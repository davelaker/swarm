import { useState, useRef, useCallback, useEffect } from 'react';
import type { ActivityEntry, CharterData, ChatMessage } from '../types';
import type { RunCharter, TaskGraphEntry } from '../App';

function now(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── Types ───────────────────────────────────────────────────────────────────

type Phase = 'start' | 'goal' | 'scope' | 'nongoals' | 'questions' | 'team' | 'ready';

interface SessionState {
  messages: ChatMessage[];
  charter: CharterData;
  team: string[];
  typing: string | null;
  executable: boolean;
  executableReason: string;
  phase: Phase;
  suggestCompact: boolean;
  branchMode?: 'branch' | 'main';
  branchName?: string; // user-edited slug only (no swarm/ prefix); undefined = auto-derive from goal
  taskGraph?: TaskGraphEntry[];
  streamingPmText: string | null;
  pmActivity?: ActivityEntry[]; // PM thinking + sub-agent steps this turn, attached to the reply when it lands
  researching: { question: string; agent?: string } | null; // active research round (agent = specialist name, or undefined for the generic Scout)
  hireSuggestion: { agentId: string; reason: string } | null; // PM's pending hire recommendation
  deploymentInfo?: string;
}

// ─── localStorage persistence ─────────────────────────────────────────────────
// Survives HMR reloads and accidental browser refreshes. Cleared by newSession().
//
// ⚠️  SECURITY HAZARD — localhost only.
// This stores planning session data (goal, charter, conversation history) in
// plaintext localStorage with no encryption or access control. That is
// acceptable for a single-user localhost dev tool. It is NOT acceptable if
// this app is ever served beyond localhost.
//
// Before any non-localhost deployment, this must be replaced with either:
//   a) Server-side session storage backed by a proper auth layer, or
//   b) Client-side encryption (e.g. Web Crypto API) keyed to a user credential.
// See project_state.md "Security debt" section for the full list of issues.
//
// Other notes:
//   - Don't paste credentials or secrets into the PM chat.
//   - Sessions are scoped per-project so different projects don't share state.
//   - TTL of SESSION_TTL_MS: stale data is cleared automatically on next load.

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Fixed storage key — NOT project-scoped.
//
// Why: the project name comes from an async /state fetch, so on first render the
// hook always starts with project = 'default'. If we keyed by project name, the
// lazy initializer would load from 'default' but persist() would save under the
// real project name once it loaded — so the next refresh would find nothing under
// 'default' and start a fresh session.
//
// Project-scoped session key.
// ProjectSwitcher writes 'swarm-active-root' before window.location.reload()
// so the correct key is available synchronously here — no async /state fetch needed.
// Falls back to the passed projectName for sessions that predate the root stamp.
const ROOT_KEY = 'swarm-active-root';
function storageKey(_project: string): string {
  try {
    const root = localStorage.getItem(ROOT_KEY);
    if (root) {
      // Derive a safe suffix from the full path, e.g. "/Users/david/Sites/foo" → "foo-a3b"
      const name = root.split('/').filter(Boolean).pop() ?? 'default';
      const suffix = root.length.toString(36); // cheap disambiguator for same-name projects
      return `swarm-session-v2-${name}-${suffix}`;
    }
  } catch {
    /* private mode */
  }
  return `swarm-session-v1`; // legacy fallback
}

type PersistedState = Pick<
  SessionState,
  | 'messages'
  | 'charter'
  | 'team'
  | 'phase'
  | 'executable'
  | 'executableReason'
  | 'branchMode'
  | 'branchName'
  | 'taskGraph'
> & { savedAt: number };

function loadPersisted(project: string): Omit<PersistedState, 'savedAt'> | null {
  try {
    const raw = localStorage.getItem(storageKey(project));
    if (!raw) return null;
    const p = JSON.parse(raw) as PersistedState;
    // Expire stale sessions
    if (!p.savedAt || Date.now() - p.savedAt > SESSION_TTL_MS) {
      localStorage.removeItem(storageKey(project));
      return null;
    }
    return Array.isArray(p.messages) && p.messages.length > 0 ? p : null;
  } catch {
    return null;
  }
}

function persist(s: SessionState, project: string) {
  try {
    const p: PersistedState = {
      messages: s.messages,
      charter: s.charter,
      team: s.team,
      phase: s.phase,
      executable: s.executable,
      executableReason: s.executableReason,
      branchMode: s.branchMode,
      branchName: s.branchName,
      taskGraph: s.taskGraph,
      savedAt: Date.now(),
    };
    localStorage.setItem(storageKey(project), JSON.stringify(p));
  } catch {
    /* quota exceeded or private mode — ignore */
  }
}

function clearPersisted(project: string) {
  try {
    localStorage.removeItem(storageKey(project));
  } catch {
    /* ok */
  }
}

const DEFAULT_REASON = 'Complete the planning conversation to unlock Execute';

// ─── Hook ────────────────────────────────────────────────────────────────────

export function usePlanningSession(
  onExecutable: (
    v: boolean,
    goal?: string,
    charter?: RunCharter,
    team?: string[],
    reason?: string,
  ) => void,
  project = 'default',
  recapMessage?: string | null,
  runBlockedReason?: string | null,
) {
  // Lazy initializer — runs once, restores persisted session if available.
  const [state, setState] = useState<SessionState>(() => {
    const p = loadPersisted(project);
    if (p) {
      return {
        messages: p.messages,
        charter: p.charter ?? { goal: '', constraints: [], nongoals: [], questions: [] },
        team: p.team ?? [],
        typing: null,
        executable: p.executable ?? false,
        executableReason: p.executableReason ?? DEFAULT_REASON,
        phase: p.phase ?? 'goal',
        suggestCompact: false,
        branchMode: p.branchMode,
        branchName: p.branchName,
        taskGraph: p.taskGraph,
        streamingPmText: null,
        researching: null,
        hireSuggestion: null,
      };
    }
    return {
      messages: [],
      charter: { goal: '', constraints: [], nongoals: [], questions: [] },
      team: [],
      typing: null,
      executable: false,
      executableReason: DEFAULT_REASON,
      phase: 'start',
      suggestCompact: false,
      branchMode: undefined,
      streamingPmText: null,
      researching: null,
      hireSuggestion: null,
    };
  });

  // Persist on every meaningful state change (skip transient 'typing' flicker).
  useEffect(() => {
    if (state.phase === 'start') return; // nothing worth saving yet
    persist(state, project);
  }, [state, project]);

  // On mount, if we restored an executable session, re-notify the parent
  // (App.tsx stores executable separately and won't know otherwise).
  const onExecutableRef = useRef(onExecutable);
  onExecutableRef.current = onExecutable;
  useEffect(() => {
    const p = loadPersisted(project);
    if (p?.executable && p.charter?.goal) {
      const charter: RunCharter = {
        constraints: (p.charter.constraints ?? []).map((c: { text: string }) => c.text),
        nongoals: (p.charter.nongoals ?? []).map((n: { text: string }) => n.text),
        questions: (p.charter.questions ?? []).map((q: { text: string }) => q.text),
        branchMode: p.branchMode,
        branchName: p.branchName,
        taskGraph: p.taskGraph,
      };
      onExecutableRef.current(true, p.charter.goal, charter, p.team ?? []);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Schedule helper (used only by init) ─────────────────────────────────

  const schedule = useCallback(
    (steps: Array<{ delay: number; fn: (prev: SessionState) => SessionState }>) => {
      let offset = 0;
      steps.forEach(({ delay, fn }) => {
        offset += delay;
        setTimeout(() => setState(prev => fn(prev)), offset);
      });
    },
    [],
  );

  // ─── Post-run recap injection ─────────────────────────────────────────────
  // When a recap message arrives (after a PR is created), append a system chip
  // and have the PM ask what's next. recapRef prevents re-injection on re-renders.

  const recapRef = useRef<string | null>(null);
  useEffect(() => {
    if (!recapMessage || recapMessage === recapRef.current) return;
    recapRef.current = recapMessage;
    // recapMessage is the PR URL. Show a plain system chip then a PM message
    // with a clickable link (PM bubbles render ReactMarkdown).
    const prUrl = recapMessage;
    setState(prev => ({
      ...prev,
      executable: false,
      executableReason: DEFAULT_REASON,
      // Full clean slate for the next task: clear the goal (and thus the charter
      // title), all charter lists, the team, and the branch — nothing from the
      // finished task should carry over into the next one.
      charter: { goal: '', constraints: [], nongoals: [], questions: [] },
      team: [],
      branchMode: undefined,
      branchName: undefined,
      phase: 'goal' as Phase,
      messages: [
        ...prev.messages,
        { from: 'system' as const, text: '✓ Run complete · PR opened', time: now() },
      ],
    }));
    schedule([
      { delay: 600, fn: p => ({ ...p, typing: 'pm' }) },
      {
        delay: 1500,
        fn: p => ({
          ...p,
          typing: null,
          messages: [
            ...p.messages,
            {
              from: 'pm' as const,
              text: `[View PR ↗](${prUrl})\n\nWhat would you like to work on next?`,
              time: now(),
            },
          ],
        }),
      },
    ]);
  }, [recapMessage, schedule]);

  // ─── Run-blocked injection ────────────────────────────────────────────────
  // When the server rejects a run (e.g. uncommitted changes), surface the reason
  // in the PM chat as a system chip so the user can't miss it.

  const blockedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!runBlockedReason || runBlockedReason === blockedRef.current) return;
    blockedRef.current = runBlockedReason;
    setState(prev => ({
      ...prev,
      messages: [
        ...prev.messages,
        { from: 'system' as const, text: `✗ Run blocked — ${runBlockedReason}`, time: now() },
      ],
    }));
  }, [runBlockedReason]);

  // ─── Apply a real PM API response to state ────────────────────────────────

  const applyPmResponse = useCallback(
    (
      prev: SessionState,
      resp: {
        reply: string;
        securityInterject?: string;
        charterUpdates?: {
          goal?: string;
          newConstraints?: string[];
          newNongoals?: string[];
          newQuestions?: string[];
          resolvedQuestion?: { index: number; answer: string };
          branchMode?: 'branch' | 'main';
          branchName?: string;
        };
        taskGraph?: TaskGraphEntry[];
        teamAdd?: string[];
        enableExecute?: boolean;
        disableExecute?: boolean;
        disableReason?: string;
      },
    ): SessionState => {
      const cu = resp.charterUpdates ?? {};
      const respondedAt = now();
      const pmThinking = prev.pmActivity ?? [];
      const newMessages = [
        ...(resp.securityInterject
          ? [{ from: 'security' as const, text: resp.securityInterject, time: respondedAt }]
          : []),
        {
          from: 'pm' as const,
          text: resp.reply,
          time: respondedAt,
          ...(pmThinking.length ? { thinking: pmThinking } : {}),
        },
      ];

      let questions = prev.charter.questions;
      if (cu.resolvedQuestion !== undefined) {
        questions = questions.map((q, i) =>
          i === cu.resolvedQuestion!.index
            ? { text: q.text + '  →  ' + cu.resolvedQuestion!.answer, resolved: true }
            : q,
        );
      }
      if (cu.newQuestions?.length) {
        questions = [...questions, ...cu.newQuestions.map(t => ({ text: t }))];
      }
      // PM rules forbid enabling Execute while questions are unresolved. If any
      // remain open here, the PM answered them in conversation but forgot to emit
      // resolved_question — auto-resolve so the charter reflects reality.
      if (resp.enableExecute) {
        questions = questions.map(q => (q.resolved ? q : { ...q, resolved: true }));
      }

      const newTeam = resp.teamAdd?.length
        ? [...prev.team, ...resp.teamAdd.filter(t => !prev.team.includes(t))]
        : prev.team;

      const newExecutable = resp.enableExecute
        ? true
        : resp.disableExecute
          ? false
          : prev.executable;

      const newReason = resp.disableExecute
        ? resp.disableReason || 'PM needs more information before proceeding'
        : resp.enableExecute
          ? ''
          : prev.executableReason;

      const newPhase: Phase = resp.enableExecute
        ? 'ready'
        : resp.disableExecute
          ? 'scope'
          : cu.goal && prev.phase === 'goal'
            ? 'scope'
            : cu.newConstraints?.length && prev.phase === 'scope'
              ? 'nongoals'
              : cu.newQuestions?.length && prev.phase === 'nongoals'
                ? 'questions'
                : prev.phase;

      return {
        ...prev,
        typing: null,
        phase: newPhase,
        messages: [...prev.messages, ...newMessages],
        executable: newExecutable,
        executableReason: newReason,
        team: newTeam,
        branchMode: cu.branchMode ?? prev.branchMode,
        // Keep user's edit if present; otherwise adopt the PM's suggestion
        branchName: prev.branchName ?? cu.branchName,
        taskGraph: resp.taskGraph ?? prev.taskGraph,
        charter: {
          ...prev.charter,
          goal: cu.goal ?? prev.charter.goal,
          constraints: cu.newConstraints?.length
            ? [
                ...prev.charter.constraints,
                ...cu.newConstraints
                  .filter(c => !prev.charter.constraints.find(x => x.text === c))
                  .map(t => ({ text: t })),
              ]
            : prev.charter.constraints,
          nongoals: cu.newNongoals?.length
            ? [
                ...prev.charter.nongoals,
                ...cu.newNongoals
                  .filter(c => !prev.charter.nongoals.find(x => x.text === c))
                  .map(t => ({ text: t })),
              ]
            : prev.charter.nongoals,
          questions,
        },
      };
    },
    [],
  );

  // ─── send ─────────────────────────────────────────────────────────────────

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      const sentAt = now();
      setState(prev => ({
        ...prev,
        messages: [...prev.messages, { from: 'you', text: trimmed, time: sentAt }],
        typing: 'pm',
        streamingPmText: null,
      }));

      const historySnapshot = state.messages;

      let activeRoot: string | undefined;
      try {
        activeRoot = localStorage.getItem(ROOT_KEY) ?? undefined;
      } catch {
        /* ok */
      }

      // Inactivity timeout, not a total cap: a PM turn can now chain several backend
      // calls (repo digest → PM → Scout/specialist research → PM), each up to ~90s, so a
      // fixed total would abort mid-research. Instead we abort only if NO SSE event
      // arrives for INACTIVITY_MS — and research emits start/done events, so a long but
      // progressing turn stays alive. The largest gap between events is one backend call.
      const INACTIVITY_MS = 160_000;
      const ctrl = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout>;
      const bumpIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => ctrl.abort(new DOMException('inactivity timeout', 'TimeoutError')),
          INACTIVITY_MS,
        );
      };
      bumpIdle();

      fetch('/pm/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmed,
          history: historySnapshot,
          charter: {
            goal: state.charter.goal || undefined,
            constraints: state.charter.constraints.map(c => c.text),
            nongoals: state.charter.nongoals.map(n => n.text),
            questions: state.charter.questions.map(q => q.text),
          },
          team: state.team,
          activeRoot,
        }),
        signal: ctrl.signal,
      })
        .then(async response => {
          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
            throw new Error(
              typeof body.error === 'string' ? body.error : `server ${response.status}`,
            );
          }
          if (!response.body) throw new Error('No response body');

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bumpIdle(); // progress arrived — reset the inactivity timer
            buffer += decoder.decode(value, { stream: true });

            // SSE events are delimited by \n\n
            const parts = buffer.split('\n\n');
            buffer = parts.pop() ?? '';

            for (const part of parts) {
              if (!part.startsWith('data: ')) continue;
              const data = JSON.parse(part.slice(6)) as Record<string, unknown>;

              if (data.type === 'thinking' && typeof data.text === 'string') {
                // PM is reasoning before it replies — append each block to this turn's
                // transcript; it stays in state until the reply lands and absorbs it.
                const entry: ActivityEntry = { kind: 'thinking', text: String(data.text) };
                setState(prev => ({
                  ...prev,
                  typing: null,
                  pmActivity: [...(prev.pmActivity ?? []), entry].slice(-200),
                }));
              } else if (data.type === 'chunk' && typeof data.text === 'string') {
                // First chunk: swap typing/research indicator for streaming text bubble.
                // pmActivity is kept — it is attached to the PM message on result.
                setState(prev => ({
                  ...prev,
                  typing: null,
                  researching: null,
                  streamingPmText: (prev.streamingPmText ?? '') + data.text,
                }));
              } else if (data.type === 'research') {
                // Scout investigating. 'started' shows the indicator and discards any
                // intermediate "let me check…" streamed text; 'done' falls back to the
                // typing indicator while the PM composes its real, research-informed reply.
                setState(prev => {
                  if (data.phase !== 'started') {
                    return { ...prev, researching: null, typing: 'pm' };
                  }
                  const question = String(data.question ?? 'the codebase');
                  const agent = typeof data.agent === 'string' ? data.agent : undefined;
                  // Record the sub-agent step in the transcript so its use is visible.
                  const step: ActivityEntry = {
                    kind: 'tool',
                    text: `Researched “${question}” · ${agent ?? 'Scout'}`,
                    tool: 'research',
                  };
                  return {
                    ...prev,
                    typing: null,
                    streamingPmText: null,
                    pmActivity: [...(prev.pmActivity ?? []), step].slice(-200),
                    researching: { question, agent },
                  };
                });
              } else if (data.type === 'result') {
                type PmResp = Parameters<typeof applyPmResponse>[1];
                type Cu = NonNullable<PmResp['charterUpdates']>;
                const cu = (data.charterUpdates ?? {}) as Cu;
                const hs = data.hireSuggestion as
                  | { agentId?: unknown; reason?: unknown }
                  | undefined;
                const hireSuggestion =
                  hs && typeof hs.agentId === 'string'
                    ? {
                        agentId: hs.agentId,
                        reason: typeof hs.reason === 'string' ? hs.reason : '',
                      }
                    : null;
                setState(prev => {
                  const next = applyPmResponse(prev, data as PmResp);
                  const withClear = { ...next, streamingPmText: null, pmActivity: [] };
                  const withExtras = data.deploymentInfo
                    ? { ...withClear, deploymentInfo: String(data.deploymentInfo) }
                    : withClear;
                  const withCompact = data.suggestCompact
                    ? { ...withExtras, suggestCompact: true }
                    : withExtras;
                  // Keep an existing suggestion until the user acts, but a fresh one replaces it.
                  return hireSuggestion ? { ...withCompact, hireSuggestion } : withCompact;
                });
                if (data.enableExecute) {
                  const goal = cu.goal ?? state.charter.goal ?? trimmed;
                  const deploymentInfo =
                    (data.deploymentInfo as string | undefined) ?? state.deploymentInfo;
                  const charter: RunCharter = {
                    constraints: [
                      ...state.charter.constraints.map(c => c.text),
                      ...((cu.newConstraints as string[] | undefined) ?? []),
                    ],
                    nongoals: [
                      ...state.charter.nongoals.map(n => n.text),
                      ...((cu.newNongoals as string[] | undefined) ?? []),
                    ],
                    questions: [
                      ...state.charter.questions.map(q => q.text),
                      ...((cu.newQuestions as string[] | undefined) ?? []),
                    ],
                    branchMode: cu.branchMode ?? state.branchMode,
                    branchName: state.branchName ?? (cu.branchName as string | undefined),
                    taskGraph:
                      (data as { taskGraph?: TaskGraphEntry[] }).taskGraph ?? state.taskGraph,
                    planningHistory: state.messages
                      .filter(m => m.from === 'pm' || m.from === 'you')
                      .map(m => ({ from: m.from as 'pm' | 'you', text: m.text })),
                    ...(deploymentInfo ? { deploymentInfo } : {}),
                  };
                  const team = [
                    ...state.team,
                    ...((data.teamAdd as string[] | undefined)?.filter(
                      t => !state.team.includes(t),
                    ) ?? []),
                  ];
                  onExecutable(true, goal, charter, team);
                } else if (data.disableExecute) {
                  onExecutable(
                    false,
                    undefined,
                    undefined,
                    undefined,
                    (data.disableReason as string | undefined) ||
                      'PM needs more information before proceeding',
                  );
                }
              } else if (data.type === 'error') {
                setState(prev => ({
                  ...prev,
                  typing: null,
                  streamingPmText: null,
                  pmActivity: [],
                  messages: [
                    ...prev.messages,
                    {
                      from: 'system' as const,
                      text: `PM error: ${String(data.error ?? 'unknown')}`,
                    },
                  ],
                }));
              }
            }
          }
        })
        .catch((err: Error) => {
          const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
          const notice = isTimeout
            ? 'PM went quiet (no progress for over 2 minutes). Try again or check the server logs.'
            : err.message.startsWith('server ') || err.message === 'Failed to fetch'
              ? 'PM server not reachable. Run `swarm dev` in the core/ directory, then resend.'
              : `PM error: ${err.message}`;
          setState(prev => ({
            ...prev,
            typing: null,
            streamingPmText: null,
            researching: null,
            messages: [...prev.messages, { from: 'system' as const, text: notice }],
          }));
        })
        .finally(() => clearTimeout(idleTimer));
    },
    [
      state.messages,
      state.charter,
      state.team,
      state.branchMode,
      state.taskGraph,
      applyPmResponse,
      onExecutable,
    ],
  );

  // ─── compact ──────────────────────────────────────────────────────────────

  const compact = useCallback(() => {
    setState(prev => ({ ...prev, typing: 'pm', suggestCompact: false }));

    const history = state.messages.filter(m => m.from !== 'system');
    const request =
      'Please provide a concise summary of our planning discussion in one short paragraph — covering the goal, key constraints, non-goals, and any open questions. Keep it under 100 words. This will replace our conversation history to save context.';

    fetch('/pm/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: request,
        history,
        charter: {
          goal: state.charter.goal || undefined,
          constraints: state.charter.constraints.map(c => c.text),
          nongoals: state.charter.nongoals.map(n => n.text),
          questions: state.charter.questions.map(q => q.text),
        },
        team: state.team,
      }),
      signal: AbortSignal.timeout(120_000),
    })
      .then(async response => {
        if (!response.ok || !response.body) throw new Error(`${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let reply = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            if (!part.startsWith('data: ')) continue;
            const data = JSON.parse(part.slice(6)) as Record<string, unknown>;
            if (data.type === 'result') reply = String(data.reply ?? '');
          }
        }

        setState(prev => ({
          ...prev,
          typing: null,
          streamingPmText: null,
          messages: [
            { from: 'pm' as const, text: reply },
            {
              from: 'system' as const,
              text: 'Conversation compacted — earlier messages cleared to save context.',
            },
          ],
        }));
      })
      .catch(() => {
        setState(prev => ({ ...prev, typing: null, streamingPmText: null }));
      });
  }, [state.messages, state.charter, state.team]);

  // ─── init ─────────────────────────────────────────────────────────────────
  // Skipped automatically if a persisted session was restored (started = true).

  const started = useRef(loadPersisted(project) !== null);

  const init = useCallback(
    (projectName?: string, projectStack?: string, switchedPath?: string) => {
      if (started.current) return;
      started.current = true;

      let greeting: string;
      if (switchedPath) {
        const name = projectName ?? switchedPath.split('/').filter(Boolean).pop() ?? 'this project';
        const parts = [`Switched to **${name}** — \`${switchedPath}\``];
        if (projectStack) parts.push(projectStack);
        parts.push('What are we building?');
        greeting = parts.join('\n\n');
      } else if (projectName) {
        greeting = projectStack
          ? `I can see this is **${projectName}** (${projectStack}). What are we building this session?`
          : `I can see this is **${projectName}**. What are we building this session?`;
      } else {
        greeting = 'Before I staff anything — what are we building?';
      }

      schedule([
        { delay: 400, fn: p => ({ ...p, typing: 'pm' }) },
        {
          delay: 900,
          fn: p => ({
            ...p,
            typing: null,
            phase: 'goal' as Phase,
            messages: [{ from: 'pm', text: greeting, time: now() }],
          }),
        },
      ]);
    },
    [schedule],
  );

  // ─── newSession ───────────────────────────────────────────────────────────
  // Clears persisted state and resets to blank. Exposed so the UI can offer
  // a "New session" button.

  // sessionKey increments each time the session is reset. Planning.tsx watches
  // it to know when to reset initFired and re-fire the greeting.
  const [sessionKey, setSessionKey] = useState(0);

  const newSession = useCallback(() => {
    clearPersisted(project);
    started.current = false;
    setSessionKey(k => k + 1);
    setState({
      messages: [],
      charter: { goal: '', constraints: [], nongoals: [], questions: [] },
      team: [],
      typing: null,
      executable: false,
      executableReason: DEFAULT_REASON,
      phase: 'start',
      suggestCompact: false,
      streamingPmText: null,
      researching: null,
      hireSuggestion: null,
    });
    onExecutable(false);
  }, [onExecutable]);

  const dismissHire = useCallback(() => {
    setState(prev => ({ ...prev, hireSuggestion: null }));
  }, []);

  const setBranchName = useCallback((slug: string) => {
    setState(prev => ({ ...prev, branchName: slug || undefined }));
  }, []);

  return { ...state, send, init, compact, newSession, sessionKey, setBranchName, dismissHire };
}
