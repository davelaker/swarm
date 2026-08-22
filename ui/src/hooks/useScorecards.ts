import { useEffect, useState } from 'react';
import { useProjectClient } from '../project/ProjectClientContext';

export interface Scorecard {
  agent: string;
  tasks: number;
  sessions: number;
  passes: number;
  issuesCaught: number;
  failures: number;
  totalCostUsd: number;
}

// Per-agent track records aggregated across all saved runs (GET /marketplace/scorecards).
// Loaded once when the marketplace mounts.
export function useScorecards(): Record<string, Scorecard> {
  const projectClient = useProjectClient();
  const [cards, setCards] = useState<Record<string, Scorecard>>({});

  useEffect(() => {
    projectClient
      .fetchJson<{ scorecards?: Record<string, Scorecard> }>('/marketplace/scorecards', {
        allowMissingEnvelope: true,
      })
      .then((d: { scorecards?: Record<string, Scorecard> }) => setCards(d.scorecards ?? {}))
      .catch(() => {});
  }, [projectClient]);

  return cards;
}
