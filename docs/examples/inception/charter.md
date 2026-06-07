---
# Example Project Charter — the artifact a Planning-mode session produces.
# See ../../INCEPTION.md §5. This becomes the {{PROJECT_CONTEXT}} injected into every
# agent's effective prompt during execution.
project: focuslist
owner: me
tier: greenfield
status: approved
goal: >
  A minimal, keyboard-first todo web app for power users — fast, no friction, no accounts.
target_users: >
  Individual power users on desktop who live on the keyboard. Not mobile-first, not for
  first-time/casual users who need heavy hand-holding.
constraints:
  - "No account system in v1 — browser local storage only."
  - "Operable end-to-end by keyboard; mouse strictly optional."
  - "Ship as a single static site; no backend in v1."
  - "Interactive in under 1s on mid-range hardware (a success criterion, not an aspiration)."
non_goals:
  - "Collaboration / sharing — v2."
  - "Mobile-optimised layout — v2."
  - "Sync across devices — implied out by 'no backend'."
success_criteria:
  - "Create, complete, reorder, and filter tasks entirely by keyboard."
  - "Loads and is interactive in <1s on mid hardware."
  - "Zero layout shift; no flash of unstyled content."
decisions:
  - decision: "Local storage, no backend in v1."
    rationale: "Single-user, single-device. A backend adds auth + hosting cost for zero v1 value."
  - decision: "Vanilla + a tiny view layer; no heavy SPA framework."
    rationale: "A keyboard todo app can't justify the bundle, and performance is an explicit success criterion."
  - decision: "Command-palette-style keyboard model (single entry point for actions)."
    rationale: "Scales better for power users than memorising many discrete shortcuts."
resolved_questions:
  - q: "Undo for completed/deleted tasks?"
    a: "Yes — single-level undo on the last destructive action."
  - q: "Persistence format?"
    a: "JSON in local storage, versioned with a schema key for future migration."
open_questions:
  - "Light/dark theming — deferred; decide during build."
  - "Keyboard cheatsheet overlay — nice-to-have; decide if time allows."
recommended_team:
  - ux-researcher          # keyboard-first interaction model needs review
  - accessibility-auditor  # keyboard operability IS an accessibility concern here
  # (Coder, Tester, Security ship as defaults; no DB/API/Compliance agents — no backend, no PII)
---

## Narrative summary

FocusList is a deliberately small, fast, keyboard-driven todo app for desktop power users.
The whole bet is *speed and friction-free keyboard control*; everything that doesn't serve
that (accounts, mobile, sync, collaboration) is explicitly a non-goal for v1.

## Why this charter is execution-ready

- **The decisions carry rationale**, so during execution the Coder won't "helpfully" reach
  for a big SPA framework or add a login screen — the charter already closed those doors and
  said why.
- **Resolved questions** (undo, persistence format) mean agents won't stall or escalate on
  them mid-build.
- **The recommended team is fitted to the project**: a UX Researcher and Accessibility
  Auditor (because keyboard operability is the core value *and* an a11y concern), but no DB,
  API, or Compliance agents — there's no backend and no PII, so those would only add noise.
- **Open questions are deliberately deferred**, not forgotten — the PM chose to discover
  them during build rather than over-plan.
