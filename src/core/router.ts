import { ProviderRegistry } from './registry.js';
import type { ChatRequest } from './provider.js';
import type { StreamEvent } from './stream.js';
import { AuthRequiredError, errorToHttpResponse } from './errors.js';

export interface RouterConfig {
  fallbacks?: Record<string, string[]>;  // providerId → fallback providerIds
  maxRetries?: number;                    // default 2
}

interface Attempt {
  provider: NonNullable<ReturnType<ProviderRegistry['getProvider']>>;
  model: string;
  modelId: string;
}

interface Failure {
  message: string;
  code?: string;
}

/**
 * Routes a chat request to a provider with retry/fallback support.
 *
 * Streaming contract:
 * - Events are yielded as they arrive — the downstream consumer never waits
 *   for the full response. Nothing is buffered for replay.
 * - A request may be retried (or moved to a fallback provider) ONLY while no
 *   externally visible event has been emitted. The first non-error event
 *   "commits" the attempt.
 * - Once output has been committed: no retry, no fallback switch, no replay.
 *   A subsequent failure is surfaced as a terminal `error` event and the
 *   stream stops.
 * - An `error` event before any output is considered a retryable failure of
 *   that attempt (subject to maxRetries and fallback config).
 * - The caller's AbortSignal is honored at every await point.
 */
export class Router {
  constructor(
    private registry: ProviderRegistry,
    private config: RouterConfig = {},
  ) {}

  async *chat(modelId: string, req: Omit<ChatRequest, 'model'>): AsyncIterable<StreamEvent> {
    let attempts: Attempt[];
    try {
      attempts = await this.buildAttempts(modelId);
    } catch (err) {
      const resp = errorToHttpResponse(err as Error);
      yield { type: 'error', message: (err as Error).message, code: resp.body.error.code };
      return;
    }

    const maxRetries = this.config.maxRetries ?? 2;
    let lastError: Failure | null = null;
    const signal = req.signal;

    for (const attempt of attempts) {
      if (!(await attempt.provider.isAuthenticated())) {
        lastError = { message: new AuthRequiredError(attempt.provider.info.id).message, code: 'auth_required' };
        continue; // Try next fallback
      }

      for (let retry = 0; retry <= maxRetries; retry++) {
        if (signal?.aborted) return;

        /** True once any non-error event has been emitted to the caller. */
        let committed = false;
        let attemptFailed = false;

        try {
          for await (const event of attempt.provider.chat({
            ...req,
            model: attempt.model,
            stream: req.stream ?? true,
          })) {
            if (event.type === 'error') {
              attemptFailed = true;
              lastError = { message: event.message, code: event.code };
              if (committed) {
                // Output already emitted — surface the failure, never retry.
                yield event;
                return;
              }
              break; // Failed before output — retry the attempt
            }
            committed = true;
            yield event;
          }

          if (!attemptFailed) return; // Attempt completed cleanly (may be empty)
        } catch (err) {
          attemptFailed = true;
          const resp = errorToHttpResponse(err as Error);
          lastError = { message: (err as Error).message, code: resp.body.error.code };
          if (committed) {
            // Output already emitted — surface the failure, never retry.
            yield { type: 'error', message: (err as Error).message, code: resp.body.error.code };
            return;
          }
        }

        // Retry with backoff (only reached when the attempt failed before output)
        if (retry < maxRetries && !signal?.aborted) {
          await delay(Math.pow(2, retry) * 1000, signal);
        }
      }
    }

    // All attempts exhausted — report the last failure
    yield { type: 'error', message: lastError?.message ?? 'All providers failed', code: lastError?.code };
  }

  private async buildAttempts(modelId: string): Promise<Attempt[]> {
    const { provider, model } = await this.registry.resolve(modelId);
    const providerId = provider.info.id;

    const attempts: Attempt[] = [{ provider, model, modelId }];
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

    return attempts;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}