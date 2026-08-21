export type ExecutionShape = 'answer' | 'quick_task' | 'plan' | 'coordinated_run';

export type IntakeConfidence = 'high' | 'medium' | 'low';

export type IntakeRiskSignal =
  | 'broad_refactor'
  | 'destructive_change'
  | 'explicit_coordinated_run'
  | 'explicit_plan_request'
  | 'explicit_quick_task'
  | 'explicit_read_only'
  | 'migration'
  | 'multi_step_delivery'
  | 'security_sensitive'
  | 'unclear_scope';

export interface IntakeDecision {
  shape: ExecutionShape;
  rationale: string;
  confidence: IntakeConfidence;
  riskSignals: IntakeRiskSignal[];
  suggestedAction: string;
}

export const EXECUTION_SHAPES: ExecutionShape[] = [
  'answer',
  'quick_task',
  'plan',
  'coordinated_run',
];

export const EXECUTION_SHAPE_LABELS: Record<ExecutionShape, string> = {
  answer: 'Answer',
  quick_task: 'Quick task',
  plan: 'Plan',
  coordinated_run: 'Coordinated run',
};

export const EXECUTION_SHAPE_DESCRIPTIONS: Record<ExecutionShape, string> = {
  answer: 'Respond directly without repository writes.',
  quick_task: 'Run a bounded implementation path with focused checks.',
  plan: 'Clarify approach, risks, and sequencing before changes.',
  coordinated_run: 'Use the full Swarm charter, agents, approvals, and review path.',
};

export const INTAKE_CONFIDENCE_LABELS: Record<IntakeConfidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

export const INTAKE_RISK_SIGNAL_LABELS: Record<IntakeRiskSignal, string> = {
  broad_refactor: 'Broad refactor',
  destructive_change: 'Destructive change',
  explicit_coordinated_run: 'Explicit coordinated run',
  explicit_plan_request: 'Explicit plan request',
  explicit_quick_task: 'Explicit quick task',
  explicit_read_only: 'Explicit read-only',
  migration: 'Migration',
  multi_step_delivery: 'Multi-step delivery',
  security_sensitive: 'Security-sensitive',
  unclear_scope: 'Unclear scope',
};

export function isExecutionShape(value: unknown): value is ExecutionShape {
  return typeof value === 'string' && EXECUTION_SHAPES.includes(value as ExecutionShape);
}

export function isIntakeConfidence(value: unknown): value is IntakeConfidence {
  return value === 'high' || value === 'medium' || value === 'low';
}

export function isIntakeRiskSignal(value: unknown): value is IntakeRiskSignal {
  return typeof value === 'string' && value in INTAKE_RISK_SIGNAL_LABELS;
}
