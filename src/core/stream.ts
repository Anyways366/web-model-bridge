/**
 * Internal stream event model shared by all providers and routes.
 *
 * Terminal semantics: a well-behaved provider stream MUST end with exactly one
 * terminal event — either `done` (success) or `error` (failure). Routes treat
 * a stream that ends without a terminal event as a clean stop and synthesize
 * a terminal so downstream SSE always terminates consistently.
 *
 * Retry semantics: an `error` event that arrives BEFORE any other event means
 * the request failed before producing output and may be retried. An `error`
 * (or thrown exception) that arrives AFTER other events means output has
 * already been committed downstream — it must be surfaced, never retried.
 */

export interface StreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type StreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | {
      type: 'tool_call';
      /** Per-call identifier, starting at 0. Each distinct call in a turn
       *  MUST use a unique index — the streaming formatter uses it to avoid
       *  collapsing simultaneous calls into one. */
      index: number;
      id: string;
      name: string;
      /**
       * The call's function arguments ACCUMULATED so far (absolute string,
       * growing across events, not per-event deltas). A provider that only
       * has the complete arguments after the fact emits a single event with
       * the full string. Formatters slice off the already-emitted prefix.
       */
      args: string;
    }
  | { type: 'done'; reason: 'stop' | 'tool_use' | 'length'; usage?: StreamUsage; conversationId?: string }
  | { type: 'error'; message: string; code?: string };