import { describe, expect, it } from 'vitest';
import { reasoningEffortTradeoff, selectableModels, type AvailableProvider } from './models';

const providers: AvailableProvider[] = [
  {
    provider: 'anthropic',
    available: true,
    availableAuthModes: ['subscription'],
    models: [
      {
        id: 'claude-opus-4-8',
        label: 'Claude Opus 4.8',
        tier: 'frontier',
        capabilities: ['coding', 'planning', 'review'],
        reasoningEfforts: ['low', 'medium', 'high'],
      },
    ],
  },
  {
    provider: 'openai',
    available: false,
    availableAuthModes: [],
    models: [
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        tier: 'standard',
        capabilities: ['coding', 'review'],
        reasoningEfforts: ['low', 'medium', 'high'],
      },
    ],
  },
];

describe('selectableModels', () => {
  it('excludes unavailable providers from routing overrides', () => {
    expect(selectableModels(providers, 'coder').map(model => model.id)).toEqual([
      'claude-opus-4-8',
    ]);
  });

  it('only returns models compatible with the task role', () => {
    const codingOnly: AvailableProvider[] = [
      {
        ...providers[0],
        models: [
          {
            id: 'coding-only',
            label: 'Coding only',
            tier: 'standard',
            capabilities: ['coding'],
            reasoningEfforts: ['low'],
          },
        ],
      },
    ];
    expect(selectableModels(codingOnly, 'reviewer')).toEqual([]);
  });

  it('does not show Responses-API-only GPT models for a local Codex subscription', () => {
    const openaiSubscription: AvailableProvider[] = [{
      provider: 'openai',
      available: true,
      availableAuthModes: ['subscription'],
      models: [
        {
          id: 'gpt-5.4', label: 'GPT-5.4', tier: 'standard',
          capabilities: ['coding', 'planning', 'review'], reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        },
        {
          id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', tier: 'frontier',
          capabilities: ['coding', 'planning', 'review'], reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
      ],
    }];

    expect(selectableModels(openaiSubscription, 'coder').map(model => model.id)).toEqual(['gpt-5.4']);
  });

  it('explains the quota and quality trade-off for each selectable effort', () => {
    expect(reasoningEffortTradeoff('low')).toMatch(/lowest quota use/);
    expect(reasoningEffortTradeoff('high')).toMatch(/higher-risk work/);
    expect(reasoningEffortTradeoff(undefined)).toMatch(/not configurable/);
  });
});
