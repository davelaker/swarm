# Agent Swarm — Build Roadmap

> Companion to the design corpus. Sequences implementation into phases. Turns the *design*
> into a *plan*. The ordering is deliberate and risk-driven, not feature-driven.

---

## Two rules that govern the whole plan

1. **Vertical slices over horizontal layers.** Don't build "all the agents", then "the
   state layer", then "the UI." Build the *thinnest end-to-end thing that runs* first (the
   walking skeleton), then thicken it. The point is to validate the riskiest assumption —
   *does a PM→worker loop actually produce good work?* — before investing in UI or a
   marketplace that assume it does.
2. **The four product-layer seams go in from commit one** (`DESIGN.md` §8). Even while
   single-user, every phase below routes through: an `owner` on all state (P1), a narrow
   `dispatch()` worker boundary (P1), a state-repository interface (P0), and a config/secrets
   boundary (P0). They are cheap now and a rewrite later. Phase 6 is *only* affordable
   because of this discipline.
3. **Isolation precedes untrusted code** (threat review S0). The execution sandbox is
   **not** a Phase 6 productisation step — it is a **hard prerequisite for the marketplace**
   (new Phase 4.5). Until it exists, the only agents that may run are first-party ones, and
   the largest blast radius is the *local* machine, not a shared server.

---

## Phase map at a glance

| Phase | Delivers | Realises | Cut line | Status |
| ----- | -------- | -------- | -------- | ------ |
| **0** | Scaffolding + the four seams | DESIGN §8 | — | ✅ Complete |
| **1** | Walking skeleton: PM loop + Coder (tweak tier) **+ eval harness** (+ crash recovery, cost-budget spine) | DESIGN §6 + §6.4, THREATS A4, CONTROLS C4 | **← usable for yourself starts here** | ✅ Complete |
| **2** | Quality gates: Tester, Security, tiers, graph (+ fail-closed parsing, sensitive-path escalation) | DESIGN §6/§9, CATALOG, THREATS S2, CONTROLS C2 | **← MVP personal tool** | ✅ Complete |
| **3** | Local dashboard (SSE) + PM chat (**+ loopback/token/Origin auth**) | UX §1–7, THREATS S3 | **← pleasant to use** | 🔄 Frontend complete; SSE wiring pending |
| **4** | Planning mode + Project Charter (+ charter provenance & scoped injection) | INCEPTION §5.1 | **← the full vision for one user** | 🔄 UI built (mock PM); Claude API integration pending |
| **4.5** | **Execution isolation (sandbox)** | THREATS S0, DESIGN §8 P2, CONTROLS C1/C3 | **← gate before any third-party code** | ⬜ Not started |
| **5** | Marketplace + Negotiator (+ structured conflict detection) | MARKETPLACE, NEGOTIATOR §3, CATALOG | **← the product** | ⬜ Not started |
| **6** | Productisation (multi-tenant, hosted, billing) | DESIGN §7.x, §8 | **← SaaS (only if users)** | ⬜ Not started |

---

## The multi-provider driver layer

After Phase 2 was complete, research into the Claude Agent SDK billing model (see
`DESIGN.md` §7.4) led to a new abstraction layer: `core/src/drivers/`. This is an
extension of **Principle 2** (the narrow orchestrator↔worker boundary).

The `AgentDriver` interface (`drivers/types.ts`) defines the worker and planning roles.
Three implementations sit behind it:

- **`api-key` driver** — `@anthropic-ai/sdk` with manual tool loops. Requires
  `ANTHROPIC_API_KEY`. Straightforward REST billing.
- **`agent-sdk` driver** — `claude -p` subprocess. Requires the `claude` CLI
  (authenticated via a Max plan subscription). Uses `--output-format json` (gives a
  `cost_usd` field), `--json-schema` (validated structured output), `--allowedTools`
  (physical enforcement of tool scope — not prompting), `--max-budget-usd` (per-dispatch
  C4 cap), and `--no-session-persistence`. Draws from the separate Agent SDK billing pool.
- **`codex` driver** — local `codex` CLI. Requires a signed-in Codex CLI. It is strictly
  read-only: a coder returns a schema-constrained unified patch, then Swarm validates its
  base revision and declared path scope, requests broker approval, and applies the exact
  patch itself. Codex never receives native repository write tools.

Provider discovery safely reports CLI/API-key presence only; it does not inspect credentials
or provider configuration. `SWARM_ENABLED_PROVIDERS` limits available providers and
`SWARM_DEFAULT_PROVIDER` chooses `auto`, `anthropic`, or `openai`. Routes are selected per
task, so independent work may use different providers. Explicit unavailable selections fail
closed. The Planning UX allows a compatible available-route override before execution and
locks it when the task starts.

