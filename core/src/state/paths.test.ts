import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRepoRelativePath, sanitizeArtifactPaths } from './paths.js';

test('isRepoRelativePath accepts ordinary repo paths', () => {
  assert.equal(isRepoRelativePath('src/index.ts'), true);
  assert.equal(isRepoRelativePath('migrations/0007_add_users.sql'), true);
  assert.equal(isRepoRelativePath('README.md'), true);
  assert.equal(isRepoRelativePath('docs/guides/with space.md'), true);
});

test('isRepoRelativePath rejects absolute, traversal, and metadata paths', () => {
  assert.equal(isRepoRelativePath('/etc/passwd'), false);
  assert.equal(isRepoRelativePath('C:\\windows\\system32'), false);
  assert.equal(isRepoRelativePath('../outside.ts'), false);
  assert.equal(isRepoRelativePath('src/../../outside.ts'), false);
  assert.equal(isRepoRelativePath('.swarm/state.json'), false);
  assert.equal(isRepoRelativePath(''), false);
  assert.equal(isRepoRelativePath('src//index.ts'), false);
  assert.equal(isRepoRelativePath('bad\u0000name'), false);
});

test('sanitizeArtifactPaths validates, normalizes, and dedupes', () => {
  assert.deepEqual(
    sanitizeArtifactPaths(['./src/a.ts', 'src/a.ts', '../evil', 42, '/abs', 'docs/x.md']),
    ['src/a.ts', 'docs/x.md'],
  );
  assert.deepEqual(sanitizeArtifactPaths('not an array'), []);
  assert.deepEqual(sanitizeArtifactPaths(undefined), []);
});
