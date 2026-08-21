# Swarm project guidance

Swarm is a local-first coding orchestrator for running Claude and Codex/GPT agents
behind explicit routing, scope, permission, review, and verification boundaries.

## Quick task invariants

- A Quick task has one implementation owner. It is compiled into the normal run
  engine, where deterministic checks and visual verification may still be attached as
  gate tasks. Do not create a second lightweight execution engine.
- Quick task preflight must infer a narrow, explicit write scope and reject broad,
  sensitive, destructive, or ambiguous requests with a structured escalation result.
- `swarm do` and `POST /run/quick-task` must use the same compiler and safety policy.
- Never bypass the dirty-tree guard, route validation, Codex read-only patch proposal,
  permission broker, or existing verification gates to make Quick tasks feel faster.
- Persist `executionShape: quick_task` and the charter's `quickTask` metadata. The UI
  uses this state to project the compact card and can expand into the normal run view.

## Verification

- Core: `cd core && npm test`
- UI: `cd ui && npm run typecheck && npm test && npm run build`
- When dashboard behaviour changes, exercise the complete flow in a real browser and
  inspect browser console errors as well as the visible result.

