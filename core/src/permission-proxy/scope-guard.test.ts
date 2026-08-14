import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesPathScope, matchesCommandScope, parseScopeList } from './scope-guard.js';

test('matchesPathScope honours ** across directories and * within a segment', () => {
  assert.equal(matchesPathScope('migrations/0001_init.sql', ['migrations/**']), true);
  assert.equal(matchesPathScope('migrations/2026/08/x.sql', ['migrations/**']), true);
  assert.equal(matchesPathScope('src/index.ts', ['migrations/**']), false);
  assert.equal(matchesPathScope('docs/guide.md', ['docs/**', 'README.md']), true);
  assert.equal(matchesPathScope('README.md', ['docs/**', 'README.md']), true);
  assert.equal(matchesPathScope('READMEXmd', ['README.md']), false); // '.' is literal
  assert.equal(matchesPathScope('docs/a/b.md', ['docs/*']), false); // single star stays shallow
  assert.equal(matchesPathScope('docs/b.md', ['docs/*']), true);
});

test('matchesPathScope normalizes leading ./ and backslashes', () => {
  assert.equal(matchesPathScope('./docs/x.md', ['docs/**']), true);
  assert.equal(matchesPathScope('docs\\x.md', ['docs/**']), true);
});

test('matchesCommandScope uses Bash(pattern) prefix semantics', () => {
  assert.equal(matchesCommandScope('npx axe-cli http://localhost', ['npx axe-cli *']), true);
  assert.equal(matchesCommandScope('npx axe-cli', ['npx axe-cli *']), true);
  assert.equal(matchesCommandScope('npx axe-cli-evil x', ['npx axe-cli *']), false);
  assert.equal(matchesCommandScope('rm -rf /', ['npx axe-cli *']), false);
  assert.equal(matchesCommandScope('npm run bench', ['npm run *']), true);
  assert.equal(matchesCommandScope('npm test', ['npm test']), true); // exact
  assert.equal(matchesCommandScope('npm test -- --grep x', ['npm test']), false);
  assert.equal(matchesCommandScope('anything at all', ['*']), true);
});

test('parseScopeList splits and trims comma lists', () => {
  assert.deepEqual(parseScopeList('docs/**, README.md ,'), ['docs/**', 'README.md']);
  assert.deepEqual(parseScopeList(undefined), []);
});
