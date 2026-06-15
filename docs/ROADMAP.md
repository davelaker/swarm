# Roadmap

Opinionated, ordered by leverage. The north star is the moat: **orchestration +
structurally-enforced quality** — the things a parallel-agent runner (see
[COMPETITORS.md](COMPETITORS.md)) structurally cannot copy.

## Shipped

- **Deterministic quality gates.** Real tools (typecheck, hardcoded-secret scan) run as
  *blocking* gates alongside the LLM reviewers; a red gate is treated exactly like a
  CHANGES_REQUESTED finding and spawns a fix-coder. (`agents/checks.ts`)
- **Self-building project memory.** After a run the swarm distils durable, non-obvious
  facts into the project's `CLAUDE.md` under a managed section, and commits it.
  (`drivers/*.runScribe`, `loop.ts distillMemory`)
- **The Negotiator.** Adjudicates two agents that disagree on the same artifact, with a
  code-enforced guardrail: it can never rule away a `negotiable:false` correctness/safety
  finding. (`loop.ts firstNonNegotiable`)
- **Visual verification.** For UI work the swarm renders the changed routes in a headless
  browser and attaches screenshots to a finding — proof a change renders. (`agents/visual.ts`)
- **Agent scorecards.** The marketplace shows real track records aggregated across every
  saved run — runs, issues caught, $/run — so you hire on evidence, not a blurb.
  (`server/scorecards.ts`)
- **Pre-push code review.** A full review surface: Shiki-highlighted structured diffs
  (word-level intra-line), inline multi-line comment threads with server persistence, and
  a fix loop — apply directly (coder + reviewer) or let the PM coordinate, in-surface,
  with live `fixing → resolved` comment status while the diff stays open.
  (`server/diff.ts`, `server/review.ts`, `components/running/DiffView.tsx`)
- **UX/observability layer.** Stale-server nudge, desktop finish notifications, a
  quality-gate summary strip, pre-flight readiness checks, a pre-run cost/time forecast,
  per-task duration on the graph, inline charter editing, bulk branch delete, first-run
  starter prompts.

## In progress

**Live diff streaming + mid-run intervention.** Each task card shows the actual diff
accumulating (not just "Editing war-view.tsx"), and a steering box lets you *pause →
amend → re-dispatch* a task ("use the eyebrow class, not a new divider") so it adapts
without a full restart. The moment it stops feeling like a black box. The cheap
amend/re-dispatch model ships first (no SDK dependency) to validate that anyone steers
mid-run — true token-stream steering waits for the Agent SDK migration below.

## Planned next — ecosystem

- **Live per-task diff accumulation.** Surface each task's diff building up on its graph
  card during the run, reusing the Shiki DiffView — the other half of the item above.
- **Per-task cost on the graph cards.** Live duration already shows; cost flows through
  `task.metrics` and can be surfaced per card to spot the expensive agent.

## Foundational — productisation (Phase 6)

**Migrate the agent driver from `claude -p` one-shot to the Agent SDK `query()` session
model.** Today `drivers/agent-sdk.ts` spawns `claude -p` fire-and-forget and parses CLI
NDJSON. Moving to the TypeScript Agent SDK `query()` is a foundational investment:

- **Typed streaming** — structured `SDKMessage` objects instead of hand-parsing
  `--output-format stream-json` NDJSON (replaces `drivers/stream-parse.ts`).
- **Native `interrupt()` + session lifecycle** — proper start/steer/stop instead of
  spawn-and-await.

The payoff for mid-run intervention rides along: the SDK's async-generator input lets you
inject a steering message into a *live* session, picked up at the **next turn boundary**
(true mid-token injection is not, and should not be, possible). But steering is the
*consequence*, not the *reason* — do this only after the cheaper pause → amend →
re-dispatch model has validated that anyone steers mid-run, and once the SDK has matured
the documented CLI streaming input and native `query()` interrupt.

## Security debt — before any non-localhost deployment

`localStorage` is plaintext (planning sessions, charters) and the `/pm/message`,
`/run/*`, `/state` endpoints have no auth. Fine for single-user localhost; needs at-rest
encryption / a server-side session store and a request token before any network exposure.
Raise at the start of Phase 6.
