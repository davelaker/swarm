import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLivingDocPath, parsePorcelain, newlyChanged, partitionDocPaths } from './living-docs.js';

test('isLivingDocPath allows human documentation markdown', () => {
  assert.equal(isLivingDocPath('README.md'), true);
  assert.equal(isLivingDocPath('docs/API.md'), true);
  assert.equal(isLivingDocPath('docs/guides/setup.mdx'), true);
  assert.equal(isLivingDocPath('packages/ui/README.md'), true);
  assert.equal(isLivingDocPath('./README.md'), true);
});

test('isLivingDocPath refuses agent-context files — the learnings scribe owns those', () => {
  assert.equal(isLivingDocPath('CLAUDE.md'), false);
  assert.equal(isLivingDocPath('core/CLAUDE.md'), false);
  assert.equal(isLivingDocPath('CONTEXT.md'), false);
  assert.equal(isLivingDocPath('AGENTS.md'), false);
});

test('isLivingDocPath refuses non-markdown and swarm metadata', () => {
  assert.equal(isLivingDocPath('src/index.ts'), false);
  assert.equal(isLivingDocPath('package.json'), false);
  assert.equal(isLivingDocPath('.swarm/state.json'), false);
  assert.equal(isLivingDocPath('.swarm/sessions/x/index.json'), false);
  assert.equal(isLivingDocPath('.swarm/notes.md'), false);
  assert.equal(isLivingDocPath('sub/.swarm/notes.md'), false);
  assert.equal(isLivingDocPath('docs/diagram.png'), false);
});

test('parsePorcelain reads modified, untracked, and renamed entries', () => {
  const out = [' M README.md', '?? docs/new-page.md', 'R  old.md -> docs/moved.md', ''].join('\n');
  const entries = parsePorcelain(out);
  assert.deepEqual(entries, [
    { path: 'README.md', untracked: false },
    { path: 'docs/new-page.md', untracked: true },
    { path: 'docs/moved.md', untracked: false },
  ]);
});

test('parsePorcelain strips git quoting on escaped paths', () => {
  const entries = parsePorcelain('?? "docs/with space.md"');
  assert.deepEqual(entries, [{ path: 'docs/with space.md', untracked: true }]);
});

test('parsePorcelain of empty output is empty', () => {
  assert.deepEqual(parsePorcelain(''), []);
});

test('newlyChanged blames the scribe only for paths that were clean before it ran', () => {
  const before = parsePorcelain(' M lingering.ts');
  const after = parsePorcelain([' M lingering.ts', ' M README.md', '?? evil.ts'].join('\n'));
  assert.deepEqual(newlyChanged(before, after), [
    { path: 'README.md', untracked: false },
    { path: 'evil.ts', untracked: true },
  ]);
});

test('partitionDocPaths splits permitted docs from forbidden changes', () => {
  const entries = parsePorcelain(
    [' M README.md', ' M docs/API.md', ' M src/index.ts', ' M CLAUDE.md'].join('\n'),
  );
  const { docs, forbidden } = partitionDocPaths(entries);
  assert.deepEqual(
    docs.map(e => e.path),
    ['README.md', 'docs/API.md'],
  );
  assert.deepEqual(
    forbidden.map(e => e.path),
    ['src/index.ts', 'CLAUDE.md'],
  );
});
