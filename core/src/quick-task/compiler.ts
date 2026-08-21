import type { BudgetClass } from '../routing/index.js';
import { recommendRoute } from '../routing/index.js';
import type { ProviderAvailability } from '../providers/index.js';
import type { RunCharter, TaskGraphEntry, TaskRoute, Tier } from '../state/types.js';
import { evaluateQuickTaskPolicy } from './policy.js';
import { inferQuickTaskWriteScope, quickScopeLimit, validWriteScope } from './scope.js';

export interface QuickTaskSpec {
  goal: string;
  acceptanceCriteria: string[];
  declaredWriteScope: string[];
  verificationCommands: string[];
  route: TaskRoute;
}

export interface QuickTaskRunDefinition {
  executionShape: 'quick_task';
  goal: string;
  tier: Tier;
  charter: RunCharter;
  taskGraph: TaskGraphEntry[];
}

export type QuickTaskPreflight =
  | { ok: true; spec: QuickTaskSpec; scopeReason: string }
  | { ok: false; escalationReason: string; riskSignals: string[] };

export interface QuickTaskPreflightInput {
  instruction: string;
  projectRoot: string;
  providerAvailability: readonly ProviderAvailability[];
  availableModelIds?: readonly string[];
  budgetClass?: BudgetClass;
}

const SENSITIVE_PATTERNS = [
  /\b(auth|authentication|authorization|permission|access control|rbac|acl)\b/i,
  /\b(password|secret|token|api key|credential|oauth)\b/i,
  /\b(sql|query|database|db|crypto|hash|encrypt|decrypt|shell)\b/i,
  /(?:^|\/)(auth|crypto|security|permissions?)(?:\/|$)/i,
];

const BROAD_PATTERNS = [
  /\b(across the codebase|entire codebase|whole app|whole project)\b/i,
  /\b(overhaul|rewrite|re-architect|replace the .* layer)\b/i,
  /\b(frontend and backend|api and ui|server and client)\b/i,
];

function nonEmptyList(values: readonly string[]): string[] {
  return values.map(value => value.trim()).filter(Boolean);
}

function riskSignals(instruction: string, scopes: readonly string[]): {
  touchesSensitivePaths: boolean;
  broadScope: boolean;
} {
  const haystack = [instruction, ...scopes].join('\n');
  return {
    touchesSensitivePaths: SENSITIVE_PATTERNS.some(pattern => pattern.test(haystack)),
    broadScope: BROAD_PATTERNS.some(pattern => pattern.test(instruction)),
  };
}

function verificationCommands(scopes: readonly string[]): string[] {
  const roots = new Set(scopes.map(scope => scope.split('/')[0]).filter(Boolean));
  const commands: string[] = [];
  if (roots.has('core')) {
    commands.push('cd core && npm test');
  }
  if (roots.has('ui')) {
    commands.push('cd ui && npm run typecheck && npm test');
  }
  if (!commands.length) {
    commands.push("Run the repository's focused tests for the changed files.");
  }
  return commands;
}

function acceptanceCriteria(goal: string, scopes: readonly string[], commands: readonly string[]): string[] {
  return [
    `Implement the requested change: ${goal}`,
    `Modify only the declared write scope: ${scopes.join(', ')}`,
    `Verify with: ${commands.join(' | ')}`,
    'Leave unrelated files unchanged.',
  ];
}

function taskTitle(spec: QuickTaskSpec): string {
  return [
    spec.goal,
    '',
    'Acceptance criteria:',
    ...spec.acceptanceCriteria.map(item => `- ${item}`),
    '',
    'Verification:',
    ...spec.verificationCommands.map(command => `- ${command}`),
  ].join('\n');
}

