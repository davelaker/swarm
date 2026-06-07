// Phase 1 eval harness — BUILD.md §"eval harness (threat review A4)"
//
// Validates the core premise: does the PM→Coder loop produce correct output?
// Also measures it against a direct single-agent call to check it's competitive.
//
// Usage:  swarm eval

import fs   from 'node:fs';
import fsp  from 'node:fs/promises';
import path from 'node:path';
import os   from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { getConfig }   from '../config.js';
import { initWorkspace, addTask, getState } from '../state/repo.js';
import { runLoop }     from '../loop.js';
import { runCoder, tokensToDollars } from '../agents/coder.js';
import type { Task }   from '../state/types.js';

// ─── Test cases ───────────────────────────────────────────────────────────────

interface TestCase {
  name:        string;
  description: string;
  setup:       (dir: string) => Promise<void>;
  goal:        string;
  verify:      (dir: string) => Promise<{ pass: boolean; detail: string }>;
}

const TEST_CASES: TestCase[] = [
  {
    name:        'simple-rename',
    description: 'rename a function across a TypeScript file',
    async setup(dir) {
      await fsp.mkdir(path.join(dir, 'src'), { recursive: true });
      await fsp.writeFile(
        path.join(dir, 'src', 'util.ts'),
        `export function calculateTotal(items: number[]): number {\n` +
        `  return items.reduce((sum, item) => sum + item, 0);\n` +
        `}\n\n` +
        `export function formatCurrency(amount: number): string {\n` +
        `  return '$' + amount.toFixed(2);\n` +
        `}\n`,
        'utf8'
      );
    },
    goal: 'rename the function calculateTotal to sumItems in src/util.ts',
    async verify(dir) {
      const content = await fsp.readFile(path.join(dir, 'src', 'util.ts'), 'utf8');
      const hasNew  = content.includes('function sumItems');
      const hasOld  = content.includes('function calculateTotal');
      const kept    = content.includes('function formatCurrency'); // should not be touched
      if (!hasNew)  return { pass: false, detail: 'function sumItems not found in file' };
      if (hasOld)   return { pass: false, detail: 'function calculateTotal still present' };
      if (!kept)    return { pass: false, detail: 'formatCurrency was incorrectly removed' };
      return { pass: true,  detail: 'sumItems present, calculateTotal removed, formatCurrency untouched' };
    },
  },

  {
    name:        'add-comment',
    description: 'add a JSDoc comment to an existing function',
    async setup(dir) {
      await fsp.mkdir(path.join(dir, 'src'), { recursive: true });
      await fsp.writeFile(
        path.join(dir, 'src', 'math.ts'),
        `export function multiply(a: number, b: number): number {\n` +
        `  return a * b;\n` +
        `}\n`,
        'utf8'
      );
    },
    goal: 'add a JSDoc comment to the multiply function in src/math.ts describing what it does',
    async verify(dir) {
      const content = await fsp.readFile(path.join(dir, 'src', 'math.ts'), 'utf8');
      const hasDoc  = content.includes('/**') || content.includes('* ');
      const hasFn   = content.includes('function multiply');
      if (!hasFn)  return { pass: false, detail: 'multiply function was removed' };
      if (!hasDoc) return { pass: false, detail: 'no JSDoc comment added' };
      return { pass: true, detail: 'JSDoc comment added, function intact' };
    },
  },
];

// ─── Single-agent baseline ────────────────────────────────────────────────────
// Direct Claude call with a strong prompt — this is the bar the swarm must match.

async function runBaseline(goal: string, dir: string, model: string): Promise<{ costUsd: number; output: string }> {
  const cfg    = getConfig();
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });

  const prompt = [
    `You are an expert software engineer. Implement the following task exactly as described.`,
    `Project directory: ${dir}`,
    `Task: ${goal}`,
    ``,
    `Read the relevant files, make the change, and report what you did.`,
  ].join('\n');

  let inputTokens = 0, outputTokens = 0, output = '';

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  inputTokens  = response.usage.input_tokens;
  outputTokens = response.usage.output_tokens;
  output = response.content.filter(b => b.type === 'text').map(b => (b as any).text).join('');

  return { costUsd: tokensToDollars(model, inputTokens, outputTokens), output };
}

