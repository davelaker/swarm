import type { Sensitivity } from '../../types';
import { IconLock, IconSearch } from '../common/icons';

export function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function initials(name: string) {
  return name
    .split(' ')
    .map(w => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function AgentIcon({
  name,
  color,
  size = 36,
}: {
  name: string;
  color: string;
  size?: number;
}) {
  return (
    <div
      className="acard-icon"
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        fontSize: size > 36 ? 15 : 13,
        color,
        background: rgba(color, 0.1),
        borderColor: rgba(color, 0.3),
      }}
    >
      {initials(name)}
    </div>
  );
}

export function RoleChip({ role }: { role: string }) {
  return <span className="rolechip">{role}</span>;
}

export function SensTag({ sens }: { sens: Sensitivity }) {
  return <span className={`sens-tag ${sens}`}>{sens}</span>;
}

// SQL category tools — shared across marketplace components
export const SQL_CAT_CLS: Record<string, string> = {
  read: 'read',
  write: 'write',
  delete: 'write',
  destructive: 'shell',
};
export const SQL_CAT_LABEL: Record<string, string> = {
  read: 'db·read',
  write: 'db·write',
  delete: 'db·delete',
  destructive: 'db·schema',
};
export const SQL_CAT_ICON: Record<string, string> = {
  read: 'read',
  write: 'write',
  delete: 'write',
  destructive: 'shell',
};
// Risk value for sort — most dangerous (0) to safest (higher = safer)
export const SQL_CAT_RISK: Record<string, number> = {
  destructive: 0,
  delete: 0.5,
  write: 0.8,
  read: 1.2,
};

export function SqlCatTag({ category }: { category: string }) {
  return (
    <span className={`sens-tag ${SQL_CAT_CLS[category] ?? 'shell'}`}>
      {SQL_CAT_LABEL[category] ?? category}
    </span>
  );
}

export function LockChip({ label }: { label?: string }) {
  return (
    <span className="lockchip">
      <IconLock size={9} /> {label}
    </span>
  );
}

export function LockBadge({ children }: { children: React.ReactNode }) {
  return <span className="lockbadge">{children}</span>;
}

export function SearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="search">
      <IconSearch />
      <input placeholder="Search agents…" value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}
