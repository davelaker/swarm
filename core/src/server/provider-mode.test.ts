import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  disableCodexOnlyMode,
  getProviderMode,
} from '../providers/index.js';
import {
  handleProviderModeRequest,
  providerModeStatus,
  validateProviderModeRequest,
} from './provider-mode.js';

afterEach(() => {
  disableCodexOnlyMode();
});

test('validateProviderModeRequest accepts only explicit provider modes', () => {
  assert.deepEqual(validateProviderModeRequest({ mode: 'normal' }), {
    ok: true,
    value: { mode: 'normal' },
  });
  assert.deepEqual(validateProviderModeRequest({ mode: 'codex_only' }), {
    ok: true,
    value: { mode: 'codex_only' },
  });
  assert.deepEqual(validateProviderModeRequest({ enabled: true }), {
    ok: false,
    error: 'mode must be "normal" or "codex_only"',
  });
});

test('provider mode reports Codex CLI subscription transport availability safely', () => {
  assert.deepEqual(providerModeStatus(false, (command) => command === 'codex'), {
    mode: 'normal',
    codexAvailable: true,
    activeRun: false,
  });
  assert.deepEqual(providerModeStatus(true, () => false), {
    mode: 'normal',
    codexAvailable: false,
    activeRun: true,
  });
});

test('enabling Codex-only mode fails closed without the local Codex CLI', () => {
  const result = handleProviderModeRequest(
    { mode: 'codex_only' },
    { activeRun: false, probe: () => false },
  );

  assert.equal(result.status, 422);
  assert.equal(result.body.mode, 'normal');
  assert.equal(result.body.codexAvailable, false);
  assert.match(result.body.error, /requires the local Codex CLI subscription transport/);
  assert.equal(getProviderMode(), 'normal');
});

test('switching provider mode is refused while a run is active', () => {
  const result = handleProviderModeRequest(
    { mode: 'codex_only' },
    { activeRun: true, probe: (command) => command === 'codex' },
  );

  assert.deepEqual(result, {
    status: 409,
    body: {
      mode: 'normal',
      codexAvailable: true,
      activeRun: true,
      error: 'Cannot switch provider mode while a run is in progress',
    },
  });
  assert.equal(getProviderMode(), 'normal');
});

test('Codex-only mode can be enabled and reset to normal in memory', () => {
  const enabled = handleProviderModeRequest(
    { mode: 'codex_only' },
    { activeRun: false, probe: (command) => command === 'codex' },
  );
  assert.deepEqual(enabled, {
    status: 200,
    body: {
      mode: 'codex_only',
      codexAvailable: true,
      activeRun: false,
    },
  });

  const disabled = handleProviderModeRequest(
    { mode: 'normal' },
    { activeRun: false, probe: () => false },
  );
  assert.deepEqual(disabled, {
    status: 200,
    body: {
      mode: 'normal',
      codexAvailable: false,
      activeRun: false,
    },
  });
});

