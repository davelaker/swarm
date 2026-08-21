import type { ExecutionShape, IntakeDecision, IntakeRiskSignal } from './types.js';

export interface IntakeClassificationInput {
  instruction: string;
  requestedShape?: ExecutionShape;
}

const EXPLICIT_OVERRIDES: ReadonlyArray<{ shape: ExecutionShape; patterns: readonly RegExp[] }> = [
  {
    shape: 'answer',
    patterns: [/^\/ask\b/i],
  },
  {
    shape: 'quick_task',
    patterns: [/^\/do\b/i],
  },
  {
    shape: 'plan',
    patterns: [/^\/plan\b/i],
  },
  {
    shape: 'coordinated_run',
    patterns: [/^\/swarm\b/i],
  },
];

const READ_ONLY_PATTERNS = [
  /\?/,
  /\b(why|what|how|where|which|review|explain|investigate|analyze|analyse|status|summari[sz]e)\b/i,
  /\b(read-only|no code changes|without changing code|without making changes)\b/i,
] as const;

const PLAN_PATTERNS = [
  /\b(plan|planning|brainstorm|approach|options|tradeoffs|roadmap|proposal|spec)\b/i,
  /\b(engineering plan|implementation plan|design doc|architecture)\b/i,
] as const;

const QUICK_TASK_PATTERNS = [
  /\b(fix|update|rename|adjust|tweak|wire|hook up|add|remove|document)\b/i,
  /\b(single|small|minor|contained|bounded|one-file|one file|focused)\b/i,
] as const;

const SECURITY_PATTERNS = [
  /\b(auth|authentication|authorization|permission|access control)\b/i,
  /\b(password|secret|token|api key|credential|oauth)\b/i,
  /\b(sql|query|database|db|crypto|hash|encrypt|decrypt|shell)\b/i,
] as const;

const MIGRATION_PATTERNS = [
  /\b(migration|migrate|backfill|schema|column|table|index|rollout)\b/i,
  /\b(data model|database change|move data)\b/i,
] as const;

const DESTRUCTIVE_PATTERNS = [
  /\b(delete data|drop table|drop column|rewrite history|force push|reset)\b/i,
  /\b(remove .* permanently|destructive|irreversible|rm -rf)\b/i,
] as const;

const DESTRUCTIVE_DELETE_TARGET_PATTERNS = [
  /\bdelete\b(?:\s+\w+){0,6}\s+\b(permanently|forever)\b/i,
  /\bdelete\b(?:\s+the)?(?:\s+(?:old|existing|legacy))?(?:\s+\w+){0,3}\s+\b(data|rows|records|table|tables|history)\b/i,
] as const;

const BROAD_REFACTOR_PATTERNS = [
  /\b(refactor the whole|across the codebase|entire codebase|replace the .* layer)\b/i,
  /\b(overhaul|rewrite|re-architect|new subsystem|permission model|authorization layer)\b/i,
] as const;

const MULTI_STEP_PATTERNS = [
  /\b(and then|as well as|as well|plus)\b/i,
  /\b(frontend and backend|api and ui|server and client|cli and dashboard)\b/i,
  /\b(sub-agents|subagents|multiple agents|parallel tasks)\b/i,
] as const;

function hasPattern(requestText: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(requestText));
}

function collectRiskSignals(requestText: string): IntakeRiskSignal[] {
  const signals: IntakeRiskSignal[] = [];

  if (hasPattern(requestText, SECURITY_PATTERNS)) {
    signals.push('security_sensitive');
  }
  if (hasPattern(requestText, MIGRATION_PATTERNS)) {
    signals.push('migration');
  }
  if (hasDestructiveWording(requestText)) {
    signals.push('destructive_change');
  }
  if (hasPattern(requestText, BROAD_REFACTOR_PATTERNS)) {
    signals.push('broad_refactor');
  }
  if (hasPattern(requestText, MULTI_STEP_PATTERNS)) {
    signals.push('multi_step_delivery');
  }

  return signals;
}

function findExplicitOverride(requestText: string): ExecutionShape | null {
  for (const override of EXPLICIT_OVERRIDES) {
    if (hasPattern(requestText, override.patterns)) {
      return override.shape;
    }
  }

  return null;
}

function isReadOnlyRequest(requestText: string): boolean {
  return hasPattern(requestText, READ_ONLY_PATTERNS) && !hasPattern(requestText, QUICK_TASK_PATTERNS);
}

function isPlanRequest(requestText: string): boolean {
  return hasPattern(requestText, PLAN_PATTERNS);
}

function isQuickTaskRequest(requestText: string): boolean {
  return hasPattern(requestText, QUICK_TASK_PATTERNS);
}

