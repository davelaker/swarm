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
