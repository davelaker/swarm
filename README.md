# Agent Swarm

Agent Swarm is a local-first coding orchestrator that plans work, assigns it to specialised agents, and enforces review and approval gates. It helps a single developer run a heterogeneous Claude and Codex/GPT team without handing either provider unrestricted control of a repository.

## Quick start

Prerequisites: Node.js 22+, npm, Git, and at least one authenticated local provider CLI.

```sh
git clone <your-swarm-repository-url>
cd swarm/core
npm install
cd ../ui
npm install
cd ../core
swarm init
swarm dev
```

Open the local dashboard, create a plan, inspect its proposed routes, confirm any cost-class warnings, and start the run. See [docs](docs/README.md) for the design corpus and build details.

## Lightweight intake

Swarm can now start with the request instead of requiring a full run up front. The CLI
classifies a bare prompt and exposes explicit shortcuts when you already know the
workflow you want:

```sh
swarm ask "why is this test flaky?"
swarm plan "move sessions to SQLite"
swarm do "fix the reconnect banner"
swarm swarm "replace the authorization layer"
swarm "review the reconnect flow"
```

`ask` and `plan` return terminal PM outcomes without creating a charter or task graph.
Bare prompts may answer or plan immediately, but write-shaped requests require an
explicit `do` or `swarm` command. `do` keeps the existing run, permission, and
verification boundaries and escalates destructive or otherwise risky wording to the
coordinated workflow.

For example, `swarm do "fix ui/src/components/common/StaleServerBanner.tsx"`
preflights that narrow path and compiles one implementation-owner node. The normal
permission boundary and deterministic verification gates still run before completion.

In the dashboard, the first request in a fresh planning session receives an Answer,
Quick task, Plan, or Coordinated run recommendation. You can accept it, select another
The dashboard uses the same Quick task compiler as `swarm do`.
shape, dismiss it into normal planning, or continue normally when the classifier server
is unavailable. See the [lightweight workflow design and delivery status](docs/LIGHTWEIGHT_WORKFLOW.md)
for the product rationale and remaining compact-run work.

## Provider setup

Swarm detects provider availability without reading CLI configuration, account details, tokens, or API-key values. It runs only `<cli> --version` and checks whether the relevant environment variable is present.

### Claude

Use either a signed-in `claude` CLI for subscription-backed local execution, or `ANTHROPIC_API_KEY` for the Anthropic API driver.

### Codex/GPT

Install and sign in to the local `codex` CLI. The current OpenAI route requires that CLI even when `OPENAI_API_KEY` is set; an OpenAI API-only driver is not implemented yet.

Choose the enabled provider set and startup default with environment variables:

```sh
export SWARM_ENABLED_PROVIDERS=anthropic,openai
export SWARM_DEFAULT_PROVIDER=auto
```

`SWARM_DEFAULT_PROVIDER` accepts `auto`, `anthropic`, or `openai`. `auto` selects an authenticated enabled provider deterministically, preferring Anthropic. An explicit unavailable provider fails closed rather than silently using another account. `SWARM_DRIVER=agent-sdk`, `api-key`, or `codex` remains available for compatibility with the older single-driver configuration.

Never put credentials in committed configuration files. Swarm does not expose credential values in provider availability responses or telemetry.

## Per-task routing and overrides

The router assigns a route to each LLM task: provider, model, optional reasoning effort, rationale, fallback, cost-confirmation requirement, and declared write scope. It recommends rather than silently upgrades:

| Work | Default recommendation |
| --- | --- |
| Large planning or ambiguous architecture | Fable, then Opus |
| Large, risky, or multi-file coding | Opus |
| Small, contained execution | GPT-5.4 with low or medium effort |
| Deterministic checks | No model |
| High-stakes review | A different available provider from the implementer |

The Planning screen shows detected providers, route rationale, fallback, effort, and any confirmation warning. You may select a compatible, currently available alternative before execution. Once a task starts, its route is immutable; a fallback requires an explicit approved route rather than an automatic upgrade. Independent tasks with disjoint declared write scopes may run concurrently on different providers. Unknown or overlapping write scopes are serialised.

## Codex safety boundary

Codex never receives native repository write permission in Swarm. Every Codex session runs with the read-only sandbox. A coding task returns only a schema-constrained unified-diff proposal containing its base Git revision and declared changed paths. Swarm then:

1. validates the patch format, paths, declared task scope, and base revision;
2. asks the existing permission broker to approve the exact patch metadata; and
3. rechecks the revision and patch before applying the exact diff itself.

Binary patches, renames, unsafe paths, `.env` files, Git/Swarm metadata, stale bases, and out-of-scope writes are rejected. This is intentionally stronger than allowing a writable Codex worktree followed by post-run diff inspection.

Native-write Codex mode is not available. It remains deferred until Swarm has a separately proven OS-enforced container or VM boundary with path-restricted writable mounts, no ambient credentials, default-deny network, and reliable cleanup.

## Privacy and limits

- Provider detection and telemetry retain only safe metadata such as provider, route, duration, retries, verdict, and cost/quota class. They exclude prompts, finding bodies, raw provider logs, token contents, and credentials.
- Local execution is not a complete sandbox for every driver. The broader Phase 4.5 execution-isolation work (credential scrubbing, default-deny egress, and resource limits) is still required before treating arbitrary third-party agents as safe.
- Model IDs come from Swarm's capability catalog and may change as providers evolve; routing policy names capabilities and roles rather than hardcoding a permanent product version.

## Verification

```sh
cd core && npm test
cd ../ui && npm run typecheck && npm run lint && npm test && npm run build
```

The repository is licensed under its included license, if present.
