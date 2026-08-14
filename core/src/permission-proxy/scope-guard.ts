// Scope guard — pure matching logic for the permission proxy's ask-mode tools.
//
// In allow mode a grant's `scope` is enforced natively by the Claude permission
// patterns (Write(migrations/**), Bash(npx axe-cli *)). The 2026-08 review
// found ask mode silently DROPPED that confinement: the proxied
// write_file/edit_file/bash tools contained to the project root only, so
// choosing the more cautious mode widened the path scope. These matchers close
// that gap — the proxy rejects out-of-scope requests before asking the human,
// making ask mode strictly tighter than allow mode, never looser.

// Path globs, comma-separated in grants: '**' spans directories, '*' stays
// within one segment, anything else matches literally.
export function matchesPathScope(relPath: string, globs: string[]): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.some(glob => globToRegex(glob).test(normalized));
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

// Command patterns use the Claude Bash(pattern) convention: a trailing ' *'
// makes the pattern a prefix ('npx axe-cli *' allows any axe-cli invocation);
// otherwise the command must match exactly. A bare '*' allows everything.
export function matchesCommandScope(command: string, patterns: string[]): boolean {
  const cmd = command.trim();
  return patterns.some(raw => {
    const pattern = raw.trim();
    if (!pattern) {
      return false;
    }
    if (pattern === '*') {
      return true;
    }
    if (pattern.endsWith(' *')) {
      const prefix = pattern.slice(0, -2);
      return cmd === prefix || cmd.startsWith(prefix + ' ');
    }
    return cmd === pattern;
  });
}

export function parseScopeList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}
