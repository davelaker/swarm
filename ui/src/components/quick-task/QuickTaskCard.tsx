import { useId } from 'react';
import { IconChevron, IconFile, IconLock, IconTerminal, IconWarn } from '../common/icons';
import {
  QUICK_TASK_STAGE_LABELS,
  QUICK_TASK_STAGE_TONES,
  countVerificationResults,
  diffSummary,
  isQuickTaskTerminal,
  type QuickTaskAction,
  type QuickTaskActivityEntry,
  type QuickTaskCardState,
  type QuickTaskCheckStatus,
  type QuickTaskPriority,
} from '../../data/quickTask';
import './QuickTaskCard.css';

interface QuickTaskCardProps {
  state: QuickTaskCardState;
  onAction?: (action: QuickTaskAction, state: QuickTaskCardState) => void;
  defaultDetailsOpen?: boolean;
}

function actionClassName(priority: QuickTaskPriority): string {
  if (priority === 'primary') {
    return 'btn primary';
  }
  if (priority === 'danger') {
    return 'btn danger';
  }
  return 'btn';
}

function checkTone(status: QuickTaskCheckStatus): string {
  if (status === 'passed') {
    return 'passed';
  }
  if (status === 'failed') {
    return 'failed';
  }
  if (status === 'running') {
    return 'running';
  }
  if (status === 'skipped') {
    return 'skipped';
  }
  return 'pending';
}

function activityTone(entry: QuickTaskActivityEntry): string {
  return entry.tone ?? 'neutral';
}

export function QuickTaskCard({
  state,
  onAction,
  defaultDetailsOpen = false,
}: QuickTaskCardProps) {
  const titleId = useId();
  const detailsId = useId();
  const verificationSummary = countVerificationResults(state.verification);
  const showChangedFiles = state.changedFiles.length > 0;
  const showVerification = state.verification.length > 0;
  const stageTone = QUICK_TASK_STAGE_TONES[state.stage];
  const terminal = isQuickTaskTerminal(state.stage);

  return (
    <section className="quick-task-card anim-in" aria-labelledby={titleId}>
      <div className="quick-task-head">
        <div className="quick-task-heading">
          <p className="quick-task-kicker">Quick task</p>
          <h2 id={titleId}>{state.title}</h2>
          <p className="quick-task-request">{state.request}</p>
        </div>
        <div className="quick-task-badges">
          {state.scopeLabel && <span className="quick-task-scope">{state.scopeLabel}</span>}
          <span className={`quick-task-stage ${stageTone}`}>{QUICK_TASK_STAGE_LABELS[state.stage]}</span>
        </div>
      </div>

      <div
        className={`quick-task-summary ${stageTone}`}
        aria-live={terminal ? 'off' : 'polite'}
        aria-atomic="true"
      >
        <p>{state.summary}</p>
        {state.currentStep && <span className="quick-task-current-step">{state.currentStep}</span>}
        {state.escalationReason && (
          <div className="quick-task-escalation" role="note">
            <IconWarn />
            <span>{state.escalationReason}</span>
          </div>
        )}
      </div>

      {showChangedFiles && (
        <section className="quick-task-section" aria-label="Changed files">
          <div className="quick-task-section-head">
            <div className="quick-task-section-title">
              <IconFile />
              <span>Changed files</span>
            </div>
            <span className="quick-task-section-meta">{diffSummary(state.changedFiles)}</span>
          </div>
          <ul className="quick-task-file-list">
            {state.changedFiles.map(file => (
              <li key={file.path} className="quick-task-file">
                <div className="quick-task-file-top">
                  <code>{file.path}</code>
                  <span className={`quick-task-file-status ${file.status}`}>{file.status}</span>
                </div>
                <p>{file.summary}</p>
                <span className="quick-task-file-counts">
                  +{file.additions} / -{file.deletions}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {showVerification && (
        <section className="quick-task-section" aria-label="Verification evidence">
          <div className="quick-task-section-head">
            <div className="quick-task-section-title">
              <IconTerminal />
              <span>Verification</span>
            </div>
            <span className="quick-task-section-meta">
              {verificationSummary.passed > 0 && `${verificationSummary.passed} passed`}
              {verificationSummary.running > 0 &&
                `${verificationSummary.passed > 0 ? ' · ' : ''}${verificationSummary.running} running`}
              {verificationSummary.failed > 0 &&
                `${verificationSummary.passed > 0 || verificationSummary.running > 0 ? ' · ' : ''}${verificationSummary.failed} failed`}
            </span>
          </div>
          <ul className="quick-task-check-list">
            {state.verification.map(check => (
              <li key={check.id} className={`quick-task-check ${checkTone(check.status)}`}>
                <div className="quick-task-check-top">
                  <span>{check.label}</span>
                  <span className={`quick-task-check-status ${checkTone(check.status)}`}>
                    {check.status}
                  </span>
                </div>
                <p>{check.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="quick-task-actions" aria-label="Quick task actions">
        {state.actions.map(action => (
          <button
            key={action.id}
            type="button"
            className={actionClassName(action.priority)}
            disabled={action.disabled}
            onClick={() => onAction?.(action, state)}
          >
            {action.label}
          </button>
        ))}
      </div>

      <details className="quick-task-details" id={detailsId} open={defaultDetailsOpen}>
        <summary>
          <span>Run details</span>
          <span className="quick-task-details-meta">
            {state.runDetails.route.model} · {state.runDetails.route.effort}
          </span>
          <span className="quick-task-details-chevron" aria-hidden="true">
            <IconChevron />
          </span>
        </summary>

        <div className="quick-task-details-grid">
          <div className="quick-task-detail-block">
            <span className="quick-task-detail-label">Run</span>
            <strong>{state.runDetails.runLabel}</strong>
          </div>
          <div className="quick-task-detail-block">
            <span className="quick-task-detail-label">Route</span>
            <strong>
              {state.runDetails.route.provider} · {state.runDetails.route.model}
            </strong>
          </div>
          <div className="quick-task-detail-block">
            <span className="quick-task-detail-label">Estimated cost</span>
            <strong>{state.runDetails.estimatedCost ?? 'Not estimated'}</strong>
          </div>
          <div className="quick-task-detail-block">
            <span className="quick-task-detail-label">Write scope</span>
            <div className="quick-task-pill-list">
              {state.runDetails.writeScope.map(scope => (
                <span key={scope} className="quick-task-pill">
                  <IconLock />
                  {scope}
                </span>
              ))}
            </div>
          </div>
          <div className="quick-task-detail-block">
            <span className="quick-task-detail-label">Checks</span>
            <div className="quick-task-pill-list">
              {state.runDetails.verificationCommands.map(command => (
                <span key={command} className="quick-task-pill terminal">
                  <IconTerminal />
                  {command}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="quick-task-activity" aria-label="Run activity log">
          {state.runDetails.activity.map(entry => (
            <div key={entry.id} className={`quick-task-activity-item ${activityTone(entry)}`}>
              <strong>{entry.label}</strong>
              <span>{entry.detail}</span>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
