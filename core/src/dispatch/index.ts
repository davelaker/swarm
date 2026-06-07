// Principle 2 — narrow orchestrator↔worker boundary.
// Phase 1: routes to the real Coder agent.
// Phase 2: routes to Tester, Security, Negotiator by assignee.
// Phase 6: workers move into sandboxed containers — swap happens here only.

import type { Task, SwarmState } from '../state/types.js';
import { runCoder, tokensToDollars } from '../agents/coder.js';

export interface TaskResult {
  status:     'done' | 'failed';
  summary:    string;
  result_ref?: string;
  artifacts?:  string[];
  finding?:    string;         // raw finding markdown — loop writes to disk
  costUsd?:    number;
}

// Idempotency key — (task_id, attempt) used to de-duplicate re-dispatches.
// A re-run after a crash must not double-apply dangerous actions (C3).
export function idempotencyKey(task: Task): string {
  return `${task.id}:${task.attempts}`;
}

// The one place the PM hands work to a worker.
export async function dispatch(task: Task, state: SwarmState): Promise<TaskResult> {
  switch (task.assignee) {
    case 'coder': {
      try {
        const result = await runCoder(task, state);
        const finding = buildCoderFinding(task, result.summary, result.filesChanged);
        return {
          status:    'done',
          summary:   result.summary,
          artifacts: result.filesChanged,
          finding,
          costUsd:   result.costUsd,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'failed', summary: msg };
      }
    }

    // Phase 2: tester, security, negotiator
    case 'tester':
    case 'security':
    case 'negotiator':
      return {
        status:  'failed',
        summary: `${task.assignee} agent not yet implemented (Phase 2).`,
      };

    default:
      return {
        status:  'failed',
        summary: `Unknown assignee: ${task.assignee}`,
      };
  }
}

// ─── Finding builder (lives here so loop.ts stays coordination-only) ─────────
// Conforms to DESIGN.md §6.2a — builder finding schema (no gate fields).

function buildCoderFinding(task: Task, summary: string, filesChanged: string[]): string {
  const filesSection = filesChanged.length
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
    filesSection,
    '',
  ].join('\n');
}
