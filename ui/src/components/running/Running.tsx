import { useRef, useEffect, useState } from 'react';
import { useRunSimulation }  from '../../hooks/useRunSimulation';
import { useRealRun }        from '../../hooks/useRealRun';
import { TaskGraph }         from './TaskGraph';
import { AgentsPanel }       from './AgentsPanel';
import { FindingsFeed }      from './FindingsFeed';
import { ChangesPanel }      from './ChangesPanel';
import { Message }           from '../planning/Message';
import { IconSend }          from '../common/icons';
import type { RunStatus }    from '../../types';

// ─── Shared view ──────────────────────────────────────────────────────────────

interface RunViewProps {
  project:       string;
  tier:          string;
  tasks:         ReturnType<typeof useRunSimulation>['tasks'];
  agents:        ReturnType<typeof useRunSimulation>['agents'];
  findings:      ReturnType<typeof useRunSimulation>['findings'];
  pmMsgs:        ReturnType<typeof useRunSimulation>['pmMsgs'];
  spend:         number;
  spendCap:      number;
  status:        RunStatus;
  connected?:    boolean;
  onPause?:      () => void;
  onAbort?:      () => void;
  onPrCreated?:  (url: string) => void;
}

// ─── Post-run actions ─────────────────────────────────────────────────────────

type ActionState = 'idle' | 'pending' | 'ok' | 'err';

function PostRunActions({ onToggleChanges, showChanges, onPrCreated }: {
  onToggleChanges: () => void;
  showChanges:     boolean;
  onPrCreated?:    (url: string) => void;
}) {
  const [pushState, setPushState] = useState<ActionState>('idle');
  const [pushErr,   setPushErr]   = useState<string | null>(null);
  const [prState,   setPrState]   = useState<ActionState>('idle');
  const [prErr,     setPrErr]     = useState<string | null>(null);
  const [prUrl,     setPrUrl]     = useState<string | null>(null);

  const push = () => {
    setPushState('pending'); setPushErr(null);
    fetch('/run/push', { method: 'POST' })
      .then(r => r.json())
      .then((d: { ok: boolean; error?: string }) => {
        if (d.ok) { setPushState('ok'); }
        else      { setPushState('err'); setPushErr(d.error ?? 'Push failed'); }
      })
      .catch((e: Error) => { setPushState('err'); setPushErr(e.message); });
  };

  const createPr = () => {
    setPrState('pending'); setPrErr(null);
    fetch('/run/pr', { method: 'POST' })
      .then(r => r.json())
      .then((d: { ok: boolean; url?: string; error?: string }) => {
        if (d.ok) {
          const url = d.url ?? null;
          setPrState('ok'); setPrUrl(url);
          // Navigate back to Planning with a recap after a short beat
          // so the user can see the "View PR" button briefly before leaving.
          if (url) setTimeout(() => onPrCreated?.(url), 1200);
        } else {
          setPrState('err'); setPrErr(d.error ?? 'PR creation failed');
        }
      })
      .catch((e: Error) => { setPrState('err'); setPrErr(e.message); });
  };

  const errStyle: React.CSSProperties = {
    fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--red)',
    maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  };

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      {/* Changes toggle */}
      <button
        className={`btn sm${showChanges ? ' active' : ''}`}
        onClick={onToggleChanges}
        title="Review code changes made during this run"
      >
        {showChanges ? 'Hide changes' : 'View changes'}
      </button>

      <span style={{ width: 1, height: 16, background: 'var(--border-1)', flexShrink: 0 }} />

      {/* Push — locked once a PR exists (no point re-pushing) */}
      <button
        className="btn sm"
        onClick={push}
        disabled={pushState === 'pending' || pushState === 'ok' || prState === 'ok'}
        title={prState === 'ok' ? 'Already pushed — PR is open' : 'git push origin HEAD'}
      >
        {pushState === 'pending' ? 'Pushing…' : pushState === 'ok' ? '✓ Pushed' : pushState === 'err' ? 'Retry push' : 'Push'}
      </button>
      {pushState === 'err' && pushErr && (
        <span style={errStyle} title={pushErr}>⚠ {pushErr}</span>
      )}

      {/* Create PR / View PR — requires a successful push first */}
      {prState === 'ok' && prUrl ? (
        <a
          href={prUrl} target="_blank" rel="noopener noreferrer"
          className="btn sm primary"
          style={{ textDecoration: 'none' }}
        >
          View PR ↗
        </a>
      ) : (
        <button
          className="btn sm primary"
          onClick={createPr}
          disabled={prState === 'pending' || pushState !== 'ok'}
          title={pushState !== 'ok' ? 'Push first, then create a PR' : 'gh pr create'}
        >
          {prState === 'pending' ? 'Creating PR…' : prState === 'err' ? 'Retry PR' : 'Create PR'}
        </button>
      )}
      {prState === 'err' && prErr && (
        <span style={errStyle} title={prErr}>⚠ {prErr}</span>
      )}
    </div>
  );
}

