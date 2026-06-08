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

// ─── Hook ────────────────────────────────────────────────────────────────────

export function usePlanningSession(onExecutable: (v: boolean, goal?: string) => void) {
  const [state, setState] = useState<SessionState>({
    messages:   [],
    charter:    { goal: '', constraints: [], nongoals: [], questions: [] },
    team:       [],
    typing:     null,
    executable: false,
    phase:      'start',
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
    const newMessages = [
      ...(resp.securityInterject
        ? [{ from: 'security' as const, text: resp.securityInterject }]
        : []),
      { from: 'pm' as const, text: resp.reply },
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
    setState(prev => ({
      ...prev,
      messages: [...prev.messages, { from: 'you', text: trimmed }],
      typing: 'pm',
    }));

    // Snapshot history BEFORE the user message was added
    const historySnapshot = state.messages;

    fetch('/pm/message', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: trimmed, history: historySnapshot }),
      signal:  AbortSignal.timeout(45_000),
    })
      .then(r => { if (!r.ok) throw new Error(`server ${r.status}`); return r.json(); })
      .then(resp => {
        setState(prev => applyPmResponse(prev, resp));
        if (resp.enableExecute) {
          // Pass the goal so App can hand it to POST /run/execute on Execute click.
          const goal = resp.charterUpdates?.goal ?? state.charter.goal ?? trimmed;
          onExecutable(true, goal);
        }
      })
      .catch((err: Error) => {
        const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
        const notice = isTimeout
          ? 'PM took too long to respond (>45s). Try again or check the server logs.'
          : 'PM server not reachable. Run `swarm dev` in the core/ directory, then resend.';
        setState(prev => ({
          ...prev,
          typing: null,
          messages: [...prev.messages, { from: 'system', text: notice }],
        }));
      });
  }, [state.messages, applyPmResponse, onExecutable]);

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
          messages: [{ from: 'pm', text: "Before I staff anything — what are we building?" }],
        }),
      },
    ]);
  }, [schedule]);

  return { ...state, send, init };
}
