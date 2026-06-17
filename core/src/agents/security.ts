import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config.js';
import { getRoot } from '../state/repo.js';
import { SECURITY_SYSTEM } from './prompts.js';
import { buildCachedSystem, logCacheStats, CACHE_BETA } from './cache.js';
import { tokensToDollars } from './coder.js';
import type { Task, SwarmState } from '../state/types.js';

export interface SecurityFindingItem {
  id: string; // SEC-N
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  type: string;
  location: string;
  attack_path: string;
  fix: string;
}

export interface SecurityResult {
  verdict: 'APPROVED' | 'CHANGES_REQUESTED';
  summary: string;
  detail: string;
  findings: SecurityFindingItem[];
  finding: string; // raw markdown for disk
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// ─── Tools — READ-ONLY (DESIGN §5.3) ─────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read a source file. You are read-only — do not attempt to write.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'list_files',
    description: 'List files in a directory.',
    input_schema: {
      type: 'object',
      properties: { dir: { type: 'string' }, recursive: { type: 'boolean' } },
    },
  },
  {
    name: 'done',
    description: 'Complete the review with a verdict and any findings.',
    input_schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['APPROVED', 'CHANGES_REQUESTED'] },
        summary: { type: 'string', description: 'One-line overall security assessment.' },
        detail: {
          type: 'string',
          description:
            '2-3 sentences: what attack surfaces you checked, what patterns you looked for, and the key reason for your verdict.',
        },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
              type: { type: 'string' },
              location: { type: 'string' },
              attack_path: { type: 'string', description: 'Entry point → data flow → impact' },
              fix: { type: 'string' },
            },
            required: ['id', 'severity', 'type', 'location', 'attack_path', 'fix'],
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
        return (all as string[])
          .filter(e => !e.includes('node_modules') && !e.startsWith('.swarm'))
          .join('\n');
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

const VERDICT_LABELS: Record<string, string> = {
  CHANGES_REQUESTED: 'Changes Requested',
  APPROVED: 'Approved',
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

function buildFinding(
  task: Task,
  verdict: string,
  summary: string,
  detail: string,
  items: SecurityFindingItem[],
): string {
  const findingsList = items.length
    ? items
        .map(
          f =>
            `  - id: ${f.id}\n    severity: ${f.severity}\n    type: ${f.type}\n    location: ${f.location}`,
        )
        .join('\n')
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
    ? items
        .map(f =>
          [
            `### ${f.id} — ${f.severity}: ${f.type}`,
            `**Location:** \`${f.location}\``,
            f.attack_path ? `**Attack path:** ${f.attack_path}` : '',
            `**Remediation:** ${f.fix}`,
            '',
          ]
            .filter(l => l !== '')
            .join('\n'),
        )
        .join('\n')
    : verdict === 'APPROVED'
      ? 'No security issues found in the changed code.\n'
      : '';

  const detailBlock = detail ? `${detail}\n\n` : '';
  return header + verdictHeading(verdict, summary) + detailBlock + body;
}

// ─── Main agent ───────────────────────────────────────────────────────────────

export async function runSecurity(
  task: Task,
  state: SwarmState,
  verbose = true,
): Promise<SecurityResult> {
  const cfg = getConfig();
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const model = cfg.securityModel;

  const coderTask = state.tasks.find(t => t.assignee === 'coder' && t.status === 'done');

  // Audit-first: security runs before any coder — full codebase scan.
  // Post-coder: review what the coder changed.
  const contextLine = coderTask
    ? coderTask.result_ref
      ? `Coder completed "${coderTask.title}". Findings file: .swarm/${coderTask.result_ref}. Changed files are listed there.`
      : `Coder completed "${coderTask.title}" — read the project files to find recent changes.`
    : 'No coder has run yet. Conduct a full codebase security audit.';

  const instruction = coderTask
    ? "Read the Coder's findings and changed files. Give your security verdict."
    : 'Explore the project files thoroughly. Report all vulnerabilities with severity, location, and fix.';

  const charter = state.charter;
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        `Task: ${task.title}`,
        state.goal ? `Goal: ${state.goal}` : '',
        contextLine,
        ...(charter?.constraints?.length
          ? [`Constraints: ${charter.constraints.join(' | ')}`]
          : []),
        ...(charter?.nongoals?.length ? [`Non-goals: ${charter.nongoals.join(' | ')}`] : []),
        ...(charter?.questions?.length ? [`Clarifications: ${charter.questions.join(' | ')}`] : []),
        instruction,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];

  let totalInput = 0,
    totalOutput = 0,
    cacheCost = 0;
  let verdict = 'CHANGES_REQUESTED';
  let summary = 'Security review did not complete — re-run required';
  let detail = '';
  let calledDoneGlobal = false;
  let items: SecurityFindingItem[] = [];
  const systemBlocks = buildCachedSystem(SECURITY_SYSTEM, 8192);

  if (verbose) console.log(`\n  [security] dispatched: "${task.title}"\n`);

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
    cacheCost += logCacheStats('security', resp.usage, 0.8);

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
        if (verbose)
          console.log(`  [security] ${b.name}(${JSON.stringify(b.input).slice(0, 100)})`);

        const result = await executeTool(b.name, b.input as Record<string, unknown>);

        if (b.name === 'done') {
          const inp = b.input as {
            verdict: string;
            summary: string;
            detail?: string;
            findings?: SecurityFindingItem[];
          };
          verdict = inp.verdict ?? verdict;
          summary = inp.summary ?? summary;
          detail = inp.detail ?? detail;
          items = inp.findings ?? [];
          calledDone = true;
          calledDoneGlobal = true;
        }

        results.push({ type: 'tool_result', tool_use_id: b.id, content: result });
      }

      // SDK >=0.93 widened the response's server-tool name union, so a beta response's
      // content no longer assigns to the request param type — cast (identical at runtime).
      messages.push({
        role: 'assistant',
        content: resp.content as unknown as Anthropic.MessageParam['content'],
      });
      messages.push({ role: 'user', content: results });
      if (calledDone) break;
    }
  }

  // If the agent timed out without calling done, inject a placeholder so
  // CHANGES_REQUESTED always has at least one actionable item.
  if (!calledDoneGlobal && items.length === 0) {
    items = [
      {
        id: 'SEC-TIMEOUT',
        severity: 'MEDIUM',
        type: 'Review incomplete',
        location: 'unknown',
        attack_path: 'N/A — agent did not submit a verdict',
        fix: 'Re-run this security review task — this is an infrastructure failure, not a code issue.',
      },
    ];
  }

  const costUsd = tokensToDollars(model, totalInput, totalOutput) + cacheCost;
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
    summary,
    detail,
    findings: items,
    finding: buildFinding(task, verdict, summary, detail, items),
    inputTokens: totalInput,
    outputTokens: totalOutput,
    costUsd,
  };
}
