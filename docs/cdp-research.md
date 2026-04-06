# Chrome CDP 研究与解决方案

> 实际调试过程中发现的问题和解决方案，2026-04-06。

---

## 核心发现

### Chrome 不允许在默认 Profile 上开启 CDP

当 Chrome 使用默认 profile 目录（`~/Library/Application Support/Google/Chrome`）时，即使传入 `--remote-debugging-port=9222` 参数，Chrome 也**拒绝**开启 CDP 调试端口。

**错误信息**：
```
DevTools remote debugging requires a non-default data directory. Specify this using --user-data-dir.
```

**原因**：Chrome 的安全设计。默认 profile 包含用户的密码、支付信息等敏感数据，Chrome 不允许通过 CDP 暴露这些数据。

**验证过程**：
```bash
# 失败：使用默认 profile
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
# → 错误：DevTools remote debugging requires a non-default data directory

# 失败：显式指定默认目录也不行
--user-data-dir="$HOME/Library/Application Support/Google/Chrome"
# → 同样的错误，Chrome 识别出这是默认目录

# 成功：使用非默认目录
--user-data-dir="/tmp/chrome-test" --remote-debugging-port=9222
# → CDP 正常启动，但没有用户的登录态
```

### Chrome 不允许两个实例共用同一个 Profile

Chrome 使用 `SingletonLock` 文件锁定 profile 目录。当 Chrome 已经在运行时：

```bash
ls -la "$HOME/Library/Application Support/Google/Chrome/SingletonLock"
# → lrwxr-xr-x SingletonLock -> seeksage-2396  （指向进程 PID）
```

尝试用相同 profile 启动第二个 Chrome 实例时，新进程会检测到锁文件，将命令转发给已有进程并退出。这意味着**不可能在不关闭 Chrome 的情况下用同一个 profile 启动带 CDP 的第二个实例**。

### 复制 Profile 可以获得 Cookie 但有限制

```bash
# 复制关键文件
mkdir -p ~/.webmodel/chrome-cdp-profile/Default
cp "$ORIG/Default/Cookies" ~/.webmodel/chrome-cdp-profile/Default/
cp "$ORIG/Default/Login Data" ~/.webmodel/chrome-cdp-profile/Default/
cp "$ORIG/Local State" ~/.webmodel/chrome-cdp-profile/

# 用副本启动
--user-data-dir="$HOME/.webmodel/chrome-cdp-profile" --remote-debugging-port=9222
# → CDP 正常，Cookie 有效（有时间窗口）
```

**限制**：
- Cookie 是时间点快照，不会自动同步
- 某些网站的 session 绑定了浏览器指纹，副本可能失效
- Chrome 加密 Cookie 的密钥存在 macOS Keychain 中，副本可以读取（同一用户）

---

## 最佳解决方案：复用 OpenClaw 的 Chrome

**发现**：openclaw-zero-token 项目的 onboard 过程已经启动了一个带 CDP 的 Chrome 实例。配置在 `~/.openclaw/openclaw.json`：

```json
{
  "browser": {
    "attachOnly": true,
    "defaultProfile": "openclaw",
    "profiles": {
      "openclaw": {
        "cdpUrl": "http://127.0.0.1:9222"
      }
    }
  }
}
```

这个 Chrome 使用独立 profile（非默认），已经通过 onboard 让用户登录了各个 AI 网站，CDP 端口 9222 已经开启。

**web-model-bridge 直接连接它即可**：

```bash
npx web-model-bridge --cdp-url http://127.0.0.1:9222
```

### 自动检测认证状态

连接 CDP 后，web-model-bridge 自动扫描浏览器中的 Cookie，检测哪些 provider 已登录：

```typescript
async autoDetectAuth(): Promise<Record<string, boolean>> {
  const ctx = await this.ensureBrowser();
  const cookies = await ctx.cookies();
  
  for (const [providerId, domain] of Object.entries(PROVIDER_DOMAINS)) {
    result[providerId] = cookies.some(c => c.domain.includes(domain));
  }
}
```

**实测结果**（复用 OpenClaw Chrome）：
```
✓ Chrome CDP connected at http://127.0.0.1:9222
✓ Auto-detected 10 authenticated providers from browser cookies
✓ 11 providers, 10 authenticated
✓ 15 models available
```

零手动操作，零登录，直接可用。

---

## 各场景对应方案

### 场景 1：用户有 OpenClaw（最佳）

```bash
# OpenClaw 的 Chrome 已在后台运行
npx web-model-bridge
# → 自动连接 CDP 9222 → 自动检测 Cookie → 15 个模型直接可用
```

### 场景 2：用户没有 OpenClaw，Chrome 已打开

```bash
# Chrome 在运行但没有 CDP
# 方案 A：关闭 Chrome 重启（推荐）
killall "Google Chrome"
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.webmodel/chrome-profile" &

# 方案 B：用 launch 模式（不关 Chrome，但需重新登录）
npx web-model-bridge --browser-mode launch
```

### 场景 3：用户没有 Chrome

```bash
npx web-model-bridge
# → doctor 检测到 Chrome 未安装
# → 提示安装命令（macOS/Linux/Windows）
```

---

## 技术细节

### CDP 连接方式对比

| 方式 | Playwright API | 用途 |
|------|---------------|------|
| `connectOverCDP(url)` | 连接到已有 Chrome 的 CDP 端口 | attach 模式 |
| `launchPersistentContext(dir)` | 启动新 Chrome + 持久化 profile | launch 模式 |
| `launch()` | 启动新 Chrome（临时 profile） | 测试用 |

### Cookie 检测逻辑

| Provider | 检测域名 | 说明 |
|----------|---------|------|
| claude-web | claude.ai | Anthropic 主域 |
| chatgpt-web | chatgpt.com | OpenAI 主域 |
| deepseek-web | deepseek.com | |
| kimi-web | moonshot.cn | Kimi 的母公司域名 |
| qwen-web | qwen.ai | |
| glm-web | chatglm.cn | 智谱清言 |
| grok-web | grok.com | xAI |
| gemini-web | google.com | Google 大域名（Cookie 较多） |
| perplexity-web | perplexity.ai | |
| doubao-web | doubao.com | 字节跳动 |
| xiaomimo-web | xiaomimimo.com | 小米 |

### macOS Chrome 启动参数

```bash
# 带 CDP 启动（需要非默认 profile）
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.webmodel/chrome-profile" \
  --no-first-run \
  --no-default-browser-check \
  --remote-allow-origins="*"
```

### Windows Chrome 启动参数

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:USERPROFILE\.webmodel\chrome-profile"
```

### Linux Chrome 启动参数

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.webmodel/chrome-profile"
```
