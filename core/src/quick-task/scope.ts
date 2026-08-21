import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MAX_QUICK_SCOPE_FILES = 8;
const MAX_SCAN_FILES = 5_000;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'be',
  'do',
  'fix',
  'for',
  'in',
  'into',
  'it',
  'of',
  'on',
  'or',
  'remove',
  'rename',
  'the',
  'this',
  'to',
  'up',
  'update',
  'wire',
  'with',
]);

const SKIP_DIRS = new Set([
  '.git',
  '.swarm',
  '.codex',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
]);

function normalizedScope(value: string): string | null {
  const scope = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!validWriteScope(scope)) {
    return null;
  }
  return scope;
}

export function validWriteScope(value: string): boolean {
  return value.length > 0
    && value.length <= 512
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !/^[A-Za-z]:/.test(value)
    && !/[\x00-\x1f]/.test(value)
    && !value.split('/').some(segment => !segment || segment === '..' || segment === '.git' || segment === '.swarm' || segment === '.codex')
    && !value.endsWith('/');
}

function explicitPathCandidates(instruction: string): string[] {
  const matches = instruction.matchAll(/(?:^|\s|`)([A-Za-z0-9_.@/-]+(?:\.[A-Za-z0-9]+|\/\*\*|\/\*|\*))(?:`|\s|$|[,.])/g);
  return [...matches]
    .map(match => normalizedScope(match[1] ?? ''))
    .filter((scope): scope is string => Boolean(scope));
}

function repoFilesFromGit(root: string): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    return out
      .split('\n')
      .map(file => file.trim())
      .filter(file => file && validWriteScope(file));
  } catch {
    return null;
  }
}

function repoFilesFromScan(root: string): string[] {
  const files: string[] = [];
  const scan = (dir: string): void => {
    if (files.length >= MAX_SCAN_FILES) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES) {
        return;
      }
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          scan(abs);
        }
      } else if (entry.isFile() && validWriteScope(rel)) {
        files.push(rel);
      }
    }
  };
  scan(root);
  return files;
}

function repoFiles(root: string): string[] {
  return repoFilesFromGit(root) ?? repoFilesFromScan(root);
}

function tokens(instruction: string): string[] {
  return [
    ...new Set(
      instruction
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(token => token.length >= 3 && !STOP_WORDS.has(token)),
    ),
  ];
}

function scoreFile(file: string, requestTokens: readonly string[]): number {
  const lower = file.toLowerCase();
  const base = path.basename(lower, path.extname(lower));
  let score = 0;
  for (const token of requestTokens) {
    if (base === token) {
      score += 8;
    } else if (base.includes(token)) {
      score += 5;
    } else if (lower.includes(token)) {
      score += 2;
    }
  }
  return score;
}

function inferScopesFromTokens(root: string, instruction: string): string[] {
  const requestTokens = tokens(instruction);
  if (!requestTokens.length) {
    return [];
  }

  return repoFiles(root)
    .map(file => ({ file, score: scoreFile(file, requestTokens) }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, MAX_QUICK_SCOPE_FILES + 1)
    .map(entry => entry.file);
}

export interface QuickTaskScopeInference {
  scopes: string[];
  reason: string;
}

export function inferQuickTaskWriteScope(root: string, instruction: string): QuickTaskScopeInference {
  const explicit = [...new Set(explicitPathCandidates(instruction))];
  if (explicit.length) {
    return {
      scopes: explicit.slice(0, MAX_QUICK_SCOPE_FILES + 1),
      reason: 'using explicit path references from the request',
    };
  }

  const inferred = inferScopesFromTokens(root, instruction);
  return {
    scopes: inferred,
    reason: inferred.length
      ? 'using matching repository paths from the request wording'
      : 'no narrow repository path candidates were found',
  };
}

export function quickScopeLimit(): number {
  return MAX_QUICK_SCOPE_FILES;
}
