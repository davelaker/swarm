#!/usr/bin/env node
/**
 * Generic stdio MCP server for agent-sdk structured output.
 *
 * Exposes a single `submit_result` tool. When an agent calls it, the tool
 * arguments (the structured result) are written to RESULT_OUTPUT_PATH and
 * "Result submitted." is returned so the agent can finish cleanly.
 *
 * This gives us guaranteed structured output: the agent MUST call the tool to
 * deliver its verdict/summary/detail/findings, so the result is always
 * tool-shaped and never plain text. No heuristic prose parsing, no JSON-fence
 * stripping, no keyword detection — and no degenerate "Completed" fallback.
 *
 * Env contract:
 *   RESULT_OUTPUT_PATH (required) — file to write captured tool arguments to.
 *   RESULT_SCHEMA      (required) — JSON string; inputSchema for submit_result.
 *   RESULT_REQUIRE     (optional) — comma-separated fields that must be present
 *                                   and non-empty (after trim).
 *   RESULT_MIN_DETAIL  (optional) — integer; if set and `detail` is required,
 *                                   `detail` must be at least this many chars.
 *
 * Protocol: MCP JSON-RPC 2.0 over stdio (newline-delimited JSON).
 */

import * as fs       from 'node:fs';
import * as readline from 'node:readline';

const outputPath = process.env.RESULT_OUTPUT_PATH;
if (!outputPath) {
  process.stderr.write('[result-mcp] RESULT_OUTPUT_PATH not set\n');
  process.exit(1);
}

// Parse the schema; fall back to a permissive object schema if it is malformed.
let inputSchema: Record<string, unknown> = { type: 'object' };
try {
  const raw = process.env.RESULT_SCHEMA;
  if (raw) inputSchema = JSON.parse(raw) as Record<string, unknown>;
} catch {
  process.stderr.write('[result-mcp] RESULT_SCHEMA failed to parse — using permissive { type: object }\n');
  inputSchema = { type: 'object' };
}

const requireFields = (process.env.RESULT_REQUIRE ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const minDetail = process.env.RESULT_MIN_DETAIL
  ? parseInt(process.env.RESULT_MIN_DETAIL, 10)
  : undefined;

// How many times we'll reject an invalid submission before accepting it anyway.
// The reject path forces the model to re-submit with the missing/short fields;
// the cap guarantees we never loop until the parent's timeout (which would leave
// the user with NO finding). After the cap we accept and let downstream defaults
// surface whatever was provided, so the run is never stuck.
const MAX_REJECTS = 2;
let rejects = 0;

// ─── Tool definition ──────────────────────────────────────────────────────────

const SUBMIT_TOOL = {
  name: 'submit_result',
  description:
    'Submit your final structured result. You MUST call this exactly once to ' +
    'finish — it is the only way to deliver your verdict, summary, detail, and ' +
    'findings. Any text you write outside this tool call is discarded.',
  inputSchema,
};

// ─── Validation ───────────────────────────────────────────────────────────────

// Returns a list of human-readable failure descriptions (empty = valid).
function validate(args: Record<string, unknown>): string[] {
  const failures: string[] = [];
  for (const field of requireFields) {
    const value = args[field];

    const isString = typeof value === 'string';
    const isArray  = Array.isArray(value);

    if (value === undefined || value === null || (!isString && !isArray)) {
      failures.push(`${field} is required and must be provided`);
      continue;
    }

    if (isString && (value as string).trim() === '') {
      failures.push(`${field} must not be empty`);
      continue;
    }

    if (isArray && (value as unknown[]).length === 0) {
      // An empty array is only a failure when the field is explicitly required.
      failures.push(`${field} must not be empty`);
      continue;
    }

    if (
      field === 'detail' &&
      isString &&
      typeof minDetail === 'number' &&
      (value as string).trim().length < minDetail
    ) {
      failures.push(
        `detail must be a substantive paragraph of at least ${minDetail} characters ` +
        `describing what you changed and why — not 'Completed'`,
      );
    }
  }
  return failures;
}

// ─── JSON-RPC over stdio ──────────────────────────────────────────────────────

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: { jsonrpc: string; id?: unknown; method: string; params?: unknown };
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'result_submitter', version: '1.0.0' },
      },
    });

  } else if (msg.method === 'notifications/initialized') {
    // No response for notifications.

  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: [SUBMIT_TOOL] },
    });

  } else if (msg.method === 'tools/call') {
    const params = msg.params as { name: string; arguments: Record<string, unknown> } | undefined;
    if (params?.name === 'submit_result') {
      const args     = params.arguments ?? {};
      const failures = validate(args);

      // Hard gate: required fields must be present and substantive. Returning
      // isError forces the model to see the failure and re-submit — up to
      // MAX_REJECTS times. After that we accept anyway so the run is never stuck.
      if (failures.length > 0 && rejects < MAX_REJECTS) {
        rejects++;
        process.stderr.write(`[result-mcp] rejected: ${failures.join('; ')} (reject ${rejects}/${MAX_REJECTS})\n`);
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{
              type: 'text',
              text:
                `REJECTED: ${failures.join('; ')}. Re-call submit_result NOW with those field(s) filled in. ` +
                `This call was NOT recorded — nothing is saved until the result is valid.`,
            }],
            isError: true,
          },
        });
      } else {
        if (failures.length > 0) {
          process.stderr.write(`[result-mcp] accepting despite: ${failures.join('; ')} after ${rejects} rejects — downstream defaults will apply\n`);
        }
        try {
          fs.writeFileSync(outputPath!, JSON.stringify(args));
          process.stderr.write('[result-mcp] result captured\n');
        } catch (err) {
          process.stderr.write(`[result-mcp] write error: ${err}\n`);
        }
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'Result submitted.' }] },
        });
      }
    } else {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unknown tool: ${params?.name ?? '(none)'}` },
      });
    }

  } else if (typeof msg.id !== 'undefined') {
    // Respond to unrecognised requests (not notifications) with method-not-found.
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: 'Method not found' },
    });
  }
});

rl.on('close', () => process.exit(0));
