import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest } from '../../src/core/provider.js';
import type { StreamEvent } from '../../src/core/stream.js';

export class DelayedMockProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'delayed-mock',
    name: 'Delayed Mock',
    website: 'https://example.com',
    loginUrl: 'https://example.com/login',
    needsBrowser: false,
  };

  constructor(private chunks: StreamEvent[], private delayMs = 0) {
    super();
  }

  async login(): Promise<void> {}
  async isAuthenticated(): Promise<boolean> { return true; }
  async detectLoginComplete(): Promise<boolean> { return true; }
  async models(): Promise<ModelInfo[]> {
    return [{ id: 'test-model', name: 'Test', contextWindow: 100000, maxOutput: 4096 }];
  }

  async *chat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    for (const chunk of this.chunks) {
      if (this.delayMs > 0) {
        await new Promise(r => setTimeout(r, this.delayMs));
      }
      yield chunk;
    }
  }
}

/**
 * Provider whose output is driven by a per-call script. Useful for testing
 * retry/fallback semantics: scripts[0] runs on the first chat() call,
 * scripts[1] on the second, and so on (the last script repeats).
 */
export class ScriptedMockProvider extends BaseProvider {
  readonly info: ProviderInfo;
  callCount = 0;

  constructor(
    id: string,
    private scripts: Array<() => StreamEvent[]>,
    opts?: { authenticated?: boolean; models?: ModelInfo[] },
  ) {
    super();
    this.info = {
      id,
      name: `Scripted ${id}`,
      website: `https://${id}.example.com`,
      loginUrl: `https://${id}.example.com/login`,
      needsBrowser: false,
    };
    this._authenticated = opts?.authenticated ?? true;
    this._models = opts?.models ?? [{ id: 'test-model', name: 'Test', contextWindow: 100000, maxOutput: 4096 }];
  }

  private _authenticated: boolean;
  private _models: ModelInfo[];

  async login(): Promise<void> { this._authenticated = true; }
  async isAuthenticated(): Promise<boolean> { return this._authenticated; }
  async detectLoginComplete(): Promise<boolean> { return this._authenticated; }
  async models(): Promise<ModelInfo[]> { return this._models; }

  async *chat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    const idx = Math.min(this.callCount, this.scripts.length - 1);
    this.callCount++;
    for (const event of this.scripts[idx]()) {
      yield event;
    }
  }
}

/**
 * Provider that throws after emitting a scripted prefix. `throwOnCall` is
 * 1-based: the throw happens on the Nth call; later calls succeed.
 */
export class ThrowingMockProvider extends BaseProvider {
  readonly info: ProviderInfo;
  callCount = 0;

  constructor(
    id: string,
    private error: Error = new Error('mock boom'),
    private eventsBeforeThrow: StreamEvent[] = [],
    private throwOnCall = 1,
    private successEvents: StreamEvent[] = [
      { type: 'text_delta', delta: 'recovered' },
      { type: 'done', reason: 'stop' },
    ],
  ) {
    super();
    this.info = {
      id,
      name: `Throwing ${id}`,
      website: `https://${id}.example.com`,
      loginUrl: `https://${id}.example.com/login`,
      needsBrowser: false,
    };
  }

  async login(): Promise<void> {}
  async isAuthenticated(): Promise<boolean> { return true; }
  async detectLoginComplete(): Promise<boolean> { return true; }
  async models(): Promise<ModelInfo[]> {
    return [{ id: 'test-model', name: 'Test', contextWindow: 100000, maxOutput: 4096 }];
  }

  async *chat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    this.callCount++;
    if (this.callCount < this.throwOnCall) {
      for (const event of this.successEvents) yield event;
      return;
    }
    for (const event of this.eventsBeforeThrow) yield event;
    throw this.error;
  }
}