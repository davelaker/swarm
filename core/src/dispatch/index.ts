// Principle 2 — narrow orchestrator↔worker boundary.
// Today: a stub that echoes.
// Phase 1: a real Coder agent runs here.
// Phase 6: the stub worker becomes an untrusted container.
// The swap happens entirely inside this file. Nothing else changes.

import type { Task, SwarmState } from '../state/types.js';

export interface TaskResult {
  status:   'done' | 'failed';
  summary:  string;
  // Path to the findings file the worker wrote, if any.
  result_ref?: string;
  // Token cost in dollars for C4 spend metering (Phase 1+).
  cost_usd?: number;
}

// Idempotency key — (task_id, attempt) pair used to de-duplicate re-dispatches.
// A worker re-run after a crash must not double-apply dangerous actions (C3).
export function idempotencyKey(task: Task): string {
  return `${task.id}:${task.attempts}`;
}

// dispatch is the ONE place the orchestrator hands work to a worker.
// Phase 0: echo stub — proves the seam without any real agent.
export async function dispatch(task: Task, _state: SwarmState): Promise<TaskResult> {
  // Stub: immediately "succeed" with a summary.
  // Phase 1 replaces this body with a real Claude agent call.
  return {
    status:  'done',
    summary: `[stub] Task ${task.id} "${task.title}" acknowledged.`,
  };
}
