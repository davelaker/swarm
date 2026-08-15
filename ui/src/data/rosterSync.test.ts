import { describe, expect, test } from 'vitest';
import { assessStaleness, syncRosterEntry, syncRoster } from './rosterSync';
import type { HiredAgent, MarketAgent } from '../types';

const catalogAgent: MarketAgent = {
  id: 'db',
  name: 'Database Specialist',
  role: 'Backend',
  rating: 4.8,
  version: '2.9.0',
  desc: 'x',
  changelog: 'x',
  prompt: 'NEW PROMPT',
  color: '#fff',
  tools: [
    { name: 'read_files', sens: 'read', desc: 'x' },
    { name: 'db_read', sens: 'shell', sqlCategory: 'read', desc: 'x' },
    { name: 'write_migration', sens: 'write', desc: 'x', scope: 'migrations/**,db/**' },
  ],
  connectors: [{ id: 'supabase', tools: ['list_tables', 'execute_sql'] }],
};

function hired(overrides: Partial<HiredAgent>): HiredAgent {
  return {
    id: 'db',
    version: '2.8.0',
    enabled: true,
    grantedTools: [
      { name: 'read_files', sens: 'read' },
      { name: 'db_read', sens: 'shell', sqlCategory: 'read', mode: 'ask' },
      { name: 'write_migration', sens: 'write', scope: 'migrations/**' },
      { name: 'apply_migration_local', sens: 'write' }, // no longer in catalog
    ],
    grantedConnectors: [
      { server: 'supabase', tool: 'list_tables' },
      { server: 'supabase', tool: 'apply_migration' }, // no longer in catalog
    ],
    model: 'claude-opus-4-8',
    instructions: 'my overlay',
    upgradeAvailable: false,
    name: 'Database Specialist',
    prompt: 'OLD PROMPT',
    ...overrides,
  };
}

describe('assessStaleness', () => {
  test('flags version drift, removed grants, and lists ungranted catalog tools', () => {
    const s = assessStaleness(hired({}), catalogAgent);
    expect(s.stale).toBe(true);
    expect(s.reasons.join(' ')).toContain('v2.8.0 → v2.9.0');
    expect(s.reasons.join(' ')).toContain('apply_migration_local');
    expect(s.reasons.join(' ')).toContain('supabase:apply_migration');
    expect(s.newTools).toContain('supabase:execute_sql');
  });

  test('flags prompt drift even when versions match', () => {
    const s = assessStaleness(
      hired({
        version: '2.9.0',
        grantedTools: [{ name: 'read_files', sens: 'read' }],
        grantedConnectors: [],
      }),
      catalogAgent,
    );
    expect(s.stale).toBe(true);
    expect(s.reasons.join(' ')).toContain('prompt differs');
  });

  test('a fully current entry is not stale', () => {
    const synced = syncRosterEntry(hired({}), catalogAgent);
    expect(assessStaleness(synced, catalogAgent).stale).toBe(false);
  });

  test('an agent missing from the catalog is never reported stale', () => {
    expect(assessStaleness(hired({}), undefined).stale).toBe(false);
  });
});

describe('syncRosterEntry', () => {
  test('refreshes prompt/version/tool metadata, preserves user choices, drops removed grants', () => {
    const synced = syncRosterEntry(
      hired({ enabled: false, model: 'claude-haiku-4-5-20251001' }),
      catalogAgent,
    );
    expect(synced.prompt).toBe('NEW PROMPT');
    expect(synced.version).toBe('2.9.0');
    // user choices preserved
    expect(synced.enabled).toBe(false);
    expect(synced.model).toBe('claude-haiku-4-5-20251001');
    expect(synced.instructions).toBe('my overlay');
    expect(synced.grantedTools.find(t => t.name === 'db_read')?.mode).toBe('ask');
    // removed grants dropped — sync only narrows
    expect(synced.grantedTools.map(t => t.name)).not.toContain('apply_migration_local');
    expect(synced.grantedConnectors).toEqual([{ server: 'supabase', tool: 'list_tables' }]);
    // tool metadata refreshed from the catalog (widened scope comes from catalog def)
    expect(synced.grantedTools.find(t => t.name === 'write_migration')?.scope).toBe(
      'migrations/**,db/**',
    );
    // new-in-catalog connector tools are NOT auto-granted
    expect(synced.grantedConnectors.map(g => g.tool)).not.toContain('execute_sql');
  });

  test('leaves an entry untouched when the catalog no longer has the agent', () => {
    const h = hired({});
    expect(syncRosterEntry(h, undefined)).toBe(h);
  });
});

describe('syncRoster', () => {
  test('maps the whole team through the catalog', () => {
    const out = syncRoster([hired({})], { db: catalogAgent });
    expect(out).toHaveLength(1);
    expect(out[0].version).toBe('2.9.0');
  });
});
