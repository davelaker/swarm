import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import type { Finding, Task } from '../../types';
import { resolveAgentPersona } from '../../data/personas';
import { IconReport } from '../common/icons';
import { useProjectClient } from '../../project/ProjectClientContext';

// ─── Custom markdown renderers ────────────────────────────────────────────────

const SEVERITY_RE = /\b(CRITICAL|HIGH|MEDIUM|LOW)\b/i;

const VERDICT_LABELS: Record<string, string> = {
  CHANGES_REQUESTED: 'Changes Requested',
  APPROVED: 'Approved',
  COMPLETE: 'Complete',
  PASS: 'Pass',
  PASS_WITH_ADVISORY: 'Pass with Advisory',
  FAILED: 'Failed',
  FAIL: 'Failed',
};

// Normalise a heading that may contain raw verdict codes or label-form repeats:
//   "CHANGES_REQUESTED: CHANGES_REQUESTED" → "Changes Requested"
//   "CHANGES_REQUESTED: something real"    → "Changes Requested: something real"
//   "Complete: Completed"                  → "Complete"  (label-form repeat)
//   "Changes Requested: ..."               → unchanged
function normH2(text: string): string {
  // Raw-code form: all-caps with underscores (e.g. COMPLETE, CHANGES_REQUESTED)
  const m = text.match(/^([A-Z][A-Z_]+?)(?::\s*(.*))?$/);
  if (m) {
    const [, code, rest] = m;
    const label = VERDICT_LABELS[code.toUpperCase()];
    if (label) {
      const restNorm = (rest ?? '')
        .trim()
        .toUpperCase()
        .replace(/[\s_]+/g, '_');
      const codeNorm = code.toUpperCase().replace(/[\s_]+/g, '_');
      if (!rest || restNorm === codeNorm || restNorm.startsWith(codeNorm)) return label;
      return `${label}: ${rest.trim()}`;
    }
  }
  // Label-form: heading already uses the human label (e.g. "Complete: Completed").
  // Happens when server-generated finding files are re-read in the modal.
  for (const [code, label] of Object.entries(VERDICT_LABELS)) {
    if (text === label) return label;
    if (text.startsWith(`${label}: `)) {
      const rest = text.slice(label.length + 2).trim();
      const restNorm = rest.toUpperCase().replace(/[\s_]+/g, '_');
      const codeNorm = code.toUpperCase().replace(/[\s_]+/g, '_');
      if (!rest || restNorm === codeNorm || restNorm.startsWith(codeNorm)) return label;
      return `${label}: ${rest}`;
    }
  }
  return text;
}

const mdComponents: Components = {
  h2({ children }) {
    const text = String(children ?? '');
    const normal = normH2(text);
    const isPass = /^(Complete|Pass|Approved)/i.test(normal);
    const isBad = /^(Failed|Changes Requested)/i.test(normal);
    const color = isPass ? 'var(--green)' : isBad ? 'var(--amber)' : 'var(--tx)';
    return <h2 style={{ color }}>{normal}</h2>;
  },
  h3({ children }) {
    const text = String(children ?? '');
    const match = text.match(SEVERITY_RE);
    const sev = match ? match[1].toUpperCase() : null;
    const color =
      sev === 'CRITICAL'
        ? 'var(--red)'
        : sev === 'HIGH'
          ? 'var(--amber)'
          : sev === 'MEDIUM'
            ? 'var(--orange)'
            : sev === 'LOW'
              ? 'var(--tx-2)'
              : 'var(--tx-1)';
    return <h3 style={{ color }}>{children}</h3>;
  },
  code({ children }) {
    return <code>{children}</code>;
  },
  img({ src, alt }) {
    // Visual-gate screenshots are embedded as `![route](visual/<task>/x.png)` —
    // a path relative to .swarm/. Route those through the backend image endpoint;
    // leave absolute/data URLs untouched.
    const raw = typeof src === 'string' ? src : '';
    const isExternal = /^(https?:|data:|\/findings\/image)/.test(raw);
    const resolved = isExternal ? raw : `/findings/image?path=${encodeURIComponent(raw)}`;
    return (
      <a
        href={resolved}
        target="_blank"
        rel="noreferrer"
        title={`${alt || 'screenshot'} — open full size`}
      >
        <img src={resolved} alt={alt || ''} className="finding-shot" loading="lazy" />
      </a>
    );
  },
};

// ─── Chip ─────────────────────────────────────────────────────────────────────

type ChipState = { label: string; cls: string };

