import type { AvailableModel, AvailableProvider } from './models';

export interface ModelPolicyProvider extends AvailableProvider {
  cliAvailable?: boolean;
  apiKeyConfigured?: boolean;
  enabled?: boolean;
}

export interface ModelPolicyState {
  providers: ModelPolicyProvider[];
  enabledModelIds: string[];
  defaultModelId: string;
  activeRun: boolean;
}

export type ModelPolicySnapshot = ModelPolicyState;

export interface ModelPolicyDraft {
  enabledModelIds: string[];
  defaultModelId: string;
}

export interface ModelPolicyResponse {
  providers?: ModelPolicyProvider[];
  enabledModelIds?: string[];
  defaultModelId?: string;
  activeRun?: boolean;
  error?: string;
}

export interface ModelPolicyControlState {
  disabled: boolean;
  reason: string | null;
}

export type ModelPolicyDraftAction =
  | { type: 'reset'; draft: ModelPolicyDraft }
  | { type: 'toggle-model'; modelId: string }
  | { type: 'select-default'; modelId: string };

export interface ModelPolicyGroupedModel extends AvailableModel {
  enabled: boolean;
  planningCapable: boolean;
}

export interface ModelPolicyGroup {
  provider: AvailableProvider['provider'];
  label: string;
  models: ModelPolicyGroupedModel[];
}

export interface ModelPolicyPreferenceState {
  modelId: string;
  label: string;
  provider: AvailableProvider['provider'] | null;
  enabledForNewRuns: boolean;
  status: 'enabled' | 'disabled' | 'missing';
  summary: string;
  remediation: string | null;
}

export interface ModelPolicyPreferenceOption {
  id: string;
  label: string;
  provider: AvailableProvider['provider'] | null;
  enabledForNewRuns: boolean;
  current: boolean;
}

export interface ModelPolicySaveState extends ModelPolicyControlState {
  dirty: boolean;
}

export function defaultModelPolicyState(): ModelPolicyState {
  return {
    providers: [],
    enabledModelIds: [],
    defaultModelId: '',
    activeRun: false,
  };
}

export const defaultModelPolicySnapshot = defaultModelPolicyState;

export function normalizeModelPolicyResponse(
  response: ModelPolicyResponse | null | undefined,
  previous: ModelPolicyState = defaultModelPolicyState(),
): ModelPolicyState {
  const providers = response?.providers ?? previous.providers;
  const enabledModelIds = uniqueModelIds(response?.enabledModelIds ?? previous.enabledModelIds);
  return {
    providers,
    enabledModelIds,
    defaultModelId: normalizeDefaultModelId({
      providers,
      enabledModelIds,
      requestedDefaultModelId: response?.defaultModelId ?? previous.defaultModelId,
    }),
    activeRun: response?.activeRun ?? previous.activeRun,
  };
}

export function allPolicyModels(
  policy: Pick<ModelPolicyState, 'providers'>,
): Array<AvailableModel & { provider: AvailableProvider['provider']; providerAvailable: boolean }> {
  return policy.providers.flatMap(provider =>
    provider.models.map(model => ({
      ...model,
      provider: provider.provider,
      providerAvailable: provider.available,
    })),
  );
}

export function modelLabel(policy: Pick<ModelPolicyState, 'providers'>, modelId: string): string {
  return allPolicyModels(policy).find(model => model.id === modelId)?.label ?? modelId;
}

export function defaultModelLabel(
  policy: Pick<ModelPolicyState, 'providers' | 'defaultModelId'>,
): string | null {
  return policy.defaultModelId ? modelLabel(policy, policy.defaultModelId) : null;
}

function providerLabel(provider: AvailableProvider['provider'] | null): string {
  if (provider === 'openai') {
    return 'OpenAI';
  }
  if (provider === 'anthropic') {
    return 'Anthropic';
  }
  return 'Unknown provider';
}

export function planningCapableModelIds(policy: Pick<ModelPolicyState, 'providers'>): string[] {
  return allPolicyModels(policy)
    .filter(model => model.capabilities.includes('planning'))
    .map(model => model.id);
}

