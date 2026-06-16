// Structured diff for the review surface. The UI highlights whole files with Shiki
// (multi-line constructs need full-file context, not isolated hunk lines), so this
// returns each changed file's parsed hunks PLUS its old/new content. The unified-diff
// parser is pure and unit-tested; content fetching + range resolution touch git.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { swarmDir } from '../state/repo.js';

const execFileAsync = promisify(execFile);

export type ChangeType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: ChangeType;
  content: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string; // the text after the @@ … @@ marker (often a function/context hint)
  lines: DiffLine[];
}

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffFile {
  path: string;
  oldPath: string | null; // set when renamed
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
}

// Pure: parse `git diff` unified output into structured files. Handles add / delete /
// rename / binary, multiple hunks, and the "\ No newline at end of file" marker.
export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split('\n');
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const pushFile = () => {
    if (file) {
      if (hunk) {
        file.hunks.push(hunk);
        hunk = null;
      }
      files.push(file);
    }
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      pushFile();
      // diff --git a/<old> b/<new>
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      const p = m ? m[2] : line.slice('diff --git '.length);
      file = {
        path: p,
        oldPath: m && m[1] !== m[2] ? m[1] : null,
        status: 'modified',
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      };
      continue;
    }
    if (!file) {
      continue;
    }
    if (line.startsWith('new file mode')) {
      file.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      file.oldPath = line.slice('rename from '.length);
      file.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      file.path = line.slice('rename to '.length);
      file.status = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      continue;
    }
    if (line.startsWith('+++ ')) {
      continue;
    }
    const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hm) {
      if (hunk) {
        file.hunks.push(hunk);
      }
      oldNo = Number(hm[1]);
      newNo = Number(hm[3]);
      hunk = {
        oldStart: oldNo,
        oldLines: hm[2] ? Number(hm[2]) : 1,
        newStart: newNo,
        newLines: hm[4] ? Number(hm[4]) : 1,
        header: hm[5].trim(),
        lines: [],
      };
      continue;
    }
    if (!hunk) {
      continue;
    }
    if (line.length === 0) {
      continue; // trailing-newline artifact — real hunk lines always carry a prefix char
    }
    if (line.startsWith('\\')) {
      continue; // "\ No newline at end of file"
    }
    const marker = line[0];
    const content = line.slice(1);
    if (marker === '+') {
      hunk.lines.push({ type: 'add', content, oldNo: null, newNo });
      file.additions++;
      newNo++;
    } else if (marker === '-') {
      hunk.lines.push({ type: 'del', content, oldNo, newNo: null });
      file.deletions++;
      oldNo++;
    } else {
      // context (leading space) or an empty diff line
      hunk.lines.push({ type: 'context', content, oldNo, newNo });
      oldNo++;
      newNo++;
    }
  }
  pushFile();
  return files;
}

// Pure: map a path to a Shiki language id. Unknown extensions fall back to 'text'.
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  md: 'markdown',
  mdx: 'mdx',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  php: 'php',
  rb: 'ruby',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  graphql: 'graphql',
  prisma: 'prisma',
  dockerfile: 'docker',
};

export function detectLanguage(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  if (base.toLowerCase() === 'dockerfile') {
    return 'docker';
  }
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return EXT_LANG[ext] ?? 'text';
}

export interface StructuredDiffFile extends DiffFile {
  language: string;
  oldContent: string | null;
  newContent: string | null;
  contentSkipped: boolean; // too large / binary — UI renders hunks without full highlight
}

export interface StructuredDiff {
  source: string; // human label for which range was diffed
  files: StructuredDiffFile[];
}

const MAX_CONTENT_BYTES = 400_000; // skip full-file highlighting beyond this

