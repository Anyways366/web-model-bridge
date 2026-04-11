import { describe, it, beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../../src/browser/manager.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';

const TMP_DIR = join(tmpdir(), `wmb-gpt-diag-${Date.now()}`);
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

describe('ChatGPT API diagnosis', () => {
  it('test /backend-api/conversation with minimal request', async () => {
    const page = await bm.getPageForOrigin('https://chatgpt.com');

    // Check if we have auth tokens
    const authCheck = await page.evaluate(async () => {
      // First get current session
      try {
        const session = await fetch('/api/auth/session', { credentials: 'include' });
        const sessionData = await session.json();
        return { sessionStatus: session.status, hasAccessToken: !!sessionData.accessToken, user: sessionData.user?.email || 'no email' };
      } catch (e: any) {
        return { error: e.message };
      }
    });
    console.log('Auth check:', JSON.stringify(authCheck, null, 2));

    // Now try a conversation request
    const result = await page.evaluate(async () => {
      // Get access token first
      let accessToken = '';
      try {
        const session = await fetch('/api/auth/session', { credentials: 'include' });
        const sessionData = await session.json();
        accessToken = sessionData.accessToken || '';
      } catch { /* */ }

      try {
        const res = await fetch('/backend-api/conversation', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify({
            action: 'next',
            model: 'auto',
            messages: [{
              id: crypto.randomUUID(),
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['Say exactly: "TEST_OK"'] },
            }],
            parent_message_id: crypto.randomUUID(),
          }),
          credentials: 'include',
        });
        const contentType = res.headers.get('content-type');
        const body = await res.text();
        return { status: res.status, contentType, body: body.substring(0, 500) };
      } catch (e: any) {
        return { error: e.message };
      }
    });
    console.log('Conversation result:', JSON.stringify(result, null, 2));
  }, 60_000);
});
