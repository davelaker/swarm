# Agent Swarm — Starter Catalog (the first templates)

> Companion to `MARKETPLACE.md`. The routing **contract** is the hard part of a template
> (a vague one fires when it shouldn't or never fires), so this catalog leads with
> contracts, not prose. These are the agents worth shipping first.

Legend for the contract fields (full schema in `MARKETPLACE.md` §3):
- **role:** planner | researcher | builder | reviewer | negotiator
- **trigger:** `always` | `on_artifact` | `on_request` | `on_conflict`
- **blocks?:** can a `CHANGES_REQUESTED` verdict block `done`? (`hard` = produces
  `negotiable:false` findings — see `NEGOTIATOR.md` §2)
- **pos:** where it sits relative to other tasks in the graph

---

## The default team (ships installed, `@builtin`)

| Agent | role | tiers | trigger | pos | blocks? | tools |
| ----- | ---- | ----- | ------- | --- | ------- | ----- |
| **Project Manager** | (orchestrator) | all | always | — | — | spawn agents |
| **Coder** | builder | all | always | first | — | read, write, shell |
| **Tester** | reviewer | feature, greenfield | on_artifact (code) | after coder | soft* | read, run-tests |
| **Security Reviewer** | reviewer | feature, greenfield | on_artifact (code) | after coder, before done | **hard** | read (read-only on code) |

\* A failing *test* is a correctness signal and is effectively hard in practice; the Tester
produces `negotiable:false` findings for actual test failures, `negotiable:true` for
coverage suggestions.

> **Tweak-tier is not "unreviewed" (threat review S2).** The Security Reviewer runs on
> `feature` and `greenfield` but the `tweak` fast-path skips it — and the tier is chosen by
> an LLM, so a mislabelled "tweak" could ship a vulnerability (an auth comparison, a regex, a
> permission default). **Rule:** any diff touching auth, crypto, permissions/access control,
> input handling, or query construction (SQL etc.) **force-escalates** out of `tweak` and
> always gets a security pass, regardless of size. "Small" must never mean "unreviewed."

> **The Security Reviewer is advisory, not assurance (threat review S6).** An LLM is an
> unreliable vulnerability scanner (high false-negative rate). A `PASS` means "nothing
> obvious found", **not** "secure". For anything load-bearing, pair it with deterministic
> tools (SAST, dependency and secret scanners) and never present its verdict to a user as a
> guarantee of security or compliance. Same caution applies doubly to a "Compliance/Privacy
> Reviewer" — it must not assert "you are compliant."

---

## The first ten hireable specialists

Ordered roughly by where they sit in a project's lifecycle (research → plan → build →
review → document).

### 1. Product Researcher — `researcher`
Turns a vague request into a grounded brief: target users, competitor patterns, must-have
vs nice-to-have, success criteria. Runs **before** anyone builds.

| tiers | trigger | pos | blocks? | tools | produces |
| ----- | ------- | --- | ------- | ----- | -------- |
| greenfield (opt. feature) | always | **before coder/planner** | no (advisory) | read, **web (read-only fetch proxy)** | `product_brief` artifact |

> Note the unusual position: a researcher runs at the *front* of the graph and its output
> (`product_brief`) becomes an *input* other agents `consume?`. Most templates are
> reviewers that run after the coder; this one inverts that.
>
> **Security (control C1).** The `web` tool resolves to the **read-only (GET-only) fetch
> proxy**, never raw outbound network — so a poisoned page can mislead the brief but cannot
> exfiltrate. Per C1's design law (*privilege XOR untrusted-input*), open-web read is
> **mutually exclusive with write/shell**: this agent has neither, and its `product_brief`
> is a sanitised finding that downstream privileged agents consume — they never read the raw
> web themselves. Any template requesting both open-web-read and write/shell is invalid.

### 2. Architect — `planner`
For greenfield: decomposes the brief into a component/module plan, picks the high-level
approach, and hands the Coder a structured plan instead of a one-line goal.

| tiers | trigger | pos | blocks? | tools | produces |
| ----- | ------- | --- | ------- | ----- | -------- |
| greenfield | always | after research, **before coder** | soft (plan can be revised) | read | `plan` artifact |

### 3. UX Researcher — `reviewer`
(Worked example — see `examples/templates/ux-researcher.agent.yaml`.) Heuristic usability
review against the product's actual users.

| tiers | trigger | pos | blocks? | tools | produces |
| ----- | ------- | --- | ------- | ----- | -------- |
| feature, greenfield | on_artifact (ui) | after coder, before done | soft (advisory→CHANGES_REQUESTED) | read, **browser** | `ux-finding` |

### 4. Accessibility Auditor — `reviewer`
WCAG / a11y review: contrast, keyboard nav, semantics, screen-reader labels.

