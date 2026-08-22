import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetProviderModelPolicy } from '../providers/index.js';
import {
  handleProviderModelsRequest,
  providerModelsStatus,
  validateProviderModelsRequest,
} from './provider-models.js';

afterEach(() => {
  resetProviderModelPolicy();
});

const bothCli = (command: string) => command === 'claude' || command === 'codex';
const codexCli = (command: string) => command === 'codex';

test('validateProviderModelsRequest accepts enabled models and optional default', () => {
  assert.deepEqual(validateProviderModelsRequest({
    enabledModelIds: ['gpt-5.4'],
    defaultModelId: 'gpt-5.4',
  }), {
    ok: true,
    value: { enabledModelIds: ['gpt-5.4'], defaultModelId: 'gpt-5.4' },
  });
  assert.deepEqual(validateProviderModelsRequest({ enabledModelIds: 'gpt-5.4' }), {
    ok: false,
    error: 'enabledModelIds must be an array',
  });
});

test('status lists only locally executable models and has no catalog fallback without auth', () => {
  const noAuth = providerModelsStatus(false, { env: {}, probe: () => false });
  assert.deepEqual(noAuth.enabledModelIds, []);
  assert.equal(noAuth.defaultModelId, '');
  assert.deepEqual(noAuth.providers.flatMap((provider) => provider.models.map((model) => model.id)), []);

  const codexCliOnly = providerModelsStatus(false, { env: {}, probe: codexCli });
  assert.deepEqual(codexCliOnly.providers.find((provider) => provider.provider === 'openai')?.models.map((model) => model.id), ['gpt-5.4']);
  assert.deepEqual(codexCliOnly.providers.find((provider) => provider.provider === 'anthropic')?.models, []);
});

test('one enabled model is automatically selected as the default', () => {
  const result = handleProviderModelsRequest(
    { enabledModelIds: ['gpt-5.4'], defaultModelId: 'claude-fable-5' },
    { activeRun: false, env: {}, probe: codexCli },
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.enabledModelIds, ['gpt-5.4']);
  assert.equal(result.body.defaultModelId, 'gpt-5.4');
});

test('model policy rejects empty, unavailable, and non-planning defaults', () => {
  const empty = handleProviderModelsRequest(
    { enabledModelIds: [] },
    { activeRun: false, env: {}, probe: bothCli },
  );
  assert.equal(empty.status, 422);
  assert.match(empty.body.error, /Enable at least one/);

  const apiOnly = handleProviderModelsRequest(
    { enabledModelIds: ['gpt-5.6-sol'], defaultModelId: 'gpt-5.6-sol' },
    { activeRun: false, env: { OPENAI_API_KEY: 'not-inspected' }, probe: codexCli },
  );
  assert.equal(apiOnly.status, 422);
  assert.match(apiOnly.body.error, /not available through a supported local transport/);

  const nonPlanningDefault = handleProviderModelsRequest(
    {
      enabledModelIds: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
      defaultModelId: 'claude-haiku-4-5-20251001',
    },
    { activeRun: false, env: {}, probe: bothCli },
  );
  assert.equal(nonPlanningDefault.status, 422);
  assert.match(nonPlanningDefault.body.error, /must support PM planning/);
});

test('model policy changes are refused while a run is active', () => {
  const result = handleProviderModelsRequest(
    { enabledModelIds: ['gpt-5.4'], defaultModelId: 'gpt-5.4' },
    { activeRun: true, env: {}, probe: codexCli },
  );

  assert.equal(result.status, 409);
  assert.match(result.body.error, /while a run is in progress/);
});
