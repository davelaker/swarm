// Per-project custom instruction overlays for built-in agents.
// Stored in .swarm/builtin-instructions.json alongside roster.json.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getRoot } from './repo.js';

export interface BuiltinInstructions {
  pm: string;
  coder: string;
  tester: string;
  reviewer: string;
  security: string;
}

const DEFAULT: BuiltinInstructions = { pm: '', coder: '', tester: '', reviewer: '', security: '' };

function filePath(): string {
  return path.join(getRoot(), '.swarm', 'builtin-instructions.json');
}

export function loadBuiltinInstructions(): BuiltinInstructions {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    return { ...DEFAULT, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveBuiltinInstructions(data: Partial<BuiltinInstructions>): void {
  const merged = { ...loadBuiltinInstructions(), ...data };
  const p = filePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
