export type QuickTaskStage =
  | 'draft'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'ready_for_review'
  | 'committed'
  | 'needs_escalation'
  | 'failed'
  | 'cancelled';

export type QuickTaskPriority = 'primary' | 'secondary' | 'danger';
export type QuickTaskActionIntent = 'execute' | 'review' | 'commit' | 'escalate' | 'dismiss';
export type QuickTaskFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export type QuickTaskCheckStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export type QuickTaskActivityTone = 'neutral' | 'success' | 'warning' | 'error';

export type QuickTaskStartResult =
  { status: 'started' } | { status: 'escalated'; escalationReason: string; riskSignals: string[] };

export interface QuickTaskAction {
  id: string;
  label: string;
  priority: QuickTaskPriority;
  intent: QuickTaskActionIntent;
  disabled?: boolean;
}

export interface QuickTaskFileChange {
  path: string;
  status: QuickTaskFileStatus;
  additions: number;
  deletions: number;
  summary: string;
}

export interface QuickTaskVerificationCheck {
  id: string;
  label: string;
  status: QuickTaskCheckStatus;
  detail: string;
}

export interface QuickTaskActivityEntry {
  id: string;
  label: string;
  detail: string;
  tone?: QuickTaskActivityTone;
}

export interface QuickTaskRouteSummary {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  provider: 'anthropic' | 'openai';
}

export interface QuickTaskRunDetails {
  route: QuickTaskRouteSummary;
  writeScope: string[];
  verificationCommands: string[];
  estimatedCost?: string;
  runLabel: string;
  activity: QuickTaskActivityEntry[];
}

interface QuickTaskBase {
  stage: QuickTaskStage;
  title: string;
  request: string;
  summary: string;
  changedFiles: QuickTaskFileChange[];
  verification: QuickTaskVerificationCheck[];
  actions: QuickTaskAction[];
  runDetails: QuickTaskRunDetails;
  scopeLabel?: string;
  escalationReason?: string;
  currentStep?: string;
}

export interface QuickTaskDraftState extends QuickTaskBase {
  stage: 'draft';
}

export interface QuickTaskAwaitingApprovalState extends QuickTaskBase {
  stage: 'awaiting_approval';
}

export interface QuickTaskExecutingState extends QuickTaskBase {
  stage: 'executing';
  currentStep: string;
}

export interface QuickTaskVerifyingState extends QuickTaskBase {
  stage: 'verifying';
  currentStep: string;
}

export interface QuickTaskReadyForReviewState extends QuickTaskBase {
  stage: 'ready_for_review';
}

export interface QuickTaskCommittedState extends QuickTaskBase {
  stage: 'committed';
}

export interface QuickTaskNeedsEscalationState extends QuickTaskBase {
  stage: 'needs_escalation';
  escalationReason: string;
}

export interface QuickTaskFailedState extends QuickTaskBase {
  stage: 'failed';
  escalationReason?: string;
}

export interface QuickTaskCancelledState extends QuickTaskBase {
  stage: 'cancelled';
}

export type QuickTaskCardState =
  | QuickTaskDraftState
  | QuickTaskAwaitingApprovalState
  | QuickTaskExecutingState
  | QuickTaskVerifyingState
  | QuickTaskReadyForReviewState
  | QuickTaskCommittedState
  | QuickTaskNeedsEscalationState
  | QuickTaskFailedState
  | QuickTaskCancelledState;

