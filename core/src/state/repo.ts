// Principle 3 — state access behind a repository interface.
// Every read/write in the codebase goes through these functions.
// Swapping state.json for Postgres later touches only this file.

import fs    from 'node:fs';
import fsp   from 'node:fs/promises';
import path  from 'node:path';
import { bus }           from './events.js';
import type { SwarmState, Task, TaskStatus, LogEntry } from './types.js';

// ─── Mutable project root ─────────────────────────────────────────────────────
// Initialised from process.cwd() at startup; can be changed at runtime via
// setRoot() so the server can switch working folders without restarting.

let _root: string = process.cwd();

export function getRoot(): string { return _root; }
export function setRoot(r: string): void { _root = r; }

export function swarmDir(): string {
  return path.join(_root, '.swarm');
}

export function stateFile(): string {
  return path.join(swarmDir(), 'state.json');
}

export function findingsDir(): string {
  return path.join(swarmDir(), 'findings');
}

export function projectContextFile(): string {
  return path.join(swarmDir(), 'PROJECT.md');
}

// Returns the content of .swarm/PROJECT.md, or null if it doesn't exist yet.
export function loadProjectContext(): string | null {
  const file = projectContextFile();
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

// Bounded loader — caps output to maxChars to prevent large PROJECT.md files
// from ballooning every agent call. Appends a truncation notice when cut.
export function loadProjectContextBounded(maxChars = 8192): string | null {
  const full = loadProjectContext();
  if (!full) return null;
  if (full.length <= maxChars) return full;
  return full.slice(0, maxChars) +
    `\n\n[PROJECT.md truncated at ${maxChars} chars — edit .swarm/PROJECT.md to trim it]`;
}

// Write or update the ## Deployment section in .swarm/PROJECT.md.
// Creates the file if it doesn't exist yet.
export function writeDeploymentInfo(info: string): void {
  const file = projectContextFile();

  if (!fs.existsSync(file)) {
    const project = path.basename(_root);
    const content = [
      '<!-- swarm:context — read this file at the start of every task, update it when architecture or conventions change -->',
      `# Project: ${project}`,
      '',
      '## Deployment',
      info,
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return;
  }

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const deployIdx = lines.findIndex(l => l.trim() === '## Deployment');

  if (deployIdx === -1) {
    // Insert before ## Features section, or append
    const featIdx = lines.findIndex(l => l.startsWith('## Features'));
    const insert  = ['## Deployment', info, ''];
    if (featIdx !== -1) {
      lines.splice(featIdx, 0, ...insert, '');
    } else {
      lines.push('', ...insert);
    }
  } else {
    // Replace everything from deployIdx+1 until the next ## heading (or EOF)
    const endIdx = lines.findIndex((l, i) => i > deployIdx && l.startsWith('## '));
    const end    = endIdx === -1 ? lines.length : endIdx;
    lines.splice(deployIdx + 1, end - deployIdx - 1, info, '');
  }

  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
  fs.renameSync(tmp, file);
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
