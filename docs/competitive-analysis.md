# 竞品分析

> 截至 2026 年 4 月实时验证

## 竞品全景

将 Web AI 模型免费暴露为 API 的开源项目，主要有三条技术路线：

| 技术路线 | 原理 | 代表项目 | 抗封锁能力 |
|---------|------|---------|-----------|
| **多提供商聚合** | 聚合第三方免费接口和逆向 API | gpt4free | 低（接口频繁失效） |
| **CLI OAuth 代理** | 包装官方 CLI 工具的 OAuth 认证 | CLIProxyAPI, ccproxy-api | 中（依赖 OAuth 不被封） |
| **Cookie/Token 模拟** | 手动获取 Token 后模拟 HTTP 请求 | chat2api, WebAI-to-API | 低（Cloudflare 拦截） |
| **浏览器自动化** | Playwright/CDP 真实浏览器 | **web-model-bridge (我们)** | **高（真实浏览器指纹）** |

---

## 活跃竞品详细分析

### 1. gpt4free

| 属性 | 值 |
|------|---|
| 链接 | https://github.com/xtekky/gpt4free |
| Stars | 66K |
| 语言 | Python |
| 最新版 | v7.4.2（2026-04-05） |
| 状态 | **非常活跃**，每天更新 |

**做什么**：聚合多个免费 LLM 提供商和逆向接口，提供 OpenAI 兼容 API + Web GUI。

**优点（学习）**：
- 提供商健康检查和自动切换 — 某个接口挂了立刻切到下一个
- MCP Server 集成 — Claude Code/Gemini CLI 可以直接通过 MCP 调用
- 社区驱动的适配器模式 — 任何人可以贡献新提供商
- Web GUI + API 双入口 — 满足不同用户习惯

**缺点（规避）**：
- 依赖第三方免费接口，**频繁失效** — 几乎每周都有提供商失效需要修补
- 法律灰色地带 — 多个提供商涉及 ToS 违规
- Python 生态 — 对 Node.js/TypeScript 用户部署不友好
- 代码质量参差 — 社区贡献的适配器质量不一

---

### 2. CLIProxyAPI

| 属性 | 值 |
|------|---|
| 链接 | https://github.com/router-for-me/CLIProxyAPI |
| Stars | 23.3K |
| 语言 | Go |
| 最新版 | v6.9.15（2026-04-04），共 547 个版本 |
| 状态 | **极其活跃**，30 天 517 个 issue/PR |

**做什么**：将 Claude Code、Gemini CLI、ChatGPT Codex 等官方 CLI 工具包装为 OpenAI/Anthropic 兼容 API。需要用户有 Claude Max/ChatGPT Plus 等付费订阅。

**优点（学习）**：
- 多账号负载均衡 — 同一 provider 配置多个 OAuth 账号，自动轮换
- 原生桌面应用 — macOS 菜单栏、Windows TUI，用户体验好
- VSCode 插件 — 编辑器内直接配置和使用
- Go 高性能 — 低延迟转发
- 547 个 release 的迭代速度 — 说明这个赛道需要高频维护

**缺点（规避）**：
- **需要付费订阅** — Claude Max $100/月或 ChatGPT Plus $20/月，不是真正免费
- 依赖 CLI OAuth 认证 — 如果厂商封堵第三方 OAuth 就会失效
- Go 语言 — 对 Node.js 生态不友好
- 复杂度高 — 547 个版本说明维护成本也极高

---

### 3. ccproxy-api

| 属性 | 值 |
|------|---|
| 链接 | https://github.com/CaddyGlow/ccproxy-api |
| Stars | 216 |
| 语言 | 未详 |
| 最新版 | v0.2.7（2026-03-31） |
| 状态 | **活跃** |

**做什么**：本地插件式反向代理，统一访问 Claude/OpenAI/GitHub Copilot。

**优点（学习）**：
- 19+ 内置插件（日志、分析、指标、追踪）— 可观测性做得最好
- Prometheus 兼容指标导出 — 标准化监控
- DuckDB 分析引擎 — 本地数据分析
- 凭据健康检查和自动轮换

**缺点（规避）**：
- 项目太新，Star 少，生态不成熟
- 和 CLIProxyAPI 一样依赖 CLI OAuth

---

### 4. WebAI-to-API（低活跃）

| 属性 | 值 |
|------|---|
| 链接 | https://github.com/Amm1rr/WebAI-to-API |
| Stars | 984 |
| 语言 | Python (FastAPI) |
| 最新版 | v0.4.0（2025-06-27） |
| 状态 | **低活跃**，3 个月前更新 |

**做什么**：最接近我们的竞品。通过 Cookie + HTTP 模拟访问 Gemini/ChatGPT/Claude/DeepSeek，暴露 OpenAI 兼容 API。

**优点（学习）**：
- 自动 Cookie 提取工具 — `browser.py` 自动从本地浏览器读取 Cookie
- 双服务器冗余设计 — 主服务 + gpt4free 备份
- 多平台支持广

**缺点（规避）**：
- 纯 Cookie HTTP 请求 — Cloudflare 保护的站点（Claude/ChatGPT）经常被拦截
- 更新慢 — 平台 API 变化后长期无法适配
- 社区小 — 问题难以快速解决

---

## 已停滞/废弃项目

| 项目 | Stars | 停止时间 | 链接 | 死因 |
|------|-------|---------|------|------|
| acheong08/ChatGPT | 28K | 2023-08 归档 | https://github.com/acheong08/ChatGPT | OpenAI 持续对抗逆向工程 |
| chat2api | 3.4K | 2025-05 | https://github.com/LanQian528/chat2api | ChatGPT Token 机制变更 |
| deepseek4free | 272 | 2025-02 | https://github.com/xtekky/deepseek4free | DeepSeek 更新 PoW 机制 |
| LlM-Api-Open | 45 | 2024-05 | https://github.com/F33RNI/LlM-Api-Open | 维护者放弃 |

**教训**：acheong08/ChatGPT 曾有 28K stars，是这个领域的开创者，但因 OpenAI 持续升级反爬措施被迫归档。说明**纯逆向 HTTP API 的方案生命周期很短**，需要持续高频维护或采用更抗封锁的技术路线。

---

## web-model-bridge 的定位

| 维度 | 我们 | gpt4free | CLIProxyAPI | WebAI-to-API |
|------|------|----------|-------------|-------------|
| 技术路线 | 真实浏览器自动化 | 多提供商聚合 | CLI OAuth 代理 | Cookie HTTP 模拟 |
| 平台数 | 11 | 多（不固定） | 4-5 | 5 |
| 需要付费订阅 | **不需要** | 不需要 | 需要 | 不需要 |
| 抗封锁能力 | **高** | 低 | 中 | 低 |
| API 格式 | OpenAI + Anthropic | OpenAI | OpenAI + Anthropic | OpenAI |
| Dashboard | 有 | 有 | 有 | 无 |
| 语言 | TypeScript | Python | Go | Python |
| 跨平台 | Win/Mac/Linux | Win/Mac/Linux | Win/Mac/Linux | Win/Mac/Linux |

**核心差异化**：我们是唯一用真实浏览器自动化 + 不需要付费订阅 + 同时支持 OpenAI 和 Anthropic 格式的项目。
