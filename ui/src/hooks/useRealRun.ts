// Connects to the real swarm backend via GET /state (snapshot) + GET /events (SSE).

import { useState, useEffect, useRef } from 'react';
import type { Task, AgentState, Finding, ChatMessage, RunStatus } from '../types';

interface ServerTask {
  id:         string;
  title:      string;
  status:     string;
  assignee:   string;
  depends_on: string[];
  result_ref: string | null;
  attempts:   number;
}

interface ServerState {
  project:    string;
  goal:       string;
  tier:       string;
  updated_at: string;
  tasks:      ServerTask[];
  log:        Array<{ ts: string; actor: string; event: string }>;
}

type SwarmEvent =
  | { type: 'run.classified';    tier: string; tasks: ServerTask[] }
  | { type: 'task.created';      task: ServerTask }
  | { type: 'task.status_changed'; task_id: string; status: string }
  | { type: 'agent.started';     agent_id: string }
  | { type: 'agent.progress';    agent_id: string; step: string }
  | { type: 'agent.finished';    agent_id: string }
  | { type: 'finding.written';   task_id: string; path: string }
  | { type: 'log.appended';      actor: string; event: string }
  | { type: 'run.blocked';       reason: string }
  | { type: 'run.completed' }
  | { type: 'run.cost_updated';  spent: number; cap: number }
  | { type: 'run.paused' }
  | { type: 'run.aborted' }
  | { type: 'task.metrics'; task_id: string; agent_id: string; input_tokens: number | null; output_tokens: number | null; cost_usd: number; context_pct: number | null };

function computeLanes(tasks: ServerTask[]): Map<string, number> {
  const lanes = new Map<string, number>();
  const childCountOf = new Map<string, number>();
  tasks.forEach(t => t.depends_on.forEach(dep => {
    childCountOf.set(dep, (childCountOf.get(dep) ?? 0) + 1);
  }));
  let nextLane = 0;
  const assign = (id: string, lane: number) => {
    if (lanes.has(id)) return;
    lanes.set(id, lane);
    const children = tasks.filter(t => t.depends_on.includes(id));
    children.forEach((child, i) => assign(child.id, lane + i));
  };
  tasks.filter(t => t.depends_on.length === 0).forEach(t => { assign(t.id, nextLane++); });
  tasks.forEach(t => { if (!lanes.has(t.id)) lanes.set(t.id, 0); });
  return lanes;
}

function adaptTask(t: ServerTask, lane: number, prev?: Task): Task {
  return {
    id:       t.id,
    title:    t.title,
    assignee: t.assignee as Task['assignee'],
    deps:     t.depends_on,
    lane,
    status:   t.status as Task['status'],
    late:     prev === undefined,
  };
}

const BLANK_METRICS = { inputTokens: null, outputTokens: null, costUsd: null, contextPct: null };

function initAgents(): Record<string, AgentState> {
  const blank = { active: false, step: '', verdict: null, ...BLANK_METRICS };
  return {
    pm:         { ...blank },
    coder:      { ...blank },
    tester:     { ...blank },
    security:   { ...blank },
    reviewer:   { ...blank },
    negotiator: { ...blank },
  };
}

export interface RealRunState {
  project:   string;
  tier:      string;
  tasks:     Task[];
  agents:    Record<string, AgentState>;
  findings:  Finding[];
  pmMsgs:    ChatMessage[];
  status:    RunStatus;
  connected: boolean;
  spend:     number;
  spendCap:  number;
}

export type ServerStatus = 'probing' | 'down' | 'up';

