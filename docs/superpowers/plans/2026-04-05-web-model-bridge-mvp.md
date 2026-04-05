# web-model-bridge MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `web-model-bridge`, a standalone npm package that exposes web model access (Claude/ChatGPT/DeepSeek) through an OpenAI-compatible HTTP API, with a Web Dashboard for login management and a single-command startup experience.

**Architecture:** Three-layer design — HTTP Layer (Hono routes + Dashboard static files) → Core Layer (ProviderRegistry + Stream Pipeline + OpenAI Formatter) → Infra Layer (BrowserManager with silent Chrome, AuthStore, Config). Providers implement a `BaseProvider` abstract class. All SSE formats normalize to `StreamEvent` before converting to OpenAI `chat.completion.chunk` format.

**Tech Stack:** TypeScript (strict mode, ESM), Hono (HTTP + SSE), playwright-core (Chrome CDP), commander (CLI), js-yaml (config), vitest (testing), tsup (build), msw (HTTP mock)

**Spec:** `docs/superpowers/specs/2026-04-05-web-model-bridge-design.md`

---

## File Structure

```
web-model-bridge/
├── src/
│   ├── cli.ts                         # CLI entry: parse options, start server, open dashboard
│   ├── server.ts                      # Hono app factory: mount all routes + dashboard
│   ├── routes/
│   │   ├── openai-compat.ts           # POST /v1/chat/completions, GET /v1/models
│   │   └── management.ts             # GET /webmodel/providers, POST /webmodel/auth/*, GET /webmodel/health
│   ├── core/
│   │   ├── provider.ts                # BaseProvider abstract class, ProviderInfo, ModelInfo, ChatRequest types
│   │   ├── stream.ts                  # StreamEvent type, StreamPipeline (normalize → tool-calling → openai)
│   │   ├── registry.ts                # ProviderRegistry: register, resolve, allModels, providerStatus
│   │   ├── openai-formatter.ts        # StreamEvent → OpenAI chat.completion.chunk SSE format
│   │   └── errors.ts                  # Error classes + HTTP status mapping
│   ├── providers/
│   │   ├── claude/
│   │   │   ├── index.ts               # ClaudeProvider extends BaseProvider
│   │   │   ├── client.ts              # Claude Web API HTTP client
│   │   │   └── stream.ts             # Claude SSE → StreamEvent normalizer
│   │   ├── chatgpt/
│   │   │   ├── index.ts               # ChatGPTProvider extends BaseProvider
│   │   │   ├── client.ts              # ChatGPT Web API HTTP client
│   │   │   └── stream.ts             # ChatGPT SSE → StreamEvent normalizer
│   │   └── deepseek/
│   │       ├── index.ts               # DeepSeekProvider extends BaseProvider
│   │       ├── client.ts              # DeepSeek Web API HTTP client
│   │       └── stream.ts             # DeepSeek SSE → StreamEvent normalizer
│   ├── browser/
│   │   └── manager.ts                # BrowserManager: silent Chrome, CDP, headed/headless switch
│   ├── auth/
│   │   └── store.ts                  # AuthStore: read/write auth.json, expiry detection
│   ├── config/
│   │   └── loader.ts                 # Load config.yml, merge defaults, CLI overrides
│   └── dashboard/
│       ├── index.html                 # Dashboard SPA page
│       ├── app.js                     # Dashboard JS (fetch providers, trigger login, copy URL)
│       └── style.css                  # Dashboard styling
├── tests/
│   ├── unit/
│   │   ├── core/
│   │   │   ├── stream.test.ts
│   │   │   ├── registry.test.ts
│   │   │   ├── openai-formatter.test.ts
│   │   │   └── errors.test.ts
│   │   ├── routes/
│   │   │   ├── openai-compat.test.ts
│   │   │   └── management.test.ts
│   │   ├── config/
│   │   │   └── loader.test.ts
│   │   └── auth/
│   │       └── store.test.ts
│   ├── integration/
│   │   ├── chat-completions.test.ts
│   │   ├── streaming.test.ts
│   │   ├── auth-flow.test.ts
│   │   ├── error-handling.test.ts
│   │   └── sse-conformance.test.ts
│   └── helpers/
│       ├── mock-provider.ts
│       ├── mock-sse.ts
│       └── test-server.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── tsup.config.ts
```

---

### Task 1: Project Skeleton

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tsup.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Initialize package.json**

```json
{
  "name": "web-model-bridge",
  "version": "0.1.0",
  "description": "Bridge web AI models through OpenAI-compatible API",
  "type": "module",
  "main": "dist/cli.js",
  "bin": {
    "web-model-bridge": "dist/cli.js"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "vitest run tests/e2e",
    "test:watch": "vitest watch",
    "test:coverage": "vitest run --coverage",
    "typecheck": "tsc --noEmit",
    "lint": "tsc --noEmit && vitest run"
  },
  "engines": {
    "node": ">=20"
  },
  "keywords": ["openai", "web-model", "bridge", "proxy", "claude", "chatgpt", "deepseek"],
  "license": "MIT"
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts', 'src/dashboard/**'],
    },
  },
});
```

- [ ] **Step 4: Create tsup.config.ts**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
  external: ['playwright-core'],
});
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
.superpowers/
coverage/
*.log
.DS_Store
```

- [ ] **Step 6: Install dependencies**

Run:
```bash
npm install hono @hono/node-server playwright-core commander js-yaml chalk open
npm install -D typescript vitest tsup tsx @types/node @types/js-yaml msw
```
Expected: Clean install, no errors.

- [ ] **Step 7: Create placeholder src/cli.ts to verify build**

```typescript
console.log('web-model-bridge v0.1.0');
```

- [ ] **Step 8: Verify build and typecheck**

Run:
```bash
npx tsc --noEmit && npx tsup
```
Expected: No errors. `dist/cli.js` created.

- [ ] **Step 9: Verify test runner works**

Create `tests/unit/smoke.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';

describe('smoke test', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run: `npx vitest run tests/unit/smoke.test.ts`
Expected: 1 test passed.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: project skeleton with TypeScript, Vitest, tsup"
```

---

### Task 2: Error Classes and HTTP Mapping

**Files:**
- Create: `src/core/errors.ts`
- Create: `tests/unit/core/errors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/core/errors.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  AuthRequiredError,
  AuthExpiredError,
  InvalidModelError,
  ProviderDisabledError,
  InvalidBodyError,
  InvalidTokenError,
  BrowserUnavailableError,
  UpstreamRateLimitError,
  UpstreamBlockedError,
  TimeoutError,
  errorToHttpResponse,
} from '../../../src/core/errors.js';

