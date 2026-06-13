// Roster persistence — hired marketplace agents, stored per-project in .swarm/roster.json.
// The file is written by POST /marketplace/roster and read by the PM and agent dispatcher.

import * as fs   from 'node:fs';
import * as path from 'node:path';
import { getRoot } from './repo.js';
import type { RosterEntry } from './types.js';

function rosterFilePath(): string {
  return path.join(getRoot(), '.swarm', 'roster.json');
}

export function loadRoster(): RosterEntry[] {
  try {
    const raw = fs.readFileSync(rosterFilePath(), 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return (arr as RosterEntry[])
      // name is a cosmetic display label — never drop a functional agent (id + prompt)
      // just because it's missing. The UI historically persisted hires without a name,
      // which silently hid hired specialists from the PM. Backfill it below.
      .filter(a => a.id && a.prompt)
      .map(a => ({
        ...a,
        name: a.name || a.id,
        // Migrate old format: grantedTools was string[] — convert to {name, sens}[]
        grantedTools: Array.isArray(a.grantedTools) && a.grantedTools.length > 0 && typeof a.grantedTools[0] === 'string'
          ? (a.grantedTools as unknown as string[]).map(name => ({ name, sens: 'read' }))
          : a.grantedTools ?? [],
        grantedConnectors: Array.isArray(a.grantedConnectors) ? a.grantedConnectors : [],
      }));
  } catch {
    return [];
  }
}

export function saveRoster(roster: RosterEntry[]): void {
  const p = rosterFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(roster, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
