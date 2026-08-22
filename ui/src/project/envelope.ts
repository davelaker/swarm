import type { ProjectEnvelope } from './types';

const PROJECT_PREFIX = 'project:v1:';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isProjectEnvelopeLike(value: unknown): value is ProjectEnvelope {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.projectId === 'string' &&
    typeof value.projectRoot === 'string' &&
    typeof value.projectName === 'string'
  );
}

export function extractProjectEnvelope(value: unknown): ProjectEnvelope | null {
  if (isProjectEnvelopeLike(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return null;
  }

  const candidates = [
    value.projectEnvelope,
    value.envelope,
    value.project,
    value.activeProject,
  ];
  for (const candidate of candidates) {
    if (isProjectEnvelopeLike(candidate)) {
      return candidate;
    }
  }

  return null;
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function projectIdFromRoot(projectRoot: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(projectRoot),
  );
  return `${PROJECT_PREFIX}${toHex(digest)}`;
}

export function projectNameFromRoot(projectRoot: string): string {
  const parts = projectRoot.split('/').filter(Boolean);
  return parts.at(-1) ?? (projectRoot || 'project');
}

export async function legacyProjectEnvelope(input: {
  project?: string | null;
  root?: string | null;
  projectRoot?: string | null;
  projectName?: string | null;
}): Promise<ProjectEnvelope | null> {
  const projectRoot = input.projectRoot ?? input.root;
  if (!projectRoot) {
    return null;
  }
  return {
    projectId: await projectIdFromRoot(projectRoot),
    projectRoot,
    projectName: input.projectName ?? input.project ?? projectNameFromRoot(projectRoot),
  };
}

export async function envelopeFromResponse(value: unknown): Promise<ProjectEnvelope | null> {
  const envelope = extractProjectEnvelope(value);
  if (envelope) {
    return envelope;
  }
  if (!isRecord(value)) {
    return null;
  }
  return legacyProjectEnvelope({
    project: typeof value.project === 'string' ? value.project : null,
    root: typeof value.root === 'string' ? value.root : null,
    projectRoot: typeof value.projectRoot === 'string' ? value.projectRoot : null,
    projectName: typeof value.projectName === 'string' ? value.projectName : null,
  });
}

export function sameProject(left: ProjectEnvelope, right: ProjectEnvelope): boolean {
  return left.projectId === right.projectId;
}
