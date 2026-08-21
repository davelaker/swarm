/**
 * Read-only Codex AgentDriver.
 *
 * Codex is deliberately never given native write tools.  A coder can only
 * return a schema-constrained unified patch, which Swarm validates and applies
 * through the permission broker in codex-patch.ts.
 */
import { applyCodexPatchProposal, CODEX_PATCH_PROPOSAL_SCHEMA } from './codex-patch.js';
import { runCodex, type CodexRunOptions, type CodexRunResult } from './codex-runner.js';
import { coderFinding, marketplaceFinding, reviewerFinding, securityFinding, testerFinding } from './findings.js';
import { getRoot } from '../state/repo.js';
import {
  supportsExecutionTransport,
  validateReasoningEffort,
  type ReasoningEffort,
} from '../providers/catalog.js';
import type {
  AgentDriver,
  DeadlockContext,
  DocsScribeContext,
  DocsScribeResult,
  DriverResult,
  NegotiatorDecision,
  PmInferenceRequest,
  PmInferenceResult,
  ReviewerFinding,
  ScoutResult,
  ScribeContext,
  ScribeResult,
  SecurityFinding,
} from './types.js';
import type { RosterEntry, SwarmState, Task } from '../state/types.js';

type CodexRunner = (opts: CodexRunOptions) => Promise<CodexRunResult>;
type PatchApplier = typeof applyCodexPatchProposal;

export type CodexDriverDependencies = {
  run?: CodexRunner;
  applyPatch?: PatchApplier;
  root?: () => string;
};

const DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium';

const resultFields = {
  verdict: { type: 'string' },
  summary: { type: 'string', minLength: 1 },
  detail: { type: 'string' },
};

const coderSchema = schema({
  ...resultFields,
  patch_proposal: CODEX_PATCH_PROPOSAL_SCHEMA,
}, ['verdict', 'summary', 'detail', 'patch_proposal']);

const testerSchema = schema(resultFields, ['verdict', 'summary', 'detail']);

const reviewerSchema = schema({
  ...resultFields,
  findings: { type: 'array', items: { type: 'object' } },
}, ['verdict', 'summary', 'detail', 'findings']);

const securitySchema = schema({
  ...resultFields,
  findings: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' }, severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
        type: { type: 'string' }, location: { type: 'string' }, attack_path: { type: 'string' }, fix: { type: 'string' },
      },
      required: ['id', 'severity', 'type', 'location', 'attack_path', 'fix'], additionalProperties: false,
    },
  },
}, ['verdict', 'summary', 'detail', 'findings']);

const scoutSchema = schema({
  summary: { type: 'string' },
  digest: { type: 'string' },
  relevant_files: { type: 'array', items: { type: 'string' } },
}, ['summary', 'digest', 'relevant_files']);

const scribeSchema = schema({ learnings: { type: 'string' } }, ['learnings']);
const docsScribeSchema = schema({
  updated_files: { type: 'array', items: { type: 'string' } },
  summary: { type: 'string' },
}, ['updated_files', 'summary']);
const negotiatorSchema = schema({
  decision: { type: 'string', enum: ['SPAWN_FIX', 'DOWNGRADE', 'ABORT'] },
  target_task_ids: { type: 'array', items: { type: 'string' } },
  reasoning: { type: 'string' },
}, ['decision', 'target_task_ids', 'reasoning']);

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

function stringField(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Codex returned an invalid schema result: "${field}" must be a non-empty string`);
  }
  return value;
}

function stringArray(data: Record<string, unknown>, field: string): string[] {
  const value = data[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Codex returned an invalid schema result: "${field}" must be an array of strings`);
  }
  return value;
}

function objectArray(data: Record<string, unknown>, field: string): Record<string, unknown>[] {
  const value = data[field];
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error(`Codex returned an invalid schema result: "${field}" must be an array of objects`);
  }
  return value as Record<string, unknown>[];
}

type CodexExecutionRoute = {
  model: string;
  reasoningEffort: ReasoningEffort;
};

function codexExecutionRoute(task?: Task): CodexExecutionRoute {
  if (task?.route) {
    if (task.route.provider !== 'openai') {
      throw new Error(`Codex driver cannot execute ${task.route.provider} route for task "${task.id}".`);
    }
    if (!task.route.reasoningEffort) {
      throw new Error(`Codex task "${task.id}" requires an explicit reasoning effort in its immutable route.`);
    }
    if (!supportsExecutionTransport(task.route.model, 'codex-cli')) {
      throw new Error(`Codex CLI cannot execute routed model "${task.route.model}" for task "${task.id}". Select a codex-cli model.`);
    }
    validateReasoningEffort(task.route.model, task.route.reasoningEffort);
    return { model: task.route.model, reasoningEffort: task.route.reasoningEffort };
  }
  if (task?.model?.startsWith('gpt-')) {
    throw new Error(`Codex task "${task.id}" must use an immutable OpenAI route with an explicit reasoning effort.`);
  }
  return { model: DEFAULT_MODEL, reasoningEffort: DEFAULT_REASONING_EFFORT };
}