export function modelPolicyPreferenceState(
  policy: Pick<ModelPolicyState, 'providers' | 'enabledModelIds'>,
  modelId: string | undefined,
): ModelPolicyPreferenceState | null {
  if (!modelId) {
    return null;
  }

  const model = allPolicyModels(policy).find(candidate => candidate.id === modelId);
  const label = model?.label ?? modelId;
  const provider = model?.provider ?? null;
  const enabledForNewRuns = policy.enabledModelIds.includes(modelId);

  if (!model) {
    return {
      modelId,
      label,
      provider,
      enabledForNewRuns: false,
      status: 'missing',
      summary: `${label} is not currently executable on this machine.`,
      remediation: 'Choose an enabled model or restore the matching local transport.',
    };
  }

  if (!enabledForNewRuns) {
    return {
      modelId,
      label,
      provider,
      enabledForNewRuns,
      status: 'disabled',
      summary: `${label} is disabled by project policy for new runs.`,
      remediation: 'Choose an enabled model here or re-enable it in Model policy.',
    };
  }

  return {
    modelId,
    label,
    provider,
    enabledForNewRuns,
    status: 'enabled',
    summary: `${label} is available for new runs through ${providerLabel(provider)}.`,
    remediation: null,
  };
}

export function modelPolicyPreferenceOptions(
  policy: Pick<ModelPolicyState, 'providers' | 'enabledModelIds'>,
  currentModelId: string | undefined,
): ModelPolicyPreferenceOption[] {
  const enabledOptions = allPolicyModels(policy)
    .filter(model => policy.enabledModelIds.includes(model.id))
    .map(model => ({
      id: model.id,
      label: model.label,
      provider: model.provider,
      enabledForNewRuns: true,
      current: model.id === currentModelId,
    }));

  if (!currentModelId || enabledOptions.some(option => option.id === currentModelId)) {
    return enabledOptions;
  }

  const currentState = modelPolicyPreferenceState(policy, currentModelId);
  if (!currentState) {
    return enabledOptions;
  }

  return [
    {
      id: currentState.modelId,
      label: currentState.label,
      provider: currentState.provider,
      enabledForNewRuns: false,
      current: true,
    },
    ...enabledOptions,
  ];
}

export function normalizeDefaultModelId(input: {
  providers: ModelPolicyProvider[];
  enabledModelIds: string[];
  requestedDefaultModelId: string;
}): string {
  const enabled = [...new Set(input.enabledModelIds)];
  const planningIds = planningCapableModelIds({ providers: input.providers });
  const enabledPlanningIds = enabled.filter(modelId => planningIds.includes(modelId));
  if (enabledPlanningIds.length === 1) {
    return enabledPlanningIds[0];
  }
  if (
    enabled.includes(input.requestedDefaultModelId) &&
    planningIds.includes(input.requestedDefaultModelId)
  ) {
    return input.requestedDefaultModelId;
  }
  return '';
}

export function modelPolicyValidation(input: {
  providers: ModelPolicyProvider[];
  enabledModelIds: string[];
  defaultModelId: string;
}): string | null {
  if (input.enabledModelIds.length === 0) {
    return 'Enable at least one model.';
  }
  const planningIds = planningCapableModelIds({ providers: input.providers });
  const enabledPlanningIds = input.enabledModelIds.filter(modelId => planningIds.includes(modelId));
  if (enabledPlanningIds.length === 0) {
    return 'Enable at least one planning-capable model so the PM has a default.';
  }
  if (!input.defaultModelId) {
    return 'Choose a default PM model.';
  }
  if (!input.enabledModelIds.includes(input.defaultModelId) || !planningIds.includes(input.defaultModelId)) {
    return 'The default PM model must stay enabled.';
  }
  return null;
}

export function modelPolicyControlState(input: {
  serverStatus: 'probing' | 'up' | 'down';
  pending: boolean;
  modelPolicy: Pick<ModelPolicyState, 'activeRun'>;
}): ModelPolicyControlState {
  if (input.pending) {
    return {
      disabled: true,
      reason: 'Updating model policy...',
    };
  }

  if (input.serverStatus !== 'up') {
    return {
      disabled: true,
      reason: 'Swarm must be connected before model policy can change.',
    };
  }

  if (input.modelPolicy.activeRun) {
    return {
      disabled: true,
      reason: 'Finish or stop the active run before changing model policy.',
    };
  }

  return {
    disabled: false,
    reason: null,
  };
}

function sameModelSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every(modelId => right.includes(modelId));
}

function uniqueModelIds(modelIds: string[]): string[] {
  return [...new Set(modelIds)];
}

export function createModelPolicyDraft(snapshot: ModelPolicySnapshot): ModelPolicyDraft {
  return {
    enabledModelIds: uniqueModelIds(snapshot.enabledModelIds),
    defaultModelId: normalizeDefaultModelId({
      providers: snapshot.providers,
      enabledModelIds: snapshot.enabledModelIds,
      requestedDefaultModelId: snapshot.defaultModelId,
    }),
  };
}

export function reduceModelPolicyDraft(
  providers: ModelPolicyProvider[],
  state: ModelPolicyDraft,
  action: ModelPolicyDraftAction,
): ModelPolicyDraft {
  if (action.type === 'reset') {
    return action.draft;
  }
  if (action.type === 'select-default') {
    const planningIds = planningCapableModelIds({ providers });
    if (!state.enabledModelIds.includes(action.modelId) || !planningIds.includes(action.modelId)) {
      return state;
    }
    return {
      ...state,
      defaultModelId: action.modelId,
    };
  }

  if (state.enabledModelIds.includes(action.modelId) && state.enabledModelIds.length === 1) {
    return state;
  }

  const enabledModelIds = state.enabledModelIds.includes(action.modelId)
    ? state.enabledModelIds.filter(modelId => modelId !== action.modelId)
    : uniqueModelIds([...state.enabledModelIds, action.modelId]);

  return {
    enabledModelIds,
    defaultModelId: normalizeDefaultModelId({
      providers,
      enabledModelIds,
      requestedDefaultModelId: state.defaultModelId,
    }),
  };
}

export function modelPolicyGroups(
  providers: ModelPolicyProvider[],
  enabledModelIds: string[],
): ModelPolicyGroup[] {
  return providers
    .filter(provider => provider.available || provider.models.length > 0)
    .map(provider => ({
      provider: provider.provider,
      label: provider.provider === 'openai' ? 'OpenAI / Codex' : 'Anthropic',
      models: provider.models.map(model => ({
        ...model,
        enabled: enabledModelIds.includes(model.id),
        planningCapable: model.capabilities.includes('planning'),
      })),
    }));
}

export function modelPolicySaveState(input: {
  serverStatus: 'probing' | 'up' | 'down';
  pending: boolean;
  snapshot: ModelPolicySnapshot;
  draft: ModelPolicyDraft;
}): ModelPolicySaveState {
  const dirty =
    !sameModelSet(input.snapshot.enabledModelIds, input.draft.enabledModelIds) ||
    input.snapshot.defaultModelId !== input.draft.defaultModelId;
  const control = modelPolicyControlState({
    serverStatus: input.serverStatus,
    pending: input.pending,
    modelPolicy: input.snapshot,
  });
  const validation = modelPolicyValidation({
    providers: input.snapshot.providers,
    enabledModelIds: input.draft.enabledModelIds,
    defaultModelId: input.draft.defaultModelId,
  });
  return {
    dirty,
    disabled: control.disabled || !dirty || validation !== null,
    reason: control.reason ?? (!dirty ? 'No model policy changes to save.' : validation),
  };
}

export function modelPolicyButtonState(input: {
  serverStatus: 'probing' | 'up' | 'down';
  snapshot: ModelPolicySnapshot;
}): ModelPolicyControlState {
  if (input.serverStatus !== 'up') {
    return {
      disabled: true,
      reason: 'Swarm must be connected before model policy can open.',
    };
  }
  if (input.snapshot.providers.every(provider => provider.models.length === 0)) {
    return {
      disabled: true,
      reason: 'No locally executable models are available right now.',
    };
  }
  return {
    disabled: false,
    reason: null,
  };
}
