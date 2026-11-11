# Jev Reflex（R 层）· 实施计划 v1（只读 MVP）

> 状态：**实施计划**（无代码）· 日期 2026-11-04
> 输入：`docs/dev/jev-reflex/arch.md`（下称 A，**设计以 A 为准**）、`docs/dev/jev-reflex/feasibility.md`（下称 F）。
> 必读（实施前按 AGENTS.md 硬规则）：`AGENTS.md`（I1–I12、Frozen artifacts、pi peer bump checklist）、
> `docs/dev/subagent-core/README.md`（Stack teardown 一节）、`docs/dev/data-encryption/README.md`（D8 清单）、
> `docs/dev/topic-switch/README.md`（I1–I6 + 注册顺序）、`docs/dev/memory/README.md`（Jev 不变式 3：classify 单一调用点）、
> `docs/dev/sysprompt-stable/README.md`（确认 R 层与之零交集）。
> 车道：**L3**（新模块 + 跨 6 处既有面 + 多包并行）。
> 修订：**r2**（2026-11-04，闭合评审 7 条：§10 列出每条的修订位置）。

---

## 0. 用户已拍板（实施不再开问）

| #   | 决策                                                                                                           | 落点                                             |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| U1  | 只读 MVP；`reflex.enabled` 默认 `false`；先 shadow                                                             | R0 设置、R2b shadow                              |
| U2  | 首批 port 仅 `jobs.list` / `fleet.status` / `quota.summary` / `git.status`；`sessions.recent` 进 R4（可选）    | R2a、R4                                          |
| U3  | 命中答案写入模型上下文：`sendMessage`（custom message，user 角色）+ 问题/结果短消息                            | R3a，格式见 §5                                   |
| U4  | autoresolve in-band 等待上限 **1.2s**（`REFLEX_BUDGET_MS = 1200`）                                             | R1 `core/budget.ts`                              |
| U5  | 晋升门槛：同一 `scriptId@scriptVer` **≥50 条候选**、port 成功率 **≥99%**、分歧 **≤5%**、重复提问 / 纠正 **=0** | R1 `core/promotion.ts`（**覆盖 A §4.8 的 ≥20**） |
| U6  | 晋升只能人工改设置（`reflex.autoResolve`）；只自动降级不自动升级                                               | R0 设置 + R3a 状态机                             |
| U7  | 复杂任务、写类脚本、argv 脚本、提取器自动启用不进 MVP                                                          | 全局冻结（§2 冻结面）                            |

## 1. 本计划新增的决策（相对 A 的细化 / 偏差，均为保守方向）

