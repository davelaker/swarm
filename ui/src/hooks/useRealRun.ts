// Connects to the real swarm backend via GET /state (snapshot) + GET /events (SSE).

import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  Task,
  AgentState,
  Finding,
  ChatMessage,
  RunStatus,
  PermissionRequest,
} from '../types';

interface ServerTask {
  id: string;
  title: string;
  status: string;
  assignee: string;
  depends_on: string[];
  result_ref: string | null;
  attempts: number;
  finding_verdict?: string; // enriched by server from finding frontmatter
  finding_summary?: string;
  skip_reason?: string;
}

interface ServerState {
  project: string;
  goal: string;
  tier: string;
  updated_at: string;
  tasks: ServerTask[];
  log: Array<{ ts: string; actor: string; event: string }>;
  branchName?: string;
}

type SwarmEvent =
  | { type: 'run.classified'; tier: string; tasks: ServerTask[] }
  | { type: 'task.created'; task: ServerTask }
  | { type: 'task.status_changed'; task_id: string; status: string; skip_reason?: string }
  | { type: 'agent.started'; agent_id: string }
  | { type: 'agent.progress'; agent_id: string; step: string }
  | { type: 'agent.thinking'; agent_id: string; text: string }
  | {
      type: 'agent.tool';
      agent_id: string;
      id: string;
      label?: string;
      tool?: string;
      file?: string;
      detail?: string;
    }
  | { type: 'agent.finished'; agent_id: string }
  | { type: 'finding.written'; task_id: string; path: string; verdict?: string; summary?: string }
  | { type: 'log.appended'; actor: string; event: string }
  | { type: 'run.blocked'; reason: string }
  | { type: 'run.completed' }
  | { type: 'run.cost_updated'; spent: number; cap: number }
  | { type: 'run.paused' }
  | { type: 'run.aborted' }
  | {
      type: 'task.metrics';
      task_id: string;
      agent_id: string;
      input_tokens: number | null;
      output_tokens: number | null;
      cost_usd: number;
      context_pct: number | null;
    }
  | {
      type: 'agent.permission_request';
      request_id: string;
      agent_id: string;
      tool: string;
      input: Record<string, unknown>;
    }
  | { type: 'agent.permission_resolved'; request_id: string; decision: 'allow' | 'deny' };

function computeLanes(tasks: ServerTask[]): Map<string, number> {
  const lanes = new Map<string, number>();
  const childCountOf = new Map<string, number>();
  tasks.forEach(t =>
    t.depends_on.forEach(dep => {
      childCountOf.set(dep, (childCountOf.get(dep) ?? 0) + 1);
    }),
  );
  let nextLane = 0;
  const assign = (id: string, lane: number) => {
    if (lanes.has(id)) return;
    lanes.set(id, lane);
    const children = tasks.filter(t => t.depends_on.includes(id));
    children.forEach((child, i) => {
      // Fix / re-check tasks spawned by a blocked review get a +1 lane offset
      // so their connecting bezier curves outward, making the causal chain visible.
      const isFollowOn = /^t_(fix|chk)_/.test(child.id);
      assign(child.id, isFollowOn ? lane + 1 : lane + i);
    });
  };
  tasks
    .filter(t => t.depends_on.length === 0)
    .forEach(t => {
      assign(t.id, nextLane++);
    });
  tasks.forEach(t => {
    if (!lanes.has(t.id)) lanes.set(t.id, 0);
  });
  return lanes;
}

function adaptTask(t: ServerTask, lane: number, prev?: Task): Task {
  return {
    id: t.id,
    title: t.title,
    assignee: t.assignee as Task['assignee'],
    deps: t.depends_on,
    lane,
    status: t.status as Task['status'],
    late: prev === undefined,
    ...(t.skip_reason ? { skip_reason: t.skip_reason } : {}),
  };
}

const BLANK_METRICS = { inputTokens: null, outputTokens: null, costUsd: null, contextPct: null };
const ACTIVITY_CAP = 200; // bound the transcript so a long run can't grow state unbounded
const BLANK_AGENT: AgentState = {
  active: false,
  step: '',
  activity: [],
  activeAt: null,
  verdict: null,
  ...BLANK_METRICS,
};

function initAgents(): Record<string, AgentState> {
  const blank = {
    active: false,
    step: '',
    activity: [],
    activeAt: null,
    verdict: null,
    ...BLANK_METRICS,
  };
  return {
    pm: { ...blank },
    coder: { ...blank },
    tester: { ...blank },
    security: { ...blank },
    reviewer: { ...blank },
    negotiator: { ...blank },
  };
}

