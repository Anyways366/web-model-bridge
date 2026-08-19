import { describe, it, expect } from 'vitest';
import { parseDeepSeekStream, parseDeepSeekSse } from '../../../src/providers/deepseek/sse.js';
import { TOOL_CALL_START, TOOL_CALL_END } from '../../../src/providers/deepseek/tools.js';

/**
 * Frozen wire fixtures (docs/deepseek-web-wire-spec.md §8–§13).
 * Fixtures use the documented wire shapes:
 *   event: ready / data: {"request_message_id":N,"response_message_id":M}
 *   event: update_session / data: {"updated_at":...}
 *   data: {"p":"response/fragments/-1/content","o":"APPEND","v":"..."}
 *   data: {"v":{"response":{"message_id":2,"fragments":[...]}}}   (snapshot)
 *   data: {"p":"response","o":"BATCH","v":[...]}                   (batch)
 *   data: {"p":"response/status","v":"FINISHED"}                   (terminal)
 */

const readyBlock = (request: unknown, response: unknown): string =>
  `event: ready\ndata: ${JSON.stringify({ request_message_id: request, response_message_id: response, model_type: 'expert' })}\n\n`;

const contentFrame = (v: string, path = 'response/fragments/-1/content'): string =>
  `data: ${JSON.stringify({ p: path, o: 'APPEND', v })}\n`;

const statusFrame = (v: string): string => `data: ${JSON.stringify({ p: 'response/status', v })}\n`;

const snapshot = (fragments: unknown[]): string =>
  `data: ${JSON.stringify({ v: { response: { message_id: 2, fragments } } })}\n`;

describe('parseDeepSeekStream — ready metadata (Phase 3)', () => {
  it('extracts valid request/response message ids from the ready event', () => {
    const result = parseDeepSeekStream(readyBlock(1715167018000, 1715167018001) + contentFrame('hi') + statusFrame('FINISHED'), false);
    expect(result.error).toBeNull();
    expect(result.ready).toEqual({ requestMessageId: 1715167018000, responseMessageId: 1715167018001 });
  });

  it('returns the wire fallback (1, 2) when both ids are missing', () => {
    const result = parseDeepSeekStream(`event: ready\ndata: {"model_type":"expert"}\n\n` + statusFrame('FINISHED'), false);
    expect(result.ready).toEqual({ requestMessageId: 1, responseMessageId: 2 });
  });

  it('returns the wire fallback (1, 2) when ids are malformed (non-numeric)', () => {
    const result = parseDeepSeekStream(readyBlock('abc', 'xyz') + statusFrame('FINISHED'), false);
    expect(result.ready).toEqual({ requestMessageId: 1, responseMessageId: 2 });
  });

  it('falls back when only one id is present', () => {
    const result = parseDeepSeekStream(`event: ready\ndata: {"request_message_id":5}\n\n` + statusFrame('FINISHED'), false);
    expect(result.ready).toEqual({ requestMessageId: 1, responseMessageId: 2 });
  });

  it('accepts numeric-string ids (documented wire values)', () => {
    const result = parseDeepSeekStream(readyBlock('1715167018000', '1715167018001') + statusFrame('FINISHED'), false);
    expect(result.ready).toEqual({ requestMessageId: 1715167018000, responseMessageId: 1715167018001 });
  });

  it('last ready event wins when multiple ready events appear', () => {
    const sse = readyBlock(1, 2) + contentFrame('a') + readyBlock(2, 3) + statusFrame('FINISHED');
    const result = parseDeepSeekStream(sse, false);
    expect(result.ready).toEqual({ requestMessageId: 2, responseMessageId: 3 });
  });

  it('does not advance ready state from non-ready frames', () => {
    const sse = contentFrame('x') + readyBlock(7, 8) + contentFrame('y') + statusFrame('FINISHED');
    const result = parseDeepSeekStream(sse, false);
    expect(result.ready).toEqual({ requestMessageId: 7, responseMessageId: 8 });
  });

  it('reports a controlled error when the stream ends before ready', () => {
    const result = parseDeepSeekStream(contentFrame('text without ready') + statusFrame('FINISHED'), false);
    expect(result.error).toEqual({ message: 'Stream ended before the ready event', code: 'stream' });
    expect(result.ready).toBeNull();
  });

  it('reports a controlled error on an empty/unparseable payload', () => {
    const result = parseDeepSeekStream('plain text response', false);
    expect(result.error?.code).toBe('stream');
    expect(result.events).toEqual([]);
  });
});

