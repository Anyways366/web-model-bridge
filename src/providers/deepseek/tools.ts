import { extractText, type Message, type ToolDef } from '../../core/provider.js';

/**
 * DeepSeek web tool-calling protocol (as reverse-engineered by the
 * ds-free-api project): DeepSeek's web backend has no native function
 * calling, so tool definitions are injected into the prompt as natural
 * language and the model is asked to emit a JSON array wrapped in literal
 * marker tags, which are then parsed out of the content stream.
 *
 * Byte-parity reference: ds-free-api (prompt.rs, tools.rs, tool_parser.rs).
 *   tool-call markers:  ASCII `|` + U+2581 (`▁`)        → <|tool\u2581calls\u2581begin|>
 *   role / output / EOS: FULL-WIDTH `｜` (U+FF5C) + `▁` → ｜tool\u2581outputs\u2581begin｜>
export  */

export const TOOL_CALL_START = '<|tool\u2581calls\u2581begin|>';
export const TOOL_CALL_END = '<|tool\u2581calls\u2581end|>';
export const TOOL_OUTPUTS_BEGIN = '<\uFF5Ctool\u2581outputs\u2581begin\uFF5C>';
export const TOOL_OUTPUT_BEGIN = '<\uFF5Ctool\u2581output\u2581begin\uFF5C>';
export const TOOL_OUTPUT_END = '<\uFF5Ctool\u2581output\u2581end\uFF5C>';
export const TOOL_OUTPUTS_END = '<\uFF5Ctool\u2581outputs\u2581end\uFF5C>';
export const END_OF_SENTENCE = '<\uFF5Cend\u2581of\u2581sentence\uFF5C>';
export const SYSTEM_TAG = '<\uFF5CSystem\uFF5C>';
export const ASSISTANT_TAG = '<\uFF5CAssistant\uFF5C>';

const roleTag = (role: string): string => `<\uFF5C${role[0].toUpperCase()}${role.slice(1)}\uFF5C>`;

const code = (s: string) => '`' + s + '`';

/**
 * Build a DeepSeek-native role-tag prompt from internal messages.
 *
 * System messages are dropped (project policy: OpenClaw/agent boilerplate is
 * not useful upstream); tool definitions and format rules are injected into
 * a `<｜System｜>` block and an unclosed `<think>` reminder right before the
 * generation position, so the tool rules are always adjacent to the model's
 * output. Full message history is preserved (multi-turn and tool loops are
 * replayed in the prompt — DeepSeek web has no server-side session history).
 */
export function buildDeepSeekPrompt(messages: Message[], tools?: ToolDef[]): string {
  const merged: Message[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role && msg.role !== 'tool') {
      const a = extractText(last.content);
      const b = extractText(msg.content);
      if (a && b) {
        last.content = a + '\n' + b;
      } else if (b) {
        last.content = b;
      }
      if (last.tool_calls && msg.tool_calls) {
        last.tool_calls = [...last.tool_calls, ...msg.tool_calls];
      } else if (msg.tool_calls) {
        last.tool_calls = msg.tool_calls;
      }
    } else {
      merged.push({ ...msg });
    }
  }

  const parts: string[] = [];
  let i = 0;
  while (i < merged.length) {
    if (merged[i].role === 'tool') {
      const contents: string[] = [];
      while (i < merged.length && merged[i].role === 'tool') {
        contents.push(extractText(merged[i].content));
        i++;
      }
      const inner = contents.map((c) => `${TOOL_OUTPUT_BEGIN}${c}${TOOL_OUTPUT_END}`).join('');
      parts.push(`${TOOL_OUTPUTS_BEGIN}${inner}${TOOL_OUTPUTS_END}`);
    } else {
      parts.push(formatMessage(merged[i]));
      i++;
    }
  }

  const hasTools = !!tools && tools.length > 0;
  if (hasTools) {
    const formatBlock = buildToolInstructionBlock(tools!);
    const defsText = buildToolDefsText(tools!);
    const reminderBody = `## 工具调用\n### 格式规范\n${formatBlock}\n\n### 工具定义\n${defsText}`;
    const sysContent = `\n\n${reminderBody}`;
    const sysIdx = parts.findIndex((p) => p.startsWith(SYSTEM_TAG));
    if (sysIdx >= 0) {
      const sys = parts[sysIdx];
      const end = sys.lastIndexOf('\n');
      parts[sysIdx] = end >= 0 ? sys.slice(0, end) + sysContent + sys.slice(end) : sys + sysContent;
    } else {
      parts.unshift(`${SYSTEM_TAG}${sysContent}\n`);
    }

    const thinkReminder = `嗯，我刚刚被系统提醒需要遵循以下内容:\n\n## 工具调用\n### 格式规范\n${formatBlock}`;
    parts.push(`${ASSISTANT_TAG}<thinking>\n${thinkReminder}\n`);
  }

  if (!parts.some((p) => p.startsWith(ASSISTANT_TAG))) {
    parts.push(`${END_OF_SENTENCE}\n`);
  }
  return parts.join('');
}

