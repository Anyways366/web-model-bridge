import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { normalizeChatGPTSSE } from './stream.js';
import { CHATGPT_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';

export class ChatGPTProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'chatgpt-web',
    name: 'ChatGPT Web',
    website: 'https://chatgpt.com',
    loginUrl: 'https://chatgpt.com/auth/login',
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
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxOutput: 4096 },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000, maxOutput: 4096 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    const response = await this.browserFetch(
      `${CHATGPT_WEB_BASE_URL}/backend-api/conversation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages.map(m => ({
            author: { role: m.role },
            content: { content_type: 'text', parts: [m.content] },
          })),
        }),
      }
    );

    if (!response.body) {
      yield { type: 'error', message: 'No response body' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const events = normalizeChatGPTSSE(trimmed);
        for (const event of events) {
          yield event;
        }
      }
    }

    if (buffer.trim()) {
      const events = normalizeChatGPTSSE(buffer.trim());
      for (const event of events) {
        yield event;
      }
    }
  }
}
