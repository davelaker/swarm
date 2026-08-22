export interface ProjectEnvelope {
  projectId: string;
  projectRoot: string;
  projectName: string;
}

export interface ProjectReadiness {
  repoUrl?: string | null;
  activeRun?: boolean;
}

export type ProjectContextState =
  | { status: 'booting'; generation: number }
  | {
      status: 'switching';
      generation: number;
      requestedRoot: string;
      previous?: ProjectEnvelope;
    }
  | {
      status: 'ready';
      generation: number;
      project: ProjectEnvelope;
      readiness: ProjectReadiness;
    }
  | { status: 'error'; generation: number; message: string; previous?: ProjectEnvelope };

export interface ProjectRequestContext {
  project: ProjectEnvelope;
  generation: number;
  signal: AbortSignal;
  isCurrentGeneration: (generation: number) => boolean;
}
