import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discoverProviderAvailability,
  getProviderSelection,
  probeCliCommand,
  resolveProviderSelection,
} from './discovery.js';

test('CLI probing falls back to the login shell when the inherited PATH is incomplete', () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const available = probeCliCommand('claude', {
    shell: '/bin/zsh',
    run: (file, args) => {
      calls.push({ file, args });
      if (file === 'claude') {
        throw new Error('not on inherited PATH');
      }
    },
  });

  assert.equal(available, true);
  assert.deepEqual(calls, [
    { file: 'claude', args: ['--version'] },
    {
      file: '/bin/zsh',
      args: [
        '-lic',
        '"$1" --version >/dev/null 2>&1',
        'swarm-provider-probe',
        'claude',
      ],
    },
  ]);
});

test('discovery returns safe provider metadata without CLI output or credentials', () => {
  const availability = discoverProviderAvailability(
    { ANTHROPIC_API_KEY: 'not-inspected', SWARM_ENABLED_PROVIDERS: 'anthropic,openai' },
    (command) => command === 'claude',
  );

  assert.deepEqual(availability, [
    {
      provider: 'anthropic',
      enabled: true,
      cliAvailable: true,
      apiKeyConfigured: true,
      availableAuthModes: ['subscription', 'api-key'],
    },
    {
      provider: 'openai',
      enabled: true,
      cliAvailable: false,
      apiKeyConfigured: false,
      availableAuthModes: [],
    },
  ]);
});

test('automatic provider selection is deterministic and preserves Anthropic precedence', () => {
  assert.equal(
    resolveProviderSelection({
      hasAnthropicApiKey: true,
      hasOpenAiApiKey: true,
      hasClaudeCli: true,
      hasCodexCli: true,
    }).defaultProvider,
    'anthropic',
  );
  assert.equal(
    resolveProviderSelection({
      hasAnthropicApiKey: false,
      hasOpenAiApiKey: false,
      hasClaudeCli: false,
      hasCodexCli: true,
    }).defaultProvider,
    'openai',
  );
  assert.equal(
    resolveProviderSelection({
      hasAnthropicApiKey: false,
      hasOpenAiApiKey: false,
      hasClaudeCli: false,
      hasCodexCli: false,
    }).defaultProvider,
    'anthropic',
  );
});

test('the existing SWARM_DRIVER setting remains an Anthropic selection input', () => {
  assert.equal(
    getProviderSelection(
      { SWARM_DRIVER: 'agent-sdk' },
      (command) => command === 'claude',
    ).defaultProvider,
    'anthropic',
  );
});

test('an explicitly selected unavailable or disabled provider fails closed', () => {
  assert.throws(
    () => resolveProviderSelection({
      defaultProvider: 'openai',
      hasAnthropicApiKey: true,
      hasOpenAiApiKey: false,
      hasClaudeCli: true,
      hasCodexCli: false,
    }),
    /Provider "openai" is selected but no supported local authentication is available/,
  );
  assert.throws(
    () => resolveProviderSelection({
      defaultProvider: 'openai',
      enabledProviders: 'anthropic',
      hasAnthropicApiKey: true,
      hasOpenAiApiKey: true,
      hasClaudeCli: true,
      hasCodexCli: true,
    }),
    /Provider "openai" is selected but is not enabled/,
  );
});

test('process-backed selection probes only known CLI executable names', () => {
  const commands: string[] = [];
  const selection = getProviderSelection(
    { SWARM_DEFAULT_PROVIDER: 'openai' },
    (command) => {
      commands.push(command);
      return command === 'codex';
    },
  );

  assert.equal(selection.defaultProvider, 'openai');
  assert.deepEqual(commands, ['claude', 'codex']);
});
