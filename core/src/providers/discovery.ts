import { execFileSync } from 'node:child_process';
import type { AuthMode, ProviderId } from './catalog.js';
import { isCodexOnlyModeEnabled } from './codex-only-mode.js';

export interface ProviderAvailability {
  provider: ProviderId;
  enabled: boolean;
  cliAvailable: boolean;
  apiKeyConfigured: boolean;
  availableAuthModes: readonly AuthMode[];
}

export interface ProviderSelection {
  defaultProvider: ProviderId;
  enabledProviders: readonly ProviderId[];
  availability: readonly ProviderAvailability[];
}

export interface ProviderDiscoveryInput {
  enabledProviders?: string;
  defaultProvider?: string;
  hasAnthropicApiKey: boolean;
  hasOpenAiApiKey: boolean;
  hasClaudeCli: boolean;
  hasCodexCli: boolean;
}

export type CliProbe = (command: string) => boolean;

const PROVIDER_PRECEDENCE: readonly ProviderId[] = ['anthropic', 'openai'];

function commandIsAvailable(command: string): boolean {
  try {
    // --version is deliberately the only command run: it establishes that the
    // executable is usable without querying, logging, or exposing credentials.
    execFileSync(command, ['--version'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function parseEnabledProviders(raw: string | undefined): readonly ProviderId[] {
  if (raw === undefined || raw.trim() === '') {
    return PROVIDER_PRECEDENCE;
  }

  const providers = raw.split(',').map((provider) => provider.trim().toLowerCase());
  if (providers.some((provider) => provider !== 'anthropic' && provider !== 'openai')) {
    throw new Error('SWARM_ENABLED_PROVIDERS must contain only "anthropic" and/or "openai".');
  }

  const unique = [...new Set(providers)] as ProviderId[];
  if (unique.length === 0) {
    throw new Error('SWARM_ENABLED_PROVIDERS must enable at least one provider.');
  }
  return unique;
}

function availableAuthModes(cliAvailable: boolean, apiKeyConfigured: boolean): readonly AuthMode[] {
  const modes: AuthMode[] = [];
  if (cliAvailable) {
    modes.push('subscription');
  }
  if (apiKeyConfigured) {
    modes.push('api-key');
  }
  return modes;
}

/**
 * Detect only safe capability metadata. This never reads CLI configuration,
 * API-key values, login tokens, or command output.
 */
export function discoverProviderAvailability(
  env: NodeJS.ProcessEnv = process.env,
  probe: CliProbe = commandIsAvailable,
): readonly ProviderAvailability[] {
  if (isCodexOnlyModeEnabled()) {
    const hasCodexCli = probe('codex');
    return [
      {
        provider: 'openai',
        enabled: true,
        cliAvailable: hasCodexCli,
        apiKeyConfigured: Boolean(env.OPENAI_API_KEY),
        availableAuthModes: hasCodexCli ? ['subscription'] : [],
      },
    ];
  }

  const enabledProviders = parseEnabledProviders(env.SWARM_ENABLED_PROVIDERS);
  const hasClaudeCli = probe('claude');
  const hasCodexCli = probe('codex');
  const hasAnthropicApiKey = Boolean(env.ANTHROPIC_API_KEY);
  const hasOpenAiApiKey = Boolean(env.OPENAI_API_KEY);

  return [
    {
      provider: 'anthropic',
      enabled: enabledProviders.includes('anthropic'),
      cliAvailable: hasClaudeCli,
      apiKeyConfigured: hasAnthropicApiKey,
      availableAuthModes: availableAuthModes(hasClaudeCli, hasAnthropicApiKey),
    },
    {
      provider: 'openai',
      enabled: enabledProviders.includes('openai'),
      cliAvailable: hasCodexCli,
      apiKeyConfigured: hasOpenAiApiKey,
      availableAuthModes: availableAuthModes(hasCodexCli, hasOpenAiApiKey),
    },
  ];
}

function providerIsAvailable(provider: ProviderAvailability): boolean {
  return provider.enabled && provider.availableAuthModes.length > 0;
}

/**
 * Resolve a provider deterministically. Explicit choices fail closed so a
 * configured provider cannot quietly fall back to a different account.
 */
export function resolveProviderSelection(input: ProviderDiscoveryInput): ProviderSelection {
  const enabledProviders = parseEnabledProviders(input.enabledProviders);
  const availability: readonly ProviderAvailability[] = [
    {
      provider: 'anthropic',
      enabled: enabledProviders.includes('anthropic'),
      cliAvailable: input.hasClaudeCli,
      apiKeyConfigured: input.hasAnthropicApiKey,
      availableAuthModes: availableAuthModes(input.hasClaudeCli, input.hasAnthropicApiKey),
    },
    {
      provider: 'openai',
      enabled: enabledProviders.includes('openai'),
      cliAvailable: input.hasCodexCli,
      apiKeyConfigured: input.hasOpenAiApiKey,
      availableAuthModes: availableAuthModes(input.hasCodexCli, input.hasOpenAiApiKey),
    },
  ];

  const requested = input.defaultProvider?.trim().toLowerCase();
  if (requested && requested !== 'auto' && requested !== 'anthropic' && requested !== 'openai') {
    throw new Error('SWARM_DEFAULT_PROVIDER must be "auto", "anthropic", or "openai".');
  }

  if (requested && requested !== 'auto') {
    const provider = availability.find((entry) => entry.provider === requested)!;
    if (!provider.enabled) {
      throw new Error(`Provider "${requested}" is selected but is not enabled.`);
    }
    if (!providerIsAvailable(provider)) {
      throw new Error(`Provider "${requested}" is selected but no supported local authentication is available.`);
    }
    return { defaultProvider: provider.provider, enabledProviders, availability };
  }

  const provider = PROVIDER_PRECEDENCE
    .map((id) => availability.find((entry) => entry.provider === id)!)
    .find(providerIsAvailable);
  if (!provider) {
    // Auto mode deliberately preserves the legacy no-auth path: configuration
    // can still report safe availability, while getConfig() supplies the
    // actionable authentication error before a run starts.
    const fallback = PROVIDER_PRECEDENCE
      .map((id) => availability.find((entry) => entry.provider === id)!)
      .find((entry) => entry.enabled)!;
    return { defaultProvider: fallback.provider, enabledProviders, availability };
  }
  return { defaultProvider: provider.provider, enabledProviders, availability };
}

/** Resolve directly from safe process metadata, while keeping probes testable. */
export function getProviderSelection(
  env: NodeJS.ProcessEnv = process.env,
  probe: CliProbe = commandIsAvailable,
): ProviderSelection {
  if (isCodexOnlyModeEnabled()) {
    const availability = discoverProviderAvailability(env, probe);
    return {
      defaultProvider: 'openai',
      enabledProviders: ['openai'],
      availability,
    };
  }

  // SWARM_DRIVER is the pre-provider configuration surface. Preserve its
  // meaning when SWARM_DEFAULT_PROVIDER has not been set explicitly.
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
