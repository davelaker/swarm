import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeTerminalPmResponse,
  pmTerminalOutcomeInstructions,
  type PmResponse,
} from './index.js';

const unsafePmResponse: PmResponse = {
  reply: 'Here is the answer.',
  securityInterject: 'Review user-controlled input.',
  deploymentInfo: 'Deploys to production.',
  suggestCompact: true,
  charterUpdates: {
    goal: 'Mutate the charter',
    newConstraints: ['Add execution state'],
    newNongoals: ['Skip direct answer'],
    newQuestions: ['Can I execute this?'],
    branchMode: 'branch',
    branchName: 'mutate-state',
  },
  taskGraph: [
    {
      id: 't1',
      assignee: 'coder',
      title: 'Write code despite terminal mode',
      depends_on: [],
    },
  ],
  teamAdd: ['coder', 'reviewer'],
  enableExecute: true,
  disableExecute: true,
  disableReason: 'Model attempted to change execution state.',
  researchRequest: { question: 'Keep researching forever.' },
  hireSuggestion: { agentId: 'architect', reason: 'Escalate the workflow.' },
};

test('answer terminal outcome strips PM state changes and execution', () => {
  const normalized = normalizeTerminalPmResponse(unsafePmResponse, 'answer');

  assert.equal(normalized.reply, 'Here is the answer.');
  assert.equal(normalized.securityInterject, 'Review user-controlled input.');
  assert.equal(normalized.suggestCompact, true);
  assert.equal(normalized.enableExecute, false);
  assert.equal(normalized.deploymentInfo, undefined);
  assert.equal(normalized.charterUpdates, undefined);
  assert.equal(normalized.taskGraph, undefined);
  assert.equal(normalized.teamAdd, undefined);
  assert.equal(normalized.disableExecute, undefined);
  assert.equal(normalized.disableReason, undefined);
  assert.equal(normalized.researchRequest, undefined);
  assert.equal(normalized.hireSuggestion, undefined);
});

test('plan terminal outcome strips task graph and never enables execution', () => {
  const normalized = normalizeTerminalPmResponse(unsafePmResponse, 'plan');

  assert.equal(normalized.reply, 'Here is the answer.');
  assert.equal(normalized.enableExecute, false);
  assert.equal(normalized.charterUpdates, undefined);
  assert.equal(normalized.taskGraph, undefined);
  assert.equal(normalized.teamAdd, undefined);
  assert.equal(normalized.disableExecute, undefined);
});

test('terminal outcome prompts preserve research while forbidding execution state', () => {
  const answer = pmTerminalOutcomeInstructions('answer');
  const plan = pmTerminalOutcomeInstructions('plan');

  assert.match(answer, /read-only/);
  assert.match(answer, /research_request/);
  assert.match(answer, /Do not enable Execute/);
  assert.match(plan, /complete engineering plan/);
  assert.match(plan, /terminal outcome/);
  assert.match(plan, /Do not enable Execute automatically/);
});
