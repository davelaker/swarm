// Shared interface for all agent drivers.
// The driver is the implementation detail — loop.ts and dispatch/index.ts
// don't care whether workers run via the Anthropic Client SDK (API key)
// or via the Claude Agent SDK (Max plan subscription).

import type { Task, SwarmState } from '../state/types.js';

export interface SecurityFinding {
  id:       string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  type:     string;
  location: string;
  fix:      string;
}

export interface DriverResult {
  verdict:          string;   // COMPLETE | PASS | FAIL | APPROVED | CHANGES_REQUESTED
  summary:          string;
  filesChanged:     string[];
  securityFindings: SecurityFinding[];
  findingMarkdown:  string;   // ready to write to disk
  costUsd?:         number;   // undefined = covered by subscription
}

export interface AgentDriver {
  name:        string;
  runCoder    (task: Task, state: SwarmState): Promise<DriverResult>;
  runTester   (task: Task, state: SwarmState): Promise<DriverResult>;
  runSecurity (task: Task, state: SwarmState): Promise<DriverResult>;
}
