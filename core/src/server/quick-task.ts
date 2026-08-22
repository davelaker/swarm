import { checkGitClean, runCompiledRun } from '../commands/new.js';
import {
  compileQuickTask,
  preflightQuickTask,
  type QuickTaskPolicyReason,
  type QuickTaskPreflight,
  type QuickTaskRunDefinition,
  type QuickTaskSpec,
} from '../quick-task/index.js';
import { discoverProviderAvailability, getProviderModelPolicy, type ProviderAvailability } from '../providers/index.js';
import { getRoot } from '../state/repo.js';
import type { TaskRoute } from '../state/types.js';
import type { Validation } from './validate.js';

const MAX_INSTRUCTION_CHARS = 20_000;

export interface QuickTaskRequest {
  instruction: string;
}

export type QuickTaskHandleResult =
  | { status: 400; body: { error: string } }
  | { status: 409; body: { error: string } }
  | {
    status: 200;
    body: QuickTaskEscalationBody | QuickTaskStartedBody;
    dispatch?: () => Promise<void>;
  };

export interface QuickTaskEscalationBody {
  ok: true;
  status: 'escalated';
  executionShape: 'quick_task';
  escalationReason: string;
  riskSignals: readonly (QuickTaskPolicyReason | string)[];
}

export interface QuickTaskStartedBody {
  ok: true;
  status: 'started';
  executionShape: 'quick_task';
  goal: string;
  scopeReason: string;
  spec: {
    declaredWriteScope: readonly string[];
    verificationCommands: readonly string[];
    acceptanceCriteria: readonly string[];
    route: TaskRoute;
  };
}

export interface QuickTaskHandlerDeps {
  hasActiveRun?: () => boolean;
  getProjectRoot?: () => string;
  getProviderAvailability?: () => readonly ProviderAvailability[];
  getAvailableModelIds?: () => readonly string[];
  ensureGitClean?: (projectRoot: string) => void;
  preflight?: (input: {
    instruction: string;
    projectRoot: string;
    providerAvailability: readonly ProviderAvailability[];
    availableModelIds?: readonly string[];
    budgetClass: 'balanced';
  }) => QuickTaskPreflight;
  compile?: (spec: QuickTaskSpec) => QuickTaskRunDefinition;
  dispatchRun?: (definition: QuickTaskRunDefinition) => Promise<void>;
}

const DEFAULT_DEPS: Required<QuickTaskHandlerDeps> = {
  hasActiveRun: () => false,
  getProjectRoot: getRoot,
  getProviderAvailability: () => discoverProviderAvailability(),
  getAvailableModelIds: () => getProviderModelPolicy().enabledModelIds,
  ensureGitClean: checkGitClean,
  preflight: preflightQuickTask,
  compile: compileQuickTask,
  dispatchRun: runCompiledRun,
};

function fail<T = QuickTaskRequest>(error: string): Validation<T> {
  return { ok: false, error };
}

export function validateQuickTaskRequest(raw: unknown): Validation<QuickTaskRequest> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('request body must be an object');
  }

  const payload = raw as Record<string, unknown>;
  const candidate = payload.instruction ?? payload.goal;
  if (typeof candidate !== 'string') {
    return fail('instruction required');
  }

  const instruction = candidate.trim();
  if (!instruction) {
    return fail('instruction required');
  }
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    return fail(`instruction too large (max ${MAX_INSTRUCTION_CHARS} chars)`);
  }

  return {
    ok: true,
    value: { instruction },
  };
}

export function createQuickTaskHandler(deps: QuickTaskHandlerDeps = {}) {
  const resolved = {
    ...DEFAULT_DEPS,
    ...deps,
  };

  return async function handleQuickTaskRequest(raw: unknown): Promise<QuickTaskHandleResult> {
    if (resolved.hasActiveRun()) {
      return {
        status: 409,
        body: { error: 'A run is already in progress' },
      };
    }

    const valid = validateQuickTaskRequest(raw);
    if (!valid.ok) {
      return {
        status: 400,
        body: { error: valid.error },
      };
    }

    const projectRoot = resolved.getProjectRoot();
    try {
      resolved.ensureGitClean(projectRoot);
    } catch (err) {
      return {
        status: 400,
        body: { error: (err as Error).message },
      };
    }

    const preflight = resolved.preflight({
      instruction: valid.value.instruction,
      projectRoot,
      providerAvailability: resolved.getProviderAvailability(),
      availableModelIds: resolved.getAvailableModelIds(),
      budgetClass: 'balanced',
    });

    if (!preflight.ok) {
      return {
        status: 200,
        body: {
          ok: true,
          status: 'escalated',
          executionShape: 'quick_task',
          escalationReason: preflight.escalationReason,
          riskSignals: preflight.riskSignals,
        },
      };
    }

    const definition = resolved.compile(preflight.spec);
    return {
      status: 200,
      body: startedBody(preflight),
      dispatch: async () => resolved.dispatchRun(definition),
    };
  };
}

function startedBody(preflight: Extract<QuickTaskPreflight, { ok: true }>): QuickTaskStartedBody {
  return {
    ok: true,
    status: 'started',
    executionShape: 'quick_task',
    goal: preflight.spec.goal,
    scopeReason: preflight.scopeReason,
    spec: {
      declaredWriteScope: preflight.spec.declaredWriteScope,
      verificationCommands: preflight.spec.verificationCommands,
      acceptanceCriteria: preflight.spec.acceptanceCriteria,
      route: preflight.spec.route,
    },
  };
}
