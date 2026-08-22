import { describe, expect, it } from 'vitest';
import {
  codexOnlyConfirmationCopy,
  codexOnlyStatusLabel,
  codexOnlyToggleState,
  defaultProviderModeState,
  normalizeProviderModeResponse,
} from './providerMode';

describe('normalizeProviderModeResponse', () => {
  it('fills in missing values from the previous state', () => {
    expect(
      normalizeProviderModeResponse(
        { mode: 'codex_only' },
        { mode: 'normal', codexAvailable: true, activeRun: false },
      ),
    ).toEqual({
      mode: 'codex_only',
      codexAvailable: true,
      activeRun: false,
    });
  });
});

describe('codexOnlyToggleState', () => {
  it('blocks changes while a run is active', () => {
    expect(
      codexOnlyToggleState({
        serverStatus: 'up',
        pending: false,
        providerMode: { mode: 'normal', codexAvailable: true, activeRun: true },
      }),
    ).toEqual({
      disabled: true,
      reason: 'Finish or stop the active run before changing provider mode.',
    });
  });

  it('blocks changes when Codex is unavailable', () => {
    expect(
      codexOnlyToggleState({
        serverStatus: 'up',
        pending: false,
        providerMode: { mode: 'normal', codexAvailable: false, activeRun: false },
      }),
    ).toEqual({
      disabled: true,
      reason: 'Codex is unavailable, so Claude cannot be disabled safely.',
    });
  });

  it('allows toggling when the server is ready and Codex is available', () => {
    expect(
      codexOnlyToggleState({
        serverStatus: 'up',
        pending: false,
        providerMode: { mode: 'codex_only', codexAvailable: true, activeRun: false },
      }),
    ).toEqual({
      disabled: false,
      reason: null,
    });
  });
});

describe('provider mode copy', () => {
  it('returns compact status labels and confirmation copy', () => {
    expect(defaultProviderModeState()).toEqual({
      mode: 'normal',
      codexAvailable: false,
      activeRun: false,
    });
    expect(codexOnlyStatusLabel('codex_only')).toBe('On');
    expect(codexOnlyConfirmationCopy('normal').body).toMatch(/PM planning and task routing/);
  });
});
