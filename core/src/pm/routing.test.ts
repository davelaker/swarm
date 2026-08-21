import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePmData } from './index.js';
import type { PmRoutingContext } from './routing.js';

const providers: PmRoutingContext = {
  providerAvailability: [
    { provider: 'anthropic', enabled: true, cliAvailable: true, apiKeyConfigured: false, availableAuthModes: ['subscription'] },
    { provider: 'openai', enabled: true, cliAvailable: true, apiKeyConfigured: false, availableAuthModes: ['subscription'] },
  ],
};

test('PM task hints receive authoritative routes without accepting an invented model', () => {
  const response = parsePmData({
    reply: 'Ready.',
    team_add: ['coder', 'reviewer'],
    task_graph: [
      {
        id: 't1', assignee: 'coder', title: 'Rename one label', depends_on: [],
        intent: 'execution', scope: 'small', risk: 'low',
        model_preference: 'gpt-future-unreleased', write_scope: ['src/labels.ts'],
      },
      {
        id: 't2', assignee: 'reviewer', title: 'Review the label change', depends_on: ['t1'],
        intent: 'review', scope: 'small', risk: 'low',
      },
    ],
  }, providers);

  const [coder, reviewer] = response.taskGraph ?? [];
  assert.equal(coder.route?.provider, 'openai');
  assert.equal(coder.route?.model, 'gpt-5.3-codex');
  assert.equal(coder.route?.requiresConfirmation, false);
  assert.deepEqual(coder.route?.writeScope, ['src/labels.ts']);
  assert.match(coder.route?.rationale ?? '', /not a supported catalog model/);
  assert.notEqual(coder.route?.model, 'gpt-future-unreleased');
  assert.equal(reviewer.route?.provider, 'anthropic');
  assert.match(reviewer.route?.rationale ?? '', /independent review/);
});

test('PM large-task preferences cannot silently approve a more expensive route', () => {
  const response = parsePmData({
    reply: 'Ready.',
    team_add: ['coder'],
    task_graph: [{
      id: 't1', assignee: 'coder', title: 'Implement cross-cutting migration', depends_on: [],
      intent: 'coding', scope: 'large', risk: 'high', model_preference: 'codex', write_scope: ['src/**'],
    }],
  }, providers);

  const route = response.taskGraph?.[0].route;
  assert.equal(route?.provider, 'anthropic');
  assert.equal(route?.model, 'claude-opus-4-8');
  assert.equal(route?.requiresConfirmation, true);
  assert.match(route?.rationale ?? '', /advisory/);
});

test('deterministic PM tasks are left without an LLM route', () => {
  const response = parsePmData({
    reply: 'Ready.',
    team_add: ['checks'],
    task_graph: [{ id: 't1', assignee: 'checks', title: 'Run deterministic checks', depends_on: [], intent: 'validation' }],
  }, providers);

  assert.equal(response.taskGraph?.[0].route, undefined);
});
