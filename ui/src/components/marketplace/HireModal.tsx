import { useState } from 'react';
import type { MarketAgent, HiredAgent } from '../../types';
import { AgentIcon, SensTag, LockChip } from './shared';
import { ToolGlyph } from '../common/ToolIcon';
import { Switch } from '../common/Switch';
import { IconWarn, IconX } from '../common/icons';
import { ALL_TIERS } from '../../data/marketAgents';

interface HireModalProps {
  a: MarketAgent;
  onClose: () => void;
  onConfirm: (cfg: Omit<HiredAgent, 'upgradeAvailable'>) => void;
}

export function HireModal({ a, onClose, onConfirm }: HireModalProps) {
  const [grants, setGrants]           = useState<Record<string, boolean>>(() =>
    Object.fromEntries(a.tools.map(t => [t.name, t.sens === 'read']))
  );
  const [acked, setAcked]             = useState<Set<string>>(new Set());
  const [instructions, setInstructions] = useState('');
  const [model, setModel]             = useState('Balanced');
  const [tiers, setTiers]             = useState<string[]>(a.tiers);

  const sensitiveTools = a.tools.filter(t => t.sens !== 'read' && !t.locked);
  const allAcked       = sensitiveTools.every(t => acked.has(t.name));
  const grantedCount   = a.tools.filter(t => grants[t.name]).length;

  const toggle = (t: MarketAgent['tools'][number]) => {
    if (t.locked) return;
    setGrants(g => ({ ...g, [t.name]: !g[t.name] }));
    if (t.sens !== 'read') setAcked(s => new Set(s).add(t.name));
  };
  const toggleTier = (tier: string) =>
    setTiers(ts => ts.includes(tier) ? ts.filter(x => x !== tier) : [...ts, tier]);

  const toneFn = (sens: string) => sens === 'write' ? 'amber' : sens === 'shell' ? 'danger' : sens === 'network' ? 'orange' : '';

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal">
        <div className="modal-head">
          <AgentIcon name={a.name} color={a.color} size={34} />
          <div style={{ flex: 1 }}>
            <div className="modal-title">Hire {a.name}</div>
            <div className="modal-sub">Grant tools one at a time — like permissions on your phone.</div>
          </div>
          <button className="x-btn" onClick={onClose}><IconX /></button>
        </div>

        <div className="modal-body">
          <div className="mfield">
            <div className="mfield-label">Tool permissions</div>
            {a.tools.map(t => {
              const caution = t.sens !== 'read';
              const unack   = caution && !t.locked && !acked.has(t.name);
              return (
                <div key={t.name} className={`grant ${caution ? 'sensitive' : ''} ${t.sens} ${t.locked ? 'locked' : ''} ${unack ? 'unack' : ''}`}>
                  <span className={`tool-i ${t.sens}`} style={{ flex: '0 0 26px', width: 26, height: 26 }}>
                    <ToolGlyph sens={t.sens} size={13} />
                  </span>
                  <div className="grant-main">
                    <div className="grant-name">
                      {t.name}
                      <SensTag sens={t.sens} />
                      {t.locked && <LockChip label={`${t.scope} · locked`} />}
                    </div>
                    <div className="grant-desc">{t.desc}</div>
                    {caution && !t.locked && (
                      <div className="grant-warn">
                        <IconWarn size={11} />
                        {t.sens === 'shell'   ? 'Can run commands on your machine.' :
                         t.sens === 'network' ? 'Can make outbound network calls.' :
                         'Can write to your filesystem.'} Off by default.
                      </div>
                    )}
                  </div>
                  <Switch on={!!grants[t.name]} disabled={t.locked} tone={toneFn(t.sens)} onToggle={() => toggle(t)} />
                </div>
              );
            })}
          </div>

          <div className="mfield">
            <div className="mfield-label">
              Additional instructions <span style={{ color: 'var(--tx-3)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(overlay)</span>
            </div>
            <textarea className="ta" value={instructions} onChange={e => setInstructions(e.target.value)}
              placeholder="e.g. Prioritise mobile breakpoints. Keep findings under three bullets." />
            <div className="helper">Appended after the template's guardrails. Cannot override them.</div>
          </div>

          <div style={{ display: 'flex', gap: 24 }}>
            <div className="mfield" style={{ flex: '0 0 auto' }}>
              <div className="mfield-label">Model</div>
              <select className="sel" value={model} onChange={e => setModel(e.target.value)}>
                <option>Balanced</option><option>Deep</option>
              </select>
            </div>
            <div className="mfield" style={{ flex: 1 }}>
              <div className="mfield-label">Enabled tiers</div>
              <div className="tier-multi">
                {ALL_TIERS.map(tier => (
                  <button key={tier} className={`tier-opt ${tiers.includes(tier) ? 'on' : ''}`} onClick={() => toggleTier(tier)}>{tier}</button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <div style={{ flex: 1 }}>
            {!allAcked
              ? <span className="ack-note"><IconWarn size={12} /> Review the {sensitiveTools.length} sensitive {sensitiveTools.length === 1 ? 'permission' : 'permissions'} to continue.</span>
              : <span style={{ fontSize: 12, color: 'var(--tx-2)' }}>{grantedCount} of {a.tools.length} tools granted · {tiers.length} tiers</span>}
          </div>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!allAcked || tiers.length === 0}
            onClick={() => onConfirm({ id: a.id, enabled: true, grantedTools: a.tools.filter(t => grants[t.name]).map(t => t.name), tiers, model, instructions, version: a.version })}
          >
            Hire {a.name} with {grantedCount} {grantedCount === 1 ? 'tool' : 'tools'} granted
          </button>
        </div>
      </div>
    </>
  );
}
