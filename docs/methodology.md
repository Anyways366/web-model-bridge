# 高质量交付方法论

> 从本次 web-model-bridge 项目实践中提炼的完整方法论，适用于任何中等复杂度的软件项目。核心理念：**每一步都有验证，每一轮都有提升，绝不跳过质量环节。**

---

## 总览流程

```
需求探索 → 设计方案 → 实施规划 → 编码实现 → 测试验证 → 代码审查 → 设计优化 → 开源研究 → 交付
    ↑                                              ↓
    └──────── 每个阶段都可以回到前面修正 ────────────┘
```

---

## 阶段一：需求探索（Superpowers Brainstorming）

### 目标

把模糊的想法变成清晰的、可执行的设计方案。

### 流程

1. **探索项目上下文**
  - 阅读现有代码、文档、git 历史
  - 理解相关项目的架构（本次研究了 openclaw-zero-token 的完整架构）
  - 找到 issue/需求的真正意图，不只看表面文字
2. **逐一提问，不要一次问完**
  - 每次只问一个问题，等用户回答后再问下一个
  - 优先用选择题（A/B/C/D），降低用户回答成本
  - 给出推荐选项和理由，不要让用户自己决定所有事情
  - 关键问题举例：目标用户是谁、核心功能范围、技术方案选型、部署形态、API 兼容性
3. **提出 2-3 种方案，带权衡分析**
  - 每种方案列出 Pros/Cons
  - 明确推荐一个并说明原因
  - 用可视化工具（如 brainstorming visual companion）展示复杂对比
4. **分节呈现设计，逐步确认**
  - 不要一次性丢出完整设计
  - 按"架构 → 接口 → CLI/配置 → 错误处理 → 测试策略"分节
  - 每节确认后再继续下一节
5. **写设计文档（Spec）并自审**
  - 保存到 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
  - 自审检查清单：
    - 占位符扫描（TBD/TODO）
    - 内部一致性（接口名称、方法签名）
    - 范围检查（是否可以在一个实施计划中完成）
    - 模糊性检查（是否有歧义）
  - 提交给用户审查，**用户确认后才进入下一步**

### 本次实践教训

- 第一版设计中"多步骤启动"太复杂，用户反馈后简化为"一条命令启动 + Web Dashboard"
- 测试策略最初太简略，用户强调质量后大幅加强
- **用户的反馈是最重要的设计输入，不要急着写代码**

---

## 阶段二：实施规划（Writing Plans）

### 目标

把设计文档转化为可以逐步执行的、无歧义的实施计划。

### 流程

1. **先映射文件结构**
  - 列出所有要创建/修改的文件及其职责
  - 确定模块边界和依赖关系
  - 文件结构决定了任务分解
2. **拆分为 bite-sized 任务**
  - 每个任务 2-5 分钟可完成
  - 每个步骤都是一个动作：写测试 → 验证失败 → 写实现 → 验证通过 → 提交
  - **每个步骤都要给出完整代码**，不要写"类似 Task N"
3. **TDD 驱动**
  - 先写测试，再写实现
  - 测试先运行验证失败（确认测试本身有效）
  - 实现后运行验证通过
  - 每个任务完成后提交
4. **计划自审**
  - Spec 覆盖检查：每个需求都有对应的任务
  - 占位符扫描：不允许 TBD/TODO
  - 类型一致性：后面的任务引用前面定义的接口名是否一致

### 本次实践数据

- 18 个任务，覆盖项目骨架到最终构建验证
- 每个任务有明确的文件列表、代码、测试命令和期望输出

---

## 阶段三：编码实现

### 目标

按计划高效执行，同时保持代码质量。

### 原则

1. **严格模式，零容忍**
  - TypeScript `strict: true`
  - `noUnusedLocals`, `noUnusedParameters`
  - 编译不过不能提交
2. **批量创建，统一验证**
  - 没有依赖关系的文件可以并行创建（用子 agent）
  - 创建完后统一运行 typecheck + 全量测试
  - 有错误立即修复，不要堆积
3. **频繁提交，语义化消息**
  - 每完成一组相关任务就提交
  - commit message 说明做了什么、影响什么
  - 方便后续回溯和审查
