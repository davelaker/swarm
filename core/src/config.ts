// Principle 4 — all secrets and API keys through one boundary.
// Today: ANTHROPIC_API_KEY from the environment.
// Tomorrow: per-user keys or managed billing — one file to change.

// Default model for the Coder agent. Override via SWARM_CODER_MODEL.
const DEFAULT_CODER_MODEL = 'claude-opus-4-5-20251101';

export interface Config {
  anthropicApiKey: string;
  port:            number;
  owner:           string;
  leaseSeconds:    number;   // seconds before an in_progress lease is considered expired
  coderModel:      string;
  hardCapUsd:      number;   // C4: abort if a single run exceeds this
  softCapUsd:      number;   // C4: warn at this threshold
  maxAttempts:     number;   // C4: max retries per task before marking failed
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;

  // In agent-sdk mode, the API key is not required — auth flows through
  // the Max plan subscription. We only enforce the key when in api-key mode.
  const mode   = process.env.SWARM_DRIVER?.toLowerCase();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const hasClaudeCli = (() => {
    try { require('node:child_process').execSync('claude --version', { stdio: 'ignore' }); return true; }
    catch { return false; }
  })();

  const usingAgentSdk = mode === 'agent-sdk' || (!apiKey && hasClaudeCli && mode !== 'api-key');

  if (!usingAgentSdk && !apiKey) {
    throw new Error(
      'No authentication available.\n\n' +
      'Option A — Claude Max plan (no API account needed):\n' +
      '  Make sure the claude CLI is installed and signed in.\n' +
      '  SWARM_DRIVER=agent-sdk  (or leave unset — auto-detected)\n\n' +
      'Option B — Anthropic API key:\n' +
      '  export ANTHROPIC_API_KEY=sk-ant-…\n'
    );
  }

  _config = {
    anthropicApiKey: apiKey ?? '',
    port:            Number(process.env.SWARM_PORT          ?? 7000),
    owner:           process.env.SWARM_OWNER                ?? 'me',
    leaseSeconds:    Number(process.env.SWARM_LEASE_SECONDS ?? 300),
    coderModel:      process.env.SWARM_CODER_MODEL          ?? DEFAULT_CODER_MODEL,
    hardCapUsd:      Number(process.env.SWARM_HARD_CAP_USD  ?? 2.00),
    softCapUsd:      Number(process.env.SWARM_SOFT_CAP_USD  ?? 1.00),
    maxAttempts:     Number(process.env.SWARM_MAX_ATTEMPTS  ?? 2),
  };

  return _config!;
}

// Called by commands that don't need the API key (init, check).
export function getConfigOptional(): Omit<Config, 'anthropicApiKey'> & { anthropicApiKey: string | null } {
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
    port:            Number(process.env.SWARM_PORT          ?? 7000),
    owner:           process.env.SWARM_OWNER                ?? 'me',
    leaseSeconds:    Number(process.env.SWARM_LEASE_SECONDS ?? 300),
    coderModel:      process.env.SWARM_CODER_MODEL          ?? DEFAULT_CODER_MODEL,
    hardCapUsd:      Number(process.env.SWARM_HARD_CAP_USD  ?? 2.00),
    softCapUsd:      Number(process.env.SWARM_SOFT_CAP_USD  ?? 1.00),
    maxAttempts:     Number(process.env.SWARM_MAX_ATTEMPTS  ?? 2),
  };
}
