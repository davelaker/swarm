// Embedded HTTP server — GET /state, GET /events (SSE), POST /run/* + /pm/*
//
// Two event sources feed the SSE stream:
//   1. In-process bus  — api-key driver: events emitted by the state repository
//   2. File watcher    — agent-sdk driver: `claude -p` subprocess writes state.json
//                        directly; we detect changes and diff to emit events
//
// Both feed the same `fanout()` function → all SSE clients.
// See UX.md §3 for the architecture diagram.

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { bus } from '../state/events.js';
import {
  getRoot,
  setRoot,
  getState,
  swarmDir,
  stateFile,
  sessionsDir,
  snapshotSession,
  projectContextFile,
  writeDeploymentInfo,
  appendLog,
} from '../state/repo.js';
import { serverFreshness } from './freshness.js';
import { runPreflight } from './preflight.js';
import { buildStructuredDiff } from './diff.js';
import { buildScorecards } from './scorecards.js';
import { readReview, writeReview } from './review.js';
import { runPmMessage, PM_SYSTEM } from '../pm/index.js';
import { runNew, checkGitClean } from '../commands/new.js';
import { pauseRun, resumeRun, abortRun } from '../loop-control.js';
import { getConfigOptional } from '../config.js';
import { getDriverMode } from '../drivers/index.js';
import { requestPermission, resolvePermission } from '../drivers/permission-broker.js';
import { loadRoster, saveRoster } from '../state/roster.js';
import { probeAvailableConnectors } from '../state/connectors.js';
import { loadBuiltinInstructions, saveBuiltinInstructions } from '../state/builtin-instructions.js';
import { loadBuiltinModels, saveBuiltinModels } from '../state/builtin-models.js';
import {
  CODER_SYSTEM,
  TESTER_SYSTEM,
  REVIEWER_SYSTEM,
  SECURITY_SYSTEM,
} from '../agents/prompts.js';
import type { SwarmEvent, SwarmState, Task } from '../state/types.js';

type SseClient = http.ServerResponse;

const clients = new Set<SseClient>();

// ─── Active-run guard ─────────────────────────────────────────────────────────
// Prevents a second Execute while agents are running. Without this, an HMR
// hot-reload during a run would dump the user back on Planning with Execute
// still enabled — a second click would spawn duplicate agents.
let activeRun = false;

// ─── File-watcher lifecycle ───────────────────────────────────────────────────
// Module-level ref so /project/switch can stop & restart the watcher when
// the root directory changes.
let stopCurrentWatcher: () => void = () => {};

function restartWatcher(): void {
  stopCurrentWatcher();
  stopCurrentWatcher = startFileWatcher();
}

// ─── GitHub URL detection ─────────────────────────────────────────────────────
// Reads `origin` once at startup and caches the result. The /state handler
// reads the cached value synchronously — no async needed there.

let githubUrl: string | null = null;

function detectGithubUrl(): void {
  execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: getRoot() })
    .then(({ stdout }) => {
      const raw = stdout.trim();
      // SSH:   git@github.com:user/repo.git
      // HTTPS: https://github.com/user/repo.git  (or without .git)
      const sshMatch = raw.match(/^git@github\.com:(.+?)(?:\.git)?$/);
      const httpsMatch = raw.match(/^https?:\/\/github\.com\/(.+?)(?:\.git)?$/);
      const slug = sshMatch?.[1] ?? httpsMatch?.[1];
      if (slug) githubUrl = `https://github.com/${slug}`;
    })
    .catch(() => {
      /* not a git repo or no origin — leave null */
    });
}

