import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderRegistry } from '../../../src/core/registry.js';
import { MockProvider } from '../../helpers/mock-provider.js';
import { InvalidModelError } from '../../../src/core/errors.js';

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;
  let claude: MockProvider;
  let deepseek: MockProvider;

  beforeEach(() => {
    registry = new ProviderRegistry();
    claude = new MockProvider('claude-web', {
      authenticated: true,
      models: [
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000, maxOutput: 8192 },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 200000, maxOutput: 8192 },
      ],
    });
    deepseek = new MockProvider('deepseek-web', {
      authenticated: false,
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 64000, maxOutput: 8192 },
      ],
    });
    registry.register(claude);
    registry.register(deepseek);
  });

  it('resolves provider from model ID', () => {
    const result = registry.resolve('claude-web/claude-sonnet-4-6');
    expect(result.provider).toBe(claude);
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('resolves provider with different model', () => {
    const result = registry.resolve('deepseek-web/deepseek-chat');
    expect(result.provider).toBe(deepseek);
    expect(result.model).toBe('deepseek-chat');
  });

  it('throws InvalidModelError for unknown provider', () => {
    expect(() => registry.resolve('unknown/model')).toThrow(InvalidModelError);
  });

  it('throws InvalidModelError for malformed model ID', () => {
    expect(() => registry.resolve('no-slash')).toThrow(InvalidModelError);
  });

  it('throws InvalidModelError for empty string', () => {
    expect(() => registry.resolve('')).toThrow(InvalidModelError);
  });

  it('allModels aggregates from all authenticated providers', async () => {
    const models = await registry.allModels();
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('claude-web/claude-sonnet-4-6');
    expect(models[1].id).toBe('claude-web/claude-opus-4-6');
  });

  it('providerStatus returns status for all providers', async () => {
    const statuses = await registry.providerStatus();
    expect(statuses).toHaveLength(2);
    expect(statuses.find(s => s.id === 'claude-web')?.authenticated).toBe(true);
    expect(statuses.find(s => s.id === 'deepseek-web')?.authenticated).toBe(false);
  });
});
