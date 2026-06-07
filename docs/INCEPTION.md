# Agent Swarm — Inception (Planning Mode)

> Companion to `DESIGN.md`. Defines the phase *before* execution: a conversational
> brainstorm with the PM that pressure-tests the idea and produces a **Project Charter**
> — the source of truth every agent reads from once the swarm runs. This phase is, in
> effect, a productised version of the very conversation that produced this design corpus.

---

## 1. Two modes, one PM

The system has two distinct modes. We had been collapsing them; separating them is the
unlock.

| | **Planning mode** (this doc) | **Execute mode** (`DESIGN.md` §6) |
| --- | --- | --- |
| Nature | Conversational, human-in-the-loop | Autonomous, graph-driven |
| Who acts | PM as a thinking partner | PM dispatches workers |
| Workers | None build; specialists may be *consulted* | Coder / Tester / Security / … running |
| Output | A **Project Charter** | Code, tests, findings |
| Cost | Cheap (a conversation) | Expensive (the swarm) |
| Ends with | The **approval gate** | The graph reaching `done` |

The PM wears both hats: the planning interlocutor and the execution orchestrator. You talk
to one entity throughout — it just changes what it's doing when you say "execute."

---

## 2. The launch experience

A single command (later: a clicked desktop/menu-bar app) boots everything and drops you
into the conversation:

```
$ swarm
  ▸ orchestrator live
  ▸ dashboard → http://localhost:7000   (opening browser…)
  ▸ PM ready · PLANNING mode. What are we building?
```

It boots the orchestrator, starts the local web server (SSE + actions, UX §3),
**auto-opens the browser** at the localhost URL, and lands you in PM chat in **Planning
mode** by default for a new project. Launching *is* the start of the conversation — there
is no separate "initiate work" step.

---

## 3. The PM as a critical partner (not a transcriber)

The entire value of Planning mode depends on the PM *interrogating* the idea, not
recording it. Its planning persona is tuned to:

- **Push back** on weak or hand-wavy decisions, and say so plainly.
- **Surface trade-offs** and the roads not taken, not just the chosen path.
- **Ask the uncomfortable questions** — users, scale, failure modes, security, scope.
- **Resist scope creep** — actively defend a lean v1 ("that's a v2; let's not block on it").
- **Know when it's enough** — "we have enough to start; here's what's still fuzzy — resolve
  now, or discover during build?"

A PM that agrees with everything is worse than useless. This is a prompt-design
requirement, and it mirrors exactly how a good design conversation feels.

---

## 4. Consultative specialists (advisory, read-only)

A reuse of the architecture: during planning the PM can **pull in specialist personas in a
read-only, questioning capacity** — *before* anything is built — to pressure-test the idea.

- **Security** asks: "How are you handling auth? Any PII? What's the threat model?"
- **UX Researcher** asks: "Who are the users — power users or first-timers? Mobile?"
- **Architect** flags: "That's three services where one would do."

Same personas as execution, in **consultative mode**: they write no code and produce no
blocking findings — they contribute questions and concerns into the conversation. This is
the "design review / ask questions about the implementation and goals" you want, for free,
from agents you already have.

---

## 5. The Project Charter (the artifact)

Planning produces exactly one durable artifact: the **Project Charter**. It is a
`DESIGN.md` for the target project, and — critically — it becomes the `{{PROJECT_CONTEXT}}`
injected into **every** agent's effective prompt during execution (the marker in the UX
Researcher base prompt). So the brainstorm flows directly into what the PM tells the Coder,
the Security agent, the UX Researcher. Inception is not a throwaway chat; it is the source
of truth the whole execution reads from.

### Charter schema

