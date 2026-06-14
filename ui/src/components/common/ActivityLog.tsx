import { useState, useEffect, useRef } from 'react';
import type { ActivityEntry } from '../../types';
import { ActivityItem } from './ActivityItem';

// Collapsible transcript of a single run's thinking + tool calls. Auto-expands
// while the run is active and auto-collapses to a one-line summary when it
// finishes; clicking the summary pins the user's choice either way, so a finished
// log can be re-opened. Keyed to a task (not an agent) by the caller, so an agent
// that runs several tasks keeps a separate transcript per task.
export function ActivityLog({
  activity,
  active,
  color,
}: {
  activity: ActivityEntry[];
  active: boolean;
  color?: string;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? active;
  const scrollRef = useRef<HTMLDivElement>(null);

  const count = activity.length;
  const thoughts = activity.filter(e => e.kind === 'thinking').length;
  const steps = count - thoughts;
  const summary =
    [
      steps ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : '',
      thoughts ? `${thoughts} ${thoughts === 1 ? 'thought' : 'thoughts'}` : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'activity';

  useEffect(() => {
    if (expanded && active && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [count, expanded, active]);

  if (count === 0) {
    return null;
  }

  return (
    <div style={{ marginTop: 5 }}>
      <button
        onClick={() => setOverride(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          background: 'transparent',
          border: 'none',
          padding: '1px 0',
          cursor: 'pointer',
          fontSize: 11,
          opacity: 0.6,
          color: 'inherit',
        }}
      >
        <span style={{ fontSize: 9 }}>{expanded ? '▾' : '▸'}</span>
        <span>{summary}</span>
      </button>
      {expanded && (
        <div
          ref={scrollRef}
          style={{
            maxHeight: 260,
            overflowY: 'auto',
            marginTop: 2,
            paddingLeft: 13,
            borderLeft: '1px solid var(--bg-3)',
          }}
        >
          {activity.map((entry, i) => (
            <ActivityItem key={i} entry={entry} color={color} />
          ))}
        </div>
      )}
    </div>
  );
}
