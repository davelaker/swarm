#!/usr/bin/env tsx
// Swarm CLI entry point.
//
//   swarm init              — scaffold .swarm/ in the current directory
//   swarm check             — verify all four Phase 0 seams
//   swarm new "<goal>"      — run a task end-to-end (Phase 1)
//   swarm eval [<cases>]    — run the eval harness (Phase 1 exit criteria)
//   swarm dev               — start the dashboard server

import { runInit }        from './commands/init.js';
import { runCheck }       from './commands/check.js';
import { runNew }         from './commands/new.js';
import { runEval }        from './eval/index.js';
import { startServer }    from './server/index.js';
import { getConfigOptional } from './config.js';

const [,, cmd = 'help', ...rest] = process.argv;

switch (cmd) {
  case 'init': {
    console.log('\n  swarm init\n');
    runInit();
    break;
  }

  case 'check': {
    await runCheck();
    break;
  }

  case 'new': {
    const goal = rest.join(' ').trim();
    if (!goal) {
      console.error('\n  Usage: swarm new "<one-line goal>"\n');
      process.exit(1);
    }
    console.log(`\n  swarm new: "${goal}"\n`);
    await runNew(goal);
    break;
  }

  case 'eval': {
    // Optional: pass specific test names to run a subset
    const names = rest.length ? rest : undefined;
    await runEval(names);
    break;
  }

  case 'dev': {
    const cfg = getConfigOptional();
    console.log('\n  Agent Swarm\n');
    console.log('  ▸ orchestrator starting…');
    startServer(cfg.port);
    const uiUrl = 'http://localhost:5173'; // Phase 3: cfg.port after ui build
    const { exec } = await import('node:child_process');
    exec(`open "${uiUrl}"`);
    console.log(`  ▸ dashboard  → ${uiUrl}`);
    console.log('\n  PM ready. Run `swarm new "<goal>"` in another terminal.\n');
    break;
  }

  default: {
    console.log(`
  Agent Swarm — local multi-agent coding system

  Commands:
    swarm init              scaffold .swarm/ in the current directory
    swarm check             verify all four Phase 0 seams
    swarm new "<goal>"      run a task end-to-end
    swarm eval [<cases>]    run the Phase 1 eval harness
    swarm dev               start the dashboard server

  Env vars:
    ANTHROPIC_API_KEY       required
    SWARM_CODER_MODEL       model for Coder agent (default: claude-opus-4-5-20251101)
    SWARM_HARD_CAP_USD      abort if total cost exceeds this (default: 2.00)
    SWARM_SOFT_CAP_USD      warn at this threshold (default: 1.00)
    SWARM_PORT              dashboard server port (default: 7000)
`);
  }
}
