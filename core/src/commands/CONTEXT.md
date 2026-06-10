<!-- swarm:context — read this file before modifying anything in this directory, then update it after -->
# Context: core/src/commands/
*Last updated: 2026-06-09 · by coder · task swarm-status*

## Purpose
CLI entry-point handlers; each file exports a single `run<Name>()` function invoked by `core/src/index.ts`.

## Key files
- `init.ts` — `runInit()`: scaffolds `.swarm/` directory, `team.config.yaml`, `state.json`, and `PROJECT.md` in the current working directory
- `check.ts` — `runCheck()`: Phase 0 exit-criteria test; verifies all four seams (config, state repo, dispatch, event bus) without real API calls
- `new.ts` — `runNew(goal, charter?, team?)`: classifies goal, builds task graph, runs the PM loop end-to-end
- `status.ts` — `runStatus()`: read-only snapshot of `.swarm/state.json`; prints project header and task table; gracefully handles missing state file or finding files

## Conventions
- All handlers are named exports (`runXxx`), never default exports
- Synchronous handlers return `void`; async handlers return `Promise<void>`
- Console output uses two-space indent (`  label: value`) to match the rest of the CLI
- `process.exitCode = 1` for errors; `process.exit()` only used in `new.ts` for CLI-only invocation
- Handlers must not import each other — they are peers wired up in `index.ts`

## Recent changes
- swarm-status (2026-06-09): added `status.ts` — read-only terminal snapshot command
- t_fix_t3/t_fix_t4 (2026-06-09): `status.ts` — show real per-task and total cost from `Task.cost_usd`; truncate long goal lines; remove dead `|| '-'` on required field; `isWithinDir()` path-traversal guard; added `cost_usd?` to `Task` type (types.ts) and persist it in loop.ts
- t_fix_t_chk_t4 (2026-06-09): `status.ts` — use `sf` variable in error message instead of hardcoded path; extract `candidatePath` to eliminate double `path.join()` call in path-traversal guard
- t_fix_t_chk_t_chk_t4 (2026-06-09): `status.ts` — replace Unicode ellipsis `…` with ASCII `...` in `truncate()`; adjust slice offset from `maxLen-1` to `maxLen-3` to preserve correct truncated length
