import { describe, expect, it, vi } from 'vitest';
import { createProjectClient, ProjectMismatchError, StaleProjectGenerationError } from './projectClient';
import { projectSurfaceKey } from './surface';
import type { ProjectEnvelope } from './types';

const projectA: ProjectEnvelope = {
  projectId: 'project:v1:a',
  projectRoot: '/tmp/a',
  projectName: 'a',
};

const projectB: ProjectEnvelope = {
  projectId: 'project:v1:b',
  projectRoot: '/tmp/b',
  projectName: 'b',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('project client', () => {
  it('adds the expected project header to project-bound requests', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ projectEnvelope: projectA, ok: true }));
    const client = createProjectClient({
      project: projectA,
      generation: 1,
      signal: new AbortController().signal,
      isCurrentGeneration: generation => generation === 1,
    });

    await client.fetchJson('/state');

    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get('X-Swarm-Project-Id')).toBe(projectA.projectId);
    fetchMock.mockRestore();
  });

  it('rejects responses enveloped for a different project', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ projectEnvelope: projectB, ok: true }));
    const client = createProjectClient({
      project: projectA,
      generation: 1,
      signal: new AbortController().signal,
      isCurrentGeneration: generation => generation === 1,
    });

    await expect(client.fetchJson('/sessions')).rejects.toBeInstanceOf(ProjectMismatchError);
    fetchMock.mockRestore();
  });

  it('rejects delayed responses from stale project generations', async () => {
    let currentGeneration = 1;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      currentGeneration = 2;
      return jsonResponse({ projectEnvelope: projectA, ok: true });
    });
    const client = createProjectClient({
      project: projectA,
      generation: 1,
      signal: new AbortController().signal,
      isCurrentGeneration: generation => generation === currentGeneration,
    });

    await expect(client.fetchJson('/branches')).rejects.toBeInstanceOf(
      StaleProjectGenerationError,
    );
    fetchMock.mockRestore();
  });

  it('ignores SSE events for stale generations or the wrong project', () => {
    let currentGeneration = 1;
    const client = createProjectClient({
      project: projectA,
      generation: 1,
      signal: new AbortController().signal,
      isCurrentGeneration: generation => generation === currentGeneration,
    });

    expect(client.acceptsEvent({ type: 'run.completed', projectEnvelope: projectA })).toBe(true);
    expect(client.acceptsEvent({ type: 'run.completed', projectEnvelope: projectB })).toBe(false);
    currentGeneration = 2;
    expect(client.acceptsEvent({ type: 'run.completed', projectEnvelope: projectA })).toBe(false);
  });

  it('uses project identity, not project name, for surface reset keys', () => {
    const sameNameDifferentRoot: ProjectEnvelope = {
      projectId: 'project:v1:c',
      projectRoot: '/other/a',
      projectName: 'a',
    };

    expect(projectSurfaceKey(projectA, 1)).not.toBe(projectSurfaceKey(sameNameDifferentRoot, 1));
    expect(projectSurfaceKey(projectA, 1)).not.toBe(projectSurfaceKey(projectA, 2));
  });
});