function sendSse(res: SseClient, event: SwarmEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function fanout(event: SwarmEvent): void {
  for (const client of clients) {
    try {
      sendSse(client, event);
    } catch {
      clients.delete(client);
    }
  }
}

// ─── File watcher ─────────────────────────────────────────────────────────────
// Detects changes to state.json (written by either driver) and emits the right
// SSE events by diffing old vs new state.

function diffAndEmit(prev: SwarmState | null, next: SwarmState): void {
  if (!prev) {
    // First snapshot — emit current task graph so the UI can initialise
    fanout({ type: 'run.classified', tier: next.tier, tasks: next.tasks as unknown as Task[] });
    return;
  }

  // New run started: goal changed, or tasks were wiped from a non-empty previous run.
  // Emit run.classified to reset the UI completely (clears old tasks, findings, agents).
  // The return is safe — next.tasks is empty at this point; task.created events follow
  // as each task is added by subsequent addTask() calls.
  const isNewRun = prev.goal !== next.goal || (prev.tasks.length > 0 && next.tasks.length === 0);
  if (isNewRun) {
    fanout({ type: 'run.classified', tier: next.tier, tasks: next.tasks as unknown as Task[] });
    return;
  }

  const prevById = new Map(prev.tasks.map(t => [t.id, t]));

  for (const task of next.tasks) {
    const old = prevById.get(task.id);
    if (!old) {
      fanout({ type: 'task.created', task: task as unknown as Task });
    } else if (old.status !== task.status) {
      fanout({ type: 'task.status_changed', task_id: task.id, status: task.status });

      // Synthesise agent lifecycle events from status transitions
      if (task.status === 'in_progress') {
        fanout({ type: 'agent.started', agent_id: task.assignee });
      } else if (task.status === 'done' || task.status === 'failed' || task.status === 'blocked') {
        fanout({ type: 'agent.finished', agent_id: task.assignee });
      }
    }

    // New finding written — parse frontmatter so the UI gets verdict+summary immediately
    if (task.result_ref && task.result_ref !== old?.result_ref) {
      let verdict: string | undefined;
      let summary: string | undefined;
      try {
        const abs = path.resolve(swarmDir(), task.result_ref);
        const content = fs.readFileSync(abs, 'utf8');
        const m = content.match(/^---[\r\n]([\s\S]*?)[\r\n]---/);
        if (m) {
          for (const line of m[1].split('\n')) {
            const colon = line.indexOf(':');
            if (colon < 1) continue;
            const k = line.slice(0, colon).trim();
            const v = line
              .slice(colon + 1)
              .trim()
              .replace(/^["']|["']$/g, '');
            if (k === 'verdict') verdict = v;
            if (k === 'summary') summary = v;
          }
        }
      } catch {
        /* non-fatal — client falls back to path display */
      }
      fanout({
        type: 'finding.written',
        task_id: task.id,
        path: task.result_ref,
        verdict,
        summary,
      });
    }
  }

  // Log entries are forwarded by repo.appendLog() via the in-process bus — the bus
  // handler in repo.ts always emits log.appended synchronously, so we do NOT
  // re-emit them here. Doing so causes every PM message to appear twice (once from
  // the bus, once from the file-watcher diff). The file-watcher path only covers
  // events that the bus cannot: task graph changes, findings, and run lifecycle.

  // Run completed — all tasks reached a terminal state.
  // 'blocked' counts as terminal: it means the PM decided the task can't proceed
  // further (e.g. reviewer flagged issues that spawned separate fix/re-review tasks).
  // Those follow-on tasks are separate entries in the task list that complete
  // independently, leaving the original task permanently blocked.
  // 'skipped' counts as terminal: upstream produced no artifacts so dependents were skipped.
  const isTerminal = (s: string) =>
    s === 'done' || s === 'blocked' || s === 'failed' || s === 'skipped';
  if (
    next.tasks.length > 0 &&
    next.tasks.every(t => isTerminal(t.status)) &&
    !prev.tasks.every(t => isTerminal(t.status))
  ) {
    fanout({ type: 'run.completed' });
    snapshotSession().catch(err => console.error('[sessions] snapshot failed:', err));
  }

  // Run blocked / any failure
  const nowBlocked = next.tasks.some(t => t.status === 'failed' || t.status === 'blocked');
  const wasBlocked = prev.tasks.some(t => t.status === 'failed' || t.status === 'blocked');
  if (nowBlocked && !wasBlocked) {
    const reason =
      next.tasks.find(t => t.status === 'failed' || t.status === 'blocked')?.id ?? 'unknown';
    fanout({ type: 'run.blocked', reason });
  }
}

// Returns a stop() fn that closes all watchers — call before switching root.
function startFileWatcher(): () => void {
  let lastState: SwarmState | null = null;
  let watcher: ReturnType<typeof fs.watch> | null = null;
  let stopped = false;

  const tryRead = (): SwarmState | null => {
    try {
      return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    } catch {
      return null;
    }
  };

  const attach = (): void => {
    if (stopped || watcher) return;
    const sf = stateFile();
    if (!fs.existsSync(sf)) return;

    lastState = tryRead();
    console.log('  ▸ watching   → .swarm/state.json');

    watcher = fs.watch(sf, () => {
      // A rename (atomic write) closes the old inode — re-attach
      watcher?.close();
      watcher = null;
      if (!stopped) setTimeout(attach, 50);

      const next = tryRead();
      if (!next) return;
      try {
        diffAndEmit(lastState, next);
      } catch {
        /* diff error — skip */
      }
      lastState = next;
    });
  };

  // Also watch the .swarm/ directory in case state.json is created after the server starts
  const dir = swarmDir();
  let dirWatcher: ReturnType<typeof fs.watch> | null = null;
  if (fs.existsSync(dir)) {
    attach();
    dirWatcher = fs.watch(dir, (_ev, name) => {
      if (name === 'state.json') attach();
    });
  } else {
    // Watch parent until .swarm/ is created
    const parent = path.dirname(dir);
    if (fs.existsSync(parent)) {
      const pw = fs.watch(parent, (_ev, name) => {
        if (stopped) {
          pw.close();
          return;
        }
        if (name === path.basename(dir) && fs.existsSync(dir)) {
          pw.close();
          attach();
          dirWatcher = fs.watch(dir, (_ev2, name2) => {
            if (name2 === 'state.json') attach();
          });
        }
      });
    }
  }

  return () => {
    stopped = true;
    watcher?.close();
    watcher = null;
    dirWatcher?.close();
    dirWatcher = null;
  };
}

function handleGet(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  if (url.pathname === '/state') {
    try {
      const state = getState();
      const driver = getDriverMode();
      const cfg = getConfigOptional();
      // model: for agent-sdk the session model is chosen by the claude CLI, not us;
      // for api-key we know the exact model ID from config.
      const model = driver === 'agent-sdk' ? null : cfg.coderModel;

      // Enrich tasks with finding verdict+summary so the UI can populate
      // the findings panel on initial load (not just via SSE events).
      const enrichedTasks = (state.tasks as unknown as Record<string, unknown>[]).map(t => {
        const ref = t.result_ref as string | null;
        if (!ref) return t;
        try {
          const abs = path.resolve(swarmDir(), ref);
          const content = fs.readFileSync(abs, 'utf8');
          const m = content.match(/^---[\r\n]([\s\S]*?)[\r\n]---/);
          if (!m) return t;
          let verdict: string | undefined, summary: string | undefined;
          for (const line of m[1].split('\n')) {
            const colon = line.indexOf(':');
            if (colon < 1) continue;
            const k = line.slice(0, colon).trim();
            const v = line
              .slice(colon + 1)
              .trim()
              .replace(/^["']|["']$/g, '');
            if (k === 'verdict') verdict = v;
            if (k === 'summary') summary = v;
          }
          return { ...t, finding_verdict: verdict, finding_summary: summary };
        } catch {
          return t;
        }
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(
        JSON.stringify({
          ...state,
          tasks: enrichedTasks,
          driver,
          model,
          activeRun,
          repoUrl: githubUrl,
          root: getRoot(),
          project: path.basename(getRoot()),
        }),
      );
    } catch {
      // No state.json yet (no run started) — still return 200 so the UI
      // recognises the server as up and shows "agents ready" instead of "offline".
      const driver = getDriverMode();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(
        JSON.stringify({
          project: '',
          goal: '',
          tier: '',
          tasks: [],
          log: [],
          driver,
          model: null,
          activeRun: false,
          repoUrl: githubUrl,
          root: getRoot(),
        }),
      );
    }
    return;
  }

  if (url.pathname === '/run/preflight') {
    // Readiness checks for the TARGET repo (getRoot), so the dashboard can surface
    // the dirty-tree / wrong-repo footguns before a run instead of as a raw 400.
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(runPreflight(getRoot())));
    return;
  }

  if (url.pathname === '/server/info') {
    // Reports whether the running backend source is older than what's on disk, so
    // the dashboard can nudge for a restart (tsx loads source once at startup).
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(serverFreshness()));
    return;
  }

  if (url.pathname === '/capabilities') {
    // Is the visual gate actually usable? Requires BOTH the playwright package and a
    // downloaded browser binary — package-only would advertise a capability that fails
    // at run time. Checked live each request (it can change without a restart).
    (async () => {
      let playwright = false;
      try {
        const pw = (await import('playwright' as string)) as {
          chromium: { executablePath: () => string };
        };
        const exe = pw.chromium.executablePath();
        playwright = !!exe && fs.existsSync(exe);
      } catch {
        /* not installed */
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ playwright }));
    })();
    return;
  }

  if (url.pathname === '/context') {
    const SKIP = new Set([
      'node_modules',
      '.git',
      '.swarm',
      'dist',
      '.next',
      'build',
      'coverage',
      '__pycache__',
      '.venv',
      '.cache',
      'tmp',
      'vendor',
      '.turbo',
      '.yarn',
      'out',
      'storybook-static',
    ]);
    const root = getRoot();
    const rootClaude = path.join(root, 'CLAUDE.md');
    const contextFiles: Array<{ relPath: string; content: string }> = [];

    const scan = (dir: string, depth: number): void => {
      if (depth > 6) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) {
          scan(path.join(dir, e.name), depth + 1);
        } else if (e.isFile() && (e.name === 'CONTEXT.md' || e.name === 'CLAUDE.md')) {
          const abs = path.join(dir, e.name);
          if (abs === rootClaude) continue; // returned separately as projectMd
          try {
            contextFiles.push({
              relPath: path.relative(root, abs),
              content: fs.readFileSync(abs, 'utf8'),
            });
          } catch {
            /* skip unreadable */
          }
        }
      }
    };
    scan(root, 0);
    contextFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));

    const pcf = projectContextFile();
    const projectMd = fs.existsSync(pcf)
      ? { relPath: 'CLAUDE.md', content: fs.readFileSync(pcf, 'utf8') }
      : null;

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ projectMd, contextFiles }));
    return;
  }

  if (url.pathname === '/run/review') {
    // The persisted review draft (comments left on the diff).
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ comments: readReview() }));
    return;
  }

  if (url.pathname === '/run/diff/structured') {
    // Structured diff (parsed hunks + language + old/new content) for the review
    // surface. The UI tokenizes whole files with Shiki, so it needs full content.
    buildStructuredDiff(path.dirname(swarmDir()))
      .then(structured => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(structured));
      })
      .catch((err: Error) => {
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ error: err.message, source: 'error', files: [] }));
      });
    return;
  }

  if (url.pathname === '/run/diff') {
    const cwd = path.dirname(swarmDir());

    // Build a unified diff that covers:
    //   A) modifications to tracked files  → git diff HEAD
    //   B) new untracked files             → git diff --no-index /dev/null <file>
    //      (git diff always exits 1 when files differ; catch stderr and use stdout)
    // If both are empty, fall back to committed changes ahead of main/master/HEAD~1.

    Promise.all([
      // A — tracked modifications
      execFileAsync('git', ['diff', 'HEAD'], { cwd })
        .then(r => r.stdout)
        .catch(() => ''),
      // Get untracked files (excluding gitignored)
      execFileAsync('git', ['status', '--porcelain'], { cwd })
        .then(r => r.stdout)
        .catch(() => ''),
    ])
      .then(async ([trackedDiff, statusOut]) => {
        const untrackedFiles = statusOut
          .split('\n')
          .filter(l => l.startsWith('??'))
          .map(l => l.slice(3).trim())
          .filter(f => f && !f.endsWith('/'));

        // B — new files: git diff --no-index always exits 1, so extract stdout from the error
        const newFileDiffs = await Promise.all(
          untrackedFiles.map(f =>
            execFileAsync('git', ['diff', '--no-index', '--', '/dev/null', f], { cwd })
              .then(r => r.stdout)
              .catch((err: { stdout?: Buffer }) => err.stdout?.toString() ?? ''),
          ),
        );

        const combined = [trackedDiff, ...newFileDiffs].filter(s => s.trim()).join('\n');

        if (combined.trim()) {
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(combined);
          return;
        }

        // Fallback: committed changes ahead of main / master / last commit
        const fallbacks = [
          ['diff', 'main...HEAD'],
          ['diff', 'master...HEAD'],
          ['diff', 'HEAD~1'],
        ];
        for (const args of fallbacks) {
          try {
            const { stdout } = await execFileAsync('git', args, { cwd });
            if (stdout.trim()) {
              res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
              });
              res.end(stdout);
              return;
            }
          } catch {
            /* try next */
          }
        }

        // Genuinely nothing to show
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end('');
      })
      .catch(() => {
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end('');
      });
    return;
  }

  if (url.pathname === '/branches') {
    (async () => {
      const cwd = getRoot();
      const git = (args: string[]) =>
        execFileAsync('git', args, { cwd, encoding: 'utf8' })
          .then(r => (r.stdout as string).trim())
          .catch(() => '');

      // Detect default branch (main / master / etc.)
      const defaultBranchRaw = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      const defaultBranch = defaultBranchRaw.replace('origin/', '') || 'main';

      const currentBranch = await git(['branch', '--show-current']);
      const rawList = await git(['branch', '--list', 'swarm/*', '--format=%(refname:short)']);
      const branchNames = rawList.split('\n').filter(Boolean);

      const mergedRaw = await git([
        'branch',
        '--merged',
        defaultBranch,
        '--list',
        'swarm/*',
        '--format=%(refname:short)',
      ]);
      const mergedSet = new Set(mergedRaw.split('\n').filter(Boolean));

      // PR info from gh CLI — best-effort, skip if not available
      type GhPr = {
        number: number;
        title: string;
        url: string;
        state: string;
        headRefName: string;
      };
      const prMap = new Map<string, GhPr>();
      await execFileAsync(
        'gh',
        [
          'pr',
          'list',
          '--json',
          'number,title,url,state,headRefName',
          '--limit',
          '100',
          '--state',
          'all',
        ],
        { cwd, encoding: 'utf8' },
      )
        .then(r => {
          const prs = JSON.parse(r.stdout as string) as GhPr[];
          for (const pr of prs) prMap.set(pr.headRefName, pr);
        })
        .catch(() => {
          /* gh not available or not authenticated */
        });

      const branches = await Promise.all(
        branchNames.map(async name => {
          const log = await git(['log', '-1', '--format=%h|%s|%aI', name]);
          const [hash = '', message = '', date = ''] = log.split('|');
          const aheadRaw = await git(['rev-list', '--count', `${defaultBranch}..${name}`]);
          const ahead = parseInt(aheadRaw) || 0;
          const pr = prMap.get(name) ?? prMap.get(name.replace(/^swarm\//, ''));
          const remoteCheck = await git(['branch', '-r', '--list', `origin/${name}`]);
          const pushed = remoteCheck.trim().length > 0;
          return {
            name,
            shortName: name.replace(/^swarm\//, ''),
            isCurrent: name === currentBranch,
            merged: mergedSet.has(name),
            pushed,
            lastCommit: { hash, message, date },
            ahead,
            pr: pr
              ? { number: pr.number, url: pr.url, title: pr.title, state: pr.state.toLowerCase() }
              : null,
          };
        }),
      );

      branches.sort((a, b) => {
        if (a.isCurrent && !b.isCurrent) return -1;
        if (b.isCurrent && !a.isCurrent) return 1;
        return b.lastCommit.date.localeCompare(a.lastCommit.date);
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ branches, defaultBranch, repoUrl: githubUrl }));
    })().catch(err => {
      res.writeHead(500);
      res.end(String(err));
    });
    return;
  }

  if (url.pathname === '/branches/commits') {
    const branch = url.searchParams.get('branch');
    if (!branch) {
      res.writeHead(400);
      res.end('branch required');
      return;
    }
    (async () => {
      const cwd = getRoot();
      const git = (args: string[]) =>
        execFileAsync('git', args, { cwd, encoding: 'utf8' })
          .then(r => (r.stdout as string).trim())
          .catch(() => '');

      const defaultBranchRaw = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      const defaultBranch = defaultBranchRaw.replace('origin/', '') || 'main';

      // Commits in this branch not in defaultBranch, newest first
      const raw = await git(['log', '--format=%H|%h|%s|%aI', `${defaultBranch}..${branch}`]);
      const commits = raw
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [hash = '', shortHash = '', message = '', date = ''] = line.split('|');
          return { hash, shortHash, message, date };
        });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ commits }));
    })().catch(err => {
      res.writeHead(500);
      res.end(String(err));
    });
    return;
  }

  if (url.pathname === '/run/branch-pushed') {
    // Determines whether a branch's work has been shipped so the Ship modal
    // can show the right state. Three independent signals, any one is enough:
    //   1. ls-remote  — branch still exists on the remote
    //   2. git cherry — all commits landed in default branch (detects cherry-picks)
    //   3. gh pr      — a PR was created (implies a prior push)
    (async () => {
      let branchName: string | undefined;
      try {
        branchName = (getState() as { branchName?: string }).branchName;
      } catch {}
      if (!branchName) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ pushed: false, alreadyInMain: false, pr: null }));
        return;
      }

      const cwd = getRoot();
      const git = (args: string[]) =>
        execFileAsync('git', args, { cwd, encoding: 'utf8' })
          .then(r => (r.stdout as string).trim())
          .catch(() => '');

      // Signal 1: ls-remote contacts GitHub directly — authoritative even after
      // branch deletion. Fall back to local ref cache if offline.
      let pushed = false;
      const lsRemote = await git(['ls-remote', '--heads', 'origin', branchName]);
      if (lsRemote.length > 0) {
        pushed = true;
      } else {
        const localRef = await git(['branch', '-r', '--list', `origin/${branchName}`]);
        pushed = localRef.trim().length > 0;
      }

      // Signal 2: git cherry compares patch content (not SHA), so it detects
      // cherry-picks where the branch was never pushed to the remote.
      // `git cherry <upstream> <head>` outputs "+ SHA" for commits NOT yet in
      // upstream, "- SHA" for commits that are equivalent. If there are no "+"
      // lines, every commit from the branch landed in the default branch.
      let alreadyInMain = false;
      const defaultBranchRaw = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      const defaultBranch = defaultBranchRaw.replace('origin/', '') || 'main';
      const cherryOut = await git(['cherry', defaultBranch, branchName]);
      if (cherryOut.length > 0) {
        // Any line starting with "+" means that commit is not yet in main
        alreadyInMain = !cherryOut.split('\n').some(l => l.startsWith('+ '));
      }

      // Signal 3: PR existence (implies a prior push even if branch is now deleted)
      let pr: { url: string; state: string } | null = null;
      await execFileAsync(
        'gh',
        [
          'pr',
          'list',
          '--head',
          branchName,
          '--json',
          'url,state',
          '--limit',
          '1',
          '--state',
          'all',
        ],
        { cwd, encoding: 'utf8' },
      )
        .then(r => {
          const prs = JSON.parse(r.stdout as string) as Array<{ url: string; state: string }>;
          if (prs.length > 0) {
            pr = { url: prs[0].url, state: prs[0].state.toLowerCase() };
            pushed = true;
          }
        })
        .catch(() => {
          /* gh not available */
        });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ pushed, alreadyInMain, pr }));
    })().catch(err => {
      res.writeHead(500);
      res.end(String(err));
    });
    return;
  }

  if (url.pathname === '/sessions') {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ sessions: [] }));
      return;
    }
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const verdictMap: Record<string, string> = {
        COMPLETE: 'complete',
        PASS: 'pass',
        APPROVED: 'pass',
        FAILED: 'fail',
        FAIL: 'fail',
        CHANGES_REQUESTED: 'changes',
      };
      const sessions = entries
        .filter(e => e.isDirectory())
        .map(e => {
          try {
            const snap = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'index.json'), 'utf8'));
            let passCount = 0,
              failCount = 0;
            for (const t of snap.tasks ?? []) {
              const v = verdictMap[(t.finding_verdict ?? '').toUpperCase()];
              if (v === 'pass' || v === 'complete') passCount++;
              if (v === 'fail' || v === 'changes') failCount++;
            }
            return {
              id: snap.id,
              savedAt: snap.savedAt,
              project: snap.project,
              goal: snap.goal,
              tier: snap.tier,
              branchName: snap.branchName,
              taskCount: (snap.tasks ?? []).length,
              passCount,
              failCount,
              elapsedMs: snap.elapsedMs,
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b!.savedAt.localeCompare(a!.savedAt));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ sessions }));
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
    return;
  }

  if (url.pathname.startsWith('/sessions/')) {
    const id = url.pathname.slice('/sessions/'.length).split('/')[0];
    if (!id) {
      res.writeHead(400);
      res.end('session id required');
      return;
    }
    const indexPath = path.join(sessionsDir(), id, 'index.json');
    if (!fs.existsSync(indexPath)) {
      res.writeHead(404);
      res.end('session not found');
      return;
    }
    try {
      const snap = fs.readFileSync(indexPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(snap);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
    return;
  }

  if (url.pathname === '/findings/image') {
    // Serve a binary image referenced by a finding (e.g. the visual gate's
    // `.swarm/visual/<task>/*.png`). Kept separate from the text `/findings`
    // handler so each route has one job and one return shape.
    const relPath = url.searchParams.get('path');
    if (!relPath) {
      res.writeHead(400);
      res.end('path required');
      return;
    }
    const IMAGE_MIME: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
    };
    const ext = path.extname(relPath).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) {
      res.writeHead(415);
      res.end('unsupported image type');
      return;
    }
    try {
      const abs = path.resolve(swarmDir(), relPath);
      // Safety: must stay inside .swarm/
      if (!abs.startsWith(swarmDir())) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      const bytes = fs.readFileSync(abs);
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
    return;
  }

  if (url.pathname === '/findings') {
    const relPath = url.searchParams.get('path');
    if (!relPath) {
      res.writeHead(400);
      res.end('path required');
      return;
    }
    try {
      const abs = path.resolve(swarmDir(), relPath);
      // Safety: must stay inside .swarm/
      if (!abs.startsWith(swarmDir())) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      const content = fs.readFileSync(abs, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
    return;
  }

  if (url.pathname === '/fs') {
    // Returns subdirectories of a given path for the project-switcher browser.
    const rawPath = url.searchParams.get('path') || getRoot();
    const target = path.resolve(rawPath);
    try {
      const entries = fs.readdirSync(target, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => {
          const full = path.join(target, e.name);
          const hasSwarm = fs.existsSync(path.join(full, '.swarm', 'state.json'));
          return { name: e.name, path: full, hasSwarm };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(target) !== target ? path.dirname(target) : null;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ path: target, parent, entries: dirs }));
    } catch {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(
        JSON.stringify({ path: target, parent: null, entries: [], error: 'Cannot read directory' }),
      );
    }
    return;
  }

  if (url.pathname === '/marketplace/scorecards') {
    // Per-agent track records aggregated across all saved runs.
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ scorecards: buildScorecards() }));
    return;
  }

  if (url.pathname === '/marketplace/roster') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(loadRoster()));
    return;
  }

  if (url.pathname === '/marketplace/connectors/available') {
    probeAvailableConnectors()
      .then(available => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ available: [...available] }));
      })
      .catch(() => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ available: [] }));
      });
    return;
  }

  if (url.pathname === '/agent-prompts') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(
      JSON.stringify({
        pm: PM_SYSTEM,
        coder: CODER_SYSTEM,
        tester: TESTER_SYSTEM,
        reviewer: REVIEWER_SYSTEM,
        security: SECURITY_SYSTEM,
      }),
    );
    return;
  }

  if (url.pathname === '/agent-instructions') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(loadBuiltinInstructions()));
    return;
  }

  if (url.pathname === '/agent-models') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(loadBuiltinModels()));
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n'); // initial ping so the client knows it's connected

    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Serve the built UI from ui/dist if it exists, otherwise 404.
  const uiDist = path.resolve(import.meta.dirname, '../../..', 'ui', 'dist');
  if (fs.existsSync(uiDist)) {
    let filePath = path.join(uiDist, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!fs.existsSync(filePath)) filePath = path.join(uiDist, 'index.html'); // SPA fallback
    const ext = path.extname(filePath);
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.png': 'image/png',
    };
    res.writeHead(200, { 'Content-Type': mime[ext] ?? 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

function handlePost(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  // Actions from the UI — Phase 3 wires these to real orchestrator state.
  // Stubs that acknowledge and return 200 so the UI doesn't error.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  let body = '';
  req.on('data', d => {
    body += d;
  });
  req.on('end', async () => {
    const payload = body ? JSON.parse(body) : {};
    const route = url.pathname;

    if (route === '/marketplace/roster') {
      try {
        const roster = Array.isArray(payload) ? payload : [];
        saveRoster(roster);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    if (route === '/agent-instructions') {
      try {
        saveBuiltinInstructions(payload as Record<string, string>);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    if (route === '/agent-models') {
      try {
        saveBuiltinModels(payload as Record<string, string>);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    if (route === '/pm/message') {
      const {
        text,
        history = [],
        charter,
        team,
        activeRoot,
      } = payload as {
        text: string;
        history?: unknown[];
        charter?: {
          goal?: string;
          constraints?: string[];
          nongoals?: string[];
          questions?: string[];
        };
        team?: string[];
        activeRoot?: string; // client's localStorage swarm-active-root — used to self-heal server root on startup
      };
      if (!text) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'text required' }));
        return;
      }
      // If the client knows a different root than the server (e.g. after a restart before auto-sync),
      // apply it now so this PM call — and all subsequent state — uses the correct project.
      if (activeRoot && activeRoot !== getRoot()) {
        const resolved = path.resolve(activeRoot.trim());
        console.log(`[pm/message] self-healing root: ${getRoot()} → ${resolved}`);
        setRoot(resolved);
        restartWatcher();
      }
      // Respond as SSE so the UI can stream reply text as it arrives.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const sendPmEvent = (data: unknown) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      runPmMessage(
        text,
        history as any,
        charter,
        team,
        (chunk: string) => {
          sendPmEvent({ type: 'chunk', text: chunk });
        },
        ({ phase, question, summary, agent }) => {
          sendPmEvent({ type: 'research', phase, question, summary, agent });
        },
        (thinking: string) => {
          sendPmEvent({ type: 'thinking', text: thinking });
        },
      )
        .then(result => {
          sendPmEvent({ type: 'result', ...result });
          res.end();
        })
        .catch(err => {
          console.error('[pm/message] error:', (err as Error).message);
          sendPmEvent({ type: 'error', error: (err as Error).message });
          res.end();
        });
      return;
    }
    if (route === '/run/review/pm') {
      // PM-coordinated path, in-surface: run a PM planning turn over the review
      // comments. If the PM produces a task graph, execute it (comments go
      // fixing → resolved, polled by the UI); if it instead replies with a question
      // or pushback, surface that and leave the comments open for the user.
      if (activeRun) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'A run is already in progress' }));
        return;
      }
      const pmComments = readReview().filter(c => c.body.trim());
      if (pmComments.length === 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'no comments to plan' }));
        return;
      }
      const pmReviewLines = pmComments.map(c => {
        const range = c.endLine !== c.startLine ? `${c.startLine}-${c.endLine}` : `${c.startLine}`;
        return `- ${c.file}:${range} — ${c.body.trim()}`;
      });
      const pmMessage = `I reviewed the changes and left these code-review comments. Plan and apply the fixes on the current branch; if anything is ambiguous or you disagree, say so instead of guessing:\n${pmReviewLines.join('\n')}`;
      activeRun = true; // hold the slot through PM planning + any execution
      runPmMessage(pmMessage, [])
        .then(pmResp => {
          const graph = pmResp.taskGraph?.length ? pmResp.taskGraph : null;
          if (!graph) {
            // PM pushed back / asked a question — don't execute; surface the reply.
            activeRun = false;
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, reply: pmResp.reply, executing: false }));
            return;
          }
          writeReview(pmComments.map(c => ({ ...c, status: 'fixing' as const })));
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, reply: pmResp.reply, executing: true }));
          const pmCharter: import('../state/types.js').RunCharter = {
            constraints: ['Apply the reviewer’s comments — do not refactor unrelated code.'],
            nongoals: [],
            questions: [],
            branchMode: 'main',
            taskGraph: graph,
          };
          runNew(pmMessage, pmCharter)
            .then(() => {
              writeReview(readReview().map(c => ({ ...c, status: 'resolved' as const })));
            })
            .catch(err => {
              console.error('  ✗ review pm-fix error:', (err as Error).message);
              writeReview(readReview().map(c => ({ ...c, status: 'open' as const })));
              fanout({ type: 'run.blocked', reason: (err as Error).message });
            })
            .finally(() => {
              activeRun = false;
            });
        })
        .catch(err => {
          activeRun = false;
          console.error('  ✗ review pm-plan error:', (err as Error).message);
          res.writeHead(500);
          res.end(JSON.stringify({ error: (err as Error).message }));
        });
      return;
    }
    if (route === '/run/review/fix') {
      // Fast path: apply the review comments directly via a coder + reviewer run, no
      // PM round. The comments reach the coder through the run goal + constraints.
      if (activeRun) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'A run is already in progress' }));
        return;
      }
      const comments = readReview().filter(c => c.body.trim());
      if (comments.length === 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'no comments to apply' }));
        return;
      }
      const reviewLines = comments.map(c => {
        const range = c.endLine !== c.startLine ? `${c.startLine}-${c.endLine}` : `${c.startLine}`;
        return `- ${c.file}:${range} — ${c.body.trim()}`;
      });
      const goal = `Apply these code-review comments to the existing code on the current branch:\n${reviewLines.join('\n')}`;
      const charter: import('../state/types.js').RunCharter = {
        constraints: [
          'Apply exactly the requested review changes — do not refactor or touch unrelated code.',
        ],
        nongoals: [],
        questions: [],
        branchMode: 'main', // fix the current branch in place — do not spin a new one
        taskGraph: [
          {
            id: 't_review_fix',
            assignee: 'coder',
            title: 'Apply the review comments',
            depends_on: [],
          },
          {
            id: 't_review_check',
            assignee: 'reviewer',
            title: 'Re-review the applied changes',
            depends_on: ['t_review_fix'],
          },
        ],
      };

      activeRun = true;
      writeReview(comments.map(c => ({ ...c, status: 'fixing' as const })));
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      console.log(`\n  ▸ review fix: ${comments.length} comment(s)\n`);
      runNew(goal, charter)
        .then(() => {
          // Mark the comments resolved (don't drop them) so the review surface can
          // show they were addressed; the user dismisses them when ready.
          writeReview(readReview().map(c => ({ ...c, status: 'resolved' as const })));
        })
        .catch(err => {
          console.error('  ✗ review fix error:', (err as Error).message);
          // Roll the comments back to open so the user can retry.
          writeReview(readReview().map(c => ({ ...c, status: 'open' as const })));
          fanout({ type: 'run.blocked', reason: (err as Error).message });
        })
        .finally(() => {
          activeRun = false;
        });
      return;
    }
    if (route === '/run/review/save') {
      // Persist the review draft so it survives reload and is readable by fixers.
      const { comments } = payload as { comments?: import('./review.js').ReviewComment[] };
      try {
        writeReview(Array.isArray(comments) ? comments : []);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }
    if (route === '/run/message') {
      const { text } = payload as { text?: string };
      if (!text?.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'text required' }));
        return;
      }
      try {
        appendLog('user', text.trim());
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // ── Delete a local swarm branch ───────────────────────────────────────────────
    // Local-only (`git branch -D`). Restricted to swarm/* branches — which also
    // structurally protects main/master (they don't carry that prefix) — and refuses
    // the currently checked-out branch. The UI's confirm dialog handles warning the
    // user about unmerged/never-pushed branches before this is ever called.
    if (route === '/branches/delete') {
      const { branch } = payload as { branch?: string };
      if (typeof branch !== 'string' || !branch.startsWith('swarm/')) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'only swarm/* branches can be deleted here' }));
        return;
      }
      (async () => {
        const cwd = getRoot();
        const runGit = (args: string[]) =>
          execFileAsync('git', args, { cwd, encoding: 'utf8' }).then(r =>
            (r.stdout as string).trim(),
          );
        const current = await runGit(['branch', '--show-current']).catch(() => '');
        if (branch === current) {
          res.writeHead(409);
          res.end(
            JSON.stringify({ error: 'cannot delete the branch that is currently checked out' }),
          );
          return;
        }
        try {
          await runGit(['branch', '-D', branch]);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          const msg =
            (err as { stderr?: Buffer | string }).stderr?.toString().trim() ||
            (err as Error).message;
          res.writeHead(400);
          res.end(JSON.stringify({ error: msg }));
        }
      })().catch(err => {
        res.writeHead(500);
        res.end(String(err));
      });
      return;
    }

    // ── Live agent progress (cross-process) ──────────────────────────────────────
    // The agent driver runs in the `swarm new` loop process and POSTs thinking /
    // tool-call events here; we fan them straight out to SSE clients. Telemetry
    // only — validated loosely, never persisted.
    if (route === '/run/progress') {
      const ev = payload as { type?: string; agent_id?: string };
      if (
        (ev.type === 'agent.thinking' ||
          ev.type === 'agent.progress' ||
          ev.type === 'agent.tool') &&
        typeof ev.agent_id === 'string'
      ) {
        fanout(ev as SwarmEvent);
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid progress event' }));
      }
      return;
    }

    // ── Permission gates ────────────────────────────────────────────────────────
    // POST /run/permission/request  — MCP proxy long-polls here; returns when user decides
    // POST /run/permission/:id      — UI sends the user's allow/deny decision
    if (route === '/run/permission/request') {
      const { agent_id, tool, input } = payload as {
        agent_id: string;
        tool: string;
        input: Record<string, unknown>;
      };
      if (!agent_id || !tool) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'agent_id and tool required' }));
        return;
      }
      // Keep connection open until user decides (up to 10 min — broker auto-denies at that point).
      // No socket timeout here; the broker's internal timer handles the limit.
      req.socket.setTimeout(0);
      requestPermission(agent_id, tool, input ?? {})
        .then(decision => {
          res.writeHead(200);
          res.end(JSON.stringify({ decision }));
        })
        .catch(() => {
          res.writeHead(200);
          res.end(JSON.stringify({ decision: 'deny' }));
        });
      return;
    }

    if (route.startsWith('/run/permission/')) {
      const requestId = route.slice('/run/permission/'.length);
      const { decision } = payload as { decision?: string };
      if (decision !== 'allow' && decision !== 'deny') {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'decision must be allow or deny' }));
        return;
      }
      const ok = resolvePermission(requestId, decision);
      res.writeHead(ok ? 200 : 404);
      res.end(JSON.stringify({ ok }));
      return;
    }

    if (route === '/run/execute') {
      if (activeRun) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'A run is already in progress' }));
        return;
      }
      const { goal, charter, team } = payload as {
        goal?: string;
        charter?: import('../state/types.js').RunCharter;
        team?: string[];
      };
      if (!goal?.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'goal required' }));
        return;
      }

      // ── Git safety check (synchronous, before 200) ───────────────────────────
      // Must run here — not inside the async runNew() — so we can return a 4xx
      // directly to the client. If we let it throw inside the async path the SSE
      // run.blocked event fires after the client's EventSource connects, causing
      // a race where the event is missed and the UI stays stuck on the Running tab.
      // Also use getRoot() so we check the TARGET project, not the swarm repo.
      try {
        checkGitClean(getRoot());
      } catch (err) {
        const msg = (err as Error).message;
        console.error('  ✗ execute error:', msg);
        res.writeHead(400);
        res.end(JSON.stringify({ error: msg }));
        return;
      }

      // Create a feature branch if the PM recommended one.
      let branchName: string | undefined;
      if (charter?.branchMode === 'branch') {
        const cwd = path.dirname(swarmDir());
        // Use the user-set slug if provided; otherwise derive from goal + timestamp.
        let slug =
          charter.branchName
            ?.trim()
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '') || '';
        if (!slug) {
          const goalSlug = goal
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, '-')
            .slice(0, 40)
            .replace(/-+$/, '');
          const ts = new Date()
            .toISOString()
            .slice(0, 16)
            .replace(/[^0-9]/g, ''); // YYYYMMDDHHmm
          slug = `${goalSlug}-${ts}`;
        }
        branchName = `swarm/${slug}`;
        try {
          await execFileAsync('git', ['checkout', '-b', branchName], { cwd });
          console.log(`  ▸ created branch: ${branchName}`);
        } catch (err) {
          const msg =
            (err as { stderr?: Buffer; message: string }).stderr?.toString().trim() ||
            (err as Error).message;
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Could not create branch: ${msg}` }));
          return;
        }
      }

      activeRun = true;
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      console.log(`\n  ▸ execute: "${goal}"\n`);
      const capturedBranch = branchName;
      runNew(goal.trim(), charter, team, branchName)
        .then(async () => {
          // If we created a branch but the run produced no commits, clean it up.
          // This happens when the coder skipped (no files changed) or every task
          // failed before writing anything. Leaving an empty branch around is noise.
          if (capturedBranch) {
            const cwd = path.dirname(swarmDir());
            try {
              const defaultBranch = await execFileAsync(
                'git',
                ['symbolic-ref', 'refs/remotes/origin/HEAD'],
                { cwd },
              )
                .then(r => r.stdout.trim().split('/').pop() ?? 'main')
                .catch(() =>
                  execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
                    .then(r => r.stdout.trim())
                    .catch(() => 'main'),
                );
              const ahead = await execFileAsync(
                'git',
                ['log', '--oneline', `${defaultBranch}..${capturedBranch}`],
                { cwd },
              )
                .then(r => r.stdout.trim())
                .catch(() => '');
              if (!ahead) {
                await execFileAsync('git', ['checkout', defaultBranch], { cwd });
                await execFileAsync('git', ['branch', '-d', capturedBranch], { cwd });
                console.log(`  ▸ empty branch deleted: ${capturedBranch}`);
                fanout({
                  type: 'log.appended',
                  actor: 'pm',
                  event: `Branch ${capturedBranch} had no commits — deleted`,
                });
              }
            } catch {
              /* non-fatal — branch cleanup is best-effort */
            }
          }
        })
        .catch(err => {
          const msg = (err as Error).message ?? 'Unknown error';
          console.error('  ✗ execute error:', msg);
          // Surface the failure to the UI via SSE so the user knows what happened.
          fanout({ type: 'run.blocked', reason: msg });
        })
        .finally(() => {
          activeRun = false;
        });
      return;
    }
    if (route === '/run/pause') {
      pauseRun();
      fanout({ type: 'run.paused' });
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (route === '/run/resume') {
      resumeRun();
      fanout({ type: 'run.classified', tier: 'feature', tasks: [] }); // nudge UI back to running
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (route === '/run/abort') {
      abortRun();
      fanout({ type: 'run.aborted' });
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (route === '/run/push') {
      const cwd = path.dirname(swarmDir());
      execFileAsync('git', ['push', 'origin', 'HEAD'], { cwd })
        .then(() => {
          appendLog('pm', '⬆ Pushed to remote successfully');
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        })
        .catch((err: { stderr?: Buffer; message: string }) => {
          const msg = (err.stderr?.toString().trim() || err.message).slice(0, 300);
          appendLog('pm', `✗ Push failed: ${msg}`);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: false, error: msg }));
        });
      return;
    }

    if (route === '/run/pr') {
      let state: ReturnType<typeof getState>;
      try {
        state = getState();
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'No run state found' }));
        return;
      }
      const cwd = path.dirname(swarmDir());
      const title = state.goal.slice(0, 120);
      const parts: string[] = [state.goal];
      const constraints = state.charter?.constraints ?? [];
      const nongoals = state.charter?.nongoals ?? [];
      if (constraints.length)
        parts.push('## Constraints\n' + constraints.map(c => `- ${c}`).join('\n'));
      if (nongoals.length) parts.push('## Non-goals\n' + nongoals.map(n => `- ${n}`).join('\n'));
      parts.push('🤖 Generated with Agent Swarm');
      const body = parts.join('\n\n');

      // Safety net: commit any changes the coder left uncommitted before pushing.
      const autoCommit = execFileAsync('git', ['status', '--porcelain'], { cwd })
        .then(({ stdout }) => {
          if (!stdout.trim()) return;
          return execFileAsync('git', ['add', '-A'], { cwd }).then(() =>
            execFileAsync('git', ['commit', '-m', `swarm: ${state.goal.slice(0, 72)}`], { cwd }),
          );
        })
        .catch(() => {
          /* no git repo or nothing to commit — ignore */
        });

      // Push the branch first so `gh pr create` always finds it on the remote.
      autoCommit
        .then(() => execFileAsync('git', ['push', '--set-upstream', 'origin', 'HEAD'], { cwd }))
        .catch(() => {
          /* already pushed — ignore */
        })
        .then(() =>
          execFileAsync('gh', ['pr', 'create', '--title', title, '--body', body], { cwd }),
        )
        .then(({ stdout }) => {
          const url = stdout.trim().match(/https:\/\/\S+/)?.[0] ?? undefined;
          appendLog('pm', `⬆ PR created${url ? `: ${url}` : ''}`);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, url: url ?? null }));
        })
        .catch((err: { stderr?: Buffer; message: string; code?: string }) => {
          const isEnoent = (err as { code?: string }).code === 'ENOENT';
          const msg = isEnoent
            ? 'GitHub CLI (gh) not installed — install it with: brew install gh  then run: gh auth login'
            : (err.stderr?.toString().trim() || err.message).slice(0, 300);
          appendLog('pm', `✗ PR creation failed: ${msg}`);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: false, error: msg, ghNotInstalled: isEnoent }));
        });
      return;
    }

    if (route === '/project/switch') {
      if (activeRun) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'Cannot switch projects while a run is in progress' }));
        return;
      }
      const { path: newPath } = payload as { path?: string };
      if (!newPath?.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'path required' }));
        return;
      }
      const resolved = path.resolve(newPath.trim());
      if (!fs.existsSync(resolved)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: `Directory not found: ${resolved}` }));
        return;
      }
      try {
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Path is not a directory' }));
          return;
        }
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Cannot access path' }));
        return;
      }

      // Switch root, restart watcher, refresh GitHub URL
      setRoot(resolved);
      restartWatcher();
      githubUrl = null;
      detectGithubUrl();

      const project = path.basename(resolved);
      const hasSwarm = fs.existsSync(path.join(resolved, '.swarm', 'state.json'));
      console.log(`  ▸ switched   → ${resolved}`);

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, project, hasSwarm, repoUrl: githubUrl }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'unknown route' }));
  });
}

export function startServer(port: number): http.Server {
  // Kick off GitHub URL detection immediately — result is cached and used by /state.
  // Fire-and-forget; if git isn't available the cached value stays null.
  detectGithubUrl();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (req.method === 'GET') {
      handleGet(req, res, url);
      return;
    }
    if (req.method === 'POST') {
      handlePost(req, res, url);
      return;
    }

    res.writeHead(405);
    res.end();
  });

  // Source 1: in-process bus (api-key driver emits here via state repo)
  bus.on('swarm', fanout);

  // Source 2: file watcher (agent-sdk driver writes state.json as subprocess)
  stopCurrentWatcher = startFileWatcher();

  server.listen(port, '127.0.0.1', () => {
    console.log(`  ▸ server     → http://localhost:${port}`);
  });

  return server;
}
