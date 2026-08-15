import type { HiredAgent } from '../../types';
import type { RosterStaleness } from '../../data/rosterSync';
import { PERSONAS } from '../../data/personas';
import { AGENT_BY_ID, BUILTINS } from '../../data/marketAgents';
import { AgentIcon, RoleChip, LockBadge, rgba } from './shared';
import { ScorecardInline } from './Scorecard';
import type { Scorecard } from '../../hooks/useScorecards';
import { ToolGlyph } from '../common/ToolIcon';
import { CONNECTOR_BY_ID } from '../../data/connectors';
import { Switch } from '../common/Switch';
import { IconLock, IconTrash } from '../common/icons';
import type { Sensitivity } from '../../types';

interface MyTeamProps {
  team: HiredAgent[];
  projectName?: string;
  scorecards: Record<string, Scorecard>;
  staleness: Record<string, RosterStaleness>;
  onSyncRoster: () => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onViewAgent: (id: string) => void;
  onBrowse: () => void;
}

export function MyTeam({
  team,
  projectName,
  scorecards,
  staleness,
  onSyncRoster,
  onToggle,
  onRemove,
  onViewAgent,
  onBrowse,
}: MyTeamProps) {
  const staleEntries = team.filter(h => staleness[h.id]?.stale);
  return (
    <div className="team-wrap">
      {/* Catalog-sync banner: hired prompts/grants are copies frozen at hire
          time — offer a one-click refresh when the catalog has moved on.
          Sync only narrows permissions; new tools still need a manual grant. */}
      {staleEntries.length > 0 && (
        <div className="roster-sync-banner">
          <span>
            Catalog updated — {staleEntries.length} hired specialist
            {staleEntries.length > 1 ? 's are' : ' is'} running{' '}
            {staleEntries.length > 1 ? 'outdated copies' : 'an outdated copy'}:{' '}
            {staleEntries.map(h => `${AGENT_BY_ID[h.id]?.name ?? h.id} (v${h.version})`).join(', ')}
          </span>
          <button
            className="btn primary"
            onClick={onSyncRoster}
            title={staleEntries
              .flatMap(h => (staleness[h.id]?.reasons ?? []).map(r => `${h.id}: ${r}`))
              .join('\n')}
          >
            ↻ Sync to catalog
          </button>
        </div>
      )}
      {/* Built-ins */}
      <div className="team-group">
        <div className="team-group-h">
          <IconLock size={11} /> Built-ins · always on the roster
        </div>
        {BUILTINS.map(b => {
          const p = PERSONAS[b.id];
          return (
            <div
              className="trow clickable"
              key={b.id}
              onClick={() => onViewAgent(b.id)}
              title="Click to view prompt"
            >
              <div
                className="trow-icon"
                style={{
                  color: p.color,
                  background: rgba(p.color, 0.1),
                  borderColor: rgba(p.color, 0.3),
                }}
              >
                {b.name
                  .split(' ')
                  .map(w => w[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase()}
              </div>
              <div className="trow-main">
                <div className="trow-name">
                  {b.name}{' '}
                  <LockBadge>
                    <IconLock size={9} /> built-in
                  </LockBadge>
                </div>
                <div className="trow-sub">
                  <RoleChip role={b.role} />
                  <ScorecardInline card={scorecards[b.id]} />
                </div>
              </div>
              <div className="trow-tools">
                {b.tools.map((t, i) => (
                  <span key={i} className={`tool-i ${t.sens}`}>
                    <ToolGlyph sens={t.sens} size={12} />
                  </span>
                ))}
              </div>
              <div className="trow-actions">
                <LockBadge>non-removable</LockBadge>
              </div>
            </div>
          );
        })}
      </div>

      {/* Hired */}
      <div className="team-group">
        <div
          className="team-group-h"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <span>
            Hired{projectName ? ` for ${projectName}` : ''} · {team.length}
          </span>
          {team.length > 0 && (
            <button
              onClick={onBrowse}
              style={{
                fontSize: 11.5,
                color: 'var(--tx-2)',
                fontFamily: 'var(--mono)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 6px',
                borderRadius: 4,
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--tx)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--tx-2)')}
            >
              + Browse agents
            </button>
          )}
        </div>

        {team.length === 0 && (
          <div
            style={{
              padding: '24px 16px',
              textAlign: 'center',
              border: '1px dashed var(--border-1)',
              borderRadius: 'var(--r-lg)',
              marginBottom: 10,
            }}
          >
            <div style={{ fontSize: 13, color: 'var(--tx-2)', marginBottom: 12 }}>
              No hired agents yet. Add specialists to extend what your team can do.
            </div>
            <button className="btn primary" onClick={onBrowse}>
              Browse agents →
            </button>
          </div>
        )}

        {team.map(h => {
          const a = AGENT_BY_ID[h.id];
          if (!a) return null;
          return (
            <div
              className="trow clickable"
              key={h.id}
              style={{ opacity: h.enabled ? 1 : 0.6 }}
              onClick={() => onViewAgent(h.id)}
              title="Click to view prompt"
            >
              <AgentIcon name={a.name} color={a.color} size={38} />
              <div className="trow-main">
                <div className="trow-name">
                  {a.name}
                  <LockBadge>v{h.version}</LockBadge>
                </div>
                <div className="trow-sub">
                  <RoleChip role={a.role} />
                  <ScorecardInline card={scorecards[h.id]} />
                  <span className="mono" style={{ color: 'var(--tx-3)' }}>
                    {h.model}
                  </span>
                </div>
              </div>
              <div className="trow-tools" onClick={e => e.stopPropagation()}>
                {h.grantedTools.length === 0 && (h.grantedConnectors?.length ?? 0) === 0 ? (
                  <span style={{ fontSize: 11, color: 'var(--tx-3)', fontFamily: 'var(--mono)' }}>
                    no tools
                  </span>
                ) : (
                  <>
                    {h.grantedTools.map(t => (
                      <span key={t.name} className={`tool-i ${t.sens}`} title={t.name}>
                        <ToolGlyph sens={t.sens as Sensitivity} size={12} />
                      </span>
                    ))}
                    {(h.grantedConnectors?.length ?? 0) > 0 &&
                      Object.entries(
                        (h.grantedConnectors ?? []).reduce<Record<string, number>>(
                          (acc, g) => ({
                            ...acc,
                            [g.server]: (acc[g.server] ?? 0) + 1,
                          }),
                          {},
                        ),
                      ).map(([server, count]) => (
                        <span
                          key={server}
                          className="connector-chip"
                          title={`${count} ${CONNECTOR_BY_ID[server]?.name ?? server} tools`}
                        >
                          {CONNECTOR_BY_ID[server]?.name ?? server} ·{count}
                        </span>
                      ))}
                  </>
                )}
              </div>
              <div className="trow-actions" onClick={e => e.stopPropagation()}>
                <Switch on={h.enabled} onToggle={() => onToggle(h.id)} />
                <button className="icon-btn danger" onClick={() => onRemove(h.id)} title="Remove">
                  <IconTrash />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
