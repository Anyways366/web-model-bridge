import { describe, it, expect } from 'vitest';
import { buildDeepSeekPrompt, parseToolCalls, TOOL_CALL_START, TOOL_CALL_END, TOOL_OUTPUTS_BEGIN, TOOL_OUTPUT_BEGIN, TOOL_OUTPUT_END, TOOL_OUTPUTS_END } from '../../../src/providers/deepseek/tools.js';
import { parseDeepSeekStream } from '../../../src/providers/deepseek/sse.js';
import type { Message, ToolDef } from '../../../src/core/provider.js';

/**
 * Phase 5 — tool continuation chain regression.
 * user → assistant tool call → OpenCode executes → tool result →
 * DeepSeek continuation. The provider contract pins:
 *   - tool results serialize into the frozen tool-outputs block
 *   - assistant tool calls serialize once, inside the call markers
 *   - the continuation prompt carries the result (the model sees it)
 *   - parsing never synthesizes duplicate calls (loop control lives in the
 *     caller; the parser must return exactly what the model emitted)
 */

const writeTool: ToolDef = {
  type: 'function',
  function: {
    name: 'Write',
    description: 'Write a file to disk',
    parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } } },
  },
};

const FILE_PATH = 'example.txt';
const ACCEPTANCE = 'WEBMODEL_ACCEPTANCE_4711';

/** The exact replayed assistant call as serialized inside the call markers
 *  (formatBody: JSON round-trips the arguments → compact JSON). */
const replayedCall = (): string =>
  `[{"name": "Write", "arguments": {"file_path":"${FILE_PATH}","content":"${ACCEPTANCE}"}}]`;

function writeCall(): Message['tool_calls'] {
  return [
    {
      id: 'call_write_1',
      type: 'function',
      function: { name: 'Write', arguments: JSON.stringify({ file_path: FILE_PATH, content: ACCEPTANCE }) },
    },
  ];
}

const history: Message[] = [
  { role: 'user', content: `Create a file called ${FILE_PATH} containing ${ACCEPTANCE}.` },
  { role: 'assistant', content: '', tool_calls: writeCall() },
  { role: 'tool', content: `File written: ${ACCEPTANCE}`, tool_call_id: 'call_write_1' },
];

describe('tool continuation chain', () => {
  it('serializes the assistant WRITE call exactly once inside call markers', () => {
    const prompt = buildDeepSeekPrompt(history, [writeTool]);
    // The instruction block may mention the call marker many times; the
    // replayed CALL (exact serialized JSON) must appear exactly once.
    expect(prompt.split(replayedCall()).length - 1).toBe(1);
    expect(prompt.indexOf(replayedCall())).toBeGreaterThan(prompt.indexOf(TOOL_CALL_START));
  });

  it('serializes the tool result exactly once inside the outputs block', () => {
    const prompt = buildDeepSeekPrompt(history, [writeTool]);
    expect(prompt).toContain(`${TOOL_OUTPUTS_BEGIN}${TOOL_OUTPUT_BEGIN}File written: ${ACCEPTANCE}${TOOL_OUTPUT_END}${TOOL_OUTPUTS_END}`);
    // The acceptance value appears once in the user ask, once replayed
    // inside the assistant call, and once in the tool result.
    expect(prompt.split(ACCEPTANCE).length - 1).toBe(3);
    expect(prompt.split(`File written: ${ACCEPTANCE}`).length - 1).toBe(1);
  });

  it('orders history: ask → call → result → continuation position', () => {
    const prompt = buildDeepSeekPrompt([...history, { role: 'user', content: 'Now verify the file.' }], [writeTool]);
    const ask = prompt.indexOf(ACCEPTANCE);
    const call = prompt.indexOf(replayedCall());
    const result = prompt.indexOf('File written');
    const follow = prompt.indexOf('Now verify the file.');
    expect(ask).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(ask);
    expect(result).toBeGreaterThan(call);
    expect(follow).toBeGreaterThan(result);
  });

  it('does not re-emit the WRITE call when a result-only turn repeats no call', () => {
    const nextTurn: Message[] = [
      ...history,
      { role: 'tool', content: 'Verified: contents match.', tool_call_id: 'call_write_2' },
    ];
    const prompt = buildDeepSeekPrompt(nextTurn, [writeTool]);
    // Only the original call is replayed — no synthesized duplicates.
    expect(prompt.split(replayedCall()).length - 1).toBe(1);
  });

  it('parses exactly the calls the model emitted — no duplicate synthesis (WRITE loop regression)', () => {
    // Regression: WRITE → tool result → model must NOT blindly repeat WRITE.
    // The parser must surface exactly one WRITE per emitted marker block and
    // must not invent repeats; loop control stays in the OpenCode tool loop.
    const repeat = `${TOOL_CALL_START}[{"name": "Write", "arguments": {"file_path": "${FILE_PATH}", "content": "${ACCEPTANCE}"}}]${TOOL_CALL_END}`;
    const parsed = parseToolCalls(repeat);
    expect(parsed).not.toBeNull();
    expect(parsed!.calls).toHaveLength(1);
    expect(parsed!.calls[0].name).toBe('Write');
    expect(parsed!.calls[0].arguments).toContain(FILE_PATH);
    expect(parsed!.calls[0].arguments).toContain(ACCEPTANCE);
  });

  it('a model answer that moves on parses to a different tool, not another WRITE', () => {
    const movedOn = `${TOOL_CALL_START}[{"name": "Read", "arguments": {"file_path": "${FILE_PATH}"}}]${TOOL_CALL_END}`;
    const parsed = parseToolCalls(movedOn);
    expect(parsed!.calls).toHaveLength(1);
    expect(parsed!.calls[0].name).toBe('Read');
  });

  it('carries the tool continuation through the SSE parser with correct chaining ids', () => {
    const content = `${TOOL_CALL_START}[{"name": "Write", "arguments": {"file_path": "${FILE_PATH}", "content": "${ACCEPTANCE}"}}]${TOOL_CALL_END}`;
    const sse =
      `event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n` +
      `data: ${JSON.stringify({ p: 'response/fragments/-1/content', o: 'APPEND', v: content })}\n` +
      `data: ${JSON.stringify({ p: 'response/status', v: 'FINISHED' })}\n`;
    const result = parseDeepSeekStream(sse, true);
    expect(result.ready).toEqual({ requestMessageId: 1, responseMessageId: 2 });
    expect(result.events[0]).toMatchObject({ type: 'tool_call', name: 'Write' });
    expect(result.events.at(-1)).toEqual({ type: 'done', reason: 'tool_use' });
  });

  it('serializes build-side tool output idempotently for a repeated history', () => {
    const a = buildDeepSeekPrompt(history, [writeTool]);
    const b = buildDeepSeekPrompt(history, [writeTool]);
    expect(a).toBe(b);
  });
});