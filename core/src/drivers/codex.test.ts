import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexDriver } from './codex.js';
import type { CodexRunOptions, CodexRunResult } from './codex-runner.js';
import type { SwarmState, Task } from '../state/types.js';
import { PM_RESPONSE_SCHEMA, runPmInference } from '../pm/index.js';

const task: Task = {
  id: 't1', title: 'Change an allowed file', status: 'pending', owner: 'me', assignee: 'coder',
  depends_on: [], artifacts: ['src/allowed.ts'], result_ref: null, attempts: 0,
};
const state: SwarmState = {
  project: 'fixture', owner: 'me', goal: 'Make the fixture better', tier: 'feature', updated_at: new Date().toISOString(), tasks: [task], log: [],
};
const proposal = {
  base_revision: 'a'.repeat(40),
  changed_paths: ['src/allowed.ts'],
  patch: 'diff --git a/src/allowed.ts b/src/allowed.ts\n--- a/src/allowed.ts\n+++ b/src/allowed.ts\n@@ -1 +1 @@\n-old\n+new\n',
};

function response(output: Record<string, unknown>): CodexRunResult {
  return { events: [], output };
}

test('Codex coder uses a read-only session and delegates its exact patch to Swarm', async () => {
  let options: CodexRunOptions | undefined;
  let applied: unknown;
  const driver = createCodexDriver({
    root: () => '/repo',
    run: async (opts) => {
      options = opts;
      return response({ verdict: 'COMPLETE', summary: 'Updated fixture', detail: 'Used the broker boundary.', patch_proposal: proposal });
    },
    applyPatch: async (opts) => {
      applied = opts;
      return { changedPaths: ['src/allowed.ts'] };
    },
  });

  const result = await driver.runCoder(task, state, '/worktree');

  assert.equal(options?.sandbox, 'read-only');
  assert.equal(options?.cwd, '/worktree');
  assert.match(options?.prompt ?? '', /Do not attempt to write files/);
  assert.deepEqual(applied, {
    agentId: 't1', worktreePath: '/worktree', writeScope: ['src/allowed.ts'], proposal,
  });
  assert.deepEqual(result.filesChanged, ['src/allowed.ts']);
  assert.equal(result.verdict, 'COMPLETE');
});

test('Codex coder refuses to apply a patch without an isolated worktree', async () => {
  const driver = createCodexDriver({
    root: () => '/repo',
    run: async () => response({ verdict: 'COMPLETE', summary: 'Updated fixture', detail: 'Used the broker boundary.', patch_proposal: proposal }),
  });
  await assert.rejects(() => driver.runCoder(task, state), /requires an isolated worktree/);
});

test('read-only Codex roles map schema outputs to the AgentDriver contract', async () => {
  const outputs = [
    { verdict: 'PASS', summary: 'Tests passed', detail: 'node --test passed.' },
    { verdict: 'APPROVED', summary: 'Secure', detail: 'No issue.', findings: [] },
    { verdict: 'APPROVED', summary: 'Reviewed', detail: 'No issue.', findings: [] },
    { verdict: 'ADVISORY', summary: 'Advice', detail: 'No changes.', findings: [] },
    { decision: 'SPAWN_FIX', target_task_ids: ['t1'], reasoning: 'Fix it.' },
    { summary: 'Found it', digest: 'Relevant fact.', relevant_files: ['src/allowed.ts'] },
    { summary: 'Research', digest: 'Relevant fact.', relevant_files: ['src/allowed.ts'] },
    { learnings: '- Keep the boundary.' },
    { updated_files: [], summary: 'No docs update proposed.' },
  ];
  const options: CodexRunOptions[] = [];
  const driver = createCodexDriver({
    root: () => '/repo',
    run: async (opts) => {
      options.push(opts);
      const output = outputs.shift();
      assert.ok(output, 'test supplied an output for every role');
      return response(output);
    },
  });
  const specialist = { id: 'specialist', name: 'Specialist', prompt: 'Assess', instructions: '', model: '', grantedTools: [], grantedConnectors: [], enabled: true, version: '1' };

  assert.equal((await driver.runTester(task, state)).verdict, 'PASS');
  assert.equal((await driver.runSecurity(task, state)).verdict, 'APPROVED');
  assert.equal((await driver.runReviewer(task, state)).verdict, 'APPROVED');
  assert.equal((await driver.runMarketplaceAgent(task, state, specialist)).verdict, 'ADVISORY');
  assert.deepEqual(await driver.runNegotiator({ goal: state.goal, blocked: [], tasks: [] }), { decision: 'SPAWN_FIX', targetTaskIds: ['t1'], reasoning: 'Fix it.' });
  assert.deepEqual(await driver.runScout('Where?'), { summary: 'Found it', digest: 'Relevant fact.', relevantFiles: ['src/allowed.ts'] });
  assert.deepEqual(await driver.runSpecialistResearch(specialist, 'Where?'), { summary: 'Research', digest: 'Relevant fact.', relevantFiles: ['src/allowed.ts'] });
  assert.deepEqual(await driver.runScribe({ goal: '', constraints: [], nongoals: [], findings: [], filesChanged: [], existingMemory: '' }), { learnings: '- Keep the boundary.' });
  assert.deepEqual(await driver.runDocsScribe({ goal: '', tier: 'feature', findings: [], filesChanged: [], docFiles: [] }), { updatedFiles: [], summary: 'No docs update proposed.' });
  assert.ok(options.every((option) => option.sandbox === 'read-only'));
});

test('live context never receives connector tools on the read-only Codex driver', async () => {
  const driver = createCodexDriver({ root: () => '/repo', run: async () => { throw new Error('must not run Codex'); } });
  const result = await driver.runLiveContextScout('Check production', ['mcp__dangerous__write']);
  assert.match(result.summary, /unavailable/);
  assert.match(result.digest, /No connector tools/);
});

test('Codex PM inference is read-only and returns data for the shared PM validator', async () => {
  let options: CodexRunOptions | undefined;
  const driver = createCodexDriver({
    run: async (opts) => {
      options = opts;
      return response({
        reply: 'Ready.', team_add: ['coder', 'reviewer'], task_graph: [], enable_execute: true,
      });
    },
  });

  const result = await runPmInference(driver, {
    systemPrompt: 'You are the PM.', conversationPrompt: 'Plan this.', projectRoot: '/repo',
  });

  assert.equal(options?.sandbox, 'read-only');
  assert.equal(options?.cwd, '/repo');
  assert.equal(options?.outputSchema, PM_RESPONSE_SCHEMA);
  assert.match(options?.prompt ?? '', /schema-constrained PM response/);
  assert.equal(result.reply, 'Ready.');
  assert.deepEqual(result.teamAdd, ['coder', 'reviewer']);
});
