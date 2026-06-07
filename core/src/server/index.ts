// Embedded HTTP server — GET /state, GET /events (SSE), POST /run/* + /pm/*
// The UI connects here; the orchestrator loop emits events into the same process.
// See UX.md §3 for the architecture diagram.
//
// Security note: this server binds to loopback only. Phase 3 adds per-session
// token auth and Origin checks (UX.md §3, THREATS.md S3). Not done here.

import http   from 'node:http';
import path   from 'node:path';
import fs     from 'node:fs';
import { bus }      from '../state/events.js';
import { getState } from '../state/repo.js';
import type { SwarmEvent } from '../state/types.js';

type SseClient = http.ServerResponse;

const clients = new Set<SseClient>();

function sendSse(res: SseClient, event: SwarmEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
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

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end(); return;
    }

    if (req.method === 'GET')  { handleGet(req, res, url);  return; }
    if (req.method === 'POST') { handlePost(req, res, url); return; }

    res.writeHead(405); res.end();
  });

  // Fan-out every bus event to all connected SSE clients.
  bus.on('swarm', (event) => {
    for (const client of clients) {
      try { sendSse(client, event); } catch { clients.delete(client); }
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`  ▸ server     → http://localhost:${port}`);
  });

  return server;
}
