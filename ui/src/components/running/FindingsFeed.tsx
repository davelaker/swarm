import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import type { Finding } from '../../types';
import { PERSONAS } from '../../data/personas';
import { VerdictChip } from '../common/VerdictChip';
import { IconChevron } from '../common/icons';

// ─── Custom markdown renderers ────────────────────────────────────────────────

const VERDICT_RE = /^(COMPLETE|PASS|APPROVED|FAILED?|FAIL|CHANGES_REQUESTED)\s*[:—]/i;
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
  // inline code — styled via CSS (.finding-md code)
  code({ children }) {
    return <code>{children}</code>;
  },
};

function FindingCard({ f }: { f: Finding }) {
  const [open,    setOpen]    = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const p = PERSONAS[f.agent];

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
        <VerdictChip verdict={f.verdict} />
      </div>
      <div className="finding-summary">{f.summary}</div>
      {open && (
        <div className="finding-body anim-in">
          <div className="fb-inner" style={{ padding: '10px 14px' }}>
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

export function FindingsFeed({ findings }: { findings: Finding[] }) {
  return (
    <div className="run-findings">
      <div className="panel-head">
        <span>Findings</span>
        <span className="spacer" />
        <span className="mono" style={{ fontSize: 11, color: 'var(--tx-3)', textTransform: 'none', letterSpacing: 0 }}>{findings.length} logged</span>
      </div>
      <div className="feed-scroll">
        {findings.length === 0 && <div className="feed-empty">waiting for the first finding…</div>}
        {findings.map(f => <FindingCard key={f.key} f={f} />)}
      </div>
    </div>
  );
}
