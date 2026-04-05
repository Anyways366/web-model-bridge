import type { StreamEvent } from '../../core/stream.js';

export function normalizeDeepSeekSSE(line: string): StreamEvent[] {
  if (!line.startsWith('data: ')) return [];
  const data = line.slice(6);
  if (data === '[DONE]') return [];

  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }

  const events: StreamEvent[] = [];
  const choice = parsed.choices?.[0];
  if (!choice) return [];

  if (choice.finish_reason) {
    const reason = choice.finish_reason === 'length' ? 'length' : 'stop';
    events.push({ type: 'done', reason });
    return events;
  }

  const delta = choice.delta;
  if (!delta) return [];

  if (delta.reasoning_content) {
    events.push({ type: 'thinking_delta', delta: delta.reasoning_content });
  }

  if (delta.content && delta.content.length > 0) {
    events.push({ type: 'text_delta', delta: delta.content });
  }

  return events;
}
