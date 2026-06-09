import { Fragment } from 'react';
import type { ChatMessage } from '../../types';

// ─── Inline Markdown ──────────────────────────────────────────────────────────
// Handles: **bold**, *italic*, `code`
// Order in the regex matters — bold/code before italic so ** isn't eaten by *.

const INLINE_RE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g;

function renderInline(text: string) {
  const parts = text.split(INLINE_RE);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')  && part.endsWith('`'))
      return <code key={i} className="md-code">{part.slice(1, -1)}</code>;
    if (part.startsWith('*')  && part.endsWith('*'))
      return <em key={i}>{part.slice(1, -1)}</em>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

// ─── Block Markdown ───────────────────────────────────────────────────────────
// Handles paragraphs (blank-line separated), bullet lists (- or *), line breaks.

function renderMarkdown(text: string) {
  const blocks = text.trim().split(/\n{2,}/);

  return blocks.map((block, bi) => {
    const lines = block.split('\n');

    // Bullet list: every line starts with "- " or "* "
    if (lines.length > 1 && lines.every(l => /^\s*[-*]\s/.test(l))) {
      return (
        <ul key={bi} className="md-list">
          {lines.map((line, li) => (
            <li key={li}>{renderInline(line.replace(/^\s*[-*]\s+/, ''))}</li>
          ))}
        </ul>
      );
    }

    // Mixed block: some bullet lines, some plain — render each line individually
    if (lines.some(l => /^\s*[-*]\s/.test(l))) {
      return (
        <div key={bi} className="md-block">
          {lines.map((line, li) => {
            if (/^\s*[-*]\s/.test(line)) {
              return (
                <div key={li} className="md-inline-bullet">
                  <span className="md-bullet-mk">▸</span>
                  {renderInline(line.replace(/^\s*[-*]\s+/, ''))}
                </div>
              );
            }
            return <p key={li} className="md-p">{renderInline(line)}</p>;
          })}
        </div>
      );
    }

    // Plain paragraph — preserve single newlines as <br>
    return (
      <p key={bi} className="md-p">
        {lines.map((line, li) => (
          <Fragment key={li}>
            {li > 0 && <br />}
            {renderInline(line)}
          </Fragment>
        ))}
      </p>
    );
  });
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
          {renderInline(m.text)}
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
        <div className="bubble md">{renderMarkdown(m.text)}</div>
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
