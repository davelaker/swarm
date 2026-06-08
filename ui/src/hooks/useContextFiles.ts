import { useState, useEffect } from 'react';

export interface ContextFile {
  relPath: string;
  content: string;
}

export interface ContextData {
  projectMd:    ContextFile | null;
  contextFiles: ContextFile[];
}

export function useContextFiles(): ContextData {
  const [data, setData] = useState<ContextData>({ projectMd: null, contextFiles: [] });

  useEffect(() => {
    const load = () => {
      fetch('/context')
        .then(r => r.ok ? r.json() as Promise<ContextData> : null)
        .then(d => { if (d) setData(d); })
        .catch(() => {});
    };
    load();
    const iv = setInterval(load, 10_000);
    return () => clearInterval(iv);
  }, []);

  return data;
}