| #    | 决策                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 理由                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PD1  | **R0 一次性冻结全部"注册面 + 契约类型"**：6 项注册（input / agent_settled / session_start / session_shutdown / renderer / command；session_start 用于多会话 re-arm，见 PD11）、`core/types.ts`、`core/settings.ts`、`ports/index.ts` 的接口在 R0 落地；后续包只填行为，**不再动 trace / 设置 / index.ts**                                                                                                                                                                                                                                                                                                                                                                                   | 热点共享文件（`src/index.ts`、`src/config/settings.ts`、`setting-specs.ts`、`activate-trace.json`、corpus/pin、`AGENTS.md`）只被一个包碰一次，避开与 fabric #14 / schedule #16 的反复冲突                                                           |
| PD2  | A 的 R2 拆成 **R2a（ports，可与 R1 并行）** 与 **R2b（shadow 接线 + `/reflex status/explain`）**；A 的 R3 拆成 **R3a（autoresolve）** 与 **R3b（跨会话 shadow 汇总 + 晋升判定脚本，必做）**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ≥50 条候选在单会话内基本攒不齐，晋升判定必须跨会话汇总；A 把它放在可选 R4，会让"必做"路径缺少晋升依据。R4 只保留意图聚类 / 草案 / `sessions.recent`                                                                                                 |
| PD3  | **pi-free 门禁用"值闭包"扫描**（`tests/boundary/pi-free.test.ts` 现有 `memoryOffenders` 同款），而**不是**加进 `["core","prompt-sections","git"]` 目录循环                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 该循环要求"只 import node:* 或本目录相对文件"，而 `reflex/core` 需要 import `topic-switch/filters.ts`、`memory/jev/predict/{clauses,shape}.ts`、`memory/jev/redact.ts`、`core/{clock,deadline}.ts`——这些都已核实 pi-free，但不在本目录              |
| PD4  | **`src/reflex/ports/**` 也加值闭包 pi-free 门禁**；`jobs.list` **不复用** `renderBashJobsSection`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `src/commands/status.ts` 值导入 `@earendil-works/pi-coding-agent`（`formatSize`），复用会把 pi 拉进 ports。改用 `src/bash/types.ts` 的 `previewCommand`/`isTerminalJobStatus`/`describeJobStatus` + `src/core/format.ts` 的 `formatDuration` 自渲染 |
| PD5  | **AUTO 态下出现 repeat 或 correction ⇒ 立即降级为 DEMOTED**（与 strike 降级共用覆盖层，`reason:"repeat"\|"corrected"`），并 `ui.notify` 一次                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | A §4.7 只在 error/timeout 降级；但 U5 把"重复提问/纠正=0"定为晋升硬门槛，晋升后出现一次即说明门槛已破。降级方向只损失速度，符合 D9                                                                                                                  |
| PD6  | shadow 期的"重复提问"用 record 字段 `reasked?: true` 计：同一 `requestDigest` 在 `REPEAT_WINDOW_MS`（10min）内**再次成为同一脚本候选**；"纠正"**独立记账并立即持久**为 `subagent:reflex-correction` 条目（`ReflexCorrectionV1`，PD12），不再挂在下一条 record 上                                                                                                                                                                                                                                                                                                                                                                                                                            | A 的 `kind:"repeat"` 只在 reflex 已作答后才可能出现，shadow 期恒为 0，无法支撑 U5 的门槛；两个字段都是 R0 冻结的 record 字段，追加式                                                                                                                |
| PD7  | `activate-trace` **只改 `max` 档**；`thread-main` / `thread-child` 档**不加** reflex                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | thread 档归 fabric（#14 在役），加进去会和它的 trace 刷新互相覆盖；`max` 已足够钉住注册面。`tests/integration/stack-teardown-matrix.test.ts` 的 FULL 档展开 `PROFILES.max`，R0 同步把 shutdown 计数 15→16                                           |
| PD8  | `reflex-off-golden.json` **只在 #14、#16 均已提交、`git status --short` 输出完全为空（含未跟踪文件）的 dev HEAD 上捕获**，再落实现（thread-off golden 的先例）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | A 级金身"永不重生"，必须证明是 reflex 引入前、且不含他人在役改动的字节；#16 会删掉 schedule surface 的 input / before_agent_start / ui_prompt_* 钩子，提前捕获会把它们冻进 golden                                                                   |
| PD9  | 时钟统一用 `src/core/clock.ts` 的 `Clock`（生产 `systemClock`，已 unref + 分段；测试 `FakeClock`），耗时测量用注入的 `monoNow()`（默认 `performance.now`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | I1/I5 现成合规；A §4.2 的 `{now,setTimer}` 形状换成仓库既有接口                                                                                                                                                                                     |
| PD10 | `/reflex status` 只汇总**本会话** `getBranch()` 的记录 + 本激活计数；跨会话晋升判定只在 R3b 的离线脚本里做，二者共用 `core/promotion.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | D8（不建跨会话统计文件）；状态命令不做目录扫描（I/O 不可控）                                                                                                                                                                                        |
| PD11 | **单激活多会话 re-arm**：pi 在同一激活内切换会话时先发 `session_shutdown` 再发 `session_start`，**同一闭包继续服务新会话**。`session_shutdown`：abort 当前 `AbortController`、丢弃 pending、`disposed=true`、`generation++`；`session_start`：`disposed=false`、新建 `AbortController`、清残留 pending / 最近候选与作答记忆（repeat / correction 窗口都绑定本会话 transcript）、`inFlight=false`。**同步入口（input、agent_settled、command）不检查 `disposed`**；只有 async 迟到 settle（shadow microtask 的 port 结果、AUTO await 之后的续体）检查 `disposed \|\| gen !== currentGen`，不符即丢弃。脚本降级覆盖层（strikes/demoted）跨会话保留到 `/reload` 或 `/reflex reset`（保守方向） | 评审 Blocker 1：只置 `disposed=true` 会让新会话的 R 层永久哑火；`stack-teardown-matrix` 的 same-module new/resume/fork 路径证明了 shutdown→start 复用同一激活                                                                                       |
| PD12 | **correction 独立持久**：检测到纠正（见 R2b 步骤 1）时**在 input 同步段内立即** `pi.appendEntry("subagent:reflex-correction", ReflexCorrectionV1)`，与本输入随后是 veto / miss / 命中无关；每个目标（最近一条候选或作答）至多记一次                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 评审 3：挂在"下一条 record"上时，纠正句本身（如"不对"）几乎必然被短口令否决，下一条 record 可能永远不出现，计数会丢                                                                                                                                 |

## 2. 冲突规避（fabric #14、schedule #16 在役）

**实测**（2026-11-04 23:24 `git status --short`）未提交改动（#14 / #16）：`src/index.ts`（删 schedule confirm 接线 6 行）、`src/commands/{fabric-xs,schedule}.ts`、`src/fabric/xs/{receiver,stack}.ts`、`src/schedule/agent/{coordinator,dispatch,ops,status,surface,view,wire}.ts`（删除 `confirm.ts`；`surface.ts` 删掉 `input`/`before_agent_start`/`ui_prompt_start`/`ui_prompt_end` 四个钩子）、`src/schedule/core/{claim,occurrence,spec}.ts`、`src/sysprompt/schedule-section.ts`、`src/tools/schedule-tool.ts`、`src/web-hub/agent/{command-policy,connection,index,xs}.ts`、`src/web-hub/hub/{agent-server,assembly-channels,audit}.ts`、`src/web-hub/hub/feishu/{schedule,service}.ts`（删除 `schedule-confirm.ts`）、`src/web-hub/hub/schedule/{feishu-port,project,service}.ts`、`src/web-hub/hub/xs/router.ts`（新增 `activation.ts`）、`src/web-hub/protocol/schedule.ts`、`src/web-hub/ui/src/**`（schedule 组件 / i18n / logic / styles）及对应 `tests/**`；未跟踪 `docs/dev/jev-reflex/`、`docs/dev/schedule-auto-approve/` 等。**结论：`src/index.ts` 已在役，且 #16 会改变 `max` 档 trace 与 teardown 计数。**

| 规则 | 内容                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1   | 所有 R 包**永不触碰**：`src/fabric/**`、`src/web-hub/**`、`src/schedule/**`、`src/sysprompt/**`、`src/tools/**`、`src/commands/**`（含 `status.ts`）、`src/topic-switch/**`、`src/memory/**`、`src/git/**`、`src/bash/**`、`src/quota/**`、`src/service/**`、`src/ui/**`、`tests/fixtures/` 既有文件、`thread-*` trace 档                                        |
| X2   | 热点共享面（`src/index.ts`、`src/config/settings.ts`、`src/config/setting-specs.ts`、`tests/config/__corpus__/*`、`tests/fixtures/governance/activate-trace.json`、`tests/governance/trace-profiles.ts`、`tests/integration/stack-teardown-matrix.test.ts`、`tests/secure/settings-override.test.ts`、`tests/boundary/pi-free.test.ts`、`AGENTS.md`）**只归 R0** |
| X3   | R0 **开工前**确认 #14、#16 已提交到 `dev`，且 `git status --short` **输出完全为空**（主会话先把 `docs/dev/jev-reflex/` 等文档精确提交）。**不满足则 R0 一行都不开工**（off golden 捕获同样必须等，PD8）；R0 的冲突预检 spec 见 §8，必须对照届时的 `git status` 实测在役路径跑                                                                                    |
| X4   | trace / pin / corpus 三个可刷新产物**只在 rebase 到最新 dev 之后重新生成**，绝不手工合并 JSON；若 #16 后来又改了 trace（"彻底移除批准概念"可能删 confirm 钩子），R0 rebase 后重跑 `PI_TOOLKIT_UPDATE_TRACE=1`，评审只接受 `max` 条目里 reflex 的 5 行 diff                                                                                                       |
| X5   | 多写包并行前主会话**真跑** `node skills/dev-flow/scripts/conflict-check.mjs <spec> --cwd /home/bluecake/ai/pi-toolkit`（spec 见 §8）                                                                                                                                                                                                                             |
| X6   | 提交一律精确路径（禁 `git add -A`）；R 包全部完成后一次 push（core.md 规则）                                                                                                                                                                                                                                                                                     |

## 3. 包总览与依赖

```
R0（契约 + 关着的骨架，独占热点面）
 ├──► R1（pi-free 核心：gate/match/catalog/state/render/agreement/promotion/…）   ┐ 并行
 └──► R2a（4 个只读 port + executePort + git porcelain 解析）                       ┘
          R1 + R2a ──► R2a′（收敛提交：executePort 改用 core/budget.ts 的 raceBudget）──► R2b（shadow 接线 + /reflex status|explain）
                         ├──► R3a（autoresolve：S2 in-band、命中消息、降级、repeat/correction）  ┐ 并行
                         └──► R3b（跨会话 shadow 汇总 + 晋升判定脚本，Tier 3）                 ┘
 R1 ──► R4（可选：意图聚类 / 候选草案报告 + sessions.recent），可与 R2b/R3a/R3b 并行
```

| 包   | 必做 | 依赖    | 并行对象      | 唯一 owner（dev 模型建议 / 异源 verifier）         | 规模（含测试） |
| ---- | ---- | ------- | ------------- | -------------------------------------------------- | -------------- |
| R0   | ✅   | —       | —（串行闸口） | dev:R0 · sonnet（热点面细活）/ verifier glm-5.3    | ~600 行        |
| R1   | ✅   | R0      | R2a           | dev:R1 · glm-5.3 / verifier kimi-k3                | ~1,400 行      |
| R2a  | ✅   | R0      | R1            | dev:R2a · gpt-6.1-sol / verifier glm-5.3           | ~700 行        |
| R2a′ | ✅   | R1, R2a | —             | dev:R2a 原 run resume（同 owner）/ verifier 同 R2a | ~60 行         |
| R2b  | ✅   | R2a′    | —             | dev:R2b · sonnet / verifier glm-5.3                | ~800 行        |
| R3a  | ✅   | R2b     | R3b           | dev:R3a · glm-5.3 / verifier kimi-k3               | ~800 行        |
| R3b  | ✅   | R2b     | R3a           | dev:R3b · gpt-6.1-sol / verifier glm-5.3           | ~500 行        |
| R4   | 可选 | R1      | R2b/R3a/R3b   | dev:R4 · glm-5.3 / verifier deepseek-flash         | ~700 行        |

> verifier 必须与 dev 异源且非 GPT 系（dev-flow 规则 5）；表中仅为建议，主会话按当时额度用回退链替换。
> （该约束已于 2026-11-09 解除：GPT 系可参与验收，仍须与开发模型异源）

---

## 4. 分包细则

### R0 · 契约冻结 + 关着的骨架

**文件域（独占）**

- 新建：`src/reflex/core/types.ts`、`src/reflex/core/settings.ts`、`src/reflex/setting-specs.ts`、`src/reflex/ports/index.ts`（**仅接口 + 空 registry 工厂**）、`src/reflex/wire.ts`（骨架）、`src/reflex/command.ts`（骨架）、`src/reflex/render-tui.ts`（renderer 骨架）、`docs/dev/jev-reflex/README.md`
- 新建测试：`tests/integration/reflex-off-golden.test.ts`、`tests/fixtures/reflex-off-golden.json`（A 级新金身）、`tests/conformance/reflex.test.ts`（C-R1…C-R8）、`tests/config/reflex-settings.test.ts`、`tests/reflex/wire-skeleton.test.ts`
- 修改（热点，X2）：`src/index.ts`、`src/config/settings.ts`、`src/config/setting-specs.ts`、`tests/config/__corpus__/setting-specs-pin.json`、`tests/config/__corpus__/settings-corpus.json`、`tests/governance/trace-profiles.ts`（仅 `max`）、`tests/fixtures/governance/activate-trace.json`（仅 `max` 条目）、`tests/integration/stack-teardown-matrix.test.ts`（仅 FULL 档 shutdown/start 计数与注释）、`tests/secure/settings-override.test.ts`（加两条断言）、`tests/boundary/pi-free.test.ts`（加 reflex core/ports 两条闭包门禁）、`AGENTS.md`

**冻结面**：X1 全部；`src/reflex/core/types.ts` 一经 R0 验收即冻结（后续只许追加，改动须回主会话裁定）。

**步骤**

1. **先捕获 off golden（PD8）**：前置检查 `git status --short` 为空、`git log origin/dev..HEAD` 为空且 #14/#16 已在 dev；然后在该 dev HEAD 上写 `tests/integration/reflex-off-golden.test.ts`，生成闸用环境变量 `PI_TOOLKIT_REFLEX_GOLDEN_CAPTURE=1`，**文件已存在则拒绝覆盖**（bash-tools golden 同款）。四个场景：`default`（无设置）、`{reflex:{enabled:false}}`、secure 模拟域（`{reflex:{enabled:true}}` + secure verdict）、`child`（HOST_KEY 预占 + `{reflex:{enabled:true}}`）。每场景记录：工具表、命令表、逐事件 handler 计数、`registerMessageRenderer` 列表、system prompt（`before_agent_start` 链输出）、对 `"后台还有几个 job"` 的 interactive 输入跑完整 input 链后的 `sendMessage`/`appendEntry` 记录中 `subagent:reflex*` 条目数（必须 0）。捕获于未改代码 ⇒ 天然证明"关=今天"。
2. `src/reflex/core/types.ts`：按 A §4.3–§4.8、§4.10 原样落 `PortId`、`Capability`、`RScriptV1`、`PortEnv`、`PortOutcome`、`ExecOutcome`、`GateFacts`、`VetoCode`、`Band`、`MatchResult`、`ScriptState`、`ScriptRuntime`、`Agreement`、`ReflexAnswerDetailsV1`、`ReflexRecordV1`、`ReflexDisambiguator`，并按 PD5/PD6 追加：
   - `ScriptRuntime.demoteReason?: "strikes" | "repeat" | "corrected"`
   - `ReflexRecordV1.reasked?: true`（shadow 重复提问，PD6）；**删除** A 中的 `prevAnswerCorrected`（改由 PD12 独立条目承担）
   - `ReflexCorrectionV1 { v:1; at:number; targetKind:"shadow"|"answer"; targetScriptId:string; targetScriptVer:number; targetDigest:string; deltaMs:number; correctionDigest:string }`（`appendEntry("subagent:reflex-correction", …)`，不存原文）
   - `ReflexStatusSnapshot`（`/reflex status` 与测试用只读快照）
3. `src/reflex/core/settings.ts`：`ReflexSettings`、`DEFAULT_REFLEX_SETTINGS`（冻结）、`parseReflexSettings(input: unknown)`（逐字段回退、永不抛；`autoResolve` 接受 csv 字符串或字符串数组，trim、去空、去重、保序）。
4. `src/reflex/setting-specs.ts`：`REFLEX_SETTING_SPECS = { "reflex.enabled": bool(...), "reflex.autoResolve": { ...csvString("reflex.autoResolve", ...), live: true } }`。描述用英文短句（UI 语言规则）。
5. `src/config/settings.ts`：`AgentSettings.reflex`、`DEFAULT_SETTINGS.reflex = { ...DEFAULT_REFLEX_SETTINGS }`、`parseSettingsSource` 加 `reflex: parseReflexSettings(value.reflex)`（紧跟 `topicSwitch` 之后）；`applySecureDomainOverrides` 在 `memory` 行后加 `reflex: { ...settings.reflex, enabled: false }`，注释 `jev-reflex arch §4.1（I11/D8）`。
6. `src/config/setting-specs.ts`：import 并在 `...SCHEDULE_SETTING_SPECS` **之后**（对象末尾）展开 `...REFLEX_SETTING_SPECS`，不改动既有顺序。
7. `src/reflex/ports/index.ts`：`ReflexPort`、`ReflexPortDeps`、`PortRegistry` 接口 + `createPortRegistry(deps)` 的**空实现**（`get` 恒 undefined、`capabilities` 空集）+ `executePort` 签名占位（R2a 填）。依赖类型只 `import type`（`JobRecord` from `src/bash/types.ts`、`QueryService` from `src/service/query-service.ts`、`QuotaService` from `src/quota/service.ts`、`GitRunner` from `src/git/run.ts`）。
8. `src/reflex/wire.ts`：`wireReflex(pi, deps): ReflexWiring | undefined`。守卫：`deps.secureDomainKind !== "plain"` ⇒ `return undefined`（零注册）。注册顺序**固定**为：① `pi.on("input")`（R0 恒 `{action:"continue"}`，try/catch fail-open；**普通非 async 函数**）② `pi.on("agent_settled")`（空）③ `pi.on("session_start")`（PD11 re-arm：`disposed=false`、新 `AbortController`、清 pending 与窗口记忆、`inFlight=false`）④ `pi.on("session_shutdown")`（abort、丢 pending、`disposed=true`、`generation++`）⑤ `typeof pi.registerMessageRenderer === "function"` 时注册 `"subagent:reflex"` → `renderReflexMessage`（`render-tui.ts` 骨架）⑥ `pi.registerCommand("reflex", createReflexCommand(...))`（骨架：只回 "reflex: enabled (skeleton)"）。所有可变状态在闭包内（I4）；闭包里有 `generation` 计数器，R0 即落地 `isStale(gen) = disposed \|\| gen !== generation` 供后续包的 async 续体使用。
9. `src/index.ts`（I2，仅装配）：在 web-hub 块（`if (settings.webHub.enabled) {…}`）**结束之后**、`// topic-switch … registered LAST` 注释块**之前**插入：
   ```ts
   // jev-reflex arch §4.2/§4.9 (D2): R 层注册在 web-hub 之后、topic-switch 之前——R 层只答零成本自省问题，
   // 回退 = continue（原文无损交给 topic-switch）；topic-switch hold/releasing 时 R 层经 fence 退让。
   // post-guard（子会话 prompt 也报 source:"interactive"，F §2.7 / C-R5）。off ⇒ 不调用（I9）。
   const reflexFence: { topicSwitch?: () => boolean } = {};
   if (settings.reflex.enabled) {
     wireReflex(pi, {
       settings: () => settings.reflex,
       secureDomainKind: secureDomain.kind,
       ports: {
         bashJobs: () => holder.current?.bashJobs,
         fleet: () => holder.current?.query,
         quota: () => holder.current?.quota,
         git: createGitRunner(),
       },
       fences: {
         topicSwitchActive: () => reflexFence.topicSwitch?.() ?? false,
         goalBusy: () => {
           const s = holder.current?.goal.record?.state;
           return s === "active" || s === "paused";
         },
       },
     });
   }
   ```
   并在 topic-switch 块内 `xsFencePorts.topicSwitch = …` 下一行加 `reflexFence.topicSwitch = () => topicSwitch.fenceActive();`（`xsFencePorts` 晚绑定先例）。`createGitRunner` 从 `./git/run.js` import；secure 域 `settings.reflex.enabled` 已被强制 false，`secureDomainKind` 守卫是双保险。
10. `tests/governance/trace-profiles.ts`：`max.settings` 加 `reflex: { enabled: true }`，头注释 `max` 清单补 `reflex`；`PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance` 刷新；**只接受 `max` 条目的 diff**（input 一行插在 session-nav input 与 topic-switch input 之间；agent_settled / session_start / session_shutdown / renderer / command 各一行，共 6 行）。必须在含 #16 的 dev 上刷新（#16 自身会删掉 schedule surface 的 4 个钩子，那部分 diff 归 #16 的提交，不进 R0）。
11. `tests/integration/stack-teardown-matrix.test.ts`：FULL 档 `session_shutdown` 与 `session_start` 计数**在 #16 落地后的基线上各 +1**（以 R0 rebase 后的实测基线为准；按今日源码为 15→16、17→18），注释补 "reflex shutdown abort / session_start re-arm"；BASELINE 档计数不变。另在 same-module new/resume/fork 用例旁**不加**断言（reflex 的 re-arm 行为由 `tests/reflex/wire-skeleton.test.ts` 钉住，不扩大 matrix 的文件面）。
12. 设置语料：pin 用 `GOV_SPECS_GENERATE=1 npx vitest run tests/config/setting-specs-pin.test.ts`（只多 2 个键且在末尾）；corpus 按 `docs/dev/memory/reports/J3-report.md` 先例：从 `git show origin/dev:tests/config/__corpus__/settings-corpus.json` 取 `captured[i].input` 写临时文件 → `GOV_CORPUS_GENERATE=<tmp> npx vitest run tests/config/settings-corpus.test.ts` → 程序化比对 `template` 只多 `.reflex` 子树、`captured`/`seed`/`randomCount` 不变 → prettier。报告贴比对输出。
13. `tests/secure/settings-override.test.ts`：secure 与 locked 两个用例各加 `expect(s.reflex.enabled).toBe(false)`（用户文件写 `reflex:{enabled:true}`）。
14. `tests/boundary/pi-free.test.ts`：新增两条 `it`（PD3/PD4），复用 `memoryOffenders`：
    - `reflex core/** value closure stays pi-free`：roots = `globSync("src/reflex/core/**/*.ts")`，断言 `roots.length ≥ 2`（R0 时只有 types/settings，R1 起自动扩）。
    - `reflex ports/** value closure stays pi-free`：roots = `globSync("src/reflex/ports/*.ts")`。
