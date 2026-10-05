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

---

# v2：随任务动态刷新标题（2026-10-06，用户拍板「按建议推进」）

v1 只在首条用户消息生成一次、永不更新。问题：首条消息常无信息量（「继续」「看一下」），
`/reload` 后用的是 reload 后的下一条消息；且「已有名字 ⇒ 跳过」无法区分「我们生成的」与
「用户 /name 的」，因此无法更新自己的标题。

## 拍板口径（用户已确认，下游不得改）

1. **首条消息快速首标（保留 v1）**：`before_agent_start` 时会话未命名 ⇒ 立即生成，列表不空着。
2. **在 `agent_settled` 按里程碑刷新**：一次 run 收尾后，满足任一条件即刷新：
   - 自上次生成以来新增用户输入数 ≥ `title.refreshEveryInputs`（默认 4，0 = 关闭此条件）；
   - 自上次生成以来新增用户输入 ≥ 1 **且** 累计 agent 运行时长 ≥ `title.refreshAfterMinutes`
     （默认 15，0 = 关闭此条件）——对应「执行任务一段时间后」。运行时长 = 每次
     `before_agent_start` → `agent_settled` 的墙钟累加（仅内存，reload 归零，可接受）。
3. **输入**：旧标题（若有，作为锚点）+ 最近 5 条用户输入（每条码点截 400，合计 ≤2000）+
   最近一条 assistant 回复的文本开头（≤600 码点，无则省略）。首标场景：无旧标题，用户输入 =
   branch 里既有用户消息 + 本次 `event.prompt`（覆盖 reload/resume 后首标）。
4. **所有权判定（核心变化）**：每次成功写名后追加 `pi.appendEntry("subagent:title",
{ name, inputs })`（`inputs` = 写入时的用户输入计数）。判定：
   - 当前名字为空 ⇒ 可生成（首标）；
   - 当前名字 === 最近一条 `subagent:title` 记录的 `name` ⇒ 自有，可刷新；
   - 否则（用户 `/name`、web `/name`、v1 遗留标题无记录）⇒ **用户所有，本会话永久停止自动更新**。
   - `getSessionName()` 遍历全部 fileEntries（会话级，不分 branch），所以最近自有记录也按
     **会话级**取（遍历 `sessionManager.getEntries()` 倒序找最近 `custom` /
     `customType === "subagent:title"`），两者口径一致。
   - v1 遗留标题会被当成用户所有、不再刷新：v1 只上线一天，接受。
5. **稳定性与成本**：
   - 刷新 prompt 要求「当前标题仍贴合就原样输出当前标题；只有任务焦点明显变化才换」；
   - sanitize 后与当前名字相同 ⇒ 不写 `session_info`、不追加记录，但**视为一次成功刷新**
     （基线前移，计数与运行时长清零），防止下一轮立刻再触发；
   - 每会话刷新上限 `title.maxRefreshes`（默认 5，不含首标；0 = 只首标不刷新）；计数 =
     会话级 `subagent:title` 记录条数 − 1（首标那条），重启后可从会话文件恢复；
   - 失败（2 次尝试耗尽/空输出）同样基线前移（计数与时长清零），下次等下一个里程碑，不风暴。
6. **在途互斥**：同一时刻最多一个生成在途（`inFlight` 闩锁），在途时新的触发直接跳过。
7. **状态恢复**：`session_start` 时从 branch 重建用户输入计数（`getBranch()` 中
   `type==="message" && message.role==="user"` 的条数），基线 = 最近自有记录的 `inputs`
   （无记录则 0）；运行时长清零。`before_agent_start` 每次计数 +1（在门检之前）。
   注意 v1 的「通知唤醒轮不经过 before_agent_start」：唤醒轮不计入用户输入，符合预期。
8. **写入前复验保留 v1 全部守卫**：重读名字（期间所有权变了 ⇒ 作废）+ 会话身份快照复验。
   刷新场景的「名字变了」判据 = 当前名字 !== 触发时的名字。
9. **子会话不触发**（不变）。

## 设置面（新增 3 键，非 live）

`title.refreshEveryInputs`（int ≥0，默认 4）、`title.refreshAfterMinutes`（int ≥0，默认 15）、
`title.maxRefreshes`（int ≥0，默认 5）。`settings.ts` 的 `TitleSettings` / defaults /
`parseTitleSettings`（逐字段容错，非法回落默认）+ `setting-specs.ts` 三个 count 型键
（参照同文件其他 int 键的写法），并把 `title.enabled` 描述改为不再只说 first message。
`refreshEveryInputs=0 && refreshAfterMinutes=0` ⇒ 行为等价 v1（只首标）。

