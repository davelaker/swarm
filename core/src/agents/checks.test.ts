import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSecrets } from './checks.js';

test('scanSecrets flags high-confidence vendor secrets with file + line', () => {
  const files = [
    {
      path: 'src/config.ts',
      content: ['const ok = true;', 'const key = "AKIAIOSFODNN7EXAMPLE";', 'const n = 1;'].join(
        '\n',
      ),
    },
  ];
  const hits = scanSecrets(files);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], { file: 'src/config.ts', line: 2, kind: 'AWS access key id' });
});

test('scanSecrets ignores environment reads (referencing, not embedding, a secret)', () => {
  const files = [
    { path: 'a.ts', content: 'const token = process.env.GITHUB_TOKEN; // gho_notARealOne' },
  ];
  assert.deepEqual(scanSecrets(files), []);
});

test('scanSecrets detects private keys and returns empty for clean files', () => {
  assert.equal(
    scanSecrets([{ path: 'id_rsa', content: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc' }]).length,
    1,
  );
  assert.deepEqual(scanSecrets([{ path: 'clean.ts', content: 'export const x = 1;\n' }]), []);
});
