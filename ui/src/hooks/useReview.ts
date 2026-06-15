import { useCallback, useEffect, useRef, useState } from 'react';

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
  clearAll: () => void;
  reload: () => void;
} {
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(() => {
    fetch('/run/review')
      .then(r => (r.ok ? r.json() : { comments: [] }))
      .then((d: { comments?: ReviewComment[] }) => {
        setComments(d.comments ?? []);
        loaded.current = true;
      })
      .catch(() => {
        loaded.current = true;
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Debounced persist — skip the first render (the load itself).
  useEffect(() => {
    if (!loaded.current) {
      return;
    }
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
    }
    saveTimer.current = setTimeout(() => {
      fetch('/run/review/save', {
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
  }, [comments]);

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

  const clearAll = useCallback(() => setComments([]), []);

  return { comments, addComment, setRange, setBody, remove, clearAll, reload };
}
