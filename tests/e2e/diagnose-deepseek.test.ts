import { describe, it, beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../../src/browser/manager.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';

const TMP_DIR = join(tmpdir(), `wmb-ds-diag-${Date.now()}`);
let bm: BrowserManager;

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

describe('DeepSeek token discovery', () => {
  it('check cookies for token', async () => {
    const ctx = await bm.ensureBrowser();
    const cookies = await ctx.cookies();
    const dsCookies = cookies.filter(c => c.domain.includes('deepseek'));
    console.log('DeepSeek cookies:');
    for (const c of dsCookies) {
      console.log(`  ${c.name} = ${c.value.substring(0, 40)}... (domain: ${c.domain})`);
    }
  }, 15_000);

  it('check localStorage for token', async () => {
    const page = await bm.getPageForOrigin('https://chat.deepseek.com');
    const storage = await page.evaluate(() => {
      const items: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        items[key] = localStorage.getItem(key)!.substring(0, 80);
      }
      return items;
    });
    console.log('DeepSeek localStorage:');
    for (const [k, v] of Object.entries(storage)) {
      console.log(`  ${k} = ${v}`);
    }
  }, 15_000);

  it('check sessionStorage for token', async () => {
    const page = await bm.getPageForOrigin('https://chat.deepseek.com');
    const storage = await page.evaluate(() => {
      const items: Record<string, string> = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i)!;
        items[key] = sessionStorage.getItem(key)!.substring(0, 80);
      }
      return items;
    });
    console.log('DeepSeek sessionStorage:');
    for (const [k, v] of Object.entries(storage)) {
      console.log(`  ${k} = ${v}`);
    }
  }, 15_000);

  it('test with Authorization header from userToken', async () => {
    const page = await bm.getPageForOrigin('https://chat.deepseek.com');
    // Try to find token from localStorage or cookie
    const token = await page.evaluate(() => {
      // Common patterns for token storage
      return localStorage.getItem('userToken')
        || localStorage.getItem('token')
        || localStorage.getItem('ds_token')
        || localStorage.getItem('access_token')
        || document.cookie.split(';').find(c => c.trim().startsWith('token='))?.split('=')[1]
        || null;
    });
    console.log('Found token:', token ? `${token.substring(0, 30)}...` : 'null');

    // Try session create with explicit auth header
    if (token) {
      const result = await page.evaluate(async (t: string) => {
        const res = await fetch('/api/v0/chat_session/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${t}`,
          },
          body: '{}',
          credentials: 'include',
        });
        return { status: res.status, body: (await res.text()).substring(0, 300) };
      }, token);
      console.log('Session create with token:', JSON.stringify(result, null, 2));
    }
  }, 15_000);
});
