import { describe, it, expect } from 'vitest';
import { createChatGPTSSENormalizer, normalizeChatGPTSSE } from '../../../src/providers/chatgpt/stream.js';

function chunk(choices: unknown[]): string {
  return 'data: ' + JSON.stringify({ choices });
}

function toolDelta(index: number, partial: { id?: string; name?: string; arguments?: string }): string {
  const fn: Record<string, unknown> = {};
  if (partial.name !== undefined) fn.name = partial.name;
  if (partial.arguments !== undefined) fn.arguments = partial.arguments;
  const tc: Record<string, unknown> = { index, type: 'function', function: fn };
  if (partial.id !== undefined) tc.id = partial.id;
  return chunk([{ delta: { tool_calls: [tc] } }]);
}

describe('ChatGPT tool-call stream normalizer', () => {
  it('parses a single tool call with id, name, and arguments', () => {
    const n = createChatGPTSSENormalizer();
    const events = n(toolDelta(0, { id: 'call_1', name: 'get_time', arguments: '{"tz":"UTC"}' }));
    expect(events).toEqual([
      { type: 'tool_call', index: 0, id: 'call_1', name: 'get_time', args: '{"tz":"UTC"}' },
    ]);
  });

  it('accumulates arguments across multiple SSE chunks', () => {
    const n = createChatGPTSSENormalizer();
    n(toolDelta(0, { id: 'call_1', name: 'get_time', arguments: '{"tz":"UTC"' }));
    const events = n(toolDelta(0, { arguments: '}' }));
    expect(events).toEqual([
      { type: 'tool_call', index: 0, id: 'call_1', name: 'get_time', args: '{"tz":"UTC"}' },
    ]);
    // The accumulated event is the absolute string, not a delta.
    expect(events[0].type).toBe('tool_call');
    if (events[0].type === 'tool_call') expect(events[0].args).toBe('{"tz":"UTC"}');
  });

  it('carries id/name forward on continuation chunks that omit them', () => {
    const n = createChatGPTSSENormalizer();
    n(toolDelta(0, { id: 'call_1', name: 'get_time', arguments: '{"a":1' }));
    const events = n(toolDelta(0, { arguments: '}' }));
    expect(events).toEqual([
      { type: 'tool_call', index: 0, id: 'call_1', name: 'get_time', args: '{"a":1}' },
    ]);
  });

  it('fills in id/name when they arrive on a later chunk', () => {
    const n = createChatGPTSSENormalizer();
    const first = n(toolDelta(0, { arguments: '{"a"' }));
    expect(first).toEqual([
      { type: 'tool_call', index: 0, id: '', name: '', args: '{"a"' },
    ]);
    const second = n(toolDelta(0, { id: 'call_1', name: 'fn', arguments: ':1}' }));
    expect(second).toEqual([
      { type: 'tool_call', index: 0, id: 'call_1', name: 'fn', args: '{"a":1}' },
    ]);
  });

  it('keeps parallel tool calls on separate indexes with independent accumulation', () => {
    const n = createChatGPTSSENormalizer();
    n(toolDelta(0, { id: 'call_a', name: 'fn_a', arguments: '{"a":1' }));
    n(toolDelta(1, { id: 'call_b', name: 'fn_b', arguments: '{"b":2' }));
    const bDone = n(toolDelta(1, { arguments: '}' }));
    expect(bDone).toEqual([
      { type: 'tool_call', index: 1, id: 'call_b', name: 'fn_b', args: '{"b":2}' },
    ]);
    const aDone = n(toolDelta(0, { arguments: '}' }));
    expect(aDone).toEqual([
      { type: 'tool_call', index: 0, id: 'call_a', name: 'fn_a', args: '{"a":1}' },
    ]);
  });

  it('maps finish_reason tool_calls to done with reason tool_use', () => {
    const n = createChatGPTSSENormalizer();
    const events = n(chunk([{ delta: {}, finish_reason: 'tool_calls' }]));
    expect(events).toEqual([{ type: 'done', reason: 'tool_use' }]);
  });

  it('emits the final tool delta and done together on a closing chunk', () => {
    const n = createChatGPTSSENormalizer();
    n(toolDelta(0, { id: 'call_1', name: 'fn', arguments: '{"a":1' }));
    const events = n(chunk([
      { delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: 'tool_calls' },
    ]));
    expect(events).toEqual([
      { type: 'tool_call', index: 0, id: 'call_1', name: 'fn', args: '{"a":1}' },
      { type: 'done', reason: 'tool_use' },
    ]);
  });

  it('handles malformed or non-string arguments defensively', () => {
    const n = createChatGPTSSENormalizer();
    // null arguments → ignored, event still emitted with empty args
    const withNull = n(chunk([{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fn', arguments: null } }] } }]));
    expect(withNull).toEqual([
      { type: 'tool_call', index: 0, id: 'call_1', name: 'fn', args: '' },
    ]);
    // non-string arguments → ignored
    const withNumber = n(chunk([{ delta: { tool_calls: [{ index: 0, function: { arguments: 123 } }] } }]));
    expect(withNumber).toEqual([
      { type: 'tool_call', index: 0, id: 'call_1', name: 'fn', args: '' },
    ]);
    // malformed JSON line → no events, state untouched
    expect(n('data: {bad')).toEqual([]);
    // missing function object → event emitted with carried state
    const noFn = n(chunk([{ delta: { tool_calls: [{ index: 0, id: 'call_1' }] } }]));
    expect(noFn).toEqual([
      { type: 'tool_call', index: 0, id: 'call_1', name: 'fn', args: '' },
    ]);
    // missing index → skipped
    expect(n(chunk([{ delta: { tool_calls: [{ id: 'x', function: { name: 'f' } }] } }]))).toEqual([]);
  });

  it('keeps normal text streaming unchanged through the stateful normalizer', () => {
    const n = createChatGPTSSENormalizer();
    expect(n('data: {"choices":[{"delta":{"content":"Hello"}}]}')).toEqual([
      { type: 'text_delta', delta: 'Hello' },
    ]);
    expect(n('data: {"choices":[{"delta":{"role":"assistant"}}]}')).toEqual([]);
    expect(n('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}')).toEqual([
      { type: 'done', reason: 'stop' },
    ]);
    expect(n('data: {"choices":[{"delta":{},"finish_reason":"length"}]}')).toEqual([
      { type: 'done', reason: 'length' },
    ]);
    expect(n('data: [DONE]')).toEqual([]);
    expect(n('')).toEqual([]);
  });

  it('stateless normalizeChatGPTSSE ignores tool-call chunks (no state)', () => {
    expect(normalizeChatGPTSSE(toolDelta(0, { id: 'call_1', name: 'fn', arguments: '{}' }))).toEqual([]);
  });
});
