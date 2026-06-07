import { useState, useRef, useCallback } from 'react';
import type { CharterData, ChatMessage } from '../types';

// ─── Types ───────────────────────────────────────────────────────────────────

type Phase = 'start' | 'goal' | 'scope' | 'nongoals' | 'questions' | 'team' | 'ready';

interface SessionState {
  messages: ChatMessage[];
  charter: CharterData;
  team: string[];
  typing: string | null;
  executable: boolean;
  phase: Phase;
}

// ─── Keyword extraction ───────────────────────────────────────────────────────

function detectKeywords(text: string) {
  const t = text.toLowerCase();
  return {
    hasDb:       /postgres|mysql|sqlite|mongodb|database|db\b|sql|supabase/.test(t),
    hasAuth:     /auth|login|password|jwt|oauth|session|user account|sign.?in/.test(t),
    hasPayment:  /payment|stripe|billing|subscription|money|charge/.test(t),
    hasApi:      /api|endpoint|rest|graphql|webhook/.test(t),
    hasBot:      /discord|slack|telegram|bot\b/.test(t),
    hasUi:       /react|vue|svelte|frontend|ui\b|dashboard|page|screen|interface/.test(t),
    hasCli:      /cli|command.?line|terminal|bash|script/.test(t),
    hasScale:    /thousand|million|scale|concurrent|high.?traffic|many users/.test(t),
    hasExisting: /existing|current|already have|legacy|we have/.test(t),
    hasWrite:    /create|insert|update|delete|write|post|put\b|add\b/.test(t),
    hasInput:    /user input|filter|search|query param|form|request param/.test(t),
    hasSql:      /sql|query|select|where|join|inject/.test(t),
  };
}

function toGoal(text: string): string {
  // Trim and normalise the user's first message into a goal line.
  let t = text.trim().replace(/\.+$/, '');
  // Strip common openers
  t = t.replace(/^(i want to|i need to|we need to|can you|please|build|create|make|implement)\s+/i, '');
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (!t.endsWith('.')) t += '.';
  return t;
}

// ─── PM response bank ────────────────────────────────────────────────────────

// pick(arr) picks a random element — but we seed by message count so it's
// deterministic per conversation (avoids Date.now() in render paths).
function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length];
}

function pmOpeningResponse(kw: ReturnType<typeof detectKeywords>, project: string, seed: number): string {
  if (kw.hasDb && kw.hasInput) return `${project} — and it's touching user-controlled input into a query. I'm bringing Security in now, before we set a single constraint.`;
  if (kw.hasDb)   return pick([
    `${project} — good. Where does the data live, and is this read-only or are we writing back?`,
    `${project} — I see a database in scope. Existing schema or greenfield? That changes the blast radius.`,
  ], seed);
  if (kw.hasAuth) return `${project} — auth is in scope. Who are the users: internal team, registered accounts, or anonymous public?`;
  if (kw.hasBot)  return pick([
    `${project}. What's the data source — something the bot already has access to, or a new integration?`,
    `${project} — is this reading from an existing store, or are we persisting new data?`,
  ], seed);
  if (kw.hasUi)   return `${project}. Who are the primary users — power users who live in dashboards, or first-timers? It changes everything about the interaction model.`;
  if (kw.hasCli)  return `${project}. What's the input source — files, stdin, a service? And how big can the data get?`;
  return pick([
    `${project}. A few things I need before I can scope this: who are the users, and does this touch any existing data or services?`,
    `${project} — makes sense. Give me more on the data layer: existing store, or greenfield?`,
    `Got it. Who's using this, and roughly what scale are we targeting for v1?`,
  ], seed);
}

function pmScopeResponse(_kw: ReturnType<typeof detectKeywords>, seed: number): string {
  const opts = [
    "Good. For v1, I'd call these out of scope — tell me if you disagree:",
    "That gives me enough to set constraints. I'd park the following for later — push back if I'm wrong:",
    "Noted. My instinct for v1 is to cut these — agree or override?",
  ];
  return pick(opts, seed);
}

function pmNongoalResponse(seed: number): string {
  const opts = [
    "One open question before I staff this:",
    "Almost there. One thing I want a call on before we build:",
    "Good. One decision I'd rather make now than during the build:",
  ];
  return pick(opts, seed);
}

function pmTeamResponse(agents: string[]): string {
  const names = agents.map(id => ({ coder: 'a Coder', tester: 'a Tester', security: 'a Security reviewer', negotiator: 'a Negotiator' }[id] ?? id));
  const list = names.length <= 2 ? names.join(' and ') : names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
  return `Charter's ready. I'd staff this with ${list}. Hit Execute when you want the swarm to start.`;
}

