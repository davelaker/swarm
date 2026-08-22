import assert from 'node:assert/strict';
import test from 'node:test';
import { claudePmSpawnArgs } from './agent-sdk.js';

test('Claude PM spawn args use the requested default model', () => {
  const args = claudePmSpawnArgs({
    systemPrompt: 'You are the PM.',
    conversationPrompt: 'Plan this.',
    model: 'claude-fable-5',
  }, '/tmp/swarm-pm-config.json');

  assert.equal(args[args.indexOf('--model') + 1], 'claude-fable-5');
});

test('Claude PM spawn args reject non-Claude defaults', () => {
  assert.throws(() => claudePmSpawnArgs({
    systemPrompt: 'You are the PM.',
    conversationPrompt: 'Plan this.',
    model: 'gpt-5.4',
  }, '/tmp/swarm-pm-config.json'), /cannot execute model/);
});