function formatMessage(msg: Message): string {
  const body = formatBody(msg);
  const tag = roleTag(msg.role);
  const prefix = msg.role === 'user' ? END_OF_SENTENCE : '';
  return `${prefix}${tag}${body}`;
}

function formatBody(msg: Message): string {
  if (msg.role === 'assistant') {
    const parts: string[] = [];
    const text = extractText(msg.content);
    if (text) parts.push(text);
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const items = msg.tool_calls.map((tc) => {
        let args: unknown = null;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = null;
        }
        return `{"name": ${JSON.stringify(tc.function.name)}, "arguments": ${JSON.stringify(args)}}`;
      });
      parts.push(`${TOOL_CALL_START}\n[${items.join(', ')}]\n${TOOL_CALL_END}`);
    }
    return parts.join('\n');
  }
  return extractText(msg.content);
}

function buildToolDefsText(tools: ToolDef[]): string {
  const lines = ['你可以使用以下工具：'];
  for (const tool of tools) {
    const f = tool.function;
    const params = JSON.stringify(f.parameters ?? {});
    const callExample = `${TOOL_CALL_START}[{"name": "${f.name}", "arguments": ${params}}]${TOOL_CALL_END}`;
    const desc = (f.description ?? '').trim();
    const descBlock = desc ? `~~~markdown\n  ${desc}\n~~~\n` : '  无描述';
    lines.push(`- **${f.name}** (function):\n  - 调用方法: ${code(callExample)}\n  - 简要说明:\n${descBlock}`);
  }
  return lines.join('\n');
}

