import { describe, expect, it } from 'vitest';
import {
  QUICK_TASK_DEMO_STATES,
  countVerificationResults,
  diffSummary,
  isQuickTaskTerminal,
} from './quickTask';

describe('diffSummary', () => {
  it('returns an empty-state summary when no files changed', () => {
    expect(diffSummary([])).toBe('No code changes yet.');
  });

  it('aggregates file counts and line totals', () => {
    const ready = QUICK_TASK_DEMO_STATES.find(state => state.stage === 'ready_for_review');
    expect(ready).toBeDefined();
    expect(diffSummary(ready!.changedFiles)).toBe('2 files changed · +25 −8');
  });
});

describe('countVerificationResults', () => {
  it('counts passed, failed, and running checks separately', () => {
    const failed = QUICK_TASK_DEMO_STATES.find(state => state.stage === 'failed');
    expect(failed).toBeDefined();
    expect(countVerificationResults(failed!.verification)).toEqual({
      passed: 1,
      failed: 1,
      running: 0,
    });
  });
});

describe('isQuickTaskTerminal', () => {
  it('treats completed, escalated, failed, and cancelled states as terminal', () => {
    expect(isQuickTaskTerminal('committed')).toBe(true);
    expect(isQuickTaskTerminal('needs_escalation')).toBe(true);
    expect(isQuickTaskTerminal('failed')).toBe(true);
    expect(isQuickTaskTerminal('cancelled')).toBe(true);
    expect(isQuickTaskTerminal('verifying')).toBe(false);
  });
});