15. `tests/conformance/reflex.test.ts`：C-R1…C-R8（A §6.3 表），夹具 `tests/conformance/agent-session-harness.ts` / `tui-harness.ts`；C-R6 不重复写：`it.todo("C-R6: covered by tests/conformance/topic-switch-hop.test.ts › S5: pi.sendUserMessage during compaction never reaches the input handler (prompt() throws before _runInputHandlers)")`，并配一条**存在性断言** `it("C-R6 reference exists")`：`readFileSync("tests/conformance/topic-switch-hop.test.ts")` 必须包含 `it("S5: pi.sendUserMessage during compaction never reaches the input handler`——被引用用例改名或删除即红；C-R7 若 tui-harness 做不出，降级为 README 残留风险中的手动验收步骤（**不得** grep dist 源码）。
16. `docs/dev/jev-reflex/README.md`：R-I1…R-I12（A §6.2）+ 本计划 PD5/PD6 的降级/计数语义 + 门禁清单 + 残留风险（A §7 R1–R9）+ 晋升流程（§7）。
17. `AGENTS.md`：Repository layout 表加 `src/reflex/` 行（K9）：``| `src/reflex/` — Jev reflex：input 阶段对只读自省问题确定性作答（默认关，shadow 起步）。 | `docs/dev/jev-reflex/README.md` · 动 reflex/input 拦截顺序前 |``；I3 post-guard 清单在 `topic-switch` 前补 `reflex`；I11 D8 列表补 `reflex`；Frozen artifacts A 级表补 `reflex-off-golden.json`；pi peer bump checklist 第 2 条补 `reflex.test.ts`。K0（≤32 KiB，现 25,141 B）复核。

**测试与门禁**

