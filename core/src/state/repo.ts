// Principle 3 — state access behind a repository interface.
// Every read/write in the codebase goes through these functions.
// Swapping state.json for Postgres later touches only this file.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { bus } from './events.js';
import type { SwarmState, Task, TaskStatus, LogEntry } from './types.js';

// ─── Mutable project root ─────────────────────────────────────────────────────
// Initialised from process.cwd() at startup; can be changed at runtime via
// setRoot() so the server can switch working folders without restarting.

let _root: string = process.cwd();

export function getRoot(): string {
  return _root;
}
export function setRoot(r: string): void {
  _root = r;
}

export function swarmDir(): string {
  return path.join(_root, '.swarm');
}

export function stateFile(): string {
  return path.join(swarmDir(), 'state.json');
}

export function findingsDir(): string {
  return path.join(swarmDir(), 'findings');
}

// CLAUDE.md lives at the project root — readable by any Claude Code session
// or Claude-based agent without knowing about swarm's internal structure.
export function projectContextFile(): string {
  return path.join(_root, 'CLAUDE.md');
}

// Returns the content of CLAUDE.md, or null if it doesn't exist yet.
export function loadProjectContext(): string | null {
  const file = projectContextFile();
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  // Fallback: legacy .swarm/PROJECT.md so existing projects still work.
  const legacy = path.join(swarmDir(), 'PROJECT.md');
  return fs.existsSync(legacy) ? fs.readFileSync(legacy, 'utf8') : null;
}

// Bounded loader — caps output to maxChars to prevent large CLAUDE.md files
// from ballooning every agent call. Appends a truncation notice when cut.
export function loadProjectContextBounded(maxChars = 8192): string | null {
  const full = loadProjectContext();
  if (!full) return null;
  if (full.length <= maxChars) return full;
  return (
    full.slice(0, maxChars) +
    `\n\n[CLAUDE.md truncated at ${maxChars} chars — edit CLAUDE.md to trim it]`
  );
}

// ─── Subdirectory context files ───────────────────────────────────────────────
// Scans for CLAUDE.md and CONTEXT.md files in subdirectories (not the root
// CLAUDE.md, which is loaded separately). Used to give the PM product-level
// context from monorepos and multi-package projects before planning begins.

const SUBDIR_CTX_NAMES = new Set(['CLAUDE.md', 'CONTEXT.md']);
const SUBDIR_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.swarm',
  'dist',
  '.next',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
  '.cache',
  'tmp',
  'vendor',
  '.turbo',
  '.yarn',
  'out',
  'storybook-static',
]);

export interface SubdirFile {
  relPath: string;
  content: string;
  truncated: boolean;
}

function scanSubdirContextFiles(): Array<{ relPath: string; full: string }> {
  const root = _root;
  const rootClaude = path.join(root, 'CLAUDE.md');
  const results: Array<{ relPath: string; full: string }> = [];

  const scan = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !SUBDIR_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
        scan(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && SUBDIR_CTX_NAMES.has(e.name)) {
        const abs = path.join(dir, e.name);
        if (abs === rootClaude) continue;
        try {
          results.push({ relPath: path.relative(root, abs), full: fs.readFileSync(abs, 'utf8') });
        } catch {
          /* skip unreadable */
        }
      }
    }
  };

  scan(root, 0);
  results.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return results;
}

// Returns bounded subdirectory context for PM injection.
// Budget is shared proportionally across all files (min 512 chars each),
// so a monorepo with many CLAUDE.md files doesn't swamp the context window.
export function loadSubdirContextBounded(totalBudget = 16_000): SubdirFile[] {
  const raw = scanSubdirContextFiles();
  if (!raw.length) return [];
  const perFile = Math.max(512, Math.floor(totalBudget / raw.length));
  return raw.map(({ relPath, full }) => {
    if (full.length <= perFile) return { relPath, content: full, truncated: false };
    return {
      relPath,
      content: full.slice(0, perFile) + `\n\n[truncated — ${full.length} chars total]`,
      truncated: true,
    };
  });
}

