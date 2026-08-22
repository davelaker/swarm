# Project-scoped UX improvement plan

> Status: proposed implementation plan  
> Scope: dashboard project isolation, historical-session fidelity, model-policy clarity,
> and targeted usability improvements  
> Primary invariant: every project-bound surface displays data from exactly one canonical
> project root

## 1. Purpose

Swarm's populated execution workspace is already strong. The three-column Running view
keeps agents and findings, the task graph, and PM chat visible together; checks and visual
verification are first-class; completed runs expose duration, cost, changes, and shipping
state without hiding the work that produced them.

This project must preserve that operational model. It is not a dashboard redesign.

The work exists because the active folder currently behaves more like a label than a hard
data boundary. After a project switch, History, Agents, context sources, Branches, Planning,
or reconnecting state can expose data associated with another folder. Historical runs can
also project incomplete data into the live Planning vocabulary, for example showing
`DRAFT`, `Waiting on PM`, or an unspecified branch for a run that completed successfully.
Model-policy summaries can appear to contradict the models configured on individual agents.

The outcome should be a workspace users can trust:

1. The project shown in the shell determines every project-bound byte on screen.
2. Switching projects is atomic from the user's perspective.
3. Historical sessions are truthful read-only records, not partial live plans.
4. Model availability, defaults, preferences, and effective run routes are distinguishable.
5. Dense operational screens remain dense, while large collections become easier to scan.

## 2. Product principles

### 2.1 Project is a security and trust boundary

Canonical project identity must be carried through requests, responses, events, caches, and
local persistence. Components must not infer identity from whichever root the server happens
to hold when a delayed request completes.

### 2.2 Preserve the populated Running workspace

Do not replace the current Agents/Findings + Task Graph + PM Chat composition with a generic
card dashboard or wizard. Improve its header, responsiveness, selection behavior, and
historical context incrementally.

### 2.3 Never use live-state language for missing archival data

An archived snapshot with no saved planning conversation is not "waiting" for anything.
Missing historical fields should be labelled unavailable or reconstructed, and stored facts
from the executed run should take precedence over draft placeholders.

### 2.4 Make effective behavior more prominent than configuration

Users care which model will or did run. Availability policy, project defaults, agent
preferences, and effective task routes are related but distinct concepts and must be named
accordingly.

### 2.5 Empty states are secondary work

Empty states should provide a useful next action, but they are not representative of the
core product. Trust, correctness, and populated workflows take priority.

## 3. Scope

### In scope

- Canonical project identity and request/response contracts.
- Atomic project switching and stale-response rejection.
- Project-scoped Planning, Running, Branches, Agents, History, context sources, findings,
  diffs, images, scorecards, and live events.
- Historical-mode navigation and historical Planning fidelity.
- Model-policy and effective-model terminology.
- Branch and History collection scalability.
- Responsive cleanup for the populated Running header.
- Targeted contrast, keyboard, and accessible-name improvements.
- Automated race, scoping, component, and browser tests.

### Non-goals

- Replacing the task graph.
- Rebuilding Running as a linear wizard or feed.
- Changing the orchestration engine or gate semantics.
- Adding a second lightweight execution engine.
- Making cross-project history the default.
- Restyling the entire product or changing its visual identity.
- Broad marketplace redesign unrelated to project scope or model clarity.

## 4. Definitions

### Canonical project root

The absolute, normalized root returned by the server after resolving the selected folder.
Client-provided display names or unnormalized paths are never authoritative.

### Project ID

A stable opaque identifier derived from the canonical root. It exists to compare identities,
not to conceal the filesystem path. A versioned SHA-256 digest is sufficient:

```text
projectId = "project:v1:" + sha256(canonicalRoot)
```

### Project generation

A monotonically increasing client-side token for one active-project lifetime. It changes
whenever switching begins, including a switch back to a previously visited project. It lets
the client discard responses from older requests even when the old and new projects share a
name.

### Project envelope

Metadata included in every project-bound server response and SSE event:

```ts
interface ProjectEnvelope {
  projectId: string;
  projectRoot: string;
  projectName: string;
}
```

### Historical mode

