---
task: t8
agent: ux-researcher
verdict: CHANGES_REQUESTED
schema: ux-finding
negotiable: true
blocks_done: true
disputes: null
findings:
  - id: UX-2
    severity: major
    type: Visibility of system status
    location: leaderboard view :: rank-transition rendering
---

## UX-2 · Rank changes are invisible · major

When the leaderboard refreshes, rows jump to their new positions instantly. Users can't
tell *what* changed — did I move up? did someone overtake me? The whole point of a
leaderboard is perceiving movement (Nielsen: *visibility of system status*).

**Impact:** the core emotional payload of a leaderboard (seeing yourself climb) is lost;
the screen reads as a static table, not a live ranking.

**Recommendation:** animate rank transitions — rows should visibly slide to their new
positions on update, so movement is perceived rather than inferred.
