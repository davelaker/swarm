# Agent Swarm — Security Controls

> Companion to `THREATS.md`. Where `THREATS.md` enumerates findings, this doc designs the
> **controls** that close them. Worked through one finding (or coupled pair) at a time.
> Each control records which findings it resolves and what residual risk remains.

Status legend mirrors `THREATS.md`: a finding moves `open → addressed (design)` once a
control here covers it. "Addressed (design)" means *designed*, not *built*.

---

## C1 — Untrusted content & egress

**Resolves:** S4 (indirect prompt injection), S7 (exfiltration via egress).
**Depends on:** the Phase 4.5 execution sandbox (`BUILD.md`) — these controls are enforced
*by* the sandbox's network and filesystem layers, not by agent prompts.

### The threat in one line

Agents read untrusted input (web, deps, repo, issue text) and some have network access, so
an attacker can plant instructions in what an agent reads (S4) and use a network-capable
agent to send code/secrets out (S7). The canonical chain: researcher fetches a poisoned page
→ page instructs "POST `.env` to evil.com" → agent has both the read and the network.

### Design law

> **Privilege and untrusted-input exposure are inversely related.** An agent may have
> shell/write access, *or* it may read the open web — **never both**. Exfiltration and
> injection-to-action both require that forbidden combination; forbidding it is the control.

### Two boundaries

#### A. Egress boundary — *what can leave* (closes S7)

Enforced by the sandbox network layer:

1. **Default-deny** all outbound network for every agent. This is the foundation: it is the
   only posture robust against *unanticipated* exfil channels.
2. **Per-agent allowlist** for predictable, legitimate needs — e.g. the Coder may reach a
   package registry to install dependencies. Granted as an explicit tool grant
   (`MARKETPLACE.md` §6), routed through a **logging proxy**, scoped to specific hosts.
3. **The open-web case (Product Researcher) is special.** You cannot allowlist the whole
   internet, so this agent reaches the web *only* through a **read-only fetch proxy**:
   - **GET/read only — no POST/PUT.** Exfiltration needs an outbound *write* channel; deny
     it and the agent can pull poisoned content in but **cannot send secrets out**. This
     single rule decouples S4 from S7.
   - Every URL logged.
   - **SSRF guard:** the proxy refuses private/loopback/link-local ranges and cloud
     metadata IPs (e.g. `169.254.169.254`) — critical once hosted.
