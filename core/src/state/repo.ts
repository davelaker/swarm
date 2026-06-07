// Principle 3 — state access behind a repository interface.
// Every read/write in the codebase goes through these functions.
// Swapping state.json for Postgres later touches only this file.

import fs    from 'node:fs';
import fsp   from 'node:fs/promises';
import path  from 'node:path';
import { bus }           from './events.js';
import type { SwarmState, Task, TaskStatus, LogEntry } from './types.js';

export function swarmDir(): string {
  return path.join(process.cwd(), '.swarm');
}

export function stateFile(): string {
  return path.join(swarmDir(), 'state.json');
}

export function findingsDir(): string {
  return path.join(swarmDir(), 'findings');
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export function getState(): SwarmState {
  const raw = fs.readFileSync(stateFile(), 'utf8');
  return JSON.parse(raw) as SwarmState;
}

// ─── Write (crash-atomic) ─────────────────────────────────────────────────────

// Write-temp-then-rename is the only crash-safe pattern for a single-file store.
// A crash mid-write leaves the .tmp file; on restart the rename never happened,
// so state.json is intact. (DESIGN §6.4)
function writeState(state: SwarmState): void {
  state.updated_at = new Date().toISOString();
  const file = stateFile();
  const tmp  = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ─── Mutations — all emit events ─────────────────────────────────────────────

// Only the PM calls updateTask with status changes. Workers call writeFinding.
// This enforces DESIGN §5.3: "only the PM writes task status."
export function updateTask(taskId: string, updates: Partial<Task>): void {
  const state = getState();
  const idx   = state.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) throw new Error(`Task ${taskId} not found`);

  const before = state.tasks[idx];
  state.tasks[idx] = { ...before, ...updates };
  writeState(state);

  if (updates.status && updates.status !== before.status) {
    bus.emit('swarm', { type: 'task.status_changed', task_id: taskId, status: updates.status });
  }
}

export function addTask(task: Task): void {
  const state = getState();
  if (state.tasks.find(t => t.id === task.id)) {
    throw new Error(`Task ${task.id} already exists`);
  }
  state.tasks.push(task);
  writeState(state);
  bus.emit('swarm', { type: 'task.created', task });
}

export function appendLog(actor: string, event: string): void {
  const state  = getState();
  const entry: LogEntry = { ts: new Date().toISOString(), actor, event };
  state.log.push(entry);
  writeState(state);
  bus.emit('swarm', { type: 'log.appended', actor, event });
}

// Workers write findings; PM reads them via result_ref.
// Finding prose is free-form but frontmatter must conform to DESIGN §6.2a.
export async function writeFinding(taskId: string, content: string): Promise<string> {
  const dir  = findingsDir();
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${taskId}.md`);
  await fsp.writeFile(file, content, 'utf8');

  const state = getState();
  const idx   = state.tasks.findIndex(t => t.id === taskId);
  if (idx !== -1) {
    state.tasks[idx].result_ref = path.relative(swarmDir(), file);
    writeState(state);
  }

  bus.emit('swarm', { type: 'finding.written', task_id: taskId, path: file });
  return file;
}

// ─── Initialise a fresh workspace ────────────────────────────────────────────

export function initWorkspace(project: string, goal: string, tier: SwarmState['tier'] = 'tweak'): void {
  const dir = swarmDir();
  fs.mkdirSync(path.join(dir, 'findings'), { recursive: true });

  const initial: SwarmState = {
    project,
    owner:      'me',
    goal,
    tier,
    updated_at: new Date().toISOString(),
    tasks:      [],
    log:        [],
  };

  // Only write if state.json doesn't exist — never clobber existing state.
  if (!fs.existsSync(stateFile())) {
    fs.writeFileSync(stateFile(), JSON.stringify(initial, null, 2), 'utf8');
  }
}
