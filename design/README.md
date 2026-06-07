# Handoff: Agent Swarm

## Overview
**Agent Swarm** is a local, single-user developer power tool for running a coordinated team of specialised AI agents against your own codebase. It has two phases and three surfaces:

1. **Planning** — you converse with a Project Manager (PM) agent that pressure-tests your idea and assembles a structured **Project Charter** in real time. When the charter is ready you hit **Execute**.
2. **Running** — autonomous execution. The PM builds a task graph and dispatches specialist agents (Coder, Tester, Security, optionally Negotiator). Agents never talk to each other; they read/write a shared blackboard (the task graph) and the PM referees. A task can't reach `done` until its security and test gates pass. You watch it live.
3. **Marketplace** — hire additional specialist agents, customise them with appended instructions, and grant them tool permissions one at a time — like granting an app permissions on your phone.

The product feeling: **dark, calm, information-dense, precise** — a tool someone spends hours in (think Linear / Vercel dashboard). No decorative chrome. Monospace where it counts. The "alive" quality comes from the task graph recolouring in real time, the agent's current step ticking through, and findings sliding into the feed — not from gratuitous animation.

## About the Design Files
The file in this bundle (`Agent Swarm.html`) is a **design reference created in HTML** — a single-file, self-contained React (via in-browser Babel) prototype that demonstrates the intended look and behaviour. It is **not production code to copy directly**.

The task is to **recreate this design in the target codebase's existing environment** (React, Vue, SwiftUI, native, etc.), using that codebase's established component library, state-management, and styling patterns. If no environment exists yet, choose the most appropriate framework for the project (a React + TypeScript SPA is a natural fit for this dashboard) and implement there. The HTML prototype uses mock data and timer-driven simulations to stand in for a real agent runtime — in production these are replaced by live data from the agent orchestration backend (streaming events for charter assembly, task-graph updates, agent steps, and findings).

## Fidelity
**High-fidelity (hifi).** Final colours, typography, spacing, layout, and interaction/animation behaviour are all specified and should be recreated faithfully using the codebase's existing primitives. Exact hex values, fonts, and timings are listed below.

---

## Design Tokens

### Colour — surfaces & text (cool-neutral dark)
| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0a0b0d` | App base background |
| `--bg-1` | `#0d0f12` | Panel background (left rails, headers) |
| `--bg-2` | `#121519` | Card / elevated surface |
| `--bg-3` | `#181c21` | Hover / active surface, chips |
| `--bg-4` | `#1f242b` | Switch track, deepest control |
| `--border` | `#22272e` | Default 1px border |
| `--border-1` | `#2c323b` | Stronger border (inputs, primary controls) |
| `--border-soft` | `#16191e` | Subtle inner dividers |
| `--tx` | `#e8eaed` | Primary text |
| `--tx-1` | `#a4abb4` | Secondary text |
| `--tx-2` | `#6c747e` | Tertiary text / labels |
| `--tx-3` | `#4a515a` | Faint text, placeholders, empty states |

### Colour — status & semantic accents
All accents share a similar lightness/chroma; only hue varies.
| Token | Hex | Meaning |
|---|---|---|
| `--blue` | `#4d8df4` | in_progress / COMPLETE verdict / Coder persona / first-party |
| `--green` | `#34cf8a` | done / PASS verdict / Tester persona |
| `--amber` | `#e8a93a` | changes_requested / CHANGES verdict / Security persona / FEATURE tier / write tool |
| `--red` | `#f05a52` | failed / FAIL verdict / shell tool / destructive |
| `--purple` | `#a585f5` | PM persona / community provenance |
| `--orange` | `#ef8043` | Negotiator persona / network tool |
| `--grey` | `#707880` | pending status / read tool / private provenance |

Deep/tint backgrounds for badges & chips (status colour at ~12–18% on dark): `--blue-d #1e3252`, `--green-d #143a2c`, `--amber-d #3a2f12`, `--red-d #3c1c1b`, `--purple-d #2a2147`.

