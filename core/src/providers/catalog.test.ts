import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getProviderModel,
  listProviderModels,
  listProviderModelsForTransport,
  supportsExecutionTransport,
  validateProviderModel,
  validateReasoningEffort,
  validateSupportedReasoningEffort,
} from './index.js';

test('catalog exposes provider-neutral Claude and OpenAI execution records', () => {
  const claude = validateProviderModel('claude-opus-4-8');
  const codex = validateProviderModel('gpt-5.4');

  assert.deepEqual(
    {
      provider: claude.provider,
      tier: claude.tier,
      capabilities: claude.capabilities,
      authModes: claude.authModes,
    },
    {
      provider: 'anthropic',
      tier: 'frontier',
      capabilities: ['coding', 'planning', 'review'],
      authModes: ['subscription', 'api-key'],
    },
  );
  assert.equal(codex.provider, 'openai');
  assert.equal(codex.label, 'GPT-5.4');
  assert.ok(codex.capabilities.includes('coding'));
  assert.ok(codex.reasoningEfforts.includes('high'));
  assert.deepEqual(codex.supportedReasoningEfforts, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(codex.executionTransports, ['codex-cli', 'openai-responses-api']);
});

test('catalog can query models by provider without loading an SDK', () => {
  assert.equal(getProviderModel('not-a-model'), undefined);
  assert.deepEqual(
    listProviderModels('openai').map((model) => model.id),
    ['gpt-5.4', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  );
});

test('OpenAI model families retain their documented purpose, effort, and transport', () => {
  const sol = validateProviderModel('gpt-5.6-sol');
  const terra = validateProviderModel('gpt-5.6-terra');
  const luna = validateProviderModel('gpt-5.6-luna');

  assert.equal(sol.tier, 'frontier');
  assert.equal(terra.tier, 'standard');
  assert.equal(luna.tier, 'fast');
  for (const model of [sol, terra, luna]) {
    assert.deepEqual(model.supportedReasoningEfforts, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(model.executionTransports, ['openai-responses-api']);
    assert.equal(model.authModes.includes('subscription'), false);
  }
  assert.equal(validateSupportedReasoningEffort('gpt-5.6-sol', 'none').id, 'gpt-5.6-sol');
  assert.throws(
    () => validateSupportedReasoningEffort('gpt-5.4', 'max'),
    /does not support "max" reasoning effort/,
  );
});

test('local Codex subscriptions cannot select Responses-API-only models', () => {
  assert.deepEqual(
    listProviderModelsForTransport('codex-cli', 'openai').map((model) => model.id),
    ['gpt-5.4'],
  );
  assert.equal(supportsExecutionTransport('gpt-5.4', 'codex-cli'), true);
  assert.equal(supportsExecutionTransport('gpt-5.6-sol', 'codex-cli'), false);
  assert.equal(supportsExecutionTransport('gpt-5.6-terra', 'codex-cli'), false);
});

test('unknown models explain how to correct the selection', () => {
  assert.throws(
    () => validateProviderModel('gpt-unknown'),
    /Unknown model "gpt-unknown"\. Choose a catalog model: .*gpt-5\.4/,
  );
});

test('reasoning validation reports unsupported effort clearly', () => {
  assert.throws(
    () => validateReasoningEffort('claude-haiku-4-5-20251001', 'high'),
    /does not support "high" reasoning effort\. Supported levels: none/,
  );
  assert.equal(validateReasoningEffort('gpt-5.4', 'medium').id, 'gpt-5.4');
});