The OpenAI integration currently requires the local Codex CLI even if an `OPENAI_API_KEY`
exists. A native-write Codex mode and an OpenAI API-only driver are deliberately out of scope
until an equivalently enforced sandbox boundary is proven.

**Why this matters for Phase 3:** The `agent-sdk` driver runs agents as subprocesses,
not in-process. The server cannot observe agent progress via in-process callbacks. The
correct architecture — and the reason the Phase 0 event bus was designed to emit from
day one — is a file-watcher on `state.json` and `findings/` feeding the SSE stream. The
dual-driver layer confirms this is the right wiring strategy for Phase 3.

---

## Phase 0 — Foundations & seams ✅ COMPLETE

Scaffolding plus the four interfaces, even though each is trivially backed today.

- Project repo (its own repo — *not* this one); Agent SDK wired as the engine.
- **State repository interface** over a `.swarm/state.json` file. All reads/writes go
  through `get_state()` / `update_task()` / `write_finding()` — never raw file access.
  *Also emits events* from day one (no subscribers yet) so the dashboard plugs in later
  without touching this code.
- **Config/secrets boundary**: API keys resolved through one module (env var today).
- **Dispatch boundary**: a `dispatch(task) -> result` interface with a *stub* worker that
  echoes — proves the seam before any real agent exists.
- `swarm init` scaffolds `.swarm/` (state, `findings/`, `team.config.yaml` with builtins),
  stamps `owner`.

**Exit criteria:** `swarm init` creates the workspace; a stub task round-trips through
`dispatch()` and is persisted + retrieved via the state repository.

> **Built:** `core/src/` contains the state repository, config boundary, dispatch
> boundary, and event bus. `swarm init` and `swarm check` work.

---

## Phase 1 — Walking skeleton: PM loop + Coder (the riskiest bet) ✅ COMPLETE

The smallest thing that does real work end-to-end. **Tweak tier only**, CLI output only
(no dashboard yet).

- The real PM loop (DESIGN §6.3): read state → find runnable → dispatch → update.
- A real **Coder** worker behind the `dispatch()` boundary; writes code + a findings file.
- `owner` carried on every task/finding (Principle 1, as a constant).
- **Crash recovery (DESIGN §6.4, threat A1):** task leases + heartbeat, `reconcile()` at the
  top of the loop, idempotent dispatch (`(task_id, attempt)` key), crash-atomic
  `write_state()`. Cheapest to build *with* the loop, not bolted on after.
- **Cost-budget spine (CONTROLS C4):** meter spend in cost units (not steps) with a global
  hard/soft cap checked in the loop, a fan-out concurrency cap, and a per-dispatch token
  bound. The remaining C4 axes (dispute-round cap) arrive with the Negotiator in Phase 5.
- `swarm new "<a one-line tweak>"` runs it to completion.
- **An eval harness (threat review A4).** Define what "good output" means and measure the
  swarm against a **single capable agent with good prompts** on the same tasks. The whole
  premise — that multi-agent beats single-agent — is unproven and the literature is mixed.
  Build the measuring stick *now*, in the cheapest phase, not after the cathedral is up.

**Exit criteria:** `swarm new "rename X to Y in file Z"` produces the edit, writes
`findings/coder-*.md`, and reports `done` — with the whole flow visible in the CLI; **and**
the eval harness shows the loop is at least competitive with a single agent. *If output
quality is bad, or it loses to one well-prompted agent, stop and fix that before building
anything else — the rest of the roadmap assumes this premise holds.*

> **Built:** Real PM loop and Coder agent via Anthropic SDK. `swarm new "<goal>"` works
> end-to-end. Eval harness built with 2 test cases.

---

## Phase 2 — Quality gates: Tester, Security, tiers, the graph ✅ COMPLETE

Make security and testing *structural*. This is the MVP personal-tool line.

- **Tier classifier** (tweak / feature / greenfield) as the PM's first action (§9).
- **Task graph** with `depends_on` edges; the PM runs any task whose deps are `done`.
- **Tester** and **Security Reviewer** personas (read-only on code for Security).
- The invariant: **only the PM writes `status`** (DESIGN §5.3).
- **Gate integrity (CONTROLS C2):** validate every finding against its schema before it can
  move a task's status; unparseable/invalid/missing gate field **fails closed** (absence ≠
  clean); one bounded repair retry, then escalate.
