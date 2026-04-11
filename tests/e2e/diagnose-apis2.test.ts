/**
 * Second round of API discovery - use correct request formats.
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../../src/browser/manager.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';

const TMP_DIR = join(tmpdir(), `wmb-api2-${Date.now()}`);
const AUTH_PROFILES_PATH = join(
  process.env.HOME ?? '~',
  'Documents/zero0330/openclaw-zero-token/.openclaw-upstream-state/agents/main/agent/auth-profiles.json'
);
let bm: BrowserManager;

function parseCookies(cookieStr: string, domain: string) {
  return cookieStr.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) return null;
    return { name: pair.substring(0, eqIdx), value: pair.substring(eqIdx + 1), domain, path: '/' };
  }).filter(Boolean) as any[];
}

function loadAuthProfile(name: string): any {
  const data = JSON.parse(readFileSync(AUTH_PROFILES_PATH, 'utf-8'));
  const profile = data.profiles?.[name];
  if (!profile?.token) return null;
  try { return JSON.parse(profile.token); } catch { return { raw: profile.token }; }
}

beforeAll(async () => {
  mkdirSync(TMP_DIR, { recursive: true });
  bm = new BrowserManager({
    profileDir: join(TMP_DIR, 'p'),
    startupTimeout: 30_000,
    idleShutdown: 0,
    loginTimeout: 300,
    cdpUrl: 'http://127.0.0.1:9222',
    mode: 'attach',
  });
}, 30_000);

afterAll(async () => {
  await bm?.shutdown();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('Qwen: deeper API discovery', () => {
  it('/api/chat/send with proper format', async () => {
    const profile = loadAuthProfile('qwen-web:default');
    const ctx = await bm.ensureBrowser();
    await ctx.addCookies(parseCookies(profile.cookie, '.qwen.ai'));
    const page = await bm.getPageForOrigin('https://chat.qwen.ai');

    // Try /api/chat/send and /api/chat with various body formats
    const bodies = [
      { name: 'openai-format', body: { model: 'qwen-plus-latest', messages: [{ role: 'user', content: 'hi' }], stream: true } },
      { name: 'with-session-token', body: { model: 'qwen-plus-latest', messages: [{ role: 'user', content: 'hi' }], stream: true, session_token: profile.sessionToken } },
      { name: 'chat-content', body: { content: 'hi', chat_type: 'text', model: 'qwen-plus-latest' } },
    ];

    for (const { name, body } of bodies) {
      for (const ep of ['/api/chat/send', '/api/chat']) {
        const result = await page.evaluate(async (args: { url: string; body: string; token: string }) => {
          try {
            const res = await fetch(args.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${args.token}`,
              },
              body: args.body,
              credentials: 'include',
            });
            return { status: res.status, body: (await res.text()).substring(0, 300) };
          } catch (e: any) {
            return { error: e.message };
          }
        }, { url: ep, body: JSON.stringify(body), token: profile.sessionToken });
        console.log(`  ${ep} (${name}): ${JSON.stringify(result)}`);
      }
    }
  }, 60_000);
});

describe('Doubao: /samantha/chat/completion', () => {
  it('with proper Doubao request format', async () => {
    const profile = loadAuthProfile('doubao-web:default');
    const ctx = await bm.ensureBrowser();
    await ctx.addCookies(parseCookies(profile.cookie, '.doubao.com'));
    const page = await bm.getPageForOrigin('https://www.doubao.com');

    // /samantha/chat/completion returned SSE-like response
    const bodies = [
      {
        name: 'standard',
        body: { messages: [{ role: 'user', content: 'Say hi' }], model: 'doubao-seed-2.0-pro', stream: true },
      },
      {
        name: 'with-section-id',
        body: {
          section_id: crypto.randomUUID(),
          messages: [{ content: 'Say hi', role: 'user' }],
          model: 'doubao-seed-2.0-pro',
          local_message_id: crypto.randomUUID(),
        },
      },
    ];

    for (const { name, body } of bodies) {
      const result = await page.evaluate(async (args: { body: string }) => {
        try {
          const res = await fetch('/samantha/chat/completion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: args.body,
            credentials: 'include',
          });
          return { status: res.status, contentType: res.headers.get('content-type'), body: (await res.text()).substring(0, 500) };
        } catch (e: any) {
          return { error: e.message };
        }
      }, { body: JSON.stringify(body) });
      console.log(`  /samantha/chat/completion (${name}):`, JSON.stringify(result, null, 2));
    }

    // Also try /api/flow/v1/chat with sessionid header
    const flowResult = await page.evaluate(async (args: { sessionid: string }) => {
      try {
        const res = await fetch('/api/flow/v1/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-ID': args.sessionid,
          },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
          credentials: 'include',
        });
        return { status: res.status, body: (await res.text()).substring(0, 300) };
      } catch (e: any) {
        return { error: e.message };
      }
    }, { sessionid: profile.sessionid });
    console.log(`  /api/flow/v1/chat with session:`, JSON.stringify(flowResult));
  }, 30_000);
});

describe('GLM: /chatglm/backend-api/assistant/stream', () => {
  it('with proper request format', async () => {
    const profile = loadAuthProfile('glm-web:default');
    const ctx = await bm.ensureBrowser();
    await ctx.addCookies(parseCookies(profile.cookie, '.chatglm.cn'));
    const page = await bm.getPageForOrigin('https://chatglm.cn');

    // Previous test showed 400 for /chatglm/backend-api/assistant/stream
    const bodies = [
      {
        name: 'assistant-stream',
        url: '/chatglm/backend-api/assistant/stream',
        body: {
          assistant_id: '',
          conversation_id: '',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hi' }] }],
          meta_data: { channel: '', draft_id: '' },
        },
      },
      {
        name: 'v1-stream-POST',
        url: '/chatglm/backend-api/v1/stream',
        body: { prompt: 'hi' },
      },
    ];

    for (const { name, url, body } of bodies) {
      const result = await page.evaluate(async (args: { url: string; body: string }) => {
        try {
          const res = await fetch(args.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: args.body,
            credentials: 'include',
          });
          return { status: res.status, body: (await res.text()).substring(0, 500) };
        } catch (e: any) {
          return { error: e.message };
        }
      }, { url, body: JSON.stringify(body) });
      console.log(`  ${name}:`, JSON.stringify(result, null, 2));
    }
  }, 30_000);
});
