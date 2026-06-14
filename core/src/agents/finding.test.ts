import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFinding } from './finding.js';

function fm(schema: string, verdict: string): string {
  return [
    '---',
    'task: t1',
    'agent: a',
    `schema: ${schema}`,
    `verdict: ${verdict}`,
    '---',
    '',
  ].join('\n');
}

test('security/tester/checks findings are non-negotiable and block on their fail verdicts', () => {
  for (const [schema, verdict] of [
    ['security-finding', 'CHANGES_REQUESTED'],
    ['tester-finding', 'FAIL'],
    ['checks-finding', 'FAIL'],
  ] as const) {
    const v = validateFinding(fm(schema, verdict), 't1');
    assert.equal(v.negotiable, false, `${schema} must be non-negotiable`);
    assert.equal(v.blocksDone, true, `${schema} ${verdict} must block done`);
  }
});

test('reviewer findings are negotiable (the Negotiator may downgrade them)', () => {
  const v = validateFinding(fm('reviewer-finding', 'CHANGES_REQUESTED'), 't1');
  assert.equal(v.negotiable, true);
  assert.equal(v.blocksDone, true);
});

test('a passing gate does not block', () => {
  assert.equal(validateFinding(fm('checks-finding', 'PASS'), 't1').blocksDone, false);
  assert.equal(validateFinding(fm('security-finding', 'APPROVED'), 't1').blocksDone, false);
});
