// Real PM planning session — INCEPTION.md §3 (critical partner, not transcriber).
// Called by POST /pm/message. Uses `claude -p` so it draws from the Max plan
// Agent SDK credit pool, same as the execution agents.

import { spawn } from 'node:child_process';
import { getConfigOptional } from '../config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HistoryMessage {
  from: 'pm' | 'you' | 'security';
  text: string;
}

export interface PmResponse {
  reply:              string;
  securityInterject?: string;
  charterUpdates?: {
    goal?:              string;
    newConstraints?:    string[];
    newNongoals?:       string[];
    newQuestions?:      string[];
    resolvedQuestion?:  { index: number; answer: string };
  };
  teamAdd?:           string[];
  enableExecute?:     boolean;
}

// ─── System prompt ────────────────────────────────────────────────────────────
// The PM is a critical partner, not a transcriber. See INCEPTION.md §3.

const PM_SYSTEM = `\
You are the Project Manager (PM) for Agent Swarm, a multi-agent AI coding system.
Your role during Planning mode is to be a CRITICAL PARTNER — challenging, precise, and opinionated.

PERSONA:
- Push back on vague, hand-wavy, or over-ambitious scope. Say so directly.
- Surface trade-offs and the roads NOT taken — not just the chosen path.
- Ask the uncomfortable questions: who are the actual users, what scale, what's the blast radius, what can go wrong, what's the security model?
- Actively defend a lean v1. When scope creeps: "that's a v2 — let's not block on it."
- Be terse. One clear question at a time. Never ask three things in one message.
- Know when you have enough: the charter doesn't need to be perfect, it needs to be executable.

WHAT YOU ARE DOING:
You are assembling a Project Charter through conversation. As you learn things, extract them into structured fields. When the charter is solid enough for agents to start without stalling, enable Execute.

CHARTER FIELDS — extract as they become clear:
- goal: One sentence. What is concretely being built.
- new_constraints: Technical or product constraints (data sources, existing systems, scale limits, security requirements). Add only new ones — don't repeat what's already in the charter.
- new_nongoals: Explicit out-of-scope items for v1. Propose these; the user can push back.
- new_questions: Open questions you're raising that aren't yet answered.
- resolved_question: If the user just answered an open question, resolve it (provide the index from the conversation and the answer).

TEAM RECOMMENDATION:
When you're ready to recommend the team, set team_add. Standard team:
- "coder" — always
- "tester" — always for feature/greenfield work
- "security" — always if there's SQL, auth, user input, API keys, or crypto in scope

SECURITY INTERJECTION:
If the user mentions SQL queries with user-controlled input, authentication, passwords, API keys, or cryptography — set security_interject to a one-line concern from the Security specialist. Keep it sharp and specific.

ENABLE EXECUTE:
Set enable_execute: true when ALL of these are true:
1. The goal is specific and unambiguous
2. At least 2 constraints are identified
3. Non-goals are clear for v1
4. Any blockers are resolved or explicitly deferred as open questions
5. You've recommended a team

Do NOT enable Execute if the goal is still vague or if a critical question remains unanswered.

RESPONSE FORMAT:
Your ENTIRE response must be a valid JSON object. The "reply" field is your natural, conversational response to the user — write it as you would speak, not as a form. The structured fields (charter_updates, team_add, etc.) are metadata you extract silently. Never reference the JSON structure in your reply.`;

// ─── JSON schema ─────────────────────────────────────────────────────────────

const SCHEMA = JSON.stringify({
  type: 'object',
  required: ['reply'],
  properties: {
    reply: {
      type: 'string',
      description: 'Your natural, conversational response to the user as the PM.',
    },
    security_interject: {
      type: 'string',
      description: 'One-line security concern from the Security specialist. Omit if none.',
    },
    charter_updates: {
      type: 'object',
      properties: {
        goal:             { type: 'string' },
        new_constraints:  { type: 'array', items: { type: 'string' } },
        new_nongoals:     { type: 'array', items: { type: 'string' } },
        new_questions:    { type: 'array', items: { type: 'string' } },
        resolved_question: {
          type: 'object',
          properties: {
            index:  { type: 'number', description: 'Index of the question being resolved (0-based)' },
            answer: { type: 'string' },
          },
          required: ['index', 'answer'],
        },
      },
    },
    team_add:       { type: 'array', items: { type: 'string', enum: ['coder', 'tester', 'security', 'negotiator'] } },
    enable_execute: { type: 'boolean' },
  },
});

// ─── Format conversation for the prompt ───────────────────────────────────────

function formatHistory(history: HistoryMessage[]): string {
  if (!history.length) return '(no prior conversation)';
  return history.map(m => {
    const who = m.from === 'you' ? 'User' : m.from === 'security' ? '[Security]' : 'PM';
    return `${who}: ${m.text}`;
  }).join('\n');
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runPmMessage(
  text:    string,
  history: HistoryMessage[],
): Promise<PmResponse> {
  const cfg = getConfigOptional();

  const conversationPrompt = [
    history.length
      ? `Conversation so far:\n${formatHistory(history)}\n`
      : '',
    `User's latest message: ${text}`,
    '',
    'Continue as the PM. Reply to the user and update the charter as appropriate.',
  ].filter(Boolean).join('\n');

  const args = [
    '--print',
    '--dangerously-skip-permissions',
    '--output-format',  'json',
    '--json-schema',    SCHEMA,
    '--system-prompt',  PM_SYSTEM,
    '--no-session-persistence',
    '--allowedTools',   '', // PM needs no tools — just reasoning
    conversationPrompt,
  ];

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('claude', args, {
      cwd:   process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('PM response timed out after 30s'));
    }, 30_000);

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }

      let envelope: { result: unknown; is_error?: boolean; cost_usd?: number };
      try {
        envelope = JSON.parse(stdout);
      } catch {
        reject(new Error(`PM output not valid JSON: ${stdout.slice(0, 200)}`));
        return;
      }

      if (envelope.is_error) {
        reject(new Error(`PM error: ${JSON.stringify(envelope.result)}`));
        return;
      }

      let data: Record<string, unknown>;
      try {
        data = typeof envelope.result === 'string'
          ? JSON.parse(envelope.result)
          : envelope.result as Record<string, unknown>;
      } catch {
        reject(new Error(`PM result not parseable JSON`));
        return;
      }

      const cu = (data.charter_updates ?? {}) as Record<string, unknown>;
      const rv = cu.resolved_question as { index: number; answer: string } | undefined;

      resolve({
        reply:              String(data.reply ?? ''),
        securityInterject:  data.security_interject ? String(data.security_interject) : undefined,
        charterUpdates: {
          goal:             cu.goal ? String(cu.goal) : undefined,
          newConstraints:   Array.isArray(cu.new_constraints) ? cu.new_constraints.map(String) : undefined,
          newNongoals:      Array.isArray(cu.new_nongoals)    ? cu.new_nongoals.map(String)    : undefined,
          newQuestions:     Array.isArray(cu.new_questions)   ? cu.new_questions.map(String)   : undefined,
          resolvedQuestion: rv,
        },
        teamAdd:        Array.isArray(data.team_add) ? data.team_add.map(String) : undefined,
        enableExecute:  Boolean(data.enable_execute),
      });
    });
  });
}
