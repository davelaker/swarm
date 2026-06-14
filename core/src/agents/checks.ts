// Deterministic quality gate — non-LLM checks that BLOCK a task from reaching done
// the same way an LLM reviewer's CHANGES_REQUESTED does. Where the Tester/Security
// agents reason, this gate runs tools and trusts exit codes: a typecheck and a
// hardcoded-secret scan over the run's changed files. A FAIL spawns a fix-coder via
// the normal remediation path. This is the "structurally enforced" half of the
// product thesis — quality the system guarantees, not quality an agent remembers.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Task, SwarmState } from '../state/types.js';
import { getRoot } from '../state/repo.js';

export interface SecretMatch {
  file: string;
  line: number;
  kind: string;
}

// High-confidence vendor patterns only — a blocking gate must not false-positive on
// legitimate code. Lower-signal heuristics (generic "secret = '...'" assignments)
// are deliberately omitted; they belong in an advisory pass, not a hard block.
const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { kind: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'GitHub token', re: /\bgh[posru]_[A-Za-z0-9]{36,}\b/ },
  { kind: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { kind: 'Stripe live secret key', re: /\bsk_live_[0-9A-Za-z]{16,}\b/ },
];

// Pure: scan file contents for hardcoded secrets. Lines that read from the
// environment are skipped — those reference a secret, they don't embed one.
export function scanSecrets(files: { path: string; content: string }[]): SecretMatch[] {
  const out: SecretMatch[] = [];
  for (const f of files) {
    const lines = f.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/process\.env|import\.meta\.env|os\.environ|getenv|System\.getenv/.test(line)) {
        continue;
      }
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(line)) {
          out.push({ file: f.path, line: i + 1, kind: p.kind });
          break;
        }
      }
    }
  }
  return out;
}

// Which typecheck command to run, if any — conservative so non-TS projects skip it.
function detectTypecheckCmd(root: string): string | null {
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.typecheck) {
        return 'npm run typecheck';
      }
    } catch {
      /* unreadable package.json — fall through */
    }
  }
  if (fs.existsSync(path.join(root, 'tsconfig.json'))) {
    return 'npx --no-install tsc --noEmit';
  }
  return null;
}

function runShellCheck(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    let output = `$ ${cmd}\n`;
    const proc = spawn(cmd, { cwd, shell: true });
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ code: null, output: `${output}\n[timed out after ${timeoutMs / 1000}s]` });
    }, timeoutMs);
    proc.stdout.on('data', d => (output += String(d)));
    proc.stderr.on('data', d => (output += String(d)));
    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n[could not run: ${(err as Error).message}]` });
    });
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

// Read changed files (bounded) so the secret scan has content to work on.
function readChangedFiles(root: string, relPaths: string[]): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const rel of relPaths) {
    try {
      const abs = path.resolve(root, rel);
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > 512 * 1024) {
        continue; // skip directories and very large files
      }
      out.push({ path: rel, content: fs.readFileSync(abs, 'utf8') });
    } catch {
      /* deleted/unreadable — skip */
    }
  }
  return out;
}

interface CheckOutcome {
  name: string;
  ok: boolean;
  detail: string;
}

function checksFinding(
  task: Task,
  verdict: string,
  summary: string,
  results: CheckOutcome[],
): string {
  const body = results
    .map(
      r => `### ${r.ok ? '✓' : '✗'} ${r.name}\n\n\`\`\`\n${r.detail.trim().slice(-1500)}\n\`\`\``,
    )
    .join('\n\n');
  return [
    '---',
    `task: ${task.id}`,
    'agent: checks',
    'schema: checks-finding',
    `verdict: ${verdict}`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    '---',
    '',
    '## Deterministic checks',
    '',
    body,
    '',
  ].join('\n');
}

// Run the deterministic gate for a task. Returns a finding the loop treats exactly
// like any other gate: FAIL blocks done and triggers a fix-coder.
export async function runDeterministicChecks(
  task: Task,
  state: SwarmState,
): Promise<{ verdict: string; summary: string; findingMarkdown: string }> {
  const root = getRoot();
  const results: CheckOutcome[] = [];

  const tc = detectTypecheckCmd(root);
  if (tc) {
    const r = await runShellCheck(tc, root, 120_000);
    results.push({ name: `typecheck (${tc})`, ok: r.code === 0, detail: r.output });
  }

  const changed = [
    ...new Set(state.tasks.filter(t => t.assignee === 'coder').flatMap(t => t.artifacts ?? [])),
  ];
  const files = readChangedFiles(root, changed);
  const secrets = scanSecrets(files);
  results.push({
    name: 'secret scan',
    ok: secrets.length === 0,
    detail: secrets.length
      ? secrets.map(s => `${s.file}:${s.line} — ${s.kind}`).join('\n')
      : `Scanned ${files.length} changed file(s); no hardcoded secrets found.`,
  });

  const failed = results.filter(r => !r.ok);
  const verdict = failed.length ? 'FAIL' : 'PASS';
  const summary = failed.length
    ? `${failed.length} check${failed.length === 1 ? '' : 's'} failed: ${failed.map(f => f.name).join(', ')}`
    : `All deterministic checks passed: ${results.map(r => r.name).join(', ')}`;

  return { verdict, summary, findingMarkdown: checksFinding(task, verdict, summary, results) };
}
