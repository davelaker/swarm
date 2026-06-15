import { useState, useCallback, useEffect, useRef } from 'react';
import type { Surface, SessionSnapshot } from './types';
import { Planning } from './components/planning/Planning';
import { Running } from './components/running/Running';
import { Branches } from './components/branches/Branches';
import { Marketplace } from './components/marketplace/Marketplace';
import { SessionsPanel } from './components/sessions/SessionsPanel';
import { ProjectSwitcher } from './components/common/ProjectSwitcher';
import { IconGitHub, IconFolder } from './components/common/icons';

export type ServerStatus = 'probing' | 'up' | 'down';

export interface TaskGraphEntry {
  id: string;
  assignee: 'coder' | 'tester' | 'security' | 'reviewer';
  title: string;
  depends_on: string[];
}

export interface RunCharter {
  constraints: string[];
  nongoals: string[];
  questions: string[];
  branchMode?: 'branch' | 'main';
  branchName?: string; // user-set slug (no swarm/ prefix)
  taskGraph?: TaskGraphEntry[];
  planningHistory?: Array<{ from: 'pm' | 'you'; text: string }>;
}

// ─── Surface persistence ──────────────────────────────────────────────────────
// Survives HMR and accidental refreshes. Without this, pressing Execute and
// then triggering a hot-reload dumps the user back to Planning — with the
// Execute button re-enabled — while agents are still running server-side.
const SURFACE_KEY = 'swarm-surface-v1';
function loadSurface(): Surface {
  try {
    const v = localStorage.getItem(SURFACE_KEY);
    if (
      v === 'running' ||
      v === 'planning' ||
      v === 'branches' ||
      v === 'marketplace' ||
      v === 'history'
    )
      return v as Surface;
  } catch {
    /* private mode or quota — ignore */
  }
  return 'planning';
}

