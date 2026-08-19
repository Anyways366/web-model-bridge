import type { Page, Route } from 'playwright-core';
import { isUrlAllowed } from '../core/network-policy.js';

/**
 * Pin a page to the allowlisted hosts: abort any main-frame navigation
 * (initial load, server redirects, JS-driven jumps) whose target host is
 * not allowlisted. This closes the redirect/foreign-host composition where
 * the provider's own same-origin fetches would otherwise resolve against a
 * page that was bounced to an attacker host.
 *
 * Subresources (scripts, images, XHR) are intentionally NOT gated: providers
 * each load their own CDNs (fe-static.deepseek.com, etc.) that are not worth
 * enumerating here, and a malicious page on an allowed host can exfiltrate
 * via DOM APIs anyway. The credential-bearing calls use fixed absolute
 * endpoints (src/providers/deepseek/client.ts) so the page origin never
 * decides where tokens are sent.
 *
 * Returns an untrack function (route handlers persist across reloads).
 */
export function gateNavigationToAllowedHosts(page: Page, allowed: readonly string[]): () => void {
  const handler = (route: Route) => {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.continue();
    if (request.frame() !== page.mainFrame()) return route.continue();
    if (!isUrlAllowed(request.url(), allowed)) return route.abort('blockedbyclient');
    return route.continue();
  };
  page.route('**/*', handler);
  return () => page.unroute('**/*', handler);
}