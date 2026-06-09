// PM orchestrator loop — DESIGN.md §6.3
// Phase 2: tier-aware task graph, C2 gate validation, remediation spawning.
// Phase 3+: parallel dispatch, pause/resume/abort, real-time cost SSE.

import fsp  from 'node:fs/promises';
import path from 'node:path';
import { getState, updateTask, addTask, appendLog, writeFinding, swarmDir } from './state/repo.js';
import { dispatch }        from './dispatch/index.js';
import { validateFinding, hasSensitivePaths } from './agents/finding.js';
import { getConfig }       from './config.js';
import { bus }             from './state/events.js';
import { isPaused, isAborted } from './loop-control.js';
import type { SwarmState, Task } from './state/types.js';

const HEARTBEAT_MS = 30_000;
const POLL_MS      = 500;

export interface LoopResult {
  status:       'done' | 'failed' | 'deadlock';
  totalCostUsd: number;
  message:      string;
}

// ─── Crash recovery ───────────────────────────────────────────────────────────

function reconcile(state: SwarmState, maxAttempts: number): void {
  const now = Date.now();
  for (const task of state.tasks) {
    if (task.status !== 'in_progress' || !task.lease) continue;
    if (now <= new Date(task.lease.expires_at).getTime()) continue;

    if (task.attempts < maxAttempts) {
      console.log(`  ↻ reconcile: ${task.id} lease expired (attempt ${task.attempts}/${maxAttempts}), resetting`);
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
      try { return await fsp.readFile(path.resolve(process.cwd(), f), 'utf8'); }
      catch { return ''; }
    })
  );
  return hasSensitivePaths(contents);
}

// ─── Remediation spawning ─────────────────────────────────────────────────────
// reviewTaskId is included in the generated IDs to avoid collisions when
// multiple review agents fail in parallel and both spawn remediations.

function spawnRemediation(state: SwarmState, reviewTaskId: string, cfg: ReturnType<typeof getConfig>): void {
  const reviewAgent = state.tasks.find(t => t.id === reviewTaskId)?.assignee ?? 'security';
  const fixId       = `t_fix_${reviewTaskId}`;
  const recheckId   = `t_chk_${reviewTaskId}`;

  if (state.tasks.find(t => t.id === fixId)) return; // already spawned

  const fixTask: Task = {
    id:         fixId,
    title:      `Fix ${reviewAgent} findings from ${reviewTaskId}`,
    status:     'pending',
    owner:      cfg.owner,
    assignee:   'coder',
    // No dependency on the blocked review task — that would deadlock because
    // blocked tasks never enter the doneIds set. The coder can start immediately;
    // the review finding is already on disk and the task title names the source.
    depends_on: [],
    artifacts:  [],
    result_ref: null,
    attempts:   0,
  };

  const recheckTask: Task = {
    id:         recheckId,
    title:      `${reviewAgent === 'reviewer' ? 'Code' : 'Security'} re-review of ${fixId}`,
    status:     'pending',
    owner:      cfg.owner,
    assignee:   reviewAgent,
    depends_on: [fixId],
    artifacts:  [],
    result_ref: null,
    attempts:   0,
  };

  addTask(fixTask);
  addTask(recheckTask);
  appendLog('pm', `spawned remediation: ${fixId} → ${recheckId}`);
  console.log(`  ↳ remediation spawned: ${fixId} (coder fix) → ${recheckId} (${reviewAgent} re-review)`);
}

// ─── Security gate escalation ─────────────────────────────────────────────────

function ensureSecurityTask(state: SwarmState, coderTaskId: string, cfg: ReturnType<typeof getConfig>): void {
  const alreadyHas = state.tasks.some(t => t.assignee === 'security');
  if (alreadyHas) return;

  const secTask: Task = {
    id:         't_sec0',
    title:      `Security review (sensitive path escalation)`,
    status:     'pending',
    owner:      cfg.owner,
    assignee:   'security',
    depends_on: [coderTaskId],
    artifacts:  [],
    result_ref: null,
    attempts:   0,
  };
  addTask(secTask);
  appendLog('pm', `sensitive path escalation: added security task ${secTask.id}`);
  console.log(`  ⚠ sensitive path detected — security task added (${secTask.id})`);
}

// ─── C2 gate check ────────────────────────────────────────────────────────────

