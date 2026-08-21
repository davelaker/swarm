import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDriverMode } from './types.js';

test('explicit driver selection wins over detected authentication', () => {
  assert.equal(
    resolveDriverMode({
      explicitDriver: 'agent-sdk',
      hasAnthropicApiKey: true,
      hasClaudeCli: false,
    }),
    'agent-sdk',
  );
  assert.equal(
    resolveDriverMode({
      explicitDriver: 'API-KEY',
      hasAnthropicApiKey: false,
      hasClaudeCli: true,
    }),
    'api-key',
  );
  assert.equal(
    resolveDriverMode({
      explicitDriver: 'codex',
      hasAnthropicApiKey: true,
      hasClaudeCli: true,
      hasCodexCli: true,
    }),
    'codex',
  );
});

test('automatic selection preserves API key precedence over Claude CLI', () => {
  assert.equal(
    resolveDriverMode({ hasAnthropicApiKey: true, hasClaudeCli: true }),
    'api-key',
  );
  assert.equal(
    resolveDriverMode({ hasAnthropicApiKey: false, hasClaudeCli: true }),
    'agent-sdk',
  );
});
