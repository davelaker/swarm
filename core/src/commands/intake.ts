import { classifyIntakeInput, type ExecutionShape, type IntakeDecision } from '../intake/index.js';
import type { PmResponse } from '../pm/index.js';
import type { QuickTaskRunResult } from '../quick-task/index.js';

export interface IntakeCommand {
  command: 'ask' | 'do' | 'plan' | 'swarm' | 'auto';
  instruction: string;
}

export interface IntakeRunResult {
  exitCode: number;
  exitProcess: boolean;
}

interface PmReplyRequest {
  instruction: string;
  shape: 'answer' | 'plan';
}

export interface IntakeRuntimeDeps {
  classifyInput?: typeof classifyIntakeInput;
  runNew?: (goal: string) => Promise<void>;
  runQuickTask?: (goal: string) => Promise<QuickTaskRunResult>;
  runPmReply?: (request: PmReplyRequest) => Promise<PmResponse>;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
}

const DEFAULT_DEPS: Required<IntakeRuntimeDeps> = {
  classifyInput: classifyIntakeInput,
  runNew: async goal => {
    const { runNew } = await import('./new.js');
    await runNew(goal);
  },
  runQuickTask: async goal => {
    const { runQuickTask } = await import('../quick-task/index.js');
    return runQuickTask(goal);
  },
  runPmReply: runLightweightPmReply,
  writeStdout: line => console.log(line),
  writeStderr: line => console.error(line),
};

export async function runIntakeCommand(
  command: IntakeCommand,
  deps: IntakeRuntimeDeps = {},
): Promise<IntakeRunResult> {
  const resolved = {
    ...DEFAULT_DEPS,
    ...deps,
  };

  if (command.command === 'ask') {
    const decision = resolved.classifyInput({
      instruction: command.instruction,
      requestedShape: 'answer',
    });
    return runPmOnly(command.instruction, decision, 'answer', resolved);
  }

  if (command.command === 'plan') {
    const decision = resolved.classifyInput({
      instruction: command.instruction,
      requestedShape: 'plan',
    });
    return runPmOnly(command.instruction, decision, 'plan', resolved);
  }

  if (command.command === 'swarm') {
    await resolved.runNew(command.instruction);
    return { exitCode: 0, exitProcess: true };
  }

  if (command.command === 'do') {
    const decision = resolved.classifyInput({
      instruction: command.instruction,
      requestedShape: 'quick_task',
    });
    if (decision.shape === 'coordinated_run') {
      writeRecommendation(resolved.writeStdout, decision);
      resolved.writeStdout(
        `Use \`swarm swarm "${command.instruction}"\` to run the full reviewed workflow.`,
      );
      return { exitCode: 1, exitProcess: false };
    }
    const quickTask = await resolved.runQuickTask(command.instruction);
    if (quickTask.status === 'escalated') {
      writeRecommendation(resolved.writeStdout, decision);
      resolved.writeStdout(`Quick task paused: ${quickTask.reason}`);
      if (quickTask.riskSignals.length) {
        resolved.writeStdout(`Signals: ${quickTask.riskSignals.join(', ')}`);
      }
      resolved.writeStdout(
        `Use \`swarm swarm "${command.instruction}"\` to run the full reviewed workflow.`,
      );
      return { exitCode: 1, exitProcess: false };
    }
    return { exitCode: 0, exitProcess: true };
  }

  const decision = resolved.classifyInput({ instruction: command.instruction });
  if (decision.shape === 'answer' || decision.shape === 'plan') {
    return runPmOnly(command.instruction, decision, decision.shape, resolved);
  }

  writeRecommendation(resolved.writeStdout, decision);
  if (decision.shape === 'quick_task') {
    resolved.writeStdout(
      `Run \`swarm do "${command.instruction}"\` to approve this bounded write path.`,
    );
  } else {
    resolved.writeStdout(
      `Run \`swarm swarm "${command.instruction}"\` to use the full coordinated workflow.`,
    );
  }
  return { exitCode: 0, exitProcess: false };
}

async function runPmOnly(
  instruction: string,
  decision: IntakeDecision,
  shape: 'answer' | 'plan',
  deps: Required<IntakeRuntimeDeps>,
): Promise<IntakeRunResult> {
  const response = await deps.runPmReply({ instruction, shape });
  writeRecommendation(deps.writeStdout, decision);
  deps.writeStdout(response.reply.trim());
  return { exitCode: 0, exitProcess: false };
}

function writeRecommendation(write: (line: string) => void, decision: IntakeDecision): void {
  write(`Recommendation: ${decision.shape} (${decision.confidence} confidence)`);
  write(`Why: ${decision.rationale}`);
}

async function runLightweightPmReply(request: PmReplyRequest): Promise<PmResponse> {
  const { runPmAnswerMessage, runPmPlanMessage } = await import('../pm/index.js');
  if (request.shape === 'answer') {
    return runPmAnswerMessage(request.instruction, []);
  }
  return runPmPlanMessage(request.instruction, []);
}
