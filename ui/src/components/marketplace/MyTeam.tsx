import type { HiredAgent } from '../../types';
import { PERSONAS } from '../../data/personas';
import { AGENT_BY_ID, BUILTINS, UX_UPGRADE } from '../../data/marketAgents';
import { AgentIcon, RoleChip, LockBadge, rgba } from './shared';
import { ToolGlyph } from '../common/ToolIcon';
import { Switch } from '../common/Switch';
import { IconLock, IconTrash } from '../common/icons';
import type { Sensitivity } from '../../types';

interface MyTeamProps {
  team: HiredAgent[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onUpgrade: (id: string) => void;
}

export function MyTeam({ team, onToggle, onRemove, onUpgrade }: MyTeamProps) {
  const EXTRA_TOOLS: Record<string, { sens: Sensitivity }> = {
    [UX_UPGRADE.newTool.name]: { sens: UX_UPGRADE.newTool.sens },
  };

  return (
    <div className="team-wrap">
      {/* Built-ins */}
      <div className="team-group">
        <div className="team-group-h"><IconLock size={11} /> Built-ins · always on the roster</div>
        {BUILTINS.map(b => {
          const p = PERSONAS[b.id];
          return (
            <div className="trow" key={b.id}>
              <div className="trow-icon" style={{ color: p.color, background: rgba(p.color, 0.1), borderColor: rgba(p.color, 0.3) }}>
                {b.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
              </div>
              <div className="trow-main">
                <div className="trow-name">{b.name} <LockBadge><IconLock size={9} /> built-in</LockBadge></div>
                <div className="trow-sub"><RoleChip role={b.role} /><span>every tier</span></div>
              </div>
              <div className="trow-tools">
                {b.tools.map((t, i) => (
                  <span key={i} className={`tool-i ${t.sens}`}><ToolGlyph sens={t.sens} size={12} /></span>
                ))}
              </div>
              <div className="trow-actions"><LockBadge>non-removable</LockBadge></div>
            </div>
          );
        })}
      </div>

      {/* Hired */}
      <div className="team-group">
        <div className="team-group-h">Hired · {team.length}</div>
        {team.length === 0 && (
          <div style={{ color: 'var(--tx-3)', fontSize: 12.5, fontFamily: 'var(--mono)', padding: '10px 2px' }}>
            No hired agents yet. Browse the marketplace to add specialists.
          </div>
        )}
        {team.map(h => {
          const a = AGENT_BY_ID[h.id];
          if (!a) return null;
          return (
            <div className="trow" key={h.id} style={{ opacity: h.enabled ? 1 : 0.6 }}>
              <AgentIcon name={a.name} color={a.color} size={38} />
              <div className="trow-main">
                <div className="trow-name">
                  {a.name}
                  <LockBadge>v{h.version}</LockBadge>
                  {h.upgradeAvailable && (
                    <span className="upgrade-badge" onClick={() => onUpgrade(h.id)}>
                      ↑ Upgrade to {UX_UPGRADE.to}
                    </span>
                  )}
                </div>
                <div className="trow-sub">
                  <RoleChip role={a.role} />
                  <span className="mono" style={{ color: 'var(--tx-3)' }}>{h.model}</span>
                  {h.tiers.map(t => <span key={t} className="tierpill">{t}</span>)}
                </div>
              </div>
              <div className="trow-tools">
                {h.grantedTools.length === 0
                  ? <span style={{ fontSize: 11, color: 'var(--tx-3)', fontFamily: 'var(--mono)' }}>no tools</span>
                  : h.grantedTools.map(tn => {
                      const tt = a.tools.find(x => x.name === tn) || EXTRA_TOOLS[tn];
                      if (!tt) return null;
                      return <span key={tn} className={`tool-i ${tt.sens}`} title={tn}><ToolGlyph sens={tt.sens} size={12} /></span>;
                    })}
              </div>
              <div className="trow-actions">
                <Switch on={h.enabled} onToggle={() => onToggle(h.id)} />
                <button className="icon-btn danger" onClick={() => onRemove(h.id)} title="Remove"><IconTrash /></button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
