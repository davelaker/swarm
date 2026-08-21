/**
 * Provider-neutral metadata for models Swarm can select. This module is data
 * only: callers must use provider discovery before treating a catalog entry as
 * available for a particular run.
 */

export type ProviderId = 'anthropic' | 'openai';

export type ModelTier = 'fast' | 'standard' | 'frontier';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * A model's complete documented effort set. `none` means the transport should
 * request no reasoning; it is not yet a legacy Swarm task-route value.
 */
export type SupportedReasoningEffort = 'none' | ReasoningEffort;

export type ModelCapability = 'coding' | 'planning' | 'review';

/**
 * Stable policy roles used by the router. These describe a model's intended
 * default placement; concrete model IDs remain catalog data, not router code.
 */
export type RoutingRole = 'large-planning' | 'large-coding' | 'small-execution';

export type AuthMode = 'subscription' | 'api-key';

/**
 * A concrete execution mechanism, rather than a provider or credential type.
 * This prevents a local Codex subscription from implicitly selecting a model
 * that OpenAI documents only for Responses API execution.
 */
export type ExecutionTransport =
  | 'claude-agent-sdk'
  | 'anthropic-api'
  | 'codex-cli'
  | 'openai-responses-api';

export interface ProviderModel {
  provider: ProviderId;
  id: string;
  label: string;
  tier: ModelTier;
  /** The exact provider-documented set, including OpenAI's `none` where supported. */
  supportedReasoningEfforts: readonly SupportedReasoningEffort[];
  /**
   * Legacy task-route efforts accepted by the current scheduler. This remains
   * separate until MP-14b/MP-14c add `none` execution and routing semantics.
   */
  reasoningEfforts: readonly ReasoningEffort[];
  capabilities: readonly ModelCapability[];
  routingRoles: readonly RoutingRole[];
  authModes: readonly AuthMode[];
  executionTransports: readonly ExecutionTransport[];
}

const ALL_CAPABILITIES: readonly ModelCapability[] = ['coding', 'planning', 'review'];
const FULL_REASONING: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const GPT_5_3_CODEX_REASONING: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const GPT_5_6_REASONING: readonly SupportedReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

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
    supportedReasoningEfforts: [],
    reasoningEfforts: [],
    capabilities: ['coding', 'review'],
    routingRoles: [],
    authModes: ['subscription', 'api-key'],
    executionTransports: ['claude-agent-sdk', 'anthropic-api'],
  },
  {
    provider: 'anthropic',
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    tier: 'standard',
    supportedReasoningEfforts: FULL_REASONING,
    reasoningEfforts: FULL_REASONING,
    capabilities: ALL_CAPABILITIES,
    routingRoles: [],
    authModes: ['subscription', 'api-key'],
    executionTransports: ['claude-agent-sdk', 'anthropic-api'],
  },
  {
    provider: 'anthropic',
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    tier: 'frontier',
    supportedReasoningEfforts: FULL_REASONING,
    reasoningEfforts: FULL_REASONING,
    capabilities: ALL_CAPABILITIES,
    routingRoles: ['large-coding'],
    authModes: ['subscription', 'api-key'],
    executionTransports: ['claude-agent-sdk', 'anthropic-api'],
  },
  {
    provider: 'anthropic',
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    tier: 'frontier',
    supportedReasoningEfforts: FULL_REASONING,
    reasoningEfforts: FULL_REASONING,
    capabilities: ALL_CAPABILITIES,
    routingRoles: ['large-planning'],
    authModes: ['subscription', 'api-key'],
    executionTransports: ['claude-agent-sdk', 'anthropic-api'],
  },
  {
    provider: 'openai',
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    tier: 'standard',
    supportedReasoningEfforts: GPT_5_3_CODEX_REASONING,
    reasoningEfforts: GPT_5_3_CODEX_REASONING,
    capabilities: ['coding', 'review'],
    routingRoles: ['small-execution'],
    authModes: ['subscription', 'api-key'],
    executionTransports: ['codex-cli', 'openai-responses-api'],
  },
  {
    provider: 'openai',
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    tier: 'frontier',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    reasoningEfforts: GPT_5_3_CODEX_REASONING,
    capabilities: ALL_CAPABILITIES,
    routingRoles: [],
    authModes: ['api-key'],
    executionTransports: ['openai-responses-api'],
  },
  {
    provider: 'openai',
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    tier: 'frontier',
    supportedReasoningEfforts: GPT_5_6_REASONING,
    reasoningEfforts: FULL_REASONING,
    capabilities: ALL_CAPABILITIES,
    routingRoles: [],
    authModes: ['api-key'],
    executionTransports: ['openai-responses-api'],
  },
  {
    provider: 'openai',
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    tier: 'standard',
    supportedReasoningEfforts: GPT_5_6_REASONING,
    reasoningEfforts: FULL_REASONING,
    capabilities: ALL_CAPABILITIES,
    routingRoles: [],
    authModes: ['api-key'],
    executionTransports: ['openai-responses-api'],
  },
  {
    provider: 'openai',
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    tier: 'fast',
    supportedReasoningEfforts: GPT_5_6_REASONING,
    reasoningEfforts: FULL_REASONING,
    capabilities: ALL_CAPABILITIES,
    routingRoles: [],
    authModes: ['api-key'],
    executionTransports: ['openai-responses-api'],
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

/** List only models the caller's concrete execution transport can run. */
export function listProviderModelsForTransport(
  transport: ExecutionTransport,
  provider?: ProviderId,
): readonly ProviderModel[] {
  return listProviderModels(provider).filter((model) => model.executionTransports.includes(transport));
}

export function supportsExecutionTransport(modelId: string, transport: ExecutionTransport): boolean {
  return validateProviderModel(modelId).executionTransports.includes(transport);
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

/**
 * Validate against the provider's full documented set. This is intentionally
 * separate from `validateReasoningEffort` until task routes support `none`.
 */
export function validateSupportedReasoningEffort(
  modelId: string,
  effort: SupportedReasoningEffort,
): ProviderModel {
  const model = validateProviderModel(modelId);
  if (!model.supportedReasoningEfforts.includes(effort)) {
    const supported = model.supportedReasoningEfforts.length === 0
      ? 'none'
      : model.supportedReasoningEfforts.join(', ');
    throw new Error(`Model "${modelId}" does not support "${effort}" reasoning effort. Supported levels: ${supported}.`);
  }
  return model;
}
