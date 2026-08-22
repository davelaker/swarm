import type { ProjectEnvelope } from './types';

export function projectSurfaceKey(project: ProjectEnvelope, generation: number): string {
  return `${project.projectId}:${generation}`;
}
