# web-model-bridge 使用指南

## 快速开始

### 第一步：安装并启动

```bash
# 全局安装
npm install -g web-model-bridge

# 或者用 npx 直接运行（不需要安装）
npx web-model-bridge
```

启动后你会看到：
```
  ✓ Server running at http://localhost:3456
  ✓ API Base: http://localhost:3456/v1
  ✓ 3 providers, 0 authenticated
  ✓ Dashboard: http://localhost:3456 (opening in browser)

  No providers authenticated yet.
  Open the Dashboard to login → http://localhost:3456
```

### 第二步：在 Dashboard 登录 Web 模型

浏览器会自动打开 Dashboard（http://localhost:3456）。你会看到三个 Provider：

| Provider | 网站 | 说明 |
|----------|------|------|
| Claude Web | claude.ai | 需要 Claude 账号 |
| ChatGPT Web | chatgpt.com | 需要 OpenAI 账号 |
| DeepSeek Web | chat.deepseek.com | 需要 DeepSeek 账号 |

点击 **[Login]** 按钮 → 弹出登录页面 → 正常登录（和你平时上网一样）→ 登录完成后窗口自动关闭 → Dashboard 显示 ✓ 已认证。

### 第三步：配置 OpenClaw 使用 web-model-bridge

编辑 OpenClaw 的配置文件 `~/.openclaw/openclaw.json`，添加一个自定义 Provider：

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "webmodel": {
        "baseUrl": "http://127.0.0.1:3456/v1",
        "apiKey": "not-needed",
        "models": [
          {
            "id": "claude-web/claude-sonnet-4-6",
            "name": "Claude Sonnet 4.6 (Web, Free)",
            "api": "openai-completions",
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "claude-web/claude-opus-4-6",
            "name": "Claude Opus 4.6 (Web, Free)",
            "api": "openai-completions",
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "chatgpt-web/gpt-4o",
            "name": "GPT-4o (Web, Free)",
            "api": "openai-completions",
            "contextWindow": 128000,
            "maxTokens": 4096
          },
          {
            "id": "deepseek-web/deepseek-chat",
            "name": "DeepSeek Chat (Web, Free)",
            "api": "openai-completions",
            "contextWindow": 64000,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

> **说明**：`apiKey` 设为任意值（web-model-bridge 默认不需要 token）。如果你配置了 `--auth-token`，则填写对应的 token。

### 第四步：在 OpenClaw 中选择 Web 模型

```bash
# 启动 OpenClaw
openclaw

# 选择模型时选择 "Claude Sonnet 4.6 (Web, Free)" 等
```

OpenClaw 发送请求到 `http://127.0.0.1:3456/v1/chat/completions` → web-model-bridge 通过浏览器调用真实的 Web API → 返回 OpenAI 格式的响应 → OpenClaw 正常接收。

**零 token 消耗** — 因为请求是通过你的浏览器登录态发出的，走的是网页版的免费额度。

---

## 在其他工具中使用

### Claude Code

在 Claude Code 的设置中配置自定义 API：
```json
{
  "apiBase": "http://127.0.0.1:3456/v1"
}
```

### Cursor

Settings → Models → OpenAI API Base URL → `http://localhost:3456/v1`

### Open WebUI

设置 → Connections → OpenAI API → Base URL: `http://localhost:3456/v1`

### 任何支持 OpenAI API 的工具

只要工具支持自定义 `base_url`，指向 `http://localhost:3456/v1` 即可。

---

## 常驻后台运行

如果你不想每次都手动启动：

```bash
# 注册为系统服务（开机自启）
web-model-bridge install-service

# 卸载
web-model-bridge uninstall-service
```

> 注：系统服务功能计划在 Phase 2 实现。

---

## 配置选项

### 命令行选项

```bash
web-model-bridge                    # 默认启动
web-model-bridge -p 8080            # 自定义端口
web-model-bridge --host 0.0.0.0     # 允许远程访问（需配合 --auth-token）
web-model-bridge --auth-token mysecret  # 设置访问密码
web-model-bridge --no-open          # 不自动打开浏览器
web-model-bridge --state-dir /path  # 自定义数据目录
```

### 配置文件

`~/.webmodel/config.yml`：

```yaml
server:
  port: 3456
  host: 127.0.0.1
  authToken: null                # 设置后需 Bearer Token 访问

browser:
  idleShutdown: 300              # 无请求 5 分钟后关闭 Chrome 节省内存

providers:
  enabled:
    - claude-web
    - chatgpt-web
    - deepseek-web

logging:
  level: info
```

---

## 数据存储

所有数据在 `~/.webmodel/`：

```
~/.webmodel/
├── config.yml         # 配置文件
├── auth.json          # Provider 认证状态
├── chrome-profile/    # 专用 Chrome 登录数据（Cookie 持久化）
└── logs/              # 日志
```

---

## 故障排查

### "Browser not connected" 错误
Chrome 未启动或 CDP 连接失败。检查：
- 系统已安装 Google Chrome
- 没有其他进程锁定 Chrome profile 目录

### Cookie 过期
Dashboard 上 Provider 显示 ⚠ 已过期 → 点击 [重新登录] → 登录后自动恢复。

### 端口被占用
web-model-bridge 默认用 3456 端口。如果冲突：
```bash
web-model-bridge -p 8080
```

### 查看日志
```bash
web-model-bridge -v   # verbose 模式
# 或查看日志文件
cat ~/.webmodel/logs/bridge.log
```
