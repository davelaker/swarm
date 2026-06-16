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

import * as fs from 'node:fs';
import * as readline from 'node:readline';

const outputPath = process.env.PM_OUTPUT_PATH;
if (!outputPath) {
  process.stderr.write('[pm-mcp] PM_OUTPUT_PATH not set\n');
  process.exit(1);
}

// How many times we'll reject an empty team_add before accepting the call anyway.
// The reject path forces the model to re-submit with a team; the cap guarantees we
// never loop until the parent's 90s timeout (which would leave the user with NO
// response). After the cap, we accept and let parsePmData's task_graph→team
// fallback / coder+reviewer default fill the gap, so the user is never stuck.
const MAX_TEAM_REJECTS = 2;
let teamRejects = 0;

// ─── Tool definition ──────────────────────────────────────────────────────────

const SUBMIT_TOOL = {
  name: 'submit_pm_response',
  description:
    'Submit your structured PM response. Call this ONCE — it is the only way ' +
    'to deliver your reply and charter updates. Plain text output is ignored.',
  inputSchema: {
    type: 'object',
    required: ['reply', 'team_add', 'task_graph'],
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
        description:
          'How this project gets deployed. Set only when first learned; omit on all other turns.',
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
              index: {
                type: 'number',
                description: '0-based index of the question being resolved',
              },
              answer: { type: 'string' },
            },
            required: ['index', 'answer'],
          },
          branch_mode: {
            type: 'string',
            enum: ['branch', 'main'],
            description:
              "Git workflow for this run. 'branch' = create a feature branch (recommended). 'main' = commit directly to main.",
          },
          branch_name: {
            type: 'string',
            description:
              "Short kebab-case slug for the feature branch (2-4 words, no numbers, max 40 chars). Set whenever branch_mode is 'branch'. E.g. 'fix-auth-redirect', 'add-stripe-webhook'.",
          },
        },
      },
      team_add: {
        type: 'array',
        items: { type: 'string' },
        description:
          'REQUIRED on every turn. Agent IDs for the recommended team. Re-emit the full current team every call — omitting it is a schema error. Minimum: ["coder", "reviewer"].',
      },
      enable_execute: {
        type: 'boolean',
        description: 'Set true when the charter is ready and Execute should be enabled.',
      },
      disable_execute: {
        type: 'boolean',
        description:
          'Set true to re-disable Execute if new information reveals a blocker after it was already enabled.',
      },
      disable_reason: {
        type: 'string',
        description:
          'Brief reason why Execute is being disabled (shown as tooltip on the button). Required if disable_execute is true.',
      },
      task_graph: {
        type: 'array',
        description:
          'REQUIRED on every turn — a draft is fine on early turns. ' +
          'Each entry is a task: id (t1, t2, …), assignee, title, and depends_on (empty = runs immediately). ' +
          'Tasks with the same or overlapping deps run in parallel once their deps complete.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique task ID, e.g. t1, t2, t_audit.' },
            assignee: {
              type: 'string',
              description:
                'Agent ID: builtin (coder/tester/security/reviewer) or a marketplace agent ID from the hired roster.',
            },
            title: { type: 'string', description: 'Clear instruction for the agent.' },
            depends_on: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs that must complete first.',
            },
            model: {
              type: 'string',
              description:
                "REQUIRED. The Claude model this agent should run on, chosen by THIS task's complexity: 'opus' (hardest / most critical reasoning, security-sensitive or architecturally tricky code, the most rigorous reviews), 'sonnet' (the standard choice for most coding and review), 'fable' (fast, capable — straightforward well-scoped edits and routine reviews), or 'haiku' (trivial, mechanical, or read-only scans). Pick deliberately per task — do not default everything to one model.",
            },
          },
          required: ['id', 'assignee', 'title', 'depends_on', 'model'],
        },
      },
      suggest_compact: {
        type: 'boolean',
        description: 'Set true once when the conversation is getting long. Never set twice.',
      },
      research_request: {
        type: 'object',
        description:
          'Set this when you need to understand the existing codebase to plan well — a read-only Scout will investigate your question and report back, and you\'ll continue planning with that context. Use a specific, answerable question (e.g. "How does the current auth middleware validate sessions, and where?"). Omit it when you already have enough context — most simple/clarifying turns need no research.',
        properties: {
          question: {
            type: 'string',
            description:
              'A specific, answerable question about the existing codebase for the Scout to investigate.',
          },
          target: {
            type: 'string',
            description:
              'Optional. The id of a HIRED specialist to run this research (e.g. "db" for live database questions). Omit to use the generic read-only Scout (source-code only). Only name a specialist that is shown ✓ HIRED in the marketplace list.',
          },
        },
      },
      hire_suggestion: {
        type: 'object',
        description:
          'Recommend the user hire a marketplace specialist that would materially improve THIS project. Use the exact agent id from the marketplace list. The UI shows your reason as a one-click "Hire" call-to-action. Only suggest a NOT-hired agent that genuinely fits; do not suggest one already hired, and do not force-fit.',
        properties: {
          agent_id: {
            type: 'string',
            description:
              'The marketplace agent id to recommend hiring (e.g. "product-researcher").',
          },
          reason: {
            type: 'string',
            description:
              'One sentence, user-facing: why hiring this specialist would help this project.',
          },
        },
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
      const args = params.arguments ?? {};
      const teamAdd = args.team_add as unknown[] | undefined;
      const teamEmpty = !Array.isArray(teamAdd) || teamAdd.length === 0;

      // Hard gate: team_add must be present and non-empty. Returning isError forces
      // the model to see the failure and re-submit — up to MAX_TEAM_REJECTS times.
      // After that we accept anyway (see counter comment) so the user is never stuck.
      if (teamEmpty && teamRejects < MAX_TEAM_REJECTS) {
        teamRejects++;
        process.stderr.write(
          `[pm-mcp] rejected: team_add missing or empty (reject ${teamRejects}/${MAX_TEAM_REJECTS})\n`,
        );
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [
              {
                type: 'text',
                text: 'REJECTED: team_add is required and must not be empty. Re-submit submit_pm_response NOW with the same reply plus team_add set to at least ["coder", "reviewer"] (add "tester"/"security" as the task warrants). This call was NOT recorded — nothing was saved until team_add is present.',
              },
            ],
            isError: true,
          },
        });
      } else {
        if (teamEmpty) {
          process.stderr.write(
            `[pm-mcp] accepting despite empty team_add after ${teamRejects} rejects — downstream fallback will apply\n`,
          );
        }
        try {
          fs.writeFileSync(outputPath!, JSON.stringify(args));
          process.stderr.write('[pm-mcp] response captured\n');
        } catch (err) {
          process.stderr.write(`[pm-mcp] write error: ${err}\n`);
        }
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'Response submitted.' }] },
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