export interface RealRunState {
  project: string;
  tier: string;
  tasks: Task[];
  agents: Record<string, AgentState>;
  findings: Finding[];
  pmMsgs: ChatMessage[];
  status: RunStatus;
  connected: boolean;
  spend: number;
  spendCap: number;
  pushed: boolean;
  branchName?: string;
  elapsedMs: number | null;
  pendingPermission: PermissionRequest | null; // non-null when an agent awaits user approval
}

export type ServerStatus = 'probing' | 'down' | 'up';

export function useRealRun(): {
  serverStatus: ServerStatus;
  state: RealRunState | null;
  resolvePermission: (requestId: string, decision: 'allow' | 'deny') => void;
} {
  const [serverStatus, setServerStatus] = useState<ServerStatus>('probing');
  const [state, setState] = useState<RealRunState | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0); // tracks consecutive failures for backoff
  const startedAtRef = useRef<number | null>(null); // wall-clock when first agent started

  // Progressive back-off: 1 s → 1.5 s → 2.25 s … capped at 8 s.
  // Resets to 0 every time a connection succeeds.
  const scheduleRetry = (mounted: { current: boolean }) => {
    const delay = Math.min(1000 * Math.pow(1.5, retryCount.current), 8000);
    retryCount.current += 1;
    retryRef.current = setTimeout(() => connect(mounted), delay);
  };

  const connect = (mounted: { current: boolean }) => {
    fetch('/state', { signal: AbortSignal.timeout(2000) })
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((snap: ServerState) => {
        if (!mounted.current) return;
        const lanes = computeLanes(snap.tasks);
        const tasks = snap.tasks.map(t => adaptTask(t, lanes.get(t.id) ?? 0));
        // 'blocked' and 'failed' are terminal — a blocked task won't change again;
        // follow-on fix/re-review tasks are separate entries that have their own status.
        const isTerminal = (s: string) => s === 'done' || s === 'blocked' || s === 'failed';
        const allDone = tasks.length > 0 && tasks.every(t => isTerminal(t.status));

        // Populate findings from snapshot so they survive refresh / reconnect.
        const verdictMap: Record<string, Finding['verdict']> = {
          COMPLETE: 'complete',
          PASS: 'pass',
          APPROVED: 'pass',
          FAILED: 'fail',
          FAIL: 'fail',
          CHANGES_REQUESTED: 'changes',
        };
        const findings: Finding[] = snap.tasks
          .filter(t => t.result_ref)
          .map(t => {
            const rawVerdict = (t.finding_verdict ?? '').toUpperCase();
            const verdict: Finding['verdict'] = verdictMap[rawVerdict] ?? 'complete';
            return {
              key: `${t.id}-finding`,
              agent: t.assignee,
              task: t.id,
              verdict,
              summary: t.finding_summary ?? t.result_ref!,
              path: t.result_ref!,
            };
          })
          .reverse(); // newest first, matching the SSE prepend order

        // Pre-populate agent verdicts from snapshot findings so chips show on reload.
        const agents = initAgents();
        snap.tasks
          .filter(t => t.result_ref && t.finding_verdict)
          .forEach(t => {
            const rawVerdict = (t.finding_verdict ?? '').toUpperCase();
            const v: Finding['verdict'] = verdictMap[rawVerdict] ?? 'complete';
            if (agents[t.assignee]) agents[t.assignee] = { ...agents[t.assignee], verdict: v };
          });
        // Mark agents whose tasks are currently in_progress as active so the
        // agents panel stays consistent with the task graph on mount / reconnect.
        snap.tasks
          .filter(t => t.status === 'in_progress')
          .forEach(t => {
            // Specialist (marketplace) agents aren't in initAgents() — create the entry
            // so they show as active rather than falling through to a blank idle row.
            const cur = agents[t.assignee] ?? BLANK_AGENT;
            agents[t.assignee] = { ...cur, active: true, step: 'working…', activeAt: Date.now() };
          });

        // Reconstruct PM chat history from the persisted log (actor 'pm' | 'user').
        // The goal line is always the first message; log entries follow in order.
        const logMsgs: Array<{ from: 'pm' | 'you'; text: string }> = snap.log
          .filter(e => e.actor === 'pm' || e.actor === 'user')
          .map(e => ({
            from: e.actor === 'pm' ? ('pm' as const) : ('you' as const),
            text: e.event,
          }));
        const pmMsgs = [
          ...(snap.goal ? [{ from: 'pm' as const, text: `Goal: ${snap.goal}` }] : []),
          ...logMsgs,
        ];

        // Detect a prior successful push from the persisted log so the Push
        // button stays disabled after a page refresh.
        const pushed = snap.log.some(
          e => e.actor === 'pm' && e.event.includes('Pushed to remote successfully'),
        );

        // Compute elapsed wall-clock from log timestamps (ISO 8601).
        // Only meaningful when the run is done — while in progress this stays null.
        const logTs = snap.log.map(e => new Date(e.ts).getTime()).filter(t => !isNaN(t));
        const elapsedMs = allDone && logTs.length >= 2 ? logTs[logTs.length - 1] - logTs[0] : null;

        retryCount.current = 0; // successful connect — reset back-off
        setServerStatus('up');
        setState({
          project: snap.project,
          tier: snap.tier,
          tasks,
          agents,
          findings,
          pmMsgs,
          status: allDone ? 'done' : 'running',
          connected: true,
          spend: 0,
          spendCap: 2,
          pushed,
          branchName: snap.branchName,
          elapsedMs,
          pendingPermission: null,
        });
      })
      .catch(() => {
        if (!mounted.current) return;
        setServerStatus('down');
        scheduleRetry(mounted);
      });

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    const es = new EventSource('/events');
    esRef.current = es;

    es.onmessage = (e: MessageEvent) => {
      if (!mounted.current) return;
      let ev: SwarmEvent;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      // New run: reset wall-clock so elapsed timer starts fresh.
      if (ev.type === 'run.classified') startedAtRef.current = null;
      // Track wall-clock start on first agent activity.
      if (ev.type === 'agent.started' && !startedAtRef.current) {
        startedAtRef.current = Date.now();
      }
      setState(prev => {
        if (!prev) return prev;
        const next = applyEvent(prev, ev);
        // Stamp elapsed time when the run completes (live, not via reload).
        if (ev.type === 'run.completed' && startedAtRef.current && next.elapsedMs === null) {
          return { ...next, elapsedMs: Date.now() - startedAtRef.current };
        }
        return next;
      });
    };

    es.onerror = () => {
      if (!mounted.current) return;
      setState(prev => (prev ? { ...prev, connected: false } : prev));
      setServerStatus('down');
      es.close();
      esRef.current = null;
      scheduleRetry(mounted);
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

  const resolvePermission = useCallback((requestId: string, decision: 'allow' | 'deny') => {
    fetch(`/run/permission/${requestId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    }).catch(() => {
      /* non-fatal — server will auto-deny on timeout */
    });
    // Optimistically clear the pending dialog immediately so the UI feels snappy.
    setState(prev => (prev ? { ...prev, pendingPermission: null } : prev));
  }, []);

  return { serverStatus, state, resolvePermission };
}

function applyEvent(prev: RealRunState, ev: SwarmEvent): RealRunState {
  switch (ev.type) {
    case 'run.classified': {
      const lanes = computeLanes(ev.tasks);
      // New run starting — wipe all stale data from the previous run.
      return {
        ...prev,
        tier: ev.tier,
        tasks: ev.tasks.map(t => adaptTask(t, lanes.get(t.id) ?? 0)),
        findings: [],
        pmMsgs: [],
        agents: initAgents(),
        spend: 0,
        pushed: false,
        branchName: undefined,
        elapsedMs: null,
        pendingPermission: null,
        status: 'running',
      };
    }

    case 'task.created': {
      // Guard: both the in-process bus (repo.ts addTask) AND the file watcher
      // (diffAndEmit) emit task.created for the same task, so deduplicate here.
      if (prev.tasks.some(t => t.id === ev.task.id)) return prev;
      const lanes = computeLanes([
        ...prev.tasks.map(t => ({
          id: t.id,
          title: t.title,
          assignee: t.assignee,
          depends_on: t.deps,
          status: t.status,
          result_ref: null,
          attempts: 0,
        })),
        ev.task,
      ]);
      return { ...prev, tasks: [...prev.tasks, adaptTask(ev.task, lanes.get(ev.task.id) ?? 0)] };
    }

    case 'task.status_changed': {
      const changedTask = prev.tasks.find(t => t.id === ev.task_id);
      const agentId = changedTask?.assignee;
      const isTerminal =
        ev.status === 'done' ||
        ev.status === 'blocked' ||
        ev.status === 'failed' ||
        ev.status === 'skipped';

      // Mirror the task graph state onto the agents panel immediately:
      // - in_progress → mark active (don't wait for agent.started which can lag)
      // - any terminal state → clear active so cursor stops blinking
      // Marketplace agents (e.g. "db") aren't seeded by initAgents(), so fall back to
      // BLANK_AGENT — otherwise an in_progress specialist task never marks its agent
      // active and the panel shows "idle" while the task graph shows RUNNING.
      let agents = prev.agents;
      if (isTerminal && agentId) {
        agents = {
          ...prev.agents,
          [agentId]: {
            ...(prev.agents[agentId] ?? BLANK_AGENT),
            active: false,
            step: '',
            activeAt: null,
          },
        };
      } else if (ev.status === 'in_progress' && agentId) {
        const cur = prev.agents[agentId];
        if (!cur || !cur.active) {
          agents = {
            ...prev.agents,
            [agentId]: {
              ...(cur ?? BLANK_AGENT),
              active: true,
              step: 'working…',
              activeAt: Date.now(),
            },
          };
        }
      }

      const allTerminal = (s: string) =>
        s === 'done' || s === 'skipped' || s === 'blocked' || s === 'failed';
      return {
        ...prev,
        tasks: prev.tasks.map(t =>
          t.id === ev.task_id
            ? {
                ...t,
                status: ev.status as Task['status'],
                ...(ev.skip_reason ? { skip_reason: ev.skip_reason } : {}),
              }
            : t,
        ),
        agents,
        // Run is done when every task (including the one just updated) is terminal.
        // run.completed SSE is the canonical signal; this is a belt-and-suspenders
        // fast path so the UI transitions without waiting for the next file-watcher tick.
        status: prev.tasks.every(t =>
          t.id === ev.task_id ? allTerminal(ev.status) : allTerminal(t.status),
        )
          ? 'done'
          : prev.status,
      };
    }

    case 'agent.started':
      return {
        ...prev,
        agents: {
          ...prev.agents,
          [ev.agent_id]: {
            ...(prev.agents[ev.agent_id] ?? BLANK_AGENT),
            active: true,
            step: 'working…',
            activity: [], // fresh transcript for this run
            activeAt: Date.now(),
            verdict: null,
          },
        },
      };

    case 'agent.progress': {
      // Live one-liner for the current action; the transcript entries come from
      // agent.tool, so this only updates the step shown next to the agent name.
      const cur = prev.agents[ev.agent_id] ?? BLANK_AGENT;
      return {
        ...prev,
        agents: {
          ...prev.agents,
          [ev.agent_id]: {
            ...cur,
            active: true,
            step: ev.step,
            activeAt: cur.activeAt ?? Date.now(),
          },
        },
      };
    }

    case 'agent.tool': {
      const cur = prev.agents[ev.agent_id] ?? BLANK_AGENT;
      const idx = ev.id ? cur.activity.findIndex(e => e.kind === 'tool' && e.id === ev.id) : -1;
      let activity = cur.activity;
      let step = cur.step;
      if (idx >= 0) {
        // Refine an existing entry (e.g. add the line count once the result lands).
        activity = cur.activity.map((e, i) =>
          i === idx
            ? {
                ...e,
                ...(ev.detail ? { detail: ev.detail } : {}),
                ...(ev.file ? { file: ev.file } : {}),
                ...(ev.tool ? { tool: ev.tool } : {}),
              }
            : e,
        );
      } else {
        activity = [
          ...cur.activity,
          {
            kind: 'tool' as const,
            text: ev.label ?? '',
            id: ev.id,
            tool: ev.tool,
            file: ev.file,
            detail: ev.detail,
          },
        ].slice(-ACTIVITY_CAP);
        if (ev.label) {
          step = ev.label;
        }
      }
      return {
        ...prev,
        agents: {
          ...prev.agents,
          [ev.agent_id]: {
            ...cur,
            active: true,
            step,
            activity,
            activeAt: cur.activeAt ?? Date.now(),
          },
        },
      };
    }

    case 'agent.thinking': {
      const cur = prev.agents[ev.agent_id] ?? BLANK_AGENT;
      return {
        ...prev,
        agents: {
          ...prev.agents,
          [ev.agent_id]: {
            ...cur,
            active: true,
            activity: [...cur.activity, { kind: 'thinking' as const, text: ev.text }].slice(
              -ACTIVITY_CAP,
            ),
            activeAt: cur.activeAt ?? Date.now(),
          },
        },
      };
    }

    case 'agent.finished':
      return {
        ...prev,
        agents: {
          ...prev.agents,
          [ev.agent_id]: {
            // keep activity so the finished transcript stays expandable
            ...(prev.agents[ev.agent_id] ?? BLANK_AGENT),
            active: false,
            step: '',
            activeAt: null,
          },
        },
      };

    case 'finding.written': {
      const task = prev.tasks.find(t => t.id === ev.task_id);
      // Map server verdict strings to UI Verdict type
      const verdictMap: Record<string, Finding['verdict']> = {
        COMPLETE: 'complete',
        PASS: 'pass',
        APPROVED: 'pass',
        FAILED: 'fail',
        FAIL: 'fail',
        CHANGES_REQUESTED: 'changes',
      };
      const rawVerdict = (ev.verdict ?? '').toUpperCase();
      const hasVerdict = !!verdictMap[rawVerdict]; // event carried an explicit, known verdict
      const verdict: Finding['verdict'] = verdictMap[rawVerdict] ?? 'complete';

      // Also stamp the verdict onto the agent row so the chip shows when idle.
      const agentId = task?.assignee;
      const agents =
        agentId && prev.agents[agentId]
          ? { ...prev.agents, [agentId]: { ...prev.agents[agentId], verdict } }
          : prev.agents;

      // Finding already known: don't re-prepend, but DO let a later explicit verdict
      // correct an earlier verdict-less (defaulted) event — the original cause of
      // "COMPLETE chip on a CHANGES_REQUESTED finding".
      const existing = prev.findings.find(f => f.task === ev.task_id);
      if (existing) {
        if (!hasVerdict || verdict === existing.verdict) return prev;
        return {
          ...prev,
          agents,
          findings: prev.findings.map(f =>
            f.task === ev.task_id
              ? { ...f, verdict, summary: ev.summary ?? f.summary, path: ev.path ?? f.path }
              : f,
          ),
        };
      }

      return {
        ...prev,
        agents,
        findings: [
          {
            key: `${ev.task_id}-finding`,
            agent: task?.assignee ?? 'pm',
            task: ev.task_id,
            verdict,
            summary: ev.summary ?? ev.path,
            path: ev.path,
            ts: Date.now(),
          },
          ...prev.findings,
        ],
      };
    }

    case 'log.appended':
      if (ev.actor === 'pm')
        return { ...prev, pmMsgs: [...prev.pmMsgs, { from: 'pm', text: ev.event }] };
      if (ev.actor === 'user')
        return { ...prev, pmMsgs: [...prev.pmMsgs, { from: 'you', text: ev.event }] };
      return prev;

    case 'run.completed':
      return { ...prev, status: 'done' };

    case 'run.blocked': {
      // Enrich the "blocked" message with task context so the PM chat is useful.
      // ev.reason is either a task ID (e.g. "t3") or a free-form error string.
      const blockedTask = prev.tasks.find(t => t.id === ev.reason);
      const msg = blockedTask
        ? `⚑ ${blockedTask.assignee} [${blockedTask.id}] flagged issues — "${blockedTask.title}". Check Findings for details.`
        : `⚑ Run blocked: ${ev.reason}`;
      return { ...prev, status: 'running', pmMsgs: [...prev.pmMsgs, { from: 'pm', text: msg }] };
    }

    case 'task.metrics':
      return {
        ...prev,
        agents: {
          ...prev.agents,
          [ev.agent_id]: {
            ...prev.agents[ev.agent_id],
            inputTokens: ev.input_tokens,
            outputTokens: ev.output_tokens,
            costUsd: ev.cost_usd,
            contextPct: ev.context_pct,
          },
        },
      };

    case 'run.cost_updated':
      return { ...prev, spend: ev.spent, spendCap: ev.cap };

    case 'run.paused':
      return { ...prev, status: 'paused' };

    case 'run.aborted':
      return { ...prev, status: 'aborted' };

    case 'agent.permission_request':
      return {
        ...prev,
        pendingPermission: {
          requestId: ev.request_id,
          agentId: ev.agent_id,
          tool: ev.tool,
          input: ev.input,
        },
      };

    case 'agent.permission_resolved':
      // Clear the dialog if it's for the request currently shown.
      return prev.pendingPermission?.requestId === ev.request_id
        ? { ...prev, pendingPermission: null }
        : prev;

    default:
      return prev;
  }
}
