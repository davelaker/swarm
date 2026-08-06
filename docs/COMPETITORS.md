# Competitive Landscape

> **Status:** Living document. Add a new `## Competitor — <name>` section per product.
> **Audience:** The author, for positioning and naming decisions.
> **Scope:** Tools in the multi-agent / parallel-agent AI coding space that overlap with
> this product's surface area, even where the underlying philosophy differs.

---

## How to read this document

Each competitor section follows the same shape:

1. **One-line identity** — what the product fundamentally *is*.
2. **Orchestration model** — the crux: who decides what gets done, the software or the human?
3. **Feature comparison** — built-vs-built, honest about our designed-but-not-built gaps.
4. **Where they're ahead** — the reality check.
5. **Where we're differentiated** — the defensible whitespace.
6. **Positioning takeaway** — the one sentence that separates us.

The recurring axis across this whole space is **human-orchestrated vs.
software-orchestrated.** Most "parallel agent" tools are workspace managers: they make a
human faster at running many independent agents. This product is an *orchestrator*: the
software plans the work, assigns specialized roles, and enforces quality gates. That
distinction is the core of every comparison below.

---

## Competitor — Conductor (conductor.build)

> Researched June 2026. Sources at the end of this section.

### One-line identity

A polished **Mac app for running parallel coding agents** — a control panel that lets a
human launch several independent agents (Claude Code, Codex, Cursor) side by side, each in
its own git worktree, then review and merge their diffs in one place.

### Orchestration model

**Human-orchestrated.** This is the defining difference. The human is the conductor:

- The human decides what each agent works on and creates each workspace manually (⌘+N).
- Each workspace is an **independent task** with its own branch, files, terminal, diff, and
  review path. There is no planner, no dependency graph, and no inter-agent communication.
- The product's own docs frame the key decision as the human's: *"should these agents share
  a workspace, or should they move independently?"*
- Conflict resolution between agents sharing a workspace is the human's problem, not the
  software's.

Despite the name, **Conductor does not conduct** — it does not decompose a goal or
coordinate agents toward it. It is a parallel-workspace switcher with an excellent
review-and-merge loop bolted on.

### Feature comparison

| Capability | Conductor | This product |
|---|---|---|
| Parallel agents in isolated git worktrees | ✅ Core, shipping | ✅ Built (worktree flows through dispatch) |
| Multi-model backend | ✅ Claude Code, Codex, Cursor; switch per workspace | ⚠️ Claude-only, but per-task model selection (haiku→fable) + per-task effort, PM-assigned with a cost-confirmation gate |
| Review / merge diffs, open PRs, archive | ✅ Polished, central to UX | ⚠️ Shiki diff review + inline comments + fix loop built; push built; PR creation still manual |
| Per-project setup/run/archive scripts (`.conductor/settings.toml`) | ✅ Shipping | ❌ No env/run-script config equivalent |
| Live "what's each agent doing" dashboard | ✅ Shipping (native Mac) | ✅ Live SSE dashboard: task graph, live transcripts, live per-task diffs, mid-run steering, per-task cost |
| Free app, BYO Claude subscription | ✅ Same billing model we rely on | ✅ Same Max-plan model (validated) |
| **Planner / PM that decomposes a goal** | ❌ Explicitly absent | ✅ Built end-to-end: real Claude PM conversation → charter → task graph → Execute |
| **Specialized roles (Tester, Security, …)** | ❌ Every agent is the same generalist | ✅ Coder/Tester/Security/Reviewer/Scout built; Negotiator built with code-enforced guardrail |
| **Dependency graph driving execution order** | ❌ Workspaces are independent | ✅ Built (`depends_on`, runnable detection) |
| **Enforced quality/safety gates** (fail-closed parsing, C1–C4, sensitive-path escalation) | ❌ None | ✅ C2 + sensitive-path + remediation built; C1/C3/C4 partial |
| **Crash recovery with leases/heartbeats** | ❌ Not a concern (human-driven) | ✅ Built (`reconcile()`) |
| **Marketplace of hireable specialist agents** | ❌ None | ✅ Hire/roster/permissions/connector grants built; specialists dispatch with scoped tools |
| **Cost budgeting in $/tokens with hard/soft caps** | ❌ (you pay your sub) | ✅ Global cap built; sub-limits partial |
| Native desktop app | ✅ Mac (Windows on roadmap) | ❌ Local web (Vite + browser) |
| Shipped & in users' hands | ✅ Public, has a following | ❌ Local single-user; several core seams unbuilt |

