import { useRef, useEffect, useState, useCallback } from 'react';
import type React from 'react';
import { useRunSimulation } from '../../hooks/useRunSimulation';
import type { RealRun, RealRunState } from '../../hooks/useRealRun';
import { useQuickTaskDiff } from '../../hooks/useQuickTaskDiff';
import { QuickTaskCard } from '../quick-task/QuickTaskCard';
import { projectQuickTaskCard } from '../../data/quickTaskRuntime';
import { NotifyToggle } from './NotifyToggle';
import { TaskGraph } from './TaskGraph';
import { AgentsPanel } from './AgentsPanel';
import { FindingsFeed } from './FindingsFeed';
import { ChangesPanel } from './ChangesPanel';
import { InboxPanel } from './InboxPanel';
import { Message } from '../planning/Message';
import { IconSend } from '../common/icons';
import type {
  RunStatus,
  SessionSnapshot,
  Task,
  AgentState,
  ActivityEntry,
  Finding,
  ChatMessage,
  PermissionRequest,
} from '../../types';

// ─── Drag-to-resize ──────────────────────────────────────────────────────────

function useDragResize(
  initialPx: number,
  min: number,
  max: number,
  storageKey: string,
  sign: 1 | -1 = 1,
): [number, (e: React.MouseEvent) => void] {
  const [px, setPx] = useState<number>(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v) return Math.min(max, Math.max(min, +v));
    } catch {}
    return initialPx;
  });
  const pxRef = useRef(px);
  useEffect(() => {
    pxRef.current = px;
  }, [px]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startPx = pxRef.current;
      const clamp = (v: number) => Math.min(max, Math.max(min, v));
      const onMove = (ev: MouseEvent) => setPx(clamp(startPx + sign * (ev.clientX - startX)));
      const onUp = (ev: MouseEvent) => {
        const final = clamp(startPx + sign * (ev.clientX - startX));
        setPx(final);
        try {
          localStorage.setItem(storageKey, String(final));
        } catch {}
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [max, min, sign, storageKey],
  );

  return [px, onMouseDown];
}

