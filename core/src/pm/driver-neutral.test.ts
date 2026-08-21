import assert from 'node:assert/strict';
import test from 'node:test';
import { PM_RESPONSE_SCHEMA, runPmInference } from './index.js';
import type { PmInferenceRequest, PmInferenceResult } from '../drivers/types.js';

const rawResponse = {
  reply: 'The charter is ready to execute.',
  team_add: ['coder'],
  task_graph: [{ id: 't1', assignee: 'coder', title: 'Implement the change', depends_on: [], model: 'opus', effort: 'high' }],
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

test('PM normalises identical Claude and Codex inference data into one PmResponse contract', async () => {
  const request = {
    systemPrompt: 'You are the PM.',
    conversationPrompt: 'Plan this.',
    projectRoot: '/repo',
  };
  const claude = await runPmInference(fakeProvider(rawResponse), request);
  const codex = await runPmInference(fakeProvider(rawResponse), request);

  assert.deepEqual(claude, codex);
  assert.equal(claude.reply, 'The charter is ready to execute.');
  assert.deepEqual(claude.teamAdd, ['coder', 'reviewer']);
  assert.deepEqual(claude.taskGraph, [
    { id: 't1', assignee: 'coder', title: 'Implement the change', depends_on: [], model: 'claude-opus-4-8', effort: 'high' },
  ]);
  assert.equal(claude.enableExecute, true);
});

test('PM output schema requires the response fields shared by every provider', () => {
  assert.deepEqual(PM_RESPONSE_SCHEMA.required, ['reply', 'team_add', 'task_graph']);
});
