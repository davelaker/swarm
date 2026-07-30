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

// Relative *cost* weight per model, taken straight from published per-million-token
// pricing with Sonnet as the 1.0 reference (input and output ratios agree, so one
// weight covers both):
//   haiku $1/$5 = 0.33 · sonnet $3/$15 = 1 · opus $5/$25 = 1.67 · fable $10/$50 = 3.33
// These are price-true rather than hand-tuned, so they can be checked against the
// pricing table. Caveat: they model PRICE only, not token VOLUME — a higher-tier model
// also tends to think longer for the same task, so these under-state a big upgrade
// somewhat. Once enough runs have recorded per-task cost_usd alongside a model, derive
// these empirically from that data instead (today's history is too thin to fit).
const MODEL_COST_WEIGHT: Record<string, number> = {
  'claude-haiku-4-5-20251001': 0.33,
  'claude-sonnet-4-6': 1,
  'claude-sonnet-5': 1,
  'claude-opus-4-8': 1.67,
  'claude-fable-5': 3.33,
};
const DEFAULT_MODEL_WEIGHT = 1; // unknown / marketplace model → treat as sonnet-equivalent

// The model each role's base cost is calibrated against — must match core's builtin-models
// DEFAULT so an un-upgraded task scales by exactly 1.0.
const ROLE_DEFAULT_MODEL: Record<string, string> = {
  coder: 'claude-sonnet-4-6',
  tester: 'claude-haiku-4-5-20251001',
  security: 'claude-haiku-4-5-20251001',
  reviewer: 'claude-sonnet-4-6',
  negotiator: 'claude-sonnet-4-6',
};

const weightOf = (model?: string): number =>
  model ? (MODEL_COST_WEIGHT[model] ?? DEFAULT_MODEL_WEIGHT) : DEFAULT_MODEL_WEIGHT;

// How much to scale a role's base cost given the task's actual model, relative to the model
// the base was calibrated for. 1.0 when the task runs on the role's default (or has no model).
function modelCostScale(role: string, model?: string): number {
  if (!model) {
    return 1;
  }
  const baseModel = ROLE_DEFAULT_MODEL[role];
  const baseWeight = baseModel ? weightOf(baseModel) : DEFAULT_MODEL_WEIGHT;
  return weightOf(model) / baseWeight;
}

export interface RunForecast {
  taskCount: number;
  costUsd: number;
  seconds: number;
}

interface TaskLike {
  assignee: string;
  model?: string;
}

// The deterministic gates the loop appends to any run that has a coder (see
// withEnforcedGates in core). Included so the forecast matches what actually runs.
const ENFORCED_GATES = ['checks', 'visual'];

// Pure: total the estimate over every task that will run, scaling each task's cost by its
// assigned model (an Opus coder costs several × a Haiku one). Time is left model-flat — model
// choice moves cost far more than wall-clock. If the tasks include a coder but not the
// enforced gates, add them (the loop will); gates cost $0 so their model is irrelevant.
export function forecastFromTasks(tasks: TaskLike[]): RunForecast {
  const all: TaskLike[] = [...tasks];
  if (all.some(t => t.assignee === 'coder')) {
    for (const gate of ENFORCED_GATES) {
      if (!all.some(t => t.assignee === gate)) {
        all.push({ assignee: gate });
      }
    }
  }
  let costUsd = 0;
  let seconds = 0;
  for (const t of all) {
    const est = ROLE_ESTIMATES[t.assignee] ?? DEFAULT_ESTIMATE;
    costUsd += est.usd * modelCostScale(t.assignee, t.model);
    seconds += est.sec;
  }
  return { taskCount: all.length, costUsd, seconds };
}

// Convenience for the team-roster fallback, where only roles (no per-task model) are known.
export function forecastFromRoles(roles: string[]): RunForecast {
  return forecastFromTasks(roles.map(assignee => ({ assignee })));
}

// Pretty wall-clock: "~45s" or "~3m".
export function formatForecastTime(seconds: number): string {
  if (seconds < 60) {
    return `~${Math.max(5, Math.round(seconds / 5) * 5)}s`;
  }
  return `~${Math.round(seconds / 60)}m`;
}
