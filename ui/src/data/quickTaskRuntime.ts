import type { ActivityEntry, Finding, RunStatus, Task } from '../types';
import type {
  QuickTaskAction,
  QuickTaskCardState,
  QuickTaskCheckStatus,
  QuickTaskFileChange,
  QuickTaskRouteSummary,
} from './quickTask';

export interface QuickTaskRuntimeMetadata {
  request: string;
  declaredWriteScope: string[];
  verificationCommands: string[];
  route?: QuickTaskRouteSummary;
}

export interface QuickTaskRuntimeInput {
  project: string;
  status: RunStatus;
  tasks: Task[];
  findings: Finding[];
  taskActivity: Record<string, ActivityEntry[]>;
  agentSteps: Record<string, string>;
  spend: number;
  metadata: QuickTaskRuntimeMetadata;
  changedFiles: QuickTaskFileChange[];
}

const DEFAULT_ROUTE: QuickTaskRouteSummary = {
  provider: 'anthropic',
  model: 'provider default',
  effort: 'medium',
};

function gateStatus(task: Task | undefined): QuickTaskCheckStatus {
  if (!task) {
    return 'pending';
  }
  if (task.status === 'done') {
    return 'passed';
  }
  if (
    task.status === 'failed' ||
    task.status === 'blocked' ||
    task.status === 'changes_requested'
  ) {
    return 'failed';
  }
  if (task.status === 'in_progress') {
    return 'running';
  }
  if (task.status === 'skipped') {
    return 'skipped';
  }
  return 'pending';
}

function hasFailedTask(tasks: readonly Task[]): boolean {
  return tasks.some(
    task =>
      task.status === 'failed' || task.status === 'blocked' || task.status === 'changes_requested',
  );
}

function verificationState(input: QuickTaskRuntimeInput) {
  const deterministic = input.tasks.find(task => task.assignee === 'checks');
  const visual = input.tasks.find(task => task.assignee === 'visual');
  const commandStatus = gateStatus(deterministic);
  const checks = input.metadata.verificationCommands.map((command, index) => ({
    id: `command-${index}`,
    label: command,
    status: commandStatus,
    detail:
      deterministic?.skip_reason ??
      `Enforced by ${deterministic?.title ?? 'the deterministic gate'}.`,
  }));
  if (visual) {
    checks.push({
      id: 'visual',
      label: 'Visual verification',
      status: gateStatus(visual),
      detail: visual.skip_reason ?? visual.title,
    });
  }
  return checks;
}

function action(
  id: string,
  label: string,
  priority: QuickTaskAction['priority'],
  intent: QuickTaskAction['intent'],
): QuickTaskAction {
  return { id, label, priority, intent };
}

function actionsFor(stage: QuickTaskCardState['stage']): QuickTaskAction[] {
  if (stage === 'ready_for_review') {
    return [
      action('review-diff', 'Review diff', 'primary', 'review'),
      action('full-run', 'Open full run', 'secondary', 'escalate'),
    ];
  }
  if (stage === 'failed' || stage === 'cancelled') {
    return [
      action('review-diff', 'Review diff', 'secondary', 'review'),
      action('full-run', 'Open full run', 'primary', 'escalate'),
    ];
  }
  return [
    action('review-diff', 'Review diff', 'secondary', 'review'),
    action('full-run', 'Open full run', 'secondary', 'escalate'),
    action('cancel-run', 'Cancel run', 'danger', 'dismiss'),
  ];
}

function runtimeStage(input: QuickTaskRuntimeInput): QuickTaskCardState['stage'] {
  if (input.status === 'aborted') {
    return 'cancelled';
  }
  if (hasFailedTask(input.tasks)) {
    return 'failed';
  }
  const coder = input.tasks.find(task => task.assignee === 'coder');
  const gates = input.tasks.filter(
    task => task.assignee === 'checks' || task.assignee === 'visual',
  );
  if (input.status === 'done') {
    return 'ready_for_review';
  }
  if (
    coder?.status === 'done' &&
    gates.some(task => task.status === 'pending' || task.status === 'in_progress')
  ) {
    return 'verifying';
  }
  return 'executing';
}

function currentStep(
  input: QuickTaskRuntimeInput,
  stage: QuickTaskCardState['stage'],
): string | undefined {
  if (stage === 'executing') {
    return input.agentSteps.coder || 'Implementing the bounded change…';
  }
  if (stage === 'verifying') {
    return input.agentSteps.checks || input.agentSteps.visual || 'Running focused verification…';
  }
  return undefined;
}

function summary(
  stage: QuickTaskCardState['stage'],
  files: readonly QuickTaskFileChange[],
): string {
  if (stage === 'ready_for_review') {
    return files.length > 0
      ? 'The bounded change and its enforced checks are complete.'
      : 'The task completed without a visible repository diff.';
  }
  if (stage === 'verifying') {
    return 'The implementation is complete and focused checks are running.';
  }
  if (stage === 'failed') {
    return 'The quick task stopped because an implementation or verification gate failed.';
  }
  if (stage === 'cancelled') {
    return 'The quick task was cancelled.';
  }
  return 'One implementation owner is working inside the approved write scope.';
}

export function projectQuickTaskCard(input: QuickTaskRuntimeInput): QuickTaskCardState {
  const stage = runtimeStage(input);
  const coder = input.tasks.find(task => task.assignee === 'coder');
  const route = input.metadata.route ?? DEFAULT_ROUTE;
  const activity = (input.taskActivity[coder?.id ?? 't_quick'] ?? [])
    .slice(-12)
    .map((entry, index) => ({
      id: entry.id ?? `activity-${index}`,
      label: entry.tool ?? (entry.kind === 'thinking' ? 'Reasoning' : 'Activity'),
      detail: entry.file ? `${entry.text} · ${entry.file}` : entry.text,
    }));
  const base = {
    stage,
    title: coder?.title.split('\n')[0] || input.metadata.request,
    request: input.metadata.request,
    summary: summary(stage, input.changedFiles),
    changedFiles: input.changedFiles,
    verification: verificationState(input),
    actions: actionsFor(stage),
    runDetails: {
      route,
      writeScope: input.metadata.declaredWriteScope,
      verificationCommands: input.metadata.verificationCommands,
      estimatedCost: input.spend > 0 ? `$${input.spend.toFixed(2)} spent` : undefined,
      runLabel: `${input.project}:quick-task`,
      activity,
    },
    scopeLabel: `${input.metadata.declaredWriteScope.length} scoped ${input.metadata.declaredWriteScope.length === 1 ? 'path' : 'paths'}`,
    currentStep: currentStep(input, stage),
  };

  if (stage === 'failed') {
    const finding = input.findings.find(
      item => item.verdict === 'fail' || item.verdict === 'changes',
    );
    return {
      ...base,
      stage,
      escalationReason: finding?.summary ?? 'Open the full run for failure details.',
    };
  }
  return { ...base, stage } as QuickTaskCardState;
}
