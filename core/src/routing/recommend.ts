import {
  listProviderModels,
  type ExecutionTransport,
  type ModelCapability,
  type ProviderModel,
  type ReasoningEffort,
} from '../providers/index.js';
import type { TaskRoute } from '../state/types.js';
import type { BudgetClass, RouteCandidate, RouteRecommendation, RouteRecommendationInput, TaskIntent } from './types.js';

const BUDGET_RANK: Record<BudgetClass, number> = { economy: 0, balanced: 1, premium: 2 };
const TIER_COST_RANK: Record<ProviderModel['tier'], number> = { fast: 0, standard: 1, frontier: 2 };
const EFFORT_RANK: Record<ReasoningEffort, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

function requiredCapability(intent: TaskIntent): ModelCapability {
  if (intent === 'planning') {
    return 'planning';
  }
  if (intent === 'review') {
    return 'review';
  }
  return 'coding';
}

function policyRole(input: RouteRecommendationInput): 'large-planning' | 'large-coding' | 'small-execution' | undefined {
  if (input.intent === 'planning' && input.scope === 'large') {
    return 'large-planning';
  }
  if ((input.intent === 'coding' || input.intent === 'execution') && input.scope === 'large') {
    return 'large-coding';
  }
  if ((input.intent === 'coding' || input.intent === 'execution') && input.scope === 'small') {
    return 'small-execution';
  }
  return undefined;
}

function desiredEffort(input: RouteRecommendationInput): ReasoningEffort {
  const complexity = input.scope === 'large' ? 2 : input.scope === 'medium' ? 1 : 0;
  const risk = input.risk === 'critical' ? 3 : input.risk === 'high' ? 2 : input.risk === 'medium' ? 1 : 0;
  const dependencies = input.dependencyCount >= 6 ? 2 : input.dependencyCount >= 3 ? 1 : 0;
  const demand = complexity + risk + dependencies;
  const unconstrained = demand >= 5 ? 'xhigh' : demand >= 2 ? 'high' : demand >= 1 ? 'medium' : 'low';

  // Budget is a quota/cost guardrail, not a reason to weaken critical work.
  // Confirmation remains required when the selected tier exceeds the budget.
  if (input.risk !== 'critical') {
    if (input.budgetClass !== 'premium' && EFFORT_RANK[unconstrained] > EFFORT_RANK.high) {
      return 'high';
    }
  }
  return unconstrained;
}

function supportedEffort(model: ProviderModel, desired: ReasoningEffort): ReasoningEffort | undefined {
  if (model.reasoningEfforts.length === 0) {
    return undefined;
  }
  const desiredRank = EFFORT_RANK[desired];
  const supported = model.reasoningEfforts.filter((effort) => EFFORT_RANK[effort] <= desiredRank);
  return supported.at(-1) ?? model.reasoningEfforts[0];
}

function isAvailable(model: ProviderModel, input: RouteRecommendationInput): boolean {
  const provider = input.providerAvailability.find((entry) => entry.provider === model.provider);
  if (!provider?.enabled || provider.availableAuthModes.length === 0) {
    return false;
  }
  if (input.availableModelIds && !input.availableModelIds.includes(model.id)) {
    return false;
  }
  return executionTransports(provider).some((transport) => model.executionTransports.includes(transport));
}

/**
 * Availability is not enough: a model is selectable only if Swarm has an
 * implementation for the concrete transport that would execute it. In
 * particular, a Codex subscription must never select Responses-API-only GPT
 * models merely because they share the OpenAI provider.
 */
function executionTransports(provider: RouteRecommendationInput['providerAvailability'][number]): readonly ExecutionTransport[] {
  if (provider.provider === 'anthropic') {
    const transports: ExecutionTransport[] = [];
    if (provider.cliAvailable && provider.availableAuthModes.includes('subscription')) {
      transports.push('claude-agent-sdk');
    }
    if (provider.apiKeyConfigured && provider.availableAuthModes.includes('api-key')) {
      transports.push('anthropic-api');
    }
    return transports;
  }

  // Swarm currently implements only the local Codex CLI transport. Do not
  // expose Responses API models until an OpenAI API driver exists.
  if (provider.cliAvailable && provider.availableAuthModes.includes('subscription')) {
    return ['codex-cli'];
  }
  return [];
}