// Write or update the Swarm Context section in CLAUDE.md.
// Creates the file if it doesn't exist yet. On existing files, replaces
// the ## Swarm Context block (or the legacy ## Deployment block) in place.
export function writeDeploymentInfo(info: string): void {
  const file = projectContextFile();
  const SECTION = '## Swarm Context';
  const LEGACY = '## Deployment';

  if (!fs.existsSync(file)) {
    const project = path.basename(_root);
    const content = [
      '<!-- swarm:context — read this file at the start of every task, update it when architecture or conventions change -->',
      `# Project: ${project}`,
      '',
      SECTION,
      '<!-- Added by Agent Swarm. Update manually if deployment details change. -->',
      '',
      `**Deployment:** ${info}`,
      '',
    ].join('\n');
    fs.writeFileSync(file, content, 'utf8');
    return;
  }

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  // Accept both the current heading and the legacy one for backward compatibility.
  const sectionIdx = lines.findIndex(l => l.trim() === SECTION || l.trim() === LEGACY);

  if (sectionIdx === -1) {
    // No existing Swarm section — append one.
    lines.push(
      '',
      SECTION,
      '<!-- Added by Agent Swarm. Update manually if deployment details change. -->',
      '',
      `**Deployment:** ${info}`,
      '',
    );
  } else {
    // Normalise heading to current name, then replace body until next ## heading.
    lines[sectionIdx] = SECTION;
    const endIdx = lines.findIndex((l, i) => i > sectionIdx && l.startsWith('## '));
    const end = endIdx === -1 ? lines.length : endIdx;
    lines.splice(
      sectionIdx + 1,
      end - sectionIdx - 1,
      '<!-- Added by Agent Swarm. Update manually if deployment details change. -->',
      '',
      `**Deployment:** ${info}`,
      '',
    );
  }

  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
  fs.renameSync(tmp, file);
}

const MEMORY_SECTION = '## Swarm Learnings';
const MEMORY_NOTE =
  '<!-- Maintained by Agent Swarm after each run. Durable, non-obvious project facts — edit freely. -->';

