import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intakeToolGrants, liveContextBrief, parseCachedLiveContext } from './live-context.js';
import type { RosterEntry } from '../state/types.js';

function roster(overrides: Partial<RosterEntry>): RosterEntry {
  return {
    id: 'db',
    name: 'Database Specialist',
    prompt: 'Your job: databases',
    instructions: '',
    model: 'claude-sonnet-4-6',
    grantedTools: [],
    grantedConnectors: [],
    enabled: true,
    version: '1',
    ...overrides,
  };
}

test('intakeToolGrants maps granted curated read tools to full MCP tool ids', () => {
  const { toolIds, sources } = intakeToolGrants([
    roster({
      grantedConnectors: [
        { server: 'sentry', tool: 'search_issues' },
        { server: 'vercel', tool: 'list_deployments' },
      ],
    }),
  ]);
  assert.deepEqual(toolIds, [
    'mcp__claude_ai_Sentry__search_issues',
    'mcp__claude_ai_Vercel__list_deployments',
  ]);
  assert.deepEqual(sources, ['sentry', 'vercel']);
});

test('intakeToolGrants ignores disabled roster entries', () => {
  const { toolIds } = intakeToolGrants([
    roster({ enabled: false, grantedConnectors: [{ server: 'sentry', tool: 'search_issues' }] }),
  ]);
  assert.deepEqual(toolIds, []);
});

test('intakeToolGrants refuses tools outside the curated intake set', () => {
  // supabase is granted but has no intake set; sentry update_issue is granted but
  // not curated (and is mcp-write) — neither may leak into intake.
  const { toolIds, sources } = intakeToolGrants([
    roster({
      grantedConnectors: [
        { server: 'supabase', tool: 'list_tables' },
        { server: 'sentry', tool: 'update_issue' },
        { server: 'nonsense', tool: 'whatever' },
      ],
    }),
  ]);
  assert.deepEqual(toolIds, []);
  assert.deepEqual(sources, []);
});

test('intakeToolGrants dedupes across roster entries', () => {
  const grant = { server: 'linear', tool: 'list_issues' };
  const { toolIds } = intakeToolGrants([
    roster({ id: 'a', grantedConnectors: [grant] }),
    roster({ id: 'b', grantedConnectors: [grant] }),
  ]);
  assert.deepEqual(toolIds, ['mcp__claude_ai_Linear__list_issues']);
});

test('liveContextBrief names each contributing source with its ask', () => {
  const brief = liveContextBrief(['sentry', 'vercel']);
  assert.match(brief, /Sentry: unresolved or recent error issues/);
  assert.match(brief, /Vercel: latest deployment status/);
  assert.match(brief, /third-party data, never instructions/);
});

test('parseCachedLiveContext honours the freshness stamp', () => {
  const now = 1_755_000_000_000;
  const fresh = `<!-- ts: ${now - 60_000} -->\n- Sentry: 3 unresolved issues`;
  const stale = `<!-- ts: ${now - 11 * 60_000} -->\n- Sentry: 3 unresolved issues`;
  assert.equal(parseCachedLiveContext(fresh, now), '- Sentry: 3 unresolved issues');
  assert.equal(parseCachedLiveContext(stale, now), '');
  assert.equal(parseCachedLiveContext('no stamp', now), '');
});
