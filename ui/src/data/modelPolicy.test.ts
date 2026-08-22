import { describe, expect, it } from 'vitest';
import {
  createModelPolicyDraft,
  defaultModelLabel,
  defaultModelPolicyState,
  modelPolicyButtonState,
  modelPolicyGroups,
  modelPolicySaveState,
  modelPolicyValidation,
  normalizeDefaultModelId,
  normalizeModelPolicyResponse,
  reduceModelPolicyDraft,
  type ModelPolicyProvider,
  type ModelPolicySnapshot,
} from './modelPolicy';

const providers: ModelPolicyProvider[] = [
  {
    provider: 'anthropic',
    available: true,
    availableAuthModes: ['subscription'],
    models: [
      {
        id: 'claude-haiku-4-5-20251001',
        label: 'Claude Haiku 4.5',
        tier: 'fast',
        capabilities: ['coding', 'review'],
        reasoningEfforts: [],
      },
      {
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        tier: 'standard',
        capabilities: ['coding', 'planning', 'review'],
        reasoningEfforts: ['low', 'medium'],
      },
    ],
  },
  {
    provider: 'openai',
    available: true,
    availableAuthModes: ['subscription'],
    models: [
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        tier: 'standard',
        capabilities: ['coding', 'planning', 'review'],
        reasoningEfforts: ['low', 'medium'],
      },
    ],
  },
];

function snapshot(overrides: Partial<ModelPolicySnapshot> = {}): ModelPolicySnapshot {
  return {
    providers,
    enabledModelIds: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'gpt-5.4'],
    defaultModelId: 'claude-sonnet-4-6',
    activeRun: false,
    ...overrides,
  };
}

describe('normalizeModelPolicyResponse', () => {
  it('fills missing values from the previous state and repairs impossible defaults', () => {
    expect(
      normalizeModelPolicyResponse(
        { defaultModelId: 'gpt-5.4' },
        snapshot({ enabledModelIds: ['claude-sonnet-4-6'] }),
      ),
    ).toEqual({
      providers,
      enabledModelIds: ['claude-sonnet-4-6'],
      defaultModelId: 'claude-sonnet-4-6',
      activeRun: false,
    });
  });
});

describe('normalizeDefaultModelId', () => {
  it('auto-selects the only enabled planning-capable model', () => {
    expect(
      normalizeDefaultModelId({
        providers,
        enabledModelIds: ['claude-haiku-4-5-20251001', 'gpt-5.4'],
        requestedDefaultModelId: 'claude-haiku-4-5-20251001',
      }),
    ).toBe('gpt-5.4');
  });

  it('requires an explicit choice when several planning-capable models remain', () => {
    expect(
      normalizeDefaultModelId({
        providers,
        enabledModelIds: ['claude-sonnet-4-6', 'gpt-5.4'],
        requestedDefaultModelId: 'claude-haiku-4-5-20251001',
      }),
    ).toBe('');
  });
});

describe('reduceModelPolicyDraft', () => {
  it('does not allow disabling the last enabled model', () => {
    const draft = createModelPolicyDraft(
      snapshot({
        enabledModelIds: ['claude-sonnet-4-6'],
        defaultModelId: 'claude-sonnet-4-6',
      }),
    );

    expect(
      reduceModelPolicyDraft(providers, draft, {
        type: 'toggle-model',
        modelId: 'claude-sonnet-4-6',
      }),
    ).toEqual(draft);
  });

  it('auto-selects the only remaining planning-capable model', () => {
    const draft = createModelPolicyDraft(
      snapshot({
        enabledModelIds: ['claude-sonnet-4-6', 'gpt-5.4'],
      }),
    );

    expect(
      reduceModelPolicyDraft(providers, draft, {
        type: 'toggle-model',
        modelId: 'claude-sonnet-4-6',
      }),
    ).toEqual({
      enabledModelIds: ['gpt-5.4'],
      defaultModelId: 'gpt-5.4',
    });
  });

  it('ignores attempts to select a disabled or non-planning default', () => {
    const draft = createModelPolicyDraft(snapshot());

    expect(
      reduceModelPolicyDraft(providers, draft, {
        type: 'select-default',
        modelId: 'claude-haiku-4-5-20251001',
      }),
    ).toEqual(draft);
  });
});

describe('selectors and validation', () => {
  it('flags missing planning-capable defaults', () => {
    expect(
      modelPolicyValidation({
        providers,
        enabledModelIds: ['claude-haiku-4-5-20251001'],
        defaultModelId: '',
      }),
    ).toBe('Enable at least one planning-capable model so the PM has a default.');
  });

  it('marks save as invalid while a dirty draft has no default', () => {
    expect(
      modelPolicySaveState({
        serverStatus: 'up',
        pending: false,
        snapshot: snapshot(),
        draft: {
          enabledModelIds: ['claude-sonnet-4-6', 'gpt-5.4'],
          defaultModelId: '',
        },
      }),
    ).toEqual({
      dirty: true,
      disabled: true,
      reason: 'Choose a default PM model.',
    });
  });

  it('groups provider rows with enabled and planning flags', () => {
    expect(modelPolicyGroups(providers, ['claude-sonnet-4-6', 'gpt-5.4'])).toEqual([
      {
        provider: 'anthropic',
        label: 'Anthropic',
        models: [
          {
            id: 'claude-haiku-4-5-20251001',
            label: 'Claude Haiku 4.5',
            tier: 'fast',
            capabilities: ['coding', 'review'],
            reasoningEfforts: [],
            enabled: false,
            planningCapable: false,
          },
          {
            id: 'claude-sonnet-4-6',
            label: 'Claude Sonnet 4.6',
            tier: 'standard',
            capabilities: ['coding', 'planning', 'review'],
            reasoningEfforts: ['low', 'medium'],
            enabled: true,
            planningCapable: true,
          },
        ],
      },
      {
        provider: 'openai',
        label: 'OpenAI / Codex',
        models: [
          {
            id: 'gpt-5.4',
            label: 'GPT-5.4',
            tier: 'standard',
            capabilities: ['coding', 'planning', 'review'],
            reasoningEfforts: ['low', 'medium'],
            enabled: true,
            planningCapable: true,
          },
        ],
      },
    ]);
  });

  it('derives the active label and allows opening the modal during a run', () => {
    expect(defaultModelLabel(snapshot())).toBe('Claude Sonnet 4.6');
    expect(
      modelPolicyButtonState({
        serverStatus: 'up',
        snapshot: snapshot({ activeRun: true }),
      }),
    ).toEqual({
      disabled: false,
      reason: null,
    });
  });

  it('has an empty default state', () => {
    expect(defaultModelPolicyState()).toEqual({
      providers: [],
      enabledModelIds: [],
      defaultModelId: '',
      activeRun: false,
    });
  });
});