async function validateTaskFinding(task: Task, taskId: string): Promise<boolean> {
  if (!task.result_ref) {
    if (task.assignee === 'security' || task.assignee === 'tester' || task.assignee === 'reviewer') {
      console.warn(`  ⚠ C2: ${taskId} has no finding — treating as blocking`);
      return true;
    }
    return false;
  }

  try {
    const abs     = path.resolve(swarmDir(), task.result_ref);
    const content = await fsp.readFile(abs, 'utf8');
    const valid   = validateFinding(content, taskId);

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

// ─── Context window sizes (tokens) ───────────────────────────────────────────

const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-8':            200_000,
  'claude-sonnet-4-6':          200_000,
  'claude-haiku-4-5-20251001':  200_000,
  'claude-opus-4-5-20251101':   200_000,
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

// ─── Main loop ────────────────────────────────────────────────────────────────

export async function runLoop(): Promise<LoopResult> {
  const cfg        = getConfig();
  let   totalCost  = 0;
  let   iterations = 0;
  const MAX_ITERS  = 100;

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
      return { status: 'failed', totalCostUsd: totalCost, message: `Hard cost cap ($${cfg.hardCapUsd}) reached.` };
    }
    if (totalCost >= cfg.softCapUsd && iterations % 5 === 1) {
      console.warn(`  ⚠ soft cap: $${totalCost.toFixed(4)} of $${cfg.softCapUsd}`);
    }

    // Crash recovery
    reconcile(getState(), cfg.maxAttempts);

    const state = getState();

    // ── Terminal: all tasks done ──────────────────────────────────────────────
    if (state.tasks.every(t => t.status === 'done')) {
      // Skip review tasks that have been superseded by a re-check (t_chk_<id>).
      // Without this the C2 gate would see the original CHANGES_REQUESTED finding
      // and re-block t4 even after the coder fixed the issues and t_chk_t4 passed.
      const remediatedIds = new Set(
        state.tasks
          .filter(t => t.id.startsWith('t_chk_'))
          .map(t => t.id.slice('t_chk_'.length))   // 't_chk_t4' → 't4'
      );

      let blocked = false;
      for (const t of state.tasks) {
        if (t.assignee === 'security' || t.assignee === 'tester' || t.assignee === 'reviewer') {
          if (remediatedIds.has(t.id)) continue;    // superseded — skip original
          const blocks = await validateTaskFinding(t, t.id);
          if (blocks) { blocked = true; updateTask(t.id, { status: 'blocked' }); }
        }
      }
      if (blocked) {
        console.log('  ⚑ gate check: blocking findings found — tasks reverted to blocked');
        continue;
      }
      appendLog('pm', 'all tasks done');
      bus.emit('swarm', { type: 'agent.finished', agent_id: 'pm' });
      console.log('\n  ✓ all tasks done\n');
      return { status: 'done', totalCostUsd: totalCost, message: 'All tasks completed successfully.' };
    }

    // ── Terminal: failed tasks out of attempts ────────────────────────────────
    const failed = state.tasks.filter(t => t.status === 'failed');
    if (failed.length) {
      const ids = failed.map(t => t.id).join(', ');
      appendLog('pm', `tasks failed: ${ids}`);
      return { status: 'failed', totalCostUsd: totalCost, message: `Tasks failed: ${ids}` };
    }

    // ── Find runnable tasks ───────────────────────────────────────────────────
    const doneIds  = new Set(state.tasks.filter(t => t.status === 'done').map(t => t.id));
    const runnable = state.tasks.filter(t =>
      t.status === 'pending' && t.depends_on.every(dep => doneIds.has(dep))
    );
    const inProg   = state.tasks.filter(t => t.status === 'in_progress');

    if (!runnable.length && inProg.length) {
      const who = inProg.map(t => t.assignee).join(', ');
      bus.emit('swarm', { type: 'agent.progress', agent_id: 'pm', step: `waiting for ${who}…` });
      await sleep(POLL_MS); continue;
    }

    if (!runnable.length && !inProg.length) {
      const blocked = state.tasks.filter(t => t.status === 'blocked');
      // If there are blocked tasks but also pending tasks that depend only on
      // blocked (not done) deps, those pending tasks will never run — real deadlock.
      if (blocked.length) {
        const blockedOrDoneIds = new Set(
          state.tasks.filter(t => t.status === 'done' || t.status === 'blocked').map(t => t.id)
        );
        const wouldBeRunnable = state.tasks.some(
          t => t.status === 'pending' && t.depends_on.every(dep => blockedOrDoneIds.has(dep))
        );
        if (wouldBeRunnable) {
          // There are tasks that could run if we treated blocked as satisfied —
          // this shouldn't happen now that fix tasks have empty depends_on,
          // but surface it clearly if it ever does.
          appendLog('pm', 'deadlock: pending tasks depend on blocked tasks');
          console.error('  ✗ deadlock — pending tasks depend on blocked tasks (fix: check depends_on)\n');
          return { status: 'deadlock', totalCostUsd: totalCost, message: 'Deadlock: pending tasks depend on blocked tasks.' };
        }
        await sleep(POLL_MS); continue;
      }
      appendLog('pm', 'deadlock');
      console.error('  ✗ deadlock — nothing runnable and nothing in progress\n');
      return { status: 'deadlock', totalCostUsd: totalCost, message: 'Deadlock: task graph cannot make progress.' };
    }

    // ── Dispatch all runnable tasks in parallel ───────────────────────────────
    await Promise.all(runnable.map(task => dispatchOne(task)));
  }

  return { status: 'failed', totalCostUsd: totalCost, message: 'Loop safety ceiling reached.' };

  // ─── Per-task dispatch ──────────────────────────────────────────────────────

  async function dispatchOne(task: Task): Promise<void> {
    if (isAborted()) return; // honour abort even within a parallel batch

    const now       = new Date();
    const expiresAt = new Date(now.getTime() + cfg.leaseSeconds * 1000);

    updateTask(task.id, {
      status:   'in_progress',
      attempts: task.attempts + 1,
      lease: {
        worker:       task.assignee,
        started_at:   now.toISOString(),
        heartbeat_at: now.toISOString(),
        expires_at:   expiresAt.toISOString(),
        attempt_key:  `${task.id}:${task.attempts + 1}`,
      },
    });
    appendLog('pm', `dispatching ${task.id} → ${task.assignee} (attempt ${task.attempts + 1})`);
    bus.emit('swarm', { type: 'agent.progress', agent_id: 'pm', step: `dispatching ${task.assignee}…` });
    console.log(`  → ${task.id} [${task.assignee}]: "${task.title}"`);

    const heartbeat = setInterval(() => {
      try {
        const cur = getState().tasks.find(t => t.id === task.id);
        if (cur?.lease) updateTask(task.id, { lease: { ...cur.lease, heartbeat_at: new Date().toISOString() } });
      } catch { /* reconcile handles it */ }
    }, HEARTBEAT_MS);

    try {
      const dispatched = { ...task, attempts: task.attempts + 1 };
      const result     = await dispatch(dispatched, getState());
      clearInterval(heartbeat);

      let resultRef: string | undefined;
      if (result.finding) {
        resultRef = await writeFinding(task.id, result.finding);
      }

      // C2: validate gate findings
      let finalStatus: Task['status'] = result.status;

      if (task.assignee === 'tester' || task.assignee === 'security' || task.assignee === 'reviewer') {
        const blocks = result.blocksDone ?? await validateTaskFinding(
          { ...task, result_ref: resultRef ? path.relative(swarmDir(), resultRef) : null },
          task.id
        );

        if (blocks) {
          finalStatus = 'blocked' as Task['status'];
          console.log(`  ⚑ ${task.id}: verdict ${result.verdict} blocks done`);

          if (result.verdict === 'CHANGES_REQUESTED' &&
              (task.assignee === 'security' || task.assignee === 'reviewer')) {
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
        status:    finalStatus,
        result_ref: resultRef ? path.relative(swarmDir(), resultRef) : task.result_ref,
        artifacts: result.artifacts ?? task.artifacts,
        lease:     undefined,
      });

      appendLog(task.assignee, `${task.id} → ${finalStatus}: ${result.summary}`);
      console.log(`  ← ${task.id} ${finalStatus}: ${result.summary}`);

      if (result.costUsd) {
        totalCost += result.costUsd;
        console.log(`     $${result.costUsd.toFixed(4)}  (total: $${totalCost.toFixed(4)})`);

        bus.emit('swarm', {
          type:          'task.metrics',
          task_id:       task.id,
          agent_id:      task.assignee,
          input_tokens:  result.inputTokens  ?? null,
          output_tokens: result.outputTokens ?? null,
          cost_usd:      result.costUsd,
          context_pct:   result.inputTokens ? contextPct(cfg.coderModel, result.inputTokens) : null,
        });

        emitCost(totalCost, cfg.hardCapUsd);
      }

    } catch (err) {
      clearInterval(heartbeat);
      const msg = (err instanceof Error) ? err.message : String(err);
      appendLog('pm', `${task.id} errored: ${msg}`);
      console.error(`  ✗ ${task.id} errored: ${msg}`);

      const cur = getState().tasks.find(t => t.id === task.id);
      if (cur && cur.attempts >= cfg.maxAttempts) {
        updateTask(task.id, { status: 'failed', lease: undefined });
      } else {
        updateTask(task.id, { status: 'pending', lease: undefined });
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
