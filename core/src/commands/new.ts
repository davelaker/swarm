import { execSync } from 'node:child_process';
import path from 'node:path';
import fs   from 'node:fs';
import { swarmDir, stateFile, initWorkspace, addTask, getState, appendLog } from '../state/repo.js';
import { classify }  from '../agents/classifier.js';
import { runLoop }   from '../loop.js';
import { resetControl } from '../loop-control.js';
import { getConfig } from '../config.js';
import { bus }       from '../state/events.js';
import type { Task, Tier, RunCharter } from '../state/types.js';

function pmProgress(step: string): void {
  bus.emit('swarm', { type: 'agent.progress', agent_id: 'pm', step });
}

// ─── Git safety fence ─────────────────────────────────────────────────────────
// Refuses to run if the working tree has uncommitted changes that could be
// clobbered by the Coder. Set SWARM_SKIP_GIT_CHECK=1 to bypass.

function checkGitClean(): void {
  if (process.env.SWARM_SKIP_GIT_CHECK === '1') return;

  try {
    execSync('git rev-parse --git-dir', { cwd: process.cwd(), stdio: 'ignore' });
  } catch {
    return; // not a git repo — no fence needed
  }

  let status: string;
  try {
    status = execSync('git status --porcelain', { cwd: process.cwd(), encoding: 'utf8' });
  } catch {
    return; // git status failed — proceed cautiously
  }

  const dirty = status
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('??')) // ignore untracked files
    .join('\n')
    .trim();

  if (dirty) {
    const preview = dirty.split('\n').slice(0, 6).join('\n');
    const more    = dirty.split('\n').length > 6 ? '\n  …' : '';
    throw new Error(
      `Uncommitted changes detected — commit or stash before running agents:\n\n${preview}${more}\n\nTo bypass: SWARM_SKIP_GIT_CHECK=1`
    );
  }
}

// ─── Task graph ───────────────────────────────────────────────────────────────

function buildTaskGraph(goal: string, tier: Tier, sensitive: boolean, cfg: ReturnType<typeof getConfig>): Task[] {
  const base: Task = {
    id: 't1', title: goal, status: 'pending',
    owner: cfg.owner, assignee: 'coder',
    depends_on: [], artifacts: [], result_ref: null, attempts: 0,
  };

  if (tier === 'tweak' && !sensitive) {
    return [base];
  }

  const tester: Task = {
    id: 't2', title: 'Run test suite — verify no regressions', status: 'pending',
    owner: cfg.owner, assignee: 'tester',
    depends_on: ['t1'], artifacts: [], result_ref: null, attempts: 0,
  };
  const security: Task = {
    id: 't3', title: 'Security audit — review changed files for vulnerabilities', status: 'pending',
    owner: cfg.owner, assignee: 'security',
    depends_on: ['t1'], artifacts: [], result_ref: null, attempts: 0,
  };
  const reviewer: Task = {
    id: 't4', title: 'Code review — correctness, robustness, design', status: 'pending',
    owner: cfg.owner, assignee: 'reviewer',
    depends_on: ['t1'], artifacts: [], result_ref: null, attempts: 0,
  };

  return [base, tester, security, reviewer];
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runNew(
  goal:     string,
  charter?: RunCharter,
  _team?:   string[],   // informational — graph is built from tier, not PM team list
): Promise<void> {
  const cfg = getConfig();

  // Signal PM is active — visible immediately in the agents panel before
  // any state.json changes land (classification can take 5–15s).
  bus.emit('swarm', { type: 'agent.started', agent_id: 'pm' });
  pmProgress('checking working tree…');

  // ── Git safety check ───────────────────────────────────────────────────────
  checkGitClean();

  // ── Bootstrap workspace ────────────────────────────────────────────────────
  if (!fs.existsSync(stateFile())) {
    const project = path.basename(process.cwd());
    pmProgress('initialising workspace…');
    initWorkspace(project, goal);
    console.log(`  ✓ .swarm/ initialised for "${project}"\n`);
  }

  // ── Tier classification ────────────────────────────────────────────────────
  pmProgress('classifying goal…');
  console.log('  ▸ classifying goal…');
  const cls = await classify(goal);
  console.log(`  ✓ tier: ${cls.tier.toUpperCase()}${cls.sensitive ? ' + sensitive path detected' : ''}`);
  console.log(`    ${cls.reasoning}\n`);
  pmProgress(`tier: ${cls.tier}${cls.sensitive ? ' · sensitive' : ''} — building task graph…`);

  // ── Reset abort/pause state from any prior run ─────────────────────────────
  resetControl();

  // ── Reset state (fresh run) ────────────────────────────────────────────────
  const freshState = {
    ...getState(),
    goal,
    tier:    cls.tier,
    charter: charter ?? { constraints: [], nongoals: [], questions: [] },
    tasks:   [],
    log:     [],
  };
  const fsFresh = await import('node:fs');
  const tmp = stateFile() + '.tmp';
  fsFresh.default.writeFileSync(tmp, JSON.stringify(freshState, null, 2), 'utf8');
  fsFresh.default.renameSync(tmp, stateFile());

  // ── Build task graph ───────────────────────────────────────────────────────
  const tasks = buildTaskGraph(goal, cls.tier, cls.sensitive, cfg);
  for (const t of tasks) addTask(t);
  appendLog('pm', `graph: ${tasks.map(t => `${t.id}→${t.assignee}`).join(', ')} [${cls.tier}]`);
  pmProgress(`graph ready · ${tasks.length} task${tasks.length === 1 ? '' : 's'} · starting agents…`);

  if (charter?.constraints?.length) {
    appendLog('pm', `constraints: ${charter.constraints.join(' | ')}`);
  }

  console.log(`  project: ${getState().project}`);
  console.log(`  goal:    ${goal}`);
  console.log(`  tier:    ${cls.tier}`);
  if (charter?.constraints?.length) {
    console.log(`  constraints: ${charter.constraints.join(', ')}`);
  }
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
}
