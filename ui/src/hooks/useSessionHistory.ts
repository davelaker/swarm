import { useState, useEffect, useCallback, useRef } from 'react';
import type { SessionMeta, SessionSnapshot } from '../types';
import type { ProjectClient } from '../project/projectClient';

interface SessionsResponse {
  sessions: SessionMeta[];
}

export function useSessionHistory(projectClient: ProjectClient | null) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latestClientRef = useRef<ProjectClient | null>(projectClient);

  useEffect(() => {
    latestClientRef.current = projectClient;
  }, [projectClient]);

  const refresh = useCallback((signal?: AbortSignal) => {
    if (!projectClient) {
      setSessions([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    projectClient
      .fetchJson<SessionsResponse>('/sessions', {
        signal,
        allowMissingEnvelope: true,
      })
      .then(payload => {
        if (latestClientRef.current?.identityKey !== projectClient.identityKey) {
          return;
        }
        const d = extractProjectScopedData<SessionsResponse>(payload, { sessions: [] });
        setSessions(d.sessions ?? []);
        setError(null);
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') {
          setError(e.message);
        }
      })
      .finally(() => {
        if (!signal?.aborted && latestClientRef.current?.identityKey === projectClient.identityKey) {
          setLoading(false);
        }
      });
  }, [projectClient]);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const loadSession = useCallback((id: string): Promise<SessionSnapshot> => {
    if (!projectClient) {
      return Promise.reject(new Error('Project is not ready.'));
    }

    return projectClient.fetchJson<SessionSnapshot>(`/sessions/${id}`, {
      allowMissingEnvelope: true,
    }).then(payload => {
      return extractProjectScopedData<SessionSnapshot>(payload, payload);
    });
  }, [projectClient]);

  return { sessions, loading, error, refresh, loadSession };
}

function extractProjectScopedData<T>(payload: unknown, fallback: T): T {
  if (isRecord(payload) && isRecord(payload.data)) {
    return payload.data as T;
  }
  return (payload as T | null) ?? fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
