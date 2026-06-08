import path from 'node:path';
import fs   from 'node:fs';
import { swarmDir, stateFile, initWorkspace, addTask, getState, appendLog } from '../state/repo.js';
import { classify }  from '../agents/classifier.js';
import { runLoop }   from '../loop.js';
import { getConfig } from '../config.js';
import type { Task, Tier } from '../state/types.js';

// Build the initial task graph for each tier (DESIGN.md §9).
// The loop adds more tasks at runtime (e.g., S2 escalation, remediation).
function buildTaskGraph(goal: string, tier: Tier, sensitive: boolean, cfg: ReturnType<typeof getConfig>): Task[] {
  const base: Task = {
    id: 't1', title: goal, status: 'pending',
    owner: cfg.owner, assignee: 'coder',
    depends_on: [], artifacts: [], result_ref: null, attempts: 0,
  };

  if (tier === 'tweak' && !sensitive) {
    return [base];
  }

  // feature / greenfield / sensitive tweak
  const tester: Task = {
    id: 't2', title: `Test: ${goal}`, status: 'pending',
    owner: cfg.owner, assignee: 'tester',
    depends_on: ['t1'], artifacts: [], result_ref: null, attempts: 0,
  };
  const security: Task = {
    id: 't3', title: `Security review: ${goal}`, status: 'pending',
    owner: cfg.owner, assignee: 'security',
    depends_on: ['t1'], artifacts: [], result_ref: null, attempts: 0,
  };

  return [base, tester, security];
}

export async function runNew(goal: string): Promise<void> {
  const cfg = getConfig();

  // ── Bootstrap workspace ────────────────────────────────────────────────────
  if (!fs.existsSync(stateFile())) {
    const project = path.basename(process.cwd());
    initWorkspace(project, goal);
    console.log(`  ✓ .swarm/ initialised for "${project}"\n`);
  }

  // ── Tier classification (PM's first action — DESIGN.md §9) ────────────────
  console.log('  ▸ classifying goal…');
  const cls = await classify(goal);
  console.log(`  ✓ tier: ${cls.tier.toUpperCase()}${cls.sensitive ? ' + sensitive path detected' : ''}`);
  console.log(`    ${cls.reasoning}\n`);

  // Reset state (fresh run — keep workspace, clear previous tasks/log)
  const freshState = {
    ...getState(),
    goal,
    tier: cls.tier,
    tasks: [],
    log: [],
  };
  const fsFresh = await import('node:fs');
  const tmp = stateFile() + '.tmp';
  fsFresh.default.writeFileSync(tmp, JSON.stringify(freshState, null, 2), 'utf8');
  fsFresh.default.renameSync(tmp, stateFile());

  // ── Build task graph ───────────────────────────────────────────────────────
  const tasks = buildTaskGraph(goal, cls.tier, cls.sensitive, cfg);
  for (const t of tasks) addTask(t);
  appendLog('pm', `graph: ${tasks.map(t => `${t.id}→${t.assignee}`).join(', ')} [${cls.tier}]`);

  console.log(`  project: ${getState().project}`);
  console.log(`  goal:    ${goal}`);
  console.log(`  tier:    ${cls.tier}`);
  console.log(`  graph:   ${tasks.map(t => t.id + ':' + t.assignee).join(' → ')}\n`);

  // ── Run the PM loop ────────────────────────────────────────────────────────
  const result = await runLoop();

  // ── Report ─────────────────────────────────────────────────────────────────
  const icon = result.status === 'done' ? '✓' : '✗';
  console.log(`  ${icon} ${result.status.toUpperCase()} — ${result.message}`);
  if (result.totalCostUsd > 0) {
    console.log(`  total cost: $${result.totalCostUsd.toFixed(4)}`);
  }

  const finalState = getState();
  const findings   = finalState.tasks.filter(t => t.result_ref).map(t => `  · ${t.id}: .swarm/${t.result_ref}`);
  if (findings.length) {
    console.log('\n  Findings:');
    findings.forEach(f => console.log(f));
  }
  console.log('');
  // Note: no process.exit() here — callers decide exit behaviour.
  // The CLI wrapper in index.ts calls process.exit(); the server calls this
  // fire-and-forget and doesn't need the process to end.
}
