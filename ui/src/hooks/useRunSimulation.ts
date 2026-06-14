import { useState, useEffect, useRef, useCallback } from 'react';
import type { Task, AgentState, Finding, ChatMessage, RunStatus } from '../types';
import {
  INIT_TASKS,
  LATE_TASKS,
  RUN_SCRIPT,
  RUN_TOTAL,
  SPEND_CAP,
  SPEND_END,
} from '../data/runScript';

const BLANK: AgentState = {
  active: false,
  step: '',
  activity: [],
  verdict: null,
  activeAt: null,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  contextPct: null,
};

function makeInitAgents(): Record<string, AgentState> {
  return {
    pm: { ...BLANK },
    coder: { ...BLANK },
    tester: { ...BLANK },
    security: { ...BLANK },
    reviewer: { ...BLANK },
    negotiator: { ...BLANK },
  };
}

export function useRunSimulation() {
  const [tasks, setTasks] = useState<Task[]>(() =>
    INIT_TASKS.map(t => ({ ...t, status: 'pending' as const })),
  );
  const [agents, setAgents] = useState<Record<string, AgentState>>(makeInitAgents);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [pmMsgs, setPmMsgs] = useState<ChatMessage[]>([
    { from: 'pm', text: 'Charter accepted. Building the task graph and dispatching the team.' },
  ]);
  const [spend, setSpend] = useState(0);
  const [status, setStatus] = useState<RunStatus>('running');

  const st = useRef({ idx: 0, elapsed: 0, last: Date.now(), status: 'running' as RunStatus });

  const apply = useCallback((ev: (typeof RUN_SCRIPT)[number]) => {
    switch (ev.fn) {
      case 'task':
        setTasks(ts =>
          ts.map(t => (t.id === ev.id ? { ...t, status: ev.status as Task['status'] } : t)),
        );
        break;
      case 'agent':
        setAgents(a => {
          const cur = a[ev.who] ?? BLANK;
          return {
            ...a,
            [ev.who]: {
              ...cur,
              active: true,
              step: ev.step,
              activity: [...cur.activity, { kind: 'tool' as const, text: ev.step }].slice(-200),
              activeAt: cur.activeAt ?? Date.now(),
              verdict: null,
            },
          };
        });
        break;
      case 'idle':
        setAgents(a => {
          const cur = a[ev.who] ?? BLANK;
          return {
            ...a,
            // keep activity so the finished transcript stays expandable
            [ev.who]: {
              ...cur,
              active: false,
              step: '',
              activeAt: null,
              verdict: ev.verdict as Finding['verdict'],
            },
          };
        });
        break;
      case 'finding':
        setFindings(f => [
          {
            key: ev.key,
            agent: ev.agent,
            task: ev.task,
            verdict: ev.verdict as Finding['verdict'],
            summary: ev.summary,
          },
          ...f,
        ]);
        break;
      case 'addtasks':
        setTasks(ts => [...ts, ...LATE_TASKS.map(t => ({ ...t, status: 'pending' as const }))]);
        break;
      case 'pm':
        setPmMsgs(m => [...m, { from: 'pm', text: ev.text }]);
        break;
      case 'finish':
        setStatus('done');
        st.current.status = 'done';
        setAgents(makeInitAgents);
        break;
    }
  }, []);

  useEffect(() => {
    st.current = { idx: 0, elapsed: 0, last: Date.now(), status: 'running' };
    const iv = setInterval(() => {
      const s = st.current;
      const now = Date.now();
      const dt = now - s.last;
      s.last = now;
      if (s.status === 'running') {
        s.elapsed += dt;
        while (s.idx < RUN_SCRIPT.length && RUN_SCRIPT[s.idx].at <= s.elapsed) {
          apply(RUN_SCRIPT[s.idx]);
          s.idx++;
        }
        setSpend(Math.min(SPEND_END, (s.elapsed / RUN_TOTAL) * SPEND_END));
      }
    }, 90);
    return () => clearInterval(iv);
  }, [apply]);

  const togglePause = useCallback(() => {
    setStatus(s => {
      if (s === 'done' || s === 'aborted') return s;
      const ns = s === 'running' ? 'paused' : 'running';
      st.current.status = ns;
      st.current.last = Date.now();
      return ns;
    });
  }, []);

  const abort = useCallback(() => {
    st.current.status = 'aborted';
    setStatus('aborted');
    setAgents(makeInitAgents);
  }, []);

  return {
    tasks,
    agents,
    findings,
    pmMsgs,
    spend,
    status,
    spendCap: SPEND_CAP,
    togglePause,
    abort,
    setPmMsgs,
  };
}
