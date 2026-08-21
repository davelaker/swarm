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

interface IntakeDecisionBase {
  shape: ExecutionShape;
  rationale: string;
  confidence: IntakeConfidence;
  riskSignals: IntakeRiskSignal[];
  suggestedAction: string;
}

export type AnswerDecision = IntakeDecisionBase & {
  shape: 'answer';
};

export type QuickTaskDecision = IntakeDecisionBase & {
  shape: 'quick_task';
};

export type PlanDecision = IntakeDecisionBase & {
  shape: 'plan';
};

export type CoordinatedRunDecision = IntakeDecisionBase & {
  shape: 'coordinated_run';
};

export type IntakeDecision =
  | AnswerDecision
  | QuickTaskDecision
  | PlanDecision
  | CoordinatedRunDecision;
