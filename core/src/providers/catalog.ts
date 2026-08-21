/**
 * Provider-neutral metadata for models Swarm can select. This module is data
 * only: callers must use provider discovery before treating a catalog entry as
 * available for a particular run.
 */

export type ProviderId = 'anthropic' | 'openai';

export type ModelTier = 'fast' | 'standard' | 'frontier';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ModelCapability = 'coding' | 'planning' | 'review';

/**
 * Stable policy roles used by the router. These describe a model's intended
 * default placement; concrete model IDs remain catalog data, not router code.
 */
export type RoutingRole = 'large-planning' | 'large-coding' | 'small-execution';

export type AuthMode = 'subscription' | 'api-key';

export interface ProviderModel {
  provider: ProviderId;
  id: string;
  label: string;
  tier: ModelTier;
  reasoningEfforts: readonly ReasoningEffort[];
  capabilities: readonly ModelCapability[];
  routingRoles: readonly RoutingRole[];
  authModes: readonly AuthMode[];
}

const ALL_CAPABILITIES: readonly ModelCapability[] = ['coding', 'planning', 'review'];
const FULL_REASONING: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The entries below intentionally retain every concrete Claude ID that Swarm
 * currently selects by default. The OpenAI entries are catalog metadata only;
 * they do not imply an installed CLI, login, or API key.
 */
export const PROVIDER_MODELS: readonly ProviderModel[] = [
  {
    provider: 'anthropic',
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    tier: 'fast',
    reasoningEfforts: [],
    capabilities: ['coding', 'review'],
    routingRoles: [],
    authModes: ['subscription', 'api-key'],
  },
  {
    provider: 'anthropic',
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    tier: 'standard',
    reasoningEfforts: FULL_REASONING,
    capabilities: ALL_CAPABILITIES,
    routingRoles: [],
    authModes: ['subscription', 'api-key'],
  },
  {
    provider: 'anthropic',
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    tier: 'frontier',
    reasoningEfforts: FULL_REASONING,
    capabilities: ALL_CAPABILITIES,
    routingRoles: ['large-coding'],
    authModes: ['subscription', 'api-key'],
  },
  {
    provider: 'anthropic',
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    tier: 'frontier',
    reasoningEfforts: FULL_REASONING,
    capabilities: ALL_CAPABILITIES,
    routingRoles: ['large-planning'],
    authModes: ['subscription', 'api-key'],
  },
  {
    provider: 'openai',
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    tier: 'standard',
    reasoningEfforts: FULL_REASONING,
    capabilities: ['coding', 'review'],
    routingRoles: ['small-execution'],
    authModes: ['subscription', 'api-key'],
  },
  {
    provider: 'openai',
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    tier: 'frontier',
    reasoningEfforts: FULL_REASONING,
    capabilities: ALL_CAPABILITIES,
    routingRoles: [],
    authModes: ['subscription', 'api-key'],
  },
];

export function getProviderModel(modelId: string): ProviderModel | undefined {
  return PROVIDER_MODELS.find((model) => model.id === modelId);
}

export function listProviderModels(provider?: ProviderId): readonly ProviderModel[] {
  if (!provider) {
    return PROVIDER_MODELS;
  }
  return PROVIDER_MODELS.filter((model) => model.provider === provider);
}

export function validateProviderModel(modelId: string): ProviderModel {
  const model = getProviderModel(modelId);
  if (!model) {
    const available = PROVIDER_MODELS.map((entry) => entry.id).join(', ');
    throw new Error(`Unknown model \"${modelId}\". Choose a catalog model: ${available}.`);
  }
  return model;
}

export function validateReasoningEffort(modelId: string, effort: ReasoningEffort): ProviderModel {
  const model = validateProviderModel(modelId);
  if (!model.reasoningEfforts.includes(effort)) {
    const supported = model.reasoningEfforts.length === 0 ? 'none' : model.reasoningEfforts.join(', ');
    throw new Error(`Model \"${modelId}\" does not support \"${effort}\" reasoning effort. Supported levels: ${supported}.`);
  }
  return model;
}
