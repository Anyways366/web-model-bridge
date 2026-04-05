import { ProviderRegistry } from './registry.js';
import type { ChatRequest } from './provider.js';
import type { StreamEvent } from './stream.js';
import { AuthRequiredError } from './errors.js';

export interface RouterConfig {
  fallbacks?: Record<string, string[]>;  // providerId → fallback providerIds
  maxRetries?: number;                    // default 2
}

export class Router {
  constructor(
    private registry: ProviderRegistry,
    private config: RouterConfig = {},
  ) {}

  async *chat(modelId: string, req: Omit<ChatRequest, 'model'>): AsyncIterable<StreamEvent> {
    const { provider, model } = this.registry.resolve(modelId);
    const providerId = provider.info.id;

    // Build attempt list: primary + fallbacks
    const attempts = [{ provider, model, modelId }];
    const fallbackIds = this.config.fallbacks?.[providerId] ?? [];
    for (const fbId of fallbackIds) {
      const fbProvider = this.registry.getProvider(fbId);
      if (fbProvider) {
        // Use first model from fallback provider
        const fbModels = await fbProvider.models();
        if (fbModels.length > 0) {
          attempts.push({
            provider: fbProvider,
            model: fbModels[0].id,
            modelId: `${fbId}/${fbModels[0].id}`,
          });
        }
      }
    }

    const maxRetries = this.config.maxRetries ?? 2;
    let lastError: Error | null = null;

    for (const attempt of attempts) {
      if (!(await attempt.provider.isAuthenticated())) {
        lastError = new AuthRequiredError(attempt.provider.info.id);
        continue; // Try next fallback
      }

      for (let retry = 0; retry <= maxRetries; retry++) {
        try {
          const events: StreamEvent[] = [];
          let hasError = false;

          for await (const event of attempt.provider.chat({
            ...req,
            model: attempt.model,
            stream: req.stream ?? true,
          })) {
            if (event.type === 'error') {
              hasError = true;
              lastError = new Error(event.message);
              break;
            }
            events.push(event);
          }

          if (!hasError) {
            // Success — yield all collected events
            for (const event of events) {
              yield event;
            }
            return;
          }

          // Retry with backoff
          if (retry < maxRetries) {
            await new Promise(r => setTimeout(r, Math.pow(2, retry) * 1000));
          }
        } catch (err) {
          lastError = err as Error;
          if (retry < maxRetries) {
            await new Promise(r => setTimeout(r, Math.pow(2, retry) * 1000));
          }
        }
      }
    }

    // All attempts exhausted
    yield { type: 'error', message: lastError?.message ?? 'All providers failed' };
  }
}
