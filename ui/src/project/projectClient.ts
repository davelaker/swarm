import { extractProjectEnvelope, sameProject } from './envelope';
import type { ProjectEnvelope, ProjectRequestContext } from './types';

export class ProjectMismatchError extends Error {
  readonly expectedProject: ProjectEnvelope;
  readonly receivedProject: ProjectEnvelope;

  constructor(expectedProject: ProjectEnvelope, receivedProject: ProjectEnvelope) {
    super(
      `Project mismatch: expected ${expectedProject.projectName}, received ${receivedProject.projectName}`,
    );
    this.name = 'ProjectMismatchError';
    this.expectedProject = expectedProject;
    this.receivedProject = receivedProject;
  }
}

export class StaleProjectGenerationError extends Error {
  readonly generation: number;

  constructor(generation: number) {
    super(`Ignored stale project generation ${generation}`);
    this.name = 'StaleProjectGenerationError';
    this.generation = generation;
  }
}

export interface ProjectFetchOptions extends RequestInit {
  allowMissingEnvelope?: boolean;
}

export interface ProjectClient {
  readonly project: ProjectEnvelope;
  readonly generation: number;
  readonly identityKey: string;
  fetchJson: <T>(input: RequestInfo | URL, init?: ProjectFetchOptions) => Promise<T>;
  fetchResponse: (input: RequestInfo | URL, init?: ProjectFetchOptions) => Promise<Response>;
  eventSource: (path: string) => EventSource;
  isStale: () => boolean;
  assertCurrent: () => void;
  acceptsEvent: (event: unknown) => boolean;
}

function mergeSignals(left?: AbortSignal | null, right?: AbortSignal | null): AbortSignal | undefined {
  if (!left) {
    return right ?? undefined;
  }
  if (!right) {
    return left;
  }
  return AbortSignal.any([left, right]);
}

export function projectHeaders(project: ProjectEnvelope, init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set('X-Swarm-Project-Id', project.projectId);
  return headers;
}

async function parseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function unwrapProjectData(body: unknown): unknown {
  if (typeof body === 'object' && body !== null && 'data' in body && extractProjectEnvelope(body)) {
    return (body as { data: unknown }).data;
  }
  return body;
}

function validateEnvelope(body: unknown, expectedProject: ProjectEnvelope, allowMissing: boolean): void {
  const receivedProject = extractProjectEnvelope(body);
  if (!receivedProject) {
    if (allowMissing) {
      return;
    }
    return;
  }
  if (!sameProject(expectedProject, receivedProject)) {
    throw new ProjectMismatchError(expectedProject, receivedProject);
  }
}

export function createProjectClient(context: ProjectRequestContext): ProjectClient {
  const assertCurrent = () => {
    if (!context.isCurrentGeneration(context.generation) || context.signal.aborted) {
      throw new StaleProjectGenerationError(context.generation);
    }
  };

  const fetchResponse = async (
    input: RequestInfo | URL,
    init: ProjectFetchOptions = {},
  ): Promise<Response> => {
    assertCurrent();
    const response = await fetch(input, {
      ...init,
      headers: projectHeaders(context.project, init.headers),
      signal: mergeSignals(context.signal, init.signal),
    });
    assertCurrent();
    const contentType = response.headers.get('content-type') ?? '';
    if (response.ok && contentType.includes('json')) {
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      validateEnvelope(body, context.project, init.allowMissingEnvelope ?? true);
      assertCurrent();
    }
    return response;
  };

  const fetchJson = async <T>(
    input: RequestInfo | URL,
    init: ProjectFetchOptions = {},
  ): Promise<T> => {
    const response = await fetchResponse(input, init);
    const body = await parseJson(response);
    assertCurrent();
    if (!response.ok) {
      const message =
        typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : `HTTP ${response.status}`;
      throw new Error(message);
    }
    validateEnvelope(body, context.project, init.allowMissingEnvelope ?? true);
    assertCurrent();
    return unwrapProjectData(body) as T;
  };

  const eventSource = (path: string): EventSource => {
    assertCurrent();
    const url = new URL(path, window.location.origin);
    url.searchParams.set('projectId', context.project.projectId);
    url.searchParams.set('generation', String(context.generation));
    return new EventSource(`${url.pathname}${url.search}`);
  };

  return {
    project: context.project,
    generation: context.generation,
    identityKey: `${context.project.projectId}:${context.generation}`,
    fetchJson,
    fetchResponse,
    eventSource,
    isStale: () =>
      !context.isCurrentGeneration(context.generation) || context.signal.aborted,
    assertCurrent,
    acceptsEvent: event => {
      if (!context.isCurrentGeneration(context.generation) || context.signal.aborted) {
        return false;
      }
      const eventEnvelope = extractProjectEnvelope(event);
      if (!eventEnvelope) {
        return true;
      }
      return sameProject(context.project, eventEnvelope);
    },
  };
}
