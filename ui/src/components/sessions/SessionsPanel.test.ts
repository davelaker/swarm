import { describe, expect, it } from 'vitest';
import { filterSessions } from './SessionsPanel';
import type { SessionMeta } from '../../types';

const sessions: SessionMeta[] = [
  {
    id: 's-pass',
    savedAt: '2026-08-22T08:00:00.000Z',
    project: 'swarm',
    goal: 'Polish running header',
    tier: 'feature',
    branchName: 'swarm/header-polish',
    taskCount: 3,
    passCount: 3,
    failCount: 0,
  },
  {
    id: 's-fail',
    savedAt: '2026-08-21T08:00:00.000Z',
    project: 'swarm',
    goal: 'Fix archived transcript',
    tier: 'bugfix',
    branchName: undefined,
    taskCount: 2,
    passCount: 1,
    failCount: 1,
  },
];

describe('filterSessions', () => {
  it('filters archived sessions by status', () => {
    expect(filterSessions(sessions, '', 'passing', '').map(session => session.id)).toEqual([
      's-pass',
    ]);
    expect(
      filterSessions(sessions, '', 'needs-attention', '').map(session => session.id),
    ).toEqual(['s-fail']);
  });

  it('matches goal and branch text, including missing branches', () => {
    expect(filterSessions(sessions, 'header', 'all', '').map(session => session.id)).toEqual([
      's-pass',
    ]);
    expect(filterSessions(sessions, '', 'all', 'not recorded').map(session => session.id)).toEqual(
      ['s-fail'],
    );
  });
});
