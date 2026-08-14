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

## Reasoning effort (`agents/effort.ts`)

Per-task `effort` (low|medium|high|xhigh|max) rides alongside `model`. Two API rules are
enforced there, centrally, and unit-tested — do not re-implement them at call sites:

- **Haiku 4.5 does not support `effort` at all** and errors if sent it. `effortForModel`
  returns undefined for haiku so the field is omitted.
- **`xhigh` only exists on Opus 4.7+ / Sonnet 5 / Fable 5.** Requests for it on older
  models are clamped to `high`.

Unset/unrecognised effort → undefined → field omitted → model default. Keeping that path
untouched is what makes the feature safe to add without a live run.
