import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { ProviderRegistry } from '../core/registry.js';
import { Router } from '../core/router.js';
import {
  formatStreamChunk,
  formatUsageChunk,
  formatDoneChunk,
  formatConversationIdChunk,
  formatNonStreamResponse,
  formatModelsResponse,
  createToolCallStreamState,
} from '../core/openai-formatter.js';
import { InvalidBodyError, errorToHttpResponse, errorEventToResponse } from '../core/errors.js';
import { fromOpenAIMessages } from '../core/provider.js';
import type { Message, ToolCall, ToolDef } from '../core/provider.js';
import type { StreamEvent, StreamUsage } from '../core/stream.js';

export function openaiRoutes(registry: ProviderRegistry, router?: Router): Hono {
  const app = new Hono();
  const rt = router ?? new Router(registry);

  app.post('/v1/chat/completions', async (c) => {
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

    let tools: ToolDef[] | undefined;
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools)) {
        const res = errorToHttpResponse(new InvalidBodyError('tools must be an array'));
        return c.json(res.body, res.status as any);
      }
      tools = body.tools as ToolDef[];
    }

    const runId = `wmb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const messages: Message[] = fromOpenAIMessages(body.messages);
    const isStream = body.stream === true;
    const signal = c.req.raw.signal;
    const conversationId = typeof body.conversation_id === 'string' && body.conversation_id ? body.conversation_id : undefined;

    if (isStream) {
      return openaiStream(rt, c, {
        model: body.model,
        runId,
        messages,
        tools,
        signal,
        conversationId,
      });
    }

    // Non-streaming
    let fullContent = '';
    let lastError: (StreamEvent & { type: 'error' }) | null = null;
    let usage: StreamUsage | undefined;
    let responseConversationId: string | undefined;
    const toolCallsByIndex = new Map<number, ToolCall>();
    try {
      for await (const event of rt.chat(body.model, {
        messages,
        stream: false,
        tools,
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
          // event.args is the accumulated argument string for the call, so
          // the latest event for an index carries the complete arguments.
          toolCallsByIndex.set(event.index, {
            id: typeof event.id === 'string' ? event.id : '',
            type: 'function',
            function: {
              name: typeof event.name === 'string' ? event.name : '',
              arguments: typeof event.args === 'string' ? event.args : '',
            },
          });
        }
      }
    } catch (err) {
      const res = errorToHttpResponse(err as Error);
      return c.json(res.body, res.status as any);
    }

    if (responseConversationId) {
      c.header('x-wmb-conversation-id', responseConversationId);
    }

    // An error after tool-call events may mean incomplete calls — never hand
    // potentially truncated tool_calls to the caller; surface the error.
    if (toolCallsByIndex.size > 0 && lastError) {
      const res = errorEventToResponse(lastError.code, lastError.message);
      return c.json(res.body, res.status as any);
    }

    if (fullContent.length === 0 && lastError) {
      const res = errorEventToResponse(lastError.code, lastError.message);
      return c.json(res.body, res.status as any);
    }
    const toolCalls = toolCallsByIndex.size > 0
      ? [...toolCallsByIndex.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
      : undefined;
    return c.json(formatNonStreamResponse(runId, body.model, fullContent, usage, toolCalls));
  });

  app.get('/v1/models', async (c) => {
    const models = await registry.allModels();
    return c.json(formatModelsResponse(models));
  });

  return app;
}

interface StreamRequest {
  model: string;
  runId: string;
  messages: Message[];
  tools?: ToolDef[];
  signal?: AbortSignal;
  conversationId?: string;
}

/**
 * Streaming handler with first-event buffering:
 *
 * - The first event is pulled BEFORE response headers are committed so that a
 *   failure before any output can be returned as a proper JSON error response
 *   with the correct HTTP status (instead of a corrupted SSE stream).
 * - Once the first event is committed, errors are surfaced as OpenAI-spec
 *   `data: {"error": {...}}` chunks followed by `data: [DONE]`. Nothing is
 *   retried or replayed after output has begun (the Router guarantees this).
 * - If the provider stream ends without a terminal event, a synthesized
 *   `done` chunk is emitted so the SSE always terminates consistently.
 * - Usage is preserved in a final chunk when the provider reports it.
 */
async function openaiStream(
  router: Router,
  c: Parameters<typeof stream>[0],
  req: StreamRequest,
): Promise<Response> {
  const iterator = router.chat(req.model, {
    messages: req.messages,
    stream: true,
    tools: req.tools,
    signal: req.signal,
    conversationId: req.conversationId,
  })[Symbol.asyncIterator]();

  let first: IteratorResult<StreamEvent>;
  try {
    first = await iterator.next();
  } catch (err) {
    const res = errorToHttpResponse(err as Error);
    return c.json(res.body, res.status as any);
  }

  // Provider produced no events at all — respond with an empty SSE stream.
  if (first.done) {
    return stream(c, async (s) => {
      await s.write(`data: ${formatDoneChunk()}\n\n`);
    });
  }

  // Failure before any output — proper JSON error response.
  if (first.value.type === 'error') {
    const res = errorEventToResponse(first.value.code, first.value.message);
    return c.json(res.body, res.status as any);
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return stream(c, async (s) => {
    let lastEventType: StreamEvent['type'] | null = null;
    const toolState = createToolCallStreamState();
    try {
      await s.write(`data: ${JSON.stringify(formatStreamChunk(req.runId, req.model, first.value, true, toolState))}\n\n`);
      lastEventType = first.value.type;
      if (first.value.type === 'done' && first.value.usage) {
        await s.write(`data: ${JSON.stringify(formatUsageChunk(req.runId, req.model, first.value.usage))}\n\n`);
      }
      if (first.value.type === 'done' && first.value.conversationId) {
        await s.write(`data: ${JSON.stringify(formatConversationIdChunk(req.runId, req.model, first.value.conversationId))}\n\n`);
      }

      while (true) {
        if (req.signal?.aborted) return;
        const { done, value } = await iterator.next();
        if (done) break;

        if (value.type === 'error') {
          // Failure after output began — surface cleanly, never retry.
          const errRes = errorEventToResponse(value.code, value.message);
          await s.write(`data: ${JSON.stringify({ error: errRes.body.error })}\n\n`);
          await s.write(`data: ${formatDoneChunk()}\n\n`);
          return;
        }

        await s.write(`data: ${JSON.stringify(formatStreamChunk(req.runId, req.model, value, false, toolState))}\n\n`);
        lastEventType = value.type;
        if (value.type === 'done' && value.usage) {
          await s.write(`data: ${JSON.stringify(formatUsageChunk(req.runId, req.model, value.usage))}\n\n`);
        }
        if (value.type === 'done' && value.conversationId) {
          await s.write(`data: ${JSON.stringify(formatConversationIdChunk(req.runId, req.model, value.conversationId))}\n\n`);
        }
      }

      // Synthesize a terminal so the stream always ends consistently.
      if (lastEventType !== 'done' && lastEventType !== 'error') {
        await s.write(`data: ${JSON.stringify(formatStreamChunk(req.runId, req.model, { type: 'done', reason: 'stop' }, false))}\n\n`);
      }
      await s.write(`data: ${formatDoneChunk()}\n\n`);
    } catch (err) {
      if (req.signal?.aborted) return;
      const errRes = errorToHttpResponse(err as Error);
      await s.write(`data: ${JSON.stringify({ error: errRes.body.error })}\n\n`);
      await s.write(`data: ${formatDoneChunk()}\n\n`);
    }
  });
}