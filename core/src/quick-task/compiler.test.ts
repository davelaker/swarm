import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileQuickTask, preflightQuickTask, type QuickTaskSpec } from './compiler.js';
import type { ProviderAvailability } from '../providers/index.js';

const openaiAvailable: ProviderAvailability[] = [
  {
    provider: 'openai',
    enabled: true,
    cliAvailable: true,
    apiKeyConfigured: false,
    availableAuthModes: ['subscription'],
  },
  {
    provider: 'anthropic',
    enabled: false,
    cliAvailable: false,
    apiKeyConfigured: false,
    availableAuthModes: [],
  },
];

function spec(): QuickTaskSpec {
  return {
    goal: 'Fix the reconnect banner',
    acceptanceCriteria: ['Banner hides after reconnect'],
    declaredWriteScope: ['ui/src/components/ReconnectBanner.tsx'],
    verificationCommands: ['cd ui && npm test'],
    route: {
      provider: 'openai',
      model: 'gpt-5.3-codex',
      reasoningEffort: 'low',
      rationale: 'Small contained execution prefers Codex.',
      fallback: null,
      requiresConfirmation: false,
      writeScope: ['ui/src/components/ReconnectBanner.tsx'],
    },
  };
}

test('compileQuickTask emits a one-coder quick task graph', () => {
  const compiled = compileQuickTask(spec());

  assert.equal(compiled.executionShape, 'quick_task');
  assert.equal(compiled.tier, 'bugfix');
  assert.equal(compiled.taskGraph.length, 1);
  assert.deepEqual(compiled.taskGraph[0], {
    id: 't_quick',
    assignee: 'coder',
    title: [
      'Fix the reconnect banner',
      '',
      'Acceptance criteria:',
      '- Banner hides after reconnect',
      '',
      'Verification:',
      '- cd ui && npm test',
    ].join('\n'),
    depends_on: [],
    model: 'gpt-5.3-codex',
    effort: 'low',
    route: spec().route,
  });
  assert.deepEqual(compiled.charter.taskGraph, compiled.taskGraph);
});

test('compileQuickTask rejects mismatched route write scope', () => {
  assert.throws(
    () => compileQuickTask({
      ...spec(),
      route: { ...spec().route, writeScope: ['ui/src/other.tsx'] },
    }),
    /route write scope must match/,
  );
});

test('preflightQuickTask infers explicit path scope and route', () => {
  const preflight = preflightQuickTask({
    instruction: 'Fix ui/src/components/ReconnectBanner.tsx so it hides after reconnect',
    projectRoot: process.cwd(),
    providerAvailability: openaiAvailable,
  });

  assert.ok(preflight.ok);
  assert.deepEqual(preflight.spec.declaredWriteScope, ['ui/src/components/ReconnectBanner.tsx']);
  assert.equal(preflight.spec.route.provider, 'openai');
  assert.equal(preflight.spec.route.model, 'gpt-5.3-codex');
});

test('preflightQuickTask escalates when no narrow scope is discovered', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-quick-task-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'unrelated.ts'), 'export const ok = true;\n');

  const preflight = preflightQuickTask({
    instruction: 'Fix the vanished panel',
    projectRoot: root,
    providerAvailability: openaiAvailable,
  });

  assert.ok(!preflight.ok);
  assert.match(preflight.escalationReason, /narrow write scope/);
  assert.deepEqual(preflight.riskSignals, ['unclear_scope']);
});

test('preflightQuickTask escalates sensitive paths', () => {
  const preflight = preflightQuickTask({
    instruction: 'Fix core/src/auth/session.ts',
    projectRoot: process.cwd(),
    providerAvailability: openaiAvailable,
  });

  assert.ok(!preflight.ok);
  assert.deepEqual(preflight.riskSignals, ['security_sensitive']);
});
