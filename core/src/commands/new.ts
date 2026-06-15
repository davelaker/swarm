import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {
  swarmDir,
  stateFile,
  initWorkspace,
  addTask,
  getState,
  appendLog,
  getRoot,
} from '../state/repo.js';
import { classify } from '../agents/classifier.js';
import { runLoop } from '../loop.js';
import { resetControl } from '../loop-control.js';
import { getConfig } from '../config.js';
import { bus } from '../state/events.js';
import type { Task, Tier, RunCharter, TaskGraphEntry } from '../state/types.js';

function pmProgress(step: string): void {
  bus.emit('swarm', { type: 'agent.progress', agent_id: 'pm', step });
}

// ─── Git safety fence ─────────────────────────────────────────────────────────
// Refuses to run if the working tree has uncommitted changes that could be
// clobbered by the Coder. Set SWARM_SKIP_GIT_CHECK=1 to bypass.
// Exported so the server can call it synchronously before returning 200,
// avoiding a race where the SSE run.blocked event fires before the client
// EventSource connects.

export function checkGitClean(cwd: string): void {
  if (process.env.SWARM_SKIP_GIT_CHECK === '1') return;

  try {
    execSync('git rev-parse --git-dir', { cwd, stdio: 'ignore' });
  } catch {
    return; // not a git repo — no fence needed
  }

  let status: string;
  try {
    status = execSync('git status --porcelain', { cwd, encoding: 'utf8' });
  } catch {
    return; // git status failed — proceed cautiously
  }

  // Files swarm itself writes during planning — not user dirt, never a blocker.
  const SWARM_OWNED = new Set<string>(); // no files written pre-Execute

  const dirty = status
    .split('\n')
    .filter(l => l.trim())
    .filter(l => !l.startsWith('??')) // ignore untracked
    .filter(l => !SWARM_OWNED.has(l.slice(3))) // ignore swarm-managed files
    .join('\n')
    .trim();

  if (dirty) {
    const preview = dirty.split('\n').slice(0, 6).join('\n');
    const more = dirty.split('\n').length > 6 ? '\n  …' : '';
    throw new Error(
      `Uncommitted changes detected — commit or stash before running agents:\n\n${preview}${more}\n\nTo bypass: SWARM_SKIP_GIT_CHECK=1`,
    );
  }
}

// ─── Task graph ───────────────────────────────────────────────────────────────

function buildFromPmGraph(entries: TaskGraphEntry[], cfg: ReturnType<typeof getConfig>): Task[] {
  return entries.map(e => ({
    id: e.id,
    title: e.title,
    status: 'pending' as const,
    owner: cfg.owner,
    assignee: e.assignee,
    depends_on: e.depends_on,
    artifacts: [],
    result_ref: null,
    attempts: 0,
    ...(e.model ? { model: e.model } : {}),
  }));
}

// Deterministic gates are STRUCTURALLY enforced — they must run on any run that
// produces code, regardless of whether the graph came from the PM or the classifier
// (the PM must not be able to opt out of the secret scan or the typecheck). Appends
// the checks + visual gates depending on every coder task, unless already present.
function withEnforcedGates(tasks: Task[], cfg: ReturnType<typeof getConfig>): Task[] {
  const coderIds = tasks.filter(t => t.assignee === 'coder').map(t => t.id);
  if (!coderIds.length) {
    return tasks;
  }
  const gate = (id: string, assignee: string, title: string): Task => ({
    id,
    title,
    status: 'pending',
    owner: cfg.owner,
    assignee,
    depends_on: coderIds,
    artifacts: [],
    result_ref: null,
    attempts: 0,
  });
  const extra: Task[] = [];
  if (!tasks.some(t => t.assignee === 'checks')) {
    extra.push(
      gate('t_checks', 'checks', 'Deterministic checks — typecheck + hardcoded-secret scan'),
    );
  }
  if (!tasks.some(t => t.assignee === 'visual')) {
    extra.push(gate('t_visual', 'visual', 'Visual verification — screenshot changed routes'));
  }
  return [...tasks, ...extra];
}

