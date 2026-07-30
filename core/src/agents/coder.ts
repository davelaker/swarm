// The Coder agent — Phase 1 implementation.
// Replaces the stub in dispatch/index.ts.
// See DESIGN.md §5.3 for write-scope and tool allowlist.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getConfig } from '../config.js';
import { getRoot } from '../state/repo.js';
import { CODER_SYSTEM } from './prompts.js';
import { buildCachedSystem, logCacheStats, CACHE_BETA } from './cache.js';
import { requestPermission } from '../drivers/permission-broker.js';
import type { Task, SwarmState } from '../state/types.js';

// ─── Cost metering ────────────────────────────────────────────────────────────
// Pricing per million tokens. Update when model pricing changes.
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  // Legacy model IDs kept for compatibility
  'claude-opus-4-5-20251101': { input: 15, output: 75 },
  'claude-sonnet-4-5-20251101': { input: 3, output: 15 },
  // Fallback for any unknown model
  default: { input: 3, output: 15 },
};

export function tokensToDollars(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? PRICING.default;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read the full contents of a file in the project.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the project root.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write (or overwrite) a file in the project.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the project root.' },
        content: { type: 'string', description: 'Full content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in a directory (non-recursive by default).',
    input_schema: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: 'Directory relative to project root. Defaults to ".".',
        },
        recursive: { type: 'boolean', description: 'List recursively. Defaults to false.' },
      },
    },
  },
  {
    name: 'done',
    description:
      'Signal that all changes are complete. Call this once — and only once — when finished.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'One-line summary of what was implemented (shown as the card headline).',
        },
        detail: {
          type: 'string',
          description:
            'A substantive paragraph (4-6 sentences) covering: what you changed and in which files/functions; why you chose this approach; any non-obvious design decisions or constraints; what the reviewer should pay closest attention to. Do not restate the task title.',
        },
        files_changed: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relative paths of files that were created or modified.',
        },
      },
      required: ['summary', 'detail', 'files_changed'],
    },
  },
];

// ─── Tool execution ───────────────────────────────────────────────────────────

const projectRoot = () => getRoot();

function safeJoin(rel: string): string {
  const abs = path.resolve(projectRoot(), rel);
  // Enforce read-only outside the project root
  if (!abs.startsWith(projectRoot())) {
    throw new Error(`Path ${rel} is outside the project directory.`);
  }
  return abs;
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  task: Task,
): Promise<string> {
  // Gate write operations — surfaced to the user before executing.
  if (name === 'write_file') {
    const decision = await requestPermission(task.assignee, name, input);
    if (decision === 'deny')
      return `Permission denied: user rejected writing ${input.path ?? 'file'}.`;
  }

  switch (name) {
    case 'read_file': {
      const abs = safeJoin(String(input.path));
      if (!fs.existsSync(abs)) return `Error: file not found: ${input.path}`;
      return await fsp.readFile(abs, 'utf8');
    }
    case 'write_file': {
      const abs = safeJoin(String(input.path));
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, String(input.content), 'utf8');
      return `Written: ${input.path}`;
    }
    case 'list_files': {
      const dir = safeJoin(String(input.dir ?? '.'));
      const recurse = Boolean(input.recursive);
      if (!fs.existsSync(dir)) return `Error: directory not found: ${input.dir}`;
      if (recurse) {
        const entries = await fsp.readdir(dir, { recursive: true });
        return (entries as string[])
          .filter(
            e => !e.includes('node_modules') && !e.includes('.git') && !e.startsWith('.swarm'),
          )
          .join('\n');
      }
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.map(e => e.name + (e.isDirectory() ? '/' : '')).join('\n');
    }
    case 'done':
      return 'acknowledged';
    default:
      return `Error: unknown tool "${name}"`;
  }
}

// ─── Coder result ─────────────────────────────────────────────────────────────

export interface CoderResult {
  summary: string;
  detail: string;
  filesChanged: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}

// ─── Main agent loop ──────────────────────────────────────────────────────────

