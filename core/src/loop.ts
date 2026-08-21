// PM orchestrator loop — DESIGN.md §6.3
// Phase 2: tier-aware task graph, C2 gate validation, remediation spawning.
// Phase 3+: parallel dispatch, pause/resume/abort, real-time cost SSE.

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  getState,
  updateTask,
  addTask,
  appendLog,
  writeFinding,
  swarmDir,
  writeDeploymentInfo,
  readProjectMemory,
  writeProjectMemory,
  getRoot,
  recordTaskOutcome,
} from './state/repo.js';
import { dispatch } from './dispatch/index.js';
import { validateFinding, hasSensitivePaths } from './agents/finding.js';
import {
  parsePorcelain,
  newlyChanged,
  partitionDocPaths,
  listLivingDocFiles,
} from './agents/living-docs.js';
import { getConfig } from './config.js';
import { getDriver } from './drivers/index.js';
import { bus } from './state/events.js';
import { isPaused, isAborted } from './loop-control.js';
import type { SwarmState, Task } from './state/types.js';
import type { DeadlockContext } from './drivers/types.js';
import { buildTaskOutcome } from './telemetry/outcomes.js';

const HEARTBEAT_MS = 30_000;
const POLL_MS = 500;

export interface LoopResult {
  status: 'done' | 'failed' | 'deadlock';
  totalCostUsd: number;
  message: string;
}

// ─── Crash recovery ───────────────────────────────────────────────────────────

function reconcile(state: SwarmState, maxAttempts: number): void {
  const now = Date.now();
  for (const task of state.tasks) {
    if (task.status !== 'in_progress' || !task.lease) continue;
    if (now <= new Date(task.lease.expires_at).getTime()) continue;

    if (task.attempts < maxAttempts) {
      console.log(
        `  ↻ reconcile: ${task.id} lease expired (attempt ${task.attempts}/${maxAttempts}), resetting`,
      );
      updateTask(task.id, { status: 'pending', lease: undefined });
    } else {
      console.log(`  ✗ reconcile: ${task.id} out of attempts`);
      updateTask(task.id, { status: 'failed', lease: undefined });
    }
  }
}

// ─── Sensitive-path check ─────────────────────────────────────────────────────

async function checkSensitivePaths(task: Task, artifacts: string[]): Promise<boolean> {
  if (!artifacts.length) return false;
  const contents = await Promise.all(
    artifacts.map(async f => {
      try {
        return await fsp.readFile(path.resolve(process.cwd(), f), 'utf8');
      } catch (err) {
        // A missing artifact is normal (the change deleted the file). Anything
        // else is a silent fail-OPEN on a security escalation — say so loudly
        // instead of quietly skipping the S2 check for this file.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(
            `  ⚠ S2: could not read artifact ${f} for ${task.id} — ` +
              `sensitive-path check skipped for this file: ${(err as Error).message}`,
          );
        }
        return '';
      }
    }),
  );
  return hasSensitivePaths(contents);
}

// ─── Remediation spawning ─────────────────────────────────────────────────────
// gateTaskId is included in the generated IDs to avoid collisions when multiple
// gate agents block in parallel and each spawns a remediation.
//
// Generalised: spawns a fix-coder + a re-check for ANY blocking gate task — the
// builtin reviewer/security path (called from dispatchOne on CHANGES_REQUESTED)
// AND a marketplace specialist sitting in a gate position (called by the
// Negotiator on deadlock). The re-check is re-assigned to the original gate's
// assignee, so the same agent (builtin or specialist) re-reviews the fix.

function spawnRemediation(
  state: SwarmState,
  gateTaskId: string,
  cfg: ReturnType<typeof getConfig>,
): void {
  const gateAgent = state.tasks.find(t => t.id === gateTaskId)?.assignee ?? 'security';
  const fixId = `t_fix_${gateTaskId}`;
  const recheckId = `t_chk_${gateTaskId}`;

  if (state.tasks.find(t => t.id === fixId)) return; // already spawned

  const fixTask: Task = {
    id: fixId,
    title: `Fix ${gateAgent} findings from ${gateTaskId}`,
    status: 'pending',
    owner: cfg.owner,
    assignee: 'coder',
    // No dependency on the blocked gate task — that would deadlock because
    // blocked tasks never enter the doneIds set. The coder can start immediately;
    // the gate finding is already on disk and the task title names the source.
    depends_on: [],
    artifacts: [],
    result_ref: null,
    attempts: 0,
  };

  // Re-check title: builtin gates get their friendly label; a specialist re-uses
  // its own id so the title is meaningful regardless of which agent gated.
  const recheckTitle =
    gateAgent === 'reviewer'
      ? `Code re-review of ${fixId}`
      : gateAgent === 'security'
        ? `Security re-review of ${fixId}`
        : `${gateAgent} re-check of ${fixId}`;

  const recheckTask: Task = {
    id: recheckId,
    title: recheckTitle,
    status: 'pending',
    owner: cfg.owner,
    assignee: gateAgent,
    depends_on: [fixId],
    artifacts: [],
    result_ref: null,
    attempts: 0,
  };

  addTask(fixTask);
  addTask(recheckTask);
  const gateLabel =
    gateAgent === 'reviewer' ? 'Code Reviewer' : gateAgent === 'security' ? 'Security' : gateAgent;
  appendLog(
    'pm',
    `${gateLabel} flagged issues in ${gateTaskId} — asking Coder to fix them (${fixId}), then running ${gateLabel} again (${recheckId})`,
  );
  console.log(
    `  ↳ remediation spawned: ${fixId} (coder fix) → ${recheckId} (${gateAgent} re-review)`,
  );
}

// ─── Security gate escalation ─────────────────────────────────────────────────

function ensureSecurityTask(
  state: SwarmState,
  coderTaskId: string,
  cfg: ReturnType<typeof getConfig>,
): void {
  const alreadyHas = state.tasks.some(t => t.assignee === 'security');
  if (alreadyHas) return;

  const secTask: Task = {
    id: 't_sec0',
    title: `Security review (sensitive path escalation)`,
    status: 'pending',
    owner: cfg.owner,
    assignee: 'security',
    depends_on: [coderTaskId],
    artifacts: [],
    result_ref: null,
    attempts: 0,
  };
  addTask(secTask);
  appendLog(
    'pm',
    `⚠ Coder touched sensitive files — adding a Security review (${secTask.id}) before this run can complete`,
  );
  console.log(`  ⚠ sensitive path detected — security task added (${secTask.id})`);
}

