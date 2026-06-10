// Embedded HTTP server — GET /state, GET /events (SSE), POST /run/* + /pm/*
//
// Two event sources feed the SSE stream:
//   1. In-process bus  — api-key driver: events emitted by the state repository
//   2. File watcher    — agent-sdk driver: `claude -p` subprocess writes state.json
//                        directly; we detect changes and diff to emit events
//
// Both feed the same `fanout()` function → all SSE clients.
// See UX.md §3 for the architecture diagram.

import http      from 'node:http';
import path      from 'node:path';
import fs        from 'node:fs';
import { execFile }  from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { bus }      from '../state/events.js';
import { getRoot, setRoot, getState, swarmDir, stateFile, projectContextFile, writeDeploymentInfo, appendLog } from '../state/repo.js';
import { runPmMessage } from '../pm/index.js';
import { runNew, checkGitClean } from '../commands/new.js';
import { pauseRun, resumeRun, abortRun } from '../loop-control.js';
import { getConfigOptional } from '../config.js';
import { getDriverMode }     from '../drivers/index.js';
import type { SwarmEvent, SwarmState, Task } from '../state/types.js';

type SseClient = http.ServerResponse;

const clients = new Set<SseClient>();

// ─── Active-run guard ─────────────────────────────────────────────────────────
// Prevents a second Execute while agents are running. Without this, an HMR
// hot-reload during a run would dump the user back on Planning with Execute
// still enabled — a second click would spawn duplicate agents.
let activeRun = false;

// ─── File-watcher lifecycle ───────────────────────────────────────────────────
// Module-level ref so /project/switch can stop & restart the watcher when
// the root directory changes.
let stopCurrentWatcher: (() => void) = () => {};

function restartWatcher(): void {
  stopCurrentWatcher();
  stopCurrentWatcher = startFileWatcher();
}

// ─── GitHub URL detection ─────────────────────────────────────────────────────
// Reads `origin` once at startup and caches the result. The /state handler
// reads the cached value synchronously — no async needed there.

let githubUrl: string | null = null;

function detectGithubUrl(): void {
  execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: getRoot() })
    .then(({ stdout }) => {
      const raw = stdout.trim();
      // SSH:   git@github.com:user/repo.git
      // HTTPS: https://github.com/user/repo.git  (or without .git)
      const sshMatch   = raw.match(/^git@github\.com:(.+?)(?:\.git)?$/);
      const httpsMatch = raw.match(/^https?:\/\/github\.com\/(.+?)(?:\.git)?$/);
      const slug = sshMatch?.[1] ?? httpsMatch?.[1];
      if (slug) githubUrl = `https://github.com/${slug}`;
    })
    .catch(() => { /* not a git repo or no origin — leave null */ });
}

