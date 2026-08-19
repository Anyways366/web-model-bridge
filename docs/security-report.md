# web-model-bridge Security Report

Date: 2026-08-19. Scope: DeepSeek Web adapter (independent implementation, MIT).
Reference: NIyueeE/ds-free-api v0.2.6 used only as external behavioral reference — no GPL code copied, no binary used as implementation, no source ported.

## Credential scan
- Working tree scan for account passwords, API keys (`sk-*`), test credentials: **clean** (no matches outside `node_modules`/`dist`/`.git`).
- No credentials committed anywhere. DeepSeek password never enters the bridge — login happens in the browser; the bridge holds session cookies in the browser profile directory and a bearer token **in memory only** (`DeepSeekProvider.bearerToken`, never logged, stripped on process exit).
- Local-API credential: `--auth-token` / `WMB_AUTH_TOKEN` (env), never persisted by the bridge.

## Logging hygiene
- No request/response logging of prompts, tool arguments, tool results, Authorization headers, or tokens. All `console.log` output is startup/status text.
- Config `logging.file` is not written by the server code (no log transport); nothing captures secrets.

## Telemetry / analytics / updaters
- None found (`telemetry|posthog|sentry|mixpanel|google-analytics|analytics` → 0 matches in `src/`). No remote update checking, no crash reporting.

## Outbound network policy (fail-closed)
- All destinations in `src/` enumerated:
  - **Provider origins** (navigation targets, now allowlisted in `BrowserManager` via `network-policy.ts`): chatgpt.com, claude.ai, www.doubao.com, chat.deepseek.com, chat.qwen.ai, www.kimi.com, chatglm.cn, grok.com, gemini.google.com, aistudio.xiaomimimo.com, www.perplexity.ai
  - **DeepSeek protocol hosts** (explicitly allowlisted): `chat.deepseek.com`, `fe-static.deepseek.com`
  - **Local only**: `127.0.0.1:<cdp>` (Chrome DevTools protocol)
  - **Display-only strings** (never fetched): nodejs.org, google.com/chrome, github.com (dashboard link)
- `src/core/network-policy.ts`: `assertAllowedUrl`/`assertAllowedHostname`/`isUrlAllowed` normalize (case, trailing dot) and reject anything not in the allowlist. Enforced at every code-initiated navigation/fetch/login (`BrowserManager.getPageForOrigin`, `fetchInBrowser`, `startLogin`). Default cli set = every enabled provider's declared origin + DeepSeek hosts.
- **Mid-flight enforcement (navigation gate, `src/browser/navigation-gate.ts`):** every page the manager creates gets a route interceptor that aborts any main-frame navigation whose target host is not allowlisted — covering initial load, server redirects, and JS-driven jumps (the previous "browser-followed redirects not policed" residual). Subresources (assets/XHR) intentionally pass: the DeepSeek page loads multiple CDNs, and a malicious page on an allowed host could exfiltrate via DOM APIs regardless. Credential-bearing calls cannot be steered by the page anyway — the DeepSeek provider posts to fixed absolute endpoints (`DEEPSEEK_API_CREATE_SESSION`/`DEEPSEEK_API_COMPLETION` in `client.ts`), passed as explicit evaluate args and verified by unit test to be unchangeable by user/model content.
- Residual (documented): (1) subresource loads are not host-gated (rationale above); (2) `kimi-web` performs one direct Node `fetch` (`kimi-web/index.ts:102`) outside the browser allowlist, and kimi client host `kimi.moonshot.cn` differs from its navigation host — out of DeepSeek scope, noted for follow-up; (3) DeepSeek provider sends its bearer auth only on the two `/api/v0/` endpoints (`deepseek/index.ts:185`).

## Bind policy
- Default bind `127.0.0.1` (`config/loader.ts`). Wildcard hosts (`0.0.0.0`, `::`) are **refused at config load** (tested). `/v1/*` and `/webmodel/*` require `Authorization: Bearer` or `x-api-key` matching `--auth-token`/`WMB_AUTH_TOKEN`. Local API credential is never sent to DeepSeek.

## Processes / files / env
- Subprocesses: only Chrome launch for CDP (`cli.ts`); no shell exec of user input.
- File writes: `auth.json` (statuses only, no secrets), browser profile dir (session cookies, OS-owned), config. No crash dumps.
- Env access: `WMB_*` vars only (`config/loader.ts`).

## Dependencies
- `npm audit`: 7 findings (1 low, 1 moderate, 5 high) — **all in dev-time toolchain** (`vite`, `postcss`, `nanoid` transitives). Runtime deps (hono, playwright-core, commander, chalk, js-yaml, open) clean. No new dependencies added by this work.

## Test status
- `tsc --noEmit` clean; unit **331/331 green (32 files)**, integration **20/20 green**.
- Security tests: `network-policy` (allowlist allow/reject, redirect targets), `browser/navigation-gate` (allowed nav succeeds, unexpected host aborts, redirect target aborts, lookalike subdomains rejected, assets pass), `deepseek-outbound` (provider targets exactly the two absolute allowlisted endpoints; user/model URLs can never steer them; bearer sent only to endpoint hosts). DeepSeek provider suites: 9 files, 143 tests.
- e2e suites requiring live provider sessions/auth-profiles fail in CI-less environments (no browser/creds; `auth-profiles.json` absent) — pre-existing, **verified identical without these changes** (stash-and-rerun of `diagnose-deepseek`, `diagnose-sse`).