import type { Scorecard } from '../../hooks/useScorecards';

// One-line track record for the dense team rows.
export function ScorecardInline({ card }: { card: Scorecard | undefined }) {
  if (!card || card.tasks === 0) {
    return null;
  }
  const avgCost = card.sessions ? card.totalCostUsd / card.sessions : 0;
  return (
    <span className="sc-inline">
      {card.sessions} run{card.sessions !== 1 ? 's' : ''}
      {card.issuesCaught > 0 && (
        <>
          {' · '}
          <b className="caught">{card.issuesCaught} caught</b>
        </>
      )}
      {avgCost > 0 && <>{` · $${avgCost.toFixed(2)}/run`}</>}
    </span>
  );
}

// A compact track-record strip for an agent — real numbers from past runs, so the
// marketplace shows "8 issues caught at $0.20/run" instead of a blurb. Shown raw and
// unambiguous: runs, issues caught (when any), $/run, and failures (when any).
export function ScorecardStrip({ card }: { card: Scorecard | undefined }) {
  if (!card || card.tasks === 0) {
    return <div className="scorecard empty">No runs yet</div>;
  }
  const avgCost = card.sessions ? card.totalCostUsd / card.sessions : 0;
  return (
    <div className="scorecard">
      <span className="sc-stat">
        <b>{card.sessions}</b> run{card.sessions !== 1 ? 's' : ''}
      </span>
      {card.issuesCaught > 0 && (
        <span className="sc-stat caught" title="Real problems this agent flagged">
          <b>{card.issuesCaught}</b> caught
        </span>
      )}
      {avgCost > 0 && (
        <span className="sc-stat" title="Average credit cost per run">
          <b>${avgCost.toFixed(2)}</b>/run
        </span>
      )}
      {card.failures > 0 && (
        <span className="sc-stat fail" title="Tasks that errored out">
          <b>{card.failures}</b> failed
        </span>
      )}
    </div>
  );
}
