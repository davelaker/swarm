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
