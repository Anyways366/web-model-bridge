import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';

import { solvePow, buildPowResponse, type DeepSeekPowChallenge } from './pow.js';
import { buildDeepSeekPrompt, resolveDeepSeekModel } from './tools.js';
import { parseDeepSeekStream } from './sse.js';
import { DeepSeekSessionStore, advanceSession, type DeepSeekSessionState } from './session.js';
import { DEEPSEEK_WEB_BASE_URL, DEEPSEEK_LOGIN_URL, DEEPSEEK_API_CREATE_SESSION, DEEPSEEK_API_COMPLETION } from './client.js';
import { AuthStore } from '../../auth/store.js';
import type { Page } from 'playwright-core';

/** PoW handshake attempts (1 bare POST + up to 2 solved re-POSTs). */
const MAX_POW_ATTEMPTS = 3;

/**
 * DeepSeek web provider.
 *
 * Wire contract: docs/deepseek-web-wire-spec.md (frozen).
 * Network surface (localhost-only from OpenCode's perspective, same-origin
 * browser fetches only): page origin + POST /api/v0/chat/create_session +
 * POST /api/v0/chat/completion. No other destinations, no telemetry, no
 * account rotation, no proxying, no fingerprint handling.
 */

interface EvaluateResult {
  kind: 'stream' | 'challenge' | 'error';
  data?: string;
  challenge?: DeepSeekPowChallenge;
  status?: number;
  code?: string;
  message?: string;
}

