# Code review — pre-push diff review with PM-coordinated fixes

A delightful, GitHub-quality review surface for the changes a run produced, **before
you push**. Syntax-highlighted diffs, clear add/old/deleted distinction, inline
comments, and a fix loop where either the PM coordinates fixes or a coder applies
them directly — then the diff refreshes so you re-review in place.

## Why

After a run completes you want to actually *read* the change, not trust a verdict.
The old surface rendered a flat, monochrome diff (diff2html) with a fragile
DOM-query comment bolt-on, and "request changes" threw away the comment structure
and bounced you out to Planning. This makes the review the centrepiece of the
"trust before you ship" story.

## Decisions (chosen 2026-06)

- **Diff + highlighting → Shiki, custom render.** We own the render (no
  `dangerouslySetInnerHTML`), tokenize whole files for multi-line-correct
  highlighting, and compose Shiki token colors with our own add/del row tints.
- **Fix flow → both.** PM-coordinated by default (it triages, can push back / ask
  clarifying questions, plans coder+reviewer); plus a one-click fast path that
  turns your comments into a finding and spawns an in-place fix coder directly.

## Architecture

### Phase 1 — structured diff + Shiki render
- `GET /run/diff/structured` returns, per changed file:
  `{ path, oldPath, status, language, additions, deletions, oldContent, newContent, hunks[] }`.
  Reuses the existing diff-range resolution (worktree vs `main...HEAD` vs `HEAD~1`).
- `core/src/server/diff.ts`: pure `parseUnifiedDiff` (files → hunks → lines) +
  `detectLanguage`, both unit-tested. Content is fetched via `git show` / disk and
  size-guarded.
- UI: a Shiki highlighter singleton (lazy, one theme, only the languages present),
  a custom `DiffView` rendering gutters (old/new line no.), per-row add/del/context
  classes, per-file headers with `+N/−M` and collapse, collapse-unchanged regions.

### Phase 2 — sturdy comment layer
- `ReviewComment { id, file, side, startLine, endLine, body, status, replies[] }`
  anchored to the structured model (not the DOM). Multi-line gutter selection,
  inline thread rows between diff lines, draft-review batching.
- Persisted at `.swarm/review/<run>.json` so it survives reload and agents can read
  precise `file:line + body`.

### Phase 3 — fix loop
- `POST /run/review { comments, mode: 'pm' | 'fast' }`.
  - `pm`: writes a `user-review` finding, runs a scoped PM turn seeded with the
    comments + diff → fix task graph → execute.
  - `fast`: writes the finding and routes straight through the existing remediation
    path (in-place fix coder + re-review).
- Comment status flows over SSE (`draft → submitted → planned → fixing → resolved`);
  the diff auto-refreshes when a fix lands.