// Returns the current body of the managed Swarm Learnings section (between the
// heading and the next ## heading), or '' if there isn't one yet.
export function readProjectMemory(): string {
  const file = projectContextFile();
  if (!fs.existsSync(file)) {
    return '';
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex(l => l.trim() === MEMORY_SECTION);
  if (start === -1) {
    return '';
  }
  const endIdx = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  const end = endIdx === -1 ? lines.length : endIdx;
  return lines
    .slice(start + 1, end)
    .filter(l => l.trim() !== MEMORY_NOTE)
    .join('\n')
    .trim();
}

// Replace the managed Swarm Learnings section with the scribe's merged memory.
// No-op on empty input so we never write an empty section.
export function writeProjectMemory(learnings: string): void {
  const body = learnings.trim();
  if (!body) {
    return;
  }
  const file = projectContextFile();
  const block = [MEMORY_SECTION, MEMORY_NOTE, '', body, ''];

  if (!fs.existsSync(file)) {
    const project = path.basename(_root);
    fs.writeFileSync(file, [`# Project: ${project}`, '', ...block].join('\n'), 'utf8');
    return;
  }

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex(l => l.trim() === MEMORY_SECTION);
  if (start === -1) {
    lines.push('', ...block);
  } else {
    const endIdx = lines.findIndex((l, i) => i > start && l.startsWith('## '));
    const end = endIdx === -1 ? lines.length : endIdx;
    lines.splice(start, end - start, ...block);
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
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ─── Mutations — all emit events ─────────────────────────────────────────────

// Only the PM calls updateTask with status changes. Workers call writeFinding.
// This enforces DESIGN §5.3: "only the PM writes task status."
export function updateTask(taskId: string, updates: Partial<Task>): void {
  const state = getState();
  const idx = state.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) throw new Error(`Task ${taskId} not found`);

  const before = state.tasks[idx];
  state.tasks[idx] = { ...before, ...updates };
  writeState(state);

  if (updates.status && updates.status !== before.status) {
    bus.emit('swarm', {
      type: 'task.status_changed',
      task_id: taskId,
      status: updates.status,
      ...(updates.skip_reason ? { skip_reason: updates.skip_reason } : {}),
    });
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
  const state = getState();
  const entry: LogEntry = { ts: new Date().toISOString(), actor, event };
  state.log.push(entry);
  writeState(state);
  bus.emit('swarm', { type: 'log.appended', actor, event });
}

// Workers write findings; PM reads them via result_ref.
// Finding prose is free-form but frontmatter must conform to DESIGN §6.2a.
export async function writeFinding(taskId: string, content: string): Promise<string> {
  const dir = findingsDir();
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${taskId}.md`);

  // Write atomically (tmp + rename) so a watcher can never read a partial file
  // with missing frontmatter (which would surface as an undefined verdict).
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, file);

  const state = getState();
  const idx = state.tasks.findIndex(t => t.id === taskId);
  if (idx !== -1) {
    state.tasks[idx].result_ref = path.relative(swarmDir(), file);
    writeState(state);
  }

  // Parse verdict + summary from the frontmatter so the bus emit carries them.
  // Without these, a verdict-less finding.written could reach the client before
  // any verdict-carrying event and win the client's first-write dedup, making a
  // CHANGES_REQUESTED finding display as COMPLETE. (Mirror server/index.ts.)
  let verdict: string | undefined, summary: string | undefined;
  const m = content.match(/^---[\r\n]([\s\S]*?)[\r\n]---/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const colon = line.indexOf(':');
      if (colon < 1) continue;
      const k = line.slice(0, colon).trim();
      const v = line
        .slice(colon + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (k === 'verdict') verdict = v;
      if (k === 'summary') summary = v;
    }
  }

  bus.emit('swarm', { type: 'finding.written', task_id: taskId, path: file, verdict, summary });
  return file;
}

// ─── Session snapshots ────────────────────────────────────────────────────────
// Written to .swarm/sessions/<id>/ when a run completes.
// Each session directory contains:
//   index.json          — metadata + task list (no finding content)
//   findings/<taskId>.md — copies of the finding files

export function sessionsDir(): string {
  return path.join(swarmDir(), 'sessions');
}

export async function snapshotSession(): Promise<void> {
  let state: ReturnType<typeof getState>;
  try {
    state = getState();
  } catch {
    return;
  } // no state.json yet — skip

  const now = new Date();
  const ts = now.toISOString().slice(0, 19).replace(/T/, '-').replace(/:/g, '');
  const slug = state.goal
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '');
  const id = `${ts}-${slug}`;
  const dir = path.join(sessionsDir(), id);

  await fsp.mkdir(path.join(dir, 'findings'), { recursive: true });

  // Copy findings and parse verdict/summary for the task list
  const tasks = await Promise.all(
    state.tasks.map(async t => {
      let verdict: string | undefined;
      let summary: string | undefined;
      if (t.result_ref) {
        try {
          const src = path.resolve(swarmDir(), t.result_ref);
          const content = await fsp.readFile(src, 'utf8');
          const dst = path.join(dir, 'findings', `${t.id}.md`);
          await fsp.writeFile(dst, content, 'utf8');
          const m = content.match(/^---[\r\n]([\s\S]*?)[\r\n]---/);
          if (m) {
            for (const line of m[1].split('\n')) {
              const colon = line.indexOf(':');
              if (colon < 1) continue;
              const k = line.slice(0, colon).trim();
              const v = line
                .slice(colon + 1)
                .trim()
                .replace(/^["']|["']$/g, '');
              if (k === 'verdict') verdict = v;
              if (k === 'summary') summary = v;
            }
          }
        } catch {
          /* finding may not exist yet */
        }
      }
      return { ...t, finding_verdict: verdict, finding_summary: summary };
    }),
  );

  const logTs = state.log.map(e => new Date(e.ts).getTime()).filter(n => !isNaN(n));
  const elapsedMs = logTs.length >= 2 ? logTs[logTs.length - 1] - logTs[0] : undefined;

  const snapshot = {
    id,
    savedAt: now.toISOString(),
    project: state.project,
    goal: state.goal,
    tier: state.tier,
    branchName: state.branchName,
    charter: state.charter,
    tasks,
    log: state.log,
    elapsedMs,
  };

  await fsp.writeFile(path.join(dir, 'index.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`  ▸ session saved: .swarm/sessions/${id}/`);
}

// ─── Initialise a fresh workspace ────────────────────────────────────────────

// Ensure .swarm/ is listed in .gitignore so swarm metadata never lands in a PR.
// Idempotent: does nothing if the entry already exists.
function ensureGitignore(): void {
  const gitignorePath = path.join(_root, '.gitignore');
  const entry = '.swarm/';

  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    // Match ".swarm/" or ".swarm" at the start of a line (with optional trailing slash).
    if (/^\.swarm\/?$/m.test(content)) return;
    // Append the entry with a blank-line separator if the file doesn't end with one.
    const suffix = content.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gitignorePath, `${suffix}# swarm agent metadata\n${entry}\n`, 'utf8');
  } else {
    fs.writeFileSync(gitignorePath, `# swarm agent metadata\n${entry}\n`, 'utf8');
  }
}

export function initWorkspace(
  project: string,
  goal: string,
  tier: SwarmState['tier'] = 'bugfix',
): void {
  const dir = swarmDir();
  fs.mkdirSync(path.join(dir, 'findings'), { recursive: true });

  // Keep .swarm/ out of the repo — swarm metadata is not app code.
  ensureGitignore();

  const initial: SwarmState = {
    project,
    owner: 'me',
    goal,
    tier,
    updated_at: new Date().toISOString(),
    tasks: [],
    log: [],
  };

  // Only write if state.json doesn't exist — never clobber existing state.
  if (!fs.existsSync(stateFile())) {
    fs.writeFileSync(stateFile(), JSON.stringify(initial, null, 2), 'utf8');
  }
}
