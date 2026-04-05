import type { StreamEvent } from '../../core/stream.js';

export function normalizeClaudeSSE(line: string): StreamEvent[] {
  if (!line.startsWith('data: ')) return [];
  const data = line.slice(6);
  if (data === '[DONE]') return [];

  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }

  const type = parsed.type;

  if (type === 'content_block_delta') {
    const delta = parsed.delta;
    if (delta?.type === 'text_delta' && delta.text) {
      return [{ type: 'text_delta', delta: delta.text }];
    }
    if (delta?.type === 'thinking_delta' && delta.thinking) {
      return [{ type: 'thinking_delta', delta: delta.thinking }];
    }
  }

  if (type === 'message_stop') {
    return [{ type: 'done', reason: 'stop' }];
  }

  if (type === 'message_delta') {
    const stopReason = parsed.delta?.stop_reason;
    if (stopReason === 'max_tokens') {
      return [{ type: 'done', reason: 'length' }];
    }
    if (stopReason) {
      return [{ type: 'done', reason: 'stop' }];
    }
  }

  return [];
}