A read-only projection of a saved run. Historical mode belongs to a specific project and
session and must not be confused with the project's current live Planning or Running state.

## 5. Target user journey

### 5.1 Select or resume a project

The shell shows the project name and offers the folder switcher. The server resolves the
canonical root and returns readiness information:

- accessible directory;
- Git repository and Codex trust readiness;
- `.swarm` state availability;
- dirty-tree state;
- active-run switch blocker;
- available provider transports.

If the folder is not a Git repository, the user sees an explicit readiness result before
planning. Initializing Git is a separate, clearly labelled action.

### 5.2 Plan and execute

Planning continues to use conversation plus structured charter. When executable, the user
reviews the concrete run shape: project, branch mode, write scope, agents, effective models,
and gates. Running retains the existing three-column operational view.

### 5.3 Inspect the result

The completed-run header summarizes outcome, duration, cost, branch, and gates. Selecting a
task or finding synchronizes the graph, finding/report context, and PM transcript where
possible. Primary actions do not wrap at supported desktop widths.

### 5.4 Revisit history

History defaults to the active project. Selecting a session enters an unmistakable archived
mode shared by Planning and Running. Returning to current work is one action. Reopening an
archive creates a new editable plan; it never mutates the archived record.

## 6. Architecture plan

### 6.1 Introduce a server-owned project descriptor

Create a small single-purpose module in `core/src/state/` responsible for:

- canonicalizing a candidate root;
- creating `projectId`;
- returning the current `ProjectEnvelope`;
- comparing a requested project identity with the active server project.

Do not mix filesystem mutation, HTTP response writing, or project switching into these pure
identity functions.

The server may continue to use one mutable active root because Swarm is local and
single-tenant, but no project-bound request may silently rely on it. Requests must state the
project they expect, and responses must prove the project that served them.

### 6.2 Add an expected-project request contract

Use one consistent mechanism for all project-bound HTTP calls. Recommended header:

```http
X-Swarm-Project-Id: project:v1:...
```

If the header is absent during a compatibility window, the server may serve the request and
include the envelope. Once the UI has migrated, make the header required for project-bound
routes.

If the expected project differs from the active root, return `409` with a structured body:

```json
{
  "error": "project_mismatch",
  "expectedProjectId": "project:v1:...",
  "activeProject": {
    "projectId": "project:v1:...",
    "projectRoot": "/canonical/root",
    "projectName": "root"
  }
}
```

Never fall through and return data from the active root under the caller's old assumption.

### 6.3 Envelope all project-bound responses

At minimum, migrate:

- `/health` project information;
- `/state`;
- `/context` and planning-related endpoints;
- `/sessions` and `/sessions/:id`;
- `/branches` and branch details;
- roster, built-in instructions, built-in models, and marketplace project state;
- findings, diffs, images, and scorecards;
- execute, quick-task, permission, rewind, merge, push, and PR operations.

Prefer one strict response shape per endpoint. Avoid returning an envelope on success and an
unstructured string on failure.

### 6.4 Scope SSE connections and events

The client must connect to `/events` with its expected project ID. The server captures that
identity for the connection and closes or invalidates the stream when the active root
changes.

Every event includes `projectId`. The UI discards an event unless both conditions are true:

1. `event.projectId === activeProject.projectId`;
2. the listener belongs to the current client project generation.

Switching projects closes the old `EventSource` before loading the next snapshot.

### 6.5 Create a frontend project context

Replace independently coordinated `projectName`, `projectRoot`, `projectSynced`, and ad-hoc
local-storage reads with one state machine:

```ts
type ProjectContextState =
  | { status: 'booting'; generation: number }
  | { status: 'switching'; generation: number; requestedRoot: string }
  | {
      status: 'ready';
      generation: number;
      project: ProjectEnvelope;
      readiness: ProjectReadiness;
    }
  | { status: 'error'; generation: number; message: string };
```

Expose a project-aware fetch helper that:

- requires a ready project;
- adds `X-Swarm-Project-Id`;
- owns an `AbortSignal` associated with the generation;
- validates the response envelope;
- returns a typed project-mismatch error;
- never updates UI state after its generation becomes stale.

Functions should either return data or perform a state transition, not both.

