# web-model-bridge 设计文档

> 独立中间件，作为使用 Web 模型的桥梁。将 openclaw-zero-token 的 Web 模型访问能力抽取为轻量 HTTP 服务，对外暴露 OpenAI 兼容 API。
>
> 对应 Issue: [openclaw-zero-token#176](https://github.com/linuxhsj/openclaw-zero-token/issues/176)

## 1. 背景与目标

openclaw-zero-token 已实现通过浏览器自动化访问 13 个 Web 模型（Claude、ChatGPT、DeepSeek 等），实现"零 token 消耗"。但该能力深度耦合在 OpenClaw 的 gateway/agent/channel 体系中，第三方工具无法直接使用。

**目标**：将 Web 模型访问能力抽取为独立的 npm 包 `web-model-bridge`，任何支持 OpenAI API 的客户端（Claude Code、Cursor、Open WebUI、LobeChat、OpenClaw 等）只需配置一个 base URL 即可接入。

### 1.1 核心设计原则

1. **一条命令启动** — `npx web-model-bridge` 搞定所有事情，不需要记多个命令和步骤顺序
2. **零学习成本登录** — 通过 Web Dashboard 在浏览器中正常登录网站，和日常上网体验一致
3. **无感浏览器管理** — Chrome 在后台静默运行，用户不需要知道它的存在
4. **高质量交付** — 完整自动化测试覆盖，编译必须通过，功能必须可用

### 1.2 设计决策总结

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 目标消费者 | 兼顾 OpenClaw 和第三方工具 | 最大化复用价值 |
| 功能范围 | 完整复刻 zero-token 能力 | 包含 tool-calling、认证管理、模型发现等 |
| 浏览器方案 | 专用 Chrome 实例（静默后台 + Dashboard 联动） | 用户无感，登录窗口自动弹出/关闭 |
| 部署形态 | CLI 为主 + 可选系统服务 | 开发用 CLI，日常用系统服务常驻 |
| 数据目录 | 默认 `~/.webmodel/`，可配指向 `~/.openclaw/` | 独立解耦，兼容迁移 |
| 发布方式 | npm 全局包 | 目标用户必有 Node.js，支持 npx 试用 |
| 包名 | `web-model-bridge` | 明确"桥梁"定位 |
| API 兼容性 | OpenAI 为主 + 扩展管理端点 + Dashboard | 通用兼容 + 可视化管理 |
| 架构方式 | 渐进式（干净接口 + 搬运实现） | 兼顾开发速度和架构质量 |

## 2. 用户体验设计

### 2.1 一条命令启动

不再区分 `onboard` / `serve` / `doctor` 等子命令。`npx web-model-bridge` 一条命令自动完成所有事情：

```
$ npx web-model-bridge

  ✓ Chrome found
  ✓ Server running at http://localhost:3456
  ✓ Dashboard opened in browser → http://localhost:3456

  No providers authenticated yet.
  Open the Dashboard to login → http://localhost:3456

  Press Ctrl+C to stop
```

**启动流程自动执行**：
1. 环境检查（Chrome 是否存在）→ 缺 Chrome 打印安装链接并退出
2. 启动 HTTP 服务器 → 端口占用自动找下一个可用端口
3. 静默启动后台 Chrome（headless，无窗口）
4. 打开 Web Dashboard → 浏览器自动导航到管理页面

### 2.2 Web Dashboard 登录体验

Dashboard 是内嵌在 HTTP 服务器中的轻量 Web 页面，替代所有 CLI 交互式操作：

```
┌──────────────────────────────────────────────┐
│  web-model-bridge  Dashboard                  │
│                                               │
│  Provider          Status     Action          │
│  ──────────────────────────────────────────  │
│  Claude Web        ✓ 已认证    [3 models]     │
│  ChatGPT Web       ✗ 未登录    [登录]         │
│  DeepSeek Web      ⚠ 已过期    [重新登录]     │
│  Kimi Web          ✗ 未登录    [登录]         │
│  ...                                          │
│                                               │
│  API Base URL:                                │
│  ┌─────────────────────────────────────────┐ │
│  │ http://localhost:3456/v1         [复制]  │ │
│  └─────────────────────────────────────────┘ │
│                                               │
│  Available Models: 3                          │
│  Active Streams: 0                            │
│  Uptime: 2h 15m                               │
└──────────────────────────────────────────────┘
```

**登录流程**：
1. 用户在 Dashboard 点击 [登录] 按钮
2. 后台 Chrome 自动切为 headed 模式，弹出目标网站登录页（如 claude.ai）
3. 用户在弹出的窗口中正常登录（和平时上网一样）
4. 后台自动检测登录完成 → 登录窗口自动关闭 → Chrome 回到 headless
5. Dashboard 实时刷新状态：`✓ Claude Web 已认证 (3 models)`

**Cookie 过期处理**（不中断服务）：
- API 返回 401 + 明确错误消息："Claude Web authentication expired"
- Dashboard 上该 Provider 自动变为 `⚠ 已过期 [重新登录]`
- 用户点击重新登录 → 同上流程，**无需停掉服务**

### 2.3 完整用户旅程

```
首次使用：
  npx web-model-bridge → Dashboard 打开 → 点 [登录] → 登录网站 → 复制 API URL → 配到 AI 工具 → 完成

日常使用：
  npx web-model-bridge → 自动加载已有登录态 → 直接可用

Cookie 过期：
  API 返回错误 → 打开 Dashboard → 点 [重新登录] → 登录 → 自动恢复

系统服务模式：
  web-model-bridge install-service → 开机自启，永远在后台 → Dashboard 随时可访问
```

## 3. 整体架构

### 3.1 分层架构

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
│  │  GET  /                           (Web Dashboard)         │    │
│  │  POST /v1/chat/completions        (聊天补全)              │    │
│  │  GET  /v1/models                  (模型列表)              │    │
│  │  GET  /webmodel/providers         (Provider 状态)        │    │
│  │  POST /webmodel/auth/login        (触发登录流程)         │    │
│  │  POST /webmodel/auth/check        (认证检查)             │    │
│  │  GET  /webmodel/health            (健康检查)             │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                          │                                       │
│  ┌─────────────── Core Layer ──────────────────────────────┐    │
│  │  Router ──→ 根据 model ID 路由到对应 Provider            │    │
│  │  Provider Registry (统一接口)                             │    │
│  │  Stream Pipeline (标准化 → 工具调用 → OpenAI 格式)       │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                          │                                       │
│  ┌─────────────── Infra Layer ─────────────────────────────┐    │
│  │  BrowserManager (静默 Chrome + 登录窗口联动)              │    │
│  │  AuthStore (认证元数据)                                    │    │
│  │  Config (YAML 配置)                                       │    │
│  └──────────────────────┬──────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────┘
                           │ CDP WebSocket
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  专用 Chrome 实例 (Profile: ~/.webmodel/chrome-profile/)         │
│  常态 headless → 登录时自动切 headed → 完成后自动回 headless     │
│  已登录: claude.ai, chatgpt.com, chat.deepseek.com, ...         │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 请求数据流

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
   └─ 未认证 → 401 + Dashboard 提示登录
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

## 4. 核心接口

### 4.1 BaseProvider

所有 Web 模型 Provider 的统一抽象：

```typescript
interface ProviderInfo {
  id: string;           // "claude-web"
  name: string;         // "Claude Web"
  website: string;      // "https://claude.ai"
  loginUrl: string;     // "https://claude.ai/login" — Dashboard 登录用
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

  // 认证 — 由 BrowserManager 在 headed 模式下调用
  abstract login(browser: BrowserContext): Promise<void>;
  abstract isAuthenticated(): Promise<boolean>;
  // 检测登录是否完成（轮询页面状态）
  abstract detectLoginComplete(page: Page): Promise<boolean>;

  // 模型发现
  abstract models(): Promise<ModelInfo[]>;

  // 核心：聊天补全，返回统一的内部事件流
  abstract chat(req: ChatRequest): AsyncIterable<StreamEvent>;
}
```

### 4.2 StreamEvent

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

### 4.3 BrowserManager

管理专用 Chrome 实例，对用户完全无感：

```typescript
interface BrowserManager {
  // 懒启动 headless Chrome（首次请求时）
  ensureBrowser(): Promise<BrowserContext>;

  // 在浏览器上下文中执行 fetch（携带 Cookie）
  fetch(url: string, init?: RequestInit): Promise<Response>;

  // 获取指定域名的 Cookie
  getCookies(domain: string): Promise<Cookie[]>;

  // Dashboard 触发的登录流程：
  //   headless → headed → 打开 loginUrl → 等待 detectLoginComplete → headed → headless
  openForLogin(provider: BaseProvider): Promise<void>;

  // 关闭浏览器
  shutdown(): Promise<void>;

  // 状态
  status(): BrowserStatus; // "running" | "idle" | "stopped"
}
```

关键行为：
- Chrome Profile 存储在 `~/.webmodel/chrome-profile/`，登录态跨重启持久化
- 常态 headless 运行，`openForLogin` 时自动弹出窗口，登录完成自动关闭窗口回到 headless
- 支持空闲自动关闭（`idleShutdown` 配置），下次请求懒启动
- Chrome 进程异常退出自动重启

### 4.4 ProviderRegistry

Provider 注册与路由：

```typescript
class ProviderRegistry {
  register(provider: BaseProvider): void;

  // "claude-web/claude-sonnet-4-6" → { provider: ClaudeProvider, model: "claude-sonnet-4-6" }
  resolve(modelId: string): { provider: BaseProvider; model: string };

  // 聚合所有 provider 的模型列表（仅已认证的）
  allModels(): Promise<ModelInfo[]>;

  // 所有 provider 的状态（Dashboard 用）
  providerStatus(): Promise<ProviderStatus[]>;
}
```

Model ID 格式：`{providerId}/{modelId}`，如 `claude-web/claude-sonnet-4-6`。

## 5. API 端点

### 5.1 OpenAI 兼容端点

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

### 5.2 Dashboard 端点

| 端点 | 用途 |
|------|------|
| `GET /` | Web Dashboard 页面（静态 HTML/JS） |
| `GET /webmodel/providers` | 所有 Provider 及认证状态（Dashboard 轮询） |
| `POST /webmodel/auth/login` | 触发指定 Provider 的登录流程（弹出窗口） |
| `POST /webmodel/auth/check` | 检查指定 Provider 认证是否有效 |
| `POST /webmodel/auth/logout` | 清除指定 Provider 的认证 |
| `GET /webmodel/health` | 服务健康检查 |

## 6. CLI 命令

```
web-model-bridge [options]

默认行为（无子命令）：
  启动服务器 + 打开 Dashboard + 自动环境检查

选项:
  --port, -p 3456      监听端口 (默认 3456)
  --host 127.0.0.1     绑定地址 (默认 127.0.0.1)
  --auth-token TOKEN   设置 Bearer Token 认证
  --no-open            不自动打开浏览器 Dashboard
  --state-dir DIR      数据目录 (默认 ~/.webmodel)
  --config FILE        配置文件路径
  --verbose, -v        详细日志
  --version            版本号

辅助子命令（高级用户）:
  install-service      注册为系统服务 (launchd/systemd)
  uninstall-service    卸载系统服务
```

注意：`onboard`、`doctor`、`models`、`providers` 等命令被移除，全部整合进默认启动流程和 Dashboard。

## 7. 配置文件

路径：`~/.webmodel/config.yml`

```yaml
server:
  port: 3456
  host: 127.0.0.1
  authToken: null           # 设置后需 Bearer Token 访问
  openDashboard: true       # 启动时自动打开 Dashboard

browser:
  profileDir: ~/.webmodel/chrome-profile
  startupTimeout: 30000     # Chrome 启动超时 (ms)
  idleShutdown: 300         # 无请求 N 秒后关闭 Chrome 节省内存
  loginTimeout: 120         # 等待用户登录超时 (秒)

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

## 8. 数据目录结构

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

## 9. 错误处理

### 9.1 错误映射

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
    "message": "Claude Web authentication expired. Open Dashboard to re-login: http://localhost:3456",
    "type": "authentication_error",
    "code": "auth_expired",
    "param": null
  }
}
```

### 9.2 重试策略

**可重试**（最多 2 次，指数退避）：网络超时、连接断开、网站 5xx、Chrome Tab 意外关闭。

**不可重试**（立即返回）：认证过期 (401)、速率限制 (429)、请求格式错误 (400)、Cloudflare 拦截 (502)。

**Cookie 自动刷新**：请求返回 401/403 时自动尝试刷新页面重取 Cookie，成功则重试，失败则标记 expired 返回 401 + Dashboard 提示重新登录。

## 10. 安全设计

- **网络隔离**：默认绑定 127.0.0.1。远程访问需显式配置 `host: 0.0.0.0` 并强制设置 `authToken`
- **认证保护**：可选 Bearer Token 认证。Cookie 由 Chrome 自身加密管理，auth.json 只存元数据
- **浏览器隔离**：专用 Chrome Profile，与用户日常浏览完全隔离
- **日志安全**：脱敏 Cookie/SessionKey，默认不记录完整请求/响应体

## 11. 支持的 Provider

MVP 阶段（3 个）：

| Provider ID | 网站 | 特点 |
|-------------|------|------|
| claude-web | claude.ai | Cloudflare 保护，需浏览器请求 |
| chatgpt-web | chatgpt.com | Cloudflare 保护，需浏览器请求 |
| deepseek-web | chat.deepseek.com | 无 JS Challenge，工具调用验证通过 |

后续补齐（10 个）：kimi-web、qwen-web、qwen-cn-web、glm-web、glm-intl-web、grok-web、gemini-web、perplexity-web、doubao-web、xiaomimo-web。

## 12. 技术栈

| 依赖 | 用途 |
|------|------|
| hono | 轻量 HTTP 框架，原生 SSE streaming + 静态文件服务（Dashboard） |
| playwright-core | Chrome CDP 连接（不捆绑浏览器） |
| commander | CLI 框架（极简，仅 options 解析） |
| js-yaml | 配置文件解析 |
| chalk | 终端着色 |
| open | 自动打开浏览器 Dashboard |
| vitest | 测试框架 |
| tsup | 打包 |
| msw | HTTP mock（测试用） |

注意：移除了 `inquirer`（不再需要 CLI 交互式提示，登录全部在 Dashboard 完成）。

## 13. 测试策略

### 13.1 质量保障流程

每一个功能模块都必须走完整的质量循环，不可跳过任何步骤：

```
编码 → 代码审查 → TypeScript 编译 → 自动化测试 → 修复 → 重新编译+测试
  └── 循环直到：编译零错误 + 全部测试通过 + 无低级错误
```

**质量门禁**：
- TypeScript 严格模式 (`strict: true`)，编译不通过不能提交
- 测试不通过不能合并
- 每个 PR 必须附带对应的测试用例

### 13.2 单元测试（Vitest，无需浏览器）

覆盖所有核心逻辑，每个模块都有对应测试文件：

| 测试文件 | 覆盖内容 | 关键用例 |
|----------|---------|---------|
| `core/stream.test.ts` | StreamEvent 标准化 | 各站点 SSE 格式解析、边界情况（空行、截断、畸形 JSON） |
| `core/registry.test.ts` | ProviderRegistry | model ID 解析、provider 查找、未知 model 错误、模型列表聚合 |
| `core/tool-calling.test.ts` | 工具调用中间件 | 提示词注入、3 种格式解析（fenced/bare/XML）、JSON 修复、无工具时透传 |
| `routes/openai-compat.test.ts` | OpenAI 格式化 | 流式/非流式响应格式、finish_reason 映射、错误响应格式 |
| `routes/management.test.ts` | 管理端点 | /providers 状态、/health 响应、/auth/* 端点 |
| `config/loader.test.ts` | 配置加载 | 默认值、YAML 解析、环境变量覆盖、无效配置报错 |
| `auth/store.test.ts` | 认证存储 | 读写 auth.json、过期检测、状态转换 |
| `errors.test.ts` | 错误映射 | 每种内部错误 → HTTP 状态码 + OpenAI 错误格式 |

### 13.3 集成测试（mock provider + mock browser）

使用 msw 模拟上游站点响应，测试完整请求链路：

| 测试场景 | 验证内容 |
|---------|---------|
| 正常流式请求 | 请求 → 路由 → mock provider → SSE 管道 → OpenAI 格式响应 |
| 正常非流式请求 | 请求 → 路由 → mock provider → 完整 JSON 响应 |
| 未认证 Provider | 请求 → 路由 → isAuthenticated=false → 401 + 正确错误格式 |
| 无效 model ID | 请求 → 路由失败 → 400 + invalid_model |
| Bearer Token 验证 | 配置 authToken 后无 token → 403，有 token → 正常 |
| 上游超时 | mock 延迟响应 → 504 + timeout |
| 上游 5xx | mock 返回 500 → 重试 2 次 → 502 |
| 流中断恢复 | SSE 流中途断开 → error 事件 + stream_interrupted |
| 多 provider 路由 | 不同 model ID → 正确路由到不同 mock provider |
| Dashboard API | GET /webmodel/providers → 正确状态列表 |

### 13.4 E2E 测试（真实浏览器）

需要真实 Chrome 环境，CI 中跳过，本地开发时手动触发：

| 测试场景 | 验证内容 |
|---------|---------|
| Chrome 启动/关闭 | BrowserManager 启动 headless Chrome → 验证 CDP 连接 → 正常关闭 |
| Chrome 异常恢复 | kill Chrome 进程 → BrowserManager 自动重启 |
| 空闲自动关闭 | 配置 idleShutdown=5 → 等待 → Chrome 关闭 → 新请求自动重启 |
| headed/headless 切换 | openForLogin → 验证窗口弹出 → 完成后验证回到 headless |
| Dashboard 页面加载 | 启动服务 → 访问 / → 验证 HTML 正确加载 |

### 13.5 SSE 协议一致性测试

专门验证 OpenAI SSE 格式的正确性，确保任何 OpenAI 客户端都能正确解析：

| 测试场景 | 验证内容 |
|---------|---------|
| chunk 格式 | 每个 chunk 是完整的 `data: {json}\n\n` |
| 首个 chunk | 包含 `role: "assistant"` |
| 中间 chunks | 只有 `content` delta |
| 结束 chunk | `finish_reason: "stop"` |
| 结尾标记 | 最后一行是 `data: [DONE]\n\n` |
| Content-Type | `text/event-stream` |
| 非流式响应 | 完整 `chat.completion` 对象，非 chunk |

### 13.6 测试运行方式

```bash
# 全量测试（单元 + 集成）
npm test

# 仅单元测试
npm run test:unit

# 仅集成测试
npm run test:integration

# E2E 测试（需要 Chrome）
npm run test:e2e

# 覆盖率报告
npm run test:coverage

# 监听模式（开发时）
npm run test:watch
```

## 14. 项目结构

```
web-model-bridge/
├── src/
│   ├── server.ts                  # Hono HTTP 服务器 + Dashboard 静态文件
│   ├── routes/
│   │   ├── openai-compat.ts       # /v1/chat/completions, /v1/models
│   │   └── management.ts         # /webmodel/* 管理端点 + Dashboard API
│   ├── core/
│   │   ├── provider.ts            # BaseProvider 抽象类
│   │   ├── stream.ts              # StreamEvent 类型 + Pipeline
│   │   ├── registry.ts            # ProviderRegistry
│   │   └── tool-calling.ts        # 工具调用中间件
│   ├── providers/
│   │   ├── claude/
│   │   │   ├── auth.ts            # 登录逻辑 + detectLoginComplete
│   │   │   ├── client.ts          # Web API 客户端
│   │   │   └── stream.ts          # SSE → StreamEvent
│   │   ├── chatgpt/
│   │   ├── deepseek/
│   │   └── ... (13 个 provider)
│   ├── browser/
│   │   └── manager.ts            # 静默 Chrome 管理 + headed/headless 切换
│   ├── auth/
│   │   └── store.ts              # 认证状态存储
│   ├── config/
│   │   └── loader.ts             # 配置文件加载
│   ├── dashboard/                 # Dashboard 静态资源
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   └── cli.ts                    # Commander CLI 入口（极简）
├── tests/
│   ├── unit/
│   │   ├── core/
│   │   │   ├── stream.test.ts
│   │   │   ├── registry.test.ts
│   │   │   └── tool-calling.test.ts
│   │   ├── routes/
│   │   │   ├── openai-compat.test.ts
│   │   │   └── management.test.ts
│   │   ├── config/
│   │   │   └── loader.test.ts
│   │   ├── auth/
│   │   │   └── store.test.ts
│   │   └── errors.test.ts
│   ├── integration/
│   │   ├── chat-completions.test.ts
│   │   ├── streaming.test.ts
│   │   ├── auth-flow.test.ts
│   │   ├── error-handling.test.ts
│   │   └── sse-conformance.test.ts
│   ├── e2e/
│   │   ├── browser-manager.test.ts
│   │   └── dashboard.test.ts
│   └── helpers/
│       ├── mock-provider.ts       # 可复用的 mock provider
│       ├── mock-sse.ts            # SSE 响应生成器
│       └── test-server.ts         # 测试用服务器工厂
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## 15. 交付阶段

### Phase 1 — MVP（核心可用）
- 项目骨架 (TypeScript strict + ESM + Vitest + tsup)
- 核心接口 (BaseProvider / StreamEvent / ProviderRegistry)
- BrowserManager (静默 Chrome + headed/headless 切换 + 登录联动)
- 3 个 Provider: Claude Web + ChatGPT Web + DeepSeek Web
- HTTP 服务器 (POST /v1/chat/completions + GET /v1/models)
- Stream Pipeline (SSE 标准化 + OpenAI 格式化)
- Web Dashboard (Provider 状态 + 登录触发 + API URL 展示)
- 一条命令启动：`npx web-model-bridge`
- 配置文件 + 错误处理 + 日志
- **完整的单元测试 + 集成测试（全部通过才算完成）**

### Phase 2 — 功能完善
- 工具调用中间件 (提示词注入 + 标签解析)
- 补齐 10 个 Provider
- Cookie 自动刷新和过期检测
- Chrome 空闲自动关闭 + 懒启动
- install-service 系统服务注册
- Dashboard 增强（模型详情、请求统计、日志查看）

### Phase 3 — 生态与优化
- 插件系统 (用户自定义 Provider)
- AskOnce 多模型并发查询端点
- Docker 镜像
- 负载均衡 (同一 Provider 多账号轮换)
