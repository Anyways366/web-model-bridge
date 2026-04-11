import { describe, it, beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../../src/browser/manager.js';
import { AuthStore } from '../../src/auth/store.js';
import { DeepSeekProvider } from '../../src/providers/deepseek/index.js';
import { DoubaoProvider } from '../../src/providers/doubao-web/index.js';
import { QwenProvider } from '../../src/providers/qwen-web/index.js';
import type { StreamEvent } from '../../src/core/stream.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';

const TMP_DIR = join(tmpdir(), `wmb-sse-diag-${Date.now()}`);
const AUTH_PROFILES_PATH = join(process.env.HOME ?? '~', 'Documents/zero0330/openclaw-zero-token/.openclaw-upstream-state/agents/main/agent/auth-profiles.json');

let bm: BrowserManager;
let authStore: AuthStore;
let profiles: Record<string, any>;

function loadProfiles() {
  const data = JSON.parse(readFileSync(AUTH_PROFILES_PATH, 'utf-8'));
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(data.profiles ?? {})) {
    try { result[k] = JSON.parse((v as any).token); } catch {}
  }
  return result;
}

function parseCookies(cookieStr: string, domain: string) {
  return cookieStr.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) return null;
    return { name: pair.substring(0, eqIdx), value: pair.substring(eqIdx + 1), domain, path: '/' };
  }).filter(Boolean) as any[];
}

beforeAll(async () => {
  mkdirSync(TMP_DIR, { recursive: true });
  profiles = loadProfiles();
  bm = new BrowserManager({
    profileDir: join(TMP_DIR, 'p'),
    startupTimeout: 30_000, idleShutdown: 0, loginTimeout: 300,
    cdpUrl: 'http://127.0.0.1:9222', mode: 'attach',
  });
  authStore = new AuthStore(TMP_DIR);

  // Inject cookies
  const ctx = await bm.ensureBrowser();
  for (const [key, domain] of Object.entries({
    'deepseek-web:default': '.deepseek.com',
    'doubao-web:default': '.doubao.com',
    'qwen-web:default': '.qwen.ai',
  })) {
    const p = profiles[key];
    if (p?.cookie) {
      for (const c of parseCookies(p.cookie, domain)) {
        try { await ctx.addCookies([c]); } catch {}
      }
      authStore.setStatus(key.replace(':default', ''), 'active');
    }
  }
}, 30_000);

afterAll(async () => {
  await bm?.shutdown();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('DeepSeek SSE content', () => {
  it('check raw API response', async () => {
    const p = profiles['deepseek-web:default'];
    const page = await bm.getPageForOrigin('https://chat.deepseek.com');

    // Create session with bearer
    const session = await page.evaluate(async (bearer: string) => {
      const res = await fetch('/api/v0/chat_session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bearer}` },
        body: '{}', credentials: 'include',
      });
      return { status: res.status, body: await res.text() };
    }, p.bearer);
    console.log('  Session:', session.body.substring(0, 200));

    const sessionData = JSON.parse(session.body);
    const sessionId = sessionData?.data?.biz_data?.id;
    if (!sessionId) { console.log('  No session ID!'); return; }

    // Get PoW challenge
    const challenge = await page.evaluate(async (bearer: string) => {
      const res = await fetch('/api/v0/chat/create_pow_challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bearer}` },
        body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
        credentials: 'include',
      });
      return { status: res.status, body: await res.text() };
    }, p.bearer);
    console.log('  Challenge:', challenge.body.substring(0, 300));

    const challengeData = JSON.parse(challenge.body);
    const c = challengeData?.data?.biz_data?.challenge || challengeData?.data?.challenge;
    console.log('  Algorithm:', c?.algorithm, 'Difficulty:', c?.difficulty);
  }, 30_000);
});

describe('Doubao SSE content', () => {
  it('check raw SSE response', async () => {
    const page = await bm.getPageForOrigin('https://www.doubao.com');
    const result = await page.evaluate(async () => {
      const localConvId = `local_16${Date.now()}`;
      const localMsgId = crypto.randomUUID();
      const queryParams = 'aid=497858&device_platform=web&language=zh&pkg_type=release_version&real_aid=497858&region=CN&samantha_web=1&sys_region=CN&use_olympus_account=1&version_code=20800';

      const res = await fetch(`/samantha/chat/completion?${queryParams}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'Agw-js-conv': 'str' },
        body: JSON.stringify({
          messages: [{ content: JSON.stringify({ text: 'Say hi' }), content_type: 2001, attachments: [], references: [] }],
          completion_option: { is_regen: false, with_suggest: true, need_create_conversation: true, launch_stage: 1, is_replace: false, is_delete: false, message_from: 0, event_id: '0' },
          conversation_id: '0', local_conversation_id: localConvId, local_message_id: localMsgId,
        }),
        credentials: 'include',
      });
      return { status: res.status, contentType: res.headers.get('content-type'), body: (await res.text()).substring(0, 1000) };
    });
    console.log('  Doubao raw:', JSON.stringify(result, null, 2));
  }, 30_000);
});

describe('Qwen API', () => {
  it('check /api/v2/chats/new response', async () => {
    const page = await bm.getPageForOrigin('https://chat.qwen.ai');
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/v2/chats/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        credentials: 'include',
      });
      return { status: res.status, body: (await res.text()).substring(0, 500) };
    });
    console.log('  Qwen /api/v2/chats/new:', JSON.stringify(result, null, 2));
  }, 30_000);
});
