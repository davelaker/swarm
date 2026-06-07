// Connects to the real swarm backend via GET /state (snapshot) + GET /events (SSE).
// Returns null for `state` while connecting, or if the backend is not running.
// The Running component falls back to mock mode when state is null.

import { useState, useEffect, useRef } from 'react';
import type { Task, AgentState, Finding, ChatMessage, RunStatus } from '../types';

// ─── Server-side types (from state.json) ─────────────────────────────────────

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

// ─── SSE event types (mirrors core/src/state/types.ts SwarmEvent) ─────────────

type SwarmEvent =
  | { type: 'run.classified';      tier: string; tasks: ServerTask[] }
  | { type: 'task.created';        task: ServerTask }
  | { type: 'task.status_changed'; task_id: string; status: string }
  | { type: 'agent.started';       agent_id: string }
  | { type: 'agent.progress';      agent_id: string; step: string }
  | { type: 'agent.finished';      agent_id: string }
  | { type: 'finding.written';     task_id: string; path: string }
  | { type: 'log.appended';        actor: string; event: string }
  | { type: 'run.blocked';         reason: string }
  | { type: 'run.completed' };

// ─── Adapters ─────────────────────────────────────────────────────────────────

function computeLanes(tasks: ServerTask[]): Map<string, number> {
  const lanes = new Map<string, number>();

  // Simple: roots get lane 0, each child inherits parent lane.
  // Branching siblings get offset lanes.
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

  tasks.filter(t => t.depends_on.length === 0).forEach(t => {
    assign(t.id, nextLane++);
  });
  // Catch any not yet assigned
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
    late:     prev === undefined, // newly appeared tasks animate in
  };
}

function initAgents(): Record<string, AgentState> {
  return {
    pm:         { active: false, step: '', verdict: null },
    coder:      { active: false, step: '', verdict: null },
    tester:     { active: false, step: '', verdict: null },
    security:   { active: false, step: '', verdict: null },
    negotiator: { active: false, step: '', verdict: null },
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface RealRunState {
  project:  string;
  tier:     string;
  tasks:    Task[];
  agents:   Record<string, AgentState>;
  findings: Finding[];
  pmMsgs:   ChatMessage[];
  status:   RunStatus;
  connected: boolean;
}

export function useRealRun(): RealRunState | null {
  const [state, setState] = useState<RealRunState | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let mounted = true;

    // 1. Snapshot on load
    fetch('/state')
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then((snap: ServerState) => {
        if (!mounted) return;
        const lanes = computeLanes(snap.tasks);
        const tasks = snap.tasks.map(t => adaptTask(t, lanes.get(t.id) ?? 0));
        const allDone = tasks.length > 0 && tasks.every(t => t.status === 'done');

        setState({
          project:   snap.project,
          tier:      snap.tier,
          tasks,
          agents:    initAgents(),
          findings:  [],
          pmMsgs:    [{ from: 'pm', text: `Running: ${snap.goal}` }],
          status:    allDone ? 'done' : 'running',
          connected: true,
        });
      })
      .catch(() => {
        // Backend not running — signal to caller to use mock
        if (mounted) setState(null);
      });

    // 2. SSE stream for live updates
    const es = new EventSource('/events');
    esRef.current = es;

    es.onmessage = (e: MessageEvent) => {
      if (!mounted) return;
      let ev: SwarmEvent;
      try { ev = JSON.parse(e.data); } catch { return; }

      setState(prev => {
        if (!prev) return prev;
        return applyEvent(prev, ev);
      });
    };

    es.onerror = () => {
      if (mounted) setState(prev => prev ? { ...prev, connected: false } : prev);
    };

    return () => {
      mounted = false;
      es.close();
      esRef.current = null;
    };
  }, []);

  return state;
}

// ─── Event → state ────────────────────────────────────────────────────────────

function applyEvent(prev: RealRunState, ev: SwarmEvent): RealRunState {
  switch (ev.type) {

    case 'run.classified': {
      const lanes = computeLanes(ev.tasks);
      return {
        ...prev,
        tier:  ev.tier,
        tasks: ev.tasks.map(t => adaptTask(t, lanes.get(t.id) ?? 0)),
      };
    }

    case 'task.created': {
      const lanes = computeLanes([...prev.tasks.map(t => ({
        id: t.id, title: t.title, assignee: t.assignee,
        depends_on: t.deps, status: t.status, result_ref: null, attempts: 0,
      })), ev.task]);
      const newTask = adaptTask(ev.task, lanes.get(ev.task.id) ?? 0);
      return { ...prev, tasks: [...prev.tasks, newTask] };
    }

    case 'task.status_changed':
      return {
        ...prev,
        tasks:  prev.tasks.map(t =>
          t.id === ev.task_id ? { ...t, status: ev.status as Task['status'] } : t
        ),
        status: ev.status === 'done' && prev.tasks.every(t =>
          t.id === ev.task_id ? true : t.status === 'done'
        ) ? 'done' : prev.status,
      };

    case 'agent.started':
      return {
        ...prev,
        agents: {
          ...prev.agents,
          [ev.agent_id]: { active: true, step: 'working…', verdict: null },
        },
      };

    case 'agent.progress':
      return {
        ...prev,
        agents: {
          ...prev.agents,
          [ev.agent_id]: { ...prev.agents[ev.agent_id], active: true, step: ev.step },
        },
      };

    case 'agent.finished':
      return {
        ...prev,
        agents: {
          ...prev.agents,
          [ev.agent_id]: { ...prev.agents[ev.agent_id], active: false, step: '' },
        },
      };

    case 'finding.written': {
      // We don't have the finding content here — show a placeholder.
      // The UI will show which task it belongs to.
      const alreadyHas = prev.findings.some(f => f.task === ev.task_id);
      if (alreadyHas) return prev;
      const task = prev.tasks.find(t => t.id === ev.task_id);
      const verdict = task?.status === 'done' ? 'pass'
                    : task?.status === 'changes_requested' ? 'changes'
                    : 'complete';
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
      if (ev.actor === 'pm') {
        return {
          ...prev,
          pmMsgs: [...prev.pmMsgs, { from: 'pm', text: ev.event }],
        };
      }
      return prev;

    case 'run.completed':
      return { ...prev, status: 'done' };

    case 'run.blocked':
      return {
        ...prev,
        status:  'running',
        pmMsgs: [...prev.pmMsgs, { from: 'pm', text: `Blocked: ${ev.reason}` }],
      };

    default:
      return prev;
  }
}
