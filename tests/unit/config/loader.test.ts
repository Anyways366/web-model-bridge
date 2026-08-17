import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../../src/config/loader.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Config loader', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `wmb-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns defaults when no config file exists', () => {
    const config = loadConfig({ stateDir: testDir });
    expect(config.server.port).toBe(3456);
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.authToken).toBeNull();
    expect(config.server.openDashboard).toBe(true);
    expect(config.browser.profileDir).toBe(join(testDir, 'chrome-profile'));
    expect(config.browser.startupTimeout).toBe(30000);
    expect(config.browser.idleShutdown).toBe(300);
    expect(config.browser.loginTimeout).toBe(120);
    expect(config.logging.level).toBe('info');
  });

  it('loads and merges YAML config', () => {
    const configPath = join(testDir, 'config.yml');
    writeFileSync(configPath, `
server:
  port: 8080
  authToken: "my-secret"
browser:
  idleShutdown: 60
logging:
  level: debug
`);
    const config = loadConfig({ stateDir: testDir });
    expect(config.server.port).toBe(8080);
    expect(config.server.authToken).toBe('my-secret');
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.browser.idleShutdown).toBe(60);
    expect(config.logging.level).toBe('debug');
  });

  it('CLI overrides take precedence over YAML', () => {
    const configPath = join(testDir, 'config.yml');
    writeFileSync(configPath, `
server:
  port: 8080
`);
    const config = loadConfig({ stateDir: testDir, port: 9999, host: '0.0.0.0' });
    expect(config.server.port).toBe(9999);
    expect(config.server.host).toBe('0.0.0.0');
  });

  it('handles invalid YAML gracefully', () => {
    const configPath = join(testDir, 'config.yml');
    writeFileSync(configPath, ': invalid: yaml: [[[');
    const config = loadConfig({ stateDir: testDir });
    expect(config.server.port).toBe(3456);
  });

  it('resolves profileDir relative to stateDir', () => {
    const config = loadConfig({ stateDir: '/custom/dir' });
    expect(config.browser.profileDir).toBe(join('/custom/dir', 'chrome-profile'));
  });

  it('resolves log file relative to stateDir', () => {
    const config = loadConfig({ stateDir: '/custom/dir' });
    expect(config.logging.file).toBe(join('/custom/dir', 'logs', 'bridge.log'));
  });

  it('providers.enabled defaults to all providers', () => {
    const config = loadConfig({ stateDir: testDir });
    expect(config.providers.enabled).toContain('claude-web');
    expect(config.providers.enabled).toContain('chatgpt-web');
    expect(config.providers.enabled).toContain('deepseek-web');
    expect(config.providers.enabled).toContain('kimi-web');
    expect(config.providers.enabled).toContain('qwen-web');
    expect(config.providers.enabled.length).toBe(11);
  });

  it('authToken override from CLI', () => {
    const config = loadConfig({ stateDir: testDir, authToken: 'cli-token' });
    expect(config.server.authToken).toBe('cli-token');
  });

  it('reads environment variables', () => {
    process.env.WMB_PORT = '9999';
    process.env.WMB_AUTH_TOKEN = 'env-token';
    try {
      const config = loadConfig({ stateDir: testDir });
      expect(config.server.port).toBe(9999);
      expect(config.server.authToken).toBe('env-token');
    } finally {
      delete process.env.WMB_PORT;
      delete process.env.WMB_AUTH_TOKEN;
    }
  });
});
