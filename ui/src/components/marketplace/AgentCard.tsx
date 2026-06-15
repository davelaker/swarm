import type { MarketAgent } from '../../types';
import { AgentIcon, RoleChip } from './shared';
import { ScorecardStrip } from './Scorecard';
import type { Scorecard } from '../../hooks/useScorecards';

interface AgentCardProps {
  a: MarketAgent;
  hired: boolean;
  scorecard?: Scorecard;
  onOpen: (a: MarketAgent) => void;
}

export function AgentCard({ a, hired, scorecard, onOpen }: AgentCardProps) {
  return (
    <div className="acard" onClick={() => onOpen(a)}>
      <div className="acard-top">
        <AgentIcon name={a.name} color={a.color} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="acard-name">{a.name}</div>
          <div className="acard-sub">
            <RoleChip role={a.role} />
          </div>
        </div>
        {hired && (
          <span className="lockbadge" style={{ color: 'var(--green)' }}>
            ✓ hired
          </span>
        )}
      </div>
      <div className="acard-desc">{a.desc}</div>
      <ScorecardStrip card={scorecard} />
    </div>
  );
}
