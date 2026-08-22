import {
  getProviderModelPolicy,
  modelPolicyProviders,
  setProviderModelPolicy,
  type CliProbe,
  type ModelPolicyProvider,
} from '../providers/index.js';
import type { Validation } from './validate.js';

export interface ProviderModelsBody {
  enabledModelIds: readonly string[];
  defaultModelId?: string;
}

export interface ProviderModelsStatus {
  providers: readonly ModelPolicyProvider[];
  enabledModelIds: readonly string[];
  defaultModelId: string;
  activeRun: boolean;
}

export type ProviderModelsHandleResult =
  | { status: 200; body: ProviderModelsStatus }
  | { status: 400; body: ProviderModelsStatus & { error: string } }
  | { status: 409; body: ProviderModelsStatus & { error: string } }
  | { status: 422; body: ProviderModelsStatus & { error: string } };

function fail(error: string): Validation<ProviderModelsBody> {
  return { ok: false, error };
}

export function validateProviderModelsRequest(raw: unknown): Validation<ProviderModelsBody> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('request body must be an object');
  }

  const payload = raw as Record<string, unknown>;
  if (!Array.isArray(payload.enabledModelIds)) {
    return fail('enabledModelIds must be an array');
  }
  if (payload.enabledModelIds.some((modelId) => typeof modelId !== 'string')) {
    return fail('enabledModelIds must contain only model id strings');
  }
  if (payload.defaultModelId !== undefined && typeof payload.defaultModelId !== 'string') {
    return fail('defaultModelId must be a model id string');
  }

  return {
    ok: true,
    value: {
      enabledModelIds: payload.enabledModelIds,
      ...(payload.defaultModelId !== undefined ? { defaultModelId: payload.defaultModelId } : {}),
    },
  };
}

export function providerModelsStatus(
  activeRun: boolean,
  deps: { env?: NodeJS.ProcessEnv; probe?: CliProbe } = {},
): ProviderModelsStatus {
  const env = deps.env ?? process.env;
  const probe = deps.probe;
  const policy = getProviderModelPolicy(env, probe);
  return {
    providers: modelPolicyProviders(env, probe),
    enabledModelIds: policy.enabledModelIds,
    defaultModelId: policy.defaultModelId,
    activeRun,
  };
}

export function handleProviderModelsRequest(
  raw: unknown,
  deps: {
    activeRun: boolean;
    env?: NodeJS.ProcessEnv;
    probe?: CliProbe;
  },
): ProviderModelsHandleResult {
  const valid = validateProviderModelsRequest(raw);
  if (!valid.ok) {
    return {
      status: 400,
      body: { ...providerModelsStatus(deps.activeRun, deps), error: valid.error },
    };
  }

  if (deps.activeRun) {
    return {
      status: 409,
      body: {
        ...providerModelsStatus(deps.activeRun, deps),
        error: 'Cannot change model policy while a run is in progress',
      },
    };
  }

  try {
    setProviderModelPolicy(valid.value, deps.env, deps.probe);
  } catch (err) {
    return {
      status: 422,
      body: {
        ...providerModelsStatus(deps.activeRun, deps),
        error: (err as Error).message,
      },
    };
  }

  return {
    status: 200,
    body: providerModelsStatus(deps.activeRun, deps),
  };
}
