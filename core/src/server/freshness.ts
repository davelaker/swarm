// Stale-server detection. `tsx` loads the backend source once at startup, so any
// edit to core's source after the process started is NOT running until a manual
// restart — and nothing on the dashboard signals that. This module lets the server
// report whether its on-disk source is newer than the running process, so the UI
// can nudge for a restart instead of silently running stale code.

import fs from 'node:fs';
import path from 'node:path';

// Captured at module load == process start. Read-only thereafter.
export const SERVER_STARTED_AT = Date.now();

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);

// Pure-ish: walk a directory tree and return the newest mtime (ms) among files
// matching `exts`. Returns 0 for an empty/unreadable tree so callers can treat
// "no sources found" as "not stale" rather than crashing.
export function newestMtimeMs(dir: string, exts: string[]): number {
  let newest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      newest = Math.max(newest, newestMtimeMs(full, exts));
    } else if (exts.some(e => entry.name.endsWith(e))) {
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        /* file vanished between readdir and stat — ignore */
      }
    }
  }
  return newest;
}

export interface ServerFreshness {
  startedAt: number;
  newestSourceAt: number;
  stale: boolean;
  restartCommand: string;
}

// The backend's own source root: this file lives at core/src/server/freshness.ts,
// so `..` is core/src/. A small grace window absorbs clock jitter / save-on-startup.
const STALE_GRACE_MS = 2_000;

export function serverFreshness(): ServerFreshness {
  const srcDir = path.resolve(new URL('..', import.meta.url).pathname);
  const newestSourceAt = newestMtimeMs(srcDir, ['.ts', '.tsx']);
  return {
    startedAt: SERVER_STARTED_AT,
    newestSourceAt,
    stale: newestSourceAt > SERVER_STARTED_AT + STALE_GRACE_MS,
    restartCommand: 'npm run dev   (in core/)',
  };
}