- `npx vitest run tests/integration/reflex-off-golden.test.ts tests/config tests/secure/settings-override.test.ts tests/boundary tests/governance tests/integration/stack-teardown-matrix.test.ts tests/integration/topic-switch.test.ts tests/docs/agents-md.test.ts tests/conformance/reflex.test.ts tests/reflex`
- `git diff --quiet origin/dev -- tests/fixtures/ ':!tests/fixtures/reflex-off-golden.json' ':!tests/fixtures/governance/activate-trace.json'` 必须为真；`activate-trace.json` diff 只含 `max` 条目。
- `npm run format:check && npm run typecheck && npm test && npm run build`。
- `tests/reflex/wire-skeleton.test.ts`：enabled+plain ⇒ 恰好 6 项注册且顺序固定；`secureDomainKind` 为 secure/locked ⇒ 返回 undefined、零注册；input handler 恒 continue、抛异常也 continue、返回值非 thenable；**re-arm**：`session_shutdown` → `session_start` 后 input handler 仍正常服务（R0 骨架下即断言 handler 被调用且不因 disposed 早退），`isStale(旧 gen)` 为真、`isStale(新 gen)` 为假；连续两次 start/shutdown 循环无累积状态。

**回滚**：单个 revert 提交即可（`src/reflex/**` 全新；热点面改动都是追加行；三个可刷新产物随 revert 一起还原）。

**验收标准**：默认/minimal/child/thread-* trace 档逐字节不变；`reflex-off-golden.json` 在未改代码上捕获并在改后通过；secure/locked 强制关；max 档只多 6 项注册；teardown FULL 档 shutdown/start 各 +1；shutdown→start 后同一闭包继续服务；全量测试绿。

---

### R1 · pi-free 核心

**文件域（独占）**：`src/reflex/core/**`（除 R0 的 `types.ts`、`settings.ts` 只读；`git-status-parse.ts` 归 R2a；`extract/**` 归 R4）；`tests/reflex/core/**`（`shadow-scan.test.ts` 归 R3b、`extract/**` 归 R4）。

**允许新建**：`src/reflex/core/{normalize,gate,match,catalog,schema,state,budget,render,agreement,promotion,digest}.ts`。

**冻结面**：X1、X2、`src/reflex/core/types.ts`（只读；缺字段停下上报）、`src/reflex/{wire,command,render-tui}.ts`、`src/reflex/ports/**`。

**步骤**

1. `budget.ts`：常量 `REFLEX_BUDGET_MS=1200`、`MAX_INPUT_CHARS=120`、`REPEAT_WINDOW_MS=600_000`、`CORRECTION_WINDOW_MS=90_000`、`DEMOTE_AFTER_STRIKES=2`、`MAX_ANSWER_LINES=24`、`MAX_ANSWER_BYTES=2048`、`PENDING_MAX_AGE_MS=REPEAT_WINDOW_MS`（**只在 input 入口与 agent_settled 入口检查**，不设任何定时器）；`raceBudget<T>(p, budgetMs, clock: Clock, signal): Promise<T | {kind:"timeout"}>`——`clampSpanMs(min(budgetMs, REFLEX_BUDGET_MS))`，undefined ⇒ 立即 timeout；计时器走 `clock.setTimer`，settle 时 `clearTimer`。
2. `normalize.ts`：`normalizeInput(text)` → `{ norm, chars, lines }`（NFKC、小写、trim、去尾标点 `?？。.!！~`、折叠空白；码点计数）。
3. `digest.ts`：`requestDigest(norm)` = `node:crypto` sha256 前 16 hex。
4. `gate.ts`：`evaluateGate(facts)`，A §4.3 的 16 条**按序**；短口令/指代用 `isShortReply`/`hasAnaphora`（`src/topic-switch/filters.ts`），取消用 `cancelIntent`（`src/memory/jev/predict/clauses.ts`）；否定用 `negationWithinWindow`；`IMPERATIVE_VETO` 冻结数组；`CORRECTION_RE`（不对|不是|错了|重新|wrong）导出给 R3a/R2b 用。
5. `catalog.ts`：`BUILTIN_SCRIPTS`（4 条，A §4.5 表；每条 `examples.hit/miss` 各 ≥5，hit 必须含表中例句）、`origin:"builtin"`、`version:1`、`risk:"readonly"`；`Object.freeze` 深冻结。
6. `schema.ts`：typebox `RScriptV1Schema` + `validateScript()`；`catalog` 自检：拒绝 `origin:"extracted"`、id 重复、`budgetMs > REFLEX_BUDGET_MS`、正则源含 `/g` 语义或嵌套量词（`(…+)+`、`(…*)*` 形状扫描）。typebox 走 peer（`@sinclair/typebox`），**值导入** OK（非 pi）。
7. `match.ts`：`compileCatalog(scripts)` → `Matcher.match(norm, caps)`，A §4.4 规则（strong 隐式 `^…$`、weak 子串、exclude 优先、单 strong 命中且无他命中 ⇒ high，否则 ambiguous）。
8. `state.ts`：`effectiveState(id, autoResolve, rt)`、`onExecOutcome(rt, o, now)`（strike: error|timeout；清零: ok；不计: uncertain|unavailable；`strikes ≥ 2` ⇒ demoted, reason `"strikes"`）、`onRepeat(rt, now)` / `onCorrected(rt, now)`（PD5：仅在 state 为 auto 时 ⇒ demoted）；`detectCorrection(norm, memo, now)`（纯函数：memo 为最近一条候选/作答 `{kind, scriptId, scriptVer, digest, settledAt, corrected}`，窗口 `CORRECTION_WINDOW_MS` 自 `settledAt` 起算；命中 `CORRECTION_RE` 且 `!corrected` ⇒ 返回 `ReflexCorrectionV1`）、`reset(rt)`。
9. `render.ts`：`renderAnswer({script, outcome, question, ms, portVer})` → `{ content, details }`，格式**逐字节**见 §5.1；行/字节截断与 `[truncated N lines]`；问题行与端口行都先过 `redactForJev(text, "user")` / `redactForJev(line, "command")`。
10. `agreement.ts`：`collectToolShapes(branchEntries, sinceUserDigest)`（倒序找最近 user 消息并核 digest；bash 用 `allShapes(command)`、`bash_job` 用 `bash_job:<action>`、其他用工具名）+ `judgeAgreement(script, shapes)`（A §4.8 规则；出现 `edit`/`write` 不可能 agree）。入参用结构化 look-alike 类型，不 import pi。
11. `promotion.ts`（**晋升判定唯一实现**，U5）：
    ```ts
    export const PROMOTION_GATE = Object.freeze({
      minCandidates: 50,
      minOkRate: 0.99,
      maxDivergeRate: 0.05,
      maxReasked: 0,
      maxCorrected: 0,
    });
    export interface ScriptStats {
      scriptId: string;
      scriptVer: number;
      candidates: number;
      portRuns: number;
      portOk: number;
      unavailable: number;
      judged: number;
      agree: number;
      noTool: number;
      diverge: number;
      unknown: number;
      reasked: number;
      crossSessionRepeats: number;
      corrected: number;
      answered: number;
      fallback: number;
      repeat: number;
      p50ms?: number;
      p95ms?: number;
    }
    export function accumulate(
      stats: Map<string, ScriptStats>,
      row:
        | { kind: "record"; rec: ReflexRecordV1 }
        | { kind: "answer"; details: ReflexAnswerDetailsV1 }
        | { kind: "correction"; c: ReflexCorrectionV1 },
    ): void;
    /** R3b 专用：输入跨会话的 (sessionFile, at, scriptId, scriptVer, digest) 序列，按 at 排序后统计"同脚本同 digest 在 REPEAT_WINDOW_MS 内再次出现且不在同一会话"的次数。 */
    export function countCrossSessionRepeats(
      rows: readonly { session: string; at: number; key: string; digest: string }[],
    ): Map<string, number>;
    export function evaluatePromotion(s: ScriptStats): { eligible: boolean; reasons: readonly string[] };
    ```
    口径：`candidates` = `kind:"shadow"` 记录数；`portRuns` = 其中 `port.outcome ∈ {ok,uncertain,error,timeout}`（`unavailable` 另计、不进分母）；`okRate = portOk/portRuns`；`judged = agree+noTool+diverge`（`unknown` 不进分母）；`divergeRate = diverge/judged`；`reasked` = 会话内 `reasked:true` 标记 + AUTO 期 `kind:"repeat"`；`crossSessionRepeats` 由 `countCrossSessionRepeats` 填（`/reflex status` 中为 `undefined` ⇒ 显示 "n/a"、视为未判定）；`corrected` = 指向该 `scriptId@scriptVer` 的 `subagent:reflex-correction` 条目数（PD12）。`eligible` ⇔ `candidates ≥ 50 ∧ portRuns ≥ 50 ∧ judged ≥ 50 ∧ okRate ≥ 0.99 ∧ divergeRate ≤ 0.05 ∧ reasked = 0 ∧ crossSessionRepeats = 0（必须已判定）∧ corrected = 0`；`reasons` 用中文短句逐条列出未达标项。**只建议，不改设置**。

**测试**（`tests/reflex/core/*.test.ts`，Tier 1）

