import { useState, useCallback, useEffect, useRef } from 'react';
import type { Surface, SessionSnapshot } from './types';
import { Planning } from './components/planning/Planning';
import { Running } from './components/running/Running';
import { Branches } from './components/branches/Branches';
import { Marketplace } from './components/marketplace/Marketplace';
import { SessionsPanel } from './components/sessions/SessionsPanel';
import { ProjectSwitcher } from './components/common/ProjectSwitcher';
import { StaleServerBanner } from './components/common/StaleServerBanner';
import { PermissionGate } from './components/running/PermissionGate';
import { useRealRun } from './hooks/useRealRun';
import { useRunNotifications } from './hooks/useRunNotifications';
import { IconGitHub, IconFolder } from './components/common/icons';
import type { QuickTaskStartResult } from './data/quickTask';

export type ServerStatus = 'probing' | 'up' | 'down';

export interface TaskGraphEntry {
  id: string;
  assignee: 'coder' | 'tester' | 'security' | 'reviewer';
  title: string;
  depends_on: string[];
  model?: string; // PM-chosen model for this task (canonical id, e.g. claude-opus-4-8)
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  route?: TaskRoute;
}

export interface TaskRoute {
  provider: 'anthropic' | 'openai';
  model: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  rationale: string;
  fallback: {
    provider: 'anthropic' | 'openai';
    model: string;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  } | null;
  requiresConfirmation: boolean;
  writeScope: string[];
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
  // Last activeRun seen by the probe — the running-tab snap fires on the
  // false→true transition only (see the probe below).
  const prevActiveRun = useRef(false);

  // The live run connection lives HERE, above the surface switch: switching
  // tabs must never close the SSE stream, wipe live transcripts/spend, or —
  // worst of all — hide a pending permission request until it auto-denies.
  const run = useRealRun(projectRoot);
  useRunNotifications(run.state?.status ?? 'running', run.state?.pendingPermission != null);

  // Single server probe — retries every 3s, also reads project name when up. Hits the
  // lightweight /health endpoint (not /state) so this frequent poll doesn't re-read every
  // finding file from disk each tick; /state is fetched only by the Running view, which
  // needs the full task snapshot.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let mounted = true;
    let switchInFlight = false; // guards against overlapping /project/switch calls

    const probe = () => {
      fetch('/health', { signal: AbortSignal.timeout(2000) })
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

            // Auto-sync: keep the server pointed at the remembered project. The server
            // resets its root to process.cwd() on every restart, so re-assert on EVERY
            // probe that shows drift — not just the first — or a run triggered after a
            // mid-session restart targets the wrong repo. We hold projectSynced=false
            // until a pending switch resolves so the Running tab never renders the wrong
            // project's state.
            let localRoot: string | null = null;
            try {
              localRoot = localStorage.getItem('swarm-active-root');
            } catch {}
            const rootMismatch = !!(localRoot && s.root && localRoot !== s.root);

            if (rootMismatch && !switchInFlight) {
              switchInFlight = true;
              // setProjectRoot and setProjectSynced land in the same .then() so React
              // batches them into one render — <Running> always mounts with the right key.
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
                  switchInFlight = false;
                  if (!mounted) return;
                  if (d.ok) {
                    if (d.project) setProjectName(d.project);
                    if (d.repoUrl !== undefined) setRepoUrl(d.repoUrl);
                    setProjectRoot(localRoot!);
                  } else {
                    // Saved path no longer valid — forget it so we stop retrying.
                    try {
                      localStorage.removeItem('swarm-active-root');
                    } catch {}
                  }
                  setProjectSynced(true); // always unblock, regardless of d.ok
                })
                .catch(() => {
                  switchInFlight = false;
                  // Network error — unblock with the server's root (already set above)
                  if (mounted) setProjectSynced(true);
                });
            } else if (!rootMismatch) {
              // On the right project (or nothing remembered) — unblock Running.
              setProjectSynced(true);
            }

            // If a run has just STARTED (or the page was reopened mid-run), snap to
            // the Running tab. Transition-guarded: only fires when activeRun flips
            // false→true, never on every 3s probe — the un-guarded version yanked
            // the user back from Branches/Agents/History for the whole run.
            if (s.activeRun && !prevActiveRun.current) setSurface('running');
            prevActiveRun.current = !!s.activeRun;
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

  const startQuickTask = useCallback(async (instruction: string): Promise<QuickTaskStartResult> => {
    setExecuteError(null);
    const response = await fetch('/run/quick-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      status?: string;
      goal?: string;
      escalationReason?: string;
      riskSignals?: unknown;
    };
    if (!response.ok) {
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    if (body.status === 'escalated') {
      return {
        status: 'escalated',
        escalationReason:
          body.escalationReason ?? 'Quick task preflight requires a broader workflow.',
        riskSignals: Array.isArray(body.riskSignals)
          ? body.riskSignals.filter((signal): signal is string => typeof signal === 'string')
          : [],
      };
    }
    if (body.status !== 'started' || !body.goal) {
      throw new Error('Quick task server returned an invalid start response.');
    }

    setRunGoal(body.goal);
    setRunCharter(null);
    setRunTeam([]);
    setIsInitiating(true);
    setSurface('running');

    const events = new EventSource('/events');
    const finish = () => {
      setIsInitiating(false);
      events.close();
    };
    const timer = setTimeout(finish, 20_000);
    events.onmessage = event => {
      try {
        const message = JSON.parse(event.data) as { type?: string; reason?: string };
        if (message.type === 'task.created' || message.type === 'run.classified') {
          clearTimeout(timer);
          finish();
        } else if (message.type === 'run.blocked') {
          clearTimeout(timer);
          finish();
          setExecuteError(message.reason ?? 'Quick task was blocked before it could start.');
          setSurface('planning');
        }
      } catch {
        // Ignore malformed events; the normal run connection remains authoritative.
      }
    };
    events.onerror = () => {
      clearTimeout(timer);
      finish();
    };

    return { status: 'started' };
  }, []);

  const handleExecutable = useCallback(
    (v: boolean, goal?: string, charter?: RunCharter, team?: string[], reason?: string) => {
      setExecutable(v);
      if (!v && reason) setExecutableReason(reason);
      if (v) setExecutableReason('');
      if (goal) setRunGoal(goal);
      if (charter) setRunCharter(charter);
      if (team) setRunTeam(team);
    },
    [],
  );

  const goExecute = useCallback(
    (goal = runGoal, charter = runCharter, team = runTeam) => startRun(goal, charter, team),
    [startRun, runGoal, runCharter, runTeam],
  );

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
      <StaleServerBanner />
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
            onQuickTask={startQuickTask}
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
              run={run}
              onPrCreated={onPrCreated}
              onRunDone={() => setRunDone(true)}
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

      {/* Above the surface switch: an agent blocked on approval must be visible
          (and answerable) from EVERY tab, not just Running — before this hoist
          the request silently auto-denied if you happened to be elsewhere. */}
      {run.state?.pendingPermission && (
        <PermissionGate request={run.state.pendingPermission} onResolve={run.resolvePermission} />
      )}
    </div>
  );
}