## 文件域

- `src/title/title.ts` — 纯核心改造：`buildTitlePrompt` 改为接收
  `{ previousTitle?, userInputs: string[], assistantExcerpt? }`；触发器新增
  `onAgentSettled()`、端口新增读会话快照（用户输入列表、最近 assistant 文本、最近自有记录、
  用户输入计数）与 `recordOwnTitle(name, inputs)`；时间用注入的 `now()`。
- `src/title/index.ts` — 装配：注册 `agent_settled`；端口用 `ctx.sessionManager.getBranch()` /
  `getEntries()` 实现；`pi.appendEntry` 写记录。
- `src/config/settings.ts`、`src/config/setting-specs.ts` — 新 3 键。
- `src/index.ts` — 只改 `wireTitle(...)` 调用参数（传入新设置），不加逻辑（I7）。
- `tests/title/title.test.ts`、`tests/title/wire.test.ts`、`tests/config/title-settings.test.ts`
  （若不存在则看 tests/config 里现有 title 解析测试所在文件）。
- `docs/dev/title/plan.md`（本文件）验收锚点补充；`AGENTS.md` 若有 title 描述则同步一行（目前无，可不动）。

## 验收锚点（v2 新增）

- 首标仍在 `before_agent_start` 立即触发，输入含 branch 既有用户消息 + 本次 prompt；
- 第 N（=4）条新输入后的 `agent_settled` 触发刷新，prompt 含旧标题 + 最近 5 条输入 + assistant 摘录；
- 新输入 ≥1 且累计运行 ≥15min 的 `agent_settled` 触发刷新；新输入 0 时不触发；
- 刷新结果与旧名相同 ⇒ 不写名、不追加记录、基线前移；
- 用户 `/name` 后（名字 ≠ 最近自有记录）永久不再刷新；生成在途用户 `/name` ⇒ 作废；
- 刷新达 `maxRefreshes` 后不再触发；设置为 0 的各种组合；
- 在途互斥：在途时再次触发不发第二个请求；
- `session_start` 从会话条目重建计数与基线（reload 后不会立即误触发、也不会丢计数）；
- 失败基线前移、无未处理 rejection、所有 timer unref；子会话不注册。

## v2 评审处置（r1，reviewer gpt-5.6-sol 打回 15 条 → 主会话裁定，本节覆盖上文冲突口径）

总原则：标题是纯增值功能，**一切异常都向「少刷新 / 停止刷新」的安全方向退化**，不追求跨 reload 精确。
据此把状态模型收敛为「内存计数 + 会话级自有记录」两件事，删去 branch 重建与持久基线。

**最终状态模型（唯一口径）**

- 内存（闭包内、per-wiring）：`inputsSinceGen`（自上次生成后的 before_agent_start 次数）、
  `inputSeq`（单调递增，每次 before_agent_start +1）、`busyMs`（累计运行时长）、`runStartedAt`、
  `lastRunOk`、`epoch`（`session_start` / `session_shutdown` 各 +1）、`inFlight`（AbortController|undefined）。
- `session_start`：全部内存状态清零（`inputsSinceGen=0, busyMs=0, inFlight=undefined`），epoch+1。
  **不从 branch 重建计数**——reload/resume 后刷新最多推迟 N 条输入，可接受（#1/#4 消解）。
- `before_agent_start`：`inputSeq++`、`inputsSinceGen++`、`runStartedAt=now()`；然后首标门检（v1 逻辑）。
- `agent_end`：取 `event.messages` 中最后一条 assistant，`lastRunOk = stopReason 不是 "aborted"/"error" 且无 errorMessage`（#6）。
- `agent_settled`：`busyMs += now()-runStartedAt`（runStartedAt 有值时），然后刷新门检：
  `lastRunOk` ∧ 无在途 ∧ 自有（见下）∧ 刷新额度未满 ∧
  (`inputsSinceGen ≥ refreshEveryInputs>0` ∨ (`inputsSinceGen ≥1` ∧ `refreshAfterMinutes>0` ∧ `busyMs ≥ refreshAfterMinutes·60000`))。
- 生成结束（成功写入 / same-name / 失败耗尽）：`inputsSinceGen=0, busyMs=0`。**结果被丢弃（stale）时不清零**，下次 settled 再判。
- `session_shutdown`：abort 在途请求（#13）、epoch+1。

**所有权与额度（会话级，#8/#9）**

- 记录 schema（#14）：`appendEntry("subagent:title", { v: 1, name: string(非空), at: number })`；
  读取时 `getEntries()` 倒序找第一条 `type==="custom" && customType==="subagent:title"` 且 schema 校验通过的；非法记录跳过。
