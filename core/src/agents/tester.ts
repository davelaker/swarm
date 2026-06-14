import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config.js';
import { getRoot } from '../state/repo.js';
import { TESTER_SYSTEM } from './prompts.js';
import { buildCachedSystem, logCacheStats, CACHE_BETA } from './cache.js';
import { tokensToDollars } from './coder.js';
import { requestPermission } from '../drivers/permission-broker.js';
import type { Task, SwarmState } from '../state/types.js';

export interface TesterResult {
  verdict: 'PASS' | 'PASS_WITH_ADVISORY' | 'FAIL';
  summary: string;
  finding: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// ─── Test runner ──────────────────────────────────────────────────────────────

async function detectAndRunTests(projectRoot: string, command?: string): Promise<string> {
  let cmd = command;
  if (!cmd) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
        cmd = pkg.scripts?.test ?? 'npm test';
      } catch {
        cmd = 'npm test';
      }
    } else if (
      fs.existsSync(path.join(projectRoot, 'pytest.ini')) ||
      fs.existsSync(path.join(projectRoot, 'pyproject.toml')) ||
      fs.existsSync(path.join(projectRoot, 'setup.py'))
    ) {
      cmd = 'python -m pytest -v --tb=short';
    } else if (fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) {
      cmd = 'cargo test';
    } else if (fs.existsSync(path.join(projectRoot, 'go.mod'))) {
      cmd = 'go test ./...';
    } else {
      return 'No test runner detected. Add a test command to package.json scripts.test.';
    }
  }

  return new Promise(resolve => {
    let output = `$ ${cmd}\n\n`;
    const proc = spawn(cmd!, { cwd: projectRoot, shell: true });
    const timer = setTimeout(() => {
      proc.kill();
      resolve(output + '\n[timeout after 120s]');
    }, 120_000);

    proc.stdout.on('data', d => {
      output += String(d);
    });
    proc.stderr.on('data', d => {
      output += String(d);
    });
    proc.on('close', code => {
      clearTimeout(timer);
      resolve(output + `\nExit code: ${code}`);
    });
    proc.on('error', err => {
      clearTimeout(timer);
      resolve(output + `\nError: ${err.message}`);
    });
  });
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read a file in the project.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'list_files',
    description: 'List files in a directory.',
    input_schema: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        recursive: { type: 'boolean' },
      },
    },
  },
  {
    name: 'run_tests',
    description: "Execute the project's test suite and return the full output.",
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Override the detected test command.' },
      },
    },
  },
  {
    name: 'done',
    description: 'Complete the review with a verdict.',
    input_schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['PASS', 'PASS_WITH_ADVISORY', 'FAIL'] },
        summary: { type: 'string', description: 'One-line result summary.' },
        detail: {
          type: 'string',
          description: 'Explanation of failures if FAIL, or advisory caveat if PASS_WITH_ADVISORY.',
        },
      },
      required: ['verdict', 'summary', 'detail'],
    },
  },
];

