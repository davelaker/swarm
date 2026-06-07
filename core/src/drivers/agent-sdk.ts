// Agent SDK driver — uses `claude -p` (Claude Code CLI in non-interactive mode).
// Authenticates via your Max plan subscription; draws from the $200/month
// Agent SDK credit pool (Max 20x). No ANTHROPIC_API_KEY required.
//
// How it works:
//   claude -p --dangerously-skip-permissions --output-format json \
//             --json-schema '{...}' --system-prompt '...' "<task prompt>"
//
// Claude Code handles tool execution (Read, Edit, Write, Bash) autonomously.
// The --json-schema flag forces Claude to output a validated JSON object,
// which we parse for verdict/summary/files. costUsd comes from the JSON envelope.

import { spawn }        from 'node:child_process';
import { getConfig }    from '../config.js';
import { CODER_SYSTEM, TESTER_SYSTEM, SECURITY_SYSTEM } from '../agents/prompts.js';
import { coderFinding, testerFinding, securityFinding } from './findings.js';
import type { AgentDriver, DriverResult, SecurityFinding } from './types.js';
import type { Task, SwarmState } from '../state/types.js';

// ─── JSON schema for structured output ───────────────────────────────────────
// claude -p enforces this schema on the model's final response.

const CODER_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdict:       { type: 'string', enum: ['COMPLETE', 'FAILED'] },
    summary:       { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'summary', 'files_changed'],
});

const TESTER_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    summary: { type: 'string' },
    detail:  { type: 'string' },
  },
  required: ['verdict', 'summary'],
});

const SECURITY_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdict:  { type: 'string', enum: ['APPROVED', 'CHANGES_REQUESTED'] },
    summary:  { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:       { type: 'string' },
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          type:     { type: 'string' },
          location: { type: 'string' },
          fix:      { type: 'string' },
        },
        required: ['id', 'severity', 'type', 'location', 'fix'],
      },
    },
  },
  required: ['verdict', 'summary'],
});

// ─── claude -p wrapper ────────────────────────────────────────────────────────

interface ClaudeOutput {
  type:        string;
  subtype?:    string;
  result:      unknown;       // string (JSON) or parsed object depending on version
  is_error?:   boolean;
  cost_usd?:   number;
  duration_ms?: number;
}

async function runClaude(opts: {
  systemPrompt: string;
  userPrompt:   string;
  schema:       string;
  allowedTools: string[];     // Claude Code tool names
  maxBudgetUsd?: number;
  verbose?: boolean;
}): Promise<{ data: Record<string, unknown>; costUsd: number }> {
  const cfg  = getConfig();
  const args = [
    '--print',
    '--dangerously-skip-permissions',
    '--output-format', 'json',
    '--json-schema', opts.schema,
    '--system-prompt', opts.systemPrompt,
    '--allowedTools', opts.allowedTools.join(','),
    '--no-session-persistence',
  ];

  if (opts.maxBudgetUsd ?? cfg.hardCapUsd) {
    args.push('--max-budget-usd', String(opts.maxBudgetUsd ?? cfg.hardCapUsd));
  }

  // Append prompt as the final positional argument
  args.push(opts.userPrompt);

  if (opts.verbose) {
    console.log(`  [agent-sdk] claude ${args.slice(0, 6).join(' ')} …`);
  }

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('claude', args, {
      cwd:   process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('error', (err: Error) => reject(new Error(`Failed to spawn claude CLI: ${err.message}\nIs Claude Code installed and in PATH?`)));

    proc.on('close', (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }

      let envelope: ClaudeOutput;
      try {
        envelope = JSON.parse(stdout) as ClaudeOutput;
      } catch {
        reject(new Error(`claude output is not valid JSON: ${stdout.slice(0, 200)}`));
        return;
      }

      if (envelope.is_error) {
        reject(new Error(`claude error: ${JSON.stringify(envelope.result)}`));
        return;
      }

      // result may be a JSON string (if --json-schema forces it) or already parsed
      let data: Record<string, unknown>;
      try {
        data = typeof envelope.result === 'string'
          ? JSON.parse(envelope.result) as Record<string, unknown>
          : envelope.result as Record<string, unknown>;
      } catch {
        reject(new Error(`Could not parse claude result as JSON: ${String(envelope.result).slice(0, 200)}`));
        return;
      }

      resolve({ data, costUsd: envelope.cost_usd ?? 0 });
    });
  });
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function coderPrompt(task: Task, state: SwarmState): string {
  return [
    `Task: ${task.title}`,
    `Project: ${state.project}`,
    state.goal ? `Goal: ${state.goal}` : '',
    '',
    'Implement exactly what the task requires — no more.',
    'Read the relevant files, make the change, then respond with the JSON result.',
  ].filter(Boolean).join('\n');
}

