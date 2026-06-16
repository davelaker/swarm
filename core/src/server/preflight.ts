// Pre-flight readiness — the checks that decide whether a run is safe to start, and
// which surface the two silent footguns that have bitten real runs: an uncommitted
// working tree (the Coder would clobber it) and a backend pointed at the WRONG repo
// (a run would commit to the wrong project). The git-clean guard is also enforced
// hard at Execute time; this endpoint lets the dashboard show every check up front.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { detectDevServer } from '../agents/visual.js';

// Pure: from `git status --porcelain` output, the tracked files with uncommitted
// changes. Untracked (??) files are ignored — they can't be clobbered by a checkout
// and are usually scratch. Exported for reuse by the hard Execute guard so the two
// never disagree about what "dirty" means.
export function parseDirtyStatus(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.trim())
    .filter(l => !l.startsWith('??'));
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

export function isGitRepo(cwd: string): boolean {
  return git(cwd, ['rev-parse', '--git-dir']) !== null;
}

export function gitDirtyFiles(cwd: string): string[] {
  // Refresh the index first so a file whose mtime changed but content did NOT (a running
  // dev server or TS watcher touching source) isn't reported as a phantom "modified".
  // `git status --porcelain` reports such stat-dirty entries as M even though `git diff`
  // is empty, which would block Execute with nothing to actually commit or stash.
  // update-index exits non-zero when real changes exist — ignored; it still refreshes
  // the stat info for unchanged files, which is all we need.
  git(cwd, ['update-index', '-q', '--refresh']);
  const status = git(cwd, ['status', '--porcelain']);
  if (status === null) {
    return [];
  }
  return parseDirtyStatus(status);
}

export function gitUserConfigured(cwd: string): boolean {
  return (
    !!git(cwd, ['config', 'user.name'])?.trim() && !!git(cwd, ['config', 'user.email'])?.trim()
  );
}

export function currentBranch(cwd: string): string | null {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() || null;
}

export function branchExists(cwd: string, name: string): boolean {
  // `show-ref --verify --quiet` exits 0 (→ non-null stdout, empty) when the ref exists,
  // non-zero (→ null) when it doesn't.
  return git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]) !== null;
}

// Resolve a collision-free `swarm/<slug>` branch name. `git checkout -b` hard-fails if the
// branch already exists, and a PM-chosen slug carries no timestamp, so it can clash with a
// prior run's branch (a goal-derived slug can't — it appends a timestamp). Append -2, -3, …
// until the name is free so Execute never blocks on a name clash.
export function uniqueSwarmBranch(cwd: string, slug: string): string {
  const base = `swarm/${slug}`;
  let candidate = base;
  let n = 2;
  while (branchExists(cwd, candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface PreflightReport {
  root: string;
  project: string;
  checks: PreflightCheck[];
  canRun: boolean; // false if any check is a hard 'fail'
}

// Gather every readiness check for a target repo. A 'fail' blocks a run (only an
// uncommitted tree does that today); 'warn' is advisory (missing git identity, no
// dev server for visual checks); 'ok' is green.
export function runPreflight(root: string): PreflightReport {
  const checks: PreflightCheck[] = [];
  const isRepo = isGitRepo(root);

  checks.push({
    id: 'git_repo',
    label: 'Git repository',
    status: isRepo ? 'ok' : 'warn',
    detail: isRepo ? path.basename(root) : 'not a git repo — runs work but nothing is versioned',
  });

  if (isRepo) {
    const dirty = gitDirtyFiles(root);
    checks.push({
      id: 'repo_clean',
      label: 'Working tree clean',
      status: dirty.length ? 'fail' : 'ok',
      detail: dirty.length
        ? `${dirty.length} uncommitted change${dirty.length > 1 ? 's' : ''} — commit or stash first`
        : 'no uncommitted changes',
    });

    checks.push({
      id: 'git_user',
      label: 'Git identity set',
      status: gitUserConfigured(root) ? 'ok' : 'warn',
      detail: gitUserConfigured(root)
        ? 'user.name and user.email configured'
        : 'set user.name / user.email so commits are attributed',
    });

    const branch = currentBranch(root);
    checks.push({
      id: 'branch',
      label: 'Branch',
      status: 'ok',
      detail: branch ?? 'unknown',
    });
  }

  const dev = detectDevServer(root);
  checks.push({
    id: 'dev_server',
    label: 'Dev server',
    status: dev ? 'ok' : 'warn',
    detail: dev ? `${dev.cmd} on :${dev.port}` : 'no `dev` script — visual verification will skip',
  });

  return {
    root,
    project: path.basename(root),
    checks,
    canRun: !checks.some(c => c.status === 'fail'),
  };
}