function sendSse(res: SseClient, event: SwarmEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function fanout(event: SwarmEvent): void {
  for (const client of clients) {
    try { sendSse(client, event); } catch { clients.delete(client); }
  }
}

// ─── File watcher ─────────────────────────────────────────────────────────────
// Detects changes to state.json (written by either driver) and emits the right
// SSE events by diffing old vs new state.

function diffAndEmit(prev: SwarmState | null, next: SwarmState): void {
  if (!prev) {
    // First snapshot — emit current task graph so the UI can initialise
    fanout({ type: 'run.classified', tier: next.tier, tasks: next.tasks as unknown as Task[] });
    return;
  }

  const prevById = new Map(prev.tasks.map(t => [t.id, t]));

  for (const task of next.tasks) {
    const old = prevById.get(task.id);
    if (!old) {
      fanout({ type: 'task.created', task: task as unknown as Task });
    } else if (old.status !== task.status) {
      fanout({ type: 'task.status_changed', task_id: task.id, status: task.status });

      // Synthesise agent lifecycle events from status transitions
      if (task.status === 'in_progress') {
        fanout({ type: 'agent.started', agent_id: task.assignee });
      } else if (task.status === 'done' || task.status === 'failed' || task.status === 'blocked') {
        fanout({ type: 'agent.finished', agent_id: task.assignee });
      }
    }

    // New finding written — parse frontmatter so the UI gets verdict+summary immediately
    if (task.result_ref && task.result_ref !== old?.result_ref) {
      let verdict: string | undefined;
      let summary: string | undefined;
      try {
        const abs     = path.resolve(swarmDir(), task.result_ref);
        const content = fs.readFileSync(abs, 'utf8');
        const m       = content.match(/^---[\r\n]([\s\S]*?)[\r\n]---/);
        if (m) {
          for (const line of m[1].split('\n')) {
            const colon = line.indexOf(':');
            if (colon < 1) continue;
            const k = line.slice(0, colon).trim();
            const v = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
            if (k === 'verdict') verdict = v;
            if (k === 'summary') summary = v;
          }
        }
      } catch { /* non-fatal — client falls back to path display */ }
      fanout({ type: 'finding.written', task_id: task.id, path: task.result_ref, verdict, summary });
    }
  }

  // Log entries are forwarded by repo.appendLog() via the in-process bus — the bus
  // handler in repo.ts always emits log.appended synchronously, so we do NOT
  // re-emit them here. Doing so causes every PM message to appear twice (once from
  // the bus, once from the file-watcher diff). The file-watcher path only covers
  // events that the bus cannot: task graph changes, findings, and run lifecycle.

  // Run completed
  if (next.tasks.length > 0 && next.tasks.every(t => t.status === 'done') &&
      !prev.tasks.every(t => t.status === 'done')) {
    fanout({ type: 'run.completed' });
  }

  // Run blocked / any failure
  const nowBlocked = next.tasks.some(t => t.status === 'failed' || t.status === 'blocked');
  const wasBlocked = prev.tasks.some(t => t.status === 'failed' || t.status === 'blocked');
  if (nowBlocked && !wasBlocked) {
    const reason = next.tasks.find(t => t.status === 'failed' || t.status === 'blocked')?.id ?? 'unknown';
    fanout({ type: 'run.blocked', reason });
  }
}

// Returns a stop() fn that closes all watchers — call before switching root.
function startFileWatcher(): () => void {
  let lastState: SwarmState | null = null;
  let watcher:   ReturnType<typeof fs.watch> | null = null;
  let stopped = false;

  const tryRead = (): SwarmState | null => {
    try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); }
    catch { return null; }
  };

  const attach = (): void => {
    if (stopped || watcher) return;
    const sf = stateFile();
    if (!fs.existsSync(sf)) return;

    lastState = tryRead();
    console.log('  ▸ watching   → .swarm/state.json');

    watcher = fs.watch(sf, () => {
      // A rename (atomic write) closes the old inode — re-attach
      watcher?.close(); watcher = null;
      if (!stopped) setTimeout(attach, 50);

      const next = tryRead();
      if (!next) return;
      try { diffAndEmit(lastState, next); } catch { /* diff error — skip */ }
      lastState = next;
    });
  };

  // Also watch the .swarm/ directory in case state.json is created after the server starts
  const dir = swarmDir();
  let dirWatcher: ReturnType<typeof fs.watch> | null = null;
  if (fs.existsSync(dir)) {
    attach();
    dirWatcher = fs.watch(dir, (_ev, name) => { if (name === 'state.json') attach(); });
  } else {
    // Watch parent until .swarm/ is created
    const parent = path.dirname(dir);
    if (fs.existsSync(parent)) {
      const pw = fs.watch(parent, (_ev, name) => {
        if (stopped) { pw.close(); return; }
        if (name === path.basename(dir) && fs.existsSync(dir)) {
          pw.close();
          attach();
          dirWatcher = fs.watch(dir, (_ev2, name2) => { if (name2 === 'state.json') attach(); });
        }
      });
    }
  }

  return () => {
    stopped = true;
    watcher?.close();   watcher    = null;
    dirWatcher?.close(); dirWatcher = null;
  };
}

