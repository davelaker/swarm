// PM orchestrator loop — DESIGN.md §6.3
// Phase 1: tweak tier, single task, no concurrency.
// The four seams (config, state-repo, dispatch, events) are already wired;
// this file only coordinates them.

import { getState, updateTask, appendLog, writeFinding } from './state/repo.js';
import { dispatch } from './dispatch/index.js';
import { getConfig } from './config.js';
import type { SwarmState, Task } from './state/types.js';

const HEARTBEAT_MS   = 30_000; // refresh lease every 30 s while a task is running
const POLL_MS        = 2_000;  // wait time when all tasks are in_progress

// ─── Crash recovery ───────────────────────────────────────────────────────────
// DESIGN.md §6.4: reconcile runs at the top of every loop iteration.

function reconcile(state: SwarmState, maxAttempts: number): void {
  const now = Date.now();
  for (const task of state.tasks) {
    if (task.status !== 'in_progress') continue;
    if (!task.lease) continue;

    const expiresAt = new Date(task.lease.expires_at).getTime();
    if (now <= expiresAt) continue; // lease is still live

    // Lease expired — worker is presumed dead
    if (task.attempts < maxAttempts) {
      console.log(`  ↻ reconcile: ${task.id} lease expired (attempt ${task.attempts}/${maxAttempts}), resetting`);
      updateTask(task.id, { status: 'pending', lease: undefined });
    } else {
      console.log(`  ✗ reconcile: ${task.id} out of attempts, marking failed`);
      updateTask(task.id, { status: 'failed', lease: undefined });
    }
  }
}

// ─── Finding writer ───────────────────────────────────────────────────────────
// Produces the YAML frontmatter + body that DESIGN.md §6.2a defines
// for a builder (coder) completion report.

function buildCoderFinding(task: Task, summary: string, filesChanged: string[]): string {
  const filesSection = filesChanged.length
    ? filesChanged.map(f => `  - ${f}`).join('\n')
    : '  (none)';

  return [
    '---',
    `task: ${task.id}`,
    `agent: coder`,
    `schema: coder-finding`,
    `verdict: COMPLETE`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    '---',
    '',
    `## ${summary}`,
    '',
    '### Files changed',
    filesSection,
    '',
  ].join('\n');
}

// ─── The loop ────────────────────────────────────────────────────────────────

export interface LoopResult {
  status:      'done' | 'failed' | 'deadlock';
  totalCostUsd: number;
  message:     string;
}

