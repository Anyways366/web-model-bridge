import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/test-server.js';
import { MockProvider } from '../../helpers/mock-provider.js';
import { DelayedMockProvider } from '../../helpers/mock-sse.js';

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
