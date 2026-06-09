// Embedded HTTP server — GET /state, GET /events (SSE), POST /run/* + /pm/*
//
// Two event sources feed the SSE stream:
//   1. In-process bus  — api-key driver: events emitted by the state repository
//   2. File watcher    — agent-sdk driver: `claude -p` subprocess writes state.json
//                        directly; we detect changes and diff to emit events
//
// Both feed the same `fanout()` function → all SSE clients.
// See UX.md §3 for the architecture diagram.

import http   from 'node:http';
import path   from 'node:path';
import fs     from 'node:fs';
import { bus }      from '../state/events.js';
import { getState, swarmDir, stateFile, projectContextFile, writeDeploymentInfo, appendLog } from '../state/repo.js';
import { runPmMessage } from '../pm/index.js';
import { runNew }       from '../commands/new.js';
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

  // New log entries → forward as agent.progress (step line in agents panel)
  const prevLen = prev.log.length;
  for (const entry of next.log.slice(prevLen)) {
    fanout({ type: 'log.appended', actor: entry.actor, event: entry.event });

    // Synthesise agent.progress for the ticking step line
    if (entry.actor !== 'pm' && entry.event.includes('dispatching') === false) {
      const step = entry.event.replace(/^[^:]+:\s*/, '').slice(0, 80);
      fanout({ type: 'agent.progress', agent_id: entry.actor, step });
    }
  }

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

function startFileWatcher(): void {
  let lastState: SwarmState | null = null;
  let watcher:   ReturnType<typeof fs.watch> | null = null;

  const tryRead = (): SwarmState | null => {
    try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); }
    catch { return null; }
  };

  const attach = (): void => {
    if (watcher) return;
    const sf = stateFile();
    if (!fs.existsSync(sf)) return;

    lastState = tryRead();
    console.log('  ▸ watching   → .swarm/state.json');

    watcher = fs.watch(sf, () => {
      // A rename (atomic write) closes the old inode — re-attach
      watcher?.close(); watcher = null;
      setTimeout(attach, 50);

      const next = tryRead();
      if (!next) return;
      try { diffAndEmit(lastState, next); } catch { /* diff error — skip */ }
      lastState = next;
    });
  };

  // Also watch the .swarm/ directory in case state.json is created after the server starts
  const dir = swarmDir();
  if (fs.existsSync(dir)) {
    attach();
    fs.watch(dir, (_ev, name) => { if (name === 'state.json') attach(); });
  } else {
    // Watch parent until .swarm/ is created
    const parent = path.dirname(dir);
    if (fs.existsSync(parent)) {
      const pw = fs.watch(parent, (_ev, name) => {
        if (name === path.basename(dir) && fs.existsSync(dir)) {
          pw.close();
          attach();
          fs.watch(dir, (_ev2, name2) => { if (name2 === 'state.json') attach(); });
        }
      });
    }
  }
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
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ...state, driver, model, activeRun }));
    } catch {
      // No state.json yet (no run started) — still return 200 so the UI
      // recognises the server as up and shows "agents ready" instead of "offline".
      const driver = getDriverMode();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ project: '', goal: '', tier: '', tasks: [], log: [], driver, model: null, activeRun: false }));
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
            contextFiles.push({ relPath: path.relative(process.cwd(), abs), content: fs.readFileSync(abs, 'utf8') });
          } catch { /* skip unreadable */ }
        }
      }
    };
    scan(process.cwd(), 0);
    contextFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));

    const pcf  = projectContextFile();
    const projectMd = fs.existsSync(pcf)
      ? { relPath: '.swarm/PROJECT.md', content: fs.readFileSync(pcf, 'utf8') }
      : null;

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ projectMd, contextFiles }));
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
  req.on('end', () => {
    const payload = body ? JSON.parse(body) : {};
    const route   = url.pathname;

    if (route === '/pm/message') {
      const { text, history = [], charter, team } = payload as {
        text:     string;
        history?: unknown[];
        charter?: { goal?: string; constraints?: string[]; nongoals?: string[]; questions?: string[] };
        team?:    string[];
      };
      if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: 'text required' })); return; }
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
        charter?: { constraints: string[]; nongoals: string[]; questions: string[] };
        team?:    string[];
      };
      if (!goal?.trim()) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'goal required' })); return;
      }
      activeRun = true;
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      console.log(`\n  ▸ execute: "${goal}"\n`);
      runNew(goal.trim(), charter, team)
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

    res.writeHead(404); res.end(JSON.stringify({ error: 'unknown route' }));
  });
}

export function startServer(port: number): http.Server {
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
  startFileWatcher();

  server.listen(port, '127.0.0.1', () => {
    console.log(`  ▸ server     → http://localhost:${port}`);
  });

  return server;
}