// Agents that PRODUCE work (never act as gates).
// Everything else — builtin reviewers and marketplace specialists — can block.
const PRODUCER_AGENTS = new Set(['coder', 'pm', 'negotiator']);

// Every non-marketplace assignee the loop can dispatch. Anything NOT in this
// set is a hired specialist — the loop commits their main-tree writes itself
// (coders commit in their worktrees; the rest are read-only by design).
const BUILTIN_ASSIGNEES = new Set([
  'coder',
  'tester',
  'security',
  'reviewer',
  'checks',
  'visual',
  'pm',
  'negotiator',
]);

// A hired specialist whose output feeds a downstream coder is a research/data
// PROVIDER, not a gate — its findings are advisory input, never blocking. We
// detect this structurally: some coder task depends_on this task. Builtin gates
// (tester/reviewer/security) always gate; specialists gate only in a post-coder
// review position (no coder depends on them).
const BUILTIN_GATES = new Set(['tester', 'reviewer', 'security']);
function isResearchProducer(task: Task, state: SwarmState): boolean {
  if (PRODUCER_AGENTS.has(task.assignee)) return false; // already non-gating
  if (BUILTIN_GATES.has(task.assignee)) return false; // builtin gates always gate
  // marketplace specialist: producer iff a coder depends on its output
  return state.tasks.some(t => t.assignee === 'coder' && t.depends_on.includes(task.id));
}
// True when a finished task's verdict may block the run.
function taskGates(task: Task, state: SwarmState): boolean {
  return !PRODUCER_AGENTS.has(task.assignee) && !isResearchProducer(task, state);
}

// ─── C2 gate check ────────────────────────────────────────────────────────────

async function validateTaskFinding(task: Task, taskId: string): Promise<boolean> {
  if (!task.result_ref) {
    if (!PRODUCER_AGENTS.has(task.assignee)) {
      console.warn(`  ⚠ C2: ${taskId} has no finding — treating as blocking`);
      return true;
    }
    return false;
  }

  try {
    const abs = path.resolve(swarmDir(), task.result_ref);
    const content = await fsp.readFile(abs, 'utf8');
    const valid = validateFinding(content, taskId);

    if (valid.blocksDone) {
      const neg = valid.negotiable ? ' (negotiable)' : '';
      console.log(`  ⚑ C2: ${taskId} finding blocks done (verdict: ${valid.verdict}${neg})`);
    }
    return valid.blocksDone;
  } catch (err) {
    console.warn(`  ⚠ C2 fail-closed: ${taskId} finding invalid — ${(err as Error).message}`);
    return true;
  }
}

