# Multi-provider routing plan

This is the living execution plan for evolving Swarm from its current Claude-only
runtime into a local, multi-provider swarm. It is intentionally divided into
small, independently verifiable subtasks so each implementation agent receives
only the context and files it needs.

## Outcome

A single Swarm run can assign different agents to Claude or Codex/GPT on a
per-task basis. A transparent router recommends the provider, concrete model,
and reasoning effort that best fit each task; the user can override a
recommendation before work starts. Independent tasks may run concurrently in
separate worktrees, while conflicting writes remain serialised.

The initial routing policy is:

| Work type | Preferred route | Fallback |
| --- | --- | --- |
| Large planning, architecture, or ambiguous decomposition | Anthropic frontier planning model (Fable, then Opus) | OpenAI frontier reasoning model |
| Large, risky, or multi-file coding | Opus | Codex/GPT with high reasoning |
| Small, contained execution task | Codex/GPT with low or medium reasoning | Sonnet |
| Deterministic validation | No model; run checks directly | — |
| High-stakes code review | A provider different from the implementation agent where available | Strongest available provider |

Concrete model IDs must be resolved from a provider capability catalog at run
time. Never encode a changing product name such as “Opus 5” in routing logic.

## Non-negotiable rules

- Do not read, print, commit, or transmit API keys, login tokens, or `.env`
  values. Authentication detection may report only availability and provider
  identity.
- The router may recommend and the user may override; it must not silently
  upgrade a task to a higher-cost tier.
- A task's route is immutable once that task starts. Retries use the recorded
  route unless a user-approved fallback is required.
- Providers never bypass the existing permission broker, worktree isolation,
  approval gates, or deterministic checks.
- Parallel write tasks require disjoint declared write scopes. Unknown or
  overlapping scope means serial execution.
- Every implementation subtask must add focused tests and run the narrowest
  useful verification command before committing.

## Target data flow

```text
PM task graph → capability discovery → route recommendation → user confirmation
      ↓                    ↓                    ↓                      ↓
  task intent        available models       route per task         immutable plan
      └──────────────────────────────────────┬──────────────────────────┘
                                             ↓
                          worktree-aware multi-provider scheduler
                                             ↓
                              gates, review, outcome telemetry
```

## Small-agent execution backlog

Each subtask is a self-contained agent brief. Give an agent only its listed
files, the relevant interfaces, and this document's non-negotiable rules. Do
not combine parallel tasks that edit the same files.

### MP-01 — Freeze the current baseline

- **Depends on:** none
- **Files/context:** `core/src/drivers/types.ts`, `core/src/drivers/index.ts`,
  `core/src/config.ts`, existing driver tests.
- **Change:** document the exact current driver contract and add tests that
  pin Claude driver selection behaviour before extending it.
- **Done when:** tests cover explicit driver selection, missing authentication,
  and the existing auto-detection precedence; no production behaviour changes.
- **Agent context limit:** driver factory and config only.

### MP-02 — Provider capability catalog

- **Depends on:** MP-01
- **Files/context:** new `core/src/providers/*`, `core/src/state/builtin-models.ts`,
  model-related tests.
- **Change:** introduce provider-neutral model metadata: provider, model ID,
  tier, supported reasoning levels, coding/planning/review capabilities,
  subscription/API auth mode, and a stable display label.
- **Done when:** Claude and Codex/GPT records can be queried without importing a
  provider SDK; unknown models fail validation with an actionable error.
- **Agent context limit:** new catalog plus built-in model storage only.

### MP-03 — Capability discovery and configuration

- **Depends on:** MP-02
- **Files/context:** `core/src/config.ts`, `core/src/drivers/index.ts`, new
  provider-discovery module, driver factory tests.
- **Change:** detect available Claude and Codex installations without inspecting
  credentials; add explicit configuration for enabled providers and default
  provider policy. Preserve the current environment-variable configuration as a
  backwards-compatible input.
- **Done when:** startup reports only safe availability metadata, an explicit
  unavailable provider fails closed, and auto-detection has deterministic
  precedence.
- **Agent context limit:** config, discovery, driver factory, tests.

### MP-04 — Codex CLI proof-of-contract

- **Depends on:** MP-03
- **Files/context:** a temporary test fixture and a new Codex runner module;
  do not change the scheduler or UI.
- **Change:** prove that `codex exec` can run in a supplied worktree, produce
  machine-readable events, enforce a JSON output schema, and use Swarm's
  required MCP/permission integration without globally mutating user Codex
  configuration.
- **Done when:** a read-only smoke test and a tightly scoped fixture write test
  pass locally; the test cleans up its fixture; limitations are recorded here.
- **Agent context limit:** Codex runner and fixture only.
- **Stop condition:** if ephemeral per-run MCP configuration cannot be made
  safe, stop and record the constraint before implementing the driver.

### MP-05 — Codex agent driver

- **Depends on:** MP-04
- **Files/context:** `core/src/drivers/types.ts`, the new runner, result and
  progress interfaces, driver tests.