function codexWriteScope(task: Task): string[] {
  return task.route?.writeScope ?? task.artifacts;
}

function taskContext(task: Task, state: SwarmState): string {
  const charter = state.charter;
  return [
    `Task ID: ${task.id}`,
    `Task: ${task.title}`,
    state.goal ? `Goal: ${state.goal}` : '',
    charter?.constraints?.length ? `Constraints: ${charter.constraints.join(' | ')}` : '',
    charter?.nongoals?.length ? `Non-goals: ${charter.nongoals.join(' | ')}` : '',
    task.steer?.length ? `User steering:\n${task.steer.map((note) => `- ${note}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

function asSecurityFindings(data: Record<string, unknown>): SecurityFinding[] {
  return objectArray(data, 'findings').map((finding) => ({
    id: stringField(finding, 'id'),
    severity: enumField(finding, 'severity', ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    type: stringField(finding, 'type'),
    location: stringField(finding, 'location'),
    attack_path: stringField(finding, 'attack_path'),
    fix: stringField(finding, 'fix'),
  } satisfies SecurityFinding));
}

function asReviewerFindings(data: Record<string, unknown>): ReviewerFinding[] {
  return objectArray(data, 'findings').map((finding) => ({
    id: stringField(finding, 'id'),
    severity: enumField(finding, 'severity', ['HIGH', 'MEDIUM', 'LOW']),
    category: enumField(finding, 'category', ['correctness', 'robustness', 'design', 'testability', 'clarity']),
    location: stringField(finding, 'location'),
    issue: stringField(finding, 'issue'),
    fix: stringField(finding, 'fix'),
  } satisfies ReviewerFinding));
}

function enumField<T extends string>(data: Record<string, unknown>, field: string, options: readonly T[]): T {
  const value = stringField(data, field).toUpperCase();
  if (!options.includes(value as T)) {
    throw new Error(`Codex returned an invalid schema result: "${field}" must be one of ${options.join(', ')}`);
  }
  return value as T;
}

function verdict(data: Record<string, unknown>, fallback: string): string {
  const value = data.verdict;
  return typeof value === 'string' && value.trim() ? value.toUpperCase() : fallback;
}

export function createCodexDriver(deps: CodexDriverDependencies = {}): AgentDriver {
  const execute = deps.run ?? runCodex;
  const applyPatch = deps.applyPatch ?? applyCodexPatchProposal;
  const root = deps.root ?? getRoot;

  const run = (prompt: string, outputSchema: Record<string, unknown>, task?: Task, cwd = root()) => {
    const route = codexExecutionRoute(task);
    return execute({ cwd, prompt, outputSchema, sandbox: 'read-only', ...route });
  };

  return {
    name: 'codex',

    async runPm(request: PmInferenceRequest): Promise<PmInferenceResult> {
      const response = await execute({
        cwd: request.projectRoot,
        model: DEFAULT_MODEL,
        reasoningEffort: DEFAULT_REASONING_EFFORT,
        sandbox: 'read-only',
        outputSchema: request.outputSchema,
        prompt: [
          request.systemPrompt,
          'Return only the schema-constrained PM response. You have read-only repository access; do not write files, invoke connectors, or rely on MCP tools.',
          request.conversationPrompt,
        ].join('\n\n'),
      });
      return { data: response.output };
    },

    async runCoder(task, state, worktreePath): Promise<DriverResult> {
      const response = await run([
        'You are Swarm\'s coder. You have read-only repository access.',
        'Do not attempt to write files, use shell redirection, commit, or alter configuration.',
        'Inspect the code, then return the exact unified diff needed in patch_proposal.',
        'The patch field must be a standard Git unified diff starting with "diff --git a/<path> b/<path>", followed by "--- a/<path>", "+++ b/<path>", and one or more "@@" hunks.',
        'Never use "*** Begin Patch" markers or include prose inside the patch field.',
        'The patch must modify only the declared task paths. Swarm—not you—will validate, approve, and apply it.',
        `Declared writable paths: ${codexWriteScope(task).join(', ') || '(none; return a patch only if this is corrected)'}.`,
        taskContext(task, state),
      ].join('\n\n'), coderSchema, task, worktreePath ?? root());
      const data = response.output;
      const summary = stringField(data, 'summary');
      const detail = stringField(data, 'detail');
      const resultVerdict = verdict(data, 'FAILED');
      if (resultVerdict === 'FAILED') {
        return { verdict: 'FAILED', summary, filesChanged: [], securityFindings: [], reviewerFindings: [], findingMarkdown: coderFinding(task, summary, detail, []) };
      }
      if (!worktreePath) {
        throw new Error('Codex coder requires an isolated worktree for broker-mediated patch application');
      }
      const applied = await applyPatch({
        agentId: task.id,
        worktreePath,
        writeScope: codexWriteScope(task),
        proposal: data.patch_proposal,
      });
      return { verdict: 'COMPLETE', summary, filesChanged: applied.changedPaths, securityFindings: [], reviewerFindings: [], findingMarkdown: coderFinding(task, summary, detail, applied.changedPaths) };
    },

    async runTester(task, state): Promise<DriverResult> {
      const { output } = await run(`You are a read-only test analyst. Inspect the repository and report test status; do not write files.\n\n${taskContext(task, state)}`, testerSchema, task);
      const resultVerdict = verdict(output, 'FAIL');
      const summary = stringField(output, 'summary');
      const detail = stringField(output, 'detail');
      return { verdict: resultVerdict, summary, filesChanged: [], securityFindings: [], reviewerFindings: [], findingMarkdown: testerFinding(task, resultVerdict, summary, detail) };
    },

    async runSecurity(task, state): Promise<DriverResult> {
      const { output } = await run(`You are a read-only security reviewer. Return APPROVED or CHANGES_REQUESTED and structured findings.\n\n${taskContext(task, state)}`, securitySchema, task);
      const resultVerdict = verdict(output, 'CHANGES_REQUESTED');
      const summary = stringField(output, 'summary');
      const detail = stringField(output, 'detail');
      const findings = asSecurityFindings(output);
      return { verdict: resultVerdict, summary, filesChanged: [], securityFindings: findings, reviewerFindings: [], findingMarkdown: securityFinding(task, resultVerdict, summary, detail, findings) };
    },

    async runReviewer(task, state): Promise<DriverResult> {
      const { output } = await run(`You are a read-only code reviewer. Return APPROVED or CHANGES_REQUESTED and structured findings.\n\n${taskContext(task, state)}`, reviewerSchema, task);
      const resultVerdict = verdict(output, 'CHANGES_REQUESTED');
      const summary = stringField(output, 'summary');
      const detail = stringField(output, 'detail');
      const findings = asReviewerFindings(output);
      return { verdict: resultVerdict, summary, filesChanged: [], securityFindings: [], reviewerFindings: findings, findingMarkdown: reviewerFinding(task, resultVerdict, summary, detail, findings) };
    },

    async runMarketplaceAgent(task, state, agent): Promise<DriverResult> {
      const { output } = await run(`${agent.prompt}\n\nYou have read-only repository access. Return findings only; do not write files.\n\n${taskContext(task, state)}`, reviewerSchema, task);
      const resultVerdict = verdict(output, 'ADVISORY');
      const summary = stringField(output, 'summary');
      const detail = stringField(output, 'detail');
      const findings = objectArray(output, 'findings');
      return { verdict: resultVerdict, summary, filesChanged: [], securityFindings: [], reviewerFindings: [], findingMarkdown: marketplaceFinding(task, agent.id, agent.name, resultVerdict, summary, detail, findings) };
    },

    async runNegotiator(ctx): Promise<NegotiatorDecision> {
      const { output } = await run(`You are a read-only deadlock arbiter. Goal: ${ctx.goal}\nBlocked tasks: ${JSON.stringify(ctx.blocked)}\nTask graph: ${JSON.stringify(ctx.tasks.map((task) => ({ id: task.id, status: task.status, depends_on: task.depends_on })))}`, negotiatorSchema);
      const decision = enumField(output, 'decision', ['SPAWN_FIX', 'DOWNGRADE', 'ABORT']);
      return { decision, targetTaskIds: stringArray(output, 'target_task_ids'), reasoning: stringField(output, 'reasoning') };
    },

    async runScout(question): Promise<ScoutResult> {
      const { output } = await run(`You are a read-only codebase scout. Investigate and answer this question factually: ${question}`, scoutSchema);
      return { summary: stringField(output, 'summary'), digest: stringField(output, 'digest'), relevantFiles: stringArray(output, 'relevant_files') };
    },

    async runSpecialistResearch(agent, question): Promise<ScoutResult> {
      const { output } = await run(`${agent.prompt}\n\nYou are performing read-only research. Answer factually: ${question}`, scoutSchema);
      return { summary: stringField(output, 'summary'), digest: stringField(output, 'digest'), relevantFiles: stringArray(output, 'relevant_files') };
    },

    async runScribe(ctx): Promise<ScribeResult> {
      const { output } = await run(`You are a read-only project-memory scribe. Return merged durable learnings only; do not edit files.\n\n${JSON.stringify(ctx)}`, scribeSchema);
      return { learnings: stringField(output, 'learnings') };
    },

    async runDocsScribe(ctx): Promise<DocsScribeResult> {
      const { output } = await run(`You are a read-only documentation analyst. Do not edit files; report documentation paths that Swarm may update separately.\n\n${JSON.stringify(ctx)}`, docsScribeSchema);
      return { updatedFiles: stringArray(output, 'updated_files'), summary: stringField(output, 'summary') };
    },

    async runLiveContextScout(brief, _allowedTools): Promise<ScoutResult> {
      // Codex does not receive connector MCP tools until an equivalently enforced
      // connector boundary exists. Return a safe, explicit non-result instead.
      return { summary: 'Live service context unavailable on the read-only Codex driver.', digest: `(No connector tools were granted to Codex. Requested brief: ${brief})`, relevantFiles: [] };
    },
  };
}

export const codexDriver = createCodexDriver();
