interface SwitchProps {
  on: boolean;
  tone?: string;
  disabled?: boolean;
  onToggle: () => void;
}

export function Switch({ on, tone = '', disabled, onToggle }: SwitchProps) {
  return (
    <div
      className={`switch ${on ? 'on' : ''} ${tone} ${disabled ? 'disabled' : ''}`}
      onClick={() => !disabled && onToggle()}
    />
  );
}
