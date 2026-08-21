# Agent Swarm — Lightweight Workflow

> Product proposal and engineering plan for making Swarm as easy to enter as Claude Code
> or Codex while preserving Swarm's advantage: governed, independently verified,
> multi-agent execution.

## Scope and terminology

This document interprets "lightweight workflow" as a single, low-friction way to ask
Swarm a question, request a change, make a plan, or start a coordinated run. The user
should not need to decide how much orchestration is appropriate before describing the
work.

The proposal does not remove Planning mode, the Project Charter, routing, approval gates,
or the task graph. It makes them progressively visible when the work justifies them.

## Product diagnosis

Swarm currently optimises for **running a governed software project**. Claude Code and
Codex optimise for **helping with the next thing**. That difference in activation energy
explains why a developer may return to either coding app for questions, exploration,
planning, and contained edits even when Swarm offers stronger execution controls.

The coding apps feel like tools that are already in the repository: type a request, let
the agent inspect the code, and decide later whether a plan is necessary. Swarm presents
useful machinery—charter, team, routes, forecast, approval, graph, findings, and review—
before it has always established that the request warrants that machinery. A small
request can therefore feel like the beginning of a run rather than a small request.

The intended correction is **progressive orchestration**: start every interaction with
the same lightweight intake, select the smallest sufficient execution shape, and
escalate in place when evidence shows that more process is warranted.

## Pros and cons

### Claude Code and Codex

#### Pros

- Very low activation energy: one prompt from an existing repository context.
- Questions, exploration, planning, implementation, and iteration share one surface.
- Planning is optional and can emerge naturally during conversation.
- Small tasks remain visually and conceptually small.
- Direct steering makes rapid, ambiguous iteration feel natural.
- The coding agent usually has immediate access to the code and working context.

#### Cons

- Quality depends heavily on the operator's prompt and discipline.
- Decomposition, independent review, and remediation are usually manual or informal.
- A plan can remain ephemeral rather than becoming durable project context.
- The implementer may also judge its own work, weakening independent verification.
- Cross-provider routing and specialist selection are not first-class capabilities.
- Evidence that work is complete is often a summary rather than structurally enforced
  tests, gates, findings, and visual verification.
- Broad or risky changes can silently receive the same interaction shape as a trivial
  edit.

### Swarm

#### Pros

- Plans work and routes each task to an appropriate provider, model, and effort level.
- Supports heterogeneous specialist teams and independent parallel work.
- Enforces deterministic tests, security review, remediation, and approval boundaries.
- Produces durable charters, findings, session recall, and living project knowledge.
- Makes execution observable through task state, live diffs, costs, findings, and an
  inbox for items needing human attention.
- Provides safer boundaries for Codex changes through validated, broker-mediated patches.
- Supports review, steering, rewind, and evidence-backed completion.

#### Cons

- The default lifecycle implies commitment to a formal run before the task's complexity
  is known.
- Charter, graph, team, route, and cost concepts can be disproportionate for a question
  or one-file edit.
- Switching between Planning and Running exposes an architectural distinction the user
  may not need to manage.
- Opening and supervising a dashboard costs more attention than issuing a request from
  the current shell or editor.
- A conversational plan can feel like an intermediate state waiting for Execute rather
  than a valid final outcome.
- The strongest capabilities appear as ceremony when they are always visible, even
  though they are valuable safeguards for larger work.

## Product principle: one front door, four execution shapes

Swarm should open with one prompt:

> What do you want done?

From the request and repository evidence, Swarm selects the smallest sufficient shape.
These are internal execution shapes, not modes the user must choose before writing the
request.

| Shape | Use when | User-visible result | Hidden machinery |
| --- | --- | --- | --- |
| **Answer** | Explanation, investigation, status, or review with no requested writes | Direct, evidence-backed response | Read-only Scout or PM turn; no run graph |
| **Quick task** | Bounded, low-risk change with clear scope | Diff, focused verification, optional commit | One-node task graph and normal permission boundary |
| **Plan** | The user asks for options or ambiguity must be resolved before writing | Standalone plan with decisions, risks, and next action | Draft understanding; charter only if it becomes durable |
| **Coordinated run** | Broad, risky, multi-system, or independently reviewable work | Plan approval followed by routed execution and gates | Full charter, graph, forecast, team, review, and remediation |

The user may explicitly request a shape, but Swarm owns the recommendation. Every
recommendation includes a short rationale and the next useful action; it should not
force the user through a mode-selection form.

Example quick task:

```text
You: Fix the stale-server banner. It remains visible after reconnecting.

Swarm: I found the reconnect path and banner state. This is a contained UI change
with focused tests, so I can handle it as a quick task.

[Do it]  [Show approach]
```

