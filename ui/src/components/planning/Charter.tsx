import type { CharterData } from '../../types';
import { PERSONAS } from '../../data/personas';

function renderText(t: string) {
  const parts = t.split(/(`[^`]+`)/g);
  return parts.map((p, i) =>
    p.startsWith('`') && p.endsWith('`')
      ? <code key={i} style={{ fontFamily: 'var(--mono)', fontSize: '0.85em', background: 'var(--bg-3)', padding: '1px 5px', borderRadius: 4, color: 'var(--tx-1)' }}>{p.slice(1, -1)}</code>
      : <span key={i}>{p}</span>
  );
}

interface CharterProps {
  charter:     CharterData;
  team:        string[];
  projectName?: string; // from /state or derived from conversation
}

export function Charter({ charter, team, projectName }: CharterProps) {
  // Derive a title from the goal (first clause before a comma/period, max 40 chars)
  const title = charter.goal
    ? charter.goal.replace(/[.,].*$/, '').trim().slice(0, 48)
    : 'New project';

  const subtitle = projectName
    ? `${projectName} · charter draft`
    : 'charter draft';

  return (
    <div className="plan-left">
      <div className="panel-head">
        <span>Project Charter</span>
        <span className="spacer" />
        <span className="badge grey">DRAFT</span>
      </div>
      <div className="charter">
        <h2>{title}</h2>
        <div className="sub">{subtitle}</div>

        <div className="csec">
          <div className="csec-label"><span className="num">01</span> Goal</div>
          {charter.goal
            ? <div className="goal-text anim-in">{renderText(charter.goal)}</div>
            : <div className="empty">Listening…</div>}
        </div>

        <Section num="02" label="Constraints" items={charter.constraints} kind="con" mk="▸" />
        <Section num="03" label="Non-goals"   items={charter.nongoals}    kind="non" mk="✕" />
        <Section num="04" label="Open questions" items={charter.questions} kind="q"   mk="?" />

        <div className="csec">
          <div className="csec-label"><span className="num">05</span> Recommended team</div>
          {team.length
            ? <div className="team-chips">
                {team.map(id => (
                  <span key={id} className="agent-chip anim-in">
                    <span className="pdot" style={{ background: PERSONAS[id]?.color }} />
                    {PERSONAS[id]?.name}
                  </span>
                ))}
              </div>
            : <div className="empty">Listening…</div>}
        </div>
      </div>
    </div>
  );
}

function Section({ num, label, items, kind, mk }: { num: string; label: string; items: CharterData['constraints']; kind: string; mk: string }) {
  return (
    <div className="csec">
      <div className="csec-label"><span className="num">{num}</span> {label}</div>
      {items.length === 0
        ? <div className="empty">Listening…</div>
        : <ul>
            {items.map((it, i) => (
              <li key={i} className={`${kind} anim-in ${it.resolved ? 'resolved' : ''}`}>
                <span className="mk">{it.resolved ? '✓' : mk}</span>
                <span>{it.text}</span>
              </li>
            ))}
          </ul>}
    </div>
  );
}
