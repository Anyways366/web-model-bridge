/**
 * Phase 4C Step 1 (cont.) — Capture the REAL ChatGPT web UI conversation
 * request via CDP network monitoring and compare its sanitized structure
 * with the bridge provider's request, to explain the 403.
 *
 * PRIVACY: outputs are sanitized. Only header NAMES (plus non-sensitive
 * allowlisted values), endpoint, method, response status, and a structural
 * skeleton of the POST body are written to .ui-request-compare.json.
 * Cookies, tokens, authorization values, device ids, message text, and
 * conversation ids are NEVER captured or printed.
 */
import { describe, it, expect } from 'vitest';
import { chromium } from 'playwright-core';
import type { Browser, Page, Response } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const OUT = join(process.cwd(), '.ui-request-compare.json');

/** Structural skeleton of a request body — values stripped except safe ones. */
function skeleton(value: unknown, depth = 0): unknown {
  if (depth > 5) return '…';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'number') return 'num';
  if (typeof value === 'boolean') return 'bool';
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? [skeleton(value[0], depth + 1)] : [];
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
      if (['model', 'action', 'role', 'content_type', 'message_type'].includes(k)) {
        out[k] = typeof value[k] === 'string' ? value[k] : '?'; // safe short values
      } else {
        out[k] = skeleton(value[k], depth + 1);
      }
    }
    return out;
  }
  return '?';
}

/** Sanitized header report: names always, values only for allowlist. */
function sanitizedHeaders(headers: Record<string, string>): Record<string, string> {
  const allowValues = new Set([
    'content-type',
    'accept',
    'accept-language',
    'oai-client-name',
    'oai-app-name',
    'oai-client-version',
    'origin',
    'referer',
    'accept-encoding',
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = allowValues.has(k.toLowerCase()) ? v : '…';
  }
  return out;
}

describe('Phase 4C diagnostic: capture real UI conversation request', () => {
  it('drives the real web UI in a fresh tab and captures the successful request', async () => {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const report: any = { captured: [], statuses: {}, pageState: {}, error: null };
    try {
      const ctxs = browser.contexts();
      const ctx = ctxs.find((c) => c.pages().some((p) => p.url().includes('chatgpt.com'))) ?? ctxs[0];
      const page = await ctx.newPage();

      const captured: any[] = [];
      const statuses = new Map<string, { status: number; contentType: string }>();
      const interesting = (url: string) => url.includes('/backend-api/') || url.includes('/api/auth/session');

      page.on('request', (req) => {
        if (!interesting(req.url())) return;
        const post = req.postData();
        let bodySkeleton: unknown = null;
        if (post) {
          try {
            bodySkeleton = skeleton(JSON.parse(post));
          } catch {
            bodySkeleton = `unparsable(${post.length} chars)`;
          }
        }
        captured.push({
          url: req.url(),
          method: req.method(),
          resourceType: req.resourceType(),
          headers: sanitizedHeaders(req.headers()),
          bodySkeleton,
          at: Date.now(),
        });
      });
      page.on('response', (res: Response) => {
        if (!interesting(res.url())) return;
        statuses.set(res.url(), {
          status: res.status(),
          contentType: res.headers()['content-type'] ?? '',
        });
      });

      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 120_000 });
      report.pageState.url = page.url();
      report.pageState.title = (await page.title()).slice(0, 200);

      // Try several known composer selectors.
      const selectors = [
        'textarea#prompt-textarea',
        'textarea',
        'div[contenteditable="true"]',
        'form textarea',
      ];
      let composer = null;
      for (const sel of selectors) {
        const loc = page.locator(sel).first();
        try {
          await loc.waitFor({ state: 'visible', timeout: 25_000 });
          composer = loc;
          report.pageState.composerSelector = sel;
          break;
        } catch {
          /* try next */
        }
      }

      if (!composer) {
        report.pageState.visibleText = (await page.locator('body').innerText().catch(() => ''))
          .split('\n').filter((l) => l.trim()).slice(0, 25);
      } else {
        await composer.fill('[diagnostic] Reply with the single word: OK');
        await composer.press('Enter');
      }

      // Wait for a conversation request with a non-403 response from the UI.
      const deadline = Date.now() + 120_000;
      let uiConversationStatus: number | null = null;
      let uiConversationUrl: string | null = null;
      while (Date.now() < deadline) {
        const convReqs = captured.filter((c) => c.url.includes('/backend-api/'));
        const ok = convReqs.find((c) => statuses.get(c.url)?.status === 200);
        if (ok) {
          uiConversationUrl = ok.url;
          uiConversationStatus = statuses.get(ok.url)!.status;
          break;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      report.uiConversationStatus = uiConversationStatus;
      report.uiConversationUrl = uiConversationUrl;
      report.captured = captured;
      report.statuses = Object.fromEntries([...statuses.entries()].map(([u, s]) => [u, s]));
      report.note =
        'sanitized: header values only for allowlisted non-sensitive headers; body values stripped except model/action/role/content_type/message_type';
      console.log(`  UI conversation status: ${uiConversationStatus ?? 'none/403'}`);
      console.log(`  UI conversation url: ${uiConversationUrl ?? 'none'}`);
    } catch (e: any) {
      report.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    } finally {
      writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf-8');
      console.log(`  wrote ${OUT}`);
      await browser.close(); // disconnect only — never closes Chrome
    }

    expect(report.error).toBeNull();
    expect(report.captured.some((c: any) => c.url.includes('/backend-api/'))).toBe(true);
    expect(report.uiConversationStatus).toBe(200);
  }, 300_000);
});
