import type { StreamEvent } from './stream.js';

export interface ProviderInfo {
  id: string;
  name: string;
  website: string;
  loginUrl: string;
  needsBrowser: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
}

/**
 * Multimodal content blocks. The internal model preserves every block that
 * arrives at the API boundary instead of flattening to text — providers that
 * cannot handle multimodal content apply their own policy (see
 * `buildWebPrompt` / `extractText`).
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON string of the arguments, exactly as received/emitted. */
    arguments: string;
  };
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  stream: boolean;
  tools?: ToolDef[];
  signal?: AbortSignal;
  /**
   * Provider conversation/session identifier. Only meaningful for providers
   * whose upstream APIs explicitly support continuing an existing session
   * (e.g. DeepSeek chat_session_id, Qwen chat_id). Must not be mutated by
   * retries or fallbacks.
   */
  conversationId?: string;
}

export abstract class BaseProvider {
  abstract readonly info: ProviderInfo;

  abstract login(context: { openUrl: (url: string) => Promise<void> }): Promise<void>;
  abstract isAuthenticated(): Promise<boolean>;
  abstract detectLoginComplete(): Promise<boolean>;
  abstract models(): Promise<ModelInfo[]>;
  abstract chat(req: ChatRequest): AsyncIterable<StreamEvent>;
}

/**
 * Extract plain text from message content, handling both string and
 * OpenAI content-block array formats.
 */
export function extractText(content: string | unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
  }
  return String(content ?? '');
}

/**
 * Extract the actual user prompt from OpenClaw-wrapped messages.
 *
 * OpenClaw sends messages like:
 *   system: "You are 聪聪, an AI assistant... [long agent framework boilerplate]"
 *   user: "A new session was started via /new...\n[Mon 2026-04-06 21:46 GMT+8] 你好"
 *
 * For web models we only need the real user question. Strategy:
 * 1. Drop system/tool messages (framework boilerplate, not useful for web models)
 * 2. From user messages, strip OpenClaw metadata prefixes
 * 3. Keep assistant messages for multi-turn context
 * 4. Return a clean prompt string
 */
export function buildWebPrompt(messages: Message[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'tool') continue;

    const text = extractText(msg.content);
    if (!text) continue;

    if (msg.role === 'assistant') {
      parts.push(text);
      continue;
    }

    // user message — strip OpenClaw metadata
    const cleaned = stripOpenClawMeta(text);
    if (cleaned) {
      parts.push(cleaned);
    }
  }

  // Return only the last user exchange (last user message + any preceding assistant)
  // to avoid sending the entire conversation history to web models
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * Strip OpenClaw framework metadata from a user message, leaving only the
 * actual human-written text.
 *
 * Handles formats like:
 *   "[Mon 2026-04-06 21:46 GMT+8] 你好"
 *   "A new session was started...\n[Mon 2026-04-06 21:46 GMT+8] 你好"
 *   "Sender (untrusted metadata):...\n[Mon 2026-04-06 21:46 GMT+8] 你好"
 */
function stripOpenClawMeta(text: string): string {
  // Pattern: [Day YYYY-MM-DD HH:MM timezone] actual message
  // The timestamp line marks where the real user input begins.
  const timestampPattern = /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\S+\]\s*/;
  const match = text.match(timestampPattern);
  if (match) {
    const afterTimestamp = text.slice(match.index! + match[0].length).trim();
    return afterTimestamp || text;
  }

  // Fallback pattern: lines starting with OpenClaw boilerplate keywords
  const boilerplatePatterns = [
    /^A new session was started via\b/m,
    /^Run your Session Startup sequence\b/m,
    /^Current time:/m,
    /^Sender \(untrusted metadata\):/m,
  ];
  const hasBoilerplate = boilerplatePatterns.some(p => p.test(text));
  if (hasBoilerplate) {
    // Try to find the last non-empty line as the actual message
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    // Walk backwards to find a line that's not JSON or metadata
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.startsWith('{') || line.startsWith('}') || line.startsWith('"') || line.startsWith('```')) continue;
      if (boilerplatePatterns.some(p => p.test(line))) continue;
      if (/^Current time:/i.test(line)) continue;
      return line;
    }
  }

  // No OpenClaw metadata detected — return as-is
  return text;
}

/**
 * Structured conversation message for providers that send full message
 * history (chatgpt.com web payload shape) instead of a flattened prompt.
 */
export interface WebConversationMessage {
  author: { role: 'user' | 'assistant' };
  content:
    | { content_type: 'text'; parts: string[] }
    | { content_type: 'code'; text: string; tool_calls: ToolCall[] }
    | { content_type: 'tool_result'; tool_call_id: string; name?: string; text: string };
}

/**
 * Build a structured message list (chatgpt.com web shape) that preserves
 * assistant tool_calls, tool-role results with their tool_call_id, and
 * message order — for providers that need the full tool loop history.
 *
 * Mapping:
 *   user (plain)            → text parts
 *   user with tool_call_id  → tool_result (name resolved from the matching
 *                             assistant tool_calls in the same history)
 *   assistant with text     → text parts
 *   assistant with tool_calls → code block carrying the tool_calls verbatim
 *   tool                    → tool_result with tool_call_id
 *   system                  → dropped (same policy as buildWebPrompt)
 *
 * Non-text content blocks are flattened via extractText; images are not
 * (yet) forwarded to chatgpt.com — live verification is deferred.
 */
