import { recommendRoute } from '../routing/recommend.js';
import type { RouteRecommendationInput } from '../routing/types.js';

export interface RoutingEvaluationFixture {
  name: string;
  input: RouteRecommendationInput;
  expectedModel: string | null;
  expectedProvider?: 'anthropic' | 'openai';
}

export interface RoutingEvaluationResult {
  name: string;
  pass: boolean;
  detail: string;
}

/**
 * Evaluate a policy against synthetic inputs before release. It is pure: it
 * reads no runtime telemetry and cannot alter routing policy or configuration.
 */
export function evaluateRoutingPolicy(
  fixtures: readonly RoutingEvaluationFixture[],
): RoutingEvaluationResult[] {
  return fixtures.map((fixture) => {
    try {
      const recommendation = recommendRoute(fixture.input);
      if (fixture.expectedModel === null) {
        const pass = recommendation.kind === 'no-model';
        return { name: fixture.name, pass, detail: pass ? 'No-model route selected.' : 'Expected no-model route.' };
      }
      const pass =
        recommendation.kind === 'model' &&
        recommendation.route.model === fixture.expectedModel &&
        (!fixture.expectedProvider || recommendation.route.provider === fixture.expectedProvider);
      const actual = recommendation.kind === 'model'
        ? `${recommendation.route.provider}/${recommendation.route.model}`
        : 'no-model';
      return {
        name: fixture.name,
        pass,
        detail: pass ? `Selected ${actual}.` : `Expected ${fixture.expectedProvider ?? 'any'}/${fixture.expectedModel}; selected ${actual}.`,
      };
    } catch (error) {
      return { name: fixture.name, pass: false, detail: (error as Error).message };
    }
  });
}
