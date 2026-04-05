import type { BrowserContext, Page } from 'playwright-core';
import { findChromePath } from '../doctor.js';

export type BrowserStatus = 'running' | 'idle' | 'stopped';

export class BrowserManager {
  private context: BrowserContext | null = null;
  private _status: BrowserStatus = 'stopped';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private profileDir: string,
    private opts: {
      startupTimeout: number;
      idleShutdown: number;
      loginTimeout: number;
    },
  ) {}

  async ensureBrowser(): Promise<BrowserContext> {
    if (this.context) {
      this.resetIdleTimer();
      return this.context;
    }

    const { chromium } = await import('playwright-core');
    const executablePath = this.findChrome();

    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: true,
      executablePath,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
      ],
      timeout: this.opts.startupTimeout,
    });

    this._status = 'running';
    this.resetIdleTimer();
    return this.context;
  }

  async fetchInBrowser(url: string, init: RequestInit): Promise<Response> {
    const ctx = await this.ensureBrowser();
    const page = ctx.pages()[0] || await ctx.newPage();

    // Use page.evaluate to execute fetch within browser context (carries cookies).
    // NOTE: This buffers the full response. For true streaming, CDP-level interception
    // (page.route or Fetch.requestPaused) would be needed. Acceptable for MVP since
    // most web model responses are < 100KB and latency is dominated by model inference.
    const result = await page.evaluate(
      async ([fetchUrl, fetchInit]: [string, { method?: string; headers?: Record<string, string>; body?: string }]) => {
        const res = await fetch(fetchUrl, {
          method: fetchInit.method || 'GET',
          headers: fetchInit.headers,
          body: fetchInit.body,
          credentials: 'include',
        });

        const headers: Record<string, string> = {};
        res.headers.forEach((v: string, k: string) => { headers[k] = v; });
        const text = await res.text();
        return { status: res.status, headers, body: text, ok: res.ok };
      },
      [url, {
        method: init.method,
        headers: init.headers as Record<string, string>,
        body: init.body as string,
      }] as [string, { method?: string; headers?: Record<string, string>; body?: string }],
    );

    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  }

  async openForLogin(loginUrl: string): Promise<void> {
    const ctx = await this.ensureBrowser();
    const page: Page = await ctx.newPage();
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        page.close().catch(() => {});
        resolve();
      }, this.opts.loginTimeout * 1000);

      page.on('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    this._status = 'stopped';
  }

  getStatus(): BrowserStatus {
    return this._status;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.opts.idleShutdown > 0) {
      this.idleTimer = setTimeout(() => {
        this._status = 'idle';
        this.shutdown();
      }, this.opts.idleShutdown * 1000);
    }
  }

  private findChrome(): string | undefined {
    return findChromePath();
  }
}