export function compileQuickTask(spec: QuickTaskSpec): QuickTaskRunDefinition {
  const goal = spec.goal.trim();
  const acceptance = nonEmptyList(spec.acceptanceCriteria);
  const verification = nonEmptyList(spec.verificationCommands);
  const writeScope = [...new Set(spec.declaredWriteScope.map(scope => scope.trim()))];

  if (!goal) {
    throw new Error('Quick task goal is required.');
  }
  if (!acceptance.length) {
    throw new Error('Quick task acceptance criteria are required.');
  }
  if (!verification.length) {
    throw new Error('Quick task verification commands are required.');
  }
  if (!writeScope.length || writeScope.some(scope => !validWriteScope(scope))) {
    throw new Error('Quick task requires a non-empty safe declared write scope.');
  }
  if (spec.route.provider !== 'openai' && spec.route.provider !== 'anthropic') {
    throw new Error('Quick task route must use a supported provider.');
  }
  if (spec.route.writeScope.length !== writeScope.length || spec.route.writeScope.some((scope, index) => scope !== writeScope[index])) {
    throw new Error('Quick task route write scope must match the declared write scope exactly.');
  }

  const taskGraph: TaskGraphEntry[] = [
    {
      id: 't_quick',
      assignee: 'coder',
      title: taskTitle({ ...spec, goal, acceptanceCriteria: acceptance, verificationCommands: verification, declaredWriteScope: writeScope }),
      depends_on: [],
      model: spec.route.model,
      effort: spec.route.reasoningEffort,
      route: spec.route,
    },
  ];

  return {
    executionShape: 'quick_task',
    goal,
    tier: 'bugfix',
    charter: {
      constraints: acceptance,
      nongoals: [
        'Do not expand beyond the declared quick-task write scope without escalating.',
        'Do not introduce a multi-agent review graph unless a gate or sensitive path requires it.',
      ],
      questions: [],
      quickTask: {
        declaredWriteScope: writeScope,
        verificationCommands: verification,
        acceptanceCriteria: acceptance,
      },
      taskGraph,
    },
    taskGraph,
  };
}

export function preflightQuickTask(input: QuickTaskPreflightInput): QuickTaskPreflight {
  const goal = input.instruction.trim();
  if (!goal) {
    return {
      ok: false,
      escalationReason: 'Quick task needs a non-empty instruction.',
      riskSignals: ['unclear_scope'],
    };
  }

  const inferred = inferQuickTaskWriteScope(input.projectRoot, goal);
  const scopes = [...new Set(inferred.scopes)].filter(validWriteScope);
  const signals = riskSignals(goal, scopes);
  if (!scopes.length) {
    return {
      ok: false,
      escalationReason: 'Quick task could not establish a narrow write scope.',
      riskSignals: ['unclear_scope'],
    };
  }
  if (scopes.length > quickScopeLimit()) {
    return {
      ok: false,
      escalationReason: `Quick task matched more than ${quickScopeLimit()} possible files.`,
      riskSignals: ['multiple_subsystems'],
    };
  }

  const policy = evaluateQuickTaskPolicy({
    approvedWriteScope: scopes,
    discoveredPaths: scopes,
    estimatedEffort: 'small',
    requestedShape: 'quick_task',
    touchesSensitivePaths: signals.touchesSensitivePaths,
    verificationScope: signals.broadScope ? 'broad' : 'focused',
  });
  if (!policy.allowed) {
    return {
      ok: false,
      escalationReason: policy.summary,
      riskSignals: policy.reasons,
    };
  }

  try {
    const recommendation = recommendRoute({
      intent: 'execution',
      scope: 'small',
      risk: 'low',
      writeAccess: 'brokered',
      writeScope: scopes,
      dependencyCount: 0,
      deterministic: false,
      budgetClass: input.budgetClass ?? 'balanced',
      providerAvailability: input.providerAvailability,
      availableModelIds: input.availableModelIds,
    });
    if (recommendation.kind !== 'model') {
      return {
        ok: false,
        escalationReason: 'Quick task could not select an executable model route.',
        riskSignals: ['unavailable_route'],
      };
    }
    if (recommendation.route.requiresConfirmation) {
      return {
        ok: false,
        escalationReason: 'Quick task route requires explicit cost or risk confirmation.',
        riskSignals: ['route_confirmation_required'],
      };
    }
    const commands = verificationCommands(scopes);
    return {
      ok: true,
      scopeReason: inferred.reason,
      spec: {
        goal,
        declaredWriteScope: scopes,
        verificationCommands: commands,
        acceptanceCriteria: acceptanceCriteria(goal, scopes, commands),
        route: recommendation.route,
      },
    };
  } catch (err) {
    return {
      ok: false,
      escalationReason: (err as Error).message,
      riskSignals: ['unavailable_route'],
    };
  }
}
