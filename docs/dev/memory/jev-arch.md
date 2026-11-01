# 以分类器 Jev 为核心的 memory 架构（jev-arch v2.1）

> 状态：架构设计稿 v2（2026-10-30），未动代码。v1 经评审 r1（`jev-arch-review-r1.md`）判为「有条件通过」；用户在第八轮拍板（`hygiene-flow.md` Q25–Q32 及一条主会话裁定）对 v1 §14 的待拍板项作了决定，v2 据此修订。处置表见 §17，变更记录见 §18；v2.1 勘误（只改表述、不改设计，`jev-plan.md` §10 与 Q33–Q35）见 §19。
> 本稿取代 `hygiene-plan.md` v4.1（Q19），复用的部件列在 §12.2。
> 需求基线：Q19–Q32 优先；Q1–Q18 中与之不冲突的部分继续有效，逐条处置见 §12.1。
> 事实底图：`jev-current-state.md` 的 §1–9（代码现状）与 §10（Jev 实测）。
> 引用约定：对现有代码的断言标 `文件:行号`；对 pi 行为的断言标文档或 d.ts 位置；未经实测的标「需 P0 验证」，由 J0 的 conformance 测试钉住。
> 读者：§1–§15 写给下游的方案和开发，§16 写给不读代码的用户。
> **实施状态**（J9，2026-11-01）：J0–J9 全部合入 dev（HEAD `e59b272d`），全量测试绿；§19 追加 12 条 v2.1 补充勘误，来源为各包交付报告与 E0 基线。

## 0. 结论速览

| 问题     | 决定                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一句话   | Markdown 记忆文件仍是唯一权威数据源；Jev 的派生标签存进可丢弃的侧车索引；需要 Jev 的判断（召回、打标、整理、现场拦截判定）全部经过一个 pi-free 的 Jev 客户端（有序列表、逐模型故障转移、错误分级、可选专用代理）。不调用 Jev 的部分（零调用部分）用上次的标签继续工作（Q26）                                                                                                                                     |
| 条目     | 顶层列表项连同其续行，或者不含列表项的 `## ` 小节整体（§4.1）。现有语料约 150 条，绝大多数是列表项                                                                                                                                                                                                                                                                                                               |
| 谁写什么 | 权威事实写在条目的行内注释里，由用户或 agent 手写，包括：用户令、到期、门禁覆盖、手工标签增删、私密（§4.2）。Jev 选出的派生判断（类型、重要度、场景标签、是否守护危险动作、时效、像不像用户令）存进 `<slug>/.jev/index.json`，以内容哈希为键（§4.4）                                                                                                                                                             |
| 标签体系 | 预置 6 种类型、4 级重要度、22 个通用场景标签，用户可用 `/mem tags add` 增加项目标签。agent 新增标签推迟到二期（Q32）。标签的 `description` 原样作为 Jev 的 criteria。命令前缀、路径 glob 这类匹配器只挂在标签上，条目上不再写触发词（Q24）                                                                                                                                                                       |
| ① 召回   | 用户消息到来时由 Jev 判定全部候选（最多 360 条，按 token 分批并行），`state` 里附带上一条用户消息。最多等 1.5 秒（Q37 起默认 2 秒），结果搭本轮便车注入；超时就先开工，结果晚到再补发（Q25）。另有零调用的动作快速通道和压缩后重注。失败的工具结果由 Jev 从经验条目里挑排障条目                                                                                                                                  |
| ② 打标   | `memory` 工具写入后同步问 Jev 一次（约 50 个问题，耗时不到 1.2 秒），并把结果回显。Jev 第一次可用时，后台自动给存量条目打标：172 次调用，约 $0.02，40–60 秒（Q28）                                                                                                                                                                                                                                               |
| ③ 整理   | 每 7 天在后台跑一次，只生成建议（Q31）。用户在 `/mem review` 里逐条确认，系统绝不自动删除                                                                                                                                                                                                                                                                                                                        |
| ④ 拦截   | 先做三级粗筛，通过后才同步问 Jev。同一份证据下的判定会缓存，重复的同类调用直接复用。Jev 超时或不可用时按两档处理（Q29）：行内写了 `gate=hold` 且确定性证据已命中 ⇒ 照样拦截；其余 ⇒ 放行，并把规则正文以「未判定」注入。进程证据只在 Linux 上采集（Q30）                                                                                                                                                         |
| 可用性   | 用户可见状态：`off`（总开关关、legacy、secure 域、分类器空列表——设置期，零注册）、`off(pi-api)`（运行时才发现 pi 无分类器 API，已注册但空转）、`probing`、`full`、`partial`。`partial` 时只停需要 Jev 的功能，零调用部分继续，并用 `x/y tagged` 标出标签覆盖率；从未打过标签时显示为 `inactive`。转入 `full` 时通知一次（主会话裁定），转入 `partial` 时通知一次。可用与否以真实调用的结果为准：有凭证不等于可用 |
| 外发     | 一律先截断再脱敏。文件正文、成功的工具结果、system prompt、助手消息与推理永不外发（§7）                                                                                                                                                                                                                                                                                                                          |
| I9       | 设置期 off 的四条路径——`memory.jev.enabled=false`、legacy layout/tool 面、secure/locked 域、`classifiers` 空列表（Q34）——一律零注册。J0 在未改动的 dev 上录制 `jev-off-golden.json`（A′ 级）。`off(pi-api)` 只能在运行时判定，属于「注册但钩子空转」，不在 I9 的 settings-off 字面承诺内，由 off-harness 第 5 个重放配置证明（§5.3、§9.2）                                                                       |
| 规模     | 10 个包（J0–J9，数量不变，范围缩小），新增一个子目录 `src/memory/jev/`。B 级 golden 只刷新 `activate-trace.json`；tiered、legacy、doctor 三份 golden 预期逐字节不变（§4.5）                                                                                                                                                                                                                                      |
| 拍板     | v1 的 D1–D7 已全部拍板（§14.1）；v2 的 N1 经 Q33 拍板为「适用」（§14.1）；Q34/Q35 见 §14.3。当前无待拍板项                                                                                                                                                                                                                                                                                                       |

## 1. 背景、目标与非目标

### 1.1 要解决的问题

- **召回失灵**（`hygiene-flow.md` 起因一节）：专题记忆在十几次派单中一次都没被召回。
  - 静态块按字母序贪心地填索引，13 个文件里只有 2 个拿到完整行（`src/memory/tiered.ts:716-717`）。
  - `read_when` 是写给模型看的自然语言，模型不会自己去匹配。
- **过时与冲突无人发现**：已经解禁的「GPT 临时禁用」、已经作废的 droid 裁定，都在文件里留了 8 天。
- **写入质量靠自觉**：append 不刷新 `updated`（`src/memory/tool-v2.ts:610`）；agent 写入时也不检查同主题的旧条目。
- **v4.1 的教训**：手写触发词（`kw=`/`cmd=`/`if-*`）要求 agent 维护一套规则语言，噪音和漏判都得靠人去调。Jev 实测（`jev-current-state.md` §10）显示，把全部候选一次问完，延迟几乎不变（0.8–1.1 秒），成本也极低（200 个问题 $0.0006）。所以判断交给 Jev，规则只保留为零调用的快速通道。

### 1.2 目标

1. Jev 承担四项职责（Q20）：
   - ① 召回与注入的主判定；
   - ② 写入时自动分类打标；
   - ③ 整理建议；
   - ④ 高危动作的拦截判定。
2. **需要 Jev 的功能**以 Jev 为硬依赖（Q21，经 Q26 细化）：Jev 不可用时这些功能停下，零调用部分继续使用已有数据，用户能看清当前处于哪种状态（§5.3）。
3. 外发前截断加脱敏（Q23）；分类器用有序列表，逐个故障转移，错误分级，代理可选（Q17/Q18）。
4. 遵守 I1、I4、I5、I8、I9、I11，不引入运行时依赖。

### 1.3 非目标

- 不让 Jev 生成任何文字（它做不到，见 `jev-current-state.md` §10）。合并草稿、改写交给 agent 或现有的 `/mem tidy`。
- 不自动删除、不静默隐藏记忆（Q1，以及 `hygiene-flow.md` 的「不做」）。
- 不改 tidy/restore 的事务层。
- 不为外部 droid run 做主动注入（O8）。
- 不改静态块的排序和目录样式（§5.6）。
- 不做按轮数或定时触发的注入。
- 不做 v4.1 规划的 D/F/G 三类触发。
- **v2 推迟或删除的项（Q32）**：
  - 超过 360 条候选时的两段式召回：推迟，超出部分先在本地预筛；
  - 由 Jev 判定门禁模式：删除，hold 只认行内 `gate=hold`；
  - agent 新增标签（工具 `tag_add`）：推迟到二期。

### 1.4 与现有 memory 的关系

| 部件                                                                                          | 处置                   | 说明                                                                                                                     |
| --------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 目录布局、文件名规则、frontmatter 字段（`src/memory/paths.ts`、`meta.ts:13-20`）              | **保留**               | 不增加 frontmatter 键                                                                                                    |
| 分层静态块：hub section `pi_project_memory`（`src/memory/index.ts:116-135`、`inject.ts:286`） | **保留**               | 仅当 jev 开启、且文件里有行内注释时，渲染前剥掉注释。fixture 中没有注释，所以输出不变                                    |
| v2 工具 `memory`（`tool-v2.ts`）                                                              | **保留 + 扩展**        | 新增：写后打标与回显、append 刷新 `updated`、用户令守卫。jev 开启时只换描述变体，**schema 不变**（Q32 推迟了 `tag_add`） |
| legacy layout / legacy 工具                                                                   | **保留，强制不接 Jev** | 作为字节兼容的退路                                                                                                       |
| `/mem` 命令族（`command.ts:154-241`）                                                         | **保留 + 新子命令**    | 新增 `jev`、`tags`、`review`、`expired`；jev 开启时，默认 list 多一行状态                                                |
| doctor D01–D14                                                                                | **保留 + 新码**        | D17 到期、D18 行内注释语法错、D19 core 用量 ≥80%（已有 D02/D03 时不报）                                                  |
| 启动提醒（`doctor-command.ts:231`）                                                           | **保留 + 扩集合**      | 加入到期条目、core 用量、待审建议、Jev 状态                                                                              |
| tidy / batch tidy / restore                                                                   | **保留不动**           | 唯一改动：语料里出现 `<!-- mem` 时，tidy prompt 加一条「原样保留行内注释」                                               |
| v4.1 的条目级触发语法 `kw/tool/arg/cmd/path/on/out/exit/if-*`                                 | **删除（从未实现）**   | 由 Jev 标签与现场判定取代（Q24）                                                                                         |
| v4.1 退回对话模型的判断链                                                                     | **删除（从未实现）**   | 依据 Q21                                                                                                                 |

## 2. 现状摘要（与本设计相关的坐标）

- **装配**：
  - `src/index.ts:204-208` 先建 prompt hub，`:219-221` 在 pre-guard 阶段调用 `wireMemory`（子会话同样会注册）。
  - 子会话在同一进程内由 `createAgentSession` 创建（`src/runtime/session-driver.ts:1`）；它的模型运行时是新建的（同文件 `:628-640` 的注释）。
- **wireMemory 内部**：
  - `wireMemory`（`src/memory/index.ts:71`）的可变状态全部放在闭包里（`:72-82`）。
  - 写后统一走 `onAfterWrite`（`:87-99`）。
  - section 的 `onRender` 回调（`:123`；类型 `inject.ts:63`，调用点 `inject.ts:276`）是得知「哪些 core 内容已在静态块里」的唯一途径。
- **文件与锁**：
  - 文件枚举只看 `*.md`（`src/memory/safe-fs.ts:202`），新建的 `.jev/` 子目录不会被渲染、doctor 或 tidy 当成记忆文件。`.backup`、`.trash`、`archive/` 是现成先例（`safe-fs.ts:834-880`）。
  - 私有目录（0700）的创建在 `safe-fs.ts:120`。
  - 目录锁的回调必须是同步函数（`lock.ts:58` 一带）。
- **密钥识别**：
  - `src/memory/doctor.ts:129` 的 `SECRET_PATTERNS`，与 `:217-238` 的 `findSecrets`（未导出）；
  - `src/core/redact.ts:6` 的 `redactSecrets`（pi-free）；
  - `src/web-hub/agent/redact.ts:77`，web 投影用的更强版本。
- **secure 域**：`getSecureDomain()`（`src/secure/domain.ts:718`）；D8 强制关闭的唯一出口是 `applySecureDomainOverrides`（`src/config/settings.ts:417-433`，由 `:407` 调用）。
- **边界测试**：
  - `tests/boundary/pi-free.test.ts:165-174` 只钉了 `paths|frontmatter|store|render` 四个文件。
  - `tests/web-hub/boundary.test.ts:197` 规定 `src/memory/settings.ts` 只能 import `./tidy/batch-settings.js`，这份白名单只许收紧。所以新设置的解析必须内联在 `settings.ts` 里。
- **工具函数**：`clampSpanMs`（`src/core/deadline.ts:318`）、`createSegmentedClock`（`src/core/clock.ts:59`）、后台任务完成通知 `bash-job:notification`（`src/bash/notify.ts:8`）。
- **pi 1.4.0**：
  - `getAvailableOfType`/`getModelOfType`/`classify`：`model-registry.d.ts:44,45,47`；`classify` 的注释写明 "Never rejects"。
  - `ClassifierOptions` 带 `fetch?` 参数：`pi-ai/dist/types.d.ts:48-58,217`。
  - 分类器的问题与答案类型：`pi-ai/dist/types.d.ts:454-510`，用法文档 `docs/codemode.md:97-136`。
  - 扩展上下文里有 `modelRegistry`（`extensions/types.d.ts:225`），UI 有 `setEditorText`（`:135`）。
  - `before_agent_start` 的 handler 逐个 await，有 try/catch，返回的 `message` 会被收集（`runner.js:1121-1150`）。
  - `tool_call` 的 handler 逐个 await，遇到 block 立即返回，**没有 try/catch**（`runner.js:957-970`）。
  - 同一条 assistant 消息里的多个工具调用可能并行执行（`docs/extensions.md:236`）；嵌套的 `ctx.executeTool` 同样会经过 `tool_call`（`:261`）。
  - 工具内部调用模型时，应把 usage 放进工具结果（`:249`）。
  - 文档建议 gate handler 在拿不准时 fail closed（`:214`），本设计的分档处理见 §6.4.5。
  - `openrouter` 的模型目录里列有 `typesafe/jev-1.13` 和 `typesafe/jev-1.14`（`docs/models.md:149`），但两者都未经本仓实测。

## 3. 总体设计

### 3.1 模块划分（新增 `src/memory/jev/`；表中「无」= 该模块不 import pi，满足 I8）

| 模块                             | import pi | 职责                                                                                              | 为什么必须存在                                                                         |
| -------------------------------- | --------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `jev/contracts.ts`               | 无        | 全部类型、常量、消息 details 形状；分类器类型的本地镜像                                           | 冻结包与包之间的接口；镜像 pi 的类型，这样 jev 目录下不必 import pi                    |
| `jev/entries.ts`                 | 无        | 切分条目；计算两种哈希；解析与剥离行内注释；判定归属；判定是否含密钥；按目录指纹缓存条目索引      | 四项职责共用「条目」这个单位；现有 `splitSections`（`meta.ts:174`）只能切到 `## ` 粒度 |
| `jev/taxonomy.ts`                | 无        | 预置类型、重要度、标签；合并项目扩展；校验；生成 criteria                                         | Q24                                                                                    |
| `jev/index-store.ts`             | 无\*      | 读写 `.jev/index.json` 与 `.jev/taxonomy.json`                                                    | 派生标签要落盘；\*只依赖 safe-fs 与 lock                                               |
| `jev/redact.ts`                  | 无        | 截断与脱敏流水线                                                                                  | Q23                                                                                    |
| `jev/shell-parse.ts`             | 无        | 把 bash 命令解析成 argv（照搬 v4.1 §2.7.1）                                                       | 粗筛和匹配器要能区分 `git -C x push`（真推送）和 `echo "git push"`（只是打印）         |
| `jev/match.ts`                   | 无        | 标签匹配器、词面预筛、从规则正文提取点名的程序                                                    | 快速通道、粗筛、证据过滤、裁剪超量候选                                                 |
| `jev/questions.ts`               | 无        | 构造 recall/error/tag/tag-major/review/gate 六类问题，并按 token 分批                             | 问题模板集中在一处，便于评测                                                           |
| `jev/decide.ts`                  | 无        | 阈值、top-k、字节预算、门禁判定、证据档、判定缓存、整理建议                                       | 纯函数，可以表驱动测试                                                                 |
| `jev/health.ts`                  | 无        | 错误分级、逐模型隔离、汇总状态机、标签覆盖率                                                      | Q17/Q21/Q26                                                                            |
| `jev/proxy-fetch.ts`             | 无        | 只走 HTTP 代理的一次性 fetch                                                                      | Q18，零依赖                                                                            |
| `jev/client.ts`                  | 无        | `JevClient`：故障转移、预算、分批、记账、令牌桶                                                   | 全仓只有这里调用 `classify()`                                                          |
| `jev/guard.ts`                   | 无        | 检测用户令是否被改动（照搬 v4.1 §3.2）                                                            | Q4                                                                                     |
| `jev/format.ts`                  | 无        | 消息、拦截文案、回显文本、`/mem jev` 的输出                                                       | 文案集中，便于金样本                                                                   |
| `jev/review.ts`                  | 无        | 组装候选对、生成建议、计算 dismissed 锚                                                           | ③                                                                                      |
| `jev/probes.ts`                  | 无        | 门禁证据：bash 任务、`/proc`（仅 Linux）、git HEAD、暂存文件                                      | ④                                                                                      |
| `jev/wire.ts`                    | 是        | 注册钩子、渲染器、`/mem` 子命令；可变状态全在闭包里                                               | I2/I4                                                                                  |
| `jev/segment.ts`                 | 是        | 段内去重记录、回扫播种、门禁闩锁（照搬 v4.1 §2.1/§2.2）                                           | 同一段上下文只注入一次                                                                 |
| `jev/config.ts`（v2.1）          | 无        | `resolveJevWiring(memory, domainKind)`：设置期接线判定（disabled/legacy/secure/empty-list ⇒ off） | 让「零注册」判定可单测，并供 off-harness 重放                                          |
| `jev/tagging.ts`（v2.1）         | 无        | 单条打标与批量打标（条目为主 / 标签为主）                                                         | 写入路径与后台迁移共用                                                                 |
| `jev/command-port.ts`（v2.1）    | 无        | `/mem jev`、`/mem tags` 的命令端口实现                                                            | `command.ts` 只通过端口调用 jev                                                        |
| `jev/write-port.ts`（v2.1）      | 无        | `JevWritePort`：识别变化条目、打标、回显、守卫                                                    | `tool-v2.ts` 只通过端口调用 jev                                                        |
| `jev/review-command.ts`（v2.1）  | 无        | `/mem review` 的交互流程（UI 结构化端口）                                                         | ③ 的用户确认环节                                                                       |
| `jev/expired-command.ts`（v2.1） | 无        | `/mem expired` 的交互流程                                                                         | Q1                                                                                     |
| `jev/entry-edit.ts`（v2.1）      | 无        | 锁内 CAS 删除条目（先复制进 `.trash`）、写入行内注释                                              | review/expired 共用的确定性写原语                                                      |

