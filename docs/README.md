# Agent Swarm — Design Corpus

A standalone project (unrelated to the repository it currently lives in): a **local-first,
single-tenant multi-agent coding system** — a swarm of role-specialised AI agents
coordinated by a Project Manager agent through a shared blackboard, with a path to becoming
a hosted product.

> Status: **Phases 0–4 complete; Phase 6's Agent SDK migration shipped (June 2026).**
> The engine, live SSE dashboard, and real Claude planning conversation all work
> end-to-end; see [`ROADMAP.md`](ROADMAP.md) for what's shipped vs planned. This corpus
> is the durable design record — read it for the *why*, not just the *what*.

## The lifecycle this design covers

```
launch  →  brainstorm (Planning)  →  Charter + approval gate  →  execute (the loop)
                                                                      │
                              dashboard (live)  ·  marketplace team  ·  negotiation
```

## Read in this order

| Doc | What it covers |
| --- | -------------- |
| [`DESIGN.md`](DESIGN.md) | **Start here.** Goals, the blackboard architecture, personas, the `state.json` schema and orchestrator loop, the local-first hosting decision, the four product-layer principles, failure modes, glossary. |
| [`INCEPTION.md`](INCEPTION.md) | Planning mode: the brainstorm phase, the critical-partner PM, the Project Charter, the approval gate, single-launch entry. |
| [`UX.md`](UX.md) | Real-time mechanism (SSE + POST), the dashboard, marketplace screens, and the design prompts for generating the UI. |
| [`MARKETPLACE.md`](MARKETPLACE.md) | Installable, customisable agent templates; per-owner teams; trust & safety for third-party templates. |
| [`CATALOG.md`](CATALOG.md) | Routing contracts for the default team + the first ten hireable specialists. |
| [`NEGOTIATOR.md`](NEGOTIATOR.md) | The conflict-resolution agent and its hard safety guardrail. |
| [`MEMORY.md`](MEMORY.md) | The memory layer: living docs vs `CLAUDE.md` learnings (the delineation), session recall at intake, live service context. |
| [`BUILD.md`](BUILD.md) | The phased implementation roadmap (risk-ordered), and where the four seams go in. |
| [`THREATS.md`](THREATS.md) | Adversarial review: trust model, attack surfaces, and a finding register with severities — read alongside the docs it corrects. |
| [`CONTROLS.md`](CONTROLS.md) | The designed security controls that close the threat findings: **C1** untrusted-content & egress, **C2** gate fail-closed, **C3** in-loop approval, **C4** spend control. (Architectural fixes for A1/A3/A5 live inline in the docs they correct.) |

## Implementation status

| Phase | Status | Notes |
| ----- | ------ | ----- |
| **0** Scaffolding | ✅ Complete | `core/src/` has state repo, config boundary, dispatch boundary, event bus. `swarm init` and `swarm check` work. |
| **1** Walking skeleton | ✅ Complete | Real PM loop, Coder agent via Anthropic SDK, `swarm new "<goal>"` works end-to-end, eval harness with 2 test cases. |
| **2** Quality gates | ✅ Complete | Tier classifier, Tester, Security Reviewer, C2 gate validation, S2 sensitive-path escalation, remediation spawning. Eval harness extended to 3 cases including a deliberate SQL injection that must be caught. |
| **3** Dashboard | ✅ Complete | Live SSE dashboard (`/events`): task graph, live transcripts, live per-task diffs, inbox, per-task cost. |
| **4** Planning mode | ✅ Complete | Real Claude PM conversation (`core/src/pm/`) with structured charter output via a dedicated MCP tool, Scout research rounds, GitHub-issue seeding. |
| **4.5–6** | 🔄 Partial | Phase 6's Agent SDK migration shipped (June 2026); remaining productisation and security debt tracked in [`ROADMAP.md`](ROADMAP.md). |

A **dual-driver abstraction layer** was added in `core/src/drivers/` between Phases 2 and 3,
behind the `AgentDriver` interface: `agent-sdk` (the default — TypeScript Agent SDK
`query()` with typed message streaming) and `api-key` (direct Anthropic SDK);
`SWARM_USE_CLI=1` falls back to the legacy `claude -p` spawn path. See `DESIGN.md` §8
Principle 2 for details.

---

## Worked examples

| Example | Shows |
| ------- | ----- |
| [`examples/inception/`](examples/inception/) | A complete, execution-ready Project Charter. |
| [`examples/leaderboard-run/`](examples/leaderboard-run/) | A feature-tier run captured mid-flow where security fails and the loop spawns remediation. |
| [`examples/negotiator/`](examples/negotiator/) | A UX-vs-performance conflict and the Negotiator's synthesis ruling. |
| [`examples/templates/`](examples/templates/) | A worked marketplace template: manifest, base prompt, team config, and a user overlay. |

## The one-paragraph summary

You launch a single command; a browser opens into a chat with a Project Manager agent. You
**brainstorm** the project — it pushes back, pulls in specialists to pressure-test, and
produces a **Charter**. You approve it; the PM **builds a task graph** and dispatches a team
of specialist agents (Coder, Tester, Security, plus any you've **hired** from a marketplace)
that coordinate through a shared **blackboard** — never talking directly, always refereed by
the PM, with security and testing enforced as graph dependencies and conflicts resolved by a
**Negotiator**. You watch it live on a dashboard. It runs **local and single-tenant** today,
but every interface is drawn so it can grow into a **hosted multi-tenant product** without a
rewrite.