function buildToolInstructionBlock(tools: ToolDef[]): string {
  const names = tools.map((t) => t.function.name);
  const lines: string[] = [];
  lines.push('**工具调用格式 — 请严格遵守：**');
  lines.push('');
  lines.push('将 JSON 数组包裹在工具调用标记中：');
  lines.push('');
  lines.push(`${TOOL_CALL_START}[{"name": "工具名", "arguments": {参数JSON}}]${TOOL_CALL_END}`);
  lines.push('');
  lines.push('**规则：**');
  lines.push('');
  lines.push('**核心：决定调用工具时，你的响应中只允许出现工具调用文本本身，禁止任何解释、前缀、总结、问候语等额外内容。**');
  lines.push('');
  lines.push(`1. JSON 数组必须以 ${code(TOOL_CALL_START)} 开头、以 ${code(TOOL_CALL_END)} 结尾，将数组**完整包裹**在标记内。`);
  lines.push('2. 所有工具调用必须放在**一个** JSON 数组中，多个调用用逗号分隔。');
  lines.push(`3. 输出 ${code(TOOL_CALL_END)} 后**立即停止**，不得添加后续文本、XML 标签或说明文字。`);
  lines.push('4. 不要将工具调用包裹在 markdown 代码块中。');
  lines.push('5. 字符串参数值必须用**双引号**包裹（JSON 标准）。');
  lines.push(`6. 决定调用工具时，输出的**第一个非空白字符**必须是 ${code(TOOL_CALL_START)}。`);
  lines.push(`7. 整个响应中**只能出现一个 ${code(TOOL_CALL_START)} 块**，不要重复输出多个 ${code(TOOL_CALL_START)} 块。`);
  lines.push(`8. **重复：** 整个响应中只能出现一个 ${code(TOOL_CALL_START)} 块，不要重复输出。如果你已经输出了一个 ${code(TOOL_CALL_START)} 块，绝对不要再输出第二个。`);
  lines.push(`9. **重复：** 禁止在 ${code(TOOL_CALL_START)} 之前输出任何文字，包括但不限于解释、确认、总结、问候语。`);
  lines.push('10. 不要把回复和工具调用置于思考内容中。');
  lines.push(`11. **重复：** 思考内容（ thinking 标签内）仅用于内部推理过程，不要将最终回复或工具调用放在  thinking 标签中。`);
  lines.push('');

  const a = names[0] || 'tool_a';
  lines.push('**正确示例：**');
  lines.push('');
  lines.push('**示例A** — 调用一个工具：');
  lines.push(`${TOOL_CALL_START}[{"name": "${a}", "arguments": ${exampleArgs(a)}}]${TOOL_CALL_END}`);
  lines.push('');
  if (names.length >= 2) {
    const items = names.slice(0, 2).map((n) => `{"name": "${n}", "arguments": ${exampleArgs(n)}}`);
    lines.push('**示例B** — 同时调用多个工具（一个数组包含全部调用）：');
    lines.push('');
    lines.push(`${TOOL_CALL_START}[${items.join(', ')}]${TOOL_CALL_END}`);
    lines.push('');
  }
  if (names.length >= 3) {
    const items = names.slice(0, 3).map((n) => `{"name": "${n}", "arguments": ${exampleArgs(n)}}`);
    lines.push('**示例C** — 同时调用三个工具（所有调用在一个数组中）：');
    lines.push('');
    lines.push(`${TOOL_CALL_START}[${items.join(', ')}]${TOOL_CALL_END}`);
    lines.push('');
  }
  const dName = names[0];
  lines.push('**示例D** — 参数值为嵌套对象/数组（仍然是标准 JSON）：');
  lines.push('');
  lines.push(`${TOOL_CALL_START}[{"name": "${dName}", "arguments": ${exampleNestedArgs(dName)}}]${TOOL_CALL_END}`);
  lines.push('');
  return lines.join('\n');
}

function exampleNestedArgs(name: string): string {
  if (name === 'Edit') {
    return '{"file_path": "/path/to/file", "edits": [{"old_string": "foo", "new_string": "bar"}, {"old_string": "x", "new_string": "y"}]}';
  }
  return '{"config": {"enabled": true, "items": ["a", "b"]}}';
}

function exampleArgs(name: string): string {
  const args: Record<string, string> = {
    Read: '"file_path": "/path/to/file"',
    read_file: '"file_path": "/path/to/file"',
    Bash: '"command": "ls -la"',
    Glob: '"pattern": "**/*.rs", "path": "."',
    search_files: '"query": "TODO", "path": "."',
    list_files: '"path": "."',
    execute_command: '"command": "ls -la"',
    exec_command: '"command": "ls -la"',
    Write: '"file_path": "/path/to/file", "content": "hello"',
    write_to_file: '"file_path": "/path/to/file", "content": "hello"',
    Edit: '"file_path": "/path/to/file", "old_string": "foo", "new_string": "bar"',
    get_weather: '"city": "Beijing"',
    get_time: '"timezone": "Asia/Shanghai"',
  };
  return `{${args[name] ?? '"key": "value"'}}`;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
  index: number;
}

let callIdCounter = 0;

function nextCallId(): string {
  return `call_${(++callIdCounter).toString(16).padStart(16, '0')}`;
}

const normChar = (c: string) => (c === '\uFF5C' ? '|' : c === '\u2581' ? '_' : c);