模块清单以 `jev-plan.md` 为准（v2.1 勘误）；`expiredEntries(entries, today)` 纯函数放在 J1 的 `entries.ts`，供 J6（启动提醒）与 J8（D17、`/mem expired`）共同使用。

需要改动的现有文件：

- `src/memory/index.ts`：调用 `wireJev`，传入端口。
- `tool-v2.ts`：写入端口。
- `tool-surface.ts`：描述变体，只改描述。
- `settings.ts`、`setting-specs.ts`。
- `doctor.ts`：新增 D17–D19；`SECRET_PATTERNS` 移到 `src/memory/secret-patterns.ts` 后两边共用，纯搬家。
- `doctor-command.ts`、`command.ts`。
- `inject.ts`：`onRender` 增加 `omittedSections` 参数，并负责剥离行内注释。
- `tidy/prompt.ts`。
- `src/index.ts`：传入 secure 判定和 bashJobs 端口，属于装配。
- `src/config/settings.ts:417`：D8 清单增加 `memory.jev.enabled`。
- `src/web-hub/agent/command-policy.ts`：`mem()` 的 web 策略追加 jev/tags/review 行（§9.4；`command-usage.ts` 不改）。
- `tidy/command.ts`、`tidy/batch-command.ts`：只透传「保留行内注释」布尔。
- `contracts.ts`：`DoctorId` 追加 D17–D19。

### 3.2 结构图（依赖自上而下；标 ✅ 的是不 import pi 的模块）

```text
src/index.ts (assembly)
  └─ wireMemory (src/memory/index.ts)          ← secure 判定、bashJobs 端口作为参数传入
       ├─ memorySection / tiered (unchanged)    ← 静态分层注入
       ├─ createMemoryToolV2 ──(JevWritePort)──┐
       ├─ createMemCommand ───(JevCommandPort)─┤
       └─ wireJev (jev/wire.ts) ◄──────────────┘
            ├─ segment.ts (appendEntry/getBranch)
            ├─ client.ts ✅ ── health.ts ✅ ── proxy-fetch.ts ✅ (node:http/tls/net)
            │      └─ ClassifierRegistryLike  ◄── ctx.modelRegistry (structural)
            ├─ questions.ts ✅ ── taxonomy.ts ✅ ── entries.ts ✅
            ├─ decide.ts ✅  review.ts ✅  guard.ts ✅  format.ts ✅
            ├─ match.ts ✅ ── shell-parse.ts ✅
            ├─ probes.ts ✅ ── src/git/run.ts ✅
            ├─ redact.ts ✅ ── secret-patterns.ts ✅, src/core/redact.ts ✅
            └─ index-store.ts ✅ ── safe-fs.ts / lock.ts
```

依赖规则：

- `jev/*` 中除 `wire.ts` 和 `segment.ts` 外，都不 import pi，也不 import `tool-v2.ts`、`inject.ts`、`command.ts`。
- `tool-v2.ts` 和 `command.ts` 只通过注入的端口调用 jev。
- J1 负责把这些文件加入 `tests/boundary/pi-free.test.ts` 的根集合。

### 3.3 功能分类：需要 Jev 与零调用（Q26）

| 功能                                                                   | 类别     | 依赖的数据                                 | Jev 不可用（`partial`）时                                                                |
| ---------------------------------------------------------------------- | -------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| U 用户消息召回（§6.1.1）                                               | 需要 Jev | 现场判定                                   | 停                                                                                       |
| E 失败结果召回（§6.1.4）                                               | 需要 Jev | 现场判定                                   | 停                                                                                       |
| 写后打标、待打标补打、批量打标（§6.2）                                 | 需要 Jev | 现场判定                                   | 停。新条目记为 pending，恢复后补打                                                       |
| 整理运行（§6.3 `--run` 及周期整理）                                    | 需要 Jev | 现场判定                                   | 停                                                                                       |
| 门禁的 Jev 判定档（§6.4.4）                                            | 需要 Jev | 现场判定                                   | 停，改走证据档                                                                           |
| A 动作快速通道（§6.1.3）                                               | 零调用   | 侧车标签、行内 `tags=`、标签匹配器         | **继续**                                                                                 |
| B 压缩后重注（§6.1.5）                                                 | 零调用   | 段记录                                     | **继续**                                                                                 |
| 门禁的证据档：`gate=hold` 证据拦截，其余放行并注入「未判定」（§6.4.5） | 零调用   | 行内 `gate*`、侧车 guard、标签、确定性证据 | **继续**                                                                                 |
| 查看并执行已存在的整理建议（`/mem review`）                            | 零调用   | 侧车里的建议                               | **继续**。条目已变的建议标为过期并跳过                                                   |
| 用户令守卫、append 刷新 `updated`、D17–D19、`/mem expired`             | 确定性   | 文件本身                                   | 与 Jev 是否可用无关；只受总开关与接线判定控制（`classifiers` 空列表视同总开关关闭，Q34） |

## 4. 数据模型

### 4.1 条目（Entry）

对文件正文逐行扫描。frontmatter 和 drift banner 先去掉，复用 `frontmatter.ts:37,88`。围栏代码块里的行不参与判定。

1. `# ` 一级标题：只作为文件标题，不算条目。
2. `## `/`### ` 标题：开启新的上下文段。`heading` 取最近的 `## `，有 `### ` 时拼成 `A › B`。
3. 第 0 列的列表项（`- `、`* `、`+ `、`N. `）开启一个新条目。以下内容都算它的续行，直到遇到下一个第 0 列列表项、标题，或未缩进的普通段落为止：
   - 后续缩进 ≥2 空格的行；
   - 列表内的空行；
   - 属于它的围栏块；
   - 缩进的表格、引用块。
4. 一个 `## ` 段里如果**没有**第 0 列列表项，整段正文就是一个条目。
5. 列表之外的块级结构（v2 补全，评审 #13）：
   - 未缩进的 GFM 表格：以 `|` 开头的连续行，整表成为**一个**条目；
   - 未缩进的引用块：以 `>` 开头的连续行，整块成为一个条目；
   - HTML 块：从 `<tag` 开头的行到下一个空行，整块成为一个条目；
   - 普通段落：≥40 码点的段落单独成为一个条目，更短的并入下一个条目作为上下文。

   以上行为写进 `contracts.ts` 的注释，并由 `entries.test.ts` 的表格、引用块、HTML 块用例钉住。

```ts
export type EntryHash = string; // sha1(normalizeBody(body)).slice(0,12)

export interface MemEntry {
  readonly file: string;
  readonly heading?: string;
  readonly section: string; // 所在 `## ` 小节标题；文件开头没有标题的区域记为 ""，用于静态 core 判定（§6.1.1）
  readonly ordinal: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly raw: string; // 含行内注释
  readonly body: string; // 剥掉行内注释
  readonly hash: EntryHash; // 侧车键：只哈希 body，所以改行内注释不会丢标签
  readonly guardHash: string; // sha1(raw)：Q4 配对用，改 user 标记也算改动
  readonly inline: InlineMeta;
  readonly inlineErrors: readonly string[]; // → D18
  readonly authority: "user" | "agent"; // §4.2
  readonly fileStatus: "active" | "stale"; // archived 文件不产出条目
  readonly secret: boolean; // body 命中 SECRET_PATTERNS 或宽松键值规则（评审 #6）
  readonly namedPrograms: readonly string[]; // 正文点名的程序（§6.4.2），提取规则在 match.ts
}
```

- **条目索引缓存**（评审 #6）：
  - `entries.ts` 按 cwd 缓存 `MemEntry[]`，键是目录指纹，即每个文件的 name + size + mtime。
  - `onAfterWrite` 和指纹变化都会让缓存失效。失效时只重切发生变化的文件，`secret` 和 `namedPrograms` 随之重算。
  - 每条用户消息到来时只读缓存，不重扫语料。缓存只放在内存里，不写进侧车：本地扫描很便宜，不必持久化。
- **规范化**：去掉行尾空白，统一换行符为 `\n`，合并连续空行。
  - 正文改动一个字就会产生新哈希，旧标签随之失效，直到重新打标（§4.4）。
- **显示锚点**：`file › heading #ordinal` 或 `file L<lineStart>`。锚点只用于显示，从不作键。
- **外发与注入的截断**：外发摘录取前 400 码点。注入时单条超过 1500B 就截断，并附上 `（完整：memory view …）`。

### 4.2 行内权威元数据（用户或 agent 手写；Jev 从不写）

一条 HTML 注释，写在条目首行的行尾；整段条目则写在标题下的第一个非空行。长度 ≤200B。

```md
- 发版前确认 GitHub CI 绿 <!-- mem user gate -->
- GPT 系模型临时禁用 <!-- mem user expires=2026-10-21 -->

## 发版进行中禁止动 git 状态

<!-- mem user gate=hold tags=+release,+git-commit -->

- release.sh 运行期间（含后台任务、其它终端）禁止 commit/tag/切分支……
```

| 键                              | 含义                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user` / `lesson`               | 覆盖默认归属。`user` = 用户令，只有用户能作废（Q4）                                                                                                                     |
| `expires=YYYY-MM-DD`            | 到期后进入 D17 和 `/mem expired`，只提示，用户确认后才删（Q1）                                                                                                          |
| `until="事件"`                  | 事件型失效条件，只列为待确认，不进启动提示（O7）                                                                                                                        |
| `gate` / `gate=hold` / `nogate` | `gate`：强制成为守护条目，拦一次。`gate=hold`：条件成立期间持续拦截（Q15），**hold 只能由这里声明**（Q32，Jev 不判定门禁模式）。`nogate`：永不拦截，即使 Jev 判它为高危 |
| `tags=+a,-b`                    | 手工增删标签，优先级高于 Jev 的判定；Jev 不可用时同样生效                                                                                                               |
| `private`                       | 永不发给 Jev（不打标、不参与召回、整理、门禁判定），只出现在静态块里                                                                                                    |

- **默认归属**（Q4/O5）：
  - 手写文件（没有 `source: agent`）里的条目默认为 `user`；
  - agent 文件里的条目默认为 `agent`；
  - 行内写了 `user`/`lesson` 时以行内为准。
  - Jev 不决定归属，只给出一个 `userLike` 概率作为提示。
- **解析与拒写**：解析器永不抛错，问题记进 `inlineErrors`，由 doctor 以 D18 报告。如果某次写入新引入了解析错误，就拒绝这次写入。
- **渲染**：jev 开启时，静态块里内联的 core 正文剥掉行内注释；jev 关闭时注释按普通文本保留（I9）。`grep -r "<!-- mem" tests/fixtures` 为空，所以现有 fixture 不受影响。

### 4.3 标签体系

#### 4.3.1 结构

```ts
export type EntryType = "rule" | "pitfall" | "procedure" | "preference" | "fact" | "pointer";
export type Importance = 0 | 1 | 2 | 3; // background | useful | important | critical

export interface TagDef {
  readonly id: string; // ^[a-z][a-z0-9-]{1,31}$
  readonly label: string; // ≤40B
  readonly description: string; // ≤240B，原样作为 criteria.true
  readonly risk: "normal" | "high";
  readonly match?: {
    readonly tools?: readonly string[];
    readonly commands?: readonly string[]; // argv 前缀模式（复用 v4.1 cmd= 词法）
    readonly paths?: readonly string[]; // glob，相对仓库根
  };
  readonly source: "preset" | "user"; // "agent" 保留给二期（Q32）
  readonly rev: number; // 改 description 时 +1；只改 match 不 +1（匹配器不参与 Jev 提问）
}

