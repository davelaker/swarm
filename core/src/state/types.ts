// State schema — see DESIGN.md §6.2 and §6.2a

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'failed';

export type Tier = 'tweak' | 'feature' | 'greenfield';

export type AgentId =
  | 'pm'
  | 'coder'
  | 'tester'
  | 'security'
  | 'reviewer'
  | 'negotiator';

// A lease is acquired when a task moves to in_progress.
// If expires_at passes without a heartbeat the task is eligible for reconcile.
export interface Lease {
  worker:       AgentId;
  started_at:   string; // ISO 8601
  heartbeat_at: string;
  expires_at:   string;
  attempt_key:  string; // `${task_id}:${attempts}` — idempotency key for C3 actions
}

export interface Task {
  id:          string;
  title:       string;
  status:      TaskStatus;
  owner:       string; // Principle 1 — always "me" today, foreign key tomorrow
  assignee:    AgentId;
  depends_on:  string[];
  artifacts:   string[];
  result_ref:  string | null; // path to findings file
  attempts:    number;
  lease?:      Lease;
}

export interface LogEntry {
  ts:    string;
  actor: string;
  event: string;
}

export interface RunCharter {
  constraints: string[];
  nongoals:    string[];
  questions:   string[];
}

export interface SwarmState {
  project:    string;
  owner:      string; // Principle 1
  goal:       string;
  tier:       Tier;
  charter?:   RunCharter;
  updated_at: string;
  tasks:      Task[];
  log:        LogEntry[];
}

// ─── Events emitted by the state repository ──────────────────────────────────
// These are the same event types the SSE stream forwards to the browser (UX.md §4).

export type SwarmEvent =
  | { type: 'run.classified';      tier: Tier; tasks: Task[] }
  | { type: 'task.created';        task: Task }
  | { type: 'task.status_changed'; task_id: string; status: TaskStatus }
  | { type: 'agent.started';       agent_id: string }
  | { type: 'agent.progress';      agent_id: string; step: string }
  | { type: 'agent.finished';      agent_id: string }
  | { type: 'finding.written';     task_id: string; path: string; verdict?: string; summary?: string }
  | { type: 'log.appended';        actor: string; event: string }
  | { type: 'run.blocked';         reason: string }
  | { type: 'run.completed' }
  | { type: 'run.cost_updated';   spent: number; cap: number }
  | { type: 'run.paused' }
  | { type: 'run.aborted' }
  | { type: 'task.metrics'; task_id: string; agent_id: string; input_tokens: number | null; output_tokens: number | null; cost_usd: number; context_pct: number | null };
