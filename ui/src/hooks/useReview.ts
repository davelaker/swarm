import { useCallback, useEffect, useRef, useState } from 'react';
import { useProjectClient } from '../project/ProjectClientContext';

export type ReviewStatus = 'open' | 'submitted' | 'planned' | 'fixing' | 'resolved';

export interface ReviewComment {
  id: string;
  file: string;
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
  body: string;
  status: ReviewStatus;
  createdAt: number;
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Manages the diff-review comment draft: loads the persisted set on mount and saves
// (debounced) on every change, so comments survive reload and are readable by the
// fixer in phase 3. The component owns all editing; this hook owns persistence.
export function useReview(): {
  comments: ReviewComment[];
  addComment: (file: string, side: 'old' | 'new', line: number) => string;
  setRange: (id: string, line: number) => void;
  setBody: (id: string, body: string) => void;
  remove: (id: string) => void;
  markAllFixing: () => void;
  clearResolved: () => void;
  clearAll: () => void;
  reload: () => void;
} {
  const projectClient = useProjectClient();
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // While a fix is in flight (or done), the server owns the comment statuses — the
  // client only displays them. Editing/persisting resumes once everything is 'open'.
  const editable = comments.every(c => c.status === 'open');
  const inFlight = comments.some(c => c.status === 'fixing' || c.status === 'planned');

  const reload = useCallback(() => {
    projectClient
      .fetchJson<{ comments?: ReviewComment[] }>('/run/review', { allowMissingEnvelope: true })
      .then((d: { comments?: ReviewComment[] }) => {
        if (!projectClient.isStale()) {
          setComments(d.comments ?? []);
          loaded.current = true;
        }
      })
      .catch(() => {
        loaded.current = true;
      });
  }, [projectClient]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Debounced persist — only while the draft is editable (server owns it otherwise).
  useEffect(() => {
    if (!loaded.current || !editable) {
      return;
    }
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
    }
    saveTimer.current = setTimeout(() => {
      projectClient.fetchResponse('/run/review/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ comments }),
      }).catch(() => {});
    }, 400);
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
    };
  }, [comments, editable, projectClient]);

  // Poll for status transitions while a fix is applying (open → fixing → resolved).
  useEffect(() => {
    if (!inFlight) {
      return;
    }
    const id = setInterval(reload, 2500);
    return () => clearInterval(id);
  }, [inFlight, reload]);

  const addComment = useCallback((file: string, side: 'old' | 'new', line: number): string => {
    const id = rid();
    setComments(prev => [
      ...prev,
      { id, file, side, startLine: line, endLine: line, body: '', status: 'open', createdAt: 0 },
    ]);
    return id;
  }, []);

  // Extend (or move) a comment's range to cover from its start to `line`.
  const setRange = useCallback((id: string, line: number) => {
    setComments(prev =>
      prev.map(c =>
        c.id === id
          ? { ...c, startLine: Math.min(c.startLine, line), endLine: Math.max(c.startLine, line) }
          : c,
      ),
    );
  }, []);

  const setBody = useCallback((id: string, body: string) => {
    setComments(prev => prev.map(c => (c.id === id ? { ...c, body } : c)));
  }, []);

  const remove = useCallback((id: string) => {
    setComments(prev => prev.filter(c => c.id !== id));
  }, []);

  const markAllFixing = useCallback(
    () => setComments(prev => prev.map(c => ({ ...c, status: 'fixing' as ReviewStatus }))),
    [],
  );

  // Dismiss the resolved comments (and persist the cleared draft).
  const clearResolved = useCallback(() => {
    setComments(prev => {
      const next = prev.filter(c => c.status !== 'resolved');
      projectClient.fetchResponse('/run/review/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ comments: next }),
      }).catch(() => {});
      return next;
    });
  }, [projectClient]);

  const clearAll = useCallback(() => setComments([]), []);

  return {
    comments,
    addComment,
    setRange,
    setBody,
    remove,
    markAllFixing,
    clearResolved,
    clearAll,
    reload,
  };
}
