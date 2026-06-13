// Tier classifier — PM's first action on any goal.
// DESIGN.md §9: tweak / feature / greenfield.
//
// Driver-aware: api-key mode uses the Anthropic SDK directly;
// agent-sdk mode uses `claude -p` so no ANTHROPIC_API_KEY is required.

import Anthropic from '@anthropic-ai/sdk';
import { spawn }              from 'node:child_process';
import { getConfig }          from '../config.js';
import { getDriverMode }      from '../drivers/index.js';
import { getRoot }            from '../state/repo.js';
import { tokensToDollars }    from './coder.js';
import type { Tier }          from '../state/types.js';

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM = `\
You classify software tasks for a multi-agent coding system.

Tiers:
- bugfix:     single, low-risk change (rename, add comment, fix typo, fix an existing bug, small config change).
              No new behaviour. Blast radius is one file or one function.
- feature:    new behaviour on an existing codebase. May touch multiple files.
              Needs tests + security review.
- greenfield: new project or subsystem built from scratch.
              Needs full pipeline: planner, coder, tests, security.
- refactor:   restructuring existing code without changing external behaviour.
              May touch many files. Needs tests to verify no regressions.

Sensitive paths:
- true if the goal touches: SQL queries, auth/login, passwords/secrets/API keys,
  crypto/hashing, permissions/access-control, input validation, shell execution.
- Sensitive tweaks get a security pass even if they are otherwise small.

Security audit:
- true if the PRIMARY purpose of the goal is to audit, find, or review security vulnerabilities
  in existing code — e.g. "run a security audit", "check for vulnerabilities", "review auth code for issues".
- false if the goal is to implement/fix something that happens to touch security-sensitive paths.`;

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    tier:          { type: 'string', enum: ['bugfix', 'feature', 'greenfield', 'refactor'] },
    reasoning:     { type: 'string', description: 'One sentence explaining the classification.' },
    sensitive:     { type: 'boolean', description: 'True if the goal touches security-sensitive code paths.' },
    securityAudit: { type: 'boolean', description: 'True if the primary goal is to audit/find/review security vulnerabilities in existing code.' },
  },
  required: ['tier', 'reasoning', 'sensitive', 'securityAudit'],
});

export interface Classification {
  tier:          Tier;
  reasoning:     string;
  sensitive:     boolean;
  securityAudit: boolean;
  costUsd:       number;
}

const FALLBACK: Classification = {
  tier: 'feature' as const, reasoning: 'classifier did not return a result', sensitive: false, securityAudit: false, costUsd: 0,
};

// ─── Agent SDK path (claude -p) ───────────────────────────────────────────────

async function classifyAgentSdk(goal: string): Promise<Classification> {
  const cfg = getConfig();

  const args = [
    '--print',
    '--output-format', 'json',
    '--json-schema',   SCHEMA,
    '--system-prompt', SYSTEM,
    '--allowedTools',  '',   // no tools — pure reasoning
    '--no-session-persistence',
    '--max-budget-usd', String(cfg.hardCapUsd),
    `Goal: ${goal}`,
  ];

  return new Promise((resolve) => {
    let stdout = '';
    const proc = spawn('claude', args, { cwd: getRoot(), stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });

    const timer = setTimeout(() => { proc.kill(); resolve(FALLBACK); }, 15_000);

    proc.on('error', () => { clearTimeout(timer); resolve(FALLBACK); });
    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) { resolve(FALLBACK); return; }

      try {
        const envelope = JSON.parse(stdout) as { result: unknown; is_error?: boolean; cost_usd?: number };
        if (envelope.is_error) { resolve(FALLBACK); return; }

        const data = typeof envelope.result === 'string'
          ? JSON.parse(envelope.result) as Record<string, unknown>
          : envelope.result as Record<string, unknown>;

        resolve({
          tier:          (data.tier as Tier) ?? 'feature',
          reasoning:     String(data.reasoning ?? ''),
          sensitive:     Boolean(data.sensitive),
          securityAudit: Boolean(data.securityAudit),
          costUsd:       0,   // Max plan — no USD cost tracked
        });
      } catch {
        resolve(FALLBACK);
      }
    });
  });
}

// ─── API-key path (Anthropic SDK) ─────────────────────────────────────────────

async function classifyApiKey(goal: string): Promise<Classification> {
  const cfg    = getConfig();
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });

  const classifyTool: Anthropic.Tool = {
    name:        'classify',
    description: 'Classify the goal and report sensitive-path status.',
    input_schema: {
      type:       'object',
      properties: {
        tier:          { type: 'string', enum: ['bugfix', 'feature', 'greenfield', 'refactor'] },
        reasoning:     { type: 'string', description: 'One sentence explaining the classification.' },
        sensitive:     { type: 'boolean' },
        securityAudit: { type: 'boolean', description: 'True if the primary goal is to audit/find/review security vulnerabilities.' },
      },
      required: ['tier', 'reasoning', 'sensitive', 'securityAudit'],
    },
  };

  const resp = await client.messages.create({
    model:       CLASSIFIER_MODEL,
    max_tokens:  256,
    system:      SYSTEM,
    tools:       [classifyTool],
    tool_choice: { type: 'any' },
    messages:    [{ role: 'user', content: `Goal: ${goal}` }],
  });

  const toolUse = resp.content.find(b => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') return FALLBACK;

  const inp     = toolUse.input as { tier: Tier; reasoning: string; sensitive: boolean };
  const costUsd = tokensToDollars(CLASSIFIER_MODEL, resp.usage.input_tokens, resp.usage.output_tokens);

  return { tier: inp.tier, reasoning: inp.reasoning, sensitive: inp.sensitive, securityAudit: Boolean((inp as Record<string, unknown>).securityAudit), costUsd };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function classify(goal: string): Promise<Classification> {
  return getDriverMode() === 'agent-sdk'
    ? classifyAgentSdk(goal)
    : classifyApiKey(goal);
}