function testerPrompt(task: Task, state: SwarmState): string {
  const coderTask = state.tasks.find(t => t.assignee === 'coder' && t.status === 'done');
  const ctx = coderTask
    ? `The Coder completed: "${coderTask.title}"`
    : 'A Coder task has completed.';
  return [
    `Task: ${task.title}`,
    ctx,
    coderTask?.result_ref ? `Coder findings: .swarm/${coderTask.result_ref}` : '',
    '',
    'Find and run the test suite (use Bash). Report PASS or FAIL with a summary.',
  ].filter(Boolean).join('\n');
}

function securityPrompt(task: Task, state: SwarmState): string {
  const coderTask = state.tasks.find(t => t.assignee === 'coder' && t.status === 'done');
  const ctx = coderTask
    ? `The Coder changed: "${coderTask.title}"`
    : 'Code changes have been made.';
  const ref = coderTask?.result_ref ? `\nCoder findings: .swarm/${coderTask.result_ref}` : '';
  return [
    `Task: ${task.title}`,
    ctx + ref,
    '',
    'READ-ONLY review. Read the changed files. Check for injection, auth issues,',
    'insecure crypto, missing input validation, hardcoded secrets.',
    'Report APPROVED (no issues) or CHANGES_REQUESTED (with findings).',
  ].join('\n');
}

// ─── Driver ───────────────────────────────────────────────────────────────────

export const agentSdkDriver: AgentDriver = {
  name: 'agent-sdk',

  async runCoder(task, state): Promise<DriverResult> {
    const { data, costUsd } = await runClaude({
      systemPrompt: CODER_SYSTEM,
      userPrompt:   coderPrompt(task, state),
      schema:       CODER_SCHEMA,
      allowedTools: ['Read', 'Edit', 'Write', 'LS', 'Glob', 'Grep', 'Bash'],
      verbose:      true,
    });

    const verdict      = String(data.verdict  ?? 'FAILED');
    const summary      = String(data.summary  ?? 'No summary');
    const filesChanged = (data.files_changed as string[] | undefined) ?? [];

    console.log(`  [coder] ${verdict}: ${summary}`);
    if (costUsd) console.log(`  [coder] cost: $${costUsd.toFixed(4)}`);

    return {
      verdict, summary, filesChanged, securityFindings: [],
      findingMarkdown: coderFinding(task, summary, filesChanged),
      costUsd,
    };
  },

  async runTester(task, state): Promise<DriverResult> {
    const { data, costUsd } = await runClaude({
      systemPrompt: TESTER_SYSTEM,
      userPrompt:   testerPrompt(task, state),
      schema:       TESTER_SCHEMA,
      // Tester needs Bash to run the test suite
      allowedTools: ['Read', 'LS', 'Glob', 'Grep', 'Bash'],
      verbose:      true,
    });

    const verdict = String(data.verdict ?? 'FAIL').toUpperCase();
    const summary = String(data.summary ?? 'No summary');
    const detail  = data.detail ? String(data.detail) : undefined;

    console.log(`  [tester] ${verdict}: ${summary}`);
    if (costUsd) console.log(`  [tester] cost: $${costUsd.toFixed(4)}`);

    return {
      verdict, summary, filesChanged: [], securityFindings: [],
      findingMarkdown: testerFinding(task, verdict, summary, detail),
      costUsd,
    };
  },

  async runSecurity(task, state): Promise<DriverResult> {
    const { data, costUsd } = await runClaude({
      systemPrompt: SECURITY_SYSTEM,
      userPrompt:   securityPrompt(task, state),
      schema:       SECURITY_SCHEMA,
      // Security is READ-ONLY — no Write, no Bash
      allowedTools: ['Read', 'LS', 'Glob', 'Grep'],
      verbose:      true,
    });

    const verdict  = String(data.verdict  ?? 'CHANGES_REQUESTED').toUpperCase();
    const summary  = String(data.summary  ?? 'No summary');
    const findings = (data.findings as SecurityFinding[] | undefined) ?? [];

    const icon = verdict === 'APPROVED' ? '✓' : '⚠';
    console.log(`  [security] ${icon} ${verdict}: ${summary}`);
    findings.forEach(f => console.log(`     ${f.id} [${f.severity}] ${f.type} @ ${f.location}`));
    if (costUsd) console.log(`  [security] cost: $${costUsd.toFixed(4)}`);

    return {
      verdict, summary, filesChanged: [], securityFindings: findings,
      findingMarkdown: securityFinding(task, verdict, summary, findings),
      costUsd,
    };
  },
};
