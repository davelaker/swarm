// Living documentation — pure path rules and git-porcelain helpers for the docs
// scribe (MEMORY.md). The scribe's prompt asks it to touch only documentation, but
// the boundary is ENFORCED here: loop.ts diffs the working tree before/after the
// scribe run, reverts anything outside these rules, and commits only what survives.

import fs from 'node:fs';
import path from 'node:path';

// Agent-context files are never living documentation — they belong to the learnings
// scribe (CLAUDE.md) or to humans (CONTEXT.md, AGENTS.md), per the MEMORY.md
// delineation.
const AGENT_CONTEXT_BASENAMES = new Set(['CLAUDE.md', 'CONTEXT.md', 'AGENTS.md']);

// True if the docs scribe is allowed to have changed this path: markdown only,
// never swarm metadata, never agent-context files. Paths are repo-relative.
export function isLivingDocPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('.swarm/') || normalized.includes('/.swarm/')) {
    return false;
  }
  const ext = path.extname(normalized).toLowerCase();
  if (ext !== '.md' && ext !== '.mdx') {
    return false;
  }
  return !AGENT_CONTEXT_BASENAMES.has(path.basename(normalized));
}

export interface PorcelainEntry {
  path: string;
  untracked: boolean;
}

// Parse `git status --porcelain` output into path entries. Handles the rename
// form ("R  old -> new") by taking the new path, and strips quoting on paths
// git escapes (spaces, unicode).
export function parsePorcelain(output: string): PorcelainEntry[] {
  return output
    .split('\n')
    .filter(line => line.length > 3)
    .map(line => {
      const status = line.slice(0, 2);
      let p = line.slice(3);
      const arrow = p.indexOf(' -> ');
      if (arrow !== -1) {
        p = p.slice(arrow + 4);
      }
      if (p.startsWith('"') && p.endsWith('"')) {
        p = p.slice(1, -1);
      }
      return { path: p, untracked: status === '??' };
    });
}

// Entries changed AFTER the scribe ran that were clean BEFORE it — the only
// changes the scribe can be held responsible for. Pre-existing dirt (there
// should be none at run end, but never assume) is left strictly alone.
export function newlyChanged(before: PorcelainEntry[], after: PorcelainEntry[]): PorcelainEntry[] {
  const preExisting = new Set(before.map(e => e.path));
  return after.filter(e => !preExisting.has(e.path));
}

export interface DocPartition {
  docs: PorcelainEntry[];
  forbidden: PorcelainEntry[];
}

export function partitionDocPaths(entries: PorcelainEntry[]): DocPartition {
  const docs: PorcelainEntry[] = [];
  const forbidden: PorcelainEntry[] = [];
  for (const e of entries) {
    (isLivingDocPath(e.path) ? docs : forbidden).push(e);
  }
  return { docs, forbidden };
}

// Documentation files that already exist in the project, for the scribe's brief:
// the root README plus markdown under docs/ (bounded depth, skip generated dirs).
const DOC_SCAN_SKIP = new Set(['node_modules', '.git', '.swarm', 'dist', 'build', 'coverage']);

export function listLivingDocFiles(root: string): string[] {
  const results: string[] = [];
  for (const name of ['README.md', 'readme.md']) {
    if (fs.existsSync(path.join(root, name))) {
      results.push(name);
      break;
    }
  }
  const docsDir = path.join(root, 'docs');
  const scan = (dir: string, depth: number): void => {
    if (depth > 3) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !DOC_SCAN_SKIP.has(e.name) && !e.name.startsWith('.')) {
        scan(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && isLivingDocPath(path.relative(root, path.join(dir, e.name)))) {
        results.push(path.relative(root, path.join(dir, e.name)));
      }
    }
  };
  scan(docsDir, 0);
  return results.sort();
}
