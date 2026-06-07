import { useState, useCallback } from 'react';
import type { Surface } from './types';
import { Planning } from './components/planning/Planning';
import { Running } from './components/running/Running';
import { Marketplace } from './components/marketplace/Marketplace';
import { IconPlay } from './components/common/icons';

export function App() {
  const [surface,    setSurface]    = useState<Surface>('planning');
  const [executable, setExecutable] = useState(false);

  // Keep Planning mounted but hidden so session state (messages, charter)
  // survives navigation to Marketplace and back.
  const goExecute = useCallback(() => setSurface('running'), []);

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
          <Planning onExecute={goExecute} onExecutable={setExecutable} />
        </div>
        {surface === 'running'     && <Running />}
        {surface === 'marketplace' && <Marketplace />}
      </div>
    </div>
  );
}