### Typography
- **Sans (UI):** system stack — `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`. In a real codebase, substitute the app's UI sans (e.g. Geist, Inter, or the existing system font).
- **Mono:** `"JetBrains Mono"` (loaded from Google Fonts), fallback `ui-monospace, "SF Mono", Menlo, monospace`. Used for IDs, task/agent codes, prompts, code blocks, tier pills, timestamps, provenance labels, metric readouts.
- Base body: 14px / line-height 1.5, `-webkit-font-smoothing: antialiased`.
- Scale in use: section labels 10.5–11px uppercase, letter-spacing 0.09–0.11em, `--tx-3`; body 12.5–14px; titles 14–19px, weight 600, letter-spacing −0.01 to −0.02em.

### Spacing / radius / misc
- Radii: `--r-sm 5px`, `--r 8px`, `--r-lg 12px`; pills use `100px`.
- Common paddings: panels `0 18px`; cards `10–16px`; modal body `18–20px`.
- Panel header height 44px; topbar 48px; marketplace tab bar 46px.
- Shadows: glow on active task node `0 0 24px -8px rgba(77,141,244,0.5)` + `0 0 0 1px rgba(77,141,244,0.12)`; modal `0 30px 80px -20px rgba(0,0,0,0.7)`; drawer `-30px 0 60px -30px rgba(0,0,0,0.6)`.
- Scrollbars: 9px, thumb `--bg-4`/`--border-1`, transparent track.

### Personas
| id | name | colour | role label |
|---|---|---|---|
| `pm` | Project Manager | `#a585f5` | Referee |
| `coder` | Coder | `#4d8df4` | Implementation |
| `tester` | Tester | `#34cf8a` | Verification |
| `security` | Security | `#e8a93a` | Review |
| `negotiator` | Negotiator | `#ef8043` | Arbitration |

---

## App Shell (all surfaces)
- **Topbar** (48px, `--bg-1`, bottom 1px `--border`): brand mark = 3 small dots (blue/green/amber) forming a triangle + wordmark "Agent Swarm" + `/` separator + project name "discord-rank-bot" (`--tx-1`). Then a **nav** of three text buttons: Planning · Running · Marketplace. Active nav button: `--tx` on `--bg-3`, radius 5px; inactive `--tx-2`, hover `--tx-1` on `--bg-2`.
- On the **Planning** surface only, the topbar right side shows a `PLANNING` status pill (amber dot) and the **Execute** primary button (disabled until the charter has content).
- Surface switching is a simple top-level state (`planning | running | marketplace`).

---

## Surface 1 — Planning

**Layout:** two-column grid, `minmax(380px,1fr)` (charter) / `1.25fr` (conversation), full height.

### Left — Project Charter (live-assembling)
Panel header "PROJECT CHARTER" with a `DRAFT` badge (grey) on the right. Body scrolls. Title "Leaderboard command" (19px/600), submeta `discord-rank-bot · charter v0.1` (mono, `--tx-2`). Then five numbered sections, each with a 10.5px uppercase label prefixed by a mono number (`01`–`05`):
1. **Goal** — single line of body text.
2. **Constraints** — bulleted list, marker `▸` in amber.
3. **Non-goals** — list, marker `✕` in red.
4. **Open questions** — list, marker `?` in blue; a resolved question turns `--tx-2` with a green `✓` marker and an appended `→ answer`.
5. **Recommended team** — pill chips, each a coloured persona dot + name.

Before content arrives, each section shows an italic `Listening…` placeholder (`--tx-3`). As the conversation progresses, items **fade-up in** (`translateY(7px)` + opacity, 0.42s `cubic-bezier(.2,.7,.2,1)`) — it should feel like a document writing itself.

### Right — PM Conversation
Panel header "PM CONVERSATION" + a small `● scoping` status (green dot, mono). Chat scroll area + a disabled composer (the PM is driving; placeholder "The PM is driving this conversation…", helper line "Auto-piloted demo · the PM assembles the charter as you talk").

