import { describe, it, expect } from 'vitest';
import { fromOpenAIMessages, fromAnthropicMessages, extractText } from '../../../src/core/provider.js';

describe('fromOpenAIMessages', () => {
  it('preserves message order and roles', () => {
    const messages = fromOpenAIMessages([
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'How are you?' },
    ]);
    expect(messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages.map(m => m.content)).toEqual(['You are helpful', 'Hi', 'Hello!', 'How are you?']);
  });

  it('preserves content-block arrays verbatim (multimodal)', () => {
    const content = [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } },
      { type: 'input_audio', input_audio: { data: 'wavdata', format: 'wav' } },
    ];
    const messages = fromOpenAIMessages([{ role: 'user', content }]);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual(content);
  });

  it('preserves assistant tool_calls and tool tool_call_id', () => {
    const toolCalls = [{
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
    }];
    const messages = fromOpenAIMessages([
      { role: 'assistant', content: '', tool_calls: toolCalls },
      { role: 'tool', content: '22C', tool_call_id: 'call_1' },
    ]);
    expect(messages[0].tool_calls).toEqual(toolCalls);
    expect(messages[1].tool_call_id).toBe('call_1');
    expect(messages[1].role).toBe('tool');
  });

  it('drops non-message entries without dropping valid ones', () => {
    const messages = fromOpenAIMessages([
      null,
      { role: 'system', content: 's' },
      { role: 'unknown', content: 'x' },
      'not-an-object',
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('s');
  });

  it('handles missing content as empty string', () => {
    const messages = fromOpenAIMessages([{ role: 'user' }]);
    expect(messages[0].content).toBe('');
  });
});

describe('fromAnthropicMessages', () => {
  it('maps system (string and blocks) to a system message', () => {
    const messages = fromAnthropicMessages({
      system: 'Be brief',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(messages[0]).toEqual({ role: 'system', content: 'Be brief' });
    expect(messages).toHaveLength(2);

    const messages2 = fromAnthropicMessages({
      system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(messages2[0].content).toBe('AB');
  });

  it('preserves text and image blocks', () => {
    const messages = fromAnthropicMessages({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'xyz' } },
          { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
        ],
      }],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'Look at this' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,xyz' } },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ]);
  });

  it('converts tool_use to assistant tool_calls with JSON-encoded arguments', () => {
    const messages = fromAnthropicMessages({
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Beijing' } },
        ],
      }],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].tool_calls).toEqual([{
      id: 'toolu_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
    }]);
  });

  it('converts tool_result to a tool message with tool_call_id', () => {
    const messages = fromAnthropicMessages({
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '22C' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'Sunny' }] },
        ],
      }],
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'tool', content: '22C', tool_call_id: 'toolu_1' });
    expect(messages[1]).toEqual({ role: 'tool', content: 'Sunny', tool_call_id: 'toolu_2' });
  });

  it('maps thinking blocks to text without losing content', () => {
    const messages = fromAnthropicMessages({
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm...' }] }],
    });
    expect(messages[0].content).toBe('hmm...');
  });

  it('normalizes a single text block to a plain string, keeps others as arrays', () => {
    const messages = fromAnthropicMessages({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'single' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
          ],
        },
      ],
    });
    expect(messages[0].content).toBe('single');
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
    ]);
  });

  it('accepts plain string content', () => {
    const messages = fromAnthropicMessages({
      messages: [{ role: 'user', content: 'Plain text' }],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Plain text');
  });

  it('ignores unknown roles and empty content', () => {
    const messages = fromAnthropicMessages({
      messages: [
        { role: 'admin', content: 'x' },
        { role: 'user', content: [] },
      ],
    });
    expect(messages).toHaveLength(0);
  });
});

describe('extractText', () => {
  it('extracts text from mixed content blocks', () => {
    const content = [
      { type: 'text', text: 'Hello' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'text', text: ' world' },
    ];
    expect(extractText(content)).toBe('Hello world');
  });
});
