// Principle 2 — narrow orchestrator↔worker boundary.
// Now driver-agnostic: routes by assignee, delegates to whichever driver
// is active (agent-sdk for Max plan, api-key for console.anthropic.com).
// Phase 5: Negotiator. Phase 6: sandboxed containers.

import type { Task, SwarmState } from '../state/types.js';
import { getDriver } from '../drivers/index.js';
import { loadRoster } from '../state/roster.js';
import { runDeterministicChecks } from '../agents/checks.js';
import { runVisualCheck } from '../agents/visual.js';

export interface TaskResult {
  status: 'done' | 'failed';
  summary: string;
  artifacts?: string[];
  finding?: string; // raw markdown — loop writes to disk
  costUsd?: number;
  inputTokens?: number; // api-key driver only
  outputTokens?: number;
  verdict?: string;
  blocksDone?: boolean;
}

export function idempotencyKey(task: Task): string {
  return `${task.id}:${task.attempts}`;
}

const DONE_VERDICTS = new Set(['COMPLETE', 'PASS', 'APPROVED']);
const BLOCKS_VERDICTS = new Set(['CHANGES_REQUESTED', 'FAIL', 'FAILED']);

export async function dispatch(
  task: Task,
  state: SwarmState,
  worktreePath?: string,
): Promise<TaskResult> {
  const driver = getDriver();

  try {
    switch (task.assignee) {
      case 'coder': {
        const r = await driver.runCoder(task, state, worktreePath);
        return {
          status: r.verdict === 'FAILED' ? 'failed' : 'done',
          summary: r.summary,
          artifacts: r.filesChanged,
          finding: r.findingMarkdown,
          costUsd: r.costUsd,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          verdict: r.verdict,
          blocksDone: false,
        };
      }

      case 'checks': {
        // Deterministic gate — no LLM, no driver. Runs tools and trusts exit codes.
        const r = await runDeterministicChecks(task, state);
        return {
          status: 'done',
          summary: r.summary,
          finding: r.findingMarkdown,
          costUsd: 0,
          verdict: r.verdict,
          blocksDone: BLOCKS_VERDICTS.has(r.verdict),
        };
      }

      case 'visual': {
        // Advisory: renders changed routes in a browser and attaches screenshots.
        const r = await runVisualCheck(task, state);
        return {
          status: 'done',
          summary: r.summary,
          finding: r.findingMarkdown,
          costUsd: 0,
          verdict: r.verdict,
          blocksDone: false,
        };
      }

      case 'tester': {
        const r = await driver.runTester(task, state);
        return {
          status: 'done',
          summary: r.summary,
          finding: r.findingMarkdown,
          costUsd: r.costUsd,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          verdict: r.verdict,
          blocksDone: BLOCKS_VERDICTS.has(r.verdict),
        };
      }

      case 'security': {
        const r = await driver.runSecurity(task, state);
        return {
          status: 'done',
          summary: r.summary,
          finding: r.findingMarkdown,
          costUsd: r.costUsd,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          verdict: r.verdict,
          blocksDone: BLOCKS_VERDICTS.has(r.verdict),
        };
      }

      case 'reviewer': {
        const r = await driver.runReviewer(task, state);
        return {
          status: 'done',
          summary: r.summary,
          finding: r.findingMarkdown,
          costUsd: r.costUsd,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          verdict: r.verdict,
          blocksDone: BLOCKS_VERDICTS.has(r.verdict),
        };
      }

      case 'negotiator':
        // The Negotiator is a runtime deadlock arbiter invoked DIRECTLY by the
        // loop (runLoop → recoverFromDeadlock → driver.runNegotiator), never
        // routed through normal task dispatch. Reaching here is a bug.
        return {
          status: 'failed',
          summary: 'Negotiator is invoked directly by the loop, not dispatched as a task.',
        };

      default: {
        // Marketplace agent — look up from the hired roster.
        const roster = loadRoster();
        const agent = roster.find(a => a.id === task.assignee && a.enabled);
        if (!agent) {
          return {
            status: 'failed',
            summary: `Unknown agent: ${task.assignee} — not found in hired roster`,
          };
        }
        const r = await driver.runMarketplaceAgent(task, state, agent);
        return {
          status: 'done' as const,
          summary: r.summary,
          finding: r.findingMarkdown,
          costUsd: r.costUsd,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          verdict: r.verdict,
          blocksDone: BLOCKS_VERDICTS.has(r.verdict),
        };
      }
    }
  } catch (err) {
    return { status: 'failed', summary: (err as Error).message };
  }
}
