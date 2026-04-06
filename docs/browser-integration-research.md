# 浏览器集成方案研究

> 核心诉求：复用用户已登录的浏览器状态，不需要重启 Chrome，不需要重新登录。
>
> 调研时间：2026-04-06，所有项目均经 GitHub API 实时验证。

---

## 问题背景

web-model-bridge 当前有两种浏览器模式：

| 模式 | 需要重启 Chrome | 复用登录态 | 用户体验 |
|------|---------------|-----------|---------|
| `attach` (CDP) | 是（需带 `--remote-debugging-port`） | 是 | 需要关闭所有 Chrome 再重启 |
| `launch` | 否 | 否（需重新登录） | 弹出独立 Chrome，登录各网站 |

两种模式都有明显缺陷。CDP attach 要求重启 Chrome，用户日常开着 Chrome 根本不想关；launch 模式不复用登录态，用户要重新登录 11 个网站。

**目标**：找到"不关 Chrome + 直接复用登录态"的方案。

---

## 方案分类

### 类型 A：直接复用真实浏览器 Session

在用户正在使用的浏览器中执行操作，天然拥有所有 Cookie。

### 类型 B：持久化 Session / Cookie，跨会话复用

把登录态保存下来，下次启动时恢复，不依赖用户浏览器是否在运行。

### 类型 C：跳过浏览器，直接调用学习到的 API

先用浏览器学习 API 端点和认证方式，之后绕过浏览器直接 HTTP 调用。

---

## 项目详细评估

### 1. bb-browser — ★ 推荐集成

| 属性 | 值 |
|------|---|
| GitHub | https://github.com/epiral/bb-browser |
| Stars | 4,117 |
| 最后更新 | 2026-04-05（活跃） |
| 语言 | TypeScript |
| 类型 | 类型 A — 直接复用浏览器 Session |

**核心原理**：
```
bb-browser CLI/MCP → HTTP → 本地 Daemon (127.0.0.1:19824) → CDP WebSocket → 用户的 Chrome
```

bb-browser 管理一个专用 Chrome 实例（独立 profile `~/.bb-browser/browser/`），用户首次在这个 Chrome 中登录各网站，之后 Session 永久持久化。daemon 通过 CDP 连接这个 Chrome，在 tab 内执行 `eval()`/`fetch()`，请求自动携带用户 Cookie。

**关键特性**：
- 不干扰用户日常 Chrome（独立 profile）
- 登录一次永久持久化
- 用户登录后 daemon 自动使用，无需手动操作
- HTTP daemon 端口 `19824`，可直接发 HTTP 请求调用
- 支持 36 个平台、103 条命令
- 有 MCP Server 模式

**与 web-model-bridge 的集成方式**：
作为 `BrowserManager` 的第三种 mode（`mode: 'bb-browser'`）。`fetchInBrowser()` 直接将请求转发到 bb-browser daemon 的 HTTP 端点，由 daemon 在浏览器上下文中执行 fetch。

**集成难度**：低
- 不需要修改 bb-browser 源码
- 只需新增一个 HTTP 客户端，调用 daemon API
- 前提：用户需要先安装 bb-browser 并在其 Chrome 中登录

**用户体验**：
```bash
# 一次性准备（安装 bb-browser + 登录）
npm install -g bb-browser
bb-browser open https://claude.ai   # 在 bb-browser 的 Chrome 中登录

# 之后每次使用
npx web-model-bridge --browser-mode bb-browser
# → 自动连接 bb-browser daemon → 所有登录态可用
```

---

### 2. agent-browser (Vercel Labs) — ★ 推荐借鉴

| 属性 | 值 |
|------|---|
| GitHub | https://github.com/vercel-labs/agent-browser |
| Stars | 27,407 |
| 最后更新 | 2026-04-06（非常活跃） |
| 语言 | Rust |
| 类型 | 类型 B — 持久化 Session |

**核心原理**：
Rust 编写的 CLI + daemon 架构。daemon 首次命令时自动启动并持久化。支持连接已有 Chrome 或使用 Chrome for Testing。

**Session 持久化方案（5 种机制，这是最有价值的借鉴）**：

