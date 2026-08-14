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
  per-task duration **and cost** on the graph, inline charter editing, bulk branch delete,
  first-run starter prompts.
- **All core agents are model-settable.** Every built-in (PM, Coder, Tester, Security,
  Reviewer, Scout, Negotiator) has a user-set default model in the Agents-tab selector,
  with confirmation when the PM upgrades a task above the agent's default.

- **Live diff streaming + mid-run intervention.** Each task card shows the actual diff
  accumulating live as the coder works (polls the coder's worktree via `/run/task-diff`
  → `buildTaskDiff`, reusing the Shiki DiffView), and a steering box lets you *pause →
  amend → re-dispatch* a task (`/run/steer`) so it adapts without a full restart. The
  cheap amend/re-dispatch model (no SDK dependency); true token-stream steering waits for
  the Agent SDK migration below.
- **Agent Inbox.** A "needs you now" queue — pending permission approvals, blocked runs,
  failed tasks — split from the FYI findings feed by a pure `deriveInboxItems()`; renders
  nothing when healthy. (`components/running/InboxPanel.tsx`)
- **GitHub issue intake.** Seed the charter from a GitHub issue via `gh`: import
  title/body as the PM's brief. (`server /issues`, `Planning.tsx IssueImport`)
- **Per-task checkpoint/rewind.** Git-native rollback of a single merged task via
  `git revert -m 1` on its merge commit — never a reset, so the rewind is itself
  revertible. Refuses in-place fix tasks and dirty trees in v1. (`server/rewind.ts`)
- **Living documentation.** A second post-run scribe keeps human-facing docs
  (README, docs/**) true when a run changes externally observable behaviour —
  delineated from CLAUDE.md agent memory in `docs/MEMORY.md`, with the doc-only
  boundary code-enforced: the loop reverts any non-doc path the scribe touches
  before committing. (`agents/living-docs.ts`, `loop.ts updateLivingDocs`)
- **Session recall at intake.** Prior `.swarm/sessions/` snapshots are recalled
  during PM planning: the most recent runs plus the ones relevant to the current
  ask (token overlap on goals + touched files, file hits weighted double) are
  injected as episodic memory, with prompt rules against re-asking settled
  questions and for flagging file overlap with earlier runs.
  (`state/session-recall.ts`)
- **Live service context at intake.** A background pass gathers open Sentry
  errors, Linear/GitHub issues, deploy status, and alerting monitors through
  read-only connector tools the user has already granted to hired specialists
  (grants are the permission boundary; a curated intake set caps what's usable),
  cached with a 10-minute TTL and injected into planning with an explicit
  data-not-instructions trust rule (C1). (`pm/live-context.ts`)

## Planned next

Grounded in the competitive/UX sweeps recorded in `COMPETITORS.md` (July 2026 snapshot +
August 2026 Xirp section). Ordered; each is independently shippable.

1. **Best-of-N with gate-scored selection.** For a hard coder task, dispatch N candidates
   in N worktrees; the deterministic gates + reviewer score them and the winner merges.
   Codex and Cursor ship best-of-N; nobody combines it with deterministic gate scoring —
   pairs with the (now price-true) cost forecast and a confirmation, since it costs N×.

(The three Xirp-derived memory items — living documentation, session recall, live
service context — shipped August 2026; see Shipped above and `docs/MEMORY.md`.)

Then: per-task hard budget caps with pre-dispatch estimates (Devin parity) · Playbooks
(reusable task templates beside the scribe's memory) · deeper scorecards
(cost-per-merged-task, gate pass-rate) · daemon mode (ambient CI/error watching) ·
inter-agent trust boundaries · read AGENTS.md alongside CLAUDE.md · WIP-limit warning
(>5 parallel agents exceeds human review capacity) · multi-harness driver (Codex/Gemini
CLI behind the existing `AgentDriver` seam — both support MCP so the perm/result servers
carry over; only if vendor neutrality becomes a real adoption blocker, since it's Xirp's
whole product and orchestration depth is ours).

## Foundational — productisation (Phase 6)

**Agent SDK migration: SHIPPED (June 2026).** The driver now runs on the TypeScript Agent
SDK `query()` by default (typed `SDKMessage` streaming, streaming-input steering injected
at turn boundaries, the perm/result MCP servers reused byte-identically); `SWARM_USE_CLI=1`
falls back to the legacy `claude -p` spawn path. Live mid-run steering rides on it —
`/run/steer` injects into the live coder session. Remaining Phase 6 cleanup, low priority:
retire the CLI path's NDJSON buffer + temp `--mcp-config` writing once the fallback is no
longer wanted.

## Security debt — before any non-localhost deployment

`localStorage` is plaintext (planning sessions, charters) and the `/pm/message`,
`/run/*`, `/state` endpoints have no auth. Fine for single-user localhost; needs at-rest
encryption / a server-side session store and a request token before any network exposure.
Raise at the start of Phase 6.