- 例句语料：每脚本 hit ⇒ `high` 且 scriptId 正确；miss ⇒ veto / miss / ambiguous（绝不 high 到别的脚本）。
- 全局否决语料：`SHORT_REPLY_TABLE` 全表、`ANAPHORA_CJK`/`ANAPHORA_EN` 全表拼进 hit 句、取消句、`IMPERATIVE_VETO` 每词 ⇒ 永不 `high`；种子性质测试（≥2,000 例：随机 hit 句 + 随机插入否决词）永不 high。
- gate 16 条逐条命中码与顺序；handler 异常语义由 R2b 测。
- 性能：1 万条随机输入 `evaluateGate+match` p99 ≤ 1ms（`performance.now`，CI 宽容系数 ×5 写进断言注释）。
- regex 扫描：catalog 与 `IMPERATIVE_VETO` 正则源无 `g` 标志、无嵌套量词。
- `raceBudget` 用 `FakeClock`：1200ms 边界、budget 非法 ⇒ timeout、settle 后定时器已清。
- `render` 逐字节快照（内联 `toBe`，不建 fixture 文件）；截断；脱敏（`sk-…` 打码）。
- `agreement` 四种结局 + digest 不一致 ⇒ unknown。
- `promotion`：49/50 边界、okRate 0.989/0.99、diverge 5%/5.1%、reasked=1 ⇒ 不合格、crossSessionRepeats=1 或 undefined ⇒ 不合格、corrected=1 ⇒ 不合格、unknown 不进分母；`countCrossSessionRepeats`：同会话重复不计、跨会话窗口内计、窗口外不计、不同 scriptVer 分开。
- `detectCorrection`：窗口内 / 外、同一目标只记一次、无 memo ⇒ undefined。
- pi-free 门禁（R0 已加）自动覆盖新文件。

**回滚**：revert `src/reflex/core/` 新文件即可（R0 骨架不引用它们）。

**验收标准**：上列测试全绿；`npm run typecheck`；pi-free 闭包门禁绿。

---

### R2a · 只读 ports

**文件域（独占）**：`src/reflex/ports/**`（`index.ts` 填实现，接口签名不变）、`src/reflex/core/git-status-parse.ts`、`tests/reflex/ports/**`、`tests/reflex/ports/git-status-parse.test.ts`。

**冻结面**：X1、X2、`src/reflex/core/types.ts`、R1 文件域、`src/reflex/{wire,command,render-tui}.ts`。

**步骤**

1. `ports/index.ts`：`createPortRegistry(deps)`（`capabilities()` 每次现算：bashJobs/fleet/quota 依赖 getter 非 undefined；`git` 恒有）；`executePort(port, env, clock)`：同步抛错与 rejected ⇒ `{kind:"error"}`；因 R1 与本包并行、`raceBudget` 尚不可用，**本包在 `ports/index.ts` 内自带最小预算竞速，只依赖 `src/core/{clock,deadline}.ts`**；收敛由 **R2a′**（R1、R2a 均合入后的独立提交）完成，R2b 不碰。`signal` aborted ⇒ `{kind:"error", reason:"aborted"}`。
2. `ports/jobs.ts`（PD4）：`bashJobs()?.list()`；缺席 ⇒ `unavailable`；渲染：`bash jobs (N running, M finished unread):` 首行（与 `/agent status` 同措辞，便于对照），每行 `  <jobId> <describeJobStatus> <formatDuration(elapsed)>  <previewCommand(cmd, 80)>`，最多 8+8 行；0 job ⇒ `lines:[]`（render 用 `emptyText`）；`facts: {running, unread, total}`。
3. `ports/fleet.ts`：`fleet()?.list()`；按 `status` 计数；活跃 run 前 8 条 `label · status · elapsed`（`displayAgentType`、`formatDuration`）；`facts` 为各状态计数。不调 `wait`、不碰 runner。
4. `ports/quota.ts`：`quota()?.verdicts(env.now)`；空 ⇒ `uncertain("no trusted snapshot")`；每 provider 一行 `renderProviderLine(v, now)`（`src/quota/render.ts`，已核 pi-free）；**禁止**调 `refreshIfStale`。
5. `ports/git.ts`：冻结常量
   ```ts
   export const REFLEX_GIT_ARGV = Object.freeze([
     "--no-replace-objects",
     "--no-pager",
     "--no-optional-locks",
     "-c",
     "core.hooksPath=/dev/null",
     "-c",
     "core.fsmonitor=false",
     "status",
     "--porcelain=v2",
     "--branch",
     "-z",
     "--untracked-files=normal",
   ]);
   ```
   调用 `git(REFLEX_GIT_ARGV, { cwd: env.cwd, timeoutMs: env.budgetMs, maxStdoutBytes: 65536, envPolicy: "minimal", pathOverride: WTDIFF_GIT_PATH, signal: env.signal })`（`WTDIFF_GIT_PATH` 来自 pi-free 的 `src/git/diff.ts`）；结果映射按 A §4.6 表；注释写明与 `VERSION_GIT_PREFIX` 的差异（不带 `--no-lazy-fetch`）及 I8 不跨层 import 的理由。
6. `core/git-status-parse.ts`：`parsePorcelainV2Z(stdout)` → `{ branch, upstream?, ahead, behind, staged, modified, untracked, unmerged, paths: string[] }`；`-z` 分隔、`2 ` 重命名条目的双路径、`# branch.*` 头；非法输入抛 ⇒ port 映射为 `error("parse")`。

**测试**

- 每个 port 的**只读断言**：fs 写入 spy（`vi.spyOn(fs, "writeFileSync"|"mkdirSync"|…)` 零调用）、quota `refreshIfStale` spy 零调用、jobs manager 只调 `list`（Proxy 记录方法名）、fleet 只调 `list`。
- git argv 逐字节钉住（含 `--no-optional-locks`）；fake `GitRunner` 覆盖 code 0 / 128 / spawnError / `killed:"timeout"` / `stdoutCapped` / `killed:"overflow"` / 其他非零。
- `git-status-parse`：干净、ahead/behind、重命名、带空格路径、unmerged、detached HEAD。
- **Tier 2**：`tests/reflex/ports/git-real.test.ts` 在 `mkdtemp` 临时仓库跑真 git，并断言运行前后 `.git/index` mtime 不变、无 `index.lock`。
- `executePort`：同步抛、reject、超时（FakeClock）、abort。
- ports 闭包 pi-free 门禁（R0 已加）。

**回滚**：revert 本包文件；`index.ts` 回到 R0 空实现。

**验收标准**：上列全绿；4 个 port 全部满足 R-I6。

---

### R2a′ · 预算竞速收敛（独立提交）

**时机**：R1 与 R2a 都已验收合入后、R2b 开工前。**owner**：R2a 的原 run（resume，同 owner，不新开 agent）。

**文件域（独占）**：`src/reflex/ports/index.ts`、`tests/reflex/ports/execute-port.test.ts`。**冻结面**：`src/reflex/core/budget.ts`（R1 产物，只读调用）及其余全部。

**步骤**：`executePort` 删除包内最小竞速实现，改调 `raceBudget`；行为不变（同一组 `executePort` 测试原样通过即证明）。**验收**：`npx vitest run tests/reflex` 绿 + `npm run typecheck`；`git diff --stat` 只含上述 2 个文件。**回滚**：revert 该提交。

---

### R2b · shadow 接线 + `/reflex status | explain`

**文件域（独占）**：`src/reflex/wire.ts`、`src/reflex/command.ts`、`tests/reflex/wire-shadow.test.ts`、`tests/reflex/command.test.ts`、`tests/reflex/wire-skeleton.test.ts`（更新）、`docs/dev/jev-reflex/R2b-report.md`。

**冻结面**：X1、X2（**含 `src/index.ts`**——接线参数在 R0 已定）、`src/reflex/core/**`（R1 独占，含 `budget.ts`）、`src/reflex/ports/**`（R2a/R2a′ 独占，含 `index.ts`）、`render-tui.ts`。需要改它们 ⇒ 停下上报主会话。

**步骤**

1. input handler（同步段）：
   - `ctx`/`event` → `GateFacts`：`source=event.source`、`mode=ctx.mode`、`streamingBehavior=event.streamingBehavior`、`idle=ctx.isIdle()`、`pendingMessages=ctx.hasPendingMessages()`、`imageCount=event.images?.length ?? 0`、`text=event.text`、`topicSwitchActive=deps.fences.topicSwitchActive()`、`goalBusy=deps.fences.goalBusy()`、`inFlight`。
   - veto / miss ⇒ `continue`，不记录。
   - **入口**：先做 pending 超龄检查（超过 `PENDING_MAX_AGE_MS` ⇒ 以 unknown 落盘并清空；不设定时器）。
   - **correction（PD12，独立持久）**：在 S0 之前、只要 `source==="interactive" ∧ mode==="tui"`，调用 `detectCorrection(norm, memo, now)`；命中 ⇒ **当场** `pi.appendEntry("subagent:reflex-correction", c)`、`memo.corrected=true`、激活计数 +1；若目标是 AUTO answer ⇒ R3a 的 `onCorrected` 降级。随后本输入照常进入 S0（结果是 veto / miss / 命中都不影响已落盘的纠正）。`memo` 在 shadow 记录落盘（agent_settled）与 AUTO 作答时更新，`settledAt` 取当时 `now`。
   - ambiguous ⇒ pending(`ambiguous`, candidates) ⇒ `continue`。
   - high ∧ state ∈ {shadow, demoted}：
     - 若同 digest 在 `REPEAT_WINDOW_MS` 内已是该脚本候选 ⇒ pending 带 `reasked:true`（PD6）。
     - pending(`shadow`) ⇒ **同步** `return {action:"continue"}`；`queueMicrotask` 里 `executePort(...)`，结果写入 pending.port（若 pending 已被替换或 `disposed` 则丢弃）。
   - high ∧ state = auto：R2b 中**按 shadow 处理**（AUTO 分支留空，R3a 填），以便 R2b 可独立上线 shadow。
   - 单槽：新 pending 到来时旧 pending 未结算 ⇒ 以 `model:{agree:"unknown", tools:[]}` 立即 `appendEntry` 再替换。
   - 整个 handler `try/catch` ⇒ `continue`（fail-open，注释写明与 pi 文档 fail-closed 建议相反的理由）。
