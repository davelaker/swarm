# Agent Swarm — UX & Real-Time State Mechanism

> Companion to `DESIGN.md`. Resolves the open question in §12 about the
> real-time agent-state mechanism, sketches the dashboard, and provides a
> ready-to-use prompt for generating the interface.

---

## 1. What the UX has to show

Four things, all of which change while the swarm runs:

1. **The task graph** — every task, its status, and its `depends_on` edges. This is the
   "what's the plan and how far along is it" view.
2. **Live agent activity** — which personas are *active right now* and what step they're
   on ("Coder: editing LeaderboardCommand", "Security: scanning for injection").
3. **The findings feed** — each finding as it lands, with its verdict.
4. **PM chat** — a conversation with the orchestrator: kick off work, answer its
   questions, approve/redirect.

Plus a few **controls**: pause / resume / abort the run, and approve a gated step
(human-in-the-loop).

---

## 2. The transport decision: SSE for state, POST for actions

The data is overwhelmingly **one-directional**: the server has a stream of state changes
to push *out* to the dashboard. The only things going the *other* way are discrete user
actions (send a PM message, pause, approve) that fit a plain request perfectly.

That shape points straight at **Server-Sent Events (SSE)** for the live stream, and plain
**HTTP POST** for actions. The trade-off table:

| Option        | Fit                                                                                  | Verdict |
| ------------- | ------------------------------------------------------------------------------------ | ------- |
| **Polling**   | Dead simple, but laggy and wasteful; you re-fetch the whole graph on a timer.         | Fallback only |
| **SSE**       | Purpose-built for server→client event streams; **auto-reconnect built in**; trivial server side; one long-lived HTTP connection. | **Chosen** |
| **WebSocket** | Bidirectional and low-latency, but you don't need client→server streaming — actions are discrete POSTs. Extra complexity for no benefit *here*. | Overkill now |

> If a future feature needs true bidirectional low-latency (e.g. live-editing a task
> graph collaboratively), WebSocket can be swapped behind the same event interface. SSE
> is the right *starting* choice, not a permanent ceiling.

---

## 3. How the server learns about changes (the important bit)

The dashboard can only stream what the system emits. So the **state repository interface**
(Design Principle 3) becomes the natural event source: every `update_task()`,
`append_log()`, or `write_finding()` call **also emits an event** onto an in-process
pub/sub bus. SSE clients are just subscribers to that bus.

```
                    ┌─────────────────────────────────────────┐
                    │  Orchestrator process (Agent SDK)         │
                    │                                           │
  PM loop ───────►  │  State Repository  ──emits──►  Event Bus  │ ──┐
  Workers ───────►  │  (the ONE writer)              (pub/sub)  │   │
                    └─────────────────────────────────────────┘   │
                                                                   │ SSE: GET /events
                    ┌─────────────────────────────────────────┐   │
   Browser  ◄───────┤  Embedded HTTP server                    │ ◄─┘
   (dashboard)      │  GET  /events   (SSE stream)             │
            ───────►│  GET  /state    (snapshot on load)       │
   actions          │  POST /pm/message, /run/pause, ...        │
                    └─────────────────────────────────────────┘
```

**Local-first choice: one process.** The orchestrator embeds the HTTP server, so state
mutations and SSE fan-out happen in-memory — no message broker, no second service. The
dashboard loads a snapshot from `GET /state`, then keeps current via `GET /events`.

**Product-path note (Principles 2 & 3):** because emission lives *behind the repository
interface*, splitting this later is a swap, not a rewrite — the orchestrator moves to a
sandboxed container, the web layer becomes its own service, and the in-memory bus becomes
Postgres `LISTEN/NOTIFY` or Redis pub/sub. The dashboard's `GET /events` contract doesn't
change.

> **Security — "local" is not "safe" (threat review S3).** A localhost server is reachable
> by **any process on the machine and any web page you visit** (CSRF / DNS-rebinding against
> `127.0.0.1` is a real attack). Unprotected, a random site could `POST /pm/message` to drive
> your PM, `POST /run/abort` your work, and the SSE stream would leak your full state (code,
> findings, possibly secrets). From Phase 3, treat it as a real auth surface: **bind to
> loopback only, require a per-session token on every request, and enforce `Origin`/`Host`
> checks** to block cross-origin POSTs. See `THREATS.md`.

