import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebMessages, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { createChatGPTSSENormalizer } from './stream.js';
import { readSSE } from '../_shared/sse-reader.js';
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
      { id: 'gpt-5.3', name: 'GPT-5.3', contextWindow: 128000, maxOutput: 4096 },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: 128000, maxOutput: 4096 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    // Tool-aware requests forward the structured history (assistant
    // tool_calls, tool results) and the tool definitions upstream. Plain
    // chats keep today's single-user-message payload.
    const hasTools = Array.isArray(req.tools) && req.tools.length > 0;
    const payload = hasTools ? buildWebMessages(req.messages, req.tools) : null;

    const body = payload
      ? { model: req.model, messages: payload.messages, tools: payload.tools }
      : {
          model: req.model,
          messages: [{
            author: { role: 'user' },
            content: { content_type: 'text', parts: [buildWebPrompt(req.messages)] },
          }],
        };

    const response = await this.browserFetch(
      `${CHATGPT_WEB_BASE_URL}/backend-api/conversation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    yield* readSSE(response, createChatGPTSSENormalizer());
  }
}