| 机制 | 原理 | 适用场景 |
|------|------|---------|
| **Chrome Profile 复用** | `--profile Default` 以只读快照复用现有 Chrome profile | 复用用户的登录态 |
| **Persistent Profiles** | 自定义 profile 目录，完整存储 cookies/localStorage/IndexedDB | 独立环境 |
| **Session Names** | `--session-name` 自动保存/恢复 cookies 和 localStorage | 多环境切换 |
| **State Files** | `state save` 将 session 导出为 JSON 文件 | 备份/迁移/分享 |
| **Auth Vault** | AES-256-GCM 加密的凭据存储，LLM 不可见 | 安全存储密码 |

存储位置：`~/.agent-browser/sessions/`，支持 30 天自动过期。

**与 web-model-bridge 的关联**：
不建议直接集成（Rust CLI，无 Node.js SDK），但其 Session 持久化设计值得借鉴：
- State Files 机制可以改进我们的 `AuthStore`，从简单的 status 标记升级为完整的 session 数据导出/导入
- Auth Vault 的加密存储可以增强安全性
- Session Names 的概念可以支持多环境（开发/测试/生产）

**集成难度**：中（借鉴设计，不直接集成）

---

### 3. Unbrowse — ★ 推荐（长期性能优化）

| 属性 | 值 |
|------|---|
| GitHub | https://github.com/unbrowse-ai/unbrowse |
| Stars | 617 |
| 最后更新 | 2026-04-06（活跃） |
| 语言 | 未详 |
| 类型 | 类型 C — 跳过浏览器直接调 API |

**核心原理（独特且有创意）**：
不是自动化浏览器，而是**捕获浏览器交互期间的内部 API 端点**，学习后直接调用这些 API。

```
首次：浏览器执行操作 → Unbrowse 捕获 API 路由和认证方式 → 保存为 "Skill"
后续：直接 HTTP 调用学习到的 API 路由 → 跳过浏览器 → 50-200ms 响应
```

**性能提升数据**：
- 从 5-30 秒 → 50-200ms（100x 提速）
- 从 8000 tokens/action → 200 tokens/action（40x 节省）

**与 web-model-bridge 的集成设想**：

```
第一次请求 deepseek-web → 走 BrowserManager.fetchInBrowser() → Unbrowse 学习 API
第二次请求 deepseek-web → 直接 HTTP 调用已学习的 API 端点 → 秒级响应
Token/Session 过期 → 自动 fallback 回浏览器 → 重新学习
```

这可以作为 `Provider.chat()` 的缓存加速层。

**集成难度**：中
- 有 npm 包，有 MCP 集成
- 有 OpenClaw 专属插件：`npx unbrowse-openclaw install`
- 需要设计缓存层和 fallback 机制

---

### 4. BrowserOS — 不推荐集成

| 属性 | 值 |
|------|---|
| GitHub | https://github.com/browseros-ai/BrowserOS |
| Stars | 10,294 |
| 最后更新 | 2026-04-05（活跃） |
| 语言 | TypeScript |
| 类型 | 独立浏览器产品 |

**原理**：Chromium fork，内置 AI agent。支持从 Chrome 导入数据。

**不推荐原因**：
- 是独立浏览器产品，需要用户切换浏览器
- 改变用户工作流成本太高
- 不能作为库嵌入

---

### 5. Notte — 有价值但依赖云服务

| 属性 | 值 |
|------|---|
| GitHub | https://github.com/nottelabs/notte |
| Stars | 1,928 |
| 最后更新 | 2026-04-05（活跃） |
| 类型 | 商业产品 + 开源框架 |

**原理**：云端浏览器基础设施。Session Profiles 支持完整浏览器快照持久化，跨 session 复用。

**有价值的点**：
- CDP 兼容 — 可以直接用 `playwright-core.connectOverCDP()` 连接
- Session 快照 — 比文件级持久化更完整
- Agent Vaults — 加密凭据存储

**不推荐直接集成原因**：
- 云服务依赖（$0.05/hour）
- 增加外部依赖
- 适合需要云端浏览器的场景，本地使用没必要

---

### 6. browser-use — 不推荐集成

| 属性 | 值 |
|------|---|
| GitHub | https://github.com/browser-use/browser-use |
| Stars | 86,138 |
| 最后更新 | 2026-04-06（非常活跃） |
| 语言 | Python |
| 类型 | AI 浏览器自动化框架 |

