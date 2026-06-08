import { useState, useCallback, useEffect } from 'react';
import type { Surface } from './types';
import { Planning } from './components/planning/Planning';
import { Running } from './components/running/Running';
import { Marketplace } from './components/marketplace/Marketplace';
import { IconPlay } from './components/common/icons';

export type ServerStatus = 'probing' | 'up' | 'down';

export function App() {
  const [surface,      setSurface]      = useState<Surface>('planning');
  const [executable,   setExecutable]   = useState(false);
  const [runGoal,      setRunGoal]      = useState('');
  const [serverStatus, setServerStatus] = useState<ServerStatus>('probing');
  const [projectName,  setProjectName]  = useState<string | null>(null);

  // Single server probe — retries every 3s, also reads project name when up.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let mounted = true;

    const probe = () => {
      fetch('/state', { signal: AbortSignal.timeout(2000) })
        .then(r => { if (!r.ok) throw new Error(); return r.json(); })
        .then((s: { project?: string }) => {
          if (!mounted) return;
          setServerStatus('up');
          if (s.project) setProjectName(s.project);
        })
        .catch(() => { if (mounted) setServerStatus('down'); })
        .finally(() => { if (mounted) timer = setTimeout(probe, 3000); });
    };

    probe();
    return () => { mounted = false; if (timer) clearTimeout(timer); };
  }, []);

  const handleExecutable = useCallback((v: boolean, goal?: string) => {
    setExecutable(v);
    if (goal) setRunGoal(goal);
  }, []);

  const goExecute = useCallback(() => {
    // Fire POST /run/execute — backend starts the run async, SSE carries progress.
    // The server must be running; if not, the Running surface shows instructions.
    if (runGoal) {
      fetch('/run/execute', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ goal: runGoal }),
      }).catch(() => {}); // fire-and-forget; Running surface handles server-down state
    }
    setSurface('running');
  }, [runGoal]);

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

        {/* Server status — visible on all surfaces */}
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
        </span>

        {surface === 'planning' && (
          <>
            <span className="pill">
              <span className="dot" style={{ background: 'var(--amber)' }} />
              PLANNING
            </span>
            <button className="btn primary" disabled={!executable} onClick={goExecute}>
              Execute <IconPlay />
            </button>
          </>
        )}
      </div>

      <div className="surface">
        {/* Planning stays mounted so session state survives navigation.
            display:none hides it without unmounting; height:100% on the
            inner wrapper is what .plan{height:100%} resolves against. */}
        <div style={{
          height:   '100%',
          display:  surface === 'planning' ? 'block' : 'none',
        }}>
          <Planning onExecute={goExecute} onExecutable={handleExecutable} serverStatus={serverStatus} />
        </div>
        {surface === 'running'     && <Running />}
        {surface === 'marketplace' && <Marketplace />}
      </div>
    </div>
  );
}
