import { useState, useEffect, useCallback } from 'react';
import type { MarketAgent, HiredAgent } from '../../types';
import { MARKET_AGENTS, AGENT_BY_ID, BUILTINS, UX_UPGRADE } from '../../data/marketAgents';
import { AgentCard } from './AgentCard';
import { AgentPage } from './AgentPage';
import { BuiltinDrawer } from './BuiltinDrawer';
import { MyTeam } from './MyTeam';
import { UpgradeModal } from './UpgradeModal';
import { SearchBar } from './shared';

// ─── Roster persistence ───────────────────────────────────────────────────────

async function fetchRoster(): Promise<HiredAgent[]> {
  try {
    const r = await fetch('/marketplace/roster');
    if (!r.ok) return [];
    const data = (await r.json()) as HiredAgent[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function persistRoster(roster: HiredAgent[]): Promise<void> {
  try {
    await fetch('/marketplace/roster', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(roster),
    });
  } catch {
    // Non-fatal — server may be offline; roster stays in local state.
  }
}

// Enrich a hired agent with the fields the server-side roster needs but the UI
// doesn't otherwise persist: the full system prompt AND the display name. Without
// the name, the backend loader can't label the agent and (historically) dropped it.
function withPrompt(agent: HiredAgent): HiredAgent {
  if (agent.prompt && agent.name) return agent;
  const def = AGENT_BY_ID[agent.id];
  if (!def) return agent;
  return { ...agent, prompt: agent.prompt ?? def.prompt, name: agent.name ?? def.name };
}

// ─── Component ────────────────────────────────────────────────────────────────

const BUILTIN_IDS = new Set(BUILTINS.map(b => b.id));

export function Marketplace({
  projectName,
  focusAgentId,
  onFocusConsumed,
}: {
  projectName?: string;
  focusAgentId?: string | null;
  onFocusConsumed?: () => void;
}) {
  const [tab, setTab] = useState<'browse' | 'team'>('team');
  const [roleF, setRoleF] = useState('All');
  const [query, setQuery] = useState('');
  const [drawer, setDrawer] = useState<MarketAgent | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [team, setTeam] = useState<HiredAgent[]>([]);
  const [viewingBuiltin, setViewingBuiltin] = useState<string | null>(null);

  // Load roster from server on mount; fall back to empty list. Enrich each entry
  // with name/prompt from the catalog so older rosters persisted without a name are
  // healed and re-saved correctly on the next change.
  useEffect(() => {
    fetchRoster().then(roster => setTeam(roster.map(withPrompt)));
  }, []);

  // Deep-link from the PM's "Hire" call-to-action: open that agent's page on Browse,
  // then clear the focus so navigating away and back doesn't re-trigger it.
  useEffect(() => {
    if (!focusAgentId) return;
    const def = AGENT_BY_ID[focusAgentId];
    if (def) {
      setTab('browse');
      setDrawer(def);
    }
    onFocusConsumed?.();
  }, [focusAgentId, onFocusConsumed]);

  // Persist roster to server whenever it changes.
  const saveTeam = useCallback((next: HiredAgent[]) => {
    setTeam(next);
    persistRoster(next);
  }, []);

  const roles = ['All', ...Array.from(new Set(MARKET_AGENTS.map(a => a.role)))];
  const hiredIds = new Set(team.map(t => t.id));

  const filtered = MARKET_AGENTS.filter(
    a =>
      (roleF === 'All' || a.role === roleF) &&
      (query === '' || (a.name + a.desc + a.role).toLowerCase().includes(query.toLowerCase())),
  ).map(a => AGENT_BY_ID[a.id]);

  const doHire = (cfg: Omit<HiredAgent, 'upgradeAvailable'>) => {
    const full = withPrompt({ ...cfg, upgradeAvailable: false });
    saveTeam([...team.filter(x => x.id !== cfg.id), full]);
    setDrawer(null);
    setTab('team');
  };

  const applyUpgrade = () => {
    const next = team.map(h =>
      h.id === 'ux'
        ? {
            ...h,
            version: UX_UPGRADE.to,
            upgradeAvailable: false,
            grantedTools: [
              ...h.grantedTools,
              { name: UX_UPGRADE.newTool.name, sens: UX_UPGRADE.newTool.sens },
            ],
          }
        : h,
    );
    saveTeam(next);
    setUpgrading(false);
  };

  // Route clicks on team rows to the right drawer.
  const handleViewAgent = (id: string) => {
    if (BUILTIN_IDS.has(id)) {
      setViewingBuiltin(id);
    } else {
      const mkt = AGENT_BY_ID[id];
      if (mkt) setDrawer(mkt);
    }
  };

  return (
    <div className="mkt">
      <div className="mkt-tabs">
        <button className={`mkt-tab ${tab === 'team' ? 'on' : ''}`} onClick={() => setTab('team')}>
          My Team <span className="cnt">{BUILTINS.length + team.length}</span>
        </button>
        <button
          className={`mkt-tab ${tab === 'browse' ? 'on' : ''}`}
          onClick={() => setTab('browse')}
        >
          Browse <span className="cnt">{MARKET_AGENTS.length}</span>
        </button>
      </div>

      <div className="mkt-body">
        {tab === 'team' && (
          <MyTeam
            team={team}
            projectName={projectName}
            onToggle={id =>
              saveTeam(team.map(h => (h.id === id ? { ...h, enabled: !h.enabled } : h)))
            }
            onRemove={id => saveTeam(team.filter(h => h.id !== id))}
            onUpgrade={() => setUpgrading(true)}
            onViewAgent={handleViewAgent}
            onBrowse={() => setTab('browse')}
          />
        )}

        {tab === 'browse' && (
          <>
            <div className="filterbar">
              <div className="chipgroup">
                {roles.map(r => (
                  <button
                    key={r}
                    className={`fchip ${roleF === r ? 'on' : ''}`}
                    onClick={() => setRoleF(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <SearchBar value={query} onChange={setQuery} />
            </div>
            <div className="grid">
              {filtered.map(a => (
                <AgentCard key={a.id} a={a} hired={hiredIds.has(a.id)} onOpen={setDrawer} />
              ))}
              {filtered.length === 0 && (
                <div
                  style={{
                    color: 'var(--tx-3)',
                    fontFamily: 'var(--mono)',
                    fontSize: 13,
                    padding: '30px 2px',
                  }}
                >
                  No agents match those filters.
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {drawer && (
        <AgentPage
          a={drawer}
          hired={hiredIds.has(drawer.id)}
          projectName={projectName}
          onClose={() => setDrawer(null)}
          onConfirm={doHire}
        />
      )}
      {upgrading && <UpgradeModal onClose={() => setUpgrading(false)} onApply={applyUpgrade} />}
      {viewingBuiltin && (
        <BuiltinDrawer agentId={viewingBuiltin} onClose={() => setViewingBuiltin(null)} />
      )}
    </div>
  );
}
