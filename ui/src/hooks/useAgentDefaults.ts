import { useEffect, useState } from 'react';

// The default model each agent runs on when the PM doesn't override it — core
// agents from the BuiltinDrawer selector (/agent-models), marketplace specialists
// from their hired roster entry. Used to detect "the PM upgraded this agent above
// its default" so the user can confirm or revert before executing.
export function useAgentDefaults(): (assignee: string) => string | undefined {
  const [core, setCore] = useState<Record<string, string>>({});
  const [roster, setRoster] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch('/agent-models')
      .then(r => (r.ok ? r.json() : {}))
      .then((d: Record<string, string>) => setCore(d ?? {}))
      .catch(() => {});
    fetch('/marketplace/roster')
      .then(r => (r.ok ? r.json() : []))
      .then((list: Array<{ id: string; model?: string }>) => {
        const map: Record<string, string> = {};
        for (const a of list ?? []) {
          if (a.model) {
            map[a.id] = a.model;
          }
        }
        setRoster(map);
      })
      .catch(() => {});
  }, []);

  return (assignee: string) => core[assignee] ?? roster[assignee];
}
