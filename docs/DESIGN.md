# Agent Swarm — Design Document

> **Status:** Phases 0–2 built; Phase 3 dashboard frontend complete; SSE wiring and
> planning-mode Claude integration pending.
> **Audience:** The author (single developer), as a durable "revert point" to build from cold.
> **Scope:** A standalone project. Unrelated to the Eclipse Discord bot in whose
> repository this document currently lives.

---

## 1. Purpose of this document

This is a thinking artifact, not an implementation plan. It captures the reasoning,
decisions, and trade-offs from an investigation into building a **multi-agent coding
system** — a "swarm" of role-specialised AI agents coordinated by a project-manager
agent — so that the conclusions can be picked up later without re-deriving them.

It is deliberately opinionated. Where a decision was made, the rejected alternatives
and *why* they were rejected are recorded, because the value of a design doc is mostly
in the roads **not** taken.

---

## 2. Goals

### 2.1 Primary goals

1. **Speed up the author's own projects** in a structured, repeatable way — the first
   and only user, initially, is the author.
2. **Bake in best practices for security and testing** so they are *structurally
   enforced* rather than remembered. Quality should be a property of the system, not
   of the author's discipline on a given day.
3. **Support three classes of work**, each with appropriately different ceremony:
   - **Greenfield** — new projects built from scratch.
   - **Feature updates** — new behaviour added to an existing codebase.
   - **Single tweaks** — small, low-risk one-off changes.
4. **Provide a UX** (eventually) that shows the live state of the agents — what each is
   working on — and a way to **communicate with the Project Manager** agent directly.

### 2.2 Secondary / future goal

