import { existsSync } from 'node:fs';

export type BrowserStatus = 'running' | 'idle' | 'stopped';

export class BrowserManager {
  private context: any = null;
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

  async ensureBrowser(): Promise<any> {
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

    const result = await page.evaluate(
      async ([fetchUrl, fetchInit]: [string, { method?: string; headers?: any; body?: any }]) => {
        const res = await fetch(fetchUrl, {
          method: fetchInit.method || 'GET',
          headers: fetchInit.headers as Record<string, string>,
          body: fetchInit.body as string | undefined,
          credentials: 'include',
        });

        const headers: Record<string, string> = {};
        res.headers.forEach((v: string, k: string) => { headers[k] = v; });
        const text = await res.text();
        return { status: res.status, headers, body: text, ok: res.ok };
      },
      [url, { method: init.method, headers: init.headers, body: init.body }] as const,
    );

    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  }

  async openForLogin(loginUrl: string): Promise<void> {
    const ctx = await this.ensureBrowser();
    const page = await ctx.newPage();
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

    // Wait for user to complete login (up to loginTimeout)
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
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ];

    for (const p of paths) {
      if (existsSync(p)) return p;
    }
    return undefined;
  }
}