export function App() {
  const [surface, setSurface] = useState<Surface>(loadSurface);
  const [marketplaceFocus, setMarketplaceFocus] = useState<string | null>(null);
  const [executable, setExecutable] = useState(false);
  // Why Execute is unavailable — surfaced as the tooltip on the amber "PLANNING" dot.
  const [executableReason, setExecutableReason] = useState(
    'Complete the planning conversation to unlock Execute',
  );
  const [runGoal, setRunGoal] = useState('');
  const [runCharter, setRunCharter] = useState<RunCharter | null>(null);
  const [runTeam, setRunTeam] = useState<string[]>([]);
  const [serverStatus, setServerStatus] = useState<ServerStatus>('probing');
  const [projectName, setProjectName] = useState<string | null>(null);
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [completionRecap, setCompletionRecap] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState<string | null>(null);
  const [runDone, setRunDone] = useState(false);
  const [planNextKey, setPlanNextKey] = useState(0);
  // Post-run "Request changes": a review the PM should turn into a coder+reviewer fix.
  const [reviewRequest, setReviewRequest] = useState<{ key: number; text: string } | null>(null);
  const autoExecuteArmed = useRef(false); // when a review is in flight, auto-run once the PM enables Execute
  const reviewKeyRef = useRef(0);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [isInitiating, setIsInitiating] = useState(false);
  const [historicalSession, setHistoricalSession] = useState<SessionSnapshot | null>(null);
  // "Re-open in Planning": seed an editable plan from a past session.
  const [reopenSeed, setReopenSeed] = useState<SessionSnapshot | null>(null);
  const [reopenKey, setReopenKey] = useState(0);
  // null = unknown (don't nag); false = visual verification disabled (Playwright missing).
  const [playwrightAvailable, setPlaywrightAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    fetch('/capabilities')
      .then(r => r.json())
      .then((d: { playwright?: boolean }) => setPlaywrightAvailable(!!d.playwright))
      .catch(() => {});
  }, []);
  // True once we've confirmed the correct project root (no mismatch, or switch
  // completed). The Running tab waits behind a loading screen until this is set
  // so we never show a flash of the wrong project's state.
  const [projectSynced, setProjectSynced] = useState(false);

  // Single server probe — retries every 3s, also reads project name when up.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let mounted = true;
    let autoSyncDone = false;

    const probe = () => {
      fetch('/state', { signal: AbortSignal.timeout(2000) })
        .then(r => {
          if (!r.ok) throw new Error();
          return r.json();
        })
        .then(
          (s: {
            project?: string;
            driver?: string;
            model?: string | null;
            activeRun?: boolean;
            repoUrl?: string | null;
            root?: string;
          }) => {
            if (!mounted) return;
            setServerStatus('up');
            if (s.project) setProjectName(s.project);
            if (s.repoUrl) setRepoUrl(s.repoUrl);
            if (s.root) setProjectRoot(s.root);

            // Auto-sync: if the user previously switched to a different project,
            // the server may have lost that on restart (process.cwd() resets).
            // Push the remembered root to the server once per page-load.
            // We hold projectSynced=false until the switch resolves so the Running
            // tab never renders with the wrong project's state.
            if (!autoSyncDone) {
              autoSyncDone = true;
              let localRoot: string | null = null;
              try {
                localRoot = localStorage.getItem('swarm-active-root');
              } catch {}
              if (localRoot && s.root && localRoot !== s.root) {
                // Root mismatch — switch first, then unblock Running.
                // Both setProjectRoot and setProjectSynced are called in the same
                // .then() callback so React 18 batches them into a single render —
                // <Running> always mounts with the correct key.
                fetch('/project/switch', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ path: localRoot }),
                })
                  .then(
                    r =>
                      r.json() as Promise<{
                        ok: boolean;
                        project?: string;
                        repoUrl?: string | null;
                      }>,
                  )
                  .then(d => {
                    if (!mounted) return;
                    if (d.ok) {
                      if (d.project) setProjectName(d.project);
                      if (d.repoUrl !== undefined) setRepoUrl(d.repoUrl);
                      setProjectRoot(localRoot!);
                    } else {
                      // Saved path no longer valid — forget it
                      try {
                        localStorage.removeItem('swarm-active-root');
                      } catch {}
                    }
                    setProjectSynced(true); // always unblock, regardless of d.ok
                  })
                  .catch(() => {
                    // Network error — unblock with server's root (already set above)
                    if (mounted) setProjectSynced(true);
                  });
              } else {
                // No mismatch (or no saved root) — already on the right project
                setProjectSynced(true);
              }
            }

            // If the server says a run is active, snap to the Running tab regardless
            // of what localStorage says — guards against the page being closed and
            // reopened mid-run without localStorage being set.
            if (s.activeRun) setSurface('running');
            // driver: 'agent-sdk' → Max plan credit pool; 'api-key' → show model name
            if (s.driver === 'agent-sdk') {
              setModelLabel('Max plan');
            } else if (s.model) {
              setModelLabel(s.model.replace(/^claude-/, ''));
            }
          },
        )
        .catch(() => {
          if (!mounted) return;
          setServerStatus('down');
          // Don't touch projectSynced here — server being offline is not the
          // same as "confirmed on correct project". When server comes back up
          // the probe fires again, auto-sync runs, and projectSynced is set
          // properly. Running will mount below because serverStatus === 'down'
          // bypasses the spinner gate.
        })
        .finally(() => {
          if (mounted) timer = setTimeout(probe, 3000);
        });
    };

    probe();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist surface so HMR / refresh restores the active tab.
  useEffect(() => {
    try {
      localStorage.setItem(SURFACE_KEY, surface);
    } catch {
      /* ignore */
    }
  }, [surface]);

  // Kick off a run with explicit values (no reliance on async state settling) —
  // used both by the Execute button (via goExecute) and by review auto-execute.
  const startRun = useCallback((goal: string, charter: RunCharter | null, team: string[]) => {
    if (!goal) return;
    setExecuteError(null);

    // Optimistic: switch to Running immediately so the tab feels instant.
    // If the POST or the early SSE watch detects a failure we snap back to
    // Planning and surface the reason.
    setSurface('running');
    setIsInitiating(true);

    fetch('/run/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, charter, team }),
    })
      .then(r => {
        if (!r.ok)
          return r.json().then((d: { error?: string }) => {
            throw new Error(d.error ?? `HTTP ${r.status}`);
          });

        // Open a short-lived SSE listener. If the run gets blocked before the
        // first task arrives (e.g. git-dirty check), snap back to Planning with
        // the reason. Close after 20 s regardless — by then success is confirmed.
        const es = new EventSource('/events');
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            es.close();
          }
        };
        const timer = setTimeout(finish, 20_000);

        es.onmessage = ev => {
          let msg: { type: string; reason?: string; task?: unknown };
          try {
            msg = JSON.parse(ev.data);
          } catch {
            return;
          }

          if (msg.type === 'task.created' || msg.type === 'run.classified') {
            setIsInitiating(false); // first task landed — hide spinner
            clearTimeout(timer);
            finish();
          } else if (msg.type === 'run.blocked') {
            clearTimeout(timer);
            finish();
            setIsInitiating(false);
            setExecuteError(msg.reason ?? 'Run was blocked before it could start');
            setSurface('planning');
          }
        };
        es.onerror = () => {
          clearTimeout(timer);
          finish();
        };
      })
      .catch((err: Error) => {
        // POST failed (409 conflict, network error, etc.) — snap back to Planning.
        setIsInitiating(false);
        setExecuteError(err.message);
        setSurface('planning');
      });
  }, []);

  const handleExecutable = useCallback(
    (v: boolean, goal?: string, charter?: RunCharter, team?: string[], reason?: string) => {
      setExecutable(v);
      if (!v && reason) setExecutableReason(reason);
      if (v) setExecutableReason('');
      if (goal) setRunGoal(goal);
      if (charter) setRunCharter(charter);
      if (team) setRunTeam(team);
      // Review auto-execute: the user already reviewed the diff and asked for changes,
      // so once the PM turns that into an executable plan, kick it off immediately
      // (same branch) without a second Execute click. Fire once, then disarm.
      if (v && goal && autoExecuteArmed.current) {
        autoExecuteArmed.current = false;
        startRun(goal, charter ?? null, team ?? []);
      }
    },
    [startRun],
  );

  const goExecute = useCallback(
    () => startRun(runGoal, runCharter, runTeam),
    [startRun, runGoal, runCharter, runTeam],
  );

  // From the Running tab's "Request changes": hand the review to the PM and arm
  // auto-execute so the resulting coder+reviewer fix runs without extra clicks.
  const handleRequestChanges = useCallback((text: string) => {
    reviewKeyRef.current += 1;
    setReviewRequest({ key: reviewKeyRef.current, text });
    autoExecuteArmed.current = true;
    setSurface('planning');
  }, []);

  const handlePlanNext = useCallback(() => {
    setRunDone(false);
    setPlanNextKey(k => k + 1);
    setSurface('planning');
  }, []);

  // Seed an editable planning session from a viewed historical run, then leave history.
  const handleReopen = useCallback((snap: SessionSnapshot) => {
    setReopenSeed(snap);
    setReopenKey(k => k + 1);
    setHistoricalSession(null);
    setSurface('planning');
  }, []);

  // Called by Running when a PR is successfully created.
  // The URL flows down to Planning as recapMessage, where usePlanningSession
  // injects a completion chip and a PM "what's next?" prompt.
  const onPrCreated = useCallback((url: string) => {
    setCompletionRecap(url);
    setSurface('planning');
  }, []);

  const serverDot =
    serverStatus === 'up'
      ? 'var(--green)'
      : serverStatus === 'probing'
        ? 'var(--tx-3)'
        : 'var(--amber)';
  const serverLabel =
    serverStatus === 'up'
      ? 'agents ready'
      : serverStatus === 'probing'
        ? 'connecting…'
        : 'agents offline';

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="glyph">
            <i />
            <i />
            <i />
          </span>
          Agent&nbsp;Swarm
          {projectName && (
            <>
              <span className="sep">/</span>
              <span className="proj">{projectName}</span>
            </>
          )}
          {repoUrl && (
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={repoUrl}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                fontFamily: 'var(--mono)',
                color: 'var(--tx-3)',
                textDecoration: 'none',
                marginLeft: 6,
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--tx-1)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--tx-3)')}
            >
              <IconGitHub />
            </a>
          )}
          <button
            className="folder-switch-btn"
            onClick={() => setShowSwitcher(true)}
            title="Switch project folder"
          >
            <IconFolder size={13} />
          </button>
        </div>
        <div className="nav">
          <button
            className={surface === 'planning' ? 'on' : ''}
            onClick={() => setSurface('planning')}
          >
            Planning
          </button>
          <button
            className={surface === 'running' ? 'on' : ''}
            onClick={() => setSurface('running')}
          >
            Running
          </button>
          <button
            className={surface === 'branches' ? 'on' : ''}
            onClick={() => setSurface('branches')}
          >
            Branches
          </button>
          <button
            className={surface === 'marketplace' ? 'on' : ''}
            onClick={() => setSurface('marketplace')}
          >
            Agents
          </button>
          <button
            className={surface === 'history' ? 'on' : ''}
            onClick={() => setSurface('history')}
          >
            History
          </button>
        </div>
        {historicalSession && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              fontSize: 11,
              fontFamily: 'var(--mono)',
              color: 'var(--amber)',
              background: 'rgba(255,170,0,0.08)',
              border: '1px solid rgba(255,170,0,0.2)',
              borderRadius: 6,
              padding: '3px 10px',
              marginLeft: 6,
            }}
          >
            <span>⏱ history</span>
            <button
              onClick={() => historicalSession && handleReopen(historicalSession)}
              style={{ color: 'var(--blue)', fontSize: 11, lineHeight: 1 }}
              title="Seed a new, editable planning session from this run"
            >
              ↻ Re-open in Planning
            </button>
            <button
              onClick={() => setHistoricalSession(null)}
              style={{ color: 'var(--tx-3)', fontSize: 13, lineHeight: 1 }}
              title="Return to live"
            >
              ×
            </button>
          </span>
        )}
        {surface === 'running' && runDone && (
          <button className="btn primary" onClick={handlePlanNext} style={{ marginLeft: 10 }}>
            ← Plan next task
          </button>
        )}
        <div className="spacer" />

        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            fontFamily: 'var(--mono)',
            color: 'var(--tx-2)',
            marginRight: 6,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: serverDot,
              ...(serverStatus === 'probing' ? { animation: 'softpulse 1.4s infinite' } : {}),
            }}
          />
          {serverLabel}
          {modelLabel && serverStatus === 'up' && (
            <>
              <span style={{ color: 'var(--tx-3)', userSelect: 'none' }}>·</span>
              <span style={{ color: 'var(--tx-3)' }}>{modelLabel}</span>
            </>
          )}
        </span>

        {surface === 'planning' && (
          <>
            {executeError ? (
              <span
                title={executeError}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                  color: 'var(--red)',
                  background: 'var(--red-d)',
                  border: '1px solid rgba(240,90,82,0.25)',
                  borderRadius: 6,
                  padding: '4px 10px',
                  maxWidth: 420,
                }}
              >
                <span style={{ flexShrink: 0 }}>✗</span>
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {executeError.split('\n')[0]}
                </span>
                <button
                  onClick={() => setExecuteError(null)}
                  style={{
                    flexShrink: 0,
                    color: 'var(--red)',
                    opacity: 0.7,
                    fontSize: 13,
                    lineHeight: 1,
                  }}
                  title="Dismiss"
                >
                  ×
                </button>
              </span>
            ) : (
              <span
                className="pill"
                title={executable ? 'Charter ready to execute' : executableReason}
              >
                <span
                  className="dot"
                  style={{ background: executable ? 'var(--green)' : 'var(--amber)' }}
                />
                PLANNING
              </span>
            )}
          </>
        )}
      </div>

      {showSwitcher && (
        <ProjectSwitcher currentRoot={projectRoot} onClose={() => setShowSwitcher(false)} />
      )}

      <div className="surface">
        <div
          style={{
            height: '100%',
            display: surface === 'planning' ? 'block' : 'none',
          }}
        >
          <Planning
            onExecute={goExecute}
            onExecutable={handleExecutable}
            onNewSession={() => {
              setRunGoal('');
              setRunCharter(null);
              setRunTeam([]);
              setRunDone(false);
            }}
            onHire={agentId => {
              setMarketplaceFocus(agentId);
              setSurface('marketplace');
            }}
            reviewRequest={reviewRequest}
            serverStatus={serverStatus}
            recapMessage={completionRecap}
            planNextKey={planNextKey}
            reopenKey={reopenKey}
            reopenSeed={reopenSeed}
            playwrightAvailable={playwrightAvailable}
            runBlockedReason={executeError}
            historicalSession={historicalSession ?? undefined}
          />
        </div>
        {surface === 'running' &&
          // Hold the spinner until we've confirmed the correct project root.
          // This covers all cases: server up immediately, server initially down,
          // mismatch needing a switch. Once projectSynced=true it never resets,
          // so mid-session server disconnects keep <Running> mounted and let
          // useRealRun show its own reconnecting banner. The topbar already
          // shows "agents offline" when the server is down.
          (!projectSynced ? (
            <div
              style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 14,
              }}
            >
              <span className="ps-spinner" style={{ width: 22, height: 22, borderWidth: 2.5 }} />
              <span style={{ color: 'var(--tx-3)', fontFamily: 'var(--mono)', fontSize: 13 }}>
                Loading project…
              </span>
            </div>
          ) : (
            <Running
              key={projectRoot ?? 'init'}
              onPrCreated={onPrCreated}
              onRunDone={() => setRunDone(true)}
              onRequestChanges={handleRequestChanges}
              isInitiating={isInitiating}
              noActiveRun={!runGoal && !historicalSession}
              historicalSession={historicalSession ?? undefined}
            />
          ))}
        {surface === 'branches' && <Branches />}
        {surface === 'marketplace' && (
          <Marketplace
            key={projectRoot ?? 'init'}
            projectName={projectName ?? undefined}
            focusAgentId={marketplaceFocus}
            onFocusConsumed={() => setMarketplaceFocus(null)}
          />
        )}
        {surface === 'history' && (
          <SessionsPanel
            onSelectSession={session => {
              setHistoricalSession(session);
              setSurface('running');
            }}
            activeSessionId={historicalSession?.id}
          />
        )}
      </div>
    </div>
  );
}
