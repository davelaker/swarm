// Principle 2 — narrow orchestrator↔worker boundary.
// Now driver-agnostic: routes by assignee, delegates to whichever driver
// is active (agent-sdk for Max plan, api-key for console.anthropic.com).
// Phase 5: Negotiator. Phase 6: sandboxed containers.

import type { Task, SwarmState, TaskRoute } from '../state/types.js';
import { getDriver, getDriverForProvider } from '../drivers/index.js';
import { loadRoster } from '../state/roster.js';
import { runDeterministicChecks } from '../agents/checks.js';
import { runVisualCheck } from '../agents/visual.js';
import {
  getProviderModel,
  getProviderModelPolicy,
  getProviderSelection,
  providerCanExecuteModel,
  type ModelCapability,
  type ProviderAvailability,
} from '../providers/index.js';

export interface TaskResult {
  status: 'done' | 'failed';
  summary: string;
  artifacts?: string[];
  finding?: string; // raw markdown — loop writes to disk
  costUsd?: number;
  inputTokens?: number; // api-key driver only
  outputTokens?: number;
  verdict?: string;
  blocksDone?: boolean;
}

export function idempotencyKey(task: Task): string {
  return `${task.id}:${task.attempts}`;
}

const DONE_VERDICTS = new Set(['COMPLETE', 'PASS', 'APPROVED']);
const BLOCKS_VERDICTS = new Set(['CHANGES_REQUESTED', 'FAIL', 'FAILED']);

function capabilityForTask(task: Task): ModelCapability | undefined {
  if (task.assignee === 'coder') {
    return 'coding';
  }
  if (task.assignee === 'tester' || task.assignee === 'security' || task.assignee === 'reviewer') {
    return 'review';
  }
  if (task.assignee === 'checks' || task.assignee === 'visual') {
    return undefined;
  }
  return 'coding';
}

function validateFallback(
  route: TaskRoute,
  availability: readonly ProviderAvailability[],
  enabledModelIds: readonly string[],
): void {
  if (!route.fallback) {
    return;
  }
  if (!enabledModelIds.includes(route.fallback.model)) {
    throw new Error(`Task route fallback model "${route.fallback.model}" is disabled by the current model policy.`);
  }
  const fallbackProvider = availability.find((entry) => entry.provider === route.fallback?.provider);
  if (!fallbackProvider?.enabled || !fallbackProvider.availableAuthModes.length) {
    throw new Error(`Task route fallback provider "${route.fallback.provider}" is unavailable or unauthorised.`);
  }
  const fallback = getProviderModel(route.fallback.model);
  if (!fallback || fallback.provider !== route.fallback.provider) {
    throw new Error(`Task route fallback model "${route.fallback.model}" does not belong to provider "${route.fallback.provider}".`);
  }
  if (!providerCanExecuteModel(fallbackProvider, fallback)) {
    throw new Error(`Task route fallback model "${fallback.id}" is unavailable through a supported local transport.`);
  }
  if (route.fallback.reasoningEffort && !fallback.reasoningEfforts.includes(route.fallback.reasoningEffort)) {
    throw new Error(`Task route fallback model "${fallback.id}" does not support "${route.fallback.reasoningEffort}" reasoning effort.`);
  }
}

/** Validates a persisted task route against current safe capability metadata. */
export function validateTaskRouteForDispatch(
  task: Task,
  availability: readonly ProviderAvailability[] = getProviderSelection().availability,
  enabledModelIds: readonly string[] = getProviderModelPolicy().enabledModelIds,
): void {
  if (!task.route) {
    return; // Legacy tasks remain supported until route recommendation is introduced.
  }
  const route = task.route;
  if (route.requiresConfirmation) {
    throw new Error(`Task ${task.id} route requires user confirmation before dispatch.`);
  }
  const capability = capabilityForTask(task);
  if (!capability) {
    throw new Error(`Task ${task.id} is deterministic and must not have an LLM route.`);
  }
  if (!enabledModelIds.includes(route.model)) {
    throw new Error(`Task ${task.id} route model "${route.model}" is disabled by the current model policy.`);
  }
  const model = getProviderModel(route.model);
  if (!model || model.provider !== route.provider) {
    throw new Error(`Task ${task.id} route model "${route.model}" is not available from provider "${route.provider}".`);
  }
  if (!model.capabilities.includes(capability)) {
    throw new Error(`Task ${task.id} route model "${route.model}" cannot perform ${capability} work.`);
  }
  if (route.reasoningEffort && !model.reasoningEfforts.includes(route.reasoningEffort)) {
    throw new Error(`Task ${task.id} route model "${route.model}" does not support "${route.reasoningEffort}" reasoning effort.`);
  }
  if (task.assignee === 'coder' && !route.writeScope.length) {
    throw new Error(`Task ${task.id} coder route must declare a non-empty write scope.`);
  }
  const provider = availability.find((entry) => entry.provider === route.provider);
  if (!provider?.enabled || !provider.availableAuthModes.length) {
    throw new Error(`Task ${task.id} route provider "${route.provider}" is unavailable or unauthorised.`);
  }
  if (!providerCanExecuteModel(provider, model)) {
    throw new Error(`Task ${task.id} route model "${model.id}" is unavailable through a supported local transport.`);
  }
  validateFallback(route, availability, enabledModelIds);
}

