import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { usePlanningSession } from '../../hooks/usePlanningSession';
import { useContextFiles } from '../../hooks/useContextFiles';
import { Charter } from './Charter';
import { Message, StreamingMessage, ProgressiveTypingIndicator } from './Message';
import { resolveAgentPersona } from '../../data/personas';
import { IconSend } from '../common/icons';
import { ActivityItem } from '../common/ActivityItem';
import type { ServerStatus, RunCharter } from '../../App';
import type { CharterData, SessionSnapshot } from '../../types';

function PlanReadyCallout({
  charter,
  team,
  onExecute,
}: {
  charter: CharterData;
  team: string[];
  onExecute?: () => void;
}) {
  const openQuestions = charter.questions.filter(q => !q.resolved);
  const noTeam = team.length === 0;
  const noGoal = !charter.goal;

  const blockers: string[] = [];
  if (noGoal) blockers.push('no goal defined');
  if (noTeam) blockers.push('no agents in the team');
  if (openQuestions.length)
    blockers.push(
      `${openQuestions.length} open question${openQuestions.length > 1 ? 's' : ''} unresolved`,
    );

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
      <div className="plan-ready-actions">
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
  onExecute?: () => void;
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
}

export function Planning({
  onExecute,
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
}: PlanningProps) {
  // Derive project name synchronously from localStorage (source of truth for active root).
  // This avoids a race with App.tsx's auto-sync: if the server has been restarted and
  // still points at the old project, a /state fetch would return the wrong name before
  // the auto-sync fires. Reading localStorage directly is always instantaneous and correct.
  const [projectName] = useState<string | undefined>(() => {
    try {
      const root = localStorage.getItem('swarm-active-root');
      if (root) return root.split('/').filter(Boolean).pop() ?? undefined;
    } catch {
      /* private mode */
    }
    return undefined;
  });

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
    projectName ?? 'default',
    recapMessage,
    runBlockedReason,
  );
  const context = useContextFiles();
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // When App asks us to start a fresh session (after a run completes), call
  // newSession(). The planNextKey increments each time — skip the initial 0.
  const prevPlanNextKey = useRef(planNextKey ?? 0);
  useEffect(() => {
    if (!planNextKey || planNextKey === prevPlanNextKey.current) return;
    prevPlanNextKey.current = planNextKey;
    session.newSession();
  }, [planNextKey, session.newSession]);

  // "Re-open in Planning" from a historical session — seed an editable plan from it.
  const prevReopenKey = useRef(reopenKey ?? 0);
  useEffect(() => {
    if (!reopenKey || reopenKey === prevReopenKey.current) return;
    prevReopenKey.current = reopenKey;
    if (reopenSeed) session.reopen(reopenSeed);
  }, [reopenKey, reopenSeed, session.reopen]);

  // A post-run "Request changes" review arrived — send it to the PM as a message
  // (it reads it like a reviewer's CHANGES_REQUESTED and plans a coder+reviewer fix).
  // Guard on the key so it fires exactly once per submission.
  const prevReviewKey = useRef(0);
  useEffect(() => {
    if (!reviewRequest || reviewRequest.key === prevReviewKey.current) return;
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
    if (initFired.current) return;
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
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [session.messages, session.typing, session.streamingPmText]);

  // Auto-grow textarea. Use height='0' (not 'auto') before measuring so that
  // scrollHeight reflects actual content rather than the rows attribute.
  // min-height in CSS guarantees at least one visible line.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [input]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || session.typing) return;
    setInput('');
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
    const hc = historicalSession.charter;
    const historicalCharter = {
      goal: historicalSession.goal,
      constraints: (hc?.constraints ?? []).map(t => ({ text: t })),
      nongoals: (hc?.nongoals ?? []).map(t => ({ text: t })),
      questions: (hc?.questions ?? []).map(t => ({ text: t, resolved: true })),
    };
    const historicalMessages = (hc?.planningHistory ?? []).map(m => ({
      from: m.from as 'pm' | 'you',
      text: m.text,
    }));
    const savedAt = new Date(historicalSession.savedAt).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return (
      <div className="plan">
        <Charter
          charter={historicalCharter}
          team={[]}
          phase={'ready' as const}
          projectName={projectName}
          projectMd={context.projectMd}
          contextFiles={context.contextFiles}
        />
        <div className="plan-right">
          <div className="panel-head">
            <span style={{ color: 'var(--amber)' }}>⏱ Archived · {savedAt}</span>
            <span className="spacer" />
            {historicalSession.branchName && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--tx-3)' }}>
                {historicalSession.branchName.replace(/^swarm\//, '')}
              </span>
            )}
          </div>
          <div className="chat">
            <div className="chat-scroll">
              {historicalMessages.length > 0 ? (
                historicalMessages.map((m, i) => <Message key={i} m={m} />)
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
                  No planning conversation recorded for this session.
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
        phase={session.phase}
        branchMode={session.branchMode}
        branchName={session.branchName}
        onBranchNameChange={session.setBranchName}
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
                onExecute={onExecute}
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
                    : session.typing
                      ? 'PM is typing…'
                      : 'Reply to the PM — Enter to send'
                }
                disabled={session.phase === 'start' || !!session.typing}
                style={{ opacity: session.phase === 'start' || !!session.typing ? 0.5 : 1 }}
              />
              <button
                className="send-btn"
                onClick={handleSend}
                disabled={!input.trim() || !!session.typing}
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
