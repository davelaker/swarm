// Driver factory — picks the right implementation based on environment.
// Everything above this (loop, dispatch, state) is driver-agnostic.

import { agentSdkDriver } from './agent-sdk.js';
import { apiKeyDriver } from './api-key.js';
import { codexDriver } from './codex.js';
import { resolveDriverMode, type AgentDriver, type DriverMode } from './types.js';
import { getProviderSelection } from '../providers/index.js';

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

export function getDriver(): AgentDriver {
  if (_driver) return _driver;
  const mode = detect();
  _driver = mode === 'agent-sdk' ? agentSdkDriver : apiKeyDriver;
  if (mode === 'codex') {
    _driver = codexDriver;
  }
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
  if (mode === 'codex') {
    return '  ▸ driver     → Codex CLI (read-only patch proposals)';
  }
  return '  ▸ driver     → Anthropic API key configured';
}

export { type AgentDriver, type DriverMode };
