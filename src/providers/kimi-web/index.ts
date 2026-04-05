import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { normalizeKimiSSE } from './stream.js';
import { readSSE } from '../_shared/sse-reader.js';
import { KIMI_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';

export class KimiProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'kimi-web',
    name: 'Kimi Web',
    website: 'https://kimi.moonshot.cn',
    loginUrl: 'https://kimi.moonshot.cn',
    needsBrowser: true,
  };

  constructor(
    private authStore: AuthStore,
    private browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
  ) {
    super();
  }

  async login(context: { openUrl: (url: string) => Promise<void> }): Promise<void> {
    await context.openUrl(this.info.loginUrl);
  }

  async isAuthenticated(): Promise<boolean> {
    return this.authStore.getStatus(this.info.id).status === 'active';
  }

  async detectLoginComplete(): Promise<boolean> {
    return false;
  }

  async models(): Promise<ModelInfo[]> {
    return [
      { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 256000, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    const response = await this.browserFetch(`${KIMI_WEB_BASE_URL}/api/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: true,
      }),
    });

    yield* readSSE(response, normalizeKimiSSE);
  }
}
