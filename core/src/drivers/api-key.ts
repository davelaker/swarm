// API-key driver — uses @anthropic-ai/sdk with a manual tool loop.
// Requires ANTHROPIC_API_KEY from console.anthropic.com.

import { getConfig }   from '../config.js';
import { runCoder }    from '../agents/coder.js';
import { runTester }   from '../agents/tester.js';
import { runSecurity } from '../agents/security.js';
import { runReviewer } from '../agents/reviewer.js';
import { coderFinding, testerFinding, securityFinding, reviewerFinding } from './findings.js';
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
      reviewerFindings: [],
      findingMarkdown:  coderFinding(task, r.summary, r.filesChanged),
      costUsd:          r.costUsd,
      inputTokens:      r.inputTokens,
      outputTokens:     r.outputTokens,
    };
  },

  async runTester(task: Task, state: SwarmState): Promise<DriverResult> {
    const r = await runTester(task, state);
    return {
      verdict:          r.verdict,
      summary:          r.summary,
      filesChanged:     [],
      securityFindings: [],
      reviewerFindings: [],
      findingMarkdown:  r.finding,
      costUsd:          r.costUsd,
      inputTokens:      r.inputTokens,
      outputTokens:     r.outputTokens,
    };
  },

  async runSecurity(task: Task, state: SwarmState): Promise<DriverResult> {
    const r = await runSecurity(task, state);
    return {
      verdict:          r.verdict,
      summary:          r.summary,
      filesChanged:     [],
      securityFindings: r.findings,
      reviewerFindings: [],
      findingMarkdown:  r.finding,
      costUsd:          r.costUsd,
      inputTokens:      r.inputTokens,
      outputTokens:     r.outputTokens,
    };
  },

  async runReviewer(task: Task, state: SwarmState): Promise<DriverResult> {
    const r = await runReviewer(task, state);
    return {
      verdict:          r.verdict,
      summary:          r.summary,
      filesChanged:     [],
      securityFindings: [],
      reviewerFindings: r.findings,
      findingMarkdown:  r.finding,
      costUsd:          r.costUsd,
      inputTokens:      r.inputTokens,
      outputTokens:     r.outputTokens,
    };
  },
};