### Where they're ahead

1. **It ships and it's polished.** Native Mac app, real users, changelog, docs. Ours is
   local single-user. (The June-2026 caveats here — SSE unwired, mock planning, no
   Negotiator — are resolved; see the July 2026 snapshot below.)
2. **Multi-model.** Codex + Cursor + Claude, switchable per workspace. We're Claude-only.
3. **The merge/PR/archive last mile is complete and central** — ours now has diff review,
   inline comments with a fix loop, and push; automatic PR creation is the remaining gap.
4. **Project scripts** make the worktree workflow usable on real repos. We have no
   equivalent yet.

### Where we're differentiated

Everything Conductor deliberately omits is our entire thesis: **structural orchestration
and enforced quality.** Conductor makes a human faster at running many agents; it does not
make the *output* safer or more correct — quality stays the developer's discipline on the
day. Our premise is that security and testing are *structurally enforced by the system*.
That is a different and defensible product — **if** we build the orchestration layer to
completion.

**The risk to be honest about:** our differentiators (PM planner, routing contracts,
Negotiator, gates C1/C3/C4, marketplace runtime, sandbox) are disproportionately in the
*designed-but-not-built* column. Conductor's shipping features overlap with our *built*
column (worktrees, dashboard, multi-agent). So today's honest comparison is: *"Conductor
ships the easy 70% we've also built; our hard, differentiating 30% is still on paper."*
Closing that gap is the whole game.

### Positioning takeaway

- Conductor = **"run agents in parallel."** Us = **"an AI team that plans, builds, tests,
  and security-reviews itself."**
- **Naming implication:** "Conductor" is off the table — taken, by a direct-adjacent
  competitor, in the same `.build` TLD. Avoid near-misses (Maestro, Orchestra, Podium) that
  invite confusion with them.

### Sources