export async function dispatch(
  task: Task,
  state: SwarmState,
  worktreePath?: string,
): Promise<TaskResult> {
  let driver: ReturnType<typeof getDriver>;
  try {
    validateTaskRouteForDispatch(task);
    driver = task.route ? getDriverForProvider(task.route.provider) : getDriver();
  } catch (err) {
    return { status: 'failed', summary: (err as Error).message };
  }
  // Existing Claude drivers still consume model/effort fields. Preserve the
  // authoritative immutable route while adapting it at this legacy boundary.
  const dispatchedTask = task.route
    ? { ...task, model: task.route.model, effort: task.route.reasoningEffort }
    : task;

  try {
    switch (dispatchedTask.assignee) {
      case 'coder': {
        const r = await driver.runCoder(dispatchedTask, state, worktreePath);
        return {
          status: r.verdict === 'FAILED' ? 'failed' : 'done',
          summary: r.summary,
          artifacts: r.filesChanged,
          finding: r.findingMarkdown,
          costUsd: r.costUsd,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          verdict: r.verdict,
          blocksDone: false,
        };
      }

      case 'checks': {
        // Deterministic gate — no LLM, no driver. Runs tools and trusts exit codes.
        const r = await runDeterministicChecks(dispatchedTask, state);
        return {
          status: 'done',
          summary: r.summary,
          finding: r.findingMarkdown,
          costUsd: 0,
          verdict: r.verdict,
          blocksDone: BLOCKS_VERDICTS.has(r.verdict),
        };
      }

      case 'visual': {
        // Advisory: renders changed routes in a browser and attaches screenshots.
        const r = await runVisualCheck(dispatchedTask, state);
        return {
          status: 'done',
          summary: r.summary,
          finding: r.findingMarkdown,
          costUsd: 0,
          verdict: r.verdict,
          blocksDone: false,
        };
      }

      case 'tester': {
        const r = await driver.runTester(dispatchedTask, state);
        return {
          status: 'done',
          summary: r.summary,
          finding: r.findingMarkdown,
          costUsd: r.costUsd,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          verdict: r.verdict,
          blocksDone: BLOCKS_VERDICTS.has(r.verdict),
        };
      }

      case 'security': {
        const r = await driver.runSecurity(dispatchedTask, state);
        return {
          status: 'done',
          summary: r.summary,
          finding: r.findingMarkdown,
          costUsd: r.costUsd,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          verdict: r.verdict,
          blocksDone: BLOCKS_VERDICTS.has(r.verdict),
        };
      }

      case 'reviewer': {
        const r = await driver.runReviewer(dispatchedTask, state);
        return {
          status: 'done',
          summary: r.summary,
          finding: r.findingMarkdown,
          costUsd: r.costUsd,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          verdict: r.verdict,
          blocksDone: BLOCKS_VERDICTS.has(r.verdict),
        };
      }

      case 'negotiator':
        // The Negotiator is a runtime deadlock arbiter invoked DIRECTLY by the
        // loop (runLoop → recoverFromDeadlock → driver.runNegotiator), never
        // routed through normal task dispatch. Reaching here is a bug.
        return {
          status: 'failed',
          summary: 'Negotiator is invoked directly by the loop, not dispatched as a task.',
        };

      default: {
        // Marketplace agent — look up from the hired roster.
        const roster = loadRoster();
        const agent = roster.find(a => a.id === dispatchedTask.assignee && a.enabled);
        if (!agent) {
          return {
            status: 'failed',
            summary: `Unknown agent: ${dispatchedTask.assignee} — not found in hired roster`,
          };
        }
        const r = await driver.runMarketplaceAgent(dispatchedTask, state, agent);
        return {
          status: 'done' as const,
          summary: r.summary,
          finding: r.findingMarkdown,
          costUsd: r.costUsd,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          verdict: r.verdict,
          blocksDone: BLOCKS_VERDICTS.has(r.verdict),
        };
      }
    }
  } catch (err) {
    return { status: 'failed', summary: (err as Error).message };
  }
}
