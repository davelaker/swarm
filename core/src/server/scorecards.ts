// Agent scorecards — per-agent track records aggregated across every saved run, so
// the marketplace shows real numbers (tasks run, pass rate, issues caught, $/run)
// instead of a blurb. Derived purely from the session snapshots (single source of
// truth); nothing new is persisted. The aggregation is pure and unit-tested.

import fs from 'node:fs';
import path from 'node:path';
import { sessionsDir } from '../state/repo.js';

export interface Scorecard {
  agent: string;
  tasks: number; // total tasks this agent ran across all sessions
  sessions: number; // distinct runs the agent appeared in
  passes: number; // findings with a passing verdict
  issuesCaught: number; // findings flagging a problem (changes/fail) — real catches
  failures: number; // tasks that errored out (failed/blocked status)
  totalCostUsd: number;
}

interface SnapTask {
  assignee?: string;
  status?: string;
  finding_verdict?: string;
  cost_usd?: number;
}
interface Snap {
  tasks?: SnapTask[];
}

const PASS_VERDICTS = new Set(['COMPLETE', 'PASS', 'APPROVED', 'PASS_WITH_ADVISORY']);
const ISSUE_VERDICTS = new Set(['CHANGES_REQUESTED', 'FAIL', 'FAILED']);

// Pure: fold session snapshots into one scorecard per agent id.
export function aggregateScorecards(snaps: Snap[]): Record<string, Scorecard> {
  const cards: Record<string, Scorecard> = {};
  for (const snap of snaps) {
    const seenThisSession = new Set<string>();
    for (const t of snap.tasks ?? []) {
      const agent = t.assignee;
      if (!agent) {
        continue;
      }
      const card =
        cards[agent] ??
        (cards[agent] = {
          agent,
          tasks: 0,
          sessions: 0,
          passes: 0,
          issuesCaught: 0,
          failures: 0,
          totalCostUsd: 0,
        });
      card.tasks++;
      if (!seenThisSession.has(agent)) {
        card.sessions++;
        seenThisSession.add(agent);
      }
      card.totalCostUsd += typeof t.cost_usd === 'number' ? t.cost_usd : 0;
      const verdict = (t.finding_verdict ?? '').toUpperCase();
      if (PASS_VERDICTS.has(verdict)) {
        card.passes++;
      } else if (ISSUE_VERDICTS.has(verdict)) {
        card.issuesCaught++;
      }
      if (t.status === 'failed' || t.status === 'blocked') {
        card.failures++;
      }
    }
  }
  return cards;
}

// Read every session snapshot's index.json (best-effort) for aggregation.
function loadSnapshots(): Snap[] {
  const dir = sessionsDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const snaps: Snap[] = [];
  for (const name of entries) {
    try {
      const raw = fs.readFileSync(path.join(dir, name, 'index.json'), 'utf8');
      snaps.push(JSON.parse(raw));
    } catch {
      /* not a session dir / unreadable — skip */
    }
  }
  return snaps;
}

export function buildScorecards(): Record<string, Scorecard> {
  return aggregateScorecards(loadSnapshots());
}
