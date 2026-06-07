import path from 'node:path';
import fs   from 'node:fs';
import { swarmDir, stateFile, initWorkspace, addTask, getState, appendLog } from '../state/repo.js';
import { runLoop }   from '../loop.js';
import { getConfig } from '../config.js';
import type { Task } from '../state/types.js';

export async function runNew(goal: string): Promise<void> {
  const cfg = getConfig(); // throws early if no API key

  // Bootstrap workspace if not yet initialised
  if (!fs.existsSync(stateFile())) {
    const project = path.basename(process.cwd());
    initWorkspace(project, goal);
    console.log(`  ✓ .swarm/ initialised for "${project}"\n`);
  } else {
    // Update the goal in existing state
    const state = getState();
    const updatedState = { ...state, goal, tier: 'tweak' as const };
    // Re-use initWorkspace is not safe here — write directly via repo
    // We just update the in-memory copy then write via a one-off path
    const fs2 = await import('node:fs');
    const tmp  = stateFile() + '.tmp';
    fs2.default.writeFileSync(tmp, JSON.stringify({ ...updatedState, tasks: [], log: [] }, null, 2), 'utf8');
    fs2.default.renameSync(tmp, stateFile());
  }

  // Create the task graph — Phase 1: one task, tweak tier, no deps
  const taskId = `t${Date.now().toString(36)}`; // unique across runs
  const task: Task = {
    id:         taskId,
    title:      goal,
    status:     'pending',
    owner:      cfg.owner,
    assignee:   'coder',
    depends_on: [],
    artifacts:  [],
    result_ref: null,
    attempts:   0,
  };

  addTask(task);
  appendLog('pm', `task graph created: ${taskId} (tweak)`);

  console.log(`  project: ${getState().project}`);
  console.log(`  goal:    ${goal}`);
  console.log(`  tier:    tweak`);
  console.log(`  task:    ${taskId} → coder\n`);

  const result = await runLoop();

  // ── Report ──────────────────────────────────────────────────────────────────
  const icon = result.status === 'done' ? '✓' : '✗';
  console.log(`  ${icon} ${result.status.toUpperCase()} — ${result.message}`);
  console.log(`  total cost: $${result.totalCostUsd.toFixed(4)}\n`);

  if (result.status === 'done') {
    const finalState = getState();
    const doneTask   = finalState.tasks.find(t => t.id === taskId);
    if (doneTask?.result_ref) {
      console.log(`  findings: .swarm/${doneTask.result_ref}\n`);
    }
  }

  process.exit(result.status === 'done' ? 0 : 1);
}
