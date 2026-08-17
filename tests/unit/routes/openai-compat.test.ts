import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/test-server.js';
import { MockProvider, CapturingProvider } from '../../helpers/mock-provider.js';
import { ScriptedMockProvider, ThrowingMockProvider, DelayedMockProvider } from '../../helpers/mock-sse.js';
import { Router } from '../../../src/core/router.js';

describe('POST /v1/chat/completions', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  it('returns streaming SSE response', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: {');
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('Hello from claude-web');
    expect(text).toContain('data: [DONE]');
  });

  it('returns non-streaming JSON response', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toContain('Hello from claude-web');
  });

  it('returns 400 for missing model', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
  });

  it('returns 400 for invalid model ID', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'no-slash',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_model');
  });

  it('returns 401 for unauthenticated provider', async () => {
    ctx = createTestContext({
      providers: [new MockProvider('claude-web', { authenticated: false })],
    });
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('auth_required');
  });

  it('returns 403 when auth token required but not provided', async () => {
    ctx = createTestContext({ authToken: 'secret-123' });
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(res.status).toBe(403);
  });

  it('passes with correct auth token', async () => {
    ctx = createTestContext({ authToken: 'secret-123' });
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer secret-123',
      },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
  });
});

describe('GET /v1/models', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  it('returns model list', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/models');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].id).toBe('claude-web/claude-sonnet-4-6');
    expect(body.data[0].object).toBe('model');
  });
});

