import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/test-server.js';
import { MockProvider, CapturingProvider } from '../../helpers/mock-provider.js';
import { DelayedMockProvider, ScriptedMockProvider } from '../../helpers/mock-sse.js';
import { Router } from '../../../src/core/router.js';

describe('POST /v1/messages (Anthropic)', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  it('returns non-streaming Anthropic response', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'test',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.content[0].type).toBe('text');
    expect(body.content[0].text).toContain('Hello from claude-web');
    expect(body.stop_reason).toBe('end_turn');
  });

  it('returns streaming Anthropic SSE response', async () => {
    const provider = new DelayedMockProvider([
      { type: 'text_delta', delta: 'Hello' },
      { type: 'text_delta', delta: ' world' },
      { type: 'done', reason: 'stop' },
    ]);
    ctx = createTestContext({ providers: [provider] });
    const res = await ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'delayed-mock/test-model',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_start');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('"text_delta"');
    expect(text).toContain('Hello');
    expect(text).toContain(' world');
    expect(text).toContain('event: content_block_stop');
    expect(text).toContain('event: message_delta');
    expect(text).toContain('"end_turn"');
    expect(text).toContain('event: message_stop');
  });

  it('handles system message', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        max_tokens: 1024,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe('message');
  });

  it('handles content array format', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        }],
      }),
    });
    expect(res.status).toBe(200);
  });

  it('returns 400 for missing model', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1024 }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 for unauthenticated provider', async () => {
    ctx = createTestContext({
      providers: [new MockProvider('claude-web', { authenticated: false })],
    });
    const res = await ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 when auth token required but not provided', async () => {
    ctx = createTestContext({ authToken: 'secret' });
    const res = await ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(res.status).toBe(403);
  });

  it('passes with x-api-key header (Anthropic SDK style)', async () => {
    ctx = createTestContext({ authToken: 'secret' });
    const res = await ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'secret',
      },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(res.status).toBe(200);
  });

  it('handles system as array of content blocks', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        max_tokens: 1024,
        system: [
          { type: 'text', text: 'You are helpful.' },
          { type: 'text', text: ' Be concise.', cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe('message');
  });

  it('streaming has correct event order', async () => {
    const provider = new DelayedMockProvider([
      { type: 'text_delta', delta: 'Hi' },
      { type: 'done', reason: 'stop' },
    ]);
    ctx = createTestContext({ providers: [provider] });
    const res = await ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'delayed-mock/test-model',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
    });
    const text = await res.text();
    const events = text.split('\n')
      .filter(l => l.startsWith('event: '))
      .map(l => l.slice(7));

    expect(events[0]).toBe('message_start');
    expect(events[1]).toBe('ping');
    expect(events[2]).toBe('content_block_start');
    expect(events.at(-3)).toBe('content_block_stop');
    expect(events.at(-2)).toBe('message_delta');
    expect(events.at(-1)).toBe('message_stop');
  });
});

describe('POST /v1/messages streaming robustness (Anthropic)', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  function messagesRequest(body: Record<string, unknown>) {
    return ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns a JSON error (not corrupted SSE) when the provider fails before any output', async () => {
    const failing = new ScriptedMockProvider('a-fail-first', [
      () => [{ type: 'error', message: 'upstream exploded', code: 'upstream_blocked' }],
    ]);
    ctx = createTestContext({
      providers: [failing],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await messagesRequest({
      model: 'a-fail-first/test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('server_error');
  });

  it('surfaces a mid-stream error as an Anthropic error event, never as content text', async () => {
    const midStream = new ScriptedMockProvider('a-midstream', [
      () => [
        { type: 'text_delta', delta: 'Hello' },
        { type: 'error', message: 'boom', code: 'upstream_blocked' },
      ],
    ]);
    ctx = createTestContext({
      providers: [midStream],
      router: (registry) => new Router(registry, { maxRetries: 2 }),
    });

    const res = await messagesRequest({
      model: 'a-midstream/test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const text = await res.text();

    // Real content is delivered once
    expect(text).toContain('"text":"Hello"');

    // Error surfaces as an event, not injected into the content stream
    expect(text).toContain('event: error');
    expect(text).toContain('"message":"boom"');

    // The error text must NOT appear as a content delta
    const contentBlocks = text.split('\n')
      .filter(l => l.startsWith('data: '))
      .map(l => JSON.parse(l.slice(6)))
      .filter(p => p.type === 'content_block_delta');
    for (const block of contentBlocks) {
      expect(JSON.stringify(block)).not.toContain('boom');
    }
  });

  it('responds to an empty stream with the message envelope only', async () => {
    const empty = new ScriptedMockProvider('a-empty', [() => []]);
    ctx = createTestContext({
      providers: [empty],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await messagesRequest({
      model: 'a-empty/test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: message_stop');
  });

  it('non-streaming: returns error JSON when provider fails before any content', async () => {
    const failing = new ScriptedMockProvider('a-ns-fail', [
      () => [{ type: 'error', message: 'nope', code: 'auth_required' }],
    ]);
    ctx = createTestContext({
      providers: [failing],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await messagesRequest({
      model: 'a-ns-fail/test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('authentication_error');
  });
});

describe('POST /v1/messages context fidelity (Anthropic)', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  function messagesRequest(body: Record<string, unknown>) {
    return ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('delivers system, tool_use/tool_result and image blocks to the provider without loss', async () => {
    const capture = new CapturingProvider('a-capture');
    ctx = createTestContext({
      providers: [capture],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await messagesRequest({
      model: 'a-capture/test-model',
      max_tokens: 1024,
      system: 'You are helpful.',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Check the weather' }],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Beijing' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '22C' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);

    expect(capture.lastRequest).not.toBeNull();
    const req = capture.lastRequest!;
    expect(req.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Check the weather' },
      {
        role: 'assistant',
        content: 'Let me check',
        tool_calls: [{
          id: 'toolu_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
        }],
      },
      { role: 'tool', content: '22C', tool_call_id: 'toolu_1' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ]);
  });

  it('passes conversation_id through to the provider request', async () => {
    const capture = new CapturingProvider('a-capture-conv');
    ctx = createTestContext({
      providers: [capture],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await messagesRequest({
      model: 'a-capture-conv/test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      conversation_id: 'conv-456',
    });
    expect(res.status).toBe(200);
    expect(capture.lastRequest!.conversationId).toBe('conv-456');
  });

  it('non-streaming: echoes provider conversation id in x-wmb-conversation-id header', async () => {
    const withConv = new ScriptedMockProvider('a-ns-conv-id', [
      () => [
        { type: 'text_delta', delta: 'ok' },
        { type: 'done', reason: 'stop', conversationId: 'server-conv-9' },
      ],
    ]);
    ctx = createTestContext({
      providers: [withConv],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await messagesRequest({
      model: 'a-ns-conv-id/test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-wmb-conversation-id')).toBe('server-conv-9');
  });

  it('streaming: emits the conversation id as an SSE comment before message_stop', async () => {
    const withConv = new ScriptedMockProvider('a-stream-conv-id', [
      () => [
        { type: 'text_delta', delta: 'ok' },
        { type: 'done', reason: 'stop', conversationId: 'server-conv-9' },
      ],
    ]);
    ctx = createTestContext({
      providers: [withConv],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await messagesRequest({
      model: 'a-stream-conv-id/test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(': wmb-conversation-id server-conv-9');
    const commentIndex = text.indexOf(': wmb-conversation-id');
    const stopIndex = text.indexOf('event: message_stop');
    expect(commentIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeGreaterThan(commentIndex);
  });
});