function handleGet(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  if (url.pathname === '/state') {
    try {
      const state  = getState();
      const driver = getDriverMode();
      const cfg    = getConfigOptional();
      // model: for agent-sdk the session model is chosen by the claude CLI, not us;
      // for api-key we know the exact model ID from config.
      const model  = driver === 'agent-sdk' ? null : cfg.coderModel;

      // Enrich tasks with finding verdict+summary so the UI can populate
      // the findings panel on initial load (not just via SSE events).
      const enrichedTasks = (state.tasks as unknown as Record<string, unknown>[]).map(t => {
        const ref = t.result_ref as string | null;
        if (!ref) return t;
        try {
          const abs     = path.resolve(swarmDir(), ref);
          const content = fs.readFileSync(abs, 'utf8');
          const m       = content.match(/^---[\r\n]([\s\S]*?)[\r\n]---/);
          if (!m) return t;
          let verdict: string | undefined, summary: string | undefined;
          for (const line of m[1].split('\n')) {
            const colon = line.indexOf(':');
            if (colon < 1) continue;
            const k = line.slice(0, colon).trim();
            const v = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
            if (k === 'verdict') verdict = v;
            if (k === 'summary') summary = v;
          }
          return { ...t, finding_verdict: verdict, finding_summary: summary };
        } catch { return t; }
      });

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ...state, tasks: enrichedTasks, driver, model, activeRun, repoUrl: githubUrl, root: getRoot() }));
    } catch {
      // No state.json yet (no run started) — still return 200 so the UI
      // recognises the server as up and shows "agents ready" instead of "offline".
      const driver = getDriverMode();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ project: '', goal: '', tier: '', tasks: [], log: [], driver, model: null, activeRun: false, repoUrl: githubUrl, root: getRoot() }));
    }
    return;
  }

  if (url.pathname === '/context') {
    const SKIP = new Set(['node_modules', '.git', '.swarm', 'dist', '.next', 'build', 'coverage', '__pycache__', '.venv']);
    const contextFiles: Array<{ relPath: string; content: string }> = [];

    const scan = (dir: string, depth: number): void => {
      if (depth > 6) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) {
          scan(path.join(dir, e.name), depth + 1);
        } else if (e.isFile() && e.name === 'CONTEXT.md') {
          try {
            const abs = path.join(dir, e.name);
            contextFiles.push({ relPath: path.relative(getRoot(), abs), content: fs.readFileSync(abs, 'utf8') });
          } catch { /* skip unreadable */ }
        }
      }
    };
    scan(getRoot(), 0);
    contextFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));

    const pcf  = projectContextFile();
    const projectMd = fs.existsSync(pcf)
      ? { relPath: 'CLAUDE.md', content: fs.readFileSync(pcf, 'utf8') }
      : null;

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ projectMd, contextFiles }));
    return;
  }

  if (url.pathname === '/run/diff') {
    const cwd = path.dirname(swarmDir());

    // Build a unified diff that covers:
    //   A) modifications to tracked files  → git diff HEAD
    //   B) new untracked files             → git diff --no-index /dev/null <file>
    //      (git diff always exits 1 when files differ; catch stderr and use stdout)
    // If both are empty, fall back to committed changes ahead of main/master/HEAD~1.

    Promise.all([
      // A — tracked modifications
      execFileAsync('git', ['diff', 'HEAD'], { cwd }).then(r => r.stdout).catch(() => ''),
      // Get untracked files (excluding gitignored)
      execFileAsync('git', ['status', '--porcelain'], { cwd }).then(r => r.stdout).catch(() => ''),
    ])
      .then(async ([trackedDiff, statusOut]) => {
        const untrackedFiles = statusOut.split('\n')
          .filter(l => l.startsWith('??'))
          .map(l => l.slice(3).trim())
          .filter(f => f && !f.endsWith('/'));

        // B — new files: git diff --no-index always exits 1, so extract stdout from the error
        const newFileDiffs = await Promise.all(
          untrackedFiles.map(f =>
            execFileAsync('git', ['diff', '--no-index', '--', '/dev/null', f], { cwd })
              .then(r => r.stdout)
              .catch((err: { stdout?: Buffer }) => err.stdout?.toString() ?? '')
          )
        );

        const combined = [trackedDiff, ...newFileDiffs].filter(s => s.trim()).join('\n');

        if (combined.trim()) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(combined);
          return;
        }

        // Fallback: committed changes ahead of main / master / last commit
        const fallbacks = [
          ['diff', 'main...HEAD'],
          ['diff', 'master...HEAD'],
          ['diff', 'HEAD~1'],
        ];
        for (const args of fallbacks) {
          try {
            const { stdout } = await execFileAsync('git', args, { cwd });
            if (stdout.trim()) {
              res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
              res.end(stdout);
              return;
            }
          } catch { /* try next */ }
        }

        // Genuinely nothing to show
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end('');
      })
      .catch(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end('');
      });
    return;
  }

  if (url.pathname === '/findings') {
    const relPath = url.searchParams.get('path');
    if (!relPath) { res.writeHead(400); res.end('path required'); return; }
    try {
      const abs = path.resolve(swarmDir(), relPath);
      // Safety: must stay inside .swarm/
      if (!abs.startsWith(swarmDir())) { res.writeHead(403); res.end('forbidden'); return; }
      const content = fs.readFileSync(abs, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(content);
    } catch {
      res.writeHead(404); res.end('not found');
    }
    return;
  }

  if (url.pathname === '/fs') {
    // Returns subdirectories of a given path for the project-switcher browser.
    const rawPath = url.searchParams.get('path') || getRoot();
    const target  = path.resolve(rawPath);
    try {
      const entries = fs.readdirSync(target, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => {
          const full = path.join(target, e.name);
          const hasSwarm = fs.existsSync(path.join(full, '.swarm', 'state.json'));
          return { name: e.name, path: full, hasSwarm };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(target) !== target ? path.dirname(target) : null;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ path: target, parent, entries: dirs }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ path: target, parent: null, entries: [], error: 'Cannot read directory' }));
    }
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n'); // initial ping so the client knows it's connected

    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Serve the built UI from ui/dist if it exists, otherwise 404.
  const uiDist = path.resolve(import.meta.dirname, '../../..', 'ui', 'dist');
  if (fs.existsSync(uiDist)) {
    let filePath = path.join(uiDist, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!fs.existsSync(filePath)) filePath = path.join(uiDist, 'index.html'); // SPA fallback
    const ext = path.extname(filePath);
    const mime: Record<string, string> = {
      '.html': 'text/html', '.js': 'application/javascript',
      '.css': 'text/css',   '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon', '.png': 'image/png',
    };
    res.writeHead(200, { 'Content-Type': mime[ext] ?? 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

function handlePost(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  // Actions from the UI — Phase 3 wires these to real orchestrator state.
  // Stubs that acknowledge and return 200 so the UI doesn't error.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', async () => {
    const payload = body ? JSON.parse(body) : {};
    const route   = url.pathname;

    if (route === '/pm/message') {
      const { text, history = [], charter, team, activeRoot } = payload as {
        text:       string;
        history?:   unknown[];
        charter?:   { goal?: string; constraints?: string[]; nongoals?: string[]; questions?: string[] };
        team?:      string[];
        activeRoot?: string;  // client's localStorage swarm-active-root — used to self-heal server root on startup
      };
      if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: 'text required' })); return; }
      // If the client knows a different root than the server (e.g. after a restart before auto-sync),
      // apply it now so this PM call — and all subsequent state — uses the correct project.
      if (activeRoot && activeRoot !== getRoot()) {
        const resolved = path.resolve(activeRoot.trim());
        console.log(`[pm/message] self-healing root: ${getRoot()} → ${resolved}`);
        setRoot(resolved);
        restartWatcher();
      }
      runPmMessage(text, history as any, charter, team)
        .then(result => {
          if (result.deploymentInfo) {
            try { writeDeploymentInfo(result.deploymentInfo); } catch { /* non-fatal */ }
          }
          res.writeHead(200); res.end(JSON.stringify(result));
        })
        .catch(err => {
          console.error('[pm/message] error:', (err as Error).message);
          res.writeHead(500); res.end(JSON.stringify({ error: (err as Error).message }));
        });
      return;
    }
    if (route === '/run/message') {
      const { text } = payload as { text?: string };
      if (!text?.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'text required' })); return; }
      try {
        appendLog('user', text.trim());
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500); res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    if (route === '/run/execute') {
      if (activeRun) {
        res.writeHead(409); res.end(JSON.stringify({ error: 'A run is already in progress' })); return;
      }
      const { goal, charter, team } = payload as {
        goal?:    string;
        charter?: { constraints: string[]; nongoals: string[]; questions: string[]; branchMode?: 'branch' | 'main' };
        team?:    string[];
      };
      if (!goal?.trim()) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'goal required' })); return;
      }

      // ── Git safety check (synchronous, before 200) ───────────────────────────
      // Must run here — not inside the async runNew() — so we can return a 4xx
      // directly to the client. If we let it throw inside the async path the SSE
      // run.blocked event fires after the client's EventSource connects, causing
      // a race where the event is missed and the UI stays stuck on the Running tab.
      // Also use getRoot() so we check the TARGET project, not the swarm repo.
      try {
        checkGitClean(getRoot());
      } catch (err) {
        const msg = (err as Error).message;
        console.error('  ✗ execute error:', msg);
        res.writeHead(400); res.end(JSON.stringify({ error: msg })); return;
      }

      // Create a feature branch if the PM recommended one.
      let branchName: string | undefined;
      if (charter?.branchMode === 'branch') {
        const cwd  = path.dirname(swarmDir());
        const slug = goal.trim().toLowerCase()
          .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-').slice(0, 40).replace(/-+$/, '');
        const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        branchName = `swarm/${slug}-${date}`;
        try {
          // Try to create the branch; if it already exists (e.g. from a previously
          // blocked run) just check it out so the user can retry without manual cleanup.
          try {
            await execFileAsync('git', ['checkout', '-b', branchName], { cwd });
            console.log(`  ▸ created branch: ${branchName}`);
          } catch (createErr) {
            const stderr = (createErr as { stderr?: Buffer }).stderr?.toString() ?? '';
            if (stderr.includes('already exists')) {
              await execFileAsync('git', ['checkout', branchName], { cwd });
              console.log(`  ▸ resumed branch: ${branchName}`);
            } else {
              throw createErr;
            }
          }
        } catch (err) {
          const msg = (err as { stderr?: Buffer; message: string }).stderr?.toString().trim() || (err as Error).message;
          res.writeHead(400); res.end(JSON.stringify({ error: `Could not create branch: ${msg}` })); return;
        }
      }

      activeRun = true;
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      console.log(`\n  ▸ execute: "${goal}"\n`);
      runNew(goal.trim(), charter, team, branchName)
        .catch(err => {
          const msg = (err as Error).message ?? 'Unknown error';
          console.error('  ✗ execute error:', msg);
          // Surface the failure to the UI via SSE so the user knows what happened.
          fanout({ type: 'run.blocked', reason: msg });
        })
        .finally(() => { activeRun = false; });
      return;
    }
    if (route === '/run/pause') {
      pauseRun();
      fanout({ type: 'run.paused' });
      res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
    }
    if (route === '/run/resume') {
      resumeRun();
      fanout({ type: 'run.classified', tier: 'feature', tasks: [] }); // nudge UI back to running
      res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
    }
    if (route === '/run/abort') {
      abortRun();
      fanout({ type: 'run.aborted' });
      res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
    }

    if (route === '/run/push') {
      const cwd = path.dirname(swarmDir());
      execFileAsync('git', ['push', 'origin', 'HEAD'], { cwd })
        .then(() => {
          appendLog('pm', '⬆ Pushed to remote successfully');
          res.writeHead(200); res.end(JSON.stringify({ ok: true }));
        })
        .catch((err: { stderr?: Buffer; message: string }) => {
          const msg = (err.stderr?.toString().trim() || err.message).slice(0, 300);
          appendLog('pm', `✗ Push failed: ${msg}`);
          res.writeHead(200); res.end(JSON.stringify({ ok: false, error: msg }));
        });
      return;
    }

    if (route === '/run/pr') {
      let state: ReturnType<typeof getState>;
      try { state = getState(); } catch {
        res.writeHead(400); res.end(JSON.stringify({ error: 'No run state found' })); return;
      }
      const cwd   = path.dirname(swarmDir());
      const title = state.goal.slice(0, 120);
      const parts: string[] = [state.goal];
      const constraints = state.charter?.constraints ?? [];
      const nongoals    = state.charter?.nongoals    ?? [];
      if (constraints.length) parts.push('## Constraints\n' + constraints.map(c => `- ${c}`).join('\n'));
      if (nongoals.length)    parts.push('## Non-goals\n'   + nongoals.map(n => `- ${n}`).join('\n'));
      parts.push('🤖 Generated with Agent Swarm');
      const body = parts.join('\n\n');

      execFileAsync('gh', ['pr', 'create', '--title', title, '--body', body], { cwd })
        .then(({ stdout }) => {
          const url = stdout.trim().match(/https:\/\/\S+/)?.[0] ?? undefined;
          appendLog('pm', `⬆ PR created${url ? `: ${url}` : ''}`);
          res.writeHead(200); res.end(JSON.stringify({ ok: true, url: url ?? null }));
        })
        .catch((err: { stderr?: Buffer; message: string }) => {
          const msg = (err.stderr?.toString().trim() || err.message).slice(0, 300);
          appendLog('pm', `✗ PR creation failed: ${msg}`);
          res.writeHead(200); res.end(JSON.stringify({ ok: false, error: msg }));
        });
      return;
    }

    if (route === '/project/switch') {
      if (activeRun) {
        res.writeHead(409); res.end(JSON.stringify({ error: 'Cannot switch projects while a run is in progress' })); return;
      }
      const { path: newPath } = payload as { path?: string };
      if (!newPath?.trim()) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'path required' })); return;
      }
      const resolved = path.resolve(newPath.trim());
      if (!fs.existsSync(resolved)) {
        res.writeHead(400); res.end(JSON.stringify({ error: `Directory not found: ${resolved}` })); return;
      }
      try {
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Path is not a directory' })); return;
        }
      } catch {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Cannot access path' })); return;
      }

      // Switch root, restart watcher, refresh GitHub URL
      setRoot(resolved);
      restartWatcher();
      githubUrl = null;
      detectGithubUrl();

      const project  = path.basename(resolved);
      const hasSwarm = fs.existsSync(path.join(resolved, '.swarm', 'state.json'));
      console.log(`  ▸ switched   → ${resolved}`);

      res.writeHead(200); res.end(JSON.stringify({ ok: true, project, hasSwarm, repoUrl: githubUrl }));
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'unknown route' }));
  });
}

export function startServer(port: number): http.Server {
  // Kick off GitHub URL detection immediately — result is cached and used by /state.
  // Fire-and-forget; if git isn't available the cached value stays null.
  detectGithubUrl();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end(); return;
    }

    if (req.method === 'GET')  { handleGet(req, res, url);  return; }
    if (req.method === 'POST') { handlePost(req, res, url); return; }

    res.writeHead(405); res.end();
  });

  // Source 1: in-process bus (api-key driver emits here via state repo)
  bus.on('swarm', fanout);

  // Source 2: file watcher (agent-sdk driver writes state.json as subprocess)
  stopCurrentWatcher = startFileWatcher();

  server.listen(port, '127.0.0.1', () => {
    console.log(`  ▸ server     → http://localhost:${port}`);
  });

  return server;
}
