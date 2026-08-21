import assert from 'node:assert/strict';
import test from 'node:test';
import { PM_RESPONSE_SCHEMA, runPmInference } from './index.js';
import type { PmInferenceRequest, PmInferenceResult } from '../drivers/types.js';
import type { PmRoutingContext } from './routing.js';

const rawResponse = {
  reply: 'The charter is ready to execute.',
  team_add: ['coder'],
  task_graph: [{ id: 't1', assignee: 'coder', title: 'Implement the change', depends_on: [], intent: 'coding', scope: 'large', write_scope: ['src/**'], model_preference: 'opus' }],
  enable_execute: true,
};

function fakeProvider(data: Record<string, unknown>): Pick<{ runPm(request: PmInferenceRequest): Promise<PmInferenceResult> }, 'runPm'> {
  return {
    async runPm(request) {
      assert.equal(request.outputSchema, PM_RESPONSE_SCHEMA);
      assert.equal(request.projectRoot, '/repo');
      return { data };
    },
  };
}

const routingContext: PmRoutingContext = {
  providerAvailability: [
    { provider: 'anthropic', enabled: true, cliAvailable: true, apiKeyConfigured: false, availableAuthModes: ['subscription'] },
    { provider: 'openai', enabled: true, cliAvailable: true, apiKeyConfigured: false, availableAuthModes: ['subscription'] },
  ],
};

test('PM normalises identical Claude and Codex inference data into one PmResponse contract', async () => {
  const request = {
    systemPrompt: 'You are the PM.',
    conversationPrompt: 'Plan this.',
    projectRoot: '/repo',
  };
  const claude = await runPmInference(fakeProvider(rawResponse), request, routingContext);
  const codex = await runPmInference(fakeProvider(rawResponse), request, routingContext);

  assert.deepEqual(claude, codex);
  assert.equal(claude.reply, 'The charter is ready to execute.');
  assert.deepEqual(claude.teamAdd, ['coder', 'reviewer']);
  assert.equal(claude.taskGraph?.[0].route?.provider, 'anthropic');
  assert.equal(claude.taskGraph?.[0].route?.model, 'claude-opus-4-8');
  assert.equal(claude.taskGraph?.[0].route?.requiresConfirmation, true);
  assert.deepEqual(claude.taskGraph?.[0].route?.writeScope, ['src/**']);
  assert.equal(claude.enableExecute, true);
});

test('PM output schema requires the response fields shared by every provider', () => {
  assert.deepEqual(PM_RESPONSE_SCHEMA.required, ['reply', 'team_add', 'task_graph']);
});
