/**
 * Discover real API endpoints for standard providers.
 * Uses browser console to intercept network requests.
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../../src/browser/manager.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';

const TMP_DIR = join(tmpdir(), `wmb-api-diag-${Date.now()}`);
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

describe('Discover Qwen real API', () => {
  it('try common chat endpoints', async () => {
    const profile = loadAuthProfile('qwen-web:default');
    const ctx = await bm.ensureBrowser();
    await ctx.addCookies(parseCookies(profile.cookie, '.qwen.ai'));

    const page = await bm.getPageForOrigin('https://chat.qwen.ai');

    // Try various possible endpoints
    const endpoints = [
      '/api/v1/chat/send',
      '/api/chat/send',
      '/api/v1/completions',
      '/api/v1/chat',
      '/api/chat',
      '/api/v1/conversation',
      '/api/chat/completions',  // already know this is 504
    ];

    for (const ep of endpoints) {
      const result = await page.evaluate(async (url: string) => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'qwen-3.5-plus', messages: [{ role: 'user', content: 'hi' }] }),
            credentials: 'include',
          });
          return { url, status: res.status, contentType: res.headers.get('content-type')?.substring(0, 50), body: (await res.text()).substring(0, 200) };
        } catch (e: any) {
          return { url, error: e.message };
        }
      }, ep);
      console.log(`  ${ep}: ${JSON.stringify(result)}`);
    }

    // Also try to find API via page resources
    const result2 = await page.evaluate(async (token: string) => {
      try {
        // Try the Qwen API with authorization
        const res = await fetch('https://chat.qwen.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            model: 'qwen-plus-latest',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          }),
          credentials: 'include',
        });
        return { status: res.status, contentType: res.headers.get('content-type')?.substring(0, 50), body: (await res.text()).substring(0, 300) };
      } catch (e: any) {
        return { error: e.message };
      }
    }, profile.sessionToken);
    console.log(`  /api/v1/chat/completions with auth token:`, JSON.stringify(result2));
  }, 60_000);
});

describe('Discover Doubao real API', () => {
  it('try common chat endpoints', async () => {
    const profile = loadAuthProfile('doubao-web:default');
    const ctx = await bm.ensureBrowser();
    await ctx.addCookies(parseCookies(profile.cookie, '.doubao.com'));

    const page = await bm.getPageForOrigin('https://www.doubao.com');

    const endpoints = [
      '/alice/api/chatv2/chat',
      '/alice/api/chat',
      '/api/flow/v1/chat',
      '/api/flow/chat',
      '/samantha/chat/completion',
      '/chat/api/chat',
      '/api/v1/chat',
    ];

    for (const ep of endpoints) {
      const result = await page.evaluate(async (url: string) => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
            credentials: 'include',
          });
          return { url, status: res.status, body: (await res.text()).substring(0, 200) };
        } catch (e: any) {
          return { url, error: e.message };
        }
      }, ep);
      console.log(`  ${ep}: ${JSON.stringify(result)}`);
    }
  }, 30_000);
});

describe('Discover GLM real API', () => {
  it('try common chat endpoints', async () => {
    const profile = loadAuthProfile('glm-web:default');
    const ctx = await bm.ensureBrowser();
    await ctx.addCookies(parseCookies(profile.cookie, '.chatglm.cn'));

    const page = await bm.getPageForOrigin('https://chatglm.cn');

    const endpoints = [
      '/chatglm/backend-api/assistant/stream',
      '/chatglm/backend-api/v1/stream',
      '/api/chat',
      '/api/v1/chat',
      '/chatglm/api/chat',
    ];

    for (const ep of endpoints) {
      const result = await page.evaluate(async (url: string) => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
            credentials: 'include',
          });
          return { url, status: res.status, body: (await res.text()).substring(0, 200) };
        } catch (e: any) {
          return { url, error: e.message };
        }
      }, ep);
      console.log(`  ${ep}: ${JSON.stringify(result)}`);
    }
  }, 30_000);
});
