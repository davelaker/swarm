import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createQuickTaskHandler,
  validateQuickTaskRequest,
} from './quick-task.js';
import type { ProviderAvailability } from '../providers/index.js';
import type { QuickTaskPreflight, QuickTaskRunDefinition, QuickTaskSpec } from '../quick-task/index.js';

const providerAvailability: readonly ProviderAvailability[] = [
  {
    provider: 'openai',
    enabled: true,
    cliAvailable: true,
    apiKeyConfigured: false,
    availableAuthModes: ['subscription'],
  },
];

function quickTaskSpec(): QuickTaskSpec {
  return {
    goal: 'Fix the reconnect banner',
    declaredWriteScope: ['ui/src/components/**'],
    verificationCommands: ['cd ui && npm run typecheck && npm test'],
    acceptanceCriteria: [
      'Implement the requested change: Fix the reconnect banner',
      'Modify only the declared write scope: ui/src/components/**',
      'Verify with: cd ui && npm run typecheck && npm test',
      'Leave unrelated files unchanged.',
    ],
    route: {
      provider: 'openai',
      model: 'gpt-5.3-codex',
      reasoningEffort: 'low',
      rationale: 'Small contained execution prefers the Codex/GPT execution model.',
      fallback: null,
      requiresConfirmation: false,
      writeScope: ['ui/src/components/**'],
    },
  };
}

function quickTaskDefinition(): QuickTaskRunDefinition {
  return {
    executionShape: 'quick_task',
    goal: 'Fix the reconnect banner',
    tier: 'bugfix',
    charter: {
      constraints: ['Keep the fix scoped.'],
      nongoals: ['Do not broaden the write scope.'],
      questions: [],
      taskGraph: [
        {
          id: 't_quick',
          assignee: 'coder',
          title: 'Apply the reconnect fix',
          depends_on: [],
          route: quickTaskSpec().route,
        },
      ],
    },
    taskGraph: [
      {
        id: 't_quick',
        assignee: 'coder',
        title: 'Apply the reconnect fix',
        depends_on: [],
        route: quickTaskSpec().route,
      },
    ],
  };
}

test('validateQuickTaskRequest accepts instruction and goal aliases', () => {
  assert.deepEqual(validateQuickTaskRequest({
    instruction: '  fix the reconnect banner  ',
  }), {
    ok: true,
    value: { instruction: 'fix the reconnect banner' },
  });
  assert.deepEqual(validateQuickTaskRequest({
    goal: ' tighten retry messaging ',
  }), {
    ok: true,
    value: { instruction: 'tighten retry messaging' },
  });
});

test('validateQuickTaskRequest rejects missing and oversized instructions', () => {
  assert.deepEqual(validateQuickTaskRequest({}), {
    ok: false,
    error: 'instruction required',
  });
  assert.deepEqual(validateQuickTaskRequest({ instruction: '   ' }), {
    ok: false,
    error: 'instruction required',
  });
  assert.deepEqual(validateQuickTaskRequest({ instruction: 'x'.repeat(20_001) }), {
    ok: false,
    error: 'instruction too large (max 20000 chars)',
  });
});

test('quick task handler refuses a second active run before doing more work', async () => {
  const handler = createQuickTaskHandler({
    hasActiveRun: () => true,
  });

  const result = await handler({ instruction: 'fix the reconnect banner' });
  assert.deepEqual(result, {
    status: 409,
    body: { error: 'A run is already in progress' },
  });
});

test('quick task handler returns the git-clean guard error without preflighting', async () => {
  let preflightCalled = false;
  const handler = createQuickTaskHandler({
    getProjectRoot: () => '/repo',
    ensureGitClean: () => {
      throw new Error('dirty tree');
    },
    preflight: () => {
      preflightCalled = true;
      return {
        ok: false,
        escalationReason: 'should not run',
        riskSignals: ['unclear_scope'],
      };
    },
  });

  const result = await handler({ instruction: 'fix the reconnect banner' });
  assert.deepEqual(result, {
    status: 400,
    body: { error: 'dirty tree' },
  });
  assert.equal(preflightCalled, false);
});

test('quick task handler returns structured escalation details without dispatching', async () => {
  let dispatched = false;
  const handler = createQuickTaskHandler({
    getProjectRoot: () => '/repo',
    getProviderAvailability: () => providerAvailability,
    ensureGitClean: () => {},
    preflight: () => {
      return {
        ok: false,
        escalationReason: 'Quick task could not establish a narrow write scope.',
        riskSignals: ['unclear_scope', 'multiple_subsystems'],
      };
    },
    dispatchRun: async () => {
      dispatched = true;
    },
  });

  const result = await handler({ instruction: 'fix auth and the whole frontend' });
  assert.deepEqual(result, {
    status: 200,
    body: {
      ok: true,
      status: 'escalated',
      executionShape: 'quick_task',
      escalationReason: 'Quick task could not establish a narrow write scope.',
      riskSignals: ['unclear_scope', 'multiple_subsystems'],
    },
  });
  assert.equal(dispatched, false);
});

test('quick task handler compiles and dispatches the one-node run when preflight passes', async () => {
  const spec = quickTaskSpec();
  const definition = quickTaskDefinition();
  const calls: {
    preflight?: unknown;
    compiled?: QuickTaskSpec;
    dispatched?: QuickTaskRunDefinition;
  } = {};

  const handler = createQuickTaskHandler({
    getProjectRoot: () => '/repo',
    getProviderAvailability: () => providerAvailability,
    ensureGitClean: () => {},
    preflight: (input): QuickTaskPreflight => {
      calls.preflight = input;
      return {
        ok: true,
        scopeReason: 'Matched the reconnect component.',
        spec,
      };
    },
    compile: (compiledSpec) => {
      calls.compiled = compiledSpec;
      return definition;
    },
    dispatchRun: async (compiledDefinition) => {
      calls.dispatched = compiledDefinition;
    },
  });

  const result = await handler({ goal: 'fix the reconnect banner' });

  assert.equal(result.status, 200);
  if (result.status !== 200 || result.body.status !== 'started') {
    assert.fail('expected a started quick-task response');
  }
  assert.deepEqual(calls.preflight, {
    instruction: 'fix the reconnect banner',
    projectRoot: '/repo',
    providerAvailability,
    budgetClass: 'balanced',
  });
  assert.deepEqual(calls.compiled, spec);
  assert.deepEqual(result.body, {
    ok: true,
    status: 'started',
    executionShape: 'quick_task',
    goal: spec.goal,
    scopeReason: 'Matched the reconnect component.',
    spec: {
      declaredWriteScope: spec.declaredWriteScope,
      verificationCommands: spec.verificationCommands,
      acceptanceCriteria: spec.acceptanceCriteria,
      route: spec.route,
    },
  });

  assert.equal(typeof result.dispatch, 'function');
  await result.dispatch?.();
  assert.deepEqual(calls.dispatched, definition);
});
