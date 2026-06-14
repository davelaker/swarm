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

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { getConfig, getConfigOptional } from '../config.js';
import {
  loadProjectContextBounded,
  loadSubdirContextBounded,
  getRoot,
  swarmDir,
} from '../state/repo.js';
import { execFileSync } from 'node:child_process';
import type { SubdirFile } from '../state/repo.js';
import { loadRoster } from '../state/roster.js';
import { formatMarketplace, CATALOG_BY_ID } from '../state/marketplace-catalog.js';
import { getDriverMode, getDriver } from '../drivers/index.js';
import { parseStreamMessage, createNdjsonBuffer } from '../drivers/stream-parse.js';
import type { RosterEntry } from '../state/types.js';

// ─── MCP server path ──────────────────────────────────────────────────────────
// Production (__dirname is dist/pm/): run the compiled mcp-server.js with node.
// Dev (tsx): run the .ts source directly with tsx. We deliberately do NOT prefer
// a compiled dist build in dev — a stale dist/pm/mcp-server.js would silently
// shadow edits to mcp-server.ts (the gate logic, schema, etc.), which is exactly
// the footgun that made earlier fixes appear to "not take effect". Source is the
// single source of truth in dev; the small tsx startup cost is worth correctness.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_TSX = __filename.endsWith('.ts');
const MCP_CMD = IS_TSX ? 'tsx' : 'node';
const MCP_SERVER = IS_TSX
  ? path.join(__dirname, 'mcp-server.ts')
  : path.join(__dirname, 'mcp-server.js');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HistoryMessage {
  from: 'pm' | 'you' | 'security';
  text: string;
}

export interface PmCharter {
  goal?: string;
  constraints?: string[];
  nongoals?: string[];
  questions?: string[];
  branchMode?: 'branch' | 'main';
}

export interface TaskGraphEntry {
  id: string;
  assignee: 'coder' | 'tester' | 'security' | 'reviewer';
  title: string;
  depends_on: string[];
}

export interface PmResponse {
  reply: string;
  securityInterject?: string;
  deploymentInfo?: string;
  suggestCompact?: boolean;
  charterUpdates?: {
    goal?: string;
    newConstraints?: string[];
    newNongoals?: string[];
    newQuestions?: string[];
    resolvedQuestion?: { index: number; answer: string };
    branchMode?: 'branch' | 'main';
    branchName?: string;
  };
  taskGraph?: TaskGraphEntry[];
  teamAdd?: string[];
  enableExecute?: boolean;
  disableExecute?: boolean;
  disableReason?: string;
  researchRequest?: { question: string; target?: string };
  hireSuggestion?: { agentId: string; reason: string };
}

// ─── System prompt ────────────────────────────────────────────────────────────

