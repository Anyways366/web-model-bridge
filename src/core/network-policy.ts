/**
 * Outbound network policy — fail-closed hostname allowlist.
 *
 * The bridge navigates a real browser to provider origins and runs
 * same-origin fetches there. Every outbound destination (page origin,
 * fetch URL, login URL) must be checked before the browser is pointed at
 * it. Anything not explicitly allowed is rejected.
 */

export const DEEPSEEK_ALLOWED_HOSTS: readonly string[] = [
  'chat.deepseek.com',
  'fe-static.deepseek.com',
];

/** Lower-case, strip a single trailing dot (FQDN form). */
export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}

export function isHostAllowed(hostname: string, allowed: ReadonlySet<string> | readonly string[]): boolean {
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  return set.has(normalizeHostname(hostname));
}

export function assertAllowedHostname(hostname: string, allowed: ReadonlySet<string> | readonly string[]): void {
  if (!isHostAllowed(hostname, allowed)) {
    throw new Error(`Blocked outbound request to disallowed host '${hostname}'`);
  }
}

export function assertAllowedUrl(url: string | URL, allowed: ReadonlySet<string> | readonly string[]): void {
  assertAllowedHostname(new URL(url).hostname, allowed);
}

/** Boolean form for callbacks that must not throw (e.g. route interceptors). */
export function isUrlAllowed(url: string | URL, allowed: ReadonlySet<string> | readonly string[]): boolean {
  return isHostAllowed(new URL(url).hostname, allowed);
}