import fs   from 'node:fs';
import path  from 'node:path';
import { swarmDir, stateFile, initWorkspace } from '../state/repo.js';

const TEAM_CONFIG = `# team.config.yaml — installed agent team
# See MARKETPLACE.md for the full schema.
owner: me
agents:
  - template: pm@builtin
  - template: coder@builtin
  - template: tester@builtin
  - template: security@builtin
`;

export function runInit(): void {
  const dir = swarmDir();
  const existed = fs.existsSync(dir);

  // Create directory structure
  fs.mkdirSync(path.join(dir, 'findings'), { recursive: true });

  // Write team config if absent
  const teamFile = path.join(dir, 'team.config.yaml');
  if (!fs.existsSync(teamFile)) {
    fs.writeFileSync(teamFile, TEAM_CONFIG, 'utf8');
    console.log('  ✓ .swarm/team.config.yaml');
  }

  // Write initial state.json if absent
  if (!fs.existsSync(stateFile())) {
    // Project name defaults to the containing directory name.
    const project = path.basename(process.cwd());
    initWorkspace(project, '', 'tweak');
    console.log('  ✓ .swarm/state.json');
  } else {
    console.log('  · .swarm/state.json  (already exists — left untouched)');
  }

  if (existed) {
    console.log('  ✓ .swarm/ updated');
  } else {
    console.log('  ✓ .swarm/ created');
  }

  console.log('\n  Workspace ready. Next:\n');
  console.log('    export ANTHROPIC_API_KEY=sk-ant-…');
  console.log('    swarm new "rename foo to bar in src/util.ts"   # Phase 1\n');
}
