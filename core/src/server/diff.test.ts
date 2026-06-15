import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, detectLanguage } from './diff.js';

test('parseUnifiedDiff parses a modified file with one hunk', () => {
  const raw = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 111..222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,4 @@ function main()',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' return a;',
    '',
  ].join('\n');
  const files = parseUnifiedDiff(raw);
  assert.equal(files.length, 1);
  const f = files[0];
  assert.equal(f.path, 'src/app.ts');
  assert.equal(f.status, 'modified');
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 1);
  assert.equal(f.hunks.length, 1);
  const h = f.hunks[0];
  assert.equal(h.header, 'function main()');
  // line-number tracking: context keeps both, add only new, del only old
  assert.deepEqual(
    h.lines.map(l => [l.type, l.oldNo, l.newNo]),
    [
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
    ],
  );
});

test('parseUnifiedDiff marks added and deleted files', () => {
  const added = [
    'diff --git a/new.ts b/new.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1,2 @@',
    '+line one',
    '+line two',
    '',
  ].join('\n');
  const [f] = parseUnifiedDiff(added);
  assert.equal(f.status, 'added');
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 0);

  const deleted = [
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-bye',
    '',
  ].join('\n');
  const [d] = parseUnifiedDiff(deleted);
  assert.equal(d.status, 'deleted');
  assert.equal(d.deletions, 1);
});

test('parseUnifiedDiff handles renames and multiple files', () => {
  const raw = [
    'diff --git a/old/name.ts b/new/name.ts',
    'similarity index 90%',
    'rename from old/name.ts',
    'rename to new/name.ts',
    '--- a/old/name.ts',
    '+++ b/new/name.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/other.css b/other.css',
    '--- a/other.css',
    '+++ b/other.css',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    '',
  ].join('\n');
  const files = parseUnifiedDiff(raw);
  assert.equal(files.length, 2);
  assert.equal(files[0].status, 'renamed');
  assert.equal(files[0].oldPath, 'old/name.ts');
  assert.equal(files[0].path, 'new/name.ts');
  assert.equal(files[1].path, 'other.css');
});

test('parseUnifiedDiff flags binary files and ignores the no-newline marker', () => {
  const raw = [
    'diff --git a/logo.png b/logo.png',
    'Binary files a/logo.png and b/logo.png differ',
    '',
  ].join('\n');
  const [f] = parseUnifiedDiff(raw);
  assert.equal(f.binary, true);
  assert.equal(f.hunks.length, 0);
});

test('detectLanguage maps known extensions and falls back to text', () => {
  assert.equal(detectLanguage('src/app.tsx'), 'tsx');
  assert.equal(detectLanguage('a/b/styles.css'), 'css');
  assert.equal(detectLanguage('Dockerfile'), 'docker');
  assert.equal(detectLanguage('notes.unknownext'), 'text');
  assert.equal(detectLanguage('LICENSE'), 'text');
});
