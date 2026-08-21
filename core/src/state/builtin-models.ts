import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateProviderModel } from '../providers/index.js';
import { getRoot } from './repo.js';

export interface BuiltinModels {
  pm: string;
  coder: string;
  tester: string;
  reviewer: string;
  security: string;
  scout: string;
  negotiator: string;
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
  scout: 'claude-haiku-4-5-20251001',
  negotiator: 'claude-sonnet-4-6',
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
  for (const [agent, modelId] of Object.entries(merged)) {
    try {
      validateProviderModel(modelId);
    } catch (error) {
      throw new Error(`Invalid model for built-in agent \"${agent}\": ${(error as Error).message}`);
    }
  }
  const p = filePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
