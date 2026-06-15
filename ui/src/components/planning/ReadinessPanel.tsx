import type { PreflightCheck } from '../../hooks/useReadiness';

const MARK: Record<PreflightCheck['status'], string> = {
  ok: '✓',
  warn: '!',
  fail: '✗',
};

// Presentational: one row per readiness check, led by the resolved target repo so
// the "wrong project" footgun is impossible to miss before a run.
export function ReadinessPanel({
  project,
  checks,
  loading,
}: {
  project: string | null;
  checks: PreflightCheck[];
  loading: boolean;
}) {
  if (loading && checks.length === 0) {
    return <div className="readiness readiness-loading">Checking readiness…</div>;
  }
  if (checks.length === 0) {
    return null; // server unreachable — stay quiet, the run flow handles the error
  }

  return (
    <div className="readiness">
      <div className="readiness-head">
        <span className="readiness-head-label">Target</span>
        <span className="readiness-target">{project ?? 'unknown'}</span>
      </div>
      <ul className="readiness-rows">
        {checks.map(c => (
          <li key={c.id} className={`readiness-row ${c.status}`} title={c.detail}>
            <span className="readiness-mark">{MARK[c.status]}</span>
            <span className="readiness-label">{c.label}</span>
            <span className="readiness-detail">{c.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