interface DiffRange {
  rawDiff: string;
  baseRef: string | null; // git ref for old content; null when there is none
  headRef: string | null; // git ref for new content; null = read working tree
  source: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function gitSafe(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch (err) {
    // git diff --no-index exits non-zero when files differ but still emits stdout.
    return (err as { stdout?: Buffer }).stdout?.toString() ?? '';
  }
}

// Resolve which diff to show, mirroring the legacy /run/diff endpoint: working-tree
// changes first, then commits ahead of main/master, then the last commit.
async function resolveRange(cwd: string): Promise<DiffRange> {
  const tracked = await gitSafe(cwd, ['diff', 'HEAD']);
  const status = await gitSafe(cwd, ['status', '--porcelain']);
  const untracked = status
    .split('\n')
    .filter(l => l.startsWith('??'))
    .map(l => l.slice(3).trim())
    .filter(f => f && !f.endsWith('/'));
  const newFileDiffs = await Promise.all(
    untracked.map(f => gitSafe(cwd, ['diff', '--no-index', '--', '/dev/null', f])),
  );
  const worktree = [tracked, ...newFileDiffs].filter(s => s.trim()).join('\n');
  if (worktree.trim()) {
    return { rawDiff: worktree, baseRef: 'HEAD', headRef: null, source: 'working tree vs HEAD' };
  }

  for (const base of ['main', 'master']) {
    try {
      const mergeBase = (await git(cwd, ['merge-base', base, 'HEAD'])).trim();
      if (mergeBase) {
        const rawDiff = await git(cwd, ['diff', `${mergeBase}`, 'HEAD']);
        if (rawDiff.trim()) {
          return { rawDiff, baseRef: mergeBase, headRef: 'HEAD', source: `${base}...HEAD` };
        }
      }
    } catch {
      /* base branch doesn't exist — try next */
    }
  }

  try {
    const rawDiff = await git(cwd, ['diff', 'HEAD~1']);
    if (rawDiff.trim()) {
      return { rawDiff, baseRef: 'HEAD~1', headRef: 'HEAD', source: 'last commit' };
    }
  } catch {
    /* no prior commit */
  }

  return { rawDiff: '', baseRef: null, headRef: null, source: 'no changes' };
}

async function showBlob(cwd: string, ref: string, filePath: string): Promise<string | null> {
  try {
    const out = await git(cwd, ['show', `${ref}:${filePath}`]);
    return out.length > MAX_CONTENT_BYTES ? null : out;
  } catch {
    return null;
  }
}

function readWorktree(cwd: string, filePath: string): string | null {
  try {
    const abs = path.join(cwd, filePath);
    const stat = fs.statSync(abs);
    if (stat.size > MAX_CONTENT_BYTES) {
      return null;
    }
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

// Per-task diff for a single task's card. While the coder runs, `live` points at its
// worktree + branch base so the diff accumulates; once it lands we fall back to the
// captured .swarm/diffs/<id>.diff snapshot. Rendered without full-file highlighting
// (hunks only) — a compact, per-card view, not the main syntax-highlighted surface.
export async function buildTaskDiff(
  taskId: string,
  live: { path: string; base: string } | null,
): Promise<StructuredDiff> {
  let raw = '';
  if (live) {
    const tracked = await gitSafe(live.path, ['diff', live.base]);
    const status = await gitSafe(live.path, ['status', '--porcelain']);
    const untracked = status
      .split('\n')
      .filter(l => l.startsWith('??'))
      .map(l => l.slice(3).trim())
      .filter(f => f && !f.endsWith('/'));
    const newDiffs = await Promise.all(
      untracked.map(f => gitSafe(live.path, ['diff', '--no-index', '--', '/dev/null', f])),
    );
    raw = [tracked, ...newDiffs].filter(s => s.trim()).join('\n');
  } else {
    try {
      raw = fs.readFileSync(path.join(swarmDir(), 'diffs', `${taskId}.diff`), 'utf8');
    } catch {
      raw = '';
    }
  }
  const files: StructuredDiffFile[] = parseUnifiedDiff(raw).map(f => ({
    ...f,
    language: detectLanguage(f.path),
    oldContent: null,
    newContent: null,
    contentSkipped: true,
  }));
  return { source: live ? `task ${taskId} · live` : `task ${taskId}`, files };
}

// Build the structured diff for the repo at cwd: parse hunks, attach language and
// old/new full content (size-guarded) so the UI can highlight whole files.
export async function buildStructuredDiff(cwd: string): Promise<StructuredDiff> {
  const range = await resolveRange(cwd);
  const files = parseUnifiedDiff(range.rawDiff);

  const enriched: StructuredDiffFile[] = await Promise.all(
    files.map(async f => {
      const language = detectLanguage(f.path);
      let oldContent: string | null = null;
      let newContent: string | null = null;
      if (!f.binary) {
        if (f.status !== 'added' && range.baseRef) {
          oldContent = await showBlob(cwd, range.baseRef, f.oldPath ?? f.path);
        }
        if (f.status !== 'deleted') {
          newContent =
            range.headRef === null
              ? readWorktree(cwd, f.path)
              : await showBlob(cwd, range.headRef, f.path);
        }
      }
      const contentSkipped =
        !f.binary &&
        ((f.status !== 'added' && oldContent === null) ||
          (f.status !== 'deleted' && newContent === null));
      return { ...f, language, oldContent, newContent, contentSkipped };
    }),
  );

  return { source: range.source, files: enriched };
}
