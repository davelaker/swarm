import { listProviderModels, type ModelCapability, type ProviderModel, type ReasoningEffort } from '../providers/index.js';
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
  if (input.scope === 'large' || input.risk === 'high' || input.risk === 'critical' || input.dependencyCount >= 3) {
    return 'high';
  }
  if (input.scope === 'small' && input.risk === 'low' && input.dependencyCount === 0) {
    return 'low';
  }
  return 'medium';
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
  return !input.availableModelIds || input.availableModelIds.includes(model.id);
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
  if (input.intent === 'review' && input.reviewerDiversity?.requireDifferentProvider && input.reviewerDiversity.implementationProvider !== selected.model.provider) {
    reason.push('It differs from the implementation provider for independent review.');
  }
  if (input.risk === 'high' || input.risk === 'critical' || input.dependencyCount >= 3) {
    reason.push('Higher risk or dependency depth uses high reasoning effort.');
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