describe('parseDeepSeekStream — wire frames (Phase 2)', () => {
  it('streams fragment appends as text and terminates on status FINISHED', () => {
    const sse = readyBlock(1, 2) + contentFrame('Hello ') + `data: {"v":"world"}\n` + statusFrame('FINISHED');
    const result = parseDeepSeekStream(sse, false);
    expect(result.events).toEqual([
      { type: 'text_delta', delta: 'Hello ' },
      { type: 'text_delta', delta: 'world' },
      { type: 'done', reason: 'stop' },
    ]);
  });

  it('routes THINK fragments to thinking deltas and RESPONSE to text', () => {
    const sse =
      readyBlock(1, 2) +
      snapshot([{ type: 'THINK', content: 'thinking starts' }]) +
      contentFrame(' continues thinking') +
      `data: ${JSON.stringify({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'answer starts' }] })}\n` +
      contentFrame(' continues answer') +
      statusFrame('FINISHED');
    const result = parseDeepSeekStream(sse, false);
    expect(result.events).toEqual([
      { type: 'thinking_delta', delta: 'thinking starts' },
      { type: 'thinking_delta', delta: ' continues thinking' },
      { type: 'text_delta', delta: 'answer starts' },
      { type: 'text_delta', delta: ' continues answer' },
      { type: 'done', reason: 'stop' },
    ]);
  });

  it('appends fragments pushed via response/fragments APPEND', () => {
    const sse =
      readyBlock(1, 2) +
      `data: ${JSON.stringify({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'frag-a' }] })}\n` +
      contentFrame('-b') +
      statusFrame('FINISHED');
    const result = parseDeepSeekStream(sse, false);
    expect(result.events).toEqual([
      { type: 'text_delta', delta: 'frag-a' },
      { type: 'text_delta', delta: '-b' },
      { type: 'done', reason: 'stop' },
    ]);
  });

  it('ignores non-THINK/RESPONSE fragment types (TOOL_SEARCH etc.)', () => {
    const sse =
      readyBlock(1, 2) +
      snapshot([{ type: 'TOOL_SEARCH', content: 'url1' }, { type: 'RESPONSE', content: 'final' }]) +
      statusFrame('FINISHED');
    const result = parseDeepSeekStream(sse, false);
    expect(result.events).toEqual([{ type: 'text_delta', delta: 'final' }, { type: 'done', reason: 'stop' }]);
  });

  it('decomposes BATCH frames with child path prefixing (accumulated usage captured)', () => {
    const sse =
      readyBlock(1, 2) +
      contentFrame('batch ok') +
      `data: ${JSON.stringify({ p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: 139 }, { p: 'quasi_status', v: 'FINISHED' }] })}\n` +
      statusFrame('FINISHED');
    const result = parseDeepSeekStream(sse, false);
    expect(result.error).toBeNull();
    expect(result.events.at(-1)).toEqual({
      type: 'done',
      reason: 'stop',
      usage: { prompt_tokens: 0, completion_tokens: 139, total_tokens: 139 },
    });
  });

  it('terminates with reason length on INCOMPLETE (truncated stream)', () => {
    const sse = readyBlock(1, 2) + contentFrame('partial') + statusFrame('INCOMPLETE');
    const result = parseDeepSeekStream(sse, false);
    expect(result.events).toEqual([{ type: 'text_delta', delta: 'partial' }, { type: 'done', reason: 'length' }]);
  });

  it('treats close/update_session/title events as no-ops', () => {
    const sse =
      readyBlock(1, 2) +
      'event: update_session\ndata: {"updated_at":1778639258.866693}\n\n' +
      contentFrame('done speaking') +
      statusFrame('FINISHED') +
      'event: update_session\ndata: {"updated_at":1778639258.9}\n\n' +
      'event: title\ndata: {"content":"title"}\n\n' +
      'event: close\ndata: {"click_behavior":"none","auto_resume":false}\n\n';
    const result = parseDeepSeekStream(sse, false);
    expect(result.events).toEqual([{ type: 'text_delta', delta: 'done speaking' }, { type: 'done', reason: 'stop' }]);
  });

  it('handles a mix of proper SSE and bare JSON lines', () => {
    const sse = `event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n${JSON.stringify({ p: 'response/content', o: 'APPEND', v: 'bare line' })}\n` + statusFrame('FINISHED');
    const result = parseDeepSeekStream(sse, true);
    expect(result.events.at(-1)).toEqual({ type: 'done', reason: 'stop' });
    expect(result.events).toContainEqual({ type: 'text_delta', delta: 'bare line' });
  });

  it('buffers markers in tools mode across fragment frames and emits tool_call', () => {
    const marker = `${TOOL_CALL_START}[{"name": "get_weather", "arguments": {"city":"Beijing"}}]${TOOL_CALL_END}`;
    const sse =
      readyBlock(1, 2) +
      snapshot([{ type: 'RESPONSE', content: '' }]) +
      contentFrame(marker.slice(0, 30)) +
      contentFrame(marker.slice(30)) +
      statusFrame('FINISHED');
    const result = parseDeepSeekStream(sse, true);
    expect(result.events[0]).toMatchObject({ type: 'tool_call', name: 'get_weather' });
    expect(result.events.at(-1)).toEqual({ type: 'done', reason: 'tool_use' });
  });
});

