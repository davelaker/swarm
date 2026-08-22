import { useState, useEffect } from 'react';
import { useProjectClient } from '../project/ProjectClientContext';

export interface ContextFile {
  relPath: string;
  content: string;
}

export interface ContextData {
  projectMd: ContextFile | null;
  contextFiles: ContextFile[];
}

export function useContextFiles(): ContextData {
  const projectClient = useProjectClient();
  const [data, setData] = useState<ContextData>({ projectMd: null, contextFiles: [] });

  useEffect(() => {
    const load = () => {
      projectClient
        .fetchJson<ContextData>('/context', { allowMissingEnvelope: true })
        .then(d => {
          if (!projectClient.isStale()) {
            setData(d);
          }
        })
        .catch(() => {});
    };
    load();
    const iv = setInterval(load, 10_000);
    return () => clearInterval(iv);
  }, [projectClient]);

  return data;
}
