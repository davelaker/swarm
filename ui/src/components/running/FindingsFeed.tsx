import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Finding } from '../../types';
import { PERSONAS } from '../../data/personas';
import { VerdictChip } from '../common/VerdictChip';
import { IconChevron } from '../common/icons';

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
                <ReactMarkdown>{content}</ReactMarkdown>
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
