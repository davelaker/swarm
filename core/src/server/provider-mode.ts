import {
  codexCliSubscriptionTransportAvailable,
  disableCodexOnlyMode,
  enableCodexOnlyMode,
  getProviderMode,
  type ProviderMode,
} from '../providers/index.js';
import type { CliProbe } from '../providers/index.js';
import type { Validation } from './validate.js';

export interface ProviderModeBody {
  mode: ProviderMode;
}

export interface ProviderModeStatus {
  mode: ProviderMode;
  codexAvailable: boolean;
  activeRun: boolean;
}

export type ProviderModeHandleResult =
  | { status: 200; body: ProviderModeStatus }
  | { status: 400; body: ProviderModeStatus & { error: string } }
  | { status: 409; body: ProviderModeStatus & { error: string } }
  | { status: 422; body: ProviderModeStatus & { error: string } };

function fail(error: string): Validation<ProviderModeBody> {
  return { ok: false, error };
}

export function validateProviderModeRequest(raw: unknown): Validation<ProviderModeBody> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('request body must be an object');
  }

  const mode = (raw as Record<string, unknown>).mode;
  if (mode !== 'normal' && mode !== 'codex_only') {
    return fail('mode must be "normal" or "codex_only"');
  }

  return {
    ok: true,
    value: { mode },
  };
}

export function providerModeStatus(
  activeRun: boolean,
  probe?: CliProbe,
): ProviderModeStatus {
  return {
    mode: getProviderMode(),
    codexAvailable: codexCliSubscriptionTransportAvailable(probe),
    activeRun,
  };
}

export function handleProviderModeRequest(
  raw: unknown,
  deps: {
    activeRun: boolean;
    probe?: CliProbe;
  },
): ProviderModeHandleResult {
  const valid = validateProviderModeRequest(raw);
  if (!valid.ok) {
    return {
      status: 400,
      body: { ...providerModeStatus(deps.activeRun, deps.probe), error: valid.error },
    };
  }

  if (deps.activeRun) {
    return {
      status: 409,
      body: {
        ...providerModeStatus(deps.activeRun, deps.probe),
        error: 'Cannot switch provider mode while a run is in progress',
      },
    };
  }

  if (valid.value.mode === 'codex_only') {
    try {
      enableCodexOnlyMode(deps.probe);
    } catch (err) {
      return {
        status: 422,
        body: {
          ...providerModeStatus(deps.activeRun, deps.probe),
          error: (err as Error).message,
        },
      };
    }
  } else {
    disableCodexOnlyMode();
  }

  return {
    status: 200,
    body: providerModeStatus(deps.activeRun, deps.probe),
  };
}

