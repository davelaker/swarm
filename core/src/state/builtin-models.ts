import * as fs from 'node:fs';
import * as path from 'node:path';
import { getRoot } from './repo.js';

export interface BuiltinModels {
  pm: string;
  coder: string;
  tester: string;
  reviewer: string;
  security: string;
}

// Per-agent defaults — match the cost-aware defaults in config.ts (sonnet for the
// reasoning agents, haiku for the cheap structured ones) so the dispatched model
// equals what the UI shows as the agent's "default". The user overrides these in
// the BuiltinDrawer model selector.
const DEFAULT: BuiltinModels = {
  pm: 'claude-sonnet-4-6',
  coder: 'claude-sonnet-4-6',
  tester: 'claude-haiku-4-5-20251001',
  reviewer: 'claude-sonnet-4-6',
  security: 'claude-haiku-4-5-20251001',
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