export interface Taxonomy {
  readonly rev: string; // sha1(全部启用 TagDef 的 description 与 rev).slice(0,8)
  readonly types: readonly { id: EntryType; description: string }[];
  readonly importance: readonly string[];
  readonly tags: readonly TagDef[]; // 只含启用的，按 id 排序
}
```

- **类型与重要度**：固定在代码里，不可扩展，否则历史标签之间失去可比性。
- **项目标签**：写在 `<slug>/.jev/taxonomy.json`，格式 `{v:1, tags:TagDef[], disabledPresets:string[]}`。
  - 预置标签不能删除，可以停用。
  - 启用的标签合计不超过 64 个。
- **新增与修改**：用户执行 `/mem tags add <id> --label … --desc "…" [--risk high] [--commands …] [--paths …] [--tools …]`，仅限主会话、有 UI 的环境。
  - 新增标签、或改了某个标签的 description 之后，后台以「标签为主」的方式只补打这一个标签（§6.2.3）。
- **criteria**：每个标签对应一个 bool 问题，形如 `{type:"bool", instructions:"Is this project-memory entry about the scenario below? <label>: <description>", criteria:{true:<description>, false:"Not about <label>"}}`。
- **匹配器不是触发词**：匹配器挂在标签上，数量有限，由系统和用户维护，只用于零调用的快速通道（§6.1.3）和门禁粗筛（§6.4.1）。

#### 4.3.2 预置清单（初稿，J1 定稿）

类型（choice）：

| id           | criteria                                                                      |
| ------------ | ----------------------------------------------------------------------------- |
| `rule`       | A rule, requirement or prohibition the assistant must follow / 必须遵守的规则 |
| `pitfall`    | A known pitfall, failure cause or workaround / 踩过的坑、排障经验             |
| `procedure`  | Steps of a workflow to perform / 操作流程                                     |
| `preference` | The user's personal preference or communication style / 用户偏好              |
| `fact`       | Background fact about the project or environment / 项目或环境事实             |
| `pointer`    | Only points to another document or file / 只是指向别处                        |

重要度（score，从低到高）：`background 背景` · `useful 有用` · `important 重要，违反会返工` · `critical 关键，违反会出事故或违背用户明确要求`。

场景标签（`H` = 高危）：

| id                | risk | 匹配器                                                                                                         | description 要点             |
| ----------------- | ---- | -------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `git-commit`      | H    | commands: `git commit`                                                                                         | 提交、提交前检查、提交范围   |
| `git-push`        | H    | commands: `git push`, `gh pr create`, `gh pr merge`                                                            | 推送远端、开或合 PR          |
| `git-history`     | H    | commands: `git reset`, `git rebase`, `git checkout`, `git switch`, `git merge`, `git cherry-pick`, `git stash` | 改写或切换历史与分支（见注） |
| `release`         | H    | commands: `git tag`, `npm publish`, `npm version`, `gh release`, `*release*.sh`                                | 发版、打 tag、发布包         |
| `deletion`        | H    | commands: `rm`, `git clean`, `find -delete`；tools: memory（delete）                                           | 删除文件或数据               |
| `dispatch`        | H    | tools: `Agent`, `SubagentWorkflow`, `steer_subagent`                                                           | 派子 agent、派单约束         |
| `dependencies`    | H    | commands: `npm install`, `npm i`, `pnpm add`, `yarn add`；paths: `package.json`                                | 增删依赖                     |
| `credentials`     | H    | paths: `**/.env*`, `**/*.pem`, `**/auth.json`                                                                  | 密钥、凭证、登录             |
| `frozen-files`    | H    | paths: `tests/fixtures/**`；commands: `*UPDATE*GOLDEN*`                                                        | 冻结文件、金样本             |
| `model-routing`   | –    | tools: `Agent`, `set_model`                                                                                    | 选哪个模型做什么             |
| `testing`         | –    | commands: `npm test`, `npx vitest`, `vitest`                                                                   | 跑测试、测试抖动             |
| `build`           | –    | commands: `npm run build`, `npm run typecheck`, `tsc`                                                          | 构建、类型检查               |
| `ci`              | –    | commands: `gh run`, `gh workflow`                                                                              | CI                           |
| `network`         | –    | commands: `curl`, `git fetch`, `git pull`, `git clone`, `gh`                                                   | 网络、代理、地区拦截         |
| `config`          | –    | paths: `**/settings*.json`, `**/pi-toolkit.json`                                                               | 设置文件                     |
| `shell-env`       | –    | commands: `timeout`, `bash`, `zsh`                                                                             | shell 环境差异               |
| `background-jobs` | –    | tools: `bash_job`                                                                                              | 后台任务                     |
| `session-context` | –    | tools: `switch_context`, `compact_context`                                                                     | 上下文交接、压缩             |
| `docs`            | –    | paths: `docs/**`, `*.md`                                                                                       | 文档约定                     |
| `communication`   | –    | —                                                                                                              | 与用户沟通                   |
| `workflow`        | –    | —                                                                                                              | 开发流程、闸门、验收         |
| `memory-system`   | –    | tools: `memory`                                                                                                | 记忆维护规则                 |

注（评审 #11）：`git checkout -b`、`git stash` 是日常操作。它们只会在「存在带 `git-history` 标签的守护条目」时触发 Jev 调用，并且受判定缓存约束（§6.4.4）：同一份证据、同一种命令，在本段内只问一次 Jev。J0 的门禁评测集收录 `git checkout -b` 和 `git stash` 正例，如果噪音不可接受，再把 checkout、switch、stash 拆成一个 normal 风险的 `git-branch` 标签。

### 4.4 侧车索引 `<slug>/.jev/index.json`（派生数据，可丢弃）

```ts
export interface JevIndexV1 {
  readonly v: 1;
  readonly entries: Record<EntryHash, EntryTags>;
  readonly lastTaggedAt?: string; // 最近一次成功打标的时间，供 partial 状态显示
  readonly review?: ReviewState;
}
export interface EntryTags {
  readonly file: string;
  readonly type: EntryType;
  readonly typeP: number;
  readonly importance: Importance;
  readonly tags: Record<string, { p: number; rev: number }>; // 只存 p ≥ 0.3
  readonly guard: number;
  readonly temporal: "permanent" | "dated" | "event";
  readonly userLike: number;
  readonly model: string;
  readonly at: string;
  readonly taxonomyRev: string;
}
export interface ReviewState {
  readonly lastRunAt: string;
  readonly corpusFp: string;
  readonly suggestions: readonly ReviewSuggestion[]; // 每条带 a/b 的 hash 与锚
  readonly dismissed: readonly DismissedPair[];
}
export interface DismissedPair {
  readonly hashKey: string; // sort(hashA, hashB).join("+")
  readonly anchorKey: string; // sort(anchor(a), anchor(b)).join("+")；anchor = file + "|" + section + "|" + 正文规范化后的前 24 码点
}
```

- **读写**：
  - 读取时容错：坏 JSON 按空索引处理，`/mem jev` 显示 `index rebuilt`。
  - 写入在 `withMemoryDirLock` 内做同步的「读 → 按 hash 合并 → 原子替换」；锁忙时跳过，下次再写。
  - 目录权限 0700，文件 0600。
- **上限**：最多 2000 条，文件 ≤1MB。超出时先清掉当前语料里已不存在的 hash。
- **dismissed 的匹配**（评审 #7）：hashKey 或 anchorKey 任一相同，就视为已忽略。
  - 编辑正文开头 24 码点以外的部分，不会让已忽略的条目对重新出现；改写开头或改名小节会重新提示。这是已知的取舍，在 `/mem review` 的说明里写明。
- **有效元数据** = 行内权威 ⊕ 侧车派生 ⊕ 默认值：
  - `tags` = 侧车中 p≥0.6 的标签 ∪ 行内 `+` − 行内 `-`；
  - `guarded` = 行内写了 `gate`/`gate=hold`，或者同时满足：没有 `nogate`、`guard ≥ 0.7`、`type ∈ {rule, procedure}`；
  - `hold` = 行内写了 `gate=hold`，只有这一个来源。
- **标签的时效**（Q26，零调用部分依赖它）：
  - **键是内容哈希**：正文不变，标签就一直有效，不按时间过期。理由：标签描述的是这段文字本身，同样的文字 Jev 给出的概率一致（`jev-current-state.md` §10 的一致性数据）。
  - **正文改动**会产生新 hash：旧标签不再适用，条目变为 pending。pending 条目只能靠行内 `tags=` 和 `gate*` 被快速通道或门禁看到；`full` 状态下会在写后或下一次后台补打时得到新标签。
  - **标签描述改动**（rev +1）：沿用旧 rev 的概率（描述改动通常只是措辞细化），同时排队补打这个标签。
  - **标签停用或删除**：立即忽略这个标签。
  - **模型换了**：旧标签继续有效，不强制重打；`/mem jev retag --all` 可以手动全部重打。
  - **侧车丢失**：覆盖率归零，`full` 状态下后台重建。
- **覆盖率**：覆盖率 = 已打标的条目 ÷ 非 private 的条目，`/mem` 和 `/mem jev` 以 `x/y tagged` 显示（§5.3）。

### 4.5 迁移、回滚与金样本

- **不改写任何现有文件**。迁移就是建立侧车：第一次进入 `full` 后在后台批量打标（Q28，§6.2.3）。
  - 按现有约 150 条语料估算：22 次「标签为主」的调用加 150 次「条目为主」的小调用，**合计约 172 次**，约 $0.02，并发 4 时约 40–60 秒（评审 #4，已统一口径）。
  - 打完之前：召回照常工作（它现场判定，不依赖标签）；快速通道和门禁只覆盖已经打标的条目，以及行内写了 `gate*` 或 `tags=` 的条目。
- **O10 疑似用户令**：在整理时，把「归属为 agent、但 `userLike ≥ 0.8`」的条目列成建议，用户确认后系统写入行内 `user`。
- **回滚**：设置 `memory.jev.enabled=false` 后 `/reload`，off golden 保证逐字节回到旧行为；`.jev/` 目录可以直接删除；代码层面每个包可以单独 revert。
- **金样本影响**：

| 文件                                                 | 级别 | 预期                                                                                                                                       |
| ---------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/fixtures/memory-legacy-golden.json`           | B    | **不变**（legacy 不接 Jev）                                                                                                                |
| `tests/fixtures/memory/tiered-golden/*.txt`          | B    | **不变**（直接调 `renderTiered`，fixture 中没有行内注释）                                                                                  |
| `tests/fixtures/memory/doctor-golden/current-5.json` | B    | **预期不变**：没有行内注释，所以没有 D17/D18；primary 已触发 D02/D03，所以不报 D19；D02 的文案不改。J8 实测 diff，有任何变化即为 bug       |
| `tests/fixtures/governance/activate-trace.json`      | B    | **变**：jev 新增钩子与渲染器的注册。按声明刷新，commit 写明「memory jev hooks」                                                            |
| `tests/fixtures/memory-tool-surface.json`            | 契约 | **新增**描述变体的 key（schema 不变）                                                                                                      |
| `tests/config/__corpus__/setting-specs-pin.json`     | pin  | 追加 §9.1 的新键                                                                                                                           |
| `tests/config/__corpus__/settings-corpus.json`       | pin  | **变**：逐字节 pin `DEFAULT_SETTINGS` 与 `loadSettings` 输出，新增 `memory.jev` 必然变化。J3 按先例 `4758bae5` 重 pin，commit 写明新增的键 |
| 新增 `tests/fixtures/memory/jev-off-golden.json`     | A′   | J0 在未改动的 dev 上生成，之后永不重生                                                                                                     |
| 其余 A 级                                            | A    | 不变。每个包都跑一次 `git diff --quiet origin/dev -- tests/fixtures/`                                                                      |

## 5. Jev 客户端与可用性

### 5.1 端口与契约

```ts
// 本地镜像 pi-ai/dist/types.d.ts:454-510（只要求结构兼容）
export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } };
export type JevAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number }
  | { type: "bool"; probability: number };

/** ctx.modelRegistry 的结构化子集（model-registry.d.ts:44-47）。缺任一方法 ⇒ off("pi-api") */
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
  readonly registry: ClassifierRegistryLike; // 每次从调用方的 ctx 取，绝不跨 activation 缓存
  readonly state: JsonObject; // 已脱敏、已截断
  readonly questions: Record<string, JevQuestion>;
  readonly budgetMs: number; // 总预算，内部经 clampSpanMs
  readonly mode: "sync" | "background"; // sync 最多 3 批并行；background 最多 4 批，session_shutdown 时 abort
  readonly signal?: AbortSignal;
}

export type JevOutcome =
  | {
      readonly ok: true;
      readonly model: string;
      readonly answers: Record<string, JevAnswer>;
      readonly missing: readonly string[];
      readonly costUsd: number;
      readonly latencyMs: number;
    }
  | {
      readonly ok: false;
      readonly reason: "off" | "unavailable" | "budget" | "timeout" | "aborted" | "all-failed";
      readonly detail: string;
    };