- 判定：当前名字空 ⇒ 首标；当前名字 === 最近有效记录 name ⇒ 自有可刷新；否则用户所有 ⇒ 不刷新。
- 刷新额度：有效记录条数 − 1 ≥ `maxRefreshes` ⇒ 不刷新。same-name / 失败 / stale 不追加记录、不耗额度。
- 口径声明：所有权与额度是**会话级**（与 `getSessionName()` 遍历全部 fileEntries 一致）；输入/摘要是**当前 branch**。
  `/tree` 切 branch 后标题仍是会话级——反映最近活动即可。fork/resume 不做特殊状态表：新会话文件里有什么就按上述规则判（确定性）。
- 写入顺序（#3）：`setSessionName(name)` → `appendEntry(record)`。两步之间失败 ⇒ 名字无匹配记录 ⇒ 判为用户所有 ⇒ 停止刷新（安全方向，接受，不做恢复协议）。

**过期结果隔离（#2/#5）**

- 触发时把 `ctx` 作为参数**快照**传入本次生成（不读共享可变 `ctxRef`），同时快照 `{ epoch, inputSeq, sessionKey, nameAtTrigger }`。
- 写入前全部复验：epoch 未变、inputSeq 未变（期间有新输入 ⇒ stale 丢弃）、sessionKey 未变、当前名字 === nameAtTrigger。
  首标场景 inputSeq 快照取「本次 +1 之后」的值，与首轮回答并行生成不受影响（首轮内无新 before_agent_start）。
- completion 的 signal = 会话级 AbortController 与 10s 超时合并（`AbortSignal.any`）。

**输入定义（#7，裁定）**：所有 `before_agent_start` 都计数——包括 /goal 续轮、compaction/switch_context 恢复、web 投递的 prompt。
理由：这些都代表会话在推进任务，标题跟着它们刷新是期望行为；成本由 `maxRefreshes` 封顶。不引入来源元数据。

**文本提取与预算（#10/#11）**——在 pi 装配层（index.ts）提取成结构化快照再给纯核心：

- 用户输入：`getBranch()` 中 `type==="message" && message.role==="user"`；content 为 string 直接用，为数组则拼接 `type==="text"` 块；
  图片-only / 空白 ⇒ 跳过。首标时追加本次 `event.prompt`（它尚未进入 branch）。取最近 5 条。
- assistant 摘录：branch 中最后一条 `role==="assistant"` 且 `stopReason` 非 aborted/error、无 errorMessage、有 text 块的消息，拼接 text 块（忽略 thinking/toolCall）。compaction entry 不参与。
- 预算（码点）：旧标题 ≤60；用户输入每条 ≤400、合计 ≤2000（从最新往旧装，装不下即停）；assistant 摘录 ≤600。三者分别计，不共享总额。

**设置解析（#12）**：三个新键 `Number.isSafeInteger(x) && x >= 0` 否则回默认；字符串数字不接受。

**测试矩阵（#15，强制）**：纯核心（假端口）+ 装配层（假 pi/ctx，含假 sessionManager 的 getBranch/getEntries/appendEntry 顺序）：
首标 / 第 N 条输入后 settled 刷新 / 时长条件刷新（注入 now）/ 0 新输入不刷新 / aborted·error run 不刷新 /
same-name 不写不记且清零 / 失败清零 / stale（在途时新输入）丢弃且不清零 / epoch 变化（reload）丢弃 /
session_shutdown abort 在途 / 用户 /name（名字≠记录）永不刷新 / 写名后 appendEntry 抛错 ⇒ 后续判用户所有 /
额度耗尽 / 非法记录跳过 / 文本提取（数组 content、图片-only、assistant error 跳过、预算截断码点安全）/
设置解析边界（NaN/Infinity/1.5/-1/"4"）/ 两个触发条件都为 0 ⇒ 等价 v1 / 子会话不注册。

## 验收处置（r2，主会话裁定）

verify r2 余留两项：① 共享 `ctxRef` 仍供 `readUserInputs`/`readAssistantExcerpt`/`titleRecords` 三个读端口使用——
裁定接受：三者只在设置 `ctxRef.current` 的**同一个同步 handler 段**内被调用（`title.ts` onBeforeAgentStart /
onAgentSettled，调用前无 await），读出的纯数据随 `generate()` 入参快照传入，异步段从不回读；会跨 await 的
completion/模型解析/会话身份已由 `buildDeps(ctx)` 按次绑定。② 缺 branch 最近 assistant `stopReason: aborted`
的摘录跳过测试——主会话补齐（`tests/title/wire.test.ts` it.each aborted/error）。
