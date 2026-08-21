import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRoot, getState, initWorkspace, migrateState, recordTaskOutcome, setRoot } from './repo.js';
import type { SwarmState, TaskOutcomeTelemetry } from './types.js';

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

test('persists bounded metadata-only task outcomes', () => {
  const originalRoot = getRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-outcome-state-'));
  try {
    setRoot(dir);
    initWorkspace('fixture', 'Telemetry fixture');
    const outcome: TaskOutcomeTelemetry = {
      taskId: 't1', agentId: 'coder', route: { provider: 'openai', model: 'gpt-5.3-codex' },
      durationMs: 25, retries: 0, status: 'done', verdict: 'COMPLETE', costQuotaClass: 'subscription-quota',
    };
    recordTaskOutcome(outcome);
    assert.deepEqual(getState().outcomes, [outcome]);
  } finally {
    setRoot(originalRoot);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
