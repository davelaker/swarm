import { useState, useEffect } from 'react';
import type { MarketAgent, HiredAgent, ConnectorGrant } from '../../types';
import { AgentIcon, RoleChip, SensTag, LockChip, SqlCatTag, SQL_CAT_ICON, SQL_CAT_RISK } from './shared';
import { ToolGlyph } from '../common/ToolIcon';
import { IconLock, IconChevronLeft } from '../common/icons';
import { CONNECTOR_BY_ID } from '../../data/connectors';
import type { ConnectorSens } from '../../data/connectors';

type PermMode = 'allow' | 'ask' | 'deny';

const MODELS = [
  { label: 'Haiku 4.5',  id: 'claude-haiku-4-5-20251001' },
  { label: 'Sonnet 4.6', id: 'claude-sonnet-4-6' },
  { label: 'Opus 4.8',   id: 'claude-opus-4-8' },
  { label: 'Fable 5',    id: 'claude-fable-5' },
];
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const TOOL_RISK: Record<string, number> = { shell: 0, write: 1, read: 2 };
const MCP_RISK:  Record<string, number> = { 'mcp-write': 0, 'mcp-read': 1 };

const REMOTE_CAPABLE = new Set([
  'psql', 'mysql', 'mysqldump', 'pg_dump', 'pg_restore',
  'redis-cli', 'mongo', 'mongosh', 'ssh', 'curl', 'wget', 'nc',
]);

function capabilityLine(sens: string, scope?: string, sqlCategory?: string): string {
  if (sens === 'shell') {
    if (sqlCategory) {
      if (sqlCategory === 'read')        return 'Can read data — SELECT, SHOW, EXPLAIN, DESCRIBE.';
      if (sqlCategory === 'write')       return 'Can modify rows — INSERT, UPDATE.';
      if (sqlCategory === 'delete')      return 'Can delete rows — DELETE.';
      if (sqlCategory === 'destructive') return 'Can destroy or alter schema — DROP, TRUNCATE, ALTER.';
    }
    if (scope) {
      const cmd = scope.split(' ')[0];
      if (scope.includes('*')) {
        return REMOTE_CAPABLE.has(cmd)
          ? `Can run ${cmd} commands — including connections to remote systems.`
          : `Can run ${cmd} commands only.`;
      }
      return `Can run: ${scope} only.`;
    }
    return 'Can run any command on your computer — not limited to stated use.';
  }
  if (sens === 'write')   return scope ? `Can create and modify files in ${scope}.` : 'Can create and modify files.';
  if (sens === 'network') return 'Can make outbound network requests.';
  return 'Can read files — no changes.';
}

function capabilityTone(sens: string, sqlCategory?: string): string {
  if (sqlCategory === 'destructive') return 'shell';
  if (sqlCategory === 'delete')      return 'write';
  if (sqlCategory === 'write')       return 'write';
  if (sqlCategory === 'read')        return '';
  return sens === 'shell' ? 'shell' : sens === 'write' ? 'write' : '';
}

function mcpCapabilityLine(sens: ConnectorSens, connectorName: string): string {
  if (sens === 'mcp-write') return `Can change data in ${connectorName} — not limited to stated use.`;
  return `Can read data from ${connectorName}.`;
}

function descPrefix(sens: string, locked?: boolean, scope?: string): string {
  if (sens === 'shell') return 'Uses this for: ';
  if (sens === 'write' && !locked && !scope) return 'Uses this for: ';
  if (sens === 'mcp-write') return 'Uses this for: ';
  return '';
}

function PermToggle({ mode, onChange }: { mode: PermMode; onChange: (m: PermMode) => void }) {
  return (
    <div className="perm-seg">
      {(['allow', 'ask', 'deny'] as PermMode[]).map(m => (
        <button key={m} className={`perm-seg-btn ${mode === m ? `active ${m}` : ''}`} onClick={() => onChange(m)}>
          {m}
        </button>
      ))}
    </div>
  );
}

function McpSensTag({ sens }: { sens: ConnectorSens }) {
  const base = sens === 'mcp-read' ? 'read' : 'write';
  return <span className={`sens-tag ${base}`}>mcp·{base}</span>;
}

interface AgentPageProps {
  a: MarketAgent;
  hired: boolean;
  projectName?: string;
  onClose: () => void;
  onConfirm: (cfg: Omit<HiredAgent, 'upgradeAvailable'>) => void;
}