- **Change:** implement `codexDriver` using the approved broker-mediated patch
  boundary. Codex runs read-only for all work; mutating coder work returns a
  structured patch proposal which Swarm validates and applies through its
  permission broker. Implement coder, tester, security, reviewer, Scout,
  negotiator, specialist research, scribe, document scribe, and live context.
  Convert structured outputs into the existing `AgentDriver` result contract.
- **Done when:** contract tests pass for each method, patch scope/base-revision
  validation rejects unsafe changes, JSON/schema failures are actionable, and
  the driver never widens write or connector permissions.
- **Agent context limit:** driver boundary, runner, result/progress types.

#### MP-05a — Broker-mediated patch proposal and application

- **Depends on:** MP-04
- **Files/context:** Codex runner, permission broker, worktree/path guards, and
  new focused patch-proposal tests.
- **Change:** define a schema-constrained unified-patch proposal with base
  revision and declared changed paths. Validate the base revision and write
  scope, then apply only validated patches through Swarm-owned code.
- **Done when:** malformed, out-of-scope, stale-base, binary, and unsafe-path
  proposals are rejected; a valid fixture patch is applied exactly once.
- **Agent context limit:** patch validator/applier plus existing path guards.

#### MP-05b — Read-only Codex driver methods

- **Depends on:** MP-05a
- **Files/context:** `AgentDriver`, Codex runner, result/progress interfaces,
  and driver contract tests.
- **Change:** implement Codex methods using read-only execution; coder returns
  a validated patch proposal to MP-05a, while non-coder roles return structured
  findings or research.
- **Done when:** all driver methods satisfy the existing contract without
  granting Codex native repository write permission.
- **Agent context limit:** driver boundary, runner, result/progress types.

### MP-06 — Make PM execution driver-neutral

- **Depends on:** MP-05
- **Files/context:** `core/src/pm/index.ts`, `core/src/drivers/types.ts`, PM
  tests and MCP response schema.
- **Change:** move PM inference behind a driver method so planning works through
  Claude, Codex, or a future API driver. Preserve the existing research loop and
  PM response contract.
- **Done when:** PM tests run against a fake driver; both real provider paths
  produce the same validated `PmResponse` shape.
- **Agent context limit:** PM module and driver interface only.

### MP-07 — Per-task route schema and validation

- **Depends on:** MP-02, MP-06
- **Files/context:** `core/src/state/types.ts`, task creation/validation,
  dispatch, state tests.
- **Change:** add an immutable `route` to each task:
  `provider`, `model`, `reasoningEffort`, `rationale`, `fallback`, and
  `requiresConfirmation`. Validate capability availability before dispatch.
- **Done when:** a task cannot start with an unavailable model, incompatible
  effort level, or unauthorised provider; existing persisted task state migrates
  safely.
- **Agent context limit:** task/state/dispatch interfaces and tests.

### MP-08 — Deterministic route recommender

- **Depends on:** MP-07
- **Files/context:** new pure `core/src/routing/*` modules and unit tests.
- **Change:** implement a pure scoring policy based on task intent, scope,
  risk, write access, dependencies, provider availability, budget class, and
  desired reviewer diversity. Encode the initial policy table above as defaults.
- **Done when:** table-driven tests demonstrate large planning → Fable/Opus,
  large coding → Opus, small execution → Codex/GPT, and deterministic checks →
  no model; every decision includes a rationale and fallback.
- **Agent context limit:** routing inputs/outputs and test fixtures only.

### MP-09 — PM recommendation integration

- **Depends on:** MP-08
- **Files/context:** PM task graph assembly, route recommender, task validation,
  PM tests.
- **Change:** let the PM describe task intent and optional preference, then run
  the deterministic recommender to produce the authoritative route. The PM must
  not invent unsupported concrete model IDs.
- **Done when:** plans contain a route for every LLM task, unsupported PM choices
  are corrected with an explanation, and no cost upgrade is auto-approved.
- **Agent context limit:** PM assembly and routing adapter only.

### MP-10 — Heterogeneous scheduler safety

- **Depends on:** MP-07
- **Files/context:** `core/src/loop.ts`, worktree helpers, scheduler tests.
- **Change:** schedule independent tasks across providers concurrently while
  enforcing write-scope conflict detection and existing gate dependencies.
- **Done when:** tests prove disjoint tasks can run in parallel, overlapping
  writes serialize, and review/gate tasks wait for all relevant producers.
- **Agent context limit:** scheduler and worktree code only.

### MP-11 — Routing controls in the local UX

- **Depends on:** MP-03, MP-07, MP-09
- **Files/context:** server route endpoints, `ui/src/components/planning/*`,
  `ui/src/data/models.ts`, relevant UI tests.
- **Change:** show detected providers, per-task recommendation, rationale,
  effort, fallback, and cost-class warning. Provide user overrides before
  execution; lock routes after task start.
- **Done when:** a user can understand why each model was selected, select an
  available alternative, and cannot select an unavailable or incompatible route.
- **Agent context limit:** planning UI, API payload types, provider catalog.

### MP-12 — Outcome telemetry and evaluation harness

