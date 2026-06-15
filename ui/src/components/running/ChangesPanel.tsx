import { useEffect, useState } from 'react';
import { DiffView, lineKey, type StructuredDiffFile } from './DiffView';
import { useReview, type ReviewComment } from '../../hooks/useReview';

interface StructuredDiff {
  source: string;
  files: StructuredDiffFile[];
  error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rangeLabel(c: ReviewComment): string {
  return c.startLine === c.endLine ? `line ${c.startLine}` : `lines ${c.startLine}–${c.endLine}`;
}

function shortRef(c: ReviewComment): string {
  const name = c.file.split('/').pop() ?? c.file;
  return c.startLine === c.endLine
    ? `${name}:${c.startLine}`
    : `${name}:${c.startLine}–${c.endLine}`;
}

function buildReviewMessage(comments: ReviewComment[]): string {
  const lines = comments
    .filter(c => c.body.trim())
    .map(c => {
      const ref =
        c.startLine === c.endLine
          ? `${c.file}:${c.startLine}`
          : `${c.file}:${c.startLine}-${c.endLine}`;
      return `• ${ref} — ${c.body.trim()}`;
    });
  return lines.length ? `Requested changes:\n${lines.join('\n')}` : '';
}

// ─── Inline comment thread (rendered under the commented line) ─────────────────

function CommentThread({
  comment,
  autoFocus,
  onChange,
  onRemove,
}: {
  comment: ReviewComment;
  autoFocus: boolean;
  onChange: (body: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="dv-thread">
      <div className="dv-thread-head">
        <span className="dv-thread-ref">{rangeLabel(comment)}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="dv-thread-remove" onClick={onRemove} title="Remove comment">
          ×
        </button>
      </div>
      <textarea
        className="dv-thread-input"
        autoFocus={autoFocus}
        value={comment.body}
        placeholder="Leave a comment… (shift-click another line to extend the range)"
        onChange={e => onChange(e.target.value)}
        rows={2}
      />
    </div>
  );
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

// ─── Review summary sidebar ───────────────────────────────────────────────────

function ReviewPane({
  comments,
  onJump,
  onRemove,
  onSubmit,
  submitting,
}: {
  comments: ReviewComment[];
  onJump: (c: ReviewComment) => void;
  onRemove: (id: string) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const withBody = comments.filter(c => c.body.trim());

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
            Click a line in the diff to comment. Shift-click another line to span a range.
          </div>
        ) : (
          comments.map(c => (
            <div
              key={c.id}
              className="review-comment"
              onClick={() => onJump(c)}
              style={{ cursor: 'pointer' }}
            >
              <div className="review-ref">
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--blue)' }}>
                  {shortRef(c)}
                </span>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    onRemove(c.id);
                  }}
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
              <div className="review-preview">
                {c.body.trim() ? (
                  c.body.trim()
                ) : (
                  <span style={{ opacity: 0.5 }}>empty — add a note</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="review-footer">
        <button
          className="btn primary"
          onClick={onSubmit}
          disabled={withBody.length === 0 || submitting}
          style={{ width: '100%' }}
        >
          {submitting
            ? 'Sending…'
            : `Request changes${withBody.length ? ` (${withBody.length})` : ''}`}
        </button>
        {withBody.length > 0 && (
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
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const { comments, addComment, setRange, setBody, remove, clearAll } = useReview();

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

  // Click a line → start a comment there. Shift-click → extend the active comment's
  // range. Clicking an empty single-line comment again removes it (toggle).
  const onLineClick = (
    file: string,
    side: 'old' | 'new',
    line: number,
    opts: { shift: boolean },
  ) => {
    if (opts.shift && activeId) {
      const active = comments.find(c => c.id === activeId);
      if (active && active.file === file && active.side === side) {
        setRange(activeId, line);
        return;
      }
    }
    const existing = comments.find(
      c => c.file === file && c.side === side && c.startLine === line && c.endLine === line,
    );
    if (existing && !existing.body.trim()) {
      remove(existing.id);
      if (activeId === existing.id) {
        setActiveId(null);
      }
      return;
    }
    const id = addComment(file, side, line);
    setActiveId(id);
  };

  const renderThread = (file: string, side: 'old' | 'new', line: number) => {
    const here = comments.filter(c => c.file === file && c.side === side && c.endLine === line);
    if (here.length === 0) {
      return null;
    }
    return here.map(c => (
      <CommentThread
        key={c.id}
        comment={c}
        autoFocus={c.id === activeId}
        onChange={b => setBody(c.id, b)}
        onRemove={() => {
          remove(c.id);
          if (activeId === c.id) {
            setActiveId(null);
          }
        }}
      />
    ));
  };

  const jumpTo = (c: ReviewComment) => {
    const el = document.querySelector(`[data-line="${lineKey(c.file, c.side, c.endLine)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const submitReview = () => {
    const msg = buildReviewMessage(comments);
    if (!msg) {
      return;
    }
    setSubmitting(true);
    onRequestChanges?.(msg);
    setSubmitted(true);
    clearAll();
    setActiveId(null);
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
  const selected = new Set<string>();
  for (const c of comments) {
    for (let n = c.startLine; n <= c.endLine; n++) {
      selected.add(lineKey(c.file, c.side, n));
    }
  }

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
            <DiffView
              files={diff!.files}
              onLineClick={onLineClick}
              selected={selected}
              renderThread={renderThread}
            />
          </>
        )}
      </div>

      <ReviewPane
        comments={comments}
        onJump={jumpTo}
        onRemove={id => {
          remove(id);
          if (activeId === id) {
            setActiveId(null);
          }
        }}
        onSubmit={submitReview}
        submitting={submitting}
      />
    </div>
  );
}