4. **不要过度设计**
  - 先让它工作，再让它优雅
  - 共享代码的时机：当 3+ 处有相同逻辑时再抽取
  - 本次实践：11 个 Provider 的 SSE 读取循环在第一轮就应该抽取，但实际是代码审查后才做的

---

## 阶段四：部署要求（傻瓜式安装 + 跨平台兼容）

### 目标

用户从零开始到能用，不超过 3 步，不需要看文档。

### 核心原则

1. **一条命令启动**
  ```bash
   npx web-model-bridge  # 安装 + 环境检查 + 启动服务 + 打开 Dashboard
  ```
  - 不要让用户记多个命令和顺序
  - 不要区分 install/configure/serve 步骤
  - 所有步骤合并为一个入口
2. **自动环境检查（Doctor）**
  - 启动前自动检测：Node.js 版本、Chrome 路径、端口可用性
  - 有问题给出明确的修复指引（具体命令，不是"请安装 Chrome"）
  - 致命问题阻止启动，非致命问题警告但继续
  - `-v` 模式显示完整诊断
3. **跨平台兼容**
  - macOS：`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
  - Linux：`/usr/bin/google-chrome`, `/snap/bin/chromium`, `which` fallback
  - Windows：`%PROGRAMFILES%\Google\Chrome\Application\chrome.exe`
  - 用 `process.platform` 分支，不要假设用户的操作系统
4. **错误信息要可操作**
  - 不好：`Error: ECONNREFUSED`
  - 好：`Chrome not found. Install: brew install --cask google-chrome (macOS) / sudo apt install google-chrome-stable (Linux)`
  - 每个错误都带修复建议
5. **Web Dashboard 替代 CLI 交互**
  - 登录、状态查看、配置这些操作放在浏览器里
  - 比 CLI 的 inquirer 多选更直观
  - 用户不需要学任何命令

---

## 阶段五：测试验证循环

### 目标

交付的代码必须是可编译、可运行、功能正确的。不是"大概能用"，是"测试证明能用"。

### 三层测试体系


| 层级     | 工具                      | 覆盖内容             | 是否需要外部依赖 |
| ------ | ----------------------- | ---------------- | -------- |
| 单元测试   | Vitest                  | 每个模块的核心逻辑        | 不需要      |
| 集成测试   | Vitest + mock           | 完整请求链路、SSE 格式一致性 | 不需要      |
| E2E 测试 | Vitest + 真实 HTTP server | 服务器生命周期、端到端请求    | 需要端口     |


### 质量循环（必须走完，不可跳过）

```
编码 → typecheck → 测试 → 失败？→ 修复 → typecheck → 测试 → 通过？→ 构建 → 提交
                           ↑                                    ↓
                           └────────── 不通过就循环 ─────────────┘