### 6.6 Make switching atomic

When a user confirms a folder:

1. Enter `switching` and increment the generation.
2. Abort project-bound HTTP requests.
3. Close the existing SSE connection.
4. Clear historical selection and project-derived transient state.
5. POST `/project/switch` with the requested path and current expected project ID.
6. Receive the canonical project envelope and readiness result.
7. Store the canonical root as the resume preference.
8. Load a minimal authoritative bootstrap snapshot for the new project.
9. Enter `ready` only after all accepted bootstrap data matches the new project ID.

Render a shared project-loading boundary across all tabs during steps 1–8. Do not allow each
tab to reveal its previous contents independently.

### 6.7 Remount every project-bound surface

As defense in depth, key all project-bound surface roots by `projectId`, including:

- Planning;
- Running;
- Branches;
- Agents/Marketplace;
- History.

Keys do not replace identity validation. They ensure local component state such as expanded
rows, selected agents, filters, and pending details cannot leak across projects.

### 6.8 Scope client persistence

Audit every `localStorage` and session-storage key. Classify it as:

- global preference, such as theme;
- project preference, keyed by `projectId`;
- session state, keyed by `projectId` and session ID.

Keep the canonical-root resume pointer global, but do not store project conversation or
selection state under a project name alone.

## 7. Surface-specific changes

### 7.1 Application shell and project switcher

Keep the compact header. Improve project confidence without adding a permanent large bar:

- expose the canonical root in the project control tooltip/popover;
- show readiness problems beside the folder choice;
- show a compact `Switching project…` boundary across the content area;
- preserve current global statuses while naming model-policy scope accurately.

The folder picker must detect and explain Git/Codex readiness before the first PM message.

### 7.2 Planning

- Preserve conversation + charter.
- Clear the current planning session on project switch before rendering new context.
- Verify context-source responses against `projectId`.
- Keep current live status terms only for live plans.
- Surface model and route constraints in the execution review, not as ambiguous global copy.

### 7.3 Running

- Preserve the populated three-column layout.
- Keep the task graph visually dominant.
- Reflow the top summary so historical controls, next-task action, model status, costs, and
  gate badges do not compete or wrap.
- At supported narrower widths, collapse secondary status into a details popover before
  shrinking the task graph.
- Allow a truncated PM/task transcript item to open its full text.
- Coordinate selection across task, finding, and transcript when an identifier is shared.

### 7.4 History

History defaults to the active project and fetches through the project-aware client.

Add collection controls only when the list size warrants them:

- text search over goal and branch;
- status/outcome filter;
- branch filter;
- date grouping or date filter;
- incremental loading.

Each row should retain goal, date, task/gate outcome, and branch. Add duration and model only
if they can be scanned without turning rows into dashboards.

If an all-projects view is added later, it is an explicit adjacent mode. It uses a dedicated
cross-project index and displays project name and canonical-root context on every entry.

### 7.5 Historical mode

Use one contextual banner across tabs:

```text
Viewing archived run · Jun 17 · live-diff-test
[Re-open as plan] [Return to current work]
```

Archived Planning must:

- display `ARCHIVED`, not `DRAFT`;
- use the executed goal, team, route/model information, branch, and gates from the snapshot;
- show `Not recorded` for genuinely absent historical data;
- never show `Waiting on PM`;
- state when a summary is reconstructed from execution data;
- remain read-only until the user explicitly reopens it as a new plan.

Update the session snapshot schema so future sessions persist the full approved charter,
planning summary or messages, team, branch mode, route decisions, and project envelope.
Support older snapshots with a pure compatibility adapter and explicit provenance fields.

### 7.6 Agents

Keep the existing built-in and hired-agent structure. Clarify four layers:

1. **Available model** — executable through an authenticated transport.
2. **Project default** — preferred route for applicable new tasks.
3. **Agent preference** — model requested by an agent configuration.
4. **Effective route** — provider, model, and effort selected for a particular task/run.

The top-level policy control must say which layer it changes. An agent whose preference is
disabled should show a clear state and remediation:

```text
Unavailable for new runs — Claude Sonnet 4.6 is disabled by project policy
[Choose enabled model]
```

