#!/usr/bin/env node
/**
 * Minimal stdio MCP server for the PM planning session.
 *
 * Exposes a single `submit_pm_response` tool. When the PM calls it, the tool
 * arguments (the structured PM response) are written to PM_OUTPUT_PATH and
 * "Response submitted." is returned to Claude so it can finish cleanly.
 *
 * This gives us guaranteed structured output: Claude MUST call the tool to
 * complete its turn, so the output is always schema-validated and never plain
 * text. No heuristic parsing, no JSON-fence stripping, no keyword detection.
 *
 * Protocol: MCP JSON-RPC 2.0 over stdio (newline-delimited JSON).
 */

import * as fs       from 'node:fs';
import * as readline from 'node:readline';

const outputPath = process.env.PM_OUTPUT_PATH;
if (!outputPath) {
  process.stderr.write('[pm-mcp] PM_OUTPUT_PATH not set\n');
  process.exit(1);
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const SUBMIT_TOOL = {
  name: 'submit_pm_response',
  description:
    'Submit your structured PM response. Call this ONCE — it is the only way ' +
    'to deliver your reply and charter updates. Plain text output is ignored.',
  inputSchema: {
    type: 'object',
    required: ['reply'],
    properties: {
      reply: {
        type: 'string',
        description: 'Your natural, conversational response to the user.',
      },
      security_interject: {
        type: 'string',
        description: 'One-line security concern from the Security specialist. Omit if none.',
      },
      deployment_info: {
        type: 'string',
        description: 'How this project gets deployed. Set only when first learned; omit on all other turns.',
      },
      charter_updates: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description:
              'Your clearest current formulation of what is being built. ' +
              'Refine this as the conversation clarifies scope — goals evolve. ' +
              'Set it whenever you have a better or more precise version.',
          },
          new_constraints: {
            type: 'array',
            items: { type: 'string' },
            description: 'New technical or product constraints to add. Only genuinely new ones.',
          },
          new_nongoals: {
            type: 'array',
            items: { type: 'string' },
            description: 'Explicit out-of-scope items. Propose these; the user can push back.',
          },
          new_questions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Open questions you are raising that are not yet answered.',
          },
          resolved_question: {
            type: 'object',
            description: 'If the user just answered an open question, resolve it.',
            properties: {
              index:  { type: 'number', description: '0-based index of the question being resolved' },
              answer: { type: 'string' },
            },
            required: ['index', 'answer'],
          },
        },
      },
      team_add: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['coder', 'tester', 'security', 'reviewer', 'negotiator'],
        },
        description: 'Agent roles to add to the recommended team.',
      },
      enable_execute: {
        type: 'boolean',
        description: 'Set true when the charter is ready and Execute should be enabled.',
      },
      suggest_compact: {
        type: 'boolean',
        description: 'Set true once when the conversation is getting long. Never set twice.',
      },
    },
  },
};

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
        serverInfo: { name: 'pm_responder', version: '1.0.0' },
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
    if (params?.name === 'submit_pm_response') {
      try {
        fs.writeFileSync(outputPath!, JSON.stringify(params.arguments));
        process.stderr.write('[pm-mcp] response captured\n');
      } catch (err) {
        process.stderr.write(`[pm-mcp] write error: ${err}\n`);
      }
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: 'Response submitted.' }] },
      });
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
