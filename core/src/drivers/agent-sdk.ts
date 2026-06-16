// Agent SDK driver — uses `claude -p` (Claude Code CLI in non-interactive mode).
// Authenticates via your Max plan subscription; draws from the $200/month
// Agent SDK credit pool (Max 20x). No ANTHROPIC_API_KEY required.
//
// How it works:
//   claude -p --output-format stream-json --verbose --system-prompt '...' \
//             --mcp-config <result+perm servers> --strict-mcp-config "<task prompt>"
// The NDJSON stream is parsed live (stream-parse.ts) to surface thinking + tool
// calls to the dashboard; the terminal `result` message carries cost.
//
// Claude Code handles tool execution (Read, Edit, Write, Bash) autonomously.
// Structured output comes from a `submit_result` MCP tool the agent MUST call to
// finish — NOT from --json-schema, which the CLI does not reliably enforce when an
// agent ends its turn on a Bash/git-commit with a short prose message (that path
// produced degenerate "Completed"/empty-detail findings). The result server
// (agents/result-server/mcp-server.js) captures the tool args to a temp file we
// read after the process closes. costUsd comes from the JSON envelope.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { getConfig } from '../config.js';
import {
  CODER_SYSTEM,
  TESTER_SYSTEM,
  SECURITY_SYSTEM,
  REVIEWER_SYSTEM,
  NEGOTIATOR_SYSTEM,
  SCOUT_SYSTEM,
  SCRIBE_SYSTEM,
} from '../agents/prompts.js';
import {
  coderFinding,
  testerFinding,
  securityFinding,
  reviewerFinding,
  marketplaceFinding,
} from './findings.js';
import { loadProjectContextBounded, getRoot, swarmDir } from '../state/repo.js';
import { loadBuiltinInstructions } from '../state/builtin-instructions.js';
import { loadBuiltinModels } from '../state/builtin-models.js';
import { parseStreamMessage, createNdjsonBuffer, type StreamEvent } from './stream-parse.js';
import { streamToProgress } from './progress.js';
import type {
  AgentDriver,
  DriverResult,
  SecurityFinding,
  ReviewerFinding,
  NegotiatorDecision,
  DeadlockContext,
  ScoutResult,
  ScribeContext,
  ScribeResult,
} from './types.js';
import type { Task, SwarmState, RosterEntry } from '../state/types.js';
import { CONNECTOR_BY_ID, mcpToolId } from '../state/connectors.js';

// Compiled permission proxy MCP server (built alongside this file).
const PERM_PROXY_SERVER = new URL('../../dist/permission-proxy/mcp-server.js', import.meta.url)
  .pathname;

// Result-submitter MCP server — dev-aware so source edits take effect without a
// rebuild in dev (tsx runs the .ts directly; compiled/prod runs the .js with node).
// Unlike PERM_PROXY_SERVER above, this deliberately does NOT prefer a stale dist
// build in dev — source is the single source of truth there.
const __agentSdkFile = fileURLToPath(import.meta.url);
const IS_TSX = __agentSdkFile.endsWith('.ts');
const RESULT_SERVER_CMD = IS_TSX ? 'tsx' : 'node';
const RESULT_SERVER_PATH = IS_TSX
  ? new URL('../agents/result-server/mcp-server.ts', import.meta.url).pathname
  : new URL('../agents/result-server/mcp-server.js', import.meta.url).pathname;

// ─── JSON schema for structured output ───────────────────────────────────────
// claude -p enforces this schema on the model's final response.

const CODER_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['COMPLETE', 'FAILED'] },
    summary: { type: 'string', description: 'One-line headline of what was implemented.' },
    detail: {
      type: 'string',
      minLength: 150,
      description:
        'A substantive paragraph (4-6 sentences). REQUIRED non-empty. Cover: (1) what you changed and in which specific files/functions — name them, the reviewer has no diff; (2) why this approach; (3) non-obvious decisions or constraints; (4) what the reviewer should focus on; (5) verification ran and result. An empty or one-sentence detail is invalid and will cause CHANGES_REQUESTED.',
    },
    files_changed: {
      type: 'array',
      items: { type: 'string' },
      description:
        'REQUIRED. Every relative file path you created or modified. Populate from `git show --stat --pretty=format: HEAD` after committing — do not write from memory.',
    },
  },
  required: ['verdict', 'summary', 'detail', 'files_changed'],
});

const TESTER_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'PASS_WITH_ADVISORY', 'FAIL'] },
    summary: {
      type: 'string',
      description: 'One sentence: test command run, number passed/failed',
    },
    detail: {
      type: 'string',
      description: 'Full test output or key excerpt showing which tests ran',
    },
  },
  required: ['verdict', 'summary', 'detail'],
});

const REVIEWER_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'CHANGES_REQUESTED'] },
    summary: { type: 'string', description: 'One-line overall assessment.' },
    detail: {
      type: 'string',
      description:
        '2-3 sentences: what files you reviewed, what you looked for, and the key reason for your verdict.',
    },
    findings: {
      type: 'array',
      description:
        'Structured list of issues found. Must be non-empty when verdict is CHANGES_REQUESTED. Empty array for APPROVED.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
          category: {
            type: 'string',
            enum: ['correctness', 'robustness', 'design', 'testability', 'clarity'],
          },
          location: { type: 'string' },
          issue: {
            type: 'string',
            description: 'Quoted offending code and explanation of what is wrong',
          },
          fix: { type: 'string' },
        },
        required: ['id', 'severity', 'category', 'location', 'issue', 'fix'],
      },
    },
  },
  required: ['verdict', 'summary', 'detail', 'findings'],
});

