// Driver factory — picks the right implementation based on environment.
// Everything above this (loop, dispatch, state) is driver-agnostic.

import { execSync } from 'node:child_process';
import { agentSdkDriver } from './agent-sdk.js';
import { apiKeyDriver } from './api-key.js';
import type { AgentDriver } from './types.js';

export type DriverMode = 'agent-sdk' | 'api-key';

function detect(): DriverMode {
  const explicit = process.env.SWARM_DRIVER?.toLowerCase();
  if (explicit === 'agent-sdk') return 'agent-sdk';
  if (explicit === 'api-key') return 'api-key';

  // Explicit API key → use it
  if (process.env.ANTHROPIC_API_KEY) return 'api-key';

  // Check if the claude CLI is available and authenticated
  try {
    execSync('claude --version', { stdio: 'ignore' });
    return 'agent-sdk';
  } catch {
    // claude not in PATH → fall through to api-key (will surface a clear error)
    return 'api-key';
  }
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

export { type AgentDriver };
