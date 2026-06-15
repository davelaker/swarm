# Roadmap

Opinionated, ordered by leverage. The north star is the moat: **orchestration +
structurally-enforced quality** — the things a parallel-agent runner (see
[COMPETITORS.md](COMPETITORS.md)) structurally cannot copy.

## In progress — moat-deepeners (this branch)

1. **Deterministic quality gates.** Real tools (typecheck, tests, secret scan,
   dependency audit, SAST) run as *blocking* gates alongside the LLM reviewers. A red
   gate is treated exactly like a CHANGES_REQUESTED finding and spawns a fix-coder.
   Turns "we have a security agent" (advisory — see [THREATS.md](THREATS.md) S6) into
   "the swarm cannot ship a secret-leaking or type-broken diff."
2. **Self-building project memory.** After a run, the swarm distills durable, non-obvious
   facts it learned (conventions, gotchas, constraints) into the project's `CLAUDE.md`,
   so every run makes the next one smarter. Idempotent, deduped, in a managed section.
3. **The Negotiator.** When two agents genuinely disagree on the same artifact, an
   adjudicator reconciles them — with the hard guardrail that it can never rule away a
   correctness or safety finding (see [NEGOTIATOR.md](NEGOTIATOR.md)).

## Planned next — trust/delight + ecosystem

4. **Live diff streaming + mid-run intervention.** Each task card shows the actual diff
   accumulating (not just "Editing war-view.tsx"), and the "Message the PM — pause to
   intervene" box *steers a running agent* ("use the eyebrow class, not a new divider")
   so it adapts without a full restart. The moment it stops feeling like a black box.

5. **Visual verification for UI changes.** For frontend work the swarm spins up the dev
   server, captures before/after screenshots, and attaches them to the finding — proof a
   change renders, not just a claim. Plays directly to the existing preview harness and to
   frontend-heavy targets like the eclipse app.

6. **Agent scorecards in the marketplace.** Track each agent's pass rate, rework rate, and
   cost across runs so the marketplace shows real track records — you hire the Database
   Specialist because it has caught 8 real issues at $0.20/run, not because of a blurb.
   Turns the marketplace from a catalog into a flywheel.

## Foundational — productisation (Phase 6)

**Migrate the agent driver from `claude -p` one-shot to the Agent SDK `query()` session
model.** Today `drivers/agent-sdk.ts` spawns `claude -p` fire-and-forget (prompt as a
positional arg, stdin ignored) and parses CLI NDJSON. Moving to the TypeScript Agent SDK
`query()` is a foundational investment worth doing on its own merits:

- **Typed streaming** — structured `SDKMessage` objects instead of hand-parsing
  `--output-format stream-json` NDJSON (replaces `drivers/stream-parse.ts`).
- **Native `interrupt()` + session lifecycle** — proper start/steer/stop instead of
  spawn-and-await.
- **On the supported programmatic interface**, not the lower-level CLI plumbing.

The payoff for roadmap item 4 (**mid-run intervention**) rides along for free: the SDK's
async-generator input lets you inject a steering message into a *live* session, picked up
at the **next turn boundary** (after the current tool call — true mid-token injection is
not, and should not be, possible). But steering is the *consequence*, not the *reason* —
it would never justify the migration alone.

**Cost / sequencing.** This re-platforms the machinery that assumes one-shot: the
`submit_result` temp-file path, the permission proxy, the worktree lifecycle, and cost
metering. Do it (a) only after the cheaper **pause → amend → re-dispatch** intervention
model has validated that anyone steers mid-run, and (b) once the SDK has matured the rough
edges the docs warn about (documented CLI streaming input, native `query()` interrupt).
Until then, `claude -p` one-shot + the existing stream-json parsing is the right call.
