import { describe, it, expect } from 'vitest';
import { buildDeepSeekPrompt, TOOL_CALL_START, TOOL_CALL_END } from '../../../src/providers/deepseek/tools.js';
import type { Message, ToolDef } from '../../../src/core/provider.js';

/**
 * Byte-parity fixture: our serialization must equal ds-free-api's output
 * byte-for-byte for an identical conversation + tool set.
 *
 * Reference transcription taken from ds-free-api source, char-for-char
 * (src/openai_adapter/request/prompt.rs, request/tools.rs):
 *   - role tags / EOS / tool-output tags: FULL-WIDTH `｜` (U+FF5C) + `▁` (U+2581)
 *   - tool-call markers embedded in the prompt: ASCII `|` + `▁`
 *   - system block injected before first part; think reminder before generation
 */

const FF5C = '\uFF5C';
const LOW = '\u2581';
const EOS = `<${FF5C}end${LOW}of${LOW}sentence${FF5C}>`;
const SYS_TAG = `<${FF5C}System${FF5C}>`;
const USER_TAG = `<${FF5C}User${FF5C}>`;
const ASST_TAG = `<${FF5C}Assistant${FF5C}>`;
const OUTS_BEGIN = `<${FF5C}tool${LOW}outputs${LOW}begin${FF5C}>`;
const OUT_BEGIN = `<${FF5C}tool${LOW}output${LOW}begin${FF5C}>`;
const OUT_END = `<${FF5C}tool${LOW}output${LOW}end${FF5C}>`;
const OUTS_END = `<${FF5C}tool${LOW}outputs${LOW}end${FF5C}>`;

const CALL = { s: TOOL_CALL_START, e: TOOL_CALL_END };

const weatherTool: ToolDef = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
};

const TOOLS: ToolDef[] = [weatherTool];

// ds-free-api build_tool_instruction_block(req) for [get_weather]
const FB = [
  '**工具调用格式 — 请严格遵守：**',
  '',
  '将 JSON 数组包裹在工具调用标记中：',
  '',
  `${CALL.s}[{"name": "工具名", "arguments": {参数JSON}}]${CALL.e}`,
  '',
  '**规则：**',
  '',
  '**核心：决定调用工具时，你的响应中只允许出现工具调用文本本身，禁止任何解释、前缀、总结、问候语等额外内容。**',
  '',
  `1. JSON 数组必须以 \`${CALL.s}\` 开头、以 \`${CALL.e}\` 结尾，将数组**完整包裹**在标记内。`,
  '2. 所有工具调用必须放在**一个** JSON 数组中，多个调用用逗号分隔。',
  `3. 输出 \`${CALL.e}\` 后**立即停止**，不得添加后续文本、XML 标签或说明文字。`,
  '4. 不要将工具调用包裹在 markdown 代码块中。',
  '5. 字符串参数值必须用**双引号**包裹（JSON 标准）。',
  `6. 决定调用工具时，输出的**第一个非空白字符**必须是 \`${CALL.s}\`。`,
  `7. 整个响应中**只能出现一个 \`${CALL.s}\` 块**，不要重复输出多个 \`${CALL.s}\` 块。`,
  `8. **重复：** 整个响应中只能出现一个 \`${CALL.s}\` 块，不要重复输出。如果你已经输出了一个 \`${CALL.s}\` 块，绝对不要再输出第二个。`,
  `9. **重复：** 禁止在 \`${CALL.s}\` 之前输出任何文字，包括但不限于解释、确认、总结、问候语。`,
  '10. 不要把回复和工具调用置于思考内容中。',
  `11. **重复：** 思考内容（ thinking 标签内）仅用于内部推理过程，不要将最终回复或工具调用放在  thinking 标签中。`,
  '',
  '**正确示例：**',
  '',
  '**示例A** — 调用一个工具：',
  `${CALL.s}[{"name": "get_weather", "arguments": {"city": "Beijing"}}]${CALL.e}`,
  '',
  '**示例D** — 参数值为嵌套对象/数组（仍然是标准 JSON）：',
  '',
  `${CALL.s}[{"name": "get_weather", "arguments": {"config": {"enabled": true, "items": ["a", "b"]}}}]${CALL.e}`,
  '',
].join('\n');