// Read verdict + summary from a finding file's frontmatter (best-effort).
// Mirrors the parser in server/index.ts. Returns empty strings if unreadable.
async function readFindingMeta(
  resultRef: string | null,
): Promise<{ verdict: string; summary: string }> {
  if (!resultRef) return { verdict: '', summary: '' };
  try {
    const abs = path.resolve(swarmDir(), resultRef);
    const content = await fsp.readFile(abs, 'utf8');
    const m = content.match(/^---[\r\n]([\s\S]*?)[\r\n]---/);
    if (!m) return { verdict: '', summary: '' };
    let verdict = '',
      summary = '';
    for (const line of m[1].split('\n')) {
      const colon = line.indexOf(':');
      if (colon < 1) continue;
      const k = line.slice(0, colon).trim();
      const v = line
        .slice(colon + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (k === 'verdict') verdict = v;
      if (k === 'summary') summary = v;
    }
    return { verdict, summary };
  } catch {
    return { verdict: '', summary: '' };
  }
}

// ─── Self-building project memory ────────────────────────────────────────────
// After a successful run, the read-only scribe distils durable, non-obvious facts
// the team learned into the project's CLAUDE.md so the next run starts smarter.
// Best-effort: never block or fail a finished run on this.

// Finding metadata + changed files for the two post-run scribes (shared input).
async function collectRunOutcome(state: SwarmState): Promise<{
  findings: Array<{ task: string; agent: string; verdict: string; summary: string }>;
  filesChanged: string[];
}> {
  const findings = await Promise.all(
    state.tasks
      .filter(t => t.result_ref)
      .map(async t => {
        const meta = await readFindingMeta(t.result_ref);
        return { task: t.id, agent: t.assignee, verdict: meta.verdict, summary: meta.summary };
      }),
  );
  const filesChanged = [
    ...new Set(state.tasks.filter(t => t.assignee === 'coder').flatMap(t => t.artifacts ?? [])),
  ];
  return { findings, filesChanged };
}

async function distillMemory(state: SwarmState): Promise<void> {
  const { findings, filesChanged } = await collectRunOutcome(state);
  const before = readProjectMemory();
  const { learnings } = await getDriver().runScribe({
    goal: state.goal ?? '',
    constraints: state.charter?.constraints ?? [],
    nongoals: state.charter?.nongoals ?? [],
    findings,
    filesChanged,
    existingMemory: before,
  });
  writeProjectMemory(learnings);
  if (learnings.trim() && learnings.trim() !== before.trim()) {
    // Commit the memory update so it doesn't leave CLAUDE.md uncommitted — a dirty
    // working tree would block the NEXT run's git-clean check. Best-effort and
    // scoped to CLAUDE.md only; runs on the run's branch alongside the coder's work.
    try {
      git(['add', 'CLAUDE.md']);
      git(['commit', '-m', 'chore(swarm): update project memory (Swarm Learnings)']);
    } catch {
      /* nothing staged / no git / hooks — non-fatal, the write still landed */
    }
    appendLog('pm', '✓ Updated project memory (CLAUDE.md) with what we learned this run.');
  }
}

// ─── Living documentation ────────────────────────────────────────────────────
// After a successful run that changed files, the docs scribe updates the HUMAN-
// facing docs (README, docs/**) if externally observable behaviour changed —
// see docs/MEMORY.md for the delineation vs CLAUDE.md learnings. The doc-only
// boundary is enforced HERE, not just in the prompt: any path the scribe touched
// that living-docs.ts does not permit is reverted before anything is committed.
// Best-effort: never block or fail a finished run on this.
async function updateLivingDocs(state: SwarmState): Promise<void> {
  const { findings, filesChanged } = await collectRunOutcome(state);
  if (!filesChanged.length) {
    return; // nothing merged — this run cannot have made the docs stale
  }

  const before = parsePorcelain(git(['status', '--porcelain']));
  const { summary } = await getDriver().runDocsScribe({
    goal: state.goal ?? '',
    tier: state.tier,
    findings,
    filesChanged,
    docFiles: listLivingDocFiles(getRoot()),
  });

  // The working tree, not the scribe's self-report, is the authority on what
  // changed. Revert anything outside the living-doc rules, keep the rest.
  const after = parsePorcelain(git(['status', '--porcelain']));
  const { docs, forbidden } = partitionDocPaths(newlyChanged(before, after));

  for (const entry of forbidden) {
    console.warn(`  ⚠ docs-scribe touched a non-doc path — reverting: ${entry.path}`);
    try {
      if (entry.untracked) {
        fs.rmSync(path.join(getRoot(), entry.path));
      } else {
        git(['checkout', '--', entry.path]);
      }
    } catch (err) {
      console.warn(`  ⚠ could not revert ${entry.path}: ${(err as Error).message}`);
    }
  }

  if (!docs.length) {
    return; // docs already accurate (or everything was reverted) — nothing to commit
  }
  const docPaths = docs.map(e => e.path);
  try {
    git(['add', ...docPaths]);
    git(['commit', '-m', 'docs(swarm): update living documentation']);
  } catch {
    /* nothing staged / no git / hooks — non-fatal, the writes still landed */
  }
  appendLog(
    'pm',
    `✓ Updated living documentation (${docPaths.join(', ')})${summary ? ` — ${summary}` : ''}`,
  );
}

// ─── Negotiator safety guardrail (NEGOTIATOR.md §2) ──────────────────────────
// The Negotiator may resolve disputes, but it can NEVER rule away a correctness or
// safety finding. `negotiable` is system-derived from the finding schema (security /
// tester / checks → false), never self-declared. Returns the id of the first blocked,
// non-negotiable target the Negotiator tried to downgrade — or null if all are
// genuinely negotiable. Fails closed: an unreadable finding is treated as protected.
async function firstNonNegotiable(taskIds: string[], state: SwarmState): Promise<string | null> {
  for (const id of taskIds) {
    const task = state.tasks.find(t => t.id === id);
    if (!task?.result_ref) {
      continue;
    }
    try {
      const abs = path.resolve(swarmDir(), task.result_ref);
      const content = await fsp.readFile(abs, 'utf8');
      const v = validateFinding(content, id);
      if (!v.negotiable && v.blocksDone) {
        return id;
      }
    } catch {
      return id; // fail closed — cannot safely downgrade what we can't validate
    }
  }
  return null;
}

// ─── Context window sizes (tokens) ───────────────────────────────────────────

// Current-generation models (Fable 5, Opus 4.8, Sonnet 5, Sonnet 4.6) all have a 1M
// context window; only Haiku 4.5 is still 200K. These were previously all recorded as
// 200K, which made the dashboard's context-% readout over-report ~5x on every
// Opus/Sonnet task. Legacy 4.5-era ids keep their real 200K window.
const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-fable-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-opus-4-5-20251101': 200_000,
  'claude-sonnet-4-5-20251101': 200_000,
};

function contextPct(model: string, inputTokens: number): number | null {
  const window = CONTEXT_WINDOWS[model];
  if (!window) return null;
  return Math.round((inputTokens / window) * 100);
}

// ─── Cost SSE ─────────────────────────────────────────────────────────────────

function emitCost(spent: number, cap: number): void {
  bus.emit('swarm', { type: 'run.cost_updated', spent, cap });
}

// ─── Git worktree isolation for coder tasks ───────────────────────────────────
// Each coder runs in its own `git worktree` so parallel coders never share a
// working directory. This prevents `git add -A` theft, files_changed
// contamination, and intermediate-state leakage between concurrent coders.

function git(args: string[], cwd: string = getRoot()): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

// Per-task diff support: while a coder runs in its worktree we expose a live
// "accumulating" diff (base → worktree working tree); once it lands we capture that
// diff to .swarm/diffs/<id>.diff so the card can keep showing it after cleanup.
const activeWorktrees = new Map<string, { path: string; base: string }>();

export function worktreeInfo(taskId: string): { path: string; base: string } | null {
  return activeWorktrees.get(taskId) ?? null;
}

function taskDiffDir(): string {
  return path.join(swarmDir(), 'diffs');
}

// Capture the task's full diff (everything since its branch base, committed or not)
// from the worktree, so the per-task view survives worktree cleanup.
function captureTaskDiff(taskId: string, worktreePath: string, base: string): void {
  try {
    const raw = git(['diff', base], worktreePath);
    fs.mkdirSync(taskDiffDir(), { recursive: true });
    fs.writeFileSync(path.join(taskDiffDir(), `${taskId}.diff`), raw);
  } catch {
    /* best-effort — a missing per-task diff just hides the card's diff toggle */
  }
}

// Symlink the project's installed node_modules into a fresh worktree so the coder can run
// tsc / build / tests to self-verify its work. `git worktree add` only materialises *tracked*
// files and node_modules is gitignored, so without this the worktree has source but no deps
// and every npm/tsc invocation fails ("node modules aren't installed"). A symlink is instant
// and points at the project's real, already-installed deps. Best-effort and skipped when a
// single top-level symlink would be unsafe — pnpm's node_modules/.pnpm symlink farm or a
// workspace monorepo, where it would resolve to the real project's packages instead of the
// worktree's edited copies; those keep the prior (no-link) behaviour rather than risk a
// wrong-package build.
function linkNodeModules(worktreePath: string, root: string): void {
  try {
    const src = path.join(root, 'node_modules');
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      return; // deps not installed — nothing to link
    }
    if (
      fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ||
      fs.existsSync(path.join(root, 'pnpm-workspace.yaml')) ||
      fs.existsSync(path.join(src, '.pnpm'))
    ) {
      return; // pnpm symlink farm — a top-level link can resolve to the wrong tree
    }
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      if (pkg.workspaces) {
        return; // workspace monorepo — hoisted deps link local packages by real path
      }
    } catch {
      /* no/invalid package.json — safe to link a plain node_modules */
    }
    fs.symlinkSync(src, path.join(worktreePath, 'node_modules'), 'dir');
  } catch {
    /* best-effort — a failed link just means the coder can't self-verify, as before */
  }
}

