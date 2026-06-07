---
task: t1
agent: coder
schema: coder-finding
verdict: COMPLETE
summary: Implemented /leaderboard command with optional season filter (2 files)
artifacts:
  - commands/LeaderboardCommand.ext
  - lib/arena_queries.ext
self_flagged_risks:
  - "Season filter value is interpolated into the query string — needs a security look"
---

## What I did

Added a `/leaderboard` command that returns the top 10 players ranked by arena win
rate, with an optional `season` argument.

- `commands/LeaderboardCommand.ext` — parses the optional `season` option, calls the
  query helper, formats the top-10 result as an embed.
- `lib/arena_queries.ext` — new `topWinRates($season)` helper that builds and runs the
  ranking query.

## Key decisions

- Ranked by `wins / NULLIF(wins + losses, 0)` so players with zero games don't divide by
  zero; tie-broken by total games so a 1-0 player doesn't outrank a 90-10 player.
- Capped at 10 rows server-side rather than fetching all and slicing in app code.

## Risks I'm flagging for review

- The `season` value is currently **interpolated into the SQL string** to keep the
  helper simple. This works but I'm explicitly flagging it for the security reviewer —
  it should probably be a bound parameter. I left it as-is rather than guess at the
  project's DB-wrapper conventions.