Example escalation:

```text
You: Replace the permission model.

Swarm: This crosses the request guard, permission broker, approval UI, and stored
run state. I recommend a coordinated run with migration tests and security review.

[Review plan]  [Start recommended run]
```

## Recommended experience changes

### 1. Universal intake

Add a persistent **Ask Swarm** composer in the dashboard and a matching CLI entry:

```sh
swarm "fix the reconnect banner"
swarm ask "why is this test flaky?"
swarm plan "move sessions to SQLite"
```

The bare prompt uses automatic classification. Explicit verbs are shortcuts and
overrides, not separate products. If a browser is unnecessary, the CLI returns the
answer or quick-task progress in place. It opens the dashboard only when richer review,
approval, or supervision becomes useful.

### 2. Automatic execution-shape classification

Classify from intent, requested writes, ambiguity, affected paths, sensitive paths,
estimated scope, and verification needs. Prefer deterministic signals over an LLM when
possible. The classifier returns one consistent structure:

```ts
type ExecutionShape = 'answer' | 'quick_task' | 'plan' | 'coordinated_run';

interface IntakeDecision {
  shape: ExecutionShape;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  riskSignals: string[];
  suggestedAction: string;
}
```

Classification recommends presentation and workflow; it must not bypass existing
security escalation, permission, budget, or quality-gate rules. A sensitive-path change
can never become less protected because intake called it a quick task.

### 3. A real quick-task path

Represent a quick task internally as a one-node run so it reuses routing, dispatch,
permissions, state, cost tracking, and recovery. Give it a compact presentation:

- request and current activity;
- accumulated diff;
- focused checks and their evidence;
- review diff, request changes, and commit actions.

Do not show an empty team panel, a one-node graph, marketplace recommendations, or a full
charter unless the user expands implementation details.

### 4. Planning as a complete outcome

"Investigate," "brainstorm," and "make a plan" must be legitimate terminal outcomes.
Do not frame every plan as incomplete because it has not been executed. Maintain a
compact background understanding—goal, constraints, non-goals, decisions, and open
questions—and expose the full charter only when the user asks or execution requires an
approval boundary.

### 5. Progressive disclosure

The default task surface shows only:

- the conversation;
- what Swarm is doing now;
- anything requiring the user's decision;
- the result and verification evidence.

Routes, forecasts, agents, graph nodes, findings, and raw activity remain available in
an expanded **Run details** view. When risk or cost requires explicit confirmation,
surface the consequential facts at the decision point rather than relying on a hidden
panel.

### 6. Escalation without restart

An answer may become a plan, a plan may become a quick task, and a quick task may become
a coordinated run without losing the conversation, repository findings, or decisions.
Escalation triggers include:

- discovered scope beyond the declared write boundary;
- sensitive paths or migrations;
- unresolved product or architecture decisions;
- multiple independently changeable subsystems;
- a failing gate that warrants specialist review;
- cost or duration exceeding the quick-task threshold.

Swarm pauses at the boundary, explains the evidence, proposes the expanded workflow,
and asks for any newly required approval. It does not silently widen write scope or
spend.

### 7. Optional command shortcuts

Natural language remains primary. Shortcuts support frequent users and make intent
explicit when desired:

```text
/ask   Why is this test flaky?
/do    Add the missing empty state
/plan  Move sessions to SQLite
/swarm Replace the authorization layer
```

## Workflow state model

Use a single conversation/session identity across escalation. Keep execution shape
separate from run status:

```text
intake
  ├─ answer ──────────────── result
  ├─ plan ───────────────── plan result
  │                            └─ approve work ─┐
  ├─ quick task ───────────────────────────────┼─ verified result
  │        └─ scope/risk grows ────────────────┤
  └─ coordinated run ──────────────────────────┘
```

A session may have no run, one compact run, or a full run. Existing run-state invariants
remain unchanged once execution starts. The UI derives its density from execution shape;
the engine continues to rely on explicit state and validated transitions.

## Engineering plan

The work should ship as vertical slices. Each phase must be useful on its own and must
reuse the existing driver, state, permission, routing, and gate boundaries.

### Phase 0 — Baseline and contracts

**Goal:** define measurable friction and stabilise the intake contract before changing
the UI.

- Record baseline events: intake started, first useful response, plan ready, execution
  confirmed, run started, result reviewed, and abandonment.
- Add `ExecutionShape` and `IntakeDecision` types in the core domain.
- Define classification fixtures for questions, plans, bounded edits, sensitive changes,
  migrations, and broad refactors.
- Define a stable session identifier that survives escalation from conversation to run.
- Reconcile `BUILD.md` and implementation-status documentation where it no longer
  reflects the shipped server and Planning integration.

