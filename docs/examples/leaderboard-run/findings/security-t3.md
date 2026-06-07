---
task: t3
agent: security
schema: security-finding
verdict: CHANGES_REQUESTED
summary: SQL injection in the season filter — user input interpolated into the query string
severity: HIGH
blocks_done: true
negotiable: false
findings:
  - id: SEC-1
    severity: HIGH
    type: SQL Injection (CWE-89)
    location: lib/arena_queries.ext :: topWinRates($season)
recommended_followups:
  - "Rebind the season filter as a parameterised query before this can reach done"
---

## Verdict: CHANGES_REQUESTED (1 high-severity issue)

This must not reach `done` until SEC-1 is resolved.

### SEC-1 · SQL Injection · HIGH · `lib/arena_queries.ext`

The `season` argument is concatenated directly into the query string:

```
... WHERE season = '" . $season . "' ...
```

`season` originates from a user-supplied command option, so a crafted value
(`2025' OR '1'='1`, or a `;`-chained statement / `UNION SELECT`) alters the query.
Impact ranges from data exfiltration to, depending on DB permissions, write access.

The Coder explicitly self-flagged this in `coder-t1.md` — good. Confirming it is real and
**blocking**.

**Recommendation:** use a bound/parameterised query for the `season` value via the
project's DB wrapper (prepared statement + bind param), exactly as the ranking query
already does for its other inputs. No string interpolation of user data into SQL.

### Things that were fine

- The top-10 cap is enforced server-side (no unbounded fetch).
- The win-rate division guards against divide-by-zero.
- No secrets or tokens touched by this change.

### Note to PM

This is a clean, localised fix (one helper, one parameter). A `feature`-tier remediation
task back to the Coder, followed by a re-review, is the right call — no need to escalate
to the human or invoke the Negotiator, since there's no conflicting guidance here.