```yaml
# charter.md (frontmatter + body)
project: focuslist
owner: me
tier: greenfield
status: draft                 # draft | approved | amending
goal: >
  A minimal, keyboard-first todo web app for power users.
target_users: >
  Individual power users on desktop; keyboard-driven; not mobile-first.
constraints:
  - "No account system in v1 — local storage only."
  - "Keyboard-operable end to end; mouse optional."
  - "Ship as a single static site; no backend in v1."
non_goals:
  - "Collaboration / sharing (v2)."
  - "Mobile-optimised layout (v2)."
success_criteria:
  - "Create, complete, reorder, and filter tasks entirely by keyboard."
  - "Loads and is interactive in under 1s on mid hardware."
decisions:                    # decisions WITH rationale — the roads not taken
  - decision: "Local storage, no backend."
    rationale: "v1 is single-user, single-device; a backend adds auth + hosting cost for no v1 value."
  - decision: "Vanilla + a tiny framework, no heavy SPA stack."
    rationale: "Keyboard-first todo app doesn't justify the bundle; performance is a success criterion."
resolved_questions:           # pre-answered so agents don't stall during execution
  - q: "Undo for completed tasks?"
    a: "Yes — single-level undo on the last action."
open_questions:               # known unknowns, deliberately deferred
  - "Theming (light/dark) — defer; decide during build."
recommended_team:             # which marketplace agents to hire (see §6)
  - ux-researcher
  - accessibility-auditor
```

The `decisions` and `resolved_questions` blocks are the highest-value part — they are what
keep agents from guessing or escalating mid-build.

### 5.1 The charter is a single point of distortion — bounding it *(threat review A3)*

The very thing that makes the charter valuable — LLM-generated, and injected into **every**
agent — also makes it dangerous on two axes:

- **Distortion that propagates.** One hallucinated constraint, or an instruction injected
  via planning-time research (a poisoned page the PM read while brainstorming), reaches
  *every* agent's prompt. The charter is an **amplifier for S4**: a single bad field becomes
  swarm-wide.
- **Cost that multiplies.** The whole charter in every dispatch is paid on every agent call
  (ties to C4).

Two mitigations bound both — they don't remove the charter's centrality, they make
distortion *catchable* and *contained*.

**1. Validate the charter against the conversation — don't just approve it.** The compile
step (§7) must emit a charter whose every claim is **traceable to the planning
conversation**:

- Each `decision` / `constraint` / `resolved_question` carries provenance back to the
  conversation turn(s) it derives from.
