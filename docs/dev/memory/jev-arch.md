# 以分类器 Jev 为核心的 memory 架构（jev-arch v1）

> 状态：架构设计稿（2026-10-30），未动代码。取代 `hygiene-plan.md` v4.1（Q19），可复用部件见 §12.2。
> 需求基线：`hygiene-flow.md` 第七轮 Q19–Q24 优先；Q1–Q18 中不冲突的部分继续有效，逐条处置见 §12.1。
> 事实底图：`jev-current-state.md` §1–9（代码）与 §10（Jev 实测）。本文对现有代码的断言给 `文件:行号`，对 pi 行为的断言给文档或 d.ts 坐标；未经实测的标「需 P0 验证」，由 J0 包的 conformance 钉住。
> 读者：§1–§15 写给下游的方案和开发，§16 写给不读代码的用户。

## 0. 结论速览

| 问题     | 决定                                                                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一句话   | Markdown 记忆文件仍是唯一的权威数据源；Jev 产出的派生标签存进可丢弃的侧车索引；召回、打标、整理、拦截四项智能判断都只经过一个 pi-free 的 Jev 客户端（有序列表 + 逐模型故障转移 + 错误分级 + 可选专用代理）                                                                            |
| 条目     | 顶层列表项及其续行，或没有列表项的 `## ` 小节整体（§4.1）。现有语料约 150 条，绝大多数是列表项                                                                                                                                                                                        |
| 谁写什么 | **权威事实**写在条目行内注释里，由用户或 agent 手写：用户令、到期、门禁覆盖、手工标签增减、私密（§4.2）。**派生判断**是 Jev 选出来的：类型、重要度、场景标签、是否高危、门禁模式、时效性，存在 `<slug>/.jev/index.json`，丢了可以重算（§4.4）                                         |
| 标签体系 | 预置 6 种类型 + 4 级重要度 + 约 22 个通用场景标签（§4.3），项目可在 `.jev/taxonomy.json` 里增加。标签的 `description` 原样作为 Jev 问题的 criteria。命令前缀、路径 glob 这类匹配器只挂在**标签**上，条目上不再手写触发词（Q24）                                                       |
| ① 召回   | 用户消息到来时由 Jev 判定全部候选（≤约 150 条一次判完，再多就分批并行，>360 条走两段式），在 `before_agent_start` 最多等 1.5s，等到了随本轮注入，超时则晚到补发。动作快速通道按标签匹配器零调用命中，失败结果由 Jev 从经验条目里挑排障条目                                            |
| ② 打标   | `memory` 工具写入后同步问 Jev 一次（约 60 个问题，<1.2s），把标签和相似、冲突条目回显给 agent。首次上线后台按标签批量打标（每个标签一次调用）                                                                                                                                         |
| ③ 整理   | 用标签重叠加词面相似组装候选对，问 Jev「重复/冲突/取代」；结果只作为建议，由用户在 `/mem review` 里逐条确认，绝不自动删除                                                                                                                                                             |
| ④ 拦截   | 三级粗筛：只读工具直接放行 → 高危标签的匹配器 → 必须存在带该标签的守护条目。三级都过了才同步问 Jev（choice：unrelated / applies / violates_now），据此拦一次（闩锁）或持续拦截（hold）。绝大多数工具调用零延迟                                                                        |
| 硬依赖   | Jev 不可用（设置关、secure 域、pi 无分类器 API、全部无凭证、401/402/403/451、熔断、预算耗尽）时，四项智能判断全部停止，只剩现有分层注入和确定性的数据模型部件（用户令守卫、到期提示）。可用性以**真实调用结果**为准，有凭证不等于可用；状态在 `/mem`、`/mem jev` 和状态变化通知里可见 |
| 外发     | 一律先截断再脱敏；文件正文、成功的工具结果、system prompt、助手推理永不外发（§7）                                                                                                                                                                                                     |
| I9       | `memory.jev.enabled=false`，或 layout/toolSurface 取 legacy，或处于 secure/locked 域，都会让 Jev 部件零注册；J0 在未改动的 dev 上录制 `jev-off-golden.json`（A′，永不重生）作证明                                                                                                     |
| 规模     | 10 个包（J0–J9），新增 `src/memory/jev/` 一个子目录。B 级 golden 只刷新 `activate-trace.json`；tiered、legacy、doctor 三份 golden 预期逐字节不变（§4.5）                                                                                                                              |
| 待拍板   | 7 项（§14），每项都给出推荐                                                                                                                                                                                                                                                           |

## 1. 背景、目标与非目标

### 1.1 要解决的问题

- **召回失灵**（`hygiene-flow.md` 起因）：专题记忆派单十几次一次都没被召回。静态块按字母序贪心填索引，13 个文件只有 2 个拿到完整行（`src/memory/tiered.ts:716-717`）；`read_when` 是写给模型看的自然语言，模型不会自己去匹配。
- **过时与冲突无人发现**：已解禁的「GPT 临时禁用」、已作废的 droid 裁定在文件里留了 8 天。
- **写入质量靠自觉**：append 不刷新 `updated`（`src/memory/tool-v2.ts:610`）；agent 写入时不检查同主题旧条。
- **v4.1 的教训**：手写触发词（`kw=`/`cmd=`/`if-*`）要 agent 维护一套规则语言，噪音和漏判都要人去调。Jev 实测（`jev-current-state.md` §10）表明，「一次把全部候选都问一遍」的延迟几乎恒定（0.8–1.1s）、成本极低（200 个问题 $0.0006）。所以判断交给 Jev，规则只留作零调用的快速通道。

### 1.2 目标

1. Jev 承担四项职责（Q20）：①召回与注入的主判定；②写入时自动分类打标；③整理建议；④高危动作拦截判定。
2. Jev 是硬依赖（Q21）：不可用时干净降级到现有分层注入，并且用户看得见。
3. 外发数据截断加脱敏（Q23）；分类器有序列表、逐个故障转移、错误分级、可选专用代理（Q17/Q18）。
4. 遵守 I1、I4、I5、I8、I9、I11，不引入运行时依赖。

### 1.3 非目标

- 不让 Jev 生成任何文字（它做不到，`jev-current-state.md` §10）：合并草稿、改写都交给 agent 或现有 `/mem tidy`。
- 不自动删除、不静默隐藏记忆（Q1、`hygiene-flow.md`「不做」）。
- 不改 tidy/restore 的事务层（`src/memory/tidy/txn.ts` 等）。
- 不给外部 droid run 做主动注入（O8 维持）。
- 不改静态块的排序和目录样式（见 §5.6 的取舍）；不做按轮数或定时的注入。
- 不做 v4.1 的 D 内容触发、F 重复失败触发、G 意图触发。

### 1.4 与现有 memory 的关系

| 部件                                                                                                          | 处置                     | 说明                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 目录布局、文件名规则、frontmatter 字段（`src/memory/paths.ts`、`meta.ts:13-20`）                              | **保留**                 | 不增加 frontmatter 键                                                                                                |
| 分层静态块：hub section `pi_project_memory`（`src/memory/index.ts:116-135`、`inject.ts:286`）                 | **保留**                 | 这是 Jev 不可用时唯一保留的注入。仅当 jev 开启且文件里有行内注释时剥掉注释（§4.2），fixture 中没有注释，所以输出不变 |
| v2 工具 `memory`（`tool-v2.ts`）                                                                              | **保留 + 扩展**          | 写后打标与回显、append 刷新 `updated`、用户令守卫、新命令 `tag_add`。jev 开启时使用变体描述和变体 schema（§9.3）     |
| legacy layout / legacy 工具                                                                                   | **保留，且强制不接 Jev** | legacy 是字节兼容的退路，jev 设置对它无效                                                                            |
| `/mem` 命令族（`command.ts:154-241`）                                                                         | **保留 + 新子命令**      | 新增 `jev`、`tags`、`review`、`expired`；默认 list 在 jev 开启时多一行状态                                           |
| doctor D01–D14（`doctor.ts`）                                                                                 | **保留 + 新码**          | 新增 D17 到期、D18 行内注释语法错、D19 core 用量 ≥80%（被 D02/D03 抑止）                                             |
| 启动提醒 `createStartupReminder`（`doctor-command.ts:231`）                                                   | **保留 + 扩集合**        | 加入到期条目、core 用量、待审整理建议、Jev 不可用                                                                    |
| tidy / batch tidy / restore                                                                                   | **保留不动**             | 唯一的增量：语料里出现 `<!-- mem` 时，tidy prompt 加一条「原样保留行内注释」                                         |
| v4.1 的 `kw`/`tool`/`arg`/`cmd`/`path`/`on`/`out`/`exit`/`if-running`/`if-branch`/`if-session` 条目级规则语法 | **删除（从未实现）**     | 由 Jev 标签和 Jev 现场判定取代（Q24）。`gate`/`gate=hold`/`expires`/`until`/`user` 保留为行内权威键                  |
| v4.1 的 T2b「便宜对话模型」回退链、`memory.inject.judge.models`                                               | **删除（从未实现）**     | Q21：Jev 不可用就停止智能判断，不再退到对话模型                                                                      |

## 2. 现状摘要（与本设计相关的坐标）

- 装配：`src/index.ts:204-208` 先建 prompt hub，`src/index.ts:219-221` 在 pre-guard 调 `wireMemory`；子会话同样注册 memory（I3 pre-guard）。子会话在同一进程内由 `createAgentSession` 创建（`src/runtime/session-driver.ts:1`），所以进程级 `Symbol.for` 表可以在主会话和子会话之间共享。
- `wireMemory`（`src/memory/index.ts:71`）的全部可变状态都在闭包里（`:72-82`）；写后统一回调 `onAfterWrite`（`:87-99`）；section 的 `onRender`（`:123`，类型见 `inject.ts:63`、调用点 `inject.ts:276`）是拿到「哪些 core 小节已在静态块里」的唯一途径。
- 文件枚举只看 `*.md`（`src/memory/safe-fs.ts:202`），所以 slug 目录里新增的 `.jev/` 子目录不会被渲染、doctor 或 tidy 当成记忆文件（另有 `.backup`、`.trash`、`archive/` 的先例，`safe-fs.ts:834-880`）。
- 密钥识别：`src/memory/doctor.ts:129` 的 `SECRET_PATTERNS` 与 `:217-238` 的 `findSecrets`（未导出）；`src/core/redact.ts:6` 的 `redactSecrets`（pi-free，零依赖）；`src/web-hub/agent/redact.ts:77` 是 web 投影用的更强版本（敏感键名子串表）。
- secure：`getSecureDomain()`（`src/secure/domain.ts:718`）；D8 强制关闭集中在 `applySecureDomainOverrides`（`src/config/settings.ts:418-433`）；`src/memory/**` 目前零 secure 引用。
- 边界：`tests/boundary/pi-free.test.ts:165-174` 只钉了 `paths|frontmatter|store|render`；`tests/web-hub/boundary.test.ts:197` 规定 `src/memory/settings.ts` 只能 import `./tidy/batch-settings.js`，这份白名单只许收紧，因此新设置的解析必须写在 `settings.ts` 里，不能另开文件再 import。
- 时限工具：`clampSpanMs`（`src/core/deadline.ts:318`）、`createSegmentedClock`（`src/core/clock.ts:59`）。
- 后台任务通知 customType `bash-job:notification`（`src/bash/notify.ts:8`）。
- pi 1.4.0（`node_modules/@earendil-works/pi-coding-agent/package.json:3`）：
  - `ModelRegistry.getAvailableOfType` / `getModelOfType` / `classify`：`dist/core/model-registry.d.ts:44,45,47`，`classify` 的注释是 "Never rejects"；
  - `ClassifierOptions extends ProviderRequestOptions`，其中有 `fetch?`：`pi-ai/dist/types.d.ts:48-58,217`；
  - 问题与答案类型：`pi-ai/dist/types.d.ts:454-510`，文档 `docs/codemode.md:97-136`；
  - 扩展上下文提供 `modelRegistry`：`dist/core/extensions/types.d.ts:225`；
  - `before_agent_start` 的 handler 会被逐个 await，返回的 `message` 会收集起来（`dist/core/extensions/runner.js:1121-1150`）；
  - `tool_call` 的 handler 逐个 await，遇到 block 立即返回；这段**没有 try/catch**（`runner.js:957-970`），handler 抛错的后果需 P0 验证，所以我们的 handler 必须保证永不抛错；
  - 同一条 assistant 消息里的工具调用可能并行执行（`docs/extensions.md:236`）；
  - 嵌套的 `ctx.executeTool` 调用同样经过 `tool_call` 与 `tool_result`（`docs/extensions.md:261`），所以 codemode 脚本发起的 bash 也在门禁覆盖范围内；
  - 文档建议 gate handler 在无法判定时 fail closed（`docs/extensions.md:214`）。本设计在 §6.4 有意偏离这条建议，理由写在那里，并列为待拍板 D2。

## 3. 总体设计

### 3.1 模块划分

新增 `src/memory/jev/` 子目录。每个模块都要能回答「为什么必须存在」，回答写在表的最后一列。

