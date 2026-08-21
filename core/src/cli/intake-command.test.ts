import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIntakeCommand, type IntakeCommandParseResult } from './intake-command.js';

interface ParseCase {
  name: string;
  argv: string[];
  expected: IntakeCommandParseResult;
}

const cases: ParseCase[] = [
  {
    name: 'parses legacy init',
    argv: ['init'],
    expected: {
      ok: true,
      value: {
        kind: 'legacy',
        command: 'init',
        args: [],
      },
    },
  },
  {
    name: 'preserves legacy new execution arguments',
    argv: ['new', 'ship', 'dashboard'],
    expected: {
      ok: true,
      value: {
        kind: 'legacy',
        command: 'new',
        args: ['ship', 'dashboard'],
      },
    },
  },
  {
    name: 'parses explicit ask intake',
    argv: ['ask', 'summarize', 'the', 'open', 'issues'],
    expected: {
      ok: true,
      value: {
        kind: 'intake',
        command: 'ask',
        instruction: 'summarize the open issues',
        args: ['summarize', 'the', 'open', 'issues'],
      },
    },
  },
  {
    name: 'parses explicit swarm intake',
    argv: ['swarm', 'draft', 'the', 'release', 'plan'],
    expected: {
      ok: true,
      value: {
        kind: 'intake',
        command: 'swarm',
        instruction: 'draft the release plan',
        args: ['draft', 'the', 'release', 'plan'],
      },
    },
  },
  {
    name: 'treats bare text as auto intake',
    argv: ['fix', 'the', 'notification', 'race'],
    expected: {
      ok: true,
      value: {
        kind: 'intake',
        command: 'auto',
        instruction: 'fix the notification race',
        args: ['fix', 'the', 'notification', 'race'],
      },
    },
  },
  {
    name: 'normalizes blank tokens before parsing',
    argv: [' ', 'plan', ' ', 'map', 'the', 'rollout', ' '],
    expected: {
      ok: true,
      value: {
        kind: 'intake',
        command: 'plan',
        instruction: 'map the rollout',
        args: ['map', 'the', 'rollout'],
      },
    },
  },
  {
    name: 'errors on missing lightweight instruction',
    argv: ['do'],
    expected: {
      ok: false,
      error: {
        kind: 'error',
        code: 'missing-instruction',
        message: 'Usage: swarm do "<instruction>"',
      },
    },
  },
  {
    name: 'errors on empty input',
    argv: [],
    expected: {
      ok: false,
      error: {
        kind: 'error',
        code: 'empty-input',
        message: 'Expected a Swarm command or instruction.',
      },
    },
  },
];

for (const c of cases) {
  test(c.name, () => {
    assert.deepEqual(parseIntakeCommand(c.argv), c.expected);
  });
}
