import { useState } from 'react';
import { useSessionHistory } from '../../hooks/useSessionHistory';
import type { SessionMeta, SessionSnapshot } from '../../types';

interface SessionsPanelProps {
  onSelectSession: (session: SessionSnapshot) => void;
  activeSessionId?: string;
}

function tierColor(tier: string): string {
  switch (tier) {
    case 'bugfix':
      return 'var(--green)';
    case 'feature':
      return 'var(--blue, #4f9cf9)';
    case 'greenfield':
      return 'var(--amber)';
    case 'refactor':
      return 'var(--tx-3)';
    default:
      return 'var(--tx-3)';
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDay = Math.floor(diffMs / 86_400_000);
  if (diffDay === 0)
    return 'today ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function VerdictDots({ pass, fail, total }: { pass: number; fail: number; total: number }) {
  const other = total - pass - fail;
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
      {pass > 0 && (
        <span style={{ fontSize: 10, color: 'var(--green)', fontFamily: 'var(--mono)' }}>
          {pass}✓
        </span>
      )}
      {fail > 0 && (
        <span style={{ fontSize: 10, color: 'var(--red)', fontFamily: 'var(--mono)' }}>
          {fail}✗
        </span>
      )}
      {other > 0 && (
        <span style={{ fontSize: 10, color: 'var(--tx-3)', fontFamily: 'var(--mono)' }}>
          {other}·
        </span>
      )}
    </span>
  );
}

function SessionRow({
  s,
  active,
  onLoad,
}: {
  s: SessionMeta;
  active: boolean;
  onLoad: () => void;
}) {
  return (
    <button
      onClick={onLoad}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        width: '100%',
        textAlign: 'left',
        padding: '10px 14px',
        background: active ? 'var(--bg-2)' : 'transparent',
        border: 'none',
        borderBottom: '1px solid var(--br)',
        cursor: 'pointer',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => {
        if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--bg-1)';
      }}
      onMouseLeave={e => {
        if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
      >
        <span
          style={{
            fontSize: 11,
            fontFamily: 'var(--mono)',
            fontWeight: 600,
            color: tierColor(s.tier),
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            flexShrink: 0,
          }}
        >
          {s.tier}
        </span>
        <span
          style={{ fontSize: 11, color: 'var(--tx-3)', fontFamily: 'var(--mono)', flexShrink: 0 }}
        >
          {formatDate(s.savedAt)}
        </span>
      </div>
      <span
        style={{
          fontSize: 12,
          color: 'var(--tx-1)',
          lineHeight: 1.4,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}
      >
        {s.goal}
      </span>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 2,
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--tx-3)', fontFamily: 'var(--mono)' }}>
          {s.taskCount} task{s.taskCount !== 1 ? 's' : ''}
          {s.branchName && <> · {s.branchName.replace(/^swarm\//, '')}</>}
        </span>
        <VerdictDots pass={s.passCount} fail={s.failCount} total={s.taskCount} />
      </div>
    </button>
  );
}

export function SessionsPanel({ onSelectSession, activeSessionId }: SessionsPanelProps) {
  const { sessions, loading, error, refresh, loadSession } = useSessionHistory();
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const handleLoad = (id: string) => {
    setLoadingId(id);
    setLoadErr(null);
    loadSession(id)
      .then(snap => {
        onSelectSession(snap);
      })
      .catch((e: Error) => setLoadErr(e.message))
      .finally(() => setLoadingId(null));
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid var(--br)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--tx-2)',
          }}
        >
          Session History
        </span>
        <button
          onClick={refresh}
          style={{
            fontSize: 11,
            color: 'var(--tx-3)',
            fontFamily: 'var(--mono)',
            padding: '2px 6px',
          }}
          title="Refresh list"
        >
          ↺
        </button>
      </div>

      {/* Error */}
      {(error || loadErr) && (
        <div
          style={{
            padding: '10px 16px',
            fontSize: 12,
            color: 'var(--red)',
            fontFamily: 'var(--mono)',
            borderBottom: '1px solid var(--br)',
          }}
        >
          {error ?? loadErr}
        </div>
      )}

      {/* Session list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && sessions.length === 0 && (
          <div
            style={{
              padding: 32,
              textAlign: 'center',
              color: 'var(--tx-3)',
              fontFamily: 'var(--mono)',
              fontSize: 12,
            }}
          >
            loading…
          </div>
        )}

        {!loading && sessions.length === 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              gap: 12,
              padding: 40,
              textAlign: 'center',
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
              No sessions yet
            </div>
            <div style={{ color: 'var(--tx-2)', fontSize: 13, maxWidth: 300, lineHeight: 1.7 }}>
              Past runs are automatically saved here when they complete.
            </div>
          </div>
        )}

        {sessions.map(s => (
          <SessionRow
            key={s.id}
            s={s}
            active={s.id === activeSessionId}
            onLoad={() => handleLoad(s.id)}
          />
        ))}

        {loadingId && (
          <div
            style={{
              padding: '10px 16px',
              fontSize: 12,
              color: 'var(--tx-3)',
              fontFamily: 'var(--mono)',
              textAlign: 'center',
            }}
          >
            loading session…
          </div>
        )}
      </div>

      <div style={{ padding: '10px 16px', borderTop: '1px solid var(--br)', flexShrink: 0 }}>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--tx-3)', lineHeight: 1.5 }}>
          Click a session to view it in Running and Planning tabs.
        </p>
      </div>
    </div>
  );
}