export const QUICK_TASK_STAGE_LABELS: Record<QuickTaskStage, string> = {
  draft: 'Draft',
  awaiting_approval: 'Awaiting approval',
  executing: 'Executing',
  verifying: 'Verifying',
  ready_for_review: 'Ready for review',
  committed: 'Committed',
  needs_escalation: 'Needs escalation',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const QUICK_TASK_STAGE_TONES: Record<
  QuickTaskStage,
  'neutral' | 'info' | 'success' | 'warning' | 'danger'
> = {
  draft: 'neutral',
  awaiting_approval: 'info',
  executing: 'info',
  verifying: 'info',
  ready_for_review: 'success',
  committed: 'success',
  needs_escalation: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
};

export function countVerificationResults(checks: QuickTaskVerificationCheck[]): {
  passed: number;
  failed: number;
  running: number;
} {
  return checks.reduce(
    (summary, check) => {
      if (check.status === 'passed') {
        summary.passed += 1;
      }
      if (check.status === 'failed') {
        summary.failed += 1;
      }
      if (check.status === 'running') {
        summary.running += 1;
      }
      return summary;
    },
    { passed: 0, failed: 0, running: 0 },
  );
}

export function diffSummary(files: QuickTaskFileChange[]): string {
  if (files.length === 0) {
    return 'No code changes yet.';
  }
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const label = files.length === 1 ? 'file changed' : 'files changed';
  return `${files.length} ${label} · +${additions} −${deletions}`;
}

export function isQuickTaskTerminal(stage: QuickTaskStage): boolean {
  return (
    stage === 'committed' ||
    stage === 'failed' ||
    stage === 'cancelled' ||
    stage === 'needs_escalation'
  );
}

export const QUICK_TASK_DEMO_STATES: QuickTaskCardState[] = [
  {
    stage: 'draft',
    title: 'Fix reconnect banner',
    request: 'Fix the reconnect banner staying visible after the websocket recovers.',
    summary: 'Contained UI bug affecting reconnect state display.',
    changedFiles: [],
    verification: [],
    actions: [
      { id: 'do', label: 'Do it', priority: 'primary', intent: 'execute' },
      { id: 'approach', label: 'Show approach', priority: 'secondary', intent: 'review' },
      { id: 'workflow', label: 'Use full workflow', priority: 'secondary', intent: 'escalate' },
    ],
    runDetails: {
      runLabel: 'qt_1042',
      route: { provider: 'openai', model: 'GPT-5.4', effort: 'low' },
      writeScope: ['ui/src/hooks/**', 'ui/src/components/**'],
      verificationCommands: ['npm run typecheck', 'npm test -- reconnect'],
      estimatedCost: '$0.09',
      activity: [
        { id: 'scan', label: 'Preflight', detail: 'Scoped likely changes to reconnect UI state.' },
      ],
    },
    scopeLabel: 'Bounded UI fix',
  },
  {
    stage: 'awaiting_approval',
    title: 'Fix reconnect banner',
    request: 'Fix the reconnect banner staying visible after the websocket recovers.',
    summary: 'Write scope and focused checks are ready for approval.',
    changedFiles: [],
    verification: [],
    actions: [
      { id: 'approve', label: 'Approve quick task', priority: 'primary', intent: 'execute' },
      { id: 'expand', label: 'Review expanded plan', priority: 'secondary', intent: 'review' },
      { id: 'cancel', label: 'Cancel', priority: 'secondary', intent: 'dismiss' },
    ],
    runDetails: {
      runLabel: 'qt_1042',
      route: { provider: 'openai', model: 'GPT-5.4', effort: 'low' },
      writeScope: ['ui/src/hooks/useReconnect.ts', 'ui/src/components/common/**'],
      verificationCommands: ['npm run typecheck', 'npm test -- reconnect'],
      estimatedCost: '$0.09',
      activity: [
        {
          id: 'scope',
          label: 'Scope approved',
          detail: 'Only the reconnect hook and banner surface are expected to change.',
        },
      ],
    },
    scopeLabel: '2 files expected',
  },
  {
    stage: 'executing',
    title: 'Fix reconnect banner',
    request: 'Fix the reconnect banner staying visible after the websocket recovers.',
    summary: 'Updating reconnect lifecycle and banner visibility conditions.',
    changedFiles: [
      {
        path: 'ui/src/hooks/useReconnect.ts',
        status: 'modified',
        additions: 18,
        deletions: 6,
        summary: 'Reset the stale banner state when a healthy socket heartbeat lands.',
      },
    ],
    verification: [
      {
        id: 'typecheck',
        label: 'Typecheck',
        status: 'pending',
        detail: 'Queued after the edit lands.',
      },
    ],
    actions: [
      { id: 'review', label: 'Review diff', priority: 'secondary', intent: 'review' },
      { id: 'cancel', label: 'Cancel run', priority: 'secondary', intent: 'dismiss' },
    ],
    runDetails: {
      runLabel: 'qt_1042',
      route: { provider: 'openai', model: 'GPT-5.4', effort: 'low' },
      writeScope: [
        'ui/src/hooks/useReconnect.ts',
        'ui/src/components/common/StaleServerBanner.tsx',
      ],
      verificationCommands: ['npm run typecheck', 'npm test -- reconnect'],
      estimatedCost: '$0.12',
      activity: [
        {
          id: 'inspect',
          label: 'Inspecting reconnect state',
          detail: 'Tracing the transition from degraded to healthy connection.',
        },
        {
          id: 'edit',
          label: 'Editing useReconnect.ts',
          detail: 'Moving banner reset logic to the socket recovery branch.',
        },
      ],
    },
    currentStep: 'Editing useReconnect.ts',
    scopeLabel: 'Scoped implementation',
  },
  {
    stage: 'verifying',
    title: 'Fix reconnect banner',
    request: 'Fix the reconnect banner staying visible after the websocket recovers.',
    summary: 'Code changes are in place and focused checks are running.',
    changedFiles: [
      {
        path: 'ui/src/hooks/useReconnect.ts',
        status: 'modified',
        additions: 18,
        deletions: 6,
        summary: 'Reset the stale banner state when a healthy socket heartbeat lands.',
      },
      {
        path: 'ui/src/components/common/StaleServerBanner.tsx',
        status: 'modified',
        additions: 7,
        deletions: 2,
        summary: 'Avoid rendering the banner after the healthy state is restored.',
      },
    ],
    verification: [
      { id: 'typecheck', label: 'Typecheck', status: 'passed', detail: 'Completed in 3.4s.' },
      {
        id: 'test',
        label: 'Reconnect tests',
        status: 'running',
        detail: 'Running focused banner recovery assertions.',
      },
    ],
    actions: [{ id: 'review', label: 'Review diff', priority: 'secondary', intent: 'review' }],
    runDetails: {
      runLabel: 'qt_1042',
      route: { provider: 'openai', model: 'GPT-5.4', effort: 'low' },
      writeScope: [
        'ui/src/hooks/useReconnect.ts',
        'ui/src/components/common/StaleServerBanner.tsx',
      ],
      verificationCommands: ['npm run typecheck', 'npm test -- reconnect'],
      estimatedCost: '$0.14',
      activity: [
        {
          id: 'checks',
          label: 'Running focused checks',
          detail: 'Typecheck passed, tests still running.',
        },
      ],
    },
    currentStep: 'Running reconnect tests',
    scopeLabel: 'Focused verification',
  },
  {
    stage: 'ready_for_review',
    title: 'Fix reconnect banner',
    request: 'Fix the reconnect banner staying visible after the websocket recovers.',
    summary: 'Focused checks passed and the diff is ready for review.',
    changedFiles: [
      {
        path: 'ui/src/hooks/useReconnect.ts',
        status: 'modified',
        additions: 18,
        deletions: 6,
        summary: 'Reset the stale banner state when a healthy socket heartbeat lands.',
      },
      {
        path: 'ui/src/components/common/StaleServerBanner.tsx',
        status: 'modified',
        additions: 7,
        deletions: 2,
        summary: 'Avoid rendering the banner after the healthy state is restored.',
      },
    ],
    verification: [
      { id: 'typecheck', label: 'Typecheck', status: 'passed', detail: 'Completed in 3.4s.' },
      { id: 'test', label: 'Reconnect tests', status: 'passed', detail: '3 tests passed.' },
    ],
    actions: [
      { id: 'diff', label: 'Review diff', priority: 'secondary', intent: 'review' },
      { id: 'commit', label: 'Commit', priority: 'primary', intent: 'commit' },
      { id: 'changes', label: 'Request changes', priority: 'secondary', intent: 'dismiss' },
    ],
    runDetails: {
      runLabel: 'qt_1042',
      route: { provider: 'openai', model: 'GPT-5.4', effort: 'low' },
      writeScope: [
        'ui/src/hooks/useReconnect.ts',
        'ui/src/components/common/StaleServerBanner.tsx',
      ],
      verificationCommands: ['npm run typecheck', 'npm test -- reconnect'],
      estimatedCost: '$0.14',
      activity: [
        { id: 'type', label: 'Typecheck passed', detail: 'No type regressions.', tone: 'success' },
        {
          id: 'test',
          label: 'Tests passed',
          detail: 'Reconnect banner clears after recovery.',
          tone: 'success',
        },
      ],
    },
    scopeLabel: 'Ready to land',
  },
  {
    stage: 'committed',
    title: 'Fix reconnect banner',
    request: 'Fix the reconnect banner staying visible after the websocket recovers.',
    summary: 'The quick task landed cleanly with focused verification evidence attached.',
    changedFiles: [
      {
        path: 'ui/src/hooks/useReconnect.ts',
        status: 'modified',
        additions: 18,
        deletions: 6,
        summary: 'Reset the stale banner state when a healthy socket heartbeat lands.',
      },
      {
        path: 'ui/src/components/common/StaleServerBanner.tsx',
        status: 'modified',
        additions: 7,
        deletions: 2,
        summary: 'Avoid rendering the banner after the healthy state is restored.',
      },
    ],
    verification: [
      { id: 'typecheck', label: 'Typecheck', status: 'passed', detail: 'Completed in 3.4s.' },
      { id: 'test', label: 'Reconnect tests', status: 'passed', detail: '3 tests passed.' },
    ],
    actions: [
      { id: 'diff', label: 'Review diff', priority: 'secondary', intent: 'review' },
      { id: 'again', label: 'Run another quick task', priority: 'secondary', intent: 'execute' },
    ],
    runDetails: {
      runLabel: 'qt_1042',
      route: { provider: 'openai', model: 'GPT-5.4', effort: 'low' },
      writeScope: [
        'ui/src/hooks/useReconnect.ts',
        'ui/src/components/common/StaleServerBanner.tsx',
      ],
      verificationCommands: ['npm run typecheck', 'npm test -- reconnect'],
      estimatedCost: '$0.14',
      activity: [
        {
          id: 'commit',
          label: 'Committed',
          detail: '1 file group committed on branch swarm/reconnect-banner.',
          tone: 'success',
        },
      ],
    },
    scopeLabel: 'Landed',
  },
  {
    stage: 'needs_escalation',
    title: 'Fix reconnect banner',
    request: 'Fix the reconnect banner staying visible after the websocket recovers.',
    summary: 'The request widened beyond the approved quick-task scope.',
    changedFiles: [
      {
        path: 'ui/src/hooks/useReconnect.ts',
        status: 'modified',
        additions: 18,
        deletions: 6,
        summary: 'Local reconnect state updates were not enough to resolve the issue.',
      },
    ],
    verification: [],
    actions: [
      { id: 'plan', label: 'Review expanded plan', priority: 'primary', intent: 'escalate' },
      {
        id: 'readonly',
        label: 'Keep investigating read-only',
        priority: 'secondary',
        intent: 'review',
      },
      { id: 'stop', label: 'Stop', priority: 'secondary', intent: 'dismiss' },
    ],
    runDetails: {
      runLabel: 'qt_1042',
      route: { provider: 'openai', model: 'GPT-5.4', effort: 'low' },
      writeScope: ['ui/src/hooks/useReconnect.ts'],
      verificationCommands: ['npm run typecheck'],
      estimatedCost: '$0.16',
      activity: [
        {
          id: 'discover',
          label: 'Discovered broader scope',
          detail: 'Persisted session state and server lifecycle also need changes.',
          tone: 'warning',
        },
      ],
    },
    escalationReason:
      'Expected a UI-only fix but discovered backend session lifecycle and persisted reconnect state.',
    scopeLabel: 'Escalation required',
  },
  {
    stage: 'failed',
    title: 'Fix reconnect banner',
    request: 'Fix the reconnect banner staying visible after the websocket recovers.',
    summary: 'Focused verification failed and the quick task stopped before commit.',
    changedFiles: [
      {
        path: 'ui/src/hooks/useReconnect.ts',
        status: 'modified',
        additions: 18,
        deletions: 6,
        summary: 'Reset the stale banner state when a healthy socket heartbeat lands.',
      },
    ],
    verification: [
      { id: 'typecheck', label: 'Typecheck', status: 'passed', detail: 'Completed in 3.4s.' },
      {
        id: 'test',
        label: 'Reconnect tests',
        status: 'failed',
        detail: 'Banner still flashes after retry loop.',
      },
    ],
    actions: [
      { id: 'diff', label: 'Review failure', priority: 'secondary', intent: 'review' },
      { id: 'escalate', label: 'Escalate', priority: 'primary', intent: 'escalate' },
    ],
    runDetails: {
      runLabel: 'qt_1042',
      route: { provider: 'openai', model: 'GPT-5.4', effort: 'medium' },
      writeScope: ['ui/src/hooks/useReconnect.ts'],
      verificationCommands: ['npm run typecheck', 'npm test -- reconnect'],
      estimatedCost: '$0.18',
      activity: [
        {
          id: 'fail',
          label: 'Verification failed',
          detail: 'A retry timing edge case still reproduces.',
          tone: 'error',
        },
      ],
    },
    escalationReason: 'Reconnect tests still fail under repeated socket flaps.',
    scopeLabel: 'Needs follow-up',
  },
  {
    stage: 'cancelled',
    title: 'Fix reconnect banner',
    request: 'Fix the reconnect banner staying visible after the websocket recovers.',
    summary: 'The quick task was stopped before changes were finalized.',
    changedFiles: [],
    verification: [],
    actions: [{ id: 'again', label: 'Restart quick task', priority: 'primary', intent: 'execute' }],
    runDetails: {
      runLabel: 'qt_1042',
      route: { provider: 'openai', model: 'GPT-5.4', effort: 'low' },
      writeScope: ['ui/src/hooks/useReconnect.ts'],
      verificationCommands: ['npm run typecheck'],
      estimatedCost: '$0.03',
      activity: [
        {
          id: 'cancel',
          label: 'Cancelled',
          detail: 'User stopped the run before execution.',
          tone: 'neutral',
        },
      ],
    },
    scopeLabel: 'No changes applied',
  },
];
