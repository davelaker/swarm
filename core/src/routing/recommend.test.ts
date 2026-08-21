import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderAvailability } from '../providers/index.js';
import { recommendRoute } from './recommend.js';
import type { RouteRecommendationInput } from './types.js';

const bothProviders: readonly ProviderAvailability[] = [
  { provider: 'anthropic', enabled: true, cliAvailable: true, apiKeyConfigured: false, availableAuthModes: ['subscription'] },
  { provider: 'openai', enabled: true, cliAvailable: true, apiKeyConfigured: false, availableAuthModes: ['subscription'] },
];

function input(overrides: Partial<RouteRecommendationInput> = {}): RouteRecommendationInput {
  return {
    intent: 'coding', scope: 'medium', risk: 'low', writeAccess: 'brokered', writeScope: ['core/src/example.ts'],
    dependencyCount: 0, deterministic: false, budgetClass: 'premium', providerAvailability: bothProviders,
    ...overrides,
  };
}

test('initial routing policy is deterministic and table-driven', () => {
  const cases: Array<{
    name: string;
    overrides: Partial<RouteRecommendationInput>;
    expected: string | null;
    fallback: string | null;
  }> = [
    {
      name: 'large planning selects Fable before Opus',
      overrides: { intent: 'planning', scope: 'large' },
      expected: 'claude-fable-5', fallback: 'claude-opus-4-8',
    },
    {
      name: 'large coding selects Opus',
      overrides: { intent: 'coding', scope: 'large' },
      expected: 'claude-opus-4-8', fallback: 'claude-fable-5',
    },
    {
      name: 'small execution selects Codex',
      overrides: { intent: 'execution', scope: 'small' },
      expected: 'gpt-5.3-codex', fallback: 'claude-haiku-4-5-20251001',
    },
    {
      name: 'deterministic checks use no model',
      overrides: { intent: 'validation', deterministic: true, writeAccess: 'none', writeScope: [] },
      expected: null, fallback: null,
    },
  ];

  for (const scenario of cases) {
    const recommendation = recommendRoute(input(scenario.overrides));
    if (scenario.expected === null) {
      if (recommendation.kind !== 'no-model') {
        throw new Error(scenario.name);
      }
      assert.ok(recommendation.rationale.length > 0, scenario.name);
      assert.equal(recommendation.fallback, scenario.fallback, scenario.name);
    } else {
      if (recommendation.kind !== 'model') {
        throw new Error(scenario.name);
      }
      assert.equal(recommendation.route.model, scenario.expected, scenario.name);
      assert.equal(recommendation.route.fallback?.model ?? null, scenario.fallback, scenario.name);
      assert.ok(recommendation.route.rationale.length > 0, scenario.name);
    }
  }
});

test('availability and model allow-lists fail closed and provide an available fallback', () => {
  const openaiOnly = [{ ...bothProviders[0], availableAuthModes: [] }, bothProviders[1]];
  const recommendation = recommendRoute(input({ intent: 'coding', scope: 'large', providerAvailability: openaiOnly }));
  if (recommendation.kind !== 'model') {
    throw new Error('Expected a model route.');
  }
  assert.equal(recommendation.route.provider, 'openai');
  assert.ok(recommendation.route.fallback === null || recommendation.route.fallback.provider === 'openai');

  assert.throws(
    () => recommendRoute(input({ availableModelIds: [] })),
    /No available provider model supports coding work/,
  );
});

test('risk, dependencies, budget, and review diversity influence deterministic decisions', () => {
  const expensive = recommendRoute(input({ intent: 'coding', scope: 'large', budgetClass: 'economy', dependencyCount: 3 }));
  if (expensive.kind !== 'model') {
    throw new Error('Expected a model route.');
  }
  assert.equal(expensive.route.reasoningEffort, 'high');
  assert.equal(expensive.route.requiresConfirmation, true);

  const review = recommendRoute(input({
    intent: 'review', scope: 'medium', reviewerDiversity: { requireDifferentProvider: true, implementationProvider: 'anthropic' },
  }));
  if (review.kind !== 'model') {
    throw new Error('Expected a model route.');
  }
  assert.equal(review.route.provider, 'openai');
  assert.match(review.route.rationale, /independent review/);
});

test('effort is selected from provider-native levels with budget and critical-risk rules explained', () => {
  const critical = recommendRoute(input({
    intent: 'coding', scope: 'large', risk: 'critical', dependencyCount: 6, budgetClass: 'economy',
  }));
  if (critical.kind !== 'model') {
    throw new Error('Expected a model route.');
  }
  assert.equal(critical.route.model, 'claude-opus-4-8');
  assert.equal(critical.route.reasoningEffort, 'xhigh');
  assert.equal(critical.route.requiresConfirmation, true);
  assert.match(critical.route.rationale, /complexity, risk, dependency depth, and budget guardrail/);

  const economical = recommendRoute(input({
    intent: 'coding', scope: 'large', risk: 'high', dependencyCount: 3, budgetClass: 'economy',
  }));
  if (economical.kind !== 'model') {
    throw new Error('Expected a model route.');
  }
  assert.equal(economical.route.reasoningEffort, 'high');
  assert.match(economical.route.rationale, /high reasoning effort/);

  const premium = recommendRoute(input({
    intent: 'coding', scope: 'large', risk: 'high', dependencyCount: 3, budgetClass: 'premium',
  }));
  if (premium.kind !== 'model') {
    throw new Error('Expected a model route.');
  }
  assert.equal(premium.route.reasoningEffort, 'xhigh');
});

test('Codex subscription routes never select Responses-API-only OpenAI models', () => {
  const openaiSubscriptionOnly: readonly ProviderAvailability[] = [
    { ...bothProviders[0], enabled: false, availableAuthModes: [] },
    bothProviders[1],
  ];
  const smallTask = recommendRoute(input({
    intent: 'execution', scope: 'small', providerAvailability: openaiSubscriptionOnly,
  }));
  if (smallTask.kind !== 'model') {
    throw new Error('Expected a model route.');
  }
  assert.equal(smallTask.route.model, 'gpt-5.3-codex');
  assert.notEqual(smallTask.route.reasoningEffort, 'none');

  assert.throws(
    () => recommendRoute(input({ intent: 'planning', scope: 'large', providerAvailability: openaiSubscriptionOnly })),
    /No available provider model supports planning work/,
  );
});
