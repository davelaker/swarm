import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDirtyStatus, uniqueSwarmBranch, branchExists } from './preflight.js';

// Build a throwaway git repo with a single commit so branch helpers have a HEAD to point at.
function tmpRepo(): { dir: string; git: (args: string[]) => void; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-preflight-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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

test('uniqueSwarmBranch returns the base name when it is free', () => {
  const { dir, cleanup } = tmpRepo();
  try {
    assert.equal(uniqueSwarmBranch(dir, 'my-feature'), 'swarm/my-feature');
  } finally {
    cleanup();
  }
});

test('uniqueSwarmBranch appends -2, then -3, as names are taken', () => {
  const { dir, git, cleanup } = tmpRepo();
  try {
    git(['branch', 'swarm/dup']);
    assert.equal(branchExists(dir, 'swarm/dup'), true);
    assert.equal(uniqueSwarmBranch(dir, 'dup'), 'swarm/dup-2');
    git(['branch', 'swarm/dup-2']);
    assert.equal(uniqueSwarmBranch(dir, 'dup'), 'swarm/dup-3');
  } finally {
    cleanup();
  }
});

test('branchExists is false for an unknown branch', () => {
  const { dir, cleanup } = tmpRepo();
  try {
    assert.equal(branchExists(dir, 'swarm/nope'), false);
  } finally {
    cleanup();
  }
});