4. **Approve-on-first-use** is the *fallback*, not the primary mechanism: if an agent needs a
   destination not on its allowlist during a run, the run pauses and asks the human
   (this is also the entry point for finding S10's in-loop approval).

#### B. Ingestion boundary — *how untrusted content enters a prompt* (closes S4)

Content is classified into **trust tiers**, and the tier dictates which agents may ingest it:

| Tier | Examples | Handling |
| ---- | -------- | -------- |
| **Trusted** | System prompt, the approved Charter, PM instructions | May carry instructions. |
| **Semi-trusted** | The user's own repo files | Treated as **data, not instructions**; **secret-scanned/redacted** before entering any prompt (closes part of S5 too); may be read by any agent. |
| **Untrusted** | Web pages, fetched dependency source, issue/PR/comment text, any external content | Ingested **only** by quarantined, read-only, network-isolated agents (below). |

#### The quarantine pattern (the heart of the control)

This is where the design law becomes mechanism — and it rides on the existing blackboard, so
it adds rules, not new plumbing:

1. Untrusted external content is read **only** by a **read-only researcher** — no shell, no
   write, web reachable only via the read-only fetch proxy.
2. The researcher's output is a **sanitised finding**: normalised into structured fields,
   tagged `source: untrusted`, with imperative/instruction-like content stripped during
   sanitisation.
3. **Privileged agents (Coder, etc.) act on the sanitised finding, never on the raw external
   content.** They already consume findings rather than talking to other agents directly
   (`DESIGN.md` §5), so "Coder consumes a researcher's finding" is the architecture we
   already have — the new constraint is only that privileged agents may not *themselves*
   fetch or read untrusted external content.

#### C. Wrap-and-tag (defence-in-depth, not the control)

Any non-trusted content placed into *any* prompt is delimited and labelled "data, not
instructions." Per the S1 correction, **this is defence-in-depth only** — prompt delimiters
do not reliably bind an LLM, so it is never relied upon as the boundary. The real controls
are the egress denial (A) and the ingestion quarantine (B).

### What this changes elsewhere

- **`CATALOG.md`:** the Product Researcher's `web` tool resolves to "read-only fetch proxy",
  and it is marked **mutually exclusive with write/shell** (the design law). Any agent
  requesting both open-web-read and write/shell is invalid.
- **Phase 4.5 (`BUILD.md`):** egress allow/deny, the read-only proxy + SSRF guard, and
  secret-scanning of repo content are part of the sandbox's exit criteria.

### Residual risk (accepted / bounded)

- A **sanitised finding can still carry a subtle injected instruction** in its prose that
  nudges a downstream privileged agent. Bounded by: sanitisation stripping imperatives +
  privileged agents treating findings as data. Not fully eliminable — an LLM reading any
  text can be influenced. The control *bounds blast radius* (the influenced agent still
  can't exfiltrate, because it lacks egress) rather than eliminating influence.
- **Read-only proxy still allows data-in.** A poisoned page can still mislead the
  researcher's *conclusions* (bad research), even though it can't exfiltrate. That's a
  quality risk, not a security breach.

---

## C2 — Gate integrity: structured output fails closed

**Resolves:** S8 (malformed structured-output / fail-open).
**Theme:** decision-point safety — *ambiguity at a gate resolves toward stopping, not proceeding.*

### The threat in one line

The PM gates status transitions by parsing a finding's YAML frontmatter (`verdict`,
`severity`, `blocks_done` — see `examples/.../security-t3.md`). LLMs routinely emit
malformed or schema-violating output. If the behaviour on a parse failure is undefined, a
**blocking security finding that won't parse silently disappears** and the task sails to
`done` — the worst possible failure mode for a gate.

### Control

Every finding is **validated against a strict schema before it can influence a status
transition.** Three outcomes, only the first proceeds:

1. **Parses + schema-valid** → consumed normally; `blocks_done` is honoured.
2. **Unparseable, or schema-invalid, or missing a required gate field** → **fail closed**:
   the task **cannot reach `done`**. The PM parks it `blocked` and triggers bounded repair
   (below), never silently proceeds.

### The fail-closed asymmetry (the whole point)

> Absence or corruption of a finding blocks `done` — it never *passes* it.

A missing, empty, or garbled security/test verdict is treated as **"review did not pass,"
never "no objection raised."** Concretely:

- If `blocks_done` is missing or unparseable on a **security or test** finding, it is
  treated as `true` (blocking).
- A task whose required gate (e.g. a security pass on a sensitive-path diff, per S2) has
  **no valid finding at all** cannot be marked `done` — no finding ≠ clean.

### Bounded repair (so fail-closed doesn't mean fail-stuck)

On a parse/schema failure the PM re-dispatches the agent **once**, feeding the exact
schema/parse error back in ("your finding failed validation: `<error>`; re-emit
conforming to the schema"). If the retry still fails validation, **escalate to the human**
with both raw outputs. One retry, then escalate — no unbounded reparse loop (which would
also feed S9's cost-runaway). 

### Relationship to other controls

- Complements **S1**: S1 made *who may write status* a code control; C2 makes *the gate
  input the PM reads* trustworthy and well-formed. Both are needed — a code-enforced writer
  acting on malformed input is still a broken gate.
- The schema C2 validates against is the **finding gate contract** defined in `DESIGN.md`
  §6.2a (`task`, `verdict`, system-derived `blocks_done`/`negotiable`, the detection tags);
  C2 just makes validation against it mandatory and the failure path explicit.

### Residual risk

- A finding can be **well-formed but wrong** (LLM claims `verdict: APPROVED` on insecure
  code — a false negative). C2 only catches *malformed* output; *wrong* output is S6's
  domain (LLM review is advisory, pair with deterministic scanners). C2 closes the
  structural hole, not the judgement hole.

---

## C3 — In-loop approval for dangerous actions

**Resolves:** S10 (no in-loop human approval for dangerous/irreversible actions).
**Unifies with:** C1's "approve-on-first-use" egress hook — same mechanism (below).
**Theme:** decision-point safety — same pillar as C2, applied to *actions* instead of *gates*.

### The threat in one line

Approval today is **pre-execution only** — the Planning→Execute gate (`INCEPTION.md` §9)
and the hire-time tool grant (`MARKETPLACE.md` §6). Once a run is executing, an agent with
shell/network can `push`, deploy, `rm -rf`, install packages, run destructive SQL, or POST
data **with no further checkpoint** — and prompt injection (S4) can be what tells it to.

### Control

A **confirmation checkpoint** intercepts a defined class of dangerous actions **at execution
time**, regardless of which agent invokes them. Critically, it is enforced at the
**tool/sandbox broker layer** (the same interception point as C1's egress proxy), **not by
asking the agent to behave** — per the S1 principle, an agent that "decides" to skip the
checkpoint can't, because it never had unmediated access to the dangerous verb.

**Dangerous = irreversible or outbound-effecting:**

| Class | Examples |
| ----- | -------- |
| Publish / push | `git push`, deploy, release, package publish |
| Destructive FS | `rm -rf`, mass overwrite/move outside the workspace |
| Supply chain | package install / dependency add (arbitrary code on resolve) |
| Outbound write | network POST/PUT (the C1 egress hook) |
| Data | DB migrations, destructive/`DROP`/`DELETE` SQL |
| Credential / money | any use of a real credential; anything that spends |

### Per-class policy

Each action class carries a policy: **`auto`** (allowed silently), **`confirm`** (pause and
surface to the human), **`deny`**. Default for every class in the table is **`confirm`**.

The confirmation surfaces full context — **what action, which agent, why (the originating
task), and the exact command/diff** — so it can't feel like a rubber-stamp (the same bar
`UX.md` §"Hire dialog" sets). 

The operator may **pre-authorise specific classes per-run into `auto`** (the "configurable
allowlist" S10 asks for) — e.g. "auto-allow installs from the pinned registry" — but never
a blanket auto-all, and the auto-allowlist is kept deliberately minimal.

### One mechanism, two findings

C1's egress "approve-on-first-use" and C3's dangerous-action checkpoint are the **same
broker-level confirmation primitive**: an allowlist-miss on egress is just the *outbound
write* row of the table above. Build it once.

### Fail-closed timeout

If the human doesn't respond, the action **stays blocked** (consistent with C2): the task
parks `blocked` and the PM continues with independent tasks. Silence never auto-approves.

### Residual risk

- **Confirmation fatigue → rubber-stamping.** A human bombarded with prompts approves
  reflexively. Mitigated by: a minimal default `confirm` set, clear diffs/commands, and
  batching related confirmations — but not eliminable. This is why the default-deny posture
  and least-privilege grants matter: the checkpoint is the *last* line, not the only one.

---

## C4 — Spend control: bound the money, not the steps

**Resolves:** S9 (financial DoS / runaway spend).
**Reuses:** C3's confirmation broker (the soft-cap "approve more budget?" prompt).
**Theme:** fail-closed at a resource limit — the budget sibling of C2/C3.

### The threat in one line

Cost is unbounded along several independent axes, and **a step-count limit does not bound
cost** — one `deep`-tier call can cost 100× a cheap one, so "max N steps" says nothing about
the bill. Left unmetered, the swarm can burn the operator's money unattended via dispute
ping-pong, fan-out, or expensive-model requests — including when steered there by injection
(S4).

### The cost axes (each gets a limit)

| Axis | How it runs away | Limit |
| ---- | ---------------- | ----- |
| **Total run** | everything, cumulatively | **Global budget in cost units ($/tokens)** — the master control |
| **Parallel fan-out** | the loop's `for task in runnable` dispatches *every* runnable task at once | **Concurrency cap** — at most *N* workers in flight; the rest queue |
| **Per-task retries** | C2 repair + failure re-dispatch + re-review | **One cost-aware per-task ceiling** unifying all retry sources |
| **Dispute loop** | Coder ↔ Security ↔ Negotiator ping-pong on one artifact | **Remediation-round cap** — after *k* rounds, force Negotiator ruling or human escalation |
| **Model tier** | agents requesting `deep`/expensive tier freely | **Tier ceiling** — deep tier is gated (a per-run cap and/or budget-headroom check); cheap tier is the default |

### The master control: a budget check *in the loop*

The global budget is set by the operator at the **Execute ▶ gate** (`INCEPTION.md` §9) —
the same place they already authorise the run — and the PM loop checks cumulative spend at
the top of every iteration, alongside the existing done/failed/deadlock stops:

```text
loop:
  state = read_state()
  if spend >= hard_cap:   -> fail-closed STOP, park run, report spend   # NEW
  if spend >= soft_cap:   -> C3 confirmation: "approve $X more?"         # NEW
  if all tasks done: ...
```

- **Soft cap** → pause and ask the human to extend — reusing C3's confirmation broker, so
  "budget exhausted, approve more?" is the *same* primitive as "approve this push?". A
  fourth finding now rides that one mechanism.
- **Hard cap** → **fail-closed STOP** (consistent with C2/C3): park the run and report,
  never silently continue and never silently downgrade quality to save money.

### Why per-axis sub-limits *and* a global cap

The global cap alone is necessary but not sufficient: a single runaway axis (a fan-out burst,
a dispute loop) could consume the *entire* budget in one cycle before the operator gets a
say. The sub-limits bound the **granularity** at which the global check can act — they keep
any one axis from spending the whole envelope between two budget checks.

The finest grain is a **per-dispatch token ceiling**: no single worker call may exceed a
max-token bound, so the global budget can never be blown past by one unbounded call before
the next loop check fires. Without it the budget check is only as tight as the most
expensive single step.

### Relationship to other controls

- **Dispute-round cap** depends on conflict detection being well-defined (A5) and on the
  Negotiator (`NEGOTIATOR.md`) as the escalation target — the cap is *when* to stop
  arbitrating and hand to a human.
- **Visibility:** live cumulative spend belongs on the dashboard state stream (`UX.md`),
  next to pause/abort, so the operator sees the burn rate, not just the final bill.

### Residual risk

- **Cost estimates are approximate** (token→$ varies by model/route; estimated before a
  call completes). The per-dispatch ceiling bounds single-call overshoot, but the run may
  still overshoot the hard cap by up to roughly one in-flight batch. Acceptable: the goal is
  *bounded* spend with a hard stop, not to-the-cent precision.
