import { useEffect, useState } from 'react';

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
  const [cards, setCards] = useState<Record<string, Scorecard>>({});

  useEffect(() => {
    fetch('/marketplace/scorecards')
      .then(r => (r.ok ? r.json() : { scorecards: {} }))
      .then((d: { scorecards?: Record<string, Scorecard> }) => setCards(d.scorecards ?? {}))
      .catch(() => {});
  }, []);

  return cards;
}