// ds-free-api defs_text for [get_weather]
const params = JSON.stringify(weatherTool.function.parameters);
const DT = [
  '你可以使用以下工具：',
  '- **get_weather** (function):',
  `  - 调用方法: \`${CALL.s}[{"name": "get_weather", "arguments": ${params}}]${CALL.e}\``,
  '  - 简要说明:',
  '~~~markdown',
  '  Get current weather for a city',
  '~~~',
  '',
].join('\n');

// ds-free-api build() final assembled prompt (joined with ''), transcribed
function referencePrompt(messages: Message[]): string {
  const parts: string[] = [];
  const sysContent = `\n\n## 工具调用\n### 格式规范\n${FB}\n\n### 工具定义\n${DT}`;
  parts.unshift(`${SYS_TAG}${sysContent}\n`);

  const userText1 = 'Create a file called example.txt containing WEBMODEL_ACCEPTANCE_4711.';
  parts.push(`${EOS}${USER_TAG}${userText1}`);

  parts.push(
    `${ASST_TAG}${CALL.s}\n[{"name": "get_weather", "arguments": {"city":"Beijing"}}]\n${CALL.e}`,
  );

  parts.push(`${OUTS_BEGIN}${OUT_BEGIN}WEBMODEL_ACCEPTANCE_4711${OUT_END}${OUTS_END}`);

  const userText2 = 'Now use the result to answer.';
  parts.push(`${EOS}${USER_TAG}${userText2}`);

  const think = `嗯，我刚刚被系统提醒需要遵循以下内容:\n\n## 工具调用\n### 格式规范\n${FB}`;
  parts.push(`${ASST_TAG}<thinking>\n${think}\n`);

  return parts.join('');
}

const messages: Message[] = [
  { role: 'user', content: 'Create a file called example.txt containing WEBMODEL_ACCEPTANCE_4711.' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } },
    ],
  },
  { role: 'tool', content: 'WEBMODEL_ACCEPTANCE_4711', tool_call_id: 'call_1' },
  { role: 'user', content: 'Now use the result to answer.' },
];

describe('deepseek protocol fixture (byte parity with ds-free-api)', () => {
  it('serializes the roundtrip byte-for-byte like the reference', () => {
    const ours = buildDeepSeekPrompt(messages, TOOLS);
    const ref = referencePrompt(messages);
    expect(ours).toBe(ref);
  });

  it('uses full-width role/output/EOS tags (no ASCII pipes outside call markers)', () => {
    const ours = buildDeepSeekPrompt(messages, TOOLS);
    const withoutCallTags = ours.replaceAll(CALL.s, '').replaceAll(CALL.e, '');
    expect(withoutCallTags).not.toContain('<|');
    expect(ours).toContain(`${OUTS_BEGIN}${OUT_BEGIN}WEBMODEL_ACCEPTANCE_4711${OUT_END}${OUTS_END}`);
  });

  it('keeps ASCII call markers and attaches the think block before generation', () => {
    const ours = buildDeepSeekPrompt(messages, TOOLS);
    expect(ours).toContain(`${CALL.s}\n[{"name": "get_weather", "arguments": {"city":"Beijing"}}]\n${CALL.e}`);
    expect(ours).toContain(`${ASST_TAG}<thinking>\n嗯，我刚刚被系统提醒需要遵循以下内容:`);
  });

  it('chains tool results into the model-facing continuation position', () => {
    const ours = buildDeepSeekPrompt(messages, TOOLS);
    const resultPos = ours.indexOf('WEBMODEL_ACCEPTANCE_4711');
    const callPos = ours.indexOf('get_weather');
    const contPos = ours.indexOf('Now use the result to answer.');
    expect(resultPos).toBeGreaterThan(callPos);
    expect(contPos).toBeGreaterThan(resultPos);
  });
});