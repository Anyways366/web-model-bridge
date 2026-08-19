import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/test-server.js';

describe('GET /health', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  it('returns ok without authentication', async () => {
    ctx = createTestContext({ authToken: 'secret' });
    const res = await ctx.app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });

  it('is not affected by the /v1 auth middleware', async () => {
    ctx = createTestContext({ authToken: 'secret' });
    const res = await ctx.app.request('/v1/models', { headers: {} });
    expect(res.status).toBe(403);
    const health = await ctx.app.request('/health');
    expect(health.status).toBe(200);
  });
});