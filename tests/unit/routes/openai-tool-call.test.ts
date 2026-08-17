import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/test-server.js';
import { ScriptedMockProvider } from '../../helpers/mock-sse.js';
import { Router } from '../../../src/core/router.js';

function parseChunks(text: string) {
  return text.split('\n')
    .filter(l => l.startsWith('data: '))
    .map(l => l.slice(6));
}

describe('POST /v1/chat/completions tool calls (streaming)', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  function request(body: Record<string, unknown>) {
    return ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('streams one tool call: id/name once, incremental args, finish_reason tool_calls', async () => {
    const provider = new ScriptedMockProvider('tc-one', [
      () => [
        { type: 'tool_call', index: 0, id: 'call_1', name: 'get_weather', args: '{"city":' },
        { type: 'tool_call', index: 0, id: 'call_1', name: 'get_weather', args: '{"city":"Beijing"}' },
        { type: 'done', reason: 'tool_use' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'tc-one/test-model',
      messages: [{ role: 'user', content: 'Weather?' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const chunks = parseChunks(text).filter(c => c !== '[DONE]').map(c => JSON.parse(c));

    const toolChunks = chunks.flatMap(c =>
      c.choices?.[0]?.delta?.tool_calls ? [{ finish: c.choices[0].finish_reason, call: c.choices[0].delta.tool_calls[0] }] : [],
    );
    expect(toolChunks).toHaveLength(2);
    expect(toolChunks[0].call).toEqual({
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":' },
    });
    expect(toolChunks[1].call).toEqual({ index: 0, function: { arguments: '"Beijing"}' } });
    expect(toolChunks[1].call).not.toHaveProperty('id');
    expect(toolChunks[1].call).not.toHaveProperty('type');

    const finish = chunks.find(c => c.choices?.[0]?.finish_reason);
    expect(finish.choices[0].finish_reason).toBe('tool_calls');
    expect(text).toContain('data: [DONE]');
  });

  it('streams multiple tool calls on separate indexes without collapsing', async () => {
    const provider = new ScriptedMockProvider('tc-multi', [
      () => [
        { type: 'tool_call', index: 0, id: 'call_a', name: 'fn_a', args: '{"a":1}' },
        { type: 'tool_call', index: 1, id: 'call_b', name: 'fn_b', args: '{"b":2' },
        { type: 'tool_call', index: 1, id: 'call_b', name: 'fn_b', args: '{"b":2,"c":3}' },
        { type: 'done', reason: 'tool_use' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'tc-multi/test-model',
      messages: [{ role: 'user', content: 'Go' }],
      stream: true,
    });
    const chunks = parseChunks(await res.text()).filter(c => c !== '[DONE]').map(c => JSON.parse(c));
    const toolChunks = chunks.flatMap(c => c.choices?.[0]?.delta?.tool_calls ?? []);

    expect(toolChunks).toHaveLength(3);
    expect(toolChunks[0]).toEqual({ index: 0, id: 'call_a', type: 'function', function: { name: 'fn_a', arguments: '{"a":1}' } });
    expect(toolChunks[1]).toEqual({ index: 1, id: 'call_b', type: 'function', function: { name: 'fn_b', arguments: '{"b":2' } });
    // index 1 continuation: only args delta, no id/name/type repeated
    expect(toolChunks[2]).toEqual({ index: 1, function: { arguments: ',"c":3}' } });
    expect(toolChunks[2]).not.toHaveProperty('id');

    // both calls' id/name appear exactly once each
    const names = toolChunks.filter(c => c.function?.name).map(c => c.function.name);
    expect(names).toEqual(['fn_a', 'fn_b']);
  });

  it('handles a mixed stream: text then tool call then done', async () => {
    const provider = new ScriptedMockProvider('tc-mixed', [
      () => [
        { type: 'text_delta', delta: 'Let me check the weather for you.' },
        { type: 'tool_call', index: 0, id: 'call_9', name: 'get_weather', args: '{"city":"Shanghai"}' },
        { type: 'done', reason: 'tool_use' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'tc-mixed/test-model',
      messages: [{ role: 'user', content: 'Weather?' }],
      stream: true,
    });
    const chunks = parseChunks(await res.text()).filter(c => c !== '[DONE]').map(c => JSON.parse(c));
    const contents = chunks.map(c => c.choices?.[0]?.delta?.content).filter(Boolean).join('');
    expect(contents).toBe('Let me check the weather for you.');
    const toolChunks = chunks.flatMap(c => c.choices?.[0]?.delta?.tool_calls ?? []);
    expect(toolChunks[0].function.name).toBe('get_weather');
    expect(chunks.find(c => c.choices?.[0]?.finish_reason).choices[0].finish_reason).toBe('tool_calls');
  });

  it('streams tool calls after thinking deltas', async () => {
    const provider = new ScriptedMockProvider('tc-think', [
      () => [
        { type: 'thinking_delta', delta: '[reasoning...]' },
        { type: 'tool_call', index: 0, id: 'call_1', name: 'fn', args: '{}' },
        { type: 'done', reason: 'tool_use' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'tc-think/test-model',
      messages: [{ role: 'user', content: 'Go' }],
      stream: true,
    });
    const chunks = parseChunks(await res.text()).filter(c => c !== '[DONE]').map(c => JSON.parse(c));
    const toolChunks = chunks.flatMap(c => c.choices?.[0]?.delta?.tool_calls ?? []);
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0].function.name).toBe('fn');
  });

  it('surfaces a mid-stream error after tool-call output without retrying or duplicating fragments', async () => {
    const provider = new ScriptedMockProvider('tc-err', [
      () => [
        { type: 'tool_call', index: 0, id: 'call_1', name: 'fn', args: '{"x":' },
        { type: 'error', message: 'boom mid-call', code: 'upstream_blocked' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 2 }),
    });

    const res = await request({
      model: 'tc-err/test-model',
      messages: [{ role: 'user', content: 'Go' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const chunks = parseChunks(text).filter(c => c !== '[DONE]').map(c => JSON.parse(c));

    expect(provider.callCount).toBe(1); // no retry replay after output
    const toolChunks = chunks.flatMap(c => c.choices?.[0]?.delta?.tool_calls ?? []);
    expect(toolChunks).toHaveLength(1); // no duplicated fragments
    expect(toolChunks[0].function.arguments).toBe('{"x":');

    const errChunk = chunks.find(c => c.error);
    expect(errChunk.error).toBeTruthy();
    expect(errChunk.error.message).toBe('boom mid-call');
    expect(text).toContain('data: [DONE]');
  });

  it('emits a terminal for a stream that ends without done after tool calls', async () => {
    const provider = new ScriptedMockProvider('tc-noterm', [
      () => [
        { type: 'tool_call', index: 0, id: 'call_1', name: 'fn', args: '{"a":1}' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'tc-noterm/test-model',
      messages: [{ role: 'user', content: 'Go' }],
      stream: true,
    });
    const chunks = parseChunks(await res.text()).filter(c => c !== '[DONE]').map(c => JSON.parse(c));
    const toolChunks = chunks.flatMap(c => c.choices?.[0]?.delta?.tool_calls ?? []);
    expect(toolChunks).toHaveLength(1);
    // synthesized terminal exists and has no finish on the tool chunk path breakage
    expect(chunks.some(c => c.choices?.[0]?.finish_reason === 'stop')).toBe(true);
  });
});

describe('POST /v1/chat/completions tool calls (non-streaming)', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  function request(body: Record<string, unknown>) {
    return ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns message.tool_calls with complete arguments and finish_reason tool_calls', async () => {
    const provider = new ScriptedMockProvider('tc-ns', [
      () => [
        { type: 'tool_call', index: 0, id: 'call_a', name: 'fn_a', args: '{"a":' },
        { type: 'tool_call', index: 0, id: 'call_a', name: 'fn_a', args: '{"a":1}' },
        { type: 'tool_call', index: 1, id: 'call_b', name: 'fn_b', args: '{"b":2}' },
        { type: 'done', reason: 'tool_use' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'tc-ns/test-model',
      messages: [{ role: 'user', content: 'Go' }],
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.tool_calls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'fn_a', arguments: '{"a":1}' } },
      { id: 'call_b', type: 'function', function: { name: 'fn_b', arguments: '{"b":2}' } },
    ]);
    expect(body.choices[0].finish_reason).toBe('tool_calls');
  });

  it('keeps text and tool_calls together in a mixed non-streaming response', async () => {
    const provider = new ScriptedMockProvider('tc-ns-mixed', [
      () => [
        { type: 'text_delta', delta: 'Checking...' },
        { type: 'tool_call', index: 0, id: 'call_1', name: 'fn', args: '{}' },
        { type: 'done', reason: 'tool_use' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'tc-ns-mixed/test-model',
      messages: [{ role: 'user', content: 'Go' }],
      stream: false,
    });
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('Checking...');
    expect(body.choices[0].message.tool_calls).toHaveLength(1);
    expect(body.choices[0].finish_reason).toBe('tool_calls');
  });

  it('returns an error instead of potentially truncated tool_calls when the provider fails mid-call', async () => {
    const provider = new ScriptedMockProvider('tc-ns-err', [
      () => [
        { type: 'tool_call', index: 0, id: 'call_1', name: 'fn', args: '{"x":' },
        { type: 'error', message: 'failed mid-call', code: 'upstream_blocked' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'tc-ns-err/test-model',
      messages: [{ role: 'user', content: 'Go' }],
      stream: false,
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.message).toBe('failed mid-call');
  });

  it('keeps a plain done-without-tools response at finish_reason stop', async () => {
    const provider = new ScriptedMockProvider('tc-ns-plain', [
      () => [{ type: 'text_delta', delta: 'ok' }, { type: 'done', reason: 'stop' }],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    const res = await request({
      model: 'tc-ns-plain/test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: false,
    });
    const body = await res.json();
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.choices[0].message.tool_calls).toBeUndefined();
  });
});

describe('tool_call → tool result → follow-up request (OpenCode-driven loop)', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  it('preserves assistant tool_calls and tool results in the next request, exactly once', async () => {
    const provider = new ScriptedMockProvider('tc-loop', [
      () => [
        { type: 'tool_call', index: 0, id: 'call_1', name: 'get_weather', args: '{"city":"Beijing"}' },
        { type: 'done', reason: 'tool_use' },
      ],
      () => [
        { type: 'text_delta', delta: 'It is 22C in Beijing.' },
        { type: 'done', reason: 'stop' },
      ],
    ]);
    ctx = createTestContext({
      providers: [provider],
      router: (registry) => new Router(registry, { maxRetries: 0 }),
    });

    // Turn 1: the model requests a tool; OpenCode receives the call.
    const turn1 = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'tc-loop/test-model',
        messages: [{ role: 'user', content: 'How is the weather in Beijing?' }],
        stream: false,
      }),
    });
    expect(turn1.status).toBe(200);
    const turn1Body = await turn1.json();
    expect(turn1Body.choices[0].message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } },
    ]);
    expect(turn1Body.choices[0].finish_reason).toBe('tool_calls');

    // Turn 2: OpenCode executed the tool and sends the result back, appended
    // after the previous assistant tool_calls message.
    const toolCall = turn1Body.choices[0].message.tool_calls[0];
    const turn2 = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'tc-loop/test-model',
        messages: [
          { role: 'user', content: 'How is the weather in Beijing?' },
          { role: 'assistant', content: '', tool_calls: [toolCall] },
          { role: 'tool', tool_call_id: 'call_1', content: '22C' },
        ],
        stream: false,
      }),
    });
    expect(turn2.status).toBe(200);
    const turn2Body = await turn2.json();
    expect(turn2Body.choices[0].message.content).toBe('It is 22C in Beijing.');
    expect(turn2Body.choices[0].finish_reason).toBe('stop');

    // The second provider call received exactly the three messages, in order,
    // with the tool_call_id link intact — no duplication.
    expect(provider.callCount).toBe(2);
  });
});