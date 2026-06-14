// Live-progress bridge for execution agents.
//
// The agent driver runs inside the `swarm new` loop process, which is separate
// from the dashboard server process that owns the SSE clients. State changes
// cross that boundary via state.json + the file watcher, but live "thinking" and
// tool-call steps are not state — they cross the same loopback HTTP boundary the
// permission proxy already uses (POST to the server, which fans the event out to
// SSE clients). Emission is best-effort and never blocks or fails a run: if the
// server is down the event is simply dropped.

import { getConfig } from '../config.js';
import type { SwarmEvent } from '../state/types.js';
import { describeToolUse, type StreamEvent } from './stream-parse.js';

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

// Build an onStreamEvent sink that maps one agent's claude stream into dashboard
// events: thinking text → agent.thinking, tool calls → agent.progress steps.
// `agentId` MUST be the task's assignee so the events land on the same agent the
// file watcher started via agent.started (server diffAndEmit keys on task.assignee).
export function streamToProgress(agentId: string): (ev: StreamEvent) => void {
  return ev => {
    if (ev.kind === 'thinking') {
      void postEvent({
        type: 'agent.thinking',
        agent_id: agentId,
        text: ev.text.slice(0, THINKING_MAX_CHARS),
      });
    } else if (ev.kind === 'tool_use') {
      void postEvent({
        type: 'agent.progress',
        agent_id: agentId,
        step: describeToolUse(ev.name, ev.input),
      });
    }
  };
}
