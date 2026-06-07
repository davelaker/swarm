# Mock run: `add-arena-leaderboard`

A concrete walk-through of data flowing across the blackboard for one **feature-tier**
request, captured at a mid-run moment where the security review has **failed** and the
orchestrator is reacting to it. This is the interesting path — it shows the loop doing
real work, not just a happy path.

> All file contents are mock data. Languages/paths are deliberately generic (`.ext`)
> because the swarm is a standalone tool, not tied to any one codebase.

## The request

> "Add a `/leaderboard` command showing the top 10 players by arena win rate, with an
> optional season filter."

## Files in this example

```
state.json                      # the blackboard at the captured moment
findings/
  coder-t1.md                   # Coder: implemented the command (+ self-flagged a risk)
  tester-t2.md                  # Tester: 6 tests, all pass
  security-t3.md                # Security: CHANGES_REQUESTED — SQL injection (HIGH)
  # coder-t4.md  -> not yet written; t4 is in_progress
  # security-t5.md -> not yet written; t5 is pending
```

## The data flow, step by step

This is the loop from `DESIGN.md` §6.3 executing. Watch the `state.json` `log` array — it
is the audit trail of exactly these transitions.

1. **PM classifies & plans.** The PM reads the request, classifies it as **FEATURE**, and
   builds the graph: `t1 (code) → t2 (tests)`, `t1 → t3 (security)`. Security and testing
   are *dependency edges*, not optional steps — this is how "best practices enforced
   structurally" actually shows up in data.

2. **PM dispatches the Coder (t1).** Coder writes code + `findings/coder-t1.md` with
   verdict `COMPLETE`. Crucially, the Coder **self-flags** that the season filter is
   string-interpolated and needs a security look. PM reads the finding, sets `t1 = done`.

3. **PM fans out.** With `t1` done, both `t2` and `t3` have their dependency satisfied, so
   the PM dispatches **both** (Tester and Security can run independently).

4. **Tester (t2) passes** — `findings/tester-t2.md`, verdict `PASS`. Note the Tester's
   explicit scope boundary: "tests pass" ≠ "safe to ship." PM sets `t2 = done`.

5. **Security (t3) fails the review** — `findings/security-t3.md`, verdict
   `CHANGES_REQUESTED`, one HIGH SQL-injection finding (SEC-1), `blocks_done: true`.

6. **The PM reacts — this is the key decision.** The PM reads the security finding and
   does *not* mark anything done. Instead it:
   - keeps `t3` as `changes_requested`,
   - **creates `t4`** ("fix SQL injection", assignee `coder`, `depends_on: [t3]`),
   - **creates `t5`** ("re-review", assignee `security`, `depends_on: [t4]`),
   - dispatches `t4` to the Coder,
   - posts a `pm.message` to the chat explaining all of the above.

   The PM took the Security agent's own steer ("clean, localised fix → remediation task,
   no need to escalate or invoke the Negotiator") — but the *decision was the PM's*,
   recorded in the `log`. Workers never set their own status; the PM arbitrates. (Design
   invariant: only the PM writes `status`.)

7. **Captured moment:** `t4` is `in_progress` (Coder fixing), `t5` is `pending`. When the
   Coder writes `coder-t4.md`, the PM will set `t4 = done`, which satisfies `t5`'s
   dependency, dispatch the re-review, and — if it comes back clean — finally let the
   feature reach `done`.

## What this demonstrates

- **The graph drives the flow.** The PM never "remembers" to run security; the
  `depends_on` edge guarantees it, and a HIGH finding *cannot* be skipped to reach `done`.
- **Findings are structured.** Each has machine-readable frontmatter (`verdict`,
  `severity`, `blocks_done`) so the PM's decision is cheap and deterministic, with the
  human-readable body kept out of `state.json` (off-loaded to files — the cost lever).
- **Failure is a first-class path.** A failed review doesn't halt the system; it spawns
  remediation + re-review tasks and the loop continues. That is the whole point of the
  architecture.
- **Where the Negotiator *would* appear:** if the Coder had pushed back ("this isn't
  exploitable, won't fix") and disagreed with Security, the PM would dispatch the
  **Negotiator** to reconcile — instead of hand-waving the conflict. Here there's no
  conflict, so it stays idle.

## How the UI renders this

See `../../UX.md`. This `state.json` + these findings are exactly what the dashboard's
event stream is built from: `t3`'s amber "changes_requested" node, the `security-t3` card
in the findings feed, the Coder re-activating on `t4`, and the PM's chat message
explaining the remediation.