export async function runCoder(
  task: Task,
  state: SwarmState,
  verbose = true,
): Promise<CoderResult> {
  const cfg = getConfig();
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const model = cfg.coderModel;

  const charter = state.charter;

  // Security-audit-first flow: if a security task ran before this coder task,
  // inject the audit findings so the coder knows exactly what to fix.
  const priorSecTask = state.tasks.find(
    t => t.assignee === 'security' && t.status === 'done' && task.depends_on.includes(t.id),
  );
  const auditCtx = priorSecTask?.result_ref
    ? `Security audit findings to fix: ${priorSecTask.result_ref}\nRead the findings file first, then address all CRITICAL and HIGH severity issues.`
    : '';

  const userPrompt = [
    `Task: ${task.title}`,
    state.goal ? `Goal: ${state.goal}` : '',
    ...(charter?.constraints?.length ? [`Constraints: ${charter.constraints.join(' | ')}`] : []),
    ...(charter?.nongoals?.length ? [`Non-goals: ${charter.nongoals.join(' | ')}`] : []),
    ...(charter?.questions?.length ? [`Clarifications: ${charter.questions.join(' | ')}`] : []),
    auditCtx,
  ]
    .filter(Boolean)
    .join('\n');

  // System blocks: cached system prompt + PROJECT.md (8 KB cap)
  const systemBlocks = buildCachedSystem(CODER_SYSTEM, 8192);

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPrompt }];

  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0; // tracks cache-adjusted cost inline
  let summary = '';
  let detail = '';
  let filesChanged: string[] = [];
  let iterations = 0;
  const MAX_ITER = 20;

  if (verbose) {
    console.log(`\n  [coder] dispatched: "${task.title}"`);
    console.log(`  [coder] model: ${model}\n`);
  }

  while (iterations++ < MAX_ITER) {
    // C4: per-dispatch token budget check
    const runCost = tokensToDollars(model, totalInput, totalOutput);
    if (runCost >= cfg.hardCapUsd) {
      throw new Error(`Hard cost cap reached ($${cfg.hardCapUsd.toFixed(2)}) during coder run.`);
    }

    const response = await client.beta.messages.create({
      model,
      max_tokens: 8192,
      system: systemBlocks,
      tools: TOOLS as Parameters<typeof client.beta.messages.create>[0]['tools'],
      messages: messages as Parameters<typeof client.beta.messages.create>[0]['messages'],
      betas: [CACHE_BETA],
    });

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;
    totalCost += logCacheStats('coder', response.usage, PRICING[model]?.input ?? 3);

    // Print any text the model produced
    if (verbose) {
      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim()) {
          console.log('  ' + block.text.trim().split('\n').join('\n  '));
        }
      }
    }

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let calledDone = false;

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        if (verbose) {
          const inp = JSON.stringify(block.input).slice(0, 120);
          console.log(`  [coder] ${block.name}(${inp}${inp.length >= 120 ? '…' : ''})`);
        }

        const result = await executeTool(block.name, block.input as Record<string, unknown>, task);

        if (block.name === 'done') {
          const inp = block.input as { summary: string; detail?: string; files_changed: string[] };
          summary = inp.summary;
          detail = inp.detail ?? '';
          filesChanged = inp.files_changed ?? [];
          calledDone = true;
        }

        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }

      // SDK >=0.93 widened the response's server-tool name union, so a beta response's
      // content no longer assigns to the request param type — cast (identical at runtime).
      messages.push({
        role: 'assistant',
        content: response.content as unknown as Anthropic.MessageParam['content'],
      });
      messages.push({ role: 'user', content: toolResults });

      if (calledDone) break;
      continue;
    }

    break;
  }

  if (!summary) summary = `Task "${task.title}" completed.`;

  // If the agent omitted files_changed (or returned []), fall back to git detection.
  // Two passes: uncommitted changes first, then committed changes ahead of the base
  // branch. Coders often commit their work before calling done(), leaving git status
  // clean — without the second pass those commits look like "no files changed".
  if (filesChanged.length === 0) {
    try {
      const raw = execFileSync('git', ['status', '--porcelain'], {
        cwd: projectRoot(),
        encoding: 'utf8',
      });
      const detected = raw
        .split('\n')
        .filter(l => l.trim() && !l.startsWith('!!'))
        .map(l =>
          l
            .slice(3)
            .trim()
            .replace(/ -> .+$/, ''),
        )
        .filter(f => f && !f.endsWith('/'));
      if (detected.length) filesChanged = detected;
    } catch {
      /* non-fatal */
    }
  }

  // Second pass: committed changes not yet merged to the base branch.
  // Use `git log --name-only` rather than `git diff` — it handles multiple commits
  // and doesn't require a local tracking branch (origin/* refs work fine).
  // Try local branch names first, then remote-tracking refs, then HEAD~1 as a
  // last resort for single-commit branches on repos with unusual branch names.
  if (filesChanged.length === 0) {
    const bases = ['main', 'master', 'origin/main', 'origin/master'];
    for (const base of bases) {
      try {
        const out = execFileSync(
          'git',
          ['log', '--name-only', '--pretty=format:', `${base}..HEAD`],
          { cwd: projectRoot(), encoding: 'utf8' },
        );
        const detected = [
          ...new Set(
            out
              .split('\n')
              .map(l => l.trim())
              .filter(Boolean),
          ),
        ];
        if (detected.length) {
          filesChanged = detected;
          break;
        }
      } catch {
        /* try next base */
      }
    }
  }
  // Absolute last resort: single commit on a branch with no known base.
  if (filesChanged.length === 0) {
    try {
      const out = execFileSync('git', ['diff', '--name-only', 'HEAD~1'], {
        cwd: projectRoot(),
        encoding: 'utf8',
      });
      const detected = out
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      if (detected.length) filesChanged = detected;
    } catch {
      /* non-fatal */
    }
  }

  // totalCost already accumulates cache costs from each iteration
  const costUsd = tokensToDollars(model, totalInput, totalOutput) + totalCost;
  if (verbose) {
    console.log(`\n  [coder] done — ${summary}`);
    console.log(
      `  [coder] tokens: ${totalInput} in / ${totalOutput} out  cost: $${costUsd.toFixed(4)}\n`,
    );
  }

  return {
    summary,
    detail,
    filesChanged,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    costUsd,
    model,
  };
}