2. `agent_settled`：入口先做 pending 超龄检查（同上）；有 pending ⇒ `collectToolShapes(ctx.sessionManager.getBranch(), pending.digest)` → `judgeAgreement` → `pi.appendEntry("subagent:reflex-record", record)` → 清空；`getBranch` 不可用 ⇒ `unknown`。
3. `session_shutdown` / `session_start`（PD11，R0 已注册，本包只填行为）：shutdown ⇒ `abort()`、丢弃 pending（**不落盘**）、`disposed=true`、`generation++`；start ⇒ re-arm（`disposed=false`、新 `AbortController`、清 pending 与 `memo`、`inFlight=false`）。shadow microtask 的 port 续体捕获 `gen`，写 pending.port 前检查 `isStale(gen)`；同步入口不检查 `disposed`。
4. `/reflex`：
   - `status`（默认）：已启用；每脚本有效状态（shadow/auto/demoted + strikes + demoteReason）；本激活计数（candidates/answered/fallback{reason}/ambiguous/repeat/reasked/corrected）；本会话 `getBranch()` 中 `subagent:reflex-record` + `subagent:reflex` 的 `accumulate` 汇总（agree 率、p50/p95）；`autoResolve` 未知 id；对每个脚本跑 `evaluatePromotion` 并显示"本会话样本不足以判定，跨会话请跑 `node scripts/dev/reflex-shadow.mjs`"（R3b）。中文散文 + 英文紧凑标记，经 `ctx.ui.notify`（command capture 自动覆盖 web）。
   - `explain <text>`：理想 TUI 空闲事实下跑 S0+S1，输出 veto 码或 band + 脚本 + 命中模板序号；**不执行 port**。
   - `reset [id]`：R3a 才有降级，本包实现为清 strikes/覆盖层（纯内存）。

**测试**（fake pi + 真 `activate()`，`tests/reflex/wire-shadow.test.ts`）

- **R-I5 同步返回**：handler 返回值不是 Promise（或 Promise 前已 resolved：断言 `typeof result.then !== "function"`）；port 在 microtask 后才被调用。
- shadow 结局 ⇒ `agent_settled` 后恰好一条 record，形状逐字段断言；无 `sendMessage`。
- 单槽替换、digest 不一致 ⇒ unknown、超龄 pending。
- I6（A §6.3）：rpc / extension / print / json / 带图 / 流式 / 非空闲 / pending messages ⇒ 零执行零记录。
- I5：`topicSwitch.enabled:true` 且 hold active（真 `wireTopicSwitch` + 构造 hold）⇒ R 层 veto `fence-topic`，topic-switch 排队语义不变；topic-switch 重注入（`source:"extension"`）R 层放行。
- goal 活跃 ⇒ veto。
- shutdown 在 port 在飞时 ⇒ 之后零 append；**shutdown → start（模拟 /new）后**：旧会话迟到的 port 结果被丢弃、新会话 input 正常产生 shadow pending 与 record、`memo` 已清（旧会话候选不会触发新会话的 correction/reasked）。
- correction 持久：shadow 候选 → agent_settled → 下一条输入"不对"（被短口令 veto）⇒ 恰好一条 `subagent:reflex-correction`；窗口外不记；同一目标第二次纠正不重复记。
- pending 超龄只在 input / agent_settled 入口触发（FakeClock 推进后不调用入口 ⇒ 零 append）。
- G2/G3/G4 governance 扫描（放 `tests/reflex/governance.test.ts`，本包新建）：`src/reflex/**` 无 `Symbol.for(`、无裸 `setTimeout`/`setInterval`（只经注入 Clock）、无 `sendUserMessage`/`triggerTurn`/`"transform"`。
- `/reflex explain` 对例句语料输出与 `match` 一致；`status` 文本快照（内联）。

**回滚**：revert 本包 ⇒ 回到 R0 骨架（handler 恒 continue）。

**验收标准**：shadow 全链路测试绿；本机 `reflex.enabled=true` 手动冒烟：问"后台还有几个 job"⇒ 模型正常作答、`/reflex status` 出现 1 条 shadow 记录。**R2b 合入即可在用户本机开启 shadow**（§7）。

---

### R3a · autoresolve

**文件域（独占）**：`src/reflex/wire.ts`、`src/reflex/render-tui.ts`、`src/reflex/command.ts`（`reset` / status 降级显示）、`tests/reflex/wire-auto.test.ts`、`tests/reflex/render-tui.test.ts`、`docs/dev/jev-reflex/R3a-report.md`。

**冻结面**：X1、X2、`core/**`（缺能力停下上报）、`ports/**`、R3b 文件域。

**步骤**

0. **handler 形态**：input handler 仍是 R0 的**普通非 async 函数**；veto / miss / ambiguous / shadow / demoted / repeat 分支都同步返回 `InputEventResult`，**只有 AUTO 分支**返回 `runAuto(...)` 产生的 `Promise<InputEventResult>`（pi 的 `ExtensionHandler` 允许 `R | Promise<R>`）。R2b 的 R-I5 测试（shadow 返回值非 thenable）必须原样保持绿。
1. AUTO 分支（`runAuto`，async 内部函数）：
   - repeat：同 digest 在 `REPEAT_WINDOW_MS` 内已被 reflex 作答 ⇒ `onRepeat`（PD5 降级 + notify 一次）⇒ pending(`repeat`) ⇒ `continue`。
   - 否则 `inFlight=true`；`ctx.ui.setStatus("reflex", "reflex…")`；`await executePort(port, {cwd: ctx.cwd, now, signal, budgetMs: script.budgetMs ?? REFLEX_BUDGET_MS}, clock)`；`finally { inFlight=false; setStatus("reflex", undefined) }`。
   - `ok` 且 `!isStale(gen)`（gen 在进入 `runAuto` 时捕获）⇒ `renderAnswer` ⇒ `pi.sendMessage({customType:"subagent:reflex", content, display:true, details})`（**不传** options：空闲时只追加不起 run，C-R3）⇒ 记 answered（digest、时间，供 repeat/correction）⇒ `return {action:"handled"}`。
   - 非 ok ⇒ `onExecOutcome`（strike/降级，`demotedNow` ⇒ `ctx.ui.notify("reflex：<id> 连续失败，已降回 shadow（/reflex reset 或 /reload 恢复）", "warning")`）⇒ pending(`fallback`, port) ⇒ `continue`。
   - await 期间发生 shutdown（或 shutdown→start 换了会话）⇒ `isStale(gen)` ⇒ 返回 `continue`，零 send/append，不记 strike；`finally` 中只在 `!isStale(gen)` 时清 `inFlight`/status（新会话的 re-arm 已重置）。
2. correction：R2b 的 PD12 路径已持久化纠正条目；本包只在目标为 AUTO answer 时追加 `onCorrected` 降级 + notify，并在作答时更新 `memo`（`kind:"answer"`）。
3. `render-tui.ts`：`renderReflexMessage`：首行 `reflex · <scriptId> · <ms>ms`（英文标记），下接 `Q: …` 与正文；剥掉 `<reflex …>` 外壳与末尾中文提示；`details` 缺失 ⇒ 回退为原 content。
4. `/reflex reset [id]` 清覆盖层；`status` 显示 demoteReason。

**测试**（`tests/reflex/wire-auto.test.ts`，FakeClock）：A §6.3 I1–I8 全部 + 返回值形态（AUTO 分支 thenable、其余分支非 thenable；`tests/reflex/wire-shadow.test.ts` 不改且全绿）+ await 期间 shutdown→start 换会话 ⇒ 旧续体零副作用、新会话正常作答 + PD5（repeat ⇒ 降级、correction ⇒ 降级、两次 strike ⇒ 降级、`reset` 恢复）；`ok` 消息 content **逐字节**等于 §5.1 格式；`details` 形状；1200ms 预算边界（1199 ok / 1201 timeout）；`autoResolve` live 变更（经 `/agent settings` 的 SettingsStore 原地修改）下一次 input 生效；`render-tui` 快照。

**回滚**：revert 本包 ⇒ 回到 R2b 纯 shadow（AUTO id 也只走 shadow）。运行时紧急回滚：清空 `reflex.autoResolve`（live）或 `reflex.enabled=false` + `/reload`。

**验收标准**：I1–I8 + PD5 测试绿；本机手动：把 `quota.summary` 临时加入 `autoResolve` ⇒ 问"额度还剩多少"⇒ TUI 出现 `reflex · quota.summary · Nms` 卡片、无模型回合；紧接着问"刚才那个额度是哪个 provider 的"⇒ 模型能接上（上下文中有 Q/结果）；再问同一句 ⇒ 交给模型并降级。验毕从 `autoResolve` 移除（晋升要等 §7 门槛）。

