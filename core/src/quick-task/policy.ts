import { matchesPathScope } from '../permission-proxy/scope-guard.js';
import type { ExecutionShape } from '../intake/types.js';

export type QuickTaskPolicyReason =
  | 'broad_verification'
  | 'destructive_change'
  | 'explicit_coordinated_run'
  | 'explicit_plan_request'
  | 'large_effort'
  | 'migration'
  | 'multiple_subsystems'
  | 'scope_expansion'
  | 'security_sensitive'
  | 'unclear_scope'
  | 'unresolved_decision';

export interface QuickTaskPolicyInput {
  approvedWriteScope: string[];
  discoveredPaths: string[];
  estimatedEffort?: 'small' | 'medium' | 'large';
  requestedShape?: ExecutionShape;
  requiresDestructiveOperation?: boolean;
  requiresMigration?: boolean;
  subsystemHints?: string[];
  touchesSensitivePaths?: boolean;
  unresolvedDecision?: boolean;
  verificationScope?: 'focused' | 'broad';
}

export interface QuickTaskPolicyVerdict {
  allowed: boolean;
  reasons: QuickTaskPolicyReason[];
  summary: string;
}

export function evaluateQuickTaskPolicy(input: QuickTaskPolicyInput): QuickTaskPolicyVerdict {
  const reasons = collectReasons(input);

  if (reasons.length === 0) {
    return {
      allowed: true,
      reasons: [],
      summary: 'Quick task can proceed with a narrow write scope and focused checks.',
    };
  }

  return {
    allowed: false,
    reasons,
    summary: 'Quick task should escalate before continuing because inspection found broader scope or risk.',
  };
}

function collectReasons(input: QuickTaskPolicyInput): QuickTaskPolicyReason[] {
  const reasons: QuickTaskPolicyReason[] = [];

  if (input.requestedShape === 'coordinated_run') {
    reasons.push('explicit_coordinated_run');
  }
  if (input.requestedShape === 'plan') {
    reasons.push('explicit_plan_request');
  }
  if (input.approvedWriteScope.length === 0 || input.discoveredPaths.length === 0) {
    reasons.push('unclear_scope');
  }
  if (hasScopeExpansion(input.discoveredPaths, input.approvedWriteScope)) {
    reasons.push('scope_expansion');
  }
  if (input.touchesSensitivePaths) {
    reasons.push('security_sensitive');
  }
  if (input.requiresMigration) {
    reasons.push('migration');
  }
  if (input.requiresDestructiveOperation) {
    reasons.push('destructive_change');
  }
  if (hasMultipleSubsystems(input)) {
    reasons.push('multiple_subsystems');
  }
  if (input.unresolvedDecision) {
    reasons.push('unresolved_decision');
  }
  if (input.verificationScope === 'broad') {
    reasons.push('broad_verification');
  }
  if (input.estimatedEffort === 'large') {
    reasons.push('large_effort');
  }

  return reasons;
}

function hasScopeExpansion(discoveredPaths: string[], approvedWriteScope: string[]): boolean {
  if (approvedWriteScope.length === 0) {
    return false;
  }

  return discoveredPaths.some(path => !matchesPathScope(path, approvedWriteScope));
}

function hasMultipleSubsystems(input: QuickTaskPolicyInput): boolean {
  if (input.subsystemHints && new Set(input.subsystemHints.filter(Boolean)).size > 1) {
    return true;
  }

  const roots = new Set(
    input.discoveredPaths
      .map(path => normalizeRoot(path))
      .filter((root): root is string => root !== null),
  );

  return roots.size > 1;
}

function normalizeRoot(relPath: string): string | null {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized) {
    return null;
  }

  const firstSegment = normalized.split('/')[0];
  return firstSegment || null;
}
