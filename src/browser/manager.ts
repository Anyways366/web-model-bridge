import type { Browser, BrowserContext, Page } from 'playwright-core';
import { findChromePath } from '../doctor.js';
import { platform } from 'node:os';

export type BrowserStatus = 'running' | 'idle' | 'stopped';
export type BrowserMode = 'attach' | 'launch';
export type LoginStatus = 'idle' | 'opening' | 'waiting_for_user' | 'success' | 'failed';

export interface LoginState {
  providerId: string | null;
  status: LoginStatus;
  message: string;
  startedAt: number | null;
}

export interface BrowserManagerOptions {
  profileDir: string;
  startupTimeout: number;
  idleShutdown: number;
  loginTimeout: number;
  cdpUrl?: string;        // e.g. "http://127.0.0.1:9222"
  mode?: BrowserMode;     // "attach" (default) | "launch"
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private _status: BrowserStatus = 'stopped';
  private _mode: BrowserMode;
  private _loginState: LoginState = { providerId: null, status: 'idle', message: '', startedAt: null };
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: BrowserManagerOptions) {
    this._mode = opts.mode ?? 'attach';
  }

  /**
   * Connect to browser. In attach mode, connects to existing Chrome via CDP.
   * In launch mode, launches a new persistent context.
   */
  async ensureBrowser(): Promise<BrowserContext> {
    if (this.context) {
      this.resetIdleTimer();
      return this.context;
    }

    const { chromium } = await import('playwright-core');

    if (this._mode === 'attach') {
      const cdpUrl = this.opts.cdpUrl ?? 'http://127.0.0.1:9222';
      try {
        this.browser = await chromium.connectOverCDP(cdpUrl, {
          timeout: this.opts.startupTimeout,
        });
        const contexts = this.browser.contexts();
        this.context = contexts[0] ?? await this.browser.newContext();
        this._status = 'running';
        this.resetIdleTimer();
        return this.context;
      } catch (err) {
        const errorMsg = (err as Error).message;
        // Provide helpful error message
        if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('connect')) {
          throw new Error(
            `Cannot connect to Chrome at ${cdpUrl}.\n\n` +
            `To use web-model-bridge, Chrome needs to run with remote debugging enabled:\n\n` +
            this.getChromeStartCommand() +
            `\n\nOr switch to launch mode: web-model-bridge --browser-mode launch`
          );
        }
        throw err;
      }
    }

    // Launch mode — start new Chrome with persistent profile
    const executablePath = this.findChrome();
    if (!executablePath) {
      throw new Error('Chrome not found. Install Google Chrome first.');
    }

    this.context = await chromium.launchPersistentContext(this.opts.profileDir, {
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

  // Cache: domain → page (avoid re-navigating for same domain)
  private domainPages = new Map<string, Page>();

  /**
   * Get a page navigated to the target origin (cached per domain).
   */
  async getPageForOrigin(origin: string): Promise<Page> {
    const ctx = await this.ensureBrowser();

    let page = this.domainPages.get(origin);
    if (page && page.isClosed()) {
      this.domainPages.delete(origin);
      page = undefined;
    }

    if (!page) {
      page = await ctx.newPage();
      try {
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch {
        try {
          await page.goto(origin + '/', { waitUntil: 'commit', timeout: 10000 });
        } catch {
          // Page is now on the right domain even if load didn't fully complete
        }
      }
      this.domainPages.set(origin, page);
    }

    return page;
  }

  /**
   * Execute arbitrary code in browser context on a specific domain.
   */
  async evaluateOnDomain<T>(origin: string, fn: string, args?: unknown): Promise<T> {
    const page = await this.getPageForOrigin(origin);
    return page.evaluate(fn as any, args as any) as Promise<T>;
  }

  /**
   * Execute fetch in browser context. Navigates to the target domain first
   * so that cookies are available and CORS is not an issue.
   */
  async fetchInBrowser(url: string, init: RequestInit): Promise<Response> {
    const targetOrigin = new URL(url).origin;
    const page = await this.getPageForOrigin(targetOrigin);

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

  /**
   * In attach mode: login is not needed — user already logged in.
   * In launch mode: open headed Chrome for login.
   */
  async startLogin(providerId: string, loginUrl: string, onComplete: (success: boolean) => void): Promise<void> {
    if (this._mode === 'attach') {
      // In attach mode, just open a new tab in the user's existing Chrome
      try {
        const ctx = await this.ensureBrowser();
        const page = await ctx.newPage();

        this._loginState = {
          providerId,
          status: 'waiting_for_user',
          message: `Opened ${loginUrl} in your Chrome. Log in and close the tab when done.`,
          startedAt: Date.now(),
        };

        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: this.opts.startupTimeout });

        // Wait for user to close the tab
        const waitDone = async () => {
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

          this._loginState = {
            providerId,
            status: 'success',
            message: `Login completed for ${providerId}.`,
            startedAt: null,
          };
          onComplete(true);

          setTimeout(() => {
            if (this._loginState.status === 'success') {
              this._loginState = { providerId: null, status: 'idle', message: '', startedAt: null };
            }
          }, 10000);
        };

        waitDone().catch(() => {
          this._loginState = { providerId, status: 'failed', message: 'Login tab closed unexpectedly.', startedAt: null };
          onComplete(false);
        });

      } catch (err) {
        this._loginState = {
          providerId,
          status: 'failed',
          message: `Failed: ${(err as Error).message}`,
          startedAt: null,
        };
        onComplete(false);
      }
      return;
    }

    // Launch mode — same as before: open headed Chrome
    if (this._loginState.status === 'opening' || this._loginState.status === 'waiting_for_user') {
      throw new Error(`Login already in progress for ${this._loginState.providerId}.`);
    }

    this._loginState = { providerId, status: 'opening', message: 'Launching Chrome...', startedAt: Date.now() };

    try {
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
      }

      const { chromium } = await import('playwright-core');
      const executablePath = this.findChrome();
      if (!executablePath) {
        this._loginState = { providerId, status: 'failed', message: 'Chrome not found.', startedAt: null };
        onComplete(false);
        return;
      }

      const headedContext = await chromium.launchPersistentContext(this.opts.profileDir, {
        headless: false,
        executablePath,
        args: ['--no-first-run', '--no-default-browser-check'],
        timeout: this.opts.startupTimeout,
      });

      const page: Page = await headedContext.newPage();

      this._loginState = {
        providerId,
        status: 'waiting_for_user',
        message: `Chrome window opened. Please log in at ${loginUrl}`,
        startedAt: Date.now(),
      };

      await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

      const waitForCompletion = async () => {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            page.close().catch(() => {});
            resolve();
          }, this.opts.loginTimeout * 1000);

          page.on('close', () => { clearTimeout(timeout); resolve(); });
          headedContext.on('close', () => { clearTimeout(timeout); resolve(); });
        });

        await headedContext.close().catch(() => {});
        this.context = null;

        this._loginState = { providerId, status: 'success', message: `Login completed for ${providerId}.`, startedAt: null };
        onComplete(true);

        setTimeout(() => {
          if (this._loginState.status === 'success') {
            this._loginState = { providerId: null, status: 'idle', message: '', startedAt: null };
          }
        }, 10000);
      };

      waitForCompletion().catch((err) => {
        this._loginState = { providerId, status: 'failed', message: `Login failed: ${(err as Error).message}`, startedAt: null };
        onComplete(false);
      });

    } catch (err) {
      this._loginState = { providerId, status: 'failed', message: `Failed: ${(err as Error).message}`, startedAt: null };
      onComplete(false);
    }
  }

  /**
   * Auto-detect which providers have valid cookies in the connected browser.
   * Returns a map of providerId → true for providers with cookies.
   */
  async autoDetectAuth(): Promise<Record<string, boolean>> {
    // Each provider's key session cookie that indicates a valid login
    const SESSION_COOKIES: Record<string, { domain: string; cookieNames: string[] }> = {
      'claude-web': { domain: 'claude.ai', cookieNames: ['sessionKey'] },
      'chatgpt-web': { domain: 'chatgpt.com', cookieNames: ['__Secure-next-auth.session-token', '__Secure-next-auth.session-token.0'] },
      'deepseek-web': { domain: 'deepseek.com', cookieNames: ['ds_session_id', 'token'] },
      'kimi-web': { domain: 'moonshot.cn', cookieNames: ['access_token'] },
      'qwen-web': { domain: 'qwen.ai', cookieNames: ['cna', 'ajs_anonymous_id'] },
      'glm-web': { domain: 'chatglm.cn', cookieNames: ['chatglm_refresh_token'] },
      'grok-web': { domain: 'grok.com', cookieNames: ['sso', 'ct0'] },
      'gemini-web': { domain: 'google.com', cookieNames: ['SID', '__Secure-1PSID'] },
      'perplexity-web': { domain: 'perplexity.ai', cookieNames: ['__Secure-next-auth.session-token', 'next-auth.session-token'] },
      'doubao-web': { domain: 'doubao.com', cookieNames: ['sessionid'] },
      'xiaomimo-web': { domain: 'xiaomimimo.com', cookieNames: ['sessionid', 'token'] },
    };

    const result: Record<string, boolean> = {};

    try {
      const ctx = await this.ensureBrowser();
      const cookies = await ctx.cookies();

      for (const [providerId, config] of Object.entries(SESSION_COOKIES)) {
        const domainCookies = cookies.filter(c => c.domain.includes(config.domain));
        // Check if any of the expected session cookies exist
        const hasSession = config.cookieNames.some(name =>
          domainCookies.some(c => c.name === name && c.value.length > 0)
        );
        result[providerId] = hasSession;
      }
    } catch {
      // Browser not available
    }

    return result;
  }

  getLoginState(): LoginState {
    return { ...this._loginState };
  }

  getMode(): BrowserMode {
    return this._mode;
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.domainPages.clear();
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
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

  /**
   * Try to detect if Chrome is already running with remote debugging.
   */
  async detectCDP(cdpUrl?: string): Promise<boolean> {
    const url = cdpUrl ?? this.opts.cdpUrl ?? 'http://127.0.0.1:9222';
    try {
      const res = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private getChromeStartCommand(): string {
    const chromePath = this.findChrome();
    const os = platform();

    if (os === 'darwin') {
      return `  # macOS:\n  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n\n  # Or create an alias in ~/.zshrc:\n  alias chrome-debug='/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222'`;
    }
    if (os === 'win32') {
      return `  # Windows (PowerShell):\n  & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222`;
    }
    // Linux
    const bin = chromePath ?? 'google-chrome';
    return `  # Linux:\n  ${bin} --remote-debugging-port=9222`;
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
