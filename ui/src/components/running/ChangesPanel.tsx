import { useEffect, useState } from 'react';
import { DiffView, lineKey, type StructuredDiffFile } from './DiffView';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReviewComment {
  id: string;
  file: string;
  side: 'old' | 'new';
  line: number;
  text: string;
}

interface StructuredDiff {
  source: string;
  files: StructuredDiffFile[];
  error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortRef(file: string, line: number): string {
  const name = file.split('/').pop() ?? file;
  return `${name}:${line}`;
}

function buildReviewMessage(comments: ReviewComment[]): string {
  const lines = comments
    .filter(c => c.text.trim())
    .map(c => `• ${c.file}:${c.line} — ${c.text.trim()}`);
  if (lines.length === 0) {
    return '';
  }
  return `Requested changes:\n${lines.join('\n')}`;
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyDiff() {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        color: 'var(--tx-3)',
        padding: 40,
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        No changes detected
      </div>
      <div
        style={{
          fontSize: 12,
          color: 'var(--tx-3)',
          textAlign: 'center',
          maxWidth: 300,
          lineHeight: 1.6,
        }}
      >
        No uncommitted or unpushed changes found.
      </div>
    </div>
  );
}

// ─── Review sidebar ───────────────────────────────────────────────────────────

function ReviewPane({
  comments,
  onUpdate,
  onRemove,
  onSubmit,
  submitting,
}: {
  comments: ReviewComment[];
  onUpdate: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const hasText = comments.some(c => c.text.trim());

  return (
    <div className="review-pane">
      <div className="panel-head">
        <span>Review</span>
        <span className="spacer" />
        <span
          className="mono"
          style={{ fontSize: 11, color: 'var(--tx-3)', textTransform: 'none', letterSpacing: 0 }}
        >
          {comments.length} {comments.length === 1 ? 'note' : 'notes'}
        </span>
      </div>

      <div className="review-scroll">
        {comments.length === 0 ? (
          <div
            style={{
              padding: '16px 14px',
              color: 'var(--tx-3)',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              lineHeight: 1.6,
            }}
          >
            Click any line in the diff to annotate it.
          </div>
        ) : (
          comments.map(c => (
            <div key={c.id} className="review-comment">
              <div className="review-ref">
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--blue)' }}>
                  {shortRef(c.file, c.line)}
                </span>
                <button
                  onClick={() => onRemove(c.id)}
                  style={{
                    marginLeft: 'auto',
                    color: 'var(--tx-3)',
                    fontSize: 13,
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                  title="Remove"
                >
                  ×
                </button>
              </div>
              <textarea
                className="review-text"
                placeholder="Describe the issue or change needed…"
                value={c.text}
                onChange={e => onUpdate(c.id, e.target.value)}
                rows={2}
              />
            </div>
          ))
        )}
      </div>

      <div className="review-footer">
        <button
          className="btn primary"
          onClick={onSubmit}
          disabled={!hasText || submitting}
          style={{ width: '100%' }}
        >
          {submitting ? 'Sending…' : 'Request changes'}
        </button>
        {hasText && (
          <div
            style={{
              marginTop: 6,
              fontSize: 10,
              fontFamily: 'var(--mono)',
              color: 'var(--tx-3)',
              textAlign: 'center',
              lineHeight: 1.4,
            }}
          >
            Sends to the PM, which plans a coder + reviewer to apply the fixes.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ChangesPanel({
  onRequestChanges,
}: {
  onRequestChanges?: (message: string) => void;
}) {
  const [diff, setDiff] = useState<StructuredDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    fetch('/run/diff/structured')
      .then(r => {
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((d: StructuredDiff) => {
        setDiff(d);
        setLoading(false);
      })
      .catch((e: Error) => {
        setFetchError(e.message);
        setLoading(false);
      });
  }, []);

  // Click a diff line → add (or remove if already noted) a comment anchored to the
  // structured model — no DOM scraping.
  const toggleLine = (file: string, side: 'old' | 'new', line: number) => {
    setComments(prev => {
      const existing = prev.find(c => c.file === file && c.side === side && c.line === line);
      if (existing) {
        // Only remove if the note is still empty — don't lose typed feedback.
        return existing.text.trim() ? prev : prev.filter(c => c !== existing);
      }
      return [...prev, { id: Math.random().toString(36).slice(2), file, side, line, text: '' }];
    });
  };

  const updateComment = (id: string, text: string) =>
    setComments(prev => prev.map(c => (c.id === id ? { ...c, text } : c)));
  const removeComment = (id: string) => setComments(prev => prev.filter(c => c.id !== id));

  const submitReview = () => {
    const msg = buildReviewMessage(comments);
    if (!msg) {
      return;
    }
    setSubmitting(true);
    onRequestChanges?.(msg);
    setSubmitted(true);
    setComments([]);
    setSubmitting(false);
  };

  if (loading) {
    return (
      <div className="run-changes">
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--tx-3)' }}>
            loading diff…
          </span>
        </div>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="run-changes">
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--red)' }}>
            ⚠ {fetchError}
          </span>
        </div>
      </div>
    );
  }

  const isEmpty = !diff || diff.files.length === 0;
  const selected = new Set(comments.map(c => lineKey(c.file, c.side, c.line)));

  return (
    <div className="run-changes">
      <div className="diff-pane">
        {isEmpty ? (
          <EmptyDiff />
        ) : (
          <>
            {submitted && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 14px',
                  background: 'rgba(52,207,138,0.08)',
                  borderBottom: '1px solid rgba(52,207,138,0.2)',
                  fontSize: 12,
                  fontFamily: 'var(--mono)',
                  color: 'var(--green)',
                }}
              >
                <span>✓</span>
                <span>Sent to the PM — see Planning, where it's scoping a coder + reviewer.</span>
                <button
                  onClick={() => setSubmitted(false)}
                  style={{ marginLeft: 'auto', color: 'var(--green)', opacity: 0.7 }}
                >
                  ×
                </button>
              </div>
            )}
            <div className="dv-source">{diff!.source}</div>
            <DiffView files={diff!.files} onLineClick={toggleLine} selected={selected} />
          </>
        )}
      </div>

      <ReviewPane
        comments={comments}
        onUpdate={updateComment}
        onRemove={removeComment}
        onSubmit={submitReview}
        submitting={submitting}
      />
    </div>
  );
}
