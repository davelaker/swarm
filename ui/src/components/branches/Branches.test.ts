import { describe, expect, it } from 'vitest';
import { filterBranches, projectBranchSections } from './Branches';
import type { SwarmBranch } from '../../types';

const branches: SwarmBranch[] = [
  {
    name: 'swarm/current-work',
    shortName: 'current-work',
    isCurrent: true,
    merged: false,
    pushed: true,
    ahead: 2,
    lastCommit: {
      hash: 'abc1234',
      message: 'Keep current work on top',
      date: '2026-08-22T09:00:00.000Z',
    },
    pr: null,
  },
  {
    name: 'swarm/open-fix',
    shortName: 'open-fix',
    isCurrent: false,
    merged: false,
    pushed: true,
    ahead: 1,
    lastCommit: {
      hash: 'def5678',
      message: 'Fix transcript wrapping',
      date: '2026-08-21T12:00:00.000Z',
    },
    pr: { number: 44, url: 'https://example.com/pr/44', title: 'Transcript fix', state: 'open' },
  },
  {
    name: 'swarm/merged-cleanup',
    shortName: 'merged-cleanup',
    isCurrent: false,
    merged: true,
    pushed: true,
    ahead: 0,
    lastCommit: {
      hash: 'ghi9012',
      message: 'Cleanup merged branch',
      date: '2026-08-20T08:00:00.000Z',
    },
    pr: { number: 12, url: 'https://example.com/pr/12', title: 'Cleanup', state: 'merged' },
  },
];

describe('filterBranches', () => {
  it('keeps the current branch first, then sorts by recent activity', () => {
    expect(filterBranches(branches, '', 'all').map(branch => branch.shortName)).toEqual([
      'current-work',
      'open-fix',
      'merged-cleanup',
    ]);
  });

  it('matches branch search against PR and commit metadata', () => {
    expect(filterBranches(branches, 'transcript', 'all').map(branch => branch.shortName)).toEqual([
      'open-fix',
    ]);
    expect(filterBranches(branches, '12', 'all').map(branch => branch.shortName)).toEqual([
      'merged-cleanup',
    ]);
  });
});

describe('projectBranchSections', () => {
  it('collapses merged branches by default when no filters are active', () => {
    expect(projectBranchSections(branches, '', 'all', false)).toMatchObject({
      openBranches: [branches[0], branches[1]],
      mergedBranches: [branches[2]],
      visibleMergedBranches: [],
      hiddenMergedCount: 1,
      hasActiveFilters: false,
      showMergedBranches: false,
    });
  });

  it('shows merged matches immediately when a filter is active', () => {
    expect(projectBranchSections(branches, 'cleanup', 'all', false)).toMatchObject({
      openBranches: [],
      mergedBranches: [branches[2]],
      visibleMergedBranches: [branches[2]],
      hiddenMergedCount: 0,
      hasActiveFilters: true,
      showMergedBranches: true,
    });
  });
});