export interface JevClient {
  status(): JevStatus; // 同步、零 IO
  ask(req: JevRequest): Promise<JevOutcome>; // 永不 reject
  probe(registry: ClassifierRegistryLike, signal?: AbortSignal): Promise<JevStatus>; // 强制刷新可用集缓存（评审 #12）
}
```

- **分批**：
  - 每个问题估算 `est(q) = ceil(utf8(instructions + criteria) / 3) + 40` 个 token，再加上 `est(state)`；每批不超过 12,000 token。
  - 各批并行发出，总延迟约等于最慢的那一批。
  - **例外**（J4，`TAG_MAJOR_BATCH_TOKENS = 20_000`，root 已批，§19 行 14）：标签为主的批量打标题（约 150 条 × 22 标签，每标签一次，约 172 次调用）放宽到每批 ≤20,000 token——opencode 上下文约 32k，这个口径偏保守估算、留有余量；真超限时仍按下面「上下文超限」对半拆批兜底。其余题型（条目为主、召回、门禁、整理）仍是 ≤12,000 token。
- **上下文超限**：实测（E0 C-J8，§19 行 16）两个 opencode 分类器一致返回 `System One API error (400): {"detail":{"error_type":"max_tokens_exceeded"}}`；`health.ts` 的 `CONTEXT_RE` 已据此补上关键词 `max_tokens_exceeded`（连同原有的 `context`、`too many tokens`、`maximum context`），命中归为 `context` 类。超限主要由 state 体积（约 340KB 触发）而非问题数量驱动。这类错误不隔离模型，而是把这一批对半拆开，重试一次。
- **漏答**：返回的 `answers` 里缺了某个问题 id，记进 `missing`，调用方按「无信号」处理。

### 5.2 故障转移与错误分级（照搬 v4.1 §2.4.1；变化写在末尾）

- **默认列表**（评审 #8）：`memory.jev.classifiers` 默认为 `opencode/jev-1.13-free,opencode/jev-1.13`，两者都实测过（v4.1 §14）。
  - `openrouter/typesafe/jev-1.13` 和 `openrouter/typesafe/jev-1.14` 虽然列在 `docs/models.md:149`，但未经实测，标注「J0 探测后定稿」。J0 的 conformance 和评测跑通后才考虑加入默认列表。
  - 评审称目录中只有 `jev-1.13`，这一点不准确：`models.md:149` 同时列了 1.14。
- **候选与超时**：
  - 可用集 = 列表 ∩ `getAvailableOfType("classifier")` − 已被隔离的模型；
  - `getAvailableOfType` 的结果缓存 10 分钟，`probe()` 和 `/reload` 会强制刷新；
  - 每一档的超时为 `min(剩余总预算, max(1000, ⌈budget/2⌉))`，命中则转下一档。**这一档超时算该档的一次瞬态失败**（计入它的熔断），不是 `aborted`，也不终止整次 ask；只有调用方自己的 `signal` 被 abort 才返回 `aborted`（§19 行 17，`510a0678`）。
- **从错误文本中取状态码**：
  - 用字面量定位 `errorMessage` 里的 `API error (`，取其后的三位数字；
  - 取不到时，按关键词 `FreeTierError`、`Insufficient`、`unavailable`、`rate limit` 兜底归类；
  - 以 `proxy error:` 开头的错误一律按瞬态处理。
- **错误分级**：
  - **不可用类**：401、402、403、451。出现一次即隔离该模型 1 小时。
  - **瞬态类**：429、5xx（451 除外）、超时、网络错误、代理错误。同一模型连续 3 次后隔离 10 分钟；中间任一次成功即清零计数。
  - **context 类**：拆批重试，不计入熔断。
- **变化**：整个列表都不可用时直接返回 `{ok:false, reason:"all-failed"}`，系统进入 `partial` 状态（§5.3），不再像 v4.1 那样退回对话模型。

### 5.3 可用性状态机（Q26 改写）

**单个模型的状态**存在进程级共享表 `Symbol.for("pi-subagent:memory-jev-health")` 中，最多 32 项。每项的 TTL 就是它的隔离截止时间 `until`，`/reload` 时清空。

```text
unknown ──真实调用成功──► ok ──不可用类──► unavailable(code, until=+1h)
   │                       └─瞬态 ×3────► transient(until=+10m)
   ├─不在 catalog──► not-found
   └─无凭证───────► no-auth
unavailable / transient ──到达 until──► unknown（下一次真实调用即为探测）
```

**会话的汇总状态**放在 wire 闭包里，用户能看到的就是这一层：

| 状态              | 条件                                                                                         | 需要 Jev 的功能  | 零调用部分                             | `/mem` 显示（英文 token）                                                        |
| ----------------- | -------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| `off(reason)`     | **设置期**四条路径：总开关关闭、`secure`（含 locked）、`legacy`、`classifiers` 空列表（Q34） | 不注册           | 不注册                                 | `jev: off (secure domain)` / `jev: off (empty classifier list)`                  |
| `off(pi-api)`     | **运行时**才判出：`ctx.modelRegistry` 缺 `classify`/`getAvailableOfType`                     | 已注册但**空转** | 已注册但**空转**（不产生注入、不拦截） | `jev: off (pi-api)`                                                              |
| `probing`         | 可用集非空，但本进程还没有一次成功的调用                                                     | 允许尝试         | 运行                                   | `jev: probing · 142/150 tagged`                                                  |
| `full(active)`    | 至少成功调用过一次，且当前有未被隔离的模型                                                   | 运行             | 运行                                   | `jev: full · opencode/jev-1.13 · 142/150 tagged · 37 calls $0.006`               |
| `partial(reason)` | 可用集为空（无凭证、不在 catalog、全部被隔离），或本 activation 的预算已用完                 | **停**           | **运行**                               | `jev: partial (451) · fast path 142/150 tagged (10-29) · retry 12:05 · /mem jev` |

- **`off(pi-api)` 与 I9**：`pi-api` 只能在 `ctx` 上判出，此时注册已经发生，所以它**不在 I9「settings off ⇒ byte-identical」的字面承诺内**。设置期的四条 off 路径（disabled、legacy、secure、empty-list）仍零注册，由 off golden 证明。`off(pi-api)` 的证明方式：off-harness 增加**第 5 个重放配置**「设置开 + 无 modelRegistry」，断言方式为**逐字段比对 + 允许差异清单 `PI_API_ALLOWED_DIFF`**（见 jev-plan.md J0 第 4 条）：`render`、`doctor`、`tidyPrompt` 与 `disabled` 逐字节相等；`registrations` 只允许多出清单声明的 jev 注册名与 `memory` 工具描述变体；`command` 只允许 `/mem` 状态行 `jev: off (pi-api)` 与补全差异；`tool`、`reminder` 只允许确定性部件的声明差异（append 刷新 `updated`、回显 `jev: not tagged (off: pi-api)`、启动提醒追加行）。清单之外的任何差异即失败；清单只许追加。这些允许的差异（工具描述变体、确定性部件、`/mem` 状态行）属于与 `inactive` 同类的有意偏差（§9.2）。
- **`inactive`**：`partial` 的一种显示形态，条件是覆盖率为 0、且没有任何行内 `gate*`/`tags=`。典型情形是从未配过分类器的用户，此时显示 `jev: inactive (no classifier credentials)`。
  - 零调用部分照常注册，但没有可用的数据，所以行为与今天一致（§9.2）。
  - 这样区分是为了不让没配过分类器的用户误以为「部分坏了」。
- **对评审「双状态心智负担」的回应**（评审对 D3 的担忧），用三个手段把「Jev 停了，但它打的标签还在用」讲清楚：
  1. **状态名**直接说明是「部分」：`partial`，后面紧跟 `fast path x/y tagged (最近打标日期)`。
  2. **`/mem jev` 按功能分两栏**，列出哪些停了、哪些在跑（§9.4 示例）。
  3. **注入标记**：`partial` 期间，零调用部分注入的消息在标记末尾加 `·partial`，例如 `── mem A·partial: pitfalls-git › #3 ──`，用户在当下就能看出这条来自缓存的标签，而不是现场判定。
- **探测**：
  - 主会话 `session_start` 后在后台调用一次：`state {probe:"ok"}`，一个 bool 问题，约 $0.00003；
  - 子会话直接读共享表，表为空时，第一次真实需要就充当探测；
  - 每一次真实调用都回写健康表。
- **恢复**：
  - 主会话在最早的 `until` 时刻安排一次一次性探测（`createSegmentedClock`，计时器 `unref`）；
  - 用户可执行 `/mem jev probe`，它会强制刷新可用集缓存（评审 #12）；
  - `/reload` 清空隔离表。
- **通知**：只在主会话、有 UI 时用 `ctx.ui.notify`。

| 时机                                              | 文案                                                                                                                                                      | 频率                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 首次转入 `full`（主会话裁定，评审 #2）            | `jev on · opencode/jev-1.13 — 记忆召回、打标、整理、高危拦截已启用；你的消息与记忆摘录会脱敏后发给该分类器。/mem jev 查看，memory.jev.enabled=false 关闭` | 每个 activation 一次                                                  |
| `full → partial`                                  | `jev partial (451) — 现场判断已停；动作快速通道与压缩后重注继续使用已有标签（142/150）。/mem jev`                                                         | 同一原因一次                                                          |
| `partial → full`                                  | `jev recovered · opencode/jev-1.13`                                                                                                                       | 每次                                                                  |
| 启动时直接进入 `partial`，且有凭证（如 451、402） | 同 `full → partial`，附上排障提示（451 多为地区拦截，可设置 `memory.jev.proxy`）                                                                          | 一次。全部模型都是 `no-auth`/`not-found`（即 `inactive`）时**不通知** |

- **零等待**：`status()` 为 `partial` 时，需要 Jev 的功能直接跳过，不发起注定失败的调用；只有已到 `until` 而回到 `unknown` 的模型会被实际调用。

### 5.4 专用代理（Q18，照搬 v4.1 §2.4.1）

- 键名为 `memory.jev.proxy`，默认 `""`，改后需 `/reload` 才生效。
- 非空时，调用 `classify` 会额外传入一个只走该代理的 `fetch`（`pi-ai/dist/types.d.ts:58`）。opencode 适配器已实测会使用传入的 fetch（v4.1 §14）；其它适配器需 P0 验证。为空时不传 `fetch`。
- 实现约束：
  - 只用 `node:http`、`node:tls`、`node:net`；
  - 代理只接受 `http://` 形式，目标只接受 `https:`；
  - 每次一个请求、一个响应，支持 Content-Length 和 chunked 两种响应体；响应体上限 1MB；
  - abort 时立即销毁 socket；
  - 硬超时覆盖整个请求过程，计时器 `unref`，时长经 `clampSpanMs`；
  - 日志里凭证脱敏；URL 无效时视为未配置，并给出提示。
- secure 域不接线。

### 5.5 预算与限流

| 维度                        | 值                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 每 activation 的美元上限    | `memory.jev.maxCostUsd` = 0.5（从 `usage.cost.total` 累计）。用完后进入 `partial(budget)`                                                                                                       |
| 每 activation 的调用上限    | `memory.jev.maxCalls` = 800。批量打标约 172 次，计入上限，余量足够                                                                                                                              |
| 子会话令牌桶                | 进程级 30 次/60 秒，`Symbol.for("pi-subagent:memory-jev-bucket")`                                                                                                                               |
| 在飞上限                    | 召回：每会话 1 个，新 prompt 会 abort 旧的。门禁：按条目 hash 串行。后台任务：并发 4                                                                                                            |
| 时限                        | 召回同步等待 1500ms（Q25；Q37 起默认 2000ms，键 `waitS`），召回总预算 4000ms；门禁 2500ms；打标 3000ms；E 层 4000ms；后台批任务合计 120s。全部经 `clampSpanMs`，外层再套 `withDeadline(+500ms)` |
| 门禁判定缓存（评审 #5/#11） | 每会话最多 64 项，本段内有效，最长 10 分钟（§6.4.4）                                                                                                                                            |
| 典型花费                    | 用户消息每条约 $0.0005；门禁约 $0.00003 一次；写入约 $0.0002 一次；周整理约 $0.004。一个 100 轮的会话约 $0.05–0.1                                                                               |

### 5.6 取舍：为什么不改静态块

- Jev 可用时，主通道是现场召回，静态块的目录价值不大。
- Jev 不可用时，Q21 要求保留现有的分层注入。
- 改目录会动 tiered 金样本，并让前缀缓存失效一次。

这一项作为后续可选扩展，扩展点是 `TieredRenderOptions`。

## 6. 四项职责的端到端流程

### 6.1 ① 召回与注入

#### 6.1.1 用户消息召回（层 `U`，需要 Jev）

- **钩子**：jev 自己注册的 `before_agent_start`，在 hub 之后注册。它**只返回 `message`**，绝不返回 `systemPrompt`。
- **闸门**（同步、零 IO）：
  1. 状态为 `full` 或 `probing`；
  2. `messageType === "user"`；
  3. 剥掉 skill 展开块后，去掉空白仍 ≥8 个码点，且不是「继续」「好」「ok」这类应答短句；
  4. 候选集非空。
- **候选组装**：
  - 排除以下条目：
    - `private` 条目；
    - `secret` 为真的条目（判定已在条目索引里缓存，评审 #6）；
    - 本段已注入的条目；
    - archived 文件里的条目；
    - 静态 core 条目。判定方法（评审 #10）：tiered 按 `## ` 小节整节决定是否内联，所以 `onRender` 带回被省略的小节集合（`omittedSections`）以及 primary 文件名；primary 文件中所在 `section` 未被省略的条目，就是静态条目。还没渲染过时不排除（退化）。
  - N ≤ 360 时，按 token 估算分批并行；现有语料约 140 个候选，分 1–2 批。
  - N > 360 时（Q32 推迟两段式）：先用本地词面预筛（ASCII 单词、CJK 二元组，与当前消息、上一条消息比对重合度，同分时用户令优先）截到 360 条，`/mem jev` 显示 `recall truncated N→360`。
- **问题**（每个候选一个 bool；`state` 里附带上一条用户消息，评审 #9）：

```json
{
  "state": {
    "user_message": "那发版呢？",
    "previous_user_message": "帮我把 dev 推到 GitHub，顺便跑一下全量测试",
    "session": "main",
    "today": "2026-10-30"
  },
  "questions": {
    "e17": {
      "type": "bool",
      "instructions": "Project memory entry [rule · user rule · critical · tags: release] from core.md: 「发版规则：默认 patch；feat ≥50 才 minor……」. Would reminding the assistant of this entry right now help it handle user_message correctly or avoid a known mistake (previous_user_message is context only)?",
      "criteria": {
        "true": "Yes: it applies to this request — a rule, pitfall or procedure the assistant should follow here",
        "false": "No: unrelated, or only shares surface keywords without affecting how to handle this request"
      }
    }
  }
}
```

`previous_user_message` 取分支上的上一条用户消息（`getBranch()` 回扫；回扫本来就为段播种而做）。它同样截断（600 码点）、脱敏，也同样先剥 skill 块。助手消息依然不外发（§7.2）。

- **决定**：
  - 取 p ≥ 0.6 的条目（E0 实测后由 0.7 调整，见 `docs/dev/memory/eval/jev-baseline.md`），按 p 降序排列；同分时依次比较：用户令优先、重要度高优先、文件名；
  - 最多 3 条、合计 4096B；
  - 到期条目也注入，标题后加注「已到期，待用户确认」（Q1）。
- **落点**（Q25）：
  - 同步等待上限内（Q37 起默认 2 秒）拿到结果：作为本次的 `message` 返回，紧跟在用户消息之后，第一次 LLM 请求就能看到（`runner.js:1141-1144`；落点位置需 P0 验证）；
  - 超时：后台继续等待；结果回来后，如果代际仍是当前这一代，就 `sendMessage(msg, {triggerTurn:false})` 补发；
  - 新 prompt 到来时 abort 旧调用。
- **失败**：不注入，只记一行日志。

#### 6.1.2 子会话的派单召回

子会话的第一个 `before_agent_start` 中，`event.prompt` 就是派单 prompt，走同一套流程（Q9）：

- `state.session` 设为 `"child"`；
- `user_message` 取派单 prompt 的前 2000 码点；
- 不附带上一条消息。

#### 6.1.3 动作快速通道（层 `A`，零调用；Jev 不可用时继续）

- **钩子**：`tool_call`，与门禁共用一个 handler，在门禁判定之后执行。
- **匹配**：
  1. shell-parse 解析出各条简单命令（按 toolCallId 缓存）；
  2. 与所有启用标签的匹配器比对，得到命中的标签；
  3. 候选条目同时满足：
     - 有效标签包含命中的标签。有效标签里，侧车标签只取当前 hash 下的；pending 条目只有行内 `tags=`；
     - `importance ≥ 2`；
     - `type ∈ {rule, pitfall, procedure}`；
     - 本段未注入过、不是静态 core 条目、不是 private。

     只有行内 `tags=` 的 pending 条目没有 `importance`/`type`，视为满足这两条，因为手工标签是用户的明确意图。

  4. 按「标签 p × 重要度」排序（只有手工标签的条目按 p=1、重要度 2 计），最多取 3 条、4KB。
- **落点**：`sendMessage(triggerTurn:false)`，排在本 turn 的工具结果之后（时机需 P0 验证）。`partial` 期间，标记末尾加 `·partial`。
- **标签陈旧时**：见 §4.4「标签的时效」。被改动过、尚未重打的条目不会被快速通道命中，除非写了行内 `tags=`。`/mem jev` 显示 pending 数量。

#### 6.1.4 失败结果召回（层 `E`，需要 Jev）

- **钩子**：`tool_result` 只观察，**永远返回 `undefined`**；外加 `bash-job:notification`，处理时机照搬 v4.1 §2.7.2。**实测补充**（§19 行 21，J7 实测）：流式中经 steer 送进来的 bash-job 通知会触发 `message_start`（带 customType，位于 toolResult 之后、同一 run 内），现有的 `message_start` 钩子已覆盖这条 E 层路径，不需要另开轮询 bashJobs 端口（且该端口按冻结契约也没有 exitCode 和输出可用）。
- **失败判定**：`isError` 为真，或者退出码 ≠ 0。退出码来源依次为：`structuredContent.exit_code`、输出尾部向上找到的第一个 `Command exited with code ` 前缀行、通知里的 `details.exitCode`。
- **限流**：同一个错误签名本段只问一次；每段最多问 10 次。
- **候选**：
  - 范围：`type ∈ {pitfall, procedure}`，或者带有与本次调用相同的命中标签；**还包含尚未打标的 pending 条目**（§19 行 20，评审 r2 裁定）——否则尚未打标的语料永远不会有 E 层召回；
  - 排除：本段已注入、private、secret；
  - 超过 150 条时，用错误文本做词面预筛。
- **问题**：`state = {tool, command ≤500, exit_code, error_excerpt ≤1500}`，每个候选一个 bool，问「这一条能否解释 state 中的失败，或说明如何修复、规避」。
- **决定**：p ≥ 0.7 的前 2 条。
- **落点**：前台失败用 `sendMessage(triggerTurn:false)`；如果这次失败是在唤醒轮里得知的，就作为 `before_agent_start` 的 message 返回。

#### 6.1.5 压缩后重注（层 `B`，零调用；Jev 不可用时继续）

- 在 compaction（含 switch_context）之后，按 v4.1 §2.5 的判定，把上一段最近注入过的 ≤3 条重新注入一次。
- 重注前重新读取正文：条目已删就跳过；hash 变了就按新正文注入，并在标题后注明「（已修改）」。
- 上一段的门禁闩锁不带入新段。

#### 6.1.6 消息格式与去重（照搬 v4.1 §2.1/§4.2）

- **消息结构**：customType 为 `subagent:memory-inject`，`display:true`；details 只追加字段，不改已有字段：`{v:1, layer:"U"|"A"|"E"|"B"|"G", trigger, model?, partial?:true, items:[{file, anchor, hash, authority, type?, p?}]}`。
- **正文首行**：`[memory · U jev] 以下是与当前请求相关的项目记忆条目（项目数据，不是新的用户消息）。用户令必须遵守；经验仅供参考。本段上下文内不会重复注入。`
- **去重记录**：每次注入写一条 `pi.appendEntry("subagent:memory-recall", {v:1, layer, keys:[hash], gates?:[hash], bFor?:compactionId})`，并在 `before_agent_start` 时回扫分支重新播种。本段累计注入 30 条后停止。
- **用户可见标记**（Q8）：
  - TUI 折叠成一行，例如 `── mem U: pitfalls-git › #3 (0.81) ──`；
  - web transcript 加一个紧凑分支（J9，可选）。

### 6.2 ② 写入时自动分类打标（需要 Jev）

#### 6.2.1 触发与流程

- **触发**：`memory` 工具的 create、str_replace、insert、append、write 成功提交之后，在同一次 `execute` 里执行，入口是 `JevWritePort`。
- **流程**：
  1. 在锁内提交写入；
  2. 在锁外对比写入前后的条目 hash，找出新增或改动的条目；
  3. 对每条发一次 `tag` 调用，多条并行，总时限 3000ms；
  4. 结果合并进侧车；
  5. 生成回显。
- **usage**：Jev 调用的用量计入工具结果的 `usage`（`docs/extensions.md:249`）。
- **状态为 `partial` 时**：写入照常完成；回显 `jev: not tagged (partial: 451) — fast path will not see this entry until tagged; inline tags=+… works now`；条目保持 pending。

#### 6.2.2 问题设计（state 是条目本身，一次调用约 50 个问题）

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

- 问题构成：5 个 `m_*` 问题；每个启用标签一个 `t_*` 问题，最多 64 个；最多 20 个 `c*` 比较问题，比较对象取词面最相似的前 12 条，加上同一文件里的条目。
- 单次约 4k token，耗时 0.8–1.1 秒，约 $0.0002。
- v1 中判断门禁模式的问题 `m_gatemode` 已删除（Q32）。

#### 6.2.3 批量打标：标签为主（迁移、新增标签、改标签描述）

- **标签部分**：每个标签发一次调用。`state = {tag:"<id>: <description>"}`，每个条目一个 bool 问题，按 token 分批。现有语料共 22 次调用。
- **条目部分**：每个条目发一次调用，只含 5 个 `m_*` 问题，后台并发 4，共 150 次。
- **合计**（Q28，评审 #4）：172 次调用，约 $0.02，40–60 秒。
- **新增或修改单个标签**时，只跑这一个标签的标签部分。**例外**（§19 行 20）：`tagBulk` 的 `"all"` 范围（由 `/mem tags add`/`/mem tags enable` 触发）每次都会重问全部标签，约 22 次调用：端口不传标签 id，没法只补问单个标签。

#### 6.2.4 回显

```text
section: pitfalls-git.md #3 (L12-14)
jev: pitfall 0.91 · important · tags git-push 0.88, network 0.83 · guard 0.12 · permanent
similar: core.md L5 (complementary 0.72)
```

按条件附加以下行：

| 条件                                                              | 附加行                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `m_userlike ≥ 0.8`，且归属为 agent                                | `jev: looks like a user order (0.86) — if the user said it, append <!-- mem user -->`                                                                         |
| `m_temporal` 为 dated 或 event，且没写 `expires`/`until`          | `jev: looks temporary — add expires=YYYY-MM-DD or until="…"`                                                                                                  |
| 某个 `c*` 的结果为 duplicate、conflict 或 supersedes，且 p ≥ 0.75 | `conflict: core.md L3 (user rule, conflict 0.84) — 用户令只有用户能作废：在回复里向用户提议具体改法`。如果对方不是用户令，改为提示 agent 原地合并或删除旧条目 |
| `m_guard ≥ 0.7`                                                   | `jev: guards a risky action (0.82) — pre-action review enabled; add gate=hold if it must block while a condition holds, nogate to opt out`                    |

#### 6.2.5 同期的确定性改动（只受总开关与接线判定控制；空列表视同关闭，Q34）

- v2 的 `doAppend` 在锁内 upsert `updated`；append 新建文件时带上 `source: agent`（照搬 v4.1 §3.1）。
- 写后回显锚点。
- 用户令守卫：两阶段确认，按 `guardHash` 配对（照搬 v4.1 §3.2）。
- 如果本次写入新引入了行内注释错误，拒绝写入。
- **守卫域与打标触发域不是同一个集合**（§19 行 22）：
  - 用户令守卫（本节上述两阶段确认）覆盖 `str_replace`/`insert`/`write`/`append`/`create` 覆写 **另加 `delete`**（`tool-v2.ts` 的 `prepareJevDeleteGuard`：`after = ""` 使该文件全部用户令条目计为 touched，手写文件跳过弹框因为 provenance 拒写已先挡下）；判定条件除「触及用户令」外，还包「手写 → 非手写的 provenance 翻转」与「未归档 → `status: archived` 归档」两条；`rename` 不守卫（不改内容，hygiene-plan §3.2）。
  - 打标触发域（J5 `JevWritePort`）只是本节开头列的五个写操作（`str_replace`/`insert`/`write`/`append`/`create` 成功提交后），不包 `delete`/`rename`。

### 6.3 ③ 整理（运行需要 Jev；查看并执行已有建议是零调用）

#### 6.3.1 触发

- **增量**：写入时的 `c*` 问题（§6.2.2）。
- **周期**（Q31）：主会话 `session_start` 后，同时满足以下条件就在后台运行一次，结果只生成建议：
  - 状态为 `full`；
  - 距上次运行 ≥ `memory.jev.review.intervalDays`（默认 7 天）；
  - `corpusFp` 有变化。
- **手动**：`/mem review --run`。

#### 6.3.2 候选对

- 每个条目与以下条目配对：至少共享一个有效标签的条目，以及词面 Jaccard 相似度最高的 5 条。
- 去重后剔除 dismissed 中的对，最多保留 600 对。截断时优先保留：至少一方是用户令的对，以及至少一方 `temporal ≠ permanent` 的对。
- 「是否过时」单独提问，只问 `temporal` 为 dated 或 event 的条目，以及正文中带日期或版本号的条目。

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

600 对约 90k token，分 8 批，约 $0.004。

#### 6.3.4 决定、确认与执行

- **生成建议的门槛**：
  - 对的关系为 duplicate、supersedes 或 conflict，且 p ≥ 0.75；
  - 或者「是否过时」的 p ≥ 0.8；
  - 另外，`userLike ≥ 0.8` 而归属为 agent 的条目，生成一条「疑似用户令」建议。
- **提示**：启动提醒追加 `jev 2 suggestions — /mem review`。
- **`/mem review`**：主会话、有 UI 时逐条处理；web 端（Q35）执行 `review` 需要确认，确认后降级为与 `--list` 相同的只读文本清单，并提示「在终端执行 /mem review 逐条处理」，不做任何写入（`expired` 同理）。用 `ctx.ui.select` 逐条处理，各类建议的选项如下：

| 建议类型   | 可选操作                                                      |
| ---------- | ------------------------------------------------------------- |
| 重复       | 删除较旧的一条 / 交给 agent 合并 / 保留两条（不再提示）/ 跳过 |
| 取代       | 删除被取代的一条 / 交给 agent 改写 / 保留 / 跳过              |
| 冲突       | 交给 agent 起草统一版本 / 保留 / 跳过                         |
| 过时       | 删除 / 延期 30 天（写入 `expires`）/ 转为长期 / 跳过          |
| 疑似用户令 | 标为用户令 / 保持经验 / 跳过                                  |

- **过期建议**：如果某条建议涉及的 hash 已不在当前语料里，标为 `stale` 并跳过。这一步是零调用的，`partial` 状态下照常可用。
- **执行**：
  - 删除和改写在目录锁内用 CAS 完成，删除前先把文件复制进 `.trash`，可用 `/mem restore --trash` 恢复。
  - 「交给 agent」：用 `ctx.ui.setEditorText` 把一句指令预填进输入框（需 P0 验证这个接口在命令上下文中可用）；不可用时改为直接显示这句指令。
- **原则**：Jev 只提建议，所有删改都由用户点选决定。

#### 6.3.5 到期（Q1，确定性）

- D17：`expires` 已过为 warn；只写了 `until` 的为 info。
- `/mem expired`：删除 / 延期 30 天 / 去掉期限 / 跳过。
- 启动提醒附带到期条目的数量。

### 6.4 ④ 高危动作拦截

#### 6.4.1 粗筛（同步、零 IO）

1. 状态不是 `off`，且 `memory.jev.gate.enabled` 为真（`partial` 下也继续，后面只走证据档）。
2. 工具不在只读集合里（`read|grep|find|ls|web_search|get_run_result|todo*`，以及 memory 的 view/search）。
3. 调用命中至少一个高危标签的匹配器。
4. 存在**守护条目**：有效 `guarded` 为真，并且「有效标签包含命中的高危标签」或「写了行内 `gate*`」（写了行内 `gate*` 的条目对任何高危命中都算候选）。按重要度排序，最多 8 条。
5. 剔除本段已闩锁、且没有写 `gate=hold` 的条目：它们一定放行，不必再问 Jev。

任一步不通过就放行；这时 `tool_call` handler 零 await，因为粗筛必须在第一个 await 之前完成。

#### 6.4.2 现场证据（并行采集，最坏 1.5 秒）

- **点名程序**：`namedPrograms(body)` 从规则正文中提取程序名，提取对象为：
  - 反引号片段的首词；
  - 以 `.sh`、`.py`、`.mjs`、`.js`、`.ts` 结尾的词。

  通用程序 `git`、`npm`、`npx`、`node`、`bash`、`sh`、`zsh`、`pi`、`gh`、`ls`、`cd`、`cat`、`echo`、`timeout` 被剔除，所以 `release.sh` 会被提取，`git` 不会。

- **`running`**（Q30）：只收录程序身份属于候选条目点名程序的进程。程序身份的取法照搬 v4.1 §2.7.3：取 argv0 的 basename；如果 argv0 是解释器，取它执行的脚本名。**解释器短旗标识别**（`jev/shell-parse.ts`，§19 行 23，`31e845ce`）：含 `c` 的短旗标集群（`-lc`/`-ic`/`-xec` 等）视为 `-c`，命令字符串取选项后的第一个操作数（`-o` 消耗自己的参数）；程序身份同样按这个操作数规则取，所以 `bash -o pipefail x.sh` 的身份是 `x.sh`，脚本操作数之后的 `-c` 仍算脚本参数。数据来源两个：
  - 主会话的 BashJobManager 中运行中的任务（晚绑定端口）；
  - **仅 Linux**：扫描 `/proc`。只看当前 uid 的进程，最多 4096 个 pid，结果缓存 2 秒；扫描永不抛错；收到 `bash-job:notification` 时清缓存。

  收录到的命令行先过 §7 的脱敏流水线，每项不超过 120 码点，最多 10 项。

- **非 Linux 的退化**（Q30，评审 #3）：macOS 等平台不扫描进程，也不用 `ps` 兜底。结果是：
  - 主会话只能看到自己的 bash 后台任务；子会话完全没有进程证据；
  - **在另一个终端、或另一个 pi 会话里运行的 release.sh 检测不到**。依赖这类条件的 hold 规则只对本会话的后台任务生效。
  - `/mem jev` 显示 `process evidence: bash jobs only (non-Linux)`，`docs/guide/memory.md` 写明这一点。
- **`branch`**：读 `.git/HEAD`，支持 worktree。
- **`staged`**：仅当命令是 git commit，且候选正文里含有路径样式的词时，才通过有界的 git 执行器取暂存文件列表（照搬 v4.1 §2.7.4），最多 50 项。
- 任何一项采集失败都直接省略，不阻塞后续。

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
      "instructions": "Project rule (user rule) from pitfalls.md › 发版进行中禁止动 git 状态: 「release.sh 运行期间（含后台任务、其它终端）禁止 commit/tag/切分支……」 How does this rule relate to the pending tool call described in state?",
      "criteria": {
        "unrelated": "The rule does not cover this tool call",
        "applies": "The rule covers this kind of action; the assistant must review the rule before running it",
        "violates_now": "The rule covers this action AND its condition holds right now according to state, so running it now would break the rule"
      }
    }
  }
}
```

#### 6.4.4 Jev 判定档（状态为 `full` 或 `probing`）

记 `a = P(applies)`，`v = P(violates_now)`，阈值为 `memory.jev.gate.threshold`（默认 0.6）。**E0 阶段二实测结论**（§19 行 18，jev-1.13 最终动作判对 34/38、零漏拦）：阈值维持 0.6（降到 0.5 只能救回 1 例，会增加误拦）；已知误拦形态——发版进行中 `echo`/`grep` 打印含 `git commit`/`git tag` 字样的文本——在生产路径上会被 §6.4.1 的 shell-parse + 标签粗筛挡下（程序身份是 `echo`/`grep`，不是 `git`，根本不会问 Jev，见 §16.4 例 7），评测集里的误拦只是构造文本直接交给 Jev 的人工构造案例。按下表自上而下取第一条成立的：

| 条件                        | 判定                                                               |
| --------------------------- | ------------------------------------------------------------------ |
| `a + v < 阈值`              | 放行                                                               |
| 条目为 `hold` 且 `v ≥ 阈值` | **hold 拦截**：正文只注入一次，之后每次只返回 reason               |
| 本段未闩锁                  | **拦一次**：正文立即注入；闩锁在 `turnSeq` 前进后生效（v4.1 §2.2） |
| 其它                        | 放行                                                               |

- **判定缓存**（评审 #5、#11）：
  - 键 = `entryHash` + `evidenceFp` + `shape`。其中 `evidenceFp` = sha1（排序后的 running 程序身份 + branch + 排序后的 staged），`shape` = 排序后的「程序 子命令」集合，例如 `git commit`。
  - 命中缓存时直接套用上表，不调用 Jev。因此 hold 场景下，agent 在证据不变时反复重试，会立刻被再次拦下，既不付费也不等待；`git checkout -b` 这类同形命令在本段内只问一次 Jev。
  - 证据一变（例如 release.sh 结束后，指纹随之改变），下一次调用就会重新判定。
  - 每会话最多 64 项，本段内有效，最长 10 分钟；compaction 时清空。
- **多条同时命中**：取最严的判定（hold > 拦一次 > 放行），reason 列出全部命中的条目。
- **同批相同调用**：判定按条目 hash 串行；同一批里对同一条目只问一次，结果共享。并行调用的派发顺序需 P0 验证（C-J3）。
- **静态 core 中的条目**：正文已在 system prompt 里，不重复注入，reason 里引用它的标题。
- **文案**：

```text
[memory gate] 本次 <tool> 调用未执行：Jev 判定它属于记忆规则「core.md L4」（用户令，applies 0.83）的管辖范围。规则正文紧随其后以 [memory] 消息给出（已在系统提示中的规则不再重复）。请逐条核对：全部满足就在下一步原样重试（看过正文后的重试不会再拦；同一批里并发的相同调用也已一并拦下）；有不满足的，调整方案或先问用户。
```

```text
[memory gate·hold] 本次 <tool> 调用未执行：规则「pitfalls.md › 发版进行中禁止动 git 状态」（用户令）的条件仍成立（violates_now 0.86；证据：job_42 bash scripts/release/release.sh 0.10.3）。本次及后续重试都会被拦，直到条件消失。请等待（如用 bash_job list 查看进度），不要反复重试；确需继续请先问用户。
```

#### 6.4.5 证据档（Q29：Jev 本次超时、出错、漏答，或状态为 `partial`）

在 Jev 无法给出判定时，对粗筛留下的每个候选条目按下表处理：

| 候选条目                                                                                                        | 处理                                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 写了行内 `gate=hold`，且 **确定性证据已命中**：`running` 中至少有一个进程的程序身份属于该条目的 `namedPrograms` | **拦截**。reason 注明「Jev 未判定，按证据拦截」。正文本段只注入一次                                        |
| 其它                                                                                                            | **放行**，同时把正文以「未判定」注入（本段一次）：`[memory · G unjudged] Jev 未能判定，以下规则请自行核对` |

```text
[memory gate·hold] 本次 <tool> 调用未执行：Jev 未判定（timeout），按证据拦截——规则「pitfalls.md › 发版进行中禁止动 git 状态」（用户令，gate=hold）点名的程序正在运行：job_42 bash scripts/release/release.sh 0.10.3。本次及后续重试都会被拦，直到该程序结束。请等待，不要反复重试；确需继续请先问用户。
```

- **为什么这样分档**：
  - hold 规则是用户显式标注的，而「点名程序正在运行」这件事本身就不需要 Jev 判断，所以由证据兜底拦截，这正是 release.sh 事故的场景（评审 #1）；
  - 其它情况如果因为外部分类器抖动就一律拦截，会卡死全部 git 操作，所以选择放行，并把规则正文给到模型。
- **与 pi 文档的关系**：对 hold 规则 fail closed 符合 `docs/extensions.md:214` 的建议；其余情况的放行是有意偏离。
- **适用范围**（N1，Q33 已拍板为适用）：证据档同样用于 `partial` 状态（整个 Jev 不可用），而不只是单次超时。这是把 Q26（零调用部分继续）与 Q29 合起来推出的结论。
- **非 Linux**：证据只有本会话的 bashJobs，见 §6.4.2。
- **handler 异常**：一律放行，并记日志。handler 必须永不抛错（`runner.js:957-970`）。

#### 6.4.6 其它约束

- **延迟**：只有通过粗筛、且没有命中判定缓存的调用，才需要同步等待，典型 0.8–1.1 秒，上限 2.5 秒。证据档本身不需要等待，`/proc` 扫描另计，最坏 1.5 秒。
- **逃生路径**（用户）：
  - 修改或删除规则；
  - 给规则加 `nogate`；
  - 终止仍在运行的任务；
  - 关闭 `memory.jev.gate.enabled` 后 `/reload`。
- **覆盖范围**：被拦下的调用不会产生 `tool_result`；嵌套的 `ctx.executeTool` 也会经过这道门禁（`docs/extensions.md:261`）。

## 7. 隐私：截断、脱敏与不外发清单

### 7.1 流水线（`jev/redact.ts`，先匹配后截断）

1. 截取前 8KB 作为匹配窗口。
2. 去掉 ANSI 转义序列，以及 `\n`、`\t` 以外的 C0 控制字符。
3. 掩码，规则如下：
   - `SECRET_PATTERNS` 与宽松键值规则（与 doctor D13 同源）；
   - `src/core/redact.ts:6` 中的 bearer 与 api-key 查询参数；
   - 敏感键名子串（token、secret、passw(or)d、pwd、api[_-]?key、auth、credential、cookie、session、private[_-]?key）所赋的值。这组常量在 memory 内部维护一份镜像，不 import web-hub；
   - URL 中的 userinfo；
   - PEM 块，整块替换为 `[PEM]`；
   - 长度 ≥32 的 base64 或 hex 串；
   - 邮箱地址。
4. `$HOME` 替换为 `~`。
5. 按下表截断（单位：码点）：

| 字段                  | 上限     | 方式                 |
| --------------------- | -------- | -------------------- |
| 用户消息、派单 prompt | 2000     | 头部                 |
| 上一条用户消息        | 600      | 头部                 |
| 工具命令              | 500      | 头部                 |
| 错误摘录              | 1500     | 尾部，首个错误行优先 |
| 条目摘录              | 400      | 头部                 |
| running（进程命令行） | 10 × 120 | 每项头部             |
| staged                | 50 × 200 |                      |

脱敏是尽力而为的卫生措施，不是安全边界。真正的边界是 §7.2 的「永不外发」清单，以及 secure 域的强制关闭。J7 的集成测试钉住一条：进程命令行里的 token 在外发前已被掩码（评审 D7 条件 ①）。

### 7.2 永不外发

- 任何文件读取结果和成功的工具结果正文；
- system prompt、助手消息与推理、其它会话的消息；
- 标为 `private` 的条目和 `secret` 为真的条目（整条剔除）；
- 未被点名的进程；
- `.trash`、`.backup`、`archive/` 目录下的内容；
- settings 与 auth 文件；
- secure/locked 域下的一切。

### 7.3 secure 域（I11）

双重关闭：

1. `applySecureDomainOverrides`（`src/config/settings.ts:417`）在 secure 和 locked 域下把 `memory.jev.enabled` 强制置为 false；
2. `src/index.ts` 把 `getSecureDomain()?.kind !== "plain"` 的判定结果传给 `wireMemory`，后者不接线 Jev。

此时零调用部分也一并不注册。J3 开工前先读 `docs/dev/data-encryption/README.md`，并把 memory.jev 补进 D8 清单。

## 8. 子会话、system prompt、cache-ttl、compact

- **子会话**（Q9/I6）：
  - 注册条件：`isChildSession && injectInChildSessions && memory.jev.childSessions`。
  - 子会话做召回（U/A/E/B）和门禁。进程证据只走 `/proc`（仅 Linux），不读主会话的 bashJobs。
  - 子会话不做：探测计时器、批量打标、周期整理、通知、写侧车。
  - 子会话与主会话共享健康表和令牌桶。
- **sysprompt 冻结快照**：
  - 全部动态注入都走消息通道。
  - 「剥掉行内注释」和「工具描述变体」两项由设置决定，在一个 activation 内保持不变。
- **cache-ttl**：
  - 注入只追加在尾部，不破坏前缀缓存。
  - 同步等待只推迟请求，不影响缓存的有效期。
  - 例外：默认开启时，工具描述变体会让 system prompt 前缀一次性变化，缓存失效一次。J9 的 release note 写明（评审 #16）。
- **compact / switch_context**：
  - compaction 会重置段内去重和判定缓存，并触发 B 层重注。
  - 子会话的 switch 用 `turn_end` 作为检查点（v4.1 §2.5）。

## 9. 设置键、工具面与 I9

### 9.1 新键（改后 `/reload` 才生效；在 `settings.ts` 内联解析，逐字段容错，不新增 import）

| 键                               | 类型/范围   | 默认                                       | 说明                                                                                                                                                           |
| -------------------------------- | ----------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.jev.enabled`             | bool        | `true`（Q27）                              | legacy 和 secure 域下强制视为 false                                                                                                                            |
| `memory.jev.classifiers`         | 逗号串/数组 | `opencode/jev-1.13-free,opencode/jev-1.13` | 有序列表；openrouter 项待 J0 探测后定稿（评审 #8）。**空列表 = off**，零调用部分也不生效（Q34）；非空但全部非法 ⇒ 同样 off，并给一条 warn（doctor 或启动提醒） |
| `memory.jev.proxy`               | string      | `""`                                       |                                                                                                                                                                |
| `memory.jev.childSessions`       | bool        | `true`                                     |                                                                                                                                                                |
| `memory.jev.recall.threshold`    | 0.5–0.99    | `0.6`                                      | E0 实测后由 0.7 调为 0.6（Q36，措辞同步改为「提醒是否有帮助」）；再调整需回本稿并问用户                                                                        |
| `memory.jev.recall.maxEntries`   | 1–10        | `3`                                        | E 层固定为 2                                                                                                                                                   |
| `memory.jev.recall.maxBytes`     | 512–16384   | `4096`                                     |                                                                                                                                                                |
| `memory.jev.recall.waitS`        | 0–3         | `2`（Q37）                                 | 0 = 纯异步；内部 waitMs（TIME_SETTING_MS_PATHS）                                                                                                               |
| `memory.jev.gate.enabled`        | bool        | `true`                                     |                                                                                                                                                                |
| `memory.jev.gate.threshold`      | 0.5–0.95    | `0.6`                                      | 同上：J0 基线评测后可能调整，调整需回本稿并问用户                                                                                                              |
| `memory.jev.review.intervalDays` | 0–90        | `7`（Q31）                                 | 0 = 只能手动                                                                                                                                                   |
| `memory.jev.maxCostUsd`          | 0.01–5      | `0.5`                                      |                                                                                                                                                                |
| `memory.jev.maxCalls`            | 0–5000      | `800`                                      |                                                                                                                                                                |
| `memory.jev.confirmTimeoutS`     | 10–600      | `60`                                       | 秒键：J3 登记进 `TIME_SETTING_MS_PATHS`（`src/config/settings.ts:329`），内部字段为 `confirmTimeoutMs`                                                         |

