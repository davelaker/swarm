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
      branch: { label: 'archived-wording', source: 'recorded', mode: 'branch' },
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

  it('uses recorded task-graph facts when the snapshot captured them', () => {
    const view = projectHistoricalPlanningView({
      ...baseSession,
      branchName: undefined,
      charter: {
        ...baseSession.charter!,
        branchMode: 'main',
        taskGraph: [
          {
            id: 't-plan',
            title: 'Review archived fidelity',
            assignee: 'reviewer',
            depends_on: ['t1'],
            route: {
              provider: 'openai',
              model: 'gpt-5.5',
              reasoningEffort: 'high',
              rationale: 'Use the stronger model for historical review',
              fallback: null,
              requiresConfirmation: false,
              writeScope: ['ui/src/components/planning/**'],
            },
          },
        ],
      },
    });

    expect(view.branch).toEqual({
      label: 'Committing to main',
      source: 'recorded',
      mode: 'main',
    });
    expect(view.team).toEqual([{ id: 'reviewer', source: 'recorded' }]);
    expect(view.executionPlan).toEqual({
      source: 'recorded',
      tasks: [
        {
          id: 't-plan',
          title: 'Review archived fidelity',
          assignee: 'reviewer',
          dependsOn: ['t1'],
          model: 'gpt-5.5',
        },
      ],
    });
  });
});
