// Friendly labels + accent colors for the Claude models the PM assigns per task.
// Keyed loosely (substring match) so both canonical ids and aliases resolve.

interface ModelMeta {
  label: string;
  color: string;
}

const MODELS: { match: string; meta: ModelMeta }[] = [
  { match: 'opus', meta: { label: 'Opus', color: '#a585f5' } },
  { match: 'fable', meta: { label: 'Fable', color: '#e8a93a' } },
  { match: 'sonnet', meta: { label: 'Sonnet', color: '#4d8df4' } },
  { match: 'haiku', meta: { label: 'Haiku', color: '#34cf8a' } },
];

export function modelMeta(model: string | undefined): ModelMeta | null {
  if (!model) {
    return null;
  }
  const s = model.toLowerCase();
  return MODELS.find(m => s.includes(m.match))?.meta ?? null;
}

// Rough capability/cost ordering, used to detect when the PM picked a model MORE
// powerful (and pricier) than an agent's default. Unknown → -1 (never an upgrade).
const RANK = ['haiku', 'fable', 'sonnet', 'opus'];
export function modelRank(model: string | undefined): number {
  if (!model) {
    return -1;
  }
  const s = model.toLowerCase();
  return RANK.findIndex(r => s.includes(r));
}

// True when `chosen` is a strict upgrade over `def` (more powerful → costs more).
export function isUpgrade(chosen: string | undefined, def: string | undefined): boolean {
  const c = modelRank(chosen);
  return c >= 0 && c > modelRank(def);
}

// Canonical ids for the override dropdown, cheapest → most powerful.
export const MODEL_CHOICES: { id: string; label: string }[] = [
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku' },
  { id: 'claude-fable-5', label: 'Fable' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet' },
  { id: 'claude-opus-4-8', label: 'Opus' },
];
