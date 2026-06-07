// Principle 2 — narrow orchestrator↔worker boundary.
// Now driver-agnostic: routes by assignee, delegates to whichever driver
// is active (agent-sdk for Max plan, api-key for console.anthropic.com).
// Phase 5: Negotiator. Phase 6: sandboxed containers.

import type { Task, SwarmState } from '../state/types.js';
import { getDriver } from '../drivers/index.js';

export interface TaskResult {
  status:      'done' | 'failed';
  summary:     string;
  artifacts?:  string[];
  finding?:    string;   // raw markdown — loop writes to disk
  costUsd?:    number;
  verdict?:    string;
  blocksDone?: boolean;
}

export function idempotencyKey(task: Task): string {
  return `${task.id}:${task.attempts}`;
}

const DONE_VERDICTS    = new Set(['COMPLETE', 'PASS', 'APPROVED']);
const BLOCKS_VERDICTS  = new Set(['CHANGES_REQUESTED', 'FAIL', 'FAILED']);

export async function dispatch(task: Task, state: SwarmState): Promise<TaskResult> {
  const driver = getDriver();

  try {
    switch (task.assignee) {
      case 'coder': {
        const r = await driver.runCoder(task, state);
        return {
          status:     r.verdict === 'FAILED' ? 'failed' : 'done',
          summary:    r.summary,
          artifacts:  r.filesChanged,
          finding:    r.findingMarkdown,
          costUsd:    r.costUsd,
          verdict:    r.verdict,
          blocksDone: false,
        };
      }

      case 'tester': {
        const r = await driver.runTester(task, state);
        return {
          status:     'done',
          summary:    r.summary,
          finding:    r.findingMarkdown,
          costUsd:    r.costUsd,
          verdict:    r.verdict,
          blocksDone: BLOCKS_VERDICTS.has(r.verdict),
        };
      }

      case 'security': {
        const r = await driver.runSecurity(task, state);
        return {
          status:     'done',
          summary:    r.summary,
          finding:    r.findingMarkdown,
          costUsd:    r.costUsd,
          verdict:    r.verdict,
          blocksDone: BLOCKS_VERDICTS.has(r.verdict),
        };
      }

      case 'negotiator':
        return { status: 'failed', summary: 'Negotiator not yet implemented (Phase 5).' };

      default:
        return { status: 'failed', summary: `Unknown assignee: ${task.assignee}` };
    }
  } catch (err) {
    return { status: 'failed', summary: (err as Error).message };
  }
}
