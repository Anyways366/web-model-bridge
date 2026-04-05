import { Hono } from 'hono';
import { ProviderRegistry } from '../core/registry.js';
import { AuthStore } from '../auth/store.js';
import type { BrowserStatus } from '../browser/manager.js';

export interface ManagementDeps {
  registry: ProviderRegistry;
  authStore: AuthStore;
  onLogin?: (providerId: string) => Promise<{ status: string }>;
  getBrowserStatus?: () => BrowserStatus;
  startTime?: number;
}

export function managementRoutes(deps: ManagementDeps): Hono {
  const { registry, authStore, onLogin } = deps;
  const routeStartTime = deps.startTime ?? Date.now();
  const app = new Hono();

  app.get('/webmodel/providers', async (c) => {
    const statuses = await registry.providerStatus();
    return c.json({ providers: statuses });
  });

  app.post('/webmodel/auth/login', async (c) => {
    let body: { providerId: string };
    try {
      body = await c.req.json<{ providerId: string }>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const provider = registry.getProvider(body.providerId);
    if (!provider) {
      return c.json({ error: 'Unknown provider' }, 404);
    }

    if (!onLogin) {
      return c.json({ error: 'Browser not available' }, 503);
    }

    try {
      await onLogin(body.providerId);
      return c.json({ status: 'login_started', providerId: body.providerId });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/webmodel/auth/check', async (c) => {
    let body: { providerId: string };
    try {
      body = await c.req.json<{ providerId: string }>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const status = authStore.getStatus(body.providerId);
    return c.json(status);
  });

  app.post('/webmodel/auth/logout', async (c) => {
    let body: { providerId: string };
    try {
      body = await c.req.json<{ providerId: string }>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    authStore.clearStatus(body.providerId);
    return c.json({ status: 'logged_out', providerId: body.providerId });
  });

  app.get('/webmodel/health', async (c) => {
    const statuses = await registry.providerStatus();
    const browserStatus = deps.getBrowserStatus ? deps.getBrowserStatus() : 'stopped';
    return c.json({
      status: 'healthy',
      uptime: Math.floor((Date.now() - routeStartTime) / 1000),
      browser: { status: browserStatus },
      providers: Object.fromEntries(
        statuses.map(s => [s.id, { authenticated: s.authenticated, models: s.modelCount }])
      ),
    });
  });

  return app;
}
