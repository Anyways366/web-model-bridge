/**
 * Test: inject cookies from auth-profiles.json and verify API calls work.
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../../src/browser/manager.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';

const TMP_DIR = join(tmpdir(), `wmb-inject-${Date.now()}`);
const AUTH_PROFILES_PATH = join(
  process.env.HOME ?? '~',
  'Documents/zero0330/openclaw-zero-token/.openclaw-upstream-state/agents/main/agent/auth-profiles.json'
);

let bm: BrowserManager;

/** Parse a cookie string like "name1=val1; name2=val2" into playwright cookie objects */
function parseCookies(cookieStr: string, domain: string): Array<{
  name: string; value: string; domain: string; path: string;
}> {
  return cookieStr.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) return null;
    return {
      name: pair.substring(0, eqIdx),
      value: pair.substring(eqIdx + 1),
      domain,
      path: '/',
    };
  }).filter(Boolean) as any[];
}

function loadAuthProfile(name: string): any {
  const data = JSON.parse(readFileSync(AUTH_PROFILES_PATH, 'utf-8'));
  const profile = data.profiles?.[name];
  if (!profile?.token) return null;
  try {
    return JSON.parse(profile.token);
  } catch {
    return { raw: profile.token };
  }
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

describe('Cookie injection + API test', () => {
  it('DeepSeek: inject cookies + use bearer token', async () => {
    const profile = loadAuthProfile('deepseek-web:default');
    console.log('  DeepSeek profile keys:', Object.keys(profile));

    // Inject cookies into browser context
    const ctx = await bm.ensureBrowser();
    const cookies = parseCookies(profile.cookie, '.deepseek.com');
    console.log(`  Injecting ${cookies.length} cookies for deepseek.com`);
    await ctx.addCookies(cookies);

    // Test session create with bearer token
    const page = await bm.getPageForOrigin('https://chat.deepseek.com');
    const result = await page.evaluate(async (bearer: string) => {
      try {
        const res = await fetch('/api/v0/chat_session/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${bearer}`,
          },
          body: '{}',
          credentials: 'include',
        });
        return { status: res.status, body: (await res.text()).substring(0, 500) };
      } catch (e: any) {
        return { error: e.message };
      }
    }, profile.bearer);
    console.log('  Session create:', JSON.stringify(result, null, 2));
  }, 30_000);

  it('Claude: inject cookies + test organizations', async () => {
    const profile = loadAuthProfile('claude-web:default');
    console.log('  Claude profile keys:', Object.keys(profile));

    const ctx = await bm.ensureBrowser();
    const cookies = parseCookies(profile.cookie, '.claude.ai');
    console.log(`  Injecting ${cookies.length} cookies for claude.ai`);
    await ctx.addCookies(cookies);

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

  it('Qwen: inject cookies + test chat', async () => {
    const profile = loadAuthProfile('qwen-web:default');
    console.log('  Qwen profile keys:', Object.keys(profile));

    const ctx = await bm.ensureBrowser();
    const cookies = parseCookies(profile.cookie, '.qwen.ai');
    console.log(`  Injecting ${cookies.length} cookies for qwen.ai`);
    await ctx.addCookies(cookies);

    const page = await bm.getPageForOrigin('https://chat.qwen.ai');
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
    console.log('  Qwen response:', JSON.stringify(result, null, 2));
  }, 60_000);

  it('Doubao: inject cookies + test chat', async () => {
    const profile = loadAuthProfile('doubao-web:default');
    console.log('  Doubao profile keys:', Object.keys(profile));

    const ctx = await bm.ensureBrowser();
    const cookies = parseCookies(profile.cookie, '.doubao.com');
    console.log(`  Injecting ${cookies.length} cookies for doubao.com`);
    await ctx.addCookies(cookies);

    const page = await bm.getPageForOrigin('https://www.doubao.com');
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'doubao-seed-2.0-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
          credentials: 'include',
        });
        return { status: res.status, contentType: res.headers.get('content-type'), body: (await res.text()).substring(0, 300) };
      } catch (e: any) {
        return { error: e.message };
      }
    });
    console.log('  Doubao response:', JSON.stringify(result, null, 2));
  }, 30_000);
});
