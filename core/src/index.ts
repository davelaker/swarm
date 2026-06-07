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
import { driverBanner, getDriverMode } from './drivers/index.js';

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
    console.log(driverBanner());
    startServer(cfg.port);
    const uiUrl = 'http://localhost:5173'; // Phase 3: cfg.port after ui build
    const { exec } = await import('node:child_process');
    exec(`open "${uiUrl}"`);
    console.log(`  ▸ dashboard  → ${uiUrl}`);
    console.log('\n  PM ready. Run `swarm new "<goal>"` in another terminal.\n');
    break;
  }

  default: {
    const mode = getDriverMode();
    console.log(`
  Agent Swarm — local multi-agent coding system
  Active driver: ${mode === 'agent-sdk' ? 'Claude Agent SDK (Max plan)' : 'API key'}

  Commands:
    swarm init              scaffold .swarm/ in the current directory
    swarm check             verify all four Phase 0 seams
    swarm new "<goal>"      run a task end-to-end
    swarm eval [<cases>]    run the eval harness
    swarm dev               start the dashboard server

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
}
