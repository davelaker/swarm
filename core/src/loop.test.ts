import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkSensitivePaths,
  dependenciesAreComplete,
  extractSensitiveDiffSignals,
  selectRunnableBatch,
  worktreeRunNames,
  writeScopesMayOverlap,
} from './loop.js';
import type { Task } from './state/types.js';

test('repeated task ids receive run-specific worktree branches', () => {
  const first = worktreeRunNames('t_quick', 100);
  const second = worktreeRunNames('t_quick', 101);

  assert.equal(first.branch, 'swarm/t_quick-100');
  assert.equal(second.branch, 'swarm/t_quick-101');
  assert.notEqual(first.path, second.path);
});

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
            model: id === 'openai' ? 'gpt-5.4' : 'claude-opus-4-8',
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

function sensitiveFixture(initialContent: string, filePath: string = 'README.md'): {
  root: string;
  task: Task;
  cleanup: () => void;
  baseRevision: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-sensitive-diff-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Swarm Test'], { cwd: root });
  const absPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, initialContent);
  execFileSync('git', ['add', filePath], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  return {
    root,
    task: task('t_quick', 'coder', [filePath]),
    baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('extractSensitiveDiffSignals keeps only changed paths and added lines', () => {
  const raw = [
    'diff --git a/README.md b/README.md',
    'index 111..222 100644',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1,2 +1,2 @@',
    '-Existing permission docs stay untouched.',
    '+Fresh copy without sensitive keywords.',
    ' unchanged context',
    '',
  ].join('\n');

  assert.deepEqual(extractSensitiveDiffSignals(raw), ['README.md', 'Fresh copy without sensitive keywords.']);
});

test('pre-existing sensitive words outside the patch do not escalate', async () => {
  const fixture = sensitiveFixture('Existing permission docs stay untouched.\nA neutral line.\n');
  try {
    fs.writeFileSync(
      path.join(fixture.root, 'README.md'),
      'Existing permission docs stay untouched.\nA refreshed neutral line.\n',
    );

    const sensitive = await checkSensitivePaths(
      fixture.task,
      ['README.md'],
      { cwd: fixture.root, baseRevision: fixture.baseRevision },
    );
    assert.equal(sensitive, false);
  } finally {
    fixture.cleanup();
  }
});

test('newly added sensitive diff content escalates', async () => {
  const fixture = sensitiveFixture('Welcome.\n');
  try {
    fs.writeFileSync(path.join(fixture.root, 'README.md'), 'Welcome.\nDocument the permission flow.\n');

    const sensitive = await checkSensitivePaths(
      fixture.task,
      ['README.md'],
      { cwd: fixture.root, baseRevision: fixture.baseRevision },
    );
    assert.equal(sensitive, true);
  } finally {
    fixture.cleanup();
  }
});

test('sensitive changed paths still escalate even without keyword additions', async () => {
  const fixture = sensitiveFixture('export const timeout = 1;\n', 'core/src/auth/session.ts');
  try {
    fs.writeFileSync(path.join(fixture.root, 'core/src/auth/session.ts'), 'export const timeout = 2;\n');

    const sensitive = await checkSensitivePaths(
      fixture.task,
      ['core/src/auth/session.ts'],
      { cwd: fixture.root, baseRevision: fixture.baseRevision },
    );
    assert.equal(sensitive, true);
  } finally {
    fixture.cleanup();
  }
});

test('failure to obtain a diff fails closed', async () => {
  const fixture = sensitiveFixture('Welcome.\n');
  try {
    const sensitive = await checkSensitivePaths(
      fixture.task,
      ['README.md'],
      { cwd: path.join(fixture.root, 'missing'), baseRevision: fixture.baseRevision },
    );
    assert.equal(sensitive, true);
  } finally {
    fixture.cleanup();
  }
});
