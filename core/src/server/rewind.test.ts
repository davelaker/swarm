import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTaskMergeCommit, rewindTask } from './rewind.js';

// Replicates the loop's exact landing pattern: coder works on swarm/<taskId>, then
// `merge --no-ff -m "merge: <taskId> into working branch"`.
function repoWithMergedTask(taskId: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-rewind-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(dir, 'app.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  git(['checkout', '-qb', `swarm/${taskId}`]);
  writeFileSync(join(dir, 'feature.txt'), 'added by task\n');
  writeFileSync(join(dir, 'app.txt'), 'base\nchanged by task\n');
  git(['add', '.']);
  git(['commit', '-qm', `${taskId}: implement feature`]);
  git(['checkout', '-q', '-']);
  git(['merge', '--no-ff', '-m', `merge: ${taskId} into working branch`, `swarm/${taskId}`]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('findTaskMergeCommit finds the merge and only for the right task', () => {
  const { dir, cleanup } = repoWithMergedTask('t1');
  try {
    assert.ok(findTaskMergeCommit(dir, 't1'));
    assert.equal(findTaskMergeCommit(dir, 't2'), null);
  } finally {
    cleanup();
  }
});

test('rewindTask reverts the task changes as a new commit', () => {
  const { dir, cleanup } = repoWithMergedTask('t1');
  try {
    assert.ok(existsSync(join(dir, 'feature.txt')));
    const r = rewindTask(dir, 't1');
    assert.equal(r.ok, true);
    // The task's file is gone and its edit undone — but history is preserved.
    assert.equal(existsSync(join(dir, 'feature.txt')), false);
    assert.equal(readFileSync(join(dir, 'app.txt'), 'utf8'), 'base\n');
    const log = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' });
    assert.match(log, /Revert "merge: t1 into working branch"/);
    assert.match(log, /merge: t1 into working branch/);
  } finally {
    cleanup();
  }
});

test('rewindTask refuses a dirty tree and an unknown task', () => {
  const { dir, cleanup } = repoWithMergedTask('t1');
  try {
    writeFileSync(join(dir, 'dirty.txt'), 'x');
    execFileSync('git', ['add', 'dirty.txt'], { cwd: dir });
    const dirty = rewindTask(dir, 't1');
    assert.equal(dirty.ok, false);
    execFileSync('git', ['reset', '-q'], { cwd: dir });
    rmSync(join(dir, 'dirty.txt'));

    const missing = rewindTask(dir, 't_nope');
    assert.equal(missing.ok, false);
    assert.match((missing as { error: string }).error, /No merge commit/);
  } finally {
    cleanup();
  }
});

test('rewindTask aborts cleanly on a revert conflict', () => {
  const { dir, cleanup } = repoWithMergedTask('t1');
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  try {
    // A later commit rewrites the task's line — reverting t1 now conflicts.
    writeFileSync(join(dir, 'app.txt'), 'base\nrewritten later\n');
    git(['add', '.']);
    git(['commit', '-qm', 'later change on same lines']);
    const r = rewindTask(dir, 't1');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /conflict/i);
    // Tree restored — no mid-revert state left behind.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
    assert.equal(status.trim(), '');
  } finally {
    cleanup();
  }
});
