import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli } from '../index.js';
import { parseIntakeCommand } from '../cli/intake-command.js';
import type { IntakeDecision } from '../intake/index.js';
import { runIntakeCommand } from './intake.js';

function decision(shape: IntakeDecision['shape']): IntakeDecision {
  return {
    shape,
    confidence: 'high',
    rationale: `classified as ${shape}`,
    riskSignals: [],
    suggestedAction: `use ${shape}`,
  } as IntakeDecision;
}

function createHarness() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const pmCalls: Array<{ instruction: string; shape: 'answer' | 'plan' }> = [];
  const newCalls: string[] = [];
  const classifyCalls: Array<{ instruction: string; requestedShape?: string }> = [];

  return {
    stdout,
    stderr,
    pmCalls,
    newCalls,
    classifyCalls,
    deps: {
      stdout: (line: string) => {
        stdout.push(line);
      },
      stderr: (line: string) => {
        stderr.push(line);
      },
      driverBanner: () => '  ▸ driver     → Test driver',
      getDriverMode: () => 'api-key' as const,
      parseIntakeCommand,
      runInit: () => {},
      runCheck: async () => {},
      runStatus: () => {},
      runEval: async () => {},
      startServer: () => {},
      getConfigOptional: () => ({
        anthropicApiKey: '',
        port: 7000,
        owner: 'test',
        leaseSeconds: 60,
        softCapUsd: 1,
        hardCapUsd: 2,
      }),
      runNew: async (goal: string) => {
        newCalls.push(goal);
      },
      runIntakeCommand: async (command: { command: 'ask' | 'do' | 'plan' | 'swarm' | 'auto'; instruction: string; }) => {
        return runIntakeCommand(command, {
          classifyInput: input => {
            classifyCalls.push(input);
            if (input.requestedShape === 'answer') {
              return decision('answer');
            }
            if (input.requestedShape === 'plan') {
              return decision('plan');
            }
            if (input.requestedShape === 'quick_task') {
              return input.instruction.includes('auth')
                ? decision('coordinated_run')
                : decision('quick_task');
            }
            return input.instruction.includes('?') ? decision('answer') : decision('quick_task');
          },
          runNew: async goal => {
            newCalls.push(goal);
          },
          runPmReply: async request => {
            pmCalls.push(request);
            return {
              reply: `${request.shape.toUpperCase()}: ${request.instruction}`,
              teamAdd: ['coder', 'reviewer'],
              taskGraph: [],
            };
          },
          writeStdout: line => {
            stdout.push(line);
          },
          writeStderr: line => {
            stderr.push(line);
          },
        });
      },
    },
  };
}

test('no args preserves help output', async () => {
  const harness = createHarness();
  const result = await runCli([], harness.deps);

  assert.deepEqual(result, { exitCode: 0, exitProcess: false });
  assert.match(harness.stdout.join('\n'), /swarm ask "<prompt>"/);
});

test('legacy new preserves execution path', async () => {
  const harness = createHarness();
  const result = await runCli(['new', 'ship', 'dashboard'], harness.deps);

  assert.deepEqual(result, { exitCode: 0, exitProcess: true });
  assert.deepEqual(harness.newCalls, ['ship dashboard']);
  assert.equal(harness.pmCalls.length, 0);
});

test('legacy dev starts the server with the configured driver context', async () => {
  const harness = createHarness();
  const result = await runCli(['dev'], harness.deps);

  assert.deepEqual(result, { exitCode: 0, exitProcess: false });
  assert.match(harness.stdout.join('\n'), /orchestrator starting/);
  assert.match(harness.stdout.join('\n'), /Test driver/);
  assert.match(harness.stdout.join('\n'), /dashboard/);
});

test('ask prints recommendation header and PM reply only', async () => {
  const harness = createHarness();
  const result = await runCli(['ask', 'why', 'is', 'the', 'test', 'flaky?'], harness.deps);

  assert.deepEqual(result, { exitCode: 0, exitProcess: false });
  assert.deepEqual(harness.pmCalls, [{ instruction: 'why is the test flaky?', shape: 'answer' }]);
  assert.equal(harness.newCalls.length, 0);
  assert.match(harness.stdout.join('\n'), /Recommendation: answer/);
  assert.match(harness.stdout.join('\n'), /ANSWER: why is the test flaky\?/);
});

test('intake path works with only parser and intake runtime injected', async () => {
  const calls: string[] = [];
  const result = await runCli(['ask', 'summarize', 'the', 'repo'], {
    parseIntakeCommand,
    runIntakeCommand: async command => {
      calls.push(`${command.command}:${command.instruction}`);
      return { exitCode: 0, exitProcess: false };
    },
  });

  assert.deepEqual(result, { exitCode: 0, exitProcess: false });
  assert.deepEqual(calls, ['ask:summarize the repo']);
});

test('plan prints PM planning reply without execution', async () => {
  const harness = createHarness();
  const result = await runCli(['plan', 'map', 'the', 'release'], harness.deps);

  assert.deepEqual(result, { exitCode: 0, exitProcess: false });
  assert.deepEqual(harness.pmCalls, [{ instruction: 'map the release', shape: 'plan' }]);
  assert.equal(harness.newCalls.length, 0);
});

test('safe do runs the existing workflow', async () => {
  const harness = createHarness();
  const result = await runCli(['do', 'rename', 'the', 'banner'], harness.deps);

  assert.deepEqual(result, { exitCode: 0, exitProcess: true });
  assert.deepEqual(harness.newCalls, ['rename the banner']);
});

test('do escalates risky work to explicit swarm command', async () => {
  const harness = createHarness();
  const result = await runCli(['do', 'fix', 'auth', 'flow'], harness.deps);

  assert.deepEqual(result, { exitCode: 1, exitProcess: false });
  assert.equal(harness.newCalls.length, 0);
  assert.match(harness.stdout.join('\n'), /swarm swarm "fix auth flow"/);
});

test('bare question auto-routes to PM answer', async () => {
  const harness = createHarness();
  const result = await runCli(['why', 'is', 'the', 'build', 'red?'], harness.deps);

  assert.deepEqual(result, { exitCode: 0, exitProcess: false });
  assert.deepEqual(harness.pmCalls, [{ instruction: 'why is the build red?', shape: 'answer' }]);
});

test('bare write request requires explicit do before writes', async () => {
  const harness = createHarness();
  const result = await runCli(['rename', 'the', 'banner'], harness.deps);

  assert.deepEqual(result, { exitCode: 0, exitProcess: false });
  assert.equal(harness.newCalls.length, 0);
  assert.match(harness.stdout.join('\n'), /swarm do "rename the banner"/);
});

test('missing lightweight instruction returns usage error', async () => {
  const harness = createHarness();
  const result = await runCli(['do'], harness.deps);

  assert.deepEqual(result, { exitCode: 1, exitProcess: false });
  assert.match(harness.stderr.join('\n'), /Usage: swarm do/);
});