| tiers | trigger | pos | blocks? | tools | produces |
| ----- | ------- | --- | ------- | ----- | -------- |
| feature, greenfield | on_artifact (ui) | after coder, before done | **hard** for critical a11y (legal/exclusionary), soft otherwise | read, **browser** | `a11y-finding` |

### 5. Performance Engineer — `reviewer`
Checks against performance budgets (latency, bundle size, query cost); flags regressions.

| tiers | trigger | pos | blocks? | tools | produces |
| ----- | ------- | --- | ------- | ----- | -------- |
| feature, greenfield | on_artifact (code/ui) | after coder, before done | **hard** for budget regressions, soft for suggestions | read, run-tests/bench | `perf-finding` |

### 6. Database Specialist — `reviewer`
Reviews schema changes and migrations: indexing, normalisation, migration safety,
injection surface in raw queries.

| tiers | trigger | pos | blocks? | tools | produces |
| ----- | ------- | --- | ------- | ----- | -------- |
| feature, greenfield | on_artifact (schema/migration) | after coder, before done | **hard** for unsafe migrations / data-loss | read | `db-finding` |

> `requires_artifacts: [schema | migration]` — so it stays idle on changes that don't touch
> the data layer. Precise `requires_artifacts` is what stops a big team from running every
> agent on every change.

### 7. API Designer — `reviewer`
Reviews public API/contract surface: consistency, versioning, breaking changes,
over-broad surface.

| tiers | trigger | pos | blocks? | tools | produces |
| ----- | ------- | --- | ------- | ----- | -------- |
| feature, greenfield | on_artifact (api) | after coder, before done | **hard** for breaking changes, soft for style | read | `api-finding` |

### 8. Compliance / Privacy Reviewer — `reviewer`
Flags PII handling, data-retention, consent, and regulatory concerns (GDPR-style).

| tiers | trigger | pos | blocks? | tools | produces |
| ----- | ------- | --- | ------- | ----- | -------- |
| feature, greenfield | on_artifact (code touching user data) | after coder, before done | **hard** for unlawful PII handling | read | `compliance-finding` |

### 9. Documentation Writer — `builder`
Writes/updates docs after a change lands. **Non-blocking** and runs *after* `done`.

| tiers | trigger | pos | blocks? | tools | produces |
| ----- | ------- | --- | ------- | ----- | -------- |
| feature, greenfield | on_artifact (merged change) | **after done** | never (advisory) | read, **write (docs/ only)** | docs |

> The only builder in the list with a *write* grant besides the Coder — and its
> `write_scope` is locked to `docs/**`. It also sits *after* `done`, so it never gates
> shipping. A good example of an agent that is useful without being on the critical path.

### 10. Refactoring Specialist — `builder`
On-demand tech-debt cleanup: extract, rename, de-duplicate — behaviour-preserving.

| tiers | trigger | pos | blocks? | tools | produces |
| ----- | ------- | --- | ------- | ----- | -------- |
| any | **on_request** | standalone | n/a | read, write, run-tests | refactor + passing tests |

> `on_request` only — never auto-fires. You invoke it deliberately ("clean up this
> module"). Its safety net is that the Tester must stay green, so a refactor that changes
> behaviour fails its own gate.

---

## System agent (special)

### Negotiator — `negotiator`
Reconciles conflicting findings. Not hired per-project the same way; it's a system role the
PM dispatches `on_conflict`. Full design in `NEGOTIATOR.md`.

| tiers | trigger | pos | blocks? | tools | produces |
| ----- | ------- | --- | ------- | ----- | -------- |
| all | on_conflict | inserted between conflicting tasks | rules on negotiable conflicts only | read | `negotiation-ruling` |

---

## What the catalog reveals about the contract design

Building ten contracts surfaces the patterns the schema must support:

1. **Position is not just "after coder."** Researchers run at the *front* and emit inputs;
   the Docs Writer runs *after done* and gates nothing. The `graph_position` field needs
   `before`/`after` against both other agents *and* the `done` milestone.
2. **`requires_artifacts` is the noise filter.** A DB Specialist that runs only when a
   migration exists, an a11y Auditor only when there's UI — this is what keeps a 10-agent
   team from running 10 agents on a one-line backend tweak.
3. **`blocks?` is per-finding, not per-agent.** Most reviewers emit *both* hard findings
   (real regressions/violations → `negotiable:false`) and soft ones (suggestions →
   `negotiable:true`). The hard/soft split is what the Negotiator keys off.
4. **`trigger` separates auto from opt-in.** `always`/`on_artifact` agents self-insert;
   `on_request` agents (Refactoring) wait to be called; `on_conflict` (Negotiator) is
   reactive. One field cleanly expresses all three behaviours.

These four observations are the real spec for the routing contract — derived from concrete
agents rather than guessed up front.
