import { useState } from 'react';
import { useServerFreshness } from '../../hooks/useServerFreshness';

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h % 12 || 12}:${m}${h >= 12 ? 'pm' : 'am'}`;
}

// A thin, quiet bar shown only when the backend's source on disk is newer than the
// running process — i.e. someone edited core and the change isn't live until restart.
// Dismissible per stale-edit (re-appears if the source changes again after dismissal).
export function StaleServerBanner() {
  const info = useServerFreshness();
  const [dismissedAt, setDismissedAt] = useState(0);

  if (!info || !info.stale) {
    return null;
  }
  // A fresh edit after a dismissal re-arms the banner.
  if (info.newestSourceAt <= dismissedAt) {
    return null;
  }

  return (
    <div className="stale-banner">
      <span className="stale-dot" />
      <span className="stale-text">
        Backend code changed at <strong>{fmtClock(info.newestSourceAt)}</strong> — the running
        server started {fmtClock(info.startedAt)} and won&rsquo;t pick it up until you restart.
      </span>
      <code className="stale-cmd">{info.restartCommand}</code>
      <button
        className="stale-dismiss"
        onClick={() => setDismissedAt(info.newestSourceAt)}
        title="Dismiss until the next edit"
      >
        ×
      </button>
    </div>
  );
}
