import { useState } from 'react';
import type { ActivityEntry } from '../../types';
import { IconEye, IconPencil, IconTerminal, IconSearch, IconFolder, IconFile } from './icons';

// Pick a glyph for a tool step from the human label describeToolUse() produced.
// Matching on the prefix keeps the icon logic in one place without threading the
// raw tool name through every event.
function ToolGlyph({ text }: { text: string }) {
  if (text.startsWith('$')) {
    return <IconTerminal size={12} />;
  }
  if (text.startsWith('Reading')) {
    return <IconEye size={12} />;
  }
  if (text.startsWith('Editing') || text.startsWith('Writing')) {
    return <IconPencil size={12} />;
  }
  if (text.startsWith('Searching')) {
    return <IconSearch />;
  }
  if (text.startsWith('Listing')) {
    return <IconFolder size={12} />;
  }
  return <IconFile />;
}

// One row of an agent/PM activity transcript. Thinking blocks collapse to a
// labelled one-line preview with a +/– toggle to reveal the full reasoning; tool
// steps render with a type glyph and the action text.
export function ActivityItem({ entry, color }: { entry: ActivityEntry; color?: string }) {
  const [open, setOpen] = useState(false);

  if (entry.kind === 'thinking') {
    const firstLine = entry.text.split('\n').find(l => l.trim()) ?? entry.text;
    return (
      <div style={{ padding: '2px 0' }}>
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 7,
            width: '100%',
            textAlign: 'left',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: 'inherit',
            fontSize: 11.5,
            lineHeight: 1.55,
          }}
        >
          <span style={{ width: 10, flexShrink: 0, opacity: 0.5, fontSize: 13 }}>
            {open ? '–' : '+'}
          </span>
          <span style={{ flexShrink: 0, opacity: 0.8 }}>Thinking</span>
          {!open && (
            <span
              style={{
                flex: 1,
                minWidth: 0,
                opacity: 0.5,
                fontStyle: 'italic',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {firstLine}
            </span>
          )}
        </button>
        {open && (
          <div
            style={{
              paddingLeft: 17,
              marginTop: 3,
              fontSize: 11.5,
              lineHeight: 1.6,
              opacity: 0.62,
              fontStyle: 'italic',
              whiteSpace: 'pre-wrap',
            }}
          >
            {entry.text}
          </div>
        )}
      </div>
    );
  }

  // Tool step — short single line; icon + action text.
  return (
    <div
      title={entry.text}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '2px 0',
        fontSize: 11.5,
        lineHeight: 1.55,
      }}
    >
      <span
        style={{
          width: 14,
          flexShrink: 0,
          display: 'flex',
          justifyContent: 'center',
          opacity: 0.75,
          ...(color ? { color } : {}),
        }}
      >
        <ToolGlyph text={entry.text} />
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          opacity: 0.85,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.text}
      </span>
    </div>
  );
}
