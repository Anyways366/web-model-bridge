# 竞品分析

> 截至 2026 年 4 月 8 日实时验证

## 竞品全景

将 Web AI 模型免费暴露为 API 的开源项目，主要有四条技术路线：

| 技术路线 | 原理 | 代表项目 | 抗封锁能力 |
|---------|------|---------|-----------|
| **配额聚合路由** | 聚合 IDE/API 配额，统一代理 | OpenRelay | 中（依赖 IDE 不封堵） |
| **浏览器 DOM 自动化** | Camoufox/Playwright 模拟人类操作网页 | WebAI2API | 中高（拟人化，但依赖 DOM） |
| **浏览器 API 直调** | 真实 Chrome + Cookie 直接调 Web API | **web-model-bridge (我们)** | **高（真实浏览器 + API 级调用）** |
| **多提供商聚合** | 聚合第三方免费接口和逆向 API | gpt4free | 低（接口频繁失效） |
| **CLI OAuth 代理** | 包装官方 CLI 工具的 OAuth 认证 | CLIProxyAPI, ccproxy-api | 中（依赖 OAuth 不被封） |
| **Cookie/Token 模拟** | 手动获取 Token 后模拟 HTTP 请求 | chat2api, WebAI-to-API | 低（Cloudflare 拦截） |

---

## 重点竞品深度分析

### 1. OpenRelay — 配额聚合路由器

| 属性 | 值 |
|------|---|
| 链接 | https://github.com/romgX/openrelay |
| Stars | 259 |
| 语言 | TypeScript（但核心闭源，仅发布预编译二进制） |
| 最新版 | v0.10.12（2026-04-07），一个月 30 个版本 |
| 贡献者 | 1 人 (romgX) |
| 许可证 | Open Core（MIT 框架 + 商业 Pro） |
| 状态 | **极其活跃**，几乎每天发布 |

#### 定位与核心卖点

> "你的 AI 订阅，各自为政。OpenRelay 打破这道墙。"

核心痛点：用户在 Claude Desktop、Kiro、Windsurf、Cursor 等多个 IDE 中有分散的 AI 配额，无法跨工具使用。OpenRelay 聚合这些配额，通过统一的本地代理端点暴露。

#### 支持的 Provider（32 个）

**IDE Provider（8 个）— 自动提取凭据，无需 API Key：**

| Provider | 免费额度 | 提取方式 |
|----------|---------|---------|
| Claude Desktop | 取决于订阅 (Pro/Max) | 解密 Chromium Cookie DB（PBKDF2 + AES-128-CBC） |
| Claude Code | 取决于订阅 | 本地凭据文件 |
| Kiro (AWS) | 50 credits/月 + 新用户 500 | Token 提取，约 1 小时过期 |
| Windsurf (Codeium) | 无限补全 + 25 credits/月 | 凭据文件 |
| Antigravity | IDE 内置 | 必须保持 IDE 打开 |
| OpenCode | 无限 (GLM-4.7) | 内置凭据 |
| VS Code Copilot | 取决于 GitHub Copilot 订阅 | Ollama BYOK 桥接 |
| OpenAI Codex | 限时免费 (GPT-5.4) | REST + WebSocket 双传输 |

**直连 API Provider（24 个）— 需要 API Key：**

| Provider | 免费额度 |
|----------|---------|
| Groq | 30 RPM，最多 14,400 次/天 |
| Cerebras | 100 万 token/天 |
| SambaNova | 20 万 token/天 |
| Gemini | 100 万上下文，慷慨免费层 |
| OpenRouter | 20 RPM，50 次/天，30+ 模型 |
| DeepSeek | 注册送 500 万 token |
| Mistral | 10 亿 token/月 |
| xAI (Grok) | $25 注册 + $150/月 |
| Together AI | $100 注册信用 |
| SiliconFlow | 2000 万 token + 免费模型 |
| Zhipu (GLM) | GLM-4-Flash 永久免费 |
| DashScope (阿里) | 450 元额度 |
| Volcengine (字节) | 100 元额度 |
| Moonshot (Kimi) | 150 万 token/天 |
| Cloudflare AI | 10,000 Neurons/天 |
| HuggingFace | 限速 Serverless |
| 其他 | Fireworks, NVIDIA NIM, GitHub Models, Baichuan, Stepfun, MiniMax, Hunyuan, Anthropic |

