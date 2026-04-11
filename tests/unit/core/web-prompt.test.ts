import { describe, it, expect } from 'vitest';
import { buildWebPrompt, extractText } from '../../../src/core/provider.js';
import type { Message } from '../../../src/core/provider.js';

describe('buildWebPrompt', () => {
  it('extracts plain user message', () => {
    const messages: Message[] = [
      { role: 'user', content: '你好' },
    ];
    expect(buildWebPrompt(messages)).toBe('你好');
  });

  it('drops system messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are an AI assistant with tools...' },
      { role: 'user', content: '你好' },
    ];
    expect(buildWebPrompt(messages)).toBe('你好');
  });

  it('strips OpenClaw timestamp prefix from user message', () => {
    const messages: Message[] = [
      { role: 'user', content: '[Mon 2026-04-06 21:46 GMT+8] 王者荣耀是哪个公司的？' },
    ];
    expect(buildWebPrompt(messages)).toBe('王者荣耀是哪个公司的？');
  });

  it('strips full OpenClaw session startup boilerplate', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are 聪聪, an OpenClaw AI agent...' },
      {
        role: 'user',
        content: `A new session was started via /new or /reset. Run your Session Startup sequence.
Current time: Monday, April 6th, 2026 — 21:46 (Asia/Shanghai) / 2026-04-06 13:46 UTC
Sender (untrusted metadata):
\`\`\`json
{
  "label": "openclaw-control-ui",
  "id": "openclaw-control-ui"
}
\`\`\`

[Mon 2026-04-06 21:46 GMT+8] 王者荣耀是哪个公司的？你是哪个公司的？`,
      },
    ];
    expect(buildWebPrompt(messages)).toBe('王者荣耀是哪个公司的？你是哪个公司的？');
  });

  it('returns last user message in multi-turn conversation', () => {
    const messages: Message[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么可以帮你的？' },
      { role: 'user', content: '天气怎么样？' },
    ];
    expect(buildWebPrompt(messages)).toBe('天气怎么样？');
  });

  it('handles content block array format', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '你好' }] as any },
    ];
    expect(buildWebPrompt(messages)).toBe('你好');
  });

  it('passes through plain message without OpenClaw metadata', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Tell me about JavaScript' },
    ];
    expect(buildWebPrompt(messages)).toBe('Tell me about JavaScript');
  });

  it('drops tool role messages', () => {
    const messages: Message[] = [
      { role: 'user', content: '搜索天气' },
      { role: 'tool', content: '{"result": "晴天"}', tool_call_id: '123' },
      { role: 'user', content: '谢谢' },
    ];
    expect(buildWebPrompt(messages)).toBe('谢谢');
  });

  it('returns empty string for empty messages', () => {
    expect(buildWebPrompt([])).toBe('');
  });

  it('handles different day names in timestamp', () => {
    const messages: Message[] = [
      { role: 'user', content: '[Tue 2026-04-07 09:30 Asia/Shanghai] 早上好' },
    ];
    expect(buildWebPrompt(messages)).toBe('早上好');
  });
});

describe('extractText', () => {
  it('returns string as-is', () => {
    expect(extractText('hello')).toBe('hello');
  });

  it('extracts text from content block array', () => {
    expect(extractText([{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }])).toBe('hello world');
  });

  it('handles non-string non-array', () => {
    expect(extractText(123)).toBe('123');
  });

  it('handles null/undefined', () => {
    expect(extractText(null)).toBe('');
    expect(extractText(undefined)).toBe('');
  });
});