- **Depends on:** MP-05, MP-08, MP-10
- **Files/context:** event/state persistence, evaluation harness, routing tests.
- **Change:** record safe outcome signals—route, duration, retries, verdicts,
  gate findings, and cost/quota class—and add representative routing evaluations.
  Do not persist prompts, credentials, or raw provider session logs beyond
  existing approved artifacts.
- **Done when:** routing policy changes can be evaluated against fixtures before
  release; aggregate data can inform recommendations without silently changing
  policy.
- **Agent context limit:** telemetry/eval modules and synthetic fixtures only.

### MP-13 — Documentation and release verification

- **Depends on:** MP-01 through MP-12
- **Files/context:** `README.md`, `docs/README.md`, `docs/DESIGN.md`,
  `docs/BUILD.md`, configuration reference, end-to-end test script.
- **Change:** document setup for both subscriptions, the routing policy,
  override behaviour, privacy boundaries, and known limitations.
- **Done when:** clean-machine setup instructions are copy-pasteable; unit,
  type, UI, and two-provider smoke checks pass; this plan records the final
  verification evidence and remaining limitations.
- **Agent context limit:** documentation plus verification commands only.

## Execution order and parallelism

```text
MP-01 → MP-02 → MP-03 → MP-04 → MP-05 → MP-06 → MP-07 → MP-08 → MP-09
                                                └────────→ MP-10
MP-03 + MP-07 + MP-09 ───────────────────────────────────→ MP-11
MP-05 + MP-08 + MP-10 ───────────────────────────────────→ MP-12
MP-01…MP-12 ──────────────────────────────────────────────→ MP-13
```

MP-10 and MP-11 may run in parallel once their dependencies are complete. All
other items are deliberately narrow and sequential where they share core
interfaces.

## Decision log

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-08-21 | Route models per task, not per run. | A swarm needs heterogeneous agents and independent review. |
| 2026-08-21 | Use a deterministic router with transparent rationale. | Keeps cost, safety, and policy under user control. |
| 2026-08-21 | Add Codex CLI before an OpenAI API driver. | Reuses the user's existing local Codex authentication and preserves local-agent semantics. |
| 2026-08-21 | Keep strict broker enforcement; approve a read-only Codex patch-proposal boundary. | Codex receives no native repository write permission. Swarm validates and applies structured patches through its broker, which is stronger than post-run diff inspection while remaining practical for small GPT execution tasks. Native Codex writes remain deferred until an OS-enforced, path-restricted container/VM boundary is proven. |

## Living status

Update this section as each item lands. Include commit hash, verification command
and result, and any changed assumptions.

| Subtask | Status | Commit / evidence | Notes |
| --- | --- | --- | --- |
| MP-01 | Complete | `d94b799`; TypeScript typecheck and 4 focused driver/config tests pass | Baseline selection behaviour is now pinned by pure selection tests. |
| MP-02 | Complete | `5ea9f05`; `npm run typecheck`, focused catalog tests, and 104-test suite pass | Provider-neutral Claude and OpenAI/Codex capability metadata established. |
| MP-03 | Complete | `825fa4c`; TypeScript typecheck and 109-test suite pass | Safe Claude/Codex capability discovery and provider configuration added; Codex selection intentionally fails closed pending its driver. |
| MP-04 | Complete (native write rejected) | `0a89601`; typecheck, 112-test suite, and two real Codex fixture smokes pass | Transport is proven; native Codex write mode is rejected. The approved read-only patch-proposal boundary unblocks MP-05. See `CODEX_RUNNER_SPIKE.md`. |
| MP-05 | Complete | MP-05a: `2ba77b7`; MP-05b: `e319a67`; typecheck and 119-test suite pass | Codex is strictly read-only; Swarm validates and applies coder patches. It fails closed until MP-07 supplies declared task write scopes. |
| MP-06 | Complete | `8b3fdbc`; TypeScript typecheck and 122-test suite pass | PM inference is provider-neutral across Claude API/CLI and read-only Codex; shared parsing and research loop remain intact. |
| MP-07 | Complete | `07097f3`; typecheck and 131-test suite pass | Immutable validated task routes and declared write scopes added; legacy tasks remain compatible but Codex mutation fails closed without a scope. |
| MP-08 | Complete | `dfbd22d`; focused routing tests plus restored full 138-test suite and typecheck pass | Pure deterministic policy recommends model/provider, rationale, fallback, confirmation, and reviewer diversity. |
| MP-09 | Complete | `a6fee06`; typecheck and 148-test suite pass | PM intent/preferences now feed the deterministic router; every LLM task receives a validated route and Codex-compatible write scope. |
| MP-10 | Complete | `6160d0d`; focused scheduler tests and restored full 138-test suite/typecheck pass | Disjoint declared write scopes may run concurrently across providers; unknown or conflicting writer scopes serialize. |
| MP-11 | Complete | `8092225`; UI typecheck/build, focused UI tests, core typecheck, and server validation tests pass | Planning UX displays availability and transparent recommendations; compatible overrides are selectable before execution and routes lock after start. |
| MP-12 | Complete | `d29e30a`; typecheck and 144-test suite pass | Safe allow-listed route/outcome telemetry and synthetic routing evaluations added; no prompts, credentials, raw logs, or findings are persisted. |
| MP-13 | Not started | — | — |
