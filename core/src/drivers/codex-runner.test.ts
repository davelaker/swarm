import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCodexCommand,
  cleanupCodexEphemeralFiles,
  createCodexEphemeralFiles,
} from './codex-runner.js';

const schema = {
  type: 'object',
  properties: { status: { type: 'string' } },
  required: ['status'],
  additionalProperties: false,
};

test('builds an isolated workspace-write Codex command with JSONL and schema output', () => {
  const args = buildCodexCommand(
    {
      cwd: '/tmp/swarm-fixture',
      prompt: 'Return the required object.',
      outputSchema: schema,
      sandbox: 'workspace-write',
      model: 'gpt-5.3-codex',
      mcpServers: {
        swarm_result: {
          command: 'node',
          args: ['/tmp/result-server.js'],
          env: { RESULT_OUTPUT_PATH: '/tmp/result.json' },
        },
      },
    },
    { schemaPath: '/tmp/schema.json', outputPath: '/tmp/last-message.json' },
  );

  assert.deepEqual(args.slice(0, 14), [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--sandbox',
    'workspace-write',
    '--cd',
    '/tmp/swarm-fixture',
    '--output-schema',
    '/tmp/schema.json',
    '--output-last-message',
    '/tmp/last-message.json',
    '--config',
    'mcp_servers.swarm_result.command="node"',
  ]);
  assert.ok(args.includes('mcp_servers.swarm_result.args=["/tmp/result-server.js"]'));
  assert.ok(args.includes('mcp_servers.swarm_result.env={ RESULT_OUTPUT_PATH = "/tmp/result.json" }'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.deepEqual(args.slice(-2), ['--', 'Return the required object.']);
});

test('rejects unsafe MCP names and unsupported sandboxes', () => {
  assert.throws(
    () =>
      buildCodexCommand(
        {
          cwd: '/tmp',
          prompt: 'x',
          outputSchema: schema,
          sandbox: 'read-only',
          mcpServers: { 'not.valid': { command: 'node' } },
        },
        { schemaPath: '/tmp/schema.json', outputPath: '/tmp/out.json' },
      ),
    /Invalid Codex MCP server name/,
  );
  assert.throws(
    () =>
      buildCodexCommand(
        { cwd: '/tmp', prompt: 'x', outputSchema: schema, sandbox: 'danger-full-access' as never },
        { schemaPath: '/tmp/schema.json', outputPath: '/tmp/out.json' },
      ),
    /Unsupported Codex sandbox/,
  );
});

test('ephemeral schema files are private and cleanup removes only their fixture directory', () => {
  const files = createCodexEphemeralFiles(schema);
  assert.ok(files.directory.startsWith(path.join(os.tmpdir(), 'swarm-codex-')));
  assert.equal(fs.statSync(files.schemaPath).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(files.schemaPath));
  cleanupCodexEphemeralFiles(files);
  assert.ok(!fs.existsSync(files.directory));
});
