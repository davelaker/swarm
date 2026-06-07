import Anthropic         from '@anthropic-ai/sdk';
import fs                from 'node:fs';
import fsp               from 'node:fs/promises';
import path              from 'node:path';
import { getConfig }     from '../config.js';
import { SECURITY_SYSTEM } from './prompts.js';
import { tokensToDollars } from './coder.js';
import type { Task, SwarmState } from '../state/types.js';

export interface SecurityFindingItem {
  id:         string; // SEC-N
  severity:   'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  type:       string;
  location:   string;
  fix:        string;
}

export interface SecurityResult {
  verdict:      'APPROVED' | 'CHANGES_REQUESTED';
  summary:      string;
  findings:     SecurityFindingItem[];
  finding:      string; // raw markdown for disk
  inputTokens:  number;
  outputTokens: number;
  costUsd:      number;
}

// ─── Tools — READ-ONLY (DESIGN §5.3) ─────────────────────────────────────────

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
        summary:  { type: 'string', description: 'One-line summary.' },
        findings: {
          type:  'array',
          items: {
            type:       'object',
            properties: {
              id:       { type: 'string' },
              severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
              type:     { type: 'string' },
              location: { type: 'string' },
              fix:      { type: 'string' },
            },
            required: ['id', 'severity', 'type', 'location', 'fix'],
          },
        },
      },
      required: ['verdict', 'summary'],
    },
  },
];

function safeJoin(rel: string): string {
  const abs = path.resolve(process.cwd(), rel);
  if (!abs.startsWith(process.cwd())) throw new Error(`Path outside project root: ${rel}`);
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
// Conforms to DESIGN.md §6.2a security-finding schema.

function buildFinding(task: Task, verdict: string, summary: string, items: SecurityFindingItem[]): string {
  const findingsList = items.length
    ? items.map(f =>
        `  - id: ${f.id}\n    severity: ${f.severity}\n    type: ${f.type}\n    location: ${f.location}`
      ).join('\n')
    : '';

  const header = [
    '---',
    `task: ${task.id}`,
    `agent: security`,
    `schema: security-finding`,
    `verdict: ${verdict}`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    ...(findingsList ? ['findings:', findingsList] : []),
    '---',
    '',
  ].join('\n');

  const body = items.length
    ? items.map(f => [
        `### ${f.id} — ${f.severity}: ${f.type}`,
        `**Location:** \`${f.location}\``,
        `**Remediation:** ${f.fix}`,
        '',
      ].join('\n')).join('\n')
    : verdict === 'APPROVED'
      ? 'No security issues found in the changed code.\n'
      : '';

  return header + `## ${verdict}: ${summary}\n\n` + body;
}

// ─── Main agent ───────────────────────────────────────────────────────────────

export async function runSecurity(task: Task, state: SwarmState, verbose = true): Promise<SecurityResult> {
  const cfg    = getConfig();
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const model  = cfg.coderModel;

  // Find what the Coder produced so the reviewer knows where to look
  const coderTask = state.tasks.find(t => t.assignee === 'coder' && t.status === 'done');
  const coderCtx  = coderTask?.result_ref
    ? `Coder completed "${coderTask.title}". Findings file: ${coderTask.result_ref}. Changed files are listed there.`
    : `Coder completed "${coderTask?.title ?? 'unknown'}" — read the project files to find recent changes.`;

  const messages: Anthropic.MessageParam[] = [{
    role: 'user',
    content: [
      `Task: ${task.title}`,
      `Project: ${state.project}`,
      coderCtx,
      '',
      'Read the Coder\'s findings, read the changed source files, and give your security verdict.',
    ].join('\n'),
  }];

  let totalInput = 0, totalOutput = 0;
  let verdict    = 'CHANGES_REQUESTED';
  let summary    = 'Security review incomplete';
  let items: SecurityFindingItem[] = [];

  if (verbose) console.log(`\n  [security] dispatched: "${task.title}"\n`);

  for (let i = 0; i < 15; i++) {
    const resp = await client.messages.create({
      model, max_tokens: 4096, system: SECURITY_SYSTEM, tools: TOOLS, messages,
    });

    totalInput  += resp.usage.input_tokens;
    totalOutput += resp.usage.output_tokens;

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
        if (verbose) console.log(`  [security] ${b.name}(${JSON.stringify(b.input).slice(0, 100)})`);

        const result = await executeTool(b.name, b.input as Record<string, unknown>);

        if (b.name === 'done') {
          const inp = b.input as { verdict: string; summary: string; findings?: SecurityFindingItem[] };
          verdict   = inp.verdict ?? verdict;
          summary   = inp.summary ?? summary;
          items     = inp.findings ?? [];
          calledDone = true;
        }

        results.push({ type: 'tool_result', tool_use_id: b.id, content: result });
      }

      messages.push({ role: 'assistant', content: resp.content });
      messages.push({ role: 'user', content: results });
      if (calledDone) break;
    }
  }

  const costUsd = tokensToDollars(model, totalInput, totalOutput);
  if (verbose) {
    const icon = verdict === 'APPROVED' ? '✓' : '⚠';
    console.log(`\n  [security] ${icon} ${verdict}: ${summary}  cost: $${costUsd.toFixed(4)}\n`);
    if (items.length) {
      items.forEach(f => console.log(`     ${f.id} [${f.severity}] ${f.type} @ ${f.location}`));
      console.log('');
    }
  }

  return {
    verdict: verdict as 'APPROVED' | 'CHANGES_REQUESTED',
    summary, findings: items,
    finding: buildFinding(task, verdict, summary, items),
    inputTokens: totalInput, outputTokens: totalOutput, costUsd,
  };
}
