import { describe, it, expect } from 'vitest';
import {
  buildDeepSeekPrompt,
  parseToolCalls,
  stripToolMarkers,
  parseDeepSeekSse,
  TOOL_CALL_START,
  TOOL_CALL_END,
  TOOL_OUTPUTS_BEGIN,
  TOOL_OUTPUT_BEGIN,
  TOOL_OUTPUT_END,
  TOOL_OUTPUTS_END,
  END_OF_SENTENCE,
} from '../../../src/providers/deepseek/tools.js';
import type { Message, ToolDef } from '../../../src/core/provider.js';

const USER = '<\uFF5CUser\uFF5C>';
const ASSISTANT = '<\uFF5CAssistant\uFF5C>';
const SYSTEM = '<\uFF5CSystem\uFF5C>';

function msg(role: Message['role'], content: string, extra?: Partial<Message>): Message {
  return { role, content, ...extra };
}

const weatherTool: ToolDef = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
};

describe('buildDeepSeekPrompt', () => {
  it('formats a plain user message with role tags and trailing EOS marker', () => {
    const prompt = buildDeepSeekPrompt([msg('user', 'hello')]);
    expect(prompt).toBe(`${END_OF_SENTENCE}${USER}hello${END_OF_SENTENCE}\n`);
  });

  it('drops system messages but injects a system block when tools are present', () => {
    const prompt = buildDeepSeekPrompt([msg('system', 'you are an agent'), msg('user', 'hi')], [weatherTool]);
    expect(prompt).toContain(`${SYSTEM}\n\n## 工具调用`);
    expect(prompt).toContain('### 工具定义');
    expect(prompt).toContain('### 格式规范');
    expect(prompt).toContain('get_weather');
    expect(prompt).toContain(`- **get_weather** (function):`);
    expect(prompt).not.toContain('you are an agent');
  });

it('appends an unclosed thinking reminder before generation, after history', () => {
    const prompt = buildDeepSeekPrompt([msg('user', 'hi')], [weatherTool]);
    const remIdx = prompt.indexOf(`${ASSISTANT}<thinking>\n`);
    expect(remIdx).toBeGreaterThan(prompt.indexOf(USER));
    expect(prompt.lastIndexOf('## 工具调用')).toBeGreaterThan(remIdx);
  });

  it('preserves multi-turn history in order', () => {
    const prompt = buildDeepSeekPrompt([
      msg('user', 'first'),
      msg('assistant', 'answer'),
      msg('user', 'second'),
    ]);
    expect(prompt.indexOf('first')).toBeLessThan(prompt.indexOf('answer'));
    expect(prompt.indexOf('answer')).toBeLessThan(prompt.indexOf('second'));
  });

  it('merges consecutive same-role user messages', () => {
    const prompt = buildDeepSeekPrompt([msg('user', 'a'), msg('user', 'b')]);
    expect(prompt).toContain(`${USER}a\nb`);
    expect(prompt.split(USER)).toHaveLength(2);
  });

  it('groups tool-role results into tool output tags', () => {
    const prompt = buildDeepSeekPrompt([
      msg('tool', '{"temp": 22}', { tool_call_id: 'call_1' }),
      msg('tool', '{"wind": 5}', { tool_call_id: 'call_2' }),
    ]);
    expect(prompt).toContain(
      `${TOOL_OUTPUTS_BEGIN}${TOOL_OUTPUT_BEGIN}{"temp": 22}${TOOL_OUTPUT_END}${TOOL_OUTPUT_BEGIN}{"wind": 5}${TOOL_OUTPUT_END}${TOOL_OUTPUTS_END}`,
    );
  });

  it('re-emits assistant tool_calls inside the marker tags', () => {
    const prompt = buildDeepSeekPrompt([
      msg('assistant', '', {
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } },
        ],
      }),
    ]);
    expect(prompt).toContain(`${TOOL_CALL_START}\n[{"name": "get_weather", "arguments": {"city":"Beijing"}}]\n${TOOL_CALL_END}`);
  });

  it('does not inject tool blocks when no tools are provided', () => {
    const prompt = buildDeepSeekPrompt([msg('user', 'hi')]);
    expect(prompt).not.toContain('工具');
    expect(prompt).not.toContain('## ');
  });
});

