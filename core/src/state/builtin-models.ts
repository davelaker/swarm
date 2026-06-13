import * as fs   from 'node:fs';
import * as path from 'node:path';
import { getRoot } from './repo.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

export interface BuiltinModels {
  pm:       string;
  coder:    string;
  tester:   string;
  reviewer: string;
  security: string;
}

const DEFAULT: BuiltinModels = {
  pm: DEFAULT_MODEL, coder: DEFAULT_MODEL, tester: DEFAULT_MODEL,
  reviewer: DEFAULT_MODEL, security: DEFAULT_MODEL,
};

function filePath(): string {
  return path.join(getRoot(), '.swarm', 'builtin-models.json');
}

export function loadBuiltinModels(): BuiltinModels {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    return { ...DEFAULT, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveBuiltinModels(data: Partial<BuiltinModels>): void {
  const merged = { ...loadBuiltinModels(), ...data };
  const p = filePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
