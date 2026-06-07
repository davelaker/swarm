import { VERDICT_CLASS, VERDICT_LABEL } from '../../data/runScript';

export function VerdictChip({ verdict }: { verdict: string }) {
  return (
    <span className={`vchip ${VERDICT_CLASS[verdict] ?? verdict}`}>
      {VERDICT_LABEL[verdict] ?? verdict.toUpperCase()}
    </span>
  );
}
