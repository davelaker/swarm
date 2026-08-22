import { getConfig } from '../config.js';
import { checkGitClean, runCompiledRun } from '../commands/new.js';
import { getRoot } from '../state/repo.js';
import { getProviderModelPolicy } from '../providers/index.js';
import { compileQuickTask, preflightQuickTask, type QuickTaskPreflight } from './compiler.js';

export type QuickTaskRunResult =
  | { status: 'started'; preflight: Extract<QuickTaskPreflight, { ok: true }> }
  | { status: 'escalated'; reason: string; riskSignals: string[] };

export async function runQuickTask(instruction: string): Promise<QuickTaskRunResult> {
  const cfg = getConfig();
  const root = getRoot();
  try {
    checkGitClean(root);
  } catch (err) {
    return {
      status: 'escalated',
      reason: (err as Error).message,
      riskSignals: ['unclear_scope'],
    };
  }
  const preflight = preflightQuickTask({
    instruction,
    projectRoot: root,
    providerAvailability: cfg.providerSelection.availability,
    availableModelIds: getProviderModelPolicy().enabledModelIds,
    budgetClass: 'balanced',
  });

  if (!preflight.ok) {
    return {
      status: 'escalated',
      reason: preflight.escalationReason,
      riskSignals: preflight.riskSignals,
    };
  }

  const compiled = compileQuickTask(preflight.spec);
  await runCompiledRun(compiled);
  return { status: 'started', preflight };
}