function buildTaskGraph(
  goal: string,
  tier: Tier,
  sensitive: boolean,
  securityAudit: boolean,
  cfg: ReturnType<typeof getConfig>,
): Task[] {
  // Security-first: the goal IS a security audit — security leads, coder applies findings
  if (securityAudit) {
    const auditTask: Task = {
      id: 't1',
      title: `Security audit: ${goal}`,
      status: 'pending',
      owner: cfg.owner,
      assignee: 'security',
      depends_on: [],
      artifacts: [],
      result_ref: null,
      attempts: 0,
    };
    const fixCoder: Task = {
      id: 't2',
      title: 'Apply fixes for all critical/high findings from security audit (.swarm/t1.md)',
      status: 'pending',
      owner: cfg.owner,
      assignee: 'coder',
      depends_on: ['t1'],
      artifacts: [],
      result_ref: null,
      attempts: 0,
    };
    const tester: Task = {
      id: 't3',
      title: 'Run test suite — verify no regressions',
      status: 'pending',
      owner: cfg.owner,
      assignee: 'tester',
      depends_on: ['t2'],
      artifacts: [],
      result_ref: null,
      attempts: 0,
    };
    const reviewer: Task = {
      id: 't4',
      title: 'Code review — correctness, robustness, design',
      status: 'pending',
      owner: cfg.owner,
      assignee: 'reviewer',
      depends_on: ['t2'],
      artifacts: [],
      result_ref: null,
      attempts: 0,
    };
    return [auditTask, fixCoder, tester, reviewer];
  }

  // Standard coder-first graph
  const base: Task = {
    id: 't1',
    title: goal,
    status: 'pending',
    owner: cfg.owner,
    assignee: 'coder',
    depends_on: [],
    artifacts: [],
    result_ref: null,
    attempts: 0,
  };

  if (tier === 'bugfix' && !sensitive) {
    return [base];
  }

  const tester: Task = {
    id: 't2',
    title: 'Run test suite — verify no regressions',
    status: 'pending',
    owner: cfg.owner,
    assignee: 'tester',
    depends_on: ['t1'],
    artifacts: [],
    result_ref: null,
    attempts: 0,
  };
  const security: Task = {
    id: 't3',
    title: 'Security audit — review changed files for vulnerabilities',
    status: 'pending',
    owner: cfg.owner,
    assignee: 'security',
    depends_on: ['t1'],
    artifacts: [],
    result_ref: null,
    attempts: 0,
  };
  const reviewer: Task = {
    id: 't4',
    title: 'Code review — correctness, robustness, design',
    status: 'pending',
    owner: cfg.owner,
    assignee: 'reviewer',
    depends_on: ['t1'],
    artifacts: [],
    result_ref: null,
    attempts: 0,
  };
  // Deterministic gate alongside the LLM reviewers: typecheck + secret scan. A FAIL
  // blocks done and spawns a fix-coder, the same as a CHANGES_REQUESTED review.
  const checks: Task = {
    id: 't5',
    title: 'Deterministic checks — typecheck + hardcoded-secret scan',
    status: 'pending',
    owner: cfg.owner,
    assignee: 'checks',
    depends_on: ['t1'],
    artifacts: [],
    result_ref: null,
    attempts: 0,
  };
  // Advisory visual verification — renders any changed routes and attaches
  // screenshots. Self-skips fast when the run touched no frontend files.
  const visual: Task = {
    id: 't6',
    title: 'Visual verification — screenshot changed routes',
    status: 'pending',
    owner: cfg.owner,
    assignee: 'visual',
    depends_on: ['t1'],
    artifacts: [],
    result_ref: null,
    attempts: 0,
  };

  return [base, tester, security, reviewer, checks, visual];
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runNew(
  goal: string,
  charter?: RunCharter,
  _team?: string[], // informational — graph is built from tier, not PM team list
  branchName?: string,
): Promise<void> {
  const cfg = getConfig();

  // Signal PM is active — visible immediately in the agents panel before
  // any state.json changes land (classification can take 5–15s).
  bus.emit('swarm', { type: 'agent.started', agent_id: 'pm' });
  pmProgress('bootstrapping…');

  // ── Bootstrap workspace ────────────────────────────────────────────────────
  if (!fs.existsSync(stateFile())) {
    const project = path.basename(getRoot());
    pmProgress('initialising workspace…');
    initWorkspace(project, goal);
    console.log(`  ✓ .swarm/ initialised for "${project}"\n`);
  }

  // ── Early state reset — clear tasks and log before classification ──────────
  // Classification takes 5–15s. Without this, the UI snapshot fetch (which
  // happens immediately when the Running tab mounts) would read the previous
  // run's tasks and log, causing stale PM messages and task graph to flash
  // before the post-classify run.classified event arrives.
  const earlyState = {
    ...getState(),
    goal,
    tier: 'feature' as Tier, // provisional — updated after classify
    charter: charter ?? { constraints: [], nongoals: [], questions: [] },
    branchName: branchName,
    tasks: [],
    log: [],
  };
  const tmpEarly = stateFile() + '.tmp';
  fs.writeFileSync(tmpEarly, JSON.stringify(earlyState, null, 2), 'utf8');
  fs.renameSync(tmpEarly, stateFile());

  // ── Tier classification ────────────────────────────────────────────────────
  pmProgress('classifying goal…');
  console.log('  ▸ classifying goal…');
  const cls = await classify(goal);
  console.log(
    `  ✓ tier: ${cls.tier.toUpperCase()}${cls.sensitive ? ' + sensitive path detected' : ''}`,
  );
  console.log(`    ${cls.reasoning}\n`);
  pmProgress(`tier: ${cls.tier}${cls.sensitive ? ' · sensitive' : ''} — building task graph…`);

  // ── Reset abort/pause state from any prior run ─────────────────────────────
  resetControl();

  // ── Update state with real tier ────────────────────────────────────────────
  const freshState = {
    ...getState(), // earlyState already written — tasks=[], log=[]
    tier: cls.tier,
  };
  const tmp = stateFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(freshState, null, 2), 'utf8');
  fs.renameSync(tmp, stateFile());

  // ── Build task graph ───────────────────────────────────────────────────────
  // PM-provided graph takes precedence; fall back to buildTaskGraph for simple runs.
  // Either way the deterministic gates are appended — they are not the PM's to skip.
  let tasks = charter?.taskGraph?.length
    ? buildFromPmGraph(charter.taskGraph, cfg)
    : buildTaskGraph(goal, cls.tier, cls.sensitive, cls.securityAudit, cfg);
  tasks = withEnforcedGates(tasks, cfg);
  for (const t of tasks) addTask(t);
  // Don't echo graph or constraints to the PM chat — the task graph panel shows
  // the structure already, and the user wrote the constraints in Planning.
  pmProgress(
    `graph ready · ${tasks.length} task${tasks.length === 1 ? '' : 's'} · starting agents…`,
  );

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
  const findings = finalState.tasks
    .filter(t => t.result_ref)
    .map(t => `  · ${t.id}: .swarm/${t.result_ref}`);
  if (findings.length) {
    console.log('\n  Findings:');
    findings.forEach(f => console.log(f));
  }
  console.log('');
}
