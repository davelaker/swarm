// Per-task rewind — git-native rollback of a single completed task's changes.
//
// Normal coder tasks land on the working branch as a --no-ff merge commit with the
// message "merge: <taskId> into working branch" (loop.ts mergeWorktree), so a task's
// entire contribution is one commit that `git revert -m 1` undoes cleanly, as a new
// commit — history is preserved, nothing is rewritten, and the revert itself can be
// reverted. This is deliberately NOT a reset: rewind must stay safe to expose in the
// UI as session-level undo.
//
// In-place fix coders (t_fix_*) do not merge — their commits sit directly on the
// working branch — so v1 refuses them with a clear message rather than guessing at
// which commits were theirs.

import { execFileSync } from 'node:child_process';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// The merge commit that landed this task, or null when none exists (task never
// merged, was an in-place fix task, or the history was rewritten).
export function findTaskMergeCommit(cwd: string, taskId: string): string | null {
  try {
    const out = git(cwd, [
      'log',
      '--merges',
      // Anchored, fixed-string-ish grep: the exact message mergeWorktree writes.
      `--grep=^merge: ${taskId} into working branch$`,
      '-n',
      '1',
      '--format=%H',
    ]).trim();
    return out || null;
  } catch {
    return null;
  }
}

export type RewindResult =
  | { ok: true; revertCommit: string; reverted: string }
  | { ok: false; error: string };

// Revert the task's merge commit. Requires a clean tree (a dirty tree would tangle
// the revert with unrelated edits). Aborts and restores on conflict so the tree is
// never left mid-revert.
export function rewindTask(cwd: string, taskId: string): RewindResult {
  try {
    if (git(cwd, ['status', '--porcelain']).trim()) {
      return { ok: false, error: 'Working tree has uncommitted changes — commit or stash first' };
    }
  } catch (err) {
    return { ok: false, error: `not a git repo: ${(err as Error).message.slice(0, 120)}` };
  }

  const mergeCommit = findTaskMergeCommit(cwd, taskId);
  if (!mergeCommit) {
    return {
      ok: false,
      error: `No merge commit found for ${taskId} — only merged coder tasks can be rewound (fix tasks commit in place)`,
    };
  }

  try {
    git(cwd, ['revert', '-m', '1', '--no-edit', mergeCommit]);
  } catch (err) {
    try {
      git(cwd, ['revert', '--abort']);
    } catch {
      /* nothing to abort */
    }
    return {
      ok: false,
      error: `Revert conflicted (later changes touch the same lines) — resolve manually: ${(err as Error).message.slice(0, 160)}`,
    };
  }

  const revertCommit = git(cwd, ['rev-parse', 'HEAD']).trim();
  return { ok: true, revertCommit, reverted: mergeCommit };
}