- **Sensitive-path escalation (threat S2):** any diff touching auth/crypto/permissions/
  input-handling/SQL force-escalates to a security pass regardless of tier.
- The kill switches: per-task `attempts` + the **cost budget from Phase 1** (CONTROLS C4 —
  cost units, not a raw step count).
- The remediation pattern: a Security `CHANGES_REQUESTED` spawns a fix + re-review task
  (the `leaderboard-run` example).

**Exit criteria:** a feature-tier `swarm new` runs Coder → Tester → Security → done; a
deliberately injected vulnerability is caught, blocks `done`, and triggers an automatic
remediation + re-review loop.

> **Built:** Tier classifier, Tester agent (runs real test suites), Security Reviewer
> (read-only), C2 gate validation, S2 sensitive-path escalation, and remediation spawning
> are all implemented. Eval harness extended to 3 cases, including a deliberate SQL
> injection that must be caught.

---

## Phase 3 — The dashboard (control plane + UX) 🔄 IN PROGRESS

Now that the engine works, make it observable and controllable.

- Local web server with the **SSE `/events`** stream subscribing to the repository's event
  bus (which has been emitting since P0) + `GET /state` snapshot.
- The **RUNNING** dashboard (UX §5): task graph, agents panel with live `agent.progress`
  (forwarded tool-call steps), findings feed, PM chat.
- **POST actions**: `/pm/message`, `/run/pause`, `/run/resume`, `/run/abort`.
- **Single-launch**: `swarm` boots everything and **auto-opens the browser**.

**Exit criteria:** `swarm` opens the browser; you start a run and watch nodes recolour,
the active agent's step line tick, and findings stream in live; pause/abort work.

> **Status:** Frontend UI complete (`ui/` — React + TypeScript + Vite). The server
> runs but does not yet watch `state.json` for changes — the SSE `/events` stream is
> not yet wired to the event bus. Remaining work: connect the server-side file watcher
> to the event bus so state changes flow to the UI.
>
> **Note on the agent-sdk driver and SSE wiring.** The `agent-sdk` driver runs `claude -p`
> as a subprocess rather than in-process. This means the server cannot observe agent
> progress via in-process callbacks — it must watch `state.json` (and `findings/`) on
> disk, which is precisely what the Phase 0 event bus was designed for. The file-watcher
> approach is correct and sufficient for both drivers.

---

## Phase 4 — Planning mode & the charter (Inception) 🔄 IN PROGRESS

The front half — brainstorm before execution.

- **Planning mode**: conversational, no workers dispatched; the **critical-partner PM
  persona** (push back, surface trade-offs, resist scope creep).
- **Consultative specialists**: Security/UX/Architect invoked read-only to question the
  idea pre-build.
- The **Project Charter** artifact + schema (INCEPTION §5), injected as
  `{{PROJECT_CONTEXT}}` into every agent's effective prompt.
- **Charter integrity (INCEPTION §5.1, threat A3):** the compile step traces every
  charter claim to the conversation and **flags ungrounded content** at the approval gate
  (so the human ratifies a grounded artifact, not a hallucination / planning-time
  injection); injection is **scoped** — each agent gets the invariant core + its role slice,
  not the whole charter.
- The **approval gate**: compile → approve → build graph → flip PLANNING → RUNNING.
- The **amend path**: execution can drop back to Planning to revise the charter.
- The **PLANNING dashboard** view (live-assembling charter + conversation).

**Exit criteria:** launch → brainstorm a small project → the PM pushes back at least once
and assembles a charter → you approve → it builds the graph and executes *using the charter
as context*; mid-run, you can amend the charter and re-plan.

> **Status:** Interactive PM conversation is built in the UI (keyword-matching mock PM).
> Real Claude API integration for the planning PM conversation — the critical-partner
> persona, consultative specialists, and Charter compilation — is the remaining work for
> this phase.

---

## Phase 4.5 — Execution isolation (sandbox) — *gate before Phase 5*

Pulled forward from the old Phase 6 because **the marketplace cannot ship safely without
it** (threat review S0). The local single-user case has the *largest* blast radius: an agent
with shell/write runs as you.

- **Sandboxed worker execution behind the `dispatch()` boundary** — a container (or
  equivalent) per dispatch with: no ambient credentials, a scrubbed filesystem view (only
  the working repo), **default-deny egress + per-agent allowlist via a logging proxy**, and
  resource/time limits (CONTROLS C1).
