export type ProviderMode = 'normal' | 'codex_only';

export interface ProviderModeState {
  mode: ProviderMode;
  codexAvailable: boolean;
  activeRun: boolean;
}

export interface ProviderModeResponse {
  mode?: ProviderMode;
  codexAvailable?: boolean;
  activeRun?: boolean;
  error?: string;
}

export interface ProviderModeToggleState {
  disabled: boolean;
  reason: string | null;
}

export function defaultProviderModeState(): ProviderModeState {
  return {
    mode: 'normal',
    codexAvailable: false,
    activeRun: false,
  };
}

export function normalizeProviderModeResponse(
  response: ProviderModeResponse | null | undefined,
  previous: ProviderModeState = defaultProviderModeState(),
): ProviderModeState {
  return {
    mode: response?.mode ?? previous.mode,
    codexAvailable: response?.codexAvailable ?? previous.codexAvailable,
    activeRun: response?.activeRun ?? previous.activeRun,
  };
}

export function codexOnlyEnabled(mode: ProviderMode): boolean {
  return mode === 'codex_only';
}

export function codexOnlyStatusLabel(mode: ProviderMode): string {
  return codexOnlyEnabled(mode) ? 'On' : 'Off';
}

export function codexOnlyConfirmationCopy(mode: ProviderMode): {
  title: string;
  body: string;
  confirmLabel: string;
  nextMode: ProviderMode;
} {
  if (codexOnlyEnabled(mode)) {
    return {
      title: 'Turn off Codex-only mode?',
      body:
        'Claude becomes available to the PM and task router again as soon as you turn this off.',
      confirmLabel: 'Allow Claude again',
      nextMode: 'normal',
    };
  }

  return {
    title: 'Turn on Codex-only mode?',
    body:
      'Claude is disabled for PM planning and task routing until you turn this off or restart the server.',
    confirmLabel: 'Disable Claude',
    nextMode: 'codex_only',
  };
}

export function codexOnlyToggleState(input: {
  serverStatus: 'probing' | 'up' | 'down';
  pending: boolean;
  providerMode: ProviderModeState;
}): ProviderModeToggleState {
  if (input.pending) {
    return {
      disabled: true,
      reason: 'Updating provider mode…',
    };
  }

  if (input.serverStatus !== 'up') {
    return {
      disabled: true,
      reason: 'Swarm must be connected before provider mode can change.',
    };
  }

  if (input.providerMode.activeRun) {
    return {
      disabled: true,
      reason: 'Finish or stop the active run before changing provider mode.',
    };
  }

  if (!input.providerMode.codexAvailable) {
    return {
      disabled: true,
      reason: 'Codex is unavailable, so Claude cannot be disabled safely.',
    };
  }

  return {
    disabled: false,
    reason: null,
  };
}