共 14 个键。其余参数（缓存规模、`/proc` 上限、批大小）都是常量。

### 9.2 I9 论证（按 Q26 更新）

- **off**（设置期，零注册）：以下任一情况成立即为 off：`memory.jev.enabled=false`、legacy layout 或 legacy 工具面、非 plain 域、`classifiers` 为空（Q34，含非空但全部非法）。此时：
  - 不调用 `wireJev`，不注册任何新钩子和渲染器；
  - 工具使用原常量，schema 本来就不变；
  - doctor 不跑 D17–D19；
  - 启动提醒、`inject.ts`、tidy prompt、`/mem` 的输出都不变。
- **off 的证明**：J0 在未改动的 dev 上生成 `jev-off-golden.json`，内容包括：
  - 注册序列；
  - 固定脚本下的工具输出与文件字节；
  - current-5 和一个合成 core 的渲染结果、doctor 输出、启动提醒；
  - tidy prompt。

  之后分别以 `jev.enabled=false`、legacy（jev=true）、模拟 secure（jev=true）三种配置重放，结果必须逐字节相等。
  v2.1 增补：重放配置扩为五种——再加 `classifiers=[]`（必须与 disabled 逐字节相等），以及「设置开 + 无 modelRegistry」（`off(pi-api)`，除 `registrations` 外逐字段等于 disabled，`registrations` 差集恰为 jev 集合；§5.3）。**`PI_API_ALLOWED_DIFF` 登记完整性**（§19 行 15）：`/mem` 描述追加 ` · /mem jev · /mem tags`（J4 commandPort 接线后）已登记；J8 接线 review/expired 后追加 ` · /mem review · /mem expired`与两个补全项 `completion:review`/`completion:expired`，同样登记在该清单（`tests/memory/jev/off-golden.test.ts`）。

