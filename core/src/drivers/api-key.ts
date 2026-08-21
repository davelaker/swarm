// API-key driver — uses @anthropic-ai/sdk with a manual tool loop.
// Requires ANTHROPIC_API_KEY from console.anthropic.com.

import { getConfig } from '../config.js';
import Anthropic from '@anthropic-ai/sdk';
import { runCoder } from '../agents/coder.js';
import { runTester } from '../agents/tester.js';
import { runSecurity } from '../agents/security.js';
import { runReviewer } from '../agents/reviewer.js';
import { runMarketplaceAgent as runMktAgent } from '../agents/marketplace.js';
import { coderFinding, testerFinding, securityFinding, reviewerFinding } from './findings.js';
import type {
  AgentDriver,
  DriverResult,
  NegotiatorDecision,
  DeadlockContext,
  ScoutResult,
  DocsScribeContext,
  DocsScribeResult,
  ScribeContext,
  ScribeResult,
  PmInferenceRequest,
  PmInferenceResult,
} from './types.js';
import type { Task, SwarmState, RosterEntry } from '../state/types.js';

async function runPmViaAnthropic(request: PmInferenceRequest): Promise<PmInferenceResult> {
  const client = new Anthropic({ apiKey: getConfig().anthropicApiKey });
  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 16_000,
    system: [{ type: 'text', text: request.systemPrompt, cache_control: { type: 'ephemeral' } }],
    tools: [{
      name: 'submit_pm_response',
      description: 'Submit the schema-constrained PM response.',
      input_schema: request.outputSchema as Anthropic.Tool['input_schema'],
    }],
    tool_choice: { type: 'tool', name: 'submit_pm_response' },
    messages: [{ role: 'user', content: request.conversationPrompt }],
  });

  let thinking = '';
  stream.on('streamEvent', (event: Anthropic.MessageStreamEvent) => {
    if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
      thinking += event.delta.thinking;
    } else if (event.type === 'content_block_stop' && thinking) {
      request.onThinking?.(thinking);
      thinking = '';
    }
  });
  const message = await stream.finalMessage();
  const tool = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === 'submit_pm_response',
  );
  if (!tool) {
    throw new Error('Anthropic PM did not return submit_pm_response');
  }
  const data = tool.input as Record<string, unknown>;
  if (typeof data.reply === 'string') {
    request.onChunk?.(data.reply);
  }
  return { data };
}

export const apiKeyDriver: AgentDriver = {
  name: 'api-key',

  async runPm(request: PmInferenceRequest): Promise<PmInferenceResult> {
    return runPmViaAnthropic(request);
  },

  // worktreePath is ignored: the api-key path runs via the Anthropic SDK
  // in-process (not a subprocess), so git worktrees don't apply.
  async runCoder(task: Task, state: SwarmState, _worktreePath?: string): Promise<DriverResult> {
    const r = await runCoder(task, state);
    return {
      verdict: 'COMPLETE',
      summary: r.summary,
      filesChanged: r.filesChanged,
      securityFindings: [],
      reviewerFindings: [],
      findingMarkdown: coderFinding(task, r.summary, r.detail, r.filesChanged),
      costUsd: r.costUsd,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    };
  },

  async runTester(task: Task, state: SwarmState): Promise<DriverResult> {
    const r = await runTester(task, state);
    return {
      verdict: r.verdict,
      summary: r.summary,
      filesChanged: [],
      securityFindings: [],
      reviewerFindings: [],
      findingMarkdown: r.finding,
      costUsd: r.costUsd,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    };
  },

  async runSecurity(task: Task, state: SwarmState): Promise<DriverResult> {
    const r = await runSecurity(task, state);
    return {
      verdict: r.verdict,
      summary: r.summary,
      filesChanged: [],
      securityFindings: r.findings,
      reviewerFindings: [],
      findingMarkdown: r.finding,
      costUsd: r.costUsd,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    };
  },

  async runReviewer(task: Task, state: SwarmState): Promise<DriverResult> {
    const r = await runReviewer(task, state);
    return {
      verdict: r.verdict,
      summary: r.summary,
      filesChanged: [],
      securityFindings: [],
      reviewerFindings: r.findings,
      findingMarkdown: r.finding,
      costUsd: r.costUsd,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    };
  },

  async runMarketplaceAgent(
    task: Task,
    state: SwarmState,
    agent: RosterEntry,
  ): Promise<DriverResult> {
    return runMktAgent(task, state, agent);
  },

  // Minimal deterministic arbiter for the Anthropic-SDK path: always spawn a fix
  // for the blocking finding(s). The full LLM-driven arbiter runs in the
  // agent-sdk path (drivers/agent-sdk.ts runNegotiator).
  async runNegotiator(ctx: DeadlockContext): Promise<NegotiatorDecision> {
    return {
      decision: 'SPAWN_FIX',
      targetTaskIds: ctx.blocked.map(b => b.taskId),
      reasoning: 'Auto-remediation: spawning a fix for the blocking finding(s).',
    };
  },

  // The Scout's read-only investigation runs via the Claude Code CLI (agent-sdk
  // path), which the user actually runs. The api-key path has no autonomous
  // file-exploration agent, so return a graceful stub: non-throwing, and a digest
  // that tells the PM scouting is unavailable here so it can plan without it.
  async runScout(question: string): Promise<ScoutResult> {
    return {
      summary: 'Scouting unavailable on the api-key path.',
      digest: `(scout unavailable: codebase investigation is only supported on the agent-sdk/Max driver. Question was: "${question}". Proceed with planning using available context.)`,
      relevantFiles: [],
    };
  },

  // Specialist research, like the Scout, runs autonomously via the Claude Code CLI
  // (agent-sdk path). The api-key path has no autonomous tool-using research agent,
  // so return a graceful, non-throwing stub.
  async runSpecialistResearch(agent: RosterEntry, question: string): Promise<ScoutResult> {
    return {
      summary: 'Specialist research unavailable on the api-key path.',
      digest: `(specialist research unavailable: it runs only on the agent-sdk/Max driver. Specialist "${agent.name}" was asked: "${question}". Proceed with planning using available context.)`,
      relevantFiles: [],
    };
  },

  // The scribe is a read-only tool-using agent; the api-key path has none, so leave
  // project memory unchanged (empty learnings = the loop writes nothing).
  async runScribe(_ctx: ScribeContext): Promise<ScribeResult> {
    return { learnings: '' };
  },

  // The docs scribe edits files autonomously via the agent-sdk path; the api-key
  // path has no tool-using agent, so leave the documentation untouched.
  async runDocsScribe(_ctx: DocsScribeContext): Promise<DocsScribeResult> {
    return { updatedFiles: [], summary: 'Docs scribe unavailable on the api-key path.' };
  },

  // Live context needs MCP connector tools, which only exist on the agent-sdk/Max
  // driver. Graceful, non-throwing stub.
  async runLiveContextScout(_brief: string, _allowedTools: string[]): Promise<ScoutResult> {
    return {
      summary: 'Live service context unavailable on the api-key path.',
      digest: '',
      relevantFiles: [],
    };
  },
};