function fuzzyMatchTag(haystack: string, partial: string): { pos: number; tag: string } | null {
  const h = Array.from(haystack);
  const p = Array.from(partial);
  if (p.length === 0 || h.length < p.length) return null;
  for (let start = 0; start <= h.length - p.length; start++) {
    let ok = true;
    for (let j = 0; j < p.length; j++) {
      if (normChar(p[j]) !== normChar(h[start + j])) {
        ok = false;
        break;
      }
    }
    if (ok) return { pos: start, tag: h.slice(start, start + p.length).join('') };
  }
  return null;
}

function findStartTag(s: string): { pos: number; tag: string } | null {
  const partial = TOOL_CALL_START.replace(/>$/, '');
  const exact = s.indexOf(partial);
  if (exact >= 0) return { pos: exact, tag: partial };
  return fuzzyMatchTag(s, partial);
}

function findEndTag(s: string, from: number, startTag: string): { pos: number; tag: string } | null {
  const search = s.slice(from);
  const openTag = startTag.replace(/>$/, '');
  const closeTag = `</${openTag.slice(1)}>`;
  let pos = search.indexOf(closeTag);
  if (pos >= 0) return { pos: from + pos, tag: closeTag };
  let fuzzy = fuzzyMatchTag(search, closeTag.replace(/>$/, ''));
  if (fuzzy) return { pos: from + fuzzy.pos, tag: fuzzy.tag };
  pos = search.indexOf(TOOL_CALL_END);
  if (pos >= 0) return { pos: from + pos, tag: TOOL_CALL_END };
  fuzzy = fuzzyMatchTag(search, TOOL_CALL_END.replace(/>$/, ''));
  if (fuzzy) return { pos: from + fuzzy.pos, tag: fuzzy.tag };
  return null;
}

