// Principle 4 — all secrets and API keys through one boundary.
import { execSync } from 'node:child_process';

// Model defaults per agent role. Tester and Security use Haiku — structured
// output tasks that don't require Sonnet-level reasoning. Coder and Reviewer
// use Sonnet because they need judgment about code quality and architecture.
const DEFAULT_CODER_MODEL    = 'claude-sonnet-4-6';
const DEFAULT_REVIEWER_MODEL = 'claude-sonnet-4-6';
const DEFAULT_TESTER_MODEL   = 'claude-haiku-4-5-20251001'; // ~70% cheaper; structured pass/fail
const DEFAULT_SECURITY_MODEL = 'claude-haiku-4-5-20251001'; // read-only structured output

export interface Config {
  anthropicApiKey: string;
  port:            number;
  owner:           string;
  leaseSeconds:    number;
  coderModel:      string;
  testerModel:     string;
  securityModel:   string;
  reviewerModel:   string;
  hardCapUsd:      number;
  softCapUsd:      number;
  maxAttempts:     number;
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;

  const mode   = process.env.SWARM_DRIVER?.toLowerCase();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const hasClaudeCli = (() => {
    try { execSync('claude --version', { stdio: 'ignore' }); return true; }
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
    port:            Number(process.env.SWARM_PORT           ?? 7000),
    owner:           process.env.SWARM_OWNER                 ?? 'me',
    leaseSeconds:    Number(process.env.SWARM_LEASE_SECONDS  ?? 300),
    coderModel:      process.env.SWARM_CODER_MODEL           ?? DEFAULT_CODER_MODEL,
    testerModel:     process.env.SWARM_TESTER_MODEL          ?? DEFAULT_TESTER_MODEL,
    securityModel:   process.env.SWARM_SECURITY_MODEL        ?? DEFAULT_SECURITY_MODEL,
    reviewerModel:   process.env.SWARM_REVIEWER_MODEL        ?? DEFAULT_REVIEWER_MODEL,
    hardCapUsd:      Number(process.env.SWARM_HARD_CAP_USD   ?? 2.00),
    softCapUsd:      Number(process.env.SWARM_SOFT_CAP_USD   ?? 1.00),
    maxAttempts:     Number(process.env.SWARM_MAX_ATTEMPTS   ?? 2),
  };

  return _config!;
}

export function getConfigOptional(): Omit<Config, 'anthropicApiKey'> & { anthropicApiKey: string | null } {
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
    port:            Number(process.env.SWARM_PORT           ?? 7000),
    owner:           process.env.SWARM_OWNER                 ?? 'me',
    leaseSeconds:    Number(process.env.SWARM_LEASE_SECONDS  ?? 300),
    coderModel:      process.env.SWARM_CODER_MODEL           ?? DEFAULT_CODER_MODEL,
    testerModel:     process.env.SWARM_TESTER_MODEL          ?? DEFAULT_TESTER_MODEL,
    securityModel:   process.env.SWARM_SECURITY_MODEL        ?? DEFAULT_SECURITY_MODEL,
    reviewerModel:   process.env.SWARM_REVIEWER_MODEL        ?? DEFAULT_REVIEWER_MODEL,
    hardCapUsd:      Number(process.env.SWARM_HARD_CAP_USD   ?? 2.00),
    softCapUsd:      Number(process.env.SWARM_SOFT_CAP_USD   ?? 1.00),
    maxAttempts:     Number(process.env.SWARM_MAX_ATTEMPTS   ?? 2),
  };
}
