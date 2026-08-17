import { describe, it, expect, beforeEach } from 'vitest';
import { Router } from '../../../src/core/router.js';
import { ProviderRegistry } from '../../../src/core/registry.js';
import { MockProvider } from '../../helpers/mock-provider.js';
import { ScriptedMockProvider, ThrowingMockProvider } from '../../helpers/mock-sse.js';
import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest } from '../../../src/core/provider.js';
import type { StreamEvent } from '../../../src/core/stream.js';

class FailingProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'failing',
    name: 'Failing',
    website: 'https://fail.example.com',
    loginUrl: 'https://fail.example.com/login',
    needsBrowser: false,
  };
  constructor(private failCount: number) { super(); }
  async login(_context: { openUrl: (url: string) => Promise<void> }): Promise<void> {}
  async isAuthenticated(): Promise<boolean> { return true; }
  async detectLoginComplete(): Promise<boolean> { return true; }
  async models(): Promise<ModelInfo[]> {
    return [{ id: 'fail-model', name: 'Fail', contextWindow: 1000, maxOutput: 100 }];
  }
  private attempts = 0;
  async *chat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    this.attempts++;
    if (this.attempts <= this.failCount) {
      yield { type: 'error', message: 'Provider failed' };
      return;
    }
    yield { type: 'text_delta', delta: 'Recovered!' };
    yield { type: 'done', reason: 'stop' };
  }
}

describe('Router', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it('routes to primary provider on success', async () => {
    const primary = new MockProvider('claude-web', { authenticated: true });
    registry.register(primary);
    const router = new Router(registry);

    const events: StreamEvent[] = [];
    for await (const e of router.chat('claude-web/mock-model-1', {
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })) {
      events.push(e);
    }
    expect(events.some(e => e.type === 'text_delta')).toBe(true);
  });

  it('falls back when primary is not authenticated', async () => {
    const primary = new MockProvider('claude-web', { authenticated: false });
    const fallback = new MockProvider('deepseek-web', { authenticated: true });
    registry.register(primary);
    registry.register(fallback);

    const router = new Router(registry, {
      fallbacks: { 'claude-web': ['deepseek-web'] },
    });

    const events: StreamEvent[] = [];
    for await (const e of router.chat('claude-web/model', {
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })) {
      events.push(e);
    }
    expect(events.some(e => e.type === 'text_delta' && e.delta.includes('deepseek-web'))).toBe(true);
  });

  it('retries on error then succeeds', async () => {
    const failing = new FailingProvider(1); // Fail once, then succeed
    registry.register(failing);
    const router = new Router(registry, { maxRetries: 2 });

    const events: StreamEvent[] = [];
    for await (const e of router.chat('failing/fail-model', {
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })) {
      events.push(e);
    }
    expect(events.some(e => e.type === 'text_delta' && e.delta === 'Recovered!')).toBe(true);
  });

  it('exhausts retries and falls back', async () => {
    const failing = new FailingProvider(999); // Always fails
    const fallback = new MockProvider('backup', { authenticated: true });
    registry.register(failing);
    registry.register(fallback);

    const router = new Router(registry, {
      fallbacks: { 'failing': ['backup'] },
      maxRetries: 0, // No retries, go straight to fallback
    });

    const events: StreamEvent[] = [];
    for await (const e of router.chat('failing/fail-model', {
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })) {
      events.push(e);
    }
    expect(events.some(e => e.type === 'text_delta' && e.delta.includes('backup'))).toBe(true);
  });

  it('returns error when all attempts fail', async () => {
    const failing = new FailingProvider(999);
    registry.register(failing);
    const router = new Router(registry, { maxRetries: 0 });

    const events: StreamEvent[] = [];
    for await (const e of router.chat('failing/fail-model', {
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })) {
      events.push(e);
    }
    expect(events.some(e => e.type === 'error')).toBe(true);
  });
});

