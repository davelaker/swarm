import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTaskRouteForDispatch } from './index.js';
import type { ProviderAvailability } from '../providers/index.js';
import type { Task } from '../state/types.js';

const available: readonly ProviderAvailability[] = [
  { provider: 'anthropic', enabled: true, cliAvailable: true, apiKeyConfigured: false, availableAuthModes: ['subscription'] },
  { provider: 'openai', enabled: true, cliAvailable: true, apiKeyConfigured: false, availableAuthModes: ['subscription'] },
];
const enabledModels = ['gpt-5.4', 'claude-sonnet-4-6'];

function task(route: Task['route']): Task {
  return {
    id: 't1', title: 'Change the file', status: 'pending', owner: 'me', assignee: 'coder',
    depends_on: [], artifacts: [], result_ref: null, attempts: 0, route,
  };
}

test('accepts an available Codex coder route with an explicit write scope', () => {
  assert.doesNotThrow(() => validateTaskRouteForDispatch(task({
    provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'medium', rationale: 'Small contained change.',
    fallback: { provider: 'anthropic', model: 'claude-sonnet-4-6', reasoningEffort: 'medium' },
    requiresConfirmation: false, writeScope: ['src/allowed.ts'],
  }), available, enabledModels));
});

test('fails closed for unavailable provider, invalid effort, and pending confirmation', () => {
  const base = {
    provider: 'openai' as const, model: 'gpt-5.4', rationale: 'Small contained change.', fallback: null,
    requiresConfirmation: false, writeScope: ['src/allowed.ts'],
  };
  assert.throws(() => validateTaskRouteForDispatch(task(base), [
    available[0], { ...available[1], availableAuthModes: [] },
  ], enabledModels), /unavailable or unauthorised/);
  assert.throws(() => validateTaskRouteForDispatch(task({ ...base, model: 'claude-haiku-4-5-20251001', reasoningEffort: 'high' }), available, [
    ...enabledModels,
    'claude-haiku-4-5-20251001',
  ]), /not available from provider/);
  assert.throws(() => validateTaskRouteForDispatch(task({ ...base, requiresConfirmation: true }), available, enabledModels), /requires user confirmation/);
});

test('rejects coder routes without a declared broker write scope', () => {
  assert.throws(() => validateTaskRouteForDispatch(task({
    provider: 'openai', model: 'gpt-5.4', rationale: 'Change code.', fallback: null,
    requiresConfirmation: false, writeScope: [],
  }), available, enabledModels), /must declare a non-empty write scope/);
});

test('current model policy rejects disabled task routes and disabled fallbacks', () => {
  assert.throws(() => validateTaskRouteForDispatch(task({
    provider: 'anthropic', model: 'claude-sonnet-4-6', reasoningEffort: 'medium', rationale: 'Use Claude.',
    fallback: null, requiresConfirmation: false, writeScope: ['src/allowed.ts'],
  }), available, ['gpt-5.4']), /model "claude-sonnet-4-6" is disabled/);

  assert.throws(() => validateTaskRouteForDispatch(task({
    provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'medium', rationale: 'Use Codex.',
    fallback: { provider: 'anthropic', model: 'claude-sonnet-4-6', reasoningEffort: 'medium' },
    requiresConfirmation: false, writeScope: ['src/allowed.ts'],
  }), available, ['gpt-5.4']), /fallback model "claude-sonnet-4-6" is disabled/);
});
