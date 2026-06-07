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
  const [serverStatus, setServerStatus] = useState<ServerStatus>('probing');

  // Single server probe shared by all surfaces — retries every 3s when down.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let mounted = true;

    const probe = () => {
      fetch('/state', { signal: AbortSignal.timeout(2000) })
        .then(r => { if (mounted) setServerStatus(r.ok ? 'up' : 'down'); })
        .catch(() => { if (mounted) setServerStatus('down'); })
        .finally(() => {
          if (mounted) timer = setTimeout(probe, 3000);
        });
    };

    probe();
    return () => { mounted = false; if (timer) clearTimeout(timer); };
  }, []);

  const goExecute = useCallback(() => setSurface('running'), []);

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
          <span className="sep">/</span>
          <span className="proj">discord-rank-bot</span>
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
          <Planning onExecute={goExecute} onExecutable={setExecutable} serverStatus={serverStatus} />
        </div>
        {surface === 'running'     && <Running />}
        {surface === 'marketplace' && <Marketplace />}
      </div>
    </div>
  );
}
