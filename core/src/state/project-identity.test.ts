import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canonicalProjectRoot,
  projectEnvelopeForRoot,
  projectIdForRoot,
  validateExpectedProjectId,
} from './project-identity.js';

test('equivalent path spellings produce the same canonical root and project id', () => {
  const spelledRoot = path.join(os.tmpdir(), 'swarm-project-id', 'nested', '..', 'app');
  const canonicalRoot = path.resolve(os.tmpdir(), 'swarm-project-id', 'app');

  assert.equal(canonicalProjectRoot(spelledRoot), canonicalRoot);
  assert.equal(projectEnvelopeForRoot(spelledRoot).projectId, projectIdForRoot(canonicalRoot));
});

test('same basename under different roots gets distinct project ids', () => {
  const first = projectEnvelopeForRoot(path.join(os.tmpdir(), 'swarm-a', 'app'));
  const second = projectEnvelopeForRoot(path.join(os.tmpdir(), 'swarm-b', 'app'));

  assert.equal(first.projectName, 'app');
  assert.equal(second.projectName, 'app');
  assert.notEqual(first.projectRoot, second.projectRoot);
  assert.notEqual(first.projectId, second.projectId);
});

test('expected project validation returns a structured mismatch', () => {
  const activeProject = projectEnvelopeForRoot(path.join(os.tmpdir(), 'swarm-active'));
  const expectedProjectId = projectEnvelopeForRoot(path.join(os.tmpdir(), 'swarm-stale')).projectId;

  assert.deepEqual(validateExpectedProjectId(undefined, activeProject), null);
  assert.deepEqual(validateExpectedProjectId(activeProject.projectId, activeProject), null);
  assert.deepEqual(validateExpectedProjectId(expectedProjectId, activeProject), {
    error: 'project_mismatch',
    expectedProjectId,
    activeProject,
  });
});
