// Driver factory — picks the right implementation based on environment.
// Everything above this (loop, dispatch, state) is driver-agnostic.

import { agentSdkDriver } from './agent-sdk.js';
import { apiKeyDriver } from './api-key.js';
import { resolveDriverMode, type AgentDriver, type DriverMode } from './types.js';
import { getProviderSelection } from '../providers/index.js';

function detect(): DriverMode {
  const selection = getProviderSelection();
  if (selection.defaultProvider !== 'anthropic') {
    throw new Error(
      'OpenAI is selected, but the Codex driver is not installed yet. Select Anthropic or complete the Codex driver setup.',
    );
  }
  const anthropic = selection.availability.find((provider) => provider.provider === 'anthropic')!;
  return resolveDriverMode({
    explicitDriver: process.env.SWARM_DRIVER,
    hasAnthropicApiKey: anthropic.apiKeyConfigured,
    hasClaudeCli: anthropic.cliAvailable,
  });
}

let _driver: AgentDriver | null = null;

export function getDriver(): AgentDriver {
  if (_driver) return _driver;
  const mode = detect();
  _driver = mode === 'agent-sdk' ? agentSdkDriver : apiKeyDriver;
  return _driver;
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
  return '  ▸ driver     → Anthropic API key configured';
}

export { type AgentDriver, type DriverMode };
