import { useState } from 'react';
import type { Finding } from '../../types';
import { PERSONAS } from '../../data/personas';
import { FINDINGS_FULL } from '../../data/findingsFull';
import { VerdictChip } from '../common/VerdictChip';
import { IconFile, IconChevron } from '../common/icons';

function FindingCard({ f }: { f: Finding }) {
  const [open, setOpen] = useState(false);
  const p    = PERSONAS[f.agent];
  const full = FINDINGS_FULL[f.key];

  return (
    <div className="finding">
      <div className="finding-head" onClick={() => setOpen(o => !o)}>
        <span className={`caret ${open ? 'open' : ''}`}><IconChevron /></span>
        <span className="finding-agent">
          <span className="pdot" style={{ background: p?.color }} />
          {p?.name}
        </span>
        <span className="finding-tid">{f.task}</span>
        <VerdictChip verdict={f.verdict} />
      </div>
      <div className="finding-summary">{f.summary}</div>
      {open && full && (
        <div className="finding-body anim-in">
          <div className="fb-inner">
            {full.body.map((b, i) => {
              if (b.type === 'files') return (
                <div className="fb-row" key={i}>
                  <div className="fb-label">Files changed</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {b.items!.map((f2, j) => (
                      <span className="file-tag" key={j}><IconFile /> {f2}</span>
                    ))}
                  </div>
                </div>
              );
              if (b.type === 'note') return (
                <div className="fb-row" key={i}>
                  <div className="fb-label">{b.label}</div>
                  <div>{b.text}</div>
                </div>
              );
              if (b.type === 'code') return (
                <div className="fb-row" key={i}>
                  <div className="fb-label">{b.label}</div>
                  <div className="code-block">
                    {b.lines!.map((l, j) => (
                      <div key={j} className={l.t}>{l.t === 'add' ? '+ ' : l.t === 'del' ? '- ' : '  '}{l.s}</div>
                    ))}
                  </div>
                </div>
              );
              return null;
            })}
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