---

### R3b · 跨会话 shadow 汇总 + 晋升判定（Tier 3 脚本，必做）

**文件域（独占）**：`scripts/dev/reflex-shadow.mjs`、`src/reflex/core/shadow-scan.ts`（pi-free 纯函数：jsonl 行 → record/answer 提取）、`tests/reflex/core/shadow-scan.test.ts`、`docs/dev/jev-reflex/R3b-report.md`。

**冻结面**：X1、X2、`core/promotion.ts`（只读调用）、其余 `src/reflex/**`。

**步骤**

1. `shadow-scan.ts`：`extractReflexRows(line: string)` → `{ kind:"record", rec } | { kind:"answer", details } | { kind:"correction", c } | undefined`（只认 `type:"custom"` + `customType ∈ {"subagent:reflex-record","subagent:reflex-correction"}` 与 `type:"custom_message"` + `customType:"subagent:reflex"`；`v !== 1` 跳过）。
2. `scripts/dev/reflex-shadow.mjs`：参数 `--days 14`（默认）、`--cwd <path>`（可选，只扫该 cwd 的会话目录）、`--json`；会话根 = `$PI_CODING_AGENT_DIR/sessions` 或 `~/.pi/agent/sessions`；流式逐行读；import `../../dist/reflex/core/{shadow-scan,promotion}.js`，缺 dist ⇒ 报 "先 npm run build" 并 exit 2；逐行 `accumulate`，同时收集 `(sessionFile, at, scriptId@scriptVer, digest)`（shadow record 与 answer 都收）喂给 `countCrossSessionRepeats` 填 `crossSessionRepeats`；`corrected` 来自 correction 条目；输出每个 `scriptId@scriptVer` 一行统计（含 reasked / crossSessionRepeats / corrected 三列）+ `evaluatePromotion` 结论与中文原因；**只读、不联网、不写任何文件**（stdout 输出）。
3. README 的晋升流程（§7）引用本脚本。

**测试**：`shadow-scan` 单测（三种 entry 形状、坏 JSON、v≠1）；构造两份会话 jsonl（同 digest、间隔 5min ⇒ crossSessionRepeats=1 ⇒ 不合格；间隔 11min ⇒ 0）；脚本本身 Tier 3 手动跑并把输出贴进 R3b-report（不进 CI）。

**回滚**：删两个新文件。**验收标准**：对一份构造的 60 条 shadow 记录样本（测试内生成，跨 3 个会话、digest 不重复、无 correction）`evaluatePromotion` 给出 eligible；对 49 条给出"候选不足 50"；加 1 条 correction 条目 ⇒ 不合格；手动跑脚本在本机真实会话目录完成且无写入（`strace -e trace=openat` 或 `inotifywait` 抽查可选）。

---

### R4（可选）· 意图聚类报告 + `sessions.recent`

**文件域（独占）**：`src/reflex/core/extract/**`、`scripts/dev/reflex-report.mjs`、`src/reflex/ports/sessions.ts`、`src/reflex/core/catalog.ts`（**仅追加** `sessions.recent` 脚本，需 R1 已合入）、`tests/reflex/core/extract/**`、`tests/reflex/ports/sessions.test.ts`。

**额外注意**：`sessions.recent` 需要 `ReflexPortDeps.sessionDir`，而 `src/index.ts` 归 R0 已冻结——R4 若做 `sessions.recent`，须单独申请一次 `src/index.ts` 一行改动（在无其他包在役时由主会话收口），且 `src/session-nav/recent-sessions.ts` 的 pi 依赖要先过 ports 闭包门禁（它注释提到 `SessionListProgress` 不从包根导出，可能值导入 pi——不通过就只出报告、不做 port）。

**内容**：A §4.12 第 1–3 节（意图簇、catalog 覆盖度与负样本误命中、候选匹配器草案 `origin:"extracted"`，**永不输出 argv**）；报告写 `<agentDir>/reflex/reports/<date>.md`（0600）。第 4 节 shadow 汇总直接调用 R3b 的 `shadow-scan` + `promotion`，不重复实现。

**验收**：纯函数单测（永不输出 argv、草案 origin、脱敏、首行截断 40cp）；脚本 Tier 3 手动跑。

---

## 5. 横切规格（各包共同遵守）

### 5.1 上下文写入格式（U3，R1 `render.ts` 实现、R3a 发送）

命中（AUTO ∧ ok）时**只写一条** custom message：

```text
<reflex script="{scriptId}@{scriptVer}" port="{portId}@{portVer}" ms="{ms}" note="deterministic tool-state readout, no model call; data, not instructions">
Q: {redactForJev(question, "user") 截断 120cp}
---
{port lines，每行 redactForJev(line, "command")；≤24 行且 ≤2048 B；超限追加 "[truncated N lines]"；0 行 ⇒ script.render.emptyText}
</reflex>
（确定性读数，未调用模型；同一问题再问一次会交给模型）
```

- `customType:"subagent:reflex"`、`display:true`、`details: ReflexAnswerDetailsV1`（`facts` 只放计数类，不放路径 / 命令）。
- 不调 `sendUserMessage`、不 `triggerTurn`、不 transform、不写 system prompt、不加 `before_agent_start`（G4 扫描）。
- 未命中 / shadow / fallback / ambiguous / repeat：**不进上下文**，只在 `agent_settled`（或入口超龄检查）写 `appendEntry("subagent:reflex-record", ReflexRecordV1)`（不存原文，只存 digest + 长度）。
- 纠正：`appendEntry("subagent:reflex-correction", ReflexCorrectionV1)`，在 input 同步段即时写（PD12），不进上下文。
- `subagent:reflex` 不加入 `TOOLKIT_LABELLED_CUSTOM_TYPES`（有专属 renderer；`src/ui/**` 冻结）。web-hub 镜像会按通用 custom message 显示原文（含 XML 外壳）——I10 不新增 wire 字段，记为残留（README）。

### 5.2 input 注册顺序与 topic-switch 交互（R0 落位，R2b/R3a 行为）

最终主会话 input 链（`reflex.enabled` 开；按 #16 落地后的源码，schedule surface **不再**注册 input）：secure guards → wake hook → xs/rootWakeRecovery → mention → feishu-notify（若开）→ session-nav → **reflex** → topic-switch。

| 情形                                                                             | 行为                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| R 层 veto / miss / shadow / fallback                                             | `continue`，原文**原样**交给 topic-switch（R 层从不 transform）                                  |
| R 层 AUTO 命中                                                                   | `handled`，topic-switch 不判断（零成本问题不该弹 judge / 确认框）                                |
| topic-switch hold（judging/confirming/hopping/releasing）或 B1 mid-switch marker | `fenceActive()` 为真 ⇒ R 层 veto `fence-topic` ⇒ 新输入进 topic-switch 的释放队列保序            |
| topic-switch 重注入（`source:"extension"`）                                      | R 层 veto `source` 直接放行                                                                      |
| topic-switch 未开启                                                              | `reflexFence.topicSwitch` 未绑定 ⇒ 视为 false                                                    |
| R 层 handled 后 topic-switch 的 `ctxRef`                                         | 不更新——它由其余事件（agent_start 等）刷新，无功能影响（R2b 测试 I5 钉住 topic-switch 行为不变） |

topic-switch 仍是 `activate()` 里**最后**注册的 input handler（`tests/integration/topic-switch.test.ts` 取 `inputHandlers[length-1]` 的用例不受影响）。

### 5.3 关闭边界

| 边界                                              | 机制（双保险）                                                                                         | 钉住                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 默认关                                            | `settings.reflex.enabled=false` ⇒ `wireReflex` 不被调用                                                | `reflex-off-golden` default/off 场景；trace default/minimal                           |
| secure / locked                                   | `applySecureDomainOverrides` 强制 false（D8）+ `wireReflex` 内 `secureDomainKind !== "plain"` ⇒ 零注册 | `settings-override.test.ts`、golden secure 场景、wire-skeleton                        |
| 子会话                                            | post-guard（`if (g[HOST_KEY]) return;` 之后）⇒ 结构不可达                                              | golden child 场景、trace child/thread-child 档不变、C-R5                              |
| rpc（含 web-hub 托管 spawn）                      | S0 #1 `source !== "interactive"`、#2 `mode !== "tui"`                                                  | wire-shadow I6                                                                        |
| web 输入（TUI 会话里的 web prompt / feishu / xs） | 走 `sendUserMessage`/hold ⇒ `source:"extension"` 或 rpc ⇒ S0 #1                                        | wire-shadow I6                                                                        |
| print / json                                      | S0 #2（print 的 `prompt()` 也报 interactive）                                                          | wire-shadow I6、C-R8                                                                  |
| 压缩中                                            | pi 在 input 之前 throw，R 层不可达                                                                     | C-R6（`it.todo` 指向 `tests/conformance/topic-switch-hop.test.ts` › S5 + 存在性断言） |

### 5.4 审计与指标

