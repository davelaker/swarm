import type { CharterData } from '../../types';
import type { ContextFile } from '../../hooks/useContextFiles';
import { PERSONAS } from '../../data/personas';
import { ContextFiles } from './ContextFiles';

function renderText(t: string) {
  const parts = t.split(/(`[^`]+`)/g);
  return parts.map((p, i) =>
    p.startsWith('`') && p.endsWith('`')
      ? <code key={i} style={{ fontFamily: 'var(--mono)', fontSize: '0.85em', background: 'var(--bg-3)', padding: '1px 5px', borderRadius: 4, color: 'var(--tx-1)' }}>{p.slice(1, -1)}</code>
      : <span key={i}>{p}</span>
  );
}

interface CharterProps {
  charter:      CharterData;
  team:         string[];
  phase:        string;        // planning phase — controls empty-state copy
  projectName?: string;
  projectMd:    ContextFile | null;
  contextFiles: ContextFile[];
  onAskPm:      (message: string) => void;
}

export function Charter({ charter, team, phase, projectName, projectMd, contextFiles, onAskPm }: CharterProps) {
  const title = charter.goal
    ? charter.goal.replace(/[.,].*$/, '').trim().slice(0, 48)
    : 'New project';

  const subtitle = projectName
    ? `${projectName} · charter draft`
    : 'charter draft';

  // Once the PM has started engaging (past 'goal' phase), empty optional
  // fields show "not specified" rather than "listening" so users know they're
  // optional, not missing data.
  const active = phase !== 'start' && phase !== 'goal';

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
          <div className="csec-label">
            <span className="num">01</span> Goal
            <span className="field-req">required</span>
          </div>
          {charter.goal
            ? <div className="goal-text anim-in">{renderText(charter.goal)}</div>
            : <div className="empty">Listening…</div>}
        </div>

        <Section num="02" label="Constraints"    items={charter.constraints} kind="con" mk="▸" optional active={active} />
        <Section num="03" label="Non-goals"      items={charter.nongoals}    kind="non" mk="✕" optional active={active} />
        <Section num="04" label="Open questions" items={charter.questions}   kind="q"   mk="?"           active={active} />

        <div className="csec">
          <div className="csec-label">
            <span className="num">05</span> Recommended team
            <span className="field-req">required</span>
          </div>
          {team.length
            ? <div className="team-chips">
                {team.map(id => (
                  <span key={id} className="agent-chip anim-in">
                    <span className="pdot" style={{ background: PERSONAS[id]?.color }} />
                    {PERSONAS[id]?.name ?? id}
                  </span>
                ))}
              </div>
            : <div className="empty">{active ? 'PM will assign when ready' : 'Listening…'}</div>}
        </div>

        <ContextFiles
          projectMd={projectMd}
          contextFiles={contextFiles}
          onAskPm={onAskPm}
        />
      </div>
    </div>
  );
}

function Section({ num, label, items, kind, mk, optional, active }: {
  num: string; label: string; items: CharterData['constraints'];
  kind: string; mk: string; optional?: boolean; active?: boolean;
}) {
  return (
    <div className="csec">
      <div className="csec-label">
        <span className="num">{num}</span> {label}
        {optional && <span className="field-opt">optional</span>}
      </div>
      {items.length === 0
        ? <div className="empty">{active && optional ? 'Not specified' : 'Listening…'}</div>
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
