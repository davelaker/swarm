import type { AgentState } from '../../types';
import { PERSONAS } from '../../data/personas';
import { VerdictChip } from '../common/VerdictChip';

const ORDER = ['pm', 'coder', 'tester', 'security', 'negotiator'];
const IDLE_LABEL: Record<string, string> = { pm: 'refereeing', negotiator: 'no conflicts to arbitrate' };

export function AgentsPanel({ agents }: { agents: Record<string, AgentState> }) {
  return (
    <div className="run-agents">
      <div className="panel-head"><span>Agents</span></div>
      {ORDER.map(id => {
        const a = agents[id]; const p = PERSONAS[id];
        return (
          <div className="agent-row" key={id}>
            <span
              className={`agent-dot ${a.active ? 'active' : 'idle'}`}
              style={{ background: a.active ? p.color : 'transparent', color: p.color }}
            />
            <span className="agent-name">{p.name}</span>
            <span className="agent-meta">
              {a.active
                ? <span className="agent-step" style={{ color: p.color }}>
                    {a.step}<span className="cursor" style={{ color: p.color }} />
                  </span>
                : a.verdict
                  ? <VerdictChip verdict={a.verdict} />
                  : <span className="agent-sub mono">{IDLE_LABEL[id] ?? 'idle'}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
