import { useState, useCallback, useEffect } from 'react';
import type { Surface } from './types';
import { Planning }   from './components/planning/Planning';
import { Running }    from './components/running/Running';
import { Marketplace } from './components/marketplace/Marketplace';
import { ProjectSwitcher } from './components/common/ProjectSwitcher';
import { IconPlay, IconGitHub, IconFolder } from './components/common/icons';

export type ServerStatus = 'probing' | 'up' | 'down';

export interface RunCharter {
  constraints: string[];
  nongoals:    string[];
  questions:   string[];
  branchMode?: 'branch' | 'main';
}

// ─── Surface persistence ──────────────────────────────────────────────────────
// Survives HMR and accidental refreshes. Without this, pressing Execute and
// then triggering a hot-reload dumps the user back to Planning — with the
// Execute button re-enabled — while agents are still running server-side.
const SURFACE_KEY = 'swarm-surface-v1';
function loadSurface(): Surface {
  try {
    const v = localStorage.getItem(SURFACE_KEY);
    if (v === 'running' || v === 'planning' || v === 'marketplace') return v as Surface;
  } catch { /* private mode or quota — ignore */ }
  return 'planning';
}

export function App() {
  const [surface,      setSurface]      = useState<Surface>(loadSurface);
  const [executable,        setExecutable]        = useState(false);
  const [executableReason,  setExecutableReason]  = useState('Complete the planning conversation to unlock Execute');
  const [runGoal,           setRunGoal]           = useState('');
  const [runCharter,        setRunCharter]        = useState<RunCharter | null>(null);
  const [runTeam,           setRunTeam]           = useState<string[]>([]);
  const [serverStatus,    setServerStatus]    = useState<ServerStatus>('probing');
  const [projectName,     setProjectName]     = useState<string | null>(null);
  const [modelLabel,      setModelLabel]      = useState<string | null>(null);
  const [executeError,    setExecuteError]    = useState<string | null>(null);
  const [completionRecap, setCompletionRecap] = useState<string | null>(null);
  const [repoUrl,         setRepoUrl]         = useState<string | null>(null);
  const [runDone,         setRunDone]         = useState(false);
  const [planNextKey,     setPlanNextKey]     = useState(0);
  const [branchName,      setBranchName]      = useState<string | null>(null);
  const [projectRoot,     setProjectRoot]     = useState<string | null>(null);
  const [showSwitcher,    setShowSwitcher]    = useState(false);

  // Single server probe — retries every 3s, also reads project name when up.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let mounted = true;
    let autoSyncDone = false;

    const probe = () => {
      fetch('/state', { signal: AbortSignal.timeout(2000) })
        .then(r => { if (!r.ok) throw new Error(); return r.json(); })
        .then((s: { project?: string; driver?: string; model?: string | null; activeRun?: boolean; repoUrl?: string | null; branchName?: string | null; root?: string }) => {
          if (!mounted) return;
          setServerStatus('up');
          if (s.project) setProjectName(s.project);
          if (s.repoUrl) setRepoUrl(s.repoUrl);
          if (s.root)    setProjectRoot(s.root);
          setBranchName(s.branchName ?? null);

          // Auto-sync: if the user previously switched to a different project,
          // the server may have lost that on restart (process.cwd() resets).
          // Push the remembered root to the server once per page-load — silently,
          // no reload needed because the planning session key is already correct.
          // Note: we intentionally do NOT overwrite swarm-active-root here;
          // localStorage is the source of truth for "which project the user wants".
          if (!autoSyncDone && s.root) {
            autoSyncDone = true;
            let localRoot: string | null = null;
            try { localRoot = localStorage.getItem('swarm-active-root'); } catch {}
            if (localRoot && localRoot !== s.root) {
              fetch('/project/switch', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ path: localRoot }),
              })
                .then(r => r.json() as Promise<{ ok: boolean; project?: string; repoUrl?: string | null }>)
                .then(d => {
                  if (!mounted) return;
                  if (d.ok) {
                    if (d.project) setProjectName(d.project);
                    if (d.repoUrl !== undefined) setRepoUrl(d.repoUrl);
                    setProjectRoot(localRoot!);
                  } else {
                    // Saved path no longer valid — forget it so we stop retrying
                    try { localStorage.removeItem('swarm-active-root'); } catch {}
                  }
                })
                .catch(() => {});
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
            // Shorten e.g. "claude-sonnet-4-6" → "sonnet-4-6"
            setModelLabel(s.model.replace(/^claude-/, ''));
          }
        })
        .catch(() => { if (mounted) setServerStatus('down'); })
        .finally(() => { if (mounted) timer = setTimeout(probe, 3000); });
    };

    probe();
    return () => { mounted = false; if (timer) clearTimeout(timer); };
  }, []);

  // Persist surface so HMR / refresh restores the active tab.
  useEffect(() => {
    try { localStorage.setItem(SURFACE_KEY, surface); } catch { /* ignore */ }
  }, [surface]);

  const handleExecutable = useCallback((v: boolean, goal?: string, charter?: RunCharter, team?: string[], reason?: string) => {
    setExecutable(v);
    if (!v && reason) setExecutableReason(reason);
    if (v)            setExecutableReason('');
    if (goal)         setRunGoal(goal);
    if (charter)      setRunCharter(charter);
    if (team)         setRunTeam(team);
  }, []);

  const goExecute = useCallback(() => {
    if (!runGoal) return;
    setExecuteError(null);

    // Optimistic: switch to Running immediately so the tab feels instant.
    // If the POST or the early SSE watch detects a failure we snap back to
    // Planning and surface the reason.
    setSurface('running');

    fetch('/run/execute', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ goal: runGoal, charter: runCharter, team: runTeam }),
    })
      .then(r => {
        if (!r.ok) return r.json().then((d: { error?: string }) => { throw new Error(d.error ?? `HTTP ${r.status}`); });

        // Open a short-lived SSE listener. If the run gets blocked before the
        // first task arrives (e.g. git-dirty check), snap back to Planning with
        // the reason. Close after 20 s regardless — by then success is confirmed.
        const es = new EventSource('/events');
        let done = false;
        const finish = () => { if (!done) { done = true; es.close(); } };
        const timer = setTimeout(finish, 20_000);

        es.onmessage = (ev) => {
          let msg: { type: string; reason?: string; task?: unknown };
          try { msg = JSON.parse(ev.data); } catch { return; }

          if (msg.type === 'task.created' || msg.type === 'run.classified') {
            clearTimeout(timer); finish();                 // run started — stop watching
          } else if (msg.type === 'run.blocked') {
            clearTimeout(timer); finish();
            setExecuteError(msg.reason ?? 'Run was blocked before it could start');
            setSurface('planning');
          }
        };
        es.onerror = () => { clearTimeout(timer); finish(); };
      })
      .catch((err: Error) => {
        // POST failed (409 conflict, network error, etc.) — snap back to Planning.
        setExecuteError(err.message);
        setSurface('planning');
      });
  }, [runGoal, runCharter, runTeam]);

  const handlePlanNext = useCallback(() => {
    setRunDone(false);
    setPlanNextKey(k => k + 1);
    setSurface('planning');
  }, []);

  // Called by Running when a PR is successfully created.
  // The URL flows down to Planning as recapMessage, where usePlanningSession
  // injects a completion chip and a PM "what's next?" prompt.
  const onPrCreated = useCallback((url: string) => {
    setCompletionRecap(url);
    setSurface('planning');
  }, []);

  const serverDot = serverStatus === 'up'      ? 'var(--green)'
                  : serverStatus === 'probing' ? 'var(--tx-3)'
                  : 'var(--amber)';
  const serverLabel = serverStatus === 'up'      ? 'agents ready'
                    : serverStatus === 'probing' ? 'connecting…'
                    : 'agents offline';

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="glyph"><i /><i /><i /></span>
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
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--tx-3)',
                textDecoration: 'none', marginLeft: 6,
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--tx-1)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--tx-3)')}
            >
              <IconGitHub />
            </a>
          )}
          {branchName && (
            <span className="branch-chip" title={branchName}>
              ⎇ {branchName.replace(/^swarm\//, '')}
            </span>
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
          <button className={surface === 'planning'    ? 'on' : ''} onClick={() => setSurface('planning')}>Planning</button>
          <button className={surface === 'running'     ? 'on' : ''} onClick={() => setSurface('running')}>Running</button>
          <button className={surface === 'marketplace' ? 'on' : ''} onClick={() => setSurface('marketplace')}>Marketplace</button>
        </div>
        {surface === 'running' && runDone && (
          <button
            className="btn primary"
            onClick={handlePlanNext}
            style={{ marginLeft: 10 }}
          >
            ← Plan next task
          </button>
        )}
        <div className="spacer" />

        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--tx-2)',
          marginRight: 6,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: serverDot,
            ...(serverStatus === 'probing' ? { animation: 'softpulse 1.4s infinite' } : {}),
          }} />
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
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--red)',
                background: 'var(--red-d)', border: '1px solid rgba(240,90,82,0.25)',
                borderRadius: 6, padding: '4px 10px', maxWidth: 380,
              }}>
                <span style={{ flexShrink: 0 }}>✗</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{executeError}</span>
                <button
                  onClick={() => setExecuteError(null)}
                  style={{ flexShrink: 0, color: 'var(--red)', opacity: 0.7, fontSize: 13, lineHeight: 1 }}
                  title="Dismiss"
                >×</button>
              </span>
            ) : (
              <span className="pill">
                <span className="dot" style={{ background: 'var(--amber)' }} />
                PLANNING
              </span>
            )}
            {/* Wrapper span carries the tooltip — disabled buttons swallow pointer events
                in Chrome so `title` never fires directly on the button. */}
            <span
              title={!executable ? executableReason : undefined}
              style={{ display: 'inline-flex', cursor: !executable ? 'not-allowed' : 'default' }}
            >
              <button
                className="btn primary"
                disabled={!executable}
                onClick={goExecute}
                style={{ pointerEvents: !executable ? 'none' : 'auto' }}
              >
                Execute <IconPlay />
              </button>
            </span>
          </>
        )}
      </div>

      {showSwitcher && (
        <ProjectSwitcher
          currentRoot={projectRoot}
          onClose={() => setShowSwitcher(false)}
        />
      )}

      <div className="surface">
        <div style={{
          height:  '100%',
          display: surface === 'planning' ? 'block' : 'none',
        }}>
          <Planning onExecute={goExecute} onExecutable={handleExecutable} serverStatus={serverStatus} recapMessage={completionRecap} planNextKey={planNextKey} />
        </div>
        {surface === 'running'     && <Running onPrCreated={onPrCreated} onRunDone={() => setRunDone(true)} />}
        {surface === 'marketplace' && <Marketplace />}
      </div>
    </div>
  );
}
