import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ActivityEntry } from '../../types';
import { IconEye, IconPencil, IconTerminal, IconSearch, IconFolder, IconFile } from './icons';

// Fixed-width leading slot so every row's text starts at the same x — toggles,
// type glyphs, and the research magnifier all centre in the same 14px column.
const ICON_SLOT = 14;

// Icon for a tool. Prefer the structured tool name; fall back to the human label's
// prefix (describeToolUse output) when a step arrives without one.
function ToolGlyph({ tool, text }: { tool?: string; text: string }) {
  const t = tool ?? '';
  if (t === 'Read' || text.startsWith('Reading')) {
    return <IconEye size={12} />;
  }
  if (t === 'Edit' || t === 'MultiEdit' || t === 'Write' || /^(Editing|Writing)/.test(text)) {
    return <IconPencil size={12} />;
  }
  if (t === 'Bash' || text.startsWith('$')) {
    return <IconTerminal size={12} />;
  }
  if (t === 'Grep' || t === 'Glob' || text.startsWith('Searching')) {
    return <IconSearch size={12} />;
  }
  if (t === 'LS' || text.startsWith('Listing')) {
    return <IconFolder size={12} />;
  }
  return <IconFile />;
}

// Collapse a multi-line thinking block to a short single-line preview: first
// non-empty line, clamped to a character budget at a word boundary with an
// ellipsis. Keeps the transcript scannable; the full text lives behind the toggle.
const PREVIEW_MAX = 110;
function thinkingPreview(text: string): string {
  const firstLine = (text.split('\n').find(l => l.trim()) ?? text).trim();
  if (firstLine.length <= PREVIEW_MAX) {
    return firstLine;
  }
  const cut = firstLine.slice(0, PREVIEW_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > PREVIEW_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const TOOL_VERB: Record<string, string> = {
  Read: 'Read',
  Edit: 'Edit',
  MultiEdit: 'Edit',
  Write: 'Wrote',
};

const LANG: Record<string, { label: string; color: string }> = {
  ts: { label: 'TS', color: '#4d8df4' },
  tsx: { label: 'TSX', color: '#4d8df4' },
  js: { label: 'JS', color: '#e3b341' },
  jsx: { label: 'JSX', color: '#e3b341' },
  json: { label: 'JSON', color: '#9aa0a6' },
  md: { label: 'MD', color: '#9aa0a6' },
  css: { label: 'CSS', color: '#c678dd' },
  scss: { label: 'SCSS', color: '#c678dd' },
  html: { label: 'HTML', color: '#e06c4f' },
  py: { label: 'PY', color: '#4d8df4' },
  go: { label: 'GO', color: '#4d8df4' },
  rs: { label: 'RS', color: '#e06c4f' },
  sh: { label: 'SH', color: '#9aa0a6' },
  yml: { label: 'YAML', color: '#9aa0a6' },
  yaml: { label: 'YAML', color: '#9aa0a6' },
};

function fileMeta(filePath: string): { name: string; badge: string; color: string } {
  const name = filePath.split('/').filter(Boolean).pop() ?? filePath;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const lang = LANG[ext] ?? { label: ext ? ext.toUpperCase() : 'FILE', color: 'var(--tx-3)' };
  return { name, badge: lang.label, color: lang.color };
}

// A filename chip with a language badge, e.g. [TS] auth.ts
function FileChip({ file }: { file: string }) {
  const { name, badge, color } = fileMeta(file);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '1px 6px',
        borderRadius: 5,
        background: 'var(--bg-3)',
        border: '1px solid var(--border)',
        maxWidth: 200,
        minWidth: 0,
      }}
    >
      <span style={{ fontWeight: 700, fontSize: 9, letterSpacing: 0.3, color, flexShrink: 0 }}>
        {badge}
      </span>
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
    </span>
  );
}

// A collapsible row: a fixed-width leading slot, a label, and a one-line preview
// that expands to the full text. Used for thinking blocks and research steps so
// they read and align identically.
function ExpandableRow({
  leading,
  label,
  text,
}: {
  leading: (open: boolean) => ReactNode;
  label: string;
  text: string;
}) {
  const [open, setOpen] = useState(false);
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
        <span
          style={{
            width: ICON_SLOT,
            flexShrink: 0,
            display: 'inline-flex',
            justifyContent: 'center',
            alignItems: 'center',
            opacity: 0.55,
          }}
        >
          {leading(open)}
        </span>
        <span style={{ flexShrink: 0, opacity: 0.8 }}>{label}</span>
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
            {thinkingPreview(text)}
          </span>
        )}
      </button>
      {open && (
        <div
          style={{
            paddingLeft: ICON_SLOT + 7,
            marginTop: 3,
            fontSize: 11.5,
            lineHeight: 1.6,
            opacity: 0.62,
            fontStyle: 'italic',
            whiteSpace: 'pre-wrap',
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

// One row of an agent/PM activity transcript. Thinking and research steps are
// expandable (preview → full text); file-bearing tools show a verb, optional line
// count, and a language-badged filename chip; other tools fall back to action text.
export function ActivityItem({ entry, color }: { entry: ActivityEntry; color?: string }) {
  if (entry.kind === 'thinking') {
    return (
      <ExpandableRow
        leading={open => <span style={{ fontSize: 13 }}>{open ? '–' : '+'}</span>}
        label="Thinking"
        text={entry.text}
      />
    );
  }

  // Research / sub-agent step — expandable like thinking, with a magnifier.
  if (entry.tool === 'research') {
    const label = entry.detail && entry.detail !== 'Scout' ? entry.detail : 'Scouting the codebase';
    return (
      <ExpandableRow leading={() => <IconSearch size={12} />} label={label} text={entry.text} />
    );
  }

  const glyph = (
    <span
      style={{
        width: ICON_SLOT,
        flexShrink: 0,
        display: 'flex',
        justifyContent: 'center',
        opacity: 0.75,
        ...(color ? { color } : {}),
      }}
    >
      <ToolGlyph tool={entry.tool} text={entry.text} />
    </span>
  );

  // File-bearing tool: verb + optional line count + language-badged filename chip.
  if (entry.file) {
    const verb = (entry.tool && TOOL_VERB[entry.tool]) || entry.tool || 'Used';
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '2px 0',
          fontSize: 11.5,
          lineHeight: 1.55,
        }}
      >
        {glyph}
        <span style={{ flexShrink: 0, opacity: 0.85 }}>
          {verb}
          {entry.detail ? ` ${entry.detail}` : ''}
        </span>
        <FileChip file={entry.file} />
      </div>
    );
  }

  // Tool without a file (Bash, search, …): icon + the action text.
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
      {glyph}
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
