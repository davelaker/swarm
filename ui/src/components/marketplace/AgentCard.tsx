import type { MarketAgent } from '../../types';
import { AgentIcon, ProvBadge, RoleChip, StarRating, ToolIconRow } from './shared';

interface AgentCardProps {
  a: MarketAgent;
  hired: boolean;
  onOpen: (a: MarketAgent) => void;
}

export function AgentCard({ a, hired, onOpen }: AgentCardProps) {
  return (
    <div className="acard" onClick={() => onOpen(a)}>
      <div className="acard-top">
        <AgentIcon name={a.name} color={a.color} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="acard-name">{a.name}</div>
          <div className="acard-sub">
            <RoleChip role={a.role} />
            <ProvBadge prov={a.prov} />
          </div>
        </div>
        {hired && <span className="lockbadge" style={{ color: 'var(--green)' }}>✓ hired</span>}
      </div>
      <div className="acard-desc">{a.desc}</div>
      <div className="acard-foot">
        <StarRating rating={a.rating} />
        <ToolIconRow tools={a.tools} />
      </div>
    </div>
  );
}
