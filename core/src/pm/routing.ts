import { getProviderModel, type ProviderAvailability } from '../providers/index.js';
import { recommendRoute, type BudgetClass, type TaskIntent, type TaskRisk, type TaskScope } from '../routing/index.js';
import type { TaskGraphEntry } from '../state/types.js';

export interface PmRoutingContext {
  providerAvailability: readonly ProviderAvailability[];
  availableModelIds?: readonly string[];
  budgetClass?: BudgetClass;
}

export interface PmTaskRoutingHints {
  intent?: TaskIntent;
  scope?: TaskScope;
  risk?: TaskRisk;
  /** An advisory PM preference only; it never selects a route directly. */
  modelPreference?: string;
  writeScope?: string[];
}

export type PmTaskGraphEntry = TaskGraphEntry & PmTaskRoutingHints;

const TASK_INTENTS = new Set<TaskIntent>(['planning', 'coding', 'execution', 'review', 'research', 'validation']);
const TASK_SCOPES = new Set<TaskScope>(['small', 'medium', 'large']);
const TASK_RISKS = new Set<TaskRisk>(['low', 'medium', 'high', 'critical']);
const DETERMINISTIC_ASSIGNEES = new Set(['checks', 'visual']);

function validWriteScope(value: string): boolean {
  return value.length > 0
    && value.length <= 512
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !/^[A-Za-z]:/.test(value)
    && !/[\x00-\x1f]/.test(value)
    && !value.replace(/\\/g, '/').split('/').some(segment => !segment || segment === '..' || segment === '.swarm');
}

function inferredIntent(task: PmTaskGraphEntry): TaskIntent {
  if (task.intent && TASK_INTENTS.has(task.intent)) {
    return task.intent;
  }
  if (task.assignee === 'reviewer' || task.assignee === 'tester' || task.assignee === 'security') {
    return 'review';
  }
  return 'coding';
}

function inferredScope(task: PmTaskGraphEntry): TaskScope {
  return task.scope && TASK_SCOPES.has(task.scope) ? task.scope : 'medium';
}

function inferredRisk(task: PmTaskGraphEntry): TaskRisk {
  return task.risk && TASK_RISKS.has(task.risk) ? task.risk : 'medium';
}

function normalizedWriteScope(task: PmTaskGraphEntry): string[] {
  return (task.writeScope ?? []).filter(validWriteScope);
}

function preferenceNote(preference: string | undefined, selectedModel: string): string {
  if (!preference) {
    return '';
  }
  const catalogPreference = getProviderModel(preference);
  if (!catalogPreference) {
    return ` PM preference "${preference}" was ignored because it is not a supported catalog model.`;
  }
  if (catalogPreference.id !== selectedModel) {
    return ` PM preference "${catalogPreference.id}" was advisory; deterministic policy selected "${selectedModel}".`;
  }
  return ` PM preference "${catalogPreference.id}" agrees with the deterministic policy.`;
}

/**
 * Attach authoritative catalog-backed routes to PM tasks. PM hints describe the
 * work only; they cannot inject a provider, model, effort, or approval choice.
 */
export function routePmTaskGraph(
  tasks: readonly PmTaskGraphEntry[],
  context: PmRoutingContext,
): PmTaskGraphEntry[] {
  const implementationProviders = new Map<string, import('../providers/index.js').ProviderId>();

  return tasks.map(task => {
    const deterministic = DETERMINISTIC_ASSIGNEES.has(task.assignee) || task.intent === 'validation';
    if (deterministic) {
      return { ...task, route: undefined };
    }

    const coderDependencies = task.depends_on
      .map(id => implementationProviders.get(id))
      .filter((provider): provider is import('../providers/index.js').ProviderId => Boolean(provider));
    const recommendation = recommendRoute({
      intent: inferredIntent(task),
      scope: inferredScope(task),
      risk: inferredRisk(task),
      writeAccess: task.assignee === 'coder' ? 'brokered' : 'none',
      writeScope: normalizedWriteScope(task),
      dependencyCount: task.depends_on.length,
      deterministic: false,
      budgetClass: context.budgetClass ?? 'balanced',
      providerAvailability: context.providerAvailability,
      availableModelIds: context.availableModelIds,
      ...(task.assignee === 'reviewer' && coderDependencies[0]
        ? { reviewerDiversity: { requireDifferentProvider: true, implementationProvider: coderDependencies[0] } }
        : {}),
    });
    if (recommendation.kind !== 'model') {
      return { ...task, route: undefined };
    }

    const route = {
      ...recommendation.route,
      rationale: `${recommendation.route.rationale}${preferenceNote(task.modelPreference, recommendation.route.model)}`,
    };
    if (task.assignee === 'coder') {
      implementationProviders.set(task.id, route.provider);
    }
    return {
      ...task,
      model: route.model,
      effort: route.reasoningEffort,
      route,
    };
  });
}
