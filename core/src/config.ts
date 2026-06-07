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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set.\n' +
      'Export it before running swarm:\n\n' +
      '  export ANTHROPIC_API_KEY=sk-ant-…\n'
    );
  }

  _config = {
    anthropicApiKey: apiKey,
    port:            Number(process.env.SWARM_PORT          ?? 7000),
    owner:           process.env.SWARM_OWNER                ?? 'me',
    leaseSeconds:    Number(process.env.SWARM_LEASE_SECONDS ?? 300),
    coderModel:      process.env.SWARM_CODER_MODEL          ?? DEFAULT_CODER_MODEL,
    hardCapUsd:      Number(process.env.SWARM_HARD_CAP_USD  ?? 2.00),
    softCapUsd:      Number(process.env.SWARM_SOFT_CAP_USD  ?? 1.00),
    maxAttempts:     Number(process.env.SWARM_MAX_ATTEMPTS  ?? 2),
  };

  return _config;
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