describe('parseDeepSeekStream — errors (Phase 6)', () => {
  it('maps rate_limit hint to an overloaded controlled error', () => {
    const sse =
      readyBlock(1, 2) + 'event: hint\ndata: {"type":"error","content":"","clear_response":true,"finish_reason":"rate_limit_reached"}\n\n';
    const result = parseDeepSeekStream(sse, true);
    expect(result.error).toEqual({ message: 'Service is overloaded', code: 'overloaded' });
  });

  it('maps input_exceeds_limit hint to a controlled error', () => {
    const sse =
      readyBlock(1, 2) +
      'event: hint\ndata: {"type":"error","content":"Content is too long. Please shorten it and try again.","clear_response":true,"finish_reason":"input_exceeds_limit"}\n\n';
    const result = parseDeepSeekStream(sse, false);
    expect(result.error?.code).toBe('api');
    expect(result.error?.message).toMatch(/input/i);
  });

  it('maps the JSON error envelope {code,msg} to a controlled error', () => {
    const sse = readyBlock(1, 2) + `data: ${JSON.stringify({ code: 40313, msg: 'bad request' })}\n`;
    const result = parseDeepSeekStream(sse, false);
    expect(result.error).toEqual({ message: 'API error code=40313: bad request', code: 'api' });
  });

  it('maps INVALID_POW_RESPONSE code 40301 to a pow error', () => {
    const sse = `data: ${JSON.stringify({ code: 40301, msg: 'invalid signature' })}\n`;
    const result = parseDeepSeekStream(sse, false);
    expect(result.error).toEqual({ message: 'INVALID_POW_RESPONSE: invalid signature', code: 'pow' });
  });

  it('maps overload codes 1001/1201 to overloaded', () => {
    for (const code of [1001, 1201]) {
      const result = parseDeepSeekStream(`data: ${JSON.stringify({ code, msg: 'busy' })}\n`, false);
      expect(result.error?.code).toBe('overloaded');
    }
  });

  it('degrades gracefully when the stream ends without a terminal status', () => {
    const sse = readyBlock(1, 2) + contentFrame('ends abruptly');
    const result = parseDeepSeekStream(sse, false);
    expect(result.error).toBeNull();
    expect(result.events).toEqual([{ type: 'text_delta', delta: 'ends abruptly' }, { type: 'done', reason: 'stop' }]);
  });
});

describe('parseDeepSeekSse — fragmentation & chunking (Phase 2)', () => {
  it('produces identical events regardless of network chunk boundaries', () => {
    const whole =
      readyBlock(1, 2) +
      snapshot([{ type: 'THINK', content: 't1' }, { type: 'RESPONSE', content: '' }]) +
      contentFrame('chunky ') +
      contentFrame('text') +
      `data: ${JSON.stringify({ p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: 7 }, { p: 'quasi_status', v: 'FINISHED' }] })}\n` +
      statusFrame('FINISHED') +
      'event: update_session\ndata: {"updated_at":1778639258.866693}\n\n' +
      'event: close\ndata: {"click_behavior":"none","auto_resume":false}\n\n';

    const wholeResult = parseDeepSeekSse(whole, false);
    // cut at every byte offset that lands mid-line — the parser must not
    // care: the read loop joins fragments before parsing.
    for (const cut of [Math.floor(whole.length / 3), Math.floor(whole.length / 2), whole.indexOf('chunky ')]) {
      const joined = whole.slice(0, cut) + whole.slice(cut);
      expect(parseDeepSeekSse(joined, false)).toEqual(wholeResult);
    }
  });

  it('parses multiple events that arrive in a single network chunk', () => {
    const oneChunk =
      readyBlock(1, 2) +
      'event: update_session\ndata: {"updated_at":1775386361.526172}\n\n' +
      contentFrame('all') +
      contentFrame(' in') +
      contentFrame(' one') +
      statusFrame('FINISHED');
    expect(parseDeepSeekSse(oneChunk, false)).toEqual([
      { type: 'text_delta', delta: 'all' },
      { type: 'text_delta', delta: ' in' },
      { type: 'text_delta', delta: ' one' },
      { type: 'done', reason: 'stop' },
    ]);
  });
});