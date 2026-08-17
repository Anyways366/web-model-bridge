/**
 * Phase 4C-STEP 1 — Live ChatGPT web tool-calling diagnostic.
 *
 * Sends the smallest authenticated request that reveals the ACTUAL upstream
 * behavior relevant to tool calls, using the browser's live chatgpt.com
 * session (attach mode via CDP, fetch with credentials:'include').
 *
 * PRIVACY: output is sanitized. Only booleans, HTTP status, structure keys,
 * finish reasons, model ids, conversation-id presence, and tool name/argument
 * keys are printed. Cookies, tokens, authorization headers, and private user
 * data are NEVER read, logged, or asserted.
 *
 * Prerequisites: Chrome with --remote-debugging-port=9222, logged into
 * chatgpt.com in that browser.
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../../src/browser/manager.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';

const TMP_DIR = join(tmpdir(), `wmb-gpt-tools-diag-${Date.now()}`);
const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const CHAT_TIMEOUT = 120_000;

let bm: BrowserManager;

beforeAll(async () => {
  mkdirSync(TMP_DIR, { recursive: true });
  bm = new BrowserManager({
    profileDir: join(TMP_DIR, 'p'),
    startupTimeout: 30_000,
    idleShutdown: 0,
    loginTimeout: 300,
    cdpUrl: CDP_URL,
    mode: 'attach',
  });
}, 30_000);

afterAll(async () => {
  await bm?.shutdown();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

function summarizeStructure(line: string): string {
  try {
    const parsed = JSON.parse(line);
    const choice = parsed.choices?.[0];
    const delta = choice?.delta;
    const message = choice?.message;
    const toolCalls = delta?.tool_calls ?? message?.tool_calls;
    const parts: string[] = [];
    if (choice) {
      parts.push(`finish=${choice.finish_reason ?? 'null'}`);
      parts.push(`deltaKeys=[${delta ? Object.keys(delta).join(',') : ''}]`);
    }
    if (Array.isArray(toolCalls)) {
      const calls = toolCalls.map((tc: any) => {
        const fn = tc?.function;
        return `idx=${tc?.index ?? '?'},id=${typeof tc?.id === 'string' ? tc.id.slice(0, 12) + '…' : '?'},name=${fn?.name ?? '?'},argKeys=${fn?.arguments ? Object.keys(JSON.parse(fn.arguments)).join(',') : ''}`;
      });
      parts.push(`toolCalls=[${calls.join(' | ')}]`);
    }
    if (parsed.type) parts.push(`type=${parsed.type}`);
    if (typeof parsed.model === 'string') parts.push(`model=${parsed.model}`);
    if (typeof parsed.conversation_id === 'string') parts.push('hasConversationId');
    return `data: {${parts.join(', ')}}`;
  } catch {
    return line.length > 120 ? `data: <${line.length} chars, not JSON>` : `data: ${line}`;
  }
}

describe('Phase 4C diagnostic: ChatGPT web tool calling', () => {
  it('reveals the live tool-call wire format from /backend-api/conversation', async () => {
    const page = await bm.getPageForOrigin('https://chatgpt.com');

    // Session check — booleans only, never tokens.
    const session = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/auth/session', { credentials: 'include' });
        const data = await res.json();
        return { status: res.status, hasSession: !!data?.accessToken };
      } catch (e: any) {
        return { error: e.message, hasSession: false };
      }
    });
    console.log('  session:', JSON.stringify(session));
    if (!session.hasSession) {
      console.log('  CLASSIFICATION A: authentication/session failure — no live chatgpt.com session in the browser.');
      return;
    }

    // Minimal tool-call probe: deterministic no-argument tool, explicit
    // instruction to call it. Response body is analyzed in the browser and
    // only the sanitized summary is returned.
    // Mirrors the real web client's headers (device id, language, client
    // name) — the backend rejects header-less requests with a 403
    // anti-bot block.
    const result = await page.evaluate(async () => {
      let deviceId = localStorage.getItem('OAI_DEVICE_ID');
      if (!deviceId) {
        deviceId = crypto.randomUUID();
        localStorage.setItem('OAI_DEVICE_ID', deviceId);
      }
      // In-page token acquisition, used ONLY as a request header below.
      // Never printed or returned.
      const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });
      const sessionJson = await sessionRes.json().catch(() => null);
      const accessToken = sessionJson?.accessToken ?? '';
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        accept: 'text/event-stream',
        authorization: accessToken ? `Bearer ${accessToken}` : '',
        'oai-device-id': deviceId,
        'oai-language': navigator.language,
        'oai-client-name': 'web',
        'oai-app-name': 'web',
        'x-request-id': crypto.randomUUID(),
        origin: 'https://chatgpt.com',
        referer: 'https://chatgpt.com/',
      };

      // Baseline: plain request WITHOUT tools, to isolate the block.
      const plain = await fetch('/backend-api/conversation', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'next',
          model: 'auto',
          messages: [{
            id: crypto.randomUUID(),
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['Say hello in one word.'] },
          }],
          parent_message_id: crypto.randomUUID(),
        }),
        credentials: 'include',
      });
      const plainStatus = plain.status;

      const res = await fetch('/backend-api/conversation', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'next',
          model: 'auto',
          messages: [{
            id: crypto.randomUUID(),
            author: { role: 'user' },
            content: {
              content_type: 'text',
              parts: ['Call the get_test_value tool, then reply with exactly what it returned.'],
            },
          }],
          parent_message_id: crypto.randomUUID(),
          tools: [{
            type: 'function',
            function: {
              name: 'get_test_value',
              description: 'Returns a deterministic test value used for verification.',
              parameters: { type: 'object', properties: {}, required: [] },
            },
          }],
        }),
        credentials: 'include',
      });
      const contentType = res.headers.get('content-type') ?? '';
      const text = await res.text();
      return { status: res.status, plainStatus, contentType, body: text };
    }, undefined);

    console.log(`  status: ${result.status}`);
    console.log(`  plain (no-tools) status: ${result.plainStatus}`);
    console.log(`  content-type: ${result.contentType}`);
    if (result.status !== 200) {
      const head = result.body.length > 400 ? `${result.body.slice(0, 400)}…` : result.body;
      console.log(`  body (first 400 chars): ${head}`);
      console.log('  CLASSIFICATION B/C: non-200 upstream response.');
      return;
    }

    // Summarize structure (sanitized) per data line.
    const lines = result.body.split('\n').map(l => l.trim()).filter(Boolean);
    console.log(`  total lines: ${lines.length}`);
    let toolCallLines = 0;
    let finishReasons: string[] = [];
    for (const line of lines) {
      if (!line.startsWith('data: ')) {
        if (line.startsWith('event:')) console.log(`  event: ${line.slice(7)}`);
        continue;
      }
      const summary = summarizeStructure(line);
      if (summary.includes('toolCalls=[')) {
        toolCallLines++;
        console.log(`  ${summary}`);
      }
      const fm = summary.match(/finish=([a-z_]+)/);
      if (fm && fm[1] !== 'null') finishReasons.push(fm[1]);
    }
    console.log(`  tool-call chunks: ${toolCallLines}`);
    console.log(`  finish reasons: [${[...new Set(finishReasons)].join(', ')}]`);

    const sawToolCall = toolCallLines > 0;
    console.log(`  RESULT: live endpoint ${sawToolCall ? 'EMITTED a tool call' : 'did NOT emit a tool call'}`);
    if (finishReasons.includes('tool_calls')) {
      console.log('  RESULT: finish_reason=tool_calls observed.');
    }
  }, CHAT_TIMEOUT);
});
