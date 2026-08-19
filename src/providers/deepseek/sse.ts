import type { StreamEvent } from '../../core/stream.js';
import { parseToolCalls, stripToolMarkers } from './tools.js';

/**
 * DeepSeek web SSE parser — implements the frozen wire contract
 * (docs/deepseek-web-wire-spec.md §8–§13):
 *
 *   - proper SSE frames (`event: X` + `data: {...}`) AND bare JSON lines
 *   - p/o/v JSON-patch frames with cross-event persistence of path/op
 *     (transcribed from DeepSeek's frontend DeltaParser):
 *       op SET (default) | APPEND | BATCH (recursive, child paths prefixed)
 *   - `ready` → structured message-id metadata (request/response message id)
 *   - `update_session` / `title` / `close` → no-op bookkeeping
 *   - `hint` (rate_limit / input_exceeds_limit) → controlled error
 *   - JSON error envelope {code, msg} → controlled error
 *   - initial snapshot `{"v":{"response":{"fragments":[...]}}}` → fragment
 *     state + initial THINK/RESPONSE deltas
 *   - paths: response/status, response/quasi_status (terminal),
 *     response/fragments (APPEND), response/fragments/-1/content,
 *     response/accumulated_token_usage, plus both legacy captured paths
 *     response/content and response/thinking_content
 *
 * Fragments: type "THINK" → thinking_delta (always streamed), type
 * "RESPONSE" → text (streamed immediately without tools; buffered for
 * tool-call marker parsing at the terminal frame when tools are present).
 */

export interface DeepSeekReadyMeta {
  requestMessageId: number;
  responseMessageId: number;
}

export interface DeepSeekStreamError {
  message: string;
  code: string;
}

export interface DeepSeekStreamResult {
  events: StreamEvent[];
  ready: DeepSeekReadyMeta | null;
  error: DeepSeekStreamError | null;
}

interface Fragment {
  type: string;
  content: string;
}

/** Path comparison: the wire uses both `response/x` and `/response/x`. */
function isOneOf(path: string, ...names: string[]): boolean {
  return names.some((n) => path === n || path === `/${n}`);
}

