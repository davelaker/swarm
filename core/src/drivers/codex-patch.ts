/**
 * Broker-mediated application of a read-only Codex patch proposal.
 *
 * Codex can inspect a task worktree but never receives native write tools. Its
 * only mutation request is this schema-constrained proposal; Swarm validates
 * it, asks the existing permission broker, then applies the exact patch.
 */
import { spawn } from 'node:child_process';
import { requestPermission } from './permission-broker.js';
import { matchesPathScope } from '../permission-proxy/scope-guard.js';

export type CodexPatchProposal = {
  base_revision: string;
  changed_paths: string[];
  patch: string;
};

export type ApplyCodexPatchOptions = {
  agentId: string;
  worktreePath: string;
  writeScope: string[];
  proposal: unknown;
  requestApproval?: (agentId: string, tool: string, input: Record<string, unknown>) => Promise<'allow' | 'deny'>;
};

export const CODEX_PATCH_PROPOSAL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    base_revision: { type: 'string', pattern: '^[0-9a-f]{40}$' },
    changed_paths: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    patch: { type: 'string', minLength: 1 },
  },
  required: ['base_revision', 'changed_paths', 'patch'],
  additionalProperties: false,
};

const SHA = /^[0-9a-f]{40}$/;
const UNSAFE_SEGMENT = /(^|\/)\.(?:git|swarm)(?:\/|$)/;

function proposalError(message: string): Error {
  return new Error(`Invalid Codex patch proposal: ${message}`);
}

function normalizePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw proposalError('changed paths must be non-empty strings without NUL bytes');
  }
  const normalized = value.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('./') ||
    normalized.includes('//') ||
    normalized.split('/').some(segment => segment === '..' || segment === '.') ||
    UNSAFE_SEGMENT.test(normalized) ||
    normalized === '.env' ||
    normalized.startsWith('.env.') ||
    normalized.includes('/.env') ||
    normalized === 'node_modules' ||
    normalized.startsWith('node_modules/')
  ) {
    throw proposalError(`unsafe changed path "${value}"`);
  }
  return normalized;
}

export function parseCodexPatchProposal(value: unknown): CodexPatchProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw proposalError('must be an object');
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== 3 || keys.some(key => !['base_revision', 'changed_paths', 'patch'].includes(key))) {
    throw proposalError('must contain only base_revision, changed_paths, and patch');
  }
  if (typeof raw.base_revision !== 'string' || !SHA.test(raw.base_revision)) {
    throw proposalError('base_revision must be a lowercase, full 40-character Git SHA');
  }
  if (!Array.isArray(raw.changed_paths) || raw.changed_paths.length === 0) {
    throw proposalError('changed_paths must be a non-empty array');
  }
  const changed_paths = raw.changed_paths.map(normalizePath);
  if (new Set(changed_paths).size !== changed_paths.length) {
    throw proposalError('changed_paths must not contain duplicates');
  }
  if (typeof raw.patch !== 'string' || !raw.patch.trim() || raw.patch.includes('\0')) {
    throw proposalError('patch must be a non-empty text unified diff without NUL bytes');
  }
  return { base_revision: raw.base_revision, changed_paths, patch: raw.patch };
}

function patchPaths(patch: string): string[] {
  if (/^GIT binary patch$/m.test(patch) || /^Binary files /m.test(patch)) {
    throw proposalError('binary patches are not allowed');
  }
  const lines = patch.split('\n');
  const paths: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match) {
      continue;
    }
    const oldPath = normalizePath(match[1]);
    const newPath = normalizePath(match[2]);
    if (oldPath !== newPath) {
      throw proposalError('renames are not allowed');
    }
    const sectionEnd = lines.findIndex((line, offset) => offset > index && line.startsWith('diff --git '));
    const section = lines.slice(index + 1, sectionEnd === -1 ? undefined : sectionEnd);
    if (section.some(line => /^(?:old mode|new mode|similarity index|rename from|rename to) /.test(line))) {
      throw proposalError(`unsupported file metadata for ${oldPath}`);
    }
    const oldHeaderIndex = section.findIndex(line => line === `--- a/${oldPath}`);
    const newHeaderIndex = oldHeaderIndex >= 0 ? section.findIndex(line => line === `+++ b/${newPath}`) : -1;
    if (oldHeaderIndex < 0 || newHeaderIndex !== oldHeaderIndex + 1) {
      throw proposalError(`malformed unified diff headers for ${oldPath}`);
    }
    paths.push(oldPath);
  }
  if (!paths.length) {
    throw proposalError('patch must contain at least one standard git unified diff');
  }
  if (new Set(paths).size !== paths.length) {
    throw proposalError('patch must not contain duplicate file sections');
  }
  return paths;
}

async function git(args: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      reject(new Error(error.message));
    });
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error((stderr.trim() || `git exited ${code ?? 'null'}`).slice(0, 500)));
      }
    });
    child.stdin.end(input);
  });
}

async function assertBaseRevision(worktreePath: string, expected: string): Promise<void> {
  const actual = (await git(['rev-parse', 'HEAD'], worktreePath)).trim();
  if (actual !== expected) {
    throw new Error(`Codex patch base revision is stale: expected ${expected}, found ${actual}`);
  }
}

export async function applyCodexPatchProposal(opts: ApplyCodexPatchOptions): Promise<{ changedPaths: string[] }> {
  const proposal = parseCodexPatchProposal(opts.proposal);
  const paths = patchPaths(proposal.patch);
  const declared = new Set(proposal.changed_paths);
  if (paths.length !== declared.size || paths.some(filePath => !declared.has(filePath))) {
    throw proposalError('changed_paths must exactly match the patch file paths');
  }
  if (!opts.writeScope.length || paths.some(filePath => !matchesPathScope(filePath, opts.writeScope))) {
    throw new Error('Codex patch is outside the task write scope');
  }

  await assertBaseRevision(opts.worktreePath, proposal.base_revision);
  await git(['apply', '--check', '--whitespace=error'], opts.worktreePath, proposal.patch);

  const approval = await (opts.requestApproval ?? requestPermission)(opts.agentId, 'apply_patch', {
    base_revision: proposal.base_revision,
    changed_paths: paths,
  });
  if (approval !== 'allow') {
    throw new Error('Codex patch application was denied');
  }

  // The project may have changed while the approval dialog was visible. Recheck
  // both invariants immediately before Swarm performs its only mutation.
  await assertBaseRevision(opts.worktreePath, proposal.base_revision);
  await git(['apply', '--check', '--whitespace=error'], opts.worktreePath, proposal.patch);
  await git(['apply', '--whitespace=error'], opts.worktreePath, proposal.patch);
  return { changedPaths: paths };
}
