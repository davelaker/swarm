import type { MarketAgent } from '../../types';
import { AgentIcon, ProvBadge, RoleChip, StarRating, SensTag, LockChip } from './shared';
import { ToolGlyph } from '../common/ToolIcon';
import { IconLock, IconWarn, IconX } from '../common/icons';

interface DrawerProps {
  a: MarketAgent;
  hired: boolean;
  onClose: () => void;
  onHire: (a: MarketAgent) => void;
}

export function AgentDrawer({ a, hired, onClose, onHire }: DrawerProps) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <AgentIcon name={a.name} color={a.color} size={44} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>{a.name}</div>
            <div className="acard-sub">
              <RoleChip role={a.role} />
              <ProvBadge prov={a.prov} />
              <StarRating rating={a.rating} />
            </div>
          </div>
          <button className="x-btn" onClick={onClose}><IconX /></button>
        </div>

        <div className="drawer-body">
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

          <div className="dsec">
            <div className="dsec-label"><IconLock size={11} /> Base prompt · read-only</div>
            <div className="prompt-block">
              <span className="prompt-lock"><IconLock size={10} /> locked</span>
              {a.prompt}
            </div>
          </div>

          <div className="dsec">
            <div className="dsec-label">Requested tools</div>
            {a.tools.map(t => {
              const caution = t.sens !== 'read';
              return (
                <div key={t.name} className={`toolitem ${caution ? 'caution' : ''} ${t.sens}`}>
                  <span className={`tool-i ${t.sens}`} style={{ flex: '0 0 26px', width: 26, height: 26 }}>
                    <ToolGlyph sens={t.sens} size={13} />
                  </span>
                  <div style={{ flex: 1 }}>
                    <div className="ti-name">
                      {t.name}
                      {caution && <IconWarn size={12} />}
                    </div>
                    <div className="ti-desc">
                      {t.desc}
                      {t.locked && <LockChip label={`scope: ${t.scope} · locked`} />}
                    </div>
                  </div>
                  <SensTag sens={t.sens} />
                </div>
              );
            })}
          </div>

          <div className="dsec">
            <div className="dsec-label">Routing contract</div>
            <div className="routing">
              {a.routing.map((seg, i) => (
                <span key={i}>
                  {seg.map((x, j) => j % 2 === 1 ? <b key={j}>{x}</b> : <span key={j}>{x}</span>)}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="drawer-foot">
          <div style={{ flex: 1, fontSize: 12, color: 'var(--tx-2)' }}>
            {hired ? 'Already on your team.' : 'Review tools and permissions before hiring.'}
          </div>
          <button className="btn primary" disabled={hired} onClick={() => onHire(a)}>
            {hired ? 'Hired' : 'Hire'} →
          </button>
        </div>
      </div>
    </>
  );
}