**不推荐原因**：
- Python-only，与 TypeScript 栈完全不兼容
- 面向"用 AI 控制浏览器"，和我们"复用浏览器状态发 API 请求"的目标不同
- 集成需要 Python 运行时依赖

---

## 推荐集成路径

### 短期目标：bb-browser 集成

```
当前：attach (CDP) | launch (独立 Chrome)
目标：attach (CDP) | launch (独立 Chrome) | bb-browser (推荐)
```

用户视角：
```bash
# 安装 bb-browser（一次性）
npm install -g bb-browser

# 在 bb-browser 的 Chrome 里登录各网站（一次性）
bb-browser open https://claude.ai
bb-browser open https://chat.deepseek.com

# 启动 web-model-bridge（每次）
npx web-model-bridge --browser-mode bb-browser
# → 自动连接 bb-browser → 所有网站已登录 → 直接可用
```

**实现方式**：
```typescript
// src/browser/manager.ts — 新增 bb-browser mode
if (this._mode === 'bb-browser') {
  // 直接 HTTP 调用 bb-browser daemon
  const res = await fetch('http://127.0.0.1:19824/fetch', {
    method: 'POST',
    body: JSON.stringify({ url, init }),
  });
  return res;
}
```

### 中期目标：借鉴 agent-browser 改进 AuthStore

- 支持 session 导出/导入（JSON State Files）
- 加密凭据存储（AES-256-GCM）
- 多环境切换（Session Names）

### 中期目标（备选）：Chrome 扩展桥接

另一种"不关 Chrome + 复用登录态"的方案，是开发一个 Chrome 扩展作为 web-model-bridge 和用户浏览器之间的通信桥梁。

**原理**：

```
web-model-bridge        Chrome 扩展              用户的 Chrome
(HTTP 服务)     ←→     (安装在浏览器里)   ←→     (已登录各网站)
    ↑                       ↑                        ↑
  接收 API 请求      WebSocket 通信           执行 fetch 带 Cookie
```

1. 用户在 Chrome 里安装一个小扩展
2. 扩展在后台建立 WebSocket 连接到 web-model-bridge 服务
3. 当 web-model-bridge 收到 API 请求时，通过 WebSocket 告诉扩展："帮我在浏览器里访问 claude.ai/api/xxx"
4. 扩展在浏览器上下文中执行 `fetch()`，**自动带上用户已有的 Cookie**
5. 扩展把响应发回给 web-model-bridge

**与其他方案的对比**：

| | CDP attach | bb-browser | Chrome 扩展桥接 |
|---|---|---|---|
| 需要重启 Chrome | 是 | 否（独立 Chrome） | **否** |
| 复用用户当前 Chrome 的登录态 | 是 | 否（独立 profile） | **是** |
| 安装步骤 | 修改启动参数 | `npm install -g bb-browser` | 安装一个扩展 |
| 安全性 | CDP 暴露完整浏览器控制权 | daemon 有完整控制权 | **扩展只能做 fetch，权限可控** |
| 开发成本 | 低（Playwright 支持） | 低（调用 daemon API） | 中（需开发扩展 + WebSocket） |

**关键优势**：这是唯一能直接复用用户**当前正在使用的** Chrome 的登录态、且不需要任何重启操作的方案。bb-browser 虽然不需要重启用户 Chrome，但它用的是独立 profile，用户还是需要在 bb-browser 的 Chrome 中重新登录。

**实现复杂度**：中等。需要开发：
- Chrome Manifest V3 扩展（background service worker + content script）
- WebSocket 通信协议
- web-model-bridge 端的 WebSocket 服务端
- 扩展发布到 Chrome Web Store 或提供 .crx 离线安装

**这是 OpenCLI 项目采用的方案**（见 `extension/` 目录），已验证可行。

---

### 长期目标：Unbrowse API 学习加速

Unbrowse（https://github.com/unbrowse-ai/unbrowse ，617 stars）采用了一种独特的思路：**不是自动化浏览器，而是从浏览器流量中学习 API 端点，之后直接 HTTP 调用，绕过浏览器。**

#### 核心原理

