import { describe, expect, it } from 'vitest';
import { projectHistoricalPlanningView } from './Planning';
import type { SessionSnapshot } from '../../types';

const baseSession: SessionSnapshot = {
  id: 'session-1',
  savedAt: '2026-08-22T08:00:00.000Z',
  project: 'swarm',
  goal: 'Tighten archived-mode wording',
  tier: 'feature',
  branchName: 'swarm/archived-wording',
  charter: {
    constraints: ['Keep Running three-column layout'],
    nongoals: [],
    questions: [],
    planningHistory: [{ from: 'you', text: 'Please polish archived mode.' }],
  },
  tasks: [
    {
      id: 't1',
      title: 'Polish copy',
      assignee: 'coder',
      status: 'done',
      depends_on: [],
      result_ref: null,
    },
  ],
  log: [],
  elapsedMs: 1000,
};

describe('projectHistoricalPlanningView', () => {
  it('marks missing charter fields as not recorded and derives the saved branch label', () => {
    expect(projectHistoricalPlanningView(baseSession)).toMatchObject({
      goal: { text: 'Tighten archived-mode wording', source: 'recorded' },
      branch: 'archived-wording',
      sections: [
        { label: 'Constraints', value: ['Keep Running three-column layout'] },
        { label: 'Non-goals', value: 'not-recorded' },
        { label: 'Open questions', value: 'not-recorded' },
      ],
      messages: [{ from: 'you', text: 'Please polish archived mode.' }],
    });
  });

  it('reconstructs team membership from executed tasks', () => {
    expect(projectHistoricalPlanningView(baseSession).team).toEqual([
      { id: 'coder', source: 'reconstructed' },
    ]);
  });
});