function scoreCandidate(model: ProviderModel, input: RouteRecommendationInput): number {
  const role = policyRole(input);
  let score = 0;
  if (role && model.routingRoles.includes(role)) {
    score += 1_000;
  }
  if (model.capabilities.includes(requiredCapability(input.intent))) {
    score += 100;
  }
  if (input.intent === 'review' && input.reviewerDiversity?.requireDifferentProvider && input.reviewerDiversity.implementationProvider) {
    score += model.provider === input.reviewerDiversity.implementationProvider ? -500 : 500;
  }
  if (input.scope === 'large' && model.tier === 'frontier') {
    score += 30;
  }
  if (input.scope === 'small' && model.tier !== 'frontier') {
    score += 20;
  }
  if (input.writeAccess === 'brokered' && model.capabilities.includes('coding')) {
    score += 5;
  }
  if (TIER_COST_RANK[model.tier] <= BUDGET_RANK[input.budgetClass]) {
    score += 10;
  }
  return score;
}

function candidates(input: RouteRecommendationInput): RouteCandidate[] {
  const capability = requiredCapability(input.intent);
  const effort = desiredEffort(input);
  return listProviderModels()
    .filter((model) => model.capabilities.includes(capability) && isAvailable(model, input))
    .map((model) => ({ model, score: scoreCandidate(model, input), effort: supportedEffort(model, effort) }))
    .sort((left, right) => right.score - left.score || left.model.id.localeCompare(right.model.id));
}

function requiresConfirmation(model: ProviderModel, input: RouteRecommendationInput): boolean {
  return TIER_COST_RANK[model.tier] > BUDGET_RANK[input.budgetClass] || input.risk === 'critical';
}

function rationale(input: RouteRecommendationInput, selected: RouteCandidate, fallback: RouteCandidate | undefined): string {
  const reason: string[] = [];
  const role = policyRole(input);
  if (role === 'large-planning') {
    reason.push('Large planning work prefers the frontier planning model.');
  } else if (role === 'large-coding') {
    reason.push('Large coding work prefers the frontier coding model.');
  } else if (role === 'small-execution') {
    reason.push('Small contained execution prefers the Codex/GPT execution model.');
  } else {
    reason.push(`Selected an available model with ${requiredCapability(input.intent)} capability.`);
  }
  reason.push(`${selected.model.label} is a ${selected.model.tier} ${selected.model.provider === 'openai' ? 'OpenAI' : 'Anthropic'} model available through Swarm's configured execution transport.`);
  if (selected.effort) {
    const desired = desiredEffort(input);
    if (selected.effort === desired) {
      reason.push(`${selected.effort} reasoning effort matches the task's complexity, risk, dependency depth, and budget guardrail.`);
    } else {
      reason.push(`${selected.effort} reasoning effort is the closest supported level to the ${desired} effort this task calls for.`);
    }
  } else {
    reason.push('This model has no configurable reasoning-effort control on its current transport.');
  }
  if (input.intent === 'review' && input.reviewerDiversity?.requireDifferentProvider && input.reviewerDiversity.implementationProvider !== selected.model.provider) {
    reason.push('It differs from the implementation provider for independent review.');
  }
  if (input.writeAccess === 'brokered') {
    reason.push('Any repository mutation remains broker-mediated.');
  }
  if (fallback) {
    reason.push(`Fallback: ${fallback.model.label}.`);
  }
  return reason.join(' ');
}

/**
 * Recommend a route using catalog data and explicit availability only. It has
 * no provider, filesystem, process, or environment side effects.
 */
export function recommendRoute(input: RouteRecommendationInput): RouteRecommendation {
  if (input.deterministic || input.intent === 'validation') {
    return {
      kind: 'no-model',
      rationale: 'Deterministic validation should run directly without a model.',
      fallback: null,
    };
  }

  const available = candidates(input);
  const selected = available[0];
  if (!selected) {
    throw new Error(`No available provider model supports ${requiredCapability(input.intent)} work.`);
  }
  const fallback = available[1];
  const route: TaskRoute = {
    provider: selected.model.provider,
    model: selected.model.id,
    ...(selected.effort ? { reasoningEffort: selected.effort } : {}),
    rationale: rationale(input, selected, fallback),
    fallback: fallback ? {
      provider: fallback.model.provider,
      model: fallback.model.id,
      ...(fallback.effort ? { reasoningEffort: fallback.effort } : {}),
    } : null,
    requiresConfirmation: requiresConfirmation(selected.model, input),
    writeScope: [...input.writeScope],
  };
  return { kind: 'model', route, selectedModel: selected.model };
}
