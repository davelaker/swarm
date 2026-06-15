// Visual verification — for UI-touching runs, render the changed routes in a real
// browser and attach screenshots (plus any console errors) to a finding, so the
// reviewer sees PROOF a change renders rather than a claim. Advisory in v1: it
// attaches evidence and flags hard failures (page failed to load, console errors)
// but does not block — a screenshot heuristic shouldn't hard-fail a run until proven.
//
// The browser capture uses Playwright via an OPTIONAL dynamic import, so core does
// not hard-depend on it; if Playwright (or a dev server) isn't available the gate
// degrades to a clear advisory note instead of failing.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import type { Task, SwarmState } from '../state/types.js';
import { getRoot, swarmDir } from '../state/repo.js';

const FRONTEND_EXT = /\.(tsx|jsx|vue|svelte|astro)$/;

// Pure: does this path look like a renderable frontend component?
export function isFrontendFile(p: string): boolean {
  if (!FRONTEND_EXT.test(p)) {
    return false;
  }
  // Exclude obvious non-page code so we don't try to "render" a hook or a test.
  return !/\.(test|spec|stories)\.|\/(hooks|lib|utils|types)\//.test(p);
}

// Pure: map changed Next.js page/route files to URL paths. Dynamic segments
// ([id]) are skipped — we can't invent a real id — and reported separately.
export function filesToRoutes(files: string[]): { routes: string[]; skippedDynamic: string[] } {
  const routes = new Set<string>();
  const skippedDynamic: string[] = [];
  for (const f of files) {
    const norm = f.replace(/^\.\//, '');
    // Next.js app router: app/(group)/foo/page.tsx → /foo ; app/page.tsx → /
    const app = norm.match(/(?:^|\/)app\/(.*\/)?page\.(?:tsx|jsx)$/);
    // Next.js pages router: pages/foo.tsx → /foo ; pages/index.tsx → /
    const pages = norm.match(/(?:^|\/)pages\/(.+)\.(?:tsx|jsx)$/);
    let seg: string | null = null;
    if (app) {
      seg = (app[1] ?? '')
        .split('/')
        .filter(p => p && !/^\(.*\)$/.test(p)) // drop route groups (parens)
        .join('/');
    } else if (pages) {
      seg = pages[1].replace(/\/index$/, '').replace(/^index$/, '');
    }
    if (seg === null) {
      continue;
    }
    if (/\[.*\]/.test(seg)) {
      skippedDynamic.push('/' + seg);
      continue;
    }
    routes.add('/' + seg);
  }
  return { routes: [...routes], skippedDynamic };
}

// Pure: detect the dev-server command + port from package.json (Next-aware).
export function detectDevServer(root: string): { cmd: string; port: number } | null {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return null;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const dev: string | undefined = pkg.scripts?.dev;
    if (!dev) {
      return null;
    }
    const portMatch = dev.match(/(?:-p|--port[= ])\s*(\d{2,5})/);
    const port = portMatch ? Number(portMatch[1]) : dev.includes('vite') ? 5173 : 3000;
    return { cmd: 'npm run dev', port };
  } catch {
    return null;
  }
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const tryOnce = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          resolve(false);
        } else {
          setTimeout(tryOnce, 500);
        }
      });
    };
    tryOnce();
  });
}

export interface RouteShot {
  route: string;
  imagePath: string | null; // relative to swarmDir(), for the finding to embed
  loaded: boolean;
  consoleErrors: string[];
}

// Optional Playwright import — returns null if the package isn't installed.
async function loadPlaywright(): Promise<{ chromium: unknown } | null> {
  try {
    // Cast the specifier to defeat TS module resolution — this is a runtime-only,
    // best-effort dependency that core does not require to be installed.
    return (await import('playwright' as string)) as { chromium: unknown };
  } catch {
    return null;
  }
}

