import { useEffect, useState } from 'react';
import {
  defaultModelPolicyState,
  normalizeModelPolicyResponse,
  type ModelPolicyResponse,
  type ModelPolicySnapshot,
} from '../data/modelPolicy';
import { useProjectClient } from '../project/ProjectClientContext';

export function useProjectModelPolicy(): ModelPolicySnapshot {
  const projectClient = useProjectClient();
  const [policy, setPolicy] = useState<ModelPolicySnapshot>(defaultModelPolicyState);

  useEffect(() => {
    let cancelled = false;
    projectClient
      .fetchJson<ModelPolicyResponse>('/providers/models', { allowMissingEnvelope: true })
      .then(response => {
        if (!cancelled && !projectClient.isStale()) {
          setPolicy(previous => normalizeModelPolicyResponse(response, previous));
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [projectClient]);

  return policy;
}
