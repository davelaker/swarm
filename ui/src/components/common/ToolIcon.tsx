import { IconEye, IconPencil, IconGlobe, IconTerminal } from './icons';
import type { Sensitivity } from '../../types';

export function ToolGlyph({ sens, size = 13 }: { sens: Sensitivity; size?: number }) {
  if (sens === 'read') return <IconEye size={size} />;
  if (sens === 'write') return <IconPencil size={size} />;
  if (sens === 'network') return <IconGlobe size={size} />;
  if (sens === 'shell') return <IconTerminal size={size} />;
  return null;
}

export function ToolIcon({ sens, size = 22 }: { sens: Sensitivity; size?: number }) {
  return (
    <span className={`tool-i ${sens}`} style={{ width: size, height: size }}>
      <ToolGlyph sens={sens} size={size - 10} />
    </span>
  );
}
