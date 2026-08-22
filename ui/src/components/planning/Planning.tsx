import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { usePlanningSession } from '../../hooks/usePlanningSession';
import { useIntakeDecision } from '../../hooks/useIntakeDecision';
import { useContextFiles } from '../../hooks/useContextFiles';
import { Charter } from './Charter';
import { Message, StreamingMessage, ProgressiveTypingIndicator } from './Message';
import { IntakeDecisionCard } from './IntakeDecisionCard';
import { resolveAgentPersona } from '../../data/personas';
import { IconSend } from '../common/icons';
import { ActivityItem } from '../common/ActivityItem';
import { ReadinessPanel } from './ReadinessPanel';
import { useReadiness } from '../../hooks/useReadiness';
import type { ServerStatus, RunCharter, TaskGraphEntry } from '../../App';
import { forecastFromRoles, forecastFromTasks, formatForecastTime } from '../../data/forecast';
import {
  modelMeta,
  reasoningEffortTradeoff,
  isUpgrade,
  selectableModels,
  type ReasoningEffort,
} from '../../data/models';
import type { ModelPolicySnapshot } from '../../data/modelPolicy';
import type { ExecutionShape, IntakeDecision } from '../../data/intake';
import type { QuickTaskStartResult } from '../../data/quickTask';
import { useAgentDefaults } from '../../hooks/useAgentDefaults';
import type { CharterData, SessionSnapshot } from '../../types';
import type { ProjectEnvelope } from '../../project/types';
import { useProjectClient } from '../../project/ProjectClientContext';

