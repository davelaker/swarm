import type { Task } from '../types';

export const INIT_TASKS: Omit<Task, 'status'>[] = [
  { id: 't1', title: 'Implement /leaderboard command', assignee: 'coder',    deps: [],      lane: 0 },
  { id: 't2', title: 'Write tests for t1',             assignee: 'tester',   deps: ['t1'],  lane: 1 },
  { id: 't3', title: 'Security review of t1',          assignee: 'security', deps: ['t1'],  lane: 0 },
];

export const LATE_TASKS: Omit<Task, 'status'>[] = [
  { id: 't4', title: 'Fix SQL injection (t3)',         assignee: 'coder',    deps: ['t3'],  lane: 0, late: true },
  { id: 't5', title: 'Security re-review of t4',       assignee: 'security', deps: ['t4'],  lane: 0, late: true },
];

export type RunEvent =
  | { at: number; fn: 'task';     id: string; status: string }
  | { at: number; fn: 'agent';    who: string; step: string }
  | { at: number; fn: 'idle';     who: string; verdict: string }
  | { at: number; fn: 'finding';  key: string; agent: string; task: string; verdict: string; summary: string }
  | { at: number; fn: 'addtasks' }
  | { at: number; fn: 'pm';       text: string }
  | { at: number; fn: 'finish' };

export const RUN_SCRIPT: RunEvent[] = [
  { at: 200,   fn: 'task',    id: 't1', status: 'in_progress' },
  { at: 200,   fn: 'agent',   who: 'coder',    step: 'Reading codebase' },
  { at: 1400,  fn: 'agent',   who: 'coder',    step: 'Writing LeaderboardCommand' },
  { at: 2700,  fn: 'agent',   who: 'coder',    step: 'Writing structured findings' },
  { at: 3700,  fn: 'finding', key: 'coder-t1', agent: 'coder',    task: 't1', verdict: 'complete', summary: 'Implemented LeaderboardCommand, 2 files changed' },
  { at: 3700,  fn: 'task',    id: 't1', status: 'done' },
  { at: 3700,  fn: 'idle',    who: 'coder',    verdict: 'complete' },
  { at: 3900,  fn: 'task',    id: 't2', status: 'in_progress' },
  { at: 3900,  fn: 'task',    id: 't3', status: 'in_progress' },
  { at: 3900,  fn: 'agent',   who: 'tester',   step: 'Reading the t1 diff' },
  { at: 3900,  fn: 'agent',   who: 'security', step: 'Static analysis of query path' },
  { at: 5000,  fn: 'agent',   who: 'tester',   step: 'Running suite — 6 tests' },
  { at: 5200,  fn: 'agent',   who: 'security', step: 'Tracing season filter input' },
  { at: 6000,  fn: 'finding', key: 'tester-t2', agent: 'tester',  task: 't2', verdict: 'pass', summary: '6 tests passing' },
  { at: 6000,  fn: 'task',    id: 't2', status: 'done' },
  { at: 6000,  fn: 'idle',    who: 'tester',   verdict: 'pass' },
  { at: 6800,  fn: 'agent',   who: 'security', step: 'Confirming injection vector' },
  { at: 7700,  fn: 'finding', key: 'security-t3', agent: 'security', task: 't3', verdict: 'changes', summary: 'SQL injection in season filter' },
  { at: 7700,  fn: 'task',    id: 't3', status: 'changes_requested' },
  { at: 7700,  fn: 'idle',    who: 'security', verdict: 'changes' },
  { at: 8400,  fn: 'pm',      text: "Security flagged a SQL injection in the season filter (t3). I've created t4 to fix it and t5 to re-review. Coder is on it now." },
  { at: 9100,  fn: 'addtasks' },
  { at: 9800,  fn: 'task',    id: 't4', status: 'in_progress' },
  { at: 9800,  fn: 'agent',   who: 'coder',    step: 'Reading t3 findings' },
  { at: 10900, fn: 'agent',   who: 'coder',    step: 'Parameterizing the season filter' },
  { at: 12000, fn: 'agent',   who: 'coder',    step: 'Writing findings' },
  { at: 12900, fn: 'finding', key: 'coder-t4', agent: 'coder',    task: 't4', verdict: 'complete', summary: 'Parameterized query, prepared statement' },
  { at: 12900, fn: 'task',    id: 't4', status: 'done' },
  { at: 12900, fn: 'idle',    who: 'coder',    verdict: 'complete' },
  { at: 13100, fn: 'task',    id: 't5', status: 'in_progress' },
  { at: 13100, fn: 'agent',   who: 'security', step: 'Re-checking the query path' },
  { at: 14200, fn: 'agent',   who: 'security', step: 'Verifying parameterization' },
  { at: 15100, fn: 'finding', key: 'security-t5', agent: 'security', task: 't5', verdict: 'pass', summary: 'No injection vectors remain' },
  { at: 15100, fn: 'task',    id: 't5', status: 'done' },
  { at: 15100, fn: 'idle',    who: 'security', verdict: 'pass' },
  { at: 15500, fn: 'pm',      text: "All gates are green. /leaderboard passed tests and the security re-review — ready to ship." },
  { at: 15500, fn: 'finish' },
];

export const RUN_TOTAL = 16200;
export const SPEND_CAP = 5.0;
export const SPEND_END = 1.24;

export const STATUS_COLOR: Record<string, string> = {
  pending:           'var(--grey)',
  in_progress:       'var(--blue)',
  done:              'var(--green)',
  changes_requested: 'var(--amber)',
  failed:            'var(--red)',
  blocked:           'var(--amber)',
};

export const STATUS_LABEL: Record<string, string> = {
  pending:           'pending',
  in_progress:       'running',
  done:              'done',
  changes_requested: 'changes',
  failed:            'failed',
  blocked:           'blocked',
};

export const VERDICT_CLASS: Record<string, string> = {
  complete: 'complete',
  pass:     'pass',
  changes:  'changes',
  fail:     'fail',
};

export const VERDICT_LABEL: Record<string, string> = {
  complete: 'COMPLETE',
  pass:     'PASS',
  changes:  'CHANGES_REQUESTED',
  fail:     'FAIL',
};
