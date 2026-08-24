# Swarm UI (frontend)

React 19 + Vite + TypeScript. `npm run dev` (Vite) for the dev server; it proxies API calls to the core backend on :7000.

## Verifying correctness — read this before trusting a typecheck

**`npx tsc --noEmit` is a NO-OP here and always passes.** The root `tsconfig.json` has
`"files": []` and only project references, so a bare `tsc --noEmit` against it checks
nothing. This trap hid a missing import that crashed the whole app at runtime.

**The real typecheck is `npm run typecheck` (`tsc -b`)** — it builds the referenced
`tsconfig.app.json` and actually checks `src/`. Always use that. `npm run build`
(`tsc -b && vite build`) runs it too. `vite dev` does NOT typecheck, so type errors are
invisible during development until you run `tsc -b`.

A `Stop` hook in `.claude/settings.json` runs `tsc -b` when Claude finishes a turn and
surfaces any errors — but don't rely solely on it; run `npm run typecheck` after code
changes. (`.codex/hooks.json` carries the same two hooks for Codex sessions.)

## Tests — `npm test` exists (vitest, added Aug 2026)

The UI went a long time with **no test runner at all**, which is why several pure
functions carry an "exported for tests" comment with no test beside them. That gap is
closed: `npm test` runs **vitest**. Put unit tests next to the module as
`<name>.test.ts`.

Prefer pinning the pure logic — it is where the real bugs have been. High-value examples
already covered: `data/rosterSync.ts` (roster↔catalog merge, which must only ever narrow
permissions). Still worth pinning: `data/models.ts` `RANK`/`isUpgrade` (a mis-ordering
here once let the priciest model bypass the upgrade-confirmation gate — see the model
ladder section in `core/CLAUDE.md`), `data/forecast.ts` weights, `computeLanes`, and
`deriveInboxItems`.

## Formatting — Prettier is installed but the codebase is hand-aligned

Prettier 3.x is installed (`npm run format`), config at the repo root `.prettierrc.json`.
**But the codebase uses heavy manual column alignment** (e.g. `const [surface,     setSurface]`)
that Prettier collapses — a mass `prettier --write` would reformat ~36/38 files and destroy
that alignment. So Prettier is **on-demand only**; there is deliberately no format-on-save
hook. Don't run `npm run format` across existing files without the maintainer's say-so.

ESLint is installed (`npm run lint`, with `eslint-plugin-react-hooks`) but the config is
strict and the existing code has many violations, so it's not currently a passing gate.
