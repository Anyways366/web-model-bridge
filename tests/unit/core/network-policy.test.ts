import { describe, it, expect } from 'vitest';
import {
  isHostAllowed,
  isUrlAllowed,
  assertAllowedHostname,
  assertAllowedUrl,
  normalizeHostname,
  DEEPSEEK_ALLOWED_HOSTS,
} from '../../../src/core/network-policy.js';

describe('network policy', () => {
  const allowed = [...DEEPSEEK_ALLOWED_HOSTS, 'claude.ai', 'example.com'];

  it('allows exact allowlisted hosts', () => {
    expect(isHostAllowed('chat.deepseek.com', allowed)).toBe(true);
    expect(isHostAllowed('fe-static.deepseek.com', allowed)).toBe(true);
  });

  it('normalizes case, trailing dot, and port form', () => {
    expect(normalizeHostname('Chat.DeepSeek.COM.')).toBe('chat.deepseek.com');
    expect(isHostAllowed('chat.deepseek.com.', allowed)).toBe(true);
    expect(assertAllowedUrl('https://chat.deepseek.com:8443/a/b?x=1#y', allowed)).toBeUndefined();
  });

  it('rejects other hosts fail-closed', () => {
    expect(isHostAllowed('evil.com', allowed)).toBe(false);
    expect(isHostAllowed('chat.deepseek.com.evil.com', allowed)).toBe(false);
    expect(isHostAllowed('deepseek.com', allowed)).toBe(false);
    expect(isHostAllowed('alice.com', allowed)).toBe(false);
    expect(isHostAllowed('xn--98j3d.com', allowed)).toBe(false);
    expect(() => assertAllowedHostname('evil.com', allowed)).toThrow(/Blocked outbound/);
  });

  it('rejects URL forms pointing at disallowed hosts', () => {
    expect(() => assertAllowedUrl('https://evil.com/x', allowed)).toThrow(/Blocked outbound/);
    expect(() => assertAllowedUrl('http://127.0.0.1:9222/json/version', allowed)).toThrow(/Blocked outbound/);
  });

  it('handles a Set allowlist and bare hostnames without scheme', () => {
    const set = new Set(DEEPSEEK_ALLOWED_HOSTS);
    expect(isHostAllowed('chat.deepseek.com', set)).toBe(true);
    expect(() => assertAllowedHostname('other.host', set)).toThrow();
  });

  it('isUrlAllowed returns a boolean without throwing (route interceptor use)', () => {
    expect(isUrlAllowed('https://chat.deepseek.com/api/v0/chat/completion', allowed)).toBe(true);
    expect(isUrlAllowed('https://fe-static.deepseek.com/assets/app.js', allowed)).toBe(true);
    expect(isUrlAllowed('https://evil.com/redirect', allowed)).toBe(false);
    expect(isUrlAllowed('https://chat.deepseek.com.evil.com/x', allowed)).toBe(false);
  });

  it('rejects redirect targets to unexpected hosts (mid-flight redirects)', () => {
    const redirectTarget = 'https://evil.com/steal';
    expect(() => assertAllowedUrl(redirectTarget, allowed)).toThrow(/Blocked outbound/);
    expect(isUrlAllowed(redirectTarget, allowed)).toBe(false);
  });

  it('allows the deepseek API endpoint hosts in the allowlist', () => {
    for (const host of DEEPSEEK_ALLOWED_HOSTS) {
      expect(isUrlAllowed(`https://${host}/api/v0/chat/completion`, allowed)).toBe(true);
    }
  });
});