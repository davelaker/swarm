// State schema — see DESIGN.md §6.2 and §6.2a

export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'failed' | 'skipped';

export type Tier = 'bugfix' | 'feature' | 'greenfield' | 'refactor';

export type AgentId = 'pm' | 'coder' | 'tester' | 'security' | 'reviewer' | 'negotiator';

// A lease is acquired when a task moves to in_progress.
// If expires_at passes without a heartbeat the task is eligible for reconcile.
export interface Lease {
  worker: string; // AgentId or marketplace agent id
  started_at: string; // ISO 8601
  heartbeat_at: string;
  expires_at: string;
  attempt_key: string; // `${task_id}:${attempts}` — idempotency key for C3 actions
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  owner: string; // Principle 1 — always "me" today, foreign key tomorrow
  assignee: string; // AgentId or marketplace agent id
  depends_on: string[];
  artifacts: string[];
  result_ref: string | null; // path to findings file
  attempts: number;
  model?: string; // PM-recommended model override for this task
  cost_usd?: number; // accumulated agent cost for this task (api-key driver only)
  lease?: Lease;
  skip_reason?: string; // set when status === 'skipped'; explains why the task was not run
  steer?: string[]; // mid-run user guidance, injected into the agent's prompt when (re)dispatched
}

// A specialist agent hired from the marketplace and persisted in .swarm/roster.json.
export interface RosterEntry {
  id: string;
  name: string;
  prompt: string; // full system prompt from market agent definition
  instructions: string; // user overlay appended to system prompt
  model: string; // claude model id, e.g. 'claude-sonnet-4-6'
  grantedTools: Array<{
    name: string;
    sens: string;
    scope?: string;
    mode?: 'allow' | 'ask';
    sqlCategory?: string;
  }>;
  grantedConnectors: Array<{ server: string; tool: string }>; // MCP connector grants
  enabled: boolean;
  version: string;
}

export interface LogEntry {
  ts: string;
  actor: string;
  event: string;
}

export interface TaskGraphEntry {
  id: string;
  assignee: string; // AgentId or marketplace agent id
  title: string;
  depends_on: string[];
  model?: string; // optional model override recommended by the PM
}

export interface RunCharter {
  constraints: string[];
  nongoals: string[];
  questions: string[];
  branchMode?: 'branch' | 'main';
  branchName?: string; // user-set slug (no swarm/ prefix); auto-derived from goal if absent
  taskGraph?: TaskGraphEntry[];
  planningHistory?: Array<{ from: 'pm' | 'you'; text: string }>;
  deploymentInfo?: string; // written to CLAUDE.md when the first Coder task starts
}

export interface SwarmState {
  project: string;
  owner: string; // Principle 1
  goal: string;
  tier: Tier;
  charter?: RunCharter;
  branchName?: string; // set at run start when charter.branchMode === 'branch'
  updated_at: string;
  tasks: Task[];
  log: LogEntry[];
}

// ─── Events emitted by the state repository ──────────────────────────────────
// These are the same event types the SSE stream forwards to the browser (UX.md §4).

export type SwarmEvent =
  | { type: 'run.classified'; tier: Tier; tasks: Task[] }
  | { type: 'task.created'; task: Task }
  | { type: 'task.status_changed'; task_id: string; status: TaskStatus; skip_reason?: string }
  | { type: 'agent.started'; agent_id: string }
  | { type: 'agent.progress'; agent_id: string; task_id?: string; step: string }
  | { type: 'agent.thinking'; agent_id: string; task_id?: string; text: string }
  | {
      // Appended to a task's transcript on tool start, then refined (matched by id)
      // with a line count when the tool result arrives. task_id keys the transcript
      // to the run so an agent (e.g. coder) that runs several tasks stays separable.
      type: 'agent.tool';
      agent_id: string;
      task_id?: string;
      id: string;
      label?: string;
      tool?: string;
      file?: string;
      detail?: string;
    }
  | { type: 'agent.finished'; agent_id: string }
  | { type: 'finding.written'; task_id: string; path: string; verdict?: string; summary?: string }
  | { type: 'log.appended'; actor: string; event: string }
  | { type: 'run.blocked'; reason: string }
  | { type: 'run.completed' }
  | { type: 'run.cost_updated'; spent: number; cap: number }
  | { type: 'run.paused' }
  | { type: 'run.aborted' }
  | {
      type: 'task.metrics';
      task_id: string;
      agent_id: string;
      input_tokens: number | null;
      output_tokens: number | null;
      cost_usd: number;
      context_pct: number | null;
    }
  | {
      type: 'agent.permission_request';
      request_id: string;
      agent_id: string;
      tool: string;
      input: Record<string, unknown>;
    }
  | { type: 'agent.permission_resolved'; request_id: string; decision: 'allow' | 'deny' };
