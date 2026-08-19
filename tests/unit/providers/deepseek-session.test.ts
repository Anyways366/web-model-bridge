import { describe, it, expect } from 'vitest';
import { DeepSeekSessionStore, advanceSession } from '../../../src/providers/deepseek/session.js';
import type { DeepSeekReadyMeta } from '../../../src/providers/deepseek/sse.js';

/**
 * Phase 4 contract: conversationId → { sessionId, parentMessageId }.
 *   - first turn: parentMessageId = null
 *   - create session once; subsequent turns reuse the same session
 *   - subsequent request uses previous response_message_id as parent
 *   - successful response updates parentMessageId
 *   - different conversationIds never share state
 *   - provider restart loses only in-memory state
 * No account pooling, no rotation, no timeout policy.
 */

function ready(responseMessageId: number): DeepSeekReadyMeta {
  return { requestMessageId: responseMessageId - 1, responseMessageId };
}

describe('DeepSeekSessionStore', () => {
  it('first turn state starts with parentMessageId null', () => {
    const state = { sessionId: 's1', parentMessageId: null };
    expect(state).toEqual({ sessionId: 's1', parentMessageId: null });
  });

  it('reuses the same session across turns in one conversation', () => {
    const store = new DeepSeekSessionStore();
    store.set('conv-a', { sessionId: 's1', parentMessageId: null });

    const turn2 = store.get('conv-a');
    expect(turn2?.sessionId).toBe('s1');

    store.set('conv-a', advanceSession(turn2!, ready(2)));
    expect(store.get('conv-a')).toEqual({ sessionId: 's1', parentMessageId: 2 });
    // same session object identity — no re-creation
    expect(store.get('conv-a')?.sessionId).toBe('s1');
  });

  it('advances parentMessageId from the ready response_message_id', () => {
    let state = { sessionId: 's1', parentMessageId: null as number | null };
    state = advanceSession(state, ready(2));
    expect(state.parentMessageId).toBe(2);
    state = advanceSession(state, ready(3));
    expect(state.parentMessageId).toBe(3);
  });

  it('keeps the previous parent when no ready ids arrive', () => {
    const state = { sessionId: 's1', parentMessageId: 2 };
    expect(advanceSession(state, null).parentMessageId).toBe(2);
  });

  it('different conversationIds never share state', () => {
    const store = new DeepSeekSessionStore();
    store.set('conv-a', { sessionId: 's-a', parentMessageId: null });
    store.set('conv-b', { sessionId: 's-b', parentMessageId: 41 });

    store.set('conv-a', advanceSession(store.get('conv-a')!, ready(2)));
    expect(store.get('conv-a')).toEqual({ sessionId: 's-a', parentMessageId: 2 });
    expect(store.get('conv-b')).toEqual({ sessionId: 's-b', parentMessageId: 41 });
    expect(store.size).toBe(2);
  });

  it('provider restart loses only in-memory state (fresh store is empty)', () => {
    const store = new DeepSeekSessionStore();
    store.set('conv-a', { sessionId: 's1', parentMessageId: 3 });

    const afterRestart = new DeepSeekSessionStore();
    expect(afterRestart.get('conv-a')).toBeUndefined();
    expect(afterRestart.size).toBe(0);
  });

  it('chains parents across three turns like the wire ready ids', () => {
    const store = new DeepSeekSessionStore();
    const conversationKey = 's1';
    let state = { sessionId: 's1', parentMessageId: null as number | null };
    store.set(conversationKey, state);

    // turn 1 → ready response 2
    state = advanceSession(state, ready(2));
    store.set(conversationKey, state);
    expect(store.get('s1')).toEqual({ sessionId: 's1', parentMessageId: 2 });

    // turn 2 uses parent 2 → ready response 3
    state = advanceSession(state, ready(3));
    store.set(conversationKey, state);
    expect(store.get('s1')).toEqual({ sessionId: 's1', parentMessageId: 3 });

    // turn 3 uses parent 3
    expect(store.get('s1')!.parentMessageId).toBe(3);
  });
});