#### 技术架构

```
用户工具 (Claude Code / Aider / Cursor...)
    ↓ 环境变量指向 localhost:18765
OpenRelay 本地代理
    ├── IDE Provider: 从本地文件提取 token → 透传请求
    ├── API Provider: 用户 API Key → 直连
    └── IDE RPC 代理: Cursor(18780) / Windsurf(18766) / Copilot(18769)
    ↓ 直连
AI Provider 后端
```

**关键技术点：**
- **单文件二进制**：Node.js SEA 打包，无需安装运行时
- **Cookie 解密**：macOS 通过 Keychain → PBKDF2 → AES-128-CBC；Windows 通过 DPAPI → AES-256-GCM
- **多协议**：REST、WebSocket、ConnectRPC (HTTP/2)、Ollama BYOK 桥接
- **Web 管理面板**：中英双语，内置于 localhost:18765
- **API Key 格式**：`sk-or-{provider}-{hex}` 用于 SDK/curl 调用

#### 商业模式：Pro vs 免费

| 功能 | 免费版 | Pro 版 |
|------|--------|--------|
| 每日请求数 | 30-50 次/天 | 无限 |
| Provider 数量 | 全部 32 个 | 全部 32 个 |
| IDE RPC 代理 | 有 | 有 |
| 模型组合 (round-robin + failover) | 无 | 有 |
| 优先支持 | 无 | 有 |

Pro 获取方式：Star + 加入 Telegram 群领 1-2 个月体验码。

#### 致命问题

1. **本质是闭源软件**：仓库中仅 `cookie.ts` 一个源文件公开，核心代码全在预编译二进制中。标榜 MIT 开源但无法审查。社区已有用户质疑（Issue #20："并未开源，风险自担"）
2. **安全风险**：需要访问用户所有 AI 服务的认证凭据，连接 `license.limitlessmeto.com` 进行许可证验证
3. **IDE 薅配额有封堵风险**：从 IDE 提取 token 本质上违反 ToS，IDE 厂商随时可能封堵
4. **单人维护**：42 次提交全来自一人，多次使用 AI 辅助（Co-Authored-By: Claude Opus 4.6）

#### 用户反馈（22 Issues）

| 类别 | 问题 | 频率 |
|------|------|------|
| 安装问题 | npm install 404、架构不匹配、启动警告 | 最频繁（#4,#7,#8,#9,#10,#12,#13） |
| IDE 集成 | Cursor/Windsurf/OpenClaw 配置问题 | 中（#3,#5,#14,#15,#16,#17,#18） |
| 安全/信任 | 闭源质疑、定价质疑 | 关键（#20,#21） |
| 功能请求 | Linux 支持（已实现） | 低（#19） |

---

### 2. WebAI2API — 浏览器 DOM 自动化

| 属性 | 值 |
|------|---|
| 链接 | https://github.com/foxhui/WebAI2API |
| Stars | 349 |
| 语言 | JavaScript (Node.js) |
| 版本 | 3.6.3（无正式 Release，通过 CHANGELOG 管理） |
| 贡献者 | 4 人（foxhui 主导，155 次提交） |
| 许可证 | MIT |
| 状态 | **活跃**，最近一次推送 2026-04-07 |

#### 定位与核心卖点

基于 Camoufox（Firefox/Playwright）的浏览器自动化工具。通过模拟人类操作网页版 AI（打字、点击、鼠标轨迹），将响应转为 OpenAI 兼容 API。

起源于一个单文件脚本（操作 LMArena 网页免费生成图片），随着 OpenClaw 生态爆火后快速发展。

#### 支持的 Provider（17 个适配器）

