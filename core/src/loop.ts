// PM orchestrator loop — DESIGN.md §6.3
// Phase 2: tier-aware task graph, C2 gate validation, remediation spawning.

import fsp  from 'node:fs/promises';
import path from 'node:path';
import { getState, updateTask, addTask, appendLog, writeFinding, swarmDir } from './state/repo.js';
import { dispatch }        from './dispatch/index.js';
import { validateFinding, hasSensitivePaths } from './agents/finding.js';
import { getConfig }       from './config.js';
import type { SwarmState, Task } from './state/types.js';

const HEARTBEAT_MS = 30_000;
const POLL_MS      = 2_000;

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
// S2: read changed files after the coder runs; escalate to security if needed.

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
// When Security returns CHANGES_REQUESTED, spawn:
//   fix task  → coder, depends_on: [original_coder_task_id]
//   re-review → security, depends_on: [fix_task_id]

function spawnRemediation(state: SwarmState, securityTaskId: string, cfg: ReturnType<typeof getConfig>): void {
  const existing = state.tasks;
  const remCount = existing.filter(t => t.id.startsWith('t_fix')).length;
  const fixId    = `t_fix${remCount + 1}`;
  const recheckId = `t_sec${remCount + 1}`;

  // Find the original coder task this security review was about
  const secTask    = existing.find(t => t.id === securityTaskId);
  const coderDepId = secTask?.depends_on[0] ?? 't1';

  const fixTask: Task = {
    id:         fixId,
    title:      `Fix security findings from ${securityTaskId}`,
    status:     'pending',
    owner:      cfg.owner,
    assignee:   'coder',
    depends_on: [securityTaskId],
    artifacts:  [],
    result_ref: null,
    attempts:   0,
  };

  const recheckTask: Task = {
    id:         recheckId,
    title:      `Security re-review of ${fixId}`,
    status:     'pending',
    owner:      cfg.owner,
    assignee:   'security',
    depends_on: [fixId],
    artifacts:  [],
    result_ref: null,
    attempts:   0,
  };

  addTask(fixTask);
  addTask(recheckTask);
  appendLog('pm', `spawned remediation: ${fixId} → ${recheckId}`);
  console.log(`  ↳ remediation spawned: ${fixId} (coder fix) → ${recheckId} (security re-review)`);
}

// ─── Security gate escalation ─────────────────────────────────────────────────
// If not already in the graph and sensitive paths detected, add security task.

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
// Read the finding file and validate its frontmatter.
// If validation fails → task stays blocked (fail closed).
// Returns true if the finding BLOCKS done (blocksDone: true).

async function validateTaskFinding(task: Task, taskId: string): Promise<boolean> {
  if (!task.result_ref) {
    // Required gate with no finding → fail closed
    if (task.assignee === 'security' || task.assignee === 'tester') {
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
      console.log(`  ⚑ C2: ${taskId} finding blocks done (verdict: ${valid.verdict})`);
    }
    return valid.blocksDone;
  } catch (err) {
    console.warn(`  ⚠ C2 fail-closed: ${taskId} finding invalid — ${(err as Error).message}`);
    return true; // absence or corruption → fail closed
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

export async function runLoop(): Promise<LoopResult> {
  const cfg        = getConfig();
  let   totalCost  = 0;
  let   iterations = 0;
  const MAX_ITERS  = 100;

  console.log('  ▸ PM loop starting…\n');

  while (iterations++ < MAX_ITERS) {
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
      // C2: check that no done task has a blocking finding
      let blocked = false;
      for (const t of state.tasks) {
        if (t.assignee === 'security' || t.assignee === 'tester') {
          const blocks = await validateTaskFinding(t, t.id);
          if (blocks) { blocked = true; updateTask(t.id, { status: 'blocked' }); }
        }
      }
      if (blocked) {
        console.log('  ⚑ gate check: blocking findings found — tasks reverted to blocked');
        continue; // loop picks up the blocked state and handles remediation
      }
      appendLog('pm', 'all tasks done');
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

    if (!runnable.length && inProg.length) { await sleep(POLL_MS); continue; }

    if (!runnable.length && !inProg.length) {
      // Check if any tasks are blocked (gate-blocked, waiting for remediation)
      const blocked = state.tasks.filter(t => t.status === 'blocked');
      if (blocked.length) {
        // Remediation tasks should have already been spawned; if the only
        // remaining work is blocked tasks with pending remediation, keep running
        await sleep(POLL_MS); continue;
      }
      appendLog('pm', 'deadlock');
      console.error('  ✗ deadlock — nothing runnable and nothing in progress\n');
      return { status: 'deadlock', totalCostUsd: totalCost, message: 'Deadlock: task graph cannot make progress.' };
    }

    // ── Dispatch each runnable task (sequential in Phase 2) ───────────────────
    for (const task of runnable) {
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

        // Write finding to disk (the loop, not the worker, owns this write)
        let resultRef: string | undefined;
        if (result.finding) {
          resultRef = await writeFinding(task.id, result.finding);
        }

        // ── C2: validate gate findings before accepting done ──────────────────
        let finalStatus: Task['status'] = result.status;

        if (task.assignee === 'tester' || task.assignee === 'security') {
          const blocks = result.blocksDone ?? await validateTaskFinding(
            { ...task, result_ref: resultRef ? path.relative(swarmDir(), resultRef) : null },
            task.id
          );

          if (blocks) {
            finalStatus = 'blocked' as Task['status'];
            console.log(`  ⚑ ${task.id}: verdict ${result.verdict} blocks done`);

            // ── Remediation: security CHANGES_REQUESTED → spawn fix + re-review
            if (task.assignee === 'security' && result.verdict === 'CHANGES_REQUESTED') {
              const freshState = getState();
              spawnRemediation(freshState, task.id, cfg);
            }
          }
        }

        // ── S2: sensitive-path escalation after coder runs ────────────────────
        if (task.assignee === 'coder' && result.artifacts?.length) {
          const sensitive = await checkSensitivePaths(task, result.artifacts);
          if (sensitive) {
            ensureSecurityTask(getState(), task.id, cfg);
          }
        }

        // Only the PM writes task status (DESIGN §5.3)
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
        }

      } catch (err) {
        clearInterval(heartbeat);
        const msg = (err instanceof Error) ? err.message : String(err);
        appendLog('pm', `${task.id} errored: ${msg}`);
        console.error(`  ✗ ${task.id} errored: ${msg}`);

        const cur = getState().tasks.find(t => t.id === task.id);
        if (cur && (cur.attempts) >= cfg.maxAttempts) {
          updateTask(task.id, { status: 'failed', lease: undefined });
        } else {
          updateTask(task.id, { status: 'pending', lease: undefined });
        }
      }
    }
  }

  return { status: 'failed', totalCostUsd: totalCost, message: 'Loop safety ceiling reached.' };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
