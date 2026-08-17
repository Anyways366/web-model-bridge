import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest } from '../../src/core/provider.js';
import type { StreamEvent } from '../../src/core/stream.js';

export class MockProvider extends BaseProvider {
  readonly info: ProviderInfo;
  private _authenticated: boolean;
  private _models: ModelInfo[];

  constructor(
    id: string,
    opts?: { authenticated?: boolean; models?: ModelInfo[] }
  ) {
    super();
    this.info = {
      id,
      name: `Mock ${id}`,
      website: `https://${id}.example.com`,
      loginUrl: `https://${id}.example.com/login`,
      needsBrowser: true,
    };
    this._authenticated = opts?.authenticated ?? true;
    this._models = opts?.models ?? [
      { id: 'mock-model-1', name: 'Mock Model 1', contextWindow: 100000, maxOutput: 4096 },
    ];
  }

  async login(): Promise<void> {
    this._authenticated = true;
  }

  async isAuthenticated(): Promise<boolean> {
    return this._authenticated;
  }

  async detectLoginComplete(): Promise<boolean> {
    return this._authenticated;
  }

  async models(): Promise<ModelInfo[]> {
    return this._models;
  }

  async *chat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'text_delta', delta: `Hello from ${this.info.id}` };
    yield { type: 'done', reason: 'stop' };
  }
}

/**
 * Records the exact ChatRequest it receives so tests can assert what the
 * route handed to the provider, and replays a scripted event sequence.
 */
export class CapturingProvider extends MockProvider {
  lastRequest: ChatRequest | null = null;
  script: StreamEvent[];

  constructor(id: string, script: StreamEvent[] = []) {
    super(id);
    this.script = script;
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.lastRequest = req;
    if (this.script.length === 0) {
      yield { type: 'text_delta', delta: 'reply' };
      yield { type: 'done', reason: 'stop' };
      return;
    }
    for (const event of this.script) {
      yield event;
    }
  }
}
