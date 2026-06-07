// Principle 2 — narrow orchestrator↔worker boundary.
// Phase 2: Coder, Tester, Security all wired.
// Phase 5: Negotiator. Phase 6: sandboxed containers.

import type { Task, SwarmState } from '../state/types.js';
import { runCoder }    from '../agents/coder.js';
import { runTester }   from '../agents/tester.js';
import { runSecurity } from '../agents/security.js';

export interface TaskResult {
  status:      'done' | 'failed';
  summary:     string;
  artifacts?:  string[];
  finding?:    string;   // raw markdown — loop writes to disk
  costUsd?:    number;
  // Gate metadata returned by reviewer agents for the loop to act on
  verdict?:    string;
  blocksDone?: boolean;
}

export function idempotencyKey(task: Task): string {
  return `${task.id}:${task.attempts}`;
}

export async function dispatch(task: Task, state: SwarmState): Promise<TaskResult> {
  switch (task.assignee) {
    case 'coder': {
      try {
        const r = await runCoder(task, state);
        return {
          status:    'done',
          summary:   r.summary,
          artifacts: r.filesChanged,
          finding:   buildCoderFinding(task, r.summary, r.filesChanged),
          costUsd:   r.costUsd,
          verdict:   'COMPLETE',
          blocksDone: false,
        };
      } catch (err) {
        return { status: 'failed', summary: (err as Error).message };
      }
    }

    case 'tester': {
      try {
        const r = await runTester(task, state);
        return {
          status:    'done',
          summary:   r.summary,
          finding:   r.finding,
          costUsd:   r.costUsd,
          verdict:   r.verdict,
          blocksDone: r.verdict === 'FAIL',
        };
      } catch (err) {
        return { status: 'failed', summary: (err as Error).message };
      }
    }

    case 'security': {
      try {
        const r = await runSecurity(task, state);
        return {
          status:    'done',
          summary:   r.summary,
          finding:   r.finding,
          costUsd:   r.costUsd,
          verdict:   r.verdict,
          blocksDone: r.verdict === 'CHANGES_REQUESTED',
        };
      } catch (err) {
        return { status: 'failed', summary: (err as Error).message };
      }
    }

    case 'negotiator':
      return { status: 'failed', summary: 'Negotiator not yet implemented (Phase 5).' };

    default:
      return { status: 'failed', summary: `Unknown assignee: ${task.assignee}` };
  }
}

function buildCoderFinding(task: Task, summary: string, filesChanged: string[]): string {
  const list = filesChanged.length
    ? filesChanged.map(f => `  - ${f}`).join('\n')
    : '  (none recorded)';
  return [
    '---',
    `task: ${task.id}`,
    `agent: coder`,
    `schema: coder-finding`,
    `verdict: COMPLETE`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    '---',
    '',
    `## ${summary}`,
    '',
    '### Files changed',
    list,
    '',
  ].join('\n');
}