export const PM_SYSTEM = `\
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

SUBDIRECTORY CONTEXT — when provided below:
If subdirectory context files are injected into the user prompt (CLAUDE.md / CONTEXT.md from project subdirectories), use them to understand what already exists: features, integrations, modules, domain language, and product capabilities. Let this inform your questions and scope — e.g. if you can see an auth module exists, you don't need to ask how auth works. Focus on product knowledge. Technical conventions and code gotchas in those files are for execution agents, not for you.

CODEBASE RESEARCH — you can investigate before you plan:
You cannot read code yourself, but you can dispatch a read-only Scout to investigate the existing codebase and report back. Set research_request: { question } when understanding the current code would materially improve the plan — then you will receive the Scout's findings and continue this same turn with that context.
- USE IT when: the task touches existing code whose behaviour you're guessing at; you need to know how/where something currently works, what files are involved, or whether an assumption holds before you scope the work; the user references a bug or feature in code you haven't seen described in the context files.
- DON'T USE IT when: the context files already answer it; the task is a simple clarification, a greenfield with no existing code, or a question only the user can answer (product intent, priorities, deployment). Research the CODE, not the user's intent.
- Ask ONE specific, answerable question per request (e.g. "How does add-test.ts validate talisman selections, and which files compute the available talismans?"). You may research again on a later turn if a new gap opens. Prefer one good scout over planning on a wrong assumption — but don't research what you already know; it slows the conversation.
- ROUTE TO A SPECIALIST when one is better suited than a source-code Scout: set research_request.target to a HIRED specialist's id and it runs the research instead of the generic Scout. The generic Scout reads SOURCE CODE ONLY — it cannot touch a live database or any connector. The prime example: the Database Specialist (id "db") holds a read-only DB grant, so route live-data questions ("what talisman rows actually exist for player X", "how many users have null emails") to it with target: "db". Only target a specialist shown ✓ HIRED in the marketplace list. If the right specialist is NOT hired, do NOT target it — recommend hiring it via hire_suggestion, and either proceed with the generic Scout (source only) or wait for the user to hire. Omit target to use the generic Scout for ordinary source-code questions.
When you set research_request, keep your reply brief (e.g. "Let me check how that works first…") — the user sees a research indicator while the Scout (or specialist) runs, and your real answer comes on the next step.

THE MARKETPLACE — you can recommend hiring specialists:
A marketplace list is injected below, showing every available specialist and whether it is already HIRED for this project. Two ways to use it:
- ASSIGN hired specialists: if a ✓ HIRED specialist fits the work, put it on the team and in the task graph (use its exact id).
- RECOMMEND hiring: if a NOT-hired specialist would materially raise the quality or de-risk this project, set hire_suggestion: { agent_id, reason }. The user sees a one-click "Hire" call-to-action with your reason. Be specific about the value, e.g. for a substantial new product: hire_suggestion: { agent_id: "product-researcher", reason: "This is a sizeable build — a Product Researcher up front would surface the unstated requirements and edge cases before we lock scope." }
- Judgement: recommend hiring when the project is large, ambiguous, or high-stakes enough that the specialist clearly earns its place. Do NOT push hires on small, well-scoped tasks — a bug fix needs a coder and a reviewer, not a panel. One suggestion at a time, only when it genuinely helps.

POST-RUN CHANGE REQUEST — when the user reviews completed work:
If the user's message starts with "Requested changes:" (or otherwise gives specific file/line feedback on work that was just completed), the run has finished, the user inspected the diff, and they want revisions. Treat it EXACTLY like a reviewer's CHANGES_REQUESTED — do not re-plan from scratch and do not re-ask scoping questions. Instead, in this same turn:
- Briefly acknowledge what they want changed (one or two sentences).
- Produce a task_graph that APPLIES the requested changes: a coder task whose title quotes the user's specific notes (their file:line feedback verbatim where given), then a reviewer task depending on it. Add tester/security only if the change genuinely warrants it.
- This is a revision of the SAME feature on the SAME branch — keep the existing goal and branch; do not invent a new project.
- Set enable_execute: true in this same response. The user has already reviewed the diff and asked for these changes — that IS the go-ahead; no further confirmation is needed.
- team_add: coder + reviewer (plus others only if warranted).

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
- charter_updates.branch_name: Set whenever branch_mode is 'branch', AND refresh whenever the goal changes substantially. 2–4 words MAXIMUM — this is a strict limit, not a suggestion. Capture the essence, not the full goal: "fix-talisman-picker" not "debug-and-fix-the-add-test-modal-talisman-picker-for-user" (the goal verbatim is always wrong). Good examples: "fix-auth-redirect", "add-stripe-webhook", "refactor-user-model". Lowercase, hyphens only, no numbers, no project name.

TEAM — SET IN EVERY RESPONSE, STARTING WITH THE FIRST:
team_add must be present in every tool call you make, beginning with your first response. There is no turn on which it is optional.
- Bug fix: minimum coder + reviewer, from the first response.
- Feature / greenfield: start with coder + reviewer in the FIRST response. Refine as scope clarifies — do not wait even one turn.
- Every response: re-evaluate. If new information changes who's needed (user mentions SQL → add security; specialist becomes relevant → add them), update team_add. If nothing changed, re-emit it unchanged — confirming is correct, skipping is a bug.

Team composition rules:
- "coder" — always
- "reviewer" — ALWAYS when coder is on the team. Non-negotiable. A coder without a reviewer is not a complete team.
- "tester" — always for features and greenfield; optional for trivial single-line bug fixes only
- "security" — whenever there's SQL, auth, user input, API keys, crypto, or file system access in scope

SECURITY INTERJECTION:
If the user mentions SQL queries with user-controlled input, authentication, passwords, API keys, or cryptography — set security_interject to a sharp one-line concern from the Security specialist.

TASK GRAPH — draft early, update on every response, finalize at enable_execute:
Set task_graph as soon as you know who is doing what — do not wait for enable_execute. A draft task graph shows the user what will run before they commit. Update it whenever the team or scope changes. By the time you set enable_execute, task_graph should already reflect the final plan.
Define exactly which agents run and in what order. IDs: t1, t2, … (unique strings).
Tasks with empty depends_on start immediately; tasks that share depends_on run in parallel once deps complete.
You may set a "model" on any task to recommend a specific Claude model. Omit it to use the agent's default.
Guidelines: haiku for fast read-only scans; sonnet for most tasks; opus/fable for complex reasoning or critical reviews.

Builtin agents:
- coder:    writes/changes code. Use MULTIPLE coders in parallel for clearly independent sub-tasks.
- security: read-only audit. Lead with security when the primary goal is an audit; post-coder for review.
- tester:   runs the test suite. Always depends on all coder tasks.
- reviewer: code review for correctness/design. Always depends on all coder tasks.

CAPABILITY BOUNDARY — builtin agents have NO live data access:
The coder/tester/security/reviewer can only touch the project's files, git, and shell. They have NO connection to any database, external API, or connector — the coder CANNOT run a live DB query, even though it has shell access. It can only read the code that talks to the DB.
Therefore: any task that needs to read or confirm LIVE data from a database or external service MUST be assigned to a hired specialist that holds the relevant connector grant (shown as "LIVE DATA ACCESS" in the roster block). Never write a task like "coder: query the DB for X" — the coder has no way to do it. If the data must be confirmed live and no hired specialist has that access, say so plainly and ask the user to hire one, rather than handing the lookup to the coder.

Specialist agents (from hired roster — see roster block injected into the user prompt below):
If specialists are available, include the ones that add genuine value for THIS task.
Use their exact agent ID from the roster in the assignee field. Placement conventions:
- Research / analysis / live-data lookup (e.g. product-researcher, architect, a database or data specialist when its data is an INPUT to the fix): depends_on [] — runs BEFORE coder. A data-access specialist that must confirm or fetch live data the coder will rely on belongs here, ahead of the coder, NOT as a trailing gate. The coder then depends on it.
- Design/UX/accessibility: depends_on all coder tasks — parallel with tester and reviewer.
- Quality/compliance (performance, api-designer, compliance, or a database specialist acting purely as a post-change review): depends_on all coder tasks.
- Documentation/refactoring: depends_on all coder tasks.
A specialist can appear in BOTH roles if useful (e.g. a database specialist that fetches data up front AND reviews the migration afterward = two tasks). Decide by what the task needs, not by a fixed slot.
Specialists used as gates: a CHANGES_REQUESTED verdict blocks the run.
In your reply, mention which specialists you are including and why (one sentence each).
If no specialists fit the task, say so — core agents are sufficient and do not force-fit.

HONOR EXPLICIT ROUTING:
If the user explicitly asks for a specific agent to do a specific job ("use the database specialist to query the data", "have the security agent review X"), create that task and assign it to that exact agent. Do NOT silently reassign it to the coder or fold it into another task. If the named capability isn't in the roster, say so rather than substituting the coder.

Patterns (use these as defaults, adapt freely):
- Standard feature:   t1:coder(goal)→[] | t2:tester→[t1] | t3:security→[t1] | t4:reviewer→[t1]
- Feature + UX:       t1:coder(goal)→[] | t2:tester→[t1] | t3:security→[t1] | t4:reviewer→[t1] | t5:ux→[t1]
- Greenfield w/ arch: t1:product-researcher→[] | t2:architect→[] | t3:coder→[t1,t2] | t4:tester→[t3] | t5:reviewer→[t3]
- Security audit:     t1:security(full audit)→[] | t2:coder(fix .swarm/t1.md findings)→[t1] | t3:tester→[t2] | t4:reviewer→[t2]
- Two parallel coders:t1:coder(part A)→[] | t2:coder(part B)→[] | t3:tester→[t1,t2] | t4:reviewer→[t1,t2]
- Bugfix only:        t1:coder(goal)→[] (no tester/reviewer if single-line or trivial change)
- Refactor:           t1:coder(refactor)→[] | t2:tester→[t1] | t3:reviewer→[t1] (no security unless the refactor touches auth/SQL)

ENABLE EXECUTE — pre-flight: ALL of these must be true before you set enable_execute: true:
  ✓ team_add is present in THIS tool call — always re-emit it, do not rely on a prior call persisting
  ✓ goal is specific and a coder won't stall mid-task
  ✓ branch_mode is set
  ✓ At least one prior exchange has happened (NEVER on the first message)
  ✓ No critical open question is unresolved
  ✓ Not in the same message as a new unanswered question

If even ONE item is missing, do NOT set enable_execute: true. Set team_add first in a prior call if needed, then enable Execute once all items are satisfied.

For features and above, also require: at least one constraint AND one non-goal stated. PROPOSE these yourself — "A few assumptions: [constraint]. Out of scope: [non-goal]. Does that match?" Once acknowledged, enable Execute.
For bug fixes only: constraints and non-goals can be light if the problem is precise enough.

WHEN ENABLING EXECUTE — what to say (and what NOT to say):
When you set enable_execute: true, the UI shows a green "Charter ready to execute" callout — do NOT say "Ready to execute", "click Execute", or any variant of those phrases in your reply text. The callout handles that. Describe what the agents will do, or confirm the last point. You may add: "Let me know if you'd like to adjust anything."

CRITICAL — text must never run ahead of the fields: Phrases like "ready to execute", "you can execute", "click Execute", "execute when ready" are ONLY valid if enable_execute: true is set in this exact same tool call. If the charter is not yet ready, do not say it is — say what is still missing instead.

This applies to every field, not just execute. If your reply text says you have added, changed, or set the team, the task graph, the goal, or any other field, that field MUST be present in this same tool call with the updated value. Writing "Added the reviewer" or "Fixed — team is set" in reply text without the field in the tool call arguments is the single most common failure of this role. Your reply text and your tool call arguments must always agree.

DISABLING EXECUTE — if new information creates a blocker:
If after enabling Execute the user reveals something that makes it unsafe to proceed, set disable_execute: true and a brief disable_reason (this appears as the tooltip on the greyed-out button, so the user knows exactly what information you still need). Example: disable_reason: "Need to know the deployment target before the Coder can safely make changes."

EVERY-RESPONSE PRE-FLIGHT — run this before composing your submit_pm_response arguments, every turn without exception:
  ✓ team_add is present in this tool call. Not "set earlier" — present in THIS call, with the current best team. No turn is exempt, including the first.
  ✓ task_graph is present in this tool call (a draft is fine on early turns; refine as scope clarifies).
  ✓ goal reflects your latest understanding.
If team_add or task_graph is missing from the arguments you are about to send, stop and add them before sending. Re-emitting the same value every turn is correct and expected — skipping is a bug.

RESPONSE — CRITICAL:
You MUST call the \`submit_pm_response\` tool to deliver your response. Plain text output is ignored entirely — only the tool call is processed. Call it exactly once per turn.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatHistory(history: HistoryMessage[]): string {
  if (!history.length) return '(no prior conversation)';
  return history
    .map(m => {
      const who = m.from === 'you' ? 'User' : m.from === 'security' ? '[Security]' : 'PM';
      return `${who}: ${m.text}`;
    })
    .join('\n');
}

function formatRoster(roster: RosterEntry[]): string {
  const enabled = roster.filter(a => a.enabled);
  if (!enabled.length) return '';
  const lines = enabled.map(a => {
    const job =
      a.prompt
        .split('\n')
        .find(l => l.startsWith('Your job:'))
        ?.replace('Your job:', '')
        .trim() ?? 'specialist agent';

    // Surface what this specialist can ACTUALLY do that builtin agents cannot —
    // chiefly live connector/DB access. Without this the PM assumes the coder can
    // query databases (it cannot) and never routes data lookups to the right agent.
    const caps: string[] = [];
    if (a.grantedConnectors?.length) {
      const byServer = new Map<string, string[]>();
      for (const g of a.grantedConnectors) {
        const arr = byServer.get(g.server) ?? [];
        arr.push(g.tool);
        byServer.set(g.server, arr);
      }
      const conn = [...byServer.entries()].map(([s, t]) => `${s} (${t.join(', ')})`).join('; ');
      caps.push(`LIVE DATA ACCESS via ${conn}`);
    }
    const sens = new Set((a.grantedTools ?? []).map(t => (t.sqlCategory ? 'sql' : t.sens)));
    const extra = ['sql', 'shell', 'write', 'network'].filter(s => sens.has(s));
    if (extra.length) caps.push(`tools: ${extra.join(', ')}`);

    const capStr = caps.length ? `  CAN: ${caps.join(' | ')}.` : '';
    return `  [${a.id}] ${a.name} — ${job}.${capStr}`;
  });
  return (
    `Hired specialist roster (use the ID in brackets as the task_graph assignee). ` +
    `ONLY these agents can reach external data or services (databases, APIs, connectors) — ` +
    `the builtin coder/tester/reviewer/security cannot:\n${lines.join('\n')}`
  );
}

function estimateTokens(...parts: (string | null | undefined)[]): number {
  return Math.ceil(parts.reduce((sum, p) => sum + (p?.length ?? 0), 0) / 4);
}

function formatSubdirContext(files: SubdirFile[]): string {
  if (!files.length) return '';
  const truncatedCount = files.filter(f => f.truncated).length;
  const header = `Subdirectory context files (${files.length} file${files.length > 1 ? 's' : ''}${truncatedCount ? `, ${truncatedCount} truncated` : ''} — product features and domain knowledge; technical conventions are for execution agents):`;
  const body = files.map(f => `--- ${f.relPath} ---\n${f.content}`).join('\n\n');
  return `${header}\n${body}`;
}

function formatCharter(charter: PmCharter | null, team: string[]): string {
  if (!charter && !team.length) return '';
  const parts: string[] = ['Charter:'];
  if (charter?.goal) parts.push(`goal="${charter.goal}"`);
  if (charter?.constraints?.length) parts.push(`constraints=[${charter.constraints.join(' | ')}]`);
  if (charter?.nongoals?.length) parts.push(`nongoals=[${charter.nongoals.join(' | ')}]`);
  if (charter?.questions?.length)
    parts.push(`openQ=[${charter.questions.map((q, i) => `${i}:${q}`).join(' | ')}]`);
  if (charter?.branchMode) parts.push(`branch_mode=${charter.branchMode}`);
  if (team.length) parts.push(`team=[${team.join(', ')}]`);
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

// ─── Shared response parser ───────────────────────────────────────────────────
// Converts a raw tool-call argument object into a typed PmResponse.
// Used by both the subprocess path (reads PM_OUTPUT_PATH) and the direct API path.

function parsePmData(data: Record<string, unknown>): PmResponse {
  const cu = (data.charter_updates ?? {}) as Record<string, unknown>;
  const rv = cu.resolved_question as { index: number; answer: string } | undefined;

  let resolvedTeam = Array.isArray(data.team_add) ? data.team_add.map(String) : undefined;
  // Fall back to deriving team from task_graph assignees when team_add was omitted
  if (!resolvedTeam?.length && Array.isArray(data.task_graph)) {
    const assignees = (data.task_graph as Array<Record<string, unknown>>)
      .map(t => String(t.assignee))
      .filter(Boolean);
    if (assignees.length) resolvedTeam = [...new Set(assignees)];
  }
  // Last-resort safety net: the model dumped the plan into reply prose and emitted
  // neither team_add nor task_graph. Rather than leave the charter showing
  // "Waiting on PM…" (which blocks the user entirely), seed the minimum viable
  // team. The MCP gate already gave the model 2 chances to do this itself; this
  // guarantees forward progress on the rare turn it still doesn't.
  if (!resolvedTeam?.length) {
    console.warn('[pm] team_add and task_graph both empty — defaulting team to [coder, reviewer]');
    resolvedTeam = ['coder', 'reviewer'];
  }
  // A coder is never alone: a reviewer is always required alongside it.
  if (resolvedTeam.includes('coder') && !resolvedTeam.includes('reviewer')) {
    console.log('[pm] enforcing reviewer — always required with coder');
    resolvedTeam = [...resolvedTeam, 'reviewer'];
  }

  const branchModeRaw = cu.branch_mode ? String(cu.branch_mode) : undefined;
  const branchMode: 'branch' | 'main' | undefined =
    branchModeRaw === 'main' ? 'main' : branchModeRaw === 'branch' ? 'branch' : undefined;
  const branchName: string | undefined = cu.branch_name
    ? String(cu.branch_name)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || undefined
    : undefined;

  let taskGraph: TaskGraphEntry[] | undefined;
  if (Array.isArray(data.task_graph)) {
    const entries = (data.task_graph as Array<Record<string, unknown>>)
      .filter(
        e =>
          e &&
          typeof e.id === 'string' &&
          typeof e.assignee === 'string' &&
          typeof e.title === 'string',
      )
      .map(e => ({
        id: String(e.id),
        assignee: String(e.assignee) as TaskGraphEntry['assignee'],
        title: String(e.title),
        depends_on: Array.isArray(e.depends_on) ? e.depends_on.map(String) : [],
      }));
    if (entries.length > 0) taskGraph = entries;
  }

  return {
    reply: String(data.reply ?? ''),
    securityInterject: data.security_interject ? String(data.security_interject) : undefined,
    deploymentInfo: data.deployment_info ? String(data.deployment_info) : undefined,
    suggestCompact: Boolean(data.suggest_compact) || undefined,
    charterUpdates: {
      goal: cu.goal ? String(cu.goal) : undefined,
      newConstraints: Array.isArray(cu.new_constraints)
        ? cu.new_constraints.map(String)
        : undefined,
      newNongoals: Array.isArray(cu.new_nongoals) ? cu.new_nongoals.map(String) : undefined,
      newQuestions: Array.isArray(cu.new_questions) ? cu.new_questions.map(String) : undefined,
      resolvedQuestion: rv,
      branchMode,
      branchName,
    },
    taskGraph,
    teamAdd: resolvedTeam,
    enableExecute: Boolean(data.enable_execute),
    disableExecute: Boolean(data.disable_execute),
    disableReason: data.disable_reason ? String(data.disable_reason) : undefined,
    researchRequest:
      data.research_request && typeof (data.research_request as any).question === 'string'
        ? {
            question: String((data.research_request as any).question),
            ...(typeof (data.research_request as any).target === 'string'
              ? { target: String((data.research_request as any).target) }
              : {}),
          }
        : undefined,
    hireSuggestion: parseHireSuggestion(data.hire_suggestion),
  };
}

// Validate a hire suggestion: must name a real, catalogued marketplace agent.
function parseHireSuggestion(raw: unknown): { agentId: string; reason: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const h = raw as Record<string, unknown>;
  const agentId = typeof h.agent_id === 'string' ? h.agent_id.trim() : '';
  if (!agentId || !CATALOG_BY_ID[agentId]) return undefined; // unknown id → ignore
  const reason = typeof h.reason === 'string' ? h.reason.trim() : '';
  return {
    agentId,
    reason: reason || `${CATALOG_BY_ID[agentId].name} would help with this project.`,
  };
}

// ─── Anthropic SDK tool definition (mirrors mcp-server.ts SUBMIT_TOOL) ────────

const SUBMIT_PM_TOOL: Anthropic.Tool = {
  name: 'submit_pm_response',
  description:
    'Submit your structured PM response. Call this ONCE — it is the only way ' +
    'to deliver your reply and charter updates. Plain text output is ignored.',
  input_schema: {
    type: 'object',
    required: ['reply', 'team_add', 'task_graph'],
    properties: {
      reply: { type: 'string' },
      security_interject: { type: 'string' },
      deployment_info: { type: 'string' },
      charter_updates: {
        type: 'object',
        properties: {
          goal: { type: 'string' },
          new_constraints: { type: 'array', items: { type: 'string' } },
          new_nongoals: { type: 'array', items: { type: 'string' } },
          new_questions: { type: 'array', items: { type: 'string' } },
          resolved_question: {
            type: 'object',
            properties: {
              index: { type: 'number' },
              answer: { type: 'string' },
            },
            required: ['index', 'answer'],
          },
          branch_mode: { type: 'string', enum: ['branch', 'main'] },
          branch_name: { type: 'string' },
        },
      },
      team_add: {
        type: 'array',
        items: { type: 'string' },
        description:
          'REQUIRED on every turn. Re-emit the full current team every call. Minimum: ["coder", "reviewer"].',
      },
      enable_execute: { type: 'boolean' },
      disable_execute: { type: 'boolean' },
      disable_reason: { type: 'string' },
      task_graph: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            assignee: { type: 'string' },
            title: { type: 'string' },
            depends_on: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'assignee', 'title', 'depends_on'],
        },
      },
      suggest_compact: { type: 'boolean' },
      research_request: {
        type: 'object',
        description:
          'Set this when you need to understand the existing codebase to plan well — a read-only Scout will investigate your question and report back, and you\'ll continue planning with that context. Use a specific, answerable question (e.g. "How does the current auth middleware validate sessions, and where?"). Omit it when you already have enough context — most simple/clarifying turns need no research.',
        properties: {
          question: {
            type: 'string',
            description:
              'A specific, answerable question about the existing codebase for the Scout to investigate.',
          },
          target: {
            type: 'string',
            description:
              'Optional. The id of a HIRED specialist to run this research (e.g. "db" for live database questions). Omit to use the generic read-only Scout (source-code only). Only name a specialist that is shown ✓ HIRED in the marketplace list.',
          },
        },
      },
      hire_suggestion: {
        type: 'object',
        description:
          'Recommend the user hire a marketplace specialist that would materially improve THIS project. Use the exact agent id from the marketplace list. The UI shows your reason as a one-click "Hire" call-to-action. Only suggest a NOT-hired agent that genuinely fits; do not suggest one already hired, and do not force-fit.',
        properties: {
          agent_id: {
            type: 'string',
            description:
              'The marketplace agent id to recommend hiring (e.g. "product-researcher").',
          },
          reason: {
            type: 'string',
            description:
              'One sentence, user-facing: why hiring this specialist would help this project.',
          },
        },
      },
    },
  } as Anthropic.Tool['input_schema'],
};

// ─── Direct API path (api-key mode only) ─────────────────────────────────────
// Bypasses the claude subprocess entirely — no CLI cold start, no MCP subprocess,
// no hidden second inference round. TTFT ≈ pure model latency (~0.8–1.5s).

async function runPmMessageApi(
  pmSystemPrompt: string,
  conversationPrompt: string,
  onChunk?: (text: string) => void,
  onThinking?: (text: string) => void,
): Promise<PmResponse> {
  const cfg = getConfig();
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });

  type ApiMessage = Anthropic.MessageParam;
  let messages: ApiMessage[] = [{ role: 'user', content: conversationPrompt }];

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 16_000,
      system: [
        {
          type: 'text',
          text: pmSystemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [SUBMIT_PM_TOOL],
      tool_choice: { type: 'tool', name: 'submit_pm_response' },
      messages,
    });

    // Only stream reply chunks on the first attempt — retries are correction turns.
    const extractor = attempt === 1 && onChunk ? new ReplyExtractor() : null;

    stream.on('streamEvent', (ev: Anthropic.MessageStreamEvent) => {
      if (
        extractor &&
        onChunk &&
        ev.type === 'content_block_delta' &&
        ev.delta.type === 'input_json_delta'
      ) {
        const chunk = extractor.feed(ev.delta.partial_json);
        if (chunk) onChunk(chunk);
      } else if (
        attempt === 1 &&
        onThinking &&
        ev.type === 'content_block_delta' &&
        ev.delta.type === 'thinking_delta'
      ) {
        onThinking(ev.delta.thinking);
      }
    });

    const finalMsg = await stream.finalMessage();
    console.log(`[pm/api] attempt ${attempt} usage:`, JSON.stringify(finalMsg.usage));

    const toolBlock = finalMsg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'submit_pm_response',
    );
    if (!toolBlock) {
      throw new Error('PM did not call submit_pm_response (direct API path)');
    }

    const data = toolBlock.input as Record<string, unknown>;
    const teamAdd = data.team_add as unknown[] | undefined;

    if (Array.isArray(teamAdd) && teamAdd.length > 0) {
      return parsePmData(data);
    }

    // team_add missing or empty — send back a tool error and retry.
    console.warn(`[pm/api] attempt ${attempt}: team_add missing or empty — retrying`);
    messages = [
      ...messages,
      { role: 'assistant', content: finalMsg.content },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: toolBlock.id,
            content:
              'REJECTED: team_add is required and must not be empty. Re-submit NOW with at least ["coder", "reviewer"] in team_add. This call was not recorded.',
            is_error: true,
          },
        ],
      },
    ];
  }

  throw new Error(`PM failed to include team_add after ${MAX_ATTEMPTS} attempts`);
}

// ─── Reply extractor — pulls the "reply" string from streaming input_json_delta ─

class ReplyExtractor {
  private buf = '';
  private state: 'seek-key' | 'seek-quote' | 'in-string' | 'done' = 'seek-key';
  private escaped = false;

  feed(partial: string): string {
    if (this.state === 'done') return '';
    this.buf += partial;
    let out = '';

    if (this.state === 'seek-key') {
      const idx = this.buf.indexOf('"reply":');
      if (idx === -1) {
        if (this.buf.length > 15) this.buf = this.buf.slice(-15);
        return '';
      }
      this.buf = this.buf.slice(idx + '"reply":'.length);
      this.state = 'seek-quote';
    }

    if (this.state === 'seek-quote') {
      const t = this.buf.trimStart();
      if (!t.startsWith('"')) {
        if (t.length > 0) this.state = 'done';
        return '';
      }
      this.buf = t.slice(1);
      this.state = 'in-string';
    }

    if (this.state === 'in-string') {
      for (let i = 0; i < this.buf.length; i++) {
        const ch = this.buf[i];
        if (this.escaped) {
          switch (ch) {
            case '"':
              out += '"';
              break;
            case '\\':
              out += '\\';
              break;
            case 'n':
              out += '\n';
              break;
            case 'r':
              out += '\r';
              break;
            case 't':
              out += '\t';
              break;
            default:
              out += ch;
          }
          this.escaped = false;
        } else if (ch === '\\') {
          this.escaped = true;
        } else if (ch === '"') {
          this.state = 'done';
          this.buf = this.buf.slice(i + 1);
          return out;
        } else {
          out += ch;
        }
      }
      this.buf = '';
    }

    return out;
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

// Max number of Scout research rounds a single user message may trigger before
// the PM must produce its final reply. Backstop against the model looping on
// research_request forever.
const MAX_RESEARCH_ROUNDS = 3;

// ─── Baseline repo digest (Stage 2) ───────────────────────────────────────────
// A one-time Scout pass that maps the repo for planning, cached in .swarm/ and keyed
// to the current git HEAD so it only regenerates when the code actually moves. This
// grounds the PM on brownfield projects without a per-turn scout call. Greenfield /
// no-commit repos return '' (nothing to map yet).

const REPO_DIGEST_QUESTION =
  'Map this repository for project planning. In a concise digest cover: what this product is and does; ' +
  'the tech stack and framework versions; the main modules/directories and their responsibilities; key entry points; ' +
  'the dominant conventions and patterns; and how a typical feature is structured end to end. Favour signal over completeness.';

function currentGitHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: getRoot(),
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return null; // not a git repo, or no commits yet (greenfield)
  }
}

// Read the cached digest synchronously (instant). Returns '' if absent or stale.
function readCachedDigest(): string {
  const head = currentGitHead();
  if (!head) return ''; // greenfield / no commits — nothing to digest
  const stamp = `<!-- head: ${head} -->`;
  try {
    const cached = fs.readFileSync(path.join(swarmDir(), 'repo-digest.md'), 'utf8');
    if (cached.startsWith(stamp)) return cached.slice(stamp.length).replace(/^\n/, '');
  } catch {
    /* no cache yet */
  }
  return '';
}

// Generate the digest in the BACKGROUND (fire-and-forget). The first planning message
// must NOT block on a full Scout pass (it can take ~minute on a large repo and would
// blow the request budget); instead we kick generation off and the digest is ready for
// the NEXT turn. An in-flight guard prevents stacking concurrent generations.
let digestInFlight = false;
function ensureRepoDigestInBackground(): void {
  if (digestInFlight) return;
  const head = currentGitHead();
  if (!head || readCachedDigest()) return; // greenfield, or already fresh
  digestInFlight = true;
  getDriver()
    .runScout(REPO_DIGEST_QUESTION)
    .then(r => {
      if (r.digest?.trim()) {
        fs.mkdirSync(swarmDir(), { recursive: true });
        fs.writeFileSync(
          path.join(swarmDir(), 'repo-digest.md'),
          `<!-- head: ${head} -->\n${r.digest}`,
        );
      }
    })
    .catch(err => console.warn(`[pm] repo digest generation failed: ${(err as Error).message}`))
    .finally(() => {
      digestInFlight = false;
    });
}

export async function runPmMessage(
  text: string,
  history: HistoryMessage[],
  charter?: PmCharter,
  team?: string[],
  onChunk?: (text: string) => void,
  onResearch?: (status: {
    phase: 'started' | 'done';
    question: string;
    summary?: string;
    agent?: string;
  }) => void,
  onThinking?: (text: string) => void,
): Promise<PmResponse> {
  getConfigOptional();
  const projectCtx = loadProjectContextBounded();
  const subdirFiles = loadSubdirContextBounded();
  const subdirBlock = formatSubdirContext(subdirFiles);
  const projectRoot = getRoot();
  const projectName = path.basename(projectRoot);

  const roster = loadRoster();
  const rosterBlock = formatRoster(roster);
  const marketplaceBlock = formatMarketplace(roster.filter(a => a.enabled).map(a => a.id));
  const repoDigest = readCachedDigest(); // instant; '' until the background pass lands
  const recentHistory = charter ? history.slice(-6) : history;
  const exchangeCount = history.filter(m => m.from === 'you').length;
  const charterBlock = formatCharter(charter ?? null, team ?? []);
  const estimatedTokens = estimateTokens(
    PM_SYSTEM,
    projectCtx,
    subdirBlock,
    charterBlock,
    rosterBlock,
    formatHistory(recentHistory),
    text,
  );
  const ctxNote = contextNote(estimatedTokens, exchangeCount);

  // Build the conversation prompt, optionally appending Scout digests gathered on
  // earlier rounds of THIS user message so the PM plans with real context.
  const buildConversationPrompt = (researchNotes: string): string =>
    [
      `Current project: ${projectName} (${projectRoot})`,
      projectCtx ? `\nProject context (CLAUDE.md):\n${projectCtx}\n` : '',
      repoDigest
        ? `\nRepository overview (auto-generated by the Scout — a map of the existing code):\n${repoDigest}\n`
        : '',
      subdirBlock ? `\n${subdirBlock}\n` : '',
      charterBlock ? `${charterBlock}\n` : '',
      rosterBlock ? `${rosterBlock}\n` : '',
      `${marketplaceBlock}\n`,
      recentHistory.length ? `Recent conversation:\n${formatHistory(recentHistory)}\n` : '',
      `User's latest message: ${text}`,
      researchNotes
        ? `\nResearch findings gathered this turn (from the Scout):\n${researchNotes}`
        : '',
      ctxNote ? `\n${ctxNote}` : '',
      '',
      'Continue as the PM. Call submit_pm_response with your reply and any charter updates.',
    ]
      .filter(Boolean)
      .join('\n');

  const { loadBuiltinInstructions } = await import('../state/builtin-instructions.js');
  const builtinInstr = loadBuiltinInstructions();
  const pmSystemPrompt = builtinInstr.pm?.trim()
    ? `${PM_SYSTEM}\n\n## Additional instructions\n${builtinInstr.pm}`
    : PM_SYSTEM;

  // One PM call for a given conversation prompt. Dispatches to the api-key direct
  // path or the agent-sdk subprocess path — identical machinery to before, just
  // parameterised so the research loop can call it repeatedly.
  const runOnce = (prompt: string): Promise<PmResponse> =>
    getDriverMode() === 'api-key'
      ? runPmMessageApi(pmSystemPrompt, prompt, onChunk, onThinking)
      : runPmMessageSubprocess(pmSystemPrompt, prompt, projectRoot, onChunk, onThinking);

  // ── Research loop ──────────────────────────────────────────────────────────
  // Most turns make exactly one call and return — zero extra latency, no scout.
  // When the PM emits a research_request, run the Scout, feed its digest back, and
  // loop (up to MAX_RESEARCH_ROUNDS). The final (non-research) response is returned.
  let researchNotes = '';
  for (let round = 0; ; round++) {
    const response = await runOnce(buildConversationPrompt(researchNotes));

    const question = response.researchRequest?.question?.trim();
    if (!question || round >= MAX_RESEARCH_ROUNDS) {
      // Final turn — either the PM has enough context or we hit the round cap.
      // Kick the repo-digest pass ONLY now, after this turn's PM/Scout calls have
      // finished, so the background scout never contends with (and throttles) the
      // live PM call — that contention was timing the PM out at 90s.
      if (!repoDigest) ensureRepoDigestInBackground();
      return response;
    }

    // The PM wants the codebase investigated before it plans. Route the research:
    // if it named a HIRED specialist, run that (read-only) — it can reach live data
    // the generic Scout cannot; otherwise run the generic source-only Scout. An
    // unknown / not-hired target silently falls back to the generic Scout.
    const target = response.researchRequest?.target?.trim();
    const hired = target ? roster.find(a => a.id === target && a.enabled) : undefined;
    const who = hired ? hired.name : 'Scout';

    onResearch?.({ phase: 'started', question, agent: hired?.name });
    try {
      const r = hired
        ? await getDriver().runSpecialistResearch(hired, question)
        : await getDriver().runScout(question);
      researchNotes += `\n### Q: ${question}  (researched by ${who})\n${r.digest}\n`;
      onResearch?.({ phase: 'done', question, summary: r.summary, agent: hired?.name });
    } catch (err) {
      const msg = (err as Error).message;
      console.warn(`[pm] research failed (${who}): ${msg}`);
      researchNotes += `\n### Q: ${question}  (researched by ${who})\n(research unavailable: ${msg})\n`;
      onResearch?.({
        phase: 'done',
        question,
        summary: `research unavailable: ${msg}`,
        agent: hired?.name,
      });
    }
  }
}

