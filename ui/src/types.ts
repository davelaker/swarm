export type Surface = 'planning' | 'running' | 'branches' | 'marketplace' | 'history';

export type {
  ProjectEnvelope,
  ProjectContextState,
  ProjectReadiness,
  ProjectRequestContext,
} from './project/types';

export interface BranchPr {
  number: number;
  url: string;
  title: string;
  state: 'open' | 'merged' | 'closed';
}

export interface BranchCommit {
  hash: string;
  shortHash: string;
  message: string;
  date: string;
}

export interface SwarmBranch {
  name: string;
  shortName: string;
  isCurrent: boolean;
  merged: boolean;
  pushed: boolean;
  ahead: number;
  lastCommit: { hash: string; message: string; date: string };
  pr: BranchPr | null;
}

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'changes_requested'
  | 'failed'
  | 'blocked'
  | 'skipped';
export type Verdict = 'complete' | 'pass' | 'changes' | 'fail';
export type RunStatus = 'running' | 'paused' | 'done' | 'aborted';
export type Sensitivity = 'read' | 'write' | 'shell' | 'network';

export interface Persona {
  id: string;
  name: string;
  short: string;
  color: string;
  role: string;
}

export interface Task {
  id: string;
  title: string;
  assignee: string;
  deps: string[];
  lane: number;
  status: TaskStatus;
  late?: boolean;
  skip_reason?: string;
  model?: string; // PM-chosen model for this task
  effort?: string; // PM-chosen reasoning effort for this task
  costUsd?: number; // accumulated agent cost for this task
}

// One entry in an agent's live activity transcript — either a block of extended
// thinking or a single tool-call step. Appended in order; the UI collapses the
// list when the agent finishes and lets the user expand it again.
export interface ActivityEntry {
  kind: 'thinking' | 'tool';
  text: string;
  id?: string; // tool_use id — lets a result event refine the matching tool entry
  tool?: string; // tool name (Read/Edit/Bash/…) — drives the icon + verb
  file?: string; // file path the tool acted on — rendered as a language-badged chip
  detail?: string; // e.g. "127 lines"
}

export interface AgentState {
  active: boolean;
  step: string;
  activeAt: number | null; // Date.now() when agent became active — drives elapsed timer
  verdict: Verdict | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  contextPct: number | null; // % of context window used — api-key only
}

export interface Finding {
  key: string;
  agent: string;
  task: string;
  verdict: Verdict;
  summary: string;
  path?: string; // relative path under .swarm/ — used to fetch full content
  ts?: number; // Date.now() when SSE event arrived; absent for snapshot findings
}

export interface ChatMessage {
  from: 'pm' | 'you' | 'security' | 'system';
  text: string;
  time?: string;
  thinking?: ActivityEntry[]; // PM's thinking + sub-agent steps that preceded this reply (collapsible)
}

export interface PermissionRequest {
  requestId: string;
  agentId: string;
  tool: string;
  input: Record<string, unknown>;
}

export type SqlCategory = 'read' | 'write' | 'delete' | 'destructive';

export interface MarketTool {
  name: string;
  sens: Sensitivity;
  desc: string;
  locked?: boolean;
  scope?: string;
  sqlCategory?: SqlCategory;
}

export interface MarketAgent {
  id: string;
  name: string;
  role: string;
  rating: number;
  version: string;
  desc: string;
  changelog: string;
  prompt: string;
  tools: MarketTool[];
  connectors?: Array<{ id: string; tools: string[] }>;
  color: string;
}

export interface GrantedTool {
  name: string;
  sens: string;
  scope?: string;
  mode?: 'allow' | 'ask';
  sqlCategory?: string;
}

export interface ConnectorGrant {
  server: string; // connector id, e.g. 'supabase'
  tool: string; // tool name, e.g. 'list_tables'
  mode?: 'allow' | 'ask';
}

export interface HiredAgent {
  id: string;
  version: string;
  enabled: boolean;
  grantedTools: GrantedTool[];
  grantedConnectors: ConnectorGrant[];
  model: string; // claude model id, e.g. 'claude-sonnet-4-6'
  instructions: string;
  upgradeAvailable: boolean;
  name?: string; // display label — persisted to roster.json so the PM/loader can name the agent
  prompt?: string; // full system prompt — stored in roster.json for server-side execution
}

export interface CharterData {
  goal: string;
  constraints: Array<{ text: string; resolved?: boolean }>;
  nongoals: Array<{ text: string; resolved?: boolean }>;
  questions: Array<{ text: string; resolved?: boolean }>;
}

export interface SessionMeta {
  id: string;
  savedAt: string;
  project: string;
  goal: string;
  tier: string;
  branchName?: string;
  taskCount: number;
  passCount: number;
  failCount: number;
  elapsedMs?: number;
}

export interface SessionSnapshot {
  id: string;
  savedAt: string;
  project: string;
  goal: string;
  tier: string;
  branchName?: string;
  charter?: {
    constraints: string[];
    nongoals: string[];
    questions: string[];
    branchMode?: string;
    planningHistory?: Array<{ from: 'pm' | 'you'; text: string }>;
  };
  tasks: Array<{
    id: string;
    title: string;
    assignee: string;
    status: string;
    depends_on: string[];
    result_ref: string | null;
    finding_verdict?: string;
    finding_summary?: string;
  }>;
  log: Array<{ ts: string; actor: string; event: string }>;
  elapsedMs?: number;
}

export interface FindingBody {
  type: 'files' | 'note' | 'code';
  label?: string;
  text?: string;
  items?: string[];
  lines?: Array<{ t: 'add' | 'del' | 'cm'; s: string }>;
}

export interface FindingFull {
  label: string;
  body: FindingBody[];
}
