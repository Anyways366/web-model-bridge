import { describe, it, expect } from 'vitest';
import { buildDoubaoCompletionBody } from '../../../src/providers/doubao-web/index.js';

describe('buildDoubaoCompletionBody', () => {
  it('creates a new conversation by default (conversation_id "0", need_create true)', () => {
    const body = buildDoubaoCompletionBody('Hello');
    expect(body.conversation_id).toBe('0');
    expect(body.completion_option.need_create_conversation).toBe(true);
    expect(body.messages[0].content).toBe(JSON.stringify({ text: 'Hello' }));
  });

  it('reuses an existing conversation id and skips creation', () => {
    const body = buildDoubaoCompletionBody('Hello again', 'server-conv-9');
    expect(body.conversation_id).toBe('server-conv-9');
    expect(body.completion_option.need_create_conversation).toBe(false);
  });
});