Historical runs continue to display the model they actually used, even if it is disabled
now. Do not rewrite historical truth to match current policy.

### 7.7 Branches

Preserve detailed branch information but manage large repositories:

- keep open branches expanded and first;
- collapse merged branches by default;
- add search and status filters;
- sort by recent activity;
- incrementally render or virtualize long merged lists;
- move per-row delete into an overflow action;
- retain a separate guarded bulk cleanup action;
- link a branch to its originating Swarm session when known.

All destructive branch actions must resolve their exact project and branch immediately
before confirmation and execution.

### 7.8 Error recovery

Convert known infrastructure failures into structured recovery states. Conversation may
record a short failure summary, but raw transport output belongs behind technical details.

Every failure should answer:

- what failed;
- whether files or Git state changed;
- what the user can do next;
- where technical diagnostics can be copied.

At minimum, handle repository readiness, project mismatch, provider unavailability,
structured-output rejection, disconnected events, and stale server root.

## 8. Data model changes

### 8.1 Session metadata

Add to new session indexes:

```ts
interface SessionProjectIdentity {
  projectId: string;
  projectRoot: string;
  projectName: string;
}

interface SessionRouteRecord {
  taskId: string;
  provider: 'anthropic' | 'openai';
  model: string;
  reasoningEffort?: string;
}
```

Persist the approved charter rather than reconstructing it from the goal. Older sessions
remain readable through a versioned adapter.

### 8.2 Provenance

Fields displayed in historical Planning should carry enough provenance for the UI to choose
truthful language:

```ts
type HistoricalValueSource = 'recorded' | 'reconstructed' | 'unavailable';
```

Do not expose this type mechanically beside every field. Use it to decide labels and helper
copy.

### 8.3 Compatibility

- Do not rewrite old session files in place merely by reading them.
- New fields are optional at the raw-storage boundary.
- Normalize raw snapshots into one strict UI model before rendering.
- Add a snapshot schema version for all newly written sessions.

## 9. Implementation phases

### Phase A — identity foundation

Deliverables:

- pure canonical-root and project-ID module;
- `ProjectEnvelope` types shared or mirrored explicitly across core and UI;
- envelope on `/health`, `/state`, `/sessions`, `/branches`, roster, and context responses;
- expected-project validation and structured `409` errors;
- unit tests for normalization and mismatch behavior.

Exit criterion: the server cannot return project-bound success data without identifying its
project.

### Phase B — atomic frontend switching

Deliverables:

- `ProjectContext` state machine;
- project-aware fetch helper;
- generation-owned abort controllers;
- project-scoped SSE connection;
- shared switching boundary;
- every surface keyed by `projectId`;
- storage-key audit.

Exit criterion: delayed old-project responses and events cannot affect the new project.

### Phase C — History and archival truth

Deliverables:

- project-scoped History requests;
- historical-mode banner and exit behavior;
- archived Planning vocabulary;
- versioned session snapshot with project, charter, team, branch, routes, and planning data;
- compatibility adapter for existing sessions.

Exit criterion: a completed session never renders as an incomplete live draft.

### Phase D — model clarity

Deliverables:

- revised policy labels;
- agent-preference validation against enabled models;
- unavailable/remediation state;
- effective routes in run and historical details;
- tests covering disabled current models and historical models.

Exit criterion: the UI can explain exactly why the header, agent configuration, and run may
show different model names.

### Phase E — density and responsive polish

Deliverables:

- scalable Branches controls;
- optional History search/filter and incremental loading;
- Running header responsive rules;
- transcript expansion and cross-column selection improvements;
- targeted contrast and accessible-name fixes.

Exit criterion: populated core screens remain usable at the project's supported minimum
desktop width and with keyboard-only input.

## 10. Test plan

### 10.1 Core unit tests

- Equivalent path spellings resolve to the same canonical root and project ID.
- Different roots with the same basename produce different IDs.
- Expected-project mismatch returns structured `409` without reading project state.
- Session listing reads only the active project's session directory.
- Historical snapshot normalization correctly distinguishes recorded, reconstructed, and
  unavailable fields.
- Old snapshot versions remain readable.

