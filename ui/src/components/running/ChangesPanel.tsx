import { useEffect, useRef, useState } from 'react';
import * as Diff2Html from 'diff2html';
import { ColorSchemeType } from 'diff2html/lib-esm/types';
import 'diff2html/bundles/css/diff2html.min.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReviewComment {
  id:   string;
  file: string;
  line: number | null;
  text: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortRef(file: string, line: number | null): string {
  const name = file.split('/').pop() ?? file;
  return line ? `${name}:${line}` : name;
}

function buildReviewMessage(comments: ReviewComment[]): string {
  const lines = comments
    .filter(c => c.text.trim())
    .map(c => `• ${c.file}${c.line ? `:${c.line}` : ''} — ${c.text.trim()}`);
  if (lines.length === 0) return '';
  return `Requested changes:\n${lines.join('\n')}`;
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyDiff() {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 10,
      color: 'var(--tx-3)', padding: 40,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        No changes detected
      </div>
      <div style={{ fontSize: 12, color: 'var(--tx-3)', textAlign: 'center', maxWidth: 300, lineHeight: 1.6 }}>
        No uncommitted or unpushed changes found in the working tree.
      </div>
    </div>
  );
}

// ─── Review sidebar ───────────────────────────────────────────────────────────

function ReviewPane({
  comments, onUpdate, onRemove, onSubmit, submitting,
}: {
  comments:   ReviewComment[];
  onUpdate:   (id: string, text: string) => void;
  onRemove:   (id: string) => void;
  onSubmit:   () => void;
  submitting: boolean;
}) {
  const hasText = comments.some(c => c.text.trim());

  return (
    <div className="review-pane">
      <div className="panel-head">
        <span>Review</span>
        <span className="spacer" />
        <span className="mono" style={{ fontSize: 11, color: 'var(--tx-3)', textTransform: 'none', letterSpacing: 0 }}>
          {comments.length} {comments.length === 1 ? 'note' : 'notes'}
        </span>
      </div>

      <div className="review-scroll">
        {comments.length === 0 ? (
          <div style={{ padding: '16px 14px', color: 'var(--tx-3)', fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.6 }}>
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
                  style={{ marginLeft: 'auto', color: 'var(--tx-3)', fontSize: 13, lineHeight: 1, flexShrink: 0 }}
                  title="Remove"
                >×</button>
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
          <div style={{ marginTop: 6, fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--tx-3)', textAlign: 'center', lineHeight: 1.4 }}>
            Sends review to PM chat. Start a new run to apply the fixes.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ChangesPanel() {
  const [diffText,   setDiffText]   = useState<string | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [comments,   setComments]   = useState<ReviewComment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted,  setSubmitted]  = useState(false);
  const diffRef = useRef<HTMLDivElement>(null);

  // ── Fetch diff ──────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/run/diff')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
      .then(t => { setDiffText(t); setLoading(false); })
      .catch((e: Error) => { setFetchError(e.message); setLoading(false); });
  }, []);

  // ── Click-to-annotate ───────────────────────────────────────────────────────
  useEffect(() => {
    const container = diffRef.current;
    if (!container || !diffText) return;

    const handleClick = (e: MouseEvent) => {
      const row = (e.target as Element).closest('tr');
      if (!row) return;

      // Skip header/info rows
      if (row.classList.contains('d2h-diff-tbody') || row.querySelector('.d2h-info')) return;

      // Line number: diff2html uses .line-num2 for new-file line, .line-num1 for old
      const num2 = row.querySelector('.line-num2')?.textContent?.trim();
      const num1 = row.querySelector('.line-num1')?.textContent?.trim();
      const rawLine = (num2 && num2 !== '&nbsp;' ? num2 : num1) ?? '';
      const line = parseInt(rawLine) || null;

      // File name: walk up to .d2h-file-wrapper then find .d2h-file-name
      const fileWrapper = row.closest('.d2h-file-wrapper');
      const fileName = fileWrapper?.querySelector('.d2h-file-name')?.textContent?.trim() ?? '';
      if (!fileName) return;

      // Highlight the clicked row
      container.querySelectorAll('tr.diff-selected').forEach(r => r.classList.remove('diff-selected'));
      row.classList.add('diff-selected');

      // Add a comment entry (or focus existing one for same file+line)
      setComments(prev => {
        const existing = prev.find(c => c.file === fileName && c.line === line);
        if (existing) return prev; // already annotated — just highlight
        return [...prev, {
          id:   Math.random().toString(36).slice(2),
          file: fileName,
          line,
          text: '',
        }];
      });
    };

    container.addEventListener('click', handleClick);
    return () => container.removeEventListener('click', handleClick);
  }, [diffText]);

  // ── Actions ─────────────────────────────────────────────────────────────────
  const updateComment = (id: string, text: string) =>
    setComments(prev => prev.map(c => c.id === id ? { ...c, text } : c));

  const removeComment = (id: string) =>
    setComments(prev => prev.filter(c => c.id !== id));

  const submitReview = () => {
    const msg = buildReviewMessage(comments);
    if (!msg) return;
    setSubmitting(true);
    fetch('/run/message', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: msg }),
    })
      .then(() => { setSubmitted(true); setComments([]); })
      .catch(() => { /* silently ignore — PM chat may be inactive */ setSubmitted(true); setComments([]); })
      .finally(() => setSubmitting(false));
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="run-changes">
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--tx-3)' }}>loading diff…</span>
        </div>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="run-changes">
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--red)' }}>⚠ {fetchError}</span>
        </div>
      </div>
    );
  }

  const isEmpty = !diffText?.trim();

  const diffHtml = isEmpty ? '' : Diff2Html.html(diffText!, {
    drawFileList:  true,
    matching:      'lines',
    outputFormat:  'line-by-line',
    renderNothingWhenEmpty: true,
    colorScheme:   ColorSchemeType.DARK,
  });

  return (
    <div className="run-changes">
      {/* Diff pane */}
      <div className="diff-pane" ref={diffRef}>
        {isEmpty ? (
          <EmptyDiff />
        ) : (
          <>
            {submitted && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 14px', background: 'rgba(52,207,138,0.08)',
                borderBottom: '1px solid rgba(52,207,138,0.2)',
                fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--green)',
              }}>
                <span>✓</span>
                <span>Review sent to PM chat. Go to Planning to start a new run addressing the feedback.</span>
                <button onClick={() => setSubmitted(false)} style={{ marginLeft: 'auto', color: 'var(--green)', opacity: 0.7 }}>×</button>
              </div>
            )}
            <div
              dangerouslySetInnerHTML={{ __html: diffHtml }}
            />
          </>
        )}
      </div>

      {/* Review sidebar */}
      <ReviewPane
        comments   = {comments}
        onUpdate   = {updateComment}
        onRemove   = {removeComment}
        onSubmit   = {submitReview}
        submitting = {submitting}
      />
    </div>
  );
}