export function AgentPage({ a, hired, projectName, onClose, onConfirm }: AgentPageProps) {
  const [grants, setGrants] = useState<Record<string, PermMode>>(() =>
    Object.fromEntries(a.tools.map(t => {
      if (t.sqlCategory === 'read')        return [t.name, 'allow' as PermMode];
      if (t.sqlCategory === 'write')       return [t.name, 'ask'   as PermMode];
      if (t.sqlCategory === 'delete')      return [t.name, 'ask'   as PermMode];
      if (t.sqlCategory === 'destructive') return [t.name, 'deny'  as PermMode];
      if (t.sens === 'read')               return [t.name, 'allow' as PermMode];
      if (t.sens === 'write' && t.locked)  return [t.name, 'allow' as PermMode];
      if (t.sens === 'network')            return [t.name, 'ask'   as PermMode];
      return [t.name, 'deny' as PermMode];
    }))
  );

  const [connectorGrants, setConnectorGrants] = useState<Record<string, Record<string, PermMode>>>(() => {
    const init: Record<string, Record<string, PermMode>> = {};
    for (const req of a.connectors ?? []) {
      const def = CONNECTOR_BY_ID[req.id];
      if (!def) continue;
      init[req.id] = Object.fromEntries(
        def.tools
          .filter(t => req.tools.includes(t.name))
          .map(t => [t.name, (t.defaultOn ? 'allow' : 'deny') as PermMode])
      );
    }
    return init;
  });

  const [available, setAvailable] = useState<string[] | null>(
    (a.connectors?.length ?? 0) === 0 ? [] : null
  );
  useEffect(() => {
    if ((a.connectors?.length ?? 0) === 0) return;
    fetch('/marketplace/connectors/available')
      .then(r => r.ok ? r.json() : { available: [] })
      .then((data: { available: string[] }) => setAvailable(data.available ?? []))
      .catch(() => setAvailable([]));
  }, []);

  const [instructions, setInstructions] = useState('');
  const [model, setModel]               = useState(DEFAULT_MODEL);
  const [reviewed, setReviewed]         = useState(false);

  const stillProbing = available === null;
  const askCount     = a.tools.filter(t => grants[t.name] === 'ask').length;
  const activeCount  = a.tools.filter(t => grants[t.name] !== 'deny').length;
  const connectorGrantedCount = Object.values(connectorGrants).reduce(
    (n, tools) => n + Object.values(tools).filter(m => m !== 'deny').length, 0
  );

  const hasSensitive = a.tools.some(t => !t.locked && (t.sens === 'shell' || t.sens === 'write') && grants[t.name] !== 'deny') ||
    (a.connectors ?? []).some(req => {
      const def = CONNECTOR_BY_ID[req.id];
      return def?.tools.some(t => t.sens === 'mcp-write' && req.tools.includes(t.name) && connectorGrants[req.id]?.[t.name] !== 'deny');
    });

  const btnDisabled    = hired || (hasSensitive && !reviewed) || stillProbing;
  const disabledReason = !hired && btnDisabled
    ? stillProbing              ? 'Checking connector status…'
    : 'Scroll down and confirm you\'ve reviewed permissions'
    : undefined;

  const toolRisk    = (t: typeof a.tools[0]) =>
    t.sqlCategory ? (SQL_CAT_RISK[t.sqlCategory] ?? 99) : (TOOL_RISK[t.sens] ?? 99);
  const sortedTools = [...a.tools].sort((x, y) => toolRisk(y) - toolRisk(x));

  const setMode          = (name: string, m: PermMode) => setGrants(g => ({ ...g, [name]: m }));
  const setConnectorMode = (connId: string, toolName: string, m: PermMode) =>
    setConnectorGrants(g => ({ ...g, [connId]: { ...(g[connId] ?? {}), [toolName]: m } }));

  const handleConfirm = () => {
    const grantedConnectors: ConnectorGrant[] = Object.entries(connectorGrants).flatMap(
      ([server, tools]) =>
        Object.entries(tools)
          .filter(([, m]) => m !== 'deny')
          .map(([tool, m]) => ({ server, tool, ...(m === 'ask' ? { mode: 'ask' as const } : {}) }))
    );
    onConfirm({
      id: a.id, enabled: true,
      grantedTools: a.tools
        .filter(t => grants[t.name] !== 'deny')
        .map(t => ({
          name: t.name, sens: t.sens,
          ...(grants[t.name] === 'ask' ? { mode: 'ask' as const } : {}),
          ...(t.scope       ? { scope: t.scope }               : {}),
          ...(t.sqlCategory ? { sqlCategory: t.sqlCategory }   : {}),
        })),
      grantedConnectors,
      model, instructions, version: a.version,
    });
  };

  return (
    <div className="agent-page hire-page">
      {/* ── Nav bar ──────────────────────────────────────────── */}
      <div className="agent-page-nav">
        <button className="ap-back" onClick={onClose}>
          <IconChevronLeft size={13} /> Browse agents
        </button>
        <div className="ap-nav-center">
          <AgentIcon name={a.name} color={a.color} size={22} />
          <span className="ap-nav-name">{a.name}</span>
          <RoleChip role={a.role} />
          {projectName && (
            <span style={{ fontSize: 12, color: 'var(--tx-3)' }}>
              · hiring into <strong style={{ color: 'var(--tx-2)', fontWeight: 600 }}>{projectName}</strong>
            </span>
          )}
        </div>
      </div>

      {/* ── Two-column body ──────────────────────────────────── */}
      <div className="agent-page-body">

        {/* Left: agent info ────────────────────────────────── */}
        <div className="ap-col ap-col-left">
          <div className="ap-header">
            <AgentIcon name={a.name} color={a.color} size={52} />
            <div>
              <div className="ap-name">{a.name}</div>
              <div className="acard-sub" style={{ marginTop: 5 }}>
                <RoleChip role={a.role} />
              </div>
            </div>
          </div>

          <div className="dsec">
            <div className="meta-grid">
              <div className="mg">
                <div className="k">Version</div>
                <div className="v">{a.version}</div>
              </div>
              <div className="mg" style={{ flex: 1 }}>
                <div className="k">Changelog</div>
                <div className="v" style={{ fontFamily: 'var(--sans)', color: 'var(--tx-1)' }}>{a.changelog}</div>
              </div>
            </div>
          </div>

          <div className="dsec ap-prompt-sec">
            <div className="dsec-label"><IconLock size={11} /> Base prompt · read-only</div>
            <div className="prompt-block ap-prompt-block">
              <span className="prompt-lock"><IconLock size={10} /> locked</span>
              {a.prompt}
            </div>
          </div>

        </div>

        {/* Right: permissions + config ─────────────────────── */}
        <div className="ap-col ap-col-right hire-config">

          {/* Summary */}
          <div className="hire-ready">
            {activeCount} of {a.tools.length} tools active
            {askCount > 0 && <span style={{ color: 'var(--amber)', marginLeft: 4 }}>· {askCount} require approval</span>}
            {connectorGrantedCount > 0 && ` · ${connectorGrantedCount} mcp`}
          </div>

          {/* Machine access */}
          <div className="perm-domain perm-domain-machine">
            <div className="perm-domain-head">
              <div className="perm-domain-title">Machine access</div>
              <div className="perm-domain-desc">
                What the agent can do on this computer.
                File access is scoped to this project directory.
              </div>
            </div>
            {sortedTools.map(t => {
              const caution    = t.sqlCategory ? t.sqlCategory !== 'read' : t.sens !== 'read';
              const capability = capabilityLine(t.sens, t.scope, t.sqlCategory);
              const tone       = capabilityTone(t.sens, t.sqlCategory);
              const defaultOff = caution && !t.locked && !t.sqlCategory;
              const iconSens   = t.sqlCategory ? (SQL_CAT_ICON[t.sqlCategory] ?? t.sens) : t.sens;
              return (
                <div key={t.name} className={`grant ${caution ? 'sensitive' : ''} ${t.sens} ${t.locked ? 'locked' : ''}`}>
                  <span className={`tool-i ${iconSens}`} style={{ flex: '0 0 26px', width: 26, height: 26 }}>
                    <ToolGlyph sens={iconSens as import('../../types').Sensitivity} size={13} />
                  </span>
                  <div className="grant-main">
                    <div className={`grant-capability ${tone}`}>{capability}</div>
                    <div className="grant-name">
                      {t.name}
                      {t.sqlCategory ? <SqlCatTag category={t.sqlCategory} /> : <SensTag sens={t.sens} />}
                      {t.locked && <LockChip label={t.scope ? `${t.scope} · locked` : 'locked'} />}
                    </div>
                    <div className="grant-desc">
                      {descPrefix(t.sens, t.locked, t.scope)}{t.desc}
                      {defaultOff && <span className="grant-default-off"> · off by default</span>}
                    </div>
                  </div>
                  {t.locked
                    ? <span className="perm-locked-allow">allow</span>
                    : <PermToggle mode={grants[t.name]} onChange={m => setMode(t.name, m)} />
                  }
                </div>
              );
            })}
          </div>

          {/* External services */}
          {(a.connectors?.length ?? 0) > 0 && (
            <>
              <div className="perm-domain-sep">
                <span>these are independent systems</span>
              </div>
              <div className="perm-domain perm-domain-services">
                <div className="perm-domain-head">
                  <div className="perm-domain-title">External services</div>
                  <div className="perm-domain-desc">
                    Each service is its own separate gate — enabling or disabling
                    access here has no interaction with machine permissions above.
                    Each service you connect is independently controlled.
                  </div>
                </div>
                {stillProbing && <div className="connector-probing">Checking connection status…</div>}
                {!stillProbing && (a.connectors ?? []).map(req => {
                  const def      = CONNECTOR_BY_ID[req.id];
                  if (!def) return null;
                  const isAvail  = (available ?? []).includes(req.id);
                  const reqTools = [...def.tools.filter(t => req.tools.includes(t.name))]
                    .sort((x, y) => (MCP_RISK[y.sens] ?? 99) - (MCP_RISK[x.sens] ?? 99));
                  const cgrants  = connectorGrants[req.id] ?? {};
                  return (
                    <div key={req.id} className={`connector-block ${isAvail ? 'available' : 'unavailable'}`}>
                      <div className="connector-head">
                        <span className="connector-name">{def.name}</span>
                        {isAvail
                          ? <span className="connector-status ok">✓ Connected</span>
                          : <span className="connector-status bad">✗ Not connected</span>}
                      </div>
                      {!isAvail && (
                        <div className="connector-not-connected">
                          Connect {def.name} at claude.ai/settings to enable these tools.
                        </div>
                      )}
                      {isAvail && reqTools.map(tool => {
                        const isWrite    = tool.sens === 'mcp-write';
                        const capability = mcpCapabilityLine(tool.sens, def.name);
                        const cmode      = cgrants[tool.name] ?? 'deny';
                        return (
                          <div key={tool.name} className={`grant ${isWrite ? 'sensitive write' : ''}`}>
                            <span className={`tool-i ${isWrite ? 'write' : 'read'}`} style={{ flex: '0 0 26px', width: 26, height: 26 }}>
                              <ToolGlyph sens={isWrite ? 'write' : 'read'} size={13} />
                            </span>
                            <div className="grant-main">
                              <div className={`grant-capability ${isWrite ? 'write' : ''}`}>{capability}</div>
                              <div className="grant-name">
                                {tool.name}
                                <McpSensTag sens={tool.sens} />
                              </div>
                              <div className="grant-desc">
                                {descPrefix(tool.sens)}{tool.desc}
                              </div>
                            </div>
                            <PermToggle mode={cmode} onChange={m => setConnectorMode(req.id, tool.name, m)} />
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Additional instructions */}
          <div className="dsec">
            <div className="dsec-label">
              Additional instructions
              <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--tx-3)' }}> (overlay)</span>
            </div>
            <textarea
              className="ta hire-ta"
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              placeholder="e.g. Prioritise mobile breakpoints. Keep findings under three bullets."
            />
            <div className="helper">Appended after the template's guardrails. Cannot override them.</div>
          </div>

          {/* Model */}
          <div className="dsec">
            <div className="dsec-label">Model</div>
            <select className="sel" value={model} onChange={e => setModel(e.target.value)}>
              {MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>

          {/* Footer: review + action */}
          <div className="hire-foot">
            {hasSensitive && (
              <label className="hire-review-label">
                <input
                  type="checkbox"
                  className="hire-review-check"
                  checked={reviewed}
                  onChange={e => setReviewed(e.target.checked)}
                />
                I've reviewed the permissions above
              </label>
            )}
            {stillProbing && (
              <div className="hire-probing">
                <span className="hire-probing-dot" />
                Checking external service connections…
              </div>
            )}
            <div className="hire-action">
              <button className="btn" onClick={onClose}>Cancel</button>
              <button
                className="btn primary"
                disabled={btnDisabled}
                title={!stillProbing ? disabledReason : undefined}
                onClick={handleConfirm}
              >
                {hired ? 'Already hired' : `Hire ${a.name} →`}
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