---

## 4. The event protocol

A small, stable set of event types flows over `GET /events`. Each is a JSON object with a
`type` and a `data` payload.

| Event                  | When                                          | Drives in the UI                          |
| ---------------------- | --------------------------------------------- | ----------------------------------------- |
| `run.classified`       | PM assigns a tier and builds the graph        | Renders the initial task graph + tier badge |
| `task.created`         | A task is added (incl. remediation tasks)     | New node appears                          |
| `task.status_changed`  | `pending → in_progress → done/failed/blocked` | Node recolours                           |
| `agent.started`        | A worker is dispatched                        | Persona lights up as "active"             |
| `agent.progress`       | A worker takes a step (tool call)             | Live activity line under the persona      |
| `agent.finished`       | A worker returns its summary                  | Persona goes idle                        |
| `finding.written`      | A findings file is committed                  | New card in the findings feed             |
| `pm.message`           | The PM says something                         | New bubble in PM chat                     |
| `run.blocked`          | Deadlock / escalation                         | Banner: needs human                       |
| `run.completed`        | Graph fully `done`                            | Success state                            |

### The real-time-progress challenge (worth calling out)

A subagent is normally a **black box**: it works, then returns a summary at the end. To
show "what it's working on" *live*, the orchestrator forwards the worker's **tool-call
stream** as digested `agent.progress` events — e.g. the Coder calling an edit tool
becomes `{persona: "coder", step: "Editing LeaderboardCommand"}`. This is cheap, the SDK
surfaces it, and it's the difference between a dashboard that *feels* alive and one that
just shows spinners. It's the single most valuable real-time signal; everything else is
state transitions.

---

## 5. Dashboard layout (wireframe)

> This is the **RUNNING** (Execute-mode) view. A new project opens in **PLANNING** mode
> first — a conversation + a live-assembling charter — reached via the single-launch entry
> (`swarm` opens the browser straight into PM chat). See `INCEPTION.md` §9 for the Planning
> wireframe and the **Execute ▶** approval gate that flips between them.


```
┌───────────────────────────────────────────────────────────────────────────┐
│  Agent Swarm   ·  Project: add-arena-leaderboard   [FEATURE]   ● running     │
│                                              [ Pause ] [ Abort ]              │
├──────────────────────────────┬────────────────────────────────────────────┤
│  TASK GRAPH                   │  AGENTS                                      │
│                               │  ┌────────────────────────────────────────┐ │
│   (t1 Coder) ✅               │  │ ● Coder      active                     │ │
│       │                       │  │   └ Editing LeaderboardCommand (bind…)  │ │
│   (t2 Tester) ✅              │  │ ○ Tester     idle                       │ │
│       │                       │  │ ○ Security   idle  (last: CHANGES_REQ)  │ │
│   (t3 Security) ⚠ changes     │  │ ○ Negotiator idle                       │ │
│       │                       │  └────────────────────────────────────────┘ │
│   (t4 Coder·fix) ◐ in-prog    ├────────────────────────────────────────────┤
│       │                       │  FINDINGS FEED                               │
│   (t5 Security re-review) ○   │  ⚠ security-t3 · CHANGES_REQUESTED · SQLi    │
│                               │  ✅ tester-t2  · PASS · 6 tests              │
│  legend: ✅done ◐active        │  ✅ coder-t1   · COMPLETE · 2 files         │
│  ⚠changes ○pending ✗failed    │                                            │
├──────────────────────────────┴────────────────────────────────────────────┤
│  PM CHAT                                                                     │
│  PM: Security flagged a SQL-injection in the season filter (t3). I've       │
│      created t4 to fix it and t5 to re-review. Coder is on it now.          │
│  You: ▌                                                          [ Send ]    │
└───────────────────────────────────────────────────────────────────────────┘
```

Three persistent regions — **graph** (plan + progress), **agents + findings** (live
activity + outputs), **PM chat** (control) — matching the four data needs from §1.

---

## 6. Prompt for generating the interface

