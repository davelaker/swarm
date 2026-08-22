import { useEffect, useState } from 'react';
import { useProjectClient } from '../project/ProjectClientContext';

// The default model each agent runs on when the PM doesn't override it — core
// agents from the BuiltinDrawer selector (/agent-models), marketplace specialists
// from their hired roster entry. Used to detect "the PM upgraded this agent above
// its default" so the user can confirm or revert before executing.
export function useAgentDefaults(): (assignee: string) => string | undefined {
  const projectClient = useProjectClient();
  const [core, setCore] = useState<Record<string, string>>({});
  const [roster, setRoster] = useState<Record<string, string>>({});

  useEffect(() => {
    projectClient
      .fetchJson<Record<string, string>>('/agent-models', { allowMissingEnvelope: true })
      .then((d: Record<string, string>) => setCore(d ?? {}))
      .catch(() => {});
    projectClient
      .fetchJson<Array<{ id: string; model?: string }>>('/marketplace/roster', {
        allowMissingEnvelope: true,
      })
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
  }, [projectClient]);

  return (assignee: string) => core[assignee] ?? roster[assignee];
}
