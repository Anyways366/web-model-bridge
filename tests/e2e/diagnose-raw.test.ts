/**
 * Raw diagnostic: check what browser fetch actually returns for each provider.
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../../src/browser/manager.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';

const CDP_URL = 'http://127.0.0.1:9222';
const TMP_DIR = join(tmpdir(), `wmb-diag-${Date.now()}`);

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

describe('Diagnose: cookies', () => {
  it('list all cookies for known domains', async () => {
    const ctx = await bm.ensureBrowser();
    const cookies = await ctx.cookies();

    const domains = [
      'claude.ai', 'chatgpt.com', 'deepseek.com', 'chat.deepseek.com',
      'moonshot.cn', 'kimi.moonshot.cn', 'qwen.ai', 'chat.qwen.ai',
      'chatglm.cn', 'grok.com', 'google.com', 'gemini.google.com',
      'perplexity.ai', 'doubao.com', 'www.doubao.com',
    ];

    for (const d of domains) {
      const matched = cookies.filter(c => c.domain.includes(d));
      if (matched.length > 0) {
        console.log(`  ${d}: ${matched.length} cookies — ${matched.map(c => c.name).slice(0, 5).join(', ')}`);
      } else {
        console.log(`  ${d}: NO cookies`);
      }
    }
  }, 30_000);
});

describe('Diagnose: raw fetch responses', () => {
  it('DeepSeek /api/v0/chat_session/create', async () => {
    const page = await bm.getPageForOrigin('https://chat.deepseek.com');
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/v0/chat_session/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          credentials: 'include',
        });
        return { status: res.status, body: (await res.text()).substring(0, 500) };
      } catch (e: any) {
        return { error: e.message };
      }
    });
    console.log('  DeepSeek session create:', JSON.stringify(result, null, 2));
  }, 30_000);

  it('Claude /api/organizations', async () => {
    const page = await bm.getPageForOrigin('https://claude.ai');
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/organizations', {
          headers: {
            'Content-Type': 'application/json',
            'anthropic-client-platform': 'web_claude_ai',
          },
          credentials: 'include',
        });
        return { status: res.status, body: (await res.text()).substring(0, 500) };
      } catch (e: any) {
        return { error: e.message };
      }
    });
    console.log('  Claude orgs:', JSON.stringify(result, null, 2));
  }, 30_000);

  it('Qwen /api/chat/completions (check if exists)', async () => {
    const page = await bm.getPageForOrigin('https://chat.qwen.ai');
    // First check what the page URL is
    console.log('  Qwen page URL:', page.url());

    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'qwen-3.5-plus', messages: [{ role: 'user', content: 'hi' }], stream: true }),
          credentials: 'include',
        });
        return { status: res.status, contentType: res.headers.get('content-type'), body: (await res.text()).substring(0, 500) };
      } catch (e: any) {
        return { error: e.message };
      }
    });
    console.log('  Qwen /api/chat/completions:', JSON.stringify(result, null, 2));
  }, 30_000);

  it('Doubao /api/chat/completions (check if exists)', async () => {
    const page = await bm.getPageForOrigin('https://www.doubao.com');
    console.log('  Doubao page URL:', page.url());

    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'doubao-seed-2.0-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
          credentials: 'include',
        });
        return { status: res.status, contentType: res.headers.get('content-type'), body: (await res.text()).substring(0, 500) };
      } catch (e: any) {
        return { error: e.message };
      }
    });
    console.log('  Doubao /api/chat/completions:', JSON.stringify(result, null, 2));
  }, 30_000);

  it('ChatGPT /backend-api/conversation (check auth)', async () => {
    const page = await bm.getPageForOrigin('https://chatgpt.com');
    console.log('  ChatGPT page URL:', page.url());

    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/backend-api/me', {
          credentials: 'include',
        });
        return { status: res.status, body: (await res.text()).substring(0, 300) };
      } catch (e: any) {
        return { error: e.message };
      }
    });
    console.log('  ChatGPT /backend-api/me:', JSON.stringify(result, null, 2));
  }, 30_000);
});