Paste the block below into Claude (e.g. an Artifacts session / "Claude design") to get an
interactive, self-contained mock. It includes the real data shapes so the result wires
cleanly onto the real backend later.

````text
Build a single-file, self-contained interactive web dashboard (React, no external
data dependencies — use mock data and a simulated live feed) for a local "Agent Swarm":
a multi-agent AI coding system where specialised agents (Coder, Tester, Security
Reviewer, Negotiator) are coordinated by a Project Manager (PM) agent through a shared
task graph. This is a single-user local developer tool, but it should LOOK like a
polished product — clean, calm, information-dense but not cluttered. Dark theme.

The dashboard has four regions:

1. HEADER: project name, a tier badge (TWEAK / FEATURE / GREENFIELD), a run-status
   indicator (running / blocked / done), and Pause / Abort controls.

2. TASK GRAPH (left): a vertical dependency graph of tasks. Each node shows id, title,
   assigned persona, and a status colour: pending (grey), in_progress (pulsing blue),
   done (green), changes_requested (amber), failed (red). Draw the depends_on edges.

3. RIGHT COLUMN, top — AGENTS panel: one row per persona (Coder, Tester, Security,
   Negotiator) showing active vs idle, and for the active one a live "current step"
   line that updates (e.g. "Editing LeaderboardCommand", "Running tests",
   "Scanning for injection"). RIGHT COLUMN, bottom — FINDINGS FEED: a reverse-chron
   list of finding cards, each with the agent, a verdict chip
   (COMPLETE / PASS / CHANGES_REQUESTED / FAIL), and a one-line summary; clicking a
   card expands its full markdown body.

4. PM CHAT (bottom, full width): a chat transcript with the PM plus an input box.

Simulate a LIVE run using a timer: start with the Coder active on t1, then progress
through the graph — t1 done, t2 (tests) pass, t3 (security) returns CHANGES_REQUESTED
for a SQL-injection, then the PM posts a chat message explaining it created a fix task
(t4) and a re-review (t5), the Coder reactivates on t4, etc. Drive everything from a
mock event stream of these event types so it's obvious how a real Server-Sent-Events
feed would plug in:

  run.classified | task.created | task.status_changed | agent.started |
  agent.progress | agent.finished | finding.written | pm.message |
  run.blocked | run.completed

Use this real state shape for the mock data (one task object shown):

  {
    "id": "t3", "title": "Security review of leaderboard",
    "status": "changes_requested", "assignee": "security",
    "depends_on": ["t1"], "result_ref": "findings/security-t3.md",
    "attempts": 1
  }

And this finding-card shape:

  { "agent": "security", "task": "t3", "verdict": "CHANGES_REQUESTED",
    "summary": "SQL injection in season filter", "body_md": "## ...full markdown..." }

Make it feel alive: pulsing active node, the agent's current-step line ticking through
steps, findings sliding into the feed, the PM chat message appearing at the right
moment. Keep it to one file, runnable as-is.
````

Adjust the tone line ("polished product / dark theme") to taste — the structure and the
data shapes are the parts that make the output reusable against the real backend.

---

## 7. Where this connects back

- The **event types** here are exactly what the **state repository** (DESIGN §8.3 /
  Principle 3) emits — UI and backend share one contract.
- The **POST actions** (`/pm/message`, `/run/pause`) are the human-in-the-loop entry
  points referenced in the failure-mode and tiering sections.
- Keeping emission behind the repository interface is what lets the **same dashboard**
  serve the local tool today and the hosted product tomorrow (Principles 2 & 3).

See `examples/leaderboard-run/` for the concrete data this UI would be rendering.

---

## 8. Marketplace screens & design prompt

The marketplace (see `MARKETPLACE.md`) needs three screens plus one safety-critical
dialog. The dialog is the one that matters most — it's where untrusted third-party tool
requests get approved, so it can't feel like a rubber-stamp.

### Screens

1. **Browse / Catalog** — a grid of agent cards (name, role, provenance badge, rating,
   one-line description, a preview of requested tools). Filter by role / tier / provenance;
   search. This is the "shopping" view.