```

### 测试编写原则

1. **每个模块都有对应的测试文件**
  - `src/core/errors.ts` → `tests/unit/core/errors.test.ts`
  - 不是"写完所有代码再补测试"，是"写一个模块测一个模块"
2. **测试覆盖 happy path + error path**
  - 正常请求能返回正确格式
  - 缺字段返回 400
  - 未认证返回 401
  - 无效 token 返回 403
  - 未知 model 返回 400
3. **SSE 协议一致性专项测试**
  - 每个 chunk 是完整的 `data: {json}\n\n`
  - 第一个 chunk 包含 `role: assistant`
  - 最后一个 chunk 有 `finish_reason`
  - 结尾是 `data: [DONE]\n\n`
  - 所有 chunk 共享同一个 run ID
4. **E2E 测试用真实 HTTP**
  - 启动真实服务器（随机端口）
  - 用 `fetch()` 发真实请求
  - 验证完整的请求→路由→处理→响应链路

### 本次实践数据

- 150 个测试，19 个测试文件
- 单元 109 + 集成 28 + E2E 13
- 两轮代码审查后都重新跑全量测试验证

---

## 阶段六：代码审查循环

### 目标

发现编码阶段遗漏的问题。审查不是走形式，是真正找 bug。

### 流程

```
实现完成 → 派发 code-reviewer agent → 收到反馈 → 分级处理 → 修复 → 全量测试 → 再次审查（如有需要）
```

### 问题分级和处理


| 级别         | 定义                 | 处理               |
| ---------- | ------------------ | ---------------- |
| Critical   | 功能不正确、安全漏洞、会导致生产故障 | **立即修复**，修复后重新测试 |
| Important  | 设计偏差、缺失功能、代码质量问题   | 当轮修复，不要留到下一轮     |
| Suggestion | 优化建议、风格改进          | 评估后选择性采纳         |


### 本次两轮审查发现的典型问题

**第一轮（4 Critical + 8 Important）：**

- `stream` 默认值错误（违反 OpenAI 规范）— 一行修复但影响所有客户端
- Dashboard XSS 注入 — innerHTML 拼接用户数据
- Provider 未接入浏览器 — 代码写了但没 wire 起来
- 管理端点不受 auth 保护 — 只保护了 `/v1/`*

**第二轮（2 Critical + 3 Important）：**

- Auth 不支持 `x-api-key` header — Anthropic SDK 不用 Bearer
- `system` 字段不支持 array 格式 — Claude Code 会发 cache_control 块
- 11 个 Provider 有 300 行重复代码 — 抽取共享 SSE reader

### 教训

- **第一次就不会写对的东西**：默认值、header 格式、字段类型这些细节，不审查根本发现不了
- **审查后必须重新跑全量测试**：修复一个问题可能引入新问题
- **审查至少两轮**：第一轮修复后的代码本身可能有问题

---

## 阶段七：设计优化（VoltAgent/awesome-design-md 方法）

### 目标

UI 不只是"能用"，而是"好看又好用"。用设计系统保证一致性。

### 方法论

**VoltAgent/awesome-design-md** 的核心思想：**写一个 DESIGN.md，定义完整的设计 token 系统，然后让 AI（或开发者）严格按照这个文档生成 UI。**

### DESIGN.md 的 9 个章节


| 章节                        | 内容                     | 作用                 |
| ------------------------- | ---------------------- | ------------------ |
| Visual Theme & Atmosphere | 设计哲学、视觉氛围              | 定调——这是什么感觉的产品      |
| Color Palette & Roles     | 所有颜色的 hex 值和语义角色       | 颜色不是随便选的，每个颜色有明确用途 |
| Typography Rules          | 字体族、大小、粗细、行高、字间距       | 层级通过排版而非颜色建立       |
| Component Stylings        | 按钮、卡片、输入框等每种状态的样式      | 组件规范，确保一致性         |
| Layout Principles         | 间距系统（8px base）、容器宽度、网格 | 空间节奏               |
| Depth & Elevation         | 阴影系统、层级关系              | 深度感                |
| Do's and Don'ts           | 设计守则和反模式               | 防止偏离               |
| Responsive Behavior       | 断点、触控目标、折叠策略           | 多设备支持              |
| Agent Prompt Guide        | 快速颜色参考和提示词             | 给 AI 的快速参考         |


### 实施步骤

1. 从 awesome-design-md 收录的 55+ 项目中选一个风格参考（本次选了 Vercel 的开发者工具风格）
2. 读取参考项目的 DESIGN.md，理解其设计 token 体系
3. 为自己的项目创建 DESIGN.md，定义所有 token
4. 按 DESIGN.md **严格**重写 CSS/HTML
5. CSS 使用 CSS Variables 对应 DESIGN.md 中的 token 名称

### 本次教训

- 第一次做 Dashboard 时没用这个方法，只是"随便写个深色主题"
- 结果颜色不一致、间距没有系统、字体随意
- 用 DESIGN.md 方法重做后，每个像素都有依据

---

## 阶段八：开源研究

### 目标

站在巨人的肩膀上。不要闷头造轮子，先看看别人怎么做的。

### 方法

1. **搜索 GitHub 近 3 个月 trending 项目**
  - 筛选 15K+ star 的
  - 按类别分类：AI 工具、开发者工具、Agent 框架、API 网关
2. **对每个相关项目分析**
  - 它做了什么（一句话）
  - 哪些功能/设计可以借鉴
  - 具体怎么借鉴（不是"参考它的架构"，而是"在 ProviderRegistry 上层增加 Router 类实现 fallback 链"）
3. **分优先级呈现给用户**
  - 高优先级：直接提升核心竞争力的
  - 中优先级：增强易用性的
  - 低优先级：长期演进方向
4. **等用户审核后再实施**
  - 不要自己决定加什么功能
  - 列出选项和理由，让用户选择

### 本次研究成果

- 30 个项目，提炼出 9 个可借鉴的功能方向
- LiteLLM 的 fallback 链、OpenClaw 的插件化、SigNoz 的可观测性是最有价值的借鉴

---

## 阶段八-B：竞品分析

### 目标

学习别人的优点，规避别人的缺点。避免重复造轮子，也避免踩已知的坑。

### 方法

1. **搜索同功能的开源项目**
  - 用精确关键词组合搜索：功能名 + 技术手段 + "github"
  - 例如："web to api" "chatgpt" "browser" "cookie" github
  - 搜索 5-8 组不同关键词确保覆盖全面
2. **验证项目真实状态**
  - 用 `gh api` 或 GitHub 页面确认：最后 commit 日期、是否 archived、近 30 天活跃度
  - **不要信 AI 搜索结果的描述**，可能过时或幻觉，必须实时验证
  - 区分三类：活跃可用 / 低活跃 / 已停滞
3. **从每个竞品提取两份清单**
  - **优点清单**：它做得好的功能、设计、用户体验，具体到可执行的建议
  - **缺点清单**：它踩过的坑、用户抱怨的问题、架构缺陷，具体到我们要规避什么
4. **分析废弃项目的死因**
  - 废弃项目往往最有价值——它们证明了什么路走不通
  - 例如：acheong08/ChatGPT (28K stars) 因 OpenAI 持续反爬被迫归档 → 说明纯逆向 HTTP API 不可持续
5. **定位差异化**
  - 画对比表：技术路线、平台数、是否免费、抗封锁能力、API 格式、语言
  - 明确"我们做了什么别人没做的"

### 输出格式

详见 `docs/competitive-analysis.md`。包含：

- 竞品全景（技术路线分类）
- 每个活跃竞品的优缺点分析
- 废弃项目的死因教训
- 自身定位差异化对比表

### 本次教训

- **验证很重要**：初始搜索时有些项目描述看着很厉害，实际验证后发现已经一年没更新
- **废弃项目的教训最有价值**：acheong08/ChatGPT 的经历直接影响了我们选择"浏览器自动化"而非"逆向 HTTP API"的技术路线
- **竞品的迭代频率说明赛道特性**：CLIProxyAPI 有 547 个 release，说明这个赛道需要高频维护才能存活

---

## 阶段九：交付检查清单

每个项目交付前必须过一遍：

### 代码质量

- TypeScript strict 模式零错误
- 全量测试通过（单元 + 集成 + E2E）
- 至少两轮代码审查，所有 Critical/Important 问题已修复
- 无未使用的代码、无 `any` 类型（安全关键模块）
- 共享逻辑已抽取，无大段重复代码

### 用户体验

- 一条命令启动
- 自动环境检查 + 错误修复建议
- 跨平台兼容（macOS/Linux/Windows）
- 错误信息可操作（带修复命令）
- Web Dashboard 替代 CLI 交互

### 文档

- README.md 英文版（VoltAgent 风格：badges、feature table、architecture 图）
- DESIGN.md 设计系统文档
- 使用指南（各工具的配置方法）
- API 参考

### 设计

- DESIGN.md 定义完整的设计 token 系统
- UI 严格按照 DESIGN.md 实现
- CSS Variables 对应 design tokens
- 响应式布局

### 安全

- 无 XSS（DOM API 替代 innerHTML）
- 无硬编码密钥
- 默认 localhost-only
- 可选 auth token 保护所有端点
- 日志脱敏

---

## 附：工具链参考


| 环节   | 工具                              | 用途               |
| ---- | ------------------------------- | ---------------- |
| 需求讨论 | superpowers:brainstorming       | 结构化的需求探索         |
| 实施规划 | superpowers:writing-plans       | TDD 驱动的实施计划      |
| 代码审查 | superpowers:code-reviewer       | 自动化代码审查          |
| 开发分支 | superpowers:using-git-worktrees | 隔离开发             |
| 设计系统 | VoltAgent/awesome-design-md     | DESIGN.md 驱动的 UI |
| 开源研究 | GitHub trending + WebSearch     | 借鉴业界最佳实践         |
| 测试   | Vitest + msw                    | 单元 / 集成 / E2E    |
| 构建   | tsup                            | TypeScript 打包    |
| 类型检查 | tsc --noEmit                    | 编译时类型安全          |


