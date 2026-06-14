import { useState, useEffect } from 'react';
import type { AgentState, RunStatus, Task } from '../../types';
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

  // Ensure every visible agent has a state object. Specialists arrive dynamically
  // via SSE (absent from the initAgents() snapshot), and a historical snapshot only
  // seeds task assignees — never `pm` — so without this fallback AgentRow would
  // dereference an undefined agent and crash the whole view.
  const agentsWithSpecialists = { ...agents };
  const blank: AgentState = {
    active: false,
    step: '',
    activeAt: null,
    verdict: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    contextPct: null,
  };
  for (const id of visibleIds) {
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