// ─── Run controls ─────────────────────────────────────────────────────────────

function RunControls({ status, onPause, onAbort, onToggleChanges, showChanges, onPrCreated }: {
  status:           RunStatus;
  onPause?:         () => void;
  onAbort?:         () => void;
  onToggleChanges?: () => void;
  showChanges?:     boolean;
  onPrCreated?:     (url: string) => void;
}) {
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [pending, setPending] = useState<'aborting' | 'pausing' | null>(null);

  // Clear pending state once the server confirms via SSE
  useEffect(() => {
    if (status === 'aborted' || status === 'done') setPending(null);
    if (status === 'paused')                       setPending(null);
  }, [status]);

  const done = status === 'done' || status === 'aborted';

  // ── Pending feedback ────────────────────────────────────────────────────────
  if (pending === 'aborting') {
    return (
      <span style={{
        fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--amber)',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--amber)', animation: 'softpulse 1.4s infinite' }} />
        Aborting — current task will finish first
      </span>
    );
  }

  if (pending === 'pausing') {
    return (
      <span style={{
        fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--tx-2)',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--tx-3)', animation: 'softpulse 1.4s infinite' }} />
        Pausing — current task will finish first
      </span>
    );
  }

  // ── Abort confirmation ──────────────────────────────────────────────────────
  if (confirmAbort) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--tx-2)',
          maxWidth: 280, lineHeight: 1.4,
        }}>
          The current agent will finish its task, then stop.
          Changes already written to disk remain.
        </span>
        <button className="btn sm danger" onClick={() => {
          onAbort?.();
          setPending('aborting');
          setConfirmAbort(false);
        }}>
          Confirm abort
        </button>
        <button className="btn sm" onClick={() => setConfirmAbort(false)}>
          Cancel
        </button>
      </div>
    );
  }

  // ── Done: replace Pause/Abort with post-run actions ────────────────────────
  if (done) return (
    <PostRunActions
      onToggleChanges={onToggleChanges ?? (() => {})}
      showChanges={showChanges ?? false}
      onPrCreated={onPrCreated}
    />
  );

  // ── Normal controls ─────────────────────────────────────────────────────────
  const pauseTitle = status === 'paused'
    ? 'Resume the run — agents will continue from where they left off.'
    : 'Pause after the current agent task completes. Does not interrupt a running agent — it will finish first.';

  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {onPause && (
        <button
          className="btn sm"
          onClick={() => {
            onPause();
            if (status !== 'paused') setPending('pausing');
          }}
          disabled={done}
          title={pauseTitle}
        >
          {status === 'paused' ? 'Resume' : 'Pause'}
        </button>
      )}
      {onAbort && (
        <button
          className="btn sm danger"
          onClick={() => setConfirmAbort(true)}
          disabled={done}
          title="Stop the run after the current agent task finishes."
        >
          Abort
        </button>
      )}
    </div>
  );
}

