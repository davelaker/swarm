import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntakeRequest, validateIntakeClassifyRequest } from './intake.js';

test('validateIntakeClassifyRequest accepts instruction and requested shape', () => {
  assert.deepEqual(validateIntakeClassifyRequest({
    instruction: '  make a plan for moving sessions to sqlite  ',
    requestedShape: 'plan',
  }), {
    ok: true,
    value: {
      instruction: 'make a plan for moving sessions to sqlite',
      requestedShape: 'plan',
    },
  });
});

test('validateIntakeClassifyRequest rejects missing and blank instructions', () => {
  assert.deepEqual(validateIntakeClassifyRequest({}), {
    ok: false,
    error: 'instruction required',
  });
  assert.deepEqual(validateIntakeClassifyRequest({ instruction: '   ' }), {
    ok: false,
    error: 'instruction required',
  });
});

test('validateIntakeClassifyRequest rejects oversized instructions safely', () => {
  const instruction = 'x'.repeat(20_001);
  assert.deepEqual(validateIntakeClassifyRequest({ instruction }), {
    ok: false,
    error: 'instruction too large (max 20000 chars)',
  });
});

test('validateIntakeClassifyRequest rejects unknown requested shapes', () => {
  assert.deepEqual(validateIntakeClassifyRequest({
    instruction: 'explain this repository',
    requestedShape: 'chat',
  }), {
    ok: false,
    error: 'requestedShape must be answer, quick_task, plan, or coordinated_run',
  });
});

test('classifyIntakeRequest returns an IntakeDecision JSON body', async () => {
  const response = await classifyIntakeRequest({
    instruction: 'why is this test flaky?',
  });

  assert.equal(response.status, 200);
  assert.equal(typeof response.body.rationale, 'string');
  assert.equal(typeof response.body.suggestedAction, 'string');
  assert.ok(['answer', 'quick_task', 'plan', 'coordinated_run'].includes(response.body.shape));
  assert.ok(['high', 'medium', 'low'].includes(response.body.confidence));
  assert.equal(Array.isArray(response.body.riskSignals), true);
});

test('classifyIntakeRequest applies requestedShape as an explicit classifier override', async () => {
  const response = await classifyIntakeRequest({
    instruction: 'fix the reconnect banner and outline verification',
    requestedShape: 'plan',
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.shape, 'plan');
  assert.deepEqual(response.body.riskSignals, ['explicit_plan_request']);
});
