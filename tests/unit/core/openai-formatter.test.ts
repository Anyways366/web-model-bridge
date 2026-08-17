import { describe, it, expect } from 'vitest';
import {
  formatStreamChunk,
  formatUsageChunk,
  formatDoneChunk,
  formatNonStreamResponse,
  formatModelsResponse,
  createToolCallStreamState,
} from '../../../src/core/openai-formatter.js';
import type { StreamEvent } from '../../../src/core/stream.js';
import type { ModelInfo } from '../../../src/core/provider.js';

describe('OpenAI Formatter', () => {
  const modelId = 'claude-web/claude-sonnet-4-6';

  describe('formatStreamChunk', () => {
    it('formats text_delta as chat.completion.chunk', () => {
      const event: StreamEvent = { type: 'text_delta', delta: 'Hello' };
      const chunk = formatStreamChunk('run-1', modelId, event, false);
      expect(chunk.id).toBe('run-1');
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.model).toBe(modelId);
      expect(chunk.choices[0].index).toBe(0);
      expect(chunk.choices[0].delta.content).toBe('Hello');
      expect(chunk.choices[0].finish_reason).toBeNull();
    });

    it('first chunk includes role', () => {
      const event: StreamEvent = { type: 'text_delta', delta: 'Hi' };
      const chunk = formatStreamChunk('run-1', modelId, event, true);
      expect(chunk.choices[0].delta.role).toBe('assistant');
      expect(chunk.choices[0].delta.content).toBe('Hi');
    });

    it('non-first chunk omits role', () => {
      const event: StreamEvent = { type: 'text_delta', delta: 'Hi' };
      const chunk = formatStreamChunk('run-1', modelId, event, false);
      expect(chunk.choices[0].delta).not.toHaveProperty('role');
    });

    it('formats done with finish_reason stop', () => {
      const event: StreamEvent = { type: 'done', reason: 'stop' };
      const chunk = formatStreamChunk('run-1', modelId, event, false);
      expect(chunk.choices[0].finish_reason).toBe('stop');
      expect(chunk.choices[0].delta).toEqual({});
    });

    it('formats done with finish_reason length', () => {
      const event: StreamEvent = { type: 'done', reason: 'length' };
      const chunk = formatStreamChunk('run-1', modelId, event, false);
      expect(chunk.choices[0].finish_reason).toBe('length');
    });

    it('formats done with tool_use as tool_calls', () => {
      const event: StreamEvent = { type: 'done', reason: 'tool_use' };
      const chunk = formatStreamChunk('run-1', modelId, event, false);
      expect(chunk.choices[0].finish_reason).toBe('tool_calls');
    });

    describe('tool_call streaming', () => {
      it('first event for a call carries id, name, type and arguments, plus role on the first chunk', () => {
        const state = createToolCallStreamState();
        const event: StreamEvent = {
          type: 'tool_call', index: 0, id: 'call_1', name: 'get_weather', args: '{"city":',
        };
        const chunk = formatStreamChunk('run-1', modelId, event, true, state);
        expect(chunk.choices[0].delta.role).toBe('assistant');
        expect(chunk.choices[0].delta.tool_calls).toEqual([{
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":' },
        }]);
      });

      it('subsequent events emit only the argument delta and never repeat id/name/type', () => {
        const state = createToolCallStreamState();
        const first: StreamEvent = {
          type: 'tool_call', index: 0, id: 'call_1', name: 'get_weather', args: '{"city":',
        };
        const second: StreamEvent = {
          type: 'tool_call', index: 0, id: 'call_1', name: 'get_weather', args: '{"city":"Beijing"}',
        };
        formatStreamChunk('run-1', modelId, first, true, state);
        const chunk = formatStreamChunk('run-1', modelId, second, false, state);
        expect(chunk.choices[0].delta.tool_calls).toEqual([{
          index: 0,
          function: { arguments: '"Beijing"}' },
        }]);
        expect(chunk.choices[0].delta.tool_calls[0]).not.toHaveProperty('id');
        expect(chunk.choices[0].delta.tool_calls[0]).not.toHaveProperty('name');
        expect(chunk.choices[0].delta.tool_calls[0]).not.toHaveProperty('type');
      });

      it('keeps concurrent tool calls on separate indexes', () => {
        const state = createToolCallStreamState();
        const callAFrag1: StreamEvent = {
          type: 'tool_call', index: 0, id: 'call_a', name: 'fn_a', args: '{"a":1',
        };
        const callB: StreamEvent = {
          type: 'tool_call', index: 1, id: 'call_b', name: 'fn_b', args: '{"b":2',
        };
        const callAFrag2: StreamEvent = {
          type: 'tool_call', index: 0, id: 'call_a', name: 'fn_a', args: '{"a":1}',
        };

        formatStreamChunk('run-1', modelId, callAFrag1, true, state);
        const chunkB = formatStreamChunk('run-1', modelId, callB, false, state);
        expect(chunkB.choices[0].delta.tool_calls).toEqual([{
          index: 1,
          id: 'call_b',
          type: 'function',
          function: { name: 'fn_b', arguments: '{"b":2' },
        }]);

        const chunkA2 = formatStreamChunk('run-1', modelId, callAFrag2, false, state);
        expect(chunkA2.choices[0].delta.tool_calls).toEqual([{
          index: 0,
          function: { arguments: '}' },
        }]);
      });

      it('a single full-arguments event streams as one chunk with complete arguments', () => {
        const state = createToolCallStreamState();
        const event: StreamEvent = {
          type: 'tool_call', index: 0, id: 'call_1', name: 'fn', args: '{"city":"Beijing"}',
        };
        const chunk = formatStreamChunk('run-1', modelId, event, false, state);
        expect(chunk.choices[0].delta.tool_calls).toEqual([{
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'fn', arguments: '{"city":"Beijing"}' },
        }]);
      });

      it('does not crash on a tool_call with non-string args (malformed provider)', () => {
        const state = createToolCallStreamState();
        const chunk = formatStreamChunk('run-1', modelId, {
          type: 'tool_call', index: 0, id: 'call_a', name: 'fn_a', args: undefined as unknown as string,
        }, false, state);
        expect(chunk.choices[0].delta.tool_calls).toEqual([{
          index: 0,
          id: 'call_a',
          type: 'function',
          function: { name: 'fn_a', arguments: '' },
        }]);
      });
    });
  });

  describe('formatDoneChunk', () => {
    it('returns [DONE] string', () => {
      expect(formatDoneChunk()).toBe('[DONE]');
    });
  });

  describe('formatUsageChunk', () => {
    it('formats a usage chunk with empty choices', () => {
      const chunk = formatUsageChunk('run-1', modelId, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
      expect(chunk.id).toBe('run-1');
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.model).toBe(modelId);
      expect(chunk.choices).toEqual([]);
      expect(chunk.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    });
  });

  describe('formatNonStreamResponse', () => {
    it('formats complete response', () => {
      const res = formatNonStreamResponse('run-1', modelId, 'Hello world');
      expect(res.id).toBe('run-1');
      expect(res.object).toBe('chat.completion');
      expect(res.model).toBe(modelId);
      expect(res.choices[0].message.role).toBe('assistant');
      expect(res.choices[0].message.content).toBe('Hello world');
      expect(res.choices[0].finish_reason).toBe('stop');
    });

    it('includes tool_calls and finish_reason tool_calls when tool calls are present', () => {
      const res = formatNonStreamResponse('run-1', modelId, '', undefined, [
        { id: 'call_1', type: 'function', function: { name: 'fn_a', arguments: '{"a":1}' } },
        { id: 'call_2', type: 'function', function: { name: 'fn_b', arguments: '{"b":2}' } },
      ]);
      expect(res.choices[0].message.tool_calls).toEqual([
        { id: 'call_1', type: 'function', function: { name: 'fn_a', arguments: '{"a":1}' } },
        { id: 'call_2', type: 'function', function: { name: 'fn_b', arguments: '{"b":2}' } },
      ]);
      expect(res.choices[0].finish_reason).toBe('tool_calls');
    });

    it('defaults usage to zeros when not provided', () => {
      const res = formatNonStreamResponse('run-1', modelId, 'Hello');
      expect(res.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    });

    it('preserves usage when provided', () => {
      const res = formatNonStreamResponse('run-1', modelId, 'Hello', {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
      });
      expect(res.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    });
  });

  describe('formatModelsResponse', () => {
    it('formats model list', () => {
      const models: (ModelInfo & { id: string })[] = [
        { id: 'claude-web/claude-sonnet-4-6', name: 'Claude Sonnet', contextWindow: 200000, maxOutput: 8192 },
        { id: 'deepseek-web/deepseek-v4', name: 'DeepSeek V4', contextWindow: 128000, maxOutput: 8192 },
      ];
      const res = formatModelsResponse(models);
      expect(res.object).toBe('list');
      expect(res.data).toHaveLength(2);
      expect(res.data[0].id).toBe('claude-web/claude-sonnet-4-6');
      expect(res.data[0].object).toBe('model');
      expect(res.data[0].owned_by).toBe('web-model-bridge');
    });
  });
});
