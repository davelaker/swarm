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

- **Negotiator guardrail** (`loop.ts` `firstNonNegotiable`). The Negotiator is fully wired
  (SPAWN_FIX/DOWNGRADE/ABORT on deadlock). The §2 promise — *it can never rule away a
  correctness/safety finding* — is **code-enforced**: a DOWNGRADE targeting a
  `negotiable:false` blocking finding is refused and the run stops for a human. `negotiable`
  is system-derived from the finding schema (`finding.ts`), never self-declared — don't add
  a way for an agent to set it.
