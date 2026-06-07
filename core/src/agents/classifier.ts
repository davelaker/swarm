// Tier classifier — PM's first action on any goal.
// Uses a cheap, fast model because this is a simple classification call.
// DESIGN.md §9: tweak / feature / greenfield.

import Anthropic from '@anthropic-ai/sdk';
import { getConfig }         from '../config.js';
import { tokensToDollars }   from './coder.js';
import type { Tier }         from '../state/types.js';

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM = `\
You classify software tasks for a multi-agent coding system.

Tiers:
- tweak:      single, low-risk change (rename, add comment, fix typo, small config change).
              No new behaviour. Blast radius is one file or one function.
- feature:    new behaviour on an existing codebase. May touch multiple files.
              Needs tests + security review.
- greenfield: new project or subsystem built from scratch.
              Needs full pipeline: planner, coder, tests, security.

Sensitive paths:
- true if the goal touches: SQL queries, auth/login, passwords/secrets/API keys,
  crypto/hashing, permissions/access-control, input validation, shell execution.
- Sensitive tweaks get a security pass even if they are otherwise small.`;

export interface Classification {
  tier:          Tier;
  reasoning:     string;
  sensitive:     boolean;
  costUsd:       number;
}

export async function classify(goal: string): Promise<Classification> {
  const cfg    = getConfig();
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });

  const classifyTool: Anthropic.Tool = {
    name:        'classify',
    description: 'Classify the goal and report sensitive-path status.',
    input_schema: {
      type:       'object',
      properties: {
        tier:      { type: 'string', enum: ['tweak', 'feature', 'greenfield'] },
        reasoning: { type: 'string', description: 'One sentence explaining the classification.' },
        sensitive: { type: 'boolean', description: 'True if the goal touches security-sensitive code paths.' },
      },
      required: ['tier', 'reasoning', 'sensitive'],
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
  if (!toolUse || toolUse.type !== 'tool_use') {
    // Fallback: conservative default
    return { tier: 'feature', reasoning: 'classifier did not return a result', sensitive: false, costUsd: 0 };
  }

  const inp      = toolUse.input as { tier: Tier; reasoning: string; sensitive: boolean };
  const costUsd  = tokensToDollars(CLASSIFIER_MODEL, resp.usage.input_tokens, resp.usage.output_tokens);

  return { tier: inp.tier, reasoning: inp.reasoning, sensitive: inp.sensitive, costUsd };
}
