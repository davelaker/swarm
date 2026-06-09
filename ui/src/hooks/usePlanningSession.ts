import { useState, useRef, useCallback } from 'react';
import type { CharterData, ChatMessage } from '../types';
import type { RunCharter } from '../App';

function now(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── Types ───────────────────────────────────────────────────────────────────

type Phase = 'start' | 'goal' | 'scope' | 'nongoals' | 'questions' | 'team' | 'ready';

interface SessionState {
  messages:      ChatMessage[];
  charter:       CharterData;
  team:          string[];
  typing:        string | null;
  executable:    boolean;
  phase:         Phase;
  suggestCompact: boolean;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function usePlanningSession(onExecutable: (v: boolean, goal?: string, charter?: RunCharter, team?: string[]) => void) {
  const [state, setState] = useState<SessionState>({
    messages:       [],
    charter:        { goal: '', constraints: [], nongoals: [], questions: [] },
    team:           [],
    typing:         null,
    executable:     false,
    phase:          'start',
    suggestCompact: false,
  });

  // Schedule a sequence of state mutations with delays — used only for init()
  const schedule = useCallback((steps: Array<{ delay: number; fn: (prev: SessionState) => SessionState }>) => {
    let offset = 0;
    steps.forEach(({ delay, fn }) => {
      offset += delay;
      setTimeout(() => setState(prev => fn(prev)), offset);
    });
  }, []);

  // ─── Apply a real PM API response to state ────────────────────────────────

  const applyPmResponse = useCallback((prev: SessionState, resp: {
    reply: string;
    securityInterject?: string;
    charterUpdates?: {
      goal?: string;
      newConstraints?: string[];
      newNongoals?: string[];
      newQuestions?: string[];
      resolvedQuestion?: { index: number; answer: string };
    };
    teamAdd?: string[];
    enableExecute?: boolean;
  }): SessionState => {
    const cu = resp.charterUpdates ?? {};
    const respondedAt = now();
    const newMessages = [
      ...(resp.securityInterject
        ? [{ from: 'security' as const, text: resp.securityInterject, time: respondedAt }]
        : []),
      { from: 'pm' as const, text: resp.reply, time: respondedAt },
    ];

    let questions = prev.charter.questions;
    if (cu.resolvedQuestion !== undefined) {
      questions = questions.map((q, i) =>
        i === cu.resolvedQuestion!.index
          ? { text: q.text + '  →  ' + cu.resolvedQuestion!.answer, resolved: true }
          : q
      );
    }
    if (cu.newQuestions?.length) {
      questions = [...questions, ...cu.newQuestions.map(t => ({ text: t }))];
    }

    const newTeam = resp.teamAdd?.length
      ? [...prev.team, ...resp.teamAdd.filter(t => !prev.team.includes(t))]
      : prev.team;

    const newPhase: Phase = resp.enableExecute ? 'ready'
      : cu.goal && prev.phase === 'goal'         ? 'scope'
      : cu.newConstraints?.length && prev.phase === 'scope' ? 'nongoals'
      : cu.newQuestions?.length   && prev.phase === 'nongoals' ? 'questions'
      : prev.phase;

    return {
      ...prev,
      typing:  null,
      phase:   newPhase,
      messages: [...prev.messages, ...newMessages],
      executable: resp.enableExecute || prev.executable,
      team: newTeam,
      charter: {
        ...prev.charter,
        goal: cu.goal ?? prev.charter.goal,
        constraints: cu.newConstraints?.length
          ? [...prev.charter.constraints, ...cu.newConstraints.filter(c => !prev.charter.constraints.find(x => x.text === c)).map(t => ({ text: t }))]
          : prev.charter.constraints,
        nongoals: cu.newNongoals?.length
          ? [...prev.charter.nongoals, ...cu.newNongoals.filter(c => !prev.charter.nongoals.find(x => x.text === c)).map(t => ({ text: t }))]
          : prev.charter.nongoals,
        questions,
      },
    };
  }, []);



  // ─── send: real backend only — tells the user if it fails ───────────────

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Add user message + show typing immediately
    const sentAt = now();
    setState(prev => ({
      ...prev,
      messages: [...prev.messages, { from: 'you', text: trimmed, time: sentAt }],
      typing: 'pm',
    }));

    // Snapshot history BEFORE the user message was added
    const historySnapshot = state.messages;

    fetch('/pm/message', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        text:    trimmed,
        history: historySnapshot,
        // Send structured charter on every message so the PM works from
        // authoritative state rather than reconstructing it from history.
        charter: {
          goal:        state.charter.goal || undefined,
          constraints: state.charter.constraints.map(c => c.text),
          nongoals:    state.charter.nongoals.map(n => n.text),
          questions:   state.charter.questions.map(q => q.text),
        },
        team: state.team,
      }),
      signal:  AbortSignal.timeout(45_000),
    })
      .then(r => r.json().then((body: Record<string, unknown>) => {
        if (!r.ok) throw new Error(typeof body.error === 'string' ? body.error : `server ${r.status}`);
        return body;
      }))
      .then(resp => {
        setState(prev => {
          const next = applyPmResponse(prev, resp);
          const withExtras = resp.deploymentInfo
            ? { ...next, messages: [...next.messages, { from: 'system' as const, text: 'Deployment method saved to .swarm/PROJECT.md' }] }
            : next;
          return resp.suggestCompact
            ? { ...withExtras, suggestCompact: true }
            : withExtras;
        });
        if (resp.enableExecute) {
          const cu   = resp.charterUpdates ?? {};
          const goal = cu.goal ?? state.charter.goal ?? trimmed;
          // Build the full charter from current state + this response's updates
          const charter: RunCharter = {
            constraints: [
              ...state.charter.constraints.map(c => c.text),
              ...(cu.newConstraints ?? []),
            ],
            nongoals: [
              ...state.charter.nongoals.map(n => n.text),
              ...(cu.newNongoals ?? []),
            ],
            questions: [
              ...state.charter.questions.map(q => q.text),
              ...(cu.newQuestions ?? []),
            ],
          };
          const team = [...state.team, ...(resp.teamAdd?.filter(t => !state.team.includes(t)) ?? [])];
          onExecutable(true, goal, charter, team);
        }
      })
      .catch((err: Error) => {
        const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
        const notice = isTimeout
          ? 'PM took too long to respond (>45s). Try again or check the server logs.'
          : err.message.startsWith('server ') || err.message === 'Failed to fetch'
            ? 'PM server not reachable. Run `swarm dev` in the core/ directory, then resend.'
            : `PM error: ${err.message}`;
        setState(prev => ({
          ...prev,
          typing: null,
          messages: [...prev.messages, { from: 'system', text: notice }],
        }));
      });
  }, [state.messages, applyPmResponse, onExecutable]);

  // ─── compact: ask PM to summarise and replace history ────────────────────
  const compact = useCallback(() => {
    setState(prev => ({ ...prev, typing: 'pm', suggestCompact: false }));

    const history = state.messages.filter(m => m.from !== 'system');
    const request = 'Please provide a concise summary of our planning discussion in one short paragraph — covering the goal, key constraints, non-goals, and any open questions. Keep it under 100 words. This will replace our conversation history to save context.';

    fetch('/pm/message', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        text:    request,
        history,
        charter: {
          goal:        state.charter.goal || undefined,
          constraints: state.charter.constraints.map(c => c.text),
          nongoals:    state.charter.nongoals.map(n => n.text),
          questions:   state.charter.questions.map(q => q.text),
        },
        team: state.team,
      }),
      signal:  AbortSignal.timeout(45_000),
    })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
      .then(resp => {
        setState(prev => ({
          ...prev,
          typing: null,
          messages: [
            { from: 'pm' as const, text: resp.reply },
            { from: 'system' as const, text: 'Conversation compacted — earlier messages cleared to save context.' },
          ],
        }));
      })
      .catch(() => {
        setState(prev => ({ ...prev, typing: null }));
      });
  }, [state.messages]);

  // Kick off the opening message on first use
  const started = useRef(false);
  const init = useCallback(() => {
    if (started.current) return;
    started.current = true;
    schedule([
      { delay: 600,  fn: p => ({ ...p, typing: 'pm' }) },
      { delay: 1400, fn: p => ({
          ...p,
          typing:   null,
          phase:    'goal' as Phase,   // unlock the textarea
          messages: [{ from: 'pm', text: "Before I staff anything — what are we building?", time: now() }],
        }),
      },
    ]);
  }, [schedule]);

  return { ...state, send, init, compact };
}
