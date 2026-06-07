// API-key driver — uses @anthropic-ai/sdk with a manual tool loop.
// Requires ANTHROPIC_API_KEY from console.anthropic.com.
// This is the Phase 1/2 implementation, extracted into a driver.

import Anthropic       from '@anthropic-ai/sdk';
import { getConfig }   from '../config.js';
import { runCoder }    from '../agents/coder.js';
import { runTester }   from '../agents/tester.js';
import { runSecurity } from '../agents/security.js';
import { coderFinding, testerFinding, securityFinding } from './findings.js';
import type { AgentDriver, DriverResult } from './types.js';
import type { Task, SwarmState } from '../state/types.js';

export const apiKeyDriver: AgentDriver = {
  name: 'api-key',

  async runCoder(task: Task, state: SwarmState): Promise<DriverResult> {
    const r = await runCoder(task, state);
    return {
      verdict:          'COMPLETE',
      summary:          r.summary,
      filesChanged:     r.filesChanged,
      securityFindings: [],
      findingMarkdown:  coderFinding(task, r.summary, r.filesChanged),
      costUsd:          r.costUsd,
    };
  },

  async runTester(task: Task, state: SwarmState): Promise<DriverResult> {
    const r = await runTester(task, state);
    return {
      verdict:          r.verdict,
      summary:          r.summary,
      filesChanged:     [],
      securityFindings: [],
      findingMarkdown:  r.finding,
      costUsd:          r.costUsd,
    };
  },

  async runSecurity(task: Task, state: SwarmState): Promise<DriverResult> {
    const r = await runSecurity(task, state);
    return {
      verdict:          r.verdict,
      summary:          r.summary,
      filesChanged:     [],
      securityFindings: r.findings,
      findingMarkdown:  r.finding,
      costUsd:          r.costUsd,
    };
  },
};
