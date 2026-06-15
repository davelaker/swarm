import { useEffect, useRef } from 'react';
import type { RunStatus } from '../types';
import { useNotifyEnabled } from './useNotifyEnabled';

// A short two-tone chime via WebAudio — no asset to bundle, best-effort (a blocked
// AudioContext just no-ops). Distinct tones for "good" (rising) vs "attention" (flat).
function chime(kind: 'done' | 'attention') {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const notes = kind === 'done' ? [660, 880] : [520, 520];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.16;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.16);
    });
    setTimeout(() => ctx.close().catch(() => {}), 600);
  } catch {
    /* audio unavailable — the visual notification still fires */
  }
}

function fire(title: string, body: string, kind: 'done' | 'attention') {
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, {
        body,
        tag: 'swarm-run',
        renotify: true,
      } as NotificationOptions);
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* construction can throw on some platforms — fall through to sound only */
    }
  }
  chime(kind);
}

// Fires a desktop notification + chime when a run reaches a moment that wants the
// user's attention while they're tabbed away: it finished, it was stopped, or an
// agent is blocked awaiting their approval. Gated on the user opting in (the bell)
// AND only when the tab is hidden — no point pinging someone who's watching.
export function useRunNotifications(status: RunStatus, awaitingApproval: boolean): void {
  const [enabled] = useNotifyEnabled();
  const prevStatus = useRef<RunStatus | null>(null);
  const prevAwaiting = useRef(false);

  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;
    // Skip the first observed status (initial mount / page load) — only live transitions.
    if (prev === null || prev === status || !enabled) {
      return;
    }
    if (!document.hidden) {
      return;
    }
    if (status === 'done') {
      fire('Swarm run finished', 'All tasks complete — ready to review.', 'done');
    } else if (status === 'aborted') {
      fire('Swarm run stopped', 'The run ended early and needs you.', 'attention');
    }
  }, [status, enabled]);

  useEffect(() => {
    const prev = prevAwaiting.current;
    prevAwaiting.current = awaitingApproval;
    if (!awaitingApproval || prev || !enabled || !document.hidden) {
      return;
    }
    fire(
      'Swarm needs your approval',
      'An agent is waiting for you to allow or deny a tool.',
      'attention',
    );
  }, [awaitingApproval, enabled]);
}