- **on，状态为 `partial` 或 `inactive`**：这种状态不在 byte-identical 的承诺之内，因为零调用部分仍会工作（Q26）。行为边界由单测钉住：
  1. **覆盖率为 0、没有任何行内 `gate*`/`tags=`**（`inactive`）：零 `sendMessage`，零 block；除了 `/mem` 多出的一行状态、工具描述变体和新注册的钩子以外，功能上与今天一致。
  2. **有侧车标签或行内元数据**：A 层只注入有标签的条目，B 层只重注上一段注入过的条目；门禁只走证据档，只有「`gate=hold` + 点名程序正在运行」才会拦截。
  3. 任何情况下都不发起 Jev 调用，到达 `until` 的探测除外。

### 9.3 工具面变体（jev 开启时只换描述）

- `MEMORY_TOOL_V2_TEXT_JEV` = 原描述 + 约 250B：

  ```text
  Entries are tagged automatically after writes. Inline authority (end of the entry's first line): <!-- mem user|lesson expires=YYYY-MM-DD until="…" gate|gate=hold|nogate tags=+a,-b private -->.
  ```

- schema 与原版**完全相同**（Q32 把 `tag_add` 推迟到二期）。
- `memory-tool-surface.json` 新增一个描述 key，`toolSurfaceBytes` 的预算由同一个包核对。

### 9.4 `/mem jev` 示例（partial 状态，Linux）

```text
jev      enabled · partial (classifier unavailable since 11:40) · next probe 12:40
models   1 opencode/jev-1.13-free   unavailable (451) until 12:40 — 451 多为地区拦截，可设 memory.jev.proxy
         2 opencode/jev-1.13        unavailable (402 Insufficient funds) until 12:41
stopped  recall U · error recall E · write tagging · review run · gate judgment
running  action fast path A · re-inject after compaction B · gate evidence tier · review list
tags     142/150 tagged · 8 pending (edited since last tagging) · last tagged 10-29 18:55 · taxonomy 4f2a91c0
evidence process: bash jobs + /proc (Linux)
usage    37 calls · $0.0061 / $0.50 · per activation (/reload resets)
segment  injected 5 (U3 A1 E1) · gates 1 (hold 0) · cap 5/30 · verdict cache 3
review   last 2026-10-28 · 2 open → /mem review
```

- **子命令**：
  - `/mem jev probe`：强制刷新可用集；
  - `/mem jev retag [--all]`、`/mem jev reset-index`；
  - `/mem tags [list|add|rm|disable|enable]`；
  - `/mem review [--run|--list]`；
  - `/mem expired`。
- **代理行**（真机验收后补，7584097c）：`memory.jev.proxy` 非空时，在 `evidence` 与 `usage` 之间多一行 `proxy    http://***@host:port`（凭证一律打码）；不可解析或非 `http://` 的代理以 `— ignored (only http:// proxies are supported)` 结尾，客户端按未配置代理处理。上面的示例没有配置代理，所以没有这一行。
- **web 端**（Q35，经 `src/web-hub/agent/command-policy.ts` 的 `mem()`）：只读的 `jev`、`tags`（裸形式）、`tags list`、`review --list` 允许执行；改动状态的子命令（`jev probe`、`jev retag`、`jev reset-index`、`tags add|rm|disable|enable`）需要确认，与 `/mem` 现有的 confirm 惯例一致；`review`（逐条选择）与 `expired` 在 web 端需要确认，确认后降级为只读文本清单并提示回终端处理，不做写入（它们有文本回退，所以不属于拒绝条件）。Q35 的拒绝条件是「纯终端交互、没有文本回退」，本期没有命中该条件的子命令，即**本期无 deny 行**。`command-usage.ts` 不改。
- **skill**：新增 `skills/memory-jev/SKILL.md`，承载使用策略（I12）。

## 10. 测试与验证策略

- **假 registry**：脚本化地返回答案；错误文本照搬实测（`System One API error (451)…`、`(402)…Insufficient`、`Provider is not configured`、`aborted`）；可注入延迟和漏答；会记录收到的 state、questions、options。
- **假代理**：照搬 v4.1 P5b 的 12 例，外加 URL 解析的表驱动用例。
- **单测**：

| 对象          | 用例                                                                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entries`     | 切分；围栏；续行；**表格、引用块、HTML 块**（#13）；两种哈希；`secret`、`namedPrograms` 的缓存与失效（#6）；按 section 判定静态 core（#10）                                              |
| `taxonomy`    | 合并、上限、rev 只随 description 变化                                                                                                                                                    |
| `questions`   | 分批边界；附带上一条用户消息（#9）                                                                                                                                                       |
| `decide`      | 阈值边界；门禁判定表；**证据档两行**（Q29）；**判定缓存**：同指纹命中、指纹变化后重判、compaction 后清空、上限 64（#5）                                                                  |
| `health`      | 全部状态转移：451→402→成功；逐模型熔断；整列不可用 → `partial`；预算 → `partial`；`inactive` 判定；通知去重：首次 `full` 通知一次（裁定），无凭证不通知；probe 强制刷新可用集缓存（#12） |
| `redact`      | 每条规则；进程命令行掩码（D7）                                                                                                                                                           |
| `review`      | 配对与截断优先级；按 anchorKey 匹配 dismissed（#7）；过期建议                                                                                                                            |
| `guard`       | 照搬 v4.1 三例                                                                                                                                                                           |
| `index-store` | 坏 JSON；锁忙；合并；GC                                                                                                                                                                  |

- **集成**（fakePi + 假 registry）：
  - U 召回的同步与晚到两条路径；
  - 写入打标与回显；
  - 迁移批量打标的调用次数为 172（按 fixture 规模换算），并断言计入 `maxCalls`；
  - release.sh 场景下，hold 重试命中缓存、不再调用 Jev；任务结束后重判并放行；
  - **Jev 超时 + `gate=hold` + 证据命中 ⇒ 拦截**，reason 为「按证据拦截」；超时但证据未命中 ⇒ 放行，并注入「未判定」；
  - `partial` 状态：A/B 层继续，标记带 `·partial`，U/E 层不调用；
  - `inactive` 状态：零注入、零 block；
  - 非 Linux 平台（mock `process.platform`）：只用 bashJobs，`/mem jev` 显示退化说明；
  - secure 域零接线；
  - 子会话。
- **P0 conformance**：C-J1–C-J14 同 v1：
  - C-J1：before_agent_start 的等待与 message 落点；
  - C-J2：tool_call 的 block 与抛错后果；
  - C-J3：并行调用的派发顺序；
  - C-J4：sendMessage 的落点（**J0 实测结论**，§19 行 19：`sendMessage(triggerTurn:false)` 在本 turn 的 turn_end 即 flush，工具结果之后、本 run 内下一次 LLM 调用可见、不起额外一轮；§6.1.3 原假设成立；LLM 侧投影 `role:"user"`，会话树为 `custom_message`）；
  - C-J5：tool_result 的字段；
  - C-J6：bash-job 通知；
  - C-J7：classify 在各类 ctx 中的可用性、`fetch` 透传、abort；
  - C-J8：错误文本格式与上下文超限时的措辞；
  - C-J9：skill 展开块；
  - C-J10：子会话 compaction；
  - C-J11：嵌套 executeTool；
  - C-J12：usage 计入工具结果；
  - C-J13：渲染器；
  - C-J14：setEditorText。

  另新增 **C-J15**：opencode 和 openrouter 两个渠道上各分类器 id 能否被 `getModelOfType` 找到、能否实际调用，结果决定默认列表的定稿（#8）。

- **质量评测**（Tier 3，`scripts/dev/jev-eval.mjs`）：
  - 召回 40 例，其中包括指代型消息（#9），以及「core 条目被重复注入」的反例（#10）；
  - 门禁 24 例，其中包括 `git checkout -b`、`git stash` 正例（#11）和 `echo` 干扰项；
  - 打标 30 例、整理 20 对。
  - J0 先跑出基线，再据此定阈值。
- **每个包的门禁**：`npm run format:check && npm run typecheck && npx vitest run tests/memory tests/conformance tests/boundary tests/governance`；J9 跑全量。

## 11. 关键决策与备选

| 决策                     | 选择                                                             | 不选的备选与理由                                                                   |
| ------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 派生标签存在哪           | 侧车，以内容哈希为键                                             | 行内：每次打标都要改写用户文件，触发守卫，并污染 diff                              |
| 权威事实存在哪           | 行内注释                                                         | 侧车：用户看不见，而且正文一改就丢                                                 |
| 条目粒度                 | 列表项 / 整段 / 块级结构                                         | 只用 `## ` 小节：7 个文件根本没有 `## `                                            |
| 召回候选                 | 一次判全部（≤360 条），超出时本地预筛                            | v4.1 预筛到 24 条：延迟优势不明显，召回率却会下降；两段式：语料规模还用不上（Q32） |
| 召回时序                 | 有界同步等待 1.5 秒（Q37 起默认 2 秒），超时后补发（Q25）        | 纯异步：纯问答的那一轮看不到记忆                                                   |
| Jev 不可用时             | 只停需要 Jev 的功能，零调用部分继续（Q26）                       | 全部关闭（v1 的推荐）：会白白丢掉已经打好的标签和行内门禁                          |
| 「部分可用」怎么让人看懂 | 状态名 `partial` + 覆盖率 + 功能分栏 + `·partial` 标记           | 只给一个 ready/unavailable 二值：正是评审担心的心智负担                            |
| 门禁的条件               | 证据交给 Jev 判断；hold 只认行内声明                             | Jev 判 hold 模式：增量价值小（Q32）                                                |
| Jev 判不了时的门禁       | 两档：`gate=hold` + 证据 ⇒ 拦截；其余放行并注入「未判定」（Q29） | 全部放行：会放过事故规则；全部拦截：外部抖动会卡死 git                             |
| hold 重试                | 按证据指纹缓存判定                                               | 每次都问 Jev：agent 不停重试时，每次多花一次调用、多卡 2.5 秒                      |
| 非 Linux 的进程证据      | 不做，并写明退化（Q30）                                          | 用 `ps` 兜底：用户选择不做                                                         |
| 健康表作用域             | 进程级共享                                                       | 每个会话各一份：子 agent 群会对同一个 451 反复撞墙                                 |

## 12. 旧拍板处置与 v4.1 部件复用

### 12.1 Q1–Q32

| #       | 处置                       | 落点                                                             |
| ------- | -------------------------- | ---------------------------------------------------------------- |
| Q1      | 保留                       | §6.3.5；注入时标「已到期」                                       |
| Q2      | 保留                       | U/A/E/B/G 五层 + skill 兜底                                      |
| Q3      | 改变                       | 范围改为本架构；后续调优依赖评测                                 |
| Q4      | 保留                       | 行内 `user`、默认归属、guard.ts                                  |
| Q5      | 改变                       | T1 → A 层 + G；T2a 作废；T2b → U；T3 → B                         |
| Q6      | 保留语义，改变来源         | 守护条目 = 行内 `gate` 或 Jev 判定的 guard                       |
| Q7      | 作废                       | 改为回显标签                                                     |
| Q8      | 保留                       | §6.1.6，加 `·partial` 标记                                       |
| Q9      | 保留并扩展                 | 子会话也受门禁约束                                               |
| Q10     | 保留                       | 上线后的手动流程                                                 |
| Q11     | A、E 保留；B、C 改变       | E 层由 Jev 选条目；状态和暂存文件作为证据                        |
| Q12     | 改变                       | 只用分类器                                                       |
| Q13     | 改变                       | 扩为四项职责                                                     |
| Q14     | 保留                       | 默认开启（Q27），secure 域双重关闭                               |
| Q15     | 保留                       | 只认行内 `gate=hold`（Q32）                                      |
| Q16     | 保留                       | 所有功能都不退回对话模型                                         |
| Q17     | 保留；「退回对话模型」作废 | §5.2                                                             |
| Q18     | 保留，键改名               | `memory.jev.proxy`                                               |
| Q19–Q24 | 落实                       | 全文                                                             |
| Q21     | **经 Q26 细化**            | 「需要 Jev 的功能」以 Jev 为硬依赖，零调用部分继续（§3.3、§5.3） |
| Q33–Q35 | 落实（v2.1）               | §14.2、§14.3                                                     |
| Q25–Q32 | 落实                       | §14.1                                                            |

v4.1 的 O 项：

- O1、O3、O5–O9、O11 保留；
- O2 被 Q25 取代；
- O4 由 Q27 确认；
- O10 改为整理中的「疑似用户令」建议；
- O12–O19 的对应关系同上表。

### 12.2 v4.1 部件复用清单

