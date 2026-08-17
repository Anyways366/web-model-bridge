import type { StreamEvent, StreamUsage } from './stream.js';
import type { ModelInfo, ToolCall } from './provider.js';

interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
}

/**
 * Streaming state for tool-call chunks, held per request by the route.
 * Tracks, per tool-call index, whether the identifying chunk (id + name) has
 * already been emitted and how many argument characters were already sent —
 * so subsequent events produce only argument deltas and the id/name are
 * never repeated.
 */
export interface ToolCallStreamState {
  perIndex: Map<number, { nameEmitted: boolean; lastArgsLength: number }>;
}

export function createToolCallStreamState(): ToolCallStreamState {
  return { perIndex: new Map() };
}

export function formatStreamChunk(
  runId: string,
  modelId: string,
  event: StreamEvent,
  isFirst: boolean,
  toolState?: ToolCallStreamState,
): ChatCompletionChunk {
  const base: ChatCompletionChunk = {
    id: runId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  };

  if (event.type === 'text_delta') {
    base.choices[0].delta = isFirst
      ? { role: 'assistant', content: event.delta }
      : { content: event.delta };
  } else if (event.type === 'done') {
    const reason = event.reason === 'tool_use' ? 'tool_calls' : event.reason;
    base.choices[0].finish_reason = reason;
    base.choices[0].delta = {};
  } else if (event.type === 'thinking_delta') {
    base.choices[0].delta = isFirst
      ? { role: 'assistant', content: event.delta }
      : { content: event.delta };
  } else if (event.type === 'tool_call') {
    const index = event.index;
    const args = typeof event.args === 'string' ? event.args : '';
    const name = typeof event.name === 'string' ? event.name : '';
    const id = typeof event.id === 'string' ? event.id : '';
    let entry = toolState?.perIndex.get(index);
    if (!entry) {
      entry = { nameEmitted: false, lastArgsLength: 0 };
      toolState?.perIndex.set(index, entry);
    }

    const argsDelta = args.slice(entry.lastArgsLength);
    entry.lastArgsLength = args.length;

    const toolCall = entry.nameEmitted
      ? // Subsequent chunk: only the argument delta, never id/name again.
        { index, function: argsDelta ? { arguments: argsDelta } : {} }
      : { index, id, type: 'function', function: { name, arguments: argsDelta } };
    entry.nameEmitted = true;

    base.choices[0].delta = {
      ...(isFirst ? { role: 'assistant' } : {}),
      tool_calls: [toolCall],
    };
  }

  return base;
}

export function formatUsageChunk(
  runId: string,
  modelId: string,
  usage: StreamUsage,
): {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: [];
  usage: StreamUsage;
} {
  return {
    id: runId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [],
    usage,
  };
}

export function formatDoneChunk(): string {
  return '[DONE]';
}

/**
 * Final metadata chunk carrying the provider conversation id (e.g. Doubao's
 * server-side conversation id), emitted before `[DONE]` when a provider
 * reports one. Standard fields match a chat.completion.chunk so strict
 * parsers accept it; the extra field is ignored by OpenAI SDKs.
 */
export function formatConversationIdChunk(
  runId: string,
  modelId: string,
  conversationId: string,
): {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: [];
  wmb_conversation_id: string;
} {
  return {
    id: runId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [],
    wmb_conversation_id: conversationId,
  };
}

interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string; tool_calls?: ToolCall[] };
    finish_reason: string;
  }>;
  usage: StreamUsage;
}

export function formatNonStreamResponse(
  runId: string,
  modelId: string,
  content: string,
  usage: StreamUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  toolCalls?: ToolCall[],
): ChatCompletion {
  const message: { role: 'assistant'; content: string; tool_calls?: ToolCall[] } =
    { role: 'assistant', content };
  if (toolCalls && toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: runId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
    usage,
  };
}

interface ModelsResponse {
  object: 'list';
  data: Array<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
  }>;
}

export function formatModelsResponse(
  models: (ModelInfo & { id: string })[],
): ModelsResponse {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model' as const,
      created: now,
      owned_by: 'web-model-bridge',
    })),
  };
}