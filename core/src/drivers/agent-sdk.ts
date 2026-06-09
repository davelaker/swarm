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
import { CODER_SYSTEM, TESTER_SYSTEM, SECURITY_SYSTEM, REVIEWER_SYSTEM } from '../agents/prompts.js';
import { coderFinding, testerFinding, securityFinding, reviewerFinding } from './findings.js';
import { loadProjectContextBounded } from '../state/repo.js';
import type { AgentDriver, DriverResult, SecurityFinding, ReviewerFinding } from './types.js';
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

const REVIEWER_SCHEMA = JSON.stringify({
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
          severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
          category: { type: 'string', enum: ['correctness', 'robustness', 'design', 'testability', 'clarity'] },
          location: { type: 'string' },
          fix:      { type: 'string' },
        },
        required: ['id', 'severity', 'category', 'location', 'fix'],
      },
    },
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
  allowedTools: string[];
  model?:       string;       // overrides session default; e.g. haiku for tester/security
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
    '--no-session-persistence',
  ];

  if (opts.allowedTools.length) {
    // --allowedTools is variadic (<tools...>) so it must come before --
    // or it will consume the prompt as another tool name.
    args.push('--allowedTools', opts.allowedTools.join(','));
  }

  if (opts.model) {
    args.push('--model', opts.model);
  }

  if (opts.maxBudgetUsd ?? cfg.hardCapUsd) {
    args.push('--max-budget-usd', String(opts.maxBudgetUsd ?? cfg.hardCapUsd));
  }

  // Use -- to terminate option parsing before the positional prompt argument.
  // Without this, --allowedTools (variadic) would consume the prompt as a tool name.
  args.push('--', opts.userPrompt);

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
      // Always try to parse stdout — claude exits 1 for is_error responses too.
      let envelope: ClaudeOutput | null = null;
      try { envelope = JSON.parse(stdout) as ClaudeOutput; } catch { /* handled below */ }

      if (code !== 0) {
        if (envelope?.is_error) {
          reject(new Error(`claude API error: ${JSON.stringify(envelope.result).slice(0, 400)}`));
        } else {
          const detail = stderr.slice(0, 400) || stdout.slice(0, 400) || '(no output)';
          reject(new Error(`claude exited ${code}: ${detail}`));
        }
        return;
      }

      if (!envelope) {
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

// Full context (coder, security, reviewer) — 8 KB cap
function projectCtxBlock(): string {
  const ctx = loadProjectContextBounded(8192);
  return ctx ? `Project context (.swarm/PROJECT.md):\n${ctx}\n` : '';
}

// Lean context (tester) — 2 KB; enough for tech stack and test-runner info
function projectCtxLean(): string {
  const ctx = loadProjectContextBounded(2048);
  return ctx ? `Project context (.swarm/PROJECT.md):\n${ctx}\n` : '';
}

function charterBlock(state: SwarmState): string {
  const c = state.charter;
  if (!c) return '';
  const parts: string[] = [];
  if (c.constraints?.length) parts.push(`Constraints: ${c.constraints.join(' | ')}`);
  if (c.nongoals?.length)    parts.push(`Non-goals: ${c.nongoals.join(' | ')}`);
  return parts.join('\n');
}

function coderPrompt(task: Task, state: SwarmState): string {
  return [
    projectCtxBlock(),
    `Task: ${task.title}`,
    state.goal ? `Goal: ${state.goal}` : '',
    charterBlock(state),
  ].filter(Boolean).join('\n');
}

function testerPrompt(task: Task, state: SwarmState): string {
  const coderTask = state.tasks.find(t => t.assignee === 'coder' && t.status === 'done');
  const ctx = coderTask ? `Coder completed: "${coderTask.title}"` : 'A Coder task has completed.';
  return [
    projectCtxLean(),                                            // lean: only test-runner info needed
    `Task: ${task.title}`,
    ctx,
    coderTask?.result_ref ? `Coder findings: .swarm/${coderTask.result_ref}` : '',
    'Find and run the test suite (use Bash). Report PASS or FAIL.',
  ].filter(Boolean).join('\n');
}

function securityPrompt(task: Task, state: SwarmState): string {
  const coderTask = state.tasks.find(t => t.assignee === 'coder' && t.status === 'done');
  const ctx = coderTask ? `Coder changed: "${coderTask.title}"` : 'Code changes have been made.';
  const ref = coderTask?.result_ref ? ` Findings: .swarm/${coderTask.result_ref}` : '';
  return [
    projectCtxBlock(),
    `Task: ${task.title}`,
    ctx + ref,
    charterBlock(state),
    'READ-ONLY. Review changed files. Report APPROVED or CHANGES_REQUESTED with structured findings.',
  ].filter(Boolean).join('\n');
}

function reviewerPrompt(task: Task, state: SwarmState): string {
  const coderTask = state.tasks.find(t => t.assignee === 'coder' && t.status === 'done');
  const ctx = coderTask ? `Coder changed: "${coderTask.title}"` : 'Code changes have been made.';
  const ref = coderTask?.result_ref ? ` Findings: .swarm/${coderTask.result_ref}` : '';
  return [
    projectCtxBlock(),
    `Task: ${task.title}`,
    ctx + ref,
    charterBlock(state),
    'READ-ONLY. Review for correctness, robustness, design, and testability. Do NOT flag security issues.',
  ].filter(Boolean).join('\n');
}

// ─── Driver ───────────────────────────────────────────────────────────────────

export const agentSdkDriver: AgentDriver = {
  name: 'agent-sdk',

  async runCoder(task, state): Promise<DriverResult> {
    const cfg = getConfig();
    const { data, costUsd } = await runClaude({
      systemPrompt: CODER_SYSTEM,
      userPrompt:   coderPrompt(task, state),
      schema:       CODER_SCHEMA,
      allowedTools: ['Read', 'Edit', 'Write', 'LS', 'Glob', 'Grep', 'Bash'],
      model:        cfg.coderModel,
      verbose:      true,
    });

    const verdict      = String(data.verdict  ?? 'FAILED');
    const summary      = String(data.summary  ?? 'No summary');
    const filesChanged = (data.files_changed as string[] | undefined) ?? [];

    console.log(`  [coder] ${verdict}: ${summary}`);
    if (costUsd) console.log(`  [coder] cost: $${costUsd.toFixed(4)}`);

    return {
      verdict, summary, filesChanged, securityFindings: [], reviewerFindings: [],
      findingMarkdown: coderFinding(task, summary, filesChanged),
      costUsd,
    };
  },

  async runTester(task, state): Promise<DriverResult> {
    const cfg = getConfig();
    const { data, costUsd } = await runClaude({
      systemPrompt: TESTER_SYSTEM,
      userPrompt:   testerPrompt(task, state),
      schema:       TESTER_SCHEMA,
      allowedTools: ['Read', 'LS', 'Glob', 'Grep', 'Bash'],
      model:        cfg.testerModel,     // haiku — structured pass/fail, no judgment needed
      verbose:      true,
    });

    const verdict = String(data.verdict ?? 'FAIL').toUpperCase();
    const summary = String(data.summary ?? 'No summary');
    const detail  = data.detail ? String(data.detail) : undefined;

    console.log(`  [tester] ${verdict}: ${summary}`);
    if (costUsd) console.log(`  [tester] cost: $${costUsd.toFixed(4)}`);

    return {
      verdict, summary, filesChanged: [], securityFindings: [], reviewerFindings: [],
      findingMarkdown: testerFinding(task, verdict, summary, detail),
      costUsd,
    };
  },

  async runSecurity(task, state): Promise<DriverResult> {
    const cfg = getConfig();
    const { data, costUsd } = await runClaude({
      systemPrompt: SECURITY_SYSTEM,
      userPrompt:   securityPrompt(task, state),
      schema:       SECURITY_SCHEMA,
      allowedTools: ['Read', 'LS', 'Glob', 'Grep'],
      model:        cfg.securityModel,   // haiku — structured read-only checklist
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
      verdict, summary, filesChanged: [], securityFindings: findings, reviewerFindings: [],
      findingMarkdown: securityFinding(task, verdict, summary, findings),
      costUsd,
    };
  },

  async runReviewer(task, state): Promise<DriverResult> {
    const cfg = getConfig();
    const { data, costUsd } = await runClaude({
      systemPrompt: REVIEWER_SYSTEM,
      userPrompt:   reviewerPrompt(task, state),
      schema:       REVIEWER_SCHEMA,
      allowedTools: ['Read', 'LS', 'Glob', 'Grep'],
      model:        cfg.reviewerModel,   // sonnet — needs judgment about code quality
      verbose:      true,
    });

    const verdict  = String(data.verdict  ?? 'CHANGES_REQUESTED').toUpperCase();
    const summary  = String(data.summary  ?? 'No summary');
    const findings = (data.findings as ReviewerFinding[] | undefined) ?? [];

    const icon = verdict === 'APPROVED' ? '✓' : '⚠';
    console.log(`  [reviewer] ${icon} ${verdict}: ${summary}`);
    findings.forEach(f => console.log(`     ${f.id} [${f.severity}/${f.category}] @ ${f.location}`));
    if (costUsd) console.log(`  [reviewer] cost: $${costUsd.toFixed(4)}`);

    return {
      verdict, summary, filesChanged: [], securityFindings: [], reviewerFindings: findings,
      findingMarkdown: reviewerFinding(task, verdict, summary, findings),
      costUsd,
    };
  },
};