### 10.2 UI unit/component tests

- All project-aware requests include the expected ID.
- A response with the wrong project ID is rejected.
- Switching increments generation and aborts old requests.
- A delayed History response cannot update state after a switch.
- A delayed roster/context/branch response cannot update state after a switch.
- Old SSE events are ignored.
- Every project surface resets local selection and expansion state.
- Archived Planning never renders live waiting language.
- Disabled agent-model preferences show remediation.
- Historical effective models remain visible when currently disabled.

### 10.3 Server integration tests

Create two temporary repositories with deliberately distinguishable:

- goals and sessions;
- branches;
- hired agents;
- context files;
- state and findings.

Switch repeatedly while issuing concurrent requests. Assert that each accepted response
matches its declared project and that mismatches fail closed.

### 10.4 Browser verification

Exercise the complete flow in a real browser:

1. Open project A on every tab and record identifying content.
2. Start a deliberately delayed request or reconnect.
3. Switch to project B.
4. Visit Planning, Running, Branches, Agents, and History.
5. Confirm no project-A identifier appears.
6. Open a completed B session in Running and Planning.
7. Confirm archived status and truthful missing-data labels.
8. Reopen the session as a plan and confirm the archive is unchanged.
9. Inspect browser console errors.
10. Capture screenshots of populated Running, archived Planning, Agents model state, History,
    and the switched project on Branches.

Run the repository verification required by `AGENTS.md`:

```bash
cd core && npm test
cd ui && npm run typecheck && npm test && npm run build
```

## 11. Acceptance criteria

The project is complete only when all of the following are true:

- Every project-bound success response and event carries a project identity.
- The UI rejects identity mismatches and stale generations.
- Switching projects atomically resets all five tabs.
- History defaults to and remains scoped to the active canonical project.
- Branches, Agents, context sources, historical selection, findings, and live run state are
  equally scoped.
- No stale project content flashes during a switch or reconnect.
- Archived sessions use archived language and display executed facts.
- Missing old-session data is labelled unavailable or reconstructed, never pending.
- Model availability, project default, agent preference, and effective route are named and
  understandable.
- The populated Running workspace retains its three-column structure.
- Large merged-branch collections are collapsed/filterable and do not render destructive
  controls as the dominant repeated affordance.
- Keyboard focus, accessible names, contrast, and supported desktop widths pass verification.
- Core tests, UI typecheck, UI tests, UI build, and browser verification pass.

## 12. Rollout and risk management

### Compatibility rollout

1. Add envelopes while the server temporarily accepts missing expected-project headers.
2. Migrate UI clients and prove all project-bound requests send the header.
3. Make identity mandatory on project-bound routes.
4. Add telemetry/logging for rejected mismatches without recording sensitive content.

### Principal risks

| Risk | Mitigation |
| --- | --- |
| Global mutable root changes between validation and read | Validate and capture one project descriptor at request start; pass its root into downstream functions rather than rereading the global root. |
| SSE events cross a switch boundary | Bind connections to project ID, close on switch, include identity per event, and validate client generation. |
| Existing sessions lack charter/model fields | Versioned adapter plus explicit reconstructed/unavailable provenance. |
| Project ID leaks filesystem information | Use an opaque digest for comparison while showing the canonical path only in intentional local UI. |
| Remounting loses active approvals | Block project switching during an active run as today; keep the permission gate global only within the active project generation. |
| Scope work expands into visual redesign | Enforce the non-goals and preserve populated Running in visual regression checks. |

## 13. Documentation updates during implementation

- Record the project-envelope contract in `docs/DESIGN.md` once adopted.
- Update `docs/UX.md` with historical mode and model terminology.
- Update `README.md` only where user-visible switching, history, or model behavior changes.
- Add critical implementation invariants and race-condition gotchas to the root `AGENTS.md`
  after the architecture is settled.

## 14. Definition of done

This work is not done when each endpoint independently returns the correct folder in a happy
path. It is done when adversarial switching and delayed responses prove that incorrect
project state cannot render, historical sessions tell the truth, model behavior is
explainable, the populated workspace remains intact, and the complete core/UI/browser
verification suite passes.
