import type { StreamEvent } from '../../core/stream.js';

/**
 * Per-call accumulation state. The upstream emits tool-call argument
 * fragments (OpenAI delta style); the bridge contract requires the absolute
 * accumulated string, so each chunk appends to the previous fragment and
 * emits the full accumulated arguments. Each call index keeps independent
 * state so parallel tool calls never bleed into each other.
 */
interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

function parseChunk(line: string): any | null {
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6);
  if (data === '[DONE]') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function mapFinishReason(reason: string): 'stop' | 'length' | 'tool_use' {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls') return 'tool_use';
  return 'stop';
}

function normalizeChatGPTLine(
  line: string,
  perIndex?: Map<number, ToolCallAccumulator>,
): StreamEvent[] {
  const parsed = parseChunk(line);
  if (!parsed) return [];

  const choice = parsed.choices?.[0];
  if (!choice) return [];

  const delta = choice.delta;
  if (!delta) return [];

  const events: StreamEvent[] = [];

  if (delta.content && delta.content.length > 0) {
    events.push({ type: 'text_delta', delta: delta.content });
  }

  if (Array.isArray(delta.tool_calls) && perIndex) {
    for (const tc of delta.tool_calls) {
      if (!tc || typeof tc !== 'object') continue;
      const index = typeof tc.index === 'number' ? tc.index : -1;
      if (index < 0) continue;

      let acc = perIndex.get(index);
      if (!acc) {
        acc = { id: '', name: '', args: '' };
        perIndex.set(index, acc);
      }

      // id/name usually arrive on the first chunk for an index; carry them
      // forward for later chunks that omit them.
      if (typeof tc.id === 'string' && tc.id) acc.id = tc.id;
      const fn = tc.function;
      if (fn && typeof fn === 'object') {
        if (typeof fn.name === 'string' && fn.name) acc.name = fn.name;
        // Arguments arrive as fragments — accumulate to the absolute string.
        // Non-string arguments (malformed) are ignored defensively.
        if (typeof fn.arguments === 'string') {
          acc.args += fn.arguments;
        }
      }

      events.push({ type: 'tool_call', index, id: acc.id, name: acc.name, args: acc.args });
    }
  }

  if (choice.finish_reason) {
    events.push({ type: 'done', reason: mapFinishReason(choice.finish_reason) });
  }

  return events;
}

/**
 * Stateful per-stream normalizer for live provider usage: tracks tool-call
 * argument accumulation across chunks. Use one instance per request.
 */
export function createChatGPTSSENormalizer(): (line: string) => StreamEvent[] {
  const perIndex = new Map<number, ToolCallAccumulator>();
  return (line: string) => normalizeChatGPTLine(line, perIndex);
}

/**
 * Stateless normalizer (text/done only) — preserved for compatibility and
 * simple one-off parsing. Tool-call chunks are ignored without state.
 */
export function normalizeChatGPTSSE(line: string): StreamEvent[] {
  return normalizeChatGPTLine(line);
}
