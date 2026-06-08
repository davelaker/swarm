import type { ChatMessage } from '../../types';

function renderText(t: string) {
  const parts = t.split(/(`[^`]+`)/g);
  return parts.map((p, i) =>
    p.startsWith('`') && p.endsWith('`')
      ? <code key={i} style={{ fontFamily: 'var(--mono)', fontSize: '0.85em', background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 4 }}>{p.slice(1, -1)}</code>
      : <span key={i}>{p}</span>
  );
}

function Avatar({ from }: { from: string }) {
  if (from === 'you')      return <div className="ava" style={{ background: 'var(--bg-3)', color: 'var(--tx-1)' }}>YOU</div>;
  if (from === 'security') return <div className="ava" style={{ background: 'var(--amber-d)', color: 'var(--amber)' }}>SE</div>;
  return <div className="ava" style={{ background: 'var(--purple-d)', color: 'var(--purple)' }}>PM</div>;
}

export function Message({ m }: { m: ChatMessage }) {
  // System notices (connection errors etc.) render as a centred, muted inline note
  if (m.from === 'system') {
    return (
      <div className="anim-in" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '6px 0',
      }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--tx-3)',
          background: 'var(--bg-2)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '5px 12px', lineHeight: 1.5,
        }}>
          {renderText(m.text)}
        </span>
      </div>
    );
  }

  const cls = m.from === 'you' ? 'you' : m.from === 'security' ? 'interject' : '';
  const who = m.from === 'you' ? 'You' : m.from === 'security' ? 'Security' : 'Project Manager';
  return (
    <div className={`msg ${cls} anim-in`}>
      <Avatar from={m.from} />
      <div className="msg-body">
        <div className="msg-meta">
          <span className="who">{who}</span>
          {m.time && <span className="time">{m.time}</span>}
        </div>
        <div className="bubble">{renderText(m.text)}</div>
      </div>
    </div>
  );
}

export function TypingIndicator({ from }: { from: string }) {
  const cls = from === 'you' ? 'you' : from === 'security' ? 'interject' : '';
  return (
    <div className={`msg ${cls}`}>
      <Avatar from={from} />
      <div className="msg-body">
        <div className="bubble" style={{ padding: 0 }}>
          <div className="typing"><i /><i /><i /></div>
        </div>
      </div>
    </div>
  );
}
