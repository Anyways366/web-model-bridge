import type { StreamEvent } from './stream.js';

interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<{ type: 'text'; text: string }>;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export function formatAnthropicNonStream(
  msgId: string,
  model: string,
  content: string,
): AnthropicMessage {
  return {
    id: msgId,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: content }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// Streaming SSE events for Anthropic format

export function formatMessageStart(msgId: string, model: string): string {
  const data = {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
  return `event: message_start\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatContentBlockStart(index: number): string {
  const data = {
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text: '' },
  };
  return `event: content_block_start\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatContentBlockDelta(index: number, text: string): string {
  const data = {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  };
  return `event: content_block_delta\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatContentBlockStop(index: number): string {
  const data = { type: 'content_block_stop', index };
  return `event: content_block_stop\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatMessageDelta(stopReason: string): string {
  const data = {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 0 },
  };
  return `event: message_delta\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatMessageStop(): string {
  return `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
}

export function formatPing(): string {
  return `event: ping\ndata: {"type":"ping"}\n\n`;
}

export function streamEventToStopReason(event: StreamEvent): string | null {
  if (event.type !== 'done') return null;
  if (event.reason === 'stop') return 'end_turn';
  if (event.reason === 'length') return 'max_tokens';
  if (event.reason === 'tool_use') return 'tool_use';
  return 'end_turn';
}
