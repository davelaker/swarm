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

## Planned next — from the July 2026 landscape research

Grounded in the competitive/UX sweep recorded in `COMPETITORS.md` → "Landscape snapshot —
July 2026". Ordered; each is independently shippable.

1. **Agent Inbox.** A "needs you now" queue — pending permission approvals, blocked runs,
   deadlock escalations — separated from the FYI findings feed, with typed actions
   (approve/deny/steer) on each item. The most-cited agent-UX pattern of 2025–26;
   over-notification (mixing FYI with action-required) is the top documented trust-killer.
2. **Issue-tracker intake.** Seed the charter from a GitHub issue (`gh` is already a
   dependency): import title/body as the PM's brief, link the run back to the issue.
   Ticket-as-unit-of-work is table stakes across Factory, Charlie, and Agent HQ.
3. **Best-of-N with gate-scored selection.** For a hard coder task, dispatch N candidates
   in N worktrees; the deterministic gates + reviewer score them and the winner merges.
   Codex and Cursor ship best-of-N; nobody combines it with deterministic gate scoring —
   pairs with the (now price-true) cost forecast and a confirmation, since it costs N×.
4. **Per-task checkpoint/rewind.** Git-native rollback of a single task's changes —
   worktrees and captured per-task diffs already exist, so this is mostly surface. The
   trust feature that lets users supervise less.

Then: per-task hard budget caps with pre-dispatch estimates (Devin parity) · Playbooks
(reusable task templates beside the scribe's memory) · deeper scorecards
(cost-per-merged-task, gate pass-rate) · daemon mode (ambient CI/error watching) ·
inter-agent trust boundaries · read AGENTS.md alongside CLAUDE.md · WIP-limit warning
(>5 parallel agents exceeds human review capacity).

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
