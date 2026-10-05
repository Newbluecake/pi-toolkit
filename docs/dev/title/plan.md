# 会话标题模型生成（任务 #12）

会话没有名字时，首个用户消息（`before_agent_start` 时刻）用一个便宜模型生成 ≤20 字
标题并 `pi.setSessionName` 落档。TUI resume 列表、web-hub 列表/详情头读的都是 session
name（`session_info` entry），因此两侧自动受益，零 UI 侧改动。

## 决策记录

- **触发点：`before_agent_start`**（而非首轮 `turn_end`）：首条用户消息此刻已展开
  （`event.prompt`），生成与首轮回答**并行**，标题最早落到 web-hub 卡片；handler 内只做
  同步门检，生成 fire-and-forget（goal/hook.ts R1 同款，绝不信 await 阻塞事件泵）。
- **模型：`title.model`，默认 `zai-coding-cn/glm-5.3-flash`**。订阅线
  （`quota.providers` 同源 `zai-coding-cn`）里最便宜最快的 flash 档：本机订阅单价
  $0.12/M in、$0.42/M out（订阅额度内边际成本 0），单次标题 ≤512 token（含推理模型
  thinking 余量），成本与延迟都可忽略；zai-coding-cn 是 pi-ai 内置目录 provider，
  `modelRegistry.find` 开箱可用。异机无此 provider / strict 解析失败 / 空串哨兵 ⇒ 回落
  当前会话模型（`memory.tidy.model` 同款约定）；无任何可用模型 ⇒ 静默放弃。
- **completion 路径：`ctx.modelRegistry.complete(model, context, options)`**——pi 同步
  兼容门面的一次性 API（请求时鉴权由 registry 处理）。repo 里另一条路（memory tidy）
  走重型 subagent spawn，对 ≤512 token 的一次性调用不值得起会话。
- **不重复生成**：`attempted` 闩锁在 handler 同步段置位（JS 单线程无竞态）；
  `session_start`（new/resume/fork/reload）重置——pi 的扩展 activate() 在每次会话替换时都会重跑
  （`main.js createRuntime → resource-loader → factory(api)`），本层闩锁重置是双保险的第二层，
  新会话理应重新获得命名机会。`pi.getSessionName()` 已有名字（用户 `/name` 过或已生成过）
  ⇒ 跳过；写入前再读一次，生成期间用户 `/name` 了则以用户为准，模型标题作废；
  写入前还复验会话身份（`ctx.sessionManager.getSessionId()` 触发时快照），生成在途
  `/new` / `/resume` 切了会话就作废晚到的标题——否则会写到新会话头上。
- **失败静默**：每次尝试 `AbortSignal.timeout(10s)` 硬超时；网络/429/超时/空输出最多
  2 次尝试（间隔 1s 退避）后放弃，不 retry 风暴、不告警——标题是纯增值，绝不打断
  主会话。sanitize 后为空串（模型只回了标签/空白）按失败计。
- **sanitize**（`src/title/title.ts`）：剥 `标题:`/`Title:` 前缀标签与 `**`/引号包裹 →
  空白折叠（换行变空格）→ 剥首尾句读 → 码点安全截断 60 字符硬上限（模型目标 ≤20 字，
  60 是兜底）。内部标点保留（`don't`、`C++` 不误伤）。
- **范围：仅主会话**。装配在 `src/index.ts` post-guard 区（HOST_KEY 之后，结构上仅主
  会话可达，TUI+RPC+json 都有）；子会话 print 模式不可达，`wireTitle` 仍自查
  `isChildSession` 作双保险。
- **设置面（用户拍板的最小面）**：`title.enabled`（默认 on）+ `title.model`；超时/尝试
  次数/截断是模块常量（规格钉死），不做成旋钮。非 live（activate 时捕获，改后
  `/reload`）。

## 文件

- `src/title/title.ts` — 纯核心：常量、`sanitizeTitle`、`buildTitlePrompt`、
  `createTitleTrigger` 状态机（端口注入，无 pi import）。
- `src/title/index.ts` — `wireTitle`：pi 装配（事件注册 + `ExtensionContext.modelRegistry`
  → 端口适配；模型解析惰性取最近 handler 的 ctx，生成时刻解析，不做 activate 快照）。
- `src/config/settings.ts` — `TitleSettings` / defaults / `parseTitleSettings`。
- `src/config/setting-specs.ts` — `title.enabled` / `title.model` 两个键。
- `tests/title/` — sanitize 纯函数 + 假 completion 端口的触发矩阵；
  `tests/config/title-settings.test.ts` — 解析容错。

## 验收锚点

- 已命名跳过 / 子会话跳过 / 失败静默（2 次后放弃、无未处理 rejection）/ 只生成一次 /
  `session_start` 重置 / 写入前 `/name` 竞态以用户为准 / 写入前 `/new` 切会话作废 /
  prompt 截断前 2000 字符 / 模型解析回退链（ref→会话模型→放弃）。