| 部件                                 | 处置                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `GATE_REASON` / `GATE_HOLD_REASON`   | 复用；依据改为 Jev 判词或证据，新增「按证据拦截」变体                     |
| 错误分级与熔断                       | 原样复用，新增 context 类；整列不可用时进入 `partial`                     |
| 代理 fetch                           | 原样复用，键改名                                                          |
| argv 解析                            | 原样复用                                                                  |
| if-running 等状态谓词                | 保留 proc-scan 和 git-head 的数据采集（proc-scan 仅 Linux），删除谓词语法 |
| 提交时的暂存文件                     | 复用为证据                                                                |
| 结果触发的时序                       | 原样复用                                                                  |
| 段内去重 / 播种 / 闩锁               | 原样复用，键改为条目 hash                                                 |
| 消息格式与渲染器                     | 复用，层改为 U/A/E/B/G，details 增加 `partial`                            |
| T3                                   | 复用为 B 层                                                               |
| 用户令守卫                           | 原样复用                                                                  |
| append 刷新、D17–D19、`/mem expired` | 复用；D02 不加 fix 文本                                                   |
| P0 ①–⑨                               | 并入 C-J1–C-J15                                                           |
| 条目元数据行语法                     | 只保留 user/lesson/expires/until/gate 系列，新增 tags/private/nogate      |
| 对话模型链、T2a、极简目录            | 删除或推迟                                                                |

## 13. 风险与缓解

| 风险                                                     | 等级 | 缓解                                                                                                        |
| -------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------- |
| Jev 判断质量：choice、score 和「标签为主」的问法都未实测 | 高   | J0 先出评测基线；阈值可调；门禁要求两重判定；行内写法可以覆盖                                               |
| 「部分可用」状态让用户困惑（评审对 D3 的担忧）           | 中   | 状态名与覆盖率、功能分栏、`·partial` 标记、转入时通知；没有标签时显示为 `inactive`（§5.3）                  |
| 标签陈旧：正文已改，或 Jev 长期不可用                    | 中   | 以内容哈希为键，正文一改旧标签即失效；pending 计数可见；行内 `tags=` 可立即生效；恢复后后台补打             |
| 门禁误拦                                                 | 中   | 闩锁；hold 随证据变化重新判定；证据档只拦截 hold + 证据命中的情况；`nogate` 和总开关作为逃生口              |
| 门禁漏拦                                                 | 中   | 行内 `gate` 对任何高危命中都算候选；预置高危匹配器；评测集                                                  |
| 非 Linux 上检测不到其它终端的进程                        | 中   | 文档与 `/mem jev` 明示；hold 规则在本会话的 bashJobs 中仍然生效                                             |
| 点名程序提取得太宽或太窄                                 | 低   | 剔除通用程序；评测集覆盖；收录哪些进程在 `/mem jev` 中可见                                                  |
| 判定缓存过期：证据指纹没有覆盖的条件发生了变化           | 低   | 缓存最长 10 分钟，compaction 时清空；hold 的条件都来自证据本身                                              |
| 同步等待拖慢交互                                         | 中   | 召回最多 1.5 秒（Q37 起默认 2 秒）；门禁只在粗筛通过且缓存未命中时等待，最多 2.5 秒；`partial` 状态下零等待 |
| 数据外发泄露                                             | 中   | §7；进程只收录被点名的程序；secure 双重关闭；首次启用时通知用户                                             |
| 注入噪音                                                 | 中   | 阈值、上限、去重、熔断、评测                                                                                |
| 默认开启导致前缀缓存失效一次                             | 低   | release note 写明（#16）                                                                                    |
| pi 的语义变化                                            | 中   | C-J1–C-J15 纳入 AGENTS.md「pi peer bump checklist」第 2 条，由 J9 负责改写                                  |
| agent 把用户令写成经验条目                               | 低   | `userLike` 回显提示，整理中生成「疑似用户令」建议                                                           |

## 14. 拍板记录

### 14.1 已拍板（第八轮，2026-10-30）

| #    | v1 项    | 结论                                                                                        | 落点                   |
| ---- | -------- | ------------------------------------------------------------------------------------------- | ---------------------- |
| Q25  | D1       | 召回最多等 1.5 秒（Q37 改为整数秒键、默认 2 秒），超时先开工、晚到补发（取代 O2）           | §6.1.1、§9.1           |
| Q26  | D3       | **保留零调用部分**；只关闭需要 Jev 的功能；Q21 细化为「需要 Jev 的功能硬依赖」              | §3.3、§4.4、§5.3、§9.2 |
| Q27  | D4       | 默认开启                                                                                    | §9.1                   |
| Q28  | D5       | Jev 第一次可用时后台自动打标（约 172 次调用，约 $0.02）                                     | §4.5、§6.2.3           |
| Q29  | D2       | 分档：行内 `gate=hold` + 确定性证据命中 ⇒ 超时也拦；其余 ⇒ 放行并注入「未判定」             | §6.4.5                 |
| Q30  | D7       | 看其它进程，但只收录被点名的程序，先脱敏再外发；仅 Linux，非 Linux 写明退化                 | §6.4.2、§7             |
| Q31  | D6       | 每 7 天在后台整理一次，只生成建议                                                           | §6.3.1                 |
| Q32  | 评审 #15 | 推迟两段式召回；删除 Jev 判定门禁模式；推迟 agent `tag_add`                                 | §1.3、§4.2、§4.3、§9.3 |
| 裁定 | 评审 #2  | Jev 首次转为可用时 `ctx.ui.notify` 一次（含所用模型、查看与关闭方式），每个 activation 一次 | §5.3                   |

### 14.2 v2 新增项（已拍板）

| #   | 问题                                                                       | 结论                                                                                      | 落点            |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------- |
| N1  | Q29 的证据档是否也用于 `partial` 状态（整个 Jev 不可用），而不只是单次超时 | **Q33 已拍板 = 适用**：证据档不调用 Jev，属于零调用部分；「未判定」注入每段每条目最多一次 | §6.4.5、J7 验收 |

### 14.3 第九轮拍板（2026-10-30，实施方案评审 r1）

| #   | 问题                                          | 结论                                                                                                                             | 落点                   |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Q34 | `memory.jev.classifiers` 为空列表             | 等同总开关关闭（off，零调用部分也不生效，与今天逐字节一致）；非空但全部非法时给一条 warn。想保留证据档保护的用户保留默认列表即可 | §3.3、§5.3、§9.1、§9.2 |
| Q35 | web 端执行改动状态的 `/mem jev`/`tags` 子命令 | 需确认（与 `/mem` 现有 confirm 惯例一致）；只有纯终端交互、无文本回退的子命令才拒绝；`tags` 裸形式允许                           | §9.4、§6.3.4           |

当前无待拍板项。

## 15. 拆包建议（粗粒度，供 Plan 细化）

依赖（v2.1，与 `jev-plan.md` 批次一致）：`J0 → {J1, J3} → J2 → J4 → {J5, J6, J8} → J7 → J9`。J7 在 J5、J6、J8 全部合入后开工（它负责这三包端口的生产接线）。

| 包  | 名称          | 文件域                                                                                                                                                                                                                                                                                   | 依赖                 | 要点                                                                                           |
| --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| J0  | 基线          | `tests/memory/jev/off-golden.test.ts` + `jev-off-golden.json`、`tests/conformance/memory-jev-channels.test.ts`（C-J1–C-J15）、`scripts/dev/jev-eval.mjs` + 评测集                                                                                                                        | —                    | 只加测试与脚本；产出评测基线、默认列表定稿（#8）                                               |
| J1  | 纯域          | `jev/{contracts,entries,taxonomy,redact,shell-parse,match,guard,format}.ts`（含 `expiredEntries`）、`secret-patterns.ts`、`doctor.ts`（搬家）、pi-free 测试根                                                                                                                            | J0                   | 块级结构（#13）、secret 缓存（#6）、`namedPrograms`                                            |
| J2  | 引擎          | `jev/{client,health,proxy-fetch,questions,decide}.ts`                                                                                                                                                                                                                                    | J1                   | 状态机四态、`inactive`、通知判定、判定缓存、证据档                                             |
| J3  | 设置与 secure | `src/memory/settings.ts`、`setting-specs.ts`、pin corpus、`src/config/settings.ts:417`、`docs/dev/data-encryption/README.md`                                                                                                                                                             | J0                   | 14 个键；D8 清单                                                                               |
| J4  | 侧车与命令    | `jev/{index-store,tagging,review,command-port}.ts`、`command.ts` 中的 `/mem jev`、`/mem tags` 分支、`src/web-hub/agent/command-policy.ts`（jev/tags 行）                                                                                                                                 | J2, J3               | 批量打标（Q28）、覆盖率、dismissed 锚（#7）；web 端确认（Q35）                                 |
| J5  | 写入路径      | `jev/write-port.ts`、`tool-v2.ts`、`tool-surface.ts`（只改描述）、`memory-tool-surface.json`、`skills/memory-jev/SKILL.md`                                                                                                                                                               | J2, J4               | 打标回显、`partial` 回显、append、Q4 守卫；生产接线在 J7                                       |
| J6  | 召回运行时    | `jev/{wire,segment,config}.ts`（创建）、`src/memory/index.ts`（commandPort 接线）、`inject.ts`、`src/index.ts`（secure 参数 + bashJobs 端口预留）、activate-trace                                                                                                                        | J2, J4               | U/A/E/B、上一条消息（#9）、`·partial`、通知、探测计时器；**静态 core 映射为显式风险点**（#10） |
| J7  | 门禁          | `jev/probes.ts`、`jev/wire.ts`（门禁分支）、`src/memory/index.ts`（J5 write 端口与 J8 doctor 端口的生产接线）、`src/index.ts`（bashJobs 绑定）                                                                                                                                           | J6（及 J5、J8 合入） | 粗筛；证据（仅 Linux）；Jev 判定档、证据档（含 partial，Q33）、判定缓存；release.sh 验收       |
| J8  | 整理与到期    | `jev/{review-command,expired-command,entry-edit}.ts`、`command.ts` 中的 `/mem review`、`/mem expired` 分支、`contracts.ts`、`doctor.ts`、`doctor-command.ts`、`tidy/prompt.ts`、`tidy/command.ts`、`tidy/batch-command.ts`（只透传）、`src/web-hub/agent/command-policy.ts`（review 行） | J4                   | doctor golden 实测不变；周期整理（Q31）；`classifiers` 非空但全部非法时的 warn（Q34）          |
| J9  | 收尾          | web 紧凑分支（可选）、`docs/dev/memory/README.md`、`docs/guide/memory.md`（含非 Linux 退化）、release note（#16）、`AGENTS.md`（pi peer bump checklist 第 2 条加入 C-J1–C-J15）、e2e、全量回归                                                                                           | 全部                 | `git diff origin/dev -- tests/fixtures/` 只出现 §4.5 声明过的文件                              |

**共享文件的串行约束**（评审 #14）：

- `src/memory/command.ts` 与 `src/web-hub/agent/command-policy.ts`：J4 先合入，J8 在其后开工，只追加自己的分派分支或策略行；
- `src/index.ts`、`src/memory/index.ts`：J6 先合入（secure 参数、端口预留、commandPort 接线），J7 在其后（bashJobs 绑定，以及 write/doctor 端口接线）；
- `src/memory/doctor.ts`：J1 先合入（搬出 `SECRET_PATTERNS`），J8 在其后（D17–D19）；
- `jev/wire.ts`：J6 创建，J7 只追加门禁分支；
- 其余文件各只属于一个包。

每个包按 dev-flow 执行：完成后立即验收（验收模型 ≠ 开发模型），通过后按精确路径 commit。

**实施要点**：

- `tool_call` handler 必须整体 try/catch，并在第一个 await 之前完成粗筛；
- 不缓存 `ctx.modelRegistry`；
- 所有 deadline 都经过 `clampSpanMs`，计时器 `unref`；
- `settings.ts` 不新增 import；
- 侧车的合并只在锁内同步完成，Jev 调用绝不放进锁里；
- 工具结果要带上 Jev 调用的 usage；
- 评测集入库前先脱敏。

## 16. 面向用户的技术讲解

> 写给不读代码的人：记忆怎么存，怎么被送到模型面前，Jev 在每一步做什么。

### 16.1 记忆怎么管理

- **存在哪里**：记忆仍是 `~/.pi/agent/memory/<项目>/` 下的 Markdown 文件。`core.md` 每一轮都在模型面前，其它是专题文件。文件里每个列表项（或者一整段、一张表）算作一条「条目」。
- **每条有两类信息**：
  - **你或 agent 写下的权威事实**：写成条目末尾一个不显眼的注释，例如 `<!-- mem user expires=2026-11-30 -->`。手写文件里的条目默认算你的命令，agent 建的文件默认算经验。
  - **Jev 打的标签**：类型、重要度、属于哪些场景、是不是在管危险动作。标签存在一个隐藏的索引文件里，不会改动你的 md 文件。条目内容一改，旧标签就失效，等 Jev 重新打标。
- **场景清单**：场景是一张固定清单（约 22 个，比如推送、发版、删除、派单、测试），Jev 只能从中选择。你可以用 `/mem tags add` 添加自己项目的场景。

### 16.2 Jev 是什么，它做什么，不能用时会怎样

Jev 是一种「分类器」模型：它不会写字，只会做选择题、打分题和是非题，并给出把握有多大。它很快（约 1 秒，不论问 4 个还是 200 个问题），也很便宜。

它出场的四个时刻：

1. **你说话时**：把你的消息（连同上一条消息，用来理解「那发版呢」这类话）和全部记忆交给 Jev，挑出把握 ≥60% 的前 3 条（Q36）。最多等 2 秒（Q37），来不及就晚一点补发。
2. **agent 写记忆时**：判断类型、重要度、场景，并检查有没有和旧记忆重复或矛盾。
3. **每 7 天一次**：在后台找出重复、矛盾、过时的条目，只给你建议。
4. **agent 要做危险动作时**：先用便宜的规则粗筛，真有相关规则时才问 Jev，必要时拦下这个动作。

**Jev 用不了时（部分可用）**：凡是要现场问 Jev 的事都停下：召回、打标、整理、现场判断。不问 Jev 的部分继续工作：

- 「动作快速通道」：agent 执行 `git push` 时，按 Jev 之前打好的「推送」标签，把相关记忆推给它；
- 压缩上下文之后，把刚才用过的记忆补回来；
- 你写了 `gate=hold` 的规则，在证据确凿时照样拦截。

这时 `/mem` 显示 `jev: partial (451) · fast path 142/150 tagged (10-29)`，意思是：Jev 现在不在，系统正在用 10 月 29 日打好的标签工作，150 条里有 142 条有标签。`/mem jev` 会分两栏列出「停了的」和「还在跑的」。这期间推送到对话里的记忆，标记末尾带 `·partial`。如果你从没配过分类器，显示的是 `jev: inactive`，一切和以前一样。如果你把分类器列表清空（`memory.jev.classifiers` 设为空），等于把整个 Jev 功能关掉，连不调用 Jev 的部分也一起停；列表里写的名字全都不对时，也按关闭处理，并会提示你一次。

**在网页端**：查看类命令（`/mem jev`、`/mem tags`）直接执行；会改动状态的命令（如 `/mem jev probe`、`/mem tags add`）会先请你确认；需要逐条点选的 `/mem review`、`/mem expired` 在网页端确认后只列出清单（不做改动），提示你回终端逐条处理。

**第一次启用时**，pi 会提示一次：Jev 已启用，用的是哪个模型，你的消息和记忆摘录会脱敏后发给它，以及怎么查看和关闭。在加密（secure）环境里，Jev 永远关闭。

### 16.3 例 1：你说「帮我推到 GitHub」

1. Jev 收到你的消息和约 140 个是非题（每条记忆一题，例如「`push 前 export https_proxy=…` 这条必须知道吗？」），约 0.9 秒后回答：「push 走代理」0.81，其它都 ≤0.5。于是这一条随你的消息进入模型视野，你会看到 `mem U: pitfalls-git › #3`。
2. 模型执行 `git push`。粗筛命中「推送」场景，core.md 里有一条你写的「push 需用户确认」。系统问 Jev：「这条规则和 `git push origin dev` 是什么关系？」Jev 答 applies 0.83。
3. push 被拦下，模型先来问你。你同意后它重试，这次放行，因为它已经看过规则了。
4. 如果 push 因网络失败，Jev 会从排障经验里挑出能解释这个错误的条目推给模型。
5. 如果当时 Jev 不可用：第 1 步不做；第 2 步改为放行，但会把「push 需用户确认」这条规则标成「未判定」贴给模型，提醒它自己核对。

### 16.4 例 2：release.sh 在后台跑时，agent 执行 git commit

