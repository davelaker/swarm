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
import { getState, swarmDir, stateFile } from '../state/repo.js';
import type { SwarmEvent, SwarmState, Task } from '../state/types.js';

type SseClient = http.ServerResponse;

const clients = new Set<SseClient>();

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

    // New finding written
    if (task.result_ref && task.result_ref !== old?.result_ref) {
      fanout({ type: 'finding.written', task_id: task.id, path: task.result_ref });
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
      const state = getState();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(state));
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No .swarm/state.json — run `swarm init` first.' }));
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
      console.log('[pm/message]', payload.text ?? '');
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (route === '/run/pause')  { res.writeHead(200); res.end(JSON.stringify({ ok: true })); return; }
    if (route === '/run/resume') { res.writeHead(200); res.end(JSON.stringify({ ok: true })); return; }
    if (route === '/run/abort')  { res.writeHead(200); res.end(JSON.stringify({ ok: true })); return; }

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