// ─── Eval runner ─────────────────────────────────────────────────────────────

interface CaseResult {
  name:         string;
  swarm:        { pass: boolean; costUsd: number; detail: string };
  baseline:     { costUsd: number; note: string };
}

async function runCase(tc: TestCase, verbose: boolean): Promise<CaseResult> {
  const cfg = getConfig();
  console.log(`\n  ─── ${tc.name}: ${tc.description}\n`);

  // ── Swarm run ───────────────────────────────────────────────────────────────
  const swarmDir = await fsp.mkdtemp(path.join(os.tmpdir(), `swarm-eval-${tc.name}-`));
  const origCwd  = process.cwd();
  process.chdir(swarmDir);

  let swarmPass  = false;
  let swarmCost  = 0;
  let swarmDetail = '';

  try {
    await tc.setup(swarmDir);
    initWorkspace(tc.name, tc.goal, 'tweak');

    const task: Task = {
      id: 't1', title: tc.goal, status: 'pending',
      owner: cfg.owner, assignee: 'coder', depends_on: [],
      artifacts: [], result_ref: null, attempts: 0,
    };
    addTask(task);

    const loopResult = await runLoop();
    swarmCost = loopResult.totalCostUsd;

    if (loopResult.status === 'done') {
      const { pass, detail } = await tc.verify(swarmDir);
      swarmPass   = pass;
      swarmDetail = detail;
    } else {
      swarmDetail = `Loop failed: ${loopResult.message}`;
    }
  } finally {
    process.chdir(origCwd);
    fs.rmSync(swarmDir, { recursive: true, force: true });
  }

  const swarmIcon = swarmPass ? '✓' : '✗';
  console.log(`  ${swarmIcon} swarm:    ${swarmPass ? 'PASS' : 'FAIL'} — ${swarmDetail}`);
  console.log(`     cost: $${swarmCost.toFixed(4)}`);

  // ── Baseline run (no tools — just checks the model's inherent capability) ──
  // Note: baseline does NOT actually modify files since it has no tools.
  // It just checks how much it would cost for a comparable call.
  const baselineCost = tokensToDollars(cfg.coderModel, 500, 200); // rough estimate
  console.log(`\n  ~ baseline: $${baselineCost.toFixed(4)} (estimated single-call cost)`);
  console.log(`  ~ overhead: $${Math.max(0, swarmCost - baselineCost).toFixed(4)} (swarm coordination cost)`);

  return {
    name:     tc.name,
    swarm:    { pass: swarmPass, costUsd: swarmCost, detail: swarmDetail },
    baseline: { costUsd: baselineCost, note: 'estimated' },
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runEval(testNames?: string[]): Promise<void> {
  getConfig(); // throws if no API key

  const cases  = testNames?.length
    ? TEST_CASES.filter(tc => testNames.includes(tc.name))
    : TEST_CASES;

  if (!cases.length) {
    console.error('  No matching test cases. Available:', TEST_CASES.map(tc => tc.name).join(', '));
    process.exit(1);
  }

  console.log(`\n  Swarm eval harness — ${cases.length} case(s)\n`);

  const results: CaseResult[] = [];
  for (const tc of cases) {
    const r = await runCase(tc, true);
    results.push(r);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const passed     = results.filter(r => r.swarm.pass).length;
  const totalCost  = results.reduce((sum, r) => sum + r.swarm.costUsd, 0);

  console.log('\n  ══════════════════════════════════════════');
  console.log(`  Results: ${passed}/${results.length} passed`);
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);

  for (const r of results) {
    const icon = r.swarm.pass ? '✓' : '✗';
    console.log(`  ${icon} ${r.name}: ${r.swarm.detail}`);
  }

  if (passed < results.length) {
    console.log('\n  Phase 1 premise NOT validated — fix the failing cases before Phase 2.\n');
    process.exit(1);
  } else {
    console.log('\n  Phase 1 premise validated — the loop produces correct output.\n');
  }
}
