# web-model-bridge 设计文档

> 独立中间件，作为使用 Web 模型的桥梁。将 openclaw-zero-token 的 Web 模型访问能力抽取为轻量 HTTP 服务，对外暴露 OpenAI 兼容 API。
>
> 对应 Issue: [openclaw-zero-token#176](https://github.com/linuxhsj/openclaw-zero-token/issues/176)

## 1. 背景与目标

openclaw-zero-token 已实现通过浏览器自动化访问 13 个 Web 模型（Claude、ChatGPT、DeepSeek 等），实现"零 token 消耗"。但该能力深度耦合在 OpenClaw 的 gateway/agent/channel 体系中，第三方工具无法直接使用。

**目标**：将 Web 模型访问能力抽取为独立的 npm 包 `web-model-bridge`，任何支持 OpenAI API 的客户端（Claude Code、Cursor、Open WebUI、LobeChat、OpenClaw 等）只需配置一个 base URL 即可接入。

### 1.1 设计决策总结

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 目标消费者 | 兼顾 OpenClaw 和第三方工具 | 最大化复用价值 |
| 功能范围 | 完整复刻 zero-token 能力 | 包含 tool-calling、认证管理、模型发现等 |
| 浏览器方案 | 专用 Chrome 实例（bb-browser 模式） | 用户登录一次后自动复用，无需手动启 CDP |
| 部署形态 | CLI 为主 + 可选系统服务 | 开发用 CLI，日常用系统服务常驻 |
| 数据目录 | 默认 `~/.webmodel/`，可配指向 `~/.openclaw/` | 独立解耦，兼容迁移 |
| 发布方式 | npm 全局包 | 目标用户必有 Node.js，支持 npx 试用 |
| 包名 | `web-model-bridge` | 明确"桥梁"定位 |
| API 兼容性 | OpenAI 为主 + 扩展管理端点 | 通用兼容 + 必要的管理能力 |
| 架构方式 | 渐进式（干净接口 + 搬运实现） | 兼顾开发速度和架构质量 |

## 2. 整体架构

### 2.1 分层架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        客户端 (Consumers)                        │
│  Claude Code │ Cursor │ Open WebUI │ LobeChat │ OpenClaw │ ... │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP (OpenAI 兼容)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    web-model-bridge 服务                          │
│                                                                   │
│  ┌─────────────────── HTTP Layer ──────────────────────────┐    │
│  │  POST /v1/chat/completions    (聊天补全)                  │    │
│  │  GET  /v1/models              (模型列表)                  │    │
│  │  GET  /webmodel/providers     (Provider 状态)            │    │
│  │  POST /webmodel/auth/check    (认证检查)                  │    │
│  │  GET  /webmodel/health        (健康检查)                  │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                          │                                       │
│  ┌─────────────── Core Layer ──────────────────────────────┐    │
│  │  Router ──→ 根据 model ID 路由到对应 Provider            │    │
│  │  Provider Registry (统一接口)                             │    │
│  │  Stream Pipeline (标准化 → 工具调用 → OpenAI 格式)       │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                          │                                       │
│  ┌─────────────── Infra Layer ─────────────────────────────┐    │
│  │  BrowserManager (专用 Chrome)                             │    │
│  │  AuthStore (认证元数据)                                    │    │
│  │  Config (YAML 配置)                                       │    │
│  └──────────────────────┬──────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────┘
                           │ CDP WebSocket
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  专用 Chrome 实例 (Profile: ~/.webmodel/chrome-profile/)         │
│  已登录: claude.ai, chatgpt.com, chat.deepseek.com, ...         │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 请求数据流

```
POST /v1/chat/completions
{"model":"claude-web/claude-sonnet-4-6", "messages":[...], "stream":true}
  │
  ▼
① HTTP 层：解析请求体，提取 model/messages/stream/tools
  │
  ▼
② Router：从 model ID 解析 provider="claude-web", model="claude-sonnet-4-6"
  │
  ▼
③ Provider Registry：查找 ClaudeProvider，检查 isAuthenticated()
  │
  ▼
④ ClaudeProvider.chat()：加载凭证，构建 Claude Web API 请求
  │
  ▼
⑤ BrowserManager.fetch()：通过 CDP 在浏览器上下文中执行 fetch
  │
  ▼
⑥ Stream Pipeline：
   raw SSE → StreamNormalizer → ToolCallingMiddleware → OpenAIFormatter
  │
  ▼
⑦ SSE 响应: data: {"choices":[{"delta":{"content":"..."}}]} ... data: [DONE]
```

## 3. 核心接口

### 3.1 BaseProvider

所有 Web 模型 Provider 的统一抽象：

```typescript
interface ProviderInfo {
  id: string;           // "claude-web"
  name: string;         // "Claude Web"
  website: string;      // "https://claude.ai"
  needsBrowser: boolean; // true = 需要 Chrome 执行请求
}

interface ModelInfo {
  id: string;           // "claude-sonnet-4-6"
  name: string;         // "Claude Sonnet 4.6"
  contextWindow: number; // 200000
  maxOutput: number;    // 8192
}

interface ChatRequest {
  model: string;
  messages: Message[];
  stream: boolean;
  tools?: ToolDef[];
  signal?: AbortSignal;
}

abstract class BaseProvider {
  abstract info: ProviderInfo;
  abstract login(browser: BrowserContext): Promise<void>;
  abstract isAuthenticated(): Promise<boolean>;
  abstract models(): Promise<ModelInfo[]>;
  abstract chat(req: ChatRequest): AsyncIterable<StreamEvent>;
}
```

### 3.2 StreamEvent

统一的内部事件协议，隔离各站点私有 SSE 格式：

```typescript
type StreamEvent =
  | { type: "text_delta";     delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_call";      id: string; name: string; args: string }
  | { type: "done";           reason: "stop" | "tool_use" | "length" }
  | { type: "error";          message: string; code?: string };
```

各站点到 StreamEvent 的映射：
- Claude: `data.delta.text` → `text_delta`
- ChatGPT: `choices[0].delta.content` → `text_delta`
- DeepSeek: `choices[0].delta.content` → `text_delta`
- Kimi: `event: cmpl, data.text` → `text_delta`
- 其余类推

### 3.3 BrowserManager

管理专用 Chrome 实例：

```typescript
interface BrowserManager {
  ensureBrowser(): Promise<BrowserContext>;  // 懒启动
  fetch(url: string, init?: RequestInit): Promise<Response>;  // 带 Cookie fetch
  getCookies(domain: string): Promise<Cookie[]>;
  openForLogin(url: string): Promise<Page>;  // onboard 用
  shutdown(): Promise<void>;
}
```

- Chrome Profile 存储在 `~/.webmodel/chrome-profile/`
- 登录态跨重启持久化
- 服务运行时 headless，onboard 时自动切 headed
- 支持空闲自动关闭（`idleShutdown` 配置）

### 3.4 ProviderRegistry

Provider 注册与路由：

```typescript
class ProviderRegistry {
  register(provider: BaseProvider): void;
  resolve(modelId: string): { provider: BaseProvider; model: string };
  allModels(): Promise<ModelInfo[]>;
  providerStatus(): Promise<ProviderStatus[]>;
}
```

Model ID 格式：`{providerId}/{modelId}`，如 `claude-web/claude-sonnet-4-6`。

## 4. API 端点

### 4.1 OpenAI 兼容端点

**POST /v1/chat/completions**

请求：
```json
{
  "model": "claude-web/claude-sonnet-4-6",
  "messages": [
    {"role": "system", "content": "You are helpful."},
    {"role": "user", "content": "Hello"}
  ],
  "stream": true,
  "tools": [...]
}
```

流式响应：
```
data: {"id":"wmb-xxx","object":"chat.completion.chunk","created":1712345678,"model":"claude-web/claude-sonnet-4-6","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}

data: [DONE]
```

**GET /v1/models**

返回所有已认证 Provider 的可用模型列表，格式兼容 OpenAI `/v1/models` 响应。

### 4.2 管理端点

| 端点 | 用途 |
|------|------|
| `GET /webmodel/providers` | 所有 Provider 及认证状态 |
| `POST /webmodel/auth/check` | 检查指定 Provider 认证是否有效 |
| `GET /webmodel/health` | 服务健康检查（运行时间、浏览器状态、请求统计） |

## 5. CLI 命令

```
web-model-bridge <command> [options]

核心命令:
  serve                启动 HTTP 服务器
    --port, -p 3456      监听端口 (默认 3456)
    --host 127.0.0.1     绑定地址 (默认 127.0.0.1)
    --auth-token TOKEN   设置 Bearer Token 认证

  onboard              交互式引导：登录 Web 模型
    --provider <id>      只登录指定 provider
    --all                依次登录所有 provider

  models               列出所有可用模型和认证状态

管理命令:
  providers            列出所有 provider 及状态
  auth check           检查认证有效性
  auth logout          清除认证
  install-service      注册为系统服务 (launchd/systemd)
  uninstall-service    卸载系统服务
  doctor               诊断环境 (Chrome, Node, 端口等)

全局选项:
  --state-dir DIR      数据目录 (默认 ~/.webmodel)
  --config FILE        配置文件路径
  --verbose, -v        详细日志
  --version            版本号
```

### 5.1 典型使用流程

```bash
# 1. 安装
npm install -g web-model-bridge

# 2. 环境诊断
web-model-bridge doctor

# 3. 登录 Web 模型（弹出专用 Chrome）
web-model-bridge onboard

# 4. 启动服务
web-model-bridge serve

# 5. 在 AI 工具中配置 base URL
#    http://127.0.0.1:3456/v1
```

## 6. 配置文件

路径：`~/.webmodel/config.yml`

```yaml
server:
  port: 3456
  host: 127.0.0.1
  authToken: null           # 设置后需 Bearer Token 访问

browser:
  headless: true            # 服务运行时 headless
  profileDir: ~/.webmodel/chrome-profile
  startupTimeout: 30000
  idleShutdown: 300         # 无请求 N 秒后关闭 Chrome

providers:
  enabled:                  # 默认全部启用
    - claude-web
    - chatgpt-web
    - deepseek-web
    - kimi-web
  defaultModel: claude-web/claude-sonnet-4-6

toolCalling:
  enabled: true
  language: auto            # auto | zh | en

logging:
  level: info
  file: ~/.webmodel/logs/bridge.log
```

支持 `--state-dir` 指向 `~/.openclaw/` 以复用 OpenClaw 已有认证。

## 7. 数据目录结构

```
~/.webmodel/
├── config.yml                  # 用户配置
├── auth.json                   # Provider 认证元数据（非敏感）
├── chrome-profile/             # 专用 Chrome 用户数据
│   └── Default/
│       ├── Cookies             # 由 Chrome 加密管理
│       ├── Local Storage/
│       └── ...
└── logs/
    └── bridge.log
```

## 8. 错误处理

### 8.1 错误映射

| 场景 | HTTP | type | code |
|------|------|------|------|
| Provider 未认证 | 401 | authentication_error | auth_required |
| Cookie/Session 过期 | 401 | authentication_error | auth_expired |
| model ID 无法解析 | 400 | invalid_request_error | invalid_model |
| Provider 未启用 | 404 | not_found_error | provider_disabled |
| 请求体格式错误 | 400 | invalid_request_error | invalid_body |
| Bearer Token 错误 | 403 | permission_error | invalid_token |
| Chrome 启动失败 | 503 | server_error | browser_unavailable |
| 网站速率限制 | 429 | rate_limit_error | upstream_rate_limit |
| Cloudflare 拦截 | 502 | server_error | upstream_blocked |
| 请求超时 | 504 | server_error | timeout |

错误响应格式与 OpenAI API 一致：
```json
{
  "error": {
    "message": "描述信息",
    "type": "error_type",
    "code": "error_code",
    "param": null
  }
}
```

### 8.2 重试策略

**可重试**（最多 2 次，指数退避）：网络超时、连接断开、网站 5xx、Chrome Tab 意外关闭。

**不可重试**（立即返回）：认证过期 (401)、速率限制 (429)、请求格式错误 (400)、Cloudflare 拦截 (502)。

**Cookie 自动刷新**：请求返回 401/403 时自动尝试刷新页面重取 Cookie，成功则重试，失败则标记 expired 返回 401。

## 9. 安全设计

- **网络隔离**：默认绑定 127.0.0.1。远程访问需显式配置 `host: 0.0.0.0` 并强制设置 `authToken`
- **认证保护**：可选 Bearer Token 认证。Cookie 由 Chrome 自身加密管理，auth.json 只存元数据
- **浏览器隔离**：专用 Chrome Profile，与用户日常浏览完全隔离
- **日志安全**：脱敏 Cookie/SessionKey，默认不记录完整请求/响应体

## 10. 支持的 Provider

MVP 阶段（3 个）：

| Provider ID | 网站 | 特点 |
|-------------|------|------|
| claude-web | claude.ai | Cloudflare 保护，需浏览器请求 |
| chatgpt-web | chatgpt.com | Cloudflare 保护，需浏览器请求 |
| deepseek-web | chat.deepseek.com | 无 JS Challenge，工具调用验证通过 |

后续补齐（10 个）：kimi-web、qwen-web、qwen-cn-web、glm-web、glm-intl-web、grok-web、gemini-web、perplexity-web、doubao-web、xiaomimo-web。

## 11. 技术栈

| 依赖 | 用途 |
|------|------|
| hono | 轻量 HTTP 框架，原生 SSE streaming |
| playwright-core | Chrome CDP 连接（不捆绑浏览器） |
| commander | CLI 框架 |
| js-yaml | 配置文件解析 |
| chalk | 终端着色 |
| inquirer | 交互式 onboard 提示 |
| vitest | 测试框架 |
| tsup | 打包 |

## 12. 测试策略

**单元测试**（Vitest，无需浏览器）：StreamEvent 标准化、OpenAI 格式化、ToolCalling 解析器、ProviderRegistry 路由、配置加载、错误映射。

**集成测试**（mock provider）：HTTP 路由、流式响应、认证拦截、错误传播。

**E2E 测试**（真实浏览器，手动触发）：BrowserManager 启动/关闭、真实 Provider 登录和请求。

## 13. 项目结构

```
web-model-bridge/
├── src/
│   ├── server.ts                  # Hono HTTP 服务器
│   ├── routes/
│   │   ├── openai-compat.ts       # /v1/chat/completions, /v1/models
│   │   └── management.ts         # /webmodel/* 管理端点
│   ├── core/
│   │   ├── provider.ts            # BaseProvider 抽象类
│   │   ├── stream.ts              # StreamEvent 类型 + Pipeline
│   │   ├── registry.ts            # ProviderRegistry
│   │   └── tool-calling.ts        # 工具调用中间件
│   ├── providers/
│   │   ├── claude/
│   │   │   ├── auth.ts            # 登录逻辑
│   │   │   ├── client.ts          # Web API 客户端
│   │   │   └── stream.ts          # SSE → StreamEvent
│   │   ├── chatgpt/
│   │   ├── deepseek/
│   │   └── ... (13 个 provider)
│   ├── browser/
│   │   └── manager.ts            # 专用 Chrome 管理
│   ├── auth/
│   │   └── store.ts              # 认证状态存储
│   ├── config/
│   │   └── loader.ts             # 配置文件加载
│   └── cli.ts                    # Commander CLI 入口
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## 14. 交付阶段

### Phase 1 — MVP（核心可用）
- 项目骨架 (TypeScript + ESM + Vitest)
- 核心接口 (BaseProvider / StreamEvent / ProviderRegistry)
- BrowserManager (专用 Chrome + CDP)
- 3 个 Provider: Claude Web + ChatGPT Web + DeepSeek Web
- HTTP 服务器 (POST /v1/chat/completions + GET /v1/models)
- Stream Pipeline (SSE 标准化 + OpenAI 格式化)
- CLI: serve + onboard + models + doctor
- 配置文件 + 基本错误处理

### Phase 2 — 功能完善
- 工具调用中间件 (提示词注入 + 标签解析)
- 补齐 10 个 Provider
- 管理端点 (/webmodel/*)
- Cookie 自动刷新和过期检测
- Chrome 空闲自动关闭 + 懒启动
- install-service 系统服务注册

### Phase 3 — 生态与优化
- 插件系统 (用户自定义 Provider)
- AskOnce 多模型并发查询端点
- Web UI 管理面板 (可选)
- Docker 镜像
- 负载均衡 (同一 Provider 多账号轮换)
