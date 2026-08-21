import { describe, expect, it } from 'vitest';
import { selectableModels, type AvailableProvider } from './models';

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
        id: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex',
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
});
