import assert from 'node:assert/strict';
import test from 'node:test';
import {
  currentPendingPermission,
  requestPermission,
  resolvePermission,
} from './permission-broker.js';

test('pending permission snapshot can recover an approval after reconnect', async () => {
  const decision = requestPermission('t_quick', 'apply_patch', {
    base_revision: 'a'.repeat(40),
    changed_paths: ['README.md'],
  });
  const snapshot = currentPendingPermission();

  assert.ok(snapshot);
  assert.equal(snapshot.agent_id, 't_quick');
  assert.equal(snapshot.tool, 'apply_patch');
  assert.deepEqual(snapshot.input.changed_paths, ['README.md']);
  assert.equal(resolvePermission(snapshot.request_id, 'allow'), true);
  assert.equal(await decision, 'allow');
  assert.equal(currentPendingPermission(), null);
});