describe('Router streaming semantics', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it('yields events as they arrive without waiting for the full response', async () => {
    const provider = new ScriptedMockProvider('probe', [
      () => [
        { type: 'text_delta', delta: 'a' },
        { type: 'text_delta', delta: 'b' },
        { type: 'done', reason: 'stop' },
      ],
    ]);
    registry.register(provider);
    const router = new Router(registry, { maxRetries: 0 });

    const iterator = router.chat('probe/test-model', {
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })[Symbol.asyncIterator]();

    // The first event must be available before the provider finishes
    const first = await iterator.next();
    expect(first.value).toEqual({ type: 'text_delta', delta: 'a' });
    const rest: StreamEvent[] = [];
    for await (const e of iterator) rest.push(e);
    expect(rest).toEqual([
      { type: 'text_delta', delta: 'b' },
      { type: 'done', reason: 'stop' },
    ]);
  });

  it('does not retry or switch providers once output has been emitted', async () => {
    const midStream = new ScriptedMockProvider('midstream', [
      () => [
        { type: 'text_delta', delta: 'partial' },
        { type: 'error', message: 'stream broke', code: 'upstream_blocked' },
      ],
    ]);
    const fallback = new ScriptedMockProvider('backup', [
      () => [{ type: 'text_delta', delta: 'should-never-appear' }, { type: 'done', reason: 'stop' }],
    ]);
    registry.register(midStream);
    registry.register(fallback);
    const router = new Router(registry, {
      fallbacks: { 'midstream': ['backup'] },
      maxRetries: 2,
    });

    const events: StreamEvent[] = [];
    for await (const e of router.chat('midstream/test-model', {
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })) {
      events.push(e);
    }

    expect(events).toEqual([
      { type: 'text_delta', delta: 'partial' },
      { type: 'error', message: 'stream broke', code: 'upstream_blocked' },
    ]);
    expect(midStream.callCount).toBe(1);
    expect(fallback.callCount).toBe(0);
  });

  it('does not retry when the provider throws after emitting output', async () => {
    const throwing = new ThrowingMockProvider('thrower', new Error('connection reset'), [
      { type: 'text_delta', delta: 'partial' },
    ]);
    registry.register(throwing);
    const router = new Router(registry, { maxRetries: 2 });

    const events: StreamEvent[] = [];
    for await (const e of router.chat('thrower/test-model', {
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })) {
      events.push(e);
    }

    expect(events[0]).toEqual({ type: 'text_delta', delta: 'partial' });
    expect(events[1].type).toBe('error');
    expect((events[1] as StreamEvent & { type: 'error' }).message).toBe('connection reset');
    expect(throwing.callCount).toBe(1);
  });

  it('never replays events from a failed attempt when retrying before output', async () => {
    const flaky = new ScriptedMockProvider('flaky', [
      // First call: fails before any output
      () => [{ type: 'error', message: 'transient' }],
      // Second call: succeeds
      () => [
        { type: 'text_delta', delta: 'final-answer' },
        { type: 'done', reason: 'stop' },
      ],
    ]);
    registry.register(flaky);
    const router = new Router(registry, { maxRetries: 2 });

    const events: StreamEvent[] = [];
    for await (const e of router.chat('flaky/test-model', {
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })) {
      events.push(e);
    }

    expect(events).toEqual([
      { type: 'text_delta', delta: 'final-answer' },
      { type: 'done', reason: 'stop' },
    ]);
    expect(flaky.callCount).toBe(2);
  });

  it('retries an error event that arrives before any output', async () => {
    const flaky = new ScriptedMockProvider('flaky2', [
      () => [{ type: 'error', message: 'transient' }],
      () => [{ type: 'text_delta', delta: 'ok' }, { type: 'done', reason: 'stop' }],
    ]);
    registry.register(flaky);
    const router = new Router(registry, { maxRetries: 2 });

    const events: StreamEvent[] = [];
    for await (const e of router.chat('flaky2/test-model', {
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })) {
      events.push(e);
    }
    expect(events.some(e => e.type === 'text_delta' && e.delta === 'ok')).toBe(true);
    expect(flaky.callCount).toBe(2);
  });

  it('honors abort signal between retries', async () => {
    const flaky = new ScriptedMockProvider('flaky3', [
      () => [{ type: 'error', message: 'transient' }],
      () => [{ type: 'text_delta', delta: 'never' }, { type: 'done', reason: 'stop' }],
    ]);
    registry.register(flaky);
    const router = new Router(registry, { maxRetries: 2 });

    const controller = new AbortController();
    controller.abort();
    const events: StreamEvent[] = [];
    for await (const e of router.chat('flaky3/test-model', {
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
      signal: controller.signal,
    })) {
      events.push(e);
    }
    expect(events).toEqual([]);
    expect(flaky.callCount).toBe(0);
  });

  it('marks unauthenticated providers with auth_required code', async () => {
    const unauth = new ScriptedMockProvider('unauth', [
      () => [{ type: 'text_delta', delta: 'never' }],
    ], { authenticated: false });
    registry.register(unauth);
    const router = new Router(registry, { maxRetries: 0 });

    const events: StreamEvent[] = [];
    for await (const e of router.chat('unauth/test-model', {
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'auth_required' });
  });

  it('preserves usage reported by the provider on done', async () => {
    const provider = new ScriptedMockProvider('usage', [
      () => [{
        type: 'done',
        reason: 'stop',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }],
    ]);
    registry.register(provider);
    const router = new Router(registry, { maxRetries: 0 });

    const events: StreamEvent[] = [];
    for await (const e of router.chat('usage/test-model', {
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })) {
      events.push(e);
    }
    expect(events).toEqual([{
      type: 'done',
      reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }]);
  });
});
