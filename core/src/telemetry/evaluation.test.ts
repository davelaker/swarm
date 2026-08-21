import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderAvailability } from '../providers/index.js';
import { evaluateRoutingPolicy } from './evaluation.js';
import type { RoutingEvaluationFixture } from './evaluation.js';

const providers: readonly ProviderAvailability[] = [
  { provider: 'anthropic', enabled: true, cliAvailable: true, apiKeyConfigured: false, availableAuthModes: ['subscription'] },
  { provider: 'openai', enabled: true, cliAvailable: true, apiKeyConfigured: false, availableAuthModes: ['subscription'] },
];

function fixture(name: string, expectedModel: string | null, overrides: Record<string, unknown>): RoutingEvaluationFixture {
  return {
    name,
    expectedModel,
    input: {
      intent: 'coding', scope: 'medium', risk: 'low', writeAccess: 'brokered', writeScope: ['src/example.ts'],
      dependencyCount: 0, deterministic: false, budgetClass: 'premium', providerAvailability: providers,
      ...overrides,
    } as RoutingEvaluationFixture['input'],
  };
}

test('synthetic routing evaluation covers the release policy scenarios', () => {
  const results = evaluateRoutingPolicy([
    fixture('large planning', 'claude-fable-5', { intent: 'planning', scope: 'large' }),
    fixture('large coding', 'claude-opus-4-8', { intent: 'coding', scope: 'large' }),
    fixture('small execution', 'gpt-5.3-codex', { intent: 'execution', scope: 'small' }),
    fixture('deterministic validation', null, { intent: 'validation', deterministic: true, writeAccess: 'none', writeScope: [] }),
  ]);

  assert.deepEqual(results.map((result) => result.pass), [true, true, true, true]);
});

test('evaluation reports policy regressions without changing policy', () => {
  const [result] = evaluateRoutingPolicy([
    fixture('intentional mismatch', 'gpt-5.3-codex', { intent: 'coding', scope: 'large' }),
  ]);
  assert.equal(result.pass, false);
  assert.match(result.detail, /Expected/);
});
