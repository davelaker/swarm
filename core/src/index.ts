#!/usr/bin/env tsx
// Swarm CLI entry point.
//
//   swarm init              — scaffold .swarm/ in the current directory
//   swarm check             — verify all four Phase 0 seams
//   swarm new "<goal>"      — run a task end-to-end (Phase 1)
//   swarm ask "<prompt>"    — read-only PM answer
//   swarm plan "<prompt>"   — PM planning reply only
//   swarm do "<prompt>"     — bounded write path after intake classification
//   swarm swarm "<prompt>"  — explicit coordinated run
//   swarm eval [<cases>]    — run the eval harness (Phase 1 exit criteria)
//   swarm dev               — start the dashboard server

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIntakeCommand, type IntakeRunResult } from './commands/intake.js';
import { getConfigOptional } from './config.js';
import { parseIntakeCommand, type LegacyCommand } from './cli/intake-command.js';

export interface CliDeps {
  runInit?: () => void;
  runCheck?: () => Promise<void>;
  runStatus?: () => void;
  runNew?: (goal: string) => Promise<void>;
  runEval?: (names?: string[]) => Promise<void>;
  startServer?: (port: number) => void;
  parseIntakeCommand?: typeof parseIntakeCommand;
  runIntakeCommand?: typeof runIntakeCommand;
  getConfigOptional?: () => { port: number };
  driverBanner?: () => string;
  getDriverMode?: () => 'agent-sdk' | 'api-key' | 'codex';
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const DEFAULT_DEPS: Required<CliDeps> = {
  runInit: () => {
    throw new Error('runInit not initialised');
  },
  runCheck: async () => {
    throw new Error('runCheck not initialised');
  },
  runStatus: () => {
    throw new Error('runStatus not initialised');
  },
  runNew: async () => {
    throw new Error('runNew not initialised');
  },
  runEval: async () => {
    throw new Error('runEval not initialised');
  },
  startServer: () => {
    throw new Error('startServer not initialised');
  },
  parseIntakeCommand,
  runIntakeCommand,
  getConfigOptional,
  driverBanner: () => {
    throw new Error('driverBanner not initialised');
  },
  getDriverMode: () => {
    throw new Error('getDriverMode not initialised');
  },
  stdout: line => console.log(line),
  stderr: line => console.error(line),
};

export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<IntakeRunResult> {
  const tokens = [...argv];
  if (!tokens.length || tokens[0] === 'help') {
    const driverFns = deps.driverBanner && deps.getDriverMode
      ? { driverBanner: deps.driverBanner, getDriverMode: deps.getDriverMode }
      : await loadDriverFns();
    const resolved = {
      ...DEFAULT_DEPS,
      ...driverFns,
      ...deps,
    };
    printHelp(resolved.stdout, resolved.getDriverMode(), resolved.driverBanner());
    return { exitCode: 0, exitProcess: false };
  }

  const resolved = {
    ...DEFAULT_DEPS,
    ...deps,
  };
  const parsed = resolved.parseIntakeCommand(tokens);
  if (!parsed.ok) {
    resolved.stderr(parsed.error.message);
    return { exitCode: 1, exitProcess: false };
  }

  if (parsed.value.kind === 'legacy') {
    const commandFns = await loadLegacyCommandFns(parsed.value.command, deps);
    return runLegacyCommand(parsed.value, {
      ...resolved,
      ...commandFns,
    });
  }

  return resolved.runIntakeCommand(parsed.value);
}

async function runLegacyCommand(
  command: LegacyCommand,
  deps: Required<CliDeps>,
): Promise<IntakeRunResult> {
  switch (command.command) {
    case 'init': {
      deps.stdout('\n  swarm init\n');
      deps.runInit();
      return { exitCode: 0, exitProcess: false };
    }

    case 'check': {
      await deps.runCheck();
      const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
      return { exitCode, exitProcess: false };
    }

    case 'status': {
      deps.runStatus();
      return { exitCode: 0, exitProcess: false };
    }

    case 'new': {
      const goal = command.args.join(' ').trim();
      if (!goal) {
        deps.stderr('\n  Usage: swarm new "<one-line goal>"\n');
        return { exitCode: 1, exitProcess: false };
      }
      deps.stdout(`\n  swarm new: "${goal}"\n`);
      await deps.runNew(goal);
      return { exitCode: 0, exitProcess: true };
    }

    case 'eval': {
      const names = command.args.length ? command.args : undefined;
      await deps.runEval(names);
      return { exitCode: 0, exitProcess: false };
    }

    case 'dev': {
      const cfg = deps.getConfigOptional();
      deps.stdout('\n  Agent Swarm\n');
      deps.stdout('  ▸ orchestrator starting…');
      deps.stdout(deps.driverBanner());
      deps.startServer(cfg.port);
      const uiUrl = 'http://localhost:5173';
      deps.stdout(`  ▸ dashboard  → ${uiUrl}`);
      deps.stdout('\n  PM ready. Run `swarm new "<goal>"` in another terminal.\n');
      return { exitCode: 0, exitProcess: false };
    }

    case 'help': {
      printHelp(deps.stdout, deps.getDriverMode(), deps.driverBanner());
      return { exitCode: 0, exitProcess: false };
    }
  }
}

function printHelp(
  write: (line: string) => void,
  mode: 'agent-sdk' | 'api-key' | 'codex',
  banner: string,
): void {
  write(`
  Agent Swarm — local multi-agent coding system
  Active driver: ${
    mode === 'agent-sdk'
      ? 'Claude Agent SDK (Max plan)'
      : mode === 'codex'
        ? 'Codex CLI'
        : 'API key'
  }

  Commands:
    swarm init              scaffold .swarm/ in the current directory
    swarm check             verify all four Phase 0 seams
    swarm new "<goal>"      run a task end-to-end
    swarm ask "<prompt>"    get a read-only PM answer
    swarm plan "<prompt>"   get a PM plan without execution
    swarm do "<prompt>"     run a bounded task after intake checks
    swarm swarm "<prompt>"  run the full coordinated workflow
    swarm "<prompt>"        classify first; require explicit write approval
    swarm eval [<cases>]    run the eval harness
    swarm status            print a snapshot of the current run
    swarm dev               start the dashboard server

${banner}

  Driver selection (SWARM_DRIVER):
    agent-sdk   Use claude CLI — authenticates via Max plan subscription
                Max 20x: $200/month Agent SDK credit included
    api-key     Use Anthropic Client SDK — requires ANTHROPIC_API_KEY
    auto        (default) API key if set, else claude CLI

  Other env vars:
    SWARM_CODER_MODEL       model override (api-key mode only)
    SWARM_HARD_CAP_USD      cost abort threshold (default: 2.00)
    SWARM_SOFT_CAP_USD      cost warn threshold (default: 1.00)
    SWARM_PORT              dashboard port (default: 7000)
`);
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

async function loadDriverFns(): Promise<Pick<Required<CliDeps>, 'driverBanner' | 'getDriverMode'>> {
  const { driverBanner, getDriverMode } = await import('./drivers/index.js');
  return { driverBanner, getDriverMode };
}

async function loadLegacyCommandFns(
  command: LegacyCommand['command'],
  deps: CliDeps,
): Promise<Partial<Pick<Required<CliDeps>, 'runInit' | 'runCheck' | 'runStatus' | 'runNew' | 'runEval' | 'startServer'>>> {
  if (command === 'init' && deps.runInit) {
    return { runInit: deps.runInit };
  }
  if (command === 'check' && deps.runCheck) {
    return { runCheck: deps.runCheck };
  }
  if (command === 'status' && deps.runStatus) {
    return { runStatus: deps.runStatus };
  }
  if (command === 'new' && deps.runNew) {
    return { runNew: deps.runNew };
  }
  if (command === 'eval' && deps.runEval) {
    return { runEval: deps.runEval };
  }
  if (command === 'dev' && deps.startServer) {
    return { startServer: deps.startServer };
  }

  switch (command) {
    case 'init': {
      const { runInit } = await import('./commands/init.js');
      return { runInit };
    }
    case 'check': {
      const { runCheck } = await import('./commands/check.js');
      return { runCheck };
    }
    case 'status': {
      const { runStatus } = await import('./commands/status.js');
      return { runStatus };
    }
    case 'new': {
      const { runNew } = await import('./commands/new.js');
      return { runNew };
    }
    case 'eval': {
      const { runEval } = await import('./eval/index.js');
      return { runEval };
    }
    case 'dev': {
      const { startServer } = await import('./server/index.js');
      return { startServer };
    }
    case 'help': {
      return {};
    }
  }
}

if (isMain()) {
  const result = await runCli(process.argv.slice(2));
  if (result.exitProcess) {
    process.exit(result.exitCode);
  }
  process.exitCode = result.exitCode;
}
