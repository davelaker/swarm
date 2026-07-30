import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModel } from './index.js';

test('normalizeModel resolves friendly aliases to canonical ids', () => {
  assert.equal(normalizeModel('haiku'), 'claude-haiku-4-5-20251001');
  assert.equal(normalizeModel('sonnet'), 'claude-sonnet-4-6');
  assert.equal(normalizeModel('opus'), 'claude-opus-4-8');
  assert.equal(normalizeModel('fable'), 'claude-fable-5');
});

test('normalizeModel matches sonnet 5 before the generic sonnet', () => {
  // The generic 'sonnet' branch would swallow these and silently downgrade the
  // task to Sonnet 4.6 — the ordering in normalizeModel is what prevents it.
  assert.equal(normalizeModel('sonnet 5'), 'claude-sonnet-5');
  assert.equal(normalizeModel('sonnet-5'), 'claude-sonnet-5');
  assert.equal(normalizeModel('claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(normalizeModel('Sonnet 5'), 'claude-sonnet-5');
});

test('normalizeModel is case- and whitespace-insensitive', () => {
  assert.equal(normalizeModel('  OPUS  '), 'claude-opus-4-8');
  assert.equal(normalizeModel('Fable'), 'claude-fable-5');
});

test('normalizeModel passes through unknown claude- ids and rejects the rest', () => {
  assert.equal(normalizeModel('claude-something-new'), 'claude-something-new');
  assert.equal(normalizeModel(''), undefined);
  assert.equal(normalizeModel('   '), undefined);
  assert.equal(normalizeModel('gpt-4'), undefined);
  assert.equal(normalizeModel(undefined), undefined);
  assert.equal(normalizeModel(42), undefined);
});