| 适配器 | 文本 | 图片 | 视频 | 备注 |
|--------|------|------|------|------|
| LMArena | 有 | 有（45+ 模型） | — | 图片生成主力 |
| Gemini Business | 有 | 有 | 有 | 需企业账号 |
| Google Gemini | 有 | 有(水印) | 有(水印) | 免费版 |
| ChatGPT | 有 | 有 (gpt-image-1.5) | — | |
| DeepSeek | 有 | — | — | v3.2 系列含 thinking/search |
| 豆包 | 有 | 有 (seedream) | — | |
| Sora | — | — | 有 (sora-2) | 视频专用 |
| zAI | 有 | 有 | — | Gemini 图片 1K/2K/4K |
| NanoBananaFree | — | 有 | — | gemini-2.5-flash-image |
| Zenmux AI | 有（36 模型） | — | — | 聚合多个模型 |
| Google Flow | — | — | — | 新适配器 |

#### 技术架构

```
用户请求 (POST /v1/chat/completions)
    ↓
API Server (OpenAI 兼容) → Queue (排队/并发控制)
    ↓
PoolManager (负载均衡: least_busy / round_robin / random)
    ↓
Worker (Camoufox 浏览器实例)
    ↓
Adapter (平台专属逻辑: 登录处理、DOM 操作、响应拦截)
    ↓
Camoufox 浏览器 → 目标 AI 网页
    ↓
拦截响应 → SSE 流式返回
```

**核心目录结构：**
```
src/
├── backend/
│   ├── adapter/          # 17 个适配器（各 AI 平台）
│   ├── engine/
│   │   ├── launcher.js   # Camoufox 启动器
│   │   └── utils.js      # 浏览器工具
│   ├── pool/
│   │   ├── PoolManager.js # 并发池管理
│   │   ├── Worker.js     # 浏览器 Worker
│   │   └── index.js
│   ├── registry.js       # Adapter 注册中心
│   ├── strategies/
│   │   ├── failover.js   # 故障转移
│   │   └── index.js      # 负载均衡策略
│   └── utils/
│       ├── CloudflareBypass.js  # Cloudflare Turnstile 绕过
│       ├── download.js   # 图片/视频下载
│       └── page.js       # 页面操作工具
├── server/
│   ├── api/openai/       # OpenAI 兼容路由
│   ├── api/admin/        # 管理后台 + VNC 代理
│   ├── queue.js          # 请求队列
│   └── respond.js        # SSE 流式响应
├── config/               # YAML 配置管理
└── utils/
webui/                    # Vue.js 管理面板（含 VNC 查看器）
supervisor.js             # 进程看门狗
patches/                  # Camoufox JS 补丁
```

#### 反检测技术（核心竞争力）

| 技术 | 实现 |
|------|------|
| 浏览器指纹 | Camoufox（基于 Firefox 135），首次生成指纹后持久化复用 |
| Canvas 指纹 | 注入固定噪声偏移 |
| WebRTC 保护 | `block_webrtc: true` |
| User-Agent | 统一为 Firefox 135.0 |
| 拟人鼠标 | ghost-cursor / camoufox 内置两种模式 |
| 拟人打字 | humanType 自然击键节奏 |
| 随机延迟 | 操作间 100-200ms 随机等待 |
| Cloudflare 绕过 | 穿透 closed shadow-root + iframe 点击 checkbox |
| 地理位置 | geoip 伪装 |
| 插件/MIME | 清空防指纹识别 |

#### 并发与资源

| 特性 | 实现 |
|------|------|
| 负载均衡 | 3 种策略：least_busy / round_robin / random |
| 故障转移 | 顺序候选，区分可重试/不可重试错误 |
| 请求队列 | FIFO + 动态缓冲 (maxConcurrent + queueBuffer) |
| 心跳保活 | 流式每 3 秒心跳（comment / content 两种模式） |
| 浏览器共享 | 多 Worker 共享一个浏览器进程（userDataDir 分组） |
| 自动恢复 | 浏览器断连 → `_reinit()`；页面关闭 → `_recreatePage()` |

**硬件需求：**

| 配置 | CPU | 内存 | 磁盘 |
|------|-----|------|------|
| 最低 | 1 核 | 1 GB | 2 GB |
| 推荐（单实例） | 2+ 核 | 2+ GB | 5+ GB |
| 推荐（多实例） | 2+ 核 | 4+ GB | 7+ GB |

#### 部署方式

