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
