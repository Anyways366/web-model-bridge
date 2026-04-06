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

### 长期目标：Unbrowse API 学习加速

- 首次请求走浏览器，Unbrowse 学习 API
- 后续请求直接 HTTP 调用
- Token 过期自动 fallback 回浏览器

---

## 最终模式对比

| 模式 | 需要重启 Chrome | 复用登录态 | 额外依赖 | 用户体验 |
|------|---------------|-----------|---------|---------|
| `attach` (CDP) | 是 | 是 | 无 | 中（需改启动方式） |
| `launch` | 否 | 否 | 无 | 差（需重新登录） |
| `bb-browser` ★ | **否** | **是** | bb-browser | **最佳** |
| Unbrowse (未来) | 首次是 | 学习后跳过 | unbrowse | 极佳（100x 加速） |
