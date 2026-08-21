import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getProviderModel,
  listProviderModels,
  validateProviderModel,
  validateReasoningEffort,
} from './index.js';

test('catalog exposes provider-neutral Claude and Codex records', () => {
  const claude = validateProviderModel('claude-opus-4-8');
  const codex = validateProviderModel('gpt-5.3-codex');

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
  assert.equal(codex.label, 'GPT-5.3 Codex');
  assert.ok(codex.capabilities.includes('coding'));
  assert.ok(codex.reasoningEfforts.includes('high'));
});

test('catalog can query models by provider without loading an SDK', () => {
  assert.equal(getProviderModel('not-a-model'), undefined);
  assert.deepEqual(
    listProviderModels('openai').map((model) => model.id),
    ['gpt-5.3-codex', 'gpt-5.4'],
  );
});

test('unknown models explain how to correct the selection', () => {
  assert.throws(
    () => validateProviderModel('gpt-unknown'),
    /Unknown model "gpt-unknown"\. Choose a catalog model: .*gpt-5\.3-codex/,
  );
});

test('reasoning validation reports unsupported effort clearly', () => {
  assert.throws(
    () => validateReasoningEffort('claude-haiku-4-5-20251001', 'high'),
    /does not support "high" reasoning effort\. Supported levels: none/,
  );
  assert.equal(validateReasoningEffort('gpt-5.3-codex', 'medium').id, 'gpt-5.3-codex');
});
