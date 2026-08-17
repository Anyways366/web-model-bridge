import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/test-server.js';
import { MockProvider } from '../helpers/mock-provider.js';
import type { ChatRequest, ModelInfo, ToolDef } from '../../src/core/provider.js';
import type { StreamEvent } from '../../src/core/stream.js';

/**
 * Provider that records every ChatRequest it receives and replays a
 * per-call script: scripts[0] on the first call, scripts[1] on the second,
 * and so on (the last script repeats).
 */
class ToolLoopProvider extends MockProvider {
  requests: ChatRequest[] = [];

  constructor(private scripts: StreamEvent[][]) {
    super('tool-loop', {
      authenticated: true,
      models: [{ id: 'test-model', name: 'Test', contextWindow: 100000, maxOutput: 4096 }] as ModelInfo[],
    });
  }

  override async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    const idx = Math.min(this.requests.length - 1, this.scripts.length - 1);
    for (const event of this.scripts[idx]) {
      yield event;
    }
  }
}

const TOOLS: ToolDef[] = [{
  type: 'function',
  function: {
    name: 'get_time',
    description: 'Get the current time in a timezone',
    parameters: { type: 'object', properties: { tz: { type: 'string' } } },
  },
}];

describe('Tool-call round trip through the HTTP boundary', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  it('request 1: tool_calls returned; request 2: tool result preserved and final answer returned', async () => {
    const provider = new ToolLoopProvider([
      // First call: the model decides to call get_time.
      [
        { type: 'tool_call', index: 0, id: 'call_1', name: 'get_time', args: '{"tz":"UTC"}' },
        { type: 'done', reason: 'tool_use' },
      ],
      // Second call: the model answers after receiving the tool result.
      [
        { type: 'text_delta', delta: 'It is 14:30 UTC' },
        { type: 'done', reason: 'stop' },
      ],
    ]);
    ctx = createTestContext({ providers: [provider] });

    // ── Request 1: OpenCode asks with tool definitions ──
    const res1 = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'tool-loop/test-model',
        stream: false,
        tools: TOOLS,
        messages: [{ role: 'user', content: 'What time is it in UTC?' }],
      }),
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.choices[0].message.tool_calls).toEqual([{
      id: 'call_1',
      type: 'function',
      function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
    }]);
    expect(body1.choices[0].finish_reason).toBe('tool_calls');

    // The provider received the tool definitions and the user message.
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].tools).toEqual(TOOLS);
    expect(provider.requests[0].messages).toEqual([
      { role: 'user', content: 'What time is it in UTC?' },
    ]);

    // ── Request 2: OpenCode executes the tool and sends the result back ──
    const res2 = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'tool-loop/test-model',
        stream: false,
        messages: [
          { role: 'user', content: 'What time is it in UTC?' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
            }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '14:30 UTC' },
        ],
      }),
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.choices[0].message.content).toBe('It is 14:30 UTC');
    expect(body2.choices[0].finish_reason).toBe('stop');

    // The provider received the full history: order, assistant tool_calls,
    // tool role, tool_call_id and the tool result all intact.
    expect(provider.requests).toHaveLength(2);
    const second = provider.requests[1];
    expect(second.messages).toHaveLength(3);
    expect(second.messages[0]).toEqual({ role: 'user', content: 'What time is it in UTC?' });
    expect(second.messages[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
      }],
    });
    expect(second.messages[2]).toEqual({
      role: 'tool',
      content: '14:30 UTC',
      tool_call_id: 'call_1',
    });
  });
});
