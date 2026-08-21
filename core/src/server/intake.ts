import { classifyIntakeInput } from '../intake/index.js';
import type { ExecutionShape, IntakeDecision } from '../intake/types.js';
import type { Validation } from './validate.js';

const MAX_INSTRUCTION_CHARS = 20_000;
const EXECUTION_SHAPES = new Set<ExecutionShape>([
  'answer',
  'quick_task',
  'plan',
  'coordinated_run',
]);

export interface IntakeClassifyRequest {
  instruction: string;
  requestedShape?: ExecutionShape;
}

export type PmExecutionShape = ExecutionShape | undefined;

export type IntakeClassifyResponse =
  | { status: 200; body: IntakeDecision }
  | { status: 400; body: { error: string } };

function fail<T = IntakeClassifyRequest>(error: string): Validation<T> {
  return { ok: false, error };
}

function isExecutionShape(value: string): value is ExecutionShape {
  return EXECUTION_SHAPES.has(value as ExecutionShape);
}

export function validatePmExecutionShape(raw: unknown): Validation<PmExecutionShape> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('request body must be an object');
  }

  const executionShape = (raw as Record<string, unknown>).executionShape;
  if (executionShape === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof executionShape !== 'string' || !isExecutionShape(executionShape)) {
    return fail('executionShape must be answer, quick_task, plan, or coordinated_run');
  }

  return { ok: true, value: executionShape };
}

export function validateIntakeClassifyRequest(raw: unknown): Validation<IntakeClassifyRequest> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('request body must be an object');
  }

  const payload = raw as Record<string, unknown>;
  if (typeof payload.instruction !== 'string') {
    return fail('instruction required');
  }

  const instruction = payload.instruction.trim();
  if (!instruction) {
    return fail('instruction required');
  }
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    return fail(`instruction too large (max ${MAX_INSTRUCTION_CHARS} chars)`);
  }

  const requestedShape = payload.requestedShape;
  if (requestedShape === undefined) {
    return { ok: true, value: { instruction } };
  }
  if (typeof requestedShape !== 'string' || !isExecutionShape(requestedShape)) {
    return fail('requestedShape must be answer, quick_task, plan, or coordinated_run');
  }

  return { ok: true, value: { instruction, requestedShape } };
}

export async function classifyIntakeRequest(raw: unknown): Promise<IntakeClassifyResponse> {
  const valid = validateIntakeClassifyRequest(raw);
  if (!valid.ok) {
    return { status: 400, body: { error: valid.error } };
  }

  return { status: 200, body: classifyIntakeInput(valid.value) };
}