| 模块                 | pi-free | 职责                                                                                                | 为什么必须存在                                                                       |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `jev/contracts.ts`   | ✅      | 全部类型、常量、消息 details 形状、本地镜像的分类器类型                                             | 冻结包间接口；本地镜像 pi-ai 类型，jev/* 就不用 import pi（I8）                      |
| `jev/entries.ts`     | ✅      | 条目切分、两种哈希、行内注释的解析和剥离、用户令判定                                                | 四项职责共用的「条目」单位；现有 `splitSections`（`meta.ts:174`）只能切到 `## ` 粒度 |
| `jev/taxonomy.ts`    | ✅      | 预置类型、重要度、标签；合并项目扩展；校验；按标签描述生成 criteria                                 | Q24 的固定可扩展体系                                                                 |
| `jev/index-store.ts` | ✅\*    | `.jev/index.json` 与 `.jev/taxonomy.json` 的读写（经 safe-fs 原子替换，持目录锁）                   | 派生标签的落盘；\*只依赖 `safe-fs`/`lock`，两者都 pi-free                            |
| `jev/redact.ts`      | ✅      | 截断与脱敏流水线                                                                                    | Q23                                                                                  |
| `jev/shell-parse.ts` | ✅      | bash 命令解析成 argv（原样复用 v4.1 §2.7.1 的设计）                                                 | 门禁粗筛和标签匹配器要识别 `git -C x push` 这类写法，而 `echo "git push"` 不能算     |
| `jev/match.ts`       | ✅      | 标签匹配器（工具名、命令前缀、路径 glob）和词面预筛打分                                             | 快速通道、门禁粗筛、超量候选的裁剪                                                   |
| `jev/questions.ts`   | ✅      | 为六种请求（recall/error/tag/tag-major/review/gate）构造 `ClassifierContext`，并按 token 估算分批   | 问题模板集中一处，便于评测与调参                                                     |
| `jev/decide.ts`      | ✅      | 把答案变成决定：阈值、top-k、字节预算、门禁判词、整理建议                                           | 纯函数，表驱动可测                                                                   |
| `jev/health.ts`      | ✅      | 错误分级、逐模型隔离表、汇总可用性状态机                                                            | Q17/Q21；有凭证不等于可用                                                            |
| `jev/proxy-fetch.ts` | ✅      | 只走 HTTP 代理的一次性 fetch（CONNECT + TLS，复用 v4.1 设计）                                       | Q18，零运行时依赖                                                                    |
| `jev/client.ts`      | ✅      | `JevClient`：结构化的 registry 端口、逐个故障转移、单档与总预算、分批并行、成本与次数记账、令牌桶   | 唯一调用 `classify()` 的地方                                                         |
| `jev/guard.ts`       | ✅      | 用户令被改动的检测（复用 v4.1 §3.2 的多重集合哈希配对）                                             | Q4                                                                                   |
| `jev/wire.ts`        | ❌      | pi 面：注册钩子、渲染器和 `/mem` 子命令，把以上部件拼起来；全部可变状态放在闭包里                   | I2/I4；唯一 import pi 的 jev 文件                                                    |
| `jev/segment.ts`     | ❌      | 段内去重记录（`appendEntry`）、回扫播种、门禁闩锁（复用 v4.1 §2.1/§2.2）                            | 同一段上下文只注入一次，跨 /reload 保持正确                                          |
| `jev/format.ts`      | ✅      | 注入消息正文、拦截文案、回显行、`/mem jev` 文本                                                     | 文案常量集中，便于金样本                                                             |
| `jev/review.ts`      | ✅      | 整理候选对组装与建议生成（纯）；`/mem review` 的交互放在 `wire.ts`                                  | ③                                                                                    |
| `jev/probes.ts`      | ✅      | 门禁状态证据：bash 任务端口、`/proc` 扫描、git HEAD、暂存文件（复用 v4.1 §2.7.3/§2.7.4 的实现规格） | ④ 需要给 Jev 看「现在是什么情况」                                                    |

现有文件的改动面：`src/memory/index.ts`（调用 `wireJev` 并传端口）、`tool-v2.ts`（写入端口）、`tool-surface.ts`（变体）、`settings.ts`、`setting-specs.ts`、`doctor.ts`（D17–D19，把 `SECRET_PATTERNS` 搬进新文件 `src/memory/secret-patterns.ts` 后两边共用，纯搬家，doctor 输出不变）、`doctor-command.ts`（启动提醒）、`command.ts`（分派）、`inject.ts`（`onRender` 多带 `omittedSections`，剥行内注释）、`tidy/prompt.ts`（条件规则）、`src/index.ts`（传 secure 判定和 bashJobs 晚绑定端口，属于装配，I2 允许）、`src/config/settings.ts:418`（D8 加入 `memory.jev.enabled=false`）。

### 3.2 结构图（依赖方向自上而下，✅ = pi-free）

```text
src/index.ts (assembly)
  └─ wireMemory (src/memory/index.ts)          ← secure 判定、bashJobs 端口作为参数传入
       ├─ memorySection / tiered (unchanged)    ← 静态分层注入（降级后唯一剩下的注入）
       ├─ createMemoryToolV2 ──(JevWritePort)──┐
       ├─ createMemCommand ───(JevCommandPort)─┤
       └─ wireJev (jev/wire.ts, pi-facing) ◄───┘
            ├─ segment.ts (appendEntry/getBranch)
            ├─ client.ts ✅ ── health.ts ✅ ── proxy-fetch.ts ✅ (node:http/tls/net)
            │      └─ ClassifierRegistryLike  ◄── ctx.modelRegistry (structural)
            ├─ questions.ts ✅ ── taxonomy.ts ✅ ── entries.ts ✅
            ├─ decide.ts ✅  review.ts ✅  guard.ts ✅  format.ts ✅
            ├─ match.ts ✅ ── shell-parse.ts ✅
            ├─ probes.ts ✅ ── src/git/run.ts ✅ (bounded git)
            ├─ redact.ts ✅ ── secret-patterns.ts ✅, src/core/redact.ts ✅
            └─ index-store.ts ✅ ── safe-fs.ts / lock.ts
```

依赖规则：

- `jev/*`（除 `wire.ts`、`segment.ts`）一律不 import pi，也不 import `tool-v2.ts`、`inject.ts`、`command.ts`。
- `tool-v2.ts`、`command.ts` 只通过 wireMemory 注入的端口接口调用 jev，自己从不 import `jev/wire.ts`。
- J1 把 `src/memory/jev/**`（除 `wire.ts`、`segment.ts`）和 `src/memory/secret-patterns.ts` 加进 `tests/boundary/pi-free.test.ts` 的根集合。

### 3.3 四条数据流

```text
[用户消息] before_agent_start(messageType=user)
   → 候选组装（排除静态 core、本段已注入、private）→ questions(recall) → client.ask(sync, ≤1.5s)
   → decide.pickRecall → 返回 {message} ｜ 超时则后续 sendMessage(triggerTurn:false)
   → segment.record

[工具调用] tool_call
   → shell-parse → match（标签匹配器）
      ├─ 命中高危标签 且 有守护条目 → probes(证据) → questions(gate) → client.ask(sync, ≤2.5s)
      │      → decide.gateVerdict → {block, reason} ｜ 放行
      └─ 普通标签命中 → 已打标条目（零调用）→ sendMessage(triggerTurn:false)（快速通道）
[工具结果] tool_result / bash-job:notification（只观察）
   → 失败且错误签名本段未见过 → questions(error) → client.ask(async) → sendMessage

[写入] memory 工具 create/str_replace/insert/append/write
   → 提交（现有锁内 CAS）→ entries diff → questions(tag) → client.ask(sync, ≤3s)
   → index-store.merge → 回显（标签、相似、冲突、时效、像用户令）

[整理] 会话开始（主会话，距上次 ≥ intervalDays 且语料有变）或 /mem review --run
   → review.pairs → questions(review) → client.ask(background) → index-store.review
   → UI 提示 → /mem review 逐条确认 → 删除走 .trash（可恢复）
```

## 4. 数据模型

### 4.1 条目（Entry）

对文件正文（去掉 frontmatter 和 drift banner，复用 `frontmatter.ts:37,88`）逐行扫描，围栏代码块内的行不参与判定：

1. `# ` 一级标题：只作文件标题，不成为条目。
2. `## `/`### ` 标题：开启新的上下文段。`heading` 取最近的 `## ` 标题，`### ` 拼成 `A › B`。
3. 第 0 列的列表项（`- `、`* `、`+ `、`N. `）开启一个新条目；随后缩进 ≥2 空格的行、列表内的空行、属于它的围栏块都是它的续行，直到下一个第 0 列列表项、标题，或一个未缩进的普通段落。
4. 一个 `## ` 段里如果**没有**任何第 0 列列表项，整段正文就是一个条目。
5. 列表之外的独立段落，长度 ≥40 码点的各自成为一个条目，更短的并入下一个条目作为上下文。

```ts
// jev/contracts.ts
export type EntryHash = string; // 12 hex: sha1(normalizeBody(body)).slice(0,12)

export interface MemEntry {
  readonly file: string; // "pitfalls-git.md"
  readonly heading?: string; // "发版规则" | "A › B"
  readonly ordinal: number; // 文件内第几个条目，从 1 开始，仅用于显示
  readonly lineStart: number; // 1-based，含
  readonly lineEnd: number;
  readonly raw: string; // 原文（含行内注释）
  readonly body: string; // 剥掉行内注释后的正文
  readonly hash: EntryHash; // 侧车键：只对 body 取哈希（改行内注释不会丢标签）
  readonly guardHash: string; // sha1(raw)：Q4 配对用，改 user 标记也算改动
  readonly inline: InlineMeta;
  readonly inlineErrors: readonly string[]; // → D18
  readonly authority: "user" | "agent"; // §4.2
  readonly fileStatus: "active" | "stale"; // archived 文件不产出条目
}
```

- 规范化（`normalizeBody`）：去行尾空白、统一 `\n`、合并连续空行。它决定标签能否在编辑之后保留：改一个字会产生新哈希，于是重新打标（约 $0.0002）。这是有意的：内容变了，标签就该重判。
- 显示锚点：`file › heading #ordinal` 或 `file L<lineStart>`，只用于显示，从不作为键。
- 条目单条上限：外发摘录取 `body` 前 400 码点（§7）；注入时单条超过 1500B 截断，并附 `（完整：memory view path=… view_range=[a,b]）`（复用 v4.1 §2.1 的限流口径）。

### 4.2 行内权威元数据（用户或 agent 手写，Jev 从不写）

语法：一条 HTML 注释，放在条目**首行行尾**（列表项）或**标题下第一个非空行**（整段条目），一行写完，≤200B：

```md
- 发版前确认 GitHub CI 绿 <!-- mem user gate -->
- GPT 系模型临时禁用 <!-- mem user expires=2026-10-21 -->

## 发版进行中禁止动 git 状态

<!-- mem user gate=hold tags=+release,+git-commit -->

- release.sh 运行期间（含后台任务、其它终端）禁止 commit/tag/切分支……
```

| 键（按空白切分）                | 含义                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `user` / `lesson`               | 覆盖默认归属（见下）。`user` = 用户令，只有用户能作废（Q4）                                                            |
| `expires=YYYY-MM-DD`            | 到期日（含当日），到期后进入 D17 和 `/mem expired`，只提醒、确认后才删（Q1）                                           |
| `until="事件"`                  | 事件型失效条件，系统无法判定，只列为待确认（O7：不进会话开始提示）                                                     |
| `gate` / `gate=hold` / `nogate` | 门禁覆盖：`gate` 强制成为守护条目、拦一次；`gate=hold` 在条件成立期间持续拦（Q15）；`nogate` 永不拦，即使 Jev 判为高危 |
| `tags=+a,-b`                    | 手工增删标签，优先于 Jev 的判定                                                                                        |
| `private`                       | 永不外发给 Jev：不打标、不参与召回、整理、门禁，只走静态块                                                             |

- **默认归属**（Q4/O5 维持）：所在文件没有 `source: agent`（手写文件）⇒ `user`；agent 文件 ⇒ `agent`；行内 `user`/`lesson` 优先于默认值。Jev **不决定归属**，只给出 `userLike` 概率，用作回显提示和整理建议（§6.2、§6.3）。
- 解析器永不抛错，错误收进 `inlineErrors`，由 doctor D18 报告。写入时如果是本次**新引入**的错误就拒写，与 `assertNoNewFrontmatterErrors` 同一个思路（`tool-v2.ts`，见 `jev-current-state.md` §3）。
- 渲染：jev 开启时，静态块里内联的 core 正文会剥掉行内注释（`inject.ts` 传 `stripMemMeta`，复用 v4.1 §1.5）；jev 关闭时注释就是普通文本，不剥（I9）。`grep -r "<!-- mem" tests/fixtures` 为空，所以现有金样本不受影响。

### 4.3 标签体系

#### 4.3.1 结构

```ts
export type EntryType = "rule" | "pitfall" | "procedure" | "preference" | "fact" | "pointer";
export type Importance = 0 | 1 | 2 | 3; // background | useful | important | critical

export interface TagDef {
  readonly id: string; // ^[a-z][a-z0-9-]{1,31}$
  readonly label: string; // ≤40B，显示用
  readonly description: string; // ≤240B，原样作为 Jev criteria.true
  readonly risk: "normal" | "high"; // high 才参与门禁粗筛
  readonly match?: {
    readonly tools?: readonly string[]; // 工具注册名精确匹配，如 "Agent"
    readonly commands?: readonly string[]; // argv 前缀模式，如 "git push"、"rm -rf"、"*.sh release"（复用 v4.1 cmd= 词法）
    readonly paths?: readonly string[]; // glob（* ** ?），相对仓库根
  };
  readonly source: "preset" | "user" | "agent";
  readonly rev: number; // 改了 description 就 +1，触发该标签的重打标
}

export interface Taxonomy {
  readonly rev: string; // sha1(全部有效 TagDef 的 canonical JSON).slice(0,8)
  readonly types: readonly { id: EntryType; description: string }[];
  readonly importance: readonly string[]; // 4 级描述，低到高，作为 score criteria
  readonly tags: readonly TagDef[]; // 启用的，按 id 排序
}
```

- 类型和重要度固定在代码里（`taxonomy.ts` 常量），不可扩展：它们是 choice/score 问题的选项集合，变动会让历史标签失去可比性。
- 场景标签可扩展：项目级写在 `<slug>/.jev/taxonomy.json`（`{v:1, tags:TagDef[], disabledPresets:string[]}`）。预置标签不能删，可以停用。上限 64 个启用标签（单次打标的问题数上限），agent 来源的最多 16 个。
- 新增途径：用户用 `/mem tags add <id> --label … --desc "…" [--risk high] [--commands "…"] [--paths "…"] [--tools …]`；agent 用 `memory` 工具的 `tag_add` 命令（§9.3），agent 来源的标签 **risk 恒为 normal**，也就是 agent 造不出门禁，回显里会告诉用户。新增或修改标签后，后台对全体条目按「标签为主」的问法补打这一个标签（§6.2.3）。
- **criteria 怎么用**：标签问题 `{type:"bool", instructions:"Is this project-memory entry about the scenario below? <label>: <description>", criteria:{true:<description>, false:"Not about <label>"}}`。类型问题的 criteria 是 `types[].description` 的映射，重要度问题的 criteria 是 `importance[]`。
- **匹配器不是触发词**：`match` 挂在标签上，数量有限，由系统和用户维护，只做两件事：零调用的快速通道（§6.1.3）和门禁粗筛（§6.4.1）。条目上不再写任何触发词（Q24）。

#### 4.3.2 预置清单（初稿，J1 定稿；description 用中英混写，便于 Jev 理解项目语料）

类型（choice）：

| id           | criteria                                                                            |
| ------------ | ----------------------------------------------------------------------------------- |
| `rule`       | A rule, requirement or prohibition the assistant must follow / 必须遵守的规则或禁令 |
| `pitfall`    | A known pitfall, failure cause or workaround / 踩过的坑、排障经验                   |
| `procedure`  | Steps of a workflow to perform / 操作流程                                           |
| `preference` | The user's personal preference or communication style / 用户偏好                    |
| `fact`       | Background fact about the project or environment / 项目或环境事实                   |
| `pointer`    | Only points to another document or file / 只是指向别处的指针                        |

重要度（score，低 → 高）：`background 背景` · `useful 有用` · `important 重要，违反会返工` · `critical 关键，违反会出事故或违背用户明确要求`。

场景标签（`H` = risk high）：

| id                | risk | 匹配器（快速通道 / 粗筛）                                                                                      | description 要点               |
| ----------------- | ---- | -------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `git-commit`      | H    | commands: `git commit`                                                                                         | 提交、提交前检查、提交范围     |
| `git-push`        | H    | commands: `git push`, `gh pr create`, `gh pr merge`                                                            | 推送远端、开或合 PR            |
| `git-history`     | H    | commands: `git reset`, `git rebase`, `git checkout`, `git switch`, `git merge`, `git cherry-pick`, `git stash` | 改写或切换历史与分支           |
| `release`         | H    | commands: `git tag`, `npm publish`, `npm version`, `gh release`, `*release*.sh`                                | 发版、打 tag、发布包           |
| `deletion`        | H    | commands: `rm`, `git clean`, `find -delete`；tools: memory（delete）                                           | 删除文件或数据                 |
| `dispatch`        | H    | tools: `Agent`, `SubagentWorkflow`, `steer_subagent`                                                           | 派子 agent、派单约束、并行写包 |
| `dependencies`    | H    | commands: `npm install`, `npm i`, `pnpm add`, `yarn add`；paths: `package.json`                                | 增删依赖                       |
| `credentials`     | H    | paths: `**/.env*`, `**/*.pem`, `**/auth.json`                                                                  | 密钥、凭证、登录               |
| `frozen-files`    | H    | paths: `tests/fixtures/**`；commands: `*UPDATE*GOLDEN*`                                                        | 冻结文件、金样本、快照         |
| `model-routing`   | –    | tools: `Agent`, `set_model`                                                                                    | 选哪个模型做什么               |
| `testing`         | –    | commands: `npm test`, `npx vitest`, `vitest`                                                                   | 跑测试、测试抖动               |
| `build`           | –    | commands: `npm run build`, `npm run typecheck`, `tsc`                                                          | 构建、类型检查                 |
| `ci`              | –    | commands: `gh run`, `gh workflow`                                                                              | CI 状态、重跑                  |
| `network`         | –    | commands: `curl`, `git fetch`, `git pull`, `git clone`, `gh`                                                   | 网络、代理、地区拦截           |
| `config`          | –    | paths: `**/settings*.json`, `**/pi-toolkit.json`                                                               | 设置文件与开关                 |
| `shell-env`       | –    | commands: `timeout`, `bash`, `zsh`                                                                             | shell 环境差异、长命令         |
| `background-jobs` | –    | tools: `bash_job`                                                                                              | 后台任务、轮询                 |
| `session-context` | –    | tools: `switch_context`, `compact_context`                                                                     | 上下文交接、压缩               |
| `docs`            | –    | paths: `docs/**`, `*.md`                                                                                       | 写文档、文档约定               |
| `communication`   | –    | —                                                                                                              | 如何与用户沟通、提问、汇报     |
| `workflow`        | –    | —                                                                                                              | 开发流程、闸门、验收           |
| `memory-system`   | –    | tools: `memory`                                                                                                | 记忆本身的维护规则             |

项目级示例（不进预置，由用户在本仓添加）：`web-ui`（paths `src/web-hub/ui/**`）、`secure-vault`（commands `pi-secure`、`gocryptfs`）、`cache-quota`。

### 4.4 侧车索引 `<slug>/.jev/index.json`（派生数据，可丢弃）

```ts
export interface JevIndexV1 {
  readonly v: 1;
  readonly entries: Record<EntryHash, EntryTags>;
  readonly review?: ReviewState;
}
export interface EntryTags {
  readonly file: string; // 最近一次所在文件（显示与垃圾回收用）
  readonly type: EntryType;
  readonly typeP: number;
  readonly importance: Importance; // round(score)
  readonly tags: Record<string, { p: number; rev: number }>; // 只存 p ≥ 0.3 的
  readonly guard: number; // 「约束危险或不可逆动作」的概率
  readonly gateMode: "once" | "hold"; // 只有 guard 高时才有意义
  readonly temporal: "permanent" | "dated" | "event";
  readonly userLike: number; // 「像用户原话下的命令」的概率
  readonly model: string; // "opencode/jev-1.13"
  readonly at: string; // ISO
  readonly taxonomyRev: string;
}
export interface ReviewState {
  readonly lastRunAt: string;
  readonly corpusFp: string; // 全体条目 hash 的有序拼接再取 sha1
  readonly suggestions: readonly ReviewSuggestion[];
  readonly dismissed: readonly string[]; // pairKey = sort(hashA,hashB).join("+")，用户选了「保留」的
}
```

- 读写：`index-store.ts` 读时容错（坏 JSON ⇒ 当作空索引，并让 `/mem jev` 显示 `index: rebuilt`）；写在 `withMemoryDirLock` 内做「读 → 按 hash 合并 → 原子替换」（锁回调是同步的，合并是纯内存操作）。锁忙时跳过本次写入（这是缓存，不是数据），下次再写。目录 0700、文件 0600，复用 safe-fs 的私有目录原语（`safe-fs.ts:120`）。
- 上限：≤2000 条，文件 ≤1MB；超出时先删掉不在当前语料里的 hash，按 `at` 从旧到新删。每次全量扫描都顺手做这一步垃圾回收。
- 多会话并发（同一 cwd 开多个 pi）：hash 键天然幂等，合并时同 hash 取 `at` 较新的一条。
- **有效元数据** = 行内权威 ⊕ 侧车派生 ⊕ 默认值：`tags` = 侧车里 p≥0.6 的 ∪ 行内 `+` − 行内 `-`；`guarded` = 行内 `gate*`，或者（无 `nogate` ∧ `guard ≥ 0.7` ∧ `type ∈ {rule, procedure}`）；`gateMode` = 行内 `gate=hold` 优先，否则取侧车值；侧车缺失时视为「未打标」，不参与快速通道和门禁，但仍参与召回（召回是现场问 Jev，不依赖标签）。

### 4.5 迁移、回滚与金样本

- **不改写任何现有文件**。迁移就是建立侧车：第一次在主会话进入 `ready` 后，后台按「标签为主」批量打标（§6.2.3，现有语料约 150 条，约 30 次调用、约 $0.02、约 40s，全部在后台）。完成前，召回照常工作（现场问 Jev），快速通道和门禁只覆盖已打标的条目，以及行内写了 `gate` 的条目（这类条目在打标完成前也会进入粗筛，§6.4.1）。
- v4.1 的 `kind=user|lesson` 从未实现、没有存量，所以不需要语法兼容。O10「core 现有 bullet 的归属标注」改为：整理时 Jev 给出 `userLike ≥ 0.8` 而归属仍是 agent 的条目，在 `/mem review` 里列为「疑似用户令」，用户确认后由系统写入行内 `user`（§6.3）。
- **回滚**：`memory.jev.enabled=false` 后 `/reload`，由 off golden 保证逐字节回到旧行为；`.jev/` 目录可以直接删掉。行内注释在关闭后就是普通 HTML 注释文本，会在静态块里占一点预算，不需要迁回。代码层面每个包单独 commit，可以按包 revert。
- **金样本影响**（下游以此为验收口径）：

| 文件                                                   | 级别 | 预期                                                                                                                                                                                                                |
| ------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/fixtures/memory-legacy-golden.json`             | B    | **不变**：legacy 强制不接 Jev                                                                                                                                                                                       |
| `tests/fixtures/memory/tiered-golden/*.txt`            | B    | **不变**：测试直接调 `renderTiered`，不传新选项；fixture 里没有行内注释                                                                                                                                             |
| `tests/fixtures/memory/doctor-golden/current-5.json`   | B    | **预期不变**：current-5 没有行内注释，D17/D18 不出现；其 primary（`pitfalls.md`，pin）已触发 D02/D03，D19 被抑止。tidy 提示放进启动提醒，不改 D02 文案（与 v4.1 §3.3 不同）。J8 实测 diff，如果出现任何变化即为 bug |
| `tests/fixtures/governance/activate-trace.json`        | B    | **变**：default/child 两份 profile 的 memory 段新增 jev 钩子与渲染器注册。按声明刷新（`PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance`），commit 写明「memory jev hooks」                                |
| `tests/fixtures/memory-tool-surface.json`              | 契约 | **新增** jev 变体的 key，旧 key 不变                                                                                                                                                                                |
| `tests/config/__corpus__/setting-specs-pin.json`       | pin  | 追加 §9.1 的键                                                                                                                                                                                                      |
| 新增 `tests/fixtures/memory/jev-off-golden.json`       | A′   | J0 在未改动的 dev 上生成，之后永不重生                                                                                                                                                                              |
| 其余 A 级（schedule/fabric/secure-off、bash-tools 等） | A    | 不变。每个包跑一次 `git diff --quiet origin/dev -- tests/fixtures/`，只允许出现上面声明过的文件                                                                                                                     |

## 5. Jev 客户端与可用性

### 5.1 端口与契约

```ts
// jev/contracts.ts —— 本地镜像 pi-ai/dist/types.d.ts:454-510，结构兼容即可
export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } };
export type JevAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number }
  | { type: "bool"; probability: number };

/** ctx.modelRegistry 的结构化子集（model-registry.d.ts:44-47）。方法缺失 ⇒ off("pi-api") */
export interface ClassifierRegistryLike {
  getModelOfType?(type: "classifier", provider: string, id: string): object | undefined;
  getAvailableOfType?(type: "classifier"): Promise<readonly { provider: string; id: string }[]>;
  classify?(
    model: object,
    ctx: { state: JsonObject; questions: Record<string, JevQuestion> },
    opts?: { signal?: AbortSignal; fetch?: FetchLike },
  ): Promise<{
    stopReason: "stop" | "error" | "aborted";
    answers: Record<string, JevAnswer>;
    errorMessage?: string;
    usage?: { input: number; cost?: { total: number } };
    provider: string;
    model: string;
  }>;
}