describe('parseToolCalls', () => {
  const wrap = (inner: string) => `${TOOL_CALL_START}${inner}${TOOL_CALL_END}`;

  it('parses a single valid tool call', () => {
    const result = parseToolCalls(wrap('[{"name": "get_weather", "arguments": {"city": "Beijing"}}]'));
    expect(result).not.toBeNull();
    expect(result!.calls).toHaveLength(1);
    expect(result!.calls[0].name).toBe('get_weather');
    expect(result!.calls[0].arguments).toBe('{"city":"Beijing"}');
    expect(result!.before).toBe('');
  });

  it('parses parallel calls with sequential indexes', () => {
    const result = parseToolCalls(
      wrap('[{"name": "a", "arguments": {}}, {"name": "b", "arguments": {"x": 1}}]'),
    );
    expect(result!.calls).toHaveLength(2);
    expect(result!.calls[0].index).toBe(0);
    expect(result!.calls[1].index).toBe(1);
    expect(result!.calls[0].id).not.toBe(result!.calls[1].id);
    expect(result!.calls[1].arguments).toBe('{"x":1}');
  });

  it('preserves text emitted before the marker', () => {
    const result = parseToolCalls(`前置文本\n${wrap('[{"name": "a", "arguments": {}}]')}`);
    expect(result!.before).toBe('前置文本\n');
  });

  it('drops text after the end marker (anti-hallucination)', () => {
    const result = parseToolCalls(wrap('[{"name": "a", "arguments": {}}]') + '幻觉尾部');
    expect(result!.calls).toHaveLength(1);
    expect(result!.before).toBe('');
  });

  it('tolerates surroundings and newlines inside the markers', () => {
    const result = parseToolCalls(`${TOOL_CALL_START}\n以下是工具调用：\n\t[{"name": "f", "arguments": {}}]\n${TOOL_CALL_END}`);
    expect(result!.calls).toHaveLength(1);
  });

  it('repairs unquoted JSON keys', () => {
    const result = parseToolCalls(wrap('[{name: "get_weather", arguments: {city: "Beijing"}}]'));
    expect(result!.calls).toHaveLength(1);
    expect(result!.calls[0].arguments).toBe('{"city":"Beijing"}');
  });

  it('repairs invalid backslashes (Windows paths)', () => {
    const result = parseToolCalls(wrap('[{"name": "read_file", "arguments": {"path": "C:\\Users\\Public"}}]'));
    expect(result!.calls).toHaveLength(1);
    expect(result!.calls[0].arguments).toContain('C:\\\\Users\\\\Public');
  });

  it('accepts a single object instead of an array', () => {
    const result = parseToolCalls(wrap('{"name": "f", "arguments": {"a": 1}}'));
    expect(result!.calls).toHaveLength(1);
    expect(result!.calls[0].name).toBe('f');
  });

  it('matches hallucinated marker variants via fuzzy normalization', () => {
    const fuzzyEnd = `${TOOL_CALL_START}[{"name": "a", "arguments": {}}]<|tool_calls\u2581end\uFF5C>`;
    const result = parseToolCalls(fuzzyEnd);
    expect(result!.calls).toHaveLength(1);
  });

  it('ignores markers inside markdown code fences', () => {
    const fenced = `示例：\n\`\`\`json\n${wrap('[{"name": "a", "arguments": {}}]')}\n\`\`\``;
    expect(parseToolCalls(fenced)).toBeNull();
  });

  it('accepts markers when code fences appear only inside argument values', () => {
    const inner = `${TOOL_CALL_START}[{"name": "format_code", "arguments": {"code": "\`\`\`rust\\nfn main() {}\\n\`\`\`"}}]${TOOL_CALL_END}`;
    const result = parseToolCalls(inner);
    expect(result!.calls).toHaveLength(1);
  });

  it('rejects an empty call array', () => {
    expect(parseToolCalls(wrap('[]'))).toBeNull();
  });

  it('rejects malformed items (missing name)', () => {
    expect(parseToolCalls(wrap('[{"arguments": {}}]'))).toBeNull();
  });

  it('returns null when no marker is present', () => {
    expect(parseToolCalls('plain text response')).toBeNull();
  });
});