- [conductor.build](https://www.conductor.build/)
- [Conductor Docs — Introduction](https://www.conductor.build/docs/)
- [Parallel agents](https://www.conductor.build/docs/core/parallel-agents)
- [Scripts reference](https://www.conductor.build/docs/reference/scripts)
- [Vercel — Conductor](https://vercel.com/docs/agent-resources/coding-agents/conductor)

---
## Landscape snapshot — July 2026

> Researched July 2026 (web sweep: vendor docs/blogs where possible; secondary sources
> marked). Supersedes the risk note in the Conductor section: the "designed-but-not-built
> 30%" (PM planner, Negotiator, gates, marketplace runtime, live dashboard) has since
> shipped. The axis has moved.

### The market converged on our bones

Parallel agents in **isolated git worktrees**, a **task board/graph** as the primary
surface, and **diff-first review** are now table stakes across the entire category:
Cursor background agents, OpenAI Codex cloud agents, GitHub Copilot **Agent HQ**
("mission control" for multi-vendor agents), Devin, Factory.ai, OpenHands, and the local
worktree tools (Conductor, Vibe Kanban, Sculptor). Differentiation no longer comes from
running agents in parallel — it comes from what the orchestration layer *guarantees*.

### The two competitors that matter most

**Claude Code Agent Teams (Anthropic — same-vendor threat).** Experimental: a lead
session plus teammate sessions sharing a dependency-aware task list (file-locked
claiming, auto-unblock), peer-to-peer mailboxes, plan-approval gates for teammates,
per-teammate model selection, and quality-gate hooks that can *block* task completion
(exit-code-2 feedback). Two things to copy early: (1) **inter-agent messages are treated
as untrusted input** — a teammate cannot relay a permission approval; adopt this before
third-party marketplace agents make it urgent; (2) hook-based completion gating
independently validates our deterministic-gates thesis. Their gap vs us: no persistent
PM/charter layer, no cost governance, no marketplace, no scorecards.

**Devin (Cognition — closest orchestration model).** Coordinator session dispatches
child Devins on their own VMs, monitors, resolves conflicts, compiles results. Leads the
industry on **cost governance** (session-level hard ACU caps with acknowledgement
modals, effort levels with expected cost ranges shown *before* running, consumption
dashboards) and **org memory** (Knowledge notes + reusable **Playbooks** with output
schemas). Their review product auto-fixes from findings, as ours does.

### Everyone else, compressed

| Product | What they ship that's relevant | Verdict for us |
|---|---|---|
| Copilot Agent HQ | Multi-vendor agents (Claude/Codex/Jules/…) under one mission control; branch controls + CI gates; AGENTS.md; org governance dashboards | Multi-vendor neutrality is their bet; we should at least *read* AGENTS.md |
| Cursor | Speculative parallel attempts (`/multitask` — "pull whichever succeeds"); Bugbot review with **Autofix**; cloud VMs that visually verify via browser | Best-of-N precedent; our visual gate is the same instinct |
| OpenAI Codex | **Best-of-N productized** (attempts parameter, pick-the-best UI); per-task sandboxes | The clearest best-of-N precedent |
| Factory.ai | Role-bounded specialist droids; Linear/Jira ticket as native unit of work; headless CI runs | Ticket-as-intake is table stakes we lack |
| Charlie Labs | **Always-on daemons** watching PRs/CI/Sentry/docs — ambient maintenance, not dispatch-per-task | The only truly novel positioning move seen; a "swarm daemon" is our version |
| OpenHands | Open-source self-hosted; repo-scoped "microagents" knowledge | Closest OSS analogue |
| LangGraph (framework) | Stateful DAGs with checkpointing + time-travel won production mindshare | Validates checkpoint/rewind as a trust feature |

### Where we are ahead (defend these)

1. **Review→fix auto-loop** — gates/reviewer findings auto-spawn fix coders. Only Cursor
   Bugbot Autofix and Devin Review match this.
2. **Agent scorecards** — industry-wide weak spot; we already ship per-agent track
   records. Deepen toward *cost-per-successfully-merged-task*, gate pass-rate, revision
   count.
3. **Deterministic, non-optional gates + the Negotiator guardrail** (`negotiable:false`
   is code-enforced) — no surveyed product has an arbitration layer at all.
4. **Cost visibility** — per-task live cost, model-aware forecast, upgrade confirmation.
   Only Devin is ahead here (hard caps + pre-run ranges) — see gaps.

### Gaps this research surfaced (now on the roadmap)

Ordered by leverage; UX research (agent-inbox patterns, approval-fatigue literature)
backs the first item as the single most-cited pattern in 2025–26 agent-UX writing.

1. **Agent Inbox** — a "needs you now" queue (permission asks, blocked runs, review
   waits) separated from the FYI findings feed; over-notification is the top documented
   trust-killer.
2. **Issue-tracker intake** — pull a GitHub/Linear issue as the charter seed; post the
   result back. Ticket-as-unit-of-work is table stakes (Factory, Charlie, Agent HQ).
3. **Best-of-N with gate-scored selection** — dispatch N coders on one hard task in N
   worktrees; let deterministic gates + reviewer score candidates and auto-select.
   Codex/Cursor ship best-of-N; **nobody combines it with deterministic gate scoring** —
   that combination is ours to take.
4. **Per-task checkpoint/rewind** — git-native rollback of a task; rare locally, and the
   fear of irreversibility is what makes users over-supervise.
5. Per-task hard budget caps with pre-dispatch estimates (Devin parity) · Playbooks
   (procedural memory beside the scribe's declarative memory) · daemon mode (Charlie's
   ambient-maintenance framing) · inter-agent trust boundaries (Agent Teams' model).

### Sources

Claude Code Agent Teams / web: code.claude.com/docs/en/agent-teams,
code.claude.com/docs/en/claude-code-on-the-web · Agent HQ: github.blog
"welcome-home-agents" · Devin: docs.devin.ai/release-notes/2026 · Cursor:
cursor.com/blog/bugbot-autofix · Codex best-of-N: learn.chatgpt.com/docs/developer-commands ·
Charlie: charlielabs.ai · Category list: github.com/andyrewlee/awesome-agent-orchestrators ·
UX patterns: langchain agent-inbox, smashingmagazine.com (Feb 2026 agentic-UX patterns),
antigravity.google/docs/artifacts, code.claude.com/docs/en/checkpointing. Secondary-source
claims (Cursor parallel limits, Managed Agents pricing) are marked in the research notes
and should be re-verified before citing externally.
