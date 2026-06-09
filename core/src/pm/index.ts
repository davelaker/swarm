// Real PM planning session — INCEPTION.md §3 (critical partner, not transcriber).
// Called by POST /pm/message. Uses `claude -p` so it draws from the Max plan
// Agent SDK credit pool, same as the execution agents.

import { spawn } from 'node:child_process';
import { getConfigOptional } from '../config.js';
import { loadProjectContext } from '../state/repo.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HistoryMessage {
  from: 'pm' | 'you' | 'security';
  text: string;
}

// Structured charter state sent from the frontend on every message.
// This is the authoritative memory — the PM trusts it over conversation history.
export interface PmCharter {
  goal?:        string;
  constraints?: string[];
  nongoals?:    string[];
  questions?:   string[];
}

export interface PmResponse {
  reply:              string;
  securityInterject?: string;
  deploymentInfo?:    string;
  suggestCompact?:    boolean;   // set when context is getting large; UI shows a compact button
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

const PM_SYSTEM = `\
You are the Project Manager (PM) for Agent Swarm, a multi-agent AI coding system.
Your role during Planning mode is to be a CRITICAL PARTNER — challenging, precise, and opinionated.

PERSONA:
- Push back on vague, hand-wavy, or over-ambitious scope. Say so directly.
- Surface trade-offs and the roads NOT taken — not just the chosen path.
- Ask the uncomfortable questions: who are the actual users, what scale, what can go wrong, what's the security model?
- Actively defend a lean v1. When scope creeps: "that's a v2 — let's not block on it."
- Be terse. One clear question at a time. Never ask three things in one message.
- Know when you have enough. The charter needs to be executable, not perfect.

CALIBRATE: bug fix = 1–2 exchanges then Execute; feature = 3–5; greenfield = more. Never over-question a bug fix; never under-question greenfield.

CONTEXT MANAGEMENT:
If you receive a CONTEXT NOTE or CONTEXT ALERT above the conversation, act on it. If the charter is executable, enable Execute. If it genuinely is not, set suggest_compact: true once — do not set it every turn. After it is set, do not set it again in the same conversation.

DEPLOYMENT CHECK — do this once per project, not every session:
Look at the project context provided above (from .swarm/PROJECT.md). Check whether a "## Deployment" section already has real content.
- If it does: skip — do not ask about deployment again.
- If it is absent, blank, or says "unknown" / "to be discovered": ask once, early in the conversation (first or second exchange). Keep it brief: "How does this project get deployed when it's ready?" Accept any answer — git push, manual upload, CI/CD, "I'll handle it myself", or "not sure yet". Record whatever they say in deployment_info. This is background context, not a blocker.
Never ask about deployment more than once.

WHAT YOU ARE DOING:
Assembling a Project Charter through conversation. The current charter state is injected above as structured data — treat it as authoritative. You do not need to re-derive it from the conversation. Your job is to fill in what is missing, challenge what is wrong, and enable Execute when the charter is complete enough to act on.

Only the RECENT conversation is shown (last few exchanges). Earlier exchanges have already been absorbed into the charter state above.

CHARTER FIELDS — extract as they become clear:
- goal: One sentence. What is concretely being built or fixed.
- new_constraints: Technical or product constraints. Add only genuinely new ones.
- new_nongoals: Explicit out-of-scope items. Propose these; the user can push back.
- new_questions: Open questions you're raising that aren't yet answered.
- resolved_question: If the user just answered an open question, resolve it (index and answer).

TEAM RECOMMENDATION — set team_add when ready:
- "coder" — always
- "tester" — always for features and greenfield; optional for trivial single-file tweaks
- "security" — whenever there's SQL, auth, user input, API keys, crypto, or file system access in scope
- "reviewer" — always for features and greenfield; the code review gate that catches correctness and design issues

SECURITY INTERJECTION:
If the user mentions SQL queries with user-controlled input, authentication, passwords, API keys, or cryptography — set security_interject to a sharp one-line concern from the Security specialist.

ENABLE EXECUTE — use judgment, not a checklist:
Enable Execute when the goal is clear enough that agents can start without stalling mid-task.
- Required always: the goal is specific and the success condition is clear; you've recommended a team.
- Required for features and above: at least one constraint and one non-goal are explicit.
- For bug fixes: constraints and non-goals can be light or absent if the problem statement is already precise.
Do NOT enable Execute if a critical open question would force the Coder to make a dangerous assumption.

RESPONSE FORMAT — CRITICAL:
Your ENTIRE response must be a single valid JSON object. No preamble, no markdown, no text outside the JSON.
Start with { and end with }. Nothing before the opening brace.
The "reply" field is your natural conversational response to the user. The structured fields are silent metadata.
Never reference the JSON structure in your reply.`;

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
    deployment_info: {
      type: 'string',
      description: 'One-line summary of how this project is deployed. Set only when first learned — omit on all other turns.',
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
    team_add:       { type: 'array', items: { type: 'string', enum: ['coder', 'tester', 'security', 'reviewer', 'negotiator'] } },
    enable_execute:  { type: 'boolean' },
    suggest_compact: {
      type: 'boolean',
      description: 'Set true when the conversation is getting long and would benefit from being compacted. The UI will show a compact button to the user.',
    },
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

// ─── Context monitoring ───────────────────────────────────────────────────────
// Rough estimate: 1 token ≈ 4 characters. Conservative but good enough for
// deciding whether to nudge the PM toward wrapping up.

function estimateTokens(...parts: (string | null | undefined)[]): number {
  const total = parts.reduce((sum, p) => sum + (p?.length ?? 0), 0);
  return Math.ceil(total / 4);
}

// ─── Charter formatter ────────────────────────────────────────────────────────
// Renders the structured charter as a compact block injected into every PM call.
// This is the PM's persistent memory — replaces the need for full conversation history.

function formatCharter(charter: PmCharter | null, team: string[]): string {
  if (!charter && !team.length) return '';
  const parts: string[] = ['Charter:'];
  if (charter?.goal)                 parts.push(`goal="${charter.goal}"`);
  if (charter?.constraints?.length)  parts.push(`constraints=[${charter.constraints.join(' | ')}]`);
  if (charter?.nongoals?.length)     parts.push(`nongoals=[${charter.nongoals.join(' | ')}]`);
  if (charter?.questions?.length)    parts.push(`openQ=[${charter.questions.join(' | ')}]`);
  if (team.length)                   parts.push(`team=[${team.join(', ')}]`);
  return parts.join(' ');
}

function contextNote(estimatedTokens: number, exchangeCount: number): string {
  if (estimatedTokens > 30_000) {
    return `CONTEXT ALERT: This conversation is using ~${Math.round(estimatedTokens / 1000)}k estimated tokens (context window: 200k). If the charter is ready, enable Execute. Otherwise set suggest_compact: true so the user can compact the conversation.`;
  }
  if (exchangeCount >= 12) {
    return `CONTEXT NOTE: This conversation has had ${exchangeCount} user exchanges — that is unusually long for planning. If the charter is solid enough to execute, do so. If it is genuinely stuck, set suggest_compact: true.`;
  }
  if (exchangeCount >= 8) {
    return `CONTEXT NOTE: ${exchangeCount} exchanges in — consider whether you have enough to enable Execute. Planning should be brief.`;
  }
  return '';
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runPmMessage(
  text:     string,
  history:  HistoryMessage[],
  charter?: PmCharter,
  team?:    string[],
): Promise<PmResponse> {
  const cfg        = getConfigOptional();
  const projectCtx = loadProjectContext();

  // When the charter is provided, only send the last 6 messages — the structured
  // charter captures everything that matters; recent exchanges provide flow context.
  const recentHistory = charter ? history.slice(-6) : history;

  const exchangeCount   = history.filter(m => m.from === 'you').length;
  const charterBlock    = formatCharter(charter ?? null, team ?? []);
  const estimatedTokens = estimateTokens(PM_SYSTEM, projectCtx, charterBlock, formatHistory(recentHistory), text);
  const ctxNote         = contextNote(estimatedTokens, exchangeCount);

  const conversationPrompt = [
    projectCtx   ? `Project context (.swarm/PROJECT.md):\n${projectCtx}\n`     : '',
    charterBlock ? `${charterBlock}\n`                                           : '',
    recentHistory.length
      ? `Recent conversation:\n${formatHistory(recentHistory)}\n`
      : '',
    `User's latest message: ${text}`,
    ctxNote ? `\n${ctxNote}` : '',
    '',
    'Continue as the PM. Reply to the user and update the charter as appropriate.',
    // JSON enforcement suffix — placed in the user message (read last, higher weight than system prompt)
    // because --json-schema without tools does not force JSON output from claude --print.
    '\nIMPORTANT: Your response MUST be ONLY a valid JSON object. Start with { end with }. Example:',
    '{"reply":"your conversational reply here","charter_updates":{"goal":"if set"},"enable_execute":false}',
  ].filter(Boolean).join('\n');

  const args = [
    '--print',
    '--dangerously-skip-permissions',
    '--output-format',  'json',
    '--json-schema',    SCHEMA,
    '--system-prompt',  PM_SYSTEM,
    '--no-session-persistence',
    // Note: --allowedTools is variadic; omit it for the PM (no tools needed)
    // and use -- to signal end-of-options before the prompt argument.
    '--',
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
      reject(new Error('PM response timed out after 90s'));
    }, 90_000);

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);

      // Always try to parse stdout first — claude exits 1 even for valid JSON
      // responses when is_error: true (e.g. API errors). Include stdout in the
      // error message so we can see the real cause.
      let envelope: { result: unknown; is_error?: boolean; cost_usd?: number } | null = null;
      try { envelope = JSON.parse(stdout); } catch { /* handled below */ }

      if (code !== 0) {
        if (envelope?.is_error) {
          reject(new Error(`claude API error: ${JSON.stringify(envelope.result).slice(0, 300)}`));
        } else {
          const detail = stderr.slice(0, 300) || stdout.slice(0, 300) || '(no output)';
          reject(new Error(`claude exited ${code}: ${detail}`));
        }
        return;
      }

      if (!envelope) {
        reject(new Error(`PM output not valid JSON: ${stdout.slice(0, 200)}`));
        return;
      }

      if (envelope.is_error) {
        reject(new Error(`PM error: ${JSON.stringify(envelope.result)}`));
        return;
      }

      // Debug: log what claude actually returned so we can see its format
      console.log('[pm] result type:', typeof envelope.result, '| preview:', JSON.stringify(envelope.result)?.slice(0, 300));

      // With --json-schema, claude may return result as an already-parsed object,
      // a JSON string, or (if the schema wasn't enforced) raw text.
      let data: Record<string, unknown>;
      const raw = typeof envelope.result === 'string' ? envelope.result : null;
      if (typeof envelope.result === 'object' && envelope.result !== null) {
        data = envelope.result as Record<string, unknown>;
      } else if (raw !== null) {
        // Try to extract JSON if model wrapped it in markdown fences
        const stripped = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
        try {
          data = JSON.parse(stripped);
        } catch {
          // If the result looks like a JSON object, try that; otherwise use reply fallback
          const match = stripped.match(/\{[\s\S]*\}/);
          if (match) {
            try { data = JSON.parse(match[0]); }
            catch { reject(new Error(`PM result not parseable JSON: ${stripped.slice(0, 200)}`)); return; }
          } else {
            // Plain text response — wrap as reply and extract key signals
            data = { reply: stripped };

            // Detect execute-readiness from PM's language
            const lower = stripped.toLowerCase();
            const executePhrases = ['hit execute', 'ready when you are', 'team will pick it up',
              'go ahead and execute', 'proceed', 'kick it off', 'start the run', 'enough to start'];
            if (executePhrases.some(p => lower.includes(p))) {
              data.enable_execute = true;
              // Default team for a feature task when PM didn't specify
              if (!data.team_add) data.team_add = ['coder', 'tester', 'reviewer'];
            }

            // Use the current user message as the goal when PM says "ready".
            // `text` IS the user's current message (history only has prior turns).
            if (data.enable_execute && !data.charter_updates) {
              // Prefer the current message if it looks like a feature description
              const candidate = text.length > 20 && text.length < 600 ? text
                : [...history].reverse().find(m => m.from === 'you' && m.text.length > 20)?.text;
              if (candidate) {
                data.charter_updates = { goal: candidate };
              }
            }
          }
        }
      } else {
        reject(new Error(`PM result was null`));
        return;
      }

      const cu = (data.charter_updates ?? {}) as Record<string, unknown>;
      const rv = cu.resolved_question as { index: number; answer: string } | undefined;

      resolve({
        reply:              String(data.reply ?? ''),
        securityInterject:  data.security_interject ? String(data.security_interject) : undefined,
        deploymentInfo:     data.deployment_info    ? String(data.deployment_info)    : undefined,
        suggestCompact:     Boolean(data.suggest_compact) || undefined,
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
