import { EventEmitter } from 'node:events';
import type { SwarmEvent } from './types.js';

// In-process pub/sub. SSE clients subscribe here.
// Splitting emit from the repository keeps the bus testable independently.
// When the architecture moves to hosted (DESIGN §7), this becomes
// Postgres LISTEN/NOTIFY or Redis pub/sub behind the same interface.

class SwarmEventBus extends EventEmitter {
  emit(event: 'swarm', data: SwarmEvent): boolean {
    return super.emit('swarm', data);
  }
  on(event: 'swarm', listener: (data: SwarmEvent) => void): this {
    return super.on('swarm', listener);
  }
  off(event: 'swarm', listener: (data: SwarmEvent) => void): this {
    return super.off('swarm', listener);
  }
}

export const bus = new SwarmEventBus();
export type { SwarmEvent };
