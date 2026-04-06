import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { normalizeDeepSeekSSE } from './stream.js';
import { solvePowSha256, buildPowResponse, type DeepSeekPowChallenge } from './pow.js';
import { DEEPSEEK_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';
import type { Page } from 'playwright-core';

export class DeepSeekProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'deepseek-web',
    name: 'DeepSeek Web',
    website: DEEPSEEK_WEB_BASE_URL,
    loginUrl: `${DEEPSEEK_WEB_BASE_URL}/sign_in`,
    needsBrowser: true,
  };

  constructor(
    private authStore: AuthStore,
    _browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
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
      { id: 'deepseek-v4', name: 'DeepSeek V4', contextWindow: 128000, maxOutput: 8192 },
      { id: 'deepseek-v4-reasoner', name: 'DeepSeek V4 Reasoner', contextWindow: 128000, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.getPage) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    try {
      const page = await this.getPage(DEEPSEEK_WEB_BASE_URL);

      // Step 1: Create chat session
      const sessionResult = await page.evaluate(async () => {
        try {
          const res = await fetch('/api/v0/chat_session/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            credentials: 'include',
          });
          if (!res.ok) return { error: `HTTP ${res.status}` };
          const data = await res.json();
          return { sessionId: data?.data?.biz_data?.id || data?.data?.id };
        } catch (e: any) {
          return { error: e.message };
        }
      });

      if (sessionResult.error || !sessionResult.sessionId) {
        yield { type: 'error', message: `DeepSeek session create failed: ${sessionResult.error || 'no session id'}` };
        return;
      }

      // Step 2: Get PoW challenge
      const challengeResult = await page.evaluate(async () => {
        try {
          const res = await fetch('/api/v0/chat/create_pow_challenge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
            credentials: 'include',
          });
          if (!res.ok) return { error: `HTTP ${res.status}` };
          const data = await res.json();
          const c = data?.data?.biz_data?.challenge || data?.data?.challenge || data?.challenge;
          return { challenge: c };
        } catch (e: any) {
          return { error: e.message };
        }
      });

      if (challengeResult.error || !challengeResult.challenge) {
        yield { type: 'error', message: `DeepSeek PoW challenge failed: ${challengeResult.error || 'no challenge'}` };
        return;
      }

      // Step 3: Solve PoW (runs in Node.js, not browser)
      const challenge = challengeResult.challenge as DeepSeekPowChallenge;
      let powResponse: string;
      try {
        const answer = solvePowSha256(challenge);
        powResponse = buildPowResponse(challenge, answer, '/api/v0/chat/completion');
      } catch (err) {
        yield { type: 'error', message: `DeepSeek PoW solve failed: ${(err as Error).message}` };
        return;
      }

      // Step 4: Build prompt
      const prompt = req.messages
        .filter(m => m.role === 'user')
        .map(m => m.content)
        .join('\n');

      const isThinking = req.model.includes('reasoner');

      // Step 5: Send message with PoW header, read SSE
      const sseResult = await page.evaluate(async (args: {
        sessionId: string; prompt: string; powResponse: string; thinkingEnabled: boolean;
      }) => {
        try {
          const res = await fetch('/api/v0/chat/completion', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-ds-pow-response': args.powResponse,
            },
            body: JSON.stringify({
              chat_session_id: args.sessionId,
              parent_message_id: null,
              prompt: args.prompt,
              ref_file_ids: [],
              thinking_enabled: args.thinkingEnabled,
              search_enabled: false,
              preempt: false,
            }),
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
        sessionId: sessionResult.sessionId,
        prompt,
        powResponse,
        thinkingEnabled: isThinking,
      });

      if (sseResult.error) {
        yield { type: 'error', message: `DeepSeek API error: ${sseResult.error}` };
        return;
      }

      // Step 6: Parse SSE
      const lines = (sseResult.data ?? '').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const events = normalizeDeepSeekSSE(trimmed);
        for (const event of events) {
          yield event;
        }
      }

    } catch (err) {
      yield { type: 'error', message: `DeepSeek provider error: ${(err as Error).message}` };
    }
  }
}
