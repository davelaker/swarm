// PM orchestrator loop — DESIGN.md §6.3
// Phase 2: tier-aware task graph, C2 gate validation, remediation spawning.
// Phase 3+: parallel dispatch, pause/resume/abort, real-time cost SSE.

import fsp from 'node:fs/promises';
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
  getRoot,
} from './state/repo.js';
import { dispatch } from './dispatch/index.js';
import { validateFinding, hasSensitivePaths } from './agents/finding.js';
import { getConfig } from './config.js';
import { getDriver } from './drivers/index.js';
import { bus } from './state/events.js';
import { isPaused, isAborted } from './loop-control.js';
import type { SwarmState, Task } from './state/types.js';
import type { DeadlockContext } from './drivers/types.js';

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
      } catch {
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

// ─── Context window sizes (tokens) ───────────────────────────────────────────

const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-8': 200_000,
  'claude-sonnet-4-6': 200_000,
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
  return worktreePath;
}

// Serialise merges: git merge cannot run concurrently against the same repo.
// Each merge queues behind the previous one (chained even on failure).
let mergeMutex: Promise<void> = Promise.resolve();
function serialMerge(fn: () => Promise<void>): Promise<void> {
  mergeMutex = mergeMutex.then(fn, fn);
  return mergeMutex;
}

// Merge the worktree's branch back into the working branch. Serialised.
// Throws if the merge conflicts (aborting the merge first so the tree is clean).
function mergeWorktree(taskId: string): Promise<void> {
  return serialMerge(async () => {
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
      t => t.status === 'pending' && t.depends_on.every(dep => doneIds.has(dep)),
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

    // ── Dispatch all runnable tasks in parallel ───────────────────────────────
    await Promise.all(runnable.map(task => dispatchOne(task)));
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
      } catch (err) {
        clearInterval(heartbeat);
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(
          'pm',
          `✗ ${task.assignee} [${task.id}] could not create worktree: ${msg.slice(0, 200)}`,
        );
        console.error(`  ✗ ${task.id} worktree add failed: ${msg}`);
        updateTask(task.id, { status: 'failed', lease: undefined });
        return;
      }
    }

    try {
      const dispatched = { ...task, attempts: task.attempts + 1 };
      const result = await dispatch(dispatched, getState(), worktreePath);
      clearInterval(heartbeat);

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

          // Spawn a coder fix + re-review only for builtin review agents.
          // Marketplace specialists block but don't auto-spawn remediation.
          if (
            result.verdict === 'CHANGES_REQUESTED' &&
            (task.assignee === 'security' || task.assignee === 'reviewer')
          ) {
            spawnRemediation(getState(), task.id, cfg);
          }
        }
      }

      // S2: sensitive-path escalation after coder runs
      if (task.assignee === 'coder' && result.artifacts?.length) {
        const sensitive = await checkSensitivePaths(task, result.artifacts);
        if (sensitive) ensureSecurityTask(getState(), task.id, cfg);
      }

      updateTask(task.id, {
        status: finalStatus,
        result_ref: resultRef ? path.relative(swarmDir(), resultRef) : task.result_ref,
        artifacts: result.artifacts ?? task.artifacts,
        cost_usd: result.costUsd,
        lease: undefined,
      });

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
          context_pct: result.inputTokens ? contextPct(cfg.coderModel, result.inputTokens) : null,
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
      } else {
        updateTask(task.id, { status: 'pending', lease: undefined });
      }
    } finally {
      // Always clean up the worktree + branch — never leave orphans, even on
      // crash. (On the merge-failure path worktreePath is already cleared.)
      if (worktreePath) cleanupWorktree(task.id, worktreePath);
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