1. 你写过一条规则：「release.sh 运行期间禁止 commit/tag/切分支」，末尾带 `<!-- mem user gate=hold -->`。
2. agent 执行 `git add -A && git commit`。系统收集现场证据：后台任务里有 `job_42 bash scripts/release/release.sh 0.10.3`。只有规则里点名的程序才会被收录，命令行也先脱敏。
3. 系统向 Jev 提一道选择题：unrelated / applies / violates_now。Jev 答 violates_now 0.86，提交被拦下。agent 再试，证据没变，系统直接沿用上次的判定继续拦截，不再问 Jev，也不用等待。
4. release.sh 结束后，证据变了，下一次提交会重新判定，然后放行。
5. **Jev 这一下超时了怎么办**：因为你写了 `gate=hold`，而 release.sh 确实在跑，系统照样拦截，并注明「Jev 未判定，按证据拦截」。没写 `gate=hold` 的规则，在这种情况下放行，但会把规则贴给模型。
6. **macOS 上**：系统不扫描其它进程，只看本会话的后台任务。在另一个终端里手动跑的 release.sh 检测不到，`/mem jev` 会注明这一点。
7. `echo "git commit"` 在粗筛阶段就会放行，因为执行的程序是 echo，不是 git。

### 16.5 例 3：agent 新写一条记忆

1. agent 写下：「gh 命令也要走代理，否则 `gh pr create` 卡住」。
2. 写完后，系统立刻问 Jev 约 50 个问题：类型、重要度、22 个场景、是否在管危险动作、是否临时、像不像你下的命令，以及与最相似的旧条目之间是什么关系。
3. Jev 约 1 秒后回答：经验类，重要；场景为 network（0.86）和 git-push（0.71）；与「push 走代理」互补。agent 看到的回显是：

   ```text
   jev: pitfall 0.90 · important · tags network 0.86, git-push 0.71 · guard 0.15 · permanent
   similar: pitfalls-git.md #3 (complementary 0.74)
   ```

4. 之后 agent 每次执行 `gh pr create`，快速通道都会按标签把这条推给它，不必再问 Jev；即使将来 Jev 不在了也照样生效。
5. 如果 Jev 判断它和你的某条命令矛盾，agent 必须来问你；如果判断它像你的原话，会提醒 agent 标成 `user`。
6. 如果写的时候 Jev 不可用，这条记忆照样存下，只是暂时没有标签。它会计入 `/mem jev` 的「pending」，等 Jev 恢复后自动补上；在那之前，可以手写 `<!-- mem tags=+network -->` 让它立刻生效。

### 16.6 例 4：每周整理发现两条矛盾记忆

1. 距上次整理满 7 天、记忆也改过时，开新会话后系统会在后台把可能相关的两两条目交给 Jev，例如：
   - A：「GPT 系模型临时禁用」（10-12）
   - B：「GPT 系模型已解禁」（10-21）

   Jev 判断 B 取代了 A，把握 0.91。

2. 你会看到提示 `jev 2 suggestions — /mem review`。打开后选「删除被取代的一条」，A 被移进回收站，可以用 `/mem restore --trash` 找回。如果选「保留」，这一对以后不再提示；只改动其中一条的后半段，也不会让它重新出现。
3. Jev 只提建议，删不删由你决定。即使 Jev 之后不可用了，已经生成的建议照样可以查看和处理。

### 16.7 例 5：Jev 突然用不了，又恢复了

1. 换了个网络，后台探测得到 451（地区拦截）。弹出一次提示：`jev partial (451) — 现场判断已停；动作快速通道与压缩后重注继续使用已有标签（142/150）`。
2. 这段时间里：对话不再等待 Jev；危险动作的拦截只剩「`gate=hold` + 证据确凿」这一种；其它相关规则以「未判定」的方式提醒模型。
3. 设置 `memory.jev.proxy` 后 `/reload`，或执行 `/mem jev probe`，探测成功即提示 `jev recovered`，这期间新写的条目会在后台补打标签。

## 17. 评审 r1 处置表

| #   | 处理                                                                                                                                             | 落点                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| 1   | 采纳（Q29 分档）                                                                                                                                 | §6.4.5、§14.1           |
| 2   | 采纳（主会话裁定：首次转入 full 时通知）                                                                                                         | §5.3、§10               |
| 3   | 采纳（Q30：仅 Linux，非 Linux 写明退化；不做 `ps` 兜底）                                                                                         | §6.4.2、§9.4、§16.4     |
| 4   | 采纳：统一为约 172 次调用、约 $0.02、40–60 秒                                                                                                    | §0、§4.5、§6.2.3        |
| 5   | 采纳：按证据指纹缓存判定（覆盖全部判词，不只 hold）                                                                                              | §6.4.4、§5.5            |
| 6   | 采纳，位置调整：`secret` 标记放在按目录指纹缓存的内存条目索引里，随 hash 失效；本地扫描很便宜，不持久化到侧车                                    | §4.1、§7.2              |
| 7   | 采纳：dismissed 同时记 hashKey 和 anchorKey（file + section + 正文前 24 码点），任一相同即视为已忽略；改写开头会重新提示，作为已知取舍写明       | §4.4、§16.6             |
| 8   | 采纳：默认列表只含实测过的两个 opencode id，openrouter 项待 J0（C-J15）探测后定稿。另注明：`models.md:149` 其实列有 jev-1.14                     | §5.2、§9.1              |
| 9   | 采纳：附带上一条用户消息（600 码点，脱敏）                                                                                                       | §6.1.1、§7.1            |
| 10  | 采纳：在条目上记录 `section`，按小节映射静态 core；J6 将其列为显式风险点；评测集加反例                                                           | §4.1、§6.1.1、§10、§15  |
| 11  | 采纳：评测集加 `git checkout -b`/`git stash` 正例；先用判定缓存压低噪音，视评测结果再决定是否拆出 `git-branch`                                   | §4.3.2、§6.4.4、§10     |
| 12  | 采纳：`probe()` 和 `/mem jev probe` 强制刷新可用集缓存                                                                                           | §5.1、§5.2、§5.3        |
| 13  | 采纳：定义表格、引用块、HTML 块的切分行为，并补测试                                                                                              | §4.1、§10               |
| 14  | 采纳：写明共享文件的串行约束                                                                                                                     | §15                     |
| 15  | 采纳（Q32）                                                                                                                                      | §1.3、§4.2、§4.3、§9.3  |
| 16  | 采纳：在 J9 的 release note 中说明                                                                                                               | §8、§15                 |
| D1  | 按用户决定 Q25（与评审一致）                                                                                                                     | §6.1.1                  |
| D2  | 按 Q29 分档（采纳评审建议）                                                                                                                      | §6.4.5                  |
| D3  | 按 Q26 **保留零调用部分**（与评审和 v1 的推荐相反）；评审担忧的「双状态心智负担」通过状态名、覆盖率、功能分栏、`·partial` 标记和 `inactive` 化解 | §3.3、§5.3、§9.2、§16.2 |
| D4  | 按 Q27 默认开启，附首次启用通知（评审的附加条件）                                                                                                | §5.3、§9.1              |
| D5  | 按 Q28，口径已统一（评审的附加条件）                                                                                                             | §6.2.3                  |
| D6  | 按 Q31                                                                                                                                           | §6.3.1                  |
| D7  | 按 Q30：脱敏断言写进集成测试；非 Linux 写明退化                                                                                                  | §6.4.2、§7.1、§10       |

## 18. v2 变更记录（2026-10-30）

| 位置           | 变更                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 头部、§0       | 版本升到 v2；结论速览按 Q25–Q32 改写；规模与拍板行更新                                                                                                        |
| §1.2、§1.3     | 「硬依赖」细化为「需要 Jev 的功能」；新增 Q32 推迟/删除清单                                                                                                   |
| §2             | 行号校正（`settings.ts:417-433`）；补充 `models.md:149`                                                                                                       |
| §3.3（新）     | 功能分类表：需要 Jev / 零调用 / 确定性                                                                                                                        |
| §4.1           | 新增块级结构规则、`section`/`secret`/`namedPrograms` 字段、内存条目索引缓存                                                                                   |
| §4.2、§4.3     | hold 只认行内声明；TagDef.source 去掉 agent；rev 只随 description 变化；git-history 噪音注记                                                                  |
| §4.4           | 删除 `gateMode`；新增 `lastTaggedAt`、标签时效规则、覆盖率、dismissed 双键                                                                                    |
| §4.5           | 迁移口径统一为约 172 次调用；`memory-tool-surface.json` 只新增描述 key                                                                                        |
| §5.1–§5.3      | probe 强制刷新可用集缓存；默认列表只含实测过的 id；状态机改为 off/probing/full/partial（含 inactive 显示形态）；新增通知表（含首次 full）；预算表增加判定缓存 |
| §6.1           | U 层附带上一条消息，静态 core 映射，>360 条改为本地预筛；A/B 层明确为零调用、partial 下继续，并加 `·partial` 标记                                             |
| §6.2           | 删除 `m_gatemode`；单次问题数约 50；批量打标口径；新增 partial 回显                                                                                           |
| §6.3           | 周期整理（Q31）；已有建议的查看与执行为零调用，并处理过期建议                                                                                                 |
| §6.4           | 粗筛步骤 5（跳过已闩锁的条目）；点名程序提取；仅 Linux 与退化说明；判定缓存；新增 §6.4.5 证据档（Q29），并适用于 partial（N1）                                |
| §7             | 增加上一条用户消息的截断行；进程命令行脱敏的测试断言                                                                                                          |
| §9             | 默认值按 Q25/Q27/Q31；classifiers 默认值改为两项；I9 论证按 partial/inactive 改写；工具面只改描述；`/mem jev` 示例改为分栏                                    |
| §10            | 新增 #5/#6/#7/#9/#10/#11/#12/#13 及 Q29/裁定/非 Linux 的用例；新增 C-J15                                                                                      |
| §11–§13        | 决策、处置、风险三表随上述改动更新                                                                                                                            |
| §14            | 改为已拍板表；新增待拍板 N1                                                                                                                                   |
| §15            | 依赖图调整（J8 只依赖 J4）；共享文件串行约束；J5 去掉 `tag_add`；J7 增加证据档与缓存                                                                          |
| §16            | 增加部分可用、首次启用通知、D2 分档、仅 Linux 的通俗说明；各例同步更新                                                                                        |
| §17、§18（新） | r1 处置表与本变更记录                                                                                                                                         |

## 19. v2.1 勘误记录（2026-10-30）

只修正表述与实施之间的落差，不改设计意图。来源：`jev-plan.md` §10（下表记作「方案 §10 #n」）、`jev-plan-review-r1.md`（「评审 #n」）、`hygiene-flow.md` 第九轮拍板。

| #   | 来源                            | 勘误                                                                                                                                                                                                                                                                                              | 落点                                         |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1   | 方案 §10 #1                     | 金样本表补 `tests/config/__corpus__/settings-corpus.json`（新增键须重 pin，先例 `4758bae5`）                                                                                                                                                                                                      | §4.5                                         |
| 2   | 方案 §10 #2、评审 #5            | `off(pi-api)` 改为「注册但钩子空转」，写明它不在 I9 settings-off 字面承诺内；设置期四条 off 路径仍零注册；off-harness 增加第 5 个重放配置作证明                                                                                                                                                   | §0、§5.3、§9.2                               |
| 3   | 方案 §10 #3、评审 #3            | 模块清单补 7 个 pi-free 文件（config/tagging/command-port/write-port/review-command/expired-command/entry-edit）；`expiredEntries` 归 J1；文件域补 `command-policy.ts`（J4→J8）、J7 改 `src/memory/index.ts`、`tidy/command.ts` 与 `tidy/batch-command.ts` 归 J8；依赖图与方案批次对齐            | §3.1、§15                                    |
| 4   | 方案 §10 #4                     | C-J1–C-J15 进 AGENTS.md peer bump 清单，由 J9 负责                                                                                                                                                                                                                                                | §13、§15                                     |
| 5   | 方案 §10 #5、评审 #1            | 召回 0.7、门禁 0.6 标注「J0 基线评测后可能调整，调整需回本稿并问用户」                                                                                                                                                                                                                            | §9.1                                         |
| 6   | 方案 §10 #6                     | `memory.jev.confirmTimeoutS` 登记 `TIME_SETTING_MS_PATHS`（J3）                                                                                                                                                                                                                                   | §9.1                                         |
| 7   | 方案 §10 #7、Q33                | N1 改为已拍板（适用）                                                                                                                                                                                                                                                                             | §0、§6.4.5、§14.2                            |
| 8   | 方案 §10 #8、评审 #6、Q34       | `classifiers` 为空列表 = off（零调用部分也不生效）；非空但全部非法时同样 off 并给 warn；§3.3 确定性部件改为「只受总开关与接线判定控制」；empty-list 留在 off 行                                                                                                                                   | §3.3、§5.3、§6.2.5、§9.1、§9.2、§14.3、§16.2 |
| 9   | 评审 #2、Q35                    | web 端：改动状态的子命令改为需要确认，只有纯终端交互、无文本回退的才拒绝；`tags` 裸形式允许                                                                                                                                                                                                       | §6.3.4、§9.4、§14.3、§16.2                   |
| 补  | 实施方案复审 r2 B1/B2（主会话） | §6.3.4、§9.4：web 端 `review`/`expired` 改为确认后降级为只读清单，本期无 deny 行；§5.3：pi-api 证明改为逐字段比对 + `PI_API_ALLOWED_DIFF`，消除同段矛盾                                                                                                                                           |
| E1  | E0 评测基线、Q36（主会话）      | §6.1.1 召回题措辞改为「现在提醒这条是否有助于正确处理请求或避免已知错误」；召回阈值 0.7 → 0.6（§6.1.1、§9.1）                                                                                                                                                                                     |
| Q37 | hygiene-flow 第十一轮（主会话） | 召回同步等待改为整数秒键 `memory.jev.recall.waitS`（0–3 秒，默认 2，0 = 纯异步）；内部仍 `recall.waitMs`（默认 2000）经 `TIME_SETTING_MS_PATHS` 换算（J3 登记先例）                                                                                                                               | §9.1                                         |
| 13  | J4 报告（root 批准）            | 契约补充（均可选、向后兼容，定义在 `jev-plan.md` §4 J4）：`tagBulk` 增 `onEntryTags?`/`base?`；`runReviewPass` 增 `project?`/`signal?`（返回型收窄为 `ReviewPassResult = ReviewState \| Extract<JevOutcome,{ok:false}>`）；`createJevCommandPort` deps 增 `config?`/`usage?`/`segment?`/`health?` | jev-plan §4 J4                               |
| 14  | J4 报告（root 批准）            | `TAG_MAJOR_BATCH_TOKENS = 20_000`：§5.2「每批 ≤12,000 token」的例外，仅用于标签为主的批量题，保障约 150 条 + 22 标签 = 172 次（opencode 上下文 32k，估算偏保守，超限有拆半兜底）                                                                                                                  | §5.2                                         |
| 15  | J0 报告、evaluated              | `/mem` 描述在有 jev 端口时追加 ` · /mem jev · /mem tags`；补全追加 review/expired；off-golden `PI_API_ALLOWED_DIFF` 已登记全部四项                                                                                                                                                                | §5.3、§9.2                                   |
| 16  | eval/jev-baseline.md C-J8       | §5.2 上下文超限关键词补 `max_tokens_exceeded`（E0 实测：HTTP 400 `{"detail":{"error_type":"max_tokens_exceeded"}}`），去掉「实际措辞需 P0 验证」                                                                                                                                                  | §5.2                                         |
| 17  | J2 报告、`510a0678`             | 单档超时 = 该模型瞬态失败 ⇒ 换下一档；只有调用方 abort 才是 `aborted`                                                                                                                                                                                                                             | §5.2                                         |
| 18  | eval/jev-baseline.md 阶段二     | 门禁阈值 0.6 维持（jev-1.13 动作 34/38、零漏拦）；已知误拦形态（发版中 echo/grep 文本含 git commit）在生产路径被 shell-parse + 标签粗筛挡住，不询问 Jev                                                                                                                                           | §6.4.4                                       |
| 19  | J0 报告                         | C-J4 结论：`sendMessage(triggerTurn:false)` 在 turn_end flush，本 run 下一次 LLM 调用可见（§6.1.3 原假设成立）                                                                                                                                                                                    | §10                                          |
| 20  | J6 报告                         | E 层把 pending（未打标）条目也当候选；`/mem tags add\|enable` 触发的批量打标重问全部标签（约 22 次）                                                                                                                                                                                              | §6.1.4、§6.2.3                               |
| 21  | J6/J7 报告                      | J6 报告的前提不成立：流式中经 steer 送进来的 bash-job 通知会触发 `message_start`，现有钩子已覆盖，无需轮询 bashJobs 端口                                                                                                                                                                          | §6.1.4                                       |
| 22  | J5 报告                         | 用户令守卫域 = str_replace/insert/write/append/create 覆写/**delete**，另加「手写→非手写 provenance 翻转」与「未归档→归档」两条判定；rename 不守卫；与打标触发域（五个写操作）区分开                                                                                                              | §6.2.5                                       |
| 23  | J1 报告、`31e845ce`             | shell-parse 把含 `c` 的解释器短旗标集群（`-lc`/`-ic`/`-xec`）视为 `-c`                                                                                                                                                                                                                            | §6.4.2                                       |
| 24  | J9 自检                         | 以上 1–23 均已核对代码/报告一致；未发现与实施冲突的额外条目                                                                                                                                                                                                                                       | §19                                          |
