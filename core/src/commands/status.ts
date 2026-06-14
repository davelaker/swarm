// swarm status — read-only terminal snapshot of .swarm/state.json.
// One-shot: reads and prints, never modifies any file.

import fs from 'node:fs';
import path from 'node:path';
import { swarmDir, stateFile } from '../state/repo.js';
import type { SwarmState } from '../state/types.js';

// ─── Path safety ─────────────────────────────────────────────────────────────

// Returns true only when `child` resolves to a path strictly inside `parent`.
// Prevents path traversal via a malicious result_ref in state.json.
function isWithinDir(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  // A valid child must start with the parent dir followed by the separator,
  // ensuring "parent" itself (or a sibling like "parent-extra") doesn't match.
  return resolvedChild.startsWith(resolvedParent + path.sep);
}

// ─── Finding summary ─────────────────────────────────────────────────────────

// Extract the one-line summary from a finding file.
// Tries the `summary:` YAML frontmatter field first; falls back to the first
// non-empty body line after the closing `---`. Returns '-' on any failure.
function extractSummary(findingPath: string): string {
  try {
    const content = fs.readFileSync(findingPath, 'utf8');
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      for (const line of fmMatch[1].split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 1) continue;
        const key = line.slice(0, colon).trim();
        if (key === 'summary') {
          const val = line
            .slice(colon + 1)
            .trim()
            .replace(/^["']|["']$/g, '');
          if (val) return truncate(val, 60);
        }
      }
      // Fall back: first non-empty body line after frontmatter
      const body = content.slice(fmMatch[0].length).replace(/^\r?\n/, '');
      const firstLine = body.split('\n').find(l => l.trim());
      if (firstLine) return truncate(firstLine.trim().replace(/^#+\s*/, ''), 60);
    }
  } catch {
    /* missing or unreadable — fall through */
  }
  return '-';
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 3) + '...' : s;
}

// ─── Table helpers ────────────────────────────────────────────────────────────

type Row = readonly [string, string, string, string, string];

function printTable(rows: Row[]): void {
  const HEADER: Row = ['ID', 'ASSIGNEE', 'STATUS', 'COST', 'SUMMARY'];
  const all = [HEADER, ...rows];

  // Column widths — max of header and all data cells per column.
  // Use reduce rather than Math.max(...spread) to avoid stack overflow on
  // large task lists (JS spread is limited by the engine's call-stack depth).
  const widths = HEADER.map((_, ci) =>
    all.reduce((max, r) => (r[ci].length > max ? r[ci].length : max), 0),
  );

  const fmt = (row: Row) => row.map((cell, ci) => cell.padEnd(widths[ci])).join('  ');

  console.log(`  ${fmt(HEADER)}`);
  console.log(`  ${widths.map(w => '-'.repeat(w)).join('  ')}`);
  for (const row of rows) {
    console.log(`  ${fmt(row)}`);
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function runStatus(): void {
  const sf = stateFile();

  if (!fs.existsSync(sf)) {
    console.log('\n  No .swarm/state.json found in the current directory.');
    console.log('  Run `swarm init` to initialise a workspace, or');
    console.log('  `swarm new "<goal>"` to start a run.\n');
    return;
  }

  let state: SwarmState;
  try {
    state = JSON.parse(fs.readFileSync(sf, 'utf8')) as SwarmState;
  } catch (e) {
    console.error(`\n  Error reading ${sf}: ${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const dir = swarmDir();
  const tasks = state.tasks ?? [];

  // Sum per-task costs stored by the loop (absent on agent-sdk driver runs)
  const totalCost = tasks.reduce((s, t) => s + (t.cost_usd ?? 0), 0);
  const costStr = totalCost > 0 ? `$${totalCost.toFixed(4)}` : '-';

  console.log('');
  console.log(`  project: ${state.project}`);
  console.log(`  goal:    ${truncate(state.goal, 80)}`);
  console.log(`  tier:    ${state.tier}`);
  console.log(`  cost:    ${costStr}`);
  console.log('');

  if (!tasks.length) {
    console.log('  No tasks.\n');
    return;
  }

  const rows: Row[] = tasks.map(t => {
    const taskCost = t.cost_usd != null ? `$${t.cost_usd.toFixed(4)}` : '-';

    // Guard against a malicious or corrupted result_ref escaping .swarm/.
    const candidatePath = t.result_ref ? path.join(dir, t.result_ref) : null;
    const summaryPath = candidatePath && isWithinDir(dir, candidatePath) ? candidatePath : null;
    const summary = summaryPath ? extractSummary(summaryPath) : '-';
    return [t.id, t.assignee, t.status, taskCost, summary] as const;
  });

  printTable(rows);
  console.log('');
}