function safeJoin(rel: string): string {
  const root = getRoot();
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root)) throw new Error(`Path ${rel} is outside project root.`);
  return abs;
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  task: Task,
): Promise<string> {
  // Gate test execution — user must approve before any commands run.
  if (name === 'run_tests') {
    const decision = await requestPermission(task.assignee, name, {
      command: input.command ?? '(auto-detected)',
    });
    if (decision === 'deny') return 'Permission denied: user rejected running the test suite.';
  }

  switch (name) {
    case 'read_file': {
      const abs = safeJoin(String(input.path));
      return fs.existsSync(abs) ? await fsp.readFile(abs, 'utf8') : `Not found: ${input.path}`;
    }
    case 'list_files': {
      const abs = safeJoin(String(input.dir ?? '.'));
      if (!fs.existsSync(abs)) return `Not found: ${input.dir}`;
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      return entries.map(e => e.name + (e.isDirectory() ? '/' : '')).join('\n');
    }
    case 'run_tests':
      return await detectAndRunTests(getRoot(), input.command ? String(input.command) : undefined);
    case 'done':
      return 'acknowledged';
    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── Build finding markdown ───────────────────────────────────────────────────

const VERDICT_LABELS: Record<string, string> = {
  PASS: 'Pass',
  PASS_WITH_ADVISORY: 'Pass with Advisory',
  FAIL: 'Failed',
  FAILED: 'Failed',
};

function verdictHeading(verdict: string, summary: string): string {
  const label = VERDICT_LABELS[verdict.toUpperCase()] ?? verdict;
  const normSum = summary
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '_');
  const normVerd = verdict.toUpperCase().replace(/[\s_]+/g, '_');
  const isRepeat = !summary.trim() || normSum === normVerd;
  return isRepeat ? `## ${label}\n\n` : `## ${label}: ${summary}\n\n`;
}

function buildFinding(task: Task, verdict: string, summary: string, detail?: string): string {
  return [
    '---',
    `task: ${task.id}`,
    `agent: tester`,
    `schema: tester-finding`,
    `verdict: ${verdict}`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    '---',
    '',
    verdictHeading(verdict, summary).trimEnd(),
    '',
    ...(detail ? [detail, ''] : []),
  ].join('\n');
}

// ─── Main agent ───────────────────────────────────────────────────────────────

export async function runTester(
  task: Task,
  state: SwarmState,
  verbose = true,
): Promise<TesterResult> {
  const cfg = getConfig();
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const model = cfg.testerModel;

  // Give the Tester context about what the Coder changed
  const coderTask = state.tasks.find(t => t.assignee === 'coder' && t.status === 'done');
  const coderContext = coderTask?.result_ref
    ? `The Coder completed task "${coderTask.title}". Findings at: .swarm/${coderTask.result_ref}`
    : `The Coder completed task "${coderTask?.title ?? 'unknown'}" (no finding file available).`;

  const charter = state.charter;
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        `Task: ${task.title}`,
        state.goal ? `Goal: ${state.goal}` : '',
        coderContext,
        ...(charter?.constraints?.length
          ? [`Constraints: ${charter.constraints.join(' | ')}`]
          : []),
        ...(charter?.nongoals?.length ? [`Non-goals: ${charter.nongoals.join(' | ')}`] : []),
        ...(charter?.questions?.length ? [`Clarifications: ${charter.questions.join(' | ')}`] : []),
        'Find and run the test suite. Report your verdict.',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];

  let totalInput = 0,
    totalOutput = 0,
    cacheCost = 0;
  let verdict = 'FAIL',
    summary = 'Tests not run',
    detail = '';
  const systemBlocks = buildCachedSystem(TESTER_SYSTEM, 2048); // lean ctx for tester

  if (verbose) console.log(`\n  [tester] dispatched: "${task.title}"\n`);

  for (let i = 0; i < 15; i++) {
    const resp = await client.beta.messages.create({
      model,
      max_tokens: 4096,
      system: systemBlocks,
      tools: TOOLS as Parameters<typeof client.beta.messages.create>[0]['tools'],
      messages: messages as Parameters<typeof client.beta.messages.create>[0]['messages'],
      betas: [CACHE_BETA],
    });

    totalInput += resp.usage.input_tokens;
    totalOutput += resp.usage.output_tokens;
    cacheCost += logCacheStats('tester', resp.usage, 0.8);

    if (verbose) {
      for (const b of resp.content) {
        if (b.type === 'text' && b.text.trim()) console.log('  ' + b.text.trim());
      }
    }

    if (resp.stop_reason === 'end_turn') break;

    if (resp.stop_reason === 'tool_use') {
      const results: Anthropic.ToolResultBlockParam[] = [];
      let calledDone = false;

      for (const b of resp.content) {
        if (b.type !== 'tool_use') continue;
        if (verbose) console.log(`  [tester] ${b.name}(${JSON.stringify(b.input).slice(0, 100)})`);

        const result = await executeTool(b.name, b.input as Record<string, unknown>, task);

        if (b.name === 'done') {
          const inp = b.input as { verdict: string; summary: string; detail?: string };
          verdict = inp.verdict ?? 'FAIL';
          summary = inp.summary ?? summary;
          detail = inp.detail ?? '';
          calledDone = true;
        }

        results.push({ type: 'tool_result', tool_use_id: b.id, content: result });
      }

      messages.push({ role: 'assistant', content: resp.content });
      messages.push({ role: 'user', content: results });
      if (calledDone) break;
    }
  }

  const costUsd = tokensToDollars(model, totalInput, totalOutput) + cacheCost;
  if (verbose) console.log(`\n  [tester] ${verdict}: ${summary}  cost: $${costUsd.toFixed(4)}\n`);

  return {
    verdict: verdict as 'PASS' | 'PASS_WITH_ADVISORY' | 'FAIL',
    summary,
    finding: buildFinding(task, verdict, summary, detail),
    inputTokens: totalInput,
    outputTokens: totalOutput,
    costUsd,
  };
}
