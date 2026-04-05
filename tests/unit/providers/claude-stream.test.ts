import { describe, it, expect } from 'vitest';
import { normalizeClaudeSSE } from '../../../src/providers/claude/stream.js';

describe('Claude stream normalizer', () => {
  it('parses content_block_delta text', () => {
    const line = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}';
    expect(normalizeClaudeSSE(line)).toEqual([{ type: 'text_delta', delta: 'Hello' }]);
  });

  it('parses message_stop', () => {
    const line = 'data: {"type":"message_stop"}';
    expect(normalizeClaudeSSE(line)).toEqual([{ type: 'done', reason: 'stop' }]);
  });

  it('parses message_delta with stop_reason end_turn', () => {
    const line = 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}';
    expect(normalizeClaudeSSE(line)).toEqual([{ type: 'done', reason: 'stop' }]);
  });

  it('parses message_delta with max_tokens', () => {
    const line = 'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}';
    expect(normalizeClaudeSSE(line)).toEqual([{ type: 'done', reason: 'length' }]);
  });

  it('ignores message_start', () => {
    const line = 'data: {"type":"message_start","message":{}}';
    expect(normalizeClaudeSSE(line)).toEqual([]);
  });

  it('ignores content_block_start', () => {
    const line = 'data: {"type":"content_block_start","content_block":{}}';
    expect(normalizeClaudeSSE(line)).toEqual([]);
  });

  it('handles thinking delta', () => {
    const line = 'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Let me..."}}';
    expect(normalizeClaudeSSE(line)).toEqual([{ type: 'thinking_delta', delta: 'Let me...' }]);
  });

  it('ignores [DONE]', () => {
    expect(normalizeClaudeSSE('data: [DONE]')).toEqual([]);
  });

  it('ignores empty lines', () => {
    expect(normalizeClaudeSSE('')).toEqual([]);
  });

  it('handles malformed JSON', () => {
    expect(normalizeClaudeSSE('data: broken{{')).toEqual([]);
  });
});
