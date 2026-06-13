import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ChatMessage } from '../../types';
import { PERSONAS } from '../../data/personas';

function Avatar({ from }: { from: string }) {
  if (from === 'you')      return <div className="ava" style={{ background: 'var(--bg-3)', color: 'var(--tx-1)' }}>YOU</div>;
  if (from === 'security') return <div className="ava" style={{ background: 'var(--amber-d)', color: 'var(--amber)' }}>SE</div>;
  return <div className="ava" style={{ background: 'var(--purple-d)', color: 'var(--purple)' }}>PM</div>;
}

// ─── PM message sub-renderers ─────────────────────────────────────────────────
// PM messages are classified by their text prefix into four visual treatments:
//   ✗ …           → red error pill    (e.g. "✗ PR creation failed: …")
//   ⬆ … / ✓ …    → green action pill (e.g. "⬆ Pushed to remote successfully")
//   → agent [tX]: → compact dispatch row (agent routing, not addressed to user)
//   anything else → full PM bubble (goal text, narrative commentary)

const DISPATCH_RE = /^→\s+(\w+)\s+\[([^\]]+)\]:\s*(.+)$/s;

function PmMessageRow({ text, time }: { text: string; time?: string }) {
  // ── Error pill ──────────────────────────────────────────────────────────────
  if (text.startsWith('✗')) {
    return (
      <div className="anim-in" style={{ display: 'flex', justifyContent: 'center', padding: '5px 12px' }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.5,
          borderRadius: 6, padding: '4px 12px',
          color: 'var(--red)', background: 'var(--red-d)',
          border: '1px solid rgba(240,90,82,0.25)',
          whiteSpace: 'pre-wrap',
        }}>
          {text}
        </span>
      </div>
    );
  }

  // ── Success / action pill ───────────────────────────────────────────────────
  if (text.startsWith('⬆') || text.startsWith('✓')) {
    return (
      <div className="anim-in" style={{ display: 'flex', justifyContent: 'center', padding: '5px 12px' }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.5,
          borderRadius: 6, padding: '4px 12px',
          color: 'var(--green)', background: 'var(--green-d)',
          border: '1px solid rgba(52,207,138,0.2)',
        }}>
          {text}
        </span>
      </div>
    );
  }

  // ── Dispatch row ────────────────────────────────────────────────────────────
  // → coder [t1]: "Run the tests"   →   ● Coder [t1]  Run the tests…
  // These are the PM routing tasks to agents — not addressed to the user.
  // Rendered compact: no avatar, no bubble, just a labeled status line.
  const dm = text.match(DISPATCH_RE);
  if (dm) {
    const [, agentId, taskId, rawDesc] = dm;
    const p     = PERSONAS[agentId];
    const color = p?.color ?? 'var(--tx-3)';
    const desc  = rawDesc.trim().replace(/^"([\s\S]*)"$/, '$1');
    return (
      <div className="anim-in" style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '3px 16px 3px 12px',
        borderLeft: `2px solid ${color}33`,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: color, flexShrink: 0,
        }} />
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
          color, flexShrink: 0,
        }}>
          {p?.name ?? agentId}
        </span>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10,
          color: 'var(--tx-3)', flexShrink: 0,
        }}>
          [{taskId}]
        </span>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11,
          color: 'var(--tx-3)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          flex: 1, minWidth: 0,
        }}>
          {desc}
        </span>
      </div>
    );
  }

  // ── Narrative PM bubble ─────────────────────────────────────────────────────
  // Goal text, commentary, anything the PM says to the user directly.
  return (
    <div className="msg anim-in">
      <Avatar from="pm" />
      <div className="msg-body">
        <div className="msg-meta">
          <span className="who">Project Manager</span>
          {time && <span className="time">{time}</span>}
        </div>
        <div className="bubble md">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
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

  // PM messages: classified by text pattern (dispatch, error, success, narrative)
  if (m.from === 'pm') return <PmMessageRow text={m.text} time={m.time} />;

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

const THINKING_MESSAGES = [
  "I'm looking into your request...",
  "I'm still doing research...",
  "This is taking a while, but I'm working on it...",
  "Thinking through the best approach here...",
  "Checking the project context to make sure I have this right...",
  "Still at it — complex requests take a bit more care...",
  "Getting some good information here, almost ready...",
  "Pulling it all together now...",
];

export function ProgressiveTypingIndicator() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setTick(t => Math.min(t + 1, THINKING_MESSAGES.length));
    }, 8000);
    return () => clearInterval(id);
  }, []);

  if (tick === 0) return <TypingIndicator from="pm" />;

  return (
    <div className="msg anim-in">
      <Avatar from="pm" />
      <div className="msg-body">
        <div className="msg-meta">
          <span className="who">Project Manager</span>
        </div>
        <div className="bubble" style={{ fontStyle: 'italic', color: 'var(--tx-3)', fontSize: 13 }}>
          {THINKING_MESSAGES[tick - 1]}
        </div>
      </div>
    </div>
  );
}

export function StreamingMessage({ text }: { text: string }) {
  return (
    <div className="msg anim-in">
      <Avatar from="pm" />
      <div className="msg-body">
        <div className="msg-meta">
          <span className="who">Project Manager</span>
        </div>
        <div className="bubble md">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

// Shown while a read-only Scout (or a hired specialist) investigates to answer a PM
// question. `agent` is the specialist's display name, or undefined for the generic Scout.
export function ResearchIndicator({ question, agent }: { question: string; agent?: string }) {
  const lead = agent ? `${agent} is investigating: ` : 'Scouting the codebase: ';
  return (
    <div className="msg anim-in">
      <Avatar from="pm" />
      <div className="msg-body">
        <div className="msg-meta">
          <span className="who">Project Manager</span>
          <span className="who-tag">{agent ? 'consulting' : 'researching'}</span>
        </div>
        <div
          className="bubble"
          style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13, color: 'var(--tx-2)' }}
        >
          <span style={{ flexShrink: 0 }}>🔍</span>
          <span>
            <span style={{ color: 'var(--tx-3)' }}>{lead}</span>
            {question}
            <span className="cursor" style={{ marginLeft: 2 }} />
          </span>
        </div>
      </div>
    </div>
  );
}
