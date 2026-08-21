import type { Task, TaskOutcomeTelemetry, TaskStatus } from '../state/types.js';

export type CostQuotaClass = TaskOutcomeTelemetry['costQuotaClass'];

export interface OutcomeInput {
  task: Task;
  status: TaskStatus;
  durationMs: number;
  verdict?: string;
  blocksDone?: boolean;
  costUsd?: number;
}

const GATE_AGENTS = new Set(['tester', 'security', 'reviewer', 'checks']);

/**
 * Convert runtime facts into a persistence-safe outcome. This function is
 * intentionally an allow-list: no prompt, finding summary/body, raw event, or
 * provider response can enter the record accidentally.
 */
export function buildTaskOutcome(input: OutcomeInput): TaskOutcomeTelemetry {
  const { task } = input;
  const route = task.route
    ? {
        provider: task.route.provider,
        model: task.route.model,
        ...(task.route.reasoningEffort ? { reasoningEffort: task.route.reasoningEffort } : {}),
      }
    : null;
  const verdict = input.verdict?.trim() || undefined;
  const isGate = GATE_AGENTS.has(task.assignee);

  return {
    taskId: task.id,
    agentId: task.assignee,
    route,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    retries: Math.max(0, task.attempts - 1),
    status: input.status,
    ...(verdict ? { verdict } : {}),
    ...(isGate && verdict
      ? { gateFinding: { verdict, blocksDone: Boolean(input.blocksDone) } }
      : {}),
    costQuotaClass: costQuotaClass(task, input.costUsd),
  };
}

function costQuotaClass(task: Task, costUsd: number | undefined): CostQuotaClass {
  if (task.assignee === 'checks' || task.assignee === 'visual') {
    return 'unmetered';
  }
  if (typeof costUsd === 'number' && costUsd > 0) {
    return 'api-metered';
  }
  if (task.route) {
    return 'subscription-quota';
  }
  return 'unknown';
}

/** Keep state bounded even when a long-lived workspace runs many swarms. */
export function appendOutcome(
  existing: readonly TaskOutcomeTelemetry[] | undefined,
  outcome: TaskOutcomeTelemetry,
  maxEntries = 500,
): TaskOutcomeTelemetry[] {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error('Outcome telemetry limit must be a positive safe integer.');
  }
  return [...(existing ?? []), outcome].slice(-maxEntries);
}
