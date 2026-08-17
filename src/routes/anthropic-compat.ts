import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { ProviderRegistry } from '../core/registry.js';
import { Router } from '../core/router.js';
import {
  formatAnthropicNonStream,
  formatMessageStart,
  formatContentBlockStart,
  formatContentBlockDelta,
  formatContentBlockStop,
  formatToolUseBlockStart,
  formatToolInputDelta,
  formatMessageDelta,
  formatMessageStop,
  formatPing,
  formatAnthropicError,
  streamEventToStopReason,
} from '../core/anthropic-formatter.js';
import { InvalidBodyError, errorToHttpResponse, errorEventToResponse } from '../core/errors.js';
import { fromAnthropicMessages } from '../core/provider.js';
import type { Message } from '../core/provider.js';
import type { StreamEvent, StreamUsage } from '../core/stream.js';

export function anthropicRoutes(registry: ProviderRegistry, router?: Router): Hono {
  const app = new Hono();
  const rt = router ?? new Router(registry);

  app.post('/v1/messages', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      const res = errorToHttpResponse(new InvalidBodyError('invalid JSON'));
      return c.json(res.body, res.status as any);
    }

    if (!body.model || typeof body.model !== 'string') {
      const res = errorToHttpResponse(new InvalidBodyError('missing model field'));
      return c.json(res.body, res.status as any);
    }

    if (!body.messages || !Array.isArray(body.messages)) {
      const res = errorToHttpResponse(new InvalidBodyError('missing messages field'));
      return c.json(res.body, res.status as any);
    }

    // Convert Anthropic request (system + messages, incl. tool_use/tool_result
    // blocks and images) to the internal Message model without information loss.
    const messages: Message[] = fromAnthropicMessages(body);

    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const isStream = body.stream === true;
    const signal = c.req.raw.signal;
    const conversationId = typeof body.conversation_id === 'string' && body.conversation_id ? body.conversation_id : undefined;

    if (isStream) {
      return anthropicStream(rt, c, msgId, body.model, messages, signal, conversationId);
    }

    // Non-streaming
    let fullContent = '';
    let lastError: (StreamEvent & { type: 'error' }) | null = null;
    let usage: StreamUsage | undefined;
    let responseConversationId: string | undefined;
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    try {
      for await (const event of rt.chat(body.model, {
        messages,
        stream: false,
        signal,
        conversationId,
      })) {
        if (event.type === 'text_delta') {
          fullContent += event.delta;
        } else if (event.type === 'error') {
          lastError = event;
        } else if (event.type === 'done') {
          if (event.usage) usage = event.usage;
          if (event.conversationId) responseConversationId = event.conversationId;
        } else if (event.type === 'tool_call') {
          toolCalls.set(event.index, {
            id: typeof event.id === 'string' ? event.id : '',
            name: typeof event.name === 'string' ? event.name : '',
            args: typeof event.args === 'string' ? event.args : '',
          });
        }
      }
    } catch (err) {
      const res = errorToHttpResponse(err as Error);
      return c.json({
        type: 'error',
        error: { type: res.body.error.type, message: (err as Error).message },
      }, res.status as any);
    }

    if (responseConversationId) {
      c.header('x-wmb-conversation-id', responseConversationId);
    }

    // An error after tool-call events may mean incomplete calls — surface the
    // error instead of emitting potentially truncated tool_use blocks.
    if (toolCalls.size > 0 && lastError) {
      const res = errorEventToResponse(lastError.code, lastError.message);
      return c.json({
        type: 'error',
        error: { type: res.body.error.type, message: res.body.error.message },
      }, res.status as any);
    }

    if (fullContent.length === 0 && lastError) {
      const res = errorEventToResponse(lastError.code, lastError.message);
      return c.json({
        type: 'error',
        error: { type: res.body.error.type, message: res.body.error.message },
      }, res.status as any);
    }
    const orderedToolCalls = toolCalls.size > 0
      ? [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
      : undefined;
    return c.json(formatAnthropicNonStream(msgId, body.model, fullContent, usage, orderedToolCalls));
  });

  return app;
}

/**
 * Streaming handler with first-event buffering (mirrors the OpenAI route):
 * - Pre-output failures return a proper JSON error with the correct status.
 * - Mid-stream failures are surfaced as `event: error` (never injected as
 *   text into the content stream, never retried or replayed).
 * - The stream always closes with content_block_stop / message_delta /
 *   message_stop, matching Anthropic's expected event sequence.
 */