// Drive a headless browser over the routes, screenshotting each and collecting
// console errors. Returns null if Playwright is unavailable.
async function captureRoutes(
  routes: string[],
  port: number,
  outDir: string,
): Promise<RouteShot[] | null> {
  const pw = await loadPlaywright();
  if (!pw) {
    return null;
  }
  // The chromium type is unknown (optional dep) — narrow at the call boundary.
  const chromium = (pw as { chromium: { launch: (o?: unknown) => Promise<any> } }).chromium;
  const browser = await chromium.launch({ headless: true });
  const shots: RouteShot[] = [];
  try {
    fs.mkdirSync(outDir, { recursive: true });
    for (const route of routes) {
      const page = await browser.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (m: { type: () => string; text: () => string }) => {
        if (m.type() === 'error') {
          consoleErrors.push(m.text());
        }
      });
      page.on('pageerror', (e: Error) => consoleErrors.push(e.message));
      let loaded = true;
      const file = `${route.replace(/[^a-z0-9]+/gi, '_') || 'root'}.png`;
      const abs = path.join(outDir, file);
      try {
        await page.goto(`http://127.0.0.1:${port}${route}`, {
          waitUntil: 'networkidle',
          timeout: 15_000,
        });
        await page.screenshot({ path: abs, fullPage: true });
      } catch (err) {
        loaded = false;
        consoleErrors.push(`navigation failed: ${(err as Error).message}`);
      }
      shots.push({
        route,
        imagePath: loaded ? path.relative(swarmDir(), abs) : null,
        loaded,
        consoleErrors,
      });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return shots;
}

function visualFinding(task: Task, verdict: string, summary: string, body: string): string {
  return [
    '---',
    `task: ${task.id}`,
    'agent: visual',
    'schema: visual-finding',
    `verdict: ${verdict}`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    '---',
    '',
    '## Visual verification',
    '',
    body,
    '',
  ].join('\n');
}

// Run the visual gate for a task. Advisory: PASS (with evidence) or ADVISORY (a
// soft flag) — never blocks. Self-skips fast when the run changed no frontend files.
export async function runVisualCheck(
  task: Task,
  state: SwarmState,
): Promise<{ verdict: string; summary: string; findingMarkdown: string }> {
  const root = getRoot();
  const changed = [
    ...new Set(state.tasks.filter(t => t.assignee === 'coder').flatMap(t => t.artifacts ?? [])),
  ].filter(isFrontendFile);

  if (changed.length === 0) {
    return {
      verdict: 'PASS',
      summary: 'No frontend changes — visual verification skipped.',
      findingMarkdown: visualFinding(
        task,
        'PASS',
        'No frontend changes to verify.',
        'Nothing to render.',
      ),
    };
  }

  const { routes, skippedDynamic } = filesToRoutes(changed);
  const server = detectDevServer(root);

  if (!routes.length || !server) {
    const why = !server
      ? 'no dev-server `dev` script detected'
      : 'changed files map to no static route (dynamic routes need a concrete id)';
    const note = [
      `Changed frontend files: ${changed.join(', ')}`,
      skippedDynamic.length ? `Dynamic routes skipped: ${skippedDynamic.join(', ')}` : '',
      `Capture not run — ${why}.`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      verdict: 'ADVISORY',
      summary: `Visual verification not run (${why}).`,
      findingMarkdown: visualFinding(
        task,
        'ADVISORY',
        `Visual verification not run (${why}).`,
        note,
      ),
    };
  }

  const outDir = path.join(swarmDir(), 'visual', task.id);
  const proc = spawn(server.cmd, { cwd: root, shell: true, stdio: 'ignore', detached: false });
  try {
    const up = await waitForPort(server.port, 60_000);
    if (!up) {
      return {
        verdict: 'ADVISORY',
        summary: `Dev server did not start on port ${server.port} within 60s.`,
        findingMarkdown: visualFinding(
          task,
          'ADVISORY',
          'Dev server did not come up — visual verification skipped.',
          `Tried \`${server.cmd}\` on port ${server.port}.`,
        ),
      };
    }
    const shots = await captureRoutes(routes, server.port, outDir);
    if (!shots) {
      return {
        verdict: 'ADVISORY',
        summary: 'Playwright not installed — visual capture unavailable.',
        findingMarkdown: visualFinding(
          task,
          'ADVISORY',
          'Playwright not installed — run `npm i playwright` in core to enable visual capture.',
          `Routes that would have been captured: ${routes.join(', ')}`,
        ),
      };
    }

    const failed = shots.filter(s => !s.loaded || s.consoleErrors.length);
    const verdict = failed.length ? 'ADVISORY' : 'PASS';
    const body = shots
      .map(s => {
        const head = `### ${s.loaded ? '✓' : '✗'} ${s.route}`;
        const img = s.imagePath ? `\n\n![${s.route}](${s.imagePath})` : '';
        const errs = s.consoleErrors.length
          ? `\n\nConsole errors:\n${s.consoleErrors.map(e => `- ${e}`).join('\n')}`
          : '';
        return head + img + errs;
      })
      .join('\n\n');
    const summary = failed.length
      ? `Rendered ${shots.length} route(s); ${failed.length} had load/console issues.`
      : `Rendered ${shots.length} route(s) cleanly — screenshots attached.`;
    return { verdict, summary, findingMarkdown: visualFinding(task, verdict, summary, body) };
  } finally {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }
}
