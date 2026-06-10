// PM planning session — INCEPTION.md §3 (critical partner, not transcriber).
// Called by POST /pm/message.
//
// Instead of hoping `claude --print --json-schema` returns well-formed JSON
// (it doesn't in single-shot mode without tools), we give the PM exactly one
// MCP tool: `submit_pm_response`. Claude MUST call it to complete its turn —
// tool calls are protocol-enforced, so the output is always structured.
//
// Flow:
//   1. Write a temp file path for the output.
//   2. Inline the MCP config as JSON (pm_responder server → mcp-server.js).
//   3. Spawn: claude --print --mcp-config <json> --allowedTools mcp__pm_responder__submit_pm_response
//   4. mcp-server.js captures the tool arguments and writes them to the temp file.
//   5. Read the temp file → PmResponse. No heuristics, no fallbacks.

import { spawn }            from 'node:child_process';
import { randomUUID }       from 'node:crypto';
import * as fs              from 'node:fs';
import * as os              from 'node:os';
import * as path            from 'node:path';
import { fileURLToPath }    from 'node:url';
import { getConfigOptional } from '../config.js';
import { loadProjectContext, getRoot } from '../state/repo.js';

// ─── MCP server path ──────────────────────────────────────────────────────────
// The server can run two ways:
//   dev:        tsx src/pm/index.ts  → __dirname is src/pm/, use tsx + .ts file
//   production: node dist/pm/index.js → __dirname is dist/pm/, use node + .js file

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Detect whether we're running via tsx (source) or compiled node
const IS_TSX     = __filename.endsWith('.ts');
const MCP_CMD    = IS_TSX ? 'tsx'       : 'node';
const MCP_SERVER = IS_TSX
  ? path.join(__dirname, 'mcp-server.ts')  // tsx executes .ts directly
  : path.join(__dirname, 'mcp-server.js'); // node runs compiled .js

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HistoryMessage {
  from: 'pm' | 'you' | 'security';
  text: string;
}

export interface PmCharter {
  goal?:        string;
  constraints?: string[];
  nongoals?:    string[];
  questions?:   string[];
  branchMode?:  'branch' | 'main';
}

