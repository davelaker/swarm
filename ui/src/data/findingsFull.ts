import type { FindingFull } from '../types';

export const FINDINGS_FULL: Record<string, FindingFull> = {
  'coder-t1': {
    label: '2 files changed',
    body: [
      { type: 'files', items: ['src/commands/leaderboard.ts', 'src/db/queries/ranking.ts'] },
      {
        type: 'note',
        label: 'Summary',
        text: 'Added LeaderboardCommand. Reads the top 100 from `matches`, joins player profiles, paginates 10 per page with prev/next buttons. Reuses the existing Elo calculation.',
      },
      {
        type: 'code',
        label: 'queries/ranking.ts',
        lines: [
          { t: 'cm', s: '// season filter is interpolated for now — flagged for review' },
          { t: 'del', s: "const q = `SELECT * FROM matches WHERE season = '${season}'`" },
        ],
      },
    ],
  },
  'tester-t2': {
    label: '6 tests passing',
    body: [
      { type: 'note', label: 'Suite', text: 'leaderboard.test.ts · 6 passed · 0 failed · 412ms' },
      {
        type: 'code',
        label: 'results',
        lines: [
          { t: 'add', s: '✓ ranks players by descending Elo' },
          { t: 'add', s: '✓ caps results at 100 rows' },
          { t: 'add', s: '✓ paginates 10 per page' },
          { t: 'add', s: '✓ tied players share a rank' },
          { t: 'add', s: '✓ empty season returns a friendly message' },
          { t: 'add', s: '✓ page overflow clamps to last page' },
        ],
      },
    ],
  },
  'security-t3': {
    label: '1 critical · query path',
    body: [
      {
        type: 'note',
        label: 'Vulnerability',
        text: 'The season filter is interpolated directly into SQL. A crafted season value escapes the string literal — classic SQL injection on a user-controlled parameter.',
      },
      {
        type: 'code',
        label: 'src/db/queries/ranking.ts:14',
        lines: [
          { t: 'del', s: "const q = `SELECT * FROM matches WHERE season = '${season}'`" },
          { t: 'cm', s: "// exploit: season = \"2024' OR '1'='1\"" },
          { t: 'add', s: '// recommended: parameterized query, season as $1' },
        ],
      },
      {
        type: 'note',
        label: 'Gate',
        text: 'Blocks t1 from reaching done. Requires a fix task before the leaderboard can ship.',
      },
    ],
  },
  'coder-t4': {
    label: '1 file changed',
    body: [
      { type: 'files', items: ['src/db/queries/ranking.ts'] },
      {
        type: 'note',
        label: 'Fix',
        text: 'Replaced string interpolation with a parameterized query. Season is now bound as `$1` via a prepared statement — no user input touches the SQL text.',
      },
      {
        type: 'code',
        label: 'queries/ranking.ts:14',
        lines: [
          { t: 'del', s: "const q = `SELECT * FROM matches WHERE season = '${season}'`" },
          { t: 'add', s: "const q = 'SELECT * FROM matches WHERE season = $1'" },
          { t: 'add', s: 'const rows = await db.query(q, [season])' },
        ],
      },
    ],
  },
  'security-t5': {
    label: '0 findings',
    body: [
      {
        type: 'note',
        label: 'Re-review',
        text: 'Season filter is now bound as a parameter. Traced the full query path — no remaining injection vectors. Input validation and the prepared statement both hold.',
      },
      {
        type: 'note',
        label: 'Gate',
        text: 'Security gate PASSED. t4 cleared — all dependent tasks may complete.',
      },
    ],
  },
};
