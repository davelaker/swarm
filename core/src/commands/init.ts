import fs   from 'node:fs';
import path  from 'node:path';
import { swarmDir, stateFile, initWorkspace, projectContextFile } from '../state/repo.js';

const TEAM_CONFIG = `# team.config.yaml — installed agent team
# See MARKETPLACE.md for the full schema.
owner: me
agents:
  - template: pm@builtin
  - template: coder@builtin
  - template: tester@builtin
  - template: security@builtin
  - template: reviewer@builtin
`;

function buildProjectMd(project: string): string {
  // Probe common tech stack indicators so the scaffold is pre-filled where possible.
  const cwd = process.cwd();

  const hasFile = (...names: string[]) =>
    names.some(n => fs.existsSync(path.join(cwd, n)));

  const lines: string[] = [];

  // Language / runtime
  if (hasFile('package.json')) lines.push('- Runtime: Node.js');
  else if (hasFile('pyproject.toml', 'setup.py', 'requirements.txt')) lines.push('- Runtime: Python');
  else if (hasFile('go.mod')) lines.push('- Runtime: Go');
  else if (hasFile('Cargo.toml')) lines.push('- Runtime: Rust');
  else if (hasFile('pom.xml', 'build.gradle')) lines.push('- Runtime: JVM');

  // Package manager
  if (hasFile('pnpm-lock.yaml')) lines.push('- Package manager: pnpm');
  else if (hasFile('bun.lockb')) lines.push('- Package manager: bun');
  else if (hasFile('yarn.lock')) lines.push('- Package manager: yarn');
  else if (hasFile('package-lock.json')) lines.push('- Package manager: npm');

  // Framework hints from package.json
  if (hasFile('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const fw: string[] = [];
      if (deps['next'])         fw.push('Next.js');
      if (deps['react'])        fw.push('React');
      if (deps['vue'])          fw.push('Vue');
      if (deps['svelte'])       fw.push('Svelte');
      if (deps['express'])      fw.push('Express');
      if (deps['fastify'])      fw.push('Fastify');
      if (deps['hono'])         fw.push('Hono');
      if (deps['@nestjs/core']) fw.push('NestJS');
      if (deps['prisma'])       fw.push('Prisma');
      if (deps['drizzle-orm'])  fw.push('Drizzle ORM');
      if (deps['sequelize'])    fw.push('Sequelize');
      if (deps['typeorm'])      fw.push('TypeORM');
      if (deps['vitest'])       fw.push('Vitest');
      if (deps['jest'])         fw.push('Jest');
      if (fw.length) lines.push(`- Frameworks / libraries: ${fw.join(', ')}`);

      // Test script
      if (pkg.scripts?.test) lines.push(`- Test command: \`${pkg.scripts.test}\``);
    } catch { /* malformed package.json — skip */ }
  }

  // TypeScript
  if (hasFile('tsconfig.json')) lines.push('- Language: TypeScript');

  const stackSection = lines.length
    ? lines.join('\n')
    : '(to be discovered — update as agents learn about the stack)';

  // Top-level directory summary
  let dirList = '(to be discovered)';
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => `- \`${e.name}/\``)
      .join('\n');
    if (dirs) dirList = dirs;
  } catch { /* ignore */ }

  return [
    '<!-- swarm:context — read this file at the start of every task, update it when architecture or conventions change -->',
    `# Project: ${project}`,
    '',
    `*Initialised by \`swarm init\`*`,
    '',
    '## Tech stack',
    stackSection,
    '',
    '## Architecture',
    '(to be discovered — update as agents learn how components connect)',
    '',
    '## Key directories',
    dirList,
    '',
    '## Deployment',
    '(unknown — the PM will ask on first planning session)',
    '',
    '## Conventions',
    '(to be discovered — update as consistent patterns emerge)',
    '',
    '## Features built by swarm',
    '(none yet — each completed `swarm new` run should append a one-liner here)',
    '',
  ].join('\n');
}

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
    const project = path.basename(process.cwd());
    initWorkspace(project, '', 'tweak');
    console.log('  ✓ .swarm/state.json');
  } else {
    console.log('  · .swarm/state.json  (already exists — left untouched)');
  }

  // Write PROJECT.md if absent — pre-filled with detected tech stack
  const ctxFile = projectContextFile();
  if (!fs.existsSync(ctxFile)) {
    const project = path.basename(process.cwd());
    fs.writeFileSync(ctxFile, buildProjectMd(project), 'utf8');
    console.log('  ✓ .swarm/PROJECT.md  (edit this to add architecture and conventions)');
  } else {
    console.log('  · .swarm/PROJECT.md  (already exists — left untouched)');
  }

  if (existed) {
    console.log('  ✓ .swarm/ updated');
  } else {
    console.log('  ✓ .swarm/ created');
  }

  console.log('\n  Workspace ready. Run `swarm dev` to open the dashboard.\n');
}