function isIntegerLike(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function toInteger(v: unknown): number | null {
  if (isIntegerLike(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isSafeInteger(Number(v)) && Number(v) >= 0) {
    return Number(v);
  }
  return null;
}

/**
 * Parse a DeepSeek web completion stream into bridge events plus the
 * ready metadata (request/response message ids).
 */
export function parseDeepSeekStream(sseText: string, hasTools: boolean): DeepSeekStreamResult {
  const events: StreamEvent[] = [];
  let ready: DeepSeekReadyMeta | null = null;
  let error: DeepSeekStreamError | null = null;

  let currentEvent = '';
  let readyPending = false;
  let lastPath = '';
  let lastOp = 'SET';
  let terminated = false;
  let sawFrame = false;
  let usage: number | null = null;

  const fragments: Fragment[] = [];
  let respBuf = '';

  const setError = (message: string, code: string): void => {
    if (!error) error = { message, code };
  };

  const emitText = (delta: string): void => {
    if (hasTools) {
      respBuf += delta;
    } else {
      events.push({ type: 'text_delta', delta });
    }
  };

  const emitFragmentContent = (type: string, content: string): void => {
    if (!content) return;
    if (type === 'THINK') {
      events.push({ type: 'thinking_delta', delta: content });
    } else if (type === 'RESPONSE') {
      emitText(content);
    }
  };

  const pushDone = (reason: 'stop' | 'length' | 'tool_use'): void => {
    events.push(
      usage === null
        ? { type: 'done', reason }
        : {
            type: 'done',
            reason,
            usage: { prompt_tokens: 0, completion_tokens: usage, total_tokens: usage },
          },
    );
  };

  /** Terminal frame: flush the tool buffer (or stream done) exactly once. */
  const terminate = (finish: string): void => {
    if (terminated) return;
    terminated = true;
    const reason: 'stop' | 'length' = finish === 'INCOMPLETE' ? 'length' : 'stop';

    if (hasTools) {
      const parsedCalls = respBuf ? parseToolCalls(respBuf) : null;
      if (parsedCalls) {
        if (parsedCalls.before) events.push({ type: 'text_delta', delta: parsedCalls.before });
        for (const call of parsedCalls.calls) {
          events.push({ type: 'tool_call', index: call.index, id: call.id, name: call.name, args: call.arguments });
        }
        pushDone('tool_use');
      } else {
        const cleaned = respBuf ? stripToolMarkers(respBuf) : '';
        if (cleaned) events.push({ type: 'text_delta', delta: cleaned });
        pushDone(reason);
      }
      respBuf = '';
      return;
    }

    pushDone(reason);
  };

  const updateReady = (parsed: Record<string, unknown>): void => {
    const requestId = toInteger(parsed.request_message_id);
    const responseId = toInteger(parsed.response_message_id);
    // Fallback (1, 2): either id missing or malformed (reference behavior —
    // parse_ready_message_ids returns (1, 2) unless BOTH ids parse).
    ready =
      requestId === null || responseId === null
        ? { requestMessageId: 1, responseMessageId: 2 }
        : { requestMessageId: requestId, responseMessageId: responseId };
  };

  const handleHint = (parsed: Record<string, unknown>): void => {
    // The reference checks the raw event block for the substrings; do the
    // same over content + finish_reason joined (empty content must not
    // shadow finish_reason).
    const text = [parsed.content, parsed.finish_reason]
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
    if (text.includes('rate_limit')) {
      setError('Service is overloaded', 'overloaded');
    } else if (text.includes('input_exceeds_limit')) {
      setError('Input content exceeds the limit; shorten it and retry', 'api');
    }
  };

  const handleErrorEnvelope = (parsed: Record<string, unknown>): void => {
    const code = typeof parsed.code === 'number' ? parsed.code : 0;
    const msg = `${parsed.msg ?? parsed.message ?? 'unknown'}`;
    if (code === 1001 || code === 1201) {
      setError(`Service is overloaded: ${msg}`, 'overloaded');
    } else if (code === 40301) {
      setError(`INVALID_POW_RESPONSE: ${msg}`, 'pow');
    } else {
      setError(`API error code=${code}: ${msg}`, 'api');
    }
  };

  const applyInitialSnapshot = (response: Record<string, unknown>): void => {
    const tokens = response.accumulated_token_usage;
    if (typeof tokens === 'number') usage = tokens;
    const arr = response.fragments;
    if (Array.isArray(arr)) {
      fragments.length = 0;
      for (const frag of arr) {
        if (!frag || typeof frag !== 'object') continue;
        const type = (frag as Record<string, unknown>).type;
        const content = (frag as Record<string, unknown>).content;
        if (typeof type !== 'string') continue;
        const text = typeof content === 'string' ? content : '';
        fragments.push({ type, content: text });
        emitFragmentContent(type, text);
      }
    }
  };

  const applyPath = (path: string, op: string, v: unknown): void => {
    if (isOneOf(path, 'response/status')) {
      if (typeof v === 'string' && (v === 'FINISHED' || v === 'INCOMPLETE' || v === 'DONE')) {
        terminate(v);
      }
      return;
    }
    if (isOneOf(path, 'response/quasi_status')) {
      if (typeof v === 'string' && (v === 'FINISHED' || v === 'INCOMPLETE')) {
        terminate(v);
      }
      return;
    }
    if (isOneOf(path, 'response/accumulated_token_usage', 'accumulated_token_usage')) {
      if (typeof v === 'number') usage = v;
      return;
    }
    if (isOneOf(path, 'response/fragments/-1/content')) {
      if (typeof v === 'string' && v.length > 0) {
        if (fragments.length === 0) {
          // Degraded stream: no fragment state seen (no snapshot/fragments
          // frame). Treat the append as RESPONSE text rather than dropping
          // it — the documented streams always emit a snapshot first.
          emitText(v);
          return;
        }
        const frag = fragments[fragments.length - 1];
        frag.content += v;
        emitFragmentContent(frag.type, v);
      }
      return;
    }
    if (isOneOf(path, 'response/fragments')) {
      if (op === 'APPEND' && Array.isArray(v)) {
        for (const item of v) {
          if (!item || typeof item !== 'object') continue;
          const rec = item as Record<string, unknown>;
          if (typeof rec.type !== 'string') continue;
          const content = typeof rec.content === 'string' ? rec.content : '';
          fragments.push({ type: rec.type, content });
          emitFragmentContent(rec.type, content);
        }
      }
      return;
    }
    if (isOneOf(path, 'response/content')) {
      if (typeof v === 'string' && v.length > 0) emitText(v);
      return;
    }
    if (isOneOf(path, 'response/thinking_content')) {
      if (typeof v === 'string' && v.length > 0) events.push({ type: 'thinking_delta', delta: v });
      return;
    }
  };

  /** BATCH frames decompose recursively; children keep their own p/o state. */
  const applyBatches = (parentPath: string, arr: unknown[]): void => {
    let subPath = '';
    let subOp = 'SET';
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.p === 'string') subPath = rec.p;
      if (typeof rec.o === 'string') subOp = rec.o;
      if (!('v' in rec)) continue;
      const full = parentPath ? (subPath ? `${parentPath}/${subPath}` : parentPath) : subPath;
      if (subOp === 'BATCH' && Array.isArray(rec.v)) {
        applyBatches(full, rec.v);
      } else {
        applyPath(full, subOp, rec.v);
      }
    }
  };

  const handleFrame = (parsed: unknown): void => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const rec = parsed as Record<string, unknown>;

    // Flat message-id frame (the `ready` event data), recognized with or
    // without the SSE event name on the stream.
    if (rec.request_message_id !== undefined || rec.response_message_id !== undefined) {
      currentEvent = 'ready';
      readyPending = false;
      updateReady(rec);
      return;
    }

    // The single data frame under `event: ready` with missing/malformed
    // ids → structured fallback (1, 2). One-shot: later bare frames must
    // not be re-treated as ready payloads.
    if (readyPending) {
      readyPending = false;
      updateReady(rec);
      return;
    }

    // JSON error envelope (non-patch error body): numeric `code` field.
    if (typeof rec.code === 'number' && !('p' in rec) && !('v' in rec)) {
      handleErrorEnvelope(rec);
      return;
    }

    if (currentEvent === 'hint') {
      handleHint(rec);
      return;
    }

    // Initial snapshot: no path seen yet and v carries a full response.
    if (lastPath === '' && rec.v !== undefined && typeof rec.v === 'object' && rec.v !== null) {
      const v = rec.v as Record<string, unknown>;
      if (v.response !== undefined && typeof v.response === 'object' && v.response !== null) {
        applyInitialSnapshot(v.response as Record<string, unknown>);
        return;
      }
    }

    lastPath = typeof rec.p === 'string' ? rec.p : lastPath;
    lastOp = typeof rec.o === 'string' ? rec.o : lastOp;
    const path = lastPath;
    const op = lastOp;
    const v = rec.v;

    if (op === 'BATCH' && Array.isArray(v)) {
      applyBatches(path, v);
      return;
    }
    applyPath(path, op, v);
  };

  for (const line of sseText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('event:')) {
      currentEvent = trimmed.slice(6).trim();
      if (currentEvent === 'ready') readyPending = true;
      continue;
    }
    if (error || terminated) continue;

    let raw: string | null = null;
    if (trimmed.startsWith('data: ')) {
      raw = trimmed.slice(6).trim();
    } else if (trimmed.startsWith('{')) {
      raw = trimmed; // bare JSON line (no SSE prefix)
    }
    if (raw === null || raw === '[DONE]' || raw === '{}') continue;

    sawFrame = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed single line — keep scanning
    }
    handleFrame(parsed);
  }

  if (error) return { events, ready, error };
  if (!sawFrame) {
    return { events, ready, error: { message: 'Empty or unparseable SSE stream', code: 'stream' } };
  }
  if (!ready) {
    return { events, ready, error: { message: 'Stream ended before the ready event', code: 'stream' } };
  }
  // Stream ended without an explicit terminal status — degrade gracefully
  // (matches the reference read-loop EOF behavior; §14 of the wire spec).
  if (!terminated) {
    terminated = true;
    if (hasTools) {
      const parsedCalls = respBuf ? parseToolCalls(respBuf) : null;
      if (parsedCalls) {
        if (parsedCalls.before) events.push({ type: 'text_delta', delta: parsedCalls.before });
        for (const call of parsedCalls.calls) {
          events.push({ type: 'tool_call', index: call.index, id: call.id, name: call.name, args: call.arguments });
        }
        pushDone('tool_use');
      } else {
        const cleaned = respBuf ? stripToolMarkers(respBuf) : '';
        if (cleaned) events.push({ type: 'text_delta', delta: cleaned });
        pushDone('stop');
      }
    } else {
      pushDone('stop');
    }
  }

  return { events, ready, error: null };
}

/**
 * Legacy event-array view of the parser (event list only). Kept for the
 * pre-freeze parser tests: identical output for the p/o/v frame subset.
 */
export function parseDeepSeekSse(sseText: string, hasTools: boolean): StreamEvent[] {
  return parseDeepSeekStream(sseText, hasTools).events;
}