import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { DOUBAO_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';
import type { Page } from 'playwright-core';

const DOUBAO_QUERY_PARAMS = 'aid=497858&device_platform=web&language=zh&pkg_type=release_version&real_aid=497858&region=CN&samantha_web=1&sys_region=CN&use_olympus_account=1&version_code=20800';

/**
 * Build the Doubao completion request body. Doubao maintains conversations
 * server-side: a brand-new exchange uses `conversation_id: '0'` with
 * `need_create_conversation: true`; continuing an existing conversation (as
 * returned in the previous turn's 2002 metadata event and echoed back to the
 * caller as the conversation id) reuses that id and skips creation. This is
 * the protocol's own semantics — no invented state.
 */
export function buildDoubaoCompletionBody(
  prompt: string,
  conversationId?: string,
): {
  messages: Array<{ content: string; content_type: number; attachments: unknown[]; references: unknown[] }>;
  completion_option: {
    is_regen: boolean;
    with_suggest: boolean;
    need_create_conversation: boolean;
    launch_stage: number;
    is_replace: boolean;
    is_delete: boolean;
    message_from: number;
    event_id: string;
  };
  conversation_id: string;
  local_conversation_id: string;
  local_message_id: string;
} {
  return {
    messages: [{
      content: JSON.stringify({ text: prompt }),
      content_type: 2001,
      attachments: [],
      references: [],
    }],
    completion_option: {
      is_regen: false,
      with_suggest: false,
      need_create_conversation: !conversationId,
      launch_stage: 1,
      is_replace: false,
      is_delete: false,
      message_from: 0,
      event_id: '0',
    },
    conversation_id: conversationId ?? '0',
    local_conversation_id: `local_16${Date.now()}`,
    local_message_id: crypto.randomUUID(),
  };
}

export class DoubaoProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'doubao-web',
    name: 'Doubao Web',
    website: 'https://www.doubao.com',
    loginUrl: 'https://www.doubao.com',
    needsBrowser: true,
  };

  constructor(
    private authStore: AuthStore,
    private browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
    private getPage?: (origin: string) => Promise<Page>,
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
      { id: 'doubao-seed-2.0-pro', name: 'Doubao Seed 2.0 Pro', contextWindow: 256000, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.getPage && !this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    try {
      const page = this.getPage
        ? await this.getPage(DOUBAO_WEB_BASE_URL)
        : null;

      if (!page) {
        yield { type: 'error', message: 'Doubao requires getPage for API calls' };
        return;
      }

      const prompt = buildWebPrompt(req.messages);

      const sseResult = await page.evaluate(async (args: {
        queryParams: string; body: unknown;
      }) => {
        try {
          const res = await fetch(`/samantha/chat/completion?${args.queryParams}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'Agw-js-conv': 'str',
            },
            body: JSON.stringify(args.body),
            credentials: 'include',
          });

          if (!res.ok) {
            const text = await res.text();
            return { error: `HTTP ${res.status}: ${text.substring(0, 200)}` };
          }

          const reader = res.body?.getReader();
          if (!reader) return { error: 'No response body' };
          const decoder = new TextDecoder();
          let fullText = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullText += decoder.decode(value, { stream: true });
          }
          return { data: fullText };
        } catch (e: any) {
          return { error: e.message };
        }
      }, {
        queryParams: DOUBAO_QUERY_PARAMS,
        body: buildDoubaoCompletionBody(prompt, req.conversationId),
      });

      if (sseResult.error) {
        yield { type: 'error', message: `Doubao API error: ${sseResult.error}` };
        return;
      }

      // Parse Doubao SSE response
      // Doubao event_data is a nested JSON string, event_type indicates the type:
      // 2001 = text content, 2002 = metadata, 2006 = done, etc.
      let serverConversationId: string | undefined;
      const lines = (sseResult.data ?? '').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const eventType = parsed?.event_type;

            if (eventType === 2001 || eventType === '2001') {
              // Text content event — event_data is a JSON string
              let eventData = parsed.event_data;
              if (typeof eventData === 'string') {
                try { eventData = JSON.parse(eventData); } catch {}
              }
              const text = eventData?.message?.content || eventData?.content || eventData?.text;
              if (text) {
                // Content may also be nested JSON: {"text": "..."}
                try {
                  const inner = JSON.parse(text);
                  if (typeof inner?.text === 'string' && inner.text) {
                    yield { type: 'text_delta', delta: inner.text };
                  }
                  // else: parsed as JSON but no text field (e.g. {} or suggest data) — skip
                } catch {
                  // Not JSON — treat as plain text
                  yield { type: 'text_delta', delta: text };
                }
              }
            } else if (eventType === 2002 || eventType === '2002') {
              // Metadata event — carries the server-side conversation id used
              // for continuing this conversation on the next turn.
              let eventData = parsed.event_data;
              if (typeof eventData === 'string') {
                try { eventData = JSON.parse(eventData); } catch {}
              }
              if (eventData && typeof eventData === 'object') {
                const convId = (eventData as any).conversation_id ?? (eventData as any).local_conversation_id;
                if (typeof convId === 'string' && convId && convId !== '0') {
                  serverConversationId = convId;
                }
              }
            } else if (eventType === 2006 || eventType === '2006') {
              // Done event
              if (serverConversationId) {
                yield { type: 'done', reason: 'stop', conversationId: serverConversationId };
              } else {
                yield { type: 'done', reason: 'stop' };
              }
            }
          } catch {
            // Skip non-JSON data lines
          }
        } else if (trimmed.startsWith('event: gateway-error')) {
          // Error from gateway
          yield { type: 'error', message: 'Doubao gateway error' };
        }
      }
    } catch (err) {
      yield { type: 'error', message: `Doubao provider error: ${(err as Error).message}` };
    }
  }
}