function pmQuestionFor(kw: ReturnType<typeof detectKeywords>, charter: CharterData, seed: number): string {
  if (kw.hasDb && charter.constraints.length > 0) {
    const dbConstraint = charter.constraints.find(c => /match|record|row|table/.test(c.text.toLowerCase()));
    if (dbConstraint) return "Should tied records share a rank, or does the first one by insertion order win?";
  }
  if (kw.hasUi) return "Mobile layout in v1, or desktop-first and defer mobile?";
  if (kw.hasApi) return "Versioning on the API surface from day one, or defer until you have a second consumer?";
  if (kw.hasCli) return "Streaming output for large inputs, or buffer and print at the end?";
  return pick([
    "What does 'done' look like — is there a specific success metric, or is shipped the bar?",
    "Is there a hard deadline, or are we optimising for quality over speed?",
    "Any existing tests or CI that the new code needs to stay green on?",
  ], seed);
}

function securityInterjectionFor(kw: ReturnType<typeof detectKeywords>, _seed: number): string {
  if (kw.hasSql || (kw.hasDb && kw.hasInput)) return "[Security consulted] Any user-controlled value going into a query needs to be parameterized — string interpolation into SQL is a gate condition, not a suggestion.";
  if (kw.hasAuth)    return "[Security consulted] Auth flows — especially session handling and credential storage — are on my checklist. Don't skip the security pass here.";
  if (kw.hasPayment) return "[Security consulted] Payments mean PCI scope. I'll need to see how credentials and card data are handled before this can reach done.";
  if (kw.hasDb)      return "[Security consulted] Any raw query paths in scope? I want to flag injection vectors before Coder writes them in.";
  return "[Security consulted] I see user-controlled input in scope — worth a dedicated security pass before this ships.";
}

// ─── Constraint / non-goal generators ────────────────────────────────────────

function deriveConstraints(text: string, kw: ReturnType<typeof detectKeywords>): string[] {
  const items: string[] = [];
  const t = text.toLowerCase();
  if (kw.hasExisting && kw.hasDb) items.push("Reads from the existing database — no schema changes in v1");
  else if (kw.hasDb && !kw.hasWrite) items.push("Database access is read-only");
  if (kw.hasScale || /hundred|thousand|million/.test(t)) items.push("Must handle concurrent requests — pagination required");
  if (/paginate|page|limit|top \d+/.test(t)) items.push("Results capped and paginated");
  if (kw.hasInput && kw.hasDb) items.push("All user-supplied query parameters must be parameterized — no string interpolation");
  if (kw.hasAuth) items.push("Auth is required — unauthenticated requests must be rejected");
  if (kw.hasExisting && !kw.hasDb) items.push("Integrates with the existing codebase — no new dependencies without approval");
  // If nothing extracted yet, add a generic scope constraint
  if (items.length === 0) items.push("v1 scope: core feature only, no admin tooling");
  return items;
}

function proposeNonGoals(kw: ReturnType<typeof detectKeywords>): string[] {
  const items: string[] = [];
  if (kw.hasUi)   { items.push("No mobile-optimised layout in v1"); items.push("No theming or dark mode in v1"); }
  if (kw.hasBot)  { items.push("No write access — read-only commands only"); }
  if (kw.hasApi)  { items.push("No API versioning in v1"); }
  if (kw.hasCli)  { items.push("No interactive TUI — plain output only"); }
  if (kw.hasAuth) { items.push("No password-reset or account-management flows in v1"); }
  if (items.length === 0) {
    items.push("No admin dashboard in v1");
    items.push("No email or notification layer in v1");
  }
  return items.slice(0, 2);
}

