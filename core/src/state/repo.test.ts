import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateState } from './repo.js';
import type { SwarmState } from './types.js';

test('migrates persisted legacy model selections to a safe immutable route', () => {
  const state: SwarmState = {
    project: 'fixture', owner: 'me', goal: 'Test migration', tier: 'feature', updated_at: '2026-01-01T00:00:00.000Z', log: [],
    tasks: [{
      id: 't1', title: 'Legacy task', status: 'pending', owner: 'me', assignee: 'reviewer', depends_on: [], artifacts: [],
      result_ref: null, attempts: 0, model: 'claude-opus-4-8', effort: 'high',
    }],
  };
  const migrated = migrateState(state);
  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.state.tasks[0].route, {
    provider: 'anthropic', model: 'claude-opus-4-8', reasoningEffort: 'high',
    rationale: 'Migrated from the legacy per-task model selection.', fallback: null,
    requiresConfirmation: false, writeScope: [],
  });
  assert.equal(migrateState(migrated.state).changed, false);
});

test('leaves unknown legacy models untouched for existing driver compatibility', () => {
  const state = {
    project: 'fixture', owner: 'me', goal: 'Test migration', tier: 'feature' as const, updated_at: '', log: [],
    tasks: [{ id: 't1', title: 'Legacy', status: 'pending' as const, owner: 'me', assignee: 'coder', depends_on: [], artifacts: [], result_ref: null, attempts: 0, model: 'custom-model' }],
  } satisfies SwarmState;
  assert.equal(migrateState(state).changed, false);
});

test('leaves legacy coder selections untouched until a declared write scope exists', () => {
  const state = {
    project: 'fixture', owner: 'me', goal: 'Test migration', tier: 'feature' as const, updated_at: '', log: [],
    tasks: [{ id: 't1', title: 'Legacy', status: 'pending' as const, owner: 'me', assignee: 'coder', depends_on: [], artifacts: [], result_ref: null, attempts: 0, model: 'claude-opus-4-8' }],
  } satisfies SwarmState;
  assert.equal(migrateState(state).changed, false);
});