export async function runLoop(): Promise<LoopResult> {
  const cfg         = getConfig();
  let   totalCost   = 0;
  let   iterations  = 0;
  const MAX_ITERS   = 100; // safety ceiling against infinite loops

  console.log('  ▸ PM loop starting…\n');

  while (iterations++ < MAX_ITERS) {
    const state = getState();

    // ── C4: global cost check ──────────────────────────────────────────────
    if (totalCost >= cfg.hardCapUsd) {
      appendLog('pm', `hard cost cap reached ($${totalCost.toFixed(4)})`);
      return { status: 'failed', totalCostUsd: totalCost, message: `Hard cost cap ($${cfg.hardCapUsd}) reached.` };
    }
    if (totalCost >= cfg.softCapUsd) {
      console.warn(`  ⚠ soft cost cap reached ($${totalCost.toFixed(4)}) — continuing`);
    }

    // ── Crash recovery ─────────────────────────────────────────────────────
    reconcile(state, cfg.maxAttempts);
    const fresh = getState(); // re-read after reconcile

    // ── Terminal: all done ─────────────────────────────────────────────────
    if (fresh.tasks.every(t => t.status === 'done')) {
      appendLog('pm', 'all tasks done');
      console.log('  ✓ all tasks done\n');
      return { status: 'done', totalCostUsd: totalCost, message: 'All tasks completed successfully.' };
    }

    // ── Terminal: any task failed out of attempts ──────────────────────────
    const failed = fresh.tasks.filter(t => t.status === 'failed');
    if (failed.length) {
      const ids = failed.map(t => t.id).join(', ');
      appendLog('pm', `tasks failed: ${ids}`);
      console.log(`  ✗ tasks failed: ${ids}\n`);
      return { status: 'failed', totalCostUsd: totalCost, message: `Tasks failed: ${ids}` };
    }

    // ── Find runnable tasks ────────────────────────────────────────────────
    // A task is runnable if: pending AND all its depends_on are done.
    const doneIds = new Set(fresh.tasks.filter(t => t.status === 'done').map(t => t.id));
    const runnable = fresh.tasks.filter(t =>
      t.status === 'pending' && t.depends_on.every(dep => doneIds.has(dep))
    );

    const inProgress = fresh.tasks.filter(t => t.status === 'in_progress');

    if (runnable.length === 0 && inProgress.length > 0) {
      // Waiting on in-progress tasks — check back soon
      await sleep(POLL_MS);
      continue;
    }

    if (runnable.length === 0 && inProgress.length === 0) {
      // Nothing runnable and nothing running — deadlock
      appendLog('pm', 'deadlock detected');
      console.error('  ✗ deadlock — nothing runnable and nothing in progress\n');
      return { status: 'deadlock', totalCostUsd: totalCost, message: 'Deadlock: task graph cannot make progress.' };
    }

    // ── Dispatch runnable tasks ────────────────────────────────────────────
    // Phase 1: sequential (one at a time). Phase 2+ adds fan-out up to concurrency cap.
    for (const task of runnable) {
      // Acquire lease (DESIGN §6.4)
      const now        = new Date();
      const expiresAt  = new Date(now.getTime() + cfg.leaseSeconds * 1000);
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
      appendLog('pm', `dispatching ${task.id} to ${task.assignee} (attempt ${task.attempts + 1})`);
      console.log(`  → dispatching ${task.id} to ${task.assignee}: "${task.title}"`);

      // Heartbeat: refresh the lease while the worker runs
      const heartbeatInterval = setInterval(() => {
        try {
          updateTask(task.id, {
            lease: { ...getState().tasks.find(t => t.id === task.id)!.lease!, heartbeat_at: new Date().toISOString() },
          });
        } catch {
          // If state can't be read during heartbeat, the loop will reconcile
        }
      }, HEARTBEAT_MS);

      try {
        // ── The dispatch call — Principle 2 boundary ───────────────────────
        const currentState = getState();
        const result       = await dispatch({ ...task, attempts: task.attempts + 1 }, currentState);

        clearInterval(heartbeatInterval);

        // Only the PM writes task status (DESIGN §5.3)
        updateTask(task.id, {
          status:     result.status,
          result_ref: result.result_ref ?? null,
          artifacts:  result.artifacts  ?? [],
          lease:      undefined,
        });

        appendLog(task.assignee, `${task.id} → ${result.status}: ${result.summary}`);
        console.log(`  ← ${task.id} ${result.status}: ${result.summary}`);

        if (result.costUsd) {
          totalCost += result.costUsd;
          console.log(`     cost: $${result.costUsd.toFixed(4)}  (total: $${totalCost.toFixed(4)})`);
        }

        // Write finding if the worker produced one
        if (result.finding) {
          const findingPath = await writeFinding(task.id, result.finding);
          updateTask(task.id, { result_ref: findingPath });
        }

      } catch (err) {
        clearInterval(heartbeatInterval);
        const msg = err instanceof Error ? err.message : String(err);
        appendLog('pm', `${task.id} errored: ${msg}`);
        console.error(`  ✗ ${task.id} errored: ${msg}`);

        // Consume one attempt; loop's reconcile handles retry/fail on next iter
        const current = getState().tasks.find(t => t.id === task.id);
        if (current && current.attempts >= cfg.maxAttempts) {
          updateTask(task.id, { status: 'failed', lease: undefined });
        } else {
          updateTask(task.id, { status: 'pending', lease: undefined });
        }
      }
    }
  }

  return { status: 'failed', totalCostUsd: totalCost, message: 'Loop safety ceiling reached (MAX_ITERS).' };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
