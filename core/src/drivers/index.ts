// Driver factory — picks the right implementation based on environment.
// Everything above this (loop, dispatch, state) is driver-agnostic.

import { agentSdkDriver } from './agent-sdk.js';
import { apiKeyDriver } from './api-key.js';
import { codexDriver } from './codex.js';
import { resolveDriverMode, type AgentDriver, type DriverMode } from './types.js';
import { getProviderSelection, providerModelPolicyRevision } from '../providers/index.js';
import type { ProviderId } from '../providers/index.js';

function detect(): DriverMode {
  const selection = getProviderSelection();
  if (selection.defaultProvider === 'openai') {
    const openai = selection.availability.find((provider) => provider.provider === 'openai')!;
    if (!openai.cliAvailable) {
      throw new Error('OpenAI is selected, but the read-only Codex driver requires the local Codex CLI.');
    }
    return 'codex';
  }
  const anthropic = selection.availability.find((provider) => provider.provider === 'anthropic')!;
  return resolveDriverMode({
    explicitDriver: process.env.SWARM_DRIVER,
    hasAnthropicApiKey: anthropic.apiKeyConfigured,
    hasClaudeCli: anthropic.cliAvailable,
  });
}

let _driver: AgentDriver | null = null;
let _driverCacheKey: string | null = null;

export function getDriver(): AgentDriver {
  const mode = detect();
  const cacheKey = `${providerModelPolicyRevision()}:${mode}`;
  if (_driver && _driverCacheKey === cacheKey) {
    return _driver;
  }
  _driver = mode === 'agent-sdk' ? agentSdkDriver : apiKeyDriver;
  if (mode === 'codex') {
    _driver = codexDriver;
  }
  _driverCacheKey = cacheKey;
  return _driver;
}

/**
 * Resolve a driver for an already validated task route. This deliberately does
 * not fall back to the process default: selecting a route for another provider
 * must either run that provider or fail closed.
 */
export function getDriverForProvider(provider: ProviderId): AgentDriver {
  const selection = getProviderSelection();
  const availability = selection.availability.find((entry) => entry.provider === provider);
  if (!availability) {
    throw new Error(`Provider "${provider}" is not enabled for this Swarm run.`);
  }
  if (!availability.enabled) {
    throw new Error(`Provider "${provider}" is not enabled for this Swarm run.`);
  }
  if (!availability.availableAuthModes.length) {
    throw new Error(`Provider "${provider}" has no supported local authentication available.`);
  }
  if (provider === 'openai') {
    if (!availability.cliAvailable) {
      throw new Error('OpenAI task routes require the local Codex CLI; API-key transport is not implemented.');
    }
    return codexDriver;
  }
  const explicit = process.env.SWARM_DRIVER?.toLowerCase();
  const mode = resolveDriverMode({
    // A Codex-wide default must not leak into an explicitly Anthropic task.
    explicitDriver: explicit === 'agent-sdk' || explicit === 'api-key' ? explicit : undefined,
    hasAnthropicApiKey: availability.apiKeyConfigured,
    hasClaudeCli: availability.cliAvailable,
  });
  return mode === 'agent-sdk' ? agentSdkDriver : apiKeyDriver;
}

export function getDriverMode(): DriverMode {
  return detect();
}

// Surface the active driver in the CLI startup banner
export function driverBanner(): string {
  const mode = detect();
  if (mode === 'agent-sdk') {
    return '  ▸ driver     → Claude Agent SDK (Max plan · $200/month credit)';
  }
  if (mode === 'codex') {
    return '  ▸ driver     → Codex CLI (read-only patch proposals)';
  }
  return '  ▸ driver     → Anthropic API key configured';
}

export { type AgentDriver, type DriverMode };
