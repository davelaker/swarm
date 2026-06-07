# Mock conflict & ruling: UX vs Performance

A worked example of the Negotiator (see `../../NEGOTIATOR.md`) resolving a genuine
trade-off. Continues the `add-arena-leaderboard` run: after the security fix landed, the
team was expanded and a UX Researcher and Performance Engineer were both hired. They now
disagree about leaderboard row transitions.

## The conflict

- `ux-finding.md` — UX Researcher, `CHANGES_REQUESTED`, `negotiable: true`: the leaderboard
  should animate rank changes so users can *see* movement; static jumps feel broken.
- `perf-finding.md` — Performance Engineer, `CHANGES_REQUESTED`, `negotiable: true`: the
  proposed animation library + per-row JS animation blows the interaction budget on the
  target hardware.

Both `blocks_done`. Both recommendations, *as written*, are mutually exclusive (rich JS
animation vs. stay within budget). The PM detects contradictory blocking findings on the
same artifact → dispatches the **Negotiator**.

## The ruling

`ruling.md` — `RESOLVED`, decision `SYNTHESIZE`. Because **both findings are negotiable**
and the product brief lists "fast, scannable" as a core value, the Negotiator doesn't
discard either: it rules for animation *within* the budget — CSS transforms only, capped
duration, `prefers-reduced-motion` honoured — and emits a single remediation task carrying
those constraints.

## Why this is the right shape

- **Compromise was legal here** because neither side was a correctness or safety finding.
  Had the Performance finding been a hard "this crashes low-end devices" (`negotiable:
  false`), the Negotiator could not have upheld the UX side against it — it would rule on
  the *manner* of compliance or escalate (`NEGOTIATOR.md` §2).
- **The decision is the PM's to enact, the reasoning is the Negotiator's to own.** The
  ruling is a written, inspectable artifact on the blackboard, not a buried PM heuristic.
- **The conflict produced one new constrained task**, not a stalemate — the loop keeps
  moving.

## Files
```
ux-finding.md     # UX Researcher's blocking finding
perf-finding.md   # Performance Engineer's blocking finding
ruling.md         # the Negotiator's synthesis
```