// The per-task model plan shown at the Execute gate: each agent's model, with the
// PM's upgrades over the agent default flagged (more capable → costs more) and an
// override dropdown so the user confirms or reverts before continuing.
function ModelPlan({
  taskGraph,
  modelPolicy,
  onSetTaskRoute,
}: {
  taskGraph: TaskGraphEntry[];
  modelPolicy?: ModelPolicySnapshot | null;
  onSetTaskRoute?: (
    taskId: string,
    route: { provider: 'anthropic' | 'openai'; model: string; reasoningEffort?: ReasoningEffort },
  ) => void;
}) {
  const defaultModelFor = useAgentDefaults();
  const tasks = taskGraph.filter(t => t.assignee);
  if (tasks.length === 0) {
    return null;
  }
  const providers = modelPolicy?.providers ?? null;
  const upgrades = tasks.filter(t =>
    isUpgrade(t.route?.model ?? t.model, defaultModelFor(t.assignee)),
  );
  const availableNames = providers
    ?.filter(provider => provider.available)
    .map(provider => (provider.provider === 'openai' ? 'OpenAI / Codex' : 'Anthropic'));

  return (
    <div className="plan-models">
      {upgrades.length > 0 && (
        <div className="plan-models-warn">
          ⚠ The PM upgraded {upgrades.length} agent{upgrades.length === 1 ? '' : 's'} above{' '}
          {upgrades.length === 1 ? 'its' : 'their'} default — more capable, higher cost. Confirm by
          executing, or override below.
        </div>
      )}
      {providers && (
        <div className="plan-provider-status" aria-label="Detected providers">
          <span>Available providers:</span>{' '}
          {availableNames?.length
            ? availableNames.join(' · ')
            : 'none detected — routes are locked'}
        </div>
      )}
      <div className="plan-models-list">
        {tasks.map(t => {
          const def = defaultModelFor(t.assignee);
          const chosen = t.route?.model ?? t.model ?? def;
          const meta = modelMeta(chosen);
          const upgraded = isUpgrade(t.route?.model ?? t.model, def);
          const p = resolveAgentPersona(t.assignee);
          const models = providers
            ? selectableModels(providers, t.assignee, modelPolicy?.enabledModelIds)
            : [];
          const chosenModel = models.find(model => model.id === chosen);
          const effort = t.route?.reasoningEffort ?? t.effort;
          const fallback = t.route?.fallback;
          const routeUnavailable = Boolean(t.route && !chosenModel);
          const selectedProvider = providers?.find(
            provider => provider.provider === (t.route?.provider ?? chosenModel?.provider),
          );
          const costClass = selectedProvider?.availableAuthModes.includes('subscription')
            ? 'Subscription quota'
            : selectedProvider?.availableAuthModes.includes('api-key')
              ? 'API-metered'
              : null;
          return (
            <div key={t.id} className={`plan-model-row${upgraded ? ' upgraded' : ''}`}>
              <span className="plan-model-agent">
                <span className="pdot" style={{ background: p.color }} />
                {p.name}
              </span>
              {upgraded && (
                <span className="plan-model-up" title={`Default: ${modelMeta(def)?.label ?? '—'}`}>
                  ↑ {modelMeta(def)?.label ?? '—'} →
                </span>
              )}
              <div className="plan-route-controls">
                <select
                  className="plan-model-select"
                  value={chosen ?? ''}
                  style={meta ? { color: meta.color } : undefined}
                  onChange={e => {
                    const next = models.find(model => model.id === e.target.value);
                    if (!next) {return;}
                    const nextEffort = next.reasoningEfforts.includes(effort as ReasoningEffort)
                      ? (effort as ReasoningEffort)
                      : next.reasoningEfforts.includes('medium')
                        ? 'medium'
                        : next.reasoningEfforts[0];
                    onSetTaskRoute?.(t.id, {
                      provider: next.provider,
                      model: next.id,
                      ...(nextEffort ? { reasoningEffort: nextEffort } : {}),
                    });
                  }}
                  disabled={!onSetTaskRoute || providers === null || models.length === 0}
                  title={
                    routeUnavailable
                      ? 'The recommended route is unavailable; select an available alternative'
                      : 'Override the route for this task'
                  }
                >
                  <option value={chosen ?? ''}>
                    {chosenModel?.label ?? modelMeta(chosen)?.label ?? 'Unavailable model'}
                  </option>
                  {models
                    .filter(model => model.id !== chosen)
                    .map(model => (
                      <option key={model.id} value={model.id}>
                        {model.provider === 'openai' ? 'OpenAI · ' : 'Anthropic · '}
                        {model.label}
                      </option>
                    ))}
                </select>
                {chosenModel?.reasoningEfforts.length ? (
                  <select
                    className="plan-effort-select"
                    value={effort ?? ''}
                    onChange={e =>
                      onSetTaskRoute?.(t.id, {
                        provider: chosenModel.provider,
                        model: chosenModel.id,
                        ...(e.target.value
                          ? { reasoningEffort: e.target.value as ReasoningEffort }
                          : {}),
                      })
                    }
                    disabled={!onSetTaskRoute || routeUnavailable}
                    title="Reasoning effort: higher levels spend more model reasoning/quota for more difficult work"
                  >
                    {chosenModel.reasoningEfforts.map(level => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
              {t.route && (
                <div className="plan-route-detail">
                  <span>{t.route.rationale}</span>
                  {fallback && (
                    <span>
                      Fallback: {fallback.model}
                      {fallback.reasoningEffort ? ` / ${fallback.reasoningEffort}` : ''}
                    </span>
                  )}
                  <span>
                    Reasoning effort: {effort ?? 'provider default'} —{' '}
                    {reasoningEffortTradeoff(effort)}
                  </span>
                  {costClass && <span>Cost class: {costClass}</span>}
                  {t.route.requiresConfirmation && (
                    <span className="plan-route-confirm">Cost confirmation required</span>
                  )}
                  {routeUnavailable && (
                    <span className="plan-route-unavailable">Route unavailable</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlanReadyCallout({
  charter,
  team,
  taskGraph,
  modelPolicy,
  onExecute,
  onSetTaskRoute,
}: {
  charter: CharterData;
  team: string[];
  taskGraph?: TaskGraphEntry[];
  modelPolicy?: ModelPolicySnapshot | null;
  onExecute?: () => void;
  onSetTaskRoute?: (
    taskId: string,
    route: { provider: 'anthropic' | 'openai'; model: string; reasoningEffort?: ReasoningEffort },
  ) => void;
}) {
  const readiness = useReadiness();
  // Prefer the PM's actual task graph (with per-task models) for the forecast; fall back to
  // the team roster when there's no graph yet.
  const forecast =
    taskGraph && taskGraph.length ? forecastFromTasks(taskGraph) : forecastFromRoles(team);
  const openQuestions = charter.questions.filter(q => !q.resolved);
  const noTeam = team.length === 0;
  const noGoal = !charter.goal;

  const blockers: string[] = [];
  if (noGoal) {blockers.push('no goal defined');}
  if (noTeam) {blockers.push('no agents in the team');}
  if (openQuestions.length)
    {blockers.push(
      `${openQuestions.length} open question${openQuestions.length > 1 ? 's' : ''} unresolved`,
    );}
  // A hard pre-flight fail (uncommitted tree) would 400 the run — block it up front.
  if (!readiness.canRun) {
    const failed = readiness.checks.find(c => c.status === 'fail');
    blockers.push(failed ? failed.detail : 'the working tree is not ready');
  }

  const canExecute = blockers.length === 0;

  return (
    <div className={`plan-ready-callout anim-in${canExecute ? '' : ' plan-ready-blocked'}`}>
      <div className="plan-ready-header">
        <span className="plan-ready-dot" />
        {canExecute ? 'Charter ready to execute' : 'Charter needs attention'}
      </div>
      {canExecute ? (
        <p>
          Review everything on the left — goal, constraints, non-goals, and the recommended team —
          before proceeding. You can still change anything: ask to adjust scope, swap or remove
          agents, tighten constraints, or flip the branch mode.
        </p>
      ) : (
        <>
          <p>
            The charter was ready, but something changed. Resolve the following before executing:
          </p>
          <ul className="plan-ready-blockers">
            {blockers.map(b => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <p style={{ marginTop: 4 }}>
            Ask the PM to address these, or adjust the charter directly.
          </p>
        </>
      )}
      <ReadinessPanel
        project={readiness.report?.project ?? null}
        checks={readiness.checks}
        loading={readiness.loading}
      />
      {taskGraph && taskGraph.length > 0 && (
        <ModelPlan
          taskGraph={taskGraph}
          modelPolicy={modelPolicy}
          onSetTaskRoute={onSetTaskRoute}
        />
      )}
      <div className="plan-ready-actions">
        {canExecute && (
          <span
            className="plan-forecast"
            title="Rough estimate — the live spend bar and timer are the truth once the run starts"
          >
            <span className="plan-forecast-n">
              {forecast.taskCount} task{forecast.taskCount !== 1 ? 's' : ''}
            </span>
            {forecast.costUsd > 0 && (
              <>
                <span className="plan-forecast-sep">·</span>
                <span>~${forecast.costUsd.toFixed(2)}</span>
              </>
            )}
            <span className="plan-forecast-sep">·</span>
            <span>{formatForecastTime(forecast.seconds)}</span>
          </span>
        )}
        <button
          className="btn primary"
          onClick={onExecute}
          disabled={!canExecute}
          title={canExecute ? undefined : `Cannot execute: ${blockers.join(', ')}`}
        >
          Execute →
        </button>
      </div>
    </div>
  );
}

// First-run guidance: when a session is brand new (the user hasn't said anything
// yet), offer a few example goals to make the blank page actionable. Picking one
// fills the composer so the user can complete the specifics, not send it blind.
const STARTER_PROMPTS: { label: string; template: string }[] = [
  {
    label: 'Add a small UI feature',
    template: 'On the page at app/…, add ',
  },
  {
    label: 'Fix a specific bug',
    template: 'Fix the bug where ',
  },
  {
    label: 'Add tests',
    template: 'Write tests for ',
  },
  {
    label: 'Refactor safely',
    template: 'Refactor … without changing its behavior, and ',
  },
];

interface GhIssue {
  number: number;
  title: string;
}

// Compose a PM brief from a GitHub issue. Pure so it is trivially testable.
// eslint-disable-next-line react-refresh/only-export-components
export function issueToBrief(issue: {
  number: number;
  title: string;
  body?: string;
  url?: string;
}): string {
  const body = (issue.body ?? '').trim();
  const parts = [`GitHub issue #${issue.number}: ${issue.title}`];
  if (body) {
    parts.push('', body);
  }
  if (issue.url) {
    parts.push('', `(${issue.url})`);
  }
  return parts.join('\n');
}

// Ticket-as-unit-of-work intake: list the target repo's open GitHub issues (via the
// backend's gh-CLI endpoint) and seed the composer from one. The user still reviews
// and sends the brief themselves — import fills the composer, it never auto-sends.
function IssueImport({ onPick }: { onPick: (text: string) => void }) {
  const projectClient = useProjectClient();
  const [issues, setIssues] = useState<GhIssue[] | null>(null); // null = not fetched
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const toggle = () => {
    setOpen(o => !o);
    if (issues === null) {
      projectClient
        .fetchJson<GhIssue[]>('/issues', {
          signal: AbortSignal.timeout(8000),
          allowMissingEnvelope: true,
        })
        .then((list: GhIssue[]) => setIssues(Array.isArray(list) ? list : []))
        .catch(() => setIssues([]));
    }
  };

  const pick = (n: number) => {
    setBusy(true);
    projectClient
      .fetchJson<{ number: number; title: string; body?: string; url?: string } | null>(
        `/issues/view?number=${n}`,
        { signal: AbortSignal.timeout(8000), allowMissingEnvelope: true },
      )
      .then((issue: { number: number; title: string; body?: string; url?: string } | null) => {
        if (issue) {
          onPick(issueToBrief(issue));
          setOpen(false);
        }
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  return (
    <span className="issue-import">
      <button className="starter-chip" onClick={toggle}>
        ⬇ Import GitHub issue{open ? ' ▴' : ''}
      </button>
      {open && (
        <div className="issue-import-list">
          {issues === null && <div className="issue-import-empty">Loading…</div>}
          {issues !== null && issues.length === 0 && (
            <div className="issue-import-empty">No open issues (or gh not connected)</div>
          )}
          {(issues ?? []).map(i => (
            <button
              key={i.number}
              className="issue-import-row"
              disabled={busy}
              onClick={() => pick(i.number)}
            >
              <span className="issue-import-num">#{i.number}</span>
              <span className="issue-import-title">{i.title}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function StarterPrompts({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="starter-prompts anim-in">
      <div className="starter-prompts-label">Not sure where to start? Try one of these:</div>
      <div className="starter-prompts-chips">
        {STARTER_PROMPTS.map(s => (
          <button key={s.label} className="starter-chip" onClick={() => onPick(s.template)}>
            {s.label}
          </button>
        ))}
        <IssueImport onPick={onPick} />
      </div>
    </div>
  );
}

// The PM recommends hiring a marketplace specialist. One-click CTA that jumps to the
// Agents tab focused on this agent's hire page.
function HireCallout({
  agentId,
  reason,
  onHire,
  onDismiss,
}: {
  agentId: string;
  reason: string;
  onHire?: (agentId: string) => void;
  onDismiss: () => void;
}) {
  const p = resolveAgentPersona(agentId);
  return (
    <div className="plan-ready-callout anim-in" style={{ borderColor: 'rgba(77,141,244,0.4)' }}>
      <div className="plan-ready-header">
        <span className="plan-ready-dot" style={{ background: p.color }} />
        PM recommends hiring {p.name}
      </div>
      {reason && <p>{reason}</p>}
      <div className="plan-ready-actions" style={{ gap: 8 }}>
        <button className="btn primary" onClick={() => onHire?.(agentId)}>
          Hire {p.name} →
        </button>
        <button
          className="btn"
          onClick={onDismiss}
          style={{ background: 'none', border: 'none', color: 'var(--tx-3)', cursor: 'pointer' }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}

interface PlanningProps {
  onExecute?: (goal: string, charter: RunCharter, team: string[]) => void;
  onQuickTask?: (instruction: string) => Promise<QuickTaskStartResult>;
  onExecutable: (
    v: boolean,
    goal?: string,
    charter?: RunCharter,
    team?: string[],
    reason?: string,
  ) => void;
  onNewSession?: () => void;
  onHire?: (agentId: string) => void;
  reviewRequest?: { key: number; text: string } | null;
  serverStatus?: ServerStatus;
  recapMessage?: string | null;
  planNextKey?: number;
  reopenKey?: number;
  reopenSeed?: SessionSnapshot | null;
  playwrightAvailable?: boolean | null;
  runBlockedReason?: string | null;
  historicalSession?: SessionSnapshot;
  modelPolicy?: ModelPolicySnapshot | null;
  project: ProjectEnvelope;
}

interface PendingIntake {
  text: string;
  sessionKey: number;
  requestedShape?: ExecutionShape;
  startingQuickTask?: boolean;
  quickTaskEscalation?: string;
  quickTaskError?: string;
}

interface HistoricalPlanningSection {
  label: string;
  value: 'not-recorded' | 'reconstructed' | string[];
}

interface HistoricalPlanningTask {
  id: string;
  title: string;
  assignee: string;
  dependsOn: string[];
  model: string | null;
}

interface HistoricalPlanningView {
  goal: { text: string; source: 'recorded' | 'reconstructed' };
  team: { id: string; source: 'recorded' | 'reconstructed' }[];
  branch:
    | { label: string; source: 'recorded' | 'reconstructed'; mode: 'branch' | 'main' }
    | null;
  executionPlan: {
    source: 'recorded' | 'reconstructed' | 'not-recorded';
    tasks: HistoricalPlanningTask[];
  };
  sections: HistoricalPlanningSection[];
  messages: Array<{ from: 'pm' | 'you'; text: string }>;
}

function historicalBranchView(
  session: SessionSnapshot,
): HistoricalPlanningView['branch'] {
  if (session.branchName) {
    return {
      label: session.branchName.replace(/^swarm\//, ''),
      source: 'recorded',
      mode: 'branch',
    };
  }
  if (session.charter?.branchMode === 'main') {
    return {
      label: 'Committing to main',
      source: 'recorded',
      mode: 'main',
    };
  }
  if (session.charter?.branchName) {
    return {
      label: session.charter.branchName.replace(/^swarm\//, ''),
      source: 'reconstructed',
      mode: 'branch',
    };
  }
  return null;
}

function historicalRecordedTasks(session: SessionSnapshot): HistoricalPlanningTask[] {
  const taskGraph = session.charter?.taskGraph ?? [];
  return taskGraph
    .filter(task => task.assignee)
    .map(task => ({
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      dependsOn: task.depends_on,
      model: task.route?.model ?? task.model ?? null,
    }));
}

function historicalReconstructedTasks(session: SessionSnapshot): HistoricalPlanningTask[] {
  return session.tasks
    .filter(task => task.assignee)
    .map(task => ({
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      dependsOn: task.depends_on,
      model: task.route?.model ?? task.model ?? null,
    }));
}

export function projectHistoricalPlanningView(
  session: SessionSnapshot,
): HistoricalPlanningView {
  const charter = session.charter;
  const recordedTasks = historicalRecordedTasks(session);
  const reconstructedTasks = historicalReconstructedTasks(session);
  const executionPlan =
    recordedTasks.length > 0
      ? { source: 'recorded' as const, tasks: recordedTasks }
      : reconstructedTasks.length > 0
        ? { source: 'reconstructed' as const, tasks: reconstructedTasks }
        : { source: 'not-recorded' as const, tasks: [] };
  const uniqueTeam = [...new Set(executionPlan.tasks.map(task => task.assignee).filter(Boolean))];
  const teamSource = executionPlan.source === 'recorded' ? 'recorded' : 'reconstructed';
  return {
    goal: {
      text: session.goal || 'Reconstructed from saved session metadata.',
      source: session.goal ? 'recorded' : 'reconstructed',
    },
    team:
      executionPlan.source === 'not-recorded'
        ? []
        : uniqueTeam.map(id => ({ id, source: teamSource })),
    branch: historicalBranchView(session),
    executionPlan,
    sections: [
      {
        label: 'Constraints',
        value: charter?.constraints?.length ? charter.constraints : 'not-recorded',
      },
      {
        label: 'Non-goals',
        value: charter?.nongoals?.length ? charter.nongoals : 'not-recorded',
      },
      {
        label: 'Open questions',
        value: charter?.questions?.length ? charter.questions : 'not-recorded',
      },
    ],
    messages: (charter?.planningHistory ?? []).map(message => ({
      from: message.from,
      text: message.text,
    })),
  };
}

function IntakeStatusCard({
  pending,
  state,
  serverDown,
  onAccept,
  onChooseShape,
  onContinue,
}: {
  pending: PendingIntake;
  state: ReturnType<typeof useIntakeDecision>;
  serverDown: boolean;
  onAccept: (decision: IntakeDecision) => void;
  onChooseShape: (shape: ExecutionShape) => void;
  onContinue: () => void;
}) {
  const requestedShape = pending.requestedShape;

  if (pending.startingQuickTask) {
    return (
      <div className="intake-card intake-status-card" role="status" aria-live="polite">
        <div>
          <p className="intake-card-kicker">Preparing quick task</p>
          <p className="intake-card-action">
            Establishing a narrow write scope, focused checks, and an executable route.
          </p>
        </div>
        <div className="intake-loading-bar" aria-hidden="true" />
      </div>
    );
  }

  if (pending.quickTaskEscalation) {
    return (
      <div className="intake-card intake-status-card" role="alert">
        <div>
          <p className="intake-card-kicker">Quick task needs a broader workflow</p>
          <p className="intake-card-action">{pending.quickTaskEscalation}</p>
        </div>
        <div className="intake-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => onChooseShape('coordinated_run')}
          >
            Review coordinated workflow
          </button>
          <button type="button" className="intake-choice-toggle" onClick={onContinue}>
            Continue planning
          </button>
        </div>
      </div>
    );
  }

  if (pending.quickTaskError) {
    return (
      <div className="intake-card intake-status-card" role="alert">
        <div>
          <p className="intake-card-kicker">Quick task could not start</p>
          <p className="intake-card-action">{pending.quickTaskError}</p>
        </div>
        <div className="intake-actions">
          <button type="button" className="btn primary" onClick={onContinue}>
            Continue planning
          </button>
          <button
            type="button"
            className="intake-choice-toggle"
            onClick={() => onChooseShape('quick_task')}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (serverDown) {
    return (
      <div className="intake-card intake-status-card" role="status">
        <div>
          <p className="intake-card-kicker">Workflow recommendation unavailable</p>
          <p className="intake-card-action">
            The server is offline, so Swarm cannot classify this first request right now.
          </p>
        </div>
        <div className="intake-actions">
          <button type="button" className="btn primary" onClick={onContinue}>
            Continue with normal planning
          </button>
        </div>
      </div>
    );
  }

  if (state.status === 'success') {
    return (
      <IntakeDecisionCard
        decision={state.decision}
        onAccept={onAccept}
        onChooseShape={onChooseShape}
        onDismiss={onContinue}
      />
    );
  }

  if (state.status === 'error') {
    return (
      <div className="intake-card intake-status-card" role="alert">
        <div>
          <p className="intake-card-kicker">Workflow recommendation failed</p>
          <p className="intake-card-action">{state.error}</p>
        </div>
        <div className="intake-actions">
          <button type="button" className="btn primary" onClick={onContinue}>
            Continue with normal planning
          </button>
          {requestedShape && (
            <button
              type="button"
              className="intake-choice-toggle"
              onClick={() => onChooseShape(requestedShape)}
            >
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="intake-card intake-status-card" role="status" aria-live="polite">
      <div>
        <p className="intake-card-kicker">Choosing a lightweight workflow</p>
        <p className="intake-card-action">
          Swarm is checking whether this should be an answer, quick task, plan, or coordinated run.
        </p>
      </div>
      <div className="intake-loading-bar" aria-hidden="true" />
    </div>
  );
}

export function Planning({
  onExecute,
  onQuickTask,
  onExecutable,
  onNewSession,
  onHire,
  reviewRequest,
  serverStatus = 'probing',
  recapMessage,
  planNextKey,
  reopenKey,
  reopenSeed,
  playwrightAvailable,
  runBlockedReason,
  historicalSession,
  modelPolicy,
  project,
}: PlanningProps) {
  const projectName = project.projectName;

  // Consume the one-shot switch flag set by ProjectSwitcher before reload.
  const [justSwitchedPath] = useState<string | null>(() => {
    try {
      const v = localStorage.getItem('swarm-just-switched');
      if (v) {
        localStorage.removeItem('swarm-just-switched');
        return v;
      }
    } catch {
      /* private mode */
    }
    return null;
  });

  const session = usePlanningSession(
    onExecutable,
    project,
    recapMessage,
    runBlockedReason,
  );
  const context = useContextFiles();
  const [input, setInput] = useState('');
  const [pendingIntake, setPendingIntake] = useState<PendingIntake | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activePendingIntake =
    pendingIntake?.sessionKey === session.sessionKey ? pendingIntake : null;
  const intakeState = useIntakeDecision(
    activePendingIntake && serverStatus !== 'down' ? activePendingIntake.text : '',
    activePendingIntake?.requestedShape,
  );

  const executePlan = useCallback(() => {
    const taskGraph = (session.taskGraph ?? []).map(task =>
      task.route?.requiresConfirmation
        ? { ...task, route: { ...task.route, requiresConfirmation: false } }
        : task,
    );
    const charter: RunCharter = {
      constraints: session.charter.constraints.map(item => item.text),
      nongoals: session.charter.nongoals.map(item => item.text),
      questions: session.charter.questions.map(item => item.text),
      branchMode: session.branchMode,
      branchName: session.branchName,
      taskGraph,
      ...(session.deploymentInfo ? { deploymentInfo: session.deploymentInfo } : {}),
    };
    // Clicking Execute is the explicit local confirmation for all cost-class
    // warnings shown immediately above. The submitted charter clears only that
    // acknowledgement flag; routes themselves remain immutable after start.
    onExecutable(true, session.charter.goal, charter, session.team);
    onExecute?.(session.charter.goal, charter, session.team);
  }, [onExecutable, onExecute, session]);

  // When App asks us to start a fresh session (after a run completes), call
  // newSession(). The planNextKey increments each time — skip the initial 0.
  const prevPlanNextKey = useRef(planNextKey ?? 0);
  useEffect(() => {
    if (!planNextKey || planNextKey === prevPlanNextKey.current) {return;}
    prevPlanNextKey.current = planNextKey;
    session.newSession();
  }, [planNextKey, session.newSession]);

  // "Re-open in Planning" from a historical session — seed an editable plan from it.
  const prevReopenKey = useRef(reopenKey ?? 0);
  useEffect(() => {
    if (!reopenKey || reopenKey === prevReopenKey.current) {return;}
    prevReopenKey.current = reopenKey;
    if (reopenSeed) {session.reopen(reopenSeed);}
  }, [reopenKey, reopenSeed, session.reopen]);

  // A post-run "Request changes" review arrived — send it to the PM as a message
  // (it reads it like a reviewer's CHANGES_REQUESTED and plans a coder+reviewer fix).
  // Guard on the key so it fires exactly once per submission.
  const prevReviewKey = useRef(0);
  useEffect(() => {
    if (!reviewRequest || reviewRequest.key === prevReviewKey.current) {return;}
    prevReviewKey.current = reviewRequest.key;
    session.send(reviewRequest.text);
  }, [reviewRequest, session.send]);

  // Start the PM opening message once we have project context.
  // We wait up to 1.5s for /state and /context to load before falling back
  // to the generic greeting so the PM can reference the existing project.
  const initFired = useRef(false);

  // When the user hits "New session", sessionKey increments — reset the guard
  // BEFORE the init effect runs (React fires effects in definition order).
  useEffect(() => {
    initFired.current = false;
  }, [session.sessionKey]);

  useEffect(() => {
    if (initFired.current) {return;}
    // Extract a short stack summary from PROJECT.md (first tech stack bullet)
    const stackLine = context.projectMd?.content
      ?.split('\n')
      .find(l => l.match(/^\s*[-*]\s*(language|runtime|tech|stack)/i));
    const stackHint = stackLine
      ? stackLine
          .replace(/^\s*[-*]\s*/i, '')
          .replace(/\*\*/g, '')
          .slice(0, 60)
      : undefined;
    if (projectName || context.projectMd) {
      initFired.current = true;
      session.init(projectName, stackHint, justSwitchedPath ?? undefined);
    }
  }, [projectName, context.projectMd, justSwitchedPath, session.sessionKey]);

  // Fallback: fire after 1.5s even if context never arrives
  useEffect(() => {
    const t = setTimeout(() => {
      if (!initFired.current) {
        initFired.current = true;
        session.init(undefined, undefined, justSwitchedPath ?? undefined);
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [justSwitchedPath, session.sessionKey]);

  // Auto-scroll on new messages / typing indicator / streaming text
  useEffect(() => {
    if (scrollRef.current) {scrollRef.current.scrollTop = scrollRef.current.scrollHeight;}
  }, [session.messages, session.typing, session.streamingPmText, activePendingIntake, intakeState]);

  // Auto-grow textarea. Use height='0' (not 'auto') before measuring so that
  // scrollHeight reflects actual content rather than the rows attribute.
  // min-height in CSS guarantees at least one visible line.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) {return;}
    el.style.height = '0';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [input]);

  const hasUserMessage = session.messages.some(m => m.from === 'you');
  const shouldClassifyFirstRequest = !hasUserMessage && session.phase !== 'start';
  const intakePending = activePendingIntake !== null;

  const continueWithNormalPlanning = useCallback(() => {
    if (!activePendingIntake) {
      return;
    }
    const text = activePendingIntake.text;
    setPendingIntake(null);
    session.send(text);
  }, [activePendingIntake, session.send]);

  const acceptIntakeDecision = useCallback(
    async (decision: IntakeDecision) => {
      if (!activePendingIntake) {
        return;
      }
      const text = activePendingIntake.text;
      if (decision.shape === 'quick_task' && onQuickTask) {
        setPendingIntake(previous =>
          previous
            ? {
                ...previous,
                startingQuickTask: true,
                quickTaskEscalation: undefined,
                quickTaskError: undefined,
              }
            : previous,
        );
        try {
          const result = await onQuickTask(text);
          if (result.status === 'started') {
            setPendingIntake(null);
          } else {
            setPendingIntake(previous =>
              previous
                ? {
                    ...previous,
                    startingQuickTask: false,
                    quickTaskEscalation: result.escalationReason,
                  }
                : previous,
            );
          }
        } catch (error) {
          setPendingIntake(previous =>
            previous
              ? {
                  ...previous,
                  startingQuickTask: false,
                  quickTaskError:
                    error instanceof Error ? error.message : 'Quick task failed to start.',
                }
              : previous,
          );
        }
        return;
      }
      setPendingIntake(null);
      session.send(text, decision.shape);
    },
    [activePendingIntake, onQuickTask, session.send],
  );

  const chooseIntakeShape = useCallback((shape: ExecutionShape) => {
    setPendingIntake(previous =>
      previous
        ? {
            ...previous,
            requestedShape: shape,
            startingQuickTask: false,
            quickTaskEscalation: undefined,
            quickTaskError: undefined,
          }
        : previous,
    );
  }, []);

  const handleSend = () => {
    const text = input.trim();
    if (!text || session.typing || intakePending) {
      return;
    }
    setInput('');
    if (shouldClassifyFirstRequest) {
      setPendingIntake({ text, sessionKey: session.sessionKey });
      return;
    }
    session.send(text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Conversation phase label
  const phaseLabel = session.executable
    ? 'ready'
    : session.phase === 'start'
      ? 'initialising'
      : 'scoping';
  const phaseDot = session.executable ? 'var(--green)' : 'var(--amber)';

  // Server-mode label shown in panel header
  const modeLabel =
    serverStatus === 'up' ? null : serverStatus === 'probing' ? 'connecting' : 'preview mode';
  const modeDot =
    serverStatus === 'up'
      ? 'var(--green)'
      : serverStatus === 'probing'
        ? 'var(--tx-3)'
        : 'var(--tx-3)';

  // Composer hint
  const hint =
    serverStatus === 'down'
      ? 'Planning works without a server — Enter to send · agents need `swarm dev` to execute'
      : 'Enter to send · Shift+Enter for newline';

  // ─── Historical mode — frozen snapshot, no interaction ──────────────────────
  if (historicalSession) {
    const historicalView = projectHistoricalPlanningView(historicalSession);
    const savedAt = new Date(historicalSession.savedAt).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return (
      <div className="plan">
        <div className="plan-left">
          <div className="panel-head">
            <span>Archived Charter</span>
            <span className="spacer" />
            <span className="badge grey">ARCHIVED</span>
          </div>
          <div className="charter">
            <h2>{historicalView.goal.text.replace(/[.,].*$/, '').trim().slice(0, 48) || 'Archived session'}</h2>
            <div className="sub">
              {projectName ?? historicalSession.project} · read-only snapshot · saved {savedAt}
            </div>

            <div
              style={{
                marginBottom: 18,
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid rgba(245,160,55,0.24)',
                background: 'var(--amber-d)',
                color: 'var(--amber)',
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              Archived sessions preserve what was recorded at run time. Missing historical fields
              are labelled <strong>Not recorded</strong>; values derived from the completed run are
              labelled <strong>Reconstructed</strong>.
            </div>

            <div className="csec">
              <div className="csec-label">
                <span className="num">01</span> Goal
                <span className="field-req">saved</span>
              </div>
              <div className="goal-text anim-in">{historicalView.goal.text}</div>
              {historicalView.goal.source === 'reconstructed' && (
                <div className="empty">Reconstructed from saved session metadata.</div>
              )}
            </div>

            {historicalView.sections.map((section, index) => (
              <div className="csec" key={section.label}>
                <div className="csec-label">
                  <span className="num">{String(index + 2).padStart(2, '0')}</span> {section.label}
                  <span className="field-opt">archived</span>
                </div>
                {Array.isArray(section.value) ? (
                  <div className="clist">
                    {section.value.map(item => (
                      <div className="crow anim-in" key={item}>
                        <span className="mark">•</span>
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                ) : section.value === 'reconstructed' ? (
                  <div className="empty">Reconstructed</div>
                ) : (
                  <div className="empty">Not recorded</div>
                )}
              </div>
            ))}

            <div className="csec">
              <div className="csec-label">
                <span className="num">05</span> Recommended team
                <span className="field-req">
                  {historicalView.team.length === 0
                    ? 'archived'
                    : historicalView.team.some(member => member.source === 'recorded')
                    ? 'saved'
                    : 'reconstructed'}
                </span>
              </div>
              {historicalView.team.length > 0 ? (
                <div className="team-chips">
                  {historicalView.team.map(member => {
                    const persona = resolveAgentPersona(member.id);
                    return (
                      <span key={member.id} className="agent-chip anim-in">
                        <span className="pdot" style={{ background: persona.color }} />
                        {persona.name}
                        {member.source === 'reconstructed' && (
                          <span
                            className="model-badge"
                            style={{ color: 'var(--tx-3)', borderColor: 'var(--border)' }}
                          >
                            Reconstructed
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">Not recorded</div>
              )}
            </div>

            <div className="csec">
              <div className="csec-label">
                <span className="num">06</span> Branch
                <span className="field-opt">
                  {!historicalView.branch
                    ? 'archived'
                    : historicalView.branch.source === 'reconstructed'
                      ? 'reconstructed'
                      : 'saved'}
                </span>
              </div>
              {historicalView.branch ? (
                <div className="branch-mode-row anim-in">
                  <span
                    className="branch-mode-chip"
                    data-mode={historicalView.branch.mode === 'main' ? 'main' : 'branch'}
                  >
                    {historicalView.branch.mode === 'main'
                      ? historicalView.branch.label
                      : `⎇ ${historicalView.branch.label}`}
                  </span>
                  <span className="branch-hint">
                    {historicalView.branch.source === 'recorded'
                      ? 'Captured from the completed run.'
                      : 'Reconstructed from archived planning metadata.'}
                  </span>
                </div>
              ) : (
                <div className="empty">Not recorded</div>
              )}
            </div>

            <div className="csec">
              <div className="csec-label">
                <span className="num">07</span> Execution plan
                <span className="field-opt">
                  {historicalView.executionPlan.source === 'recorded'
                    ? 'saved'
                    : historicalView.executionPlan.source === 'reconstructed'
                      ? 'reconstructed'
                      : 'archived'}
                </span>
              </div>
              {historicalView.executionPlan.tasks.length > 0 ? (
                <div className="clist">
                  {historicalView.executionPlan.tasks.map(task => {
                    const persona = resolveAgentPersona(task.assignee);
                    const model = task.model ? modelMeta(task.model) : null;
                    return (
                      <div className="crow anim-in" key={task.id} style={{ alignItems: 'flex-start' }}>
                        <span className="mark">→</span>
                        <div style={{ display: 'grid', gap: 6 }}>
                          <span>{task.title}</span>
                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: 6,
                              alignItems: 'center',
                              color: 'var(--tx-3)',
                              fontSize: 12,
                            }}
                          >
                            <span className="agent-chip" style={{ animation: 'none' }}>
                              <span className="pdot" style={{ background: persona.color }} />
                              {persona.name}
                            </span>
                            {model ? (
                              <span
                                className="model-badge"
                                style={{ color: model.color, borderColor: model.color }}
                              >
                                {model.label}
                              </span>
                            ) : (
                              <span className="empty" style={{ padding: 0 }}>
                                Model not recorded
                              </span>
                            )}
                            {task.dependsOn.length > 0 && (
                              <span>depends on {task.dependsOn.join(', ')}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">Not recorded</div>
              )}
            </div>
          </div>
        </div>
        <div className="plan-right">
          <div className="panel-head">
            <span style={{ color: 'var(--amber)' }}>ARCHIVED TRANSCRIPT · {savedAt}</span>
            <span className="spacer" />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--tx-3)' }}>
              read-only
            </span>
          </div>
          <div className="chat">
            <div className="chat-scroll">
              <div
                style={{
                  marginBottom: 14,
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-2)',
                  color: 'var(--tx-2)',
                  fontSize: 12,
                  lineHeight: 1.55,
                }}
              >
                Historical mode does not stream new PM turns. Use Re-open in Planning to seed a
                fresh editable plan from this archived record.
              </div>
              {historicalView.messages.length > 0 ? (
                historicalView.messages.map((m, i) => <Message key={i} m={m} />)
              ) : (
                <div
                  style={{
                    padding: 24,
                    color: 'var(--tx-3)',
                    fontFamily: 'var(--mono)',
                    fontSize: 12,
                    textAlign: 'center',
                  }}
                >
                  Planning conversation: Not recorded for this session.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="plan">
      <Charter
        charter={session.charter}
        team={session.team}
        taskGraph={session.taskGraph}
        phase={session.phase}
        branchMode={session.branchMode}
        branchName={session.branchName}
        onBranchNameChange={session.setBranchName}
        onConstraintsChange={session.setConstraints}
        onNongoalsChange={session.setNongoals}
        projectName={projectName}
        projectMd={context.projectMd}
        contextFiles={context.contextFiles}
      />
      <div className="plan-right">
        <div className="panel-head">
          <span>PM Conversation</span>
          <button
            className="new-session-btn"
            onClick={() => {
              session.newSession();
              setPendingIntake(null);
              onNewSession?.();
            }}
            title="Clear conversation and start fresh"
          >
            New session
          </button>
          <span className="spacer" />
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              textTransform: 'none',
              letterSpacing: 0,
            }}
          >
            {modeLabel && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--tx-3)' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: modeDot }} />
                {modeLabel}
              </span>
            )}
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--tx-2)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: phaseDot }} />
              {phaseLabel}
            </span>
          </span>
        </div>
        <div className="chat">
          <div className="chat-scroll" ref={scrollRef}>
            {session.messages.map((m, i) => (
              <Message key={i} m={m} />
            ))}
            {!session.messages.some(m => m.from === 'you') &&
              !session.typing &&
              !session.streamingPmText &&
              !session.researching &&
              !activePendingIntake && (
                <StarterPrompts
                  onPick={text => {
                    setInput(text);
                    textareaRef.current?.focus();
                  }}
                />
              )}
            {activePendingIntake && (
              <>
                <Message m={{ from: 'you', text: activePendingIntake.text }} />
                <IntakeStatusCard
                  pending={activePendingIntake}
                  state={intakeState}
                  serverDown={serverStatus === 'down'}
                  onAccept={acceptIntakeDecision}
                  onChooseShape={chooseIntakeShape}
                  onContinue={continueWithNormalPlanning}
                />
              </>
            )}
            {session.streamingPmText ? (
              <StreamingMessage text={session.streamingPmText} />
            ) : session.pmActivity && session.pmActivity.length > 0 ? (
              // Live transcript — thinking blocks and the scout step appear here as
              // expandable entries (the scout no longer takes over the whole pane).
              <div style={{ padding: '4px 2px' }}>
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 4 }}>PM thinking…</div>
                <div style={{ borderLeft: '1px solid var(--bg-3)', paddingLeft: 10 }}>
                  {session.pmActivity.map((entry, i) => (
                    <ActivityItem key={i} entry={entry} />
                  ))}
                </div>
              </div>
            ) : session.typing ? (
              <ProgressiveTypingIndicator />
            ) : null}
            {session.hireSuggestion &&
              !session.team.includes(session.hireSuggestion.agentId) &&
              !session.researching &&
              !session.streamingPmText &&
              !session.typing && (
                <HireCallout
                  agentId={session.hireSuggestion.agentId}
                  reason={session.hireSuggestion.reason}
                  onHire={onHire}
                  onDismiss={session.dismissHire}
                />
              )}
            {session.executable && !session.streamingPmText && !session.typing && (
              <PlanReadyCallout
                charter={session.charter}
                team={session.team}
                taskGraph={session.taskGraph}
                modelPolicy={modelPolicy}
                onExecute={executePlan}
                onSetTaskRoute={session.setTaskRoute}
              />
            )}
          </div>
          {session.suggestCompact && (
            <div className="compact-banner">
              <span className="compact-icon">⚠</span>
              <span className="compact-text">
                This conversation is getting long — compact it to save context.
              </span>
              <button className="compact-btn" onClick={session.compact} disabled={!!session.typing}>
                Compact
              </button>
            </div>
          )}
          {playwrightAvailable === false && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                padding: '8px 12px',
                margin: '0 0 8px',
                borderRadius: 8,
                background: 'var(--bg-2)',
                border: '1px solid var(--border)',
                fontSize: 11.5,
                color: 'var(--tx-2)',
              }}
            >
              <span>
                🎭 Visual verification is off — install Playwright to screenshot UI changes during
                runs.
              </span>
              <code
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10.5,
                  color: 'var(--tx-3)',
                  userSelect: 'all',
                }}
              >
                npm i playwright && npx playwright install chromium
              </code>
            </div>
          )}
          <div className="composer">
            <div className="composer-row">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  session.phase === 'start'
                    ? 'Waiting for PM…'
                    : intakePending
                      ? 'Review the workflow recommendation…'
                      : session.typing
                        ? 'PM is typing…'
                        : 'Reply to the PM — Enter to send'
                }
                disabled={session.phase === 'start' || !!session.typing || intakePending}
                style={{
                  opacity: session.phase === 'start' || !!session.typing || intakePending ? 0.5 : 1,
                }}
              />
              <button
                className="send-btn"
                onClick={handleSend}
                disabled={!input.trim() || !!session.typing || intakePending}
              >
                <IconSend />
              </button>
            </div>
            <div className="hint">{hint}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
