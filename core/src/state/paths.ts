// Repo-relative path validation — shared by any code that accepts file paths
// from an agent's structured output. Agent-reported paths feed `git add` and
// the task's artifacts, so they must be provably inside the repo: relative,
// no traversal, never swarm metadata. Pure — trivially testable.

const MAX_PATH_LENGTH = 512;

export function isRepoRelativePath(p: string): boolean {
  if (!p || p.length > MAX_PATH_LENGTH) {
    return false;
  }
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) {
    return false; // absolute (posix or windows)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(p)) {
    return false; // control characters (NUL, newline, ...) never belong in a path
  }
  const segments = p.replace(/\\/g, '/').split('/');
  if (segments.some(s => s === '..' || s === '')) {
    return false; // traversal, or '//' / trailing slash
  }
  if (segments[0] === '.swarm') {
    return false; // swarm metadata is never an agent artifact
  }
  return true;
}

// Coerce an agent-reported files array into validated repo-relative paths.
// Anything malformed is dropped, deduped, order preserved.
export function sanitizeArtifactPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      continue;
    }
    const p = entry.trim().replace(/^\.\//, '');
    if (isRepoRelativePath(p) && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}
