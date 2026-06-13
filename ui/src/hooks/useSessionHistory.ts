import { useState, useEffect, useCallback } from 'react';
import type { SessionMeta, SessionSnapshot } from '../types';

export function useSessionHistory() {
  const [sessions,  setSessions]  = useState<SessionMeta[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    fetch('/sessions')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
      .then((d: { sessions: SessionMeta[] }) => {
        setSessions(d.sessions ?? []);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const loadSession = useCallback((id: string): Promise<SessionSnapshot> => {
    return fetch(`/sessions/${id}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)));
  }, []);

  return { sessions, loading, error, refresh, loadSession };
}