function DragHandle({
  gridColumn,
  onMouseDown,
}: {
  gridColumn: number;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  return <div className="run-drag-handle" style={{ gridColumn }} onMouseDown={onMouseDown} />;
}

// ─── Shared view ──────────────────────────────────────────────────────────────

interface RunViewProps {
  project: string;
  tier: string;
  tasks: ReturnType<typeof useRunSimulation>['tasks'];
  agents: ReturnType<typeof useRunSimulation>['agents'];
  taskActivity?: Record<string, ActivityEntry[]>;
  taskTimings?: Record<string, { startedAt: number; endedAt: number | null }>;
  findings: ReturnType<typeof useRunSimulation>['findings'];
  pmMsgs: ReturnType<typeof useRunSimulation>['pmMsgs'];
  spend: number;
  spendCap: number;
  status: RunStatus;
  connected?: boolean;
  alreadyPushed?: boolean;
  branchName?: string;
  elapsedMs?: number | null;
  onPause?: () => void;
  onAbort?: () => void;
  onPrCreated?: (url: string) => void;
  // Lifted to the stable parent so the diff survives RunView remounts during a
  // review-fix run (which briefly wipes the task list).
  showChanges: boolean;
  onToggleShowChanges: () => void;
  pendingPermission?: PermissionRequest | null;
}

// ─── Run summary strip ────────────────────────────────────────────────────────
// Shown below the run header when all agents finish.

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

// The quality gates the system enforces, in pipeline order. A badge shows for each
// gate that actually ran (produced a finding) — making the "structurally enforced
// quality" promise visible at a glance after a run.
const GATE_DEFS: { agent: string; label: string }[] = [
  { agent: 'tester', label: 'Tests' },
  { agent: 'security', label: 'Security' },
  { agent: 'reviewer', label: 'Review' },
  { agent: 'checks', label: 'Checks' },
  { agent: 'visual', label: 'Visual' },
];

// Pure: collapse the findings into one pass/fail badge per gate that ran. Uses the
// NEWEST finding per gate so a re-review that ultimately passed reads as a pass,
// not the superseded "changes requested".
export function deriveGates(
  findings: RunViewProps['findings'],
): { label: string; status: 'pass' | 'fail' }[] {
  const newestFirst = [...findings].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  const out: { label: string; status: 'pass' | 'fail' }[] = [];
  for (const def of GATE_DEFS) {
    const newest = newestFirst.find(f => f.agent === def.agent);
    if (!newest) {
      continue;
    }
    const failed = newest.verdict === 'fail' || newest.verdict === 'changes';
    out.push({ label: def.label, status: failed ? 'fail' : 'pass' });
  }
  return out;
}

function RunSummary({
  tasks,
  findings,
  spend,
  elapsedMs,
}: {
  tasks: RunViewProps['tasks'];
  findings: RunViewProps['findings'];
  spend: number;
  elapsedMs: number | null | undefined;
}) {
  const gates = deriveGates(findings);
  const total = tasks.length;
  // 'blocked' = "changes requested" — the task did its job; only true failures count here.
  const failed = tasks.filter(t => t.status === 'failed').length;
  const allOk = failed === 0;
  const findingsFailed = findings.filter(
    f => f.verdict === 'fail' || f.verdict === 'changes',
  ).length;
  const overallOk = allOk && findingsFailed === 0;

  return (
    <div className={`run-summary ${overallOk ? 'ok' : 'warn'}`}>
      <span className="run-summary-icon">{overallOk ? '✓' : '⚠'}</span>
      <span>
        {total} task{total !== 1 ? 's' : ''} ·{' '}
        {failed > 0 ? <span style={{ color: 'var(--red)' }}>{failed} failed</span> : 'all passed'}
      </span>
      {elapsedMs != null && (
        <>
          <span className="run-summary-sep">·</span>
          <span>{formatElapsed(elapsedMs)}</span>
        </>
      )}
      {spend > 0 && (
        <>
          <span className="run-summary-sep">·</span>
          <span>${spend.toFixed(4)}</span>
        </>
      )}
      {gates.length > 0 && (
        <span className="run-summary-gates" title="Quality gates enforced this run">
          {gates.map(g => (
            <span key={g.label} className={`gate-badge ${g.status}`}>
              <span className="gate-mark">{g.status === 'pass' ? '✓' : '✗'}</span>
              {g.label}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

// ─── Post-run actions ─────────────────────────────────────────────────────────

type ActionState = 'idle' | 'pending' | 'ok' | 'err';

// ── Ship modal ────────────────────────────────────────────────────────────────
// Shown when the user clicks "Ship →". Content is contextual:
//   • feature branch → recommend PR, offer push-only fallback
//   • main branch    → single push button

function ShipModal({
  branchName,
  onClose,
  onShipped,
  onPrCreated,
}: {
  branchName?: string;
  onClose: () => void;
  onShipped: () => void;
  onPrCreated?: (url: string) => void;
}) {
  const [pushState, setPushState] = useState<ActionState>('idle');
  const [pushErr, setPushErr] = useState<string | null>(null);
  const [prState, setPrState] = useState<ActionState>('idle');
  const [prErr, setPrErr] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [ghMissing, setGhMissing] = useState(false);

  const [existingPr, setExistingPr] = useState<{ url: string; state: string } | null>(null);

  // Check whether the branch's work is already shipped — three signals:
  //   pushed:       branch exists on the remote (ls-remote, not stale cache)
  //   alreadyInMain: all commits landed via cherry-pick / merge (git cherry)
  //   pr:           a PR was opened (implies a prior push)
  useEffect(() => {
    fetch('/run/branch-pushed')
      .then(r => r.json())
      .then(
        (d: {
          pushed: boolean;
          alreadyInMain: boolean;
          pr: { url: string; state: string } | null;
        }) => {
          if (d.pushed || d.alreadyInMain) setPushState('ok');
          if (d.pr) setExistingPr(d.pr);
        },
      )
      .catch(() => {}); // best-effort
  }, []);

  const push = useCallback(() => {
    setPushState('pending');
    setPushErr(null);
    fetch('/run/push', { method: 'POST' })
      .then(r => r.json())
      .then((d: { ok: boolean; error?: string }) => {
        if (d.ok) {
          setPushState('ok');
          onShipped();
        } else {
          setPushState('err');
          setPushErr(d.error ?? 'Push failed');
        }
      })
      .catch((e: Error) => {
        setPushState('err');
        setPushErr(e.message);
      });
  }, [onShipped]);

  const createPr = useCallback(() => {
    setPrState('pending');
    setPrErr(null);
    setGhMissing(false);
    fetch('/run/pr', { method: 'POST' })
      .then(r => r.json())
      .then((d: { ok: boolean; url?: string; error?: string; ghNotInstalled?: boolean }) => {
        if (d.ok) {
          const url = d.url ?? null;
          setPrState('ok');
          setPrUrl(url);
          onShipped();
          if (url)
            setTimeout(() => {
              onPrCreated?.(url);
              onClose();
            }, 1200);
          else setTimeout(onClose, 800);
        } else {
          setPrState('err');
          if (d.ghNotInstalled) {
            setGhMissing(true);
            setPrErr(null); // use the dedicated ghMissing UI
          } else {
            setPrErr(d.error ?? 'PR creation failed');
          }
        }
      })
      .catch((e: Error) => {
        setPrState('err');
        setPrErr(e.message);
      });
  }, [onShipped, onPrCreated, onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const errStyle: React.CSSProperties = {
    fontSize: 11,
    fontFamily: 'var(--mono)',
    color: 'var(--red)',
    marginTop: 4,
  };

  return (
    <div className="ship-backdrop" onClick={onClose}>
      <div className="ship-modal" onClick={e => e.stopPropagation()}>
        <div className="ship-modal-head">
          <span>Ship changes</span>
          <button className="ship-modal-close" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        {branchName ? (
          // ── Feature branch: PR recommended, push-only fallback ─────────────
          <div className="ship-modal-body">
            <p className="ship-modal-context">
              Changes are on branch <code>{branchName}</code>.
            </p>

            {/* Primary: Create PR */}
            <div className="ship-option primary">
              <div className="ship-option-head">
                <div>
                  <div className="ship-option-title">
                    Create pull request
                    <span className="ship-option-badge">Recommended</span>
                  </div>
                  <div className="ship-option-desc">
                    Opens a PR on GitHub so changes can be reviewed before merging into main.
                  </div>
                </div>
                {(prState === 'ok' && prUrl) || existingPr ? (
                  <a
                    href={(prState === 'ok' ? prUrl : existingPr?.url) ?? '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn sm primary"
                    style={{ textDecoration: 'none', flexShrink: 0 }}
                  >
                    View PR ↗
                  </a>
                ) : (
                  <button
                    className="btn sm primary"
                    onClick={createPr}
                    disabled={prState === 'pending' || prState === 'ok' || pushState === 'ok'}
                    style={{ flexShrink: 0 }}
                  >
                    {prState === 'pending'
                      ? 'Creating PR…'
                      : prState === 'ok'
                        ? '✓ PR created'
                        : 'Create PR →'}
                  </button>
                )}
              </div>
              {prState === 'err' && prErr && <div style={errStyle}>⚠ {prErr}</div>}
              {ghMissing && (
                <div style={{ ...errStyle, lineHeight: 1.6 }}>
                  <strong>GitHub CLI not installed.</strong> To enable PR creation:
                  <br />
                  <code style={{ fontSize: 10 }}>brew install gh</code> then{' '}
                  <code style={{ fontSize: 10 }}>gh auth login</code>
                </div>
              )}
            </div>

            {/* Divider */}
            <div className="ship-or">or</div>

            {/* Secondary: Push branch only */}
            <div className="ship-option">
              <div className="ship-option-head">
                <div>
                  <div className="ship-option-title">Push branch only</div>
                  <div className="ship-option-desc">
                    Pushes <code>{branchName}</code> to origin without opening a PR. You can create
                    one later from GitHub.
                  </div>
                </div>
                <button
                  className="btn sm"
                  onClick={push}
                  disabled={pushState === 'pending' || pushState === 'ok' || prState === 'ok'}
                  style={{ flexShrink: 0 }}
                >
                  {pushState === 'pending'
                    ? 'Pushing…'
                    : pushState === 'ok'
                      ? '✓ Pushed'
                      : 'Push branch'}
                </button>
              </div>
              {pushState === 'err' && pushErr && <div style={errStyle}>⚠ {pushErr}</div>}
            </div>
          </div>
        ) : (
          // ── Main branch: single push ────────────────────────────────────────
          <div className="ship-modal-body">
            <p className="ship-modal-context">
              Changes were committed directly to <code>main</code>.
            </p>
            <div className="ship-option primary">
              <div className="ship-option-head">
                <div>
                  <div className="ship-option-title">Push to origin</div>
                  <div className="ship-option-desc">
                    Runs <code>git push origin HEAD</code> to publish the commits.
                  </div>
                </div>
                <button
                  className="btn sm primary"
                  onClick={push}
                  disabled={pushState === 'pending' || pushState === 'ok'}
                  style={{ flexShrink: 0 }}
                >
                  {pushState === 'pending'
                    ? 'Pushing…'
                    : pushState === 'ok'
                      ? '✓ Pushed'
                      : 'Push to origin'}
                </button>
              </div>
              {pushState === 'err' && pushErr && <div style={errStyle}>⚠ {pushErr}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PostRunActions({
  onToggleChanges,
  showChanges,
  onPrCreated,
  alreadyPushed,
  branchName,
}: {
  onToggleChanges: () => void;
  showChanges: boolean;
  onPrCreated?: (url: string) => void;
  alreadyPushed?: boolean;
  branchName?: string;
}) {
  const [shipped, setShipped] = useState(alreadyPushed ?? false);
  const [showShip, setShowShip] = useState(false);

  const handleShipped = useCallback(() => setShipped(true), []);
  const handleClose = useCallback(() => setShowShip(false), []);

  return (
    <>
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

        {/* Ship → opens the contextual dialog */}
        <button
          className="btn sm primary"
          onClick={() => setShowShip(true)}
          disabled={shipped}
          title={shipped ? 'Changes already shipped' : 'Push or open a pull request'}
        >
          {shipped ? '✓ Shipped' : 'Ship →'}
        </button>
      </div>

      {showShip && (
        <ShipModal
          branchName={branchName}
          onClose={handleClose}
          onShipped={handleShipped}
          onPrCreated={onPrCreated}
        />
      )}
    </>
  );
}

// ─── Run controls ─────────────────────────────────────────────────────────────

function RunControls({
  status,
  tasks,
  onPause,
  onAbort,
  onToggleChanges,
  showChanges,
  onPrCreated,
  alreadyPushed,
  branchName,
}: {
  status: RunStatus;
  tasks?: RunViewProps['tasks'];
  onPause?: () => void;
  onAbort?: () => void;
  onToggleChanges?: () => void;
  showChanges?: boolean;
  onPrCreated?: (url: string) => void;
  alreadyPushed?: boolean;
  branchName?: string;
}) {
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [pending, setPending] = useState<'aborting' | 'pausing' | null>(null);

  // Clear pending state once the server confirms via SSE
  useEffect(() => {
    if (status === 'aborted' || status === 'done') setPending(null);
    if (status === 'paused') setPending(null);
  }, [status]);

  const done = status === 'done' || status === 'aborted';

  // ── Pending feedback ────────────────────────────────────────────────────────
  if (pending === 'aborting') {
    return (
      <span
        style={{
          fontSize: 11,
          fontFamily: 'var(--mono)',
          color: 'var(--amber)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--amber)',
            animation: 'softpulse 1.4s infinite',
          }}
        />
        Aborting — current task will finish first
      </span>
    );
  }

  if (pending === 'pausing') {
    return (
      <span
        style={{
          fontSize: 11,
          fontFamily: 'var(--mono)',
          color: 'var(--tx-2)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--tx-3)',
            animation: 'softpulse 1.4s infinite',
          }}
        />
        Pausing — current task will finish first
      </span>
    );
  }

  // ── Abort confirmation ──────────────────────────────────────────────────────
  if (confirmAbort) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: 11,
            fontFamily: 'var(--mono)',
            color: 'var(--tx-2)',
            maxWidth: 280,
            lineHeight: 1.4,
          }}
        >
          The current agent will finish its task, then stop. Changes already written to disk remain.
        </span>
        <button
          className="btn sm danger"
          onClick={() => {
            onAbort?.();
            setPending('aborting');
            setConfirmAbort(false);
          }}
        >
          Confirm abort
        </button>
        <button className="btn sm" onClick={() => setConfirmAbort(false)}>
          Cancel
        </button>
      </div>
    );
  }

  // ── Done: replace Pause/Abort with post-run actions ────────────────────────
  if (done)
    return (
      <PostRunActions
        onToggleChanges={onToggleChanges ?? (() => {})}
        showChanges={showChanges ?? false}
        onPrCreated={onPrCreated}
        alreadyPushed={alreadyPushed}
        branchName={branchName}
      />
    );

  // ── Normal controls ─────────────────────────────────────────────────────────
  const pauseTitle =
    status === 'paused'
      ? 'Resume the run — agents will continue from where they left off.'
      : 'Pause after the current agent task completes. Does not interrupt a running agent — it will finish first.';

  const coderDone = tasks?.some(t => t.assignee === 'coder' && t.status === 'done') ?? false;

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      {coderDone && onToggleChanges && (
        <>
          <button
            className={`btn sm${showChanges ? ' active' : ''}`}
            onClick={onToggleChanges}
            title="Review code changes made by the coder so far"
          >
            {showChanges ? 'Hide changes' : 'View changes'}
          </button>
          <span style={{ width: 1, height: 16, background: 'var(--border-1)', flexShrink: 0 }} />
        </>
      )}
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

function PmChat({
  pmMsgs,
  status,
  open,
  onToggle,
}: {
  pmMsgs: RunViewProps['pmMsgs'];
  status: RunStatus;
  open: boolean;
  onToggle: () => void;
}) {
  const chatRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [pmMsgs, open]);

  useEffect(() => {
    if (!open) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = '0';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [draft, open]);

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

  if (!open) {
    return (
      <div className="run-chat run-chat-collapsed" onClick={onToggle} title="Expand PM Chat">
        <span style={{ fontSize: 16, color: 'var(--tx-3)', lineHeight: 1 }}>‹</span>
        <span
          style={{
            writingMode: 'vertical-rl',
            transform: 'rotate(180deg)',
            fontSize: 10,
            fontFamily: 'var(--mono)',
            color: 'var(--tx-3)',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            userSelect: 'none',
            marginTop: 8,
          }}
        >
          PM Chat
        </span>
        {pmMsgs.length > 0 && (
          <span
            style={{
              marginTop: 10,
              fontSize: 9,
              fontFamily: 'var(--mono)',
              color: 'var(--blue)',
              background: 'rgba(77,141,244,0.14)',
              borderRadius: 8,
              padding: '2px 5px',
              lineHeight: 1.3,
            }}
          >
            {pmMsgs.length}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="run-chat">
      <div className="panel-head">
        <span>PM Chat</span>
        <button
          onClick={onToggle}
          title="Collapse PM Chat"
          style={{
            marginLeft: 'auto',
            fontSize: 16,
            color: 'var(--tx-3)',
            lineHeight: 1,
            padding: '0 2px',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          ›
        </button>
      </div>
      <div className="chat" style={{ minHeight: 0 }}>
        <div className="chat-scroll" ref={chatRef}>
          {pmMsgs.length === 0 && (
            <span
              style={{
                color: 'var(--tx-3)',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                padding: '2px 0',
              }}
            >
              PM messages will appear here…
            </span>
          )}
          {pmMsgs.map((m, i) => (
            <Message key={i} m={m} />
          ))}
        </div>
        <div className="composer">
          <div className="composer-row">
            <textarea
              ref={taRef}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={
                disabled ? 'Run complete.' : 'Message the PM — pause the run to intervene…'
              }
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
          {!disabled && <div className="hint">Enter to send · Shift+Enter for newline</div>}
        </div>
      </div>
    </div>
  );
}

function RunView({
  project,
  tier,
  tasks,
  agents,
  taskActivity = {},
  taskTimings = {},
  findings,
  pmMsgs,
  spend,
  spendCap,
  status,
  connected = true,
  alreadyPushed,
  branchName,
  elapsedMs,
  onPause,
  onAbort,
  onPrCreated,
  showChanges,
  onToggleShowChanges,
  pendingPermission = null,
}: RunViewProps) {
  // ── Hover-to-highlight ────────────────────────────────────────────────────
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);

  // ── Resizable panes ────────────────────────────────────────────────────────
  const [leftPx, onDragLeft] = useDragResize(340, 180, 520, 'swarm-left-px', 1);
  const [chatPx, onDragChat] = useDragResize(300, 160, 480, 'swarm-chat-px', -1);
  const [chatOpen, setChatOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('swarm-chat-open') !== 'false';
    } catch {
      return true;
    }
  });
  // The code-changes view wants the room — collapse the PM chat there by default,
  // but keep it toggleable. Tracked separately so it doesn't disturb the user's
  // normal-view preference.
  const [chatOpenInChanges, setChatOpenInChanges] = useState(false);
  const effectiveChatOpen = showChanges ? chatOpenInChanges : chatOpen;

  const toggleChat = useCallback(() => {
    if (showChanges) {
      setChatOpenInChanges(v => !v);
      return;
    }
    setChatOpen(v => {
      const next = !v;
      try {
        localStorage.setItem('swarm-chat-open', String(next));
      } catch {}
      return next;
    });
  }, [showChanges]);

  const gridCols = `${leftPx}px 4px 1fr ${effectiveChatOpen ? `4px ${chatPx}px` : '1px 36px'}`;

  // Mid-run steering — add guidance to a task and re-dispatch it. Returns the outcome
  // so the card can surface the server's message (e.g. "pause first" for a live task).
  const steerTask = async (
    taskId: string,
    note: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const r = await fetch('/run/steer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId, note }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: d.error ?? `HTTP ${r.status}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };

  const tierColour = tier === 'tweak' ? 'blue' : tier === 'greenfield' ? 'green' : 'amber';
  const statusMeta: Record<RunStatus, { cls: string; label: string }> = {
    running: { cls: 'running', label: 'running' },
    paused: { cls: 'paused', label: 'paused' },
    done: { cls: 'done', label: 'done' },
    aborted: { cls: 'aborted', label: 'aborted' },
  };
  const { cls, label } = statusMeta[status] ?? statusMeta.running;

  const agentSteps = Object.fromEntries(
    Object.entries(agents).map(([k, v]) => [k, v.active ? v.step : '']),
  );

  return (
    <div className="run" style={{ gridTemplateColumns: gridCols }}>
      <div className="run-head">
        <span className="pname">{project}</span>
        <span className={`badge ${tierColour}`}>{tier.toUpperCase()}</span>
        {branchName && (
          <span className="run-branch" title={branchName}>
            ⎇ {branchName.replace(/^swarm\//, '')}
          </span>
        )}
        <span className={`run-status ${cls}`}>
          <span className="rdot" />
          {label}
        </span>
        <NotifyToggle />
        <div className="spacer" />
        <RunControls
          status={status}
          tasks={tasks}
          onPause={onPause}
          onAbort={onAbort}
          onToggleChanges={onToggleShowChanges}
          showChanges={showChanges}
          onPrCreated={onPrCreated}
          alreadyPushed={alreadyPushed}
          branchName={branchName}
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

      {/* Disconnected banner — shown when the SSE feed is down and data may be stale.
          Disappears within ~1 s of the server coming back (first back-off interval). */}
      {!connected && (
        <div
          style={{
            // .run is a 5-column grid — without explicit placement this
            // auto-flowed into the 340px first column and rendered as a
            // cramped corner strip instead of a full-width banner.
            gridColumn: '1 / -1',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 18px',
            background: 'var(--amber-d)',
            borderBottom: '1px solid var(--amber)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--amber)',
            animation: 'softpulse 1.8s infinite',
          }}
        >
          <span>⟳</span>
          <span>Server offline — reconnecting… displayed data may be stale</span>
        </div>
      )}

      {status === 'done' && (
        <RunSummary tasks={tasks} findings={findings} spend={spend} elapsedMs={elapsedMs} />
      )}

      {showChanges ? (
        <ChangesPanel />
      ) : (
        <>
          <div className="run-right">
            <InboxPanel
              tasks={tasks}
              pendingPermission={pendingPermission}
              onFocusTask={setHoveredTaskId}
            />
            <AgentsPanel
              agents={agents}
              status={status}
              tasks={tasks}
              hoveredTaskId={hoveredTaskId}
            />
            <FindingsFeed findings={findings} tasks={tasks} hoveredTaskId={hoveredTaskId} />
          </div>
          <DragHandle gridColumn={2} onMouseDown={onDragLeft} />
          <TaskGraph
            tasks={tasks}
            agentSteps={agentSteps}
            taskActivity={taskActivity}
            taskTimings={taskTimings}
            hoveredTaskId={hoveredTaskId}
            onHoverTask={setHoveredTaskId}
            runActive={status === 'running' || status === 'paused'}
            onSteer={steerTask}
          />
          {effectiveChatOpen && <DragHandle gridColumn={4} onMouseDown={onDragChat} />}
        </>
      )}

      <PmChat pmMsgs={pmMsgs} status={status} open={effectiveChatOpen} onToggle={toggleChat} />
    </div>
  );
}

// ─── Server-down screen ───────────────────────────────────────────────────────

function ServerDown() {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 28,
        padding: 40,
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--tx-3)',
            marginBottom: 10,
          }}
        >
          Swarm server not running
        </div>
        <div style={{ color: 'var(--tx-2)', fontSize: 13, maxWidth: 420, lineHeight: 1.6 }}>
          Start the server in one terminal, then run a task in another. This panel will connect
          automatically.
        </div>
      </div>

      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 560 }}
      >
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
          <div
            style={{
              color: 'var(--tx-2)',
              fontSize: 12,
              fontFamily: 'var(--mono)',
              padding: '8px 12px',
            }}
          >
            This panel updates live as agents run.
          </div>
        </Step>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          color: 'var(--tx-3)',
          fontSize: 11,
          fontFamily: 'var(--mono)',
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--tx-3)',
            animation: 'softpulse 1.4s infinite',
            display: 'inline-block',
          }}
        />
        retrying every 3 seconds…
      </div>
    </div>
  );
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--bg-1)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-lg)',
        padding: '14px 16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: 'var(--bg-3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--tx-2)',
            fontFamily: 'var(--mono)',
            flexShrink: 0,
          }}
        >
          {n}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tx-1)' }}>{label}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 12,
        color: 'var(--tx)',
        background: 'var(--bg)',
        border: '1px solid var(--border-soft)',
        borderRadius: 5,
        padding: '6px 10px',
      }}
    >
      <span style={{ color: 'var(--tx-3)', userSelect: 'none' }}>$ </span>
      {children}
    </div>
  );
}

// ─── Historical run view (frozen snapshot) ────────────────────────────────────

function computeHistoricalLanes(tasks: SessionSnapshot['tasks']): Map<string, number> {
  const lanes = new Map<string, number>();
  let nextLane = 0;
  const assign = (id: string, lane: number) => {
    if (lanes.has(id)) return;
    lanes.set(id, lane);
    tasks
      .filter(t => t.depends_on.includes(id))
      .forEach((child, i) => {
        assign(child.id, lane + i);
      });
  };
  tasks
    .filter(t => t.depends_on.length === 0)
    .forEach(t => {
      assign(t.id, nextLane++);
    });
  tasks.forEach(t => {
    if (!lanes.has(t.id)) lanes.set(t.id, 0);
  });
  return lanes;
}

function sessionToRunViewData(session: SessionSnapshot): {
  tasks: Task[];
  agents: Record<string, AgentState>;
  findings: Finding[];
  pmMsgs: ChatMessage[];
} {
  const verdictMap: Record<string, Finding['verdict']> = {
    COMPLETE: 'complete',
    PASS: 'pass',
    APPROVED: 'pass',
    FAILED: 'fail',
    FAIL: 'fail',
    CHANGES_REQUESTED: 'changes',
  };

  const lanes = computeHistoricalLanes(session.tasks);
  const tasks: Task[] = session.tasks.map(t => ({
    id: t.id,
    title: t.title,
    assignee: t.assignee,
    deps: t.depends_on,
    lane: lanes.get(t.id) ?? 0,
    status: t.status as Task['status'],
    late: false,
  }));

  const agents: Record<string, AgentState> = {};
  const blank: AgentState = {
    active: false,
    step: '',
    activeAt: null,
    verdict: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    contextPct: null,
  };
  for (const t of session.tasks) {
    if (!agents[t.assignee]) agents[t.assignee] = { ...blank };
    if (t.finding_verdict) {
      const v = verdictMap[(t.finding_verdict ?? '').toUpperCase()] ?? 'complete';
      agents[t.assignee] = { ...agents[t.assignee], verdict: v };
    }
  }

  const findings: Finding[] = session.tasks
    .filter(t => t.result_ref)
    .map(t => ({
      key: `${t.id}-finding`,
      agent: t.assignee,
      task: t.id,
      verdict: verdictMap[(t.finding_verdict ?? '').toUpperCase()] ?? 'complete',
      summary: t.finding_summary ?? t.result_ref ?? '',
      // Path is relative to .swarm/ — the /findings endpoint resolves it
      path: `sessions/${session.id}/findings/${t.id}.md`,
    }))
    .reverse();

  const charter = session.charter;

  // The original planning conversation (you ↔ PM) that scoped the run, when the
  // snapshot captured it; otherwise fall back to just the goal line.
  const planningMsgs: ChatMessage[] = charter?.planningHistory?.length
    ? charter.planningHistory.map(m => ({ from: m.from, text: m.text }))
    : session.goal
      ? [{ from: 'you' as const, text: session.goal }]
      : [];

  // The agreed charter, surfaced read-only as compact system notes.
  const charterMsgs: ChatMessage[] = (
    [
      charter?.constraints?.length ? `Constraints: ${charter.constraints.join(' · ')}` : null,
      charter?.nongoals?.length ? `Non-goals: ${charter.nongoals.join(' · ')}` : null,
      charter?.questions?.length ? `Open questions: ${charter.questions.join(' · ')}` : null,
    ].filter(Boolean) as string[]
  ).map(text => ({ from: 'system' as const, text }));

  // Execution-time PM/user log lines (dispatch, commentary) that followed.
  const runLog: ChatMessage[] = session.log
    .filter(e => e.actor === 'pm' || e.actor === 'user')
    .map(e => ({ from: e.actor === 'pm' ? ('pm' as const) : ('you' as const), text: e.event }));

  const pmMsgs: ChatMessage[] = [...planningMsgs, ...charterMsgs, ...runLog];

  return { tasks, agents, findings, pmMsgs };
}

function HistoricalRunView({ session }: { session: SessionSnapshot }) {
  const { tasks, agents, findings, pmMsgs } = sessionToRunViewData(session);
  const [showChanges, setShowChanges] = useState(false);
  return (
    <RunView
      project={session.project}
      tier={session.tier}
      tasks={tasks}
      agents={agents}
      findings={findings}
      pmMsgs={pmMsgs}
      showChanges={showChanges}
      onToggleShowChanges={() => setShowChanges(v => !v)}
      spend={0}
      spendCap={0}
      status={'done' as RunStatus}
      // A frozen snapshot is complete, not "disconnected" — suppress the offline banner.
      connected={true}
      alreadyPushed={true}
      branchName={session.branchName}
      elapsedMs={session.elapsedMs ?? null}
    />
  );
}

function QuickTaskRunView({
  state,
  onReview,
  onFullRun,
  onAbort,
}: {
  state: RealRunState;
  onReview: () => void;
  onFullRun: () => void;
  onAbort: () => void;
}) {
  const revisionKey = state.tasks.map(task => `${task.id}:${task.status}`).join('|');
  const changedFiles = useQuickTaskDiff(true, revisionKey, state.status === 'running');
  const agentSteps = Object.fromEntries(
    Object.entries(state.agents).map(([agent, value]) => [agent, value.active ? value.step : '']),
  );
  const card = projectQuickTaskCard({
    project: state.project,
    status: state.status,
    tasks: state.tasks,
    findings: state.findings,
    taskActivity: state.taskActivity,
    agentSteps,
    spend: state.spend,
    metadata: {
      request: state.goal,
      declaredWriteScope: state.quickTask?.declaredWriteScope ?? [],
      verificationCommands: state.quickTask?.verificationCommands ?? [],
      route: state.quickTask?.route,
    },
    changedFiles,
  });

  return (
    <div className="quick-task-surface">
      <QuickTaskCard
        state={card}
        defaultDetailsOpen={false}
        onAction={selected => {
          if (selected.id === 'review-diff') {
            onReview();
          } else if (selected.id === 'full-run') {
            onFullRun();
          } else if (selected.id === 'cancel-run') {
            onAbort();
          }
        }}
      />
    </div>
  );
}

// ─── Running: real backend or server-down screen ──────────────────────────────

export function Running({
  run,
  onPrCreated,
  onRunDone,
  isInitiating,
  noActiveRun,
  historicalSession,
}: {
  // Owned by App (above the surface switch) so tab switches never close the
  // SSE stream, drop live transcripts, or hide the permission gate.
  run: RealRun;
  onPrCreated?: (url: string) => void;
  onRunDone?: () => void;
  isInitiating?: boolean;
  noActiveRun?: boolean;
  historicalSession?: SessionSnapshot;
}) {
  const { serverStatus, state } = run;

  // Owned here (not in RunView) so the diff stays open across a review-fix run, which
  // briefly empties the task list and would otherwise remount RunView and close it.
  const [showChanges, setShowChanges] = useState(false);
  const [expandedQuickGoal, setExpandedQuickGoal] = useState<string | null>(null);
  const toggleShowChanges = useCallback(() => setShowChanges(v => !v), []);

  // Notify parent once when the run transitions to done.
  // Reset the flag when a new run starts so it fires again on subsequent runs.
  const runDoneNotified = useRef(false);
  useEffect(() => {
    if (state?.status === 'running') runDoneNotified.current = false;
    if (state?.status === 'done' && !runDoneNotified.current) {
      runDoneNotified.current = true;
      onRunDone?.();
    }
  }, [state?.status, onRunDone]);

  // Historical mode: render frozen snapshot, bypass live SSE entirely
  if (historicalSession) {
    return <HistoricalRunView session={historicalSession} />;
  }

  if (serverStatus === 'probing') {
    return (
      <div
        style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <span style={{ color: 'var(--tx-3)', fontFamily: 'var(--mono)', fontSize: 13 }}>
          connecting…
        </span>
      </div>
    );
  }

  if (serverStatus === 'down' || !state) {
    return <ServerDown />;
  }

  // Execute was just clicked — show spinner regardless of stale previous-run state.
  // isInitiating stays true until run.classified / task.created fires from the server.
  if (isInitiating) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 40,
        }}
      >
        <span className="ps-spinner" style={{ width: 22, height: 22, borderWidth: 2.5 }} />
        <div style={{ color: 'var(--tx-2)', fontSize: 13, fontFamily: 'var(--mono)' }}>
          Initialising run…
        </div>
        <div
          style={{
            color: 'var(--tx-3)',
            fontSize: 12,
            maxWidth: 300,
            textAlign: 'center',
            lineHeight: 1.6,
          }}
        >
          Classifying goal and building task graph
        </div>
      </div>
    );
  }

  // Show "no active run" when the planning session was reset or no run has started yet.
  // Skip this while the user is reviewing (showChanges) so a review-fix run that briefly
  // empties the task list doesn't yank the diff out from under them.
  if (!showChanges && (noActiveRun || (state.tasks.length === 0 && state.status === 'running'))) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 40,
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--tx-3)',
          }}
        >
          No active run
        </div>
        <div
          style={{
            color: 'var(--tx-2)',
            fontSize: 13,
            maxWidth: 340,
            textAlign: 'center',
            lineHeight: 1.7,
          }}
        >
          Go to <strong style={{ color: 'var(--tx-1)' }}>Planning</strong> and click{' '}
          <strong style={{ color: 'var(--tx-1)' }}>Execute</strong> to start a run. This panel will
          update live as agents work.
        </div>
      </div>
    );
  }

  const pause = () => fetch('/run/pause', { method: 'POST' }).catch(() => {});
  const abort = () => fetch('/run/abort', { method: 'POST' }).catch(() => {});
  const resume = () => fetch('/run/resume', { method: 'POST' }).catch(() => {});

  const showFullQuickRun = expandedQuickGoal === state.goal;
  if (state.executionShape === 'quick_task' && !showChanges && !showFullQuickRun) {
    return (
      <QuickTaskRunView
        state={state}
        onReview={() => setShowChanges(true)}
        onFullRun={() => setExpandedQuickGoal(state.goal)}
        onAbort={abort}
      />
    );
  }

  return (
    <>
      <RunView
        project={state.project}
        tier={state.tier}
        tasks={state.tasks}
        agents={state.agents}
        taskActivity={state.taskActivity}
        taskTimings={state.taskTimings}
        findings={state.findings}
        pmMsgs={state.pmMsgs}
        spend={state.spend}
        spendCap={state.spendCap}
        status={state.status}
        connected={state.connected}
        alreadyPushed={state.pushed}
        branchName={state.branchName}
        elapsedMs={state.elapsedMs}
        onPause={state.status === 'paused' ? resume : pause}
        onAbort={abort}
        onPrCreated={onPrCreated}
        showChanges={showChanges}
        onToggleShowChanges={toggleShowChanges}
        pendingPermission={state.pendingPermission}
      />
    </>
  );
}
