// Session recall — episodic memory at PM intake (docs/MEMORY.md).
// Turns the .swarm/sessions/ archive into context the PM actually uses: compact
// summaries of prior runs, scored for relevance against the user's current
// message, formatted as a bounded block for the planning prompt.
//
// Scoring and selection are pure functions (unit-tested); only loadSessionRecall
// touches the filesystem, best-effort.

import fs from 'node:fs';
import path from 'node:path';
import { sessionsDir } from './repo.js';

export type SessionOutcome = 'completed' | 'failed' | 'partial';

export interface SessionRecallEntry {
  id: string;
  savedAt: string; // ISO timestamp
  goal: string;
  branchName?: string;
  outcome: SessionOutcome;
  filesChanged: string[];
  taskCount: number;
}

interface SnapshotTask {
  status?: string;
  assignee?: string;
  artifacts?: string[];
}

export function outcomeFromTasks(tasks: Array<{ status?: string }>): SessionOutcome {
  if (!tasks.length) {
    return 'partial';
  }
  if (tasks.some(t => t.status === 'failed' || t.status === 'blocked')) {
    return 'failed';
  }
  return tasks.every(t => t.status === 'done' || t.status === 'skipped') ? 'completed' : 'partial';
}

// Read all session snapshots, newest first. Unreadable/malformed snapshots are
// skipped — recall is best-effort and must never break planning.
export function loadSessionRecall(): SessionRecallEntry[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(sessionsDir());
  } catch {
    return []; // no sessions yet
  }

  const entries: SessionRecallEntry[] = [];
  for (const id of ids) {
    try {
      const raw = fs.readFileSync(path.join(sessionsDir(), id, 'index.json'), 'utf8');
      const snap = JSON.parse(raw) as {
        savedAt?: string;
        goal?: string;
        branchName?: string;
        tasks?: SnapshotTask[];
      };
      const tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
      entries.push({
        id,
        savedAt: String(snap.savedAt ?? ''),
        goal: String(snap.goal ?? ''),
        branchName: snap.branchName ? String(snap.branchName) : undefined,
        outcome: outcomeFromTasks(tasks),
        filesChanged: [
          ...new Set(tasks.filter(t => t.assignee === 'coder').flatMap(t => t.artifacts ?? [])),
        ],
        taskCount: tasks.length,
      });
    } catch {
      /* skip malformed snapshot */
    }
  }
  entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return entries;
}

// ─── Relevance scoring (pure) ────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'when',
  'then',
  'them',
  'they',
  'have',
  'has',
  'was',
  'were',
  'will',
  'would',
  'should',
  'could',
  'can',
  'not',
  'but',
  'are',
  'you',
  'your',
  'our',
  'its',
  'it',
  'about',
  'add',
  'fix',
  'make',
  'use',
  'new',
  'get',
  'set',
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

// Overlap between the query and a session's goal + touched file paths.
// File-path hits weigh double: touching the same files is a much stronger
// signal of relevance than sharing goal vocabulary.
export function scoreRelevance(entry: SessionRecallEntry, queryTokens: Set<string>): number {
  if (!queryTokens.size) {
    return 0;
  }
  let score = 0;
  const goalTokens = tokenize(entry.goal);
  for (const t of queryTokens) {
    if (goalTokens.has(t)) {
      score += 1;
    }
  }
  const fileTokens = tokenize(entry.filesChanged.join(' '));
  for (const t of queryTokens) {
    if (fileTokens.has(t)) {
      score += 2;
    }
  }
  return score;
}

// Up to `maxRecent` most recent sessions (continuity) plus up to `maxRelevant`
// highest-scoring others (relevance), deduped, most recent first.
export function selectRelevantSessions(
  entries: SessionRecallEntry[],
  queryText: string,
  limits: { maxRecent: number; maxRelevant: number } = { maxRecent: 2, maxRelevant: 3 },
): SessionRecallEntry[] {
  const queryTokens = tokenize(queryText);
  const recent = entries.slice(0, limits.maxRecent);
  const recentIds = new Set(recent.map(e => e.id));
  const relevant = entries
    .filter(e => !recentIds.has(e.id))
    .map(e => ({ e, score: scoreRelevance(e, queryTokens) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limits.maxRelevant)
    .map(x => x.e);
  return [...recent, ...relevant].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

// ─── Prompt formatting (pure) ────────────────────────────────────────────────

const MAX_FILES_SHOWN = 6;

export function formatSessionRecall(entries: SessionRecallEntry[]): string {
  if (!entries.length) {
    return '';
  }
  const lines = entries.map(e => {
    const date = e.savedAt.slice(0, 10) || 'unknown date';
    const branch = e.branchName ? ` on ${e.branchName}` : '';
    const shown = e.filesChanged.slice(0, MAX_FILES_SHOWN);
    const more = e.filesChanged.length - shown.length;
    const files = shown.length
      ? ` · files: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`
      : '';
    return `- ${date} · "${e.goal}" · ${e.outcome}${branch}${files}`;
  });
  return (
    `Prior runs on this project (episodic memory — what happened, not necessarily what the code looks like now):\n` +
    lines.join('\n')
  );
}