- **Read-only web for the researcher (CONTROLS C1):** the open-web `web` tool resolves to a
  **GET-only fetch proxy** with an **SSRF guard** (blocks private/loopback/metadata IPs), so
  poison can come in but data cannot go out; open-web read stays mutually exclusive with
  write/shell.
- **Project-secret protection** — secret-scanning + redaction so a sandboxed agent can't
  read or exfiltrate `.env`/credentials (threat review S5; folded into C1).
- **In-loop human approval (CONTROLS C3)** for irreversible/outbound actions (push, deploy,
  `rm`, dep install) during autonomous execution (threat S10) — the **same broker** as C1's
  egress approve-on-first-use; build the confirmation primitive once.

**Exit criteria:** a deliberately hostile first-party "agent" that *tries* to read `~/.ssh`,
phone home (including via the fetch proxy and an SSRF to a metadata IP), and `git push` is
contained — it can touch only the working repo, its egress is blocked, and the dangerous
actions require human confirmation. Only now is it safe to let third-party code in.

---

## Phase 5 — Marketplace & Negotiator (the product layer)

> **Depends on Phase 4.5.** No third-party / shell / write agent runs un-sandboxed.

Make personas installable; make the orchestrator persona-agnostic.

- **Agent templates** + manifests; **layered prompt composition** (immutable base + user
  overlay + project context).
- **Per-owner team config**; **grant-on-hire least-privilege** tool approval.
- **Routing-contract-driven graph assembly** — the PM stops hardcoding the cast and
  composes the graph from installed agents' contracts (MARKETPLACE §2). *This refactors the
  Phase 2 tier pipelines into filters.*
- The **Negotiator** (`on_conflict`) with its guardrail **code-enforced**, not prompted —
  `negotiable` derived by the system, rulings validated by the orchestrator (NEGOTIATOR §2).
- **Structured conflict detection (NEGOTIATOR §3, threat A5):** the PM raises *candidate*
  conflicts from structured fields only (`disputes`/`cannot_satisfy` tags; co-`blocks_done`
  on overlapping `task`/`location`) — never prose comparison — and the Negotiator
  adjudicates. Closes C4's remaining axis: the **dispute-round cap** (k rounds → forced
  `ESCALATE` to human).
- The **first-ten catalog** (CATALOG) as the launch content.
- **Marketplace UX**: browse / detail / my-team + the security-critical hire dialog (UX §8).

**Exit criteria:** hire a UX Researcher from the marketplace; on the next matching run it
**self-inserts** into the graph via its routing contract with no PM code change; engineer a
UX-vs-perf conflict and watch the Negotiator produce a ruling.

---

## Phase 6 — Productisation (only when there are users)

Deliberately deferred. Each item is *additive behind an existing seam*, not a rewrite —
which is the entire payoff of the four principles.

| Add | Behind which seam |
| --- | ----------------- |
| Auth / identity (`owner` becomes real) **+ enforced isolation (row-level security), not just a field** (threat review S11) | Principle 1 (tenancy) |
| Multi-tenant hardening of the Phase 4.5 sandbox (per-tenant limits, escape testing) | Principle 2 (worker boundary) |
| Hosted, concurrent, multi-tenant state store | Principle 3 (state repository) |
| Per-user keys / managed billing | Principle 4 (secrets boundary) |
| Hosted control plane + the always-on dashboard | UX §3 (in-memory bus → Postgres LISTEN/NOTIFY) |
| Template signing / provenance / scanning | MARKETPLACE §6/§7 |

**Exit criterion (threat S11):** **cross-tenant isolation tests** that assert tenant A cannot
read tenant B's state, code, or findings — and that an *unfiltered* query returns nothing,
not everything. Added with `owner`, not retrofitted after a leak (DESIGN §8 Principle 1).

**Exit criteria:** a second user can run an isolated swarm with their own team, keys, and
state, with workers sandboxed — without any single-user assumption being excavated from the
codebase.

---

## Sequencing rationale (why this order)

- **Risk first.** Phase 1 validates the one thing that, if it doesn't work, sinks the whole
  project — *can the loop produce good work?* Everything after assumes a "yes."
- **Enforcement before polish.** Security/testing gates (P2) land before the dashboard (P3),
  because a quiet, structurally-safe tool beats a beautiful unsafe one.
- **Dogfood before product.** Phases 1–4 give *you* a complete tool you'll actually use; the
  marketplace (P5) and SaaS (P6) are only worth building once the core has earned it.
- **The seams never wait.** They're in from P0 so productisation is a late, additive phase
  rather than a teardown — the difference between "add a sandbox" and "rewrite everything."