**Verification:** unit tests for the contract and event schema; baseline metrics visible
locally without retaining prompts or code content.

### Phase 1 — Read-only Answer workflow

**Goal:** make Swarm useful without creating a run.

- Add a core intake service that identifies read-only requests.
- Route Answer through the existing PM/Scout read-only capability.
- Return cited file evidence and a clear terminal response without generating a charter
  or task graph.
- Add `swarm ask "..."` and accept a bare quoted prompt as an alias.
- Render the same conversation in the dashboard's universal composer.

**Verification:** integration tests prove that Answer cannot invoke write tools, create a
branch, or mutate repository files; CLI and dashboard produce the same stored session.

### Phase 2 — Compact one-agent Quick task

**Goal:** make a contained edit feel comparable in weight to a coding-app request.

- Compile a quick task to a one-node graph using the existing route recommendation.
- Reuse current permission handling, broker-mediated Codex patch validation, leases,
  cost tracking, focused deterministic checks, and diff review.
- Add the compact task surface and keep full run details expandable.
- Offer commit after verification; preserve the existing rule that incomplete or failing
  work is never committed.
- Escalate sensitive-path and unexpectedly broad changes before continuing.

**Verification:** end-to-end fixtures for one-file UI, test-only, and documentation
changes; existing permission, route, crash-recovery, and gate tests remain green; a
sensitive-path fixture cannot bypass security review.

### Phase 3 — Unified automatic intake

**Goal:** remove the need to choose Answer, Quick task, Plan, or Coordinated run first.

- Implement the deterministic-first classifier and a bounded model fallback for
  ambiguous intent.
- Explain the selected shape in one sentence and expose an override.
- Make the universal composer the default landing experience.
- Preserve explicit `/ask`, `/do`, `/plan`, and `/swarm` overrides in CLI and UI.
- Add confidence-aware behaviour: low confidence gathers evidence or proposes a plan
  rather than initiating writes.

**Verification:** table-driven classification tests plus an evaluation corpus with
expected shape, risk signals, and allowed transitions. Measure false-lightweight errors
separately because under-classifying risky work is more costly than over-classifying it.

### Phase 4 — Progressive charter and plan outcomes

**Goal:** retain durable planning value without making the charter an up-front form.

- Derive the compact understanding from PM structured updates already used by Planning.
- Treat a plan as complete when the user's requested outcome is a plan.
- Reveal the full charter at user request or before a coordinated execution approval.
- Preserve provenance, scoped agent injection, open-question checks, route confirmation,
  and branch decisions at the existing approval boundary.
- Allow plan-to-execution promotion without replaying the planning conversation.

**Verification:** tests for plan-only completion, charter compilation, provenance,
conversation continuity, and promotion to a run.

### Phase 5 — In-place escalation

**Goal:** let the workflow grow safely when investigation changes the risk assessment.

- Add explicit transition rules between execution shapes.
- Carry forward evidence, decisions, session history, proposed paths, and cost already
  incurred.
- Require approval for widened paths, added specialists, increased budget, or a branch
  strategy change.
- Present a concise before/after summary of the proposed escalation.
- Resume through existing run creation rather than inventing a second execution engine.

**Verification:** integration tests for Answer → Plan, Plan → Quick task, Quick task →
Coordinated run, rejection of escalation, and recovery after restart at each boundary.

### Phase 6 — Entry points and polish

**Goal:** make Swarm available where the user naturally begins work.

- Finalise `swarm "..."` with streaming terminal progress and a compact result.
- Open the dashboard only for approvals, rich diff review, or full-run supervision unless
  the user explicitly requests it.
- Add a global dashboard composer and optional editor/menu-bar launcher later, using the
  same intake API.
- Add recent-task recall so a follow-up can continue the prior session without locating
  it manually.
- Tune empty, loading, escalation, failure, and cancellation states.

**Verification:** run the same scenario suite through CLI and dashboard; capture real
time-to-first-response and prompt-to-verified-result measurements; perform screenshot
verification of compact and expanded states.

## Orchestrated implementation slices

The lightweight workflow should be delivered as small work packets with one coordinator
owning sequencing, docs, and integration decisions. Each packet should be independently
testable and, where possible, assigned to the least-capable model that still matches the
risk.

### Coordinator responsibilities

- Maintain the single workflow contract: `ExecutionShape`, `IntakeDecision`, transition
  rules, and verification expectations.
- Serialize packets that touch the same files or the same state transitions.
- Keep the README and this document aligned with shipped behaviour.
- Reject any packet that weakens sensitive-path escalation, route validation,
  permissions, or deterministic gates in the name of "lightweight" UX.

### Recommended packets and model tiers

