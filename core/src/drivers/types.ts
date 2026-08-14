// Shared interface for all agent drivers.
// The driver is the implementation detail — loop.ts and dispatch/index.ts
// don't care whether workers run via the Anthropic Client SDK (API key)
// or via the Claude Agent SDK (Max plan subscription).

import type { Task, SwarmState, RosterEntry } from '../state/types.js';

export interface SecurityFinding {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  type: string;
  location: string;
  attack_path: string; // entry point → data flow → impact
  fix: string;
}

export interface ReviewerFinding {
  id: string; // REV-N
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  category: 'correctness' | 'robustness' | 'design' | 'testability' | 'clarity';
  location: string;
  issue: string; // quoted offending code + explanation
  fix: string;
}

export interface DriverResult {
  verdict: string; // COMPLETE | PASS | FAIL | APPROVED | CHANGES_REQUESTED
  summary: string;
  filesChanged: string[];
  securityFindings: SecurityFinding[];
  reviewerFindings: ReviewerFinding[];
  findingMarkdown: string; // ready to write to disk
  costUsd?: number; // undefined = covered by subscription
  inputTokens?: number; // api-key driver only — not available from claude -p
  outputTokens?: number;
}

// ─── Negotiator — runtime deadlock arbiter ───────────────────────────────────
// Invoked directly by the loop (not dispatched as a task) when the run is stuck
// on a blocking gate finding. Read-only; returns a structured recovery decision.

export interface NegotiatorDecision {
  decision: 'SPAWN_FIX' | 'DOWNGRADE' | 'ABORT';
  targetTaskIds: string[]; // the blocked gate task(s) this applies to
  reasoning: string; // 1-3 sentences, user-facing
}

export interface DeadlockContext {
  goal: string;
  blocked: Array<{
    taskId: string;
    assignee: string;
    title: string;
    verdict: string;
    summary: string;
    findingPath: string | null;
  }>;
  tasks: Task[];
}

export interface AgentDriver {
  name: string;
  runCoder(task: Task, state: SwarmState, worktreePath?: string): Promise<DriverResult>;
  runTester(task: Task, state: SwarmState): Promise<DriverResult>;
  runSecurity(task: Task, state: SwarmState): Promise<DriverResult>;
  runReviewer(task: Task, state: SwarmState): Promise<DriverResult>;
  runMarketplaceAgent(task: Task, state: SwarmState, agent: RosterEntry): Promise<DriverResult>;
  runNegotiator(ctx: DeadlockContext): Promise<NegotiatorDecision>;
  // Read-only codebase investigator for the PM planning session. Invoked directly
  // from the PM flow (like the Negotiator from the loop) — NOT dispatched as a task,
  // NOT run in a worktree. Answers one specific question with a factual digest.
  runScout(question: string): Promise<ScoutResult>;
  // Read-only research by a HIRED marketplace specialist during PM planning.
  // Like runScout but runs as the specialist with its own (read-only) tool grants,
  // so a data-access specialist can run live read-only queries the generic Scout
  // cannot. Invoked directly from the PM flow — NOT dispatched, NOT in a worktree.
  runSpecialistResearch(agent: RosterEntry, question: string): Promise<ScoutResult>;
  // Read-only "scribe": after a run, distil durable, non-obvious facts the team
  // learned (conventions, gotchas, constraints) into the project's memory. Invoked
  // directly from the loop on completion — NOT dispatched, NOT in a worktree.
  runScribe(ctx: ScribeContext): Promise<ScribeResult>;
  // Documentation scribe: after a run that changed files, update the project's
  // HUMAN-facing docs (README, docs/**) if externally observable behaviour changed.
  // May edit markdown; loop.ts enforces the doc-only boundary afterwards by
  // reverting anything outside living-docs.ts rules (MEMORY.md). Invoked directly
  // from the loop on completion — NOT dispatched, NOT in a worktree.
  runDocsScribe(ctx: DocsScribeContext): Promise<DocsScribeResult>;
  // Live service context gatherer for PM intake: queries the given read-only
  // connector tools (Sentry issues, deploy status, tickets…) and returns a bounded
  // digest of the project's live surroundings. Tool list is computed from roster
  // grants by pm/live-context.ts — this method never widens it. Invoked in the
  // background from the PM flow — NOT dispatched, NOT in a worktree.
  runLiveContextScout(brief: string, allowedTools: string[]): Promise<ScoutResult>;
}

export interface ScoutResult {
  summary: string;
  digest: string;
  relevantFiles: string[];
  costUsd?: number;
}

export interface ScribeContext {
  goal: string;
  constraints: string[];
  nongoals: string[];
  findings: Array<{ task: string; agent: string; verdict: string; summary: string }>;
  filesChanged: string[];
  existingMemory: string; // current managed memory body, so the scribe merges + dedupes
}

export interface ScribeResult {
  learnings: string; // full merged memory body as markdown bullets (empty = nothing to record)
  costUsd?: number;
}

export interface DocsScribeContext {
  goal: string;
  tier: string;
  findings: Array<{ task: string; agent: string; verdict: string; summary: string }>;
  filesChanged: string[];
  docFiles: string[]; // existing documentation files (repo-relative) the scribe may update
}

export interface DocsScribeResult {
  updatedFiles: string[]; // repo-relative doc paths the scribe says it edited (loop verifies via git)
  summary: string; // one line: what changed in the docs, or why nothing needed changing
  costUsd?: number;
}

// Re-export RosterEntry so callers can import it from this module too.
export type { RosterEntry };
