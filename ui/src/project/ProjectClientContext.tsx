import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { ProjectClient } from './projectClient';

const ProjectClientContext = createContext<ProjectClient | null>(null);

export function ProjectClientProvider({
  client,
  children,
}: {
  client: ProjectClient | null;
  children: ReactNode;
}) {
  return <ProjectClientContext.Provider value={client}>{children}</ProjectClientContext.Provider>;
}

export function useOptionalProjectClient(): ProjectClient | null {
  return useContext(ProjectClientContext);
}

export function useProjectClient(): ProjectClient {
  const client = useContext(ProjectClientContext);
  if (!client) {
    throw new Error('Project client is not ready.');
  }
  return client;
}
