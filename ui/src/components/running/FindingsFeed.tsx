import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import type { Finding, Task } from '../../types';
import { PERSONAS } from '../../data/personas';
import { IconChevron } from '../common/icons';

// ─── Custom markdown renderers ────────────────────────────────────────────────

const SEVERITY_RE = /\b(CRITICAL|HIGH|MEDIUM|LOW)\b/i;

const mdComponents: Components = {
  // h2 = verdict headline — colour by outcome
  h2({ children }) {
    const text = String(children ?? '');
    const isPass = /^(COMPLETE|PASS|APPROVED)/i.test(text);
    const isBad  = /^(FAILED?|FAIL|CHANGES_REQUESTED)/i.test(text);
    const color  = isPass ? 'var(--green)' : isBad ? 'var(--amber)' : 'var(--tx)';
    return <h2 style={{ color }}>{children}</h2>;
  },
  // h3 = per-finding row — colour by severity keyword
  h3({ children }) {
    const text  = String(children ?? '');
    const match = text.match(SEVERITY_RE);
    const sev   = match ? match[1].toUpperCase() : null;
    const color = sev === 'CRITICAL' ? 'var(--red)'
                : sev === 'HIGH'     ? 'var(--amber)'
                : sev === 'MEDIUM'   ? 'var(--orange)'
                : sev === 'LOW'      ? 'var(--tx-2)'
                : 'var(--tx-1)';
    return <h3 style={{ color }}>{children}</h3>;
  },
  code({ children }) {
    return <code>{children}</code>;
  },
};

// ─── Derived chip ─────────────────────────────────────────────────────────────
// The task graph is the ground truth. We use task.status to override the
// agent's self-reported verdict so both panels always agree.

type ChipState = { label: string; cls: string };

function deriveChip(f: Finding, tasks: Task[]): ChipState {
  const task = tasks.find(t => t.id === f.task);

  if (task?.status === 'blocked') {
    return { label: 'BLOCKED', cls: 'changes' };
  }

  // A t_fix_* task that is pending/in_progress means the coder is addressing
  // issues found in this task's review — surface that rather than 'COMPLETE'.
  const fixing = tasks.find(
    t => t.id === `t_fix_${f.task}` &&
         (t.status === 'pending' || t.status === 'in_progress'),
  );
  if (fixing) return { label: 'FIXING…', cls: 'changes' };

  // Normal path — show the agent's verdict
  const MAP: Record<string, ChipState> = {
    complete: { label: 'COMPLETE',          cls: 'complete' },
    pass:     { label: 'PASS',              cls: 'pass'     },
    changes:  { label: 'CHANGES',           cls: 'changes'  },
    fail:     { label: 'FAIL',              cls: 'fail'     },
  };
  return MAP[f.verdict] ?? { label: f.verdict.toUpperCase(), cls: f.verdict };
}

// ─── Summary sanitisation ─────────────────────────────────────────────────────
// If enrichment hasn't run yet the summary falls back to the file path.
// Show a cleaner placeholder in that case.

function cleanSummary(summary: string): string {
  if (!summary) return '';
  // Looks like a path (absolute or relative ending in .md)
  if (summary.endsWith('.md') || summary.startsWith('/')) return '';
  return summary;
}

// ─── Time formatting ─────────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return `${h12}:${m}${ampm}`;
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function FindingCard({ f, tasks }: { f: Finding; tasks: Task[] }) {
  const [open,    setOpen]    = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const p    = PERSONAS[f.agent];
  const chip = deriveChip(f, tasks);
  const sum  = cleanSummary(f.summary);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && content === null && f.path && !loading) {
      setLoading(true);
      fetch(`/findings?path=${encodeURIComponent(f.path)}`)
        .then(r => r.text())
        .then(text => {
          // Strip YAML frontmatter — show only the markdown body
          const body = text.replace(/^---[\r\n][\s\S]*?[\r\n]---[\r\n]?/, '').trim();
          setContent(body || '*(no body)*');
        })
        .catch(() => setContent('*(could not load finding)*'))
        .finally(() => setLoading(false));
    }
  };

  return (
    <div className="finding">
      <div className="finding-head" onClick={toggle} style={{ cursor: 'pointer' }}>
        <span className={`caret ${open ? 'open' : ''}`}><IconChevron /></span>
        <span className="finding-agent">
          <span className="pdot" style={{ background: p?.color }} />
          {p?.name}
        </span>
        <span className="finding-tid">{f.task}</span>
        <span style={{ flex: 1 }} />
        {f.ts && (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--tx-3)',
            marginRight: 8, flexShrink: 0,
          }}>
            {fmtTime(f.ts)}
          </span>
        )}
        <span className={`vchip ${chip.cls}`}>{chip.label}</span>
      </div>
      {sum && !open && <div className="finding-summary">{sum}</div>}
      {open && (
        <div className="finding-body anim-in">
          <div className="fb-inner">
            {loading && (
              <span style={{ color: 'var(--tx-3)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                loading…
              </span>
            )}
            {!loading && content && (
              <div className="finding-md">
                <ReactMarkdown components={mdComponents}>{content}</ReactMarkdown>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Feed ─────────────────────────────────────────────────────────────────────

export function FindingsFeed({ findings, tasks }: { findings: Finding[]; tasks: Task[] }) {
  return (
    <div className="run-findings">
      <div className="panel-head">
        <span>Findings</span>
        <span className="spacer" />
        <span className="mono" style={{ fontSize: 11, color: 'var(--tx-3)', textTransform: 'none', letterSpacing: 0 }}>
          {findings.length} logged
        </span>
      </div>
      <div className="feed-scroll">
        {findings.length === 0 && <div className="feed-empty">waiting for the first finding…</div>}
        {findings.map(f => <FindingCard key={f.key} f={f} tasks={tasks} />)}
      </div>
    </div>
  );
}
