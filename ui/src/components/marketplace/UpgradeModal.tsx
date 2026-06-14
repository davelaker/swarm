import { AGENT_BY_ID, UX_UPGRADE } from '../../data/marketAgents';
import { AgentIcon } from './shared';
import { ToolGlyph } from '../common/ToolIcon';
import { IconWarn, IconX } from '../common/icons';

export function UpgradeModal({ onClose, onApply }: { onClose: () => void; onApply: () => void }) {
  const a = AGENT_BY_ID['ux'];
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" style={{ width: 540 }}>
        <div className="modal-head">
          <AgentIcon name="UX Researcher" color={a.color} size={34} />
          <div style={{ flex: 1 }}>
            <div className="modal-title">Upgrade UX Researcher</div>
            <div className="modal-sub">
              1.2.0 →{' '}
              <span style={{ color: 'var(--amber)', fontWeight: 600 }}>{UX_UPGRADE.to}</span>
            </div>
          </div>
          <button className="x-btn" onClick={onClose}>
            <IconX />
          </button>
        </div>
        <div className="modal-body">
          <div className="mfield">
            <div className="mfield-label">What changed</div>
            <div style={{ fontSize: 12.5, color: 'var(--tx-1)', marginBottom: 12 }}>
              {UX_UPGRADE.changelog}
            </div>
          </div>
          <div className="mfield">
            <div className="mfield-label">Prompt diff</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {UX_UPGRADE.diff.map((l, i) => (
                <div key={i} className={`diff-line ${l.t}`}>
                  {l.t === 'add' ? '+' : l.t === 'del' ? '-' : ' '}
                  {l.s}
                </div>
              ))}
            </div>
          </div>
          <div className="mfield">
            <div className="mfield-label">Newly requested tool</div>
            <div className="newtool">
              <span
                className={`tool-i ${UX_UPGRADE.newTool.sens}`}
                style={{ flex: '0 0 28px', width: 28, height: 28 }}
              >
                <ToolGlyph sens={UX_UPGRADE.newTool.sens} size={14} />
              </span>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontWeight: 600,
                    fontSize: 13,
                    color: 'var(--tx)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  {UX_UPGRADE.newTool.name}
                  <span className={`sens-tag ${UX_UPGRADE.newTool.sens}`}>
                    {UX_UPGRADE.newTool.sens}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--tx-1)', marginTop: 3 }}>
                  {UX_UPGRADE.newTool.desc}
                </div>
              </div>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--amber)',
                  fontFamily: 'var(--mono)',
                }}
              >
                NEW
              </span>
            </div>
            <div className="helper">
              <IconWarn size={11} /> This version requests a network permission you haven't granted.
              You'll review it on upgrade.
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Not now
          </button>
          <button className="btn primary" onClick={onApply}>
            Review &amp; apply upgrade
          </button>
        </div>
      </div>
    </>
  );
}
