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
| Multi-model backend | ✅ Claude Code, Codex, Cursor; switch per workspace | ⚠️ Dual-driver (Claude API-key + Max-plan `claude -p`), Claude only |
| Review / merge diffs, open PRs, archive | ✅ Polished, central to UX | ⚠️ Git-clean check + worktrees; PR/merge flow not wired |
| Per-project setup/run/archive scripts (`.conductor/settings.toml`) | ✅ Shipping | ❌ No env/run-script config equivalent |
| Live "what's each agent doing" dashboard | ✅ Shipping (native Mac) | ⚠️ Full React dashboard built; **SSE live-wiring pending** |
| Free app, BYO Claude subscription | ✅ Same billing model we rely on | ✅ Same Max-plan model (validated) |
| **Planner / PM that decomposes a goal** | ❌ Explicitly absent | ✅ PM loop, tier classifier, charter (partly built) |
| **Specialized roles (Tester, Security, …)** | ❌ Every agent is the same generalist | ✅ Coder/Tester/Security built; Negotiator designed |
| **Dependency graph driving execution order** | ❌ Workspaces are independent | ✅ Built (`depends_on`, runnable detection) |
| **Enforced quality/safety gates** (fail-closed parsing, C1–C4, sensitive-path escalation) | ❌ None | ✅ C2 + sensitive-path + remediation built; C1/C3/C4 partial |
| **Crash recovery with leases/heartbeats** | ❌ Not a concern (human-driven) | ✅ Built (`reconcile()`) |
| **Marketplace of hireable specialist agents** | ❌ None | ⚠️ UI complete + roster persistence; routing contracts designed-only |
| **Cost budgeting in $/tokens with hard/soft caps** | ❌ (you pay your sub) | ✅ Global cap built; sub-limits partial |
| Native desktop app | ✅ Mac (Windows on roadmap) | ❌ Local web (Vite + browser) |
| Shipped & in users' hands | ✅ Public, has a following | ❌ Local single-user; several core seams unbuilt |

### Where they're ahead

1. **It ships and it's polished.** Native Mac app, real users, changelog, docs. Ours is a
   partially-built local tool — SSE not wired, planning mode is a keyword-matching mock,
   sandbox not started, Negotiator not implemented.
2. **Multi-model.** Codex + Cursor + Claude, switchable per workspace. We're Claude-only.
3. **The merge/PR/archive last mile is complete and central** — exactly the part of ours
   that's still designed-but-not-wired.
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