| 数据                             | 落点                                                                                                         | 读方                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| AUTO 作答                        | `custom_message` `subagent:reflex` 的 `details`（ms、digest、facts、truncated）                              | `/reflex status`、`reflex-shadow.mjs`                     |
| shadow/fallback/ambiguous/repeat | `custom` `subagent:reflex-record`（port outcome/ms/reason、agree、tools、reasked）                           | 同上                                                      |
| 纠正                             | `custom` `subagent:reflex-correction`（目标脚本@版本、目标 digest、deltaMs；即时写）                         | 同上                                                      |
| 跨会话重复                       | 不落盘；R3b 由各会话 record/answer 的 digest + at 现算                                                       | `reflex-shadow.mjs`                                       |
| 激活内计数                       | `wireReflex` 闭包（candidates/answered/fallback{reason}/ambiguous/repeat/reasked/corrected/strikes/demoted） | `/reflex status`                                          |
| 降级事件                         | `ui.notify` 一次 + 闭包 `demoteReason`                                                                       | 用户、`/reflex status`                                    |
| 晋升判定                         | `core/promotion.ts` `evaluatePromotion`（唯一实现）                                                          | `/reflex status`（本会话）、`reflex-shadow.mjs`（跨会话） |

无新持久化文件、无 `Symbol.for` 全局、无网络。

## 6. 门禁汇总

| 门禁                                                                                             | 包                | Tier              |
| ------------------------------------------------------------------------------------------------ | ----------------- | ----------------- |
| `tests/fixtures/reflex-off-golden.json`（A 级，新）                                              | R0 捕获，全程不变 | 1                 |
| `activate-trace.json` 仅 `max` 条目 diff                                                         | R0                | 1                 |
| `setting-specs-pin.json` / `settings-corpus.json` 仅因新增 `reflex` 变化（报告贴比对）           | R0                | 1                 |
| 既有 A 级金身 `git diff --quiet origin/dev -- tests/fixtures/`（除上两项）                       | 每包              | 1                 |
| pi-free 闭包门禁 reflex core / ports                                                             | R0 建，R1+ 受约束 | 1                 |
| governance G2/G3/G4                                                                              | R2b 建            | 1                 |
| conformance `tests/conformance/reflex.test.ts` C-R1–C-R8（pi peer bump 必跑）                    | R0                | 2（自含 harness） |
| `ports/git-real.test.ts`                                                                         | R2a               | 2                 |
| `reflex-shadow.mjs` / `reflex-report.mjs`                                                        | R3b / R4          | 3                 |
| 每包收尾：`npm run format:check && npm run typecheck && npm test && npm run build`（全绿贴输出） | 每包              | —                 |

## 7. 上线与晋升流程

1. R0 → (R1 ∥ R2a) → R2b 合入 ⇒ 用户本机 `reflex.enabled=true` + `/reload`（`autoResolve` 为空 ⇒ 全部 shadow）。
2. R3a ∥ R3b 合入（不改变 shadow 行为：`autoResolve` 仍为空）。
3. shadow 运行约 2 周 ⇒ `npm run build && node scripts/dev/reflex-shadow.mjs --days 14`。
4. 对报告中 `eligible` 的脚本，人工抽查 diverge 样本（报告给出 session 文件 + entry id，不含正文）；确认后**由用户**在 `/agent settings` 把 id 加进 `reflex.autoResolve`（live，无需 reload）。建议顺序：`quota.summary`、`jobs.list` → `fleet.status` → `git.status`。
5. 晋升后任一 error/timeout×2、repeat、correction ⇒ 自动降回 shadow（会话内）；用户决定是否从 `autoResolve` 移除。`scriptVer` 变更 ⇒ 统计重新从 0 计。

## 8. 冲突预检 spec（主会话派 R0 前、R1 ∥ R2a 前、R3a ∥ R3b 前真跑）

R0 开工前对照**届时** `git status --short` 的在役路径跑（`inflight` 条目由主会话按实测填写；若 §2 的 X3 已满足则它为空，预检应为"无交集"）：

```json
[
  {
    "id": "R0",
    "globs": [
      "src/reflex/**",
      "src/index.ts",
      "src/config/settings.ts",
      "src/config/setting-specs.ts",
      "tests/config/__corpus__/**",
      "tests/fixtures/governance/activate-trace.json",
      "tests/fixtures/reflex-off-golden.json",
      "tests/governance/trace-profiles.ts",
      "tests/integration/stack-teardown-matrix.test.ts",
      "tests/integration/reflex-off-golden.test.ts",
      "tests/secure/settings-override.test.ts",
      "tests/boundary/pi-free.test.ts",
      "tests/conformance/reflex.test.ts",
      "tests/config/reflex-settings.test.ts",
      "tests/reflex/**",
      "docs/dev/jev-reflex/README.md",
      "AGENTS.md"
    ]
  },
  { "id": "inflight", "globs": ["<git status --short 实测路径>"] }
]
```

```json
[
  {
    "id": "R1",
    "globs": [
      "src/reflex/core/{normalize,gate,match,catalog,schema,state,budget,render,agreement,promotion,digest}.ts",
      "tests/reflex/core/**"
    ]
  },
  {
    "id": "R2a",
    "globs": [
      "src/reflex/ports/**",
      "src/reflex/core/git-status-parse.ts",
      "tests/reflex/ports/**",
      "tests/reflex/ports/git-status-parse.test.ts"
    ]
  }
]
```

```json
[
  {
    "id": "R3a",
    "globs": [
      "src/reflex/wire.ts",
      "src/reflex/render-tui.ts",
      "src/reflex/command.ts",
      "tests/reflex/wire-auto.test.ts",
      "tests/reflex/render-tui.test.ts"
    ]
  },
  {
    "id": "R3b",
    "globs": [
      "scripts/dev/reflex-shadow.mjs",
      "src/reflex/core/shadow-scan.ts",
      "tests/reflex/core/shadow-scan.test.ts"
    ]
  }
]
```

R4 与 R2b/R3a/R3b 并行时加 `{ "id": "R4", "globs": ["src/reflex/core/extract/**", "scripts/dev/reflex-report.mjs", "tests/reflex/core/extract/**"] }`（`catalog.ts` / `ports/sessions.ts` 部分须等 R3a 合入后串行）。

## 9. 残留风险与未决

- **C-R7**（TUI 串行前提）可能做不成自动化 conformance ⇒ README 手动验收步骤；R 层单飞守卫兜底。
- **R2a 与 R1 的预算竞速重复**：R2a 先自带最小实现，由独立的 R2a′ 提交收敛到 `core/budget.ts`（R2b 不碰 budget/ports）。
- _\*#16 已实测删除 schedule surface 的 input/before_agent_start/ui_prompt_* 钩子_*（工作区未提交）：R0 必须在其提交后开工（X3），trace 与 teardown 计数以那时的实测为基线；R 层不依赖 schedule surface。
- **跨会话重复的口径偏严**：不同会话在 10min 内问同一句也会判不合格（如开两个窗口各问一次额度）。按评审要求保留为硬门槛；若 shadow 期因此长期不达标，由主会话 `ask_user` 决定是否只计同会话。
- **feishu-notify `userInputPending` 残留**（A R7）、**web-hub 镜像显示 XML 外壳**（§5.1）：记入 README 残留，不在 MVP 修。
- 无需用户再拍板的开放问题。PD5（repeat/correction 立即降级）是比 A 更保守的偏差，评审如有异议由主会话裁定。

## 10. r2 修订索引（评审 7 条）

| #   | 评审项                        | 修订位置                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 单激活多会话 re-arm           | §1 PD1（6 项注册）、新增 PD11；R0 步骤 8（注册 ③ session_start、`generation`/`isStale`）、步骤 10（trace 6 行）、步骤 11（teardown shutdown/start 各 +1）、wire-skeleton 测试、R0 验收；R2b 步骤 3 与测试；R3a 步骤 1 与测试；arch §4.2、§6.2 R-I7                                                     |
| 2   | off golden 捕获时机 / §2 实测 | §1 PD8；§2 实测清单（含 `src/index.ts`）与 X3；R0 步骤 1 前置检查；§5.2 input 链；§9                                                                                                                                                                                                                   |
| 3   | 晋升口径                      | §1 PD6、新增 PD12；R0 步骤 2（`ReflexCorrectionV1`、删 `prevAnswerCorrected`）；R1 步骤 8（`detectCorrection`）、步骤 11（`crossSessionRepeats`、`countCrossSessionRepeats`、`corrected` 口径）与测试；R2b 步骤 1 与测试；R3a 步骤 2；R3b 步骤 1–2、测试、验收；§5.1、§5.4；arch §4.7、§4.8、§6.2 R-I9 |
| 4   | X2 / R0 预检补 pi-free 测试   | §2 X2；§8 R0 spec                                                                                                                                                                                                                                                                                      |
| 5   | R3a handler 非 async          | R0 步骤 8（①普通函数）；R3a 步骤 0 与测试                                                                                                                                                                                                                                                              |
| 6   | R2b 不改 budget/ports         | 新增 R2a′ 包（§3 依赖图与总表、§4 R2a′ 小节）；R2a 步骤 1；R2b 文件域与冻结面；§9                                                                                                                                                                                                                      |
| 7   | C-R6 引用 / 超龄检查点        | R0 步骤 15；§5.3；arch §6.3；R1 步骤 1（`PENDING_MAX_AGE_MS` 注释）；R2b 步骤 1–2 与测试                                                                                                                                                                                                               |
