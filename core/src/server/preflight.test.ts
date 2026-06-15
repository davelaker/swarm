import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDirtyStatus } from './preflight.js';

test('parseDirtyStatus keeps tracked changes and drops untracked', () => {
  const porcelain = [
    ' M src/app.ts',
    'A  src/new.ts',
    '?? scratch.log',
    'D  removed.ts',
    '?? node_modules/',
    '',
  ].join('\n');
  assert.deepEqual(parseDirtyStatus(porcelain), [
    ' M src/app.ts',
    'A  src/new.ts',
    'D  removed.ts',
  ]);
});

test('parseDirtyStatus returns empty for a clean tree', () => {
  assert.deepEqual(parseDirtyStatus(''), []);
  assert.deepEqual(parseDirtyStatus('?? only-untracked.txt\n'), []);
});