describe('POST /v1/chat/completions streaming robustness', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  function streamRequest(body: Record<string, unknown>) {
    return ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns a JSON error (not corrupted SSE) when the provider fails before any output', async () => {
    const failing = new ScriptedMockProvider('fail-first', [
      () => [{ type: 'error', message: 'upstream exploded', code: 'upstream_blocked' }],
    ]);
    // maxRetries 0 so the test does not wait on backoff
    ctx = createTestContext({
      providers: [failing],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await streamRequest({
      model: 'fail-first/test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('upstream_blocked');
  });

  it('returns 401 JSON error before any SSE when provider is unauthenticated', async () => {
    const unauth = new ScriptedMockProvider('unauth-route', [
      () => [{ type: 'text_delta', delta: 'never' }],
    ], { authenticated: false });
    ctx = createTestContext({
      providers: [unauth],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await streamRequest({
      model: 'unauth-route/test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.code).toBe('auth_required');
  });

  it('surfaces a mid-stream error as an error chunk without duplicating or retrying', async () => {
    const midStream = new ScriptedMockProvider('midstream-route', [
      () => [
        { type: 'text_delta', delta: 'Hello' },
        { type: 'text_delta', delta: ' world' },
        { type: 'error', message: 'connection lost', code: 'upstream_blocked' },
      ],
    ]);
    const fallback = new ScriptedMockProvider('fallback-route', [
      () => [{ type: 'text_delta', delta: 'NEVER' }, { type: 'done', reason: 'stop' }],
    ]);
    ctx = createTestContext({
      providers: [midStream, fallback],
      router: (registry) => new Router(registry, {
        fallbacks: { 'midstream-route': ['fallback-route'] },
        maxRetries: 2,
      }),
    });

    const res = await streamRequest({
      model: 'midstream-route/test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
    const chunks = dataLines.map(l => l.slice(6));

    // Content appears exactly once — no replay of already-emitted events
    const contentChunks = chunks
      .filter(c => c !== '[DONE]')
      .map(c => JSON.parse(c).choices?.[0]?.delta?.content)
      .filter(Boolean);
    expect(contentChunks.join('')).toBe('Hello world');

    // Error is surfaced as an OpenAI-spec error chunk
    const errorChunk = chunks
      .map(c => { try { return JSON.parse(c); } catch { return null; } })
      .find(p => p && p.error);
    expect(errorChunk.error.message).toBe('connection lost');
    expect(errorChunk.error.code).toBe('upstream_blocked');

    // Never falls back after output has begun
    expect(fallback.callCount).toBe(0);
    expect(midStream.callCount).toBe(1);

    // Stream still terminates with [DONE]
    expect(chunks[chunks.length - 1]).toBe('[DONE]');
  });

  it('surfaces a thrown mid-stream error without retrying', async () => {
    const throwing = new ThrowingMockProvider('throwing-route', new Error('sock reset'), [
      { type: 'text_delta', delta: 'partial' },
    ]);
    ctx = createTestContext({
      providers: [throwing],
      router: (registry) => new Router(registry, { maxRetries: 2 }),
    });

    const res = await streamRequest({
      model: 'throwing-route/test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    const text = await res.text();
    const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
    const chunks = dataLines.map(l => l.slice(6));
    const errorChunk = chunks
      .map(c => { try { return JSON.parse(c); } catch { return null; } })
      .find(p => p && p.error);

    expect(errorChunk.error.message).toBe('sock reset');
    expect(chunks[chunks.length - 1]).toBe('[DONE]');
    expect(throwing.callCount).toBe(1);
  });

  it('synthesizes a terminal finish chunk when the provider ends without one', async () => {
    const noTerminal = new ScriptedMockProvider('no-terminal', [
      () => [{ type: 'text_delta', delta: 'hi there' }],
    ]);
    ctx = createTestContext({
      providers: [noTerminal],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await streamRequest({
      model: 'no-terminal/test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    const text = await res.text();
    const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
    const chunks = dataLines.map(l => l.slice(6));
    const lastJson = chunks.filter(c => c !== '[DONE]').at(-1)!;

    expect(JSON.parse(lastJson).choices[0].finish_reason).toBe('stop');
    expect(chunks[chunks.length - 1]).toBe('[DONE]');
  });

  it('responds to an empty stream with just [DONE]', async () => {
    const empty = new ScriptedMockProvider('empty-route', [() => []]);
    ctx = createTestContext({
      providers: [empty],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await streamRequest({
      model: 'empty-route/test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('data: [DONE]\n\n');
  });

  it('emits a usage chunk when the provider reports usage on done', async () => {
    const withUsage = new ScriptedMockProvider('usage-route', [
      () => [
        { type: 'text_delta', delta: 'answer' },
        { type: 'done', reason: 'stop', usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
      ],
    ]);
    ctx = createTestContext({
      providers: [withUsage],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await streamRequest({
      model: 'usage-route/test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    const text = await res.text();
    const jsonChunks = text.split('\n')
      .filter(l => l.startsWith('data: {'))
      .map(l => JSON.parse(l.slice(6)));

    const usageChunk = jsonChunks.find(c => c.usage);
    expect(usageChunk.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    expect(usageChunk.choices).toEqual([]);
  });

  it('non-streaming: returns error JSON before any content when provider fails', async () => {
    const failing = new ScriptedMockProvider('ns-fail', [
      () => [{ type: 'error', message: 'nope', code: 'upstream_rate_limit' }],
    ]);
    ctx = createTestContext({
      providers: [failing],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await streamRequest({
      model: 'ns-fail/test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: false,
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('upstream_rate_limit');
  });

  it('non-streaming: preserves usage in the response when reported', async () => {
    const withUsage = new ScriptedMockProvider('ns-usage', [
      () => [
        { type: 'text_delta', delta: 'hello' },
        { type: 'done', reason: 'stop', usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } },
      ],
    ]);
    ctx = createTestContext({
      providers: [withUsage],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await streamRequest({
      model: 'ns-usage/test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('hello');
    expect(body.usage).toEqual({ prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 });
  });

  it('falls back to a configured fallback provider when primary fails before output', async () => {
    const failing = new ScriptedMockProvider('primary-route', [
      () => [{ type: 'error', message: 'down', code: 'upstream_blocked' }],
    ]);
    const backup = new ScriptedMockProvider('backup-route', [
      () => [{ type: 'text_delta', delta: 'from backup' }, { type: 'done', reason: 'stop' }],
    ]);
    ctx = createTestContext({
      providers: [failing, backup],
      router: (registry) => new Router(registry, {
        fallbacks: { 'primary-route': ['backup-route'] },
        maxRetries: 0,
      }),
    });

    const res = await streamRequest({
      model: 'primary-route/test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    const text = await res.text();
    const content = text.split('\n')
      .filter(l => l.startsWith('data: {'))
      .map(l => JSON.parse(l.slice(6)).choices[0].delta.content)
      .filter(Boolean)
      .join('');
    expect(content).toBe('from backup');
  });

  it('delivers the full conversation to the provider: order, tool_calls, tool_call_id, multimodal blocks', async () => {
    const capture = new CapturingProvider('capture-route');
    ctx = createTestContext({
      providers: [capture],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const toolCalls = [{
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
    }];
    const content = [
      { type: 'text', text: 'Describe' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ];
    const res = await streamRequest({
      model: 'capture-route/test-model',
      stream: false,
      messages: [
        { role: 'system', content: 'You are a weather assistant' },
        { role: 'user', content: 'What is the weather?' },
        { role: 'assistant', content: '', tool_calls: toolCalls },
        { role: 'tool', content: '22C', tool_call_id: 'call_1' },
        { role: 'user', content },
      ],
    });
    expect(res.status).toBe(200);

    expect(capture.lastRequest).not.toBeNull();
    const req = capture.lastRequest!;
    expect(req.messages).toEqual([
      { role: 'system', content: 'You are a weather assistant' },
      { role: 'user', content: 'What is the weather?' },
      { role: 'assistant', content: '', tool_calls: toolCalls },
      { role: 'tool', content: '22C', tool_call_id: 'call_1' },
      { role: 'user', content },
    ]);
  });

  it('passes conversation_id through to the provider request', async () => {
    const capture = new CapturingProvider('capture-conv');
    ctx = createTestContext({
      providers: [capture],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await streamRequest({
      model: 'capture-conv/test-model',
      stream: false,
      messages: [{ role: 'user', content: 'Hi' }],
      conversation_id: 'conv-123',
    });
    expect(res.status).toBe(200);
    expect(capture.lastRequest!.conversationId).toBe('conv-123');
  });

  it('non-streaming: echoes provider conversation id in x-wmb-conversation-id header', async () => {
    const withConv = new ScriptedMockProvider('ns-conv-id', [
      () => [
        { type: 'text_delta', delta: 'ok' },
        { type: 'done', reason: 'stop', conversationId: 'server-conv-9' },
      ],
    ]);
    ctx = createTestContext({
      providers: [withConv],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await streamRequest({
      model: 'ns-conv-id/test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: false,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-wmb-conversation-id')).toBe('server-conv-9');
  });

  it('streaming: emits wmb_conversation_id chunk before [DONE]', async () => {
    const withConv = new ScriptedMockProvider('stream-conv-id', [
      () => [
        { type: 'text_delta', delta: 'ok' },
        { type: 'done', reason: 'stop', conversationId: 'server-conv-9' },
      ],
    ]);
    ctx = createTestContext({
      providers: [withConv],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await streamRequest({
      model: 'stream-conv-id/test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    const text = await res.text();
    const lines = text.split('\n').filter(l => l.startsWith('data: '));
    expect(lines[lines.length - 2]).toContain('wmb_conversation_id');
    expect(JSON.parse(lines[lines.length - 2].slice(6)).wmb_conversation_id).toBe('server-conv-9');
    expect(lines[lines.length - 1]).toBe('data: [DONE]');
  });
});
