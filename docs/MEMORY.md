# The Memory Layer — living docs, agent memory, and recall

> Design record for Swarm's institutional-memory features (August 2026), added after the
> Xirp research (see [COMPETITORS.md](COMPETITORS.md) → "Competitor — Xirp"). Covers the
> delineation between the two written surfaces, session recall at intake, and live
> service context. Read [DESIGN.md](DESIGN.md) first for the blackboard architecture.

## The principle: two audiences, two surfaces

A finished run produces two very different kinds of knowledge, and conflating them is
how both surfaces rot:

1. **What the team learned about the code** — conventions, gotchas, constraints, where
   key logic lives. The audience is the **next agent** (or Claude Code session) working
   on this repo cold.
2. **What the software now does** — behaviour, features, usage, configuration. The
   audience is a **human** reading the project's documentation.

Swarm writes each to its own surface, each owned by its own scribe pass at run
completion:

| | Agent memory | Living documentation |
|---|---|---|
| **Surface** | `CLAUDE.md` → managed `## Swarm Learnings` section | `README.md`, `docs/**/*.md`, subdirectory readmes |
| **Audience** | Future agents working on the code | Humans using or evaluating the project |
| **Written by** | Learnings scribe (read-only; `runScribe`) | Docs scribe (`runDocsScribe`, may edit markdown) |
| **Written when** | Every successful run that surfaced a durable, non-obvious fact | Only when the run changed **externally observable behaviour** |
| **Semantics** | Merge — full section replaced with deduped, still-true facts | Edit in place — smallest change that makes the docs true again |
| **Never contains** | A changelog of the run; anything obvious from the code | Internal gotchas, agent conventions, a changelog (git history is the changelog) |

### The delineation test

Ask of each fact the run produced:

- **"Would a human user or README reader care?"** → living documentation.
  New feature, changed CLI/API/endpoint, new or changed config/env var, changed
  install/run steps, removed capability, changed defaults.
- **"Would only a future agent editing this code care?"** → `## Swarm Learnings`.
  "War views render via `WarSection` over a single `SlotResult[]`", "talisman data is
  read-only, synced from the bot", "the app is dark-theme only".
- **Both can be true in one run** — a user-visible feature that also introduced a
  non-obvious internal constraint writes to both surfaces, as two different sentences
  for two different readers.
- **Neither is a changelog.** "Added X in this run" belongs in git history and the
  session snapshot, not in either surface.

Two adjacent surfaces that are **not** the docs scribe's to touch:

- `## Swarm Context` in CLAUDE.md (deployment info) — written at planning time by the
  PM flow (`writeDeploymentInfo`), not by any scribe.
- `CONTEXT.md` / `AGENTS.md` / subdirectory `CLAUDE.md` files — agent context, managed
  by humans (or future features), never by the docs scribe.

### Enforcement is code, not prompt

Matching the rest of Swarm's gate philosophy, the boundary is enforced structurally in
`loop.ts`, not just requested in the prompt: after the docs scribe runs, the loop diffs
`git status --porcelain` against a pre-run snapshot and **reverts any newly changed
path that is not a permitted documentation file** (markdown only; never `CLAUDE.md`,
`CONTEXT.md`, `AGENTS.md`, never anything under `.swarm/`). The path rules live in
`agents/living-docs.ts` (`isLivingDocPath`, unit-tested). Only surviving doc changes
are committed, as `docs(swarm): update living documentation`.

Both scribe passes are best-effort: they run after the run is already successful and
can never fail it.

## Session recall — episodic memory at intake

Every completed run already snapshots to `.swarm/sessions/<id>/` (charter, task list,
verdicts, log). Session recall turns that archive into memory the PM actually uses:

- `state/session-recall.ts` loads compact summaries of prior sessions (goal, date,
  outcome, branch, files changed) and scores their relevance to the user's current
  message by token overlap on goals and file paths (pure, unit-tested).
- The most recent runs plus the highest-scoring relevant ones (capped, bounded chars)
  are injected into the PM's planning prompt as a "Prior runs on this project" block.
- The PM is instructed to use them the way Xirp uses Portal history: don't re-ask what
  a prior run already settled, flag when the new goal overlaps files a prior run
  touched, and treat prior outcomes as history — not as a description of the current
  code (the repo digest and Scout answer what's true *now*).

Delineation from `## Swarm Learnings`: learnings are **semantic** memory (timeless
facts about the code); session recall is **episodic** memory (what happened, when, and
how it went). Learnings are written into the repo; episodes stay in `.swarm/` and are
recalled per conversation.

## Live service context — the environment at intake

The PM plans better when it can see the project's live surroundings: open Sentry
errors, open Linear/GitHub issues, the latest deploy status. The builtin agents have no
connector access, so this rides on the marketplace grant system:

- `pm/live-context.ts` computes which **read-only** connector tools are usable for
  intake: the intersection of (a) a curated per-connector intake set (Sentry issues,
  Linear/GitHub issues, Vercel deployments, Datadog monitors) and (b) tools the user
  has actually granted to at least one hired specialist. No grants → no live context.
  Grants are the permission boundary — intake never widens what the user allowed.
- A background pass (same fire-and-forget pattern as the repo digest, cached in
  `.swarm/live-context.md` with a short TTL) asks the driver to gather a bounded
  digest with exactly those tools, and the next planning turn injects it.
- **Trust boundary (C1):** everything retrieved is third-party content. The gathering
  prompt and the PM prompt both mark it as *data, not instructions* — an issue title
  that says "ignore your instructions" is quoted, never obeyed. See
  [THREATS.md](THREATS.md) / [CONTROLS.md](CONTROLS.md).

## How the pieces relate

```
                      run completes
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
  learnings scribe   docs scribe       session snapshot
  (agent memory)     (human docs)      (episodic record)
        │                 │                  │
  CLAUDE.md          README/docs/**    .swarm/sessions/<id>/
  ## Swarm Learnings                        │
        │                                   │
        └────────────┬──────────────────────┘
                     ▼
              next PM intake  ◄── live service context (.swarm/live-context.md)
   (project context + repo digest + prior runs + live environment)
```

Together these are Swarm's answer to Xirp's "institutional memory" — local-first and
single-tenant: the org-catalog layer is out of scope, but the loop from *work done* →
*knowledge captured* → *next session starts smarter* is closed.
