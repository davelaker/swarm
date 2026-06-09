import { useState, useCallback, useEffect } from 'react';
import type { Surface } from './types';
import { Planning }   from './components/planning/Planning';
import { Running }    from './components/running/Running';
import { Marketplace } from './components/marketplace/Marketplace';
import { IconPlay }   from './components/common/icons';

export type ServerStatus = 'probing' | 'up' | 'down';

export interface RunCharter {
  constraints: string[];
  nongoals:    string[];
  questions:   string[];
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
  const [serverStatus, setServerStatus] = useState<ServerStatus>('probing');
  const [projectName,  setProjectName]  = useState<string | null>(null);
  const [modelLabel,   setModelLabel]   = useState<string | null>(null);

  // Single server probe — retries every 3s, also reads project name when up.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let mounted = true;

    const probe = () => {
      fetch('/state', { signal: AbortSignal.timeout(2000) })
        .then(r => { if (!r.ok) throw new Error(); return r.json(); })
        .then((s: { project?: string; driver?: string; model?: string | null; activeRun?: boolean }) => {
          if (!mounted) return;
          setServerStatus('up');
          if (s.project) setProjectName(s.project);
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
    if (runGoal) {
      fetch('/run/execute', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ goal: runGoal, charter: runCharter, team: runTeam }),
      }).catch(() => {});
    }
    setSurface('running');
  }, [runGoal, runCharter, runTeam]);

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
        </div>
        <div className="nav">
          <button className={surface === 'planning'    ? 'on' : ''} onClick={() => setSurface('planning')}>Planning</button>
          <button className={surface === 'running'     ? 'on' : ''} onClick={() => setSurface('running')}>Running</button>
          <button className={surface === 'marketplace' ? 'on' : ''} onClick={() => setSurface('marketplace')}>Marketplace</button>
        </div>
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
            <span className="pill">
              <span className="dot" style={{ background: 'var(--amber)' }} />
              PLANNING
            </span>
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

      <div className="surface">
        <div style={{
          height:  '100%',
          display: surface === 'planning' ? 'block' : 'none',
        }}>
          <Planning onExecute={goExecute} onExecutable={handleExecutable} serverStatus={serverStatus} />
        </div>
        {surface === 'running'     && <Running />}
        {surface === 'marketplace' && <Marketplace />}
      </div>
    </div>
  );
}
