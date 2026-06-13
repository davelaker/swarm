// The Reviewer agent — api-key driver implementation.
// Read-only. Reviews changed code for correctness, robustness, and design quality.
// See DESIGN.md §5.3 for write-scope and tool allowlist.

import Anthropic         from '@anthropic-ai/sdk';
import fs                from 'node:fs';
import fsp               from 'node:fs/promises';
import path              from 'node:path';
import { getConfig }          from '../config.js';
import { getRoot }            from '../state/repo.js';
import { REVIEWER_SYSTEM }    from './prompts.js';
import { buildCachedSystem, logCacheStats, CACHE_BETA } from './cache.js';
import { tokensToDollars }    from './coder.js';
import type { Task, SwarmState } from '../state/types.js';

export interface ReviewerFindingItem {
  id:       string;   // REV-N
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  category: 'correctness' | 'robustness' | 'design' | 'testability' | 'clarity';
  location: string;
  issue:    string;
  fix:      string;
}

export interface ReviewerResult {
  verdict:      'APPROVED' | 'CHANGES_REQUESTED';
  summary:      string;
  detail:       string;
  findings:     ReviewerFindingItem[];
  finding:      string;   // raw markdown for disk
  inputTokens:  number;
  outputTokens: number;
  costUsd:      number;
}

// ─── Tools — READ-ONLY ────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name:        'read_file',
    description: 'Read a source file. You are read-only — do not attempt to write.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name:        'list_files',
    description: 'List files in a directory.',
    input_schema: {
      type:       'object',
      properties: { dir: { type: 'string' }, recursive: { type: 'boolean' } },
    },
  },
  {
    name:        'done',
    description: 'Complete the review with a verdict and any findings.',
    input_schema: {
      type:       'object',
      properties: {
        verdict:  { type: 'string', enum: ['APPROVED', 'CHANGES_REQUESTED'] },
        summary:  { type: 'string', description: 'One-line overall assessment.' },
        detail:   { type: 'string', description: '2-3 sentences: what files you reviewed, what you looked for, and the key reason for your verdict.' },
        findings: {
          type:  'array',
          items: {
            type:       'object',
            properties: {
              id:       { type: 'string' },
              severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
              category: { type: 'string', enum: ['correctness', 'robustness', 'design', 'testability', 'clarity'] },
              location: { type: 'string' },
              issue:    { type: 'string', description: 'Quoted offending code and explanation of what is wrong' },
              fix:      { type: 'string' },
            },
            required: ['id', 'severity', 'category', 'location', 'issue', 'fix'],
          },
        },
      },
      required: ['verdict', 'summary', 'detail', 'findings'],
    },
  },
];

function safeJoin(rel: string): string {
  const root = getRoot();
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root)) throw new Error(`Path outside project root: ${rel}`);
  return abs;
}

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'read_file': {
      const abs = safeJoin(String(input.path));
      return fs.existsSync(abs) ? await fsp.readFile(abs, 'utf8') : `Not found: ${input.path}`;
    }
    case 'list_files': {
      const abs = safeJoin(String(input.dir ?? '.'));
      if (!fs.existsSync(abs)) return `Not found: ${input.dir}`;
      const recurse = Boolean(input.recursive);
      if (recurse) {
        const all = await fsp.readdir(abs, { recursive: true });
        return (all as string[]).filter(e => !e.includes('node_modules') && !e.startsWith('.swarm')).join('\n');
      }
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      return entries.map(e => e.name + (e.isDirectory() ? '/' : '')).join('\n');
    }
    case 'done':
      return 'acknowledged';
    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── Finding markdown ─────────────────────────────────────────────────────────

const VERDICT_LABELS: Record<string, string> = {
  CHANGES_REQUESTED: 'Changes Requested',
  APPROVED:          'Approved',
  COMPLETE:          'Complete',
  PASS:              'Pass',
  PASS_WITH_ADVISORY:'Pass with Advisory',
  FAILED:            'Failed',
  FAIL:              'Failed',
};

function verdictHeading(verdict: string, summary: string): string {
  const label    = VERDICT_LABELS[verdict.toUpperCase()] ?? verdict;
  const normSum  = summary.trim().toUpperCase().replace(/[\s_]+/g, '_');
  const normVerd = verdict.toUpperCase().replace(/[\s_]+/g, '_');
  const isRepeat = !summary.trim() || normSum === normVerd;
  return isRepeat ? `## ${label}\n\n` : `## ${label}: ${summary}\n\n`;
}

