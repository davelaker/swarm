import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateQuickTaskPolicy,
  type QuickTaskPolicyInput,
  type QuickTaskPolicyReason,
} from './policy.js';

test('evaluateQuickTaskPolicy handles representative quick-task safety cases', () => {
  const cases: Array<{
    name: string;
    input: QuickTaskPolicyInput;
    expectedAllowed: boolean;
    expectedReasons: QuickTaskPolicyReason[];
  }> = [
    {
      name: 'safe one-file ui change stays quick task',
      input: {
        approvedWriteScope: ['ui/src/components/reconnect-banner.tsx'],
        discoveredPaths: ['ui/src/components/reconnect-banner.tsx'],
        estimatedEffort: 'small',
        requestedShape: 'quick_task',
        verificationScope: 'focused',
      },
      expectedAllowed: true,
      expectedReasons: [],
    },
    {
      name: 'safe docs touch stays quick task',
      input: {
        approvedWriteScope: ['README.md'],
        discoveredPaths: ['README.md'],
        requestedShape: 'quick_task',
        verificationScope: 'focused',
      },
      expectedAllowed: true,
      expectedReasons: [],
    },
    {
      name: 'safe focused test change stays quick task',
      input: {
        approvedWriteScope: ['core/src/intake/classify.test.ts'],
        discoveredPaths: ['core/src/intake/classify.test.ts'],
        requestedShape: 'quick_task',
        verificationScope: 'focused',
      },
      expectedAllowed: true,
      expectedReasons: [],
    },
    {
      name: 'ambiguous inspected scope escalates',
      input: {
        approvedWriteScope: [],
        discoveredPaths: [],
        requestedShape: 'quick_task',
      },
      expectedAllowed: false,
      expectedReasons: ['unclear_scope'],
    },
    {
      name: 'auth and security-sensitive work escalates',
      input: {
        approvedWriteScope: ['core/src/auth/**'],
        discoveredPaths: ['core/src/auth/session.ts'],
        requestedShape: 'quick_task',
        touchesSensitivePaths: true,
        verificationScope: 'focused',
      },
      expectedAllowed: false,
      expectedReasons: ['security_sensitive'],
    },
    {
      name: 'migrations still escalate even with an explicit quick-task override',
      input: {
        approvedWriteScope: ['core/migrations/**'],
        discoveredPaths: ['core/migrations/20260821_add_sessions.sql'],
        requestedShape: 'quick_task',
        requiresMigration: true,
        verificationScope: 'focused',
      },
      expectedAllowed: false,
      expectedReasons: ['migration'],
    },
    {
      name: 'destructive operations escalate',
      input: {
        approvedWriteScope: ['core/src/cleanup.ts'],
        discoveredPaths: ['core/src/cleanup.ts'],
        requestedShape: 'quick_task',
        requiresDestructiveOperation: true,
        verificationScope: 'focused',
      },
      expectedAllowed: false,
      expectedReasons: ['destructive_change'],
    },
    {
      name: 'multi-system work escalates',
      input: {
        approvedWriteScope: ['ui/**', 'core/**'],
        discoveredPaths: ['ui/src/components/reconnect-banner.tsx', 'core/src/server/intake.ts'],
        requestedShape: 'quick_task',
        verificationScope: 'focused',
      },
      expectedAllowed: false,
      expectedReasons: ['multiple_subsystems'],
    },
    {
      name: 'scope expansion escalates before widening writes',
      input: {
        approvedWriteScope: ['ui/**'],
        discoveredPaths: ['ui/src/components/reconnect-banner.tsx', 'core/src/server/intake.ts'],
        requestedShape: 'quick_task',
        verificationScope: 'focused',
      },
      expectedAllowed: false,
      expectedReasons: ['scope_expansion', 'multiple_subsystems'],
    },
    {
      name: 'broad verification and open architecture decisions escalate',
      input: {
        approvedWriteScope: ['core/src/intake/**'],
        discoveredPaths: ['core/src/intake/classify.ts'],
        requestedShape: 'quick_task',
        unresolvedDecision: true,
        verificationScope: 'broad',
      },
      expectedAllowed: false,
      expectedReasons: ['unresolved_decision', 'broad_verification'],
    },
    {
      name: 'explicit plan override blocks quick-task execution',
      input: {
        approvedWriteScope: ['ui/**'],
        discoveredPaths: ['ui/src/components/reconnect-banner.tsx'],
        requestedShape: 'plan',
        verificationScope: 'focused',
      },
      expectedAllowed: false,
      expectedReasons: ['explicit_plan_request'],
    },
    {
      name: 'explicit coordinated-run override blocks quick-task execution',
      input: {
        approvedWriteScope: ['ui/**'],
        discoveredPaths: ['ui/src/components/reconnect-banner.tsx'],
        requestedShape: 'coordinated_run',
        verificationScope: 'focused',
      },
      expectedAllowed: false,
      expectedReasons: ['explicit_coordinated_run'],
    },
    {
      name: 'large estimated effort escalates',
      input: {
        approvedWriteScope: ['ui/**'],
        discoveredPaths: ['ui/src/components/reconnect-banner.tsx'],
        estimatedEffort: 'large',
        requestedShape: 'quick_task',
        verificationScope: 'focused',
      },
      expectedAllowed: false,
      expectedReasons: ['large_effort'],
    },
  ];

  for (const scenario of cases) {
    const verdict = evaluateQuickTaskPolicy(scenario.input);
    assert.equal(verdict.allowed, scenario.expectedAllowed, scenario.name);
    assert.deepEqual(verdict.reasons, scenario.expectedReasons, scenario.name);
    assert.ok(verdict.summary.length > 0, scenario.name);
  }
});
