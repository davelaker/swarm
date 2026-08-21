import assert from 'node:assert/strict';
import test from 'node:test';
import { hasDriverAuthentication } from './config.js';

test('configuration rejects automatic mode without any authentication', () => {
  assert.equal(
    hasDriverAuthentication({ hasAnthropicApiKey: false, hasClaudeCli: false }),
    false,
  );
});

test('configuration accepts each existing authentication path', () => {
  assert.equal(
    hasDriverAuthentication({ hasAnthropicApiKey: true, hasClaudeCli: false }),
    true,
  );
  assert.equal(
    hasDriverAuthentication({ hasAnthropicApiKey: false, hasClaudeCli: true }),
    true,
  );
});