Message rows (max-width 760px):
- **PM** messages: left-aligned, purple `PM` avatar (rounded 7px, `--purple-d` bg), bubble `--bg-2` / `--border`.
- **You** messages: right-aligned (row-reverse), grey `YOU` avatar, bubble `--blue-d` bg, `rgba(77,141,244,0.32)` border, text `#e6eefc`.
- **Specialist interjections** (e.g. Security): rendered differently — a dashed amber border, transparent bg, mono 12px amber text, amber `SE` avatar. Example: `[Security consulted] Season filter takes raw user input — SQL injection risk on the query path.`
- Avatars 26px; meta row shows name + mono timestamp `00:SS`.
- Inline `` `code` `` spans render as mono on a faint `rgba(255,255,255,0.06)` background.
- A **typing indicator** (3 dots blinking, 1.2s) appears ~450ms before each message lands.

### Simulated conversation (mock — replace with live stream)
Plays automatically on mount via a timed script. The exchange scopes a `/leaderboard` Discord-bot command and produces this charter:
- **Goal:** "Add a /leaderboard slash command that ranks players by season."
- **Constraints:** reads from existing Postgres `matches` table · cap to top 100, paginated · season filter must be parameterized (no string interpolation).
- **Non-goals:** no write access to match data · no new ranking math — reuse existing Elo.
- **Open question:** "Should tied players share a rank?" → resolved "yes — tied players share a rank".
- **Team:** Coder, Tester, Security (chips appear one by one).
Security interjects mid-conversation to flag the SQL-injection risk, which becomes a gate. When the team is staffed, **Execute** enables.

### Execute
Pressing Execute transitions to Surface 2 (Running) and starts the run.

---

## Surface 2 — Running

**Layout:** CSS grid, columns `minmax(310px,360px) 1fr`, rows `52px / 1fr / minmax(160px,230px)`.
- Row 1 (full width): **run header**
- Row 2 col 1: **Task Graph** · col 2: **Agents** (top) + **Findings** (bottom)
- Row 3 (full width): **PM Chat**

### Run header (52px, `--bg-1`)
Left: project name "discord-rank-bot" · `FEATURE` tier badge (amber, mono uppercase) · **run-status pill**. Right: **Pause/Resume** and **Abort** (danger hover) buttons, then the **spend meter**.
- Status pill states: `running` (blue, pulsing dot, `softpulse` 1.4s opacity 1↔0.35), `paused` (grey), `done` (green dot, no pulse), `aborted` (red).
- **Spend meter:** fixed 172px column. Top row mono: bold amount `$1.24` + `/ $5.00` cap (`--tx-3`). Below, a 4px track (`--bg-3`) with a blue→`#6aa6f8` gradient fill, width = spend/cap, `transition: width .2s linear`. Climbs continuously during the run, ending at `$1.24` of a `$5.00` budget.

### Left — Task Graph
Panel header "TASK GRAPH" + `N/M done` counter (mono, right). Vertical, **git-graph style**: each task is a row with a left **rail** (56px) holding a status **dot** and a card. Dots sit in lanes (x = `18 + lane*20`) so branches don't overlap; **dependency edges** are drawn as an absolutely-positioned SVG overlay behind the nodes — cubic bézier curves from each parent dot to each child dot (control points at the vertical midpoint). Edge stroke 1.5px, subtle `rgba(255,255,255,0.14)` (or `#2c323b` for pending targets). Recompute edge geometry on mount, resize (ResizeObserver), and whenever nodes are added.

**Node dot colours by status:** pending `--grey` · in_progress `--blue` (pulsing, with `0 0 0 4px rgba(77,141,244,0.18)` halo) · done `--green` · changes_requested `--amber` · failed `--red`. Dot is 13px, 2px `--bg-1` border ring.

**Node card** (`--bg-2`/`--border`, radius 8px): top row = mono task id (`t1`) + title (13px). Bottom row = assignee (persona dot + name) + status label (mono 10px uppercase, status-coloured, right). An **in_progress card** is emphasised: border `rgba(77,141,244,0.45)`, bg `#0f1620`, the blue glow shadow. Late-arriving nodes (t4/t5) **fade-up in**.

