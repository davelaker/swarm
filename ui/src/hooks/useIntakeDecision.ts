import { useEffect, useRef, useState } from 'react';
import {
  isExecutionShape,
  isIntakeConfidence,
  isIntakeRiskSignal,
  type ExecutionShape,
  type IntakeDecision,
} from '../data/intake';

export type IntakeDecisionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; decision: IntakeDecision }
  | { status: 'error'; error: string };

interface IntakeDecisionResult {
  requestKey: string;
  state: Extract<IntakeDecisionState, { status: 'success' | 'error' }>;
}

function parseDecision(raw: unknown): IntakeDecision {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('classifier returned an invalid decision');
  }

  const body = raw as Record<string, unknown>;
  if (!isExecutionShape(body.shape)) {
    throw new Error('classifier returned an unknown execution shape');
  }
  if (typeof body.rationale !== 'string' || !body.rationale.trim()) {
    throw new Error('classifier returned an empty rationale');
  }
  if (!isIntakeConfidence(body.confidence)) {
    throw new Error('classifier returned an unknown confidence level');
  }
  if (!Array.isArray(body.riskSignals) || !body.riskSignals.every(isIntakeRiskSignal)) {
    throw new Error('classifier returned invalid risk signals');
  }
  if (typeof body.suggestedAction !== 'string' || !body.suggestedAction.trim()) {
    throw new Error('classifier returned an empty suggested action');
  }

  return {
    shape: body.shape,
    rationale: body.rationale,
    confidence: body.confidence,
    riskSignals: body.riskSignals,
    suggestedAction: body.suggestedAction,
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) {
      return body.error;
    }
  } catch {
    /* fall through to generic status */
  }

  return `classifier request failed (${response.status})`;
}

export function useIntakeDecision(
  instruction: string,
  requestedShape?: ExecutionShape,
): IntakeDecisionState {
  const trimmedInstruction = instruction.trim();
  const requestKey = `${requestedShape ?? 'auto'}:${trimmedInstruction}`;
  const [result, setResult] = useState<IntakeDecisionResult | null>(null);
  const activeRequestKey = useRef('');

  useEffect(() => {
    if (!trimmedInstruction) {
      return;
    }

    const controller = new AbortController();
    activeRequestKey.current = requestKey;

    fetch('/intake/classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: trimmedInstruction,
        ...(requestedShape ? { requestedShape } : {}),
      }),
      signal: controller.signal,
    })
      .then(async response => {
        if (!response.ok) {
          throw new Error(await readError(response));
        }

        return parseDecision(await response.json());
      })
      .then(decision => {
        if (activeRequestKey.current === requestKey) {
          setResult({ requestKey, state: { status: 'success', decision } });
        }
      })
      .catch(error => {
        if (controller.signal.aborted || activeRequestKey.current !== requestKey) {
          return;
        }

        setResult({
          requestKey,
          state: {
            status: 'error',
            error: error instanceof Error ? error.message : 'classifier request failed',
          },
        });
      });

    return () => {
      controller.abort();
    };
  }, [requestKey, requestedShape, trimmedInstruction]);

  if (!trimmedInstruction) {
    return { status: 'idle' };
  }
  if (result?.requestKey === requestKey) {
    return result.state;
  }

  return { status: 'loading' };
}
