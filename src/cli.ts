import { program } from 'commander';
import chalk from 'chalk';
import open from 'open';
import { serve } from '@hono/node-server';
import { createApp } from './server.js';
import { loadConfig } from './config/loader.js';
import { ProviderRegistry } from './core/registry.js';
import { AuthStore } from './auth/store.js';
import { BrowserManager } from './browser/manager.js';
import { ClaudeProvider } from './providers/claude/index.js';
import { ChatGPTProvider } from './providers/chatgpt/index.js';
import { DeepSeekProvider } from './providers/deepseek/index.js';
import { KimiProvider } from './providers/kimi-web/index.js';
import { QwenProvider } from './providers/qwen-web/index.js';
import { GLMProvider } from './providers/glm-web/index.js';
import { GrokProvider } from './providers/grok-web/index.js';
import { GeminiProvider } from './providers/gemini-web/index.js';
import { PerplexityProvider } from './providers/perplexity-web/index.js';
import { DoubaoProvider } from './providers/doubao-web/index.js';
import { XiaomimoProvider } from './providers/xiaomimo-web/index.js';
import type { BaseProvider } from './core/provider.js';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createServer } from 'node:net';
import { runDoctor, printDoctorResults, findChromePath } from './doctor.js';

const PROVIDER_MAP: Record<string, new (auth: AuthStore, fetch?: (url: string, init: RequestInit) => Promise<Response>) => BaseProvider> = {
  'claude-web': ClaudeProvider,
  'chatgpt-web': ChatGPTProvider,
  'deepseek-web': DeepSeekProvider,
  'kimi-web': KimiProvider,
  'qwen-web': QwenProvider,
  'glm-web': GLMProvider,
  'grok-web': GrokProvider,
  'gemini-web': GeminiProvider,
  'perplexity-web': PerplexityProvider,
  'doubao-web': DoubaoProvider,
  'xiaomimo-web': XiaomimoProvider,
};

const DEFAULT_STATE_DIR = join(homedir(), '.webmodel');

// ─── Helpers ───

/** Check if a port is available */
function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(port, host);
  });
}

/** Find an available port starting from preferred */
async function findAvailablePort(preferred: number, host: string): Promise<number> {
  for (let port = preferred; port < preferred + 100; port++) {
    if (await isPortAvailable(port, host)) return port;
  }
  throw new Error(`No available port found in range ${preferred}-${preferred + 99}`);
}

/** Check if Chrome is running (any instance) */
function isChromeRunning(): boolean {
  try {
    const os = platform();
    if (os === 'darwin') {
      execSync('pgrep -x "Google Chrome"', { stdio: 'ignore' });
      return true;
    } else if (os === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf-8' });
      return out.includes('chrome.exe');
    } else {
      execSync('pgrep -x "chrome|chromium|google-chrome"', { stdio: 'ignore' });
      return true;
    }
  } catch {
    return false;
  }
}

