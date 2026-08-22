import { describe, expect, it } from 'vitest';
import {
  createModelPolicyDraft,
  defaultModelLabel,
  defaultModelPolicyState,
  modelPolicyButtonState,
  modelPolicyGroups,
  modelPolicyPreferenceOptions,
  modelPolicyPreferenceState,
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

  it('enables and disables a provider as one coarse-grained choice', () => {
    const gptOnly = createModelPolicyDraft(
      snapshot({ enabledModelIds: ['gpt-5.4'], defaultModelId: 'gpt-5.4' }),
    );
    const withClaude = reduceModelPolicyDraft(providers, gptOnly, {
      type: 'enable-provider',
      provider: 'anthropic',
    });

    expect(withClaude).toEqual({
      enabledModelIds: ['gpt-5.4', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
      defaultModelId: 'gpt-5.4',
    });
    expect(
      reduceModelPolicyDraft(providers, withClaude, {
        type: 'disable-provider',
        provider: 'anthropic',
      }),
    ).toEqual(gptOnly);
  });

  it('does not disable the last enabled provider', () => {
    const gptOnly = createModelPolicyDraft(
      snapshot({ enabledModelIds: ['gpt-5.4'], defaultModelId: 'gpt-5.4' }),
    );

    expect(
      reduceModelPolicyDraft(providers, gptOnly, {
        type: 'disable-provider',
        provider: 'openai',
      }),
    ).toEqual(gptOnly);
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
        label: 'Claude',
        available: true,
        policyEnabled: true,
        canDisable: true,
        unavailableReason: null,
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
        available: true,
        policyEnabled: true,
        canDisable: true,
        unavailableReason: null,
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

  it('keeps an unavailable Claude provider as one collapsed entry with a reason', () => {
    const unavailableClaude: ModelPolicyProvider = {
      provider: 'anthropic',
      available: false,
      enabled: true,
      cliAvailable: false,
      apiKeyConfigured: false,
      availableAuthModes: [],
      models: [],
    };

    expect(modelPolicyGroups([unavailableClaude, providers[1]], ['gpt-5.4'])).toEqual([
      {
        provider: 'anthropic',
        label: 'Claude',
        available: false,
        policyEnabled: false,
        canDisable: false,
        unavailableReason: 'Claude CLI was not detected and no Anthropic API key is configured.',
        models: [],
      },
      {
        provider: 'openai',
        label: 'OpenAI / Codex',
        available: true,
        policyEnabled: true,
        canDisable: false,
        unavailableReason: null,
        models: [
          {
            ...providers[1].models[0],
            enabled: true,
            planningCapable: true,
          },
        ],
      },
    ]);
  });

  it('describes enabled, disabled, and missing agent preferences', () => {
    expect(modelPolicyPreferenceState(snapshot(), 'gpt-5.4')).toMatchObject({
      modelId: 'gpt-5.4',
      status: 'enabled',
      enabledForNewRuns: true,
      remediation: null,
    });

    expect(
      modelPolicyPreferenceState(snapshot({ enabledModelIds: ['claude-sonnet-4-6'] }), 'gpt-5.4'),
    ).toMatchObject({
      modelId: 'gpt-5.4',
      status: 'disabled',
      enabledForNewRuns: false,
    });

    expect(modelPolicyPreferenceState(snapshot(), 'claude-fable-5')).toMatchObject({
      modelId: 'claude-fable-5',
      status: 'missing',
      enabledForNewRuns: false,
    });
  });

  it('keeps a disabled current preference visible beside enabled choices', () => {
    expect(
      modelPolicyPreferenceOptions(snapshot({ enabledModelIds: ['claude-sonnet-4-6'] }), 'gpt-5.4'),
    ).toEqual([
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        provider: 'openai',
        enabledForNewRuns: false,
        current: true,
      },
      {
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        provider: 'anthropic',
        enabledForNewRuns: true,
        current: false,
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