function isHighRisk(signals: readonly IntakeRiskSignal[]): boolean {
  return signals.includes('security_sensitive')
    || signals.includes('migration')
    || signals.includes('destructive_change')
    || signals.includes('broad_refactor');
}

function impliesWrites(requestText: string): boolean {
  return isQuickTaskRequest(requestText)
    || hasDestructiveWording(requestText)
    || hasPattern(requestText, MIGRATION_PATTERNS)
    || hasPattern(requestText, BROAD_REFACTOR_PATTERNS);
}

function hasDestructiveWording(requestText: string): boolean {
  return hasPattern(requestText, DESTRUCTIVE_PATTERNS)
    || hasPattern(requestText, DESTRUCTIVE_DELETE_TARGET_PATTERNS);
}

function withExplicitRiskSignal(
  explicitShape: ExecutionShape | null,
  riskSignals: IntakeRiskSignal[],
): IntakeRiskSignal[] {
  if (explicitShape === null) {
    return riskSignals;
  }

  const explicitSignal = explicitShape === 'answer'
    ? 'explicit_read_only'
    : explicitShape === 'quick_task'
      ? 'explicit_quick_task'
      : explicitShape === 'plan'
        ? 'explicit_plan_request'
        : 'explicit_coordinated_run';

  return [...riskSignals, explicitSignal];
}

function buildDecision(
  shape: ExecutionShape,
  rationale: string,
  confidence: IntakeDecision['confidence'],
  riskSignals: IntakeRiskSignal[],
  suggestedAction: string,
): IntakeDecision {
  return {
    shape,
    rationale,
    confidence,
    riskSignals,
    suggestedAction,
  };
}

function normalizeRequest(requestText: string): string {
  return requestText.trim().replace(/\s+/g, ' ');
}

export function classifyIntake(requestText: string): IntakeDecision {
  const normalized = normalizeRequest(requestText);
  const explicitShape = findExplicitOverride(normalized);
  const baseRiskSignals = collectRiskSignals(normalized);
  const riskSignals = withExplicitRiskSignal(explicitShape, baseRiskSignals);

  if (!normalized) {
    return buildDecision(
      'plan',
      'The request is empty, so Swarm should gather intent before acting.',
      'low',
      ['unclear_scope'],
      'Ask a clarifying question before creating a run or plan.',
    );
  }

  if (explicitShape === 'coordinated_run') {
    return buildDecision(
      'coordinated_run',
      'The request touches risky or broad work that should keep Swarm’s full approval and review flow.',
      'high',
      riskSignals,
      'Compile a reviewed charter and coordinated task graph before making changes.',
    );
  }

  if (explicitShape === 'answer' || isReadOnlyRequest(normalized)) {
    return buildDecision(
      'answer',
      'The request reads as a question or investigation that does not require repository writes.',
      'high',
      riskSignals,
      'Answer directly with evidence and avoid creating a run.',
    );
  }

  if (explicitShape === 'plan' || isPlanRequest(normalized)) {
    return buildDecision(
      'plan',
      'The request is asking for options, sequencing, or design rather than immediate execution.',
      'high',
      riskSignals,
      'Return a plan with decisions, risks, and the next recommended action.',
    );
  }

  if (isHighRisk(riskSignals) && impliesWrites(normalized)) {
    return buildDecision(
      'coordinated_run',
      'The request implies risky or broad repository writes, so Swarm should keep the full approval and review flow.',
      'medium',
      riskSignals,
      'Compile a reviewed charter and coordinated task graph before making changes.',
    );
  }

  if (explicitShape === 'quick_task' || isQuickTaskRequest(normalized)) {
    const confidence = riskSignals.includes('multi_step_delivery') ? 'medium' : 'high';
    return buildDecision(
      'quick_task',
      'The request appears bounded enough for a compact execution path with focused verification.',
      confidence,
      riskSignals,
      'Run a compact one-node task with narrow write scope and deterministic checks.',
    );
  }

  return buildDecision(
    'plan',
    'The request is actionable but still ambiguous about scope, so Swarm should plan before writing.',
    'medium',
    [...riskSignals, 'unclear_scope'],
    'Clarify scope and propose the smallest safe execution shape.',
  );
}

export function classifyRequestedIntake(
  instruction: string,
  requestedShape: ExecutionShape,
): IntakeDecision {
  const prefixedInstruction = requestedShape === 'answer'
    ? `/ask ${instruction}`
    : requestedShape === 'quick_task'
      ? `/do ${instruction}`
      : requestedShape === 'plan'
        ? `/plan ${instruction}`
        : `/swarm ${instruction}`;

  return classifyIntake(prefixedInstruction);
}

export function classifyIntakeInput(input: IntakeClassificationInput): IntakeDecision {
  if (input.requestedShape) {
    return classifyRequestedIntake(input.instruction, input.requestedShape);
  }

  return classifyIntake(input.instruction);
}
