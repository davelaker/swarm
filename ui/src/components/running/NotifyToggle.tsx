import { useNotifyEnabled } from '../../hooks/useNotifyEnabled';

// A bell that opts the user into desktop notifications + a chime when the run
// finishes, stops, or needs their approval. Clicking to enable requests browser
// Notification permission inside the click (a user gesture — required by Firefox
// and Safari). If the user has hard-denied permission, the bell explains that.
export function NotifyToggle() {
  const [enabled, setEnabled] = useNotifyEnabled();

  const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';

  const toggle = () => {
    if (enabled) {
      setEnabled(false);
      return;
    }
    if (typeof Notification === 'undefined') {
      setEnabled(true); // sound-only fallback
      return;
    }
    if (Notification.permission === 'granted') {
      setEnabled(true);
      return;
    }
    if (Notification.permission === 'denied') {
      return; // can't re-prompt — browser setting must be changed
    }
    Notification.requestPermission().then(p => setEnabled(p === 'granted'));
  };

  const title = denied
    ? 'Notifications are blocked in your browser settings — enable them there to get pinged when a run finishes.'
    : enabled
      ? 'Notify me when the run finishes, stops, or needs approval — on. Click to turn off.'
      : 'Notify me when the run finishes, stops, or needs approval (only while this tab is in the background).';

  return (
    <button
      className={`notify-toggle${enabled ? ' on' : ''}${denied ? ' denied' : ''}`}
      onClick={toggle}
      title={title}
      aria-pressed={enabled}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3a6 6 0 0 0-6 6c0 4-1.5 5.5-2 6.5h16c-.5-1-2-2.5-2-6.5a6 6 0 0 0-6-6Z"
          fill={enabled ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="M10 19a2 2 0 0 0 4 0"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        {denied && (
          <path d="M5 4l14 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        )}
      </svg>
    </button>
  );
}
