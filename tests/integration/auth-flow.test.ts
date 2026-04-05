import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/test-server.js';
import { MockProvider } from '../helpers/mock-provider.js';

describe('Auth flow integration', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  it('GET /webmodel/providers shows auth status', async () => {
    ctx = createTestContext({
      providers: [
        new MockProvider('p1', { authenticated: true }),
        new MockProvider('p2', { authenticated: false }),
      ],
    });
    const res = await ctx.app.request('/webmodel/providers');
    const body = await res.json();
    expect(body.providers).toHaveLength(2);
    const p1 = body.providers.find((p: any) => p.id === 'p1');
    const p2 = body.providers.find((p: any) => p.id === 'p2');
    expect(p1.authenticated).toBe(true);
    expect(p2.authenticated).toBe(false);
  });

  it('GET /webmodel/health includes provider status', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/webmodel/health');
    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(body).toHaveProperty('uptime');
    expect(body).toHaveProperty('providers');
    expect(body).toHaveProperty('browser');
  });

  it('POST /webmodel/auth/login returns 503 without browser', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'claude-web' }),
    });
    expect(res.status).toBe(503);
  });

  it('POST /webmodel/auth/login returns 404 for unknown provider', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'nonexistent' }),
    });
    expect(res.status).toBe(404);
  });
});