// Create an isolated worktree on a fresh `swarm/<task.id>` branch off HEAD.
function createWorktree(taskId: string): string {
  const worktreePath = path.join(os.tmpdir(), `swarm-${taskId}-${Date.now()}`);
  const branch = `swarm/${taskId}`;
  // If a stale branch from a crashed run lingers, delete it so `-b` succeeds.
  try {
    git(['branch', '-D', branch]);
  } catch {
    /* no such branch — fine */
  }
  git(['worktree', 'add', worktreePath, '-b', branch, 'HEAD']);
  linkNodeModules(worktreePath, getRoot());
  return worktreePath;
}

// Serialises everything that mutates the MAIN working tree so two such operations
// never overlap and see each other's half-written state:
//   • worktree merges (brief — a single `git merge`), and
//   • in-place remediation coder runs (long — a whole edit+commit cycle).
// Each operation queues behind the previous one (chained even on failure); the
// next waiter chains on completion only, never inheriting this run's value/error.
let mainTreeMutex: Promise<unknown> = Promise.resolve();
function withMainTreeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mainTreeMutex.then(fn, fn);
  mainTreeMutex = run.then(
    () => undefined,
    () => undefined,
  );
  return run as Promise<T>;
}

// Merge the worktree's branch back into the working branch. Serialised.
// Throws if the merge conflicts (aborting the merge first so the tree is clean).
function mergeWorktree(taskId: string): Promise<void> {
  return withMainTreeLock(async () => {
    const branch = `swarm/${taskId}`;
    try {
      git(['merge', '--no-ff', '-m', `merge: ${taskId} into working branch`, branch]);
    } catch (err) {
      // Conflict (or other merge failure) — abort so the main tree is left clean.
      try {
        git(['merge', '--abort']);
      } catch {
        /* nothing to abort */
      }
      const detail =
        (err as { stderr?: Buffer | string }).stderr?.toString().slice(0, 400) ??
        (err as Error).message;
      throw new Error(`merge conflict for ${taskId}: ${detail}`);
    }
  });
}

// Remove the worktree and delete its branch. Best-effort — never throws.
function cleanupWorktree(taskId: string, worktreePath: string): void {
  // Remove our node_modules symlink FIRST so teardown can never follow it into — and delete
  // the contents of — the project's real node_modules. Unlinking a symlink only drops the
  // link, never its target. (git worktree remove already unlinks rather than recurses, but
  // this makes the guarantee explicit and independent of git's behaviour.)
  try {
    const link = path.join(worktreePath, 'node_modules');
    if (fs.lstatSync(link).isSymbolicLink()) {
      fs.unlinkSync(link);
    }
  } catch {
    /* not present or not a symlink — fine */
  }
  try {
    git(['worktree', 'remove', '--force', worktreePath]);
  } catch {
    /* already gone */
  }
  try {
    git(['branch', '-D', `swarm/${taskId}`]);
  } catch {
    /* already gone */
  }
}

// ─── Runnable batch selection ────────────────────────────────────────────────
//
// A task graph can contain agents backed by different providers. Provider choice
// does not affect scheduling safety: write scopes do. Read-only tasks may always
// share a batch, while possible writers may share a batch only when both declare
// scopes that can be proven disjoint. We deliberately treat legacy/missing and
// empty writer scopes as unknown, so an older task graph cannot accidentally
// gain parallel write access merely by being upgraded to this scheduler.

function isPotentialWriter(task: Task): boolean {
  if (task.assignee === 'coder') {
    return true;
  }

  // Marketplace agents can be granted write access. Built-in non-coder agents
  // are read-only/deterministic, unless a future route explicitly declares a
  // write scope for one of them.
  return !BUILTIN_ASSIGNEES.has(task.assignee) || Boolean(task.route?.writeScope.length);
}

function declaredWriteScope(task: Task): readonly string[] | null {
  if (!isPotentialWriter(task) || !task.route?.writeScope.length) {
    return null;
  }
  return task.route.writeScope;
}