describe('Error classes', () => {
  it('AuthRequiredError maps to 401', () => {
    const err = new AuthRequiredError('claude-web');
    const res = errorToHttpResponse(err);
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
    expect(res.body.error.code).toBe('auth_required');
    expect(res.body.error.message).toContain('claude-web');
  });

  it('AuthExpiredError maps to 401', () => {
    const err = new AuthExpiredError('chatgpt-web');
    const res = errorToHttpResponse(err);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('auth_expired');
  });

  it('InvalidModelError maps to 400', () => {
    const err = new InvalidModelError('unknown/model');
    const res = errorToHttpResponse(err);
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
    expect(res.body.error.code).toBe('invalid_model');
  });

  it('ProviderDisabledError maps to 404', () => {
    const err = new ProviderDisabledError('kimi-web');
    const res = errorToHttpResponse(err);
    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe('not_found_error');
    expect(res.body.error.code).toBe('provider_disabled');
  });

  it('InvalidBodyError maps to 400', () => {
    const err = new InvalidBodyError('missing model field');
    const res = errorToHttpResponse(err);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
  });

  it('InvalidTokenError maps to 403', () => {
    const err = new InvalidTokenError();
    const res = errorToHttpResponse(err);
    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('permission_error');
    expect(res.body.error.code).toBe('invalid_token');
  });

  it('BrowserUnavailableError maps to 503', () => {
    const err = new BrowserUnavailableError('Chrome not found');
    const res = errorToHttpResponse(err);
    expect(res.status).toBe(503);
    expect(res.body.error.type).toBe('server_error');
    expect(res.body.error.code).toBe('browser_unavailable');
  });

  it('UpstreamRateLimitError maps to 429', () => {
    const err = new UpstreamRateLimitError('claude-web');
    const res = errorToHttpResponse(err);
    expect(res.status).toBe(429);
    expect(res.body.error.type).toBe('rate_limit_error');
  });

  it('UpstreamBlockedError maps to 502', () => {
    const err = new UpstreamBlockedError('claude-web');
    const res = errorToHttpResponse(err);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('upstream_blocked');
  });

  it('TimeoutError maps to 504', () => {
    const err = new TimeoutError(30000);
    const res = errorToHttpResponse(err);
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('timeout');
  });

  it('Unknown error maps to 500', () => {
    const err = new Error('unexpected');
    const res = errorToHttpResponse(err);
    expect(res.status).toBe(500);
    expect(res.body.error.type).toBe('server_error');
    expect(res.body.error.code).toBe('internal_error');
  });

  it('error response has correct OpenAI shape', () => {
    const err = new AuthRequiredError('test');
    const res = errorToHttpResponse(err);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('message');
    expect(res.body.error).toHaveProperty('type');
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('param', null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/errors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement error classes**

Create `src/core/errors.ts`:
```typescript
export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class AuthRequiredError extends BridgeError {
  constructor(public readonly providerId: string) {
    super(`${providerId} not authenticated. Open Dashboard to login.`);
  }
}

export class AuthExpiredError extends BridgeError {
  constructor(public readonly providerId: string) {
    super(`${providerId} authentication expired. Open Dashboard to re-login.`);
  }
}

export class InvalidModelError extends BridgeError {
  constructor(public readonly modelId: string) {
    super(`Invalid model: "${modelId}". Format: {provider}/{model}`);
  }
}

export class ProviderDisabledError extends BridgeError {
  constructor(public readonly providerId: string) {
    super(`Provider "${providerId}" is not enabled.`);
  }
}

export class InvalidBodyError extends BridgeError {
  constructor(detail: string) {
    super(`Invalid request body: ${detail}`);
  }
}

export class InvalidTokenError extends BridgeError {
  constructor() {
    super('Invalid or missing Bearer token.');
  }
}

export class BrowserUnavailableError extends BridgeError {
  constructor(detail: string) {
    super(`Browser unavailable: ${detail}`);
  }
}

export class UpstreamRateLimitError extends BridgeError {
  constructor(public readonly providerId: string) {
    super(`${providerId} rate limited by upstream.`);
  }
}

export class UpstreamBlockedError extends BridgeError {
  constructor(public readonly providerId: string) {
    super(`${providerId} blocked by upstream (Cloudflare or similar).`);
  }
}

export class TimeoutError extends BridgeError {
  constructor(public readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms.`);
  }
}

interface ErrorResponse {
  status: number;
  body: {
    error: {
      message: string;
      type: string;
      code: string;
      param: null;
    };
  };
}

export function errorToHttpResponse(err: Error): ErrorResponse {
  const base = { param: null as null, message: err.message };

  if (err instanceof AuthRequiredError) {
    return { status: 401, body: { error: { ...base, type: 'authentication_error', code: 'auth_required' } } };
  }
  if (err instanceof AuthExpiredError) {
    return { status: 401, body: { error: { ...base, type: 'authentication_error', code: 'auth_expired' } } };
  }
  if (err instanceof InvalidModelError) {
    return { status: 400, body: { error: { ...base, type: 'invalid_request_error', code: 'invalid_model' } } };
  }
  if (err instanceof ProviderDisabledError) {
    return { status: 404, body: { error: { ...base, type: 'not_found_error', code: 'provider_disabled' } } };
  }
  if (err instanceof InvalidBodyError) {
    return { status: 400, body: { error: { ...base, type: 'invalid_request_error', code: 'invalid_body' } } };
  }
  if (err instanceof InvalidTokenError) {
    return { status: 403, body: { error: { ...base, type: 'permission_error', code: 'invalid_token' } } };
  }
  if (err instanceof BrowserUnavailableError) {
    return { status: 503, body: { error: { ...base, type: 'server_error', code: 'browser_unavailable' } } };
  }
  if (err instanceof UpstreamRateLimitError) {
    return { status: 429, body: { error: { ...base, type: 'rate_limit_error', code: 'upstream_rate_limit' } } };
  }
  if (err instanceof UpstreamBlockedError) {
    return { status: 502, body: { error: { ...base, type: 'server_error', code: 'upstream_blocked' } } };
  }
  if (err instanceof TimeoutError) {
    return { status: 504, body: { error: { ...base, type: 'server_error', code: 'timeout' } } };
  }

  return { status: 500, body: { error: { ...base, type: 'server_error', code: 'internal_error' } } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/errors.test.ts`
Expected: All 12 tests pass.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/errors.ts tests/unit/core/errors.test.ts
git commit -m "feat: error classes with OpenAI-compatible HTTP mapping"
```

---

### Task 3: Config Loader

**Files:**
- Create: `src/config/loader.ts`
- Create: `tests/unit/config/loader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/config/loader.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, defaultConfig, type BridgeConfig } from '../../../src/config/loader.js';
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
    expect(config.server.host).toBe('127.0.0.1'); // default preserved
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
    // Falls back to defaults
    expect(config.server.port).toBe(3456);
  });

  it('resolves profileDir relative to stateDir', () => {
    const config = loadConfig({ stateDir: '/custom/dir' });
    expect(config.browser.profileDir).toBe('/custom/dir/chrome-profile');
  });

  it('resolves log file relative to stateDir', () => {
    const config = loadConfig({ stateDir: '/custom/dir' });
    expect(config.logging.file).toBe('/custom/dir/logs/bridge.log');
  });

  it('providers.enabled defaults to all three MVP providers', () => {
    const config = loadConfig({ stateDir: testDir });
    expect(config.providers.enabled).toEqual([
      'claude-web', 'chatgpt-web', 'deepseek-web',
    ]);
  });

  it('authToken override from CLI', () => {
    const config = loadConfig({ stateDir: testDir, authToken: 'cli-token' });
    expect(config.server.authToken).toBe('cli-token');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/config/loader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement config loader**

Create `src/config/loader.ts`:
```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export interface BridgeConfig {
  server: {
    port: number;
    host: string;
    authToken: string | null;
    openDashboard: boolean;
  };
  browser: {
    profileDir: string;
    startupTimeout: number;
    idleShutdown: number;
    loginTimeout: number;
  };
  providers: {
    enabled: string[];
    defaultModel: string;
  };
  toolCalling: {
    enabled: boolean;
    language: 'auto' | 'zh' | 'en';
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    file: string;
  };
}

export function defaultConfig(stateDir: string): BridgeConfig {
  return {
    server: {
      port: 3456,
      host: '127.0.0.1',
      authToken: null,
      openDashboard: true,
    },
    browser: {
      profileDir: join(stateDir, 'chrome-profile'),
      startupTimeout: 30000,
      idleShutdown: 300,
      loginTimeout: 120,
    },
    providers: {
      enabled: ['claude-web', 'chatgpt-web', 'deepseek-web'],
      defaultModel: 'claude-web/claude-sonnet-4-6',
    },
    toolCalling: {
      enabled: true,
      language: 'auto',
    },
    logging: {
      level: 'info',
      file: join(stateDir, 'logs', 'bridge.log'),
    },
  };
}

interface LoadOptions {
  stateDir: string;
  configFile?: string;
  port?: number;
  host?: string;
  authToken?: string;
  verbose?: boolean;
}

export function loadConfig(opts: LoadOptions): BridgeConfig {
  const config = defaultConfig(opts.stateDir);

  // Load YAML file
  const configPath = opts.configFile ?? join(opts.stateDir, 'config.yml');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(raw);
    if (parsed && typeof parsed === 'object') {
      mergeDeep(config, parsed as Record<string, unknown>);
    }
  } catch {
    // No config file or invalid YAML — use defaults
  }

  // Re-resolve relative paths after YAML merge (YAML might not set them)
  if (!config.browser.profileDir || config.browser.profileDir === defaultConfig('__placeholder__').browser.profileDir) {
    config.browser.profileDir = join(opts.stateDir, 'chrome-profile');
  }
  if (!config.logging.file || config.logging.file === defaultConfig('__placeholder__').logging.file) {
    config.logging.file = join(opts.stateDir, 'logs', 'bridge.log');
  }

  // CLI overrides
  if (opts.port !== undefined) config.server.port = opts.port;
  if (opts.host !== undefined) config.server.host = opts.host;
  if (opts.authToken !== undefined) config.server.authToken = opts.authToken;
  if (opts.verbose) config.logging.level = 'debug';

  return config;
}

function mergeDeep(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      mergeDeep(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else if (srcVal !== undefined) {
      target[key] = srcVal;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/config/loader.test.ts`
Expected: All 8 tests pass.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: No errors.

```bash
git add src/config/loader.ts tests/unit/config/loader.test.ts
git commit -m "feat: config loader with YAML parsing and CLI overrides"
```

---

### Task 4: Auth Store

**Files:**
- Create: `src/auth/store.ts`
- Create: `tests/unit/auth/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/auth/store.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthStore, type ProviderAuthStatus } from '../../../src/auth/store.js';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('AuthStore', () => {
  let testDir: string;
  let store: AuthStore;

  beforeEach(() => {
    testDir = join(tmpdir(), `wmb-auth-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    store = new AuthStore(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns "none" for unknown provider', () => {
    expect(store.getStatus('claude-web')).toEqual({
      providerId: 'claude-web',
      status: 'none',
      lastCheck: null,
    });
  });

  it('sets and gets status', () => {
    store.setStatus('claude-web', 'active');
    const s = store.getStatus('claude-web');
    expect(s.status).toBe('active');
    expect(s.lastCheck).toBeTypeOf('string');
  });

  it('persists to disk and reloads', () => {
    store.setStatus('claude-web', 'active');
    store.setStatus('deepseek-web', 'expired');

    const store2 = new AuthStore(testDir);
    expect(store2.getStatus('claude-web').status).toBe('active');
    expect(store2.getStatus('deepseek-web').status).toBe('expired');
  });

  it('getAllStatuses returns all known providers', () => {
    store.setStatus('claude-web', 'active');
    store.setStatus('chatgpt-web', 'none');
    const all = store.getAllStatuses();
    expect(all).toHaveLength(2);
    expect(all.map(s => s.providerId)).toContain('claude-web');
    expect(all.map(s => s.providerId)).toContain('chatgpt-web');
  });

  it('clearStatus removes a provider', () => {
    store.setStatus('claude-web', 'active');
    store.clearStatus('claude-web');
    expect(store.getStatus('claude-web').status).toBe('none');
  });

  it('setStatus overwrites previous status', () => {
    store.setStatus('claude-web', 'active');
    store.setStatus('claude-web', 'expired');
    expect(store.getStatus('claude-web').status).toBe('expired');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/auth/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement AuthStore**

Create `src/auth/store.ts`:
```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type AuthStatus = 'active' | 'expired' | 'none';

export interface ProviderAuthStatus {
  providerId: string;
  status: AuthStatus;
  lastCheck: string | null;
}

interface AuthData {
  [providerId: string]: {
    status: AuthStatus;
    lastCheck: string;
  };
}

export class AuthStore {
  private data: AuthData;
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, 'auth.json');
    this.data = this.load();
  }

  getStatus(providerId: string): ProviderAuthStatus {
    const entry = this.data[providerId];
    if (!entry) {
      return { providerId, status: 'none', lastCheck: null };
    }
    return { providerId, status: entry.status, lastCheck: entry.lastCheck };
  }

  getAllStatuses(): ProviderAuthStatus[] {
    return Object.keys(this.data).map(id => this.getStatus(id));
  }

  setStatus(providerId: string, status: AuthStatus): void {
    this.data[providerId] = {
      status,
      lastCheck: new Date().toISOString(),
    };
    this.save();
  }

  clearStatus(providerId: string): void {
    delete this.data[providerId];
    this.save();
  }

  private load(): AuthData {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as AuthData;
    } catch {
      return {};
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/auth/store.test.ts`
Expected: All 6 tests pass.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/auth/store.ts tests/unit/auth/store.test.ts
git commit -m "feat: auth store with JSON persistence and status tracking"
```

---

### Task 5: Core Types — BaseProvider, StreamEvent, ChatRequest

**Files:**
- Create: `src/core/provider.ts`
- Create: `src/core/stream.ts`

- [ ] **Step 1: Create BaseProvider and types**

Create `src/core/provider.ts`:
```typescript
export interface ProviderInfo {
  id: string;
  name: string;
  website: string;
  loginUrl: string;
  needsBrowser: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  stream: boolean;
  tools?: ToolDef[];
  signal?: AbortSignal;
}

export abstract class BaseProvider {
  abstract readonly info: ProviderInfo;

  abstract login(context: { openUrl: (url: string) => Promise<void> }): Promise<void>;
  abstract isAuthenticated(): Promise<boolean>;
  abstract detectLoginComplete(): Promise<boolean>;
  abstract models(): Promise<ModelInfo[]>;
  abstract chat(req: ChatRequest): AsyncIterable<StreamEvent>;
}

// Re-export StreamEvent for convenience
export type { StreamEvent } from './stream.js';
```

- [ ] **Step 2: Create StreamEvent types**

Create `src/core/stream.ts`:
```typescript
export type StreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: string }
  | { type: 'done'; reason: 'stop' | 'tool_use' | 'length' }
  | { type: 'error'; message: string; code?: string };
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/core/provider.ts src/core/stream.ts
git commit -m "feat: core types — BaseProvider, StreamEvent, ChatRequest"
```

---

### Task 6: ProviderRegistry

**Files:**
- Create: `src/core/registry.ts`
- Create: `tests/unit/core/registry.test.ts`
- Create: `tests/helpers/mock-provider.ts`

- [ ] **Step 1: Create mock provider helper**

Create `tests/helpers/mock-provider.ts`:
```typescript
import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest } from '../../src/core/provider.js';
import type { StreamEvent } from '../../src/core/stream.js';

export class MockProvider extends BaseProvider {
  readonly info: ProviderInfo;
  private _authenticated: boolean;
  private _models: ModelInfo[];

  constructor(
    id: string,
    opts?: { authenticated?: boolean; models?: ModelInfo[] }
  ) {
    super();
    this.info = {
      id,
      name: `Mock ${id}`,
      website: `https://${id}.example.com`,
      loginUrl: `https://${id}.example.com/login`,
      needsBrowser: true,
    };
    this._authenticated = opts?.authenticated ?? true;
    this._models = opts?.models ?? [
      { id: 'mock-model-1', name: 'Mock Model 1', contextWindow: 100000, maxOutput: 4096 },
    ];
  }

  async login(): Promise<void> {
    this._authenticated = true;
  }

  async isAuthenticated(): Promise<boolean> {
    return this._authenticated;
  }

  async detectLoginComplete(): Promise<boolean> {
    return this._authenticated;
  }

  async models(): Promise<ModelInfo[]> {
    return this._models;
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'text_delta', delta: `Hello from ${this.info.id}` };
    yield { type: 'done', reason: 'stop' };
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/core/registry.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderRegistry } from '../../../src/core/registry.js';
import { MockProvider } from '../../helpers/mock-provider.js';
import { InvalidModelError, ProviderDisabledError } from '../../../src/core/errors.js';

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;
  let claude: MockProvider;
  let deepseek: MockProvider;

  beforeEach(() => {
    registry = new ProviderRegistry();
    claude = new MockProvider('claude-web', {
      authenticated: true,
      models: [
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000, maxOutput: 8192 },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 200000, maxOutput: 8192 },
      ],
    });
    deepseek = new MockProvider('deepseek-web', {
      authenticated: false,
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 64000, maxOutput: 8192 },
      ],
    });
    registry.register(claude);
    registry.register(deepseek);
  });

  it('resolves provider from model ID', () => {
    const result = registry.resolve('claude-web/claude-sonnet-4-6');
    expect(result.provider).toBe(claude);
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('resolves provider with different model', () => {
    const result = registry.resolve('deepseek-web/deepseek-chat');
    expect(result.provider).toBe(deepseek);
    expect(result.model).toBe('deepseek-chat');
  });

  it('throws InvalidModelError for unknown provider', () => {
    expect(() => registry.resolve('unknown/model')).toThrow(InvalidModelError);
  });

  it('throws InvalidModelError for malformed model ID', () => {
    expect(() => registry.resolve('no-slash')).toThrow(InvalidModelError);
  });

  it('throws InvalidModelError for empty string', () => {
    expect(() => registry.resolve('')).toThrow(InvalidModelError);
  });

  it('allModels aggregates from all authenticated providers', async () => {
    const models = await registry.allModels();
    // claude is authenticated (2 models), deepseek is not (0 models)
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('claude-web/claude-sonnet-4-6');
    expect(models[1].id).toBe('claude-web/claude-opus-4-6');
  });

  it('providerStatus returns status for all providers', async () => {
    const statuses = await registry.providerStatus();
    expect(statuses).toHaveLength(2);
    expect(statuses.find(s => s.id === 'claude-web')?.authenticated).toBe(true);
    expect(statuses.find(s => s.id === 'deepseek-web')?.authenticated).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement ProviderRegistry**

Create `src/core/registry.ts`:
```typescript
import { BaseProvider, type ModelInfo } from './provider.js';
import { InvalidModelError } from './errors.js';

export interface ProviderStatus {
  id: string;
  name: string;
  website: string;
  authenticated: boolean;
  modelCount: number;
}

export class ProviderRegistry {
  private providers = new Map<string, BaseProvider>();

  register(provider: BaseProvider): void {
    this.providers.set(provider.info.id, provider);
  }

  resolve(modelId: string): { provider: BaseProvider; model: string } {
    const slashIndex = modelId.indexOf('/');
    if (slashIndex === -1 || slashIndex === 0 || slashIndex === modelId.length - 1) {
      throw new InvalidModelError(modelId);
    }

    const providerId = modelId.slice(0, slashIndex);
    const model = modelId.slice(slashIndex + 1);

    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new InvalidModelError(modelId);
    }

    return { provider, model };
  }

  async allModels(): Promise<(ModelInfo & { id: string })[]> {
    const result: (ModelInfo & { id: string })[] = [];

    for (const [providerId, provider] of this.providers) {
      if (!(await provider.isAuthenticated())) continue;
      const models = await provider.models();
      for (const m of models) {
        result.push({ ...m, id: `${providerId}/${m.id}` });
      }
    }

    return result;
  }

  async providerStatus(): Promise<ProviderStatus[]> {
    const result: ProviderStatus[] = [];

    for (const [, provider] of this.providers) {
      const authenticated = await provider.isAuthenticated();
      let modelCount = 0;
      if (authenticated) {
        modelCount = (await provider.models()).length;
      }
      result.push({
        id: provider.info.id,
        name: provider.info.name,
        website: provider.info.website,
        authenticated,
        modelCount,
      });
    }

    return result;
  }

  getProvider(id: string): BaseProvider | undefined {
    return this.providers.get(id);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/registry.test.ts`
Expected: All 7 tests pass.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/core/registry.ts tests/unit/core/registry.test.ts tests/helpers/mock-provider.ts
git commit -m "feat: ProviderRegistry with model ID routing and status aggregation"
```

---

### Task 7: OpenAI Formatter

**Files:**
- Create: `src/core/openai-formatter.ts`
- Create: `tests/unit/core/openai-formatter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/core/openai-formatter.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  formatStreamChunk,
  formatDoneChunk,
  formatNonStreamResponse,
  formatModelsResponse,
} from '../../../src/core/openai-formatter.js';
import type { StreamEvent } from '../../../src/core/stream.js';
import type { ModelInfo } from '../../../src/core/provider.js';

describe('OpenAI Formatter', () => {
  const modelId = 'claude-web/claude-sonnet-4-6';

  describe('formatStreamChunk', () => {
    it('formats text_delta as chat.completion.chunk', () => {
      const event: StreamEvent = { type: 'text_delta', delta: 'Hello' };
      const chunk = formatStreamChunk('run-1', modelId, event, false);
      expect(chunk.id).toBe('run-1');
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.model).toBe(modelId);
      expect(chunk.choices[0].index).toBe(0);
      expect(chunk.choices[0].delta.content).toBe('Hello');
      expect(chunk.choices[0].finish_reason).toBeNull();
    });

    it('first chunk includes role', () => {
      const event: StreamEvent = { type: 'text_delta', delta: 'Hi' };
      const chunk = formatStreamChunk('run-1', modelId, event, true);
      expect(chunk.choices[0].delta.role).toBe('assistant');
      expect(chunk.choices[0].delta.content).toBe('Hi');
    });

    it('non-first chunk omits role', () => {
      const event: StreamEvent = { type: 'text_delta', delta: 'Hi' };
      const chunk = formatStreamChunk('run-1', modelId, event, false);
      expect(chunk.choices[0].delta).not.toHaveProperty('role');
    });

    it('formats done with finish_reason stop', () => {
      const event: StreamEvent = { type: 'done', reason: 'stop' };
      const chunk = formatStreamChunk('run-1', modelId, event, false);
      expect(chunk.choices[0].finish_reason).toBe('stop');
      expect(chunk.choices[0].delta).toEqual({});
    });

    it('formats done with finish_reason length', () => {
      const event: StreamEvent = { type: 'done', reason: 'length' };
      const chunk = formatStreamChunk('run-1', modelId, event, false);
      expect(chunk.choices[0].finish_reason).toBe('length');
    });

    it('formats done with tool_use as tool_calls', () => {
      const event: StreamEvent = { type: 'done', reason: 'tool_use' };
      const chunk = formatStreamChunk('run-1', modelId, event, false);
      expect(chunk.choices[0].finish_reason).toBe('tool_calls');
    });
  });

  describe('formatDoneChunk', () => {
    it('returns [DONE] string', () => {
      expect(formatDoneChunk()).toBe('[DONE]');
    });
  });

  describe('formatNonStreamResponse', () => {
    it('formats complete response', () => {
      const res = formatNonStreamResponse('run-1', modelId, 'Hello world');
      expect(res.id).toBe('run-1');
      expect(res.object).toBe('chat.completion');
      expect(res.model).toBe(modelId);
      expect(res.choices[0].message.role).toBe('assistant');
      expect(res.choices[0].message.content).toBe('Hello world');
      expect(res.choices[0].finish_reason).toBe('stop');
    });
  });

  describe('formatModelsResponse', () => {
    it('formats model list', () => {
      const models: (ModelInfo & { id: string })[] = [
        { id: 'claude-web/claude-sonnet-4-6', name: 'Claude Sonnet', contextWindow: 200000, maxOutput: 8192 },
        { id: 'deepseek-web/deepseek-chat', name: 'DeepSeek Chat', contextWindow: 64000, maxOutput: 8192 },
      ];
      const res = formatModelsResponse(models);
      expect(res.object).toBe('list');
      expect(res.data).toHaveLength(2);
      expect(res.data[0].id).toBe('claude-web/claude-sonnet-4-6');
      expect(res.data[0].object).toBe('model');
      expect(res.data[0].owned_by).toBe('web-model-bridge');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/openai-formatter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement OpenAI formatter**

Create `src/core/openai-formatter.ts`:
```typescript
import type { StreamEvent } from './stream.js';
import type { ModelInfo } from './provider.js';

interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
}

export function formatStreamChunk(
  runId: string,
  modelId: string,
  event: StreamEvent,
  isFirst: boolean,
): ChatCompletionChunk {
  const base: ChatCompletionChunk = {
    id: runId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  };

  if (event.type === 'text_delta') {
    base.choices[0].delta = isFirst
      ? { role: 'assistant', content: event.delta }
      : { content: event.delta };
  } else if (event.type === 'done') {
    const reason = event.reason === 'tool_use' ? 'tool_calls' : event.reason;
    base.choices[0].finish_reason = reason;
    base.choices[0].delta = {};
  } else if (event.type === 'thinking_delta') {
    // Pass through as content for now (thinking not in OpenAI spec)
    base.choices[0].delta = isFirst
      ? { role: 'assistant', content: event.delta }
      : { content: event.delta };
  }

  return base;
}

export function formatDoneChunk(): string {
  return '[DONE]';
}

interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function formatNonStreamResponse(
  runId: string,
  modelId: string,
  content: string,
): ChatCompletion {
  return {
    id: runId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

interface ModelsResponse {
  object: 'list';
  data: Array<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
  }>;
}

export function formatModelsResponse(
  models: (ModelInfo & { id: string })[],
): ModelsResponse {
  return {
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model' as const,
      created: Math.floor(Date.now() / 1000),
      owned_by: 'web-model-bridge',
    })),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/openai-formatter.test.ts`
Expected: All 9 tests pass.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/core/openai-formatter.ts tests/unit/core/openai-formatter.test.ts
git commit -m "feat: OpenAI formatter for stream chunks and model list"
```

---

### Task 8: HTTP Server + Routes (with Mock Provider)

**Files:**
- Create: `src/server.ts`
- Create: `src/routes/openai-compat.ts`
- Create: `src/routes/management.ts`
- Create: `tests/helpers/test-server.ts`
- Create: `tests/unit/routes/openai-compat.test.ts`
- Create: `tests/unit/routes/management.test.ts`

- [ ] **Step 1: Create test server helper**

Create `tests/helpers/test-server.ts`:
```typescript
import { createApp } from '../../src/server.js';
import { ProviderRegistry } from '../../src/core/registry.js';
import { AuthStore } from '../../src/auth/store.js';
import { MockProvider } from './mock-provider.js';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface TestContext {
  app: ReturnType<typeof createApp>;
  registry: ProviderRegistry;
  authStore: AuthStore;
  stateDir: string;
  cleanup: () => void;
}

export function createTestContext(opts?: {
  authToken?: string;
  providers?: MockProvider[];
}): TestContext {
  const stateDir = join(tmpdir(), `wmb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(stateDir, { recursive: true });

  const registry = new ProviderRegistry();
  const authStore = new AuthStore(stateDir);

  const providers = opts?.providers ?? [
    new MockProvider('claude-web', {
      authenticated: true,
      models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000, maxOutput: 8192 }],
    }),
  ];

  for (const p of providers) {
    registry.register(p);
  }

  const app = createApp({ registry, authStore, authToken: opts?.authToken ?? null });

  return {
    app,
    registry,
    authStore,
    stateDir,
    cleanup: () => rmSync(stateDir, { recursive: true, force: true }),
  };
}
```

- [ ] **Step 2: Write route tests**

Create `tests/unit/routes/openai-compat.test.ts`:
```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/test-server.js';
import { MockProvider } from '../../helpers/mock-provider.js';

describe('POST /v1/chat/completions', () => {
  let ctx: TestContext;

  afterEach(() => ctx?.cleanup());

  it('returns streaming SSE response', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    expect(text).toContain('data: {');
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('Hello from claude-web');
    expect(text).toContain('data: [DONE]');
  });

  it('returns non-streaming JSON response', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toContain('Hello from claude-web');
  });

  it('returns 400 for missing model', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
  });

  it('returns 400 for invalid model ID', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'no-slash',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_model');
  });

  it('returns 401 for unauthenticated provider', async () => {
    ctx = createTestContext({
      providers: [new MockProvider('claude-web', { authenticated: false })],
    });
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('auth_required');
  });

  it('returns 403 when auth token required but not provided', async () => {
    ctx = createTestContext({ authToken: 'secret-123' });
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    expect(res.status).toBe(403);
  });

  it('passes with correct auth token', async () => {
    ctx = createTestContext({ authToken: 'secret-123' });
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer secret-123',
      },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
  });
});

describe('GET /v1/models', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  it('returns model list', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/models');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].id).toBe('claude-web/claude-sonnet-4-6');
    expect(body.data[0].object).toBe('model');
  });
});
```

Create `tests/unit/routes/management.test.ts`:
```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/test-server.js';
import { MockProvider } from '../../helpers/mock-provider.js';

describe('Management endpoints', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  describe('GET /webmodel/providers', () => {
    it('returns provider statuses', async () => {
      ctx = createTestContext({
        providers: [
          new MockProvider('claude-web', { authenticated: true }),
          new MockProvider('deepseek-web', { authenticated: false }),
        ],
      });
      const res = await ctx.app.request('/webmodel/providers');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.providers).toHaveLength(2);
      expect(body.providers.find((p: any) => p.id === 'claude-web').authenticated).toBe(true);
      expect(body.providers.find((p: any) => p.id === 'deepseek-web').authenticated).toBe(false);
    });
  });

  describe('GET /webmodel/health', () => {
    it('returns health status', async () => {
      ctx = createTestContext();
      const res = await ctx.app.request('/webmodel/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('healthy');
      expect(body).toHaveProperty('uptime');
      expect(body).toHaveProperty('providers');
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/unit/routes/`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement server and routes**

Create `src/routes/openai-compat.ts`:
```typescript
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { ProviderRegistry } from '../core/registry.js';
import {
  formatStreamChunk,
  formatDoneChunk,
  formatNonStreamResponse,
  formatModelsResponse,
} from '../core/openai-formatter.js';
import { AuthRequiredError, InvalidBodyError, errorToHttpResponse } from '../core/errors.js';
import type { Message } from '../core/provider.js';
import type { StreamEvent } from '../core/stream.js';

export function openaiRoutes(registry: ProviderRegistry): Hono {
  const app = new Hono();

  app.post('/v1/chat/completions', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      const res = errorToHttpResponse(new InvalidBodyError('invalid JSON'));
      return c.json(res.body, res.status as any);
    }

    if (!body.model || typeof body.model !== 'string') {
      const res = errorToHttpResponse(new InvalidBodyError('missing model field'));
      return c.json(res.body, res.status as any);
    }

    if (!body.messages || !Array.isArray(body.messages)) {
      const res = errorToHttpResponse(new InvalidBodyError('missing messages field'));
      return c.json(res.body, res.status as any);
    }

    let resolved;
    try {
      resolved = registry.resolve(body.model);
    } catch (err) {
      const res = errorToHttpResponse(err as Error);
      return c.json(res.body, res.status as any);
    }

    const { provider, model } = resolved;

    if (!(await provider.isAuthenticated())) {
      const res = errorToHttpResponse(new AuthRequiredError(provider.info.id));
      return c.json(res.body, res.status as any);
    }

    const runId = `wmb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const messages: Message[] = body.messages;
    const isStream = body.stream !== false;

    if (isStream) {
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');

      return stream(c, async (s) => {
        let isFirst = true;
        try {
          for await (const event of provider.chat({ model, messages, stream: true })) {
            const chunk = formatStreamChunk(runId, body.model, event, isFirst);
            await s.write(`data: ${JSON.stringify(chunk)}\n\n`);
            isFirst = false;
          }
          await s.write(`data: ${formatDoneChunk()}\n\n`);
        } catch (err) {
          const errEvent: StreamEvent = {
            type: 'error',
            message: (err as Error).message,
          };
          const chunk = formatStreamChunk(runId, body.model, errEvent, false);
          await s.write(`data: ${JSON.stringify(chunk)}\n\n`);
          await s.write(`data: ${formatDoneChunk()}\n\n`);
        }
      });
    }

    // Non-streaming
    let fullContent = '';
    for await (const event of provider.chat({ model, messages, stream: false })) {
      if (event.type === 'text_delta') {
        fullContent += event.delta;
      }
    }
    return c.json(formatNonStreamResponse(runId, body.model, fullContent));
  });

  app.get('/v1/models', async (c) => {
    const models = await registry.allModels();
    return c.json(formatModelsResponse(models));
  });

  return app;
}
```

Create `src/routes/management.ts`:
```typescript
import { Hono } from 'hono';
import { ProviderRegistry } from '../core/registry.js';
import { AuthStore } from '../auth/store.js';

const startTime = Date.now();

export function managementRoutes(registry: ProviderRegistry, _authStore: AuthStore): Hono {
  const app = new Hono();

  app.get('/webmodel/providers', async (c) => {
    const statuses = await registry.providerStatus();
    return c.json({ providers: statuses });
  });

  app.get('/webmodel/health', async (c) => {
    const statuses = await registry.providerStatus();
    return c.json({
      status: 'healthy',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      providers: Object.fromEntries(
        statuses.map(s => [s.id, { authenticated: s.authenticated, models: s.modelCount }])
      ),
    });
  });

  return app;
}
```

Create `src/server.ts`:
```typescript
import { Hono } from 'hono';
import { openaiRoutes } from './routes/openai-compat.js';
import { managementRoutes } from './routes/management.js';
import { ProviderRegistry } from './core/registry.js';
import { AuthStore } from './auth/store.js';
import { InvalidTokenError, errorToHttpResponse } from './core/errors.js';

interface AppOptions {
  registry: ProviderRegistry;
  authStore: AuthStore;
  authToken: string | null;
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();

  // Auth middleware for /v1/* routes
  if (opts.authToken) {
    app.use('/v1/*', async (c, next) => {
      const authHeader = c.req.header('Authorization');
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (token !== opts.authToken) {
        const res = errorToHttpResponse(new InvalidTokenError());
        return c.json(res.body, res.status as any);
      }
      await next();
    });
  }

  // Mount routes
  app.route('/', openaiRoutes(opts.registry));
  app.route('/', managementRoutes(opts.registry, opts.authStore));

  return app;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/routes/`
Expected: All tests pass (7 openai-compat + 2 management = 9 tests).

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/server.ts src/routes/ tests/unit/routes/ tests/helpers/test-server.ts
git commit -m "feat: HTTP server with OpenAI-compat routes and management endpoints"
```

---

### Task 9: Integration Tests — Streaming and SSE Conformance

**Files:**
- Create: `tests/helpers/mock-sse.ts`
- Create: `tests/integration/streaming.test.ts`
- Create: `tests/integration/sse-conformance.test.ts`

- [ ] **Step 1: Create SSE mock helper**

Create `tests/helpers/mock-sse.ts`:
```typescript
import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest } from '../../src/core/provider.js';
import type { StreamEvent } from '../../src/core/stream.js';

export class DelayedMockProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'delayed-mock',
    name: 'Delayed Mock',
    website: 'https://example.com',
    loginUrl: 'https://example.com/login',
    needsBrowser: false,
  };

  constructor(private chunks: StreamEvent[], private delayMs = 0) {
    super();
  }

  async login(): Promise<void> {}
  async isAuthenticated(): Promise<boolean> { return true; }
  async detectLoginComplete(): Promise<boolean> { return true; }
  async models(): Promise<ModelInfo[]> {
    return [{ id: 'test-model', name: 'Test', contextWindow: 100000, maxOutput: 4096 }];
  }

  async *chat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    for (const chunk of this.chunks) {
      if (this.delayMs > 0) {
        await new Promise(r => setTimeout(r, this.delayMs));
      }
      yield chunk;
    }
  }
}
```

- [ ] **Step 2: Write SSE conformance tests**

Create `tests/integration/sse-conformance.test.ts`:
```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/test-server.js';
import { DelayedMockProvider } from '../helpers/mock-sse.js';

describe('SSE Conformance', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  function makeRequest(app: any, model: string) {
    return app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
    });
  }

  it('Content-Type is text/event-stream', async () => {
    const provider = new DelayedMockProvider([
      { type: 'text_delta', delta: 'Hi' },
      { type: 'done', reason: 'stop' },
    ]);
    ctx = createTestContext({ providers: [provider] });
    const res = await makeRequest(ctx.app, 'delayed-mock/test-model');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  it('each chunk is a complete data: {json} line', async () => {
    const provider = new DelayedMockProvider([
      { type: 'text_delta', delta: 'Hello' },
      { type: 'text_delta', delta: ' world' },
      { type: 'done', reason: 'stop' },
    ]);
    ctx = createTestContext({ providers: [provider] });
    const res = await makeRequest(ctx.app, 'delayed-mock/test-model');
    const text = await res.text();

    const lines = text.split('\n').filter(l => l.startsWith('data: '));
    expect(lines.length).toBe(4); // 2 text + 1 done + 1 [DONE]

    // Each JSON line is parseable
    for (const line of lines) {
      const data = line.slice(6); // remove "data: "
      if (data === '[DONE]') continue;
      const parsed = JSON.parse(data);
      expect(parsed).toHaveProperty('id');
      expect(parsed).toHaveProperty('object', 'chat.completion.chunk');
      expect(parsed).toHaveProperty('choices');
    }
  });

  it('first chunk includes role: assistant', async () => {
    const provider = new DelayedMockProvider([
      { type: 'text_delta', delta: 'Hi' },
      { type: 'done', reason: 'stop' },
    ]);
    ctx = createTestContext({ providers: [provider] });
    const res = await makeRequest(ctx.app, 'delayed-mock/test-model');
    const text = await res.text();

    const firstDataLine = text.split('\n').find(l => l.startsWith('data: {'))!;
    const firstChunk = JSON.parse(firstDataLine.slice(6));
    expect(firstChunk.choices[0].delta.role).toBe('assistant');
  });

  it('last data line before [DONE] has finish_reason', async () => {
    const provider = new DelayedMockProvider([
      { type: 'text_delta', delta: 'Hi' },
      { type: 'done', reason: 'stop' },
    ]);
    ctx = createTestContext({ providers: [provider] });
    const res = await makeRequest(ctx.app, 'delayed-mock/test-model');
    const text = await res.text();

    const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
    const lastJson = dataLines[dataLines.length - 2]; // before [DONE]
    const parsed = JSON.parse(lastJson.slice(6));
    expect(parsed.choices[0].finish_reason).toBe('stop');
  });

  it('ends with data: [DONE]', async () => {
    const provider = new DelayedMockProvider([
      { type: 'text_delta', delta: 'Hi' },
      { type: 'done', reason: 'stop' },
    ]);
    ctx = createTestContext({ providers: [provider] });
    const res = await makeRequest(ctx.app, 'delayed-mock/test-model');
    const text = await res.text();
    expect(text.trimEnd()).toMatch(/data: \[DONE\]$/);
  });

  it('all chunks share the same run ID', async () => {
    const provider = new DelayedMockProvider([
      { type: 'text_delta', delta: 'a' },
      { type: 'text_delta', delta: 'b' },
      { type: 'done', reason: 'stop' },
    ]);
    ctx = createTestContext({ providers: [provider] });
    const res = await makeRequest(ctx.app, 'delayed-mock/test-model');
    const text = await res.text();

    const ids = text.split('\n')
      .filter(l => l.startsWith('data: {'))
      .map(l => JSON.parse(l.slice(6)).id);
    expect(new Set(ids).size).toBe(1);
  });
});
```

- [ ] **Step 3: Write streaming integration test**

Create `tests/integration/streaming.test.ts`:
```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/test-server.js';
import { DelayedMockProvider } from '../helpers/mock-sse.js';
import { MockProvider } from '../helpers/mock-provider.js';

describe('Streaming integration', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  it('streams multiple text deltas correctly', async () => {
    const provider = new DelayedMockProvider([
      { type: 'text_delta', delta: 'Hello' },
      { type: 'text_delta', delta: ' ' },
      { type: 'text_delta', delta: 'world' },
      { type: 'done', reason: 'stop' },
    ]);
    ctx = createTestContext({ providers: [provider] });

    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'delayed-mock/test-model',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
    });

    const text = await res.text();
    const contents = text.split('\n')
      .filter(l => l.startsWith('data: {'))
      .map(l => JSON.parse(l.slice(6)))
      .map(c => c.choices[0].delta.content)
      .filter(Boolean);
    expect(contents.join('')).toBe('Hello world');
  });

  it('non-streaming collects all deltas into one message', async () => {
    const provider = new DelayedMockProvider([
      { type: 'text_delta', delta: 'Hello' },
      { type: 'text_delta', delta: ' world' },
      { type: 'done', reason: 'stop' },
    ]);
    ctx = createTestContext({ providers: [provider] });

    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'delayed-mock/test-model',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
      }),
    });

    const body = await res.json();
    expect(body.choices[0].message.content).toBe('Hello world');
  });

  it('routes to correct provider based on model ID', async () => {
    const claude = new MockProvider('claude-web', { authenticated: true });
    const deepseek = new MockProvider('deepseek-web', { authenticated: true });
    ctx = createTestContext({ providers: [claude, deepseek] });

    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-web/mock-model-1',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
      }),
    });

    const body = await res.json();
    expect(body.choices[0].message.content).toContain('deepseek-web');
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/integration/`
Expected: All tests pass (6 SSE conformance + 3 streaming = 9 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add tests/integration/ tests/helpers/mock-sse.ts
git commit -m "test: integration tests for streaming, SSE conformance, and routing"
```

---

### Task 10: Dashboard Static Files

**Files:**
- Create: `src/dashboard/index.html`
- Create: `src/dashboard/app.js`
- Create: `src/dashboard/style.css`
- Modify: `src/server.ts` — serve dashboard at `/`

- [ ] **Step 1: Create Dashboard HTML**

Create `src/dashboard/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>web-model-bridge</title>
  <link rel="stylesheet" href="/dashboard/style.css">
</head>
<body>
  <div class="container">
    <header>
      <h1>web-model-bridge</h1>
      <p class="subtitle">Dashboard</p>
    </header>

    <section class="api-url">
      <label>API Base URL</label>
      <div class="url-box">
        <code id="api-url"></code>
        <button onclick="copyUrl()" id="copy-btn">Copy</button>
      </div>
    </section>

    <section class="providers">
      <h2>Providers</h2>
      <div id="provider-list">Loading...</div>
    </section>

    <section class="stats">
      <h2>Status</h2>
      <div id="health-info">Loading...</div>
    </section>
  </div>
  <script src="/dashboard/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create Dashboard JS**

Create `src/dashboard/app.js`:
```javascript
const apiUrl = `${window.location.origin}/v1`;
document.getElementById('api-url').textContent = apiUrl;

async function copyUrl() {
  await navigator.clipboard.writeText(apiUrl);
  const btn = document.getElementById('copy-btn');
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
}

async function loadProviders() {
  try {
    const res = await fetch('/webmodel/providers');
    const data = await res.json();
    const list = document.getElementById('provider-list');
    if (!data.providers || data.providers.length === 0) {
      list.innerHTML = '<p class="empty">No providers configured.</p>';
      return;
    }
    list.innerHTML = data.providers.map(p => `
      <div class="provider-card ${p.authenticated ? 'active' : 'inactive'}">
        <div class="provider-info">
          <span class="status-dot ${p.authenticated ? 'green' : 'red'}"></span>
          <strong>${p.name}</strong>
          <span class="provider-id">${p.id}</span>
        </div>
        <div class="provider-action">
          ${p.authenticated
            ? `<span class="model-count">${p.modelCount} models</span>`
            : `<button onclick="loginProvider('${p.id}')" class="login-btn">Login</button>`
          }
        </div>
      </div>
    `).join('');
  } catch (err) {
    document.getElementById('provider-list').innerHTML =
      `<p class="error">Failed to load: ${err.message}</p>`;
  }
}

async function loginProvider(providerId) {
  try {
    const res = await fetch('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId }),
    });
    const data = await res.json();
    if (data.status === 'login_started') {
      alert(`Login window opened for ${providerId}. Complete login in the browser window, then this page will refresh.`);
      // Poll for completion
      pollLogin(providerId);
    }
  } catch (err) {
    alert(`Login failed: ${err.message}`);
  }
}

async function pollLogin(providerId) {
  const interval = setInterval(async () => {
    const res = await fetch('/webmodel/providers');
    const data = await res.json();
    const provider = data.providers.find(p => p.id === providerId);
    if (provider && provider.authenticated) {
      clearInterval(interval);
      loadProviders();
      loadHealth();
    }
  }, 2000);
  // Stop polling after 2 minutes
  setTimeout(() => clearInterval(interval), 120000);
}

async function loadHealth() {
  try {
    const res = await fetch('/webmodel/health');
    const data = await res.json();
    const el = document.getElementById('health-info');
    const uptime = formatUptime(data.uptime);
    el.innerHTML = `
      <div class="health-grid">
        <div class="health-item">
          <span class="health-label">Status</span>
          <span class="health-value ${data.status}">${data.status}</span>
        </div>
        <div class="health-item">
          <span class="health-label">Uptime</span>
          <span class="health-value">${uptime}</span>
        </div>
      </div>
    `;
  } catch {
    document.getElementById('health-info').innerHTML = '<p class="error">Unable to reach server</p>';
  }
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// Initial load + auto-refresh every 10s
loadProviders();
loadHealth();
setInterval(() => { loadProviders(); loadHealth(); }, 10000);
```

- [ ] **Step 3: Create Dashboard CSS**

Create `src/dashboard/style.css`:
```css
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #0d1117;
  color: #c9d1d9;
  min-height: 100vh;
}

.container {
  max-width: 720px;
  margin: 0 auto;
  padding: 40px 20px;
}

header { margin-bottom: 32px; }
header h1 { font-size: 24px; color: #f0f6fc; }
header .subtitle { color: #8b949e; margin-top: 4px; }

h2 { font-size: 16px; color: #f0f6fc; margin-bottom: 12px; }

.api-url { margin-bottom: 32px; }
.api-url label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
.url-box {
  display: flex; align-items: center; gap: 8px;
  margin-top: 8px; padding: 12px 16px;
  background: #161b22; border: 1px solid #30363d; border-radius: 8px;
}
.url-box code { flex: 1; font-size: 14px; color: #58a6ff; }
.url-box button {
  padding: 6px 16px; background: #238636; color: #fff;
  border: none; border-radius: 6px; cursor: pointer; font-size: 13px;
}
.url-box button:hover { background: #2ea043; }

.provider-card {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 16px; margin-bottom: 8px;
  background: #161b22; border: 1px solid #30363d; border-radius: 8px;
}
.provider-info { display: flex; align-items: center; gap: 10px; }
.provider-id { color: #8b949e; font-size: 12px; }
.status-dot {
  width: 8px; height: 8px; border-radius: 50%; display: inline-block;
}
.status-dot.green { background: #3fb950; }
.status-dot.red { background: #f85149; }
.model-count { color: #8b949e; font-size: 13px; }
.login-btn {
  padding: 4px 12px; background: #1f6feb; color: #fff;
  border: none; border-radius: 6px; cursor: pointer; font-size: 13px;
}
.login-btn:hover { background: #388bfd; }

.health-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.health-item {
  padding: 12px 16px;
  background: #161b22; border: 1px solid #30363d; border-radius: 8px;
}
.health-label { display: block; font-size: 12px; color: #8b949e; margin-bottom: 4px; }
.health-value { font-size: 18px; font-weight: 600; }
.health-value.healthy { color: #3fb950; }

.empty, .error { color: #8b949e; font-style: italic; }
.error { color: #f85149; }
```

- [ ] **Step 4: Add dashboard serving to server.ts**

Add to `src/server.ts` — add static file serving for dashboard:

```typescript
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { openaiRoutes } from './routes/openai-compat.js';
import { managementRoutes } from './routes/management.js';
import { ProviderRegistry } from './core/registry.js';
import { AuthStore } from './auth/store.js';
import { InvalidTokenError, errorToHttpResponse } from './core/errors.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface AppOptions {
  registry: ProviderRegistry;
  authStore: AuthStore;
  authToken: string | null;
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();

  // Auth middleware for /v1/* routes
  if (opts.authToken) {
    app.use('/v1/*', async (c, next) => {
      const authHeader = c.req.header('Authorization');
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (token !== opts.authToken) {
        const res = errorToHttpResponse(new InvalidTokenError());
        return c.json(res.body, res.status as any);
      }
      await next();
    });
  }

  // Dashboard
  app.get('/', (c) => {
    try {
      const html = readFileSync(join(__dirname, 'dashboard', 'index.html'), 'utf-8');
      return c.html(html);
    } catch {
      return c.text('Dashboard not found', 404);
    }
  });

  app.get('/dashboard/:file', (c) => {
    const file = c.req.param('file');
    const ext = file.split('.').pop();
    const contentType = ext === 'js' ? 'application/javascript'
      : ext === 'css' ? 'text/css'
      : 'text/plain';
    try {
      const content = readFileSync(join(__dirname, 'dashboard', file), 'utf-8');
      return c.text(content, 200, { 'Content-Type': contentType });
    } catch {
      return c.text('Not found', 404);
    }
  });

  // Mount API routes
  app.route('/', openaiRoutes(opts.registry));
  app.route('/', managementRoutes(opts.registry, opts.authStore));

  return app;
}
```

- [ ] **Step 5: Update tsup to copy dashboard files**

Update `tsup.config.ts`:
```typescript
import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
  external: ['playwright-core'],
  onSuccess: async () => {
    // Copy dashboard static files
    const dashDir = join('dist', 'dashboard');
    mkdirSync(dashDir, { recursive: true });
    for (const file of ['index.html', 'app.js', 'style.css']) {
      copyFileSync(join('src', 'dashboard', file), join(dashDir, file));
    }
  },
});
```

- [ ] **Step 6: Verify build and tests still pass**

Run:
```bash
npx tsc --noEmit && npx vitest run
```
Expected: All tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/ src/server.ts tsup.config.ts
git commit -m "feat: Web Dashboard with provider status, login trigger, and API URL copy"
```

---

### Task 11: CLI Entry Point

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Implement CLI**

Overwrite `src/cli.ts`:
```typescript
import { program } from 'commander';
import chalk from 'chalk';
import open from 'open';
import { serve } from '@hono/node-server';
import { createApp } from './server.js';
import { loadConfig } from './config/loader.js';
import { ProviderRegistry } from './core/registry.js';
import { AuthStore } from './auth/store.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
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

    // TODO: Register real providers here (Task 12-14)

    const app = createApp({
      registry,
      authStore,
      authToken: config.server.authToken,
    });

    const server = serve({
      fetch: app.fetch,
      port: config.server.port,
      hostname: config.server.host,
    });

    const url = `http://${config.server.host === '0.0.0.0' ? 'localhost' : config.server.host}:${config.server.port}`;

    console.log('');
    console.log(chalk.green('  ✓') + ` Server running at ${chalk.cyan(url)}`);
    console.log(chalk.green('  ✓') + ` API Base: ${chalk.cyan(url + '/v1')}`);

    if (opts.open !== false && config.server.openDashboard) {
      console.log(chalk.green('  ✓') + ` Dashboard: ${chalk.cyan(url)} (opening in browser)`);
      await open(url);
    } else {
      console.log(chalk.green('  ✓') + ` Dashboard: ${chalk.cyan(url)}`);
    }

    console.log('');
    console.log(chalk.gray('  Press Ctrl+C to stop'));
    console.log('');
  });

// Subcommand: install-service
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
```

- [ ] **Step 2: Verify build**

Run:
```bash
npx tsc --noEmit && npx tsup
```
Expected: No errors.

- [ ] **Step 3: Verify CLI runs**

Run:
```bash
node dist/cli.js --help
```
Expected: Shows usage info with options.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat: CLI entry point with single-command startup"
```

---

### Task 12: DeepSeek Provider (First Real Provider — Simplest)

DeepSeek is the simplest provider (no Cloudflare, standard SSE format). Implement it first to validate the full pipeline.

**Files:**
- Create: `src/providers/deepseek/index.ts`
- Create: `src/providers/deepseek/client.ts`
- Create: `src/providers/deepseek/stream.ts`
- Create: `tests/unit/providers/deepseek-stream.test.ts`

- [ ] **Step 1: Write stream normalizer test**

Create `tests/unit/providers/deepseek-stream.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { normalizeDeepSeekSSE } from '../../../src/providers/deepseek/stream.js';
import type { StreamEvent } from '../../../src/core/stream.js';

describe('DeepSeek stream normalizer', () => {
  it('parses text delta from standard SSE', () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hello"}}]}';
    const events = normalizeDeepSeekSSE(line);
    expect(events).toEqual([{ type: 'text_delta', delta: 'Hello' }]);
  });

  it('parses done signal', () => {
    const line = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}';
    const events = normalizeDeepSeekSSE(line);
    expect(events).toEqual([{ type: 'done', reason: 'stop' }]);
  });

  it('ignores [DONE] marker', () => {
    const events = normalizeDeepSeekSSE('data: [DONE]');
    expect(events).toEqual([]);
  });

  it('ignores empty lines', () => {
    const events = normalizeDeepSeekSSE('');
    expect(events).toEqual([]);
  });

  it('ignores non-data lines', () => {
    const events = normalizeDeepSeekSSE('event: ping');
    expect(events).toEqual([]);
  });

  it('handles empty content delta', () => {
    const line = 'data: {"choices":[{"delta":{"content":""}}]}';
    const events = normalizeDeepSeekSSE(line);
    expect(events).toEqual([]); // Skip empty deltas
  });

  it('handles malformed JSON gracefully', () => {
    const line = 'data: {invalid json}}}';
    const events = normalizeDeepSeekSSE(line);
    expect(events).toEqual([]); // Skip, don't crash
  });

  it('handles finish_reason length', () => {
    const line = 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}';
    const events = normalizeDeepSeekSSE(line);
    expect(events).toEqual([{ type: 'done', reason: 'length' }]);
  });

  it('handles reasoning_content (thinking)', () => {
    const line = 'data: {"choices":[{"delta":{"reasoning_content":"Let me think..."}}]}';
    const events = normalizeDeepSeekSSE(line);
    expect(events).toEqual([{ type: 'thinking_delta', delta: 'Let me think...' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/providers/deepseek-stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement DeepSeek stream normalizer**

Create `src/providers/deepseek/stream.ts`:
```typescript
import type { StreamEvent } from '../../core/stream.js';

export function normalizeDeepSeekSSE(line: string): StreamEvent[] {
  if (!line.startsWith('data: ')) return [];
  const data = line.slice(6);
  if (data === '[DONE]') return [];

  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }

  const events: StreamEvent[] = [];
  const choice = parsed.choices?.[0];
  if (!choice) return [];

  if (choice.finish_reason) {
    const reason = choice.finish_reason === 'length' ? 'length' : 'stop';
    events.push({ type: 'done', reason });
    return events;
  }

  const delta = choice.delta;
  if (!delta) return [];

  if (delta.reasoning_content) {
    events.push({ type: 'thinking_delta', delta: delta.reasoning_content });
  }

  if (delta.content && delta.content.length > 0) {
    events.push({ type: 'text_delta', delta: delta.content });
  }

  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/providers/deepseek-stream.test.ts`
Expected: All 9 tests pass.

- [ ] **Step 5: Implement DeepSeek client and provider**

Create `src/providers/deepseek/client.ts`:
```typescript
export interface DeepSeekChatOptions {
  model: string;
  prompt: string;
  cookie: string;
  signal?: AbortSignal;
}

export async function deepseekChatStream(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  opts: DeepSeekChatOptions,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetchFn('https://chat.deepseek.com/api/v0/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': opts.cookie,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [{ role: 'user', content: opts.prompt }],
      stream: true,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    throw new Error(`DeepSeek API returned ${res.status}`);
  }

  if (!res.body) {
    throw new Error('No response body');
  }

  return res.body;
}
```

Create `src/providers/deepseek/index.ts`:
```typescript
import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { normalizeDeepSeekSSE } from './stream.js';
import { AuthStore } from '../../auth/store.js';

export class DeepSeekProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'deepseek-web',
    name: 'DeepSeek Web',
    website: 'https://chat.deepseek.com',
    loginUrl: 'https://chat.deepseek.com/sign_in',
    needsBrowser: true,
  };

  constructor(
    private authStore: AuthStore,
    private browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
  ) {
    super();
  }

  async login(context: { openUrl: (url: string) => Promise<void> }): Promise<void> {
    await context.openUrl(this.info.loginUrl);
  }

  async isAuthenticated(): Promise<boolean> {
    return this.authStore.getStatus(this.info.id).status === 'active';
  }

  async detectLoginComplete(): Promise<boolean> {
    // Will be implemented with BrowserManager — check for session cookie
    return false;
  }

  async models(): Promise<ModelInfo[]> {
    return [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 64000, maxOutput: 8192 },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextWindow: 64000, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    const cookie = ''; // Will come from BrowserManager
    const prompt = req.messages.map(m => m.content).join('\n');

    const response = await this.browserFetch('https://chat.deepseek.com/api/v0/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: true,
      }),
    });

    if (!response.body) {
      yield { type: 'error', message: 'No response body' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const events = normalizeDeepSeekSSE(trimmed);
        for (const event of events) {
          yield event;
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      const events = normalizeDeepSeekSSE(buffer.trim());
      for (const event of events) {
        yield event;
      }
    }
  }
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/providers/deepseek/ tests/unit/providers/
git commit -m "feat: DeepSeek provider with SSE stream normalization"
```

---

### Task 13: Claude Provider

**Files:**
- Create: `src/providers/claude/index.ts`
- Create: `src/providers/claude/client.ts`
- Create: `src/providers/claude/stream.ts`
- Create: `tests/unit/providers/claude-stream.test.ts`

- [ ] **Step 1: Write stream normalizer test**

Create `tests/unit/providers/claude-stream.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { normalizeClaudeSSE } from '../../../src/providers/claude/stream.js';

describe('Claude stream normalizer', () => {
  it('parses content_block_delta text', () => {
    const line = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}';
    const events = normalizeClaudeSSE(line);
    expect(events).toEqual([{ type: 'text_delta', delta: 'Hello' }]);
  });

  it('parses message_stop', () => {
    const line = 'data: {"type":"message_stop"}';
    const events = normalizeClaudeSSE(line);
    expect(events).toEqual([{ type: 'done', reason: 'stop' }]);
  });

  it('parses message_delta with stop_reason', () => {
    const line = 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}';
    const events = normalizeClaudeSSE(line);
    expect(events).toEqual([{ type: 'done', reason: 'stop' }]);
  });

  it('parses message_delta with max_tokens', () => {
    const line = 'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}';
    const events = normalizeClaudeSSE(line);
    expect(events).toEqual([{ type: 'done', reason: 'length' }]);
  });

  it('ignores message_start', () => {
    const line = 'data: {"type":"message_start","message":{}}';
    const events = normalizeClaudeSSE(line);
    expect(events).toEqual([]);
  });

  it('ignores content_block_start', () => {
    const line = 'data: {"type":"content_block_start","content_block":{}}';
    const events = normalizeClaudeSSE(line);
    expect(events).toEqual([]);
  });

  it('handles thinking delta', () => {
    const line = 'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Let me..."}}';
    const events = normalizeClaudeSSE(line);
    expect(events).toEqual([{ type: 'thinking_delta', delta: 'Let me...' }]);
  });

  it('ignores [DONE]', () => {
    expect(normalizeClaudeSSE('data: [DONE]')).toEqual([]);
  });

  it('ignores empty lines', () => {
    expect(normalizeClaudeSSE('')).toEqual([]);
  });

  it('handles malformed JSON', () => {
    expect(normalizeClaudeSSE('data: broken{{')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/providers/claude-stream.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Claude stream normalizer**

Create `src/providers/claude/stream.ts`:
```typescript
import type { StreamEvent } from '../../core/stream.js';

export function normalizeClaudeSSE(line: string): StreamEvent[] {
  if (!line.startsWith('data: ')) return [];
  const data = line.slice(6);
  if (data === '[DONE]') return [];

  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }

  const type = parsed.type;

  if (type === 'content_block_delta') {
    const delta = parsed.delta;
    if (delta?.type === 'text_delta' && delta.text) {
      return [{ type: 'text_delta', delta: delta.text }];
    }
    if (delta?.type === 'thinking_delta' && delta.thinking) {
      return [{ type: 'thinking_delta', delta: delta.thinking }];
    }
  }

  if (type === 'message_stop') {
    return [{ type: 'done', reason: 'stop' }];
  }

  if (type === 'message_delta') {
    const stopReason = parsed.delta?.stop_reason;
    if (stopReason === 'max_tokens') {
      return [{ type: 'done', reason: 'length' }];
    }
    if (stopReason) {
      return [{ type: 'done', reason: 'stop' }];
    }
  }

  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/providers/claude-stream.test.ts`
Expected: All 10 tests pass.

- [ ] **Step 5: Implement Claude client and provider**

Create `src/providers/claude/client.ts`:
```typescript
export interface ClaudeChatOptions {
  organizationId: string;
  conversationId?: string;
  model: string;
  prompt: string;
  cookie: string;
  signal?: AbortSignal;
}

export const CLAUDE_WEB_BASE_URL = 'https://claude.ai';

export async function createClaudeConversation(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  cookie: string,
  organizationId: string,
): Promise<string> {
  const res = await fetchFn(`${CLAUDE_WEB_BASE_URL}/api/organizations/${organizationId}/chat_conversations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie,
    },
    body: JSON.stringify({ name: '' }),
  });

  if (!res.ok) throw new Error(`Failed to create conversation: ${res.status}`);
  const data = await res.json() as { uuid: string };
  return data.uuid;
}
```

Create `src/providers/claude/index.ts`:
```typescript
import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { normalizeClaudeSSE } from './stream.js';
import { CLAUDE_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';

export class ClaudeProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'claude-web',
    name: 'Claude Web',
    website: 'https://claude.ai',
    loginUrl: 'https://claude.ai/login',
    needsBrowser: true,
  };

  constructor(
    private authStore: AuthStore,
    private browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
  ) {
    super();
  }

  async login(context: { openUrl: (url: string) => Promise<void> }): Promise<void> {
    await context.openUrl(this.info.loginUrl);
  }

  async isAuthenticated(): Promise<boolean> {
    return this.authStore.getStatus(this.info.id).status === 'active';
  }

  async detectLoginComplete(): Promise<boolean> {
    return false; // Will be implemented with BrowserManager
  }

  async models(): Promise<ModelInfo[]> {
    return [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000, maxOutput: 8192 },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 200000, maxOutput: 8192 },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200000, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    // Claude Web API requires browser-context fetch with cookies
    // The actual URL and body format will be refined during E2E testing
    const response = await this.browserFetch(
      `${CLAUDE_WEB_BASE_URL}/api/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
        }),
      }
    );

    if (!response.body) {
      yield { type: 'error', message: 'No response body' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const events = normalizeClaudeSSE(trimmed);
        for (const event of events) {
          yield event;
        }
      }
    }

    if (buffer.trim()) {
      const events = normalizeClaudeSSE(buffer.trim());
      for (const event of events) {
        yield event;
      }
    }
  }
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/providers/claude/ tests/unit/providers/claude-stream.test.ts
git commit -m "feat: Claude provider with SSE stream normalization"
```

---

### Task 14: ChatGPT Provider

**Files:**
- Create: `src/providers/chatgpt/index.ts`
- Create: `src/providers/chatgpt/client.ts`
- Create: `src/providers/chatgpt/stream.ts`
- Create: `tests/unit/providers/chatgpt-stream.test.ts`

- [ ] **Step 1: Write stream normalizer test**

Create `tests/unit/providers/chatgpt-stream.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { normalizeChatGPTSSE } from '../../../src/providers/chatgpt/stream.js';

describe('ChatGPT stream normalizer', () => {
  it('parses text delta', () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hello"}}]}';
    const events = normalizeChatGPTSSE(line);
    expect(events).toEqual([{ type: 'text_delta', delta: 'Hello' }]);
  });

  it('parses done with finish_reason stop', () => {
    const line = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}';
    const events = normalizeChatGPTSSE(line);
    expect(events).toEqual([{ type: 'done', reason: 'stop' }]);
  });

  it('parses done with finish_reason length', () => {
    const line = 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}';
    const events = normalizeChatGPTSSE(line);
    expect(events).toEqual([{ type: 'done', reason: 'length' }]);
  });

  it('ignores [DONE]', () => {
    expect(normalizeChatGPTSSE('data: [DONE]')).toEqual([]);
  });

  it('ignores empty lines', () => {
    expect(normalizeChatGPTSSE('')).toEqual([]);
  });

  it('handles malformed JSON', () => {
    expect(normalizeChatGPTSSE('data: {bad}')).toEqual([]);
  });

  it('skips empty content', () => {
    const line = 'data: {"choices":[{"delta":{"content":""}}]}';
    expect(normalizeChatGPTSSE(line)).toEqual([]);
  });

  it('parses role-only delta (first chunk)', () => {
    const line = 'data: {"choices":[{"delta":{"role":"assistant"}}]}';
    const events = normalizeChatGPTSSE(line);
    expect(events).toEqual([]); // Role-only deltas have no content to emit
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/providers/chatgpt-stream.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement ChatGPT stream normalizer**

Create `src/providers/chatgpt/stream.ts`:
```typescript
import type { StreamEvent } from '../../core/stream.js';

export function normalizeChatGPTSSE(line: string): StreamEvent[] {
  if (!line.startsWith('data: ')) return [];
  const data = line.slice(6);
  if (data === '[DONE]') return [];

  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }

  const choice = parsed.choices?.[0];
  if (!choice) return [];

  if (choice.finish_reason) {
    const reason = choice.finish_reason === 'length' ? 'length' : 'stop';
    return [{ type: 'done', reason }];
  }

  const delta = choice.delta;
  if (!delta) return [];

  if (delta.content && delta.content.length > 0) {
    return [{ type: 'text_delta', delta: delta.content }];
  }

  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/providers/chatgpt-stream.test.ts`
Expected: All 8 tests pass.

- [ ] **Step 5: Implement ChatGPT client and provider**

Create `src/providers/chatgpt/client.ts`:
```typescript
export const CHATGPT_WEB_BASE_URL = 'https://chatgpt.com';
```

Create `src/providers/chatgpt/index.ts`:
```typescript
import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { normalizeChatGPTSSE } from './stream.js';
import { CHATGPT_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';

export class ChatGPTProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'chatgpt-web',
    name: 'ChatGPT Web',
    website: 'https://chatgpt.com',
    loginUrl: 'https://chatgpt.com/auth/login',
    needsBrowser: true,
  };

  constructor(
    private authStore: AuthStore,
    private browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
  ) {
    super();
  }

  async login(context: { openUrl: (url: string) => Promise<void> }): Promise<void> {
    await context.openUrl(this.info.loginUrl);
  }

  async isAuthenticated(): Promise<boolean> {
    return this.authStore.getStatus(this.info.id).status === 'active';
  }

  async detectLoginComplete(): Promise<boolean> {
    return false; // Will be implemented with BrowserManager
  }

  async models(): Promise<ModelInfo[]> {
    return [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxOutput: 4096 },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000, maxOutput: 4096 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    const response = await this.browserFetch(
      `${CHATGPT_WEB_BASE_URL}/backend-api/conversation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages.map(m => ({
            author: { role: m.role },
            content: { content_type: 'text', parts: [m.content] },
          })),
        }),
      }
    );

    if (!response.body) {
      yield { type: 'error', message: 'No response body' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const events = normalizeChatGPTSSE(trimmed);
        for (const event of events) {
          yield event;
        }
      }
    }

    if (buffer.trim()) {
      const events = normalizeChatGPTSSE(buffer.trim());
      for (const event of events) {
        yield event;
      }
    }
  }
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/providers/chatgpt/ tests/unit/providers/chatgpt-stream.test.ts
git commit -m "feat: ChatGPT provider with SSE stream normalization"
```

---

### Task 15: BrowserManager — Silent Chrome with Login Window

**Files:**
- Create: `src/browser/manager.ts`

This task creates the BrowserManager. It uses playwright-core for CDP connection. Full E2E testing requires a real Chrome installation, so this task focuses on the implementation and type safety. E2E tests are in a later task.

- [ ] **Step 1: Implement BrowserManager**

Create `src/browser/manager.ts`:
```typescript
import type { Browser, BrowserContext, Page } from 'playwright-core';

export type BrowserStatus = 'running' | 'idle' | 'stopped';

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private status: BrowserStatus = 'stopped';
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

    // Try to find Chrome
    const executablePath = this.findChrome();

    this.browser = await chromium.launchPersistentContext(this.profileDir, {
      headless: true,
      executablePath,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
      ],
      timeout: this.opts.startupTimeout,
    }) as unknown as Browser;

    // launchPersistentContext returns BrowserContext directly
    this.context = this.browser as unknown as BrowserContext;
    this.status = 'running';
    this.resetIdleTimer();

    return this.context;
  }

  async fetch(url: string, init: RequestInit): Promise<Response> {
    const ctx = await this.ensureBrowser();
    const page = ctx.pages()[0] || await ctx.newPage();

    // Execute fetch in browser context to carry cookies
    const result = await page.evaluate(
      async ([fetchUrl, fetchInit]) => {
        const res = await fetch(fetchUrl, {
          method: fetchInit.method || 'GET',
          headers: fetchInit.headers as Record<string, string>,
          body: fetchInit.body as string | undefined,
          credentials: 'include',
        });

        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => { headers[k] = v; });

        // For streaming, we need to read the body
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

  async getCookies(domain: string): Promise<{ name: string; value: string }[]> {
    const ctx = await this.ensureBrowser();
    const cookies = await ctx.cookies();
    return cookies
      .filter(c => c.domain.includes(domain))
      .map(c => ({ name: c.name, value: c.value }));
  }

  async openForLogin(loginUrl: string): Promise<{ page: Page; waitForClose: () => Promise<void> }> {
    const ctx = await this.ensureBrowser();

    // Open a new page for login (browser should be visible for login)
    const page = await ctx.newPage();
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

    return {
      page,
      waitForClose: () => new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          page.close().catch(() => {});
          resolve();
        }, this.opts.loginTimeout * 1000);

        page.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      }),
    };
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.context = null;
    }
    this.status = 'stopped';
  }

  getStatus(): BrowserStatus {
    return this.status;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.opts.idleShutdown > 0) {
      this.idleTimer = setTimeout(() => {
        this.status = 'idle';
        this.shutdown();
      }, this.opts.idleShutdown * 1000);
    }
  }

  private findChrome(): string | undefined {
    const paths = [
      // macOS
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      // Linux
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ];

    const { existsSync } = require('node:fs');
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
    return undefined; // Let Playwright find it
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/browser/manager.ts
git commit -m "feat: BrowserManager with silent Chrome, login window, and idle shutdown"
```

---

### Task 16: Wire Everything Together — Register Providers in CLI

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/routes/management.ts` — add login endpoint

- [ ] **Step 1: Add login endpoint to management routes**

Update `src/routes/management.ts` to add `POST /webmodel/auth/login`:
```typescript
import { Hono } from 'hono';
import { ProviderRegistry } from '../core/registry.js';
import { AuthStore } from '../auth/store.js';
import { BrowserManager } from '../browser/manager.js';

const startTime = Date.now();

export function managementRoutes(
  registry: ProviderRegistry,
  authStore: AuthStore,
  browserManager?: BrowserManager,
): Hono {
  const app = new Hono();

  app.get('/webmodel/providers', async (c) => {
    const statuses = await registry.providerStatus();
    return c.json({ providers: statuses });
  });

  app.post('/webmodel/auth/login', async (c) => {
    const body = await c.req.json<{ providerId: string }>();
    const provider = registry.getProvider(body.providerId);
    if (!provider) {
      return c.json({ error: 'Unknown provider' }, 404);
    }

    if (!browserManager) {
      return c.json({ error: 'Browser not available' }, 503);
    }

    // Open login window
    try {
      const { page, waitForClose } = await browserManager.openForLogin(provider.info.loginUrl);

      // Don't await — let it run in background
      waitForClose().then(async () => {
        // Check if login was successful by checking cookies
        const authenticated = await provider.detectLoginComplete();
        if (authenticated) {
          authStore.setStatus(provider.info.id, 'active');
        }
      });

      return c.json({ status: 'login_started', providerId: body.providerId });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/webmodel/auth/check', async (c) => {
    const body = await c.req.json<{ providerId: string }>();
    const status = authStore.getStatus(body.providerId);
    return c.json(status);
  });

  app.post('/webmodel/auth/logout', async (c) => {
    const body = await c.req.json<{ providerId: string }>();
    authStore.clearStatus(body.providerId);
    return c.json({ status: 'logged_out', providerId: body.providerId });
  });

  app.get('/webmodel/health', async (c) => {
    const statuses = await registry.providerStatus();
    return c.json({
      status: 'healthy',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      browser: {
        status: browserManager?.getStatus() ?? 'stopped',
      },
      providers: Object.fromEntries(
        statuses.map(s => [s.id, { authenticated: s.authenticated, models: s.modelCount }])
      ),
    });
  });

  return app;
}
```

- [ ] **Step 2: Update server.ts to pass browserManager**

Update `src/server.ts` — add `browserManager` to `AppOptions` and pass to `managementRoutes`:

```typescript
import { Hono } from 'hono';
import { openaiRoutes } from './routes/openai-compat.js';
import { managementRoutes } from './routes/management.js';
import { ProviderRegistry } from './core/registry.js';
import { AuthStore } from './auth/store.js';
import { BrowserManager } from './browser/manager.js';
import { InvalidTokenError, errorToHttpResponse } from './core/errors.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface AppOptions {
  registry: ProviderRegistry;
  authStore: AuthStore;
  authToken: string | null;
  browserManager?: BrowserManager;
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();

  // Auth middleware for /v1/* routes
  if (opts.authToken) {
    app.use('/v1/*', async (c, next) => {
      const authHeader = c.req.header('Authorization');
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (token !== opts.authToken) {
        const res = errorToHttpResponse(new InvalidTokenError());
        return c.json(res.body, res.status as any);
      }
      await next();
    });
  }

  // Dashboard
  app.get('/', (c) => {
    try {
      const html = readFileSync(join(__dirname, 'dashboard', 'index.html'), 'utf-8');
      return c.html(html);
    } catch {
      return c.text('Dashboard not found', 404);
    }
  });

  app.get('/dashboard/:file', (c) => {
    const file = c.req.param('file');
    const ext = file.split('.').pop();
    const contentType = ext === 'js' ? 'application/javascript'
      : ext === 'css' ? 'text/css'
      : 'text/plain';
    try {
      const content = readFileSync(join(__dirname, 'dashboard', file), 'utf-8');
      return c.text(content, 200, { 'Content-Type': contentType });
    } catch {
      return c.text('Not found', 404);
    }
  });

  // Mount API routes
  app.route('/', openaiRoutes(opts.registry));
  app.route('/', managementRoutes(opts.registry, opts.authStore, opts.browserManager));

  return app;
}
```

- [ ] **Step 3: Update CLI to register providers and BrowserManager**

Update `src/cli.ts` — register the 3 real providers:
```typescript
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

    // BrowserManager
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
      browserManager,
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
    console.log(chalk.green('  ✓') + ` ${providerStatuses.length} providers configured, ${authCount} authenticated`);

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

    // Graceful shutdown
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
```

- [ ] **Step 4: Update test helpers for new managementRoutes signature**

Update `tests/helpers/test-server.ts` — pass `undefined` as browserManager:
The `managementRoutes` now accepts optional `browserManager`, existing tests should still work since it's optional.

- [ ] **Step 5: Run all tests**

Run:
```bash
npx tsc --noEmit && npx vitest run
```
Expected: All tests pass, no type errors.

- [ ] **Step 6: Build and verify**

Run:
```bash
npx tsup && node dist/cli.js --help
```
Expected: Clean build, help output shows correctly.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts src/server.ts src/routes/management.ts
git commit -m "feat: wire providers, BrowserManager, and login endpoint together"
```

---

### Task 17: Final Integration Tests — Error Handling

**Files:**
- Create: `tests/integration/error-handling.test.ts`
- Create: `tests/integration/auth-flow.test.ts`

- [ ] **Step 1: Write error handling integration tests**

Create `tests/integration/error-handling.test.ts`:
```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/test-server.js';
import { MockProvider } from '../helpers/mock-provider.js';

describe('Error handling integration', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  it('returns 400 for missing messages', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-web/claude-sonnet-4-6' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
  });

  it('returns 400 for invalid JSON body', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 for unauthenticated provider', async () => {
    ctx = createTestContext({
      providers: [new MockProvider('test-provider', { authenticated: false })],
    });
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-provider/model',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe('authentication_error');
  });

  it('returns 403 with wrong Bearer token', async () => {
    ctx = createTestContext({ authToken: 'correct-token' });
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-token',
      },
      body: JSON.stringify({
        model: 'claude-web/claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_token');
  });

  it('returns 400 for unknown provider in model ID', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'nonexistent/model',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_model');
  });

  it('GET /v1/models returns only authenticated provider models', async () => {
    ctx = createTestContext({
      providers: [
        new MockProvider('auth-provider', { authenticated: true, models: [
          { id: 'model-1', name: 'Model 1', contextWindow: 100000, maxOutput: 4096 },
        ]}),
        new MockProvider('unauth-provider', { authenticated: false, models: [
          { id: 'model-2', name: 'Model 2', contextWindow: 100000, maxOutput: 4096 },
        ]}),
      ],
    });
    const res = await ctx.app.request('/v1/models');
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('auth-provider/model-1');
  });
});
```

Create `tests/integration/auth-flow.test.ts`:
```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/test-server.js';
import { MockProvider } from '../helpers/mock-provider.js';

describe('Auth flow integration', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  it('GET /webmodel/providers shows auth status', async () => {
    ctx = createTestContext({
      providers: [
        new MockProvider('p1', { authenticated: true }),
        new MockProvider('p2', { authenticated: false }),
      ],
    });
    const res = await ctx.app.request('/webmodel/providers');
    const body = await res.json();
    expect(body.providers).toHaveLength(2);
    const p1 = body.providers.find((p: any) => p.id === 'p1');
    const p2 = body.providers.find((p: any) => p.id === 'p2');
    expect(p1.authenticated).toBe(true);
    expect(p2.authenticated).toBe(false);
  });

  it('GET /webmodel/health includes provider status', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/webmodel/health');
    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(body).toHaveProperty('uptime');
    expect(body).toHaveProperty('providers');
    expect(body).toHaveProperty('browser');
  });

  it('POST /webmodel/auth/login returns 503 without browser', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'claude-web' }),
    });
    expect(res.status).toBe(503);
  });

  it('POST /webmodel/auth/login returns 404 for unknown provider', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'nonexistent' }),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/integration/`
Expected: All integration tests pass.

- [ ] **Step 3: Run full test suite**

Run:
```bash
npx tsc --noEmit && npx vitest run
```
Expected: All tests pass (unit + integration), no type errors.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/error-handling.test.ts tests/integration/auth-flow.test.ts
git commit -m "test: integration tests for error handling and auth flow"
```

---

### Task 18: Final Build Verification and Cleanup

**Files:**
- Remove: `tests/unit/smoke.test.ts` (no longer needed)

- [ ] **Step 1: Remove smoke test**

```bash
rm tests/unit/smoke.test.ts
```

- [ ] **Step 2: Run complete verification**

Run all checks in sequence:
```bash
npx tsc --noEmit && npx vitest run && npx tsup
```
Expected:
- TypeScript: zero errors
- Tests: all pass
- Build: `dist/cli.js` + `dist/dashboard/` created

- [ ] **Step 3: Verify built CLI**

Run:
```bash
node dist/cli.js --version
node dist/cli.js --help
```
Expected: Shows `0.1.0` and help text.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: cleanup and final build verification — MVP complete"
```

- [ ] **Step 5: Run full test suite one more time**

Run: `npx vitest run --reporter=verbose`
Expected: All tests listed, all pass. Document the count for reference.