**Task set (mock):**
| id | title | assignee | depends on | lane |
|---|---|---|---|---|
| t1 | Implement /leaderboard command | coder | — | 0 |
| t2 | Write tests for t1 | tester | t1 | 1 |
| t3 | Security review of t1 | security | t1 | 0 |
| t4 | Fix SQL injection (t3) | coder | t3 | 0 (appears later) |
| t5 | Security re-review of t4 | security | t4 | 0 (appears later) |

### Right top — Agents panel
Panel header "AGENTS". One row per persona in fixed order: PM, Coder, Tester, Security, Negotiator. Each row: status dot + name (92px) + meta.
- **Active:** filled persona-coloured dot with an expanding ring pulse (`ring` 1.5s, scale 0.6→1.5 fading), and a live **current-step** line in mono, persona-coloured, **with a blinking block cursor** (`▌`, `cblink` 1s steps). This ticking step line is one of the two key "alive" signals.
- **Idle:** hollow dot (inset ring in `--tx-3`); shows either a **last-verdict chip** (see verdict chips) or a mono sub-label (`idle`, PM → `refereeing`, Negotiator → `no conflicts to arbitrate`).

### Right bottom — Findings feed
Panel header "FINDINGS" + `N logged` counter. Reverse-chronological cards; **new cards slide in from the top** (`slideTop` 0.45s, `translateY(-12px) scale(.99)`→none). This is the second key "alive" signal.
- Collapsed card head: caret + agent (persona dot + name) + mono task id + **verdict chip** (right). Below, a one-line summary (`--tx-1`).
- **Click to expand** full content (caret rotates 90°): a bordered body with labelled sections — file lists (file icon + mono path), notes (uppercase label + paragraph), and **code blocks** (mono, `--bg`, with `+ add` green / `- del` red / comment `--tx-3` line treatments).

**Verdict chips** (mono, 10px, 700, radius 4px) — immediately scannable:
| verdict | label | style |
|---|---|---|
| COMPLETE | `COMPLETE` | blue on `--blue-d` |
| PASS | `PASS` | green on `--green-d` |
| CHANGES_REQUESTED | `CHANGES_REQUESTED` | amber on `--amber-d` |
| FAIL | `FAIL` | red on `--red-d` |

**Seed findings (mock, with full expand content in the HTML):**
- `coder-t1` · COMPLETE · "Implemented LeaderboardCommand, 2 files changed"
- `tester-t2` · PASS · "6 tests passing"
- `security-t3` · CHANGES_REQUESTED · "SQL injection in season filter"
- `coder-t4` · COMPLETE · "Parameterized query, prepared statement"
- `security-t5` · PASS · "No injection vectors remain"

### Bottom — PM Chat (full width)
Panel header "PM CHAT". Transcript (reuses the planning message component) + composer (placeholder "Message the PM — pause the run to intervene…"). The PM posts when Security flags the SQLi: *"Security flagged a SQL injection in the season filter (t3). I've created t4 to fix it and t5 to re-review. Coder is on it now."* and a closing message when all gates are green.

### Run simulation (mock timeline — replace with live event stream)
Driven by a **wall-clock accumulator** (a `setInterval` ~90ms tracking `Date.now()` deltas into `elapsed`), NOT chained `setTimeout`s — this makes **Pause** (freeze accumulation) and **Abort** behave correctly and keeps timing accurate when backgrounded. Events have absolute `at` timestamps and fire when `elapsed >= at`. Sequence (~16.2s total):
1. t1 → in_progress; Coder active, step ticks: "Reading codebase" → "Writing LeaderboardCommand" → "Writing structured findings".
2. `coder-t1` COMPLETE slides in; t1 → done; Coder idle (COMPLETE). Tester + Security activate **in parallel** on t2/t3.
3. `tester-t2` PASS slides in; t2 → done.
4. `security-t3` CHANGES_REQUESTED slides in; t3 → changes_requested (amber).
5. PM posts the SQLi message.
6. t4 + t5 nodes **appear** in the graph (pending) with new dependency edges.
7. Coder reactivates on t4 ("Reading t3 findings" → "Parameterizing the season filter" → "Writing findings").
8. `coder-t4` COMPLETE; t4 → done; Security activates on t5.
9. `security-t5` PASS; t5 → done → all nodes green → status pill flips to ✓ **done**; PM posts closing message.
Spend climbs proportionally to elapsed, ending ~$1.24. The Negotiator stays idle in this scenario (shown to convey the concept); in a real run it arbitrates conflicts and can escalate to the user.