function literalScopeRoot(scope: string): string {
  const segments = scope.replace(/^\.\//, '').split('/');
  const literal: string[] = [];
  for (const segment of segments) {
    if (/[?*[{]/.test(segment)) {
      break;
    }
    literal.push(segment);
  }
  return literal.join('/');
}

function pathContains(parent: string, child: string): boolean {
  return parent === child || child.startsWith(`${parent}/`);
}

/**
 * Returns true unless two safe repo-relative glob scopes are clearly disjoint.
 * It intentionally does not try to fully implement glob intersection: any glob
 * with a common literal directory prefix might overlap and must serialize.
 */
export function writeScopesMayOverlap(
  first: readonly string[],
  second: readonly string[],
): boolean {
  if (!first.length || !second.length) {
    return true;
  }

  return first.some(firstScope =>
    second.some(secondScope => {
      const firstRoot = literalScopeRoot(firstScope);
      const secondRoot = literalScopeRoot(secondScope);
      if (!firstRoot || !secondRoot) {
        return true;
      }
      return pathContains(firstRoot, secondRoot) || pathContains(secondRoot, firstRoot);
    }),
  );
}

/** Returns a safe concurrent subset of already dependency-ready tasks. */
export function selectRunnableBatch(runnable: readonly Task[]): Task[] {
  const selected: Task[] = [];
  const selectedWriterScopes: Array<readonly string[] | null> = [];

  for (const task of runnable) {
    const scope = declaredWriteScope(task);
    if (isPotentialWriter(task)) {
      const conflicts = selectedWriterScopes.some(
        selectedScope =>
          selectedScope === null || scope === null || writeScopesMayOverlap(selectedScope, scope),
      );
      if (conflicts) {
        continue;
      }
      selectedWriterScopes.push(scope);
    }
    selected.push(task);
  }

  return selected;
}

/** Gates and reviews become runnable only after every declared producer is complete. */
export function dependenciesAreComplete(task: Task, completedTaskIds: ReadonlySet<string>): boolean {
  return task.depends_on.every(dependency => completedTaskIds.has(dependency));
}

// ─── Main loop ────────────────────────────────────────────────────────────────

export async function runLoop(): Promise<LoopResult> {
  const cfg = getConfig();
  let totalCost = 0;
  let iterations = 0;
  const MAX_ITERS = 100;

  // ── Negotiator (deadlock recovery) run-scoped guards ──────────────────────────
  // Three backstops against infinite arbitration: a hard count cap, a per-deadlock
  // signature dedupe (never arbitrate the identical blocked set twice), and the
  // "already has t_fix_" guard inside spawnRemediation.
  let negotiations = 0;
  const MAX_NEGOTIATIONS = 3;
  const negotiatedSig = new Set<string>();

  console.log('  ▸ PM loop starting…\n');

  while (iterations++ < MAX_ITERS) {
    // ── Abort / pause checkpoints ─────────────────────────────────────────────
    if (isAborted()) {
      appendLog('pm', 'aborted by user');
      return { status: 'failed', totalCostUsd: totalCost, message: 'Run aborted.' };
    }
    while (isPaused()) {
      await sleep(POLL_MS);
      if (isAborted()) {
        appendLog('pm', 'aborted while paused');
        return { status: 'failed', totalCostUsd: totalCost, message: 'Run aborted while paused.' };
      }
    }

    // C4: global cost check
    if (totalCost >= cfg.hardCapUsd) {
      appendLog('pm', `hard cost cap reached ($${totalCost.toFixed(4)})`);
      return {
        status: 'failed',
        totalCostUsd: totalCost,
        message: `Hard cost cap ($${cfg.hardCapUsd}) reached.`,
      };
    }
    if (totalCost >= cfg.softCapUsd && iterations % 5 === 1) {
      console.warn(`  ⚠ soft cap: $${totalCost.toFixed(4)} of $${cfg.softCapUsd}`);
    }

    // Crash recovery
    reconcile(getState(), cfg.maxAttempts);

    const state = getState();

    // ── Terminal: all tasks done or skipped ──────────────────────────────────
    if (state.tasks.every(t => t.status === 'done' || t.status === 'skipped')) {
      // Skip review tasks that have been superseded by a re-check (t_chk_<id>).
      // Without this the C2 gate would see the original CHANGES_REQUESTED finding
      // and re-block t4 even after the coder fixed the issues and t_chk_t4 passed.
      const remediatedIds = new Set(
        state.tasks.filter(t => t.id.startsWith('t_chk_')).map(t => t.id.slice('t_chk_'.length)), // 't_chk_t4' → 't4'
      );

      let blocked = false;
      for (const t of state.tasks) {
        if (t.status === 'skipped') continue; // no finding written — nothing to gate
        if (!taskGates(t, state)) continue; // producers + research providers never gate
        if (remediatedIds.has(t.id)) continue; // superseded — skip original
        const blocks = await validateTaskFinding(t, t.id);
        if (blocks) {
          blocked = true;
          updateTask(t.id, { status: 'blocked' });
        }
      }
      if (blocked) {
        console.log('  ⚑ gate check: blocking findings found — tasks reverted to blocked');
        continue;
      }
      const skippedCount = state.tasks.filter(t => t.status === 'skipped').length;
      const doneCount = state.tasks.filter(t => t.status === 'done').length;
      if (skippedCount) {
        appendLog(
          'pm',
          `✓ ${doneCount} task${doneCount !== 1 ? 's' : ''} complete · ${skippedCount} skipped — ` +
            `the Coder produced no recorded file changes so downstream agents were skipped. ` +
            `Use **View Changes** to check whether commits were made. ` +
            `If changes exist but weren't recorded, this is a detection gap — re-run or push manually. ` +
            `If no changes were made, go back to **Planning** and give the Coder a more specific goal.`,
        );
      } else {
        appendLog(
          'pm',
          `✓ All ${state.tasks.length} task${state.tasks.length === 1 ? '' : 's'} complete — run finished`,
        );
      }
      bus.emit('swarm', { type: 'agent.finished', agent_id: 'pm' });
      if (state.executionShape !== 'quick_task') {
        // Self-building memory — distil durable learnings into CLAUDE.md (best-effort).
        await distillMemory(state).catch(err =>
          console.warn(`  [scribe] memory distillation skipped: ${(err as Error).message}`),
        );
        // Living documentation — keep human docs true to the merged behaviour (best-effort).
        await updateLivingDocs(state).catch(err =>
          console.warn(`  [docs-scribe] living-docs update skipped: ${(err as Error).message}`),
        );
      }
      console.log('\n  ✓ all tasks done\n');
      return {
        status: 'done',
        totalCostUsd: totalCost,
        message: 'All tasks completed successfully.',
      };
    }

    // ── Terminal: failed tasks out of attempts ────────────────────────────────
    const failed = state.tasks.filter(t => t.status === 'failed');
    if (failed.length) {
      const failedDesc = failed.map(t => `${t.id} (${t.assignee}: "${t.title}")`).join(', ');
      appendLog('pm', `✗ Run stopped — failed tasks: ${failedDesc}`);
      return { status: 'failed', totalCostUsd: totalCost, message: `Tasks failed: ${failedDesc}` };
    }

    // ── Find runnable tasks ───────────────────────────────────────────────────
    // Skipped tasks satisfy dependencies the same as done — their dependents were
    // already recursively skipped by skipDependents(), so this is belt-and-suspenders.
    const doneIds = new Set(
      state.tasks.filter(t => t.status === 'done' || t.status === 'skipped').map(t => t.id),
    );
    const runnable = state.tasks.filter(
      t => t.status === 'pending' && dependenciesAreComplete(t, doneIds),
    );
    const inProg = state.tasks.filter(t => t.status === 'in_progress');

    if (!runnable.length && inProg.length) {
      const who = inProg.map(t => t.assignee).join(', ');
      bus.emit('swarm', { type: 'agent.progress', agent_id: 'pm', step: `waiting for ${who}…` });
      await sleep(POLL_MS);
      continue;
    }

    if (!runnable.length && !inProg.length) {
      const blocked = state.tasks.filter(t => t.status === 'blocked');
      // If there are blocked tasks but also pending tasks that depend only on
      // blocked (not done) deps, those pending tasks will never run — real deadlock.
      if (blocked.length) {
        const blockedOrDoneIds = new Set(
          state.tasks.filter(t => t.status === 'done' || t.status === 'blocked').map(t => t.id),
        );
        const wouldBeRunnable = state.tasks.some(
          t => t.status === 'pending' && t.depends_on.every(dep => blockedOrDoneIds.has(dep)),
        );
        if (wouldBeRunnable) {
          // There are tasks that could run if we treated blocked as satisfied —
          // this shouldn't happen now that fix tasks have empty depends_on,
          // but surface it clearly if it ever does. Attempt deadlock recovery
          // before giving up.
          appendLog('pm', 'deadlock: pending tasks depend on blocked tasks');
          console.error(
            '  ✗ deadlock — pending tasks depend on blocked tasks (fix: check depends_on)\n',
          );
          const r = await recoverFromDeadlock(getState());
          if (r === 'continue') continue;
          return r;
        }
        await sleep(POLL_MS);
        continue;
      }
      appendLog('pm', 'deadlock');
      console.error('  ✗ deadlock — nothing runnable and nothing in progress\n');
      const r = await recoverFromDeadlock(getState());
      if (r === 'continue') continue;
      return r;
    }

    // ── Dispatch a write-safe batch in parallel ───────────────────────────────
    // Tasks in this batch may use different providers. Dependencies were checked
    // above; this additional gate only prevents concurrent possible writes whose
    // declared scopes overlap (or cannot be proven disjoint).
    const batch = selectRunnableBatch(runnable);
    await Promise.all(batch.map(task => dispatchOne(task)));
  }

  return { status: 'failed', totalCostUsd: totalCost, message: 'Loop safety ceiling reached.' };

  // ─── Per-task dispatch ──────────────────────────────────────────────────────

  async function dispatchOne(task: Task): Promise<void> {
    if (isAborted()) return; // honour abort even within a parallel batch

    const now = new Date();
    const expiresAt = new Date(now.getTime() + cfg.leaseSeconds * 1000);

    updateTask(task.id, {
      status: 'in_progress',
      attempts: task.attempts + 1,
      lease: {
        worker: task.assignee,
        started_at: now.toISOString(),
        heartbeat_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        attempt_key: `${task.id}:${task.attempts + 1}`,
      },
    });
    const attemptNote = task.attempts + 1 > 1 ? ` (retry ${task.attempts + 1})` : '';
    appendLog('pm', `→ ${task.assignee} [${task.id}]${attemptNote}: "${task.title}"`);
    // Use "X running…" not "dispatching X…" — the former reflects the sustained wait
    // while the PM loop is blocked on Promise.all; "dispatching" would remain stale.
    bus.emit('swarm', {
      type: 'agent.progress',
      agent_id: 'pm',
      step: `${task.assignee} running…`,
    });
    console.log(`  → ${task.id} [${task.assignee}]: "${task.title}"`);

    const heartbeat = setInterval(() => {
      try {
        const cur = getState().tasks.find(t => t.id === task.id);
        if (cur?.lease)
          updateTask(task.id, { lease: { ...cur.lease, heartbeat_at: new Date().toISOString() } });
      } catch {
        /* reconcile handles it */
      }
    }, HEARTBEAT_MS);

    // Write CLAUDE.md on the first Coder attempt — not during planning.
    if (task.assignee === 'coder' && task.attempts === 0) {
      const deploymentInfo = getState().charter?.deploymentInfo;
      if (deploymentInfo) {
        try {
          writeDeploymentInfo(deploymentInfo);
        } catch {
          /* non-fatal */
        }
      }
    }

    // Coders run in an isolated git worktree so parallel coders never collide;
    // non-coder (read-only) agents share the main working directory.
    //
    // Remediation/fix coders are the exception: they run IN-PLACE on the working
    // branch with no worktree and no merge-back. A fix task exists only to repair a
    // previous coder's *already-merged* work, so it must build on that work
    // directly. Branching a fresh worktree off HEAD and merging it back over the
    // same files produced spurious "local changes would be overwritten" conflicts
    // against the very changes it was fixing. Fix tasks are sequential (spawned by
    // a blocked gate), so they don't need worktree isolation.
    const isCoder = task.assignee === 'coder';
    const isFixTask = task.id.startsWith('t_fix_');
    let worktreePath: string | undefined;
    if (isCoder && !isFixTask) {
      try {
        worktreePath = createWorktree(task.id);
        // Track the worktree + its base commit so the per-task diff endpoint can show
        // the change accumulating live, and so we can capture the final diff on landing.
        activeWorktrees.set(task.id, {
          path: worktreePath,
          base: git(['rev-parse', 'HEAD']).trim(),
        });
      } catch (err) {
        clearInterval(heartbeat);
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(
          'pm',
          `✗ ${task.assignee} [${task.id}] could not create worktree: ${msg.slice(0, 200)}`,
        );
        console.error(`  ✗ ${task.id} worktree add failed: ${msg}`);
        updateTask(task.id, { status: 'failed', lease: undefined });
        recordTaskOutcome(buildTaskOutcome({
          task: { ...task, attempts: task.attempts + 1 },
          status: 'failed',
          durationMs: Date.now() - now.getTime(),
        }));
        return;
      }
    }

    try {
      const dispatched = { ...task, attempts: task.attempts + 1 };
      // An in-place fix coder edits the main working tree for its whole run, so it
      // must hold the main-tree lock end-to-end — otherwise a parallel coder's
      // worktree merge could land mid-edit and clobber its uncommitted changes
      // (the same "local changes would be overwritten" failure, just relocated).
      // Worktree coders run unlocked here and only take the lock briefly at merge.
      const result =
        isCoder && isFixTask
          ? await withMainTreeLock(() => dispatch(dispatched, getState(), worktreePath))
          : await dispatch(dispatched, getState(), worktreePath);
      clearInterval(heartbeat);

      // Coder has finished + committed in its worktree: capture the per-task diff to
      // disk and stop serving the live worktree view (switch the card to the snapshot).
      const wt = activeWorktrees.get(task.id);
      if (wt) {
        captureTaskDiff(task.id, wt.path, wt.base);
        activeWorktrees.delete(task.id);
      }

      // Merge the coder's isolated branch back into the working branch
      // (serialised — one merge at a time). A conflict marks the task failed.
      if (isCoder && worktreePath) {
        try {
          await mergeWorktree(task.id);
        } catch (mergeErr) {
          const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
          appendLog('pm', `✗ ${task.assignee} [${task.id}] merge failed: ${msg.slice(0, 200)}`);
          console.error(`  ✗ ${task.id} merge failed: ${msg}`);
          cleanupWorktree(task.id, worktreePath);
          worktreePath = undefined; // already cleaned up — skip the finally block
          updateTask(task.id, { status: 'failed', lease: undefined });
          recordTaskOutcome(buildTaskOutcome({
            task: { ...task, attempts: task.attempts + 1 },
            status: 'failed',
            durationMs: Date.now() - now.getTime(),
          }));
          return;
        }
      }

      let resultRef: string | undefined;
      if (result.finding) {
        resultRef = await writeFinding(task.id, result.finding);
      }

      // C2: validate gate findings
      let finalStatus: Task['status'] = result.status;

      if (taskGates(task, getState())) {
        const blocks =
          result.blocksDone ??
          (await validateTaskFinding(
            { ...task, result_ref: resultRef ? path.relative(swarmDir(), resultRef) : null },
            task.id,
          ));

        if (blocks) {
          finalStatus = 'blocked' as Task['status'];
          console.log(`  ⚑ ${task.id}: verdict ${result.verdict} blocks done`);

          // Spawn a coder fix + re-check for builtin gates (LLM reviewers on
          // CHANGES_REQUESTED, the deterministic checks gate on FAIL). Marketplace
          // specialists block but don't auto-spawn remediation.
          const reviewerBlocked =
            result.verdict === 'CHANGES_REQUESTED' &&
            (task.assignee === 'security' || task.assignee === 'reviewer');
          const checksBlocked = result.verdict === 'FAIL' && task.assignee === 'checks';
          if (reviewerBlocked || checksBlocked) {
            spawnRemediation(getState(), task.id, cfg);
          }
        }
      }

      // S2: sensitive-path escalation after coder runs
      if (task.assignee === 'coder' && result.artifacts?.length) {
        const sensitive = await checkSensitivePaths(task, result.artifacts);
        if (sensitive) ensureSecurityTask(getState(), task.id, cfg);
      }

      // Marketplace specialists run in the MAIN tree with no worktree and no
      // merge-back — commit their reported writes so the work is preserved and
      // the next run's clean-tree check doesn't block on a dirty tree. Under
      // the tree lock so it can never interleave with a coder merge.
      if (!BUILTIN_ASSIGNEES.has(task.assignee) && result.artifacts?.length) {
        await withMainTreeLock(async () => {
          try {
            git(['add', '--', ...result.artifacts!]);
            git(['commit', '-m', `chore(swarm): ${task.assignee} output for ${task.id}`]);
            console.log(`  ▸ committed ${task.assignee} writes: ${result.artifacts!.join(', ')}`);
          } catch (err) {
            // Nothing staged (agent over-reported), or hooks — non-fatal, but say so.
            console.warn(
              `  ⚠ could not commit ${task.assignee} writes: ${(err as Error).message.slice(0, 200)}`,
            );
          }
        });
      }

      updateTask(task.id, {
        status: finalStatus,
        result_ref: resultRef ? path.relative(swarmDir(), resultRef) : task.result_ref,
        artifacts: result.artifacts ?? task.artifacts,
        cost_usd: result.costUsd,
        lease: undefined,
      });

      recordTaskOutcome(buildTaskOutcome({
        task: { ...task, attempts: task.attempts + 1 },
        status: finalStatus,
        durationMs: Date.now() - now.getTime(),
        verdict: result.verdict,
        blocksDone: finalStatus === 'blocked',
        costUsd: result.costUsd,
      }));

      // E1: early-exit — skip downstream tasks when a dependency produced nothing actionable.
      // Coder with no file output: testers, reviewers, and security agents downstream
      // have nothing to work on. Security APPROVED with no findings: any spawned fix
      // coder tasks are redundant.
      skipDependents(task.id, result);

      appendLog(task.assignee, `${task.id} → ${finalStatus}: ${result.summary}`);
      console.log(`  ← ${task.id} ${finalStatus}: ${result.summary}`);

      if (result.costUsd) {
        totalCost += result.costUsd;
        console.log(`     $${result.costUsd.toFixed(4)}  (total: $${totalCost.toFixed(4)})`);

        bus.emit('swarm', {
          type: 'task.metrics',
          task_id: task.id,
          agent_id: task.assignee,
          input_tokens: result.inputTokens ?? null,
          output_tokens: result.outputTokens ?? null,
          cost_usd: result.costUsd,
          // Use THIS task's model — a haiku task (200K window) measured against
          // the global coder model's 1M window under-reported context use ~5x.
          context_pct: result.inputTokens
            ? contextPct(task.model ?? cfg.coderModel, result.inputTokens)
            : null,
        });

        emitCost(totalCost, cfg.hardCapUsd);
      }
    } catch (err) {
      clearInterval(heartbeat);
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('pm', `✗ ${task.assignee} [${task.id}] errored: ${msg.slice(0, 200)}`);
      console.error(`  ✗ ${task.id} errored: ${msg}`);

      const cur = getState().tasks.find(t => t.id === task.id);
      if (cur && cur.attempts >= cfg.maxAttempts) {
        updateTask(task.id, { status: 'failed', lease: undefined });
        recordTaskOutcome(buildTaskOutcome({
          task: cur,
          status: 'failed',
          durationMs: Date.now() - now.getTime(),
        }));
      } else {
        updateTask(task.id, { status: 'pending', lease: undefined });
      }
    } finally {
      // Always clean up the worktree + branch — never leave orphans, even on
      // crash. (On the merge-failure path worktreePath is already cleared.)
      if (worktreePath) cleanupWorktree(task.id, worktreePath);
      // Drop any live-worktree tracking left over from a thrown dispatch.
      activeWorktrees.delete(task.id);
    }
  }

  // ─── Deadlock recovery (the Negotiator) ─────────────────────────────────────
  // Invoked at the loop's deadlock points instead of silently dead-ending. Reads
  // the blocking gate findings, asks the Negotiator for a recovery decision, and
  // applies it. Returns 'continue' to resume the loop, or a terminal LoopResult.
  async function recoverFromDeadlock(state: SwarmState): Promise<'continue' | LoopResult> {
    const deadlockResult: LoopResult = {
      status: 'deadlock',
      totalCostUsd: totalCost,
      message: 'Deadlock: task graph cannot make progress.',
    };

    // Only gate tasks can be arbitrated. Producers/research providers never block.
    const blockedGates = state.tasks.filter(t => t.status === 'blocked' && taskGates(t, state));
    if (!blockedGates.length) return deadlockResult; // nothing to arbitrate

    const sig = blockedGates
      .map(t => t.id)
      .sort()
      .join(',');

    // Deterministic fallback: spawn a fix for any un-remediated blocked gate, else
    // log an informative (never silent) deadlock and return the deadlock result.
    const deterministicFallback = (): 'continue' | LoopResult => {
      let spawned = false;
      for (const t of getState().tasks.filter(
        x => x.status === 'blocked' && taskGates(x, getState()),
      )) {
        if (getState().tasks.find(x => x.id === `t_fix_${t.id}`)) continue; // already has a fix
        spawnRemediation(getState(), t.id, cfg);
        spawned = true;
      }
      if (spawned) return 'continue';
      const detail = blockedGates.map(t => `${t.id} (${t.assignee}: "${t.title}")`).join('; ');
      appendLog(
        'pm',
        `⚑ Deadlock — blocked gate task(s) cannot be resolved automatically: ${detail}. Review the findings and decide how to proceed.`,
      );
      console.error(`  ✗ deadlock — unresolved blocked gates: ${detail}\n`);
      return { ...deadlockResult, message: `Deadlock — unresolved blocked gate(s): ${detail}` };
    };

    // Cap / dedupe backstops — fall back deterministically rather than loop forever.
    if (negotiatedSig.has(sig) || negotiations >= MAX_NEGOTIATIONS) {
      return deterministicFallback();
    }

    // Build the deadlock context for the arbiter.
    const blocked = await Promise.all(
      blockedGates.map(async t => {
        const meta = await readFindingMeta(t.result_ref);
        return {
          taskId: t.id,
          assignee: t.assignee,
          title: t.title,
          verdict: meta.verdict,
          summary: meta.summary,
          findingPath: t.result_ref,
        };
      }),
    );
    const ctx: DeadlockContext = {
      goal: state.goal ?? state.charter?.constraints?.join(' | ') ?? '',
      blocked,
      tasks: state.tasks,
    };

    negotiations++;
    negotiatedSig.add(sig);

    let decision;
    try {
      decision = await getDriver().runNegotiator(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog(
        'pm',
        `Negotiator errored (${msg.slice(0, 120)}) — falling back to auto-remediation`,
      );
      console.error(`  ✗ negotiator errored: ${msg}`);
      return deterministicFallback();
    }

    // Apply the decision.
    if (decision.decision === 'ABORT') {
      appendLog('pm', `Negotiator: aborting — ${decision.reasoning}`);
      return { status: 'failed', totalCostUsd: totalCost, message: decision.reasoning };
    }

    if (decision.decision === 'DOWNGRADE') {
      // S1 guardrail: refuse to downgrade a non-negotiable correctness/safety finding.
      const protectedId = await firstNonNegotiable(decision.targetTaskIds, getState());
      if (protectedId) {
        const msg =
          `Negotiator tried to downgrade a non-negotiable finding (${protectedId}). ` +
          `A correctness or safety finding can never be ruled away — stopping so a human can decide.`;
        appendLog('pm', `⚠ ${msg}`);
        console.error(`  ✗ S1 guardrail: ${msg}`);
        return { status: 'failed', totalCostUsd: totalCost, message: msg };
      }
      for (const id of decision.targetTaskIds) {
        if (getState().tasks.some(t => t.id === id && t.status === 'blocked')) {
          updateTask(id, { status: 'done' }); // unblock — advisory finding stays on disk
        }
      }
      appendLog('pm', `Negotiator: ${decision.reasoning}`);
      return 'continue';
    }

    // SPAWN_FIX (default).
    for (const id of decision.targetTaskIds) {
      if (getState().tasks.some(t => t.id === id && t.status === 'blocked')) {
        spawnRemediation(getState(), id, cfg);
      }
    }
    appendLog('pm', `Negotiator: ${decision.reasoning}`);
    return 'continue';
  }
}

function skipDependents(
  completedId: string,
  result: import('./dispatch/index.js').TaskResult,
): void {
  const isEmptyCoder = result.artifacts !== undefined && result.artifacts.length === 0;
  const isNoopSecurity =
    result.verdict === 'APPROVED' &&
    result.artifacts !== undefined &&
    result.artifacts.length === 0;

  if (!isEmptyCoder && !isNoopSecurity) return;

  const reason = isEmptyCoder
    ? `Skipped: upstream task ${completedId} produced no file changes`
    : `Skipped: security audit found no issues (${completedId} returned APPROVED)`;

  // Iteratively skip all transitively dependent tasks so the loop doesn't deadlock
  // on tasks that depend on an already-skipped task.
  const toProcess = [completedId];
  while (toProcess.length) {
    const parentId = toProcess.pop()!;
    const state = getState();
    for (const t of state.tasks) {
      if (t.status !== 'pending') continue;
      if (!t.depends_on.includes(parentId)) continue;
      updateTask(t.id, { status: 'skipped', skip_reason: reason });
      appendLog('pm', `↷ ${t.id} skipped — ${reason}`);
      console.log(`  ↷ ${t.id} skipped: ${reason}`);
      toProcess.push(t.id);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
