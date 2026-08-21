# Codex runner proof-of-contract and adopted boundary (MP-04)

This record is deliberately separate from the execution plan. It captures the
transport proof, the original native-write rejection, and the boundary ultimately
adopted for the Codex driver.

## Proven transport contract

`core/src/drivers/codex-runner.ts` constructs an invocation that:

- runs `codex exec` in the supplied Git worktree with `--cd`;
- requests JSONL machine events with `--json`;
- supplies a per-run JSON Schema using `--output-schema` and reads the final
  response from `--output-last-message`;
- restricts execution to `read-only` or `workspace-write` (never
  `danger-full-access` or a sandbox-bypass flag);
- starts with `--ephemeral --ignore-user-config`, so it neither persists a
  Codex session nor loads or changes a user's MCP configuration; and
- injects local MCP server definitions through command-line config overrides,
  held only in the child process arguments.

The runner's temporary schema/output directory is private (`0600`) and removed
on success, spawn failure, invalid JSON, or non-zero Codex exit.

## Local smoke evidence (2026-08-21)

Using a temporary Git fixture (removed after each run), the local signed-in
Codex CLI completed:

- a `read-only` run with six JSONL events and a schema-valid final object; and
- a `workspace-write` run with nine JSONL events, a schema-valid final object,
  and exactly one expected fixture-file write.

An additional read-only run injected Swarm's existing `result-server` MCP
through the per-run overrides and instructed Codex to call `submit_result`.
It returned a schema-valid final response but did **not** create the MCP result
artifact. That is not treated as a successful MCP proof.

## Original permission-broker constraint

Codex `exec` currently exposes its native filesystem and shell tools under the
selected sandbox. Its documented CLI has no per-invocation tool allowlist or
mechanism to force filesystem/shell mutations through Swarm's existing
`permission-proxy` MCP server. Adding that MCP server would be additive: the
agent could still use native workspace-write tools and bypass the broker's
write-scope and approval decisions.

The failed `result-server` artifact above additionally means this CLI version's
per-run MCP tool invocation needs a dedicated, isolated interoperability proof
before it can be relied on for structured result submission.

That result correctly rejected native Codex writes as a Swarm execution mode.
The original options were:

1. Codex provides a supported per-run way to disable native mutating tools and
   expose only Swarm's permission proxy; or
2. Swarm adopts an equivalently enforced boundary.

The existing `workspace-write` sandbox is necessary isolation, but it is not a
substitute for Swarm's task-level permission broker.

## Adopted implementation (MP-05, 2026-08-21)

Swarm adopted a stricter design than a native-write equivalence: **Codex is read-only for
every role.** It cannot mutate the repository through native tools or MCP. For a coder task
it returns a schema-constrained unified patch proposal with a full base Git SHA and an exact
changed-path list. Swarm-owned code then:

1. rejects malformed, binary, renamed, unsafe, secret, metadata, stale-base, or
   out-of-scope proposals;
2. asks the existing permission broker to approve the exact patch metadata; and
3. rechecks the base and patch immediately before applying the exact diff.

This broker-mediated patch boundary preserves a single mutation authority while allowing
Codex to contribute coding work. It is stronger than a writable worktree followed by
post-run inspection. Native-write Codex remains deferred until an OS-enforced,
path-restricted container/VM design is proven.
