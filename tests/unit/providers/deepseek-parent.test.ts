import { describe, it, expect } from 'vitest';

/**
 * Offline spec for DeepSeek session parent chaining (NOT wired into the
 * provider yet — live wire confirmation pending, see audit report).
 *
 * Wire facts transcribed from ds-free-api (raw-api-reference.md §4,
 * chat/response.rs parse_ready_message_ids):
 *   - completion SSE emits: `event: ready` + `data: {"request_message_id":N,"response_message_id":M}`
 *   - the message id to send as parent_message_id on the NEXT completion in
 *     the same session is M (the response_message_id of the ready event).
 *
 * The current index.ts always sends parent_message_id: null and creates a
 * fresh chat_session per turn (no capture, no reuse). These tests pin the
 * intended state transition so the eventual wiring (extractReadyMessageIds +
 * per-conversation { sessionId, parentMessageId } state) has a contract.
 */

function extractReadyMessageIds(sseText: string): { requestMessageId: number; responseMessageId: number } | null {
  for (const block of sseText.split('\n\n')) {
    const isReady = block
      .split('\n')
      .some((l) => l.trim().startsWith('event:') && l.trim().slice(6).trim() === 'ready');
    if (!isReady) continue;
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      try {
        const v = JSON.parse(t.slice(6));
        if (typeof v.request_message_id === 'number' && typeof v.response_message_id === 'number') {
          return { requestMessageId: v.request_message_id, responseMessageId: v.response_message_id };
        }
      } catch {
        // skip malformed data lines
      }
    }
  }
  return null;
}

/** Mirrors the completion payload built in src/providers/deepseek/index.ts (frozen shape). */
function buildCompletionBody(sessionId: string, parentMessageId: number | null, prompt: string): Record<string, unknown> {
  return {
    chat_session_id: sessionId,
    parent_message_id: parentMessageId,
    prompt,
    ref_file_ids: [],
    thinking_enabled: false,
    search_enabled: false,
    preempt: false,
  };
}

const readyBlock = (request: number, response: number) =>
  `event: ready\ndata: ${JSON.stringify({ request_message_id: request, response_message_id: response, model_type: 'expert' })}\n\n`;

describe('deepseek parent chaining (offline spec)', () => {
  it('captures request/response message ids from the ready event', () => {
    const sse = `data: {"p":"response/status","v":"WIP"}\n\n${readyBlock(1, 2)}\nevent: update_session\ndata: {"updated_at":1775386361.526172}\n`;
    expect(extractReadyMessageIds(sse)).toEqual({ requestMessageId: 1, responseMessageId: 2 });
  });

  it('returns null when no ready event is present (plain/single-turn responses)', () => {
    const contentOnly = [
      `data: {"p":"response/fragments/-1/content","o":"APPEND","v":"hello"}\n\n`,
      `data: {"p":"response/status","v":"FINISHED"}\n\n`,
    ].join('');
    expect(extractReadyMessageIds(contentOnly)).toBeNull();
    expect(extractReadyMessageIds('plain text response')).toBeNull();
  });

  it('chains parent ids across three turns in one session', () => {
    const sessionId = 'e6795fb3-272f-4782-87cf-6d6140b5bf76';
    let parent: number | null = null;

    // turn 1: first request in a session -> null parent
    expect(buildCompletionBody(sessionId, parent, 'first question').parent_message_id).toBeNull();
    parent = extractReadyMessageIds(readyBlock(1, 2))!.responseMessageId;

    // turn 2: previous response id becomes the parent
    expect(buildCompletionBody(sessionId, parent, 'second question').parent_message_id).toBe(2);
    parent = extractReadyMessageIds(readyBlock(2, 3))!.responseMessageId;

    // turn 3: second response id becomes the parent
    expect(buildCompletionBody(sessionId, parent, 'third question').parent_message_id).toBe(3);
  });

  it('stays compatible with a single-turn completion (no ready event -> parent stays null)', () => {
    const sse = `data: {"p":"response/status","v":"FINISHED"}\n\n`;
    const parent = extractReadyMessageIds(sse)?.responseMessageId ?? null;
    expect(buildCompletionBody('s1', parent, 'one-off').parent_message_id).toBeNull();
  });
});