// Request guard — the browser boundary for the localhost API (THREATS.md S3).
// The server binds 127.0.0.1, but "localhost" is not a boundary a browser
// respects: without these checks any web page the user visits can drive every
// endpoint (fetch/EventSource reach localhost cross-origin, and DNS rebinding
// defeats the bind address). Two rules close both vectors:
//
//   HOST   must be the server's own localhost authority — kills DNS rebinding,
//          where an attacker domain resolves to 127.0.0.1 but carries its own
//          Host header.
//   ORIGIN when present, must be the dashboard itself (prod on the server's own
//          port, or the Vite dev server). Browsers attach Origin to all POSTs
//          and to EventSource, so a foreign page can never reach a mutating
//          route or the SSE stream. Absent Origin = non-browser client (curl,
//          scripts) or same-origin GET — allowed, matching the localhost trust
//          model. "null" Origin (sandboxed iframes, file://) is rejected.
//
// Pure — trivially testable. No CORS headers exist anywhere anymore: the UI is
// same-origin in prod (served from this server) and in dev (Vite proxy).

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
}

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1'];

// Vite's dev server proxies API calls but forwards the browser's Origin header.
const DEV_ORIGIN_PORT = 5173;

function allowedOrigins(port: number): Set<string> {
  const origins = new Set<string>();
  for (const host of LOCAL_HOSTNAMES) {
    origins.add(`http://${host}:${port}`);
    origins.add(`http://${host}:${DEV_ORIGIN_PORT}`);
  }
  return origins;
}

export function checkRequest(
  host: string | undefined,
  origin: string | undefined,
  port: number,
): GuardVerdict {
  const allowedHosts = new Set(LOCAL_HOSTNAMES.map(h => `${h}:${port}`));
  if (!host || !allowedHosts.has(host.toLowerCase())) {
    return { ok: false, reason: `Host not allowed: ${host ?? '(missing)'}` };
  }
  if (origin !== undefined && !allowedOrigins(port).has(origin.toLowerCase())) {
    return { ok: false, reason: `Origin not allowed: ${origin}` };
  }
  return { ok: true };
}
