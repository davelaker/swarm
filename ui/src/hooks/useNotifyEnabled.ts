import { useEffect, useState } from 'react';

const KEY = 'swarm-notify-enabled';
const EVENT = 'swarm-notify-changed';

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true';
  } catch {
    return false;
  }
}

// Whether finish/blocked notifications are enabled, backed by localStorage and kept
// in sync across every consumer in the tab (the bell toggle and the notifier hook
// live in different components) via a custom window event. Separate from browser
// Notification permission — both must be true to actually fire.
export function useNotifyEnabled(): [boolean, (on: boolean) => void] {
  const [enabled, setEnabled] = useState(read);

  useEffect(() => {
    const sync = () => setEnabled(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync); // other tabs
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const set = (on: boolean) => {
    try {
      localStorage.setItem(KEY, String(on));
    } catch {
      /* private mode — keep in-memory only */
    }
    setEnabled(on);
    window.dispatchEvent(new Event(EVENT));
  };

  return [enabled, set];
}
