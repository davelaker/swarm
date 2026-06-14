import { useState, useEffect, useRef } from 'react';
import type { ActivityEntry, AgentState, RunStatus, Task } from '../../types';
import { resolveAgentPersona } from '../../data/personas';
import { VerdictChip } from '../common/VerdictChip';

const BUILTIN_ORDER = ['pm', 'coder', 'tester', 'security', 'reviewer', 'negotiator'];

// Idle labels while a run is active
const IDLE_LABEL: Record<string, string> = {
  pm: 'refereeing',
  negotiator: 'no conflicts to arbitrate',
};
// Idle labels once the run has finished (PM gets nothing — "refereeing" is stale)
const DONE_LABEL: Record<string, string> = {
  pm: '',
};

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// One line in the transcript: a thinking block (dim, italic, labelled) or a
// tool-call step (coloured caret + the action text). Both truncate to one line
// with the full text on hover.
function ActivityRow({ entry, color }: { entry: ActivityEntry; color: string }) {
  const clamp = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  };
  if (entry.kind === 'thinking') {
    return (
      <div
        title={entry.text}
        style={{ display: 'flex', gap: 6, fontSize: 11, lineHeight: 1.6, padding: '1px 0' }}
      >
        <span style={{ opacity: 0.55, flexShrink: 0 }}>Thinking</span>
        <span style={{ opacity: 0.5, fontStyle: 'italic', ...clamp }}>{entry.text}</span>
      </div>
    );
  }
  return (
    <div
      title={entry.text}
      style={{ display: 'flex', gap: 6, fontSize: 11, lineHeight: 1.6, padding: '1px 0' }}
    >
      <span style={{ color, flexShrink: 0 }}>›</span>
      <span style={{ opacity: 0.85, ...clamp }}>{entry.text}</span>
    </div>
  );
}

