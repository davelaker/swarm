import { useState } from 'react';
import type { MarketAgent, HiredAgent } from '../../types';
import { MARKET_AGENTS, AGENT_BY_ID, BUILTINS, UX_UPGRADE } from '../../data/marketAgents';
import { AgentCard } from './AgentCard';
import { AgentDrawer } from './AgentDrawer';
import { HireModal } from './HireModal';
import { MyTeam } from './MyTeam';
import { UpgradeModal } from './UpgradeModal';
import { SearchBar } from './shared';

const INITIAL_TEAM: HiredAgent[] = [
  { id: 'ux', version: '1.2.0', enabled: true, grantedTools: ['read_files', 'read_artifacts'], tiers: ['FEATURE', 'GREENFIELD'], model: 'Balanced', instructions: '', upgradeAvailable: true },
];

export function Marketplace() {
  const [tab,       setTab]       = useState<'browse' | 'team'>('browse');
  const [roleF,     setRoleF]     = useState('All');
  const [provF,     setProvF]     = useState('all');
  const [query,     setQuery]     = useState('');
  const [drawer,    setDrawer]    = useState<MarketAgent | null>(null);
  const [hiring,    setHiring]    = useState<MarketAgent | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [team,      setTeam]      = useState<HiredAgent[]>(INITIAL_TEAM);

  const roles    = ['All', ...Array.from(new Set(MARKET_AGENTS.map(a => a.role)))];
  const hiredIds = new Set(team.map(t => t.id));

  const filtered = MARKET_AGENTS.filter(a =>
    (roleF === 'All' || a.role === roleF) &&
    (provF === 'all' || a.prov === provF) &&
    (query === '' || (a.name + a.desc + a.role).toLowerCase().includes(query.toLowerCase()))
  ).map(a => AGENT_BY_ID[a.id]);

  const doHire = (cfg: Omit<HiredAgent, 'upgradeAvailable'>) => {
    setTeam(t => [...t.filter(x => x.id !== cfg.id), { ...cfg, upgradeAvailable: false }]);
    setHiring(null); setDrawer(null); setTab('team');
  };

  const applyUpgrade = () => {
    setTeam(t => t.map(h => h.id === 'ux'
      ? { ...h, version: UX_UPGRADE.to, upgradeAvailable: false, grantedTools: [...h.grantedTools, UX_UPGRADE.newTool.name] }
      : h
    ));
    setUpgrading(false);
  };

  return (
    <div className="mkt">
      <div className="mkt-tabs">
        <button className={`mkt-tab ${tab === 'browse' ? 'on' : ''}`} onClick={() => setTab('browse')}>
          Browse <span className="cnt">{MARKET_AGENTS.length}</span>
        </button>
        <button className={`mkt-tab ${tab === 'team' ? 'on' : ''}`} onClick={() => setTab('team')}>
          My Team <span className="cnt">{BUILTINS.length + team.length}</span>
        </button>
      </div>

      <div className="mkt-body">
        {tab === 'browse' && (
          <>
            <div className="filterbar">
              <div className="chipgroup">
                {roles.map(r => (
                  <button key={r} className={`fchip ${roleF === r ? 'on' : ''}`} onClick={() => setRoleF(r)}>{r}</button>
                ))}
              </div>
              <span className="filter-sep" />
              <select className="prov-select" value={provF} onChange={e => setProvF(e.target.value)}>
                <option value="all">All provenance</option>
                <option value="first">First-party</option>
                <option value="community">Community</option>
                <option value="private">Private</option>
              </select>
              <SearchBar value={query} onChange={setQuery} />
            </div>
            <div className="grid">
              {filtered.map(a => <AgentCard key={a.id} a={a} hired={hiredIds.has(a.id)} onOpen={setDrawer} />)}
              {filtered.length === 0 && (
                <div style={{ color: 'var(--tx-3)', fontFamily: 'var(--mono)', fontSize: 13, padding: '30px 2px' }}>
                  No agents match those filters.
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'team' && (
          <MyTeam
            team={team}
            onToggle={id => setTeam(t => t.map(h => h.id === id ? { ...h, enabled: !h.enabled } : h))}
            onRemove={id => setTeam(t => t.filter(h => h.id !== id))}
            onUpgrade={() => setUpgrading(true)}
          />
        )}
      </div>

      {drawer   && <AgentDrawer a={drawer} hired={hiredIds.has(drawer.id)} onClose={() => setDrawer(null)} onHire={setHiring} />}
      {hiring   && <HireModal  a={hiring} onClose={() => setHiring(null)} onConfirm={doHire} />}
      {upgrading && <UpgradeModal onClose={() => setUpgrading(false)} onApply={applyUpgrade} />}
    </div>
  );
}
