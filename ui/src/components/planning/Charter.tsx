import { useState } from 'react';
import type { CharterData } from '../../types';
import type { ContextFile } from '../../hooks/useContextFiles';
import type { TaskGraphEntry } from '../../App';
import { resolveAgentPersona } from '../../data/personas';
import { modelMeta } from '../../data/models';
import { ContextFiles } from './ContextFiles';

function renderText(t: string) {
  const parts = t.split(/(`[^`]+`)/g);
  return parts.map((p, i) =>
    p.startsWith('`') && p.endsWith('`') ? (
      <code
        key={i}
        style={{
          fontFamily: 'var(--mono)',
          fontSize: '0.85em',
          background: 'var(--bg-3)',
          padding: '1px 5px',
          borderRadius: 4,
          color: 'var(--tx-1)',
        }}
      >
        {p.slice(1, -1)}
      </code>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

interface CharterProps {
  charter: CharterData;
  team: string[];
  taskGraph?: TaskGraphEntry[]; // per-task model assignments the PM chose
  phase: string; // planning phase — controls empty-state copy
  branchMode?: 'branch' | 'main';
  branchName?: string; // user-set slug (no swarm/ prefix)
  onBranchNameChange?: (slug: string) => void;
  onConstraintsChange?: (items: CharterData['constraints']) => void;
  onNongoalsChange?: (items: CharterData['nongoals']) => void;
  projectName?: string;
  projectMd: ContextFile | null;
  contextFiles: ContextFile[];
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50)
    .replace(/^-+|-+$/g, '');
}

export function Charter({
  charter,
  team,
  taskGraph,
  phase,
  branchMode,
  branchName,
  onBranchNameChange,
  onConstraintsChange,
  onNongoalsChange,
  projectName,
  projectMd,
  contextFiles,
}: CharterProps) {
  const title = charter.goal
    ? charter.goal
        .replace(/[.,].*$/, '')
        .trim()
        .slice(0, 48)
    : 'New project';

  const subtitle = projectName ? `${projectName} · charter draft` : 'charter draft';

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
          {charter.goal ? (
            <div className="goal-text anim-in">{renderText(charter.goal)}</div>
          ) : (
            <div className="empty">Waiting on PM…</div>
          )}
        </div>

        <Section
          num="02"
          label="Constraints"
          items={charter.constraints}
          kind="con"
          mk="▸"
          optional
          active={active}
          onChange={onConstraintsChange}
        />
        <Section
          num="03"
          label="Non-goals"
          items={charter.nongoals}
          kind="non"
          mk="✕"
          optional
          active={active}
          onChange={onNongoalsChange}
        />
        <Section
          num="04"
          label="Open questions"
          items={charter.questions}
          kind="q"
          mk="?"
          optional
          active={active}
        />

        <div className="csec">
          <div className="csec-label">
            <span className="num">05</span> Recommended team
            <span className="field-req">required</span>
          </div>
          {team.length ? (
            <div className="team-chips">
              {team.map(id => {
                const p = resolveAgentPersona(id);
                // Distinct models the PM assigned to this agent's task(s).
                const models = [
                  ...new Set(
                    (taskGraph ?? [])
                      .filter(t => t.assignee === id && t.model)
                      .map(t => t.model as string),
                  ),
                ];
                return (
                  <span key={id} className="agent-chip anim-in">
                    <span className="pdot" style={{ background: p.color }} />
                    {p.name}
                    {models.map(m => {
                      const meta = modelMeta(m);
                      return meta ? (
                        <span
                          key={m}
                          className="model-badge"
                          style={{ color: meta.color, borderColor: meta.color }}
                          title={`Runs on ${meta.label}`}
                        >
                          {meta.label}
                        </span>
                      ) : null;
                    })}
                  </span>
                );
              })}
            </div>
          ) : (
            <div className="empty">Waiting on PM…</div>
          )}
        </div>

        <div className="csec">
          <div className="csec-label">
            <span className="num">06</span> Branch mode
            <span className="field-opt">optional</span>
          </div>
          {branchMode ? (
            <div className="branch-mode-row anim-in">
              {branchMode === 'branch' ? (
                <>
                  <div className="branch-name-field">
                    <span className="branch-prefix">swarm /</span>
                    <input
                      className="branch-slug-input"
                      value={branchName ?? ''}
                      onChange={e =>
                        onBranchNameChange?.(
                          e.target.value
                            .toLowerCase()
                            .replace(/[^a-z0-9-]/g, '-')
                            .replace(/-+/g, '-'),
                        )
                      }
                      placeholder={slugify(charter.goal) || 'feature-name'}
                      spellCheck={false}
                    />
                  </div>
                  <span className="branch-hint">
                    Feature branch — created when you Execute, deleted if no changes are made.
                  </span>
                </>
              ) : (
                <>
                  <span className="branch-mode-chip" data-mode="main">
                    ⎇ Committing to main
                  </span>
                  <span className="branch-hint">
                    Changes go directly to the default branch — ensure CI is in place.
                  </span>
                </>
              )}
            </div>
          ) : (
            <div className="empty">
              {active ? 'Not specified — ask the PM to set a branch mode' : 'Waiting on PM…'}
            </div>
          )}
        </div>

        <ContextFiles projectMd={projectMd} contextFiles={contextFiles} />
      </div>
    </div>
  );
}

// A charter list item whose text becomes editable on click (Enter/blur commits,
// Escape reverts; clearing it removes the item).
function EditableText({ value, onCommit }: { value: string; onCommit: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (editing) {
    return (
      <input
        className="charter-edit-input"
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            onCommit(draft);
            setEditing(false);
          } else if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        onBlur={() => {
          onCommit(draft);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <span
      className="editable-text"
      title="Click to edit"
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
    >
      {value}
    </span>
  );
}

// The editable rendering of a charter list — used for constraints/non-goals so the
// user can tweak them directly. Questions stay read-only (PM-driven).
function EditableList({
  items,
  kind,
  mk,
  label,
  onChange,
}: {
  items: CharterData['constraints'];
  kind: string;
  mk: string;
  label: string;
  onChange: (items: CharterData['constraints']) => void;
}) {
  const [adding, setAdding] = useState('');

  const commitEdit = (i: number, text: string) => {
    const next = items.slice();
    if (!text.trim()) {
      next.splice(i, 1);
    } else {
      next[i] = { ...next[i], text: text.trim() };
    }
    onChange(next);
  };
  const remove = (i: number) => {
    const next = items.slice();
    next.splice(i, 1);
    onChange(next);
  };
  const add = () => {
    const text = adding.trim();
    if (text) {
      onChange([...items, { text }]);
      setAdding('');
    }
  };

  return (
    <ul className="editable-list">
      {items.map((it, i) => (
        <li key={i} className={`${kind} ${it.resolved ? 'resolved' : ''}`}>
          <span className="mk">{it.resolved ? '✓' : mk}</span>
          <EditableText value={it.text} onCommit={t => commitEdit(i, t)} />
          <button className="row-remove" title="Remove" onClick={() => remove(i)}>
            ×
          </button>
        </li>
      ))}
      <li className={`${kind} editable-add`}>
        <span className="mk" style={{ opacity: 0.4 }}>
          +
        </span>
        <input
          className="charter-edit-input"
          value={adding}
          placeholder={`Add ${label.toLowerCase()}…`}
          onChange={e => setAdding(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              add();
            }
          }}
          onBlur={add}
        />
      </li>
    </ul>
  );
}

function Section({
  num,
  label,
  items,
  kind,
  mk,
  optional,
  active,
  onChange,
}: {
  num: string;
  label: string;
  items: CharterData['constraints'];
  kind: string;
  mk: string;
  optional?: boolean;
  active?: boolean;
  onChange?: (items: CharterData['constraints']) => void;
}) {
  return (
    <div className="csec">
      <div className="csec-label">
        <span className="num">{num}</span> {label}
        {optional && <span className="field-opt">optional</span>}
      </div>
      {onChange ? (
        <EditableList items={items} kind={kind} mk={mk} label={label} onChange={onChange} />
      ) : items.length === 0 ? (
        <div className="empty">{active && optional ? 'Not specified' : 'Waiting on PM…'}</div>
      ) : (
        <ul>
          {items.map((it, i) => (
            <li key={i} className={`${kind} anim-in ${it.resolved ? 'resolved' : ''}`}>
              <span className="mk">{it.resolved ? '✓' : mk}</span>
              <span>{it.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
