import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateScorecards } from './scorecards.js';

test('aggregateScorecards folds tasks per agent across sessions', () => {
  const snaps = [
    {
      tasks: [
        { assignee: 'coder', status: 'done', finding_verdict: 'COMPLETE', cost_usd: 0.2 },
        {
          assignee: 'reviewer',
          status: 'done',
          finding_verdict: 'CHANGES_REQUESTED',
          cost_usd: 0.1,
        },
      ],
    },
    {
      tasks: [
        { assignee: 'coder', status: 'done', finding_verdict: 'COMPLETE', cost_usd: 0.3 },
        { assignee: 'reviewer', status: 'done', finding_verdict: 'APPROVED', cost_usd: 0.15 },
        { assignee: 'checks', status: 'done', finding_verdict: 'FAIL', cost_usd: 0 },
      ],
    },
  ];
  const cards = aggregateScorecards(snaps);

  assert.equal(cards.coder.tasks, 2);
  assert.equal(cards.coder.sessions, 2);
  assert.equal(cards.coder.passes, 2);
  assert.equal(cards.coder.issuesCaught, 0);
  assert.ok(Math.abs(cards.coder.totalCostUsd - 0.5) < 1e-9);

  assert.equal(cards.reviewer.tasks, 2);
  assert.equal(cards.reviewer.passes, 1); // APPROVED
  assert.equal(cards.reviewer.issuesCaught, 1); // CHANGES_REQUESTED

  assert.equal(cards.checks.issuesCaught, 1); // FAIL
});

test('aggregateScorecards counts a session once per agent even with multiple tasks', () => {
  const snaps = [
    {
      tasks: [
        { assignee: 'coder', status: 'done', finding_verdict: 'COMPLETE' },
        { assignee: 'coder', status: 'failed' },
      ],
    },
  ];
  const cards = aggregateScorecards(snaps);
  assert.equal(cards.coder.tasks, 2);
  assert.equal(cards.coder.sessions, 1);
  assert.equal(cards.coder.failures, 1);
});

test('aggregateScorecards ignores tasks with no assignee and missing cost', () => {
  const cards = aggregateScorecards([{ tasks: [{ status: 'done' }, { assignee: 'visual' }] }]);
  assert.equal(Object.keys(cards).length, 1);
  assert.equal(cards.visual.tasks, 1);
  assert.equal(cards.visual.totalCostUsd, 0);
});