---

## Surface 3 — Marketplace

Sub-tab bar (46px): **Browse** (count 10) · **My Team** (count = built-ins + hired). Detail **drawer** and **Hire modal** open on top of Browse; **Upgrade diff modal** opens from My Team.

### Browse
**Filter bar** (sticky): a role **chip group** (All + Research, Architecture, Design, Quality, Backend, Security, Docs, Code), a **provenance** `<select>` (All / First-party / Community / Private), and a **search** input (filters name/desc/role). Active chip: `--tx` on `--bg-3`.

**Grid:** `repeat(auto-fill, minmax(290px,1fr))`, gap 14px. **Agent card** (`--bg-1`, radius 12px, hover lifts `translateY(-2px)` + `--bg-2`):
- Top: 36px square mono-initials icon tinted to the agent's colour; name (14.5px/600); sub-row with a **role chip** (`--bg-3`) and a **provenance badge**. If already hired, a green `✓ hired` marker.
- One-line description (`--tx-1`).
- Foot: ★ rating (mono, amber star) + **tool icons** (right), each a 22px square coloured by **sensitivity**.

**Provenance badge** (mono, uppercase, dot + label, nowrap): FIRST-PARTY blue · COMMUNITY purple · PRIVATE grey.

**Tool sensitivity** (icon + colour + treatment):
| sensitivity | colour | icon | treatment |
|---|---|---|---|
| read | grey | eye | neutral |
| write | amber | pencil | tinted bg/border |
| network | orange | globe | tinted bg/border |
| shell | red | terminal | tinted bg/border, strongest |

**10 seeded agents:** Product Researcher (Research, first, 4.8) · Architect (Architecture, first, 4.9) · UX Researcher (Design, community, 4.6) · Accessibility Auditor (Quality, first, 4.7) · Performance Engineer (Quality, community, 4.5) · Database Specialist (Backend, first, 4.8) · API Designer (Backend, community, 4.4) · Compliance Reviewer (Security, first, 4.9) · Documentation Writer (Docs, community, 4.3) · Refactoring Specialist (Code, private, 4.2). Each has version, short changelog, a read-only base prompt, a tool list (with `locked` write-scope where relevant), and a routing contract — see the HTML data block for exact copy.

### Agent Detail (drawer, right side, 540px)
Slides in from the right over a blurred scrim. Header: initials icon, name, role chip, provenance, rating, close. Body sections:
- **Version + changelog** (meta grid).
- **Base prompt · read-only** — a mono, scrollable block (max-height 190px) with a `🔒 locked` chip pinned top-right and a lock icon on the section label. Content is non-editable.
- **Requested tools** — each tool a row; **shell/network/write get ⚠ warning style** (caution border/bg, warning icon) and a sensitivity tag; locked write tools show `scope: <path> · locked`.
- **Routing contract** — plain English with tiers/roles bolded, e.g. *"Runs on **FEATURE** & **GREENFIELD**, after the Coder, before completion, only when a UI artifact exists."*
- Footer: **Hire** primary button (disabled + "Already on your team" if hired).

### Hire modal (intentional friction — "granting app permissions")
Centred modal (~560px) over scrim, `pop` entrance. Subtitle: "Grant tools one at a time — like permissions on your phone."
- **Per-tool grant toggles, one per row — never an accept-all.**
  - **read** rows: neutral, **default ON**.
  - **shell/network/write** rows: caution background, ⚠ icon, a specific warning line (e.g. "Can run commands on your machine. Off by default."), **default OFF**. An un-acknowledged sensitive row shows a red ring outline.
  - **Locked fields (write scope)** are shown but **visually disabled** with a lock icon and the scope (e.g. `/migrations only · locked`).
  - Toggle component: 38×22px pill switch; ON tint matches the tool sensitivity (blue/amber/orange/red).
