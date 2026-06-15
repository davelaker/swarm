// Rough pre-run forecast — task count, credit cost, wall-clock — so you know what a
// run will roughly take before committing to it ("6 tasks · ~$0.40 · ~3m"). These
// are deliberately coarse per-role heuristics, not a promise; the run's live spend
// bar and elapsed timer are the source of truth once it starts.

interface RoleEstimate {
  usd: number;
  sec: number;
}

// Per-agent rough cost/time. Gates that run without an LLM (checks, visual) cost no
// credit but still take wall-clock (a typecheck, a headless browser render).
const ROLE_ESTIMATES: Record<string, RoleEstimate> = {
  coder: { usd: 0.14, sec: 40 },
  tester: { usd: 0.09, sec: 28 },
  security: { usd: 0.09, sec: 28 },
  reviewer: { usd: 0.07, sec: 22 },
  negotiator: { usd: 0.05, sec: 15 },
  checks: { usd: 0, sec: 8 },
  visual: { usd: 0, sec: 22 },
};
const DEFAULT_ESTIMATE: RoleEstimate = { usd: 0.1, sec: 30 }; // marketplace / unknown

export interface RunForecast {
  taskCount: number;
  costUsd: number;
  seconds: number;
}

// The deterministic gates the loop appends to any run that has a coder (see
// withEnforcedGates in core). Included so the forecast matches what actually runs.
const ENFORCED_GATES = ['checks', 'visual'];

// Pure: given the assignee role of every task that will run, total the estimate. If
// the roles include a coder but not the enforced gates, add them (the loop will).
export function forecastFromRoles(roles: string[]): RunForecast {
  const all = [...roles];
  if (all.includes('coder')) {
    for (const gate of ENFORCED_GATES) {
      if (!all.includes(gate)) {
        all.push(gate);
      }
    }
  }
  let costUsd = 0;
  let seconds = 0;
  for (const role of all) {
    const est = ROLE_ESTIMATES[role] ?? DEFAULT_ESTIMATE;
    costUsd += est.usd;
    seconds += est.sec;
  }
  return { taskCount: all.length, costUsd, seconds };
}

// Pretty wall-clock: "~45s" or "~3m".
export function formatForecastTime(seconds: number): string {
  if (seconds < 60) {
    return `~${Math.max(5, Math.round(seconds / 5) * 5)}s`;
  }
  return `~${Math.round(seconds / 60)}m`;
}
