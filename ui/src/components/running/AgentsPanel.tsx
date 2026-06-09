import { useState, useEffect } from 'react';
import type { AgentState } from '../../types';
import { PERSONAS } from '../../data/personas';
import { VerdictChip } from '../common/VerdictChip';

const ORDER = ['pm', 'coder', 'tester', 'security', 'reviewer', 'negotiator'];
const IDLE_LABEL: Record<string, string> = { pm: 'refereeing', negotiator: 'no conflicts to arbitrate' };

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

function AgentRow({ id, a }: { id: string; a: AgentState }) {
  const p          = PERSONAS[id];
  const now        = useNow(a.active);
  const elapsed    = a.active && a.activeAt ? now - a.activeAt : 0;
  const hasMetrics = a.costUsd != null && a.costUsd > 0;
  const hasTokens  = a.inputTokens != null;

  return (
    <div className="agent-row">
      <span
        className={`agent-dot ${a.active ? 'active' : 'idle'}`}
        style={{ background: a.active ? p.color : 'transparent', color: p.color }}
      />
      <div className="agent-body">
        <div className="agent-top">
          <span className="agent-name">{p.name}</span>
          <span className="agent-meta">
            {a.active
              ? <span className="agent-step" style={{ color: p.color }}>
                  {a.step}<span className="cursor" style={{ color: p.color }} />
                  {elapsed >= 3000 && (
                    <span style={{ opacity: 0.5, marginLeft: 6, fontStyle: 'normal' }}>
                      {fmtElapsed(elapsed)}
                    </span>
                  )}
                </span>
              : a.verdict
                ? <VerdictChip verdict={a.verdict} />
                : <span className="agent-sub mono">{IDLE_LABEL[id] ?? 'idle'}</span>}
          </span>
        </div>
        {!a.active && hasMetrics && (
          <div className="agent-metrics">
            {hasTokens && (
              <span>
                {fmtTokens(a.inputTokens!)} in · {fmtTokens(a.outputTokens ?? 0)} out
                {a.contextPct != null && (
                  <span className="ctx-pct"> ({a.contextPct}% ctx)</span>
                )}
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

export function AgentsPanel({ agents }: { agents: Record<string, AgentState> }) {
  return (
    <div className="run-agents">
      <div className="panel-head"><span>Agents</span></div>
      {ORDER.map(id => <AgentRow key={id} id={id} a={agents[id]} />)}
    </div>
  );
}