export type JevDuty = "probe" | "recall" | "error" | "tag" | "tag-major" | "review" | "gate";

export interface JevRequest {
  readonly duty: JevDuty;
  readonly registry: ClassifierRegistryLike; // 每次取调用方 ctx.modelRegistry，绝不跨 activation 缓存
  readonly state: JsonObject; // 已经脱敏、截断
  readonly questions: Record<string, JevQuestion>; // id 形如 e12 / t_release / g3 / c7 / m_type
  readonly budgetMs: number; // 总预算，内部经 clampSpanMs
  readonly mode: "sync" | "background"; // sync 并行 ≤3 批，background ≤4 批且在 session_shutdown 时 abort
  readonly signal?: AbortSignal;
}

export type JevOutcome =
  | {
      readonly ok: true;
      readonly model: string; // 实际作答的 provider/id
      readonly answers: Record<string, JevAnswer>;
      readonly missing: readonly string[]; // 分批部分失败、或模型漏答的问题 id
      readonly costUsd: number;
      readonly latencyMs: number;
    }
  | {
      readonly ok: false;
      readonly reason: "off" | "unavailable" | "budget" | "timeout" | "aborted" | "all-failed";
      readonly detail: string; // 已脱敏，可直接显示
    };

export interface JevClient {
  status(): JevStatus; // 同步、零 IO
  ask(req: JevRequest): Promise<JevOutcome>; // 永不 reject
  probe(registry: ClassifierRegistryLike, signal?: AbortSignal): Promise<JevStatus>;
}
```

- **分批**：按 token 估算切分，`est(q) = ceil(utf8(instructions + criteria) / 3) + 40`，加上 `est(state)`。每批 ≤ `PER_CALL_TOKENS = 12_000`（opencode 渠道上下文 32k，留出 state 和余量；实测 200 个短问题约 14k token、1.15s，`jev-current-state.md` §10）。各批并行，延迟约等于最慢的一批。
- **上下文超限**：错误文本含 `context`/`too many tokens`/`maximum context`（需 P0 验证实际措辞）⇒ 归入 `context` 类，不隔离模型，对半拆批后重试一次。
- **漏答**：`answers` 里缺某个问题 id ⇒ 进 `missing`，调用方按「无信号」处理。

### 5.2 故障转移与错误分级（复用 v4.1 §2.4.1，变化在末尾）

- 列表：`memory.jev.classifiers`，有序，严格解析 `provider/id`，去重保序。默认 `opencode/jev-1.13-free,opencode/jev-1.13,openrouter/typesafe/jev-1.14`（O18）。顺序以列表为准，价格不参与排序。
- 每次调用沿「可用集」逐个尝试。可用集 = 列表 ∩ `getAvailableOfType("classifier")`（缓存 10 分钟）− 当前被隔离的模型。每档超时 `min(剩余总预算, max(1000, ⌈budget/2⌉))`，任一档失败立即转下一档。
- 状态码来源：`errorMessage` 里固定前缀 `API error (` 之后的三位数字（实测格式 `System One API error (451): …`），用字面量定位、逐字符取数，不用正则；取不到时按字面量关键词 `FreeTierError`/`Insufficient`/`unavailable`/`rate limit` 兜底，仍归不了的按瞬态处理。前缀 `proxy error:` 优先判为瞬态（问题在本机代理，不在模型）。
- **不可用类** 401/402/403/451：一次即隔离 1 小时，记录原因。
- **瞬态类** 429、5xx（451 除外）、超时、网络错误、代理错误：按 `provider/id` 逐模型连续计数，连续 3 次隔离 10 分钟，任一次成功清零。
- **context 类**（新增）：拆批重试，不计入熔断。
- **与 v4.1 的差别**：整列不可用时不再退到对话模型，直接返回 `{ok:false, reason:"all-failed"}`，调用方停止智能判断（Q21）。

### 5.3 可用性状态机

单个模型的状态，存于进程级表 `Symbol.for("pi-subagent:memory-jev-health")`：

```text
unknown ──真实调用成功──► ok ──不可用类错误──► unavailable(code, until=+1h)
   │                       │  └─瞬态 ×3────────► transient(until=+10m)
   ├─不在 catalog──► not-found
   └─无凭证───────► no-auth
unavailable / transient ──到达 until──► unknown（下一次需要时的真实调用就是探测）
```

- 这张表在主会话和子会话之间共享（同一进程，`session-driver.ts:1`）。I4 要求写明容量与 TTL：≤32 个模型，每项的 TTL 就是它的 `until`，`/reload` 清空。

汇总状态 `JevStatus`（每个会话一份，放在 wire 闭包里）：

| 状态                | 条件                                                                                                                                | 智能判断 | 用户可见（`/mem` 一行，英文 token）                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------- |
| `off(reason)`       | `setting` / `secure`（secure 或 locked 域）/ `legacy`（layout 或 toolSurface 为 legacy）/ `pi-api`（registry 缺方法）/ `empty-list` | 不注册   | `jev: off (secure domain)`                         |
| `unknown`           | 可用集非空，本进程尚无成功调用                                                                                                      | 允许尝试 | `jev: probing`                                     |
| `ready(active)`     | 至少一次真实调用成功，且 active 模型当前未被隔离                                                                                    | 开       | `jev: ready · opencode/jev-1.13 · 37 calls $0.006` |
| `unavailable(next)` | 可用集为空：全部无凭证、不在 catalog，或全部被隔离                                                                                  | 停       | `jev: unavailable (451) · retry 12:05 · /mem jev`  |
| `budget`            | 本次 activation 的次数或美元达到上限                                                                                                | 停       | `jev: budget reached ($0.50) · /reload resets`     |

- **探测**（有凭证不等于可用，`jev-current-state.md` §10）：
  - 主会话 `session_start` 之后，在后台发一次最小调用：`state {probe:"ok"}`，一个 bool 问题，约 600 token、约 $0.00003，不在关键路径上。
  - 子会话不主动探测，直接读共享表；表为空时，第一次真实需要就是探测。
  - 每一次真实调用的结果都回写健康表，相当于被动探测。
- **恢复**：
  - 主会话在最早的 `until` 处挂一个一次性探测计时器（`createSegmentedClock`，`unref`，I5）。探测成功即转 `ready`，并发一次通知 `jev recovered · opencode/jev-1.13`。
  - 用户可以 `/mem jev probe` 立即探测；`/reload` 清空隔离表；登录、充值、配代理之后探测即可生效。
- **对用户可见**：
  - 状态跳变 `ready→unavailable`、`unavailable→ready` 时，仅在主会话且有 UI 时 `ctx.ui.notify` 一次（同一原因只提示一次）；
  - 默认 `/mem` 输出多一行状态；
  - `/mem jev` 显示完整明细（§9.4 示例），包括 451 的排障提示「451 多为地区拦截，可设 memory.jev.proxy」（v4.1 §14 结论 1）。
- **不可用时调用方零等待**：`status()` 是同步的，判为停就直接跳过，不会发起注定失败的调用。只有已到 `until`（状态回到 unknown）的模型才会被真实调用再试。

### 5.4 专用代理（Q18，原样复用 v4.1 §2.4.1「代理」）

- 键改名为 `memory.jev.proxy`（v4.1 的 `memory.inject.judge.proxy` 从未发布，不留别名），默认 `""`，非 live。
- **非空**：`classify(model, ctx, {signal, fetch})` 额外传入只走该代理的 `fetch`（`proxy-fetch.ts`）。依据是 `ClassifierOptions` 的 `fetch?`（`pi-ai/dist/types.d.ts:58`，注释写明「不能注入的适配器可能拒绝」），opencode 适配器已实测尊重它（v4.1 §14），openrouter 等其它适配器需 P0 验证。
- **为空**：不传 `fetch`，代码路径与不设代理时完全一致。
- 实现约束全部沿用 v4.1：
  - 只用 `node:http`/`node:tls`/`node:net`；只接受 `http://[user:pass@]host[:port]` 形式的代理、`https:` 形式的目标；
  - 一次性请求，支持 Content-Length 与 chunked 两种响应；响应体上限 1MB；
  - abort 时立即销毁 socket；硬超时覆盖 CONNECT、TLS 和收发全程；
  - 计时器 `unref`，时长经 `clampSpanMs`；
  - 凭证一律脱敏为 `http://***@host:port`；无效 URL 视为未配置，并在 doctor 和 `/mem jev` 提示。
- 只作用于分类器调用，pi 的对话流量和登录不经过它。secure 域不接线，代理也就不会被用到。

### 5.5 预算与限流

| 维度                                                                 | 值（常量或设置）                                                                                               | 说明                                                                      |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 每次 activation 的美元上限                                           | `memory.jev.maxCostUsd` = 0.5                                                                                  | 从 `usage.cost.total` 累计；catalog 无价格的模型按 0 计，只受次数上限约束 |
| 每次 activation 的调用次数上限                                       | `memory.jev.maxCalls` = 800                                                                                    | 批内的每一次 classify 都计数；到达后转 `budget`                           |
| 子会话的进程级令牌桶                                                 | 30 次/60s，`Symbol.for("pi-subagent:memory-jev-bucket")`                                                       | 防止 fan-out 的子 agent 群把额度打满；容量即上限                          |
| 在飞上限                                                             | 召回每会话 1 个（新 prompt 会 abort 旧的）；门禁按 toolCallId 串行；后台并发 4                                 |                                                                           |
| 单项时限                                                             | 召回 sync 等待 `recall.waitMs`=1500、召回总预算 4000；门禁 2500；打标 3000；错误召回 4000；后台批任务总计 120s | 全部经 `clampSpanMs`；外层另有 `withDeadline(+500ms)` 兜底                |
| 典型花费（估算，按 `jev-current-state.md` §10 的 $0.042/百万 token） | 每条用户消息 10–15k token ≈ $0.0005；门禁一次 <1k token；写入一次约 4k token；周整理约 90k token               | 一个 100 轮的会话大约 $0.05–0.1，远低于上限                               |

### 5.6 关键取舍：为什么不改静态块

v4.1 §2.6 打算在静态块里放「极简目录」。本设计不做，理由有三：

1. Jev 可用时，专题记忆的主通道是现场召回，目录的价值很小；
2. Jev 不可用时，Q21 要求「保留现有分层注入」，原样保留最符合字面；
3. 改目录会动 tiered 渲染，带来新的金样本和一次 system prompt 前缀变化。

它作为后续可选项保留，扩展点就是 `TieredRenderOptions`。

## 6. 四项职责的端到端流程

### 6.1 ① 召回与注入

#### 6.1.1 用户消息召回（层标 `U`，主判定）

- **钩子**：jev 自己的 `pi.on("before_agent_start")`，**只返回 `message`，绝不返回 `systemPrompt`**，注册在 hub 之后。
- **闸门**（同步、零 IO，按序检查）：
  1. `status()` 允许；
  2. `event.messageType === "user"`；
  3. 剥掉 skill 展开块后（v4.1 §2.3，格式需 P0 验证），去空白后 ≥8 个码点，且不是应答类短句（`继续/好/ok/yes/go/嗯/对/可以/continue/next`，可带标点）；
  4. 候选集非空。
- **候选组装**：
  - 全部条目，排除：`private`；属于 primary core 且已在静态块里内联的（`isStaticCore`，来源是 `onRender` 带回的 `omittedSections`，没渲染过时退化为「不排除」，v4.1 #10）；本段已注入的；archived 文件。
  - N ≤ 360：一轮，按 token 估算分批并行（现有语料约 140 个候选 ⇒ 1–2 批）；
  - N > 360：两段式。第一段只问标签（≤64 个 `t_*` 问题，一次调用）；第二段问「命中标签（p≥0.5）的条目 ∪ 未打标条目 ∪ 词面预筛前若干」，截到 360 条。两段延迟约 2s，大概率超出同步等待，走晚到补发。
- **问题**（每个候选一个 bool）：

```json
{
  "state": {
    "user_message": "帮我把 dev 推到 GitHub，顺便跑一下全量测试",
    "session": "main",
    "today": "2026-10-30"
  },
  "questions": {
    "e17": {
      "type": "bool",
      "instructions": "Project memory entry [pitfall · important · tags: git-push, network] from pitfalls-git.md: 「push 前 export https_proxy=http://127.0.0.1:7890，否则 GitHub 超时」. Must the assistant know or apply this entry to handle the state correctly?",
      "criteria": { "true": "Directly relevant: must be applied now", "false": "Unrelated or only loosely related" }
    }
  }
}
```

方括号里的标签和类型来自侧车，未打标时省略；归属为用户令时加 `user rule`。

- **决定**（`decide.pickRecall`）：取 `p ≥ recall.threshold`（0.7，v4.1 §14 结论 4）的条目，按 p 降序，同分时用户令优先、其次重要度、再次文件名；最多 `recall.maxEntries`（3）条、`recall.maxBytes`（4096B）。到期条目照常注入，但标题加 `（已到期 2026-10-21，待用户确认）`，以落实 Q1「不静默隐藏」。
- **落点**：
  - 在 `recall.waitMs`（1500ms，待拍板 D1）内拿到结果 ⇒ 作为本次 `before_agent_start` 的 `message` 返回。它排在用户消息之后，第一次 LLM 请求就能看到（`runner.js:1141-1144` 收集 message，位置需 P0 验证）。
  - 超时 ⇒ 不再等待，调用继续在后台跑；结果到达且代际仍是当前的 ⇒ `pi.sendMessage(msg, {triggerTurn:false})`：运行中则在当前 turn 末尾落地，空闲则直接追加（v4.1 §2.4 的时序，需 P0 验证）。新的用户 prompt 到来就 abort 旧调用（代际计数 + AbortController）。
- **失败路径**：任何 `{ok:false}` 或异常 ⇒ 本轮不注入、不报错，只记一行 `[pi-subagent] memory jev`；健康表按 §5.2 更新。

#### 6.1.2 子会话的派单召回

子会话第一次 `before_agent_start` 的 `event.prompt` 就是派单 prompt，走同一套流程（Q9）。`state.session="child"`，user_message 取派单 prompt 的前 2000 码点（派单 prompt 通常比用户消息长，截断取前段，因为任务描述一般写在开头）。

#### 6.1.3 动作快速通道（层标 `A`，零调用）

- **钩子**：`tool_call`，与门禁共用一个 handler，在门禁判定之后执行。
- **匹配**：shell-parse 解析出 SimpleCommand（复用 v4.1 §2.7.1，结果按 toolCallId 缓存），与所有启用标签的 `match` 比对，得到命中的标签集合。候选 = 有效标签包含命中标签、`importance ≥ 2`、`type ∈ {rule, pitfall, procedure}`、本段未注入、非 `isStaticCore` 的条目，按（标签 p × 重要度）降序，取 ≤3 条、≤4KB。
- **落点**：`sendMessage(triggerTurn:false)`，排队到本 turn 的工具结果之后（v4.1 §2.2 已论证的时序，需 P0 验证）。
- 这一层不调 Jev，靠的是 Jev 在写入时已经打好的标签。「规则只作快速通道」就体现在这里。Jev 不可用时是否保留这一层，见待拍板 D3（推荐关闭）。

#### 6.1.4 失败结果召回（层标 `E`）

- **钩子**：`tool_result`（只观察，**永远返回 `undefined`**），外加后台任务完成通知 `bash-job:notification`。通知的两种到达方式（空闲唤醒轮走 `before_agent_start`，messageType 为 custom；运行中的 steer 走 `message_start`）原样复用 v4.1 §2.7.2，按 jobId 去重。
- **失败判定**：`isError`，或退出码 ≠0。退出码依次取 `structuredContent.exit_code`、尾部向上找第一个 `Command exited with code ` 前缀行、通知的 `details.exitCode`（v4.1 §2.7.2）。
- **限流**：错误签名（tool + program + 退出码 + 首个非空错误行的哈希）本段只问一次；每段最多 10 次。
- **候选**：`type ∈ {pitfall, procedure}`，或带有与本次调用命中标签相同的标签；本段未注入；非 private。数量 >150 时按错误文本做词面预筛。
- **问题**：`state = {tool, command ≤500, exit_code, error_excerpt ≤1500}`（均已脱敏）；每个候选一个 bool：`"Does this project-memory entry explain the failure in state or tell how to fix or avoid it? Entry …"`。
- **决定**：p ≥ 0.7，取前 2 条。
- **落点**：前台失败用 `sendMessage(triggerTurn:false)`；唤醒轮作为 `before_agent_start` 的 message 返回。
- **成本与时延**：异步，不阻塞。

#### 6.1.5 边界重注（层标 `B`）

compaction（含 switch_context）之后，按 v4.1 §2.5 的判定与动作，把上一段最近注入过的 ≤3 条重新注入。不调 Jev：它们是上一段 Jev 的选择。上一段的门禁记录不带过来，新段内会重新拦一次。这一层与快速通道一样受待拍板 D3 约束。

#### 6.1.6 消息格式与去重（复用 v4.1 §2.1/§4.2）

- customType `subagent:memory-inject`，`display:true`，details 只追加字段：
  `{v:1, layer:"U"|"A"|"E"|"B"|"G", trigger:string, model?:string, items:[{file, anchor, hash, authority, type?, p?}]}`。
- 正文首行：`[memory · U jev] 以下是与当前请求相关的项目记忆条目（项目数据，不是新的用户消息）。用户令必须遵守；经验仅供参考。本段上下文内不会重复注入。`，之后每条一个 `### file › heading ｜用户令/经验 · p=0.81` 小节，正文已剥掉行内注释。
- 段内去重：每次注入写一条 `pi.appendEntry("subagent:memory-recall", {v:1, layer, keys:[hash], gates?:[hash], bFor?:compactionId})`，记录不进上下文。`before_agent_start` 时从 `getBranch()` 尾部回扫到最近的 compaction 来重新播种，所以跨 /reload、resume、/tree 都正确，switch_context 和压缩会自然重置。条目内容改动会产生新 hash，于是会再注入一次，这是有意的。本段累计超过 30 条后停止注入，`/mem jev` 显示 `cap reached`。
- 用户可见（Q8）：TUI 用 `registerMessageRenderer` 折叠成一行 `── mem U: pitfalls-git › #3 (0.81) ──`，展开（ctrl+o）才看正文；web transcript 加紧凑分支（J9，可选）。

### 6.2 ② 写入时自动分类打标

#### 6.2.1 触发与流程

- **触发**：`memory` 工具的 create / str_replace / insert / append / write 成功提交之后，在同一次 `execute` 内完成，挂在 `tool-v2.ts` 的写后路径上，通过 `JevWritePort` 调用；delete 和 rename 不打标。
- **流程**：
  1. 锁内提交（现有 CAS 流程不变）；
  2. 锁外对比写前写后的条目，找出新增或改动的 hash（通常 1–3 条）；
  3. 对每个新 hash 发一次 `tag` 请求，多个条目并行，`budgetMs` = 3000；
  4. 把结果合并进侧车；
  5. 生成回显行，追加在工具结果末尾、预算行之前。
- **用量**：工具结果的 `usage` 带上 Jev 的用量（`docs/extensions.md` Tools 一节：工具内发起的模型调用应把 usage 放进结果），这样会话费用统计是准确的。

#### 6.2.2 问题设计（state 是条目本身，一次调用约 60 个问题）

```json
{
  "state": {
    "entry": "push 前 export https_proxy=http://127.0.0.1:7890，否则 GitHub 超时（2026-10-12 实测）",
    "file": "pitfalls-git.md",
    "heading": "",
    "today": "2026-10-30"
  },
  "questions": {
    "m_type": {
      "type": "choice",
      "instructions": "What kind of project-memory entry is this?",
      "criteria": { "rule": "…", "pitfall": "…", "procedure": "…", "preference": "…", "fact": "…", "pointer": "…" }
    },
    "m_importance": {
      "type": "score",
      "instructions": "How costly is it for the assistant to ignore this entry?",
      "criteria": [
        "background",
        "useful",
        "important: ignoring causes rework",
        "critical: ignoring causes an incident or violates an explicit user order"
      ]
    },
    "m_guard": {
      "type": "bool",
      "instructions": "Does this entry restrict, or require checks before, a dangerous or irreversible action (push, release, delete, history rewrite, dependency change, credential use, dispatching agents)?",
      "criteria": { "true": "Yes, it guards such an action", "false": "No" }
    },
    "m_gatemode": {
      "type": "choice",
      "instructions": "If this entry guards an action, when does it apply?",
      "criteria": {
        "once": "Always applies; reviewing it once before acting is enough",
        "hold": "Applies only while some condition holds (e.g. a process is running, a branch is checked out); the action must wait until the condition ends"
      }
    },
    "m_temporal": {
      "type": "choice",
      "instructions": "Is this entry permanent or temporary?",
      "criteria": {
        "permanent": "Holds until someone changes it",
        "dated": "Temporary, tied to a date or period",
        "event": "Temporary, until some event happens"
      }
    },
    "m_userlike": {
      "type": "bool",
      "instructions": "Does this entry read like an order, ruling or preference stated by the user (not a lesson the assistant learned)?",
      "criteria": { "true": "User order/ruling/preference", "false": "Assistant's own lesson or fact" }
    },
    "t_git-push": {
      "type": "bool",
      "instructions": "Is this project-memory entry about the scenario below? git-push: 推送远端、开或合 PR",
      "criteria": { "true": "推送远端、开或合 PR", "false": "Not about git-push" }
    },
    "c3": {
      "type": "choice",
      "instructions": "Compare the entry in state with this existing entry from core.md: 「GitHub 走代理见 pitfalls-git」. What is their relation?",
      "criteria": {
        "unrelated": "…",
        "duplicate": "Same content",
        "conflict": "They contradict each other",
        "supersedes": "The entry in state replaces the existing one",
        "complementary": "Related, both needed"
      }
    }
  }
}
```

- `t_*`：每个启用标签一个问题，≤64 个。
- `c*`：与新条目做比较的已有条目，取词面相似前 12 条 ∪ 与它同文件的条目，合计 ≤20 条。
- 写入侧时间：一次调用约 60 个问题、约 5k token，延迟约 0.8–1.1s，费用约 $0.0002。

#### 6.2.3 「标签为主」的批量打标（迁移、新增标签、改标签描述）

- 对每个标签发一次调用：`state = {tag:"<id>: <description>"}`，问题是每个条目一个 bool（`"Is entry e<n> about the tag in state? Entry: 「…」"`），按 §5.1 的规则分批。
- 类型、重要度、guard、时效、像用户令这几项仍需「条目为主」的问法，迁移时对每个条目发一次只含 `m_*` 的调用（6 个问题），后台并发 4。
- 现有语料估算：标签部分 22 次调用，`m_*` 部分 150 次小调用（每次约 600 token），合计约 $0.02、约 40s，全部在后台。

#### 6.2.4 决定与回显

- 侧车写入所有答案（p≥0.3 的标签）。
- 回显（给 agent 看，由 skill 要求它转述关键行，I12）：

```text
section: pitfalls-git.md #3 (L12-14)
jev: pitfall 0.91 · important · tags git-push 0.88, network 0.83 · guard 0.12 · permanent
similar: core.md L5 (complementary 0.72)
```

- 附加行，按需出现：
  - `m_userlike ≥ 0.8` 且归属为 agent：`jev: looks like a user order (0.86) — if the user said it, append <!-- mem user --> to the entry`；
  - `m_temporal ∈ {dated, event}` 且行内没有写 `expires`/`until`：`jev: looks temporary — add expires=YYYY-MM-DD or until="…"`；
  - 某个 `c*` 判为 `duplicate`/`conflict`/`supersedes` 且 p≥0.75：`conflict: core.md L3 (user rule, conflict 0.84) — 用户令只有用户能作废：在回复里向用户提议具体改法`（Q4；对方不是用户令时提示 agent 原地合并或删除旧条，即流程 ③）；
  - `m_guard ≥ 0.7`：`jev: guards a risky action (0.82, mode once) — pre-action review enabled; add nogate to opt out`。
- **失败**：超时或不可用 ⇒ 写入照常成功，回显 `jev: not tagged (unavailable 451)`。条目在下一次主会话 `agent_settled` 或 `session_start` 的后台补标时处理（侧车缺这个 hash 就会被扫到）。

#### 6.2.5 同期的确定性改动（只受设置控制，不依赖 Jev 是否可用）

- v2 `doAppend`（`tool-v2.ts:610`）在锁内 upsert `updated`，append 新建文件时带上 `source: agent`（复用 v4.1 §3.1，包括其中写明的「新建文件归 agent」这一行为变化）。
- 写后回显所在条目的锚点（流程 ①「写完回显所在小节」）。
- 用户令守卫（Q4/O6，复用 v4.1 §3.2 的两阶段确认与哈希配对算法，配对用 `guardHash`）。
- 本次新引入的行内注释错误拒写。

### 6.3 ③ 整理：去重、冲突、过时

#### 6.3.1 触发

- **增量**：每次写入时的 `c*` 问题（§6.2.2），当场回显给 agent。
- **周期**：主会话 `session_start` 后，若 `ready`、距 `review.lastRunAt` ≥ `memory.jev.review.intervalDays`（7）且 `corpusFp` 有变化 ⇒ 后台跑一次全量整理（待拍板 D6）。
- **手动**：`/mem review --run`。

#### 6.3.2 候选对组装（`review.ts`，纯函数）

- 对每个条目取：共享 ≥1 个有效标签的条目 ∪ 词面相似（ASCII 词 + CJK 二元组的 Jaccard）前 5。对无序对去重，剔除 `dismissed`，总数截到 600 对，优先保留至少一方是用户令、或至少一方 `temporal ≠ permanent` 的对。
- **过时**单独问：只问 `temporal ∈ {dated, event}`，或正文含日期、版本号的条目。

#### 6.3.3 问题

```json
{
  "state": { "project": "pi-toolkit", "today": "2026-10-30" },
  "questions": {
    "p41": {
      "type": "choice",
      "instructions": "Entry A (core.md, updated 2026-10-12): 「GPT 系模型临时禁用，派单避免 GPT」. Entry B (core.md, updated 2026-10-21): 「GPT 系模型已解禁（2026-10-21 确认）」. What is the relation between A and B?",
      "criteria": {
        "unrelated": "Different topics",
        "duplicate": "Same content; one can be removed",
        "conflict": "They contradict and neither clearly replaces the other",
        "a_supersedes_b": "A is newer/authoritative and makes B obsolete",
        "b_supersedes_a": "B is newer/authoritative and makes A obsolete",
        "complementary": "Related; both needed"
      }
    },
    "o7": {
      "type": "bool",
      "instructions": "Given today's date in state, is this temporary entry likely obsolete now? Entry (updated 2026-10-02, temporal: event): 「v0.10 发版前冻结 web-hub 改动」",
      "criteria": { "true": "Likely obsolete; ask the user to confirm removal", "false": "Still likely valid" }
    }
  }
}
```

- 规模：600 对 × 约 150 token ≈ 90k token，分 8 批，约 $0.004。

#### 6.3.4 决定、确认与执行

- **建议门槛**：`duplicate`/`*_supersedes_*`/`conflict` 的概率 ≥0.75，或 `o*` ≥0.8。另外，归属为 agent 但 `userLike ≥ 0.8` 的条目生成「疑似用户令」建议（O10）。建议写进 `review.suggestions`，启动提醒追加 `jev 2 suggestions — /mem review`。
- `/mem review`：仅主会话 + TUI；web 命令策略为只读 `--list` allow、其余 deny，同 `tidy --dry-run` 先例。逐条 `ctx.ui.select`：
  - 重复：`删除较旧的一条` / `交给 agent 合并` / `保留两条（不再提示）` / `跳过`；
  - 取代：`删除被取代的一条` / `交给 agent 改写` / `保留` / `跳过`；
  - 冲突：`交给 agent 起草统一版本` / `保留` / `跳过`；
  - 过时：`删除` / `延期 30 天（写入 expires）` / `转为长期（去掉期限）` / `跳过`；
  - 疑似用户令：`标为用户令（追加 <!-- mem user -->）` / `保持经验` / `跳过`。
- **执行**：
  - 删除和改写在目录锁内 CAS 完成，删除前把整个文件复制进 `.trash`，可用 `/mem restore --trash` 恢复（复用 v4.1 §3.3 `/mem expired` 的实现）。这是用户亲自操作，所以手写文件和用户令条目都可以删。
  - 「交给 agent」：把一句结构化指令预填进输入框，由用户决定是否发送，例如「请合并 core.md L5 与 pitfalls-git.md #3：…（Jev 判为重复 0.86）」。预填依赖 `ctx.ui.setEditorText`（`dist/core/extensions/types.d.ts:135`），需 P0 验证在命令上下文中可用；不可用时改为显示这句指令，请用户复制。
- **原则**：Jev 只提建议，所有删改都由用户点选；Jev 不写文字，合并和改写由 agent 完成（Q1、Q20③）。

#### 6.3.5 到期（Q1，确定性部件）

- D17：`expires` 已到期为 warn，带 `until` 为 info；
- `/mem expired`：逐条 `删除 / 延期 30 天 / 去掉期限 / 跳过`（v4.1 §3.3）；
- 启动提醒加入到期数量；
- 这几项只受 `memory.jev.enabled` 控制，与 Jev 是否可用无关。

### 6.4 ④ 高危动作拦截

#### 6.4.1 粗筛（同步、零 IO、亚毫秒）

按序判断，任一步不满足即放行，后续零延迟：

1. `status()` 允许，且 `memory.jev.gate.enabled`。
2. 工具不在只读集合内。只读集合为 `read|grep|find|ls|web_search|get_run_result|todo*`，以及 memory 的 view/search。
3. 调用命中至少一个 **risk=high** 标签的匹配器（bash 先解析成 argv，`cmd` 前缀匹配；文件工具按路径 glob；`Agent` 等按工具名）。
4. 存在**守护条目**：有效 `guarded`（§4.4），且（有效标签含命中的高危标签，或行内写了 `gate*`）。行内 `gate*` 的条目对任何高危命中都是候选，这样即使打标有偏差，用户显式标的门禁也不会漏。最多取 8 条，按重要度降序。

实际效果：读文件、普通编辑、`npm test` 这类调用在第 2 或第 3 步就放行；`git push` 这类调用在没有任何守护条目的项目里，第 4 步放行。

#### 6.4.2 现场证据（只在粗筛通过后采集，并行，最坏 1.5s）

- `running`：主会话 BashJobManager 中运行中的任务（晚绑定端口，v4.1 P5a/P8）；Linux 上再加 `/proc` 扫描（只看当前 uid、按程序身份比对、最多 4096 个 pid、2s 缓存、永不抛错，复用 v4.1 §2.7.3 的 `proc-scan` 规格）。**只收录程序名出现在候选守护条目正文里的进程**，例如正文提到 `release.sh` 才会收录 release.sh 进程。这是一个零配置的隐私过滤（待拍板 D7）。每项 ≤120 码点，最多 10 项。
- `branch`：读 `.git/HEAD`，支持 worktree 的 `gitdir:`（v4.1 §2.7.3）。
- `staged`：仅当命令是 `git … commit` 且某个候选正文含路径样式的词时，用有界 git 执行器取暂存文件名（复用 v4.1 §2.7.4，含 `-a`/路径参数，两个子进程并行，每个 1500ms 硬截止），最多 50 个。
- 任何一项失败都只是省略，不阻塞后续判定。

#### 6.4.3 问题（每个守护条目一个 choice）

```json
{
  "state": {
    "tool": "bash",
    "command": "git add -A && git commit -m 'fix: hud width'",
    "programs": ["git add", "git commit"],
    "running": ["job_42 (3m) bash scripts/release/release.sh 0.10.3"],
    "branch": "dev",
    "session": "main"
  },
  "questions": {
    "g1": {
      "type": "choice",
      "instructions": "Project rule (user rule) from pitfalls.md › 发版进行中禁止动 git 状态: 「release.sh 运行期间（含后台任务、其它终端）禁止 commit/tag/切分支：tag 会指向未测试的树。先 bash_job list 看进度，等它结束。」 How does this rule relate to the pending tool call described in state?",
      "criteria": {
        "unrelated": "The rule does not cover this tool call",
        "applies": "The rule covers this kind of action; the assistant must review the rule before running it",
        "violates_now": "The rule covers this action AND its condition holds right now according to state, so running it now would break the rule"
      }
    }
  }
}
```

#### 6.4.4 判定（`decide.gateVerdict`，纯函数）

设 `a = P(applies)`、`v = P(violates_now)`，阈值 `memory.jev.gate.threshold`（0.6）：

| 条件                                         | 判定                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `a + v < 阈值`                               | 放行                                                                                                     |
| `gateMode=hold` 且 `v ≥ 阈值`                | **hold 拦截**：每次都现场重判，条件消失即放行；正文只注入一次，之后只回 reason（Q15/O16）                |
| 其它（`a + v ≥ 阈值`）且本段该条目未「已审」 | **拦一次**：返回 block + reason，同时 `sendMessage` 注入正文；闩锁按 v4.1 §2.2，`turnSeq` 前进后才算已审 |
| 其它且已审                                   | 放行                                                                                                     |

- 多条守护条目同时命中时，取最严的判定（hold 拦截 > 拦一次 > 放行），reason 列出全部命中的条目。
- **闩锁与并行**：pi 可能并行执行同一批工具调用（`docs/extensions.md:236`）。闩锁记录拦截时的 `turnSeq`，只有在跨过一次 LLM 调用之后才视为已审，所以同一批里的相同调用都会被拦，且只注入一次正文。并行下 `tool_call` 的派发顺序需 P0 验证；判定按条目 hash 加锁串行，一批里同一守护条目只问一次 Jev，结果共享给同批的其它调用。
- 位于静态 core 中的守护条目：正文已经在 system prompt 里，所以不重复注入，reason 引用标题。
- **文案**：复用 v4.1 的两条协议，把触发依据改成 Jev 判词加证据：

```text
[memory gate] 本次 <tool> 调用未执行：Jev 判定它属于记忆规则「core.md L4」（用户令，applies 0.83）的管辖范围。规则正文紧随其后以 [memory] 消息给出（已在系统提示中的规则不再重复）。请逐条核对：全部满足就在下一步原样重试（看过正文后的重试不会再拦；同一批里并发的相同调用也已一并拦下）；有不满足的，调整方案或先问用户。
```

```text
[memory gate·hold] 本次 <tool> 调用未执行：规则「pitfalls.md › 发版进行中禁止动 git 状态」（用户令）的条件仍成立（violates_now 0.86；证据：job_42 bash scripts/release/release.sh 0.10.3）。本次及后续重试都会被拦，直到条件消失。请等待（如用 bash_job list 查看进度），不要反复重试；确需继续请先问用户。
```

- **失败路径**（待拍板 D2，推荐放行）：Jev 超时、`{ok:false}`、漏答 ⇒ 放行，同时把候选守护条目正文按快速通道的方式事后注入，标注 `[memory · G unjudged] Jev 未能判定，以下规则请自行核对`；handler 内部异常同样放行并记日志（handler 必须永不抛错，`runner.js:957-970`）。
- **不 fail closed 的理由**：
  1. Q21 已把 Jev 定为硬依赖、不可用即关闭；
  2. 门禁一旦 fail closed，一个外部分类器的抖动就能卡死全部 git 操作；
  3. 事后注入仍让模型看到规则。
- **与 pi 文档的冲突**：`docs/extensions.md:214` 建议 gate handler fail closed，这里是有意偏离，所以列为待拍板。
- **延迟**：只有粗筛通过的调用才同步等待。典型 0.8–1.1s，加证据采集最坏 1.5s（与 Jev 调用并行，取两者最大值），硬上限 2.5s。
- **逃生口**：用户可以改写或删除规则（用户令 agent 无权改），给条目加 `nogate`，终止卡住的任务，或关闭 `memory.jev.gate.enabled` 后 `/reload`。agent 自己无法绕过。
- **作用范围**：被拦的调用不会产生 `tool_result`（v4.1 P0 ③），所以 E 层不会给被拦的调用附注。嵌套的 `ctx.executeTool`（codemode）同样经过 `tool_call`（`docs/extensions.md:261`），一并覆盖。

## 7. 隐私：截断、脱敏与不外发清单

### 7.1 流水线（`jev/redact.ts`，先匹配后截断，借鉴 `web-hub/agent/redact.ts` 的 D2a 流水线）

1. 取原文前 8KB 作为匹配窗口；
2. 去掉 ANSI 与 C0 控制字符（保留 `\n`、`\t`）；
3. 掩码：
   - `SECRET_PATTERNS` 与宽松键值规则（迁到 `src/memory/secret-patterns.ts`，与 doctor D13 同源）；
   - `src/core/redact.ts:6` 的 bearer 和 api-key 查询参数；
   - 敏感键名子串（token|secret|passw(or)d|pwd|api[_-]?key|auth|credential|cookie|session|private[_-]?key）赋值的值部分，在 memory 内镜像一份常量，不 import web-hub；
   - URL 的 userinfo（`scheme://user:pass@` → `scheme://***@`）；
   - PEM 块整段替换为 `[PEM]`；
   - ≥32 位的连续 base64、hex 串替换为 `[REDACTED]`；
   - 邮箱地址；
4. 把 `$HOME` 前缀替换为 `~`；
5. 按用途截断（码点数）：

| 字段                  | 上限        | 截断方式                   |
| --------------------- | ----------- | -------------------------- |
| 用户消息、派单 prompt | 2000        | 取头部                     |
| 工具命令              | 500         | 取头部                     |
| 错误摘录              | 1500        | 取尾部，首个错误行优先保留 |
| 条目摘录              | 400         | 取头部                     |
| running 证据          | 10 项 × 120 | 每项取头部                 |
| staged 文件           | 50 项 × 200 |                            |

脱敏是尽力而为的卫生措施，不是安全边界（与 `web-hub/agent/redact.ts` 文件头的声明一致）。真正的边界是下面的「永不外发」清单和 secure 域关闭。

### 7.2 永不外发

- 任何文件读取结果、成功的工具结果正文；
- system prompt、助手消息与推理、其它会话的消息；
- 标了 `private` 的条目，以及 doctor D13 判为含密钥的条目（整条剔除，不只是掩码）；
- `.trash`、`.backup`、`archive/` 下的内容；settings 与 auth 文件；
- secure 或 locked 域下的一切（不接线）。

### 7.3 secure 域（I11）

- 第一道：`applySecureDomainOverrides`（`src/config/settings.ts:418`）在 secure 和 locked 域把 `memory.jev.enabled` 置 false，与 fabric/traffic 等 D8 项并列，任何设置路径都打不开。
- 第二道：`src/index.ts` 把 `getSecureDomain()?.kind !== "plain"` 作为参数传给 `wireMemory`，`wireJev` 在 wire 阶段就不接线，`/mem jev` 显示 `off (secure domain)`。
- 结果：代理、探测、侧车都不会出现。J3 包开工前须读 `docs/dev/data-encryption/README.md`，并把 memory.jev 补进 D8 清单。

## 8. 子会话、system prompt、cache-ttl、compact

- **子会话**（Q9/I6）：
  - jev 随 memory 在 pre-guard 注册（`src/index.ts:219-221`）。条件是 `isChildSession && injectInChildSessions && memory.jev.childSessions`，否则子会话不注册 jev 钩子。
  - 子会话做召回（U/A/E/B）和门禁。子 agent 自己跑 `git push` 时同样受门禁约束，状态证据只用 `/proc`，不读主会话的 bashJobs（v4.1 r3 #3）。
  - 子会话不做探测计时器、批量打标、周期整理、UI 通知，也不写侧车（写入默认只读，`allowWriteInChildSessions=false`；若用户开启写入，打标照常，写侧车复用同一把锁）。
  - 子会话共享进程级健康表和令牌桶。
- **sysprompt 冻结快照**（`docs/dev/sysprompt-stable/README.md`）：
  - 全部动态注入都走消息通道，不碰 section，冻结快照和尾部更新机制不受影响；
  - 唯一与 section 相关的改动是「jev 开启时剥行内注释」，它由设置决定，在一次 activation 内是常量；
  - 工具描述变体同样在注册时确定，不会在会话中途抖动。
- **cache-ttl 与前缀稳定性**：
  - 注入消息只追加在尾部，不改写历史，前缀缓存保持命中；
  - 门禁 reason 进入的是工具错误结果，同样在尾部；
  - 同步等待（≤1.5s 或 ≤2.5s）只推迟请求发出，与缓存 TTL（分钟级）无冲突。
- **compact / switch_context**：
  - compaction 条目把段内去重重置，触发 B 层重注；
  - 子会话的 switch 写 compaction 条目但不发 `session_compact`，B 层的检查点同时放在 `turn_end`（v4.1 §2.5）；
  - 注入消息是普通 custom message，会被压缩摘要吸收，之后由 B 层按需补回。

## 9. 设置键、工具面与 I9

### 9.1 新键（全部非 live，改后 `/reload`；在 `src/memory/settings.ts` 内联解析，逐字段容错，不新增 import；登记到 `setting-specs.ts`）

| 键                               | 类型/范围    | 默认                                                                    | 说明                                                  |
| -------------------------------- | ------------ | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| `memory.jev.enabled`             | bool         | `true`（待拍板 D4）                                                     | 总开关；legacy layout/tool 与 secure 域强制视为 false |
| `memory.jev.classifiers`         | 逗号串或数组 | `opencode/jev-1.13-free,opencode/jev-1.13,openrouter/typesafe/jev-1.14` | 有序列表；`off`/空 = `off(empty-list)`                |
| `memory.jev.proxy`               | string       | `""`                                                                    | 只给分类器用的 HTTP 代理                              |
| `memory.jev.childSessions`       | bool         | `true`                                                                  | 子会话召回与门禁                                      |
| `memory.jev.recall.threshold`    | 0.5–0.99     | `0.7`                                                                   |                                                       |
| `memory.jev.recall.maxEntries`   | 1–10         | `3`                                                                     | 每条注入消息的条目上限（U/A/B；E 固定 2）             |
| `memory.jev.recall.maxBytes`     | 512–16384    | `4096`                                                                  |                                                       |
| `memory.jev.recall.waitMs`       | 0–3000       | `1500`                                                                  | 用户消息召回的同步等待；0 = 纯异步（待拍板 D1）       |
| `memory.jev.gate.enabled`        | bool         | `true`                                                                  |                                                       |
| `memory.jev.gate.threshold`      | 0.5–0.95     | `0.6`                                                                   |                                                       |
| `memory.jev.review.intervalDays` | 0–90         | `7`                                                                     | 0 = 只手动（待拍板 D6）                               |
| `memory.jev.maxCostUsd`          | 0.01–5       | `0.5`                                                                   | 每次 activation                                       |
| `memory.jev.maxCalls`            | 0–5000       | `800`                                                                   | 每次 activation                                       |
| `memory.jev.confirmTimeoutS`     | 10–600       | `60`                                                                    | 用户令修改确认框，超时视为拒绝                        |

- 共 14 个键。各项时限、批大小、`/proc` 上限、错误签名上限等用常量，不开设置（少一个旋钮就少一份 I9 证明）。
- 代理 URL 的合法性在使用侧校验，设置解析只保证类型。

### 9.2 I9 论证

- **off 的定义**：`memory.jev.enabled=false`，或 `layout/toolSurface` 取 legacy，或非 plain 域。此时 `wireMemory` 走与今天完全相同的路径：
  - 不调 `wireJev`，不注册任何新钩子和渲染器；
  - 工具用原常量 `MEMORY_TOOL_V2_TEXT` 和原 schema；
  - `doAppend`、doctor（不跑 D17–D19）、启动提醒、`inject.ts`（不传 `stripMemMeta`、`onRender` 多出的参数不被消费）、tidy prompt、`/mem` 输出全部不变。
- **证明**：J0 在未改动的 dev 上生成 `jev-off-golden.json`，内容包括：
  1. 真实 `wireMemory` 的注册序列；
  2. 固定脚本下 v2 工具各命令的输出文本与写后文件字节（假时钟）；
  3. current-5 与一个合成 core fixture 的 tiered 渲染、doctor 报告、启动提醒文本；
  4. tidy prompt。

  之后以 `{jev:{enabled:false}}`、`{layout:"legacy"}`（jev=true）、模拟 secure 域（jev=true）三种配置重放，必须逐字节相等。

- **on 但 Jev 不可用**：不是 byte-identical（新钩子已注册、工具描述用变体、`/mem` 多一行状态），但功能等价于今天：注入只剩静态分层块，钩子判为停就直接 return。由单测钉住「不可用时零 sendMessage、零 block」。

### 9.3 工具面变体（jev 开启时）

- `MEMORY_TOOL_V2_TEXT_JEV` = 原描述 + 一段约 350B 的说明：

  ```text
  Entries are tagged automatically after writes. Inline authority (end of the entry's first line): <!-- mem user|lesson expires=YYYY-MM-DD until="…" gate|gate=hold|nogate tags=+a,-b private -->. tag_add adds a project tag (id, description).
  ```

- schema 变体在原 `command` 枚举里追加 `tag_add`，并新增可选字段 `tag_id`、`tag_description`（≤240B）、`tag_label`。
- `memory-tool-surface.json` 新增 jev 变体的 key，`toolSurfaceBytes`（`tool-surface.ts:64`）预算同包核对。

### 9.4 `/mem jev` 输出示例（I12：机制写在工具和命令里，策略写进 skill）

```text
jev     enabled · ready · proxy http://***@127.0.0.1:7890
models  1 opencode/jev-1.13-free        unavailable (451) until 12:05 — 451 多为地区拦截，可设 memory.jev.proxy
        2 opencode/jev-1.13             ok · 0.84s
        3 openrouter/typesafe/jev-1.14  no auth
        → active opencode/jev-1.13
usage   37 calls · $0.0061 / $0.50 · per activation (/reload resets)
index   142 tagged · 3 pending · taxonomy 4f2a91c0 (22 preset + 3 project)
segment injected 5 (U3 A1 E1) · gates 1 (hold 0) · cap 5/30
review  last 2026-10-28 · 2 open → /mem review
```

- 子命令：`/mem jev probe`、`/mem jev retag [--all]`、`/mem jev reset-index`；`/mem tags [list|add|rm|disable|enable]`；`/mem review [--run|--list]`；`/mem expired`。
- web 策略：`jev`、`tags list`、`review --list` 为只读 allow，其余 deny。
- 新 skill `skills/memory-jev/SKILL.md` 写策略：先查后写、用户令当场写、经验坑收尾时写、转述回显里的 conflict/userLike/temporal 行。

## 10. 测试与验证策略

- **假 registry**：在 `tests/memory/jev/helpers/fake-registry.ts` 里实现 `ClassifierRegistryLike`。
  - 按问题 id 返回脚本化的答案；
  - 错误形状严格照搬实测：`System One API error (451): {...Endpoint is unavailable...}`、`(402) …Insufficient account funds`、`Provider is not configured`、`stopReason:"aborted"`；
  - 可注入延迟（配合假时钟）和漏答；
  - 记录收到的 `state`、`questions`、`options`，用来断言脱敏结果和 `fetch` 是否传入。
- **假代理**：复用 v4.1 P5b 的 12 例与 URL 解析表驱动（本机 `node:net`/`node:tls` 服务器，自签证书，不联网）。
- **单测矩阵**（`tests/memory/jev/*.test.ts`）：
  - `entries`：切分规则、围栏、续行、两种哈希、行内解析永不抛错；
  - `taxonomy`：合并、上限、rev；
  - `questions`：按 token 分批的边界；
  - `decide`：阈值边界 0.69/0.70、门禁判定表全部格子、取最严、到期标注；
  - `health`：§5.2/§5.3 的全部转移，包括「首位 451 → 次位 402 → 第三位成功」、逐模型熔断、整列不可用、context 类拆批、预算耗尽；
  - `redact`：每条规则正反例，包括「先匹配后截断」跨窗口；
  - `review`：配对组装与截断优先级；
  - `guard`：沿用 v4.1 三例；
  - `index-store`：坏 JSON、锁忙跳过、并发合并、垃圾回收。
- **集成**（`tests/integration/memory-jev*.test.ts`，fakePi + 假 registry）：
  - 用户消息召回：同步落点与超时晚到两条路径；
  - 写入打标与回显；
  - 迁移批量打标；
  - 门禁：release.sh 场景，hold 下重试仍拦，任务结束后放行；同批并行相同调用只问一次 Jev；`echo "git commit"` 在粗筛就放行；
  - 失败召回：前台与后台通知两种路径；
  - compaction 后 B 层重注；
  - Jev 不可用时零 sendMessage、零 block；
  - secure 域零接线；
  - 子会话。
- **P0 conformance**（`tests/conformance/memory-jev-channels.test.ts`，纳入 peer bump 清单）：
  - C-J1 `before_agent_start` 被 await，返回的 message 排在用户消息之后，第一次 LLM 请求可见；handler 等待 1.5s 期间 abort 的行为。
  - C-J2 `tool_call` 被 await；block 后得到 isError 结果且不触发 `tool_result`；handler 抛错的后果（`runner.js:957-970` 无 try）。
  - C-J3 同批并行工具调用时 `tool_call` 的派发顺序与并发度。
  - C-J4 `sendMessage(triggerTurn:false)` 分别在 `tool_call`、`tool_result`、晚到的异步回调中，处于 streaming 和 idle 两种状态时的落点。
  - C-J5 `tool_result` 事件字段（`input`/`isError`/`structuredContent.exit_code`），返回 undefined 时结果不变。
  - C-J6 `bash-job:notification` 两种到达方式的落点（v4.1 ⑨）。
  - C-J7 `ctx.modelRegistry.classify` 在主会话 handler、子会话、工具 `execute` 和命令上下文中都存在；从不 reject；abort 得到 `stopReason:"aborted"`；`options.fetch` 被调用（假 provider）；`getAvailableOfType` 只看凭证。
  - C-J8 错误文本格式 `<Provider> API error (<status>): <body>`，以及上下文超限的措辞。
  - C-J9 skill 展开块格式（v4.1 ⑦）。
  - C-J10 子会话 switch 写 compaction 条目（v4.1 ④）。
  - C-J11 嵌套 `ctx.executeTool` 经过 `tool_call`。
  - C-J12 工具结果中的 `usage` 计入会话费用。
  - C-J13 `registerMessageRenderer` 的折叠显示。
  - C-J14 命令上下文中 `ctx.ui.setEditorText` 可用。
- **质量评测**（Tier 3 probe，不进 CI）：`scripts/dev/jev-eval.mjs`。
  - 标注集放 `tests/fixtures/memory/jev-eval/`：召回 40 例（来自真实派单、用户消息与本仓语料）、门禁 24 例（含 release.sh、push 确认、`echo` 干扰项）、打标 30 例、整理 20 对；
  - 需要凭证和代理，输出各项职责的 precision/recall，用来校准阈值；
  - J0 先跑一次基线，尤其要验证未实测过的 choice/score 问题和「标签为主」问法的质量。
- **门禁命令**：每包执行 `npm run format:check && npm run typecheck && npx vitest run tests/memory tests/conformance tests/boundary tests/governance`；J9 跑全量四件套。

## 11. 关键决策与备选

| 决策           | 选择                                   | 不选的备选与理由                                                                                                                               |
| -------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 派生标签存哪   | 侧车 `.jev/index.json`                 | **行内存**：每次打标都要改写用户的 md，触发 tidy 和用户令守卫、污染 diff 与静态块预算；派生数据本来就可以重算。**frontmatter**：只能到文件粒度 |
| 权威事实存哪   | 行内注释                               | **侧车**：用户看不见、编辑后按 hash 会丢；权威事实必须随正文走                                                                                 |
| 条目粒度       | 列表项，无列表时取整段                 | **只按 `## ` 小节**：现有语料 13 个文件里 7 个没有 `## `，粒度太粗，Jev 判断不准，注入也会超预算                                               |
| 召回候选       | 一次判全部（≤360），超过才两段式       | **先词面预筛到 24 条**（v4.1）：`jev-current-state.md` §10 表明 200 个问题与 4 个问题延迟几乎相同，预筛只会丢召回率                            |
| 召回时序       | 有界同步 1.5s，再晚到补发              | **纯异步**（O2）：纯问答那一轮看不到记忆，而召回现在是主通道；**无界同步**：违反 I1                                                            |
| 门禁触发       | 高危标签匹配器 + 守护条目 + Jev 现场判 | **每次工具调用都问 Jev**：每次多约 1s；**纯规则**：回到手写触发词                                                                              |
| 门禁的条件判断 | 把现场证据交给 Jev 判 `violates_now`   | **v4.1 的 `if-running` 谓词**：要手写，且只认得几种条件                                                                                        |
| 整理结果       | 只产建议，用户点选执行                 | **自动删除、合并**：违反 Q1 与「不做」项；Jev 也写不出合并文本                                                                                 |
| 不可用时       | 智能判断全停，只留静态块               | **退到对话模型**：Q21 明确拒绝（成本、刷屏风险）                                                                                               |
| 健康表作用域   | 进程级 `Symbol.for`                    | **每会话一份**：子 agent 群会对同一个 451 端点各撞一次                                                                                         |

## 12. 旧拍板处置与 v4.1 部件复用

### 12.1 Q1–Q24

| #   | 原结论（摘要）                    | 处置                     | 新架构中的落点                                                                                                          |
| --- | --------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Q1  | 到期只提醒，确认后删              | **保留**                 | §6.3.5；注入时带「已到期」标注，不隐藏                                                                                  |
| Q2  | 系统推送 + 流程节点兜底           | **保留**                 | 推送 = U/A/E/B/G 五层；兜底规则写进 skill                                                                               |
| Q3  | 一次做完，三期只剩调优            | **改变**                 | 范围改为本架构（J0–J9）；调优靠 §10 的评测集与阈值设置                                                                  |
| Q4  | 用户令只有用户能作废              | **保留**                 | 行内 `user` + 默认归属 + `guard.ts` 两阶段确认（§6.2.5）；Jev 不决定归属                                                |
| Q5  | T1 + T2a + T2b + T3 四层          | **改变**                 | T1 → A 快速通道 + G 门禁；T2a 关键词**作废**；T2b → U（Jev 主判定）；T3 → B                                             |
| Q6  | 只拦 gate 条目，其余事后附加      | **保留语义，改变来源**   | 守护条目 = Jev 判 guard 或行内 `gate`；拦不拦由 Jev 现场判定；非守护条目一律事后附加                                    |
| Q7  | agent 写触发规则并回显            | **作废，代之以标签回显** | agent 不再写触发规则；写后回显 Jev 标签，用户可用行内 `tags=` 或 `/mem tags` 修正                                       |
| Q8  | 轻量标记                          | **保留**                 | §6.1.6                                                                                                                  |
| Q9  | 子 agent 接收注入                 | **保留并扩展**           | 子会话也受门禁约束（§8）                                                                                                |
| Q10 | 上线后逐条确认清理 core 指针条目  | **保留**                 | 上线后的手动流程；Jev 的 `type=pointer` 可帮 agent 列出清单                                                             |
| Q11 | A 结果、B 状态、C 暂存、E argv    | **A/E 保留，B/C 改变**   | A → E 层由 Jev 挑排障条目（字面 `out=`/`exit=` 作废）；B → 现场证据交给 Jev；C → 暂存文件作为门禁证据；E → 粗筛与匹配器 |
| Q12 | 分类器优先，没有就退对话模型      | **改变**                 | 只用分类器；对话模型回退**作废**（Q21）                                                                                 |
| Q13 | 分类器用于 T2b 与 A 兜底          | **改变**                 | 扩为四项职责（Q20）                                                                                                     |
| Q14 | 凭证可选，有则启用；secure 强制关 | **保留**                 | 默认开、自动探测（D4）；secure 双重关闭（§7.3）                                                                         |
| Q15 | `gate=hold`                       | **保留**                 | 行内 `gate=hold` 或 Jev 判 `gateMode=hold`；条件由 Jev 判 `violates_now`                                                |
| Q16 | A 兜底不退回对话模型              | **保留（已普适化）**     | 所有职责都不退回                                                                                                        |
| Q17 | 有序列表 + 逐个故障转移           | **保留**；后半句作废     | §5.2；「整列不可用才退回对话模型」作废，改为智能判断停止                                                                |
| Q18 | 分类器专用代理                    | **保留，键改名**         | `memory.jev.proxy`（§5.4）                                                                                              |
| Q19 | 推翻 v4 重做                      | **本文即其落实**         | —                                                                                                                       |
| Q20 | Jev 四项职责                      | **落实**                 | §6.1–§6.4                                                                                                               |
| Q21 | 硬依赖，不可用即关闭              | **落实**                 | §5.3；快速通道与 B 层的去留见 D3                                                                                        |
| Q22 | 粗筛后才同步问 Jev                | **落实**                 | §6.4.1                                                                                                                  |
| Q23 | 截断 + 脱敏                       | **落实**                 | §7                                                                                                                      |
| Q24 | 固定可扩展标签，不再手写触发词    | **落实**                 | §4.3                                                                                                                    |

v4.1 的 O 项：

- O1（与 topic-switch 不共用调用）保留；
- O2（纯异步）**改变**，见 D1；
- O3（不回退会话模型）保留；
- O4（默认开）保留，见 D4；
- O5、O6、O7、O8、O9、O11 保留；
- O10 改为 Jev 的「疑似用户令」建议（§6.3.4）；
- O12–O17 见上表 Q11–Q16；
- O18 与 O19 即 Q17 与 Q18。

### 12.2 v4.1 部件复用清单

| 部件                                                                                     | 处置                                                                                                            |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GATE_REASON` / `GATE_HOLD_REASON` 文案协议                                              | **复用，改写依据**：条件来源从规则键改成「Jev 判词 + 证据」                                                     |
| 错误分级与逐模型熔断（§2.4.1）                                                           | **原样复用**，新增 `context` 类；整列不可用的后续处理改为停止                                                   |
| 代理 fetch（§2.4.1 v4.1 行、P5b 的 12 例）                                               | **原样复用**，键改名                                                                                            |
| argv 解析（§2.7.1）                                                                      | **原样复用**；用途从 `cmd=` 匹配改为标签匹配器与粗筛                                                            |
| 状态谓词 if-running / if-branch / if-session（§2.7.3）                                   | **数据采集复用**（proc-scan、git-head），谓词语法**删除**，改为证据交给 Jev；if-session 由 `state.session` 承载 |
| 提交时暂存文件（§2.7.4）                                                                 | **复用为门禁证据**，触发条件改为「git commit 且候选正文含路径」                                                 |
| 结果触发时序（before_agent_start / message_start，§2.7.2）                               | **原样复用**                                                                                                    |
| 段内去重、回扫播种、闩锁（§2.1/§2.2）                                                    | **原样复用**，键从 EntryKey 改为条目 hash                                                                       |
| 消息格式与渲染器（§2.1/§4.2）                                                            | **复用**，层标改为 U/A/E/B/G                                                                                    |
| T3 边界（§2.5）                                                                          | **复用**为 B 层                                                                                                 |
| 用户令守卫与配对算法（§3.2）                                                             | **原样复用**                                                                                                    |
| append 刷 `updated`（§3.1）、D17 到期、D18 语法错、D19 core 用量、`/mem expired`（§3.3） | **复用**；D02 不加 fix 文本（改为放进启动提醒），doctor golden 因此不变                                         |
| P0 conformance ①–⑨                                                                       | **并入 C-J1–C-J14**                                                                                             |
| §14 实测                                                                                 | 作为阈值 0.7、451 排障提示、「有凭证≠可用」的依据                                                               |
| 条目元数据行语法（§1.2）                                                                 | **大部分删除**：只保留 user/lesson/expires/until/gate 系列，新增 tags/private/nogate                            |
| 对话模型判断器链、T2a 关键词、静态块极简目录                                             | **删除**（或延后，见 §5.6）                                                                                     |

## 13. 风险与缓解

| 风险                                                                                | 等级 | 缓解                                                                                                                                   |
| ----------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Jev 判断质量：choice/score 问法、「标签为主」问法、门禁 `violates_now` 都没有实测过 | 高   | J0 先跑评测基线再定阈值；全部阈值可调；门禁要求两重 Jev 判断（守护标记 + 现场判定）都成立才拦；行内 `gate`/`nogate`/`tags=` 可人工覆盖 |
| 门禁误拦，卡住正常操作                                                              | 中   | 普通门禁只拦一次（闩锁）；hold 在条件消失后放行；Jev 失败时放行（D2）；`nogate` 与 `gate.enabled` 逃生；`/mem jev` 显示本段门禁记录    |
| 门禁漏拦：打标漏判或粗筛匹配器没覆盖                                                | 中   | 用户显式 `gate` 的条目对任何高危命中都是候选；预置高危匹配器覆盖 git/发版/删除/依赖/派单；用户可加项目级高危标签；评测集覆盖           |
| 同步等待拖慢交互                                                                    | 中   | 召回 ≤1.5s 后转异步；门禁只在粗筛通过时等待，上限 2.5s；不可用时零等待                                                                 |
| 外发泄露                                                                            | 中   | §7 流水线 + 永不外发清单 + `private` + D13 剔除 + secure 双关；进程证据只收规则点名的程序（D7）                                        |
| 注入噪音                                                                            | 中   | 阈值 0.7、每条 ≤3 条/4KB、段内去重、每段 30 条熔断、错误签名限流；评测调参                                                             |
| 免费档或渠道不稳导致频繁翻转                                                        | 低   | 逐模型隔离 + 有序故障转移；同一原因只通知一次                                                                                          |
| 侧车损坏或多会话竞争                                                                | 低   | 侧车是缓存：坏了就重建；hash 合并幂等；锁忙跳过                                                                                        |
| 32k 上下文超限                                                                      | 低   | 按 token 估算分批（12k/批）；context 类错误拆批重试                                                                                    |
| pi 语义变化（并行 tool_call、消息落点、classify 签名）                              | 中   | C-J1–C-J14 纳入 peer bump 清单；能力探测缺失即 `off(pi-api)`                                                                           |
| agent 把用户令写成经验（v4.1 #13 固有缺口）                                         | 低   | Jev 的 `userLike` 在回显和整理中提示；`/mem review` 列为「疑似用户令」                                                                 |
| 标签爆炸                                                                            | 低   | 启用标签 ≤64、agent 来源 ≤16，且 agent 标签恒为 normal 风险                                                                            |
| 首次上线批量打标的费用与时长                                                        | 低   | 约 $0.02、约 40s，后台执行，受 `maxCostUsd` 约束；可改为手动（D5）                                                                     |

## 14. 待用户拍板

| #   | 问题                                                   | 推荐                                                                           | 理由（一句）                                                         |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| D1  | 用户消息召回是否同步等待（改变 O2）                    | **(a) 有界同步 1.5s，超时转晚到补发**；(b) 维持纯异步                          | Jev 实测 <1.2s，召回已是主通道，纯异步会让纯问答那一轮看不到记忆     |
| D2  | 门禁判定时 Jev 超时或出错                              | **(a) 放行 + 事后注入规则正文并标注 unjudged**；(b) 拦截（fail closed）        | 外部分类器的抖动不应卡死全部 git 操作，事后注入仍让模型看到规则      |
| D3  | Jev 不可用时零调用部件（A 快速通道、B 边界重注）的去留 | **(a) 一并关闭**；(b) 保留（依赖既有标签）                                     | 与 Q21「只保留现有分层注入」字面一致，状态单一、可预期               |
| D4  | `memory.jev.enabled` 默认值                            | **(a) 默认开（有可用分类器即生效）**；(b) 默认关                               | 与 Q14「有凭证自动启用」、O4 一致；没有凭证时功能上等同于今天        |
| D5  | 首次上线的批量打标                                     | **(a) 首次 ready 后自动后台执行**；(b) 手动 `/mem jev retag --all`             | 约 $0.02、约 40s，不打标的话快速通道和门禁上线当天覆盖不到存量记忆   |
| D6  | 周期整理                                               | **(a) 会话开始时若距上次 ≥7 天且语料有变，后台跑并只提示**；(b) 仅手动         | 每次约 $0.004，只提示不动数据，能防止「过时规则留 8 天」再发生       |
| D7  | 门禁状态证据中的进程信息                               | **(a) bash 任务 + 规则正文点名的程序的进程命令行（脱敏）**；(b) 只发 bash 任务 | 只有 (a) 能识别另一个终端在跑的 release.sh，过滤规则保证不发无关进程 |

## 15. 拆包建议（粗粒度，供 Plan 细化）

依赖：`J0 → {J1, J3} → J2 → {J4, J5, J6, J8} → J7 → J9`。J7 依赖 J6 的 segment 与 format。

| 包  | 名称          | 文件域                                                                                                                                                                     | 依赖   | 要点                                                          |
| --- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| J0  | 基线          | `tests/memory/jev/off-golden.test.ts` + `jev-off-golden.json`（在未改的 dev 上生成）、`tests/conformance/memory-jev-channels.test.ts`、`scripts/dev/jev-eval.mjs` + 评测集 | —      | 只加测试与脚本；评测基线写进包报告，决定阈值初值              |
| J1  | 纯域          | `jev/{contracts,entries,taxonomy,redact,shell-parse,match,guard,format}.ts`、`src/memory/secret-patterns.ts`（从 `doctor.ts` 搬家）、pi-free 测试根                        | J0     | 永不抛错；doctor 输出不变                                     |
| J2  | 引擎          | `jev/{client,health,proxy-fetch,questions,decide}.ts`                                                                                                                      | J1     | 假 registry、假代理、假时钟全覆盖                             |
| J3  | 设置与 secure | `src/memory/settings.ts`、`setting-specs.ts`、pin corpus、`src/config/settings.ts:418`、`docs/dev/data-encryption/README.md`                                               | J0     | 14 键；D8 补项；开工前先读 data-encryption README             |
| J4  | 侧车与命令    | `jev/index-store.ts`、`jev/review.ts`（纯部分）、`/mem jev`、`/mem tags`（`command.ts` 分派）                                                                              | J2, J3 | 批量打标（D5）、garbage collect                               |
| J5  | 写入路径      | `tool-v2.ts`、`tool-surface.ts`、`memory-tool-surface.json`（新增 key）、`skills/memory-jev/SKILL.md`                                                                      | J2, J4 | 打标回显、append 刷新、Q4 守卫、`tag_add`                     |
| J6  | 召回运行时    | `jev/{wire,segment}.ts`、`src/memory/index.ts`、`inject.ts`（onRender、strip）、`src/index.ts`（secure 参数、bashJobs 端口预留）、activate-trace 声明刷新                  | J2, J4 | U/A/E/B 四层、渲染器、可用性通知与探测计时器                  |
| J7  | 门禁          | `jev/probes.ts`、`wire.ts` 门禁分支、`src/index.ts` bashJobs 绑定                                                                                                          | J6     | release.sh 验收场景、并行批、失败放行（D2）                   |
| J8  | 整理与到期    | `review.ts` 交互、`/mem review`、`/mem expired`、`doctor.ts` D17–D19、`doctor-command.ts` 启动提醒、`tidy/prompt.ts` 条件规则                                              | J2, J4 | doctor golden 实测不变                                        |
| J9  | 收尾          | web transcript 紧凑分支（可选）、`docs/dev/memory/README.md` 不变式、`docs/guide/memory.md`、生产接线 e2e、全量回归                                                        | 全部   | `git diff origin/dev -- tests/fixtures/` 只含 §4.5 声明的文件 |

每个包按 dev-flow 执行：返回后立即派验收（验收模型 ≠ 开发模型），通过后按精确路径 commit。

### 15.1 实施要点（给下游的提示）

- `tool_call` handler 必须整体包 try/catch、永不抛错（`runner.js:957-970`）；粗筛要在第一个 await 之前完成，保证不命中的调用零 await。
- 不要缓存 `ctx.modelRegistry`，每次从当前 ctx 取。子会话的 registry 是新建的（`session-driver.ts:634` 附近的注释）。
- 所有 deadline 经 `clampSpanMs`，>24.8 天的值（不会出现，但探测计时器要统一处理）用 `createSegmentedClock`；全部计时器 `unref`。
- `src/memory/settings.ts` 不得新增 import（web-hub 边界白名单）。
- 侧车写入只在锁内做同步合并，Jev 调用绝不能放在锁内。
- 工具结果里带上 Jev 用量（打标费用计入会话）。
- 评测集与真实语料可能含个人信息，入库前用 §7 流水线脱敏。

## 16. 面向用户的技术讲解

> 这一节写给不读代码的人：记忆怎么存、怎么被送到模型面前、Jev 在每一步做什么。

### 16.1 记忆怎么管理

- 记忆仍是你熟悉的 Markdown 文件，放在 `~/.pi/agent/memory/<项目>/`，`core.md` 每轮都在；其它是专题文件。文件里的**每个列表项**（或者没有列表的一整段）就是一条「条目」。
- 每条记忆有两类信息：
  - **你（或 agent）写下的权威事实**，用一个不显眼的注释写在条目末尾，例如 `<!-- mem user expires=2026-11-30 -->`：这是用户令、到某天到期。没写的话，你手写的文件默认都算用户令，agent 建的文件默认算经验。
  - **Jev 打的标签**：这条是规则还是踩坑、重要程度、属于哪些场景（推送、发版、派单、测试……）、是否在管危险动作。这些存在一个隐藏的索引文件里，不改你的 md；删了也没关系，会重新打。
- 「场景」是一张固定的清单（约 22 个，如推送、发版、删除、派单、测试），每个场景有一句说明。Jev 只能从清单里选，不会编新词。你可以加自己项目的场景（`/mem tags add`），agent 也可以加，但 agent 加的场景不能用来拦截动作。

### 16.2 Jev 是什么，它在哪几步出场

Jev 是一种「分类器」模型：不会写字，只会回答选择题、打分题和是非题，并给出把握有多大。它很快（约 1 秒，不论一次问 4 个还是 200 个问题），很便宜（问 200 个问题约 0.0006 美元）。它在四个地方出场：

1. **你说话时**：把你的话和全部记忆条目交给它，逐条问「处理这句话必须知道这条吗？」，把把握 ≥70% 的前 3 条递给模型。
2. **agent 写记忆时**：问它「这条是什么类型、多重要、属于哪些场景、是否在管危险动作、是不是临时的、像不像你下的命令、和哪条旧记忆重复或矛盾」，把答案回显给 agent。
3. **每周整理时**：把可能相关的两两条目交给它，问「重复、矛盾还是被取代？」，结果只作为建议，等你确认。
4. **agent 要做危险动作时**：先用便宜的规则粗筛（是不是 push、发版、删除、派单之类，有没有管这事的记忆），只有真有相关规则时才问它「这条规则管不管这次操作？现在是不是正在违反？」，必要时拦下。

Jev 用不了的时候（没登录、余额不足、地区被拦、加密环境），以上四件事全部停下，只剩「core.md 和目录每轮都在」这个老办法。`/mem` 第一行会告诉你现在的状态，例如 `jev: unavailable (451) · retry 12:05`；在国内网络下可以设置 `memory.jev.proxy`，只让 Jev 的请求走代理，不影响 pi 的其它流量。

每次有记忆被送进对话，你会看到一行灰色小字，例如 `── mem U: pitfalls-git › #3 (0.81) ──`，按 ctrl+o 才展开正文。

### 16.3 例 1：你说「帮我推到 GitHub」

1. 你发出消息。系统在模型开工前（最多等 1.5 秒）把消息交给 Jev。发出去的 `state` 是 `{user_message:"帮我推到 GitHub", session:"main"}`，问题是约 140 个是非题，每条非 core 记忆一题，例如「`push 前 export https_proxy=…` 这条，处理这句话必须知道吗？」。
2. Jev 约 0.9 秒后回答：「push 走代理」0.81、「发版期间禁止提交」0.48、「gocryptfs 测试抖动」0.46，其余都 <0.1。只有 0.81 那条超过 0.7，于是它随你的消息一起进入模型的视野，你看到一行 `mem U: pitfalls-git › #3`。
3. 模型执行 `git push`。粗筛发现这是「推送」这个高危场景；core.md 里有一条你写的「push 需用户确认」，Jev 早先已把它标为守护条目。于是系统同步问 Jev：「规则『push/发版需用户确认』和这次 `git push origin dev` 是什么关系？」Jev 答 applies 0.83。
4. 这次 push 被拦下，模型收到 `[memory gate] … 规则「core.md L4」（用户令）…` 的说明（规则本来就在系统提示里，所以不重复贴正文），于是先问你「可以推吗？」。你同意后，它原样重试；由于它已经看过规则，重试不再被拦。
5. 如果 push 因网络失败（退出码 128、`Connection timed out`），系统会把「bash、git push、128、错误摘录（已脱敏）」交给 Jev，问哪些排障条目能解释这个错误。代理那条已经注入过，不会重复；若有其它命中，会紧跟在失败结果后面出现。

### 16.4 例 2：release.sh 在后台跑时，agent 执行 git commit

1. 记忆里有一条你写的规则：「release.sh 运行期间禁止 commit/tag/切分支」，末尾写了 `<!-- mem user gate=hold -->`，意思是条件成立期间要一直拦。
2. agent 执行 `git add -A && git commit -m …`。粗筛命中「提交」高危场景，且有这条守护规则，于是系统收集现场：后台任务列表里有 `job_42 bash scripts/release/release.sh 0.10.3`（只收录规则正文里点名的程序），当前分支是 dev。
3. 发给 Jev 的是一道选择题：「这条规则和这次提交是什么关系？unrelated / applies / violates_now」，state 里带着命令和正在运行的任务。Jev 答 violates_now 0.86。
4. 提交被拦，agent 收到 `[memory gate·hold] … 条件仍成立（证据：job_42 …）… 请等待，不要反复重试`。规则正文只在第一次拦截时贴一次。agent 再试，系统重新问 Jev，结果仍是 violates_now，于是继续拦。
5. release.sh 结束后，agent 再提交：state 里已没有运行中的任务，Jev 判为 applies 或 unrelated，而这条规则本段已审过，于是放行。
6. 如果这时 Jev 正好超时：按推荐方案放行，但会把规则正文贴给模型并标注「Jev 未能判定，请自行核对」（待拍板 D2）。
7. 对比 `echo "git commit"`：粗筛看出程序是 echo，不是 git，直接放行，零延迟。

### 16.5 例 3：agent 新写一条记忆

1. agent 调用 `memory`，在 pitfalls-git.md 里加一条：「gh 命令也要走代理，否则 `gh pr create` 卡住」。
2. 写入照常完成后，系统立刻问 Jev 一次：state 是这条新条目，问题约 60 个，包括类型选择、重要度打分、22 个场景是非题、「是否在管危险动作」「是否临时」「像不像用户命令」，以及与 12 条最相似旧条目各一道「关系」选择题。
3. Jev 约 1 秒后返回：类型 pitfall 0.90，重要度 important，场景 network 0.86、git-push 0.71，管危险动作 0.15，永久，像用户命令 0.10；与「push 前 export https_proxy」的关系是 complementary 0.74。
4. agent 在工具结果里看到：

   ```text
   jev: pitfall 0.90 · important · tags network 0.86, git-push 0.71 · guard 0.15 · permanent
   similar: pitfalls-git.md #3 (complementary 0.74)
   ```

   以后 agent 一执行 `gh pr create`，快速通道就会按「推送」场景把这条推出来，不用再问 Jev。

5. 如果 Jev 判为与某条用户令「矛盾」（≥0.75），回显会说「用户令只有用户能作废：在回复里向用户提议具体改法」，agent 必须来问你，不能自己改。如果 Jev 判为「像用户命令」（≥0.8），回显会提醒 agent：若这是你的原话，就给它加上 `<!-- mem user -->`。

### 16.6 例 4：每周整理发现两条矛盾记忆

1. 周一你开一个新会话，距上次整理已经 7 天，记忆也改过。系统在后台组装候选对：共享场景、或字面相近的两两条目，最多 600 对。
2. 其中一对：A「GPT 系模型临时禁用，派单避免 GPT」（10-12）、B「GPT 系模型已解禁（10-21 确认）」（10-21）。问 Jev：「A 与 B 是什么关系？重复 / 矛盾 / A 取代 B / B 取代 A / 互补 / 无关」。Jev 答 b_supersedes_a 0.91。
3. 你在启动时看到一行提示 `jev 2 suggestions — /mem review`。运行 `/mem review`，第一条是「B 取代 A（0.91）」，选项为「删除被取代的一条 / 交给 agent 改写 / 保留 / 跳过」。
4. 你选「删除被取代的一条」，A 被移进回收站（可以 `/mem restore --trash` 找回）。若你选「保留」，这一对以后不再提示。
5. 从头到尾 Jev 只给建议，删不删由你点；它也写不了合并后的文字，需要合并时会把一句指令预填进输入框，由你决定是否交给 agent。

### 16.7 例 5：Jev 突然用不了

1. 你在一个新网络环境开会话，后台探测得到 451（地区拦截）。`/mem` 显示 `jev: unavailable (451) · retry 12:05`，并弹一次提示，指向 `/mem jev`。
2. 此后记忆只按老办法工作：core.md 与目录每轮都在；不做召回、不打标、不整理、不拦截。工具调用零延迟。
3. 你设置 `memory.jev.proxy` 并 `/reload`，或者运行 `/mem jev probe`。探测成功后状态回到 `ready`，会提示一次 `jev recovered`。之前没打上标签的新条目会在后台补标。
4. 在加密（secure）环境里，Jev 永远关闭，任何设置都打不开，记忆内容不会离开本机。
