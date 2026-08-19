import { describe, it, expect } from 'vitest';

/**
 * Frozen request-body contract for the DeepSeek web completion endpoint
 * (docs/deepseek-web-wire-spec.md §4, §15 — corrected 2026-08-19 against the
 * raw-api-reference capture: `ref_file_ids` IS part of the wire body).
 * Pure fixture — no src imports. Do NOT change the expected bodies without
 * updating the wire spec in the same change.
 *
 * Wire facts:
 *   - POST /api/v0/chat/completion body:
 *     { chat_session_id, parent_message_id, model_type, prompt,
 *       ref_file_ids, thinking_enabled, search_enabled, preempt }
 *   - first turn: parent_message_id null (capture shows explicit null)
 *   - ref_file_ids: always present, [] when nothing was uploaded
 *   - model_type values: "default" | "expert" | "vision"
 *   - our provider defaults: thinking on reasoner-named ids only,
 *     search_enabled false (frozen spec §12)
 */

interface CompletionBody {
  chat_session_id: string;
  parent_message_id: number | null;
  model_type: string;
  prompt: string;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  preempt: boolean;
}

function body(overrides: Partial<CompletionBody> = {}): CompletionBody {
  return {
    chat_session_id: 'abc',
    parent_message_id: null,
    model_type: 'default',
    prompt: '',
    ref_file_ids: [],
    thinking_enabled: false,
    search_enabled: false,
    preempt: false,
    ...overrides,
  };
}

describe('deepseek completion request body (frozen wire contract)', () => {
  it('default model first turn serializes exactly as the wire expects', () => {
    expect(body()).toEqual({
      chat_session_id: 'abc',
      parent_message_id: null,
      model_type: 'default',
      prompt: '',
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: false,
      preempt: false,
    });
  });

  it('expert model demux maps open-code deepseek-expert -> model_type expert', () => {
    expect(body({ model_type: 'expert' }).model_type).toBe('expert');
  });

  it('default model demux maps open-code deepseek-default -> model_type default', () => {
    expect(body({ model_type: 'default' }).model_type).toBe('default');
  });

  it('vision demux maps to model_type vision', () => {
    expect(body({ model_type: 'vision' }).model_type).toBe('vision');
  });

  it('ref_file_ids is always present ([] when no uploads)', () => {
    expect(body().ref_file_ids).toEqual([]);
    expect(body({ ref_file_ids: ['file-xxx'] }).ref_file_ids).toEqual(['file-xxx']);
  });

  it('subsequent turns send the previous response_message_id as parent_message_id', () => {
    expect(body({ parent_message_id: 2 }).parent_message_id).toBe(2);
  });

  it('search_enabled defaults to false regardless of tools (frozen §12)', () => {
    expect(body({ search_enabled: false }).search_enabled).toBe(false);
  });
});