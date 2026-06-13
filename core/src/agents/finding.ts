// C2 — gate integrity: finding validation.
// Every finding must pass this before it can influence a task's status.
// Malformed or missing gate fields fail CLOSED (absence ≠ clean).
// DESIGN.md §6.2a + CONTROLS.md C2.

export interface ValidatedFinding {
  task:           string;
  agent:          string;
  schema:         string;
  verdict:        string;
  // System-derived — never taken from what the agent wrote (C2 + threat S1).
  blocksDone:     boolean;
  negotiable:     boolean;
  summary?:       string;
}

// Schema → gate behaviour.
// negotiable:false = Negotiator can never trade this away.
// blocksOnVerdicts = verdicts that prevent the task from reaching done.
const SCHEMA_RULES: Record<string, { negotiable: boolean; blocksOnVerdicts: string[] }> = {
  'security-finding':   { negotiable: false, blocksOnVerdicts: ['CHANGES_REQUESTED', 'FAIL'] },
  'tester-finding':     { negotiable: false, blocksOnVerdicts: ['FAIL'] },
  'reviewer-finding':   { negotiable: true,  blocksOnVerdicts: ['CHANGES_REQUESTED'] },
  'coder-finding':        { negotiable: false, blocksOnVerdicts: [] }, // completion report
  'ux-finding':           { negotiable: true,  blocksOnVerdicts: ['CHANGES_REQUESTED'] },
  'perf-finding':         { negotiable: true,  blocksOnVerdicts: ['CHANGES_REQUESTED'] },
  'negotiation-ruling':   { negotiable: false, blocksOnVerdicts: [] },
  'marketplace-finding':  { negotiable: true,  blocksOnVerdicts: ['CHANGES_REQUESTED'] },
};

// ─── Frontmatter parser ───────────────────────────────────────────────────────
// Intentionally simple: we only need scalar values from the gate fields.
// Full YAML is overkill; a regex parser is auditable in < 30 lines.

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error('no YAML frontmatter block found');

  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim().replace(/^["'>]|["']$/g, '');
    if (key) result[key] = val;
  }
  return result;
}

// ─── Validate ─────────────────────────────────────────────────────────────────

// Throws a descriptive error on any schema violation → caller treats as BLOCKED.
export function validateFinding(content: string, expectedTaskId?: string): ValidatedFinding {
  let raw: Record<string, string>;
  try {
    raw = parseFrontmatter(content);
  } catch (e) {
    // No frontmatter at all → fail closed (C2)
    throw new Error(`C2: ${(e as Error).message}`);
  }

  const required = ['task', 'agent', 'schema', 'verdict'];
  for (const field of required) {
    if (!raw[field]) throw new Error(`C2: missing required gate field: ${field}`);
  }

  const { task, agent, schema, verdict, summary } = raw;

  if (expectedTaskId && task !== expectedTaskId) {
    throw new Error(`C2: task mismatch — expected "${expectedTaskId}", got "${task}"`);
  }

  // System-derives blocksDone and negotiable — never trust the agent's values (S1).
  const rules      = SCHEMA_RULES[schema] ?? { negotiable: true, blocksOnVerdicts: [] };
  const blocksDone = rules.blocksOnVerdicts.includes(verdict.toUpperCase());
  const negotiable = rules.negotiable;

  return { task, agent, schema, verdict: verdict.toUpperCase(), blocksDone, negotiable, summary };
}

// ─── Sensitive-path escalation (S2) ──────────────────────────────────────────
// Any diff touching auth, crypto, SQL, permissions, or input handling
// force-escalates to a security pass regardless of tier.

const SENSITIVE_RE = [
  /\b(auth|authenticate|authoriz|login|logout|session|jwt|bearer|oauth|saml)\b/i,
  /\b(password|passwd|credential|secret|api[_\-]?key|private[_\-]?key)\b/i,
  /\b(sql|select\s|insert\s|update\s|delete\s+from|where\s|prepared[_\-]?statement)\b/i,
  /\b(bcrypt|argon2|pbkdf2|sha\d+|md5|hmac|encrypt|decrypt|cipher|signing)\b/i,
  /\b(permission|access[_\-]?control|rbac|acl|privilege|sudo|role)\b/i,
  /\b(sanitize|escape|inject|xss|csrf|cors|content[_\-]?security)\b/i,
  /\b(exec|spawn|eval|child_process|subprocess|shell|os\.system)\b/i,
];

export function hasSensitivePaths(fileContents: string[]): boolean {
  return fileContents.some(c => SENSITIVE_RE.some(re => re.test(c)));
}