**Docker（主推）：**
```yaml
services:
  webai-2api:
    image: foxhui/webai-2api:latest
    ports: ["3000:3000"]
    volumes: ["./data:/app/data"]
    shm_size: '2gb'  # 必需：浏览器需要大量共享内存
```

需要 Xvfb 虚拟显示器 + x11vnc 远程桌面（Linux/Docker），Supervisor 看门狗管理进程。

#### 用户反馈（10 Open Issues）

| 类别 | 问题 | 频率 |
|------|------|------|
| Docker 部署 | sharp 模块加载失败、虚拟显示器启动 | 高（#52,#48） |
| 长时间稳定性 | CLICK_TIMEOUT（14 条评论，最热 issue） | 关键（#30） |
| 平台变化 | Gemini 限制、ChatGPT 模型名变化、回复截断 | 中（#46,#47,#40） |
| 功能请求 | 支持 Grok、图片去水印 | 低（#51,#45） |

---

### 3. gpt4free — 多提供商聚合

| 属性 | 值 |
|------|---|
| 链接 | https://github.com/xtekky/gpt4free |
| Stars | 66K |
| 语言 | Python |
| 最新版 | v7.4.2（2026-04-05） |
| 状态 | **非常活跃**，每天更新 |

**做什么**：聚合多个免费 LLM 提供商和逆向接口，提供 OpenAI 兼容 API + Web GUI。

**优点**：
- 提供商健康检查和自动切换 — 某个接口挂了立刻切到下一个
- MCP Server 集成 — Claude Code/Gemini CLI 可以直接通过 MCP 调用
- 社区驱动的适配器模式 — 任何人可以贡献新提供商
- Web GUI + API 双入口

**缺点**：
- 依赖第三方免费接口，**频繁失效** — 几乎每周都有提供商失效
- 法律灰色地带 — 多个提供商涉及 ToS 违规
- Python 生态 — 对 Node.js/TypeScript 用户部署不友好
- 代码质量参差

---

### 4. CLIProxyAPI — CLI OAuth 代理

| 属性 | 值 |
|------|---|
| 链接 | https://github.com/router-for-me/CLIProxyAPI |
| Stars | 23.3K |
| 语言 | Go |
| 最新版 | v6.9.15（2026-04-04），共 547 个版本 |
| 状态 | **极其活跃**，30 天 517 个 issue/PR |

**做什么**：将 Claude Code、Gemini CLI、ChatGPT Codex 等官方 CLI 工具包装为 OpenAI/Anthropic 兼容 API。需要用户有 Claude Max/ChatGPT Plus 等付费订阅。

**优点**：
- 多账号负载均衡 — 同一 provider 配置多个 OAuth 账号，自动轮换
- 原生桌面应用 — macOS 菜单栏、Windows TUI
- Go 高性能 — 低延迟转发
- 547 个 release 的迭代速度

**缺点**：
- **需要付费订阅** — Claude Max $100/月或 ChatGPT Plus $20/月
- 依赖 CLI OAuth 认证 — 如果厂商封堵就失效
- 复杂度高 — 547 个版本说明维护成本极高

---

### 5. ccproxy-api — 插件式代理

| 属性 | 值 |
|------|---|
| 链接 | https://github.com/CaddyGlow/ccproxy-api |
| Stars | 216 |
| 最新版 | v0.2.7（2026-03-31） |
| 状态 | **活跃** |

**做什么**：本地插件式反向代理，统一访问 Claude/OpenAI/GitHub Copilot。

**优点**：19+ 内置插件（日志、分析、指标、追踪），Prometheus 兼容指标导出，DuckDB 分析引擎。

**缺点**：项目太新，和 CLIProxyAPI 一样依赖 CLI OAuth。

---

### 6. WebAI-to-API（低活跃）

| 属性 | 值 |
|------|---|
| 链接 | https://github.com/Amm1rr/WebAI-to-API |
| Stars | 984 |
| 语言 | Python (FastAPI) |
| 最新版 | v0.4.0（2025-06-27） |
| 状态 | **低活跃**，3 个月前更新 |

**做什么**：通过 Cookie + HTTP 模拟访问 Gemini/ChatGPT/Claude/DeepSeek，暴露 OpenAI 兼容 API。