2. **Agent Detail** — full description, **read-only base-prompt preview**, the requested
   tools *with risk indicators*, the routing contract rendered in plain language ("Runs on
   feature & greenfield, after the Coder, before completion"), version + changelog. Primary
   action: **Hire**.
3. **My Team** — the installed roster: each agent with its overlay, granted tools, pinned
   version, enabled tiers, an enable/disable toggle, an **upgrade-available** badge (with a
   diff of prompt + tool changes), and remove.

### The Hire dialog (security-critical)

The grant-on-hire, least-privilege approval step (`MARKETPLACE.md` §6). It must:
- list each **requested tool** with a clear, individual **grant toggle** (not one "accept
  all");
- **visually escalate sensitive tools** (shell, network/egress, write) — these are where a
  malicious template does damage, so they should look heavier than `read`;
- show the **overlay** textarea (append your own instructions) and an explanation that it's
  appended *after* the template's guardrails, which it can't override;
- expose the allowed overrides (model, enabled tiers) and nothing locked.

> Design intent: hiring should feel deliberate, like granting an app permissions — not a
> one-click install. The friction here is a feature.

### Design prompt

Paste into Claude (Artifacts / "Claude design") for an interactive mock. Same dark,
polished-product tone as the dashboard; same one-file, mock-data approach.

````text
Build a single-file, self-contained interactive React mock (mock data only, no backend)
for the "Agent Marketplace" of a multi-agent AI coding tool. Same dark, polished,
information-dense product aesthetic as a developer dashboard. It has three screens
(tabs/routes) plus one modal:

1. BROWSE: a grid of agent cards. Each card: agent name, a role chip (researcher /
   planner / builder / reviewer), a provenance badge (FIRST-PARTY / COMMUNITY / PRIVATE),
   a star rating, a one-line description, and small icons for its requested tools. A
   filter bar (role, tier, provenance) and a search box. Seed ~10 agents from this
   catalog: Product Researcher, Architect, UX Researcher, Accessibility Auditor,
   Performance Engineer, Database Specialist, API Designer, Compliance/Privacy Reviewer,
   Documentation Writer, Refactoring Specialist.

2. AGENT DETAIL: opened from a card. Shows full description; a READ-ONLY base-prompt
   preview in a monospace block; the routing contract rendered as a plain-English
   sentence ("Runs on FEATURE & GREENFIELD, after the Coder, before completion; only
   when a UI artifact exists"); a "requested tools" list where sensitive tools (shell,
   network, write) are visually flagged with a warning treatment and read is neutral;
   version + a short changelog. Primary button: HIRE.

3. MY TEAM: a list of installed agents (seed it with the 4 built-ins —
   PM, Coder, Tester, Security — shown as locked defaults, plus 1-2 hired specialists).
   Each row: name, role, pinned version, enabled-tiers chips, granted-tools icons, an
   enable/disable switch, and a remove action. Put an "Upgrade available" badge on one
   hired agent that, when clicked, opens a small diff modal showing changed prompt lines
   and any newly requested tools (highlight a new tool request in warning colour).

4. HIRE MODAL (the important one — make it feel like granting app permissions, NOT a
   one-click install): per-tool grant toggles (never a single accept-all), with sensitive
   tools (shell / network / write) rendered heavier/with a caution style and read-only
   tools neutral; an "Additional instructions (overlay)" textarea with helper text noting
   it's appended after the template's guardrails and cannot override them; dropdowns for
   the allowed overrides (model: balanced/deep, enabled tiers); locked fields shown but
   disabled. A confirm button summarising "Hiring X with N tools granted".

Use this agent data shape for the mock:

  { id, name, role, provenance, rating, description,
    base_prompt, version, changelog,
    tools_requested: [{ name, sensitivity: "read"|"write"|"shell"|"network" }],
    routing: { applies_to_tiers, after, before, requires_artifacts, trigger } }

Make it feel like a real product: hover states, the caution styling on sensitive tools,
a satisfying hire confirmation. One file, runnable as-is.
````

The `tools_requested[].sensitivity` field is the hook that drives the caution styling —
it's the same data the real Hire flow uses to decide what to warn about, so the generated
UI maps straight onto the backend's grant model.