const SECURITY_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'CHANGES_REQUESTED'] },
    summary: { type: 'string', description: 'One-line overall security assessment.' },
    detail: {
      type: 'string',
      description:
        '2-3 sentences: what attack surfaces you checked, what patterns you looked for, and the key reason for your verdict.',
    },
    findings: {
      type: 'array',
      description:
        'Structured list of security issues found. Must be non-empty when verdict is CHANGES_REQUESTED. Empty array for APPROVED.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          type: { type: 'string' },
          location: { type: 'string' },
          attack_path: { type: 'string', description: 'Entry point → data flow → impact' },
          fix: { type: 'string' },
        },
        required: ['id', 'severity', 'type', 'location', 'attack_path', 'fix'],
      },
    },
  },
  required: ['verdict', 'summary', 'detail', 'findings'],
});

const NEGOTIATOR_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['SPAWN_FIX', 'DOWNGRADE', 'ABORT'] },
    target_task_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'The blocked gate task id(s) this decision applies to.',
    },
    reasoning: {
      type: 'string',
      description: '1-3 sentences, user-facing: what you decided and why.',
    },
  },
  required: ['decision', 'target_task_ids', 'reasoning'],
});

const SCOUT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One-line headline answer to the question.' },
    digest: {
      type: 'string',
      description:
        'The substantive findings (markdown ok): answer the question, name the files/functions that matter, describe current behaviour, flag risks/constraints/unknowns.',
    },
    relevant_files: {
      type: 'array',
      items: { type: 'string' },
      description: 'The file paths most relevant to this question.',
    },
  },
  required: ['summary', 'digest'],
});

const SCRIBE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    learnings: {
      type: 'string',
      description:
        'The FULL merged project memory as concise markdown bullets (durable facts only). Empty string if there is nothing durable worth recording.',
    },
  },
  required: ['learnings'],
});

// ─── claude -p wrapper ────────────────────────────────────────────────────────

