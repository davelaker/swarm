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

  // For monorepos: also look one level deep for package.json files
  const findPackageJsonPaths = (): string[] => {
    const paths: string[] = [];
    if (hasFile('package.json')) paths.push(path.join(cwd, 'package.json'));
    try {
      const entries = fs.readdirSync(cwd, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const sub = path.join(cwd, e.name, 'package.json');
        if (fs.existsSync(sub)) paths.push(sub);
      }
    } catch { /* ignore */ }
    return paths;
  };

  const lines: string[] = [];
  const pkgPaths = findPackageJsonPaths();

  // Language / runtime — detect from root or any workspace
  if (pkgPaths.length > 0) {
    lines.push('- Runtime: Node.js');
    if (pkgPaths.length > 1) lines.push(`- Structure: monorepo (${pkgPaths.length} workspaces)`);
  } else if (hasFile('pyproject.toml', 'setup.py', 'requirements.txt')) lines.push('- Runtime: Python');
  else if (hasFile('go.mod')) lines.push('- Runtime: Go');
  else if (hasFile('Cargo.toml')) lines.push('- Runtime: Rust');
  else if (hasFile('pom.xml', 'build.gradle')) lines.push('- Runtime: JVM');

  // Package manager
  if (hasFile('pnpm-lock.yaml') || pkgPaths.some(p => fs.existsSync(path.join(path.dirname(p), 'pnpm-lock.yaml')))) lines.push('- Package manager: pnpm');
  else if (hasFile('bun.lockb')) lines.push('- Package manager: bun');
  else if (hasFile('yarn.lock')) lines.push('- Package manager: yarn');
  else lines.push('- Package manager: npm');

  // Framework and test hints — merge across all package.json files
  const allFw = new Set<string>();
  const testCmds: string[] = [];
  for (const pkgPath of pkgPaths) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['next'])         allFw.add('Next.js');
      if (deps['react'])        allFw.add('React');
      if (deps['vue'])          allFw.add('Vue');
      if (deps['svelte'])       allFw.add('Svelte');
      if (deps['express'])      allFw.add('Express');
      if (deps['fastify'])      allFw.add('Fastify');
      if (deps['hono'])         allFw.add('Hono');
      if (deps['@nestjs/core']) allFw.add('NestJS');
      if (deps['prisma'])       allFw.add('Prisma');
      if (deps['drizzle-orm'])  allFw.add('Drizzle ORM');
      if (deps['vite'])         allFw.add('Vite');
      if (deps['vitest'])       allFw.add('Vitest');
      if (deps['jest'])         allFw.add('Jest');
      if (pkg.scripts?.test && !testCmds.includes(pkg.scripts.test)) {
        const ws = path.relative(cwd, path.dirname(pkgPath)) || '.';
        testCmds.push(`\`${pkg.scripts.test}\` (${ws})`);
      }
    } catch { /* malformed — skip */ }
  }
  if (allFw.size > 0) lines.push(`- Frameworks / libraries: ${[...allFw].join(', ')}`);
  if (testCmds.length > 0) lines.push(`- Test command: ${testCmds.join(', ')}`);

  // TypeScript — check root or any workspace
  const hasTsConfig = hasFile('tsconfig.json') ||
    pkgPaths.some(p => fs.existsSync(path.join(path.dirname(p), 'tsconfig.json')));
  if (hasTsConfig) lines.push('- Language: TypeScript');

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