describe('stripToolMarkers', () => {
  it('removes markers from unparseable output', () => {
    const out = stripToolMarkers(`${TOOL_CALL_START}[坏掉的json${TOOL_CALL_END}`);
    expect(out).not.toContain('tool');
    expect(out).not.toContain('begin');
  });
});

describe('parseDeepSeekSse', () => {
  function sseFrame(p: string | null, v: unknown): string {
    return `data: ${JSON.stringify(p ? { p, o: 'APPEND', v } : { v })}\n`;
  }

  it('streams text immediately without tools and ends with stop', () => {
    const sse = sseFrame('response/content', 'Hello ') + sseFrame(null, 'world') + sseFrame('response/status', 'FINISHED');
    const events = parseDeepSeekSse(sse, false);
    expect(events).toEqual([
      { type: 'text_delta', delta: 'Hello ' },
      { type: 'text_delta', delta: 'world' },
      { type: 'done', reason: 'stop' },
    ]);
  });

  it('emits thinking deltas before content', () => {
    const sse = sseFrame('response/thinking_content', 'think...') + sseFrame('response/content', 'hi') + sseFrame('response/status', 'FINISHED');
    const events = parseDeepSeekSse(sse, false);
    expect(events).toEqual([
      { type: 'thinking_delta', delta: 'think...' },
      { type: 'text_delta', delta: 'hi' },
      { type: 'done', reason: 'stop' },
    ]);
  });

  it('converts marker content into tool_call events with tool_use finish', () => {
    const content = `${TOOL_CALL_START}[{"name": "get_weather", "arguments": {"city": "Beijing"}}]${TOOL_CALL_END}`;
    const sse = sseFrame('response/content', content) + sseFrame('response/status', 'FINISHED');
    const events = parseDeepSeekSse(sse, true);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'tool_call', name: 'get_weather', args: '{"city":"Beijing"}' });
    expect(events[1]).toEqual({ type: 'done', reason: 'tool_use' });
  });

  it('emits pre-marker text then tool calls', () => {
    const content = `按你的要求：${TOOL_CALL_START}[{"name": "a", "arguments": {}}]${TOOL_CALL_END}`;
    const events = parseDeepSeekSse(sseFrame('response/content', content) + sseFrame('response/status', 'FINISHED'), true);
    expect(events[0]).toEqual({ type: 'text_delta', delta: '按你的要求：' });
    expect(events[1]).toMatchObject({ type: 'tool_call' });
  });

  it('degrades to plain text (markers stripped) when parsing fails', () => {
    const content = `${TOOL_CALL_START}[{"name": "a", "arguments": {}}, broken]${TOOL_CALL_END}`;
    const events = parseDeepSeekSse(sseFrame('response/content', content) + sseFrame('response/status', 'FINISHED'), true);
    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'stop' });
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
  });

  it('passes plain text through when tools are requested but not used', () => {
    const events = parseDeepSeekSse(sseFrame('response/content', '直接回答') + sseFrame('response/status', 'FINISHED'), true);
    expect(events).toEqual([
      { type: 'text_delta', delta: '直接回答' },
      { type: 'done', reason: 'stop' },
    ]);
  });

  it('skips the initial full-response snapshot frame', () => {
    const sse = sseFrame('response/status', 'WIP') + JSON.stringify({ p: 'response', o: 'BATCH', v: [{ p: 'response/content', o: 'APPEND', v: 'x' }] }) + '\n' + sseFrame('response/content', 'hi') + sseFrame('response/status', 'FINISHED');
    const events = parseDeepSeekSse(sse, false);
    expect(events).toEqual([
      { type: 'text_delta', delta: 'hi' },
      { type: 'done', reason: 'stop' },
    ]);
  });
});