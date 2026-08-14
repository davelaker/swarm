import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest } from './request-guard.js';

const PORT = 7000;

test('allows the dashboard itself — same-origin prod', () => {
  assert.equal(checkRequest('localhost:7000', 'http://localhost:7000', PORT).ok, true);
  assert.equal(checkRequest('127.0.0.1:7000', 'http://127.0.0.1:7000', PORT).ok, true);
});

test('allows the Vite dev origin through the proxy', () => {
  assert.equal(checkRequest('127.0.0.1:7000', 'http://localhost:5173', PORT).ok, true);
  assert.equal(checkRequest('127.0.0.1:7000', 'http://127.0.0.1:5173', PORT).ok, true);
});

test('allows non-browser clients — no Origin header', () => {
  assert.equal(checkRequest('localhost:7000', undefined, PORT).ok, true);
  assert.equal(checkRequest('127.0.0.1:7000', undefined, PORT).ok, true);
});

test('rejects foreign origins — the drive-by vector', () => {
  assert.equal(checkRequest('localhost:7000', 'https://evil.example', PORT).ok, false);
  assert.equal(checkRequest('localhost:7000', 'http://localhost:8080', PORT).ok, false);
  // sandboxed iframe / file:// pages send the literal string "null"
  assert.equal(checkRequest('localhost:7000', 'null', PORT).ok, false);
});

test('rejects foreign Host — the DNS-rebinding vector', () => {
  assert.equal(checkRequest('evil.example:7000', undefined, PORT).ok, false);
  assert.equal(checkRequest('evil.example', undefined, PORT).ok, false);
  assert.equal(checkRequest('localhost:9999', undefined, PORT).ok, false);
  assert.equal(checkRequest(undefined, undefined, PORT).ok, false);
});

test('host and origin checks are case-insensitive', () => {
  assert.equal(checkRequest('LOCALHOST:7000', 'HTTP://LOCALHOST:7000', PORT).ok, true);
});

test('reports a reason on rejection', () => {
  const v = checkRequest('localhost:7000', 'https://evil.example', PORT);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? '', /evil\.example/);
});
