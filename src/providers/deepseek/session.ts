import type { DeepSeekReadyMeta } from './sse.js';

/**
 * Per-conversation session state for the DeepSeek web protocol.
 *
 * Keyed by `conversationId` (the chat_session_id returned to the caller in
 * the `done` event). First turn of a conversation has parentMessageId null;
 * every successful turn advances it to that turn's ready.response_message_id
 * so the next request chains off the wire's message ids.
 *
 * In-memory only: a provider restart loses all session state by design
 * (the client then receives a fresh chat_session_id and reuses it).
 * No account pooling, no rotation, no timeout policy (intentionally absent
 * until a live signal proves one is needed).
 */
export interface DeepSeekSessionState {
  sessionId: string;
  parentMessageId: number | null;
}

export class DeepSeekSessionStore {
  private readonly sessions = new Map<string, DeepSeekSessionState>();

  get(conversationId: string): DeepSeekSessionState | undefined {
    return this.sessions.get(conversationId);
  }

  set(conversationId: string, state: DeepSeekSessionState): void {
    this.sessions.set(conversationId, state);
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** Advance the parent chain after a successful turn (pure, testable). */
export function advanceSession(
  state: DeepSeekSessionState,
  ready: DeepSeekReadyMeta | null,
): DeepSeekSessionState {
  return {
    sessionId: state.sessionId,
    parentMessageId: ready ? ready.responseMessageId : state.parentMessageId,
  };
}