function buildFinding(task: Task, verdict: string, summary: string, detail: string, items: ReviewerFindingItem[]): string {
  const findingsList = items.length
    ? items.map(f =>
        `  - id: ${f.id}\n    severity: ${f.severity}\n    category: ${f.category}\n    location: ${f.location}`
      ).join('\n')
    : '';

  const header = [
    '---',
    `task: ${task.id}`,
    `agent: reviewer`,
    `schema: reviewer-finding`,
    `verdict: ${verdict}`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    ...(findingsList ? ['findings:', findingsList] : []),
    '---',
    '',
  ].join('\n');

  const body = items.length
    ? items.map(f => [
        `### ${f.id} — ${f.severity}: ${f.category}`,
        `**Location:** \`${f.location}\``,
        f.issue ? `**Issue:** ${f.issue}` : '',
        `**Fix:** ${f.fix}`,
        '',
      ].filter(l => l !== '').join('\n')).join('\n')
    : verdict === 'APPROVED'
      ? 'No significant issues found in the changed code.\n'
      : '';

  const detailBlock = detail ? `${detail}\n\n` : '';
  return header + verdictHeading(verdict, summary) + detailBlock + body;
}

// ─── Main agent ───────────────────────────────────────────────────────────────

export async function runReviewer(task: Task, state: SwarmState, verbose = true): Promise<ReviewerResult> {
  const cfg    = getConfig();
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const model  = cfg.reviewerModel;

  const coderTask = state.tasks.find(t => t.assignee === 'coder' && t.status === 'done');
  const coderCtx  = coderTask?.result_ref
    ? `Coder completed "${coderTask.title}". Findings file: .swarm/${coderTask.result_ref}`
    : `Coder completed "${coderTask?.title ?? 'unknown'}" — read the project files to find recent changes.`;

  const charter = state.charter;
  const messages: Anthropic.MessageParam[] = [{
    role: 'user',
    content: [
      `Task: ${task.title}`,
      state.goal ? `Goal: ${state.goal}` : '',
      coderCtx,
      ...(charter?.constraints?.length ? [`Constraints: ${charter.constraints.join(' | ')}`] : []),
      ...(charter?.nongoals?.length    ? [`Non-goals: ${charter.nongoals.join(' | ')}`] : []),
      ...(charter?.questions?.length   ? [`Clarifications: ${charter.questions.join(' | ')}`] : []),
      'Read the Coder\'s findings and changed files. Give your code review verdict.',
    ].filter(Boolean).join('\n'),
  }];

  let totalInput = 0, totalOutput = 0, cacheCost = 0;
  let verdict    = 'CHANGES_REQUESTED';
  let summary    = 'Review did not complete — re-run required';
  let detail     = '';
  let calledDoneGlobal = false;
  let items: ReviewerFindingItem[] = [];
  const systemBlocks = buildCachedSystem(REVIEWER_SYSTEM, 8192);

  if (verbose) console.log(`\n  [reviewer] dispatched: "${task.title}"\n`);

  for (let i = 0; i < 15; i++) {
    const resp = await client.beta.messages.create({
      model, max_tokens: 4096,
      system:   systemBlocks,
      tools:    TOOLS as Parameters<typeof client.beta.messages.create>[0]['tools'],
      messages: messages as Parameters<typeof client.beta.messages.create>[0]['messages'],
      betas:    [CACHE_BETA],
    });

    totalInput  += resp.usage.input_tokens;
    totalOutput += resp.usage.output_tokens;
    cacheCost   += logCacheStats('reviewer', resp.usage, 3);

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
        if (verbose) console.log(`  [reviewer] ${b.name}(${JSON.stringify(b.input).slice(0, 100)})`);

        const result = await executeTool(b.name, b.input as Record<string, unknown>);

        if (b.name === 'done') {
          const inp = b.input as { verdict: string; summary: string; detail?: string; findings?: ReviewerFindingItem[] };
          verdict    = inp.verdict ?? verdict;
          summary    = inp.summary ?? summary;
          detail     = inp.detail  ?? detail;
          items      = inp.findings ?? [];
          calledDone = true;
          calledDoneGlobal = true;
        }

        results.push({ type: 'tool_result', tool_use_id: b.id, content: result });
      }

      messages.push({ role: 'assistant', content: resp.content });
      messages.push({ role: 'user', content: results });
      if (calledDone) break;
    }
  }

  // If the agent timed out without calling done, inject a placeholder so
  // CHANGES_REQUESTED always has at least one actionable item.
  if (!calledDoneGlobal && items.length === 0) {
    items = [{
      id: 'REV-TIMEOUT', severity: 'MEDIUM', category: 'correctness',
      location: 'unknown',
      issue: 'Review agent did not submit a verdict within the iteration limit.',
      fix: 'Re-run this review task — this is an infrastructure failure, not a code issue.',
    }];
  }

  const costUsd = tokensToDollars(model, totalInput, totalOutput) + cacheCost;
  if (verbose) {
    const icon = verdict === 'APPROVED' ? '✓' : '⚠';
    console.log(`\n  [reviewer] ${icon} ${verdict}: ${summary}  cost: $${costUsd.toFixed(4)}\n`);
    if (items.length) {
      items.forEach(f => console.log(`     ${f.id} [${f.severity}/${f.category}] @ ${f.location}`));
      console.log('');
    }
  }

  return {
    verdict: verdict as 'APPROVED' | 'CHANGES_REQUESTED',
    summary, detail, findings: items,
    finding: buildFinding(task, verdict, summary, detail, items),
    inputTokens: totalInput, outputTokens: totalOutput, costUsd,
  };
}
