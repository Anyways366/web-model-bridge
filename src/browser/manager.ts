import type { BrowserContext, Page } from 'playwright-core';
import { findChromePath } from '../doctor.js';

export type BrowserStatus = 'running' | 'idle' | 'stopped';
export type LoginStatus = 'idle' | 'opening' | 'waiting_for_user' | 'success' | 'failed';

export interface LoginState {
  providerId: string | null;
  status: LoginStatus;
  message: string;
  startedAt: number | null;
}

export class BrowserManager {
  private context: BrowserContext | null = null;
  private _status: BrowserStatus = 'stopped';
  private _loginState: LoginState = { providerId: null, status: 'idle', message: '', startedAt: null };
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private profileDir: string,
    private opts: {
      startupTimeout: number;
      idleShutdown: number;
      loginTimeout: number;
    },
  ) {}

  /**
   * Launch Chrome in headless mode for API requests.
   */
  async ensureBrowser(): Promise<BrowserContext> {
    if (this.context) {
      this.resetIdleTimer();
      return this.context;
    }

    const { chromium } = await import('playwright-core');
    const executablePath = this.findChrome();

    if (!executablePath) {
      throw new Error('Chrome not found. Install Google Chrome first.');
    }

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
   * Start login process. This is NON-BLOCKING — it launches a headed Chrome
   * window and returns immediately. The returned Promise resolves when the
   * browser window is opened (not when login completes).
   *
   * Call getLoginState() to check progress. The login completes when the user
   * closes the window or the timeout expires.
   */
  async startLogin(providerId: string, loginUrl: string, onComplete: (success: boolean) => void): Promise<void> {
    if (this._loginState.status === 'opening' || this._loginState.status === 'waiting_for_user') {
      throw new Error(`Login already in progress for ${this._loginState.providerId}. Wait for it to complete or close the browser window.`);
    }

    this._loginState = {
      providerId,
      status: 'opening',
      message: 'Launching Chrome...',
      startedAt: Date.now(),
    };

    try {
      // Close existing headless context — we need a headed one for login
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
      }

      const { chromium } = await import('playwright-core');
      const executablePath = this.findChrome();

      if (!executablePath) {
        this._loginState = { providerId, status: 'failed', message: 'Chrome not found. Install Google Chrome first.', startedAt: null };
        onComplete(false);
        return;
      }

      // Launch in HEADED mode so user can see and interact
      const headedContext = await chromium.launchPersistentContext(this.profileDir, {
        headless: false,
        executablePath,
        args: [
          '--no-first-run',
          '--no-default-browser-check',
        ],
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

      // Wait for user to close the window OR timeout
      // This runs in background — we already returned from startLogin
      const waitForCompletion = async () => {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            page.close().catch(() => {});
            resolve();
          }, this.opts.loginTimeout * 1000);

          page.on('close', () => {
            clearTimeout(timeout);
            resolve();
          });

          // Also listen for context disconnect (user closed entire Chrome)
          headedContext.on('close', () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        // Login window closed — close the headed context and switch back to headless
        await headedContext.close().catch(() => {});
        this.context = null; // Will be re-created as headless on next request

        this._loginState = {
          providerId,
          status: 'success',
          message: `Login completed for ${providerId}. Cookies saved.`,
          startedAt: null,
        };

        onComplete(true);

        // Reset login state after 10 seconds
        setTimeout(() => {
          if (this._loginState.status === 'success') {
            this._loginState = { providerId: null, status: 'idle', message: '', startedAt: null };
          }
        }, 10000);
      };

      // Fire and forget — don't await
      waitForCompletion().catch((err) => {
        this._loginState = {
          providerId,
          status: 'failed',
          message: `Login failed: ${(err as Error).message}`,
          startedAt: null,
        };
        onComplete(false);
      });

    } catch (err) {
      this._loginState = {
        providerId,
        status: 'failed',
        message: `Failed to launch Chrome: ${(err as Error).message}`,
        startedAt: null,
      };
      onComplete(false);
    }
  }

  getLoginState(): LoginState {
    return { ...this._loginState };
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