export interface PmResponse {
  reply:              string;
  securityInterject?: string;
  deploymentInfo?:    string;
  suggestCompact?:    boolean;
  charterUpdates?: {
    goal?:              string;
    newConstraints?:    string[];
    newNongoals?:       string[];
    newQuestions?:      string[];
    resolvedQuestion?:  { index: number; answer: string };
    branchMode?:        'branch' | 'main';
  };
  teamAdd?:        string[];
  enableExecute?:  boolean;
  disableExecute?: boolean;
  disableReason?:  string;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const PM_SYSTEM = `\
You are a Project Manager (PM) for a multi-agent AI coding system.
Your role during Planning mode is to be a CRITICAL PARTNER — challenging, precise, and opinionated.

PERSONA:
- Push back on vague, hand-wavy, or over-ambitious scope. Say so directly.
- Surface trade-offs and the roads NOT taken — not just the chosen path.
- Ask the uncomfortable questions: who are the actual users, what scale, what can go wrong, what's the security model?
- Actively defend a lean v1. When scope creeps: "that's a v2 — let's not block on it."
- Be terse. One clear question at a time. Never ask three things in one message.
- Know when you have enough. The charter needs to be executable, not perfect.

CALIBRATE: bug fix = 1–2 exchanges then Execute; feature = 3–5; greenfield = more. Never over-question a bug fix; never under-question greenfield.

CONTEXT MANAGEMENT:
If you receive a CONTEXT NOTE or CONTEXT ALERT above the conversation, act on it. If the charter is executable, enable Execute. If it genuinely is not, set suggest_compact: true once — do not set it every turn.

DEPLOYMENT CHECK — do this once per project, not every session:
Look at the project context provided. Check whether a "## Deployment" section already has real content.
- If it does: skip — do not ask about deployment again.
- If absent or blank: ask once, early (first or second exchange). Accept any answer. Record in deployment_info.
Never ask about deployment more than once.

WHAT YOU ARE DOING:
Assembling a Project Charter through conversation. The current charter state is injected above as structured data — treat it as authoritative. Your job is to fill in what is missing, challenge what is wrong, and enable Execute when the charter is complete enough to act on.

CHARTER FIELDS — all updatable at any time throughout the conversation:
All fields can be added to or refined at any turn — not just when first set. If the user asks to adjust the goal, constraints, non-goals, team, or questions mid-conversation, update them. The charter is a living document.
- charter_updates.goal: Your clearest current formulation of what is being built. REFINE this as the conversation clarifies scope — goals evolve through discussion. The first message is often rough; set a tighter version once you understand the actual need. Update whenever you have a better formulation.
- charter_updates.new_constraints: Technical or product constraints. Add new ones at any point in the conversation, not just at the start.
- charter_updates.new_nongoals: Explicit out-of-scope items. PROPOSE these yourself after understanding the goal — don't wait for the user. If you say "out of scope: X" in your reply, include it here. Can be added any time.
- charter_updates.new_questions: Open questions you're raising. Can be added any time if new uncertainties emerge.
- charter_updates.resolved_question: If the user just answered an open question, resolve it (index, answer).

- charter_updates.branch_mode: Git workflow for this run. Ask once, early (first or second exchange), as a simple choice. ALWAYS recommend 'branch' — it creates a named feature branch, keeps main clean, and makes the work easy to review or roll back. Only accept 'main' if the user explicitly prefers it. Once set, do not ask again.

TEAM RECOMMENDATION — set team_add when ready:
- "coder" — always
- "reviewer" — ALWAYS when coder is on the team. Non-negotiable. A coder without a reviewer is not a complete team. No code ships without review.
- "tester" — always for features and greenfield; optional for trivial single-line bug fixes only
- "security" — whenever there's SQL, auth, user input, API keys, crypto, or file system access in scope

SECURITY INTERJECTION:
If the user mentions SQL queries with user-controlled input, authentication, passwords, API keys, or cryptography — set security_interject to a sharp one-line concern from the Security specialist.

ENABLE EXECUTE — use judgment, not a checklist:
Enable Execute when the goal is clear enough that agents can start without stalling mid-task.
- NEVER on the first exchange, even if the request seems complete. Always do at least one scoping round first.
- Required always: goal is specific, success condition is clear, team is recommended.
- Required for features and above: at least one constraint AND one non-goal have been stated. PROPOSE these yourself after the first exchange — "A few assumptions: [constraint]. Out of scope: [non-goal]. Does that match?" Once acknowledged, enable Execute.
- For bug fixes only: constraints and non-goals can be light if the problem is precise enough that an agent won't stall.
- Do NOT enable Execute if a critical open question is unresolved.
- Do NOT enable Execute in the same message as an unanswered question.

WHEN ENABLING EXECUTE — what to say:
When you set enable_execute: true, your reply MUST tell the user explicitly: e.g. "Ready to execute — click the Execute button whenever you're set to start. If you'd like to adjust anything in the charter first, just let me know." Always invite further conversation; Execute being enabled does not end the planning session.

DISABLING EXECUTE — if new information creates a blocker:
If after enabling Execute the user reveals something that makes it unsafe to proceed, set disable_execute: true and a brief disable_reason (this appears as the tooltip on the greyed-out button, so the user knows exactly what information you still need). Example: disable_reason: "Need to know the deployment target before the Coder can safely make changes."

RESPONSE — CRITICAL:
You MUST call the \`submit_pm_response\` tool to deliver your response. Plain text output is ignored entirely — only the tool call is processed. Call it exactly once per turn.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatHistory(history: HistoryMessage[]): string {
  if (!history.length) return '(no prior conversation)';
  return history.map(m => {
    const who = m.from === 'you' ? 'User' : m.from === 'security' ? '[Security]' : 'PM';
    return `${who}: ${m.text}`;
  }).join('\n');
}

function estimateTokens(...parts: (string | null | undefined)[]): number {
  return Math.ceil(parts.reduce((sum, p) => sum + (p?.length ?? 0), 0) / 4);
}

function formatCharter(charter: PmCharter | null, team: string[]): string {
  if (!charter && !team.length) return '';
  const parts: string[] = ['Charter:'];
  if (charter?.goal)                 parts.push(`goal="${charter.goal}"`);
  if (charter?.constraints?.length)  parts.push(`constraints=[${charter.constraints.join(' | ')}]`);
  if (charter?.nongoals?.length)     parts.push(`nongoals=[${charter.nongoals.join(' | ')}]`);
  if (charter?.questions?.length)    parts.push(`openQ=[${charter.questions.join(' | ')}]`);
  if (charter?.branchMode)           parts.push(`branch_mode=${charter.branchMode}`);
  if (team.length)                   parts.push(`team=[${team.join(', ')}]`);
  return parts.join(' ');
}

function contextNote(estimatedTokens: number, exchangeCount: number): string {
  if (estimatedTokens > 30_000) {
    return `CONTEXT ALERT: ~${Math.round(estimatedTokens / 1000)}k estimated tokens. If charter is ready, enable Execute. Otherwise set suggest_compact: true.`;
  }
  if (exchangeCount >= 12) {
    return `CONTEXT NOTE: ${exchangeCount} exchanges — consider whether you have enough to enable Execute or set suggest_compact: true.`;
  }
  if (exchangeCount >= 8) {
    return `CONTEXT NOTE: ${exchangeCount} exchanges in — consider enabling Execute if the charter is solid enough.`;
  }
  return '';
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runPmMessage(
  text:     string,
  history:  HistoryMessage[],
  charter?: PmCharter,
  team?:    string[],
): Promise<PmResponse> {
  getConfigOptional();
  const projectCtx  = loadProjectContext();
  const projectRoot = getRoot();
  const projectName = path.basename(projectRoot);

  const recentHistory   = charter ? history.slice(-6) : history;
  const exchangeCount   = history.filter(m => m.from === 'you').length;
  const charterBlock    = formatCharter(charter ?? null, team ?? []);
  const estimatedTokens = estimateTokens(PM_SYSTEM, projectCtx, charterBlock, formatHistory(recentHistory), text);
  const ctxNote         = contextNote(estimatedTokens, exchangeCount);

  const conversationPrompt = [
    `Current project: ${projectName} (${projectRoot})`,
    projectCtx   ? `\nProject context (CLAUDE.md):\n${projectCtx}\n`  : '',
    charterBlock ? `${charterBlock}\n`                                        : '',
    recentHistory.length
      ? `Recent conversation:\n${formatHistory(recentHistory)}\n`
      : '',
    `User's latest message: ${text}`,
    ctxNote ? `\n${ctxNote}` : '',
    '',
    'Continue as the PM. Call submit_pm_response with your reply and any charter updates.',
  ].filter(Boolean).join('\n');

  // ── Temp files ────────────────────────────────────────────────────────────
  const uuid        = randomUUID();
  const outputPath  = path.join(os.tmpdir(), `pm-output-${uuid}.json`);
  const configPath  = path.join(os.tmpdir(), `pm-config-${uuid}.json`);

  // --mcp-config expects a file path, not inline JSON.
  // MCP_CMD/MCP_SERVER handle both tsx (dev) and node (compiled) environments.
  const mcpConfig = {
    mcpServers: {
      pm_responder: {
        command: MCP_CMD,
        args:    [MCP_SERVER],
        env:     { PM_OUTPUT_PATH: outputPath },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(mcpConfig));

  const args = [
    '--print',
    '--dangerously-skip-permissions',
    '--output-format',  'json',           // envelope gives us cost_usd
    '--no-session-persistence',
    '--strict-mcp-config',                // ignore all other MCP servers
    '--mcp-config',     configPath,
    '--allowedTools',   'mcp__pm_responder__submit_pm_response',
    '--system-prompt',  PM_SYSTEM,
    '--',
    conversationPrompt,
  ];

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('claude', args, {
      cwd:   projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const cleanup = () => {
      try { fs.unlinkSync(outputPath); } catch { /* ok */ }
      try { fs.unlinkSync(configPath); } catch { /* ok */ }
    };

    const timer = setTimeout(() => {
      proc.kill();
      cleanup();
      reject(new Error('PM response timed out after 90s'));
    }, 90_000);

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);

      // Log cost if available (envelope may or may not parse cleanly)
      try {
        const envelope = JSON.parse(stdout) as { cost_usd?: number; is_error?: boolean; result?: unknown };
        if (envelope.cost_usd) console.log(`[pm] cost: $${envelope.cost_usd.toFixed(4)}`);
        if (envelope.is_error) {
          cleanup();
          reject(new Error(`claude API error: ${JSON.stringify(envelope.result).slice(0, 300)}`));
          return;
        }
      } catch { /* envelope not parseable — not fatal, carry on */ }

      if (code !== 0 && !fs.existsSync(outputPath)) {
        const detail = stderr.slice(0, 300) || stdout.slice(0, 300) || '(no output)';
        cleanup();
        reject(new Error(`claude exited ${code}: ${detail}`));
        return;
      }

      // Read the structured response written by the MCP server
      if (!fs.existsSync(outputPath)) {
        // Log what Claude actually said so we can debug tool-call failures
        console.error('[pm] submit_pm_response was not called');
        console.error('[pm] MCP_CMD:', MCP_CMD, '| MCP_SERVER:', MCP_SERVER);
        console.error('[pm] stdout:', stdout.slice(0, 400));
        console.error('[pm] stderr:', stderr.slice(0, 400));
        cleanup();
        reject(new Error('PM did not call submit_pm_response — check server logs'));
        return;
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      } catch (err) {
        cleanup();
        reject(new Error(`Failed to read PM output file: ${err}`));
        return;
      }
      cleanup();

      console.log('[pm] tool call captured — reply length:', String(data.reply ?? '').length);

      const cu = (data.charter_updates ?? {}) as Record<string, unknown>;
      const rv = cu.resolved_question as { index: number; answer: string } | undefined;

      // ── Server-side team enforcement ──────────────────────────────────────────
      // Belt-and-braces: even if the PM omits reviewer, add it when execute fires.
      let resolvedTeam = Array.isArray(data.team_add) ? data.team_add.map(String) : undefined;
      if (Boolean(data.enable_execute) && resolvedTeam?.includes('coder') && !resolvedTeam.includes('reviewer')) {
        console.log('[pm] enforcing reviewer — always required with coder');
        resolvedTeam = [...resolvedTeam, 'reviewer'];
      }

      const branchModeRaw = cu.branch_mode ? String(cu.branch_mode) : undefined;
      const branchMode: 'branch' | 'main' | undefined =
        branchModeRaw === 'main' ? 'main' : branchModeRaw === 'branch' ? 'branch' : undefined;

      resolve({
        reply:              String(data.reply ?? ''),
        securityInterject:  data.security_interject ? String(data.security_interject) : undefined,
        deploymentInfo:     data.deployment_info    ? String(data.deployment_info)    : undefined,
        suggestCompact:     Boolean(data.suggest_compact) || undefined,
        charterUpdates: {
          goal:             cu.goal             ? String(cu.goal)                              : undefined,
          newConstraints:   Array.isArray(cu.new_constraints) ? cu.new_constraints.map(String) : undefined,
          newNongoals:      Array.isArray(cu.new_nongoals)    ? cu.new_nongoals.map(String)    : undefined,
          newQuestions:     Array.isArray(cu.new_questions)   ? cu.new_questions.map(String)   : undefined,
          resolvedQuestion: rv,
          branchMode,
        },
        teamAdd:        resolvedTeam,
        enableExecute:  Boolean(data.enable_execute),
        disableExecute: Boolean(data.disable_execute),
        disableReason:  data.disable_reason ? String(data.disable_reason) : undefined,
      });
    });
  });
}
