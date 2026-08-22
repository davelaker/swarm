import { describe, expect, it } from 'vitest';
import type { SwarmBranch } from '../../types';
import { filterBranches, projectBranchSections } from './Branches';

function makeBranch(overrides: Partial<SwarmBranch>): SwarmBranch {
  return {
    name: 'feature/default',
    shortName: 'feature/default',
    isCurrent: false,
    merged: false,
    pushed: true,
    ahead: 1,
    lastCommit: {
      hash: 'abc1234',
      message: 'Update branch flow',
      date: '2026-08-20T12:00:00.000Z',
    },
    pr: null,
    ...overrides,
  };
}

describe('filterBranches', () => {
  const branches = [
    makeBranch({
      name: 'feature/current',
      shortName: 'feature/current',
      isCurrent: true,
      lastCommit: {
        hash: 'current1',
        message: 'Current work',
        date: '2026-08-18T12:00:00.000Z',
      },
    }),
    makeBranch({
      name: 'feature/open-newest',
      shortName: 'feature/open-newest',
      lastCommit: {
        hash: 'newest1',
        message: 'Fresh open branch',
        date: '2026-08-21T12:00:00.000Z',
      },
      pr: {
        number: 14,
        url: 'https://example.com/pr/14',
        title: 'Fix branch density',
        state: 'open',
      },
    }),
    makeBranch({
      name: 'feature/merged',
      shortName: 'feature/merged',
      merged: true,
      ahead: 0,
      lastCommit: {
        hash: 'merge111',
        message: 'Merged cleanup',
        date: '2026-08-19T12:00:00.000Z',
      },
    }),
  ];

  it('keeps the current branch first and sorts remaining matches by recent activity', () => {
    expect(filterBranches(branches, '', 'all').map(branch => branch.shortName)).toEqual([
      'feature/current',
      'feature/open-newest',
      'feature/merged',
    ]);
  });

  it('matches search text across branch metadata and PR titles', () => {
    expect(filterBranches(branches, 'density', 'all').map(branch => branch.shortName)).toEqual([
      'feature/open-newest',
    ]);
  });

  it('applies status filtering without mixing merged and open results', () => {
    expect(filterBranches(branches, '', 'merged').map(branch => branch.shortName)).toEqual([
      'feature/merged',
    ]);
    expect(filterBranches(branches, '', 'open').map(branch => branch.shortName)).toEqual([
      'feature/current',
      'feature/open-newest',
    ]);
  });
});

describe('projectBranchSections', () => {
  const branches = [
    makeBranch({
      name: 'feature/open',
      shortName: 'feature/open',
      lastCommit: {
        hash: 'open1111',
        message: 'Open branch',
        date: '2026-08-21T12:00:00.000Z',
      },
    }),
    makeBranch({
      name: 'feature/merged-a',
      shortName: 'feature/merged-a',
      merged: true,
      ahead: 0,
      lastCommit: {
        hash: 'mergeda',
        message: 'Merged a',
        date: '2026-08-20T12:00:00.000Z',
      },
    }),
    makeBranch({
      name: 'feature/merged-b',
      shortName: 'feature/merged-b',
      merged: true,
      ahead: 0,
      lastCommit: {
        hash: 'mergedb',
        message: 'Merged b',
        date: '2026-08-19T12:00:00.000Z',
      },
    }),
  ];

  it('collapses merged branches by default while keeping their count available', () => {
    const sections = projectBranchSections(branches, '', 'all', false, 1);

    expect(sections.openBranches.map(branch => branch.shortName)).toEqual(['feature/open']);
    expect(sections.mergedBranches).toHaveLength(2);
    expect(sections.visibleMergedBranches).toHaveLength(0);
    expect(sections.hiddenMergedCount).toBe(2);
    expect(sections.showMergedBranches).toBe(false);
  });

  it('reveals merged matches when filtering is active', () => {
    const sections = projectBranchSections(branches, 'merged', 'all', false, 1);

    expect(sections.hasActiveFilters).toBe(true);
    expect(sections.showMergedBranches).toBe(true);
    expect(sections.visibleMergedBranches.map(branch => branch.shortName)).toEqual([
      'feature/merged-a',
    ]);
    expect(sections.hiddenMergedCount).toBe(1);
  });
});
