import { describe, it, expect, vi } from 'vitest';
import { gateNavigationToAllowedHosts } from '../../../src/browser/navigation-gate.js';
import { DEEPSEEK_ALLOWED_HOSTS } from '../../../src/core/network-policy.js';

/**
 * Security gate: main-frame navigations (initial load, server redirects,
 * JS-driven jumps) are aborted when the target host is not allowlisted;
 * subresources pass through. The gate runs at every page-creation point in
 * BrowserManager (getPageForOrigin, startLogin attach + launch).
 */

type Handler = (route: any) => void;

const mainFrame = { name: 'main' };
const iframe = { name: 'iframe' };

function makePage(): {
  page: any;
  handler: () => Handler;
  unroute: ReturnType<typeof vi.fn>;
} {
  let handler: Handler = () => {};
  const unroute = vi.fn();
  const page = {
    mainFrame: () => mainFrame,
    route: vi.fn((_pattern: string, fn: Handler) => {
      handler = fn;
    }),
    unroute,
  };
  return { page, handler: () => handler, unroute };
}

function mockRequest(url: string, isNavigation: boolean, frame: unknown) {
  return {
    url: () => url,
    isNavigationRequest: () => isNavigation,
    frame: () => frame,
  };
}

function mockRoute(req: unknown, cont = vi.fn(() => Promise.resolve()), abort = vi.fn(() => Promise.resolve())) {
  return { request: () => req, continue: cont, abort };
}

describe('navigation gate (outbound allowlist mid-flight enforcement)', () => {
  it('allows main-frame navigation to an allowlisted deepseek host', async () => {
    const { page, handler } = makePage();
    gateNavigationToAllowedHosts(page, DEEPSEEK_ALLOWED_HOSTS);
    const cont = vi.fn(() => Promise.resolve());
    const abort = vi.fn(() => Promise.resolve());
    await handler()(mockRoute(mockRequest('https://chat.deepseek.com/', true, mainFrame), cont, abort));
    expect(cont).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
  });

  it('aborts a main-frame navigation to an unexpected host (redirect target)', async () => {
    const { page, handler } = makePage();
    gateNavigationToAllowedHosts(page, DEEPSEEK_ALLOWED_HOSTS);
    const cont = vi.fn(() => Promise.resolve());
    const abort = vi.fn(() => Promise.resolve());
    await handler()(mockRoute(mockRequest('https://evil.com/steal', true, mainFrame), cont, abort));
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith('blockedbyclient');
    expect(cont).not.toHaveBeenCalled();
  });

  it('rejects a lookalike host with the allowlisted name as a subdomain', async () => {
    const { page, handler } = makePage();
    gateNavigationToAllowedHosts(page, DEEPSEEK_ALLOWED_HOSTS);
    const abort = vi.fn(() => Promise.resolve());
    await handler()(mockRoute(mockRequest('https://chat.deepseek.com.evil.com/x', true, mainFrame), vi.fn(), abort));
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('lets API navigations on the allowed host pass (page.reload, goto)', async () => {
    const { page, handler } = makePage();
    gateNavigationToAllowedHosts(page, DEEPSEEK_ALLOWED_HOSTS);
    const cont = vi.fn(() => Promise.resolve());
    await handler()(mockRoute(mockRequest('https://chat.deepseek.com/api/v0/chat/completion', true, mainFrame), cont));
    expect(cont).toHaveBeenCalledTimes(1);
  });

  it('does not gate subresource loads (assets, xhr) even from foreign hosts', async () => {
    const { page, handler } = makePage();
    gateNavigationToAllowedHosts(page, DEEPSEEK_ALLOWED_HOSTS);
    const cont = vi.fn(() => Promise.resolve());
    const abort = vi.fn(() => Promise.resolve());
    await handler()(mockRoute(mockRequest('https://cdn.evil.com/pixel.gif', false, mainFrame), cont, abort));
    expect(cont).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
  });

  it('does not gate iframe navigations (page-scoped enforcement only)', async () => {
    const { page, handler } = makePage();
    gateNavigationToAllowedHosts(page, DEEPSEEK_ALLOWED_HOSTS);
    const cont = vi.fn(() => Promise.resolve());
    await handler()(mockRoute(mockRequest('https://evil.com/frame', true, iframe), cont));
    expect(cont).toHaveBeenCalledTimes(1);
  });

  it('untrack() removes the route handler on the page', () => {
    const { page, unroute, handler } = makePage();
    const untrack = gateNavigationToAllowedHosts(page, DEEPSEEK_ALLOWED_HOSTS);
    expect(handler()).toBeTypeOf('function');
    untrack();
    expect(unroute).toHaveBeenCalledWith('**/*', handler());
  });

  it('empty allowlist fails closed (nothing is allowed; manager never passes empty)', async () => {
    const { page, handler } = makePage();
    gateNavigationToAllowedHosts(page, []);
    const cont = vi.fn(() => Promise.resolve());
    const abort = vi.fn(() => Promise.resolve());
    await handler()(mockRoute(mockRequest('https://anything.example/x', true, mainFrame), cont, abort));
    expect(abort).toHaveBeenCalledTimes(1);
    expect(cont).not.toHaveBeenCalled();
  });
});