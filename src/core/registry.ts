import { BaseProvider, type ModelInfo } from './provider.js';
import { InvalidModelError } from './errors.js';

export interface ProviderStatus {
  id: string;
  name: string;
  website: string;
  authenticated: boolean;
  modelCount: number;
}

export class ProviderRegistry {
  private providers = new Map<string, BaseProvider>();

  register(provider: BaseProvider): void {
    this.providers.set(provider.info.id, provider);
  }

  resolve(modelId: string): { provider: BaseProvider; model: string } {
    const slashIndex = modelId.indexOf('/');
    if (slashIndex === -1 || slashIndex === 0 || slashIndex === modelId.length - 1) {
      throw new InvalidModelError(modelId);
    }

    const providerId = modelId.slice(0, slashIndex);
    const model = modelId.slice(slashIndex + 1);

    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new InvalidModelError(modelId);
    }

    return { provider, model };
  }

  async allModels(): Promise<(ModelInfo & { id: string })[]> {
    const result: (ModelInfo & { id: string })[] = [];

    for (const [providerId, provider] of this.providers) {
      if (!(await provider.isAuthenticated())) continue;
      const models = await provider.models();
      for (const m of models) {
        result.push({ ...m, id: `${providerId}/${m.id}` });
      }
    }

    return result;
  }

  async providerStatus(): Promise<ProviderStatus[]> {
    const result: ProviderStatus[] = [];

    for (const [, provider] of this.providers) {
      const authenticated = await provider.isAuthenticated();
      let modelCount = 0;
      if (authenticated) {
        modelCount = (await provider.models()).length;
      }
      result.push({
        id: provider.info.id,
        name: provider.info.name,
        website: provider.info.website,
        authenticated,
        modelCount,
      });
    }

    return result;
  }

  getProvider(id: string): BaseProvider | undefined {
    return this.providers.get(id);
  }
}
