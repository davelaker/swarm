import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  outcomeFromTasks,
  tokenize,
  scoreRelevance,
  selectRelevantSessions,
  formatSessionRecall,
  type SessionRecallEntry,
} from './session-recall.js';

function entry(overrides: Partial<SessionRecallEntry>): SessionRecallEntry {
  return {
    id: 'x',
    savedAt: '2026-08-01T10:00:00.000Z',
    goal: '',
    outcome: 'completed',
    filesChanged: [],
    taskCount: 1,
    ...overrides,
  };
}

test('outcomeFromTasks maps task statuses to a session outcome', () => {
  assert.equal(outcomeFromTasks([{ status: 'done' }, { status: 'skipped' }]), 'completed');
  assert.equal(outcomeFromTasks([{ status: 'done' }, { status: 'failed' }]), 'failed');
  assert.equal(outcomeFromTasks([{ status: 'done' }, { status: 'blocked' }]), 'failed');
  assert.equal(outcomeFromTasks([{ status: 'done' }, { status: 'in_progress' }]), 'partial');
  assert.equal(outcomeFromTasks([]), 'partial');
});

test('tokenize lowercases, splits, and drops short words and stopwords', () => {
  const tokens = tokenize('Fix the Auth redirect in login-flow.ts');
  assert.equal(tokens.has('auth'), true);
  assert.equal(tokens.has('redirect'), true);
  assert.equal(tokens.has('login'), true);
  assert.equal(tokens.has('the'), false);
  assert.equal(tokens.has('fix'), false); // stopword — too generic to signal relevance
  assert.equal(tokens.has('in'), false);
});

test('scoreRelevance weighs file-path overlap double vs goal overlap', () => {
  const q = tokenize('talisman picker bug');
  const goalHit = entry({ goal: 'improve the talisman sorting' });
  const fileHit = entry({ goal: 'unrelated', filesChanged: ['src/talisman/picker.ts'] });
  assert.equal(scoreRelevance(goalHit, q), 1);
  assert.equal(scoreRelevance(fileHit, q), 4); // talisman + picker, ×2 each
  assert.equal(scoreRelevance(entry({ goal: 'nothing shared' }), q), 0);
  assert.equal(scoreRelevance(goalHit, new Set()), 0);
});

test('selectRelevantSessions returns recents plus scored matches, deduped, newest first', () => {
  const a = entry({ id: 'a', savedAt: '2026-08-04T10:00:00Z', goal: 'add dark mode' });
  const b = entry({ id: 'b', savedAt: '2026-08-03T10:00:00Z', goal: 'refactor billing' });
  const c = entry({
    id: 'c',
    savedAt: '2026-07-01T10:00:00Z',
    goal: 'auth session handling',
    filesChanged: ['src/auth/session.ts'],
  });
  const d = entry({ id: 'd', savedAt: '2026-06-01T10:00:00Z', goal: 'update readme' });

  const picked = selectRelevantSessions([a, b, c, d], 'broken auth session cookie');
  assert.deepEqual(
    picked.map(e => e.id),
    ['a', 'b', 'c'], // 2 recents + the relevant auth run; 'd' scores 0 and is dropped
  );
});

test('selectRelevantSessions with no query still returns the recents', () => {
  const a = entry({ id: 'a', savedAt: '2026-08-04T10:00:00Z' });
  const b = entry({ id: 'b', savedAt: '2026-08-03T10:00:00Z' });
  const c = entry({ id: 'c', savedAt: '2026-08-02T10:00:00Z' });
  assert.deepEqual(
    selectRelevantSessions([a, b, c], '').map(e => e.id),
    ['a', 'b'],
  );
});

test('formatSessionRecall renders a bounded, labelled block', () => {
  const block = formatSessionRecall([
    entry({
      savedAt: '2026-08-02T09:00:00Z',
      goal: 'add stripe webhook',
      outcome: 'completed',
      branchName: 'swarm/add-stripe-webhook',
      filesChanged: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts'],
    }),
  ]);
  assert.match(block, /Prior runs on this project/);
  assert.match(block, /2026-08-02 · "add stripe webhook" · completed on swarm\/add-stripe-webhook/);
  assert.match(block, /\(\+2 more\)/); // 8 files, 6 shown
});

test('formatSessionRecall of nothing is empty — no header noise in the prompt', () => {
  assert.equal(formatSessionRecall([]), '');
});