/** Check if CDP is available */
async function checkCDP(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Try to launch Chrome with debugging port */
async function launchChromeWithCDP(cdpPort: number): Promise<boolean> {
  const chromePath = findChromePath();
  if (!chromePath) return false;

  try {
    const os = platform();
    if (os === 'darwin') {
      execSync(`"${chromePath}" --remote-debugging-port=${cdpPort} &>/dev/null &`, { shell: '/bin/zsh' });
    } else if (os === 'win32') {
      execSync(`start "" "${chromePath}" --remote-debugging-port=${cdpPort}`, { shell: 'cmd.exe' });
    } else {
      execSync(`"${chromePath}" --remote-debugging-port=${cdpPort} &>/dev/null &`, { shell: '/bin/bash' });
    }

    // Wait for CDP to become available (up to 8 seconds)
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await checkCDP(`http://127.0.0.1:${cdpPort}`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Get platform-specific Chrome launch command for display */
function getChromeCommand(port: number): string {
  const os = platform();
  if (os === 'darwin') {
    return `/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${port}`;
  } else if (os === 'win32') {
    return `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=${port}`;
  }
  return `google-chrome --remote-debugging-port=${port}`;
}

// ─── Main ───

program
  .name('web-model-bridge')
  .description('Bridge web AI models through OpenAI-compatible API')
  .version('0.1.0')
  .option('-p, --port <port>', 'listen port', parseInt)
  .option('--host <host>', 'bind address')
  .option('--auth-token <token>', 'require Bearer token for API access')
  .option('--no-open', 'do not open dashboard in browser')
  .option('--state-dir <dir>', 'data directory', DEFAULT_STATE_DIR)
  .option('--config <file>', 'config file path')
  .option('-v, --verbose', 'verbose logging')
  .option('--browser-mode <mode>', 'browser mode: attach (default) or launch', 'attach')
  .option('--cdp-url <url>', 'Chrome CDP URL for attach mode', 'http://127.0.0.1:9222')
  .action(async (opts) => {
    console.log('');

    const stateDir = opts.stateDir;
    mkdirSync(stateDir, { recursive: true });

    // ── Step 1: Environment check ──
    const doctorResults = await runDoctor();
    const hasFatal = doctorResults.some(r => r.status === 'fail');
    if (hasFatal) {
      printDoctorResults(doctorResults);
      console.log(chalk.red('  Cannot start. Please fix the issues above.'));
      process.exit(1);
    }
    if (opts.verbose) {
      printDoctorResults(doctorResults);
    }

    const config = loadConfig({
      stateDir,
      configFile: opts.config,
      port: opts.port,
      host: opts.host,
      authToken: opts.authToken,
      verbose: opts.verbose,
    });

    // ── Step 2: Find available port ──
    let serverPort = config.server.port;
    const serverHost = config.server.host;
    if (!(await isPortAvailable(serverPort, serverHost))) {
      const oldPort = serverPort;
      serverPort = await findAvailablePort(serverPort + 1, serverHost);
      console.log(chalk.yellow(`  ⚠ Port ${oldPort} in use, using ${serverPort} instead`));
    }

    // ── Step 3: Browser setup ──
    const browserMode = (opts.browserMode === 'launch' ? 'launch' : 'attach') as 'attach' | 'launch';
    const cdpPort = parseInt(new URL(opts.cdpUrl).port, 10) || 9222;
    const cdpUrl = opts.cdpUrl;

    if (browserMode === 'attach') {
      const cdpAvailable = await checkCDP(cdpUrl);

      if (cdpAvailable) {
        console.log(chalk.green('  ✓') + ` Chrome CDP connected at ${cdpUrl}`);
      } else {
        // CDP not available — figure out why and try to fix
        const chromeRunning = isChromeRunning();

        if (chromeRunning) {
          // Chrome is running but WITHOUT debugging port
          console.log(chalk.yellow('  ⚠ Chrome is running but without remote debugging port.'));
          console.log(chalk.yellow('    To reuse your existing login sessions:'));
          console.log('');
          console.log(chalk.white('    1. Quit Chrome completely (Cmd+Q / Alt+F4)'));
          console.log(chalk.white('    2. Restart with:'));
          console.log(chalk.cyan(`       ${getChromeCommand(cdpPort)}`));
          console.log('');
          console.log(chalk.gray('    Or use launch mode (separate browser, needs re-login):'));
          console.log(chalk.gray('    web-model-bridge --browser-mode launch'));
          console.log('');
          console.log(chalk.yellow('    Server will start anyway. Login via Dashboard will work in launch mode.'));
          console.log('');
        } else {
          // Chrome not running at all — try to launch it with CDP
          console.log(chalk.gray('  … Chrome not running, launching with debug port...'));

          const launched = await launchChromeWithCDP(cdpPort);
          if (launched) {
            console.log(chalk.green('  ✓') + ` Chrome launched with CDP at port ${cdpPort}`);
          } else {
            console.log(chalk.yellow('  ⚠ Could not auto-launch Chrome with debug port.'));
            console.log(chalk.yellow('    Please start manually:'));
            console.log(chalk.cyan(`    ${getChromeCommand(cdpPort)}`));
            console.log('');
          }
        }
      }
    } else {
      console.log(chalk.green('  ✓') + ' Browser mode: launch (independent Chrome)');
    }

    const browserManager = new BrowserManager({
      profileDir: config.browser.profileDir,
      startupTimeout: config.browser.startupTimeout,
      idleShutdown: config.browser.idleShutdown,
      loginTimeout: config.browser.loginTimeout,
      cdpUrl,
      mode: browserMode,
    });

    // ── Step 4: Register providers ──
    const registry = new ProviderRegistry();
    const authStore = new AuthStore(stateDir);

    const browserFetch = (url: string, init: RequestInit) =>
      browserManager.fetchInBrowser(url, init);

    const enabled = new Set(config.providers.enabled);
    for (const [id, Ctor] of Object.entries(PROVIDER_MAP)) {
      if (enabled.has(id)) {
        registry.register(new Ctor(authStore, browserFetch));
      }
    }

    // ── Step 5: Create and start server ──
    const app = createApp({
      registry,
      authStore,
      authToken: config.server.authToken,
      getBrowserStatus: () => browserManager.getStatus(),
      onLogin: async (providerId: string) => {
        const provider = registry.getProvider(providerId);
        if (!provider) return { status: 'error', message: `Provider "${providerId}" not found.` };

        await browserManager.startLogin(providerId, provider.info.loginUrl, (success) => {
          if (success) {
            authStore.setStatus(providerId, 'active');
            console.log(chalk.green(`  ✓ ${providerId} login completed. Cookies saved.`));
          } else {
            console.log(chalk.yellow(`  ⚠ ${providerId} login did not complete.`));
          }
        });

        return {
          status: 'login_started',
          message: browserMode === 'attach'
            ? 'A new tab opened in your Chrome. Log in and close the tab when done.'
            : 'A Chrome window opened. Log in and close it when done.',
        };
      },
      getLoginState: () => browserManager.getLoginState(),
    });

    serve({
      fetch: app.fetch,
      port: serverPort,
      hostname: serverHost,
    });

    const url = `http://${serverHost === '0.0.0.0' ? 'localhost' : serverHost}:${serverPort}`;

    console.log(chalk.green('  ✓') + ` Server running at ${chalk.cyan(url)}`);
    console.log(chalk.green('  ✓') + ` API Base: ${chalk.cyan(url + '/v1')}`);

    const providerStatuses = await registry.providerStatus();
    const authCount = providerStatuses.filter(p => p.authenticated).length;
    console.log(chalk.green('  ✓') + ` ${providerStatuses.length} providers, ${authCount} authenticated`);

    if (opts.open !== false && config.server.openDashboard) {
      console.log(chalk.green('  ✓') + ` Dashboard: ${chalk.cyan(url)} (opening in browser)`);
      await open(url);
    } else {
      console.log(chalk.green('  ✓') + ` Dashboard: ${chalk.cyan(url)}`);
    }

    if (authCount === 0 && browserMode === 'attach') {
      const cdpNow = await checkCDP(cdpUrl);
      if (cdpNow) {
        console.log('');
        console.log(chalk.green('  ✓ Chrome is connected. Your existing login sessions are available.'));
        console.log(chalk.gray('    Requests will use cookies from your Chrome browser.'));
      }
    }

    console.log('');
    console.log(chalk.gray('  Press Ctrl+C to stop'));
    console.log('');

    process.on('SIGINT', async () => {
      console.log(chalk.gray('\n  Shutting down...'));
      await browserManager.shutdown();
      process.exit(0);
    });
  });

program
  .command('install-service')
  .description('Register as system service (launchd/systemd)')
  .action(() => {
    console.log(chalk.yellow('install-service is planned for Phase 2.'));
  });

program
  .command('uninstall-service')
  .description('Uninstall system service')
  .action(() => {
    console.log(chalk.yellow('uninstall-service is planned for Phase 2.'));
  });

program.parse();