| Packet | Scope | Recommended model | Why |
| --- | --- | --- | --- |
| **A. Intake contract** | Pure `ExecutionShape` / `IntakeDecision` types, deterministic classifier, fixtures, server request validation | **GPT-5.4** | Deterministic core logic and tests; modest integration risk |
| **B. CLI command parsing** | `swarm ask`, `swarm do`, `swarm plan`, `swarm "..."`, usage/help output, parser fixtures | **GPT-5.4 Mini** | Mostly mechanical parsing and usage-string work |
| **C. Intake API plumbing** | `/intake/classify`, shared session identity, telemetry events for intake started / decision made | **GPT-5.4** | Straightforward server and state wiring with moderate contract sensitivity |
| **D. Answer workflow** | Read-only PM/Scout path, no-run terminal outcome, shared session persistence | **GPT-5.5** | Crosses planning, server, and storage boundaries; quiet mistakes matter |
| **E. Quick task compiler** | Compile quick tasks to one-node runs, narrow write scope, focused checks, escalation triggers | **GPT-5.5** | Higher behavioural risk because it touches execution, permissions, and gates |
| **F. Compact task UI** | Minimal task surface, expandable run details, result and verification evidence | **GPT-5.4** | Mostly presentation work on top of settled server contracts |
| **G. In-place escalation** | Answer → Plan → Quick task → Coordinated run transitions and approval boundaries | **GPT-5.5** | Stateful workflow logic with high regression cost |
| **H. Evaluation corpus** | False-lightweight fixtures, regression corpus, local metrics reports | **GPT-5.4 Mini** | Fixture-heavy, mostly mechanical expansion once the contract settles |

### Suggested execution order

1. Packet A: land the deterministic intake contract and server seam first.
2. Packet B: finish CLI parsing and top-level command routing while the contract is
   still fresh.
3. Packet C: emit stable intake telemetry and session identity before richer workflows
   depend on them.
4. Packet D: ship Answer as the first full lightweight outcome.
5. Packet E and Packet F: add Quick task execution and its compact UI together once the
   read-only path is stable.
6. Packet G: add in-place escalation only after Answer and Quick task are both proven.
7. Packet H: keep expanding the evaluation corpus throughout, but treat it as complete
   only after escalation ships.

### Current status

The first packet is the right starting point and is already useful even before the full
workflow lands:

- deterministic intake classification can now distinguish `answer`, `quick_task`,
  `plan`, and `coordinated_run`;
- read-only questions about sensitive areas remain `answer` while still surfacing risk
  signals;
- explicit requested shapes are handled as structured input rather than by smuggling
  slash prefixes through the request text; and
- the contract is covered by table-driven tests for the classifier, server intake
  validation, and CLI command parsing.

## Implementation boundaries

- Do not create a separate lightweight execution engine. Compile lightweight requests
  into existing read-only planning or run primitives.
- Do not let presentation classification weaken sensitive-path escalation, permission
  checks, route validation, cost controls, or deterministic gates.
- Do not silently expand declared write scope, team, budget, or provider cost class.
- Keep the classifier pure and deterministic where inputs allow it; isolate any model
  fallback behind a narrow interface with evaluation fixtures.
- Keep answer generation separate from actions that mutate repository or run state.
- Preserve strict return types and avoid boolean mode flags; use explicit shape-specific
  functions and discriminated unions.
- Store only safe workflow telemetry. Do not retain prompt bodies, code, secrets, or raw
  provider logs in analytics.

## Success measures

The change is successful when lightweight work no longer requires the user to think in
terms of orchestration, while complex work still receives Swarm's protections.

Track:

- median time from opening Swarm to submitting a request;
- median time to first useful response for Answer and Plan;
- median time from request to verified diff for Quick task;
- percentage of sessions completing without opening full Run details;
- abandonment before the first useful response and before execution approval;
- manual shape overrides, split by original and selected shape;
- Quick tasks escalated because of discovered scope or risk;
- false-lightweight classification rate on the evaluation corpus;
- gate-pass, rollback, and fix-loop rates compared with current coordinated runs;
- repeated use of Swarm for questions and contained edits, not only large runs.

Initial product targets should be set after Phase 0 captures a baseline. Safety targets
are immediate: zero bypasses of existing sensitive-path, permission, budget, and quality
controls.

## Recommended delivery order

Build **Answer first**, then **Quick task**, and only then make classification automatic.
This yields two useful lightweight workflows before an intake classifier is trusted to
choose between them. After that, make the charter progressive and add in-place
escalation. Entry-point polish comes last because it should expose one proven intake
contract rather than hard-code another workflow.

The resulting product position is:

> **Codex and Claude Code help you code. Swarm decides how much process the work deserves—and supplies it.**
