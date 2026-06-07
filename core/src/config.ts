// Principle 4 — all secrets and API keys through one boundary.
// Today: ANTHROPIC_API_KEY from the environment.
// Tomorrow: per-user keys or managed billing — one file to change.

export interface Config {
  anthropicApiKey: string;
  port:            number;
  owner:           string;
  leaseSeconds:    number; // how long before an in_progress task is considered dead
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
    port:            Number(process.env.SWARM_PORT ?? 7000),
    owner:           process.env.SWARM_OWNER ?? 'me',
    leaseSeconds:    Number(process.env.SWARM_LEASE_SECONDS ?? 300),
  };

  return _config;
}

// Called by commands that don't need the API key (init, check basics).
export function getConfigOptional(): Omit<Config, 'anthropicApiKey'> & { anthropicApiKey: string | null } {
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
    port:            Number(process.env.SWARM_PORT ?? 7000),
    owner:           process.env.SWARM_OWNER ?? 'me',
    leaseSeconds:    Number(process.env.SWARM_LEASE_SECONDS ?? 300),
  };
}
