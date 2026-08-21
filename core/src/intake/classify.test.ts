import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyIntake, classifyIntakeInput, classifyRequestedIntake } from './classify.js';
import type { ExecutionShape, IntakeRiskSignal } from './types.js';

test('classifyIntake selects the expected execution shape for representative requests', () => {
  const cases: Array<{
    name: string;
    request: string;
    expectedShape: ExecutionShape;
    expectedConfidence: 'high' | 'medium' | 'low';
    expectedSignals: IntakeRiskSignal[];
  }> = [
    {
      name: 'read-only question becomes answer',
      request: 'Why is the stale banner still visible after reconnect?',
      expectedShape: 'answer',
      expectedConfidence: 'high',
      expectedSignals: [],
    },
    {
      name: 'explicit ask stays answer',
      request: '/ask review the current reconnect flow without changing code',
      expectedShape: 'answer',
      expectedConfidence: 'high',
      expectedSignals: ['explicit_read_only'],
    },
    {
      name: 'planning request becomes plan',
      request: 'Come up with an engineering plan for lightweight intake and escalation',
      expectedShape: 'plan',
      expectedConfidence: 'high',
      expectedSignals: [],
    },
    {
      name: 'bounded fix becomes quick task',
      request: 'Fix the stale reconnect banner in the dashboard',
      expectedShape: 'quick_task',
      expectedConfidence: 'high',
      expectedSignals: [],
    },
    {
      name: 'small explicit do with parallel follow-ons lowers confidence but stays quick task',
      request: '/do add the missing empty state and update the docs as well',
      expectedShape: 'quick_task',
      expectedConfidence: 'medium',
      expectedSignals: ['multi_step_delivery', 'explicit_quick_task'],
    },
    {
      name: 'explicit planning wins over coding wording when risk is low',
      request: '/plan fix the reconnect banner and outline the verification steps',
      expectedShape: 'plan',
      expectedConfidence: 'high',
      expectedSignals: ['explicit_plan_request'],
    },
    {
      name: 'security-sensitive work escalates to coordinated run',
      request: 'Fix the auth token handling in the login flow',
      expectedShape: 'coordinated_run',
      expectedConfidence: 'medium',
      expectedSignals: ['security_sensitive'],
    },
    {
      name: 'migration work escalates to coordinated run',
      request: 'Move sessions to SQLite with a schema migration and backfill',
      expectedShape: 'coordinated_run',
      expectedConfidence: 'medium',
      expectedSignals: ['migration'],
    },
    {
      name: 'broad replacement escalates to coordinated run',
      request: 'Replace the permission model across the codebase',
      expectedShape: 'coordinated_run',
      expectedConfidence: 'medium',
      expectedSignals: ['security_sensitive', 'broad_refactor'],
    },
    {
      name: 'destructive data change escalates to coordinated run',
      request: 'Delete data from the old sessions table and reset the migration history',
      expectedShape: 'coordinated_run',
      expectedConfidence: 'medium',
      expectedSignals: ['migration', 'destructive_change'],
    },
    {
      name: 'delete wording with permanence escalates to coordinated run',
      request: 'Delete old sessions permanently after the rollout',
      expectedShape: 'coordinated_run',
      expectedConfidence: 'medium',
      expectedSignals: ['migration', 'destructive_change'],
    },
    {
      name: 'empty request asks for clarification via plan',
      request: '   ',
      expectedShape: 'plan',
      expectedConfidence: 'low',
      expectedSignals: ['unclear_scope'],
    },
  ];

  for (const scenario of cases) {
    const decision = classifyIntake(scenario.request);
    assert.equal(decision.shape, scenario.expectedShape, scenario.name);
    assert.equal(decision.confidence, scenario.expectedConfidence, scenario.name);
    assert.deepEqual(decision.riskSignals, scenario.expectedSignals, scenario.name);
    assert.ok(decision.rationale.length > 0, scenario.name);
    assert.ok(decision.suggestedAction.length > 0, scenario.name);
  }
});

test('explicit coordinated runs stay coordinated even when the text looks small', () => {
  const decision = classifyRequestedIntake('rename the stale banner component', 'coordinated_run');
  assert.equal(decision.shape, 'coordinated_run');
  assert.equal(decision.confidence, 'high');
  assert.deepEqual(decision.riskSignals, ['explicit_coordinated_run']);
});

test('questions about sensitive systems remain answers while surfacing risk', () => {
  const decision = classifyIntake('Why is the SQL auth query failing for admin users?');
  assert.equal(decision.shape, 'answer');
  assert.deepEqual(decision.riskSignals, ['security_sensitive']);
});

test('ambiguous actionable requests default to plan instead of guessing writes', () => {
  const decision = classifyIntake('Take a look at the session system');
  assert.equal(decision.shape, 'plan');
  assert.equal(decision.confidence, 'medium');
  assert.deepEqual(decision.riskSignals, ['unclear_scope']);
});

test('explicit requested shape is applied independently of slash-prefix text', () => {
  const decision = classifyIntakeInput({
    instruction: 'map the implementation approach for lightweight intake',
    requestedShape: 'plan',
  });

  assert.equal(decision.shape, 'plan');
  assert.deepEqual(decision.riskSignals, ['explicit_plan_request']);
});

test('structured quick-task requests still escalate when the wording is destructive', () => {
  const decision = classifyIntakeInput({
    instruction: 'delete old sessions permanently',
    requestedShape: 'quick_task',
  });

  assert.equal(decision.shape, 'coordinated_run');
  assert.equal(decision.confidence, 'medium');
  assert.deepEqual(decision.riskSignals, ['destructive_change', 'explicit_quick_task']);
});

test('ordinary remove wording does not trigger destructive escalation', () => {
  const decision = classifyIntake('Remove the stale CSS class from the reconnect banner');
  assert.equal(decision.shape, 'quick_task');
  assert.deepEqual(decision.riskSignals, []);
});