function deriveChip(f: Finding, tasks: Task[]): ChipState {
  const task = tasks.find(t => t.id === f.task);
  // Only show BLOCKED when the finding itself signalled problems (changes/fail).
  // If the agent approved (pass/complete) but the PM blocked the task for workflow
  // reasons, the chip should reflect what the agent actually found — not the PM's
  // workflow decision. The task graph already shows the workflow state.
  if (task?.status === 'blocked' && (f.verdict === 'changes' || f.verdict === 'fail')) {
    return { label: 'CHANGES REQ', cls: 'changes' };
  }
  const fixing = tasks.find(
    t => t.id === `t_fix_${f.task}` && (t.status === 'pending' || t.status === 'in_progress'),
  );
  if (fixing) return { label: 'FIXING…', cls: 'changes' };
  const MAP: Record<string, ChipState> = {
    complete: { label: 'COMPLETE', cls: 'complete' },
    pass: { label: 'PASS', cls: 'pass' },
    pass_with_advisory: { label: 'PASS+ADV', cls: 'pass' },
    changes: { label: 'CHANGES', cls: 'changes' },
    fail: { label: 'FAIL', cls: 'fail' },
  };
  return MAP[f.verdict] ?? { label: f.verdict.toUpperCase(), cls: f.verdict };
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h % 12 || 12}:${m}${h >= 12 ? 'pm' : 'am'}`;
}

// ─── Detail modal ─────────────────────────────────────────────────────────────

function FindingModal({ f, onClose }: { f: Finding; onClose: () => void }) {
  const projectClient = useProjectClient();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const p = resolveAgentPersona(f.agent);
  const chip = deriveChip(f, []); // tasks not needed inside modal (chip already chosen)

  useEffect(() => {
    if (!f.path) {
      setContent('*(no finding file)*');
      setLoading(false);
      return;
    }
    projectClient.fetchResponse(`/findings?path=${encodeURIComponent(f.path)}`)
      .then(r => r.text())
      .then(text => {
        const body = text.replace(/^---[\r\n][\s\S]*?[\r\n]---[\r\n]?/, '').trim();
        setContent(body || '*(no body)*');
      })
      .catch(() => setContent('*(could not load finding)*'))
      .finally(() => setLoading(false));
  }, [f.path, projectClient]);

  // Close on Escape
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'fade 0.12s ease',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg-1)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          width: 'min(820px, 92vw)',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
          animation: 'slideTop 0.15s ease',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 18px',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: p?.color,
              flexShrink: 0,
            }}
          />
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--tx-1)' }}>{p?.name}</span>
          <span style={{ fontSize: 12, color: 'var(--tx-3)', fontFamily: 'var(--mono)' }}>
            {f.task}
          </span>
          <span style={{ flex: 1 }} />
          {f.ts && (
            <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--tx-3)' }}>
              {fmtTime(f.ts)}
            </span>
          )}
          <span className={`vchip ${chip.cls}`} style={{ marginLeft: 4 }}>
            {chip.label}
          </span>
          <button
            onClick={onClose}
            style={{
              marginLeft: 8,
              fontSize: 18,
              lineHeight: 1,
              color: 'var(--tx-3)',
              flexShrink: 0,
            }}
            title="Close (Esc)"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', padding: '20px 24px', flex: 1 }}>
          {loading ? (
            <span style={{ color: 'var(--tx-3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
              Loading…
            </span>
          ) : (
            <div className="finding-md">
              <ReactMarkdown components={mdComponents}>{content ?? ''}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function FindingCard({
  f,
  tasks,
  dimmed,
  highlighted,
}: {
  f: Finding;
  tasks: Task[];
  dimmed?: boolean;
  highlighted?: boolean;
}) {
  const [showModal, setShowModal] = useState(false);
  const p = resolveAgentPersona(f.agent);
  const chip = deriveChip(f, tasks);

  // Trim summary to one line, don't show if it's just a path
  const summaryText =
    f.summary && !f.summary.includes('/')
      ? f.summary.length > 120
        ? f.summary.slice(0, 117) + '…'
        : f.summary
      : null;

  return (
    <>
      <div
        className="finding"
        style={{
          opacity: dimmed ? 0.15 : 1,
          transition: 'opacity 0.15s, box-shadow 0.15s',
          boxShadow: highlighted ? 'inset 2px 0 0 rgba(77,141,244,0.6)' : 'none',
          background: highlighted ? 'rgba(77,141,244,0.04)' : 'transparent',
        }}
      >
        <div className="finding-head" style={{ cursor: 'default' }}>
          <span className="finding-agent">
            <span className="pdot" style={{ background: p?.color }} />
            {p?.name}
          </span>
          <span className="finding-tid">{f.task}</span>
          <span style={{ flex: 1 }} />
          {f.ts && (
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--tx-3)',
                marginRight: 8,
                flexShrink: 0,
              }}
            >
              {fmtTime(f.ts)}
            </span>
          )}
          <span className={`vchip ${chip.cls}`}>{chip.label}</span>
        </div>

        {/* Summary + view link */}
        <div style={{ padding: '6px 14px 10px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
          {summaryText && (
            <span style={{ fontSize: 12, color: 'var(--tx-2)', lineHeight: 1.5, flex: 1 }}>
              {summaryText}
            </span>
          )}
          {f.path && (
            <button
              onClick={() => setShowModal(true)}
              title="View full report"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                fontFamily: 'var(--mono)',
                color: 'var(--blue)',
                whiteSpace: 'nowrap',
                flexShrink: 0,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              <IconReport size={11} />
              report
            </button>
          )}
        </div>
      </div>

      {showModal && <FindingModal f={f} onClose={() => setShowModal(false)} />}
    </>
  );
}

// ─── Feed ─────────────────────────────────────────────────────────────────────

export function FindingsFeed({
  findings,
  tasks,
  hoveredTaskId,
}: {
  findings: Finding[];
  tasks: Task[];
  hoveredTaskId?: string | null;
}) {
  return (
    <div className="run-findings">
      <div className="panel-head">
        <span>Findings</span>
        <span className="spacer" />
        <span
          className="mono"
          style={{ fontSize: 11, color: 'var(--tx-3)', textTransform: 'none', letterSpacing: 0 }}
        >
          {findings.length} logged
        </span>
      </div>
      <div className="feed-scroll">
        {findings.length === 0 && <div className="feed-empty">waiting for the first finding…</div>}
        {findings.map(f => (
          <FindingCard
            key={f.key}
            f={f}
            tasks={tasks}
            highlighted={hoveredTaskId != null && f.task === hoveredTaskId}
            dimmed={hoveredTaskId != null && f.task !== hoveredTaskId}
          />
        ))}
      </div>
    </div>
  );
}
