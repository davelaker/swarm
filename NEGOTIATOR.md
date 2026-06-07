# Agent Swarm — The Negotiator

> Companion to `DESIGN.md` and `MARKETPLACE.md`. Designs the agent that reconciles
> conflicting findings. Once teams grow (via the marketplace), conflict stops being an
> edge case and becomes routine — which promotes the Negotiator from "nice to have" to
> load-bearing.

---

## 1. What problem it solves

With one reviewer, a finding is just acted on. With many reviewers, two specialists will
issue **contradictory** guidance on the same artifact:

- UX Researcher: "add rich animated transitions" · Performance Engineer: "those blow the
  interaction budget."
- API Designer: "make it flexible and generic" · Security: "narrow the surface."
- Coder: "this finding isn't exploitable, won't fix" · Security: "it is, and it blocks."

Without a designated resolver, the PM either picks one arbitrarily (bad) or bounces it to
the human every time (defeats the point). The **Negotiator** is the agent whose only job
is to turn a conflict into a **ruling** the PM can act on.

---

## 2. The hard guardrail (read this first)

**The Negotiator arbitrates trade-offs. It cannot rule away a correctness or safety
finding.** This is the single most important design constraint, and it is non-negotiable.

- A genuine HIGH security vulnerability, a real data-loss bug, a failing correctness test —
  these are **not negotiable**. The Negotiator may decide *how* to fix (timing, scope,
  sequencing) but never *whether*. It cannot downgrade "there is a SQL injection" to
  "ship it."
- Findings carry a `negotiable` property derived from their type. Security/correctness
  findings are `negotiable: false`. UX/performance/style/architecture-preference findings
  are `negotiable: true`.
- If a conflict contains a `negotiable: false` finding on one side, the Negotiator's only
  legal moves are **uphold-the-hard-finding** (and rule on the *manner* of compliance) or
  **escalate to human**. It can never uphold the soft side against the hard one.

This keeps the system's "security and testing enforced structurally" promise intact even
as the team fills with opinionated specialists.

> **Enforcement note (threat review S1).** This guardrail is only real if it is enforced in
> *code*, not by asking an LLM nicely. Two requirements: (1) the `negotiable` flag must be
> **derived by the system from the finding's type/source** (security/correctness →
> `false`), never self-declared by the producing agent — otherwise a compromised or mistaken
> agent downgrades a vulnerability to negotiable. (2) The orchestrator must **reject any
> ruling that upholds a soft finding against a `negotiable:false` one**, regardless of what
> the Negotiator's text says — the LLM ruling is an input the code validates, not the final
> authority. Treat the Negotiator as advisory; the *gate* is code. See `THREATS.md`.

---

## 3. When it triggers — conflict detection *(threat review A5)*

**The detector and the adjudicator are different jobs, in different agents.** Deciding
whether two free-text recommendations *truly* contradict is a hard semantic task — and the
PM is deliberately a cheap, mechanical triage loop (`DESIGN.md` §6), not the place for it.
So detection is split:

> **The PM flags *candidate* conflicts cheaply, from structured fields.
> The Negotiator adjudicates whether a candidate is a real either/or.**

This mirrors the system's whole philosophy: keep the orchestrator deterministic; put the
reasoning in the focused agent built for it. It is fine for detection to **over-flag** (a
candidate that turns out compatible costs one Negotiator call); it must never **under-flag**
and silently drop a blocking finding (see fail-safe below).

### Detection signals — structured first, never prose-semantics

The PM raises a candidate from fields already on every finding, in order of certainty:

1. **Explicit dispute (deterministic).** A finding tagged `disputes: <finding-id>` — the
   agent *declared* the conflict (e.g. the Coder formally contesting a Security finding
   rather than silently complying). Zero inference. Always fires.
2. **Builder refusal (deterministic).** A builder finding tagged
   `cannot_satisfy: [<finding-id>, …]` — declared, not inferred. Always fires.
3. **Co-blocking on the same locus (structured).** Two `blocks_done: true` findings whose
   `task` (same artifact/task) matches **and** whose per-issue `location` (in `findings[]`)
   overlaps (same function / region / field). Computed from fields — `blocks_done`, `task`,
   `location` —
   **not** from comparing paragraphs. Two blocking findings on the same spot is the
   *signal*; whether they actually conflict is the question handed to the Negotiator.

If two blocking findings share a `task` but their `location`s don't overlap (a SQLi and a
missing test on the same file), they are **independent, not a conflict** — the PM just
creates both remediation tasks. The Negotiator is only for a genuine *either/or*, and the
adjudication of "candidate → real conflict or compatible?" is the *one* place semantic
reasoning is spent — bounded by C4's dispute-round cap.

### Fail-safe direction (ties to control C2)

Detection is an over-approximation, so it can mis-judge — but the safe direction is
guaranteed by the gate, not the detector: **a task cannot reach `done` while two unresolved
`blocks_done` findings target it.** So a *missed* conflict never lets a blocking finding
evaporate into `done`; the worst case degrades to "PM creates both remediation tasks" or
"Negotiator gets called," never "task silently ships." Detection failure is a cost/latency
risk, not a safety hole — exactly the C2 fail-closed posture, applied to conflicts.

