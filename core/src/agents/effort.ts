// Per-task reasoning effort.
//
// `effort` controls how much the model thinks and how much it spends before answering.
// It is the primary intelligence/latency/cost lever on current models — often a better
// knob than jumping a task up the model ladder, since raising effort on sonnet is far
// cheaper than switching to opus or fable.
//
// Two hard constraints, both enforced here rather than at the call site:
//   1. Haiku 4.5 does NOT support the effort parameter at all — sending it errors.
//   2. `xhigh` only exists on Opus 4.7+ / Sonnet 5 / Fable 5; older models top out at
//      `high`/`max`, so an xhigh request there is clamped down to `high`.
//
// Everything is a pure function so the rules are unit-testable without a live model.

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

// Models that accept `effort` at all. Haiku is deliberately absent.
const SUPPORTS_EFFORT = ['fable', 'opus', 'sonnet'];

// Models that accept the `xhigh` level (added with Opus 4.7). Sonnet 4.6 and Opus 4.6
// support effort but not xhigh, so a request for it is clamped to `high`.
const SUPPORTS_XHIGH = ['fable', 'opus-4-8', 'opus-4-7', 'sonnet-5'];

const matchesAny = (model: string, keys: string[]): boolean => {
  const s = model.toLowerCase();
  return keys.some(k => s.includes(k));
};

// True when the model accepts an `effort` value. Haiku 4.5 does not.
export function modelSupportsEffort(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  // Haiku wins over the generic 'sonnet'/'opus' substrings if an id ever contains both.
  if (model.toLowerCase().includes('haiku')) {
    return false;
  }
  return matchesAny(model, SUPPORTS_EFFORT);
}

// Parse a PM-supplied effort value. Returns undefined for anything unrecognised so the
// caller falls back to the model's own default rather than sending a bad value.
export function normalizeEffort(raw: unknown): Effort | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const s = raw
    .trim()
    .toLowerCase()
    // Hyphens too, so 'x-high' and 'x_high' land on the same key as 'xhigh'.
    .replace(/[\s_-]+/g, '');
  const alias: Record<string, Effort> = {
    low: 'low',
    medium: 'medium',
    med: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    extrahigh: 'xhigh',
    veryhigh: 'xhigh',
    max: 'max',
    maximum: 'max',
  };
  return alias[s];
}

// The effort value that is actually safe to send for this model, or undefined to omit
// the parameter entirely. Omitting is always safe — the model uses its own default.
export function effortForModel(model: string | undefined, requested: unknown): Effort | undefined {
  const effort = normalizeEffort(requested);
  if (!effort || !modelSupportsEffort(model)) {
    return undefined;
  }
  if (effort === 'xhigh' && !matchesAny(model ?? '', SUPPORTS_XHIGH)) {
    return 'high';
  }
  return effort;
}
