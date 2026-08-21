import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModel } from './index.js';

test('normalizeModel resolves friendly aliases to canonical ids', () => {
  assert.equal(normalizeModel('haiku'), 'claude-haiku-4-5-20251001');
  assert.equal(normalizeModel('sonnet'), 'claude-sonnet-4-6');
  assert.equal(normalizeModel('opus'), 'claude-opus-4-8');
  assert.equal(normalizeModel('fable'), 'claude-fable-5');
});

test('normalizeModel accepts catalog-backed Codex aliases', () => {
  assert.equal(normalizeModel('codex'), 'gpt-5.3-codex');
  assert.equal(normalizeModel('gpt'), 'gpt-5.3-codex');
  assert.equal(normalizeModel('gpt-5.4'), 'gpt-5.4');
});

test('normalizeModel is case- and whitespace-insensitive', () => {
  assert.equal(normalizeModel('  OPUS  '), 'claude-opus-4-8');
  assert.equal(normalizeModel('Fable'), 'claude-fable-5');
});

test('normalizeModel rejects unsupported concrete provider ids', () => {
  assert.equal(normalizeModel('claude-something-new'), undefined);
  assert.equal(normalizeModel('claude-sonnet-5'), undefined);
  assert.equal(normalizeModel(''), undefined);
  assert.equal(normalizeModel('   '), undefined);
  assert.equal(normalizeModel('gpt-4'), undefined);
  assert.equal(normalizeModel(undefined), undefined);
  assert.equal(normalizeModel(42), undefined);
});