function isInsideCodeFence(xml: string, tagPos: number): boolean {
  const count = (xml.slice(0, tagPos).match(/```/g) ?? []).length;
  return count % 2 === 1;
}

function repairInvalidBackslashes(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const next = s[i + 1];
      if (next === undefined) {
        out += '\\';
        i++;
      } else if ('"\\/bfnrtu'.includes(next)) {
        out += '\\' + next;
        i += 2;
      } else {
        out += '\\\\' + next;
        i += 2;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function repairUnquotedKeys(s: string): string {
  const chars = Array.from(s);
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if ((c === '{' || c === ',') && i + 1 < chars.length) {
      out.push(c);
      i++;
      while (i < chars.length && /\s/.test(chars[i])) {
        out.push(chars[i]);
        i++;
      }
      if (i < chars.length && /[\p{L}_]/u.test(chars[i])) {
        const keyStart = i;
        while (i < chars.length && /[\p{L}\p{N}_]/u.test(chars[i])) i++;
        if (i < chars.length && chars[i] === ':') {
          out.push('"', ...chars.slice(keyStart, i), '"');
        } else {
          out.push(...chars.slice(keyStart, i));
          continue;
        }
      }
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join('');
}

function repairJson(s: string): string | null {
  const step1 = repairInvalidBackslashes(s);
  try {
    JSON.parse(step1);
    return step1;
  } catch {
    // fall through
  }
  const step2 = repairUnquotedKeys(step1);
  try {
    JSON.parse(step2);
    return step2;
  } catch {
    return null;
  }
}

/**
 * Extract tool calls from a model response.
 *
 * Accepts a full content string and returns the text emitted before the
 * marker and the parsed calls. Text AFTER the end marker is dropped
 * (anti-hallucination: the model is instructed to stop immediately after
 * the end tag). Returns null when the response contains no usable tool
 * call — caller then treats the content as plain text.
 */
export function parseToolCalls(content: string): { before: string; calls: ParsedToolCall[] } | null {
  const start = findStartTag(content);
  if (!start) return null;
  if (isInsideCodeFence(content, start.pos)) return null;

  const afterStart = start.pos + start.tag.length;
  const end = findEndTag(content, afterStart, start.tag);
  const inner = end ? content.slice(afterStart, end.pos) : content.slice(afterStart);

  let arr: unknown[] | null = null;
  const arrStart = inner.indexOf('[');
  if (arrStart >= 0) {
    const arrEnd = inner.lastIndexOf(']') + 1;
    const jsonStr = arrEnd > 0 ? inner.slice(arrStart, arrEnd) : inner.slice(arrStart);
    if (jsonStr.trim() === '[]') return null;
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      // fall through to repair
    }
    if (!arr) {
      const repaired = repairJson(jsonStr);
      if (repaired) {
        const trimmed = repaired.trimStart();
        const objStr = trimmed.startsWith('[') ? trimmed.slice(1) : trimmed;
        const objStart = objStr.indexOf('{');
        const objEnd = objStr.lastIndexOf('}') + 1;
        if (objStart >= 0 && objEnd > objStart) {
          try {
            const v = JSON.parse(objStr.slice(objStart, objEnd));
            if (v && typeof v === 'object' && !Array.isArray(v)) arr = [v];
          } catch {
            return null;
          }
        } else {
          return null;
        }
      } else {
        return null;
      }
    }
  } else {
    const objStart = inner.indexOf('{');
    if (objStart < 0) return null;
    const objEnd = inner.lastIndexOf('}') + 1;
    const jsonStr = inner.slice(objStart, objEnd > objStart ? objEnd : undefined);
    let v: unknown = null;
    try {
      v = JSON.parse(jsonStr);
    } catch {
      // fall through to repair
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      const repaired = repairJson(jsonStr);
      if (!repaired) return null;
      try {
        v = JSON.parse(repaired);
      } catch {
        return null;
      }
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    arr = [v];
  }

  const calls: ParsedToolCall[] = [];
  for (const item of arr ?? []) {
    if (!item || typeof item !== 'object') return null;
    const obj = item as Record<string, unknown>;
    if (typeof obj.name !== 'string' || !obj.name) return null;
    let argumentsStr = '{}';
    const a = obj.arguments;
    if (typeof a === 'string') {
      try {
        argumentsStr = JSON.stringify(JSON.parse(a));
      } catch {
        argumentsStr = a;
      }
    } else if (a !== undefined) {
      argumentsStr = JSON.stringify(a);
    }
    calls.push({ id: nextCallId(), name: obj.name, arguments: argumentsStr, index: calls.length });
  }
  if (calls.length === 0) return null;
  return { before: content.slice(0, start.pos), calls };
}

/**
 * Strip marker tags from text that failed to parse (degradation path: the
 * client sees the raw response, not protocol tags).
 */
export function stripToolMarkers(content: string): string {
  let out = content;
  const start = findStartTag(out);
  if (start) out = out.slice(0, start.pos) + out.slice(start.pos + start.tag.length);
  const end = findEndTag(out, 0, TOOL_CALL_START);
  if (end) out = out.slice(0, end.pos) + out.slice(end.pos + end.tag.length);
  return out.trim();
}

/**
 * Model demux: OpenCode model ids → wire `model_type` + thinking default.
 *   deepseek-expert     → "expert"   (thinking off unless reasoner-named)
 *   deepseek-default    → "default"
 *   deepseek-vision     → "vision"
 * Legacy aliases keep working: deepseek-v4 → default, deepseek-v4-reasoner
 * → default + thinking (previous behavior, no wire model_type was sent).
 * search_enabled is NEVER derived from tools — the frozen spec (§12) fixes
 * its default to false; web search fragments would corrupt the marker
 * protocol for agent providers.
 */
export interface DeepSeekModelConfig {
  modelType: 'default' | 'expert' | 'vision';
  thinking: boolean;
}

export function resolveDeepSeekModel(modelId: string): DeepSeekModelConfig {
  const id = modelId.toLowerCase();
  const thinking = id.includes('reasoner');
  if (id.includes('vision')) return { modelType: 'vision', thinking };
  if (id.includes('expert')) return { modelType: 'expert', thinking };
  return { modelType: 'default', thinking };
}

/**
 * Parse DeepSeek web SSE into bridge stream events.
 *
 * Full wire parsing (ready / update_session / content / fragments / status /
 * close / errors) lives in ./sse.ts; this re-export keeps the pre-freeze
 * parser import site (`tools`) working unchanged.
 */
export { parseDeepSeekSse } from './sse.js';
