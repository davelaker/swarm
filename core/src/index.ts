#!/usr/bin/env tsx
// Swarm CLI entry point.
// Usage:
//   swarm init              — scaffold .swarm/ in the current directory
//   swarm check             — verify all four Phase 0 seams
//   swarm dev               — start the server + open the dashboard
//   swarm new "<goal>"      — Phase 1: run a task end-to-end (not yet implemented)

import { runInit }  from './commands/init.js';
import { runCheck } from './commands/check.js';
import { startServer } from './server/index.js';
import { getConfigOptional } from './config.js';

const [,, cmd = 'dev', ...rest] = process.argv;

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

  case 'dev': {
    const cfg = getConfigOptional();
    console.log('\n  Agent Swarm\n');
    console.log('  ▸ orchestrator starting…');
    startServer(cfg.port);

    // Auto-open the browser. In dev the Vite server is on 5173;
    // in production the server itself serves ui/dist.
    const uiUrl = `http://localhost:5173`; // Phase 3: point to cfg.port after build
    const { exec } = await import('node:child_process');
    exec(`open "${uiUrl}"`);
    console.log(`  ▸ dashboard  → ${uiUrl}`);
    console.log('\n  PM ready. Run `swarm new "<goal>"` in another terminal to start a task.\n');
    break;
  }

  case 'new': {
    const goal = rest.join(' ');
    if (!goal) {
      console.error('  Usage: swarm new "<one-line goal>"\n');
      process.exit(1);
    }
    console.log(`\n  swarm new: "${goal}"\n`);
    console.log('  Phase 1 not yet implemented. Run `swarm check` to verify the seams are ready.\n');
    break;
  }

  default: {
    console.log(`
  Agent Swarm — local multi-agent coding system

  Commands:
    swarm init              scaffold .swarm/ in the current directory
    swarm check             verify all four Phase 0 seams
    swarm dev               start the server + open the dashboard
    swarm new "<goal>"      run a task (Phase 1)
`);
  }
}