5. **Be productisable.** The author habitually turns personal tools into full products.
   The system must be buildable as a single-user local tool *today* without foreclosing
   a future multi-tenant, hosted SaaS *tomorrow* — ideally evolving into it rather than
   being rewritten for it. See [§8 The Four Product-Layer Principles](#8-the-four-product-layer-principles).

### 2.3 Explicit non-goals (for now)

- Not a multi-tenant product on day one.
- Not a hosted service on day one.
- Not attempting true peer-to-peer agent autonomy (see [§5.2](#52-why-not-peer-to-peer)).
- Not replacing human judgement on architecturally significant decisions.

---

## 3. Background & reference points

These are **reference points**, studied to learn from — explicitly *not* templates to
copy or standards to conform to.

### 3.1 The blackboard architecture (the core pattern)

A classic AI coordination pattern: independent specialist components ("knowledge
sources") never talk to each other directly. Instead they read from and write to a
shared, structured store (the **blackboard**), and a **controller** decides who acts
next based on the state of that store. This is the backbone of the design here.

### 3.2 Meta DevMate (industry reference)

Publicly reported (via secondary sources — blogs, not a Meta engineering paper, so
treat specifics as *directional*) as a network of collaborating AI agents rather than a
single assistant. Reported role set: **Planner, Researcher, Builder, Reviewer,
Negotiator**, merged via a "Collaborative Context Framework." The standout idea worth
borrowing is the **Negotiator** — a dedicated agent whose only job is to reconcile
*conflicting outputs* from other agents, rather than leaving the coordinator to
hand-wave the conflict away.

### 3.3 OpenAI Swarm (industry reference — the contrasting choice)

An educational framework popularising the **handoff** pattern: agents share a single
message context and pass control to one another via special tool calls. It represents
the **opposite** design choice to ours and the contrast is the whole lesson:

| Dimension      | OpenAI Swarm style                              | This design (blackboard)                 |
| -------------- | ----------------------------------------------- | ---------------------------------------- |
| State lives in | The shared **message context** (travels inline) | A durable **external store** (file / DB) |
| Coordination   | Agent A *hands off* to Agent B                   | Workers write findings; PM dispatches    |
| Persistence    | Ephemeral — gone when the run ends               | Survives restarts; inspectable           |
| Best for       | Fast, in-band, single-session routing            | Long-running projects, audit trail, HITL |

We chose the blackboard because durability and inspectability matter more than
in-session cleverness for "larger and larger projects."

### 3.4 Other ecosystem references

MetaGPT (an SOP-driven virtual software company: PM/architect/dev/QA roles), CrewAI
(role-playing autonomous agents with goals and backstories), AutoGen, and the
"swarms"/"Agency Swarm" frameworks all orbit the same orchestrator-worker idea. Useful
as prior art; none adopted wholesale.

---

## 4. The constraint that shapes everything

In an interactive harness (e.g. Claude Code), the agent topology is a
**hub-and-spoke, one level deep**:

- The **main conversation is the only orchestrator.** It spawns subagents and collects
  their results.
- **Subagents cannot spawn their own subagents**, and **cannot talk to each other.**
  Each reports back to the hub and stops.

The direct consequence: **the Project Manager *is* the hub** — not a separate persona
nested under another agent. Everything the agents "say to each other" is really them
reading and writing the blackboard that the PM referees. This indirection is the
feature, not a limitation: it is what makes the system inspectable, restartable, and
debuggable when (not if) an agent goes off the rails.

To go beyond human-in-the-loop nudging toward autonomous, durable, programmatic
orchestration, the implementation engine is the **Claude Agent SDK** (the programmatic
SDK), which can run as a long-running local process and give each agent its own system
prompt (persona) and tool allowlist.

---

## 5. Architecture

### 5.1 The three layers

A multi-agent system with a UX is not one deployable — it is three layers that need not
live in the same place. Separating them is what makes the hosting question
([§7](#7-hosting-decision-local-first-single-tenant)) easy and reversible.

1. **Control plane + UX** — the dashboard (live agent state) and the chat-with-the-PM
   interface.
2. **Orchestrator + blackboard** — the PM loop and the shared state store (the brain +
   memory).
3. **Workers / execution** — the specialist agents that actually edit files and run
   tools.

### 5.2 Why not peer-to-peer?

Even where frameworks *allow* agents to message each other directly, the clean designs
route everything through a shared store + coordinator. Direct peer-to-peer LLM chatter
tends to spiral: agents over-converse, loop, and agree too readily. **Coordinator-
mediated coordination via the blackboard is a deliberate constraint that keeps the
system sane**, not a shortcoming to be engineered away.

### 5.3 Personas (the agents)

Each persona is a subagent with a system prompt, a **write-scope**, and a tool
allowlist. Write-scope is an access-control decision, not a stylistic one.

| Persona                  | Reads                       | Writes                       | Tools             |
| ------------------------ | --------------------------- | ---------------------------- | ----------------- |
| **PM / Orchestrator**    | everything                  | `state` (task graph), `log`  | spawn agents only |
| **Coder**                | its task + dependencies     | code files, `findings/coder-*` | full edit / shell |
| **Tester**               | code + its task             | tests, `findings/tester-*`   | edit + run tests  |
| **Security Reviewer**    | code + its task             | `findings/security-*` only   | **read-only** code |
| **Negotiator** (opt.)    | conflicting findings        | `resolution-*`               | read-only         |

**Critical invariant: only the PM writes task `status`.** Workers write *findings*; the
PM reads findings and decides the status transition. If workers self-report status into
the shared graph, you get races and agents marking their own homework. This single rule
prevents most multi-agent chaos.

> **Enforcement (threat review S1).** This must be a **code-level access control** in the
> state repository — writes are checked against the calling actor's identity and a
> non-PM `status` write is *rejected* — not a prompt convention. A convention an LLM
> "follows" is bypassable by a confused or hostile agent. Likewise the read-only/write-scope
> rows above are enforced by the tool-grant layer and the sandbox, not by the agent's
> goodwill.

A **read-only reviewer cannot "helpfully fix" things** and therefore cannot pollute the
diff — another reason write-scope is enforced, not advisory.

> **Agent-sdk driver (partial S1 improvement).** When the `agent-sdk` driver is active, the
> Security Reviewer is dispatched with `--allowedTools "Read,LS,Glob,Grep"`. This is
> **code-level enforcement at the CLI**: the `claude -p` subprocess physically cannot invoke
> write-scope tools regardless of what the agent's LLM output asks for. This closes the
> prompt-convention gap for the agent-sdk driver. The `api-key` driver still relies on the
> tool-grant layer and prompt convention — the Phase 4.5 sandbox is still required for full
> isolation on both drivers.

---

## 6. The blackboard & control loop

### 6.1 Design principle: the store is a task graph, not a chat log

The single most important data decision. A structured task graph keeps the
orchestrator's "understand what's going on" step **cheap and deterministic**; a growing
free-form log makes it expensive and noisy to re-read every cycle.

### 6.2 `state.json` — minimal schema

```json
{
  "project": "add-arena-leaderboard",
  "owner": "me",
  "goal": "Add a leaderboard command showing top 10 arena win rates",
  "tier": "feature",
  "updated_at": "2026-06-06T10:30:00Z",
  "tasks": [
    {
      "id": "t1",
      "title": "Implement /leaderboard command",
      "status": "done",
      "owner": "me",
      "assignee": "coder",
      "depends_on": [],
      "artifacts": ["commands/LeaderboardCommand.ext"],
      "result_ref": "findings/coder-t1.md",
      "attempts": 1
    },
    {
      "id": "t2",
      "title": "Security review of t1",
      "status": "in_progress",
      "owner": "me",
      "assignee": "security",
      "depends_on": ["t1"],
      "artifacts": [],
      "result_ref": null,
      "attempts": 0
    }
  ],
  "log": [
    { "ts": "...", "actor": "pm",    "event": "created t1, t2" },
    { "ts": "...", "actor": "coder", "event": "t1 done -> findings/coder-t1.md" }
  ]
}
```

`status` enum: `pending | in_progress | blocked | done | failed`. An `in_progress` task also
carries a **`lease`** (worker + heartbeat + expiry) used for crash recovery — see §6.4.

**Two deliberate choices:**

- **Findings live in separate files (`result_ref`), not inline.** The large security
  write-up lives in `findings/security-t2.md`; `state.json` stays small so the PM can
  re-read it cheaply every cycle. *This is the single biggest lever for keeping cost and
  noise down.*
- **`depends_on` encodes the workflow.** The PM does not need to *reason* about
  ordering — it runs any task whose dependencies are all `done`. The graph itself
  encodes "code → test → security → done."

> Note the `owner` field on the project *and* every task. Today it is the constant
> `"me"`. It exists now purely to honour [Product Principle #1](#principle-1--tenancy-from-day-one).

### 6.2a Finding frontmatter — the gate contract

A finding's body is free-form prose, but its **YAML frontmatter is a strict contract** —
because the PM gates on it, the Negotiator detects conflicts from it, and control C2
validates it. It is defined here once; every example finding (`examples/.../*.md`) and the
ruling schema (`NEGOTIATOR.md` §5) conform to it. The frontmatter is **two-level**:
document-level gate fields, plus a `findings[]` list of the individual issues.

```yaml
# --- document level: what the PM gates on ---
task: t3                  # the artifact/task this finding is about — the conflict-detection locus
agent: security           # who produced it
schema: security-finding  # finding subtype: security-finding | ux-finding | perf-finding | …
verdict: CHANGES_REQUESTED # APPROVED | CHANGES_REQUESTED | …
blocks_done: true         # SYSTEM-DERIVED — does this block the task reaching done?
negotiable: false         # SYSTEM-DERIVED from schema — can the Negotiator trade it away?
summary: >                # optional one-liner
  SQL injection in the season filter.
disputes: null            # optional: a finding-id this finding formally contests (A5 signal)
cannot_satisfy: null      # optional: finding-ids a builder reports it cannot satisfy (A5 signal)

# --- issue level: one entry per concrete issue ---
findings:
  - id: SEC-1
    severity: HIGH
    type: SQL Injection (CWE-89)
    location: lib/arena_queries.ext :: topWinRates($season)   # per-issue — A5 overlap test reads these
recommended_followups:
  - "Rebind the season filter as a parameterised query before this can reach done."
```

A single-issue finding (e.g. `ux-finding`, `perf-finding`) may carry one `findings[]` entry;
the issue's structured `id` + `location` still belong in frontmatter, **not** only in the
prose heading, so detection never has to read the body. A **builder completion report**
(e.g. `schema: coder-finding`, `verdict: COMPLETE`) carries `task`/`agent`/`schema`/`verdict`
but no gate fields — `blocks_done`/`negotiable` apply only to **reviewer** findings, which
are the ones that gate.

Two fields are **system-derived, not agent-authored** (threat review S1): `blocks_done` and
`negotiable` are set by the system from the finding's `schema` (e.g. `security-finding` ⇒
`negotiable: false`), never taken from what the producing agent wrote — otherwise a mistaken
or compromised agent could downgrade a vulnerability or suppress a gate. The detection fields
(`task`, per-issue `location`, `disputes`, `cannot_satisfy`) are what `NEGOTIATOR.md` §3
reads to raise conflict *candidates* — all structured, never prose. Control **C2** validates
an incoming finding against this contract and **fails closed** on any violation.

### 6.3 The orchestrator loop (the PM)

> This loop is **Execute mode**. It is preceded by **Planning mode** — a conversational
> brainstorm in which the PM pressure-tests the project and produces the **Project
> Charter** that seeds this graph and every agent's context. The single-launch entry point
> (`swarm` → opens the browser → PM chat) starts in Planning mode by default. See
> `INCEPTION.md`.

The PM does not write code or perform reviews. It does four things, repeatedly, until
the graph is complete:

```text
loop:
  state = read_state()                       # via the state repository interface (§8.3)
  reconcile(state)                           # §6.4 — reclaim tasks whose worker died

  if all tasks done:                          -> report to human, STOP
  if any task failed and out of attempts:     -> escalate to human, STOP

  runnable = [ t in state.tasks
               if t.status == "pending"
               and every dep in t.depends_on is "done" ]

  if runnable empty and in_progress with live leases:  -> wait / poll
  if runnable empty and nothing in_progress:  -> DEADLOCK -> escalate to human, STOP

  for task in runnable:
     set task.status = "in_progress"; acquire lease; write_state()   # §6.4
     result = dispatch(task.assignee, task, state)   # narrow boundary (§8.2)
     # worker writes findings/<task>.md and returns a summary
     set task.status from result; release lease; append log; write_state()
```

The PM's intelligence lives in **triage, dispatch decisions, and failure handling** —
*not* in doing the work. When the Coder reports "t1 done," the PM re-reads state, sees
t2's dependency satisfied, and dispatches the Security agent. The flow the author
described ("PM tells the coder, coder says done, PM then tells security") falls out of
this loop *mechanically*, driven by the graph rather than the PM "remembering."

### 6.4 Crash recovery & restart *(threat review A1)*

The blackboard is a **durable store**, but durable *state* is not the same as *recovery*.
The loop above has a gap: between `set in_progress; write_state()` and `set status from
result; write_state()` sits `dispatch()` — a long-running, possibly forked call. **If the
process dies there, the task is stranded `in_progress`.** On restart the loop sees it
neither `pending` (so not runnable) nor `done`, and `runnable empty + work in_progress →
wait` would block on a phantom worker forever. "Survives restarts / restartable" needs
three mechanisms to be real:

**1. Leases + heartbeat.** Dispatching a task records a lease on it:

```json
"lease": { "worker": "coder", "started_at": "...", "heartbeat_at": "...", "expires_at": "..." }
```

The worker (or the PM on its behalf) refreshes `heartbeat_at` while it runs. A lease whose
`expires_at` has passed with no heartbeat is **expired** — the worker is presumed dead. The
lease is how the system *detects* death; the heartbeat is what distinguishes "still working"
from "crashed."

**2. Reconcile-on-startup (and on lease expiry).** A `reconcile()` pass runs at the top of
every loop iteration (so it covers both cold restart and mid-run worker death). It sweeps
`in_progress` tasks:

- `in_progress` with an **expired or missing lease** → the worker is gone. If the task can
  be safely re-run and has attempts left, reset to `pending` (reclaim); otherwise mark
  `failed`. Increment a recovery counter.
- This converts the phantom-deadlock — `runnable empty + in_progress` — into recovery: an
  expired lease means "reclaim," not "wait." Only **live** leases justify waiting.

**3. Idempotent dispatch.** Reclaiming is only safe if re-running is safe, because a task may
have *partially* completed before the crash — written a file, committed, even pushed:

- Worker outputs are addressed by task id (`findings/<task>.md`, deterministic artifact
  paths), so a re-run **overwrites rather than duplicates**.
- Re-dispatch carries an **idempotency key** = `(task_id, attempt)`, so any retried
  external/dangerous action (the C3 set — push, deploy, install) is de-duplicated at the
  broker rather than double-applied. *A re-run after a crash must not double-push.*
- Before re-running, reconcile checks for the task's expected `result_ref`: if it exists and
  passes schema validation (control C2), the task can be **adopted as complete without
  redoing the work** — belt-and-braces against repeating expensive work that actually
  finished.

**Atomic state writes.** `write_state()` must be crash-atomic (write-temp-then-`rename`), or
a crash mid-write corrupts the single source of truth. Behind the repository interface
(§8 Principle 3) this is *one* place to get right; the DB-backed future inherits it from
transactions.

**Bounded recovery.** Reclaim-and-retry consumes the task's attempt budget (and C4 budget),
so a task that crash-loops eventually exhausts attempts → `failed` → escalate, rather than
retrying forever.

> In one line: **durable state + leases to detect death + reconcile to act on it +
> idempotency to make re-running safe.** That quartet — not the durable store alone — is
> what backs the "restartable" claim. It also composes with the controls: reconcile adopts
> C2-valid results, idempotency protects C3 actions, retries draw on the C4 budget.

---

## 7. Hosting decision: local-first, single-tenant

### 7.1 The decision

**Build it local-first and single-tenant. Do not host it (yet).**

### 7.2 Why

With a single user, almost every argument *for* hosting is a multi-user argument
(sandboxing untrusted workloads, central updates, distribution, billing,
reach-from-anywhere for customers). None of those apply yet, so hosting is pure
overhead. Meanwhile the deciding technical fact lands on the local side: **"feature
updates" and "single tweaks" operate on the author's existing repos, on the author's
machine, with the author's toolchain and secrets** — exactly the case where local
execution is both simpler and safer (no uploading working directories, no replicating
the dev environment in a container, no secret-shipping). Greenfield works locally too,
so supporting all three tiers costs nothing extra.

### 7.3 The options weighed

| Option            | What                                              | Pros                                                                 | Cons                                                                                          |
| ----------------- | ------------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **A. Fully local** | Agents, state, local web UI all on the user's box | Direct file/tool/secret access; user brings own key; zero infra/sandbox burden | Machine must be on/awake; eats local CPU/RAM; no remote reach; distribution & updates on you   |
| **B. Fully hosted** | Cloud containers run agents; web UX             | Always-on; reachable anywhere; trivial updates; scales to many users | Code must be cloud-reachable; **you own the sandbox/isolation problem**; key & billing management |
| **C. Hybrid**     | Hosted brain (PM, blackboard, UX) + thin local runner | Always-on control plane *and* local fs/tool access without uploading code | Most moving parts; build control plane *and* local agent *and* the secure channel between them  |

**Chosen: A**, with the explicit note that the architecture is **deployment-agnostic** —
`state.json` + the orchestrator loop run identically whether on a laptop or a cloud
container. The store does not care where it lives.

### 7.4 Agent SDK billing model (verified June 2026)

**The local-first decision is unchanged and still correct.** This subsection records what
changed in the billing landscape and what it means for the dual-driver architecture.

Starting June 15, 2026, Anthropic splits billing into **two separate pools that do not
commingle**:

| Pool | Covers | Billing |
| ---- | ------ | ------- |
| **Pool 1 — Interactive** | Claude.ai, Claude Code terminal, Cowork | Covered by subscription limits |
| **Pool 2 — Agent SDK** | `claude -p`, Agent SDK usage, Claude Code GitHub Actions | Separate monthly credit, billed at API rates |

The **agent-sdk driver draws from Pool 2**, not the interactive pool. Max plan monthly
credits: $100/month at the 5× tier, $200/month at the 20× tier. The api-key driver
draws directly from the Anthropic console billing account.

**What this means for the dual-driver design:**

- Both auth paths are viable for local single-tenant use; the auto-detection logic
  (`drivers/index.ts`) picks the right one.
- The `claude -p` subprocess IS the Claude Agent SDK — it wraps over stdio, not direct
  REST calls. This is the correct programmatic interface for the agent-sdk driver.
- The `--max-budget-usd` flag provides per-dispatch cost caps (control C4) at the CLI
  level, complementing the global budget check in the PM loop.
- OAuth tokens (`sk-ant-oat01-*`) are **not** a third auth path — using them for
  programmatic REST calls violates Consumer ToS and is server-enforced rejected.

### 7.5 Recovering "always-on" without changing the architecture

The only real thing local costs is always-on / reach-from-phone. That is recoverable
*without* a rewrite by running the *same single-tenant app* on a cheap always-on box the
author owns (home server, mini-PC, or a personal cloud VM with the repos checked out).
That is still "local" in every way that matters — full trust, direct filesystem access,
single tenant — just on a machine that does not sleep. Deferring this is a
where-do-I-run-the-process choice, not a rewrite.

---

## 8. The Four Product-Layer Principles

The trap when productising a personal tool is *not* "I didn't build enough for scale."
It is "I baked single-user assumptions into every file, so multi-tenant is a teardown."
The discipline is therefore **not** building product machinery now (premature, slower) —
it is **not hardcoding the assumptions that are expensive to undo**. There are exactly
four such seams. Each is a cheap habit today and the difference between *evolving* into a
product and *rewriting* for one.

> Guiding idea: **the local tool and the product are the same architecture at two
> different trust levels.** Draw the seams now; fill them in later.

### Principle 1 — Tenancy from day one

Namespace all state by an `owner` / `project` id immediately, even though it is always
`"me"` today. Every task, finding, and blackboard entry carries an owner. Today a
constant; tomorrow a foreign key. This single habit is the difference between *adding
auth* and *rewriting the data model*.

> **Enforcement caveat (threat review S11).** The `owner` *field* is the data-model habit,
> **not** the isolation control — and must not be mistaken for it. A field that no query
> filters on is a future IDOR: the day `owner` becomes real (P6), *every* read through the
> repository interface (Principle 3) must filter by the caller's tenant, enforced **below
> the application** (database row-level security), not by trusting each call site to add a
> `WHERE owner = …`. The single-tenant constant `"me"` means there are **zero** owner-scoped
> queries today, so the gap is invisible until multi-tenant — which is exactly when a missed
> filter becomes a cross-tenant leak. Two requirements when `owner` goes live: (1) RLS (or
> equivalent) enforced in the store, so an unfiltered query returns nothing rather than
> everything; (2) **isolation tests** that assert tenant A cannot read tenant B's state,
> code, or findings — added as a P6 exit criterion, not retrofitted after a leak.

### Principle 2 — A narrow orchestrator↔worker boundary

Today a worker is a local subprocess editing files directly. In a product, that worker
becomes **untrusted code-execution that must run in an isolated container** — the
hardest, most expensive part of hosting a coding agent. Keep dispatch to a narrow
interface (`dispatch(task) -> result`) that never assumes shared memory or filesystem
with the worker. Then "wrap the worker in a sandbox" is a swap behind that interface,
not an excavation. (The same Agent SDK code runs as a local subprocess *or* in a
sandboxed container — same code, different box.)

> **This seam is built: `core/src/drivers/`.** The `AgentDriver` interface
> (`drivers/types.ts`) is the narrow dispatch boundary — `runCoder()`, `runTester()`,
> `runSecurity()`. Two implementations sit behind it:
>
> - **`api-key` driver** (`drivers/api-key.ts`): direct `@anthropic-ai/sdk` with manual
>   tool loops. Requires `ANTHROPIC_API_KEY`.
> - **`agent-sdk` driver** (`drivers/agent-sdk.ts`): invokes `claude -p` (the Claude Code
>   CLI in non-interactive mode). Uses `--print`, `--dangerously-skip-permissions`,
>   `--output-format json`, `--json-schema`, `--allowedTools`, `--max-budget-usd`,
>   `--system-prompt`, and `--no-session-persistence`. Auth is via the user's Max plan
>   subscription (OAuth, not an API key).
> - **`drivers/index.ts`** auto-detects: `SWARM_DRIVER=api-key` → api-key; else
>   `ANTHROPIC_API_KEY` set → api-key; else `claude` CLI available → agent-sdk; else
>   helpful error listing both options.
>
> Swapping to a sandboxed container in Phase 4.5 is a change behind this interface,
> not an excavation.

### Principle 3 — State access behind a repository interface

A single `state.json` on disk is perfect for one user — do **not** over-engineer it. But
put every read/write behind one small module (`get_state()`, `update_task()`, …) instead
of sprinkling file reads across the codebase. Then migrating to a multi-tenant,
concurrent, queryable store later touches **one file**. (A Postgres-backed service with
built-in auth — e.g. Supabase — is a natural fit when users arrive; a "when you have
users" decision, not a now decision.)

### Principle 4 — Secrets / keys behind a config boundary

Route all secrets and API keys through one config/secrets boundary. Today: your env var.
Tomorrow: per-user keys or managed billing. Never hardcode a key or assume a single
global credential across call sites.

> **Two auth paths, one boundary.** The config boundary now auto-detects which auth
> path is available (see Principle 2 driver auto-detection above):
> - **API key path** — `ANTHROPIC_API_KEY` from `console.anthropic.com`. The traditional
>   path; direct REST billing.
> - **Max plan subscription path** — the `claude` CLI authenticated via `claude.ai` login
>   (OAuth). The agent-sdk driver uses this path. Note: OAuth tokens
>   (prefixed `sk-ant-oat01-*`) are **prohibited for programmatic use** and are server-
>   enforced rejected since Jan 9, 2026 — the `claude -p` subprocess is the correct
>   interface, not direct REST calls with these tokens.
>
> The boundary abstracts which path is in use; nothing outside `drivers/index.ts` needs
> to know.

> **Scope clarification (threat review S5).** This boundary governs the **swarm's own
> credentials** (the LLM API keys). It does **not** protect the **user's project secrets** —
> a Coder with shell + filesystem read can read `.env`, hardcoded credentials, and cloud
> configs in the repo directly, no matter how this boundary is built. Protecting project
> secrets from the agents is a *sandbox + secret-scanning/redaction* problem, not a config
> abstraction. Don't let this principle read as "agents can't see secrets" — they can see
> the repo's.

> Four cheap habits, none of which slows you down now. Together they mean that the day
> you decide "this should be a product," you are *adding* auth, a sandbox, and a hosted
> store **behind interfaces that already exist** — not excavating single-user
> assumptions out of a hundred call sites.

---

## 9. Tiered ceremony (right-sizing the pipeline)

A one-line tweak must **not** march through Planner → Coder → Test → Security →
Negotiator — that would make the system slower than doing it by hand, and it would fall
into disuse. The PM's **first** action on any request is to **classify it and build the
right task graph.** This is also how "best practices for security and testing" stop
being a hope and become *structural*: testing and security are **dependency edges in the
graph**, scaled to the size of the change.

| Tier          | Trigger                          | Pipeline                                                      |
| ------------- | -------------------------------- | ------------------------------------------------------------ |
| **Tweak**     | one-liner, low blast radius      | Coder → run tests. Skip the swarm.                           |
| **Feature**   | new behaviour on existing code   | Coder → Tests → Security review → done                       |
| **Greenfield**| new project                      | Planner → Coder → Tests → Security → (Negotiator on conflict)|

In blackboard terms: fewer `depends_on` edges for a tweak; the full chain for
greenfield. A `feature` task literally cannot reach `done` until its test task and
security task are `done` first. Quality becomes a property of the graph topology.

---

## 10. Failure modes & how the design handles them

| Failure mode             | Cause                                              | Mitigation built into the design                                                            |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Concurrent writes**    | Two workers finish at once and both write state    | Workers write only their own `findings/*`; the **single-threaded PM loop** is the sole `state.json` writer. Serialise the writer. |
| **Runaway cost / loops** | A failing task + a determined PM retrying forever  | `attempts` counter per task **+ a global step budget** as a hard kill switch.               |
| **Conflicting outputs**  | Coder says "done & secure"; Security says "SQLi"   | A dedicated **Negotiator** reconciliation step beats the PM hand-waving the conflict.        |
| **Deadlock**             | Dependency cycle, or every task blocked            | Loop detects "nothing runnable *and* nothing in progress" as an explicit state → escalate to human, do not spin. |
| **Context crowding**     | Every worker's full output competes for PM context | Findings off-loaded to files; PM re-reads a small task graph, not the transcripts.           |
| **Self-marked homework** | Workers set their own task status                  | Invariant: **only the PM writes `status`.**                                                 |

---

## 11. Convergence note

The author's independently-arrived-at design and Meta's DevMate converge on the same
shape: **role agents that never talk directly, coordinating through shared state that a
coordinator arbitrates.** The agents *feel* like they communicate, but they are really
reading and writing a structured store the PM referees. That convergence is reassuring
evidence the shape is right, not a sign of copying — DevMate is a revert point, not a
template.

---

## 12. Open questions / future work

- **UX form factor:** **resolved** — local web app (React + TypeScript + Vite in `ui/`).
  Built through Phase 3 frontend. Real-time mechanism **resolved** → **SSE** (confirmed
  correct; the Phase 0 event bus has been emitting since the start). Plain **POST** for
  actions; see `UX.md`. A worked, concrete render of a real run lives in
  `examples/leaderboard-run/`.
- **Planning mode UI:** Interactive PM conversation built in the UI (keyword-matching mock).
  Real Claude API integration for the planning PM is the remaining Phase 4 item.
- **Dual-driver auth question:** **resolved** — the `AgentDriver` interface in
  `core/src/drivers/` abstracts both the API key path and the Max plan subscription
  (agent-sdk) path. Auto-detection logic in `drivers/index.ts`. See §8 Principle 2 and §7.4.
- **Negotiator** *(designed → `NEGOTIATOR.md`)*: triggers `on_conflict`; arbitrates
  *negotiable* trade-offs only and can never rule away a correctness/safety
  (`negotiable:false`) finding — it upholds or escalates. Worked example in
  `examples/negotiator/`.
- **Starter catalog** *(designed → `CATALOG.md`)*: routing contracts for the first ten
  hireable specialists, which doubles as the real spec for the contract schema.
- **State store migration trigger:** at what point (concurrency? multi-project?) does
  `state.json` graduate to a real DB?
- **Sandbox technology** for the eventual hosted worker (containers per session, à la
  ephemeral cloud dev environments) — deferred until productisation.
- **Multi-model:** DevMate is explicitly multi-model. Worth considering whether
  different personas benefit from different models (e.g. a cheaper model for tweaks).
- **Agent marketplace** *(designed → `MARKETPLACE.md`)*: a catalog of installable,
  customisable persona templates (hire a UX Researcher, etc.) on top of the default team.
  This refines §5.3 (personas become installable **templates**) and §9 (the fixed tier
  pipelines become **filters** over whatever team is installed — the PM reads each agent's
  *routing contract* and assembles the graph, so it never hardcodes the cast).

---

## 13. Glossary

Technical terms and emerging industry vocabulary used in this document.

| Term | Definition |
| ---- | ---------- |
| **Agent (LLM agent)** | An LLM instance given a goal, a system prompt, and tools, which acts in a loop (reason → act → observe) to accomplish a task. |
| **Agent SDK (Claude Agent SDK)** | The programmatic SDK for building agents in code (vs. the interactive CLI). Lets you define personas, tool allowlists, and long-running orchestration loops. The intended implementation engine here. In practice, `claude -p` (the Claude Code CLI in non-interactive mode) IS the Claude Agent SDK — it wraps over stdio rather than making direct REST API calls. The `agent-sdk` driver uses this interface. |
| **Artifact** | A concrete output of a task — a code file, a test file, a findings document — referenced from the blackboard. |
| **Blackboard architecture** | A coordination pattern where independent specialist components share a structured store (the "blackboard") instead of talking directly; a controller decides who acts next based on the store's state. The backbone of this design. |
| **Ceremony** | The amount of process applied to a task. High ceremony = full multi-stage pipeline; low ceremony = a single agent. "Right-sizing ceremony" = matching process to task risk/size. |
| **Context window** | The bounded amount of text (tokens) an LLM can attend to at once. A key reason for multi-agent systems: each subagent gets its *own* window, so concerns don't compete for one shared budget. |
| **Control plane** | The layer that coordinates and surfaces the system — here, the UX + the orchestration loop — as distinct from the workers that execute. |
| **Dispatch** | The act of the orchestrator handing a task to a worker agent and awaiting its result, through a narrow interface. |
| **Greenfield** | A project built from scratch, with no existing codebase to respect. |
| **Handoff** | (OpenAI Swarm term.) One agent transferring control of a shared message context to another via a tool call — the *contrasting* approach to the blackboard. |
| **HITL (Human-in-the-loop)** | A workflow where a human approves, arbitrates, or nudges at key points rather than the system running fully autonomously. |
| **Hook** | A harness-executed shell command that fires automatically on an event (file save, session start, agent stop). The mechanism for "automatically on every change" behaviour. |
| **Hub-and-spoke** | A topology where all coordination passes through a central hub (the orchestrator/PM); spokes (workers) do not connect to each other. The native shape of one-level-deep subagent systems. |
| **MCP (Model Context Protocol)** | A standard for connecting agents to external tools and data sources (GitHub, databases, browsers, design tools) via "MCP servers." |
| **Multi-tenant / Single-tenant** | Multi-tenant: one system instance serves many isolated users. Single-tenant: one user, one trust domain. This design starts single-tenant and is structured to *evolve* to multi-tenant. |
| **Negotiator** | (Borrowed from Meta DevMate.) A dedicated agent whose sole job is reconciling conflicting outputs from other agents. |
| **Orchestrator** | The component that reads the blackboard, decides the next action, and dispatches workers. Here it is embodied by the **Project Manager (PM)** persona / main loop. |
| **Persona** | An agent specialised by its system prompt, tool allowlist, and write-scope (e.g. Coder, Security Reviewer). |
| **Repository interface (state repository)** | A small module that mediates all reads/writes to the state store, so the underlying store (file vs. DB) can change behind a stable API. (Principle 3.) |
| **Sandbox / isolation** | Running untrusted, code-executing agents in a contained environment (e.g. an ephemeral container) so they cannot harm the host or other tenants. The chief cost of hosting a coding agent. |
| **Skill** | A reusable, parameterised prompt + instructions invoked as a command (e.g. `/security-review`); a packaged capability. |
| **Subagent** | A separate agent instance the orchestrator spawns for a focused job; it has its own context window, returns a summary, and (in one-level-deep harnesses) cannot spawn further subagents or talk to peers. |
| **Swarm** | Informal umbrella term for multiple coordinated agents working toward a shared goal. Used here loosely; the *specific* coordination model is the blackboard, not free peer-to-peer. |
| **Task graph** | The set of tasks plus their `depends_on` edges. Encodes the workflow declaratively; the orchestrator runs any task whose dependencies are all complete. |
| **Tier (tweak / feature / greenfield)** | The classification the PM assigns a request to determine pipeline ceremony. |
| **Tenancy seam / boundary / interface** | A deliberate abstraction placed where a future product boundary will fall, so single-user assumptions can be replaced without a rewrite. (The Four Principles.) |
| **Trust domain** | A boundary within which components implicitly trust each other (shared filesystem, secrets). Single-tenant local = one trust domain; multi-tenant = many, requiring isolation. |
| **Write-scope** | The set of locations a given persona is permitted to write to — an access-control decision (e.g. the Security Reviewer is read-only on code). |

---

*End of design document.*
