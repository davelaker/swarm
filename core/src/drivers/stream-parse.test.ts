import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStreamMessage,
  describeToolUse,
  createNdjsonBuffer,
  type StreamEvent,
} from './stream-parse.js';

test('parseStreamMessage extracts thinking and tool_use from an assistant message', () => {
  const msg = {
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'I need to read the auth setup first.' },
        { type: 'text', text: 'Let me look at auth.ts.' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/auth.ts' } },
      ],
    },
  };
  assert.deepEqual(parseStreamMessage(msg), [
    { kind: 'thinking', text: 'I need to read the auth setup first.' },
    { kind: 'tool_use', name: 'Read', input: { file_path: '/repo/src/auth.ts' } },
  ] satisfies StreamEvent[]);
});

test('parseStreamMessage flattens tool_result content (string and block array)', () => {
  const stringResult = {
    type: 'user',
    message: { content: [{ type: 'tool_result', is_error: false, content: '127 lines read' }] },
  };
  assert.deepEqual(parseStreamMessage(stringResult), [
    { kind: 'tool_result', isError: false, text: '127 lines read' },
  ]);

  const blockResult = {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'boom' }] }],
    },
  };
  assert.deepEqual(parseStreamMessage(blockResult), [
    { kind: 'tool_result', isError: true, text: 'boom' },
  ]);
});

test('parseStreamMessage reads cost from total_cost_usd, falling back to cost_usd', () => {
  assert.deepEqual(parseStreamMessage({ type: 'result', total_cost_usd: 0.42 }), [
    { kind: 'result', costUsd: 0.42, isError: false },
  ]);
  assert.deepEqual(parseStreamMessage({ type: 'result', cost_usd: 0.1, is_error: true }), [
    { kind: 'result', costUsd: 0.1, isError: true },
  ]);
});

test('parseStreamMessage ignores system/init and unknown messages', () => {
  assert.deepEqual(parseStreamMessage({ type: 'system', subtype: 'init' }), []);
  assert.deepEqual(parseStreamMessage(null), []);
  assert.deepEqual(parseStreamMessage('nonsense'), []);
});

test('describeToolUse renders readable activity lines per tool', () => {
  assert.equal(describeToolUse('Read', { file_path: '/repo/src/auth.ts' }), 'Reading src/auth.ts');
  assert.equal(describeToolUse('Edit', { file_path: '/a/b/c/x.tsx' }), 'Editing c/x.tsx');
  assert.equal(describeToolUse('Bash', { command: 'npm test -- --run' }), '$ npm test -- --run');
  assert.equal(describeToolUse('Grep', { pattern: 'TODO' }), 'Searching “TODO”');
  assert.equal(describeToolUse('mcp__result__submit_result', {}), 'submit_result');
});

test('createNdjsonBuffer emits one message per complete line and holds partials', () => {
  const seen: unknown[] = [];
  const buf = createNdjsonBuffer(m => seen.push(m));
  buf.push('{"type":"system"}\n{"type":"resu');
  assert.equal(seen.length, 1, 'only the complete line is emitted');
  buf.push('lt","total_cost_usd":0.5}\n');
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], { type: 'result', total_cost_usd: 0.5 });
});
