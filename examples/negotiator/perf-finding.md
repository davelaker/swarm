---
task: t8
agent: performance-engineer
verdict: CHANGES_REQUESTED
schema: perf-finding
negotiable: true
blocks_done: true
disputes: null
findings:
  - id: PERF-1
    severity: major
    type: Interaction latency budget
    location: leaderboard view :: rank-transition rendering
---

## PERF-1 · Animation approach blows the interaction budget · major

The proposed implementation pulls in a JS animation library and animates each row's
position in JavaScript on every update. Measured on the target low-mid hardware this drops
the update well past the 100ms interaction budget (frame drops during reorder).

**Impact:** the leaderboard janks on exactly the moment it's meant to shine (a refresh with
movement), on the hardware most of our users have.

**Recommendation:** do not animate per-row in JS and do not add the animation dependency.
Keep updates within the interaction budget.

> Note: I'm flagging the *approach*, not motion per se. This is `negotiable: true` — a
> within-budget way to show movement would satisfy me.