**缺点**：纯 Cookie HTTP 请求，Cloudflare 拦截严重，更新慢。

---

## 已停滞/废弃项目

| 项目 | Stars | 停止时间 | 死因 |
|------|-------|---------|------|
| acheong08/ChatGPT | 28K | 2023-08 | OpenAI 持续对抗逆向工程 |
| chat2api | 3.4K | 2025-05 | ChatGPT Token 机制变更 |
| deepseek4free | 272 | 2025-02 | DeepSeek 更新 PoW 机制 |

**教训**：纯逆向 HTTP API 的方案生命周期很短，需要持续高频维护或采用更抗封锁的技术路线。

---

## 核心竞品三方对比

### 技术路线对比

| 维度 | **web-model-bridge (我们)** | **OpenRelay** | **WebAI2API** |
|------|---------------------------|---------------|---------------|
| **核心思路** | 真实 Chrome Cookie + Web API 直调 | 聚合 IDE/API 配额，统一路由 | Camoufox 模拟人类操作网页 |
| **浏览器** | Chrome (Playwright CDP) | 无（纯 HTTP 代理） | Camoufox (Firefox/Playwright) |
| **API 调用方式** | 直接 HTTP 调 Web API 端点 | 透传到 Provider API | 操控 DOM 输入/点击/等待 |
| **开源程度** | 完全开源 (TypeScript) | 闭源二进制（仅 cookie.ts 公开） | 完全开源 (JavaScript) |
| **运行时** | Node.js + Chrome | 独立二进制（Node.js SEA） | Node.js + Camoufox + Xvfb |

### 功能对比

| 功能 | **我们** | **OpenRelay** | **WebAI2API** |
|------|---------|---------------|---------------|
| Provider 数量 | 11 个 Web | 32 个 (8 IDE + 24 API) | 17 个适配器 |
| API 格式 | OpenAI + Anthropic | OpenAI + Anthropic | OpenAI |
| 文本生成 | 有 | 有 | 有 |
| 图片生成 | 无 | 无 | 有（LMArena、Gemini、ChatGPT、豆包） |
| 视频生成 | 无 | 无 | 有（Sora、Gemini） |
| Web 管理面板 | Dashboard | Web 面板（中英双语） | Vue.js WebUI + VNC |
| 故障转移 | Router fallback 链 | 模型组合 (Pro) | 顺序候选转移 |
| 负载均衡 | 无 | round-robin (Pro) | 3 种策略 |
| 请求队列 | 无 | 无 | FIFO + 动态缓冲 |
| 心跳保活 | 无 | 无 | 3 秒心跳（comment/content） |
| 一键 CLI 配置 | 无 | Claude Code/Aider/Goose | 无 |
| IDE RPC 代理 | 无 | Cursor/Windsurf/Copilot | 无 |
| Docker 部署 | 无（计划中） | 无（二进制分发） | 有（含 Xvfb/VNC） |

### 性能对比

| 指标 | **我们** | **OpenRelay** | **WebAI2API** |
|------|---------|---------------|---------------|
| 请求方式 | HTTP 直调 Web API | HTTP 透传 | 浏览器 DOM 操作 |
| 首次响应延迟 | 低（~100ms 网络延迟） | 低（纯代理转发） | 高（页面加载 + DOM 操作 + 等待） |
| 内存占用（每请求） | 极低（HTTP 请求） | 极低（代理） | 高（浏览器实例 1-2GB） |
| 并发能力 | 中（单 browser context） | 高（纯代理） | 低（每请求占浏览器窗口） |
| 流式处理 | SSE 流式 | SSE 流式 | SSE 流式（含心跳保活） |

### 稳定性与风险对比

| 风险 | **我们** | **OpenRelay** | **WebAI2API** |
|------|---------|---------------|---------------|
| 被平台封锁 | 低（真实 Chrome） | 中（IDE 可能封堵 token 提取） | 中低（Camoufox 反检测） |
| API 变更影响 | 中（依赖 Web API 逆向） | 低（使用官方 API） | 高（依赖 DOM 结构） |
| 长时间运行 | 稳定（HTTP 请求无状态） | 稳定（纯代理） | 不稳定（CLICK_TIMEOUT 是最热 issue） |
| Cookie 过期 | 需手动刷新 | 自动刷新 | 浏览器保持登录 |
| 安全审计 | 可审计（完全开源） | 不可审计（闭源二进制） | 可审计（完全开源） |