async function anthropicStream(
  router: Router,
  c: Parameters<typeof stream>[0],
  msgId: string,
  model: string,
  messages: Message[],
  signal?: AbortSignal,
  conversationId?: string,
): Promise<Response> {
  const iterator = router.chat(model, { messages, stream: true, signal, conversationId })[Symbol.asyncIterator]();

  let first: IteratorResult<StreamEvent>;
  try {
    first = await iterator.next();
  } catch (err) {
    const res = errorToHttpResponse(err as Error);
    return c.json({
      type: 'error',
      error: { type: 'api_error', message: (err as Error).message },
    }, res.status as any);
  }

  // Empty stream — respond with just the standard message envelope.
  if (first.done) {
    return stream(c, async (s) => {
      await s.write(formatMessageStart(msgId, model));
      await s.write(formatMessageStop());
    });
  }

  // Failure before any output — proper JSON error response.
  if (first.value.type === 'error') {
    const res = errorEventToResponse(first.value.code, first.value.message);
    return c.json({
      type: 'error',
      error: { type: res.body.error.type, message: res.body.error.message },
    }, res.status as any);
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return stream(c, async (s) => {
    await s.write(formatMessageStart(msgId, model));
    await s.write(formatPing());
    await s.write(formatContentBlockStart(0));

    let stopReason = 'end_turn';
    let conversationId: string | undefined;
    // Tool-call → Anthropic block mapping. Block 0 is the text block (its
    // start/stop are written around everything else, preserving the existing
    // text behavior); each distinct tool call gets its own sequential block
    // index as it first appears, so simultaneous calls keep separate indexes.
    const toolBlockIndexes = new Map<number, number>();
    const toolArgsLength = new Map<number, number>();
    const startedToolBlocks: number[] = [];
    let nextToolBlockIndex = 1;

    const writeEvent = async (event: StreamEvent): Promise<void> => {
      if (event.type === 'text_delta' || event.type === 'thinking_delta') {
        await s.write(formatContentBlockDelta(0, event.delta));
      } else if (event.type === 'tool_call') {
        let blockIndex = toolBlockIndexes.get(event.index);
        if (blockIndex === undefined) {
          blockIndex = nextToolBlockIndex++;
          toolBlockIndexes.set(event.index, blockIndex);
          await s.write(formatToolUseBlockStart(
            blockIndex,
            typeof event.id === 'string' ? event.id : '',
            typeof event.name === 'string' ? event.name : '',
          ));
          startedToolBlocks.push(blockIndex);
          toolArgsLength.set(event.index, 0);
        }
        const args = typeof event.args === 'string' ? event.args : '';
        const sent = toolArgsLength.get(event.index) ?? 0;
        // event.args is the accumulated argument string; slice off the part
        // already streamed as input_json_delta.
        const partialJson = args.slice(sent);
        if (partialJson) {
          await s.write(formatToolInputDelta(blockIndex, partialJson));
        }
        toolArgsLength.set(event.index, args.length);
      }
    };

    try {
      // Write the buffered first event
      await writeEvent(first.value);
      if (first.value.type === 'done') {
        stopReason = streamEventToStopReason(first.value) ?? 'end_turn';
        conversationId = first.value.conversationId;
      }

      while (true) {
        if (signal?.aborted) return;
        const { done, value } = await iterator.next();
        if (done) break;

        if (value.type === 'error') {
          // Failure after output began — surface as an Anthropic error event.
          await s.write(formatAnthropicError(
            value.message,
            value.code === 'upstream_rate_limit' ? 'rate_limit_error' : 'api_error',
          ));
          return;
        }

        await writeEvent(value);
        if (value.type === 'done') {
          stopReason = streamEventToStopReason(value) ?? 'end_turn';
          conversationId = value.conversationId;
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      await s.write(formatAnthropicError((err as Error).message));
      return;
    }

    // Close tool-use blocks (in block-index order), then the text block.
    for (const blockIndex of startedToolBlocks.sort((a, b) => a - b)) {
      await s.write(formatContentBlockStop(blockIndex));
    }
    await s.write(formatContentBlockStop(0));
    // SSE comment: ignored by spec-compliant clients, carries the provider
    // conversation id for continuing this conversation.
    if (conversationId) {
      await s.write(`: wmb-conversation-id ${conversationId}\n\n`);
    }
    await s.write(formatMessageDelta(stopReason));
    await s.write(formatMessageStop());
  });
}