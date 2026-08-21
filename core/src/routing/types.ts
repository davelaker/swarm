import type { ProviderAvailability, ProviderId, ProviderModel, ReasoningEffort } from '../providers/index.js';
import type { TaskRoute } from '../state/types.js';

export type TaskIntent = 'planning' | 'coding' | 'execution' | 'review' | 'research' | 'validation';
export type TaskScope = 'small' | 'medium' | 'large';
export type TaskRisk = 'low' | 'medium' | 'high' | 'critical';
export type WriteAccess = 'none' | 'brokered';
export type BudgetClass = 'economy' | 'balanced' | 'premium';

export interface ReviewerDiversityPreference {
  requireDifferentProvider: boolean;
  implementationProvider?: ProviderId;
}

/**
 * All routing inputs are supplied by the caller. This keeps recommendation
 * deterministic and prevents this module from observing the environment.
 */
export interface RouteRecommendationInput {
  intent: TaskIntent;
  scope: TaskScope;
  risk: TaskRisk;
  writeAccess: WriteAccess;
  writeScope: readonly string[];
  dependencyCount: number;
  deterministic: boolean;
  budgetClass: BudgetClass;
  providerAvailability: readonly ProviderAvailability[];
  /** Optional runtime model allow-list, supplied after capability discovery. */
  availableModelIds?: readonly string[];
  reviewerDiversity?: ReviewerDiversityPreference;
}

export interface ModelRouteRecommendation {
  kind: 'model';
  route: TaskRoute;
  selectedModel: ProviderModel;
}

export interface NoModelRouteRecommendation {
  kind: 'no-model';
  rationale: string;
  fallback: null;
}

export type RouteRecommendation = ModelRouteRecommendation | NoModelRouteRecommendation;

export interface RouteCandidate {
  model: ProviderModel;
  score: number;
  effort?: ReasoningEffort;
}