// Collapsible activity transcript for one agent. Auto-expands while the agent is
// active and auto-collapses to a one-line summary when it finishes; clicking the
// summary pins the user's choice either way so a finished log can be re-opened.
function ActivityLog({ a, color }: { a: AgentState; color: string }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? a.active;
  const scrollRef = useRef<HTMLDivElement>(null);

  const count = a.activity.length;
  const thoughts = a.activity.filter(e => e.kind === 'thinking').length;
  const steps = count - thoughts;
  const summary =
    [
      steps ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : '',
      thoughts ? `${thoughts} ${thoughts === 1 ? 'thought' : 'thoughts'}` : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'activity';

  useEffect(() => {
    if (expanded && a.active && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [count, expanded, a.active]);

  return (
    <div style={{ marginTop: 4 }}>
      <button
        onClick={() => setOverride(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          background: 'transparent',
          border: 'none',
          padding: '1px 0',
          cursor: 'pointer',
          fontSize: 11,
          opacity: 0.6,
          color: 'inherit',
        }}
      >
        <span style={{ fontSize: 9 }}>{expanded ? '▾' : '▸'}</span>
        <span>{summary}</span>
      </button>
      {expanded && (
        <div
          ref={scrollRef}
          style={{
            maxHeight: 220,
            overflowY: 'auto',
            marginTop: 2,
            paddingLeft: 13,
            borderLeft: '1px solid var(--bg-3)',
          }}
        >
          {a.activity.map((entry, i) => (
            <ActivityRow key={i} entry={entry} color={color} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRow({
  id,
  a,
  idleLabel,
  tasks,
  dimmed,
  highlighted,
}: {
  id: string;
  a: AgentState;
  idleLabel: string;
  tasks: Task[];
  dimmed?: boolean;
  highlighted?: boolean;
}) {
  const p = resolveAgentPersona(id);
  const now = useNow(a.active);
  const elapsed = a.active && a.activeAt ? now - a.activeAt : 0;
  const hasMetrics = a.costUsd != null && a.costUsd > 0;
  const hasTokens = a.inputTokens != null;

  // Show BLOCKED only if the agent's MOST RECENT task is blocked.
  // Checking any task (with .some) is wrong: if the reviewer ran t4 (blocked),
  // then re-ran t_chk_t4 (done/pass), "any blocked" would still show BLOCKED
  // even though the agent's last action passed. We want the current state.
  const agentTasks = tasks.filter(t => t.assignee === id);
  const lastTask = agentTasks.length > 0 ? agentTasks[agentTasks.length - 1] : null;
  const isBlocked = !a.active && lastTask?.status === 'blocked';

  return (
    <div
      className="agent-row"
      style={{
        opacity: dimmed ? 0.18 : 1,
        transition: 'opacity 0.15s, background 0.15s',
        background: highlighted ? 'rgba(77,141,244,0.07)' : 'transparent',
        borderRadius: highlighted ? 6 : 0,
      }}
    >
      <span
        className={`agent-dot ${a.active ? 'active' : 'idle'}`}
        style={{ background: a.active ? p.color : 'transparent', color: p.color }}
      />
      <div className="agent-body">
        <div className="agent-top">
          <span className="agent-name">{p.name}</span>
          <span className="agent-meta">
            {a.active ? (
              <span className="agent-step" style={{ color: p.color }}>
                {a.step}
                <span className="cursor" style={{ color: p.color }} />
                {elapsed >= 3000 && (
                  <span style={{ opacity: 0.5, marginLeft: 6, fontStyle: 'normal' }}>
                    {fmtElapsed(elapsed)}
                  </span>
                )}
              </span>
            ) : isBlocked ? (
              <span className="vchip changes">CHANGES REQ</span>
            ) : a.verdict ? (
              <VerdictChip verdict={a.verdict} />
            ) : idleLabel ? (
              <span className="agent-sub mono">{idleLabel}</span>
            ) : null}
          </span>
        </div>
        {a.activity.length > 0 && <ActivityLog a={a} color={p.color} />}
        {!a.active && hasMetrics && (
          <div className="agent-metrics">
            {hasTokens && (
              <span>
                {fmtTokens(a.inputTokens!)} in · {fmtTokens(a.outputTokens ?? 0)} out
                {a.contextPct != null && <span className="ctx-pct"> ({a.contextPct}% ctx)</span>}
              </span>
            )}
            {hasTokens && <span className="metrics-sep">·</span>}
            <span>${a.costUsd!.toFixed(4)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function AgentsPanel({
  agents,
  status,
  tasks,
  hoveredTaskId,
}: {
  agents: Record<string, AgentState>;
  status: RunStatus;
  tasks: Task[];
  hoveredTaskId?: string | null;
}) {
  const idleLabel = (id: string) => {
    const map = status === 'done' || status === 'aborted' ? DONE_LABEL : IDLE_LABEL;
    return map[id] ?? 'idle';
  };
  const hoveredAssignee = hoveredTaskId
    ? (tasks.find(t => t.id === hoveredTaskId)?.assignee ?? null)
    : null;

  // Only show agents that are actually assigned tasks in this run (plus pm, which
  // is always the orchestrator). Preserve the canonical order for builtins;
  // append any specialist agents (marketplace hires) after.
  const assignedIds = new Set(['pm', ...tasks.map(t => t.assignee)]);
  const builtinIds = BUILTIN_ORDER.filter(id => assignedIds.has(id));
  const specialistIds = [...assignedIds].filter(id => !BUILTIN_ORDER.includes(id));
  const visibleIds = [...builtinIds, ...specialistIds];

  // Ensure agents map has entries for any specialist agents (created dynamically
  // via SSE events — they won't be in the initAgents() snapshot).
  const agentsWithSpecialists = { ...agents };
  const blank = {
    active: false,
    step: '',
    activity: [],
    activeAt: null,
    verdict: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    contextPct: null,
  };
  for (const id of specialistIds) {
    if (!agentsWithSpecialists[id]) agentsWithSpecialists[id] = blank;
  }

  return (
    <div className="run-agents">
      <div className="panel-head">
        <span>Agents</span>
      </div>
      {visibleIds.map(id => (
        <AgentRow
          key={id}
          id={id}
          a={agentsWithSpecialists[id]}
          idleLabel={idleLabel(id)}
          tasks={tasks}
          highlighted={hoveredAssignee === id}
          dimmed={hoveredAssignee != null && hoveredAssignee !== id}
        />
      ))}
    </div>
  );
}