```
首次请求（慢路径，~12s）：
  启动 Chrome → 导航到目标网站 → CDP 拦截所有网络请求
  → 从流量中提取 API 端点 → 参数化为 URL 模板
  → 保存为 "Skill"（含端点、headers、认证方式、响应 schema）
  → 发布到本地缓存和共享 marketplace

后续请求（快路径，50-200ms）：
  查本地缓存找到 Skill → 从 Chrome 的 Cookie 数据库实时解密读取 Cookie
  → 直接 fetch() 调用学习到的 API 端点 → 返回 JSON 数据
  → 完全跳过浏览器
```

**性能提升**：
- 响应时间：5-30 秒 → 50-200ms（100x 提速）
- Token 消耗：8000 tokens/action → 200 tokens/action（40x 节省）

#### 三种执行策略

| 策略 | 原理 | 速度 | 适用场景 |
|------|------|------|---------|
| **Server-side Direct Fetch** | 直接 HTTP 调用学习到的 API，注入 Cookie | 50-200ms | 大多数网站 |
| **Trigger-and-Intercept** | 导航到页面让 JS 发请求，CDP 拦截响应 | 1-3s | 有复杂请求签名的网站（如 LinkedIn） |
| **Full Browser Capture** | 完整浏览器会话 | 5-30s | 未映射的新工作流，同时学习生成 Skill |

#### 认证方式（关键创新）

Unbrowse **直接解密 Chrome 的 Cookie 数据库文件**：
- macOS：`~/Library/Application Support/Google/Chrome/{Profile}/Network/Cookies`
- 解密密钥通过 macOS Keychain 获取
- 每次执行时实时读取，不需要手动复制 Cookie
- 只要用户在 Chrome 中保持登录，agent 就自动拥有认证

这意味着：**完全不需要用户做任何登录操作**，也不需要重启 Chrome。

#### Skill 数据结构

一个 Skill 包含：
- `url_template`：参数化的 API URL（如 `https://x.com/i/api/graphql/{query_hash}?variables={vars}`）
- `headers_template`：请求头模板
- `csrf_plan`：CSRF token 获取策略（来源、刷新规则）
- `oauth_plan`：OAuth 配置
- `response_schema`：推断出的响应 JSON Schema
- `operation_graph`：多步 API 调用的 DAG 依赖关系
- `exec_strategy`：学习到的最佳执行策略
- `reliability_score`：可靠性评分

#### 技术栈

- **Kuri**：Zig 编写的原生 CDP broker（464KB，3ms 冷启动），取代 Playwright（80-150MB，1-3s 冷启动）
- **不依赖 Playwright/Puppeteer**：直接通过 HTTP API 说 CDP 协议
- 有 npm 包，有 MCP 集成

#### 与 web-model-bridge 的集成设想

```
Provider.chat() 调用链：
  
  第一次请求 deepseek-web：
    → BrowserManager.fetchInBrowser()（走浏览器）
    → Unbrowse 在后台捕获 DeepSeek 的 API 端点
    → 生成 Skill 并缓存
  
  第二次请求 deepseek-web：
    → 查到 Skill 缓存
    → 直接 fetch() 调用 DeepSeek API + 从 Cookie 数据库注入认证
    → 50ms 完成（跳过浏览器）
  
  Cookie 过期：
    → fetch 返回 401
    → 自动 fallback 回浏览器路径
    → 重新学习
```

**集成难度**：中。有 npm 包，有 OpenClaw 专属插件（`npx unbrowse-openclaw install`）。需要设计缓存层和 fallback 机制。

---

## 最终模式对比

| 模式 | 需要重启 Chrome | 复用登录态 | 额外依赖 | 用户体验 | 速度 |
|------|---------------|-----------|---------|---------|------|
| `attach` (CDP) | 是 | 是 | 无 | 中 | 正常 |
| `launch` | 否 | 否 | 无 | 差 | 正常 |
| `bb-browser` ★ | 否 | 是（独立 profile） | bb-browser | 好 | 正常 |
| Chrome 扩展桥接 | **否** | **是（当前 Chrome）** | 扩展开发 | **最佳** | 正常 |
| Unbrowse (未来) | 否 | 是（读 Cookie DB） | unbrowse | 极佳 | **100x 加速** |
