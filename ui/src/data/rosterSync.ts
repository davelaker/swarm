// Roster ↔ catalog sync — pure logic (unit-tested in rosterSync.test.ts).
//
// Prompts and grants are COPIED into .swarm/roster.json at hire time, so a
// hired specialist keeps its old prompt — and any since-removed grants — until
// re-synced. Sync refreshes each hired entry from the current catalog while
// preserving every choice the user made, and it can only ever NARROW
// permissions, never widen them:
//   - prompt / name / version / tool metadata (sens, scope, sqlCategory): from
//     the current catalog.
//   - the user's allow/ask decisions, enabled state, model, instruction
//     overlay: preserved.
//   - grants for tools the catalog no longer offers: dropped.
//   - tools NEW in the catalog since hire: NOT auto-granted — granting is the
//     user's decision, made on the hire page. Sync surfaces them instead.

import type { HiredAgent, MarketAgent } from '../types';

export interface RosterStaleness {
  stale: boolean;
  reasons: string[]; // human-readable, e.g. "prompt updated (v1.2.0 → v1.3.0)"
  newTools: string[]; // catalog tools/connector-tools the user has not granted
}

export function assessStaleness(h: HiredAgent, a: MarketAgent | undefined): RosterStaleness {
  if (!a) {
    return { stale: false, reasons: [], newTools: [] };
  }
  const reasons: string[] = [];
  if (h.version !== a.version) {
    reasons.push(`prompt updated (v${h.version} → v${a.version})`);
  } else if (h.prompt !== undefined && h.prompt !== a.prompt) {
    reasons.push('prompt differs from catalog');
  }

  const catalogTools = new Set(a.tools.map(t => t.name));
  const removedTools = h.grantedTools.filter(t => !catalogTools.has(t.name)).map(t => t.name);
  if (removedTools.length) {
    reasons.push(`grants no longer in catalog: ${removedTools.join(', ')}`);
  }

  const catalogConnTools = new Set(
    (a.connectors ?? []).flatMap(c => c.tools.map(t => `${c.id}:${t}`)),
  );
  const removedConn = h.grantedConnectors
    .filter(g => !catalogConnTools.has(`${g.server}:${g.tool}`))
    .map(g => `${g.server}:${g.tool}`);
  if (removedConn.length) {
    reasons.push(`connector grants no longer in catalog: ${removedConn.join(', ')}`);
  }

  const grantedToolNames = new Set(h.grantedTools.map(t => t.name));
  const grantedConnKeys = new Set(h.grantedConnectors.map(g => `${g.server}:${g.tool}`));
  const newTools = [
    ...a.tools.filter(t => !grantedToolNames.has(t.name)).map(t => t.name),
    ...(a.connectors ?? []).flatMap(c =>
      c.tools.filter(t => !grantedConnKeys.has(`${c.id}:${t}`)).map(t => `${c.id}:${t}`),
    ),
  ];

  return { stale: reasons.length > 0, reasons, newTools };
}

export function syncRosterEntry(h: HiredAgent, a: MarketAgent | undefined): HiredAgent {
  if (!a) {
    return h; // hired agent no longer in the catalog at all — leave untouched
  }
  const catalogToolByName = new Map(a.tools.map(t => [t.name, t]));
  const catalogConnTools = new Set(
    (a.connectors ?? []).flatMap(c => c.tools.map(t => `${c.id}:${t}`)),
  );
  return {
    ...h,
    name: a.name,
    prompt: a.prompt,
    version: a.version,
    // Intersection with the current catalog: user's mode survives, tool
    // metadata (sens/scope/sqlCategory) refreshes, removed tools drop out.
    grantedTools: h.grantedTools
      .filter(t => catalogToolByName.has(t.name))
      .map(t => {
        const cat = catalogToolByName.get(t.name)!;
        return {
          name: cat.name,
          sens: cat.sens,
          ...(t.mode === 'ask' ? { mode: 'ask' as const } : {}),
          ...(cat.scope ? { scope: cat.scope } : {}),
          ...(cat.sqlCategory ? { sqlCategory: cat.sqlCategory } : {}),
        };
      }),
    grantedConnectors: h.grantedConnectors.filter(g =>
      catalogConnTools.has(`${g.server}:${g.tool}`),
    ),
  };
}

export function syncRoster(
  team: HiredAgent[],
  catalogById: Record<string, MarketAgent>,
): HiredAgent[] {
  return team.map(h => syncRosterEntry(h, catalogById[h.id]));
}
