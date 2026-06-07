import type { Sensitivity, Provenance } from '../../types';
import { ToolGlyph } from '../common/ToolIcon';
import { IconLock, IconStar, IconSearch } from '../common/icons';

export function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function initials(name: string) {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

export function AgentIcon({ name, color, size = 36 }: { name: string; color: string; size?: number }) {
  return (
    <div className="acard-icon" style={{ width: size, height: size, flex: `0 0 ${size}px`, fontSize: size > 36 ? 15 : 13, color, background: rgba(color, 0.1), borderColor: rgba(color, 0.3) }}>
      {initials(name)}
    </div>
  );
}

export function ProvBadge({ prov }: { prov: Provenance }) {
  const label = { first: 'First-party', community: 'Community', private: 'Private' }[prov];
  return <span className={`prov ${prov}`}><span className="pdot" />{label}</span>;
}

export function RoleChip({ role }: { role: string }) {
  return <span className="rolechip">{role}</span>;
}

export function SensTag({ sens }: { sens: Sensitivity }) {
  return <span className={`sens-tag ${sens}`}>{sens}</span>;
}

export function LockChip({ label }: { label?: string }) {
  return <span className="lockchip"><IconLock size={9} /> {label}</span>;
}

export function LockBadge({ children }: { children: React.ReactNode }) {
  return <span className="lockbadge">{children}</span>;
}

export function StarRating({ rating }: { rating: number }) {
  return <span className="stars"><IconStar />{rating.toFixed(1)}</span>;
}

export function ToolIconRow({ tools }: { tools: Array<{ sens: Sensitivity; name?: string }> }) {
  return (
    <span className="toolrow">
      {tools.map((t, i) => (
        <span key={i} className={`tool-i ${t.sens}`} title={t.name}>
          <ToolGlyph sens={t.sens} size={12} />
        </span>
      ))}
    </span>
  );
}

export function SearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="search">
      <IconSearch />
      <input placeholder="Search agents…" value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}
