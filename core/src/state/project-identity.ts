import { createHash } from 'node:crypto';
import path from 'node:path';

export interface ProjectEnvelope {
  projectId: string;
  projectRoot: string;
  projectName: string;
}

export interface ProjectMismatchError {
  error: 'project_mismatch';
  expectedProjectId: string;
  activeProject: ProjectEnvelope;
}

export function canonicalProjectRoot(candidateRoot: string): string {
  return path.resolve(candidateRoot.trim());
}

export function projectIdForRoot(canonicalRoot: string): string {
  const digest = createHash('sha256').update(canonicalRoot).digest('hex');
  return `project:v1:${digest}`;
}

export function projectEnvelopeForRoot(candidateRoot: string): ProjectEnvelope {
  const projectRoot = canonicalProjectRoot(candidateRoot);
  return {
    projectId: projectIdForRoot(projectRoot),
    projectRoot,
    projectName: path.basename(projectRoot),
  };
}

export function validateExpectedProjectId(
  expectedProjectId: string | undefined,
  activeProject: ProjectEnvelope,
): ProjectMismatchError | null {
  if (!expectedProjectId || expectedProjectId === activeProject.projectId) {
    return null;
  }
  return {
    error: 'project_mismatch',
    expectedProjectId,
    activeProject,
  };
}
