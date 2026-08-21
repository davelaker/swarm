// Driver factory — picks the right implementation based on environment.
// Everything above this (loop, dispatch, state) is driver-agnostic.

import { execSync } from 'node:child_process';
import { agentSdkDriver } from './agent-sdk.js';
import { apiKeyDriver } from './api-key.js';
import { resolveDriverMode, type AgentDriver, type DriverMode } from './types.js';

function detect(): DriverMode {
  let hasClaudeCli = false;
  try {
    execSync('claude --version', { stdio: 'ignore' });
    hasClaudeCli = true;
  } catch {
    // claude not in PATH → fall through to api-key (will surface a clear error)
  }
  return resolveDriverMode({
    explicitDriver: process.env.SWARM_DRIVER,
    hasAnthropicApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    hasClaudeCli,
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
  const key = process.env.ANTHROPIC_API_KEY ?? '';
  return `  ▸ driver     → API key (${key.slice(0, 14)}…)`;
}

export { type AgentDriver, type DriverMode };
