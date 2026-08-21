import assert from 'node:assert/strict';
import test from 'node:test';
import { appendOutcome, buildTaskOutcome } from './outcomes.js';
import type { Task } from '../state/types.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Never persist this title as telemetry content',
    status: 'pending',
    owner: 'me',
    assignee: 'security',
    depends_on: [],
    artifacts: [],
    result_ref: null,
    attempts: 2,
    route: {
      provider: 'openai',
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
      rationale: 'This must not appear in telemetry.',
      fallback: null,
      requiresConfirmation: false,
      writeScope: ['src/**'],
    },
    ...overrides,
  };
}

test('buildTaskOutcome allow-lists only safe route and gate metadata', () => {
  const outcome = buildTaskOutcome({
    task: task(),
    status: 'blocked',
    durationMs: 12.6,
    verdict: 'CHANGES_REQUESTED',
    blocksDone: true,
  });

  assert.deepEqual(outcome, {
    taskId: 't1',
    agentId: 'security',
    route: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'medium' },
    durationMs: 13,
    retries: 1,
    status: 'blocked',
    verdict: 'CHANGES_REQUESTED',
    gateFinding: { verdict: 'CHANGES_REQUESTED', blocksDone: true },
    costQuotaClass: 'subscription-quota',
  });
  const serialized = JSON.stringify(outcome);
  assert.doesNotMatch(serialized, /Never persist|rationale|writeScope|prompt|credential/i);
});

test('classifies deterministic and API-billed work without recording prices', () => {
  assert.equal(
    buildTaskOutcome({ task: task({ assignee: 'checks', route: undefined }), status: 'done', durationMs: 0 }).costQuotaClass,
    'unmetered',
  );
  const apiOutcome = buildTaskOutcome({ task: task(), status: 'done', durationMs: 1, costUsd: 0.001 });
  assert.equal(apiOutcome.costQuotaClass, 'api-metered');
  assert.equal('costUsd' in apiOutcome, false);
});

test('outcome history is bounded and rejects unsafe limits', () => {
  const first = buildTaskOutcome({ task: task({ id: 't1' }), status: 'done', durationMs: 1 });
  const second = buildTaskOutcome({ task: task({ id: 't2' }), status: 'done', durationMs: 1 });
  assert.deepEqual(appendOutcome([first], second, 1).map((outcome) => outcome.taskId), ['t2']);
  assert.throws(() => appendOutcome([], first, 0), /positive safe integer/);
});
