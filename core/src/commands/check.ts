// Phase 0 exit-criteria test.
// Verifies all four seams without making any real Claude API calls.

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { swarmDir, stateFile, getState, updateTask, appendLog, writeFinding, addTask } from '../state/repo.js';
import { dispatch }          from '../dispatch/index.js';
import { bus }               from '../state/events.js';
import { getConfigOptional } from '../config.js';
import type { Task }         from '../state/types.js';

function ok(msg: string)   { console.log(`  ✓ ${msg}`); }
function fail(msg: string) { console.error(`  ✗ ${msg}`); process.exitCode = 1; }
function hdr(msg: string)  { console.log(`\n  ${msg}`); }

export async function runCheck(): Promise<void> {
  console.log('\n  Phase 0 — exit criteria check\n');

  // ── Seam 1: Config / secrets boundary ───────────────────────────────────────
  hdr('1. Config boundary (Principle 4)');
  const cfg = getConfigOptional();
  if (cfg.anthropicApiKey) {
    ok(`ANTHROPIC_API_KEY set (${cfg.anthropicApiKey.slice(0, 12)}…)`);
  } else {
    fail('ANTHROPIC_API_KEY not set — Phase 1 will not work until this is exported');
  }
  ok(`port = ${cfg.port}, owner = "${cfg.owner}", leaseSeconds = ${cfg.leaseSeconds}`);

  // ── Seam 2: State repository interface (Principle 3) ────────────────────────
  hdr('2. State repository (Principle 3)');

  // Work in a temp dir so we don't clobber any real workspace.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-check-'));
  const origCwd = process.cwd();
  process.chdir(tmp);

  try {
    // init workspace
    const { initWorkspace } = await import('../state/repo.js');
    initWorkspace('check-project', 'Phase 0 exit-criteria test', 'bugfix');
    ok('.swarm/state.json created');

    // read
    const state = getState();
    if (state.project !== 'check-project') throw new Error('read mismatch');
    ok('getState() round-trips correctly');

    // add a task
    const task: Task = {
      id: 't0', title: 'stub task', status: 'pending',
      owner: 'me', assignee: 'coder', depends_on: [],
      artifacts: [], result_ref: null, attempts: 0,
    };
    addTask(task);
    const s2 = getState();
    if (!s2.tasks.find(t => t.id === 't0')) throw new Error('addTask not persisted');
    ok('addTask() persists to disk');

    // update status (only PM does this — enforced by convention in Phase 0, code in Phase 2)
    updateTask('t0', { status: 'in_progress', attempts: 1 });
    const s3 = getState();
    if (s3.tasks[0].status !== 'in_progress') throw new Error('updateTask not persisted');
    ok('updateTask() persists status change');

    // log
    appendLog('pm', 'test event');
    const s4 = getState();
    if (!s4.log.find(e => e.event === 'test event')) throw new Error('log not persisted');
    ok('appendLog() persists log entry');

    // write finding
    const findingPath = await writeFinding('t0', '---\ntask: t0\nagent: coder\nverdict: COMPLETE\n---\nStub finding.\n');
    if (!fs.existsSync(findingPath)) throw new Error('finding not written');
    ok('writeFinding() writes findings/t0.md');

    // crash-atomic: verify no .tmp files left behind
    const tmpFile = stateFile() + '.tmp';
    if (fs.existsSync(tmpFile)) fail('stale .tmp file found — atomic write broken');
    else ok('atomic write — no stale .tmp files');

  } catch (e) {
    fail(`state repository: ${(e as Error).message}`);
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ── Seam 3: Dispatch boundary (Principle 2) ──────────────────────────────────
  // Phase 1: dispatch routes to real workers (API key required for coder).
  // The seam check verifies the interface shape is correct, not that a live
  // Claude call succeeds — that's what `swarm eval` is for.
  hdr('3. Dispatch boundary (Principle 2)');
  try {
    const stubTask: Task = {
      id: 't-stub', title: 'echo test', status: 'pending',
      owner: 'me', assignee: 'tester', // tester is a known stub in Phase 1
      depends_on: [], artifacts: [], result_ref: null, attempts: 0,
    };
    const stubState = {
      project: 'test', owner: 'me', goal: '', tier: 'bugfix' as const,
      updated_at: new Date().toISOString(), tasks: [stubTask], log: [],
    };
    const result = await dispatch(stubTask, stubState);
    // Phase 1: tester returns 'failed' (not yet implemented) — that's correct.
    // The seam test confirms dispatch() returns a TaskResult and doesn't throw.
    if (typeof result.status !== 'string' || typeof result.summary !== 'string') {
      throw new Error(`dispatch returned unexpected shape: ${JSON.stringify(result)}`);
    }
    ok(`dispatch(tester) → { status: "${result.status}", summary: "${result.summary.slice(0,60)}" }`);
    ok('dispatch boundary: interface correct (live coder run requires ANTHROPIC_API_KEY + swarm eval)');
  } catch (e) {
    fail(`dispatch: ${(e as Error).message}`);
  }

  // ── Seam 4: Event bus (subscriber side of Principle 3) ──────────────────────
  hdr('4. Event bus (pub/sub for SSE)');
  try {
    let received = false;
    bus.once('swarm', (ev) => { if (ev.type === 'run.completed') received = true; });
    bus.emit('swarm', { type: 'run.completed' });
    if (!received) throw new Error('event not delivered');
    ok('bus.emit() → bus.on() round-trip working');
  } catch (e) {
    fail(`event bus: ${(e as Error).message}`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('');
  if (process.exitCode === 1) {
    console.error('  Phase 0 check FAILED — fix the issues above before Phase 1.\n');
  } else {
    console.log('  Phase 0 check PASSED — all four seams are wired.\n');
    console.log('  Next: implement the PM loop + Coder in dispatch/index.ts (Phase 1).\n');
  }
}
