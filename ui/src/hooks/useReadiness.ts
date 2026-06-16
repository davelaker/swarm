import { useEffect, useRef, useState } from 'react';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface PreflightReport {
  root: string;
  project: string;
  checks: PreflightCheck[];
  canRun: boolean;
}

export interface Readiness {
  report: PreflightReport | null;
  checks: PreflightCheck[]; // preflight checks + the Playwright capability, merged
  canRun: boolean; // false only on a hard preflight fail (not on warnings)
  loading: boolean;
  refresh: () => void;
}

// Combines the backend pre-flight report (/run/preflight) with the visual-gate
// capability (/capabilities) into one readiness view for the panel. Re-checks on
// mount, when asked (refresh), and when the tab regains focus — picking up a
// just-committed tree or a newly-installed Playwright without a reload.
export function useReadiness(refreshKey: number = 0): Readiness {
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [playwright, setPlaywright] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    Promise.all([
      fetch('/run/preflight', { signal: AbortSignal.timeout(3000) })
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch('/capabilities', { signal: AbortSignal.timeout(3000) })
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null),
    ]).then(([pre, cap]) => {
      if (!mounted) {
        return;
      }
      setReport(pre);
      setPlaywright(cap ? !!cap.playwright : null);
      setLoading(false);
    });
    const onFocus = () => setTick(t => t + 1);
    window.addEventListener('focus', onFocus);
    return () => {
      mounted = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [tick, refreshKey]);

  // While the panel is BLOCKING (a hard fail), poll so a just-cleaned tree recovers on its
  // own — e.g. a phantom stat-dirty that settles, or the user commits in another terminal —
  // instead of staying stuck until they refocus the tab. One always-on timer reads the
  // latest canRun through a ref (avoiding any effect-dependency transition subtlety) and
  // only re-checks while blocked, so a ready run costs nothing.
  const blockedRef = useRef(false);
  blockedRef.current = report?.canRun === false;
  useEffect(() => {
    const id = setInterval(() => {
      if (blockedRef.current) {
        setTick(t => t + 1);
      }
    }, 3000);
    return () => clearInterval(id);
  }, []);

  const checks: PreflightCheck[] = [...(report?.checks ?? [])];
  if (playwright !== null) {
    checks.push({
      id: 'playwright',
      label: 'Visual verification',
      status: playwright ? 'ok' : 'warn',
      detail: playwright
        ? 'Playwright + Chromium ready'
        : 'Playwright not installed — visual checks will skip',
    });
  }

  return {
    report,
    checks,
    canRun: report ? report.canRun : true, // unknown → don't block (server may be down)
    loading,
    refresh: () => setTick(t => t + 1),
  };
}
