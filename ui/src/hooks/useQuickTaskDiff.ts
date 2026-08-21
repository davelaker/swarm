import { useEffect, useState } from 'react';
import type { QuickTaskFileChange } from '../data/quickTask';

interface StructuredDiffFile {
  path: string;
  status: QuickTaskFileChange['status'];
  additions: number;
  deletions: number;
}

interface StructuredDiffResponse {
  files: StructuredDiffFile[];
}

function isStructuredDiffFile(value: unknown): value is StructuredDiffFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const file = value as Record<string, unknown>;
  return (
    typeof file.path === 'string' &&
    (file.status === 'added' ||
      file.status === 'modified' ||
      file.status === 'deleted' ||
      file.status === 'renamed') &&
    typeof file.additions === 'number' &&
    typeof file.deletions === 'number'
  );
}

function parseChangedFiles(value: unknown): QuickTaskFileChange[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const files = (value as Partial<StructuredDiffResponse>).files;
  if (!Array.isArray(files)) {
    return [];
  }
  return files.filter(isStructuredDiffFile).map(file => ({
    ...file,
    summary: `${file.additions} additions and ${file.deletions} deletions`,
  }));
}

export function useQuickTaskDiff(
  active: boolean,
  taskId: string,
  revisionKey: string,
  polling: boolean,
): QuickTaskFileChange[] {
  const [result, setResult] = useState<{ key: string; files: QuickTaskFileChange[] } | null>(null);

  useEffect(() => {
    if (!active) {
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      fetch(`/run/task-diff?task=${encodeURIComponent(taskId)}`, { signal: controller.signal })
        .then(response =>
          response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)),
        )
        .then(body => setResult({ key: revisionKey, files: parseChangedFiles(body) }))
        .catch(() => {
          if (!controller.signal.aborted) {
            setResult({ key: revisionKey, files: [] });
          }
        })
        .finally(() => {
          if (polling && !controller.signal.aborted) {
            timer = setTimeout(load, 1_500);
          }
        });
    };
    load();
    return () => {
      controller.abort();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [active, polling, revisionKey, taskId]);

  return result?.key === revisionKey ? result.files : [];
}