- **Additional instructions (overlay)** textarea + helper: *"Appended after the template's guardrails. Cannot override them."*
- **Model** dropdown: Balanced / Deep.
- **Enabled tiers** multi-select pills: GREENFIELD / FEATURE / BUGFIX / REFACTOR (active = amber).
- **Confirm button** label is dynamic: `Hire <Name> with <N> tools granted`. It is **disabled until the user has acknowledged (interacted with) every sensitive shell/network/write toggle** (and at least one tier is selected). Until then the footer shows `⚠ Review the N sensitive permissions to continue.`
- Confirm adds/updates the agent in My Team and switches to the My Team tab.

### My Team
- **Built-ins** group (non-removable): PM, Coder, Tester, Security — each row has a `🔒 built-in` lock badge, role chip, "every tier", granted-tool icons, and a `non-removable` badge.
- **Hired** group: each row shows initials icon, name, `v<version>` badge, role chip, model, **enabled-tier pills**, **granted-tool icons**, an **enable/disable switch**, and a **remove** (trash) button. Disabled agents render at 60% opacity.
- **UX Researcher** is pre-hired, pinned at **v1.2.0**, with an amber **"↑ Upgrade to 1.3.0"** badge.

### Upgrade diff modal (from the upgrade badge)
Shows `1.2.0 → 1.3.0`, the changelog, a **prompt diff** (mono lines: green `+` additions, red `−` deletions, neutral context), and a **newly requested tool** highlighted in an amber-bordered `NEW` panel (the network tool `fetch_heuristics`, with a helper warning that this version requests a permission you haven't granted). "Review & apply upgrade" bumps the version to 1.3.0, clears the badge, and adds the new tool to the agent's granted-tool icons.

---

## State Management (what a real implementation needs)
- **Top-level:** active surface (`planning | running | marketplace`); whether the charter is executable (gates the Execute button).
- **Planning:** message list, charter object `{ goal, constraints[], nongoals[], questions[{text, resolved}] }`, recommended team[], typing indicator (who), executable flag. In production these are populated by a streaming charter-assembly endpoint.
- **Running:** tasks[] `{ id, title, assignee, deps[], lane, status }`; agents map `{ active, step, verdict }` per persona; findings[] (prepended, each with collapsed/expanded content); PM messages[]; spend (number); run status (`running|paused|done|aborted`); elapsed (accumulator). In production these come from the orchestrator's event stream; Pause/Abort send control commands.
- **Marketplace:** active tab; filters (role, provenance, query); open drawer agent; hiring agent; upgrading flag; **team[]** `{ id, version, enabled, grantedTools[], tiers[], model, instructions, upgradeAvailable }`.

## Interactions & Behaviour summary
- Nav + sub-tab switching; Execute → Running transition; Pause/Resume/Abort control the run accumulator.
- Findings cards expand/collapse on click. Agent cards open the detail drawer. Hire flow gates the confirm on permission acknowledgement. Upgrade applies a version bump + new tool.
- **Animations:** fade-up (charter/nodes, 0.42s), slide-in-from-top (findings, 0.45s), drawer slide (0.26s), modal pop (0.2s), scrim fade (0.18s), status/dot pulses (1.3–1.5s), ticking step cursor blink (1s), expanding active-agent ring (1.5s). Respect `prefers-reduced-motion` in production. The pulsing active task node and the ticking agent step line are the most important "alive" signals — make them feel real, not like generic spinners.

## Design Tokens / Assets
- No external image assets. All icons are inline SVG (eye, pencil, globe, terminal, lock, warning, star, file, search, send, trash, chevrons, play). Recreate with the codebase's existing icon set (e.g. Lucide — these map directly).
- Only external dependency is the **JetBrains Mono** webfont; swap for the codebase's mono if it has one.
- No third-party brand assets are used.

## Files
- `Agent Swarm.html` — the complete single-file prototype (React + Babel inline). All data (personas, task set, run timeline, 10 marketplace agents with prompts/tools/routing, upgrade diff) lives in clearly-commented data blocks near the top of the `<script type="text/babel">`. The CSS design system is the `<style>` block in `<head>`. Read these for exact copy, timings, and values.
