# Agent Swarm — Design Corpus

A standalone project (unrelated to the repository it currently lives in): a **local-first,
single-tenant multi-agent coding system** — a swarm of role-specialised AI agents
coordinated by a Project Manager agent through a shared blackboard, with a path to becoming
a hosted product.

> Status: **design / investigation.** Nothing built yet. This corpus is the durable
> "revert point" to build from.

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
| [`BUILD.md`](BUILD.md) | The phased implementation roadmap (risk-ordered), and where the four seams go in. |
| [`THREATS.md`](THREATS.md) | Adversarial review: trust model, attack surfaces, and a finding register with severities — read alongside the docs it corrects. |
| [`CONTROLS.md`](CONTROLS.md) | The designed security controls that close the threat findings: **C1** untrusted-content & egress, **C2** gate fail-closed, **C3** in-loop approval, **C4** spend control. (Architectural fixes for A1/A3/A5 live inline in the docs they correct.) |

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
