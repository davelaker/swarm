// Friendly labels + accent colors for the Claude models the PM assigns per task.
// Keyed loosely (substring match) so both canonical ids and aliases resolve.

interface ModelMeta {
  label: string;
  color: string;
}

// Order matters — `find` takes the first match, so more specific ids come first
// ('sonnet-5' before the generic 'sonnet').
const MODELS: { match: string; meta: ModelMeta }[] = [
  { match: 'gpt-5.4', meta: { label: 'GPT-5.4', color: '#21a6a1' } },
  { match: 'codex', meta: { label: 'GPT Codex', color: '#21a6a1' } },
  { match: 'opus', meta: { label: 'Opus', color: '#a585f5' } },
  { match: 'fable', meta: { label: 'Fable', color: '#e8a93a' } },
  { match: 'sonnet-5', meta: { label: 'Sonnet 5', color: '#4d8df4' } },
  { match: 'sonnet', meta: { label: 'Sonnet', color: '#4d8df4' } },
  { match: 'haiku', meta: { label: 'Haiku', color: '#34cf8a' } },
];

export function modelMeta(model: string | undefined): ModelMeta | null {
  if (!model) {
    return null;
  }
  const s = model.toLowerCase();
  return MODELS.find(m => s.includes(m.match))?.meta ?? null;
}

// Cost ordering (cheapest → priciest), used to detect when the PM picked a model that
// costs MORE than an agent's default so the user can confirm. Ordered by price per
// million tokens, since that is what the confirmation gate is protecting against:
//   haiku $1/$5 · sonnet $3/$15 · opus $5/$25 · fable $10/$50
// Fable is Anthropic's most capable AND priciest model — it must rank ABOVE opus, or an
// upgrade to it slips through unconfirmed. Both Sonnet generations share the sonnet tier
// (same price), so sonnet-4-6 → sonnet-5 is correctly not treated as a cost upgrade.
// Unknown → -1 (never an upgrade).
const RANK = ['haiku', 'sonnet', 'opus', 'fable'];
export function modelRank(model: string | undefined): number {
  if (!model) {
    return -1;
  }
  const s = model.toLowerCase();
  return RANK.findIndex(r => s.includes(r));
}

// True when `chosen` is a strict upgrade over `def` (more powerful → costs more).
export function isUpgrade(chosen: string | undefined, def: string | undefined): boolean {
  const c = modelRank(chosen);
  return c >= 0 && c > modelRank(def);
}

// Canonical ids for the override dropdown, cheapest → priciest (matching RANK).
export const MODEL_CHOICES: { id: string; label: string }[] = [
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-opus-4-8', label: 'Opus' },
  { id: 'claude-fable-5', label: 'Fable' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
];

export type RoutingCapability = 'coding' | 'planning' | 'review';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AvailableModel {
  id: string;
  label: string;
  tier: 'fast' | 'standard' | 'frontier';
  capabilities: RoutingCapability[];
  reasoningEfforts: ReasoningEffort[];
}

export interface AvailableProvider {
  provider: 'anthropic' | 'openai';
  available: boolean;
  availableAuthModes: Array<'subscription' | 'api-key'>;
  models: AvailableModel[];
}

// The local Swarm OpenAI driver invokes `codex exec`. Models that are available
// only through the Responses API must not appear as override choices merely
// because the server's provider catalog knows about them.
const CODEX_CLI_MODEL_IDS = new Set(['gpt-5.3-codex']);

function hasExecutableTransport(provider: AvailableProvider, model: AvailableModel): boolean {
  if (provider.provider !== 'openai') {
    return true;
  }
  return provider.availableAuthModes.includes('subscription') && CODEX_CLI_MODEL_IDS.has(model.id);
}

export function reasoningEffortTradeoff(effort: ReasoningEffort | undefined): string {
  switch (effort) {
    case 'low':
      return 'fastest response and lowest quota use for contained work';
    case 'medium':
      return 'balanced reasoning depth and quota use';
    case 'high':
      return 'deeper reasoning for multi-step or higher-risk work';
    case 'xhigh':
      return 'maximum practical scrutiny for critical or highly interdependent work';
    case 'max':
      return 'the provider’s highest available reasoning investment';
    default:
      return 'not configurable for this model on the active transport';
  }
}

export function taskCapability(assignee: string): RoutingCapability {
  return assignee === 'tester' || assignee === 'security' || assignee === 'reviewer'
    ? 'review'
    : 'coding';
}

export function selectableModels(
  providers: AvailableProvider[],
  assignee: string,
): Array<AvailableModel & { provider: AvailableProvider['provider'] }> {
  const capability = taskCapability(assignee);
  return providers.flatMap(provider =>
    provider.available
      ? provider.models
          .filter(model => model.capabilities.includes(capability) && hasExecutableTransport(provider, model))
          .map(model => ({ ...model, provider: provider.provider }))
      : [],
  );
}