async function runClaude(opts: {
  systemPrompt: string;
  userPrompt: string;
  schema: string;
  allowedTools: string[];
  model?: string; // overrides session default; e.g. haiku for tester/security
  maxBudgetUsd?: number;
  verbose?: boolean;
  cwd?: string; // working dir for the spawned claude process; defaults to getRoot()
  permProxy?: { agentId: string; sqlPolicy?: Record<string, 'allow' | 'ask' | 'deny'> }; // when set, spawn the permission proxy MCP server
  requireFields?: string[]; // fields the result server must see present & non-empty
  minDetail?: number; // min length for `detail` (when required) — rejects one-word details
  onStreamEvent?: (ev: StreamEvent) => void; // live thinking/tool-call events for the dashboard
}): Promise<{ data: Record<string, unknown>; costUsd: number }> {
  const cfg = getConfig();
  const args = [
    '--print',
    '--output-format',
    'stream-json', // NDJSON stream so we can surface thinking + tool calls live
    '--verbose', // required by the CLI for stream-json under --print
    '--system-prompt',
    opts.systemPrompt,
    '--no-session-persistence',
  ];

  // Structured output is delivered by the `submit_result` MCP tool, not by
  // --json-schema (which the CLI does not reliably enforce when an agent ends
  // on a Bash/git-commit turn with a short prose message). The schema travels to
  // the result server via the RESULT_SCHEMA env var instead.
  const resultOutputPath = path.join(
    os.tmpdir(),
    `swarm-result-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );

  const mcpServers: Record<string, unknown> = {
    result: {
      command: RESULT_SERVER_CMD,
      args: [RESULT_SERVER_PATH],
      env: {
        RESULT_OUTPUT_PATH: resultOutputPath,
        RESULT_SCHEMA: opts.schema,
        RESULT_REQUIRE: (opts.requireFields ?? []).join(','),
        ...(opts.minDetail ? { RESULT_MIN_DETAIL: String(opts.minDetail) } : {}),
      },
    },
  };

  // When a permission proxy is requested, also start the proxy server alongside
  // the agent. The proxy intercepts Write/Edit/Bash and gates them through the
  // user's approval before executing.
  if (opts.permProxy) {
    mcpServers.perm = {
      command: 'node',
      args: [PERM_PROXY_SERVER],
      env: {
        SWARM_SERVER_URL: `http://127.0.0.1:${cfg.port}`,
        SWARM_AGENT_ID: opts.permProxy.agentId,
        SWARM_PROJECT_ROOT: getRoot(),
        ...(opts.permProxy.sqlPolicy
          ? { SWARM_SQL_POLICY: JSON.stringify(opts.permProxy.sqlPolicy) }
          : {}),
      },
    };
  }

  const mcpConfigPath = path.join(
    os.tmpdir(),
    `swarm-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }));
  args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');

  // The agent must be allowed to call the result-submission tool to finish.
  const allowedTools = [...opts.allowedTools, 'mcp__result__submit_result'];
  if (allowedTools.length) {
    // --allowedTools is variadic (<tools...>) so it must come before --
    // or it will consume the prompt as another tool name.
    args.push('--allowedTools', allowedTools.join(','));
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
    // Bounded tail of raw stdout, kept only for error diagnostics — the live
    // stream is consumed incrementally below, never re-parsed as one blob.
    let stdoutTail = '';
    let stderr = '';
    let resultCostUsd = 0;
    let resultIsError = false;
    let sawResult = false;

    // Parse the NDJSON stream as it arrives: forward thinking/tool events to the
    // dashboard and capture the final `result` message for cost + error state.
    const ndjson = createNdjsonBuffer(raw => {
      for (const ev of parseStreamMessage(raw)) {
        if (ev.kind === 'result') {
          sawResult = true;
          resultCostUsd = ev.costUsd;
          resultIsError = ev.isError;
        } else if (opts.onStreamEvent) {
          opts.onStreamEvent(ev);
        }
      }
    });

    const proc = spawn('claude', args, {
      cwd: opts.cwd ?? getRoot(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (d: Buffer) => {
      const chunk = d.toString();
      ndjson.push(chunk);
      stdoutTail = (stdoutTail + chunk).slice(-2000);
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on('error', (err: Error) =>
      reject(
        new Error(
          `Failed to spawn claude CLI: ${err.message}\nIs Claude Code installed and in PATH?`,
        ),
      ),
    );

    proc.on('close', (code: number | null) => {
      ndjson.flush();

      // Clean up both temp files (MCP config + result output) on every exit path.
      const cleanup = () => {
        try {
          fs.unlinkSync(mcpConfigPath);
        } catch {
          /* non-fatal */
        }
        try {
          fs.unlinkSync(resultOutputPath);
        } catch {
          /* non-fatal */
        }
      };

      // claude exits non-zero for is_error responses too; the stream also carries
      // is_error on its terminal result message.
      if (code !== 0 || resultIsError) {
        cleanup();
        const detail = stderr.slice(0, 400) || stdoutTail.slice(-400) || '(no output)';
        reject(
          new Error(
            `claude exited ${code ?? 'null'}${resultIsError ? ' (is_error)' : ''}: ${detail}`,
          ),
        );
        return;
      }

      if (!sawResult) {
        cleanup();
        reject(new Error(`claude produced no result message: ${stdoutTail.slice(-200)}`));
        return;
      }

      // Structured output comes from the submit_result tool, which the result
      // MCP server captured to resultOutputPath. The stream's result message is
      // used only for cost metering — never for the result payload. There is
      // deliberately NO prose fallback: a missing submission yields empty data,
      // which downstream defaults surface as an honest FAILED-ish finding rather
      // than a fabricated "Completed".
      const costUsd = resultCostUsd;
      let data: Record<string, unknown> = {};
      try {
        if (fs.existsSync(resultOutputPath)) {
          data = JSON.parse(fs.readFileSync(resultOutputPath, 'utf8')) as Record<string, unknown>;
        } else {
          console.warn(
            '  [agent-sdk] WARNING: agent did not call submit_result — finding will be marked incomplete',
          );
        }
      } catch (err) {
        console.warn(
          `  [agent-sdk] WARNING: could not read submit_result output (${err}) — finding will be marked incomplete`,
        );
        data = {};
      }

      cleanup();
      resolve({ data, costUsd });
    });
  });
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

// Full context (coder, security, reviewer) — 8 KB cap
function projectCtxBlock(): string {
  const ctx = loadProjectContextBounded(8192);
  return ctx ? `Project context (CLAUDE.md):\n${ctx}\n` : '';
}

// Lean context (tester) — 2 KB; enough for tech stack and test-runner info
function projectCtxLean(): string {
  const ctx = loadProjectContextBounded(2048);
  return ctx ? `Project context (CLAUDE.md):\n${ctx}\n` : '';
}

function charterBlock(state: SwarmState): string {
  const c = state.charter;
  if (!c) return '';
  const parts: string[] = [];
  if (c.constraints?.length) parts.push(`Constraints: ${c.constraints.join(' | ')}`);
  if (c.nongoals?.length) parts.push(`Non-goals: ${c.nongoals.join(' | ')}`);
  return parts.join('\n');
}

// Mid-run user steering — guidance the user added on a task while the run was live.
// Injected prominently so the (re)dispatched agent adapts without a full restart.
function steerBlock(task: Task): string {
  if (!task.steer?.length) {
    return '';
  }
  return [
    'IMPORTANT — mid-run steering from the user. Apply these to your work on this task:',
    ...task.steer.map(s => `- ${s}`),
  ].join('\n');
}

function coderPrompt(task: Task, state: SwarmState): string {
  // For remediation fix tasks, point the coder at the review finding it must address.
  // Findings live in the real repo's .swarm/ dir, which is gitignored and so
  // absent from the coder's isolated worktree. Use absolute paths so the coder
  // can read them regardless of its (worktree) cwd.
  const isFixTask = task.id.startsWith('t_fix_');
  const reviewRef = isFixTask
    ? state.tasks
        .filter(
          t =>
            (t.assignee === 'reviewer' || t.assignee === 'security' || t.assignee === 'checks') &&
            t.result_ref,
        )
        .map(t => `Review findings to address: ${path.join(swarmDir(), t.result_ref!)}`)
        .join('\n')
    : '';

  // Security-audit-first flow: t2 coder runs after t1 security audit.
  // Point the coder at the audit findings so it knows exactly what to fix.
  const priorSecTask = !isFixTask
    ? state.tasks.find(
        t => t.assignee === 'security' && t.status === 'done' && task.depends_on.includes(t.id),
      )
    : undefined;
  const auditRef = priorSecTask?.result_ref
    ? `Security audit findings to fix: ${path.join(swarmDir(), priorSecTask.result_ref)}\nAddress all CRITICAL and HIGH findings. Read the findings file first, then apply each fix.`
    : '';

  return [
    projectCtxBlock(),
    `Task ID: ${task.id}`,
    `Task: ${task.title}`,
    state.goal ? `Goal: ${state.goal}` : '',
    charterBlock(state),
    auditRef || reviewRef,
    steerBlock(task),
  ]
    .filter(Boolean)
    .join('\n');
}

function testerPrompt(task: Task, state: SwarmState): string {
  const coderTask = state.tasks.find(t => t.assignee === 'coder' && t.status === 'done');
  const ctx = coderTask ? `Coder completed: "${coderTask.title}"` : 'A Coder task has completed.';
  return [
    projectCtxLean(), // lean: only test-runner info needed
    `Task: ${task.title}`,
    ctx,
    coderTask?.result_ref ? `Coder findings: .swarm/${coderTask.result_ref}` : '',
    'Find and run the test suite (use Bash). Report PASS or FAIL.',
    steerBlock(task),
  ]
    .filter(Boolean)
    .join('\n');
}

function securityPrompt(task: Task, state: SwarmState): string {
  const coderTask = state.tasks.find(t => t.assignee === 'coder' && t.status === 'done');

  // Audit-first flow: security runs before any coder — full codebase scan.
  if (!coderTask) {
    return [
      projectCtxBlock(),
      `Task: ${task.title}`,
      state.goal ? `Goal: ${state.goal}` : '',
      charterBlock(state),
      'READ-ONLY. Conduct a full codebase security audit. Explore the project files thoroughly. Report APPROVED or CHANGES_REQUESTED with structured findings (id, severity, type, location, fix).',
      steerBlock(task),
    ]
      .filter(Boolean)
      .join('\n');
  }

  // Standard post-coder review.
  const ctx = `Coder changed: "${coderTask.title}"`;
  const ref = coderTask.result_ref ? ` Findings: .swarm/${coderTask.result_ref}` : '';
  return [
    projectCtxBlock(),
    `Task: ${task.title}`,
    ctx + ref,
    charterBlock(state),
    'READ-ONLY. Review changed files. Report APPROVED or CHANGES_REQUESTED with structured findings.',
    steerBlock(task),
  ]
    .filter(Boolean)
    .join('\n');
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
    steerBlock(task),
  ]
    .filter(Boolean)
    .join('\n');
}

function negotiatorPrompt(ctx: DeadlockContext): string {
  // Render each blocked gate task with an ABSOLUTE finding path so the read-only
  // agent can open it regardless of cwd (findings live in the real repo's
  // .swarm/, gitignored — mirror how coderPrompt emits absolute .swarm paths).
  const blockedBlock = ctx.blocked
    .map(b => {
      const abs = b.findingPath
        ? path.join(swarmDir(), b.findingPath)
        : '(no finding file on disk)';
      return [
        `- Task ${b.taskId} (assignee: ${b.assignee})`,
        `  Title: ${b.title}`,
        `  Verdict: ${b.verdict}`,
        `  Summary: ${b.summary}`,
        `  Finding file: ${abs}`,
      ].join('\n');
    })
    .join('\n');

  // Compact task-graph rendering so the arbiter can see structure at a glance.
  const graphBlock = ctx.tasks
    .map(
      t => `  ${t.id} [${t.assignee}] status=${t.status} depends_on=[${t.depends_on.join(', ')}]`,
    )
    .join('\n');

  return [
    `Goal: ${ctx.goal}`,
    '',
    'The run has stalled. The following gate task(s) returned a blocking verdict and downstream work cannot proceed. Read each cited finding file before deciding.',
    '',
    'Blocked gate task(s):',
    blockedBlock,
    '',
    'Task graph:',
    graphBlock,
    '',
    'Decide exactly one recovery action (SPAWN_FIX / DOWNGRADE / ABORT) and submit it.',
  ].join('\n');
}

function scoutPrompt(question: string): string {
  return [
    projectCtxBlock(),
    'The Project Manager is planning a piece of work and needs to understand the existing codebase first.',
    'Investigate the project (read-only) and report a focused, factual digest that answers this question:',
    '',
    `Research question: ${question}`,
    '',
    'Explore the relevant files, confirm how the code actually works today, and submit your digest. Name the specific files and functions that matter — the PM cannot see the code and relies on your paths.',
  ]
    .filter(Boolean)
    .join('\n');
}

function scribePrompt(ctx: ScribeContext): string {
  const findings = ctx.findings.length
    ? ctx.findings.map(f => `- [${f.agent} · ${f.verdict}] ${f.summary}`).join('\n')
    : '(no findings recorded)';
  return [
    `A run just completed. Goal: ${ctx.goal}`,
    ctx.constraints.length ? `Constraints: ${ctx.constraints.join(' | ')}` : '',
    ctx.nongoals.length ? `Non-goals: ${ctx.nongoals.join(' | ')}` : '',
    '',
    'Agent findings from the run:',
    findings,
    '',
    ctx.filesChanged.length ? `Files changed: ${ctx.filesChanged.join(', ')}` : 'No files changed.',
    '',
    '── Existing project memory (merge into this; return the full merged result) ──',
    ctx.existingMemory.trim() || '(none yet)',
    '',
    'Read the changed files as needed to verify facts, then submit the merged memory.',
  ]
    .filter(Boolean)
    .join('\n');
}

function specialistResearchPrompt(agent: RosterEntry, question: string): string {
  const role =
    agent.prompt
      .split('\n')
      .find(l => l.startsWith('Your job:'))
      ?.replace('Your job:', '')
      .trim() ?? 'specialist';
  return [
    projectCtxBlock(),
    `You are the ${agent.name} (${role}), consulted by the Project Manager during planning.`,
    'Investigate (read-only) and report a focused, factual digest that answers this question:',
    '',
    `Research question: ${question}`,
    '',
    'Use your read-only tools — read source files and run READ-ONLY queries against any data sources you can reach. Report what IS, naming the specific files, tables, or facts that matter. The PM cannot see the code or data and relies on your report.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ─── Specialist tool-grant assembly ───────────────────────────────────────────
// Translates a hired marketplace agent's granted tools + connectors into the
// concrete Claude tool list, the proxy flag, and the SQL policy map. Shared by
// `runMarketplaceAgent` (readOnly: false — full grants as configured) and
// `runSpecialistResearch` (readOnly: true — writes/deletes made impossible).
//
// readOnly: false reproduces EXACTLY the assembly that lived inline in
// runMarketplaceAgent. readOnly: true strips every mutating capability:
//   - drops grantedTools whose sens is 'write', and 'shell' grants that aren't SQL
//   - drops SQL categories write/delete/destructive, forces their policy to 'deny'
//     and read to 'allow' (so even a general execute_sql is read-constrained)
//   - always includes Read/LS/Glob/Grep so the specialist can read source
function assembleSpecialistTools(
  agent: RosterEntry,
  opts: { readOnly: boolean },
): {
  allowedTools: string[];
  needsProxy: boolean;
  sqlPolicyMap: Record<string, 'allow' | 'ask' | 'deny'>;
} {
  // Map granted tool sens values to the Claude tool names the agent may call.
  const SENS_TO_TOOLS: Record<string, string[]> = {
    read: ['Read', 'LS', 'Glob', 'Grep'],
    write: ['Write', 'Edit'],
    shell: ['Bash'],
    network: ['WebSearch', 'WebFetch'],
  };
  const ALL_SQL_CATEGORIES = ['read', 'write', 'delete', 'destructive'] as const;

  const toolSet = new Set<string>();
  let needsProxy = false;
  const sqlPolicyMap: Record<string, 'allow' | 'ask' | 'deny'> = {};

  // SQL category tools are virtual — they encode per-category DB policies rather
  // than mapping 1:1 to a Claude tool. If any are granted, build a full policy
  // (ungranted categories default to 'deny') and route all shell access through
  // the proxy so it can classify SQL statements and apply the policy.
  const hasSqlTools = agent.grantedTools.some(t => t.sqlCategory);
  if (hasSqlTools) {
    for (const cat of ALL_SQL_CATEGORIES) {
      if (opts.readOnly) {
        // Read-only research: only reads are permitted; every mutating category is denied.
        sqlPolicyMap[cat] = cat === 'read' ? 'allow' : 'deny';
      } else {
        const tool = agent.grantedTools.find(t => t.sqlCategory === cat);
        sqlPolicyMap[cat] = tool ? ((tool.mode ?? 'allow') as 'allow' | 'ask' | 'deny') : 'deny';
      }
    }
    needsProxy = true;
    toolSet.add('mcp__perm__bash');
  }

  for (const t of agent.grantedTools) {
    if (t.sqlCategory) continue; // handled above — expressed as policy, not a direct tool

    // In read-only research mode, drop every mutating capability outright:
    // write tools and non-SQL shell tools can never run.
    if (opts.readOnly && (t.sens === 'write' || t.sens === 'shell')) continue;

    const mode = t.mode ?? 'allow';
    if (mode === 'ask') {
      needsProxy = true;
      if (t.sens === 'shell') {
        toolSet.add('mcp__perm__bash');
      } else if (t.sens === 'write') {
        toolSet.add('mcp__perm__write_file');
        toolSet.add('mcp__perm__edit_file');
      } else if (t.sens === 'read') {
        // ask mode on read — route through proxy's read_file tool
        toolSet.add('mcp__perm__read_file');
      } else {
        for (const tool of SENS_TO_TOOLS[t.sens] ?? []) toolSet.add(tool);
      }
    } else {
      // allow — add to --allowedTools directly (no prompt).
      // Shell tools use Bash(pattern); write tools use Write(pattern)/Edit(pattern).
      // Both honour the scope field, which is a comma-separated list of path globs.
      if (t.sens === 'shell' && t.scope) {
        toolSet.add(`Bash(${t.scope})`);
      } else if (t.sens === 'write' && t.scope) {
        for (const pattern of t.scope
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)) {
          toolSet.add(`Write(${pattern})`);
          toolSet.add(`Edit(${pattern})`);
        }
      } else {
        for (const tool of SENS_TO_TOOLS[t.sens] ?? []) toolSet.add(tool);
      }
    }
  }

  const allowedTools = agent.grantedTools.length
    ? Array.from(toolSet)
    : ['Read', 'LS', 'Glob', 'Grep'];

  // Read-only research always needs base file-reading tools, even if the agent's
  // grants happened to exclude them (e.g. a pure-connector specialist).
  if (opts.readOnly) {
    for (const tool of ['Read', 'LS', 'Glob', 'Grep']) {
      if (!allowedTools.includes(tool)) allowedTools.push(tool);
    }
  }

  // Add MCP tool IDs for each granted connector tool. In read-only research mode we
  // drop every connector tool classified mcp-write (e.g. Supabase execute_sql,
  // apply_migration) — these are direct MCP tools that bypass the proxy's SQL
  // classifier, so the read-only SQL policy above does NOT constrain them. Dropping
  // them is the only hard guarantee that a planning consult cannot mutate anything.
  // Read queries still work via the proxy-classified shell-SQL path (sqlCategory:read)
  // and the mcp-read introspection tools (list_tables, list_migrations, get_advisors…).
  for (const grant of agent.grantedConnectors ?? []) {
    const connector = CONNECTOR_BY_ID[grant.server];
    if (!connector) continue;
    if (opts.readOnly) {
      const toolDef = connector.tools.find(t => t.name === grant.tool);
      if (toolDef?.sens === 'mcp-write') continue; // never expose mutating connectors during research
    }
    allowedTools.push(mcpToolId(connector.serverId, grant.tool));
  }

  return { allowedTools, needsProxy, sqlPolicyMap };
}

// ─── Driver ───────────────────────────────────────────────────────────────────

export const agentSdkDriver: AgentDriver = {
  name: 'agent-sdk',

  async runCoder(task, state, worktreePath?: string): Promise<DriverResult> {
    const cfg = getConfig();
    const instr = loadBuiltinInstructions();
    const coderSystem = instr.coder?.trim()
      ? `${CODER_SYSTEM}\n\n## Additional instructions\n${instr.coder}`
      : CODER_SYSTEM;
    const { data, costUsd } = await runClaude({
      systemPrompt: coderSystem,
      userPrompt: coderPrompt(task, state),
      schema: CODER_SCHEMA,
      allowedTools: ['Read', 'LS', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
      model: task.model || loadBuiltinModels().coder,
      verbose: true,
      cwd: worktreePath, // run inside the isolated worktree (if any)
      requireFields: ['summary', 'detail'],
      minDetail: 120,
      onStreamEvent: streamToProgress(task.assignee, task.id),
    });

    const verdict = String(data.verdict ?? 'FAILED');
    const summary = String(data.summary ?? 'No summary');
    const detail = String(data.detail ?? '');
    const selfReported = (data.files_changed as string[] | undefined) ?? [];

    // PRIMARY source of files_changed: the commits THIS task made inside its
    // worktree (commit message starts with "<task.id>:"). The worktree is
    // isolated, so `git log --grep` here returns only this coder's files — no
    // contamination from parallel coders, no branch-wide bleed.
    let filesChanged: string[] = [];
    const gitCwd = worktreePath ?? getRoot();
    try {
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync(
        'git',
        ['log', '--name-only', '--pretty=format:', `--grep=^${task.id}:`],
        { cwd: gitCwd, encoding: 'utf8', stdio: 'pipe' },
      );
      filesChanged = [
        ...new Set(
          out
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean),
        ),
      ];
    } catch {
      /* non-fatal — fall through to self-reported */
    }

    // FALLBACK: research/no-commit tasks produce no commit, so git gives nothing.
    // Only then trust the model's self-reported list.
    if (filesChanged.length === 0) filesChanged = selfReported;

    console.log(`  [coder] ${verdict}: ${summary}`);
    if (costUsd) console.log(`  [coder] cost: $${costUsd.toFixed(4)}`);

    return {
      verdict,
      summary,
      filesChanged,
      securityFindings: [],
      reviewerFindings: [],
      findingMarkdown: coderFinding(task, summary, detail, filesChanged),
      costUsd,
    };
  },

  async runTester(task, state): Promise<DriverResult> {
    const cfg = getConfig();
    const instr = loadBuiltinInstructions();
    const testerSystem = instr.tester?.trim()
      ? `${TESTER_SYSTEM}\n\n## Additional instructions\n${instr.tester}`
      : TESTER_SYSTEM;
    const { data, costUsd } = await runClaude({
      systemPrompt: testerSystem,
      userPrompt: testerPrompt(task, state),
      schema: TESTER_SCHEMA,
      allowedTools: ['Read', 'LS', 'Glob', 'Grep', 'Bash'],
      model: task.model || loadBuiltinModels().tester,
      verbose: true,
      requireFields: ['summary', 'detail'],
      onStreamEvent: streamToProgress(task.assignee, task.id),
    });

    const verdict = String(data.verdict ?? 'FAIL').toUpperCase();
    const summary = String(data.summary ?? 'No summary');
    const detail = data.detail ? String(data.detail) : undefined;

    console.log(`  [tester] ${verdict}: ${summary}`);
    if (costUsd) console.log(`  [tester] cost: $${costUsd.toFixed(4)}`);

    return {
      verdict,
      summary,
      filesChanged: [],
      securityFindings: [],
      reviewerFindings: [],
      findingMarkdown: testerFinding(task, verdict, summary, detail),
      costUsd,
    };
  },

  async runSecurity(task, state): Promise<DriverResult> {
    const cfg = getConfig();
    const instr = loadBuiltinInstructions();
    const securitySystem = instr.security?.trim()
      ? `${SECURITY_SYSTEM}\n\n## Additional instructions\n${instr.security}`
      : SECURITY_SYSTEM;
    const { data, costUsd } = await runClaude({
      systemPrompt: securitySystem,
      userPrompt: securityPrompt(task, state),
      schema: SECURITY_SCHEMA,
      allowedTools: ['Read', 'LS', 'Glob', 'Grep'],
      model: task.model || loadBuiltinModels().security, // override > user default (haiku)
      verbose: true,
      requireFields: ['summary', 'detail'],
      onStreamEvent: streamToProgress(task.assignee, task.id),
    });

    const verdict = String(data.verdict ?? 'CHANGES_REQUESTED').toUpperCase();
    const summary = String(data.summary ?? 'No summary');
    const detail = String(data.detail ?? '');
    const findings = (data.findings as SecurityFinding[] | undefined) ?? [];

    const icon = verdict === 'APPROVED' ? '✓' : '⚠';
    console.log(`  [security] ${icon} ${verdict}: ${summary}`);
    findings.forEach(f => console.log(`     ${f.id} [${f.severity}] ${f.type} @ ${f.location}`));
    if (costUsd) console.log(`  [security] cost: $${costUsd.toFixed(4)}`);

    return {
      verdict,
      summary,
      filesChanged: [],
      securityFindings: findings,
      reviewerFindings: [],
      findingMarkdown: securityFinding(task, verdict, summary, detail, findings),
      costUsd,
    };
  },

  async runReviewer(task, state): Promise<DriverResult> {
    const cfg = getConfig();
    const instr = loadBuiltinInstructions();
    const reviewerSystem = instr.reviewer?.trim()
      ? `${REVIEWER_SYSTEM}\n\n## Additional instructions\n${instr.reviewer}`
      : REVIEWER_SYSTEM;
    const { data, costUsd } = await runClaude({
      systemPrompt: reviewerSystem,
      userPrompt: reviewerPrompt(task, state),
      schema: REVIEWER_SCHEMA,
      allowedTools: ['Read', 'LS', 'Glob', 'Grep'],
      model: task.model || loadBuiltinModels().reviewer, // override > user default (sonnet)
      verbose: true,
      requireFields: ['summary', 'detail'],
      onStreamEvent: streamToProgress(task.assignee, task.id),
    });

    const verdict = String(data.verdict ?? 'CHANGES_REQUESTED').toUpperCase();
    const summary = String(data.summary ?? 'No summary');
    const detail = String(data.detail ?? '');
    const findings = (data.findings as ReviewerFinding[] | undefined) ?? [];

    const icon = verdict === 'APPROVED' ? '✓' : '⚠';
    console.log(`  [reviewer] ${icon} ${verdict}: ${summary}`);
    findings.forEach(f =>
      console.log(`     ${f.id} [${f.severity}/${f.category}] @ ${f.location}`),
    );
    if (costUsd) console.log(`  [reviewer] cost: $${costUsd.toFixed(4)}`);

    return {
      verdict,
      summary,
      filesChanged: [],
      securityFindings: [],
      reviewerFindings: findings,
      findingMarkdown: reviewerFinding(task, verdict, summary, detail, findings),
      costUsd,
    };
  },

  async runMarketplaceAgent(task, state, agent: RosterEntry): Promise<DriverResult> {
    // Generic schema: accepts any verdict a marketplace agent may produce.
    const schema = JSON.stringify({
      type: 'object',
      properties: {
        verdict: {
          type: 'string',
          enum: ['APPROVED', 'ADVISORY', 'COMPLETE', 'CHANGES_REQUESTED', 'FAIL', 'FAILED'],
        },
        summary: { type: 'string', description: 'One-line overall assessment.' },
        detail: { type: 'string', description: '2-3 sentences of context.' },
        findings: { type: 'array', items: { type: 'object' } },
      },
      required: ['verdict', 'summary', 'detail'],
    });

    const baseSystemPrompt = agent.instructions?.trim()
      ? `${agent.prompt}\n\n## Additional instructions\n${agent.instructions}`
      : agent.prompt;
    // Marketplace prompts are user-authored and may not mention the result tool.
    // Append a universal submit instruction so they finish via submit_result.
    const systemPrompt = `${baseSystemPrompt}\n\n## Submitting your result\nCall the submit_result tool exactly once with: verdict, summary, detail, and findings (array, may be empty). This is the ONLY way to finish — any other text is discarded.`;

    const coderTask = state.tasks.find(t => t.assignee === 'coder' && t.status === 'done');
    const userPrompt = [
      projectCtxBlock(),
      `Task: ${task.title}`,
      state.goal ? `Goal: ${state.goal}` : '',
      coderTask?.result_ref ? `Coder findings: .swarm/${coderTask.result_ref}` : '',
      charterBlock(state),
    ]
      .filter(Boolean)
      .join('\n');

    // Translate the agent's granted tools + connectors into the concrete tool
    // list, proxy flag, and SQL policy. readOnly: false reproduces the original
    // inline assembly exactly (full grants as configured).
    const { allowedTools, needsProxy, sqlPolicyMap } = assembleSpecialistTools(agent, {
      readOnly: false,
    });
    const hasSqlTools = agent.grantedTools.some(t => t.sqlCategory);

    // Prefer task-level model override (PM recommendation), fall back to agent's stored model.
    const modelOverride = task.model || agent.model || undefined;

    const { data, costUsd } = await runClaude({
      systemPrompt,
      userPrompt,
      schema,
      allowedTools,
      model: modelOverride,
      verbose: true,
      requireFields: ['summary', 'detail'],
      onStreamEvent: streamToProgress(task.assignee, task.id),
      permProxy: needsProxy
        ? { agentId: task.id, ...(hasSqlTools ? { sqlPolicy: sqlPolicyMap } : {}) }
        : undefined,
    });

    const verdict = String(data.verdict ?? 'ADVISORY').toUpperCase();
    const summary = String(data.summary ?? 'No summary');
    const detail = String(data.detail ?? '');
    const findings = (data.findings as Record<string, unknown>[] | undefined) ?? [];

    const icon = ['APPROVED', 'COMPLETE', 'ADVISORY'].includes(verdict) ? '✓' : '⚠';
    console.log(`  [${agent.id}] ${icon} ${verdict}: ${summary}`);
    if (costUsd) console.log(`  [${agent.id}] cost: $${costUsd.toFixed(4)}`);

    return {
      verdict,
      summary,
      filesChanged: [],
      securityFindings: [],
      reviewerFindings: [],
      findingMarkdown: marketplaceFinding(
        task,
        agent.id,
        agent.name,
        verdict,
        summary,
        detail,
        findings,
      ),
      costUsd,
    };
  },

  // Runtime deadlock arbiter — invoked directly by the loop (NOT dispatched as a
  // task). Read-only; reads the cited findings and returns a recovery decision.
  async runNegotiator(ctx: DeadlockContext): Promise<NegotiatorDecision> {
    const { data } = await runClaude({
      systemPrompt: NEGOTIATOR_SYSTEM,
      userPrompt: negotiatorPrompt(ctx),
      schema: NEGOTIATOR_SCHEMA,
      allowedTools: ['Read', 'LS', 'Glob', 'Grep'],
      model: loadBuiltinModels().negotiator,
      requireFields: ['reasoning'],
      verbose: true,
    });

    const rawDecision = String(data.decision ?? 'SPAWN_FIX').toUpperCase();
    const decision: NegotiatorDecision['decision'] =
      rawDecision === 'DOWNGRADE' || rawDecision === 'ABORT' ? rawDecision : 'SPAWN_FIX';
    const targetTaskIds =
      Array.isArray(data.target_task_ids) && data.target_task_ids.length
        ? (data.target_task_ids as unknown[]).map(String)
        : ctx.blocked.map(b => b.taskId);
    const reasoning = String(
      data.reasoning ?? 'Resolving the blocking finding to keep the run moving.',
    );

    console.log(`  [negotiator] ${decision}: ${reasoning}`);

    return { decision, targetTaskIds, reasoning };
  },

  // Read-only codebase investigator for the PM planning session. Invoked directly
  // from the PM flow (NOT dispatched, NOT in a worktree). Answers one specific
  // question with a factual digest the PM uses to plan.
  async runScout(question: string): Promise<ScoutResult> {
    const { data, costUsd } = await runClaude({
      systemPrompt: SCOUT_SYSTEM,
      userPrompt: scoutPrompt(question),
      schema: SCOUT_SCHEMA,
      allowedTools: ['Read', 'LS', 'Glob', 'Grep'],
      model: loadBuiltinModels().scout,
      requireFields: ['digest'],
      verbose: true,
    });

    const summary = String(data.summary ?? '');
    const digest = String(data.digest ?? '');
    const relevantFiles = Array.isArray(data.relevant_files)
      ? (data.relevant_files as unknown[]).map(String)
      : [];

    console.log(`  [scout] ${summary || '(no summary)'}`);
    if (costUsd) console.log(`  [scout] cost: $${costUsd.toFixed(4)}`);

    return { summary, digest, relevantFiles, costUsd };
  },

  // Read-only scribe — distils durable learnings into project memory after a run.
  async runScribe(ctx: ScribeContext): Promise<ScribeResult> {
    const cfg = getConfig();
    const { data, costUsd } = await runClaude({
      systemPrompt: SCRIBE_SYSTEM,
      userPrompt: scribePrompt(ctx),
      schema: SCRIBE_SCHEMA,
      allowedTools: ['Read', 'LS', 'Glob', 'Grep'],
      model: cfg.scoutModel,
      requireFields: ['learnings'],
      verbose: true,
    });
    const learnings = String(data.learnings ?? '');
    if (costUsd) {
      console.log(`  [scribe] cost: $${costUsd.toFixed(4)}`);
    }
    return { learnings, costUsd };
  },

  // Read-only research by a HIRED specialist during PM planning. Like runScout,
  // but uses the specialist's own prompt and READ-ONLY tool grants — it may read
  // source AND run read-only queries against any connector it holds (e.g. the
  // Database Specialist querying the live DB), but cannot write/delete anything.
  // Invoked directly from the PM flow (NOT dispatched, NOT in a worktree).
  async runSpecialistResearch(agent: RosterEntry, question: string): Promise<ScoutResult> {
    const cfg = getConfig();

    const basePrompt = agent.instructions?.trim()
      ? `${agent.prompt}\n\n## Additional instructions\n${agent.instructions}`
      : agent.prompt;
    const systemPrompt = `${basePrompt}\n\n## You are being consulted during PROJECT PLANNING\nNo code has been written yet. A Project Manager needs facts to plan well. Investigate the question below using ONLY your read-only tools (you may read source files and run READ-ONLY queries against any data sources you can reach — never write, migrate, or mutate anything). Report a concise, factual digest the planner will use. Do not propose a plan or make scope decisions — report what IS.`;

    const { allowedTools, needsProxy, sqlPolicyMap } = assembleSpecialistTools(agent, {
      readOnly: true,
    });
    const hasSqlTools = agent.grantedTools.some(t => t.sqlCategory);

    const { data, costUsd } = await runClaude({
      systemPrompt,
      userPrompt: specialistResearchPrompt(agent, question),
      schema: SCOUT_SCHEMA,
      allowedTools,
      model: agent.model || cfg.scoutModel,
      requireFields: ['digest'],
      verbose: true,
      permProxy: needsProxy
        ? {
            agentId: `pm-research-${agent.id}`,
            ...(hasSqlTools ? { sqlPolicy: sqlPolicyMap } : {}),
          }
        : undefined,
    });

    const summary = String(data.summary ?? '');
    const digest = String(data.digest ?? '');
    const relevantFiles = Array.isArray(data.relevant_files)
      ? (data.relevant_files as unknown[]).map(String)
      : [];

    console.log(`  [research:${agent.id}] ${summary || '(no summary)'}`);
    if (costUsd) console.log(`  [research:${agent.id}] cost: $${costUsd.toFixed(4)}`);

    return { summary, digest, relevantFiles, costUsd };
  },
};
