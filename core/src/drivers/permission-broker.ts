// In-process permission broker.
// Both the api-key driver (direct calls) and the agent-sdk permission proxy
// MCP server (via HTTP) funnel through this module.
//
// Flow:
//   1. requestPermission() stores a pending resolver and emits an SSE event
//   2. The UI shows an approval dialog
//   3. POST /run/permission/:requestId calls resolvePermission()
//   4. The promise resolves and the caller proceeds or rejects the operation

import { randomUUID } from 'node:crypto';
import { bus } from '../state/events.js';

interface PendingRequest {
  agentId: string;
  tool: string;
  input: Record<string, unknown>;
  resolve: (decision: 'allow' | 'deny') => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRequest>();

// Auto-deny after 10 minutes so a forgotten dialog doesn't stall a run forever.
const TIMEOUT_MS = 10 * 60 * 1_000;

export function requestPermission(
  agentId: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<'allow' | 'deny'> {
  return new Promise(resolve => {
    const requestId = randomUUID();

    const timeoutId = setTimeout(() => {
      if (!pending.has(requestId)) return;
      pending.delete(requestId);
      bus.emit('swarm', {
        type: 'agent.permission_resolved',
        request_id: requestId,
        decision: 'deny',
      });
      resolve('deny');
    }, TIMEOUT_MS);

    pending.set(requestId, { agentId, tool, input, resolve, timeoutId });

    bus.emit('swarm', {
      type: 'agent.permission_request',
      request_id: requestId,
      agent_id: agentId,
      tool,
      input,
    });
  });
}

export function resolvePermission(requestId: string, decision: 'allow' | 'deny'): boolean {
  const req = pending.get(requestId);
  if (!req) return false;
  clearTimeout(req.timeoutId);
  pending.delete(requestId);
  bus.emit('swarm', { type: 'agent.permission_resolved', request_id: requestId, decision });
  req.resolve(decision);
  return true;
}

export function hasPendingPermission(requestId: string): boolean {
  return pending.has(requestId);
}