### 中文模型覆盖对比

| 中文模型 | **我们** | **OpenRelay** | **WebAI2API** |
|---------|---------|---------------|---------------|
| DeepSeek | 有（含 PoW 求解） | 有（API Key） | 有（v3.2 系列） |
| 通义千问 | 有 | 有（DashScope API） | 无 |
| Kimi | 有（Connect RPC） | 有（Moonshot API） | 无 |
| 智谱 GLM | 有（签名认证） | 有（API Key） | 无 |
| 豆包 | 有 | 有（Volcengine API） | 有（含图片） |
| 小米 MiMo | 有 | 无 | 无 |

**中文模型优势明显**：我们支持 6 个中文 Web Provider，且全部为免费 Web 版（不需要 API Key）。OpenRelay 虽然也覆盖中文模型，但走的是需要 API Key 的付费 API 路线。WebAI2API 仅覆盖 DeepSeek 和豆包。

---

## 竞争格局总结

### 三个赛道，三种用户

| 赛道 | 目标用户 | 核心诉求 | 代表 |
|------|---------|---------|------|
| **配额复用** | 已有多个 IDE 付费订阅的开发者 | "我在 Cursor 的配额能不能给 Claude Code 用？" | OpenRelay |
| **Web 转 API** | 有 Web 账号但没有 API 配额的用户 | "我已经付了 ChatGPT Plus，但没有 API 额度" | **我们**、WebAI2API |
| **免费聚合** | 不想花钱的用户 | "有没有完全免费的 AI API？" | gpt4free、OpenRelay (API) |

### 我们的核心差异化

1. **技术路线独特**：唯一采用"真实浏览器 + API 直调"的方案，兼具真实浏览器的抗封锁能力和 API 调用的高性能
2. **完全开源**：对比 OpenRelay 的闭源二进制，完全可审计
3. **中文模型最全**：6 个中文 Web Provider，全部免费 Web 版
4. **双 API 兼容**：同时支持 OpenAI 和 Anthropic 格式（WebAI2API 仅支持 OpenAI）
5. **轻量高效**：HTTP 直调 vs DOM 操作，性能差一个数量级
6. **DeepSeek PoW 求解**：WASM 加速的独特技术实现

### 我们的短板

1. **多模态缺失**：不支持图片/视频生成（WebAI2API 支持）
2. **并发架构简单**：无连接池、请求队列、负载均衡（WebAI2API 有完整方案）
3. **Cookie 维护**：登录态过期需手动刷新（OpenRelay 自动刷新）
4. **分发方式**：需要 Node.js 环境运行（OpenRelay 是独立二进制）
5. **工具集成**：无一键配置 Claude Code/Aider/Cursor（OpenRelay 有）
6. **知名度**：新项目，尚需推广

### 可借鉴的功能

| 来源 | 功能 | 优先级 | 理由 |
|------|------|--------|------|
| WebAI2API | 请求队列 + 心跳保活 | P1 | 长时间请求防超时 |
| WebAI2API | 故障转移 + 负载均衡策略 | P1 | 提升可靠性 |
| OpenRelay | 免费 API Provider 接入 (Groq/Cerebras/SambaNova) | P2 | 低成本扩展模型范围 |
| OpenRelay | 一键 CLI 配置命令 | P2 | 降低使用门槛 |
| WebAI2API | 图片/视频生成支持 | P3 | 多模态能力 |
| WebAI2API | Docker 部署方案 | P3 | 服务器端部署 |
| OpenRelay | 独立二进制分发 | P3 | 简化安装 |

---

## 定位声明

> **web-model-bridge** 是唯一采用真实浏览器 + API 直调的开源方案，以最轻量的方式将 Web AI 模型转为标准 API。不需要付费订阅，不需要 API Key，不需要复杂部署 — 一行命令，11 个平台，OpenAI + Anthropic 双格式兼容。