- The compiler **flags any charter content with no basis in the conversation** ("this
  constraint was never discussed"), so the human review (§7) ratifies a *grounded* artifact
  rather than silently rubber-stamping a hallucination. The approval gate becomes a real
  check: the human confirms *intent*, the provenance check confirms *fidelity*.
- This is also how a **planning-time injection is contained**: a constraint that appeared
  from nowhere surfaces as ungrounded and is caught at the one human gate *before* execution,
  instead of propagating to every agent. A3's job is to stop the charter being a silent S4
  amplifier.

**2. Scope the injection — each agent gets its slice, not the whole charter.**
`{{PROJECT_CONTEXT}}` is **not** the entire charter for everyone. Inject the role-relevant
projection:

- **Invariant core (all agents):** `goal`, `tier`, `non_goals`, `success_criteria`.
- **Role slices:** the Coder gets `constraints` + `decisions`; the UX Researcher gets
  `target_users` + UX constraints; the Security agent gets `constraints` + `non_goals` +
  security-relevant decisions; and so on.

Two wins: **blast radius** — a wrong or poisoned field only reaches agents whose slice
includes it, not all of them; and **cost** — smaller per-agent context, paid on every
dispatch (C4).

> Bounded, not eliminated. The charter stays the load-bearing source of truth by design.
> The amend path (§8) extends both mitigations: an amendment re-runs the same provenance
> check and re-scopes only the affected slices.

---

## 6. The charter recommends a team

Part of "working out what the project is" is realising it needs a UX Researcher and an
Accessibility Auditor. So the charter outputs a **recommended team** to hire from the
marketplace, closing the loop:

```
brainstorm  →  charter + recommended team  →  you hire  →  execute
```

The PM proposes; you approve the hires (with their tool grants — MARKETPLACE §6) as part of
the approval gate. The team is assembled *to fit the project*, not chosen blind.

---

## 7. The approval gate (the boundary that matters)

You brainstorm freely — cheap, no workers — until you say **"execute."** That word triggers
the single most important transition in the system:

1. **Compile** — the PM turns the conversation into the structured charter (status `draft`).
2. **Review** — it presents the charter (and the recommended team + tool grants) for your
   **approval**. This is the human-in-the-loop checkpoint: the last cheap moment before the
   expensive part. You can edit, push back, or send it back to more brainstorming.
3. **Approve** — on your go, the charter flips to `approved`, the recommended team is hired,
   and the PM builds the execution task graph from the charter + the team's routing
   contracts (MARKETPLACE §2).
4. **Switch** — the dashboard flips from **PLANNING** to **RUNNING**, and the first agent is
   dispatched (DESIGN §6.3).

Nothing expensive happens before step 3. That's the design intent: **spend a conversation
before you spend a swarm.**

---

## 8. Planning ↔ Execution is not strictly one-way

Reality intrudes during builds: a security finding invalidates an assumption, or a resolved
question turns out wrong. When that happens the PM can **drop back into Planning mode**,
amend the charter (status `amending`), get your sign-off on the change, and re-plan the
affected part of the graph — rather than letting the charter silently go stale while the
build drifts from the spec. The charter stays the living source of truth; execution can
kick back to planning when the truth changes.

---

## 9. The dashboard in Planning mode

The dashboard reflects the mode (UX §5 shows RUNNING; this is its sibling):

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Agent Swarm   ·  Project: focuslist   ◷ PLANNING                            │
│                                                   [ Execute ▶ ]              │
├──────────────────────────────┬────────────────────────────────────────────┤
│  CHARTER (live, taking shape) │  PM CONVERSATION                            │
│  Goal: keyboard-first todo…   │  PM: Who are the users — power users, or    │
│  Constraints:                 │      first-timers? It changes everything.   │
│   • local storage only        │  You: power users, desktop, keyboard-first  │
│   • keyboard end-to-end        │  PM: Good. Then mobile is a non-goal for v1 │
│  Non-goals: collab, mobile    │      — agreed? Also: undo on complete?       │
│  Open Qs: theming             │  [Security consulted]: any PII? → none → ok  │
│  Recommended team:            │  You: ▌                                      │
│   + UX Researcher             │                                  [ Send ]    │
│   + Accessibility Auditor     │                                            │
└──────────────────────────────┴────────────────────────────────────────────┘
```

- **Left:** the charter assembling itself live as you talk — you *watch the spec form*.
- **Right:** the conversation, including consulted specialists' interjections.
- **The graph is empty/draft** until you hit **Execute**, at which point this view yields to
  the RUNNING dashboard (UX §5).

---

## 10. Honest tensions

- **"Done enough."** Over-planning is as bad as under-planning. The PM should offer to start
  with known unknowns explicitly deferred to `open_questions`, not chase every detail.
- **Push-back vs. obstinacy.** It must challenge without becoming a wall; tunable, and the
  human always wins a tie.
- **Charter drift.** §8 exists precisely because a frozen charter rots; the amend path keeps
  it honest.
- **Scope creep.** A *critical* PM resists ballooning v1 — the bias is toward shipping a lean
  thing and learning, matching the whole project's "speed" goal.

---

## 11. Glossary additions

| Term | Definition |
| ---- | ---------- |
| **Planning mode** | The conversational, human-in-the-loop phase where the PM brainstorms and pressure-tests the project before any work is dispatched. No workers build. |
| **Execute mode** | The autonomous, graph-driven phase (DESIGN §6) where the PM dispatches workers against the approved charter. |
| **Project Charter** | The single durable artifact of Planning mode: goals, constraints, non-goals, success criteria, decisions-with-rationale, resolved/open questions, and a recommended team. Becomes the `{{PROJECT_CONTEXT}}` every agent reads. |
| **Consultative mode** | A specialist persona invoked during planning in a read-only, questioning capacity — contributes concerns/questions, writes nothing, blocks nothing. |
| **Approval gate** | The human-in-the-loop checkpoint between Planning and Execute: compile the charter, approve it (and the team/tool grants), then build the graph. The boundary before expensive work begins. |
| **Inception** | Shorthand for the whole Planning-mode session that produces the charter. |