export class DeepSeekProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'deepseek-web',
    name: 'DeepSeek Web',
    website: DEEPSEEK_WEB_BASE_URL,
    loginUrl: DEEPSEEK_LOGIN_URL,
    needsBrowser: true,
  };

  private bearerToken: string | null = null;
  private readonly sessions = new DeepSeekSessionStore();

  constructor(
    private authStore: AuthStore,
    _browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
    private getPage?: (origin: string) => Promise<Page>,
  ) {
    super();
  }

  /** Set a bearer token for API authentication (e.g. from OpenClaw auth-profiles) */
  setBearerToken(token: string): void {
    this.bearerToken = token;
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
      // Frozen demux ids
      { id: 'deepseek-default', name: 'DeepSeek V4 (default tier)', contextWindow: 128000, maxOutput: 8192 },
      { id: 'deepseek-expert', name: 'DeepSeek V4 (expert tier)', contextWindow: 128000, maxOutput: 8192 },
      { id: 'deepseek-vision', name: 'DeepSeek V4 Vision', contextWindow: 128000, maxOutput: 8192 },
      // Legacy aliases (kept for existing configs)
      { id: 'deepseek-v4', name: 'DeepSeek V4 (legacy alias)', contextWindow: 128000, maxOutput: 8192 },
      { id: 'deepseek-v4-reasoner', name: 'DeepSeek V4 Reasoner (legacy alias)', contextWindow: 128000, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.getPage) {
      yield { type: 'error', code: 'provider', message: 'Browser not connected' };
      return;
    }

    const cfg = resolveDeepSeekModel(req.model);
    const hasTools = !!req.tools?.length;

    try {
      const page = await this.getPage(DEEPSEEK_WEB_BASE_URL);

      // Step 1: Extract bearer token by intercepting the logged-in page's
      // own API calls (the browser holds the credentials; we never store
      // or log them).
      const bearer = await this.extractBearerToken(page);
      if (!bearer) {
        yield {
          type: 'error',
          code: 'auth',
          message: 'DeepSeek: could not extract bearer token. Please re-login at chat.deepseek.com',
        };
        return;
      }

      // Step 2: Session state (Phase 4 — per-conversation continuity).
      let state: DeepSeekSessionState;
      let conversationKey: string;
      const existing = req.conversationId ? this.sessions.get(req.conversationId) : undefined;
      if (existing) {
        state = existing; // reuse the same session + parent chain
        conversationKey = req.conversationId!;
      } else {
        const sessionId = await this.createSession(page, bearer);
        if (!sessionId) {
          yield { type: 'error', code: 'api', message: 'DeepSeek session create failed: no session id' };
          return;
        }
        state = { sessionId, parentMessageId: null };
        conversationKey = sessionId;
      }

      // Step 3: Build prompt (frozen protocol markers, byte-verified).
      const prompt = buildDeepSeekPrompt(req.messages, req.tools);

      // Step 4: Completion with PoW handshake (ping → solve → ready).
      const body = {
        chat_session_id: state.sessionId,
        parent_message_id: state.parentMessageId,
        model_type: cfg.modelType,
        prompt,
        ref_file_ids: [],
        thinking_enabled: cfg.thinking,
        search_enabled: false,
        preempt: false,
      };

      const result = await this.completionWithPow(page, body, bearer);
      if (result.kind === 'error') {
        yield {
          type: 'error',
          code: result.code ?? mapHttpError(result.status ?? 0),
          message: `DeepSeek API error: ${result.message ?? `HTTP ${result.status}`}`,
        };
        return;
      }

      // Step 5: Parse the wire stream (SSE, ready metadata, errors).
      const parsed = parseDeepSeekStream(result.data ?? '', hasTools);
      if (parsed.error) {
        yield { type: 'error', code: parsed.error.code, message: parsed.error.message };
        return;
      }

      // Step 6: Advance the parent chain from the ready metadata.
      state = advanceSession(state, parsed.ready);
      this.sessions.set(conversationKey, state);

      // Step 7: Surface events, tagging the terminal done with the
      // conversation id so the caller can continue this session next turn.
      const events = parsed.events;
      const last = events[events.length - 1];
      for (const ev of events) {
        if (ev === last && ev.type === 'done') {
          yield { ...ev, conversationId: conversationKey };
        } else {
          yield ev;
        }
      }
    } catch (err) {
      yield { type: 'error', code: 'provider', message: `DeepSeek provider error: ${(err as Error).message}` };
    }
  }

  /** Intercept the page's own API calls to harvest the live bearer token. */
  private async extractBearerToken(page: Page): Promise<string | null> {
    if (this.bearerToken) return this.bearerToken;
    const tokenPromise = new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 10000);
      const handler = (request: any) => {
        const url = request.url() as string;
        if (url.includes('/api/v0/')) {
          const auth = request.headers()['authorization'] as string | undefined;
          if (auth?.startsWith('Bearer ')) {
            clearTimeout(timeout);
            page.off('request', handler);
            resolve(auth.slice(7));
          }
        }
      };
      page.on('request', handler);
    });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
    return tokenPromise;
  }

  /** POST /api/v0/chat/create_session (empty body) → chat_session_id. */
  private async createSession(page: Page, bearer: string): Promise<string | null> {
    const res = await page.evaluate(
      async (args: { endpoint: string; bearerToken: string }): Promise<{ sessionId?: string; error?: string }> => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (args.bearerToken) headers['Authorization'] = `Bearer ${args.bearerToken}`;
        try {
          const r = await fetch(args.endpoint, {
            method: 'POST',
            headers,
            body: '{}',
            credentials: 'include',
          });
          if (!r.ok) return { error: `HTTP ${r.status}` };
          const data = await r.json();
          const sessionId = data?.data?.chat_session_id ?? data?.data?.id ?? data?.chat_session_id ?? null;
          return sessionId ? { sessionId } : { error: 'no session id' };
        } catch (e: unknown) {
          return { error: (e as Error).message };
        }
      },
      { endpoint: DEEPSEEK_API_CREATE_SESSION, bearerToken: bearer },
    );
    if (res.error || !res.sessionId) return null;
    return res.sessionId;
  }

  /**
   * Completion with PoW handshake (frozen spec §3): the first SSE event of a
   * bare POST is the `ping` challenge; solve it (node-side) and re-POST with
   * `x-ds-pow-response`. At most MAX_POW_ATTEMPTS requests — never an
   * unbounded retry loop. When the first event is `ready` (no PoW needed),
   * the same response continues streaming and is consumed fully.
   */
  private async completionWithPow(
    page: Page,
    body: Record<string, unknown>,
    bearer: string,
  ): Promise<EvaluateResult> {
    let powHeader: string | null = null;
    for (let attempt = 0; attempt < MAX_POW_ATTEMPTS; attempt++) {
      const res = await page.evaluate(
        async (args: {
          endpoint: string;
          body: Record<string, unknown>;
          bearerToken: string;
          powHeader: string | null;
        }): Promise<EvaluateResult> => {
          try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (args.bearerToken) headers['Authorization'] = `Bearer ${args.bearerToken}`;
            if (args.powHeader) headers['x-ds-pow-response'] = args.powHeader;

            const res = await fetch(args.endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify(args.body),
              credentials: 'include',
            });
            if (!res.ok) {
              const text = await res.text();
              return { kind: 'error', status: res.status, message: text.substring(0, 500) || `HTTP ${res.status}` };
            }

            const reader = res.body?.getReader();
            if (!reader) return { kind: 'error', status: 0, message: 'No response body' };
            const decoder = new TextDecoder();
            let buf = '';

            // Probe: read until the first complete SSE event block (`\n\n`)
            // or EOF — this decides ping vs. live stream.
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const blank = buf.search(/\n\s*\n/);
              if (blank >= 0 || buf.length > 65536) break;
            }

            const firstBlock = buf.slice(0, buf.search(/\n\s*\n/));
            const firstData = firstBlock
              .split('\n')
              .map((l) => l.trim())
              .find((l) => l.startsWith('data: '))
              ?.slice(6);
            if (firstData && !args.powHeader) {
              try {
                const parsed = JSON.parse(firstData);
                const v = (parsed as Record<string, unknown>)?.v as Record<string, unknown> | undefined;
                const response = v?.response as Record<string, unknown> | undefined;
                if (response && typeof response.challenge === 'string' && typeof response.algorithm === 'string') {
                  return {
                    kind: 'challenge',
                    challenge: {
                      algorithm: response.algorithm as string,
                      challenge: response.challenge as string,
                      difficulty: typeof response.difficulty === 'number' ? response.difficulty : 0,
                      salt: response.salt as string,
                      signature: response.signature as string,
                      ...(typeof response.expire_at === 'number' ? { expire_at: response.expire_at } : {}),
                    },
                  };
                }
              } catch {
                // Not a challenge frame — fall through and stream the body.
              }
            }

            // Live stream (ready or later): consume the remainder.
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
            }
            buf += decoder.decode();
            return { kind: 'stream', data: buf };
          } catch (e: unknown) {
            return { kind: 'error', status: 0, message: (e as Error).message };
          }
        },
        { endpoint: DEEPSEEK_API_COMPLETION, body, bearerToken: bearer, powHeader },
      );

      if (res.kind === 'challenge' && res.challenge) {
        try {
          const answer = await solvePow(res.challenge);
          powHeader = buildPowResponse(res.challenge, answer, '/api/v0/chat/completion');
          continue;
        } catch (err) {
          return { kind: 'error', status: 0, code: 'pow', message: `PoW solve failed: ${(err as Error).message}` };
        }
      }
      if (res.kind === 'error') return res;
      return res;
    }
    return { kind: 'error', status: 0, code: 'pow', message: 'PoW challenge loop exceeded attempts' };
  }
}

/**
 * HTTP status → provider error code (frozen spec §13 taxonomy).
 * 401/403 = expired/invalid authentication; 429 = rate limit; 5xx = API.
 */
function mapHttpError(status: number): string {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'overloaded';
  if (status >= 500) return 'api';
  return 'api';
}