### What this requires of the finding schema

Structured detection reads the fields defined in the **finding gate contract**
(`DESIGN.md` §6.2a): `task` (artifact/task id), `blocks_done` (bool), `location` (where in
the artifact), plus the declarative `disputes` / `cannot_satisfy` tags. Per **S1**, the
gate-relevant fields (`blocks_done`, `negotiable`) are **system-derived there, not trusted
as the agent wrote them** — a mistaken or compromised agent must not be able to suppress a
conflict by lying in a field.

> A **dispute round** (the unit C4's cap counts) = one Negotiator adjudication plus any
> remediation tasks its ruling spawns. Exceeding the cap forces `ESCALATE` to the human.

---

## 4. Inputs and authority

The Negotiator is **read-only**. It receives:

- the two (or more) conflicting findings, in full;
- the task and the project `goal` / `product_brief`;
- the `tier` (a tweak tolerates less ceremony than greenfield);
- any stated project priorities (e.g. "performance is a top-three product value").

It has **no write access to code** and **cannot change task status** — like every worker,
it writes a finding (its ruling) and the PM acts on it. It is an advisor with a narrow,
well-defined verdict, not a dictator.

---

## 5. Output: the ruling

A ruling is a structured finding (`finding_schema: negotiation-ruling`):

```yaml
---
task: t7
agent: negotiator
verdict: RESOLVED            # RESOLVED | ESCALATE
schema: negotiation-ruling
conflict:
  between: [ux-finding:UX-2, perf-finding:PERF-1]
  axis: "richness of motion vs interaction latency budget"
decision: SYNTHESIZE         # UPHOLD_A | UPHOLD_B | SYNTHESIZE | ESCALATE
rationale: >
  Both are negotiable. The product brief lists "fast, scannable" as a core value, so
  latency wins where they truly conflict — but the UX goal is achievable within budget
  with constraints, so a synthesis serves both rather than discarding one.
actions:                      # concrete, becomes new/updated tasks for the PM
  - "Implement the transitions (satisfies UX-2) using GPU-friendly CSS transforms only."
  - "Cap any transition at 150ms and honour prefers-reduced-motion (satisfies PERF-1)."
creates_tasks:
  - { title: "Apply constrained transitions per ruling", assignee: coder, depends_on: [t7] }
blocks_done: true            # the synthesis must be implemented before done
---

## Reasoning
... human-readable explanation ...
```

The four legal `decision` values:

| Decision     | Meaning                                                            | When |
| ------------ | ----------------------------------------------------------------- | ---- |
| `UPHOLD_A`   | One side is simply right (often: one was factually mistaken).      | Correctness disputes; one side misread the code |
| `UPHOLD_B`   | Same, the other way.                                              | — |
| `SYNTHESIZE` | A concrete middle path satisfying both within constraints.         | Genuine trade-offs between two `negotiable` findings |
| `ESCALATE`   | The Negotiator declines to rule.                                  | A `negotiable:false` finding is being contested on the merits; or the call is architecturally significant; or priorities don't disambiguate |

---

## 6. How the PM acts on a ruling

- `RESOLVED` → the PM applies `actions` / `creates_tasks`, updates the conflicting tasks'
  status accordingly, posts a one-line summary to PM chat, and the loop continues.
- `ESCALATE` → the PM sets the relevant tasks `blocked`, surfaces the conflict and the
  Negotiator's framing to the **human** via PM chat (this is a human-in-the-loop entry
  point), and waits. The Negotiator having *framed* the trade-off cleanly is itself
  valuable even when it doesn't decide — the human gets a crisp choice, not a mess.

---

## 7. Conflict taxonomy (how it should reason)

| Type | Example | Right move |
| ---- | ------- | ---------- |
| **Correctness** | One agent claims a bug the other says isn't real | Determine who's *factually* right → `UPHOLD`. Not a compromise; facts aren't split-the-difference. |
| **Trade-off** | UX richness vs performance budget | Weigh against project priorities → usually `SYNTHESIZE`, else `UPHOLD` the prioritised value. |
| **Authority** | Builder vs Security on a real vuln | Hard finding wins (§2). Rule only on the *manner* of the fix, or `ESCALATE`. Never uphold the soft side. |
| **Preference** | Two valid architectural styles | If priorities don't disambiguate, `ESCALATE` — don't impose a coin-flip on something architecturally significant. |

The meta-rule: **compromise is for trade-offs, not for facts or safety.** A Negotiator that
"splits the difference" on a correctness or security question is a bug, not a feature.

---

## 8. Why a separate agent (not just PM logic)

The PM *detects* conflict but shouldn't *resolve* it inline, for the same reason reviewers
are separate from the coder: **focused context and an auditable artifact.** The Negotiator
gets a clean context window containing only the conflict and the priorities, produces a
written ruling with rationale that lives on the blackboard, and can be inspected, learned
from, or overruled. Folding it into the PM loop would bury the reasoning and bloat the
orchestrator's context with every dispute.

See `examples/negotiator/` for a worked conflict and ruling.