// ─── Subprocess PM call (agent-sdk / Max path) ───────────────────────────────
// Spawns the claude CLI with the pm_responder MCP server and reads the structured
// response it writes. Factored out of runPmMessage so the research loop can invoke
// it once per round.

function runPmMessageSubprocess(
  pmSystemPrompt: string,
  conversationPrompt: string,
  projectRoot: string,
  onChunk?: (text: string) => void,
  onThinking?: (text: string) => void,
): Promise<PmResponse> {
  void onChunk; // subprocess path delivers the reply via the result file, not incrementally
  // ── Temp files ────────────────────────────────────────────────────────────
  const uuid = randomUUID();
  const outputPath = path.join(os.tmpdir(), `pm-output-${uuid}.json`);
  const configPath = path.join(os.tmpdir(), `pm-config-${uuid}.json`);

  // --mcp-config expects a file path, not inline JSON.
  // MCP_CMD/MCP_SERVER handle both tsx (dev) and node (compiled) environments.
  const mcpConfig = {
    mcpServers: {
      pm_responder: {
        command: MCP_CMD,
        args: [MCP_SERVER],
        env: { PM_OUTPUT_PATH: outputPath },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(mcpConfig));

  const args = [
    '--print',
    '--output-format',
    'stream-json', // NDJSON stream so we can surface the PM's thinking live
    '--verbose', // required by the CLI for stream-json under --print
    '--no-session-persistence',
    '--model',
    'claude-sonnet-4-6',
    '--strict-mcp-config', // ignore all other MCP servers
    '--mcp-config',
    configPath,
    '--allowedTools',
    'mcp__pm_responder__submit_pm_response',
    '--system-prompt',
    pmSystemPrompt,
    '--',
    conversationPrompt,
  ];

  return new Promise((resolve, reject) => {
    // Bounded tail of raw stdout, for error diagnostics only — the stream is
    // consumed incrementally below, never re-parsed as one blob.
    let stdoutTail = '';
    let stderr = '';
    let resultIsError = false;

    // Surface the PM's thinking live; capture cost/error from the terminal result.
    const ndjson = createNdjsonBuffer(raw => {
      for (const ev of parseStreamMessage(raw)) {
        if (ev.kind === 'result') {
          resultIsError = ev.isError;
          if (ev.costUsd) console.log(`[pm] cost: $${ev.costUsd.toFixed(4)}`);
        } else if (ev.kind === 'thinking' && onThinking) {
          onThinking(ev.text);
        }
      }
    });

    const proc = spawn('claude', args, {
      cwd: projectRoot,
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

    const cleanup = () => {
      try {
        fs.unlinkSync(outputPath);
      } catch {
        /* ok */
      }
      try {
        fs.unlinkSync(configPath);
      } catch {
        /* ok */
      }
    };

    // Per-call cap for one PM inference. Generous because a cold tsx MCP start plus a
    // large planning context can run long; the client uses a matching inactivity
    // budget. This bounds a SINGLE call — the research loop may make several.
    const PM_CALL_TIMEOUT_MS = 150_000;
    const timer = setTimeout(() => {
      proc.kill();
      cleanup();
      reject(new Error(`PM response timed out after ${PM_CALL_TIMEOUT_MS / 1000}s`));
    }, PM_CALL_TIMEOUT_MS);

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      ndjson.flush();

      if (resultIsError) {
        cleanup();
        reject(
          new Error(
            `claude API error during PM planning: ${stderr.slice(0, 300) || stdoutTail.slice(-300)}`,
          ),
        );
        return;
      }

      if (code !== 0 && !fs.existsSync(outputPath)) {
        const detail = stderr.slice(0, 300) || stdoutTail.slice(-300) || '(no output)';
        cleanup();
        reject(new Error(`claude exited ${code}: ${detail}`));
        return;
      }

      // Read the structured response written by the MCP server
      if (!fs.existsSync(outputPath)) {
        // Log what Claude actually said so we can debug tool-call failures
        console.error('[pm] submit_pm_response was not called');
        console.error('[pm] MCP_CMD:', MCP_CMD, '| MCP_SERVER:', MCP_SERVER);
        console.error('[pm] stdout:', stdoutTail.slice(-400));
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
      resolve(parsePmData(data));
    });
  });
}
