/**
 * Narrow Codex CLI transport used by the MP-04 compatibility spike.
 *
 * This module deliberately does not implement an AgentDriver.  It establishes
 * the safe per-invocation contract a future driver may rely on: an isolated
 * Codex session, a supplied worktree, JSONL events, JSON-schema output, and
 * transient MCP configuration.  It never writes to CODEX_HOME or alters a
 * user's Codex configuration.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CodexSandbox = 'read-only' | 'workspace-write';

export type CodexMcpServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type CodexRunOptions = {
  cwd: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  sandbox: CodexSandbox;
  mcpServers?: Record<string, CodexMcpServer>;
  model?: string;
};

export type CodexRunResult = {
  events: unknown[];
  output: Record<string, unknown>;
};

export type CodexEphemeralFiles = {
  directory: string;
  schemaPath: string;
  outputPath: string;
};

const SAFE_MCP_NAME = /^[a-z][a-z0-9_-]*$/;

function tomlString(value: string): string {
  // JSON strings are valid TOML basic strings and safely preserve quotes,
  // backslashes, and newlines without invoking a shell.
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlStringTable(values: Record<string, string>): string {
  const entries = Object.entries(values).map(([key, value]) => `${key} = ${tomlString(value)}`);
  return `{ ${entries.join(', ')} }`;
}

function mcpConfigOverrides(servers: Record<string, CodexMcpServer>): string[] {
  const overrides: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!SAFE_MCP_NAME.test(name)) {
      throw new Error(`Invalid Codex MCP server name "${name}"`);
    }
    if (!server.command) {
      throw new Error(`Codex MCP server "${name}" needs a command`);
    }
    const prefix = `mcp_servers.${name}`;
    overrides.push(`${prefix}.command=${tomlString(server.command)}`);
    if (server.args?.length) {
      overrides.push(`${prefix}.args=${tomlStringArray(server.args)}`);
    }
    if (server.env && Object.keys(server.env).length) {
      overrides.push(`${prefix}.env=${tomlStringTable(server.env)}`);
    }
  }
  return overrides;
}

export function createCodexEphemeralFiles(outputSchema: Record<string, unknown>): CodexEphemeralFiles {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-codex-'));
  const schemaPath = path.join(directory, 'output-schema.json');
  fs.writeFileSync(schemaPath, JSON.stringify(outputSchema), { mode: 0o600 });
  return { directory, schemaPath, outputPath: path.join(directory, 'last-message.json') };
}

export function cleanupCodexEphemeralFiles(files: CodexEphemeralFiles): void {
  // The directory was created with mkdtemp under the OS temp directory above;
  // cleanup is intentionally limited to that one exact directory.
  fs.rmSync(files.directory, { recursive: true, force: true });
}

export function buildCodexCommand(
  opts: CodexRunOptions,
  files: Pick<CodexEphemeralFiles, 'schemaPath' | 'outputPath'>,
): string[] {
  if (opts.sandbox !== 'read-only' && opts.sandbox !== 'workspace-write') {
    throw new Error(`Unsupported Codex sandbox "${opts.sandbox}"`);
  }

  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--sandbox',
    opts.sandbox,
    '--cd',
    opts.cwd,
    '--output-schema',
    files.schemaPath,
    '--output-last-message',
    files.outputPath,
  ];

  for (const override of mcpConfigOverrides(opts.mcpServers ?? {})) {
    args.push('--config', override);
  }
  if (opts.model) {
    args.push('--model', opts.model);
  }
  return [...args, '--', opts.prompt];
}

function parseJsonl(stdout: string): unknown[] {
  const lines = stdout.split('\n').filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Codex emitted invalid JSONL at line ${index + 1}`);
    }
  });
}

export async function runCodex(opts: CodexRunOptions): Promise<CodexRunResult> {
  const files = createCodexEphemeralFiles(opts.outputSchema);
  const args = buildCodexCommand(opts, files);
  try {
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
      (resolve, reject) => {
        const proc = spawn('codex', args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', chunk => {
          stdout += chunk.toString();
        });
        proc.stderr.on('data', chunk => {
          stderr += chunk.toString();
        });
        proc.on('error', error => {
          reject(new Error(`Failed to spawn Codex CLI: ${error.message}`));
        });
        proc.on('close', code => {
          resolve({ stdout, stderr, code });
        });
      },
    );
    if (code !== 0) {
      throw new Error(`Codex exited ${code ?? 'null'}: ${stderr.slice(0, 500) || '(no error output)'}`);
    }
    if (!fs.existsSync(files.outputPath)) {
      throw new Error('Codex completed without writing the schema-constrained final response');
    }
    let output: Record<string, unknown>;
    try {
      output = JSON.parse(fs.readFileSync(files.outputPath, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error('Codex final response was not valid JSON despite the output schema');
    }
    return { events: parseJsonl(stdout), output };
  } finally {
    cleanupCodexEphemeralFiles(files);
  }
}