export function useRealRun(): { serverStatus: ServerStatus; state: RealRunState | null } {
  const [serverStatus, setServerStatus] = useState<ServerStatus>('probing');
  const [state, setState]               = useState<RealRunState | null>(null);
  const esRef    = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = (mounted: { current: boolean }) => {
    fetch('/state', { signal: AbortSignal.timeout(2000) })
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then((snap: ServerState) => {
        if (!mounted.current) return;
        const lanes   = computeLanes(snap.tasks);
        const tasks   = snap.tasks.map(t => adaptTask(t, lanes.get(t.id) ?? 0));
        const allDone = tasks.length > 0 && tasks.every(t => t.status === 'done');

        setServerStatus('up');
        setState({
          project:  snap.project,
          tier:     snap.tier,
          tasks,
          agents:   initAgents(),
          findings: [],
          pmMsgs:   snap.goal ? [{ from: 'pm', text: `Goal: ${snap.goal}` }] : [],
          status:   allDone ? 'done' : 'running',
          connected: true,
          spend:    0,
          spendCap: 2,  // default; overridden by run.cost_updated events
        });
      })
      .catch(() => {
        if (!mounted.current) return;
        setServerStatus('down');
        retryRef.current = setTimeout(() => connect(mounted), 3000);
      });

    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    const es = new EventSource('/events');
    esRef.current = es;

    es.onmessage = (e: MessageEvent) => {
      if (!mounted.current) return;
      let ev: SwarmEvent;
      try { ev = JSON.parse(e.data); } catch { return; }
      setState(prev => prev ? applyEvent(prev, ev) : prev);
    };

    es.onerror = () => {
      if (!mounted.current) return;
      setState(prev => prev ? { ...prev, connected: false } : prev);
      setServerStatus('down');
      es.close(); esRef.current = null;
      retryRef.current = setTimeout(() => connect(mounted), 3000);
    };
  };

  useEffect(() => {
    const mounted = { current: true };
    connect(mounted);
    return () => {
      mounted.current = false;
      esRef.current?.close();
      esRef.current = null;
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, []);

  return { serverStatus, state };
}

function applyEvent(prev: RealRunState, ev: SwarmEvent): RealRunState {
  switch (ev.type) {

    case 'run.classified': {
      const lanes = computeLanes(ev.tasks);
      return { ...prev, tier: ev.tier, tasks: ev.tasks.map(t => adaptTask(t, lanes.get(t.id) ?? 0)) };
    }

    case 'task.created': {
      const lanes = computeLanes([...prev.tasks.map(t => ({
        id: t.id, title: t.title, assignee: t.assignee,
        depends_on: t.deps, status: t.status, result_ref: null, attempts: 0,
      })), ev.task]);
      return { ...prev, tasks: [...prev.tasks, adaptTask(ev.task, lanes.get(ev.task.id) ?? 0)] };
    }

    case 'task.status_changed':
      return {
        ...prev,
        tasks: prev.tasks.map(t => t.id === ev.task_id ? { ...t, status: ev.status as Task['status'] } : t),
        status: ev.status === 'done' && prev.tasks.every(t =>
          t.id === ev.task_id ? true : t.status === 'done'
        ) ? 'done' : prev.status,
      };

    case 'agent.started':
      return { ...prev, agents: { ...prev.agents, [ev.agent_id]: { active: true, step: 'working…', verdict: null } } };

    case 'agent.progress':
      return { ...prev, agents: { ...prev.agents, [ev.agent_id]: { ...prev.agents[ev.agent_id], active: true, step: ev.step } } };

    case 'agent.finished':
      return { ...prev, agents: { ...prev.agents, [ev.agent_id]: { ...prev.agents[ev.agent_id], active: false, step: '' } } };

    case 'finding.written': {
      if (prev.findings.some(f => f.task === ev.task_id)) return prev;
      const task    = prev.tasks.find(t => t.id === ev.task_id);
      const verdict = task?.status === 'done' ? 'pass' : task?.status === 'changes_requested' ? 'changes' : 'complete';
      return {
        ...prev,
        findings: [{
          key:     `${ev.task_id}-finding`,
          agent:   task?.assignee ?? 'pm',
          task:    ev.task_id,
          verdict: verdict as Finding['verdict'],
          summary: `Finding written — ${ev.path}`,
        }, ...prev.findings],
      };
    }

    case 'log.appended':
      return ev.actor === 'pm'
        ? { ...prev, pmMsgs: [...prev.pmMsgs, { from: 'pm', text: ev.event }] }
        : prev;

    case 'run.completed':
      return { ...prev, status: 'done' };

    case 'run.blocked':
      return { ...prev, status: 'running', pmMsgs: [...prev.pmMsgs, { from: 'pm', text: `Blocked: ${ev.reason}` }] };

    case 'task.metrics':
      return {
        ...prev,
        agents: {
          ...prev.agents,
          [ev.agent_id]: {
            ...prev.agents[ev.agent_id],
            inputTokens:  ev.input_tokens,
            outputTokens: ev.output_tokens,
            costUsd:      ev.cost_usd,
            contextPct:   ev.context_pct,
          },
        },
      };

    case 'run.cost_updated':
      return { ...prev, spend: ev.spent, spendCap: ev.cap };

    case 'run.paused':
      return { ...prev, status: 'paused' };

    case 'run.aborted':
      return { ...prev, status: 'aborted' };

    default:
      return prev;
  }
}
