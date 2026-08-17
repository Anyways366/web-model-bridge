import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/test-server.js';
import { ScriptedMockProvider } from '../../helpers/mock-sse.js';
import { Router } from '../../../src/core/router.js';

function parseEvents(text: string) {
  const events: Array<{ event: string; data: any }> = [];
  let current: { event: string; data: any } | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) {
      current = { event: line.slice(7), data: null };
    } else if (line.startsWith('data: ') && current) {
      try {
        current.data = JSON.parse(line.slice(6));
      } catch {
        current.data = line.slice(6);
      }
      events.push(current);
      current = null;
    }
  }
  return events;
}

describe('POST /v1/messages tool calls (Anthropic)', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  function request(body: Record<string, unknown>) {
    return ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('streams tool_use: block start with id/name, input_json_delta, block stop, stop_reason tool_use', async () => {
    const provider = new ScriptedMockProvider('at-one', [
      () => [
        { type: 'tool_call', index: 0, id: 'toolu_1', name: 'get_weather', args: '{"city":' },
        { type: 'tool_call', index: 0, id: 'toolu_1', name: 'get_weather', args: '{"city":"Beijing"}' },
        { type: 'done', reason: 'tool_use' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'at-one/test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Weather?' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    const starts = events.filter(e => e.event === 'content_block_start');
    expect(starts).toHaveLength(2); // text block 0 + tool_use block 1
    expect(starts[1].data).toEqual({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
    });

    const deltas = events.filter(e => e.event === 'content_block_delta');
    expect(deltas).toHaveLength(2);
    expect(deltas.map(d => d.data.delta)).toEqual([
      { type: 'input_json_delta', partial_json: '{"city":' },
      { type: 'input_json_delta', partial_json: '"Beijing"}' },
    ]);

    const stops = events.filter(e => e.event === 'content_block_stop');
    expect(stops.map(s => s.data.index)).toEqual([1, 0]);

    const msgDelta = events.find(e => e.event === 'message_delta');
    expect(msgDelta.data.delta.stop_reason).toBe('tool_use');
    expect(events.at(-1)?.event).toBe('message_stop');
  });

  it('streams multiple tool calls on separate content block indexes', async () => {
    const provider = new ScriptedMockProvider('at-multi', [
      () => [
        { type: 'tool_call', index: 0, id: 'toolu_a', name: 'fn_a', args: '{"a":1}' },
        { type: 'tool_call', index: 1, id: 'toolu_b', name: 'fn_b', args: '{"b":2}' },
        { type: 'done', reason: 'tool_use' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'at-multi/test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Go' }],
      stream: true,
    });
    const events = parseEvents(await res.text());
    const starts = events.filter(e => e.event === 'content_block_start');
    expect(starts.map(s => s.data.content_block.type)).toEqual(['text', 'tool_use', 'tool_use']);
    expect(starts[1].data.content_block).toMatchObject({ id: 'toolu_a', name: 'fn_a' });
    expect(starts[2].data.content_block).toMatchObject({ id: 'toolu_b', name: 'fn_b' });

    // each tool_use id/name appears exactly once
    expect(starts.map(s => s.data.content_block.id).filter(Boolean)).toEqual(['toolu_a', 'toolu_b']);

    const stops = events.filter(e => e.event === 'content_block_stop');
    expect(stops.map(s => s.data.index)).toEqual([1, 2, 0]);

    const msgDelta = events.find(e => e.event === 'message_delta');
    expect(msgDelta.data.delta.stop_reason).toBe('tool_use');
  });

  it('handles a mixed stream: text then tool call', async () => {
    const provider = new ScriptedMockProvider('at-mixed', [
      () => [
        { type: 'text_delta', delta: 'Checking the weather now.' },
        { type: 'tool_call', index: 0, id: 'toolu_1', name: 'get_weather', args: '{"city":"Shanghai"}' },
        { type: 'done', reason: 'tool_use' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'at-mixed/test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Weather?' }],
      stream: true,
    });
    const events = parseEvents(await res.text());
    const textDeltas = events.filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta');
    expect(textDeltas.map(d => d.data.delta.text).join('')).toBe('Checking the weather now.');
    expect(events.some(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')).toBe(true);
    const msgDelta = events.find(e => e.event === 'message_delta');
    expect(msgDelta.data.delta.stop_reason).toBe('tool_use');
  });

  it('normal text responses keep the existing event sequence', async () => {
    const provider = new ScriptedMockProvider('at-text', [
      () => [
        { type: 'text_delta', delta: 'Hi there' },
        { type: 'done', reason: 'stop' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'at-text/test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    const events = parseEvents(await res.text());
    const types = events.map(e => e.event);
    expect(types).toEqual([
      'message_start', 'ping', 'content_block_start', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ]);
    expect(events.find(e => e.event === 'message_delta').data.delta.stop_reason).toBe('end_turn');
  });

  it('non-streaming: returns tool_use content blocks and stop_reason tool_use', async () => {
    const provider = new ScriptedMockProvider('at-ns', [
      () => [
        { type: 'text_delta', delta: 'Calling...' },
        { type: 'tool_call', index: 0, id: 'toolu_1', name: 'get_weather', args: '{"city":"Beijing"}' },
        { type: 'tool_call', index: 1, id: 'toolu_2', name: 'fn_b', args: '{"b":2}' },
        { type: 'done', reason: 'tool_use' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'at-ns/test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Go' }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toEqual([
      { type: 'text', text: 'Calling...' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Beijing' } },
      { type: 'tool_use', id: 'toolu_2', name: 'fn_b', input: { b: 2 } },
    ]);
    expect(body.stop_reason).toBe('tool_use');
  });

  it('non-streaming: returns an error instead of truncated tool_use blocks when the provider fails mid-call', async () => {
    const provider = new ScriptedMockProvider('at-ns-err', [
      () => [
        { type: 'tool_call', index: 0, id: 'toolu_1', name: 'fn', args: '{"x":' },
        { type: 'error', message: 'failed mid-call', code: 'upstream_blocked' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'at-ns-err/test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Go' }],
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.type).toBe('error');
    expect(body.error.message).toBe('failed mid-call');
  });

  it('surfaces a mid-stream error after a tool-call block started, without retrying', async () => {
    const provider = new ScriptedMockProvider('at-err', [
      () => [
        { type: 'tool_call', index: 0, id: 'toolu_1', name: 'fn', args: '{"x":' },
        { type: 'error', message: 'boom', code: 'upstream_blocked' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 2 }),
    });

    const res = await request({
      model: 'at-err/test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Go' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());
    expect(provider.callCount).toBe(1); // no retry after output
    const err = events.find(e => e.event === 'error');
    expect(err.data.error.message).toBe('boom');
    // the tool_use block start appears exactly once — no duplicate fragments
    const toolStarts = events.filter(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use');
    expect(toolStarts).toHaveLength(1);
  });

  it('perserves stop_reason tool_use from a done event without tool_call fragments (malformed stream)', async () => {
    const provider = new ScriptedMockProvider('at-malformed', [
      () => [{ type: 'done', reason: 'tool_use' }],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'at-malformed/test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Go' }],
      stream: true,
    });
    const events = parseEvents(await res.text());
    const msgDelta = events.find(e => e.event === 'message_delta');
    expect(msgDelta.data.delta.stop_reason).toBe('tool_use');
  });
});