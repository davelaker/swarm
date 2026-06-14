// Prompt caching helpers for the api-key driver.
// Uses client.beta.messages.create() with the prompt-caching-2024-07-31 beta.
//
// Strategy:
//   1. System prompt — marked ephemeral; cached for 5 min across parallel agents
//      in the same run and across sequential runs.
//   2. CLAUDE.md — appended to the system array, also marked ephemeral.
//      Cache key = exact text, so hits when CLAUDE.md hasn't changed.
//
// Minimum eligible sizes: 1024 tokens (Sonnet/Opus), 2048 tokens (Haiku).
// The API ignores cache_control silently if the block is too short — no error.

import type { BetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { loadProjectContextBounded } from '../state/repo.js';

export const CACHE_BETA = 'prompt-caching-2024-07-31' as const;

// Build the system block array: [systemPrompt, optionalProjectCtx].
// Both blocks are marked ephemeral so they can be cached.
export function buildCachedSystem(
  systemPrompt: string,
  projectCtxMax = 8192,
): BetaTextBlockParam[] {
  const blocks: BetaTextBlockParam[] = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  const ctx = loadProjectContextBounded(projectCtxMax);
  if (ctx) {
    blocks.push({
      type: 'text',
      text: `Project context (CLAUDE.md):\n${ctx}`,
      cache_control: { type: 'ephemeral' },
    } as BetaTextBlockParam);
  }

  return blocks;
}

// Log cache stats when non-zero; returns the cache-adjusted cost in USD.
export function logCacheStats(
  agentTag: string,
  usage: { cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null },
  inputPrice: number, // price per million input tokens
): number {
  const write = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  if (write > 0 || read > 0) {
    console.log(`  [${agentTag}] cache: ${write} write tokens, ${read} read tokens`);
  }
  // Cache write costs 1.25× input; cache read costs 0.10× input
  return (write * inputPrice * 1.25 + read * inputPrice * 0.1) / 1_000_000;
}
