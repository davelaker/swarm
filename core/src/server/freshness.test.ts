import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newestMtimeMs } from './freshness.js';

function tmpTree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-'));
}

test('newestMtimeMs returns the newest matching file mtime, recursively', () => {
  const root = tmpTree();
  const nested = path.join(root, 'sub');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(root, 'a.ts'), 'a');
  fs.writeFileSync(path.join(nested, 'b.ts'), 'b');
  // Make the nested file the newest, by an explicit future mtime.
  const newer = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(nested, 'b.ts'), newer, newer);

  const got = newestMtimeMs(root, ['.ts']);
  assert.equal(Math.round(got), Math.round(newer.getTime()));
});

test('newestMtimeMs ignores non-matching extensions and skipped dirs', () => {
  const root = tmpTree();
  const skipped = path.join(root, 'node_modules');
  fs.mkdirSync(skipped);
  // A .md file (wrong ext) and a .ts inside node_modules (skipped dir) — both ignored.
  const future = new Date(Date.now() + 120_000);
  fs.writeFileSync(path.join(root, 'readme.md'), 'x');
  fs.utimesSync(path.join(root, 'readme.md'), future, future);
  fs.writeFileSync(path.join(skipped, 'dep.ts'), 'x');
  fs.utimesSync(path.join(skipped, 'dep.ts'), future, future);
  // The only file that should count:
  fs.writeFileSync(path.join(root, 'real.ts'), 'x');

  const got = newestMtimeMs(root, ['.ts']);
  const realMtime = fs.statSync(path.join(root, 'real.ts')).mtimeMs;
  assert.equal(Math.round(got), Math.round(realMtime));
});

test('newestMtimeMs returns 0 for an unreadable/empty tree', () => {
  assert.equal(newestMtimeMs(path.join(os.tmpdir(), 'does-not-exist-xyz'), ['.ts']), 0);
  assert.equal(newestMtimeMs(tmpTree(), ['.ts']), 0);
});
