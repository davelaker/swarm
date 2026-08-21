import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyCodexPatchProposal, parseCodexPatchProposal } from './codex-patch.js';

function fixture(): { root: string; base: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-codex-patch-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Swarm Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'allowed.ts'), 'export const value = 1;\n');
  execFileSync('git', ['add', 'allowed.ts'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  return {
    root,
    base: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function patch(before: string, after: string): string {
  return [
    'diff --git a/allowed.ts b/allowed.ts',
    'index 1111111..2222222 100644',
    '--- a/allowed.ts',
    '+++ b/allowed.ts',
    '@@ -1 +1 @@',
    `-${before}`,
    `+${after}`,
    '',
  ].join('\n');
}

test('applies a valid in-scope patch exactly once after broker approval', async () => {
  const f = fixture();
  try {
    let approvals = 0;
    const proposal = { base_revision: f.base, changed_paths: ['allowed.ts'], patch: patch('export const value = 1;', 'export const value = 2;') };
    const result = await applyCodexPatchProposal({
      agentId: 'coder',
      worktreePath: f.root,
      writeScope: ['allowed.ts'],
      proposal,
      requestApproval: async () => {
        approvals++;
        return 'allow';
      },
    });
    assert.deepEqual(result.changedPaths, ['allowed.ts']);
    assert.equal(approvals, 1);
    assert.equal(fs.readFileSync(path.join(f.root, 'allowed.ts'), 'utf8'), 'export const value = 2;\n');
    await assert.rejects(
      applyCodexPatchProposal({ agentId: 'coder', worktreePath: f.root, writeScope: ['allowed.ts'], proposal, requestApproval: async () => 'allow' }),
      /patch does not apply|corrupt patch|failed/i,
    );
  } finally {
    f.cleanup();
  }
});

test('rejects malformed, stale, binary, unsafe, and out-of-scope proposals before approval', async () => {
  const f = fixture();
  try {
    const validPatch = patch('export const value = 1;', 'export const value = 2;');
    const base = { base_revision: f.base, changed_paths: ['allowed.ts'], patch: validPatch };
    await assert.rejects(
      applyCodexPatchProposal({ agentId: 'coder', worktreePath: f.root, writeScope: ['allowed.ts'], proposal: { ...base, base_revision: '0'.repeat(40) }, requestApproval: async () => 'allow' }),
      /stale/,
    );
    await assert.rejects(
      applyCodexPatchProposal({ agentId: 'coder', worktreePath: f.root, writeScope: ['allowed.ts'], proposal: { ...base, patch: 'diff --git a/a b/a\nGIT binary patch\n' }, requestApproval: async () => 'allow' }),
      /binary/,
    );
    await assert.rejects(
      applyCodexPatchProposal({ agentId: 'coder', worktreePath: f.root, writeScope: ['**'], proposal: { ...base, changed_paths: ['../.env'] }, requestApproval: async () => 'allow' }),
      /unsafe changed path/,
    );
    await assert.rejects(
      applyCodexPatchProposal({ agentId: 'coder', worktreePath: f.root, writeScope: ['docs/**'], proposal: base, requestApproval: async () => 'allow' }),
      /outside the task write scope/,
    );
    await assert.rejects(
      applyCodexPatchProposal({ agentId: 'coder', worktreePath: f.root, writeScope: ['allowed.ts'], proposal: { ...base, changed_paths: ['other.ts'] }, requestApproval: async () => 'allow' }),
      /exactly match/,
    );
  } finally {
    f.cleanup();
  }
});

test('rejects malformed schema shapes and unsafe paths', () => {
  assert.throws(() => parseCodexPatchProposal({}), /must contain only/);
  assert.throws(
    () => parseCodexPatchProposal({ base_revision: 'a'.repeat(40), changed_paths: ['.git/config'], patch: 'x' }),
    /unsafe changed path/,
  );
  assert.throws(
    () => parseCodexPatchProposal({ base_revision: 'A'.repeat(40), changed_paths: ['allowed.ts'], patch: 'x' }),
    /lowercase/,
  );
});
