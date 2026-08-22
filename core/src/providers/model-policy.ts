import {
  getProviderModel,
  listProviderModels,
  type ExecutionTransport,
  type ProviderId,
  type ProviderModel,
} from './catalog.js';
import {
  discoverProviderAvailability,
  probeCliCommand,
  resolveProviderSelection,
  type CliProbe,
  type ProviderAvailability,
  type ProviderSelection,
} from './discovery.js';

export interface ProviderModelPolicy {
  enabledModelIds: readonly string[];
  defaultModelId: string;
}

export interface ExecutableProviderModel extends ProviderModel {
  executable: boolean;
}

export interface ModelPolicyProvider {
  provider: ProviderId;
  enabled: boolean;
  available: boolean;
  cliAvailable: boolean;
  apiKeyConfigured: boolean;
  availableAuthModes: ProviderAvailability['availableAuthModes'];
  models: readonly ExecutableProviderModel[];
}

let policyOverride: ProviderModelPolicy | null = null;
let revision = 0;

export function providerModelPolicyRevision(): number {
  return revision;
}

export function resetProviderModelPolicy(): void {
  if (!policyOverride) {
    return;
  }
  policyOverride = null;
  revision += 1;
}

export function executionTransportsForProvider(
  provider: ProviderAvailability,
): readonly ExecutionTransport[] {
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

  if (provider.cliAvailable && provider.availableAuthModes.includes('subscription')) {
    return ['codex-cli'];
  }
  return [];
}

export function providerCanExecuteModel(
  availability: ProviderAvailability,
  model: ProviderModel,
): boolean {
  if (!availability.enabled || availability.availableAuthModes.length === 0) {
    return false;
  }
  return executionTransportsForProvider(availability).some((transport) =>
    model.executionTransports.includes(transport),
  );
}

function listExecutableModels(
  availability: readonly ProviderAvailability[],
): readonly ProviderModel[] {
  return listProviderModels().filter((model) => {
    const provider = availability.find((entry) => entry.provider === model.provider);
    return provider ? providerCanExecuteModel(provider, model) : false;
  });
}

function chooseDefaultModel(
  models: readonly ProviderModel[],
  selection: ProviderSelection,
): string {
  const defaultProviderModels = models.filter((model) => model.provider === selection.defaultProvider);
  const planningDefault = defaultProviderModels.find((model) => model.id === 'claude-sonnet-4-6')
    ?? defaultProviderModels.find((model) => model.capabilities.includes('planning'))
    ?? models.find((model) => model.capabilities.includes('planning'));
  if (!planningDefault) {
    throw new Error('No locally executable planning model is available.');
  }
  return planningDefault.id;
}

function initialProviderSelection(env: NodeJS.ProcessEnv, probe: CliProbe): ProviderSelection {
  const legacyDriver = env.SWARM_DRIVER?.trim().toLowerCase();
  const legacyDefaultProvider =
    legacyDriver === 'agent-sdk' || legacyDriver === 'api-key' ? 'anthropic' : undefined;
  return resolveProviderSelection({
    enabledProviders: env.SWARM_ENABLED_PROVIDERS,
    defaultProvider: env.SWARM_DEFAULT_PROVIDER ?? legacyDefaultProvider,
    hasAnthropicApiKey: Boolean(env.ANTHROPIC_API_KEY),
    hasOpenAiApiKey: Boolean(env.OPENAI_API_KEY),
    hasClaudeCli: probe('claude'),
    hasCodexCli: probe('codex'),
  });
}

export function defaultProviderModelPolicy(
  env: NodeJS.ProcessEnv = process.env,
  probe: CliProbe = probeCliCommand,
): ProviderModelPolicy {
  const selection = initialProviderSelection(env, probe);
  const executable = listExecutableModels(selection.availability);
  if (executable.length === 0) {
    return {
      enabledModelIds: [],
      defaultModelId: '',
    };
  }
  return {
    enabledModelIds: executable.map((model) => model.id),
    defaultModelId: chooseDefaultModel(executable, selection),
  };
}

export function getProviderModelPolicy(
  env: NodeJS.ProcessEnv = process.env,
  probe: CliProbe = probeCliCommand,
): ProviderModelPolicy {
  return policyOverride ?? defaultProviderModelPolicy(env, probe);
}

function normalizeEnabledModelIds(raw: readonly string[]): readonly string[] {
  return [...new Set(raw.map((model) => model.trim()).filter(Boolean))];
}

function assertPolicyIsValid(
  policy: ProviderModelPolicy,
  availability: readonly ProviderAvailability[],
): void {
  if (policy.enabledModelIds.length === 0) {
    throw new Error('Enable at least one locally executable model.');
  }

  for (const modelId of policy.enabledModelIds) {
    const model = getProviderModel(modelId);
    if (!model) {
      throw new Error(`Unsupported model "${modelId}".`);
    }
    const provider = availability.find((entry) => entry.provider === model.provider);
    if (!provider || !providerCanExecuteModel(provider, model)) {
      throw new Error(`Model "${modelId}" is not available through a supported local transport.`);
    }
  }

  const defaultModel = getProviderModel(policy.defaultModelId);
  if (!defaultModel || !policy.enabledModelIds.includes(policy.defaultModelId)) {
    throw new Error('Default model must be one of the enabled models.');
  }
  if (!defaultModel.capabilities.includes('planning')) {
    throw new Error('Default model must support PM planning.');
  }
}

export function setProviderModelPolicy(
  input: { enabledModelIds: readonly string[]; defaultModelId?: string },
  env: NodeJS.ProcessEnv = process.env,
  probe: CliProbe = probeCliCommand,
): ProviderModelPolicy {
  const enabledModelIds = normalizeEnabledModelIds(input.enabledModelIds);
  const requestedDefault = input.defaultModelId?.trim();
  const defaultModelId = enabledModelIds.length === 1
    ? enabledModelIds[0]
    : (requestedDefault ?? '');
  const nextPolicy = { enabledModelIds, defaultModelId };
  const availability = discoverProviderAvailability(env, probe);
  assertPolicyIsValid(nextPolicy, availability);

  policyOverride = nextPolicy;
  revision += 1;
  return nextPolicy;
}

export function modelPolicyProviders(
  env: NodeJS.ProcessEnv = process.env,
  probe: CliProbe = probeCliCommand,
): readonly ModelPolicyProvider[] {
  const availability = discoverProviderAvailability(env, probe);
  return availability.map((provider) => ({
    ...provider,
    available: provider.enabled && executionTransportsForProvider(provider).length > 0,
    models: listProviderModels(provider.provider)
      .filter((model) => providerCanExecuteModel(provider, model))
      .map((model) => ({
        ...model,
        executable: true,
      })),
  }));
}

export function resolveProviderSelectionFromModelPolicy(
  env: NodeJS.ProcessEnv = process.env,
  probe: CliProbe = probeCliCommand,
): ProviderSelection {
  const availability = discoverProviderAvailability(env, probe);
  const policy = getProviderModelPolicy(env, probe);
  const defaultModel = getProviderModel(policy.defaultModelId);
  if (!defaultModel) {
    return initialProviderSelection(env, probe);
  }

  const enabledProviders = [
    ...new Set(
      policy.enabledModelIds
        .map((modelId) => getProviderModel(modelId)?.provider)
        .filter((provider): provider is ProviderId => Boolean(provider)),
    ),
  ];
  const filteredAvailability = availability.map((provider) => ({
    ...provider,
    enabled: provider.enabled && enabledProviders.includes(provider.provider),
  }));

  return {
    defaultProvider: defaultModel.provider,
    enabledProviders,
    availability: filteredAvailability,
  };
}
