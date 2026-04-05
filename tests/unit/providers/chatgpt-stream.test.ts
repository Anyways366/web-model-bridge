import { describe, it, expect } from 'vitest';
import { normalizeChatGPTSSE } from '../../../src/providers/chatgpt/stream.js';

describe('ChatGPT stream normalizer', () => {
  it('parses text delta', () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hello"}}]}';
    expect(normalizeChatGPTSSE(line)).toEqual([{ type: 'text_delta', delta: 'Hello' }]);
  });

  it('parses done with finish_reason stop', () => {
    const line = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}';
    expect(normalizeChatGPTSSE(line)).toEqual([{ type: 'done', reason: 'stop' }]);
  });

  it('parses done with finish_reason length', () => {
    const line = 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}';
    expect(normalizeChatGPTSSE(line)).toEqual([{ type: 'done', reason: 'length' }]);
  });

  it('ignores [DONE]', () => {
    expect(normalizeChatGPTSSE('data: [DONE]')).toEqual([]);
  });

  it('ignores empty lines', () => {
    expect(normalizeChatGPTSSE('')).toEqual([]);
  });

  it('handles malformed JSON', () => {
    expect(normalizeChatGPTSSE('data: {bad}')).toEqual([]);
  });

  it('skips empty content', () => {
    const line = 'data: {"choices":[{"delta":{"content":""}}]}';
    expect(normalizeChatGPTSSE(line)).toEqual([]);
  });

  it('parses role-only delta (first chunk)', () => {
    const line = 'data: {"choices":[{"delta":{"role":"assistant"}}]}';
    expect(normalizeChatGPTSSE(line)).toEqual([]);
  });
});