function PmChat({ pmMsgs, status }: { pmMsgs: RunViewProps['pmMsgs']; status: RunStatus }) {
  const chatRef  = useRef<HTMLDivElement>(null);
  const taRef    = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const [busy,  setBusy]  = useState(false);

  // Auto-scroll when new messages arrive
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [pmMsgs]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [draft]);

  const disabled = status === 'done' || status === 'aborted';

  const send = () => {
    const text = draft.trim();
    if (!text || busy || disabled) return;
    setBusy(true);
    setDraft('');
    fetch('/run/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).finally(() => setBusy(false));
  };

  return (
    <div className="run-chat">
      <div className="panel-head"><span>PM Chat</span></div>
      <div className="chat" style={{ minHeight: 0 }}>
        <div className="chat-scroll" ref={chatRef}>
          {pmMsgs.length === 0 && (
            <span style={{ color: 'var(--tx-3)', fontFamily: 'var(--mono)', fontSize: 11, padding: '2px 0' }}>
              PM messages will appear here…
            </span>
          )}
          {pmMsgs.map((m, i) => <Message key={i} m={m} />)}
        </div>
        <div className="composer">
          <div className="composer-row">
            <textarea
              ref={taRef}
              rows={1}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder={disabled ? 'Run complete.' : 'Message the PM — pause the run to intervene…'}
              disabled={disabled || busy}
            />
            <button
              className="send-btn"
              onClick={send}
              disabled={!draft.trim() || disabled || busy}
              title="Send (Enter)"
            >
              <IconSend />
            </button>
          </div>
          {!disabled && (
            <div className="hint">Enter to send · Shift+Enter for newline</div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunView({
  project, tier, tasks, agents, findings, pmMsgs,
  spend, spendCap, status, connected = true,
  onPause, onAbort, onPrCreated,
}: RunViewProps) {
  const [showChanges, setShowChanges] = useState(false);

  const tierColour = tier === 'tweak' ? 'blue' : tier === 'greenfield' ? 'green' : 'amber';
  const statusMeta: Record<RunStatus, { cls: string; label: string }> = {
    running: { cls: 'running', label: 'running' },
    paused:  { cls: 'paused',  label: 'paused'  },
    done:    { cls: 'done',    label: 'done'     },
    aborted: { cls: 'aborted', label: 'aborted'  },
  };
  const { cls, label } = statusMeta[status] ?? statusMeta.running;

  const agentSteps = Object.fromEntries(
    Object.entries(agents).map(([k, v]) => [k, v.active ? v.step : ''])
  );

  return (
    <div className="run">
      <div className="run-head">
        <span className="pname">{project}</span>
        <span className={`badge ${tierColour}`}>{tier.toUpperCase()}</span>
        {!connected && (
          <span style={{ fontSize: 11, color: 'var(--amber)', fontFamily: 'var(--mono)', marginLeft: 4 }}>
            ⚠ reconnecting…
          </span>
        )}
        <span className={`run-status ${cls}`}>
          <span className="rdot" />{label}
        </span>
        <div className="spacer" />
        <RunControls
          status           = {status}
          onPause          = {onPause}
          onAbort          = {onAbort}
          onToggleChanges  = {() => setShowChanges(v => !v)}
          showChanges      = {showChanges}
          onPrCreated      = {onPrCreated}
        />
        <div className="spend">
          <div className="spend-top">
            <span className="amt">${spend.toFixed(2)}</span>
            <span className="cap">/ ${spendCap.toFixed(2)}</span>
          </div>
          <div className="spend-bar">
            <i style={{ width: `${Math.min(100, (spend / spendCap) * 100)}%` }} />
          </div>
        </div>
      </div>

      {showChanges ? (
        <ChangesPanel />
      ) : (
        <>
          <TaskGraph tasks={tasks} agentSteps={agentSteps} />
          <div className="run-right">
            <AgentsPanel agents={agents} status={status} />
            <FindingsFeed findings={findings} tasks={tasks} />
          </div>
        </>
      )}

      <PmChat pmMsgs={pmMsgs} status={status} />
    </div>
  );
}

// ─── Server-down screen ───────────────────────────────────────────────────────

function ServerDown() {
  return (
    <div style={{
      height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 28, padding: 40,
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--tx-3)', marginBottom: 10 }}>
          Swarm server not running
        </div>
        <div style={{ color: 'var(--tx-2)', fontSize: 13, maxWidth: 420, lineHeight: 1.6 }}>
          Start the server in one terminal, then run a task in another.
          This panel will connect automatically.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 560 }}>
        <Step n={1} label="Start the server">
          <Code>cd /path/to/swarm/core</Code>
          <Code>npm run dev</Code>
        </Step>
        <Step n={2} label="Run a task in your project">
          <Code>cd /your/project</Code>
          <Code>swarm init</Code>
          <Code>swarm new "describe what you want to build"</Code>
        </Step>
        <Step n={3} label="Watch it here">
          <div style={{ color: 'var(--tx-2)', fontSize: 12, fontFamily: 'var(--mono)', padding: '8px 12px' }}>
            This panel updates live as agents run.
          </div>
        </Step>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        color: 'var(--tx-3)', fontSize: 11, fontFamily: 'var(--mono)',
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--tx-3)', animation: 'softpulse 1.4s infinite', display: 'inline-block' }} />
        retrying every 3 seconds…
      </div>
    </div>
  );
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-1)', border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)', padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{
          width: 22, height: 22, borderRadius: '50%', background: 'var(--bg-3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 700, color: 'var(--tx-2)', fontFamily: 'var(--mono)', flexShrink: 0,
        }}>{n}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tx-1)' }}>{label}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {children}
      </div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--tx)',
      background: 'var(--bg)', border: '1px solid var(--border-soft)',
      borderRadius: 5, padding: '6px 10px',
    }}>
      <span style={{ color: 'var(--tx-3)', userSelect: 'none' }}>$ </span>
      {children}
    </div>
  );
}

