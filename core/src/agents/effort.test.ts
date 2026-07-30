import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEffort, modelSupportsEffort, effortForModel } from './effort.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';
const SONNET5 = 'claude-sonnet-5';
const OPUS = 'claude-opus-4-8';
const FABLE = 'claude-fable-5';

test('normalizeEffort accepts the canonical levels and common aliases', () => {
  assert.equal(normalizeEffort('low'), 'low');
  assert.equal(normalizeEffort('MEDIUM'), 'medium');
  assert.equal(normalizeEffort(' med '), 'medium');
  assert.equal(normalizeEffort('high'), 'high');
  assert.equal(normalizeEffort('x-high'), 'xhigh');
  assert.equal(normalizeEffort('extra high'), 'xhigh');
  assert.equal(normalizeEffort('maximum'), 'max');
});

test('normalizeEffort rejects unknown values rather than guessing', () => {
  assert.equal(normalizeEffort('turbo'), undefined);
  assert.equal(normalizeEffort(''), undefined);
  assert.equal(normalizeEffort(undefined), undefined);
  assert.equal(normalizeEffort(3), undefined);
});

test('modelSupportsEffort excludes Haiku, which errors on the parameter', () => {
  assert.equal(modelSupportsEffort(HAIKU), false);
  assert.equal(modelSupportsEffort(SONNET), true);
  assert.equal(modelSupportsEffort(SONNET5), true);
  assert.equal(modelSupportsEffort(OPUS), true);
  assert.equal(modelSupportsEffort(FABLE), true);
  assert.equal(modelSupportsEffort(undefined), false);
});

test('effortForModel omits the parameter entirely on Haiku', () => {
  // Sending effort to Haiku is an API error — the whole point of the guard.
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(effortForModel(HAIKU, level), undefined);
  }
});

test('effortForModel clamps xhigh on models that lack it', () => {
  // xhigh arrived with Opus 4.7; Sonnet 4.6 tops out below it.
  assert.equal(effortForModel(SONNET, 'xhigh'), 'high');
  // ...but is passed through where it exists.
  assert.equal(effortForModel(OPUS, 'xhigh'), 'xhigh');
  assert.equal(effortForModel(FABLE, 'xhigh'), 'xhigh');
  assert.equal(effortForModel(SONNET5, 'xhigh'), 'xhigh');
});

test('effortForModel passes supported levels through unchanged', () => {
  assert.equal(effortForModel(OPUS, 'low'), 'low');
  assert.equal(effortForModel(SONNET, 'medium'), 'medium');
  assert.equal(effortForModel(FABLE, 'max'), 'max');
});

test('effortForModel omits the parameter when nothing was requested', () => {
  // No effort assigned → undefined → caller omits it → model default. This is what
  // keeps the feature opt-in and behaviour-identical when unused.
  assert.equal(effortForModel(OPUS, undefined), undefined);
  assert.equal(effortForModel(OPUS, ''), undefined);
  assert.equal(effortForModel(OPUS, 'nonsense'), undefined);
});
