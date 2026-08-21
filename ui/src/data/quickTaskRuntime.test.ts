import { describe, expect, it } from 'vitest';
import { projectQuickTaskCard, type QuickTaskRuntimeInput } from './quickTaskRuntime';

function input(overrides: Partial<QuickTaskRuntimeInput> = {}): QuickTaskRuntimeInput {
  return {
    project: 'swarm',
    status: 'running',
    tasks: [
      {
        id: 't_quick',
        title: 'Fix banner',
        assignee: 'coder',
        deps: [],
        lane: 0,
        status: 'in_progress',
      },
      {
        id: 't_checks',
        title: 'Checks',
        assignee: 'checks',
        deps: ['t_quick'],
        lane: 0,
        status: 'pending',
      },
    ],
    findings: [],
    taskActivity: {},
    agentSteps: { coder: 'Editing banner state' },
    spend: 0,
    metadata: {
      request: 'Fix the reconnect banner',
      declaredWriteScope: ['ui/src/Banner.tsx'],
      verificationCommands: ['cd ui && npm test'],
      route: { provider: 'openai', model: 'gpt-5.4', effort: 'low' },
    },
    changedFiles: [],
    ...overrides,
  };
}

describe('projectQuickTaskCard', () => {
  it('projects an executing one-owner run', () => {
    const card = projectQuickTaskCard(input());
    expect(card.stage).toBe('executing');
    expect(card.currentStep).toBe('Editing banner state');
    expect(card.runDetails.writeScope).toEqual(['ui/src/Banner.tsx']);
  });

  it('switches to verification after the coder completes', () => {
    const card = projectQuickTaskCard(
      input({
        tasks: [
          {
            id: 't_quick',
            title: 'Fix banner',
            assignee: 'coder',
            deps: [],
            lane: 0,
            status: 'done',
          },
          {
            id: 't_checks',
            title: 'Checks',
            assignee: 'checks',
            deps: ['t_quick'],
            lane: 0,
            status: 'in_progress',
          },
        ],
      }),
    );
    expect(card.stage).toBe('verifying');
    expect(card.verification[0]?.status).toBe('running');
  });

  it('surfaces failed gates and their finding', () => {
    const card = projectQuickTaskCard(
      input({
        tasks: [
          {
            id: 't_quick',
            title: 'Fix banner',
            assignee: 'coder',
            deps: [],
            lane: 0,
            status: 'done',
          },
          {
            id: 't_checks',
            title: 'Checks',
            assignee: 'checks',
            deps: ['t_quick'],
            lane: 0,
            status: 'failed',
          },
        ],
        findings: [
          {
            key: 'f',
            agent: 'checks',
            task: 't_checks',
            verdict: 'fail',
            summary: 'Typecheck failed.',
          },
        ],
      }),
    );
    expect(card.stage).toBe('failed');
    expect(card.escalationReason).toBe('Typecheck failed.');
  });
});
