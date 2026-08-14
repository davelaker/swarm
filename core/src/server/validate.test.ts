import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRosterPayload, validateTaskGraph } from './validate.js';

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

test('validateRosterPayload accepts a well-formed roster', () => {
  const v = validateRosterPayload([
    entry({
      grantedTools: [{ name: 'shell', sens: 'shell', mode: 'ask' }],
      grantedConnectors: [{ server: 'sentry', tool: 'search_issues' }],
    }),
  ]);
  assert.equal(v.ok, true);
});

test('validateRosterPayload rejects non-arrays and hostile shapes', () => {
  assert.equal(validateRosterPayload({}).ok, false);
  assert.equal(validateRosterPayload([null]).ok, false);
  assert.equal(validateRosterPayload([entry({ id: '../escape' })]).ok, false);
  assert.equal(validateRosterPayload([entry({ id: 'a' }), entry({ id: 'a' })]).ok, false);
});

test('validateRosterPayload rejects unknown sens, mode, and sqlCategory', () => {
  assert.equal(
    validateRosterPayload([entry({ grantedTools: [{ name: 'x', sens: 'root' }] })]).ok,
    false,
  );
  assert.equal(
    validateRosterPayload([entry({ grantedTools: [{ name: 'x', sens: 'read', mode: 'always' }] })])
      .ok,
    false,
  );
  assert.equal(
    validateRosterPayload([
      entry({ grantedTools: [{ name: 'x', sens: 'sql', sqlCategory: 'root' }] }),
    ]).ok,
    false,
  );
});

test('validateRosterPayload rejects unknown connectors and connector tools', () => {
  assert.equal(
    validateRosterPayload([entry({ grantedConnectors: [{ server: 'nope', tool: 'x' }] })]).ok,
    false,
  );
  assert.equal(
    validateRosterPayload([entry({ grantedConnectors: [{ server: 'sentry', tool: 'nope' }] })]).ok,
    false,
  );
});

test('validateTaskGraph accepts a valid DAG and an absent graph', () => {
  assert.equal(validateTaskGraph(undefined).ok, true);
  const v = validateTaskGraph([
    { id: 't1', assignee: 'coder', title: 'build', depends_on: [] },
    { id: 't2', assignee: 'reviewer', title: 'review', depends_on: ['t1'] },
  ]);
  assert.equal(v.ok, true);
});

test('validateTaskGraph rejects traversal-shaped and malformed ids', () => {
  assert.equal(
    validateTaskGraph([{ id: '../../etc/x', assignee: 'coder', title: 't', depends_on: [] }]).ok,
    false,
  );
  assert.equal(
    validateTaskGraph([{ id: 't one', assignee: 'coder', title: 't', depends_on: [] }]).ok,
    false,
  );
  assert.equal(
    validateTaskGraph([{ id: 't1', assignee: 'Coder!', title: 't', depends_on: [] }]).ok,
    false,
  );
});

test('validateTaskGraph rejects dangling deps, duplicates, and cycles', () => {
  assert.equal(
    validateTaskGraph([{ id: 't1', assignee: 'coder', title: 't', depends_on: ['ghost'] }]).ok,
    false,
  );
  assert.equal(
    validateTaskGraph([
      { id: 't1', assignee: 'coder', title: 'a', depends_on: [] },
      { id: 't1', assignee: 'coder', title: 'b', depends_on: [] },
    ]).ok,
    false,
  );
  assert.equal(
    validateTaskGraph([
      { id: 't1', assignee: 'coder', title: 'a', depends_on: ['t2'] },
      { id: 't2', assignee: 'coder', title: 'b', depends_on: ['t1'] },
    ]).ok,
    false,
  );
});
