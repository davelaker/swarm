# Agent Swarm — Threat Model & Finding Register

> Companion to the design corpus. Produced by an adversarial review of the *design* (no
> code exists yet). Captures the trust model, the attack surfaces, and a register of
> findings with severities and the design responses. Living document — update as the
> design and (eventually) the code change.

---

## 1. Why this document exists

The corpus repeatedly described **prompt instructions and conventions as if they were
enforced controls** ("hard guardrail", "only the PM writes status", "guardrails sit after
the overlay so it can't override them"). An adversary doesn't respect a prompt. This doc
re-states what is actually enforceable, what is merely requested, and what must change
before any code is written.

**The one-line takeaway:** *an LLM following an instruction is not a security boundary.*
Wherever the design's safety depends on an agent choosing to behave, assume it can be made
not to.

---

## 2. Trust model & boundaries

### Trust zones

| Zone | Contains | Trusted? |
| ---- | -------- | -------- |
| **The human** | The operator | Trusted (the only fully-trusted actor) |
| **The orchestrator (PM)** | The control loop + state repository | Trusted *core*, but LLM-driven → can be steered by injected content |
| **First-party agents** | Built-in Coder/Tester/Security | Semi-trusted; still LLM, still read untrusted input |
| **Marketplace agents** | Third-party templates | **Untrusted** (prompts + tool requests authored by others) |
| **The codebase / repo** | User's files, deps, `.env`, configs | **Untrusted input** to agents (may carry injection; contains secrets) |
| **External content** | Web pages, package registries, issue text | **Untrusted input** |
| **The dashboard client** | The local browser UI | A network surface; reachable by any local process / browser tab |

### Key insight about the boundaries

The design's comfort comes from "single trust domain, local, full filesystem access." But
within that domain sit **untrusted prompts (marketplace), untrusted input (repo + web), and
LLM actors that can be steered by both.** Collapsing all of that into one trust zone with
shell access on the operator's machine is the root of most findings below.

---

## 3. Assets to protect

1. The operator's machine and ambient credentials (SSH keys, cloud creds, other repos).
2. The user's **project secrets** (`.env`, tokens, hardcoded credentials in the repo).
3. Source code confidentiality (exfiltration).
4. Integrity of the build (no backdoors / malicious deps introduced by an agent).
5. The operator's money (token spend).
6. (Future, multi-tenant) cross-tenant isolation of state, code, and secrets.

---

## 4. Adversaries

- **Malicious template author** — publishes a useful-looking agent with a hidden payload in
  its base prompt; waits to be hired with the tools its role legitimately needs.
- **Compromised-update attacker** — takes over a popular template and ships a bad version.
- **Indirect-injection attacker** — plants instructions in content an agent will read (a
  README, a dependency, a web page, an issue, a code comment).
- **Drive-by web page** — any site the operator visits, attacking the local dashboard via
  CSRF / DNS-rebinding.
- **Curious/malicious co-tenant** (future hosted) — tries to read another tenant's state.
- **The system itself** — runaway loops burning money; false assurance from an LLM gate.

---

## 5. Finding register

Severity: **CRITICAL** (fix before building the relevant phase) · **HIGH** · **MEDIUM** ·
**LOW/PROCESS**. Status: `open` (design not yet corrected) / `addressed` (design corrected
in this pass) / `accepted` (residual risk acknowledged).

### CRITICAL

| ID | Finding | Design response | Status |
| -- | ------- | --------------- | ------ |
| **S0** | **Marketplace (P5) ships before isolation (P6).** Hiring a shell/write-capable third-party agent = arbitrary code execution on the operator's machine, with maximum blast radius in exactly the "trusted" local case. | **Isolation is now a prerequisite for the marketplace** (new Phase 4.5 in `BUILD.md`). No third-party or shell/write agent runs un-sandboxed. | addressed |
| **S1** | **"Hard" guarantees are LLM/convention-enforced, not code-enforced** — `only PM writes status`, the Negotiator safety guardrail, `negotiable` flag, overlay-after-guardrails. | Re-specified as **code controls**: repository rejects `status` writes from non-PM actors; `negotiable` is **derived by the system from finding type/source**, never self-declared; prompt-ordering is no longer described as a boundary. (`DESIGN.md` §5.3, `NEGOTIATOR.md` §2, `MARKETPLACE.md` §4.) | addressed |
| **S2** | **Tier classifier is a security bypass** — an LLM mislabelling a sensitive change as a "tweak" skips security review. | **Sensitive-path escalation rule**: any diff touching auth/crypto/permissions/input-handling/SQL is force-escalated and always gets a security pass, regardless of size. (`CATALOG.md`.) | addressed |
| **S3** | **localhost dashboard is unauthenticated** — CSRF / DNS-rebinding lets any web page drive the PM; SSE leaks full state. | Loopback-only bind, per-session token, `Origin`/`Host` enforcement from Phase 3. (`UX.md` §3.) | addressed |

### HIGH

| ID | Finding | Design response | Status |
| -- | ------- | --------------- | ------ |
| **S4** | **Indirect prompt injection unaddressed** — web/repo/dep/issue content can carry instructions. | **Control C1** (`CONTROLS.md`): ingestion trust-tiers + quarantine pattern — untrusted external content read only by isolated read-only agents that emit sanitised findings; privileged agents never read raw external content (design law: privilege XOR untrusted-input). | addressed (design) |
| **S5** | **"Secrets boundary" protects the wrong thing** — it governs the swarm's API keys, not the user's project secrets, which any shell/FS-read agent can read directly. | Distinguish *swarm credentials* from *project secrets*; the latter needs sandboxing + **secret-scanning/redaction of repo content** (now part of C1) + the sandbox. (`MARKETPLACE.md` §6, `DESIGN.md` §8 P4, `CONTROLS.md` C1.) | addressed (reframed + partial control) |
| **S6** | **LLM Security Reviewer creates false assurance** — high false-negative rate, yet sold as "security enforced structurally". Worse than no gate if trusted. | Reframed as **advisory triage, not assurance**; must be paired with deterministic tools (SAST, dep/secret scanners) for anything load-bearing. (`DESIGN.md`, `CATALOG.md`.) | addressed (reframed) |
| **S7** | **Exfiltration via network-capable agents** — read-repo + network tool = one-step exfil. | **Control C1** (`CONTROLS.md`): default-deny egress + per-agent allowlist via logging proxy; the open-web researcher gets a **read-only (GET-only) fetch proxy** so it cannot POST data out; SSRF guard. | addressed (design) |

### MEDIUM

| ID | Finding | Design response | Status |
| -- | ------- | --------------- | ------ |
| **S8** | **Malformed structured-output / fail-open** — PM parses YAML frontmatter to gate; LLMs emit malformed output; behaviour on parse failure undefined. | **Control C2** (`CONTROLS.md`): strict schema validation before any status transition; unparseable/invalid/missing gate field **fails closed** (absence ≠ clean); bounded one-retry repair then escalate. | addressed (design) |
| **S9** | **Financial DoS** — dispute ping-pong, unbounded parallel fan-out, `deep`-model requests can burn money unattended. | **Control C4** (`CONTROLS.md`): global budget in **cost units (not step count)** checked in the PM loop, fail-closed at a hard cap; per-axis sub-limits (fan-out concurrency cap, per-task retry ceiling, dispute-round cap, model-tier ceiling, per-dispatch token bound); soft cap reuses C3's confirmation broker. | addressed (design) |
| **S10** | **No in-loop human approval for dangerous actions** — approval gate is pre-execution only; agents can push/deploy/`rm`/install mid-run. | **Control C3** (`CONTROLS.md`): broker-level confirmation checkpoint for irreversible/outbound action classes (default `confirm`), enforced at the tool/sandbox layer not by the agent; per-run `auto` allowlist; fail-closed on timeout. Unifies with C1's approve-on-first-use egress hook (one primitive). | addressed (design) |
| **S11** | **`owner`-as-a-field is a future IDOR** — a constant today means no query filters by it; multi-tenant turns every unfiltered query into a cross-tenant leak. | **Design intent spec'd in `DESIGN.md` Principle 1 (S11 caveat)**: the field is the data habit, *not* the control; P6 requires store-enforced isolation (RLS — unfiltered query returns nothing, not everything) + cross-tenant isolation tests as a P6 exit criterion. | deferred (P6), intent spec'd |

### Architectural / correctness

| ID | Finding | Design response | Status |
| -- | ------- | --------------- | ------ |
| **A1** | **Crash recovery asserted, not designed** — orphaned `in_progress` tasks, no leases/heartbeats/idempotency. | **Designed in `DESIGN.md` §6.4**: task `lease` + heartbeat to detect a dead worker; `reconcile()` at top of loop reclaims expired-lease tasks (kills the phantom-deadlock); idempotent dispatch (id-addressed artifacts, `(task_id, attempt)` idempotency key protecting C3 actions, adopt-valid-result via C2); crash-atomic state writes; bounded by attempt/C4 budget. | addressed (design) |
| **A2** | **PM is a bottleneck / SPOF** — single-threaded sole writer. | Accepted at current scale; revisit if graphs grow. | accepted |
| **A3** | **Charter is a single point of distortion** — LLM-generated, injected into every agent; an error propagates everywhere; grows context/cost. | **Designed in `INCEPTION.md` §5.1**: (1) provenance check — every charter claim traceable to the conversation, ungrounded content flagged at the human approval gate (catches planning-time S4 injection before it propagates); (2) scoped injection — each agent gets the invariant core + its role slice, not the whole charter (bounds blast radius + cost/C4). | addressed (design) |
| **A4** | **Core hypothesis never measured** — "multi-agent > single agent" is asserted; literature is mixed. | **Add an eval harness in Phase 1** comparing swarm vs single-agent on defined quality metrics, before building the upper floors. (`BUILD.md` Phase 1.) | addressed |
| **A5** | **Conflict detection underspecified** — semantic contradiction between free-text findings is itself a hard LLM task. | **Redesigned in `NEGOTIATOR.md` §3**: split detect (PM, cheap/structured) from adjudicate (Negotiator, semantic). PM raises *candidates* from structured fields only — `disputes`/`cannot_satisfy` tags + co-`blocks_done` on overlapping `task`/`location` (finding gate contract, DESIGN §6.2a) — never prose comparison; over-flagging is fine, the C2 gate guarantees a missed conflict can't reach `done`. | addressed (design) |

### Process

| ID | Finding | Design response | Status |
| -- | ------- | --------------- | ------ |
| **P1** | **"Security/Compliance Reviewer" agents are false-assurance & liability surfaces** (esp. GDPR). | Frame explicitly as "not a substitute for professional review"; no "you are compliant/secure" assertions in product copy. | addressed (framing) |
| **P2** | **IP hygiene** — design for a standalone product committed into an unrelated private repo. | Move to its own repo before code (it's literally Phase 0). | open |

---

## 6. The three changes to make before any code

1. **Sandbox-before-marketplace** (S0) — isolation gates third-party/shell agents.
2. **Demote every "guarantee" to its real strength** (S1, S5, S6) — code-enforce what can
   be; stop calling prompts and LLM-compliance boundaries; reframe LLM review as advisory.
3. **Add an eval harness in Phase 1** (A4) — measure the core premise before building on it.

---

## 6a. Status of the review pass

Every CRITICAL, HIGH, and MEDIUM security finding and every live architectural finding now
has a **designed** response (not yet built — "addressed (design)"):

- **Controls C1–C4** (`CONTROLS.md`): untrusted-content & egress (S4, S7); gate fail-closed
  (S8); in-loop approval (S10); spend control (S9). Four findings share C3's confirmation
  broker; the suite is unified by *fail-closed at every decision point*.
- **Inline design fixes:** crash recovery (A1, `DESIGN.md` §6.4); conflict detection (A5,
  `NEGOTIATOR.md` §3); charter distortion (A3, `INCEPTION.md` §5.1); tenancy-isolation
  intent (S11, `DESIGN.md` Principle 1).
- **Earlier in this pass:** S0–S3, S5, S6, A4, P1.

**Still genuinely open:** **P2** (relocate to its own repo — a Phase 0 *action*, not a design
question) and **S11** (deferred to P6, but its design intent is now spec'd). Nothing else.

---

## 7. Residual / accepted risks

- **A2** (PM as SPOF/bottleneck) — accepted at single-user scale.
- **The fundamental one:** the orchestrator and every agent are LLMs reading untrusted
  input. No amount of structure fully eliminates prompt injection or hallucinated
  judgement. The design's job is to **bound blast radius** (sandboxing, least privilege,
  deterministic gates, fail-closed, human checkpoints) — not to pretend the LLMs are
  trustworthy. The controls above bound; they do not cure. The residual that remains after
  every control is the irreducible one: a well-formed but *wrong* LLM judgement
  (e.g. C2 passes a finding the reviewer got wrong — S6's domain). That is managed by
  defence-in-depth and deterministic tooling, never "solved."
