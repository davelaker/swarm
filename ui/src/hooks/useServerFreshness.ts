import { useEffect, useState } from 'react';

export interface ServerFreshness {
  startedAt: number;
  newestSourceAt: number;
  stale: boolean;
  restartCommand: string;
}

// Polls the backend's /server/info so the dashboard can warn when the running
// process is older than the source on disk (tsx loads source once at startup,
// so backend edits don't take effect until a manual restart). Re-checks on a
// timer and whenever the tab regains focus — that's when a developer who just
// edited code flips back to the dashboard.
export function useServerFreshness(pollMs = 15_000): ServerFreshness | null {
  const [info, setInfo] = useState<ServerFreshness | null>(null);

  useEffect(() => {
    let mounted = true;
    const check = () => {
      fetch('/server/info', { signal: AbortSignal.timeout(2000) })
        .then(r => (r.ok ? r.json() : null))
        .then((d: ServerFreshness | null) => {
          if (mounted && d) {
            setInfo(d);
          }
        })
        .catch(() => {
          /* server down / restarting — leave the last reading, don't flap the UI */
        });
    };
    check();
    const timer = setInterval(check, pollMs);
    window.addEventListener('focus', check);
    return () => {
      mounted = false;
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [pollMs]);

  return info;
}
