import ReactMarkdown from 'react-markdown';
import type { ChatMessage } from '../../types';

function Avatar({ from }: { from: string }) {
  if (from === 'you')      return <div className="ava" style={{ background: 'var(--bg-3)', color: 'var(--tx-1)' }}>YOU</div>;
  if (from === 'security') return <div className="ava" style={{ background: 'var(--amber-d)', color: 'var(--amber)' }}>SE</div>;
  return <div className="ava" style={{ background: 'var(--purple-d)', color: 'var(--purple)' }}>PM</div>;
}

export function Message({ m }: { m: ChatMessage }) {
  if (m.from === 'system') {
    const isError = m.text.startsWith('✗');
    return (
      <div className="anim-in" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '6px 0',
      }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.5,
          borderRadius: 6, padding: '5px 12px',
          ...(isError ? {
            color:      'var(--red)',
            background: 'var(--red-d)',
            border:     '1px solid rgba(240,90,82,0.25)',
            whiteSpace: 'pre-wrap' as const,
          } : {
            color:      'var(--tx-3)',
            background: 'var(--bg-2)',
            border:     '1px solid var(--border)',
          }),
        }}>
          {m.text}
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
        <div className="bubble md">
          <ReactMarkdown>{m.text}</ReactMarkdown>
        </div>
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
