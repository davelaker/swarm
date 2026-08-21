import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dependenciesAreComplete,
  selectRunnableBatch,
  writeScopesMayOverlap,
} from './loop.js';
import type { Task } from './state/types.js';

function task(
  id: string,
  assignee: string,
  writeScope: string[] | undefined,
  dependsOn: string[] = [],
): Task {
  return {
    id,
    title: id,
    status: 'pending',
    owner: 'me',
    assignee,
    depends_on: dependsOn,
    artifacts: [],
    result_ref: null,
    attempts: 0,
    ...(writeScope === undefined
      ? {}
      : {
          route: {
            provider: id === 'openai' ? 'openai' : 'anthropic',
            model: id === 'openai' ? 'gpt-5.3-codex' : 'claude-opus-4-8',
            rationale: 'test',
            fallback: null,
            requiresConfirmation: false,
            writeScope,
          },
        }),
  };
}

test('proves clearly disjoint write scopes do not overlap', () => {
  assert.equal(writeScopesMayOverlap(['core/src/**'], ['ui/src/**']), false);
  assert.equal(writeScopesMayOverlap(['core/src/loop.ts'], ['core/src/loop.ts']), true);
  assert.equal(writeScopesMayOverlap(['core/src/**'], ['core/src/loop.ts']), true);
  assert.equal(writeScopesMayOverlap(['**'], ['ui/src/**']), true);
});

test('schedules disjoint tasks from different providers concurrently', () => {
  const anthropic = task('anthropic', 'coder', ['core/src/**']);
  const openai = task('openai', 'coder', ['ui/src/**']);
  const reviewer = task('reviewer', 'reviewer', []);

  assert.deepEqual(
    selectRunnableBatch([anthropic, openai, reviewer]).map(candidate => candidate.id),
    ['anthropic', 'openai', 'reviewer'],
  );
});

test('serializes overlapping and unknown writer scopes while retaining read-only work', () => {
  const first = task('first', 'coder', ['core/src/**']);
  const overlap = task('overlap', 'coder', ['core/src/loop.ts']);
  const legacyUnknown = task('legacy', 'coder', undefined);
  const emptyUnknown = task('empty', 'coder', []);
  const reviewer = task('reviewer', 'reviewer', []);

  assert.deepEqual(
    selectRunnableBatch([first, overlap, legacyUnknown, reviewer]).map(candidate => candidate.id),
    ['first', 'reviewer'],
  );
  assert.deepEqual(
    selectRunnableBatch([legacyUnknown, first, reviewer]).map(candidate => candidate.id),
    ['legacy', 'reviewer'],
  );
  assert.deepEqual(
    selectRunnableBatch([emptyUnknown, first, reviewer]).map(candidate => candidate.id),
    ['empty', 'reviewer'],
  );
});

test('a review or gate waits for every declared producer', () => {
  const review = task('review', 'reviewer', [], ['coder-a', 'coder-b']);

  assert.equal(dependenciesAreComplete(review, new Set(['coder-a'])), false);
  assert.equal(dependenciesAreComplete(review, new Set(['coder-a', 'coder-b'])), true);
});
