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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const DEFAULT_STATE_DIR = join(homedir(), '.webmodel');

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
  .action(async (opts) => {
    const stateDir = opts.stateDir;
    mkdirSync(stateDir, { recursive: true });

    const config = loadConfig({
      stateDir,
      configFile: opts.config,
      port: opts.port,
      host: opts.host,
      authToken: opts.authToken,
      verbose: opts.verbose,
    });

    const registry = new ProviderRegistry();
    const authStore = new AuthStore(stateDir);

    const browserManager = new BrowserManager(config.browser.profileDir, {
      startupTimeout: config.browser.startupTimeout,
      idleShutdown: config.browser.idleShutdown,
      loginTimeout: config.browser.loginTimeout,
    });

    // Register providers
    const enabled = new Set(config.providers.enabled);
    if (enabled.has('claude-web')) {
      registry.register(new ClaudeProvider(authStore));
    }
    if (enabled.has('chatgpt-web')) {
      registry.register(new ChatGPTProvider(authStore));
    }
    if (enabled.has('deepseek-web')) {
      registry.register(new DeepSeekProvider(authStore));
    }

    const app = createApp({
      registry,
      authStore,
      authToken: config.server.authToken,
      onLogin: async (providerId: string) => {
        const provider = registry.getProvider(providerId);
        if (!provider) return { status: 'error' };
        await browserManager.openForLogin(provider.info.loginUrl);
        const ok = await provider.detectLoginComplete();
        if (ok) authStore.setStatus(providerId, 'active');
        return { status: 'login_started' };
      },
    });

    serve({
      fetch: app.fetch,
      port: config.server.port,
      hostname: config.server.host,
    });

    const url = `http://${config.server.host === '0.0.0.0' ? 'localhost' : config.server.host}:${config.server.port}`;

    console.log('');
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

    if (authCount === 0) {
      console.log('');
      console.log(chalk.yellow('  No providers authenticated yet.'));
      console.log(chalk.yellow(`  Open the Dashboard to login → ${url}`));
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