function recommendTeam(kw: ReturnType<typeof detectKeywords>): string[] {
  const team = ['coder', 'tester'];
  if (kw.hasDb || kw.hasAuth || kw.hasPayment || kw.hasInput || kw.hasSql) team.push('security');
  return team;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function usePlanningSession(onExecutable: (v: boolean) => void) {
  const [state, setState] = useState<SessionState>({
    messages:   [],
    charter:    { goal: '', constraints: [], nongoals: [], questions: [] },
    team:       [],
    typing:     null,
    executable: false,
    phase:      'start',
  });

  // Track accumulated keywords across the whole conversation
  const kwAccum  = useRef<ReturnType<typeof detectKeywords>>({ hasDb: false, hasAuth: false, hasPayment: false, hasApi: false, hasBot: false, hasUi: false, hasCli: false, hasScale: false, hasExisting: false, hasWrite: false, hasInput: false, hasSql: false });
  const msgCount = useRef(0);

  // Schedule a sequence of state mutations with delays
  const schedule = useCallback((steps: Array<{ delay: number; fn: (prev: SessionState) => SessionState }>) => {
    let offset = 0;
    steps.forEach(({ delay, fn }) => {
      offset += delay;
      setTimeout(() => setState(prev => fn(prev)), offset);
    });
  }, []);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const kw = detectKeywords(trimmed);
    // Merge into accumulated keywords
    Object.keys(kw).forEach(k => {
      if ((kw as any)[k]) (kwAccum.current as any)[k] = true;
    });
    const allKw = kwAccum.current;
    const seed  = msgCount.current++;

    // 1. Add user message immediately
    setState(prev => ({
      ...prev,
      messages: [...prev.messages, { from: 'you', text: trimmed }],
    }));

    const phase = state.phase; // snapshot before any async

    // 2. Build the response sequence based on phase
    if (phase === 'start' || phase === 'goal') {
      const projectSummary = toGoal(trimmed);
      const needsSecurity  = kw.hasAuth || kw.hasPayment || kw.hasSql || (kw.hasDb && kw.hasInput);
      const pmQ            = pmOpeningResponse(kw, projectSummary, seed);

      const steps: Array<{ delay: number; fn: (p: SessionState) => SessionState }> = [
        // typing
        { delay: 400, fn: p => ({ ...p, typing: 'pm' }) },
        // charter: set goal
        { delay: 1200, fn: p => ({
            ...p, typing: null,
            messages: [...p.messages, { from: 'pm', text: pmQ }],
            charter: { ...p.charter, goal: projectSummary },
            phase: 'scope' as Phase,
          }),
        },
      ];

      if (needsSecurity) {
        // Security interjects before PM finishes
        steps.splice(1, 0,
          { delay: 300, fn: p => ({ ...p, typing: 'security' }) },
          { delay: 900, fn: p => ({
              ...p, typing: null,
              messages: [...p.messages, { from: 'security', text: securityInterjectionFor(allKw, seed) }],
            }),
          }
        );
        // shift the PM delay
        steps[steps.length - 1].delay = 700;
      }

      schedule(steps);

    } else if (phase === 'scope') {
      const constraints = deriveConstraints(trimmed, allKw);
      const nongoals    = proposeNonGoals(allKw);
      const pmText      = pmScopeResponse(allKw, seed);

      schedule([
        { delay: 400, fn: p => ({ ...p, typing: 'pm' }) },
        { delay: 1300, fn: p => ({
            ...p, typing: null,
            messages: [...p.messages, {
              from: 'pm',
              text: `${pmText}\n${nongoals.map(ng => `• ${ng}`).join('\n')}`,
            }],
            charter: {
              ...p.charter,
              constraints: [
                ...p.charter.constraints,
                ...constraints
                  .filter(c => !p.charter.constraints.find(x => x.text === c))
                  .map(c => ({ text: c })),
              ],
              nongoals: nongoals.map(ng => ({ text: ng })),
            },
            phase: 'nongoals' as Phase,
          }),
        },
      ]);

    } else if (phase === 'nongoals') {
      const question = pmQuestionFor(allKw, state.charter, seed);
      const pmIntro  = pmNongoalResponse(seed);

      schedule([
        { delay: 400, fn: p => ({ ...p, typing: 'pm' }) },
        { delay: 1100, fn: p => ({
            ...p, typing: null,
            messages: [...p.messages, { from: 'pm', text: `${pmIntro}\n\n${question}` }],
            charter: {
              ...p.charter,
              questions: [{ text: question }],
            },
            phase: 'questions' as Phase,
          }),
        },
      ]);

    } else if (phase === 'questions') {
      const resolvedAnswer = trimmed.charAt(0).toUpperCase() + trimmed.slice(1).replace(/\.?$/, '.');
      const team           = recommendTeam(allKw);
      const pmText         = pmTeamResponse(team);

      schedule([
        // resolve question
        { delay: 200, fn: p => ({
            ...p,
            charter: {
              ...p.charter,
              questions: p.charter.questions.map((q, i) =>
                i === 0 ? { text: q.text + '  →  ' + resolvedAnswer, resolved: true } : q
              ),
            },
          }),
        },
        // PM types
        { delay: 500, fn: p => ({ ...p, typing: 'pm' }) },
        // team chips appear one by one, then PM message
        { delay: 500, fn: p => ({ ...p, team: [team[0]], typing: 'pm' }) },
        { delay: 700, fn: p => ({ ...p, team: team.slice(0, 2), typing: 'pm' }) },
        { delay: 900, fn: p => ({
            ...p, typing: null,
            team,
            messages: [...p.messages, { from: 'pm', text: pmText }],
            phase: 'ready' as Phase,
            executable: true,
          }),
        },
      ]);
      // signal App that Execute can be enabled
      setTimeout(() => onExecutable(true), 2400);

    } else {
      // ready phase — PM acknowledges any further messages
      const acks = [
        "Noted. We can refine that once the run starts — use PM Chat to redirect mid-build.",
        "Good point. I'll include that in the charter context when I dispatch the team.",
        "Got it. Charter's already marked ready — hit Execute when you are.",
      ];
      schedule([
        { delay: 300, fn: p => ({ ...p, typing: 'pm' }) },
        { delay: 900, fn: p => ({
            ...p, typing: null,
            messages: [...p.messages, { from: 'pm', text: pick(acks, seed) }],
          }),
        },
      ]);
    }
  }, [state.phase, state.charter, schedule, onExecutable]);

  // Kick off the opening message on first use
  const started = useRef(false);
  const init = useCallback(() => {
    if (started.current) return;
    started.current = true;
    schedule([
      { delay: 600, fn: p => ({ ...p, typing: 'pm' }) },
      { delay: 1400, fn: p => ({
          ...p, typing: null,
          messages: [{ from: 'pm', text: "Before I staff anything — what are we building?" }],
        }),
      },
    ]);
  }, [schedule]);

  return { ...state, send, init };
}
