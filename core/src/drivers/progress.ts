// Live-progress bridge for execution agents.
//
// The agent driver runs inside the `swarm new` loop, which is separate from the
// dashboard server that owns the SSE clients. State changes cross that boundary
// via state.json + the file watcher, but live "thinking" and tool-call steps are
// not state — they cross the same loopback HTTP boundary the permission proxy
// uses (POST to the server, which fans the event out to SSE clients). Emission is
// best-effort and never blocks or fails a run: if the server is down the event is
// simply dropped.

import { getConfig } from '../config.js';
import type { SwarmEvent } from '../state/types.js';
import { describeToolUse, readResultLineCount, type StreamEvent } from './stream-parse.js';

const THINKING_MAX_CHARS = 2000;

async function postEvent(event: SwarmEvent): Promise<void> {
  let port: number;
  try {
    port = getConfig().port;
  } catch {
    return; // no config — nothing to stream to
  }
  try {
    await fetch(`http://127.0.0.1:${port}/run/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* server not up / unreachable — drop the telemetry event */
  }
}

// Plumbing tools the user shouldn't see in the transcript (result submission, PM
// response capture) — these are how an agent finishes, not work worth showing.
function isInternalTool(name: string): boolean {
  return name.startsWith('mcp__result__') || name.startsWith('mcp__pm');
}

// Build an onStreamEvent sink that maps one agent's claude stream into dashboard
// events. Thinking blocks → agent.thinking. Each tool call appends an agent.tool
// entry when it starts (so the transcript updates live) and is refined with a line
// count when its result arrives. `agentId` is the task's assignee (so the file
// watcher's agent.started lines up); `taskId` keys the transcript to this run so an
// agent that runs several tasks keeps a separate transcript per task.
export function streamToProgress(agentId: string, taskId: string): (ev: StreamEvent) => void {
  const pendingTool = new Map<string, { tool: string }>();
  return ev => {
    if (ev.kind === 'thinking') {
      void postEvent({
        type: 'agent.thinking',
        agent_id: agentId,
        task_id: taskId,
        text: ev.text.slice(0, THINKING_MAX_CHARS),
      });
    } else if (ev.kind === 'tool_use') {
      if (isInternalTool(ev.name)) {
        return;
      }
      pendingTool.set(ev.id, { tool: ev.name });
      const file = typeof ev.input.file_path === 'string' ? ev.input.file_path : undefined;
      void postEvent({
        type: 'agent.tool',
        agent_id: agentId,
        task_id: taskId,
        id: ev.id,
        label: describeToolUse(ev.name, ev.input),
        tool: ev.name,
        ...(file ? { file } : {}),
      });
    } else if (ev.kind === 'tool_result') {
      const p = pendingTool.get(ev.id);
      if (!p || isInternalTool(p.tool)) {
        return;
      }
      pendingTool.delete(ev.id);
      // Refine the entry with a line count for reads; other tools need no follow-up.
      const lines = p.tool === 'Read' && !ev.isError ? readResultLineCount(ev.text) : null;
      if (lines != null) {
        void postEvent({
          type: 'agent.tool',
          agent_id: agentId,
          task_id: taskId,
          id: ev.id,
          detail: `${lines} lines`,
        });
      }
    }
  };
}
