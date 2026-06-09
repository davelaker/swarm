export type Surface = 'planning' | 'running' | 'marketplace';

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'changes_requested' | 'failed' | 'blocked';
export type Verdict = 'complete' | 'pass' | 'changes' | 'fail';
export type RunStatus = 'running' | 'paused' | 'done' | 'aborted';
export type Sensitivity = 'read' | 'write' | 'shell' | 'network';
export type Provenance = 'first' | 'community' | 'private';

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
}

export interface AgentState {
  active:       boolean;
  step:         string;
  activeAt:     number | null;   // Date.now() when agent became active — drives elapsed timer
  verdict:      Verdict | null;
  inputTokens:  number | null;
  outputTokens: number | null;
  costUsd:      number | null;
  contextPct:   number | null;   // % of context window used — api-key only
}

export interface Finding {
  key:     string;
  agent:   string;
  task:    string;
  verdict: Verdict;
  summary: string;
  path?:   string;   // relative path under .swarm/ — used to fetch full content
  ts?:     number;   // Date.now() when SSE event arrived; absent for snapshot findings
}

export interface ChatMessage {
  from: 'pm' | 'you' | 'security' | 'system';
  text: string;
  time?: string;
}

export interface MarketTool {
  name: string;
  sens: Sensitivity;
  desc: string;
  locked?: boolean;
  scope?: string;
}

export interface MarketAgent {
  id: string;
  name: string;
  role: string;
  prov: Provenance;
  rating: number;
  version: string;
  desc: string;
  changelog: string;
  prompt: string;
  tools: MarketTool[];
  routing: Array<string[]>;
  tiers: string[];
  color: string;
}

export interface HiredAgent {
  id: string;
  version: string;
  enabled: boolean;
  grantedTools: string[];
  tiers: string[];
  model: string;
  instructions: string;
  upgradeAvailable: boolean;
}

export interface CharterData {
  goal: string;
  constraints: Array<{ text: string; resolved?: boolean }>;
  nongoals: Array<{ text: string; resolved?: boolean }>;
  questions: Array<{ text: string; resolved?: boolean }>;
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