export function buildWebMessages(
  messages: Message[],
  tools?: ToolDef[],
): { messages: WebConversationMessage[]; tools?: ToolDef[] } {
  // Resolve tool names for tool results from the assistant tool_calls in
  // the same conversation (the internal tool message only carries the id).
  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    for (const call of msg.tool_calls ?? []) {
      toolNameById.set(call.id, call.function.name);
    }
  }

  const out: WebConversationMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const text = extractText(msg.content);

    if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        out.push({
          author: { role: 'assistant' },
          content: { content_type: 'code', text: '', tool_calls: msg.tool_calls },
        });
      } else if (text) {
        out.push({ author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] } });
      }
      continue;
    }

    if (msg.tool_call_id) {
      const name = toolNameById.get(msg.tool_call_id);
      const content: WebConversationMessage['content'] = {
        content_type: 'tool_result',
        tool_call_id: msg.tool_call_id,
        ...(name ? { name } : {}),
        text,
      };
      out.push({ author: { role: 'user' }, content });
      continue;
    }

    if (msg.role === 'user' && text) {
      out.push({ author: { role: 'user' }, content: { content_type: 'text', parts: [text] } });
    }
    // role 'tool' without tool_call_id is degenerate — cannot be attached upstream.
  }

  return { messages: out, tools: tools && tools.length > 0 ? tools : undefined };
}

export type { StreamEvent } from './stream.js';

/**
 * Convert OpenAI-compatible request messages into the internal Message
 * model without destroying information: content-block arrays (text,
 * image_url, input_audio) are preserved verbatim, assistant tool_calls and
 * tool tool_call_id/tool_call_id links are carried through, and message
 * order is untouched.
 */
export function fromOpenAIMessages(raw: unknown[]): Message[] {
  if (!Array.isArray(raw)) return [];
  const messages: Message[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const role = m.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
    const msg: Message = { role, content: '' };
    const content = m.content;
    if (typeof content === 'string') {
      msg.content = content;
    } else if (Array.isArray(content)) {
      msg.content = content as ContentBlock[];
    }
    if (typeof m.tool_call_id === 'string') {
      msg.tool_call_id = m.tool_call_id;
    }
    if (Array.isArray(m.tool_calls)) {
      msg.tool_calls = m.tool_calls as ToolCall[];
    }
    messages.push(msg);
  }
  return messages;
}

/**
 * Convert an Anthropic Messages API request into the internal Message
 * model. `system` becomes a system message; content blocks map as follows:
 *   text      → text block
 *   image     → image_url block (base64 sources become data: URIs)
 *   tool_use  → assistant message tool_calls (input object is JSON-encoded)
 *   tool_result → tool message with tool_call_id
 *   thinking  → text block (content is preserved, block kind is not)
 */
export function fromAnthropicMessages(body: unknown): Message[] {
  if (!body || typeof body !== 'object') return [];
  const req = body as Record<string, unknown>;
  const messages: Message[] = [];

  const system = req.system;
  if (typeof system === 'string' && system) {
    messages.push({ role: 'system', content: system });
  } else if (Array.isArray(system)) {
    const texts = system
      .filter((b: any): b is { type: 'text'; text: string } => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text);
    if (texts.length > 0) messages.push({ role: 'system', content: texts.join('') });
  }

  if (!Array.isArray(req.messages)) return messages;
  for (const item of req.messages) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const role = m.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const rawContent = m.content;
    if (typeof rawContent === 'string') {
      messages.push({ role, content: rawContent });
      continue;
    }
    if (!Array.isArray(rawContent)) continue;

    const blocks: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of rawContent) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      switch (b.type) {
        case 'text':
          blocks.push({ type: 'text', text: typeof b.text === 'string' ? b.text : '' });
          break;
        case 'image': {
          const source = (b.source ?? {}) as Record<string, unknown>;
          if (source.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
            blocks.push({ type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } });
          } else if (typeof source.url === 'string') {
            blocks.push({ type: 'image_url', image_url: { url: source.url } });
          }
          break;
        }
        case 'thinking':
          blocks.push({ type: 'text', text: typeof b.thinking === 'string' ? b.thinking : '' });
          break;
        case 'tool_use':
          if (typeof b.id === 'string' && typeof b.name === 'string') {
            toolCalls.push({
              id: b.id,
              type: 'function',
              function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
            });
          }
          break;
        case 'tool_result': {
          const toolId = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
          const resultContent = b.content;
          let text = '';
          if (typeof resultContent === 'string') {
            text = resultContent;
          } else if (Array.isArray(resultContent)) {
            text = (resultContent as any[])
              .filter((p: any) => p && p.type === 'text' && typeof p.text === 'string')
              .map((p: any) => p.text)
              .join('');
            if (!text) text = JSON.stringify(resultContent);
          }
          messages.push({ role: 'tool', content: text, tool_call_id: toolId });
          break;
        }
        default:
          break;
      }
    }

    const msg: Message = { role, content: blocks };
    if (blocks.length === 1 && blocks[0].type === 'text') {
      msg.content = (blocks[0] as { type: 'text'; text: string }).text;
    }
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    if (blocks.length === 0 && toolCalls.length === 0) continue;
    messages.push(msg);
  }
  return messages;
}