// ─── Running: real backend or server-down screen ──────────────────────────────

export function Running({ onPrCreated }: { onPrCreated?: (url: string) => void }) {
  const { serverStatus, state } = useRealRun();

  if (serverStatus === 'probing') {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: 'var(--tx-3)', fontFamily: 'var(--mono)', fontSize: 13 }}>
          connecting…
        </span>
      </div>
    );
  }

  if (serverStatus === 'down' || !state) {
    return <ServerDown />;
  }

  // Server is up but no run has been started yet (state.json doesn't exist or tasks is empty).
  if (state.tasks.length === 0 && state.status === 'running') {
    return (
      <div style={{
        height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 12, padding: 40,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--tx-3)' }}>
          No active run
        </div>
        <div style={{ color: 'var(--tx-2)', fontSize: 13, maxWidth: 340, textAlign: 'center', lineHeight: 1.7 }}>
          Go to <strong style={{ color: 'var(--tx-1)' }}>Planning</strong> and click{' '}
          <strong style={{ color: 'var(--tx-1)' }}>Execute</strong> to start a run.
          This panel will update live as agents work.
        </div>
      </div>
    );
  }

  const pause = () => fetch('/run/pause',  { method: 'POST' }).catch(() => {});
  const abort = () => fetch('/run/abort',  { method: 'POST' }).catch(() => {});
  const resume = () => fetch('/run/resume', { method: 'POST' }).catch(() => {});

  return (
    <RunView
      project      = {state.project}
      tier         = {state.tier}
      tasks        = {state.tasks}
      agents       = {state.agents}
      findings     = {state.findings}
      pmMsgs       = {state.pmMsgs}
      spend        = {state.spend}
      spendCap     = {state.spendCap}
      status       = {state.status}
      connected    = {state.connected}
      onPause      = {state.status === 'paused' ? resume : pause}
      onAbort      = {abort}
      onPrCreated  = {onPrCreated}
    />
  );
}
