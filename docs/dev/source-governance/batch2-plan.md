# 源码治理第二批 · 实施方案（④⑤⑦⑧⑨⑩）

> 基线 `dev@43d892fd`（2026-10-26）。#59「archive keep count」已经落在这个提交上，改了 `src/stack.ts:3025-3032`、`src/archive/**`、`src/config/**`。输入：`analysis.md` §3、§8 Top10，`plan-lowrisk.md`（第一批 ①②③⑥ 已合入）。本文只写方案，没有改代码。
> 行号都是 `43d892fd` 上的参考值，**实施时一律按符号名定位**，不要按行号。stack.ts 第 3025 行以前的行号和 `3831a2bd` 相同。
> 能直接派开发的只有 ④⑤（§2、§3）。⑦⑧⑨⑩ 写到概要设计，需要拍板的点都标了出来（§4–§7、§9）。用户已经拍板的事项见文末「用户拍板（2026-10-26）」，评审意见的逐条回应见「r2 修订对照表」。

**修订记录**

- r1（2026-10-26）：初版。
- r2（2026-10-26）：回应评审（kimi，`/tmp/review56.txt`）并落实用户拍板。⑦ 的前提重写：核实了 pi 1.3.0 的扩展缓存，结论是同 cwd 的 new/resume/fork 复用同一个模块实例，只有 `/reload` 和跨 cwd 切换会换成新模块（§4.1）。矩阵补齐所有持有计时器的组件（§4.2）。冲突表补上 #61（§0.3、§8.2）。④ 的验收改为机器枚举自由标识符的绑定（§2.5）。轨迹守卫入库为 B 档 golden，存调用计数，补 compat-failure 画像，并同步 AGENTS.md（§3.1）。5-7 取消（拍板第 4 条）。逐条对照见文末。

---

## 0. 总览

### 0.1 范围与目标

| #   | 主题                                  | 本文深度                 | 车道             | 说明                                                                                                                                    |
| --- | ------------------------------------- | ------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| ④   | `stack.ts` 机械下沉                   | **可直接派发**           | L2               | 6 组纯移动，stack.ts 从 3531 行降到约 2000 行。消除 `todo`、`context-switch`、`compact-hint` 指向 `stack.ts` 的反向值边                 |
| ⑤   | `index.ts` 抽子 wire                  | **可直接派发**           | L2（偏高）       | 先加「激活调用轨迹」守卫（4-0），再分 7 个提交抽取（5-0…5-6；5-7 按拍板取消）。`activate()` 从 1750 行降到约 1050 行，⑦ 落地后约 900 行 |
| ⑦   | `Stack.dispose()` 统一拆栈            | 概要 + **矩阵** + 决策点 | **L3**           | 先写 conformance 探针和矩阵测试，钉住**现状**（包括缺口）；然后做零行为合并；缺口各自单独提交修复（拍板第 3 条）                        |
| ⑧   | settings 子系统化                     | 概要 + 决策点            | L3               | 硬依赖 #59 收尾和 #54 包 B/C 合入                                                                                                       |
| ⑨   | web-hub 巨型闭包分拆                  | 概要 + 决策点            | L3（每文件一包） | 三个文件三个包，只做纯抽取（拍板第 4 条）。H1/H3 排在 #61 C2/H2 后面，H2 排在 #66 后面                                                  |
| ⑩   | UI transport 去重 + `helper.mjs` 拆分 | 概要 + 决策点            | L3               | 两件事互相独立；helper 拆分要等 #54 包 A                                                                                                |

### 0.2 全批硬约束（每个包都适用）

1. **行为零变化**：不改设置键、wire 字段、tool schema/描述、命令表、`pi.on` 的注册顺序（由 §3.1 的轨迹守卫钉住），也不改模型可见的文本。唯一的例外是 ⑦ 的缺口修复，它们必须各自走一个 `fix(...)` 提交。
2. **冻结面**：每个提交都要满足 `git diff <包开工时 HEAD>..<commit> -- tests/fixtures` 为空。唯一例外是 4-0 **新增**的 B 档 golden `tests/fixtures/governance/activate-trace.json`（拍板第 2 条）：它属于新增文件，同一个提交里要把它登记进 AGENTS.md 冻结物表的 B 档。
3. **运行时旧名不动**（I7）。**包公开面不动**：`src/index.ts` 目前导出 `default` 和 `mentionAutocompleteEntries`（`package.json` 的 exports 只有 `"."` → `dist/index.js`）。⑤ 把后者移走以后，`src/index.ts` 必须保留 `export { mentionAutocompleteEntries } from "./mention/wire.js"`。
4. **不留兼容垫片**（沿用第一批 Q5）：被移走的符号不在 `stack.ts`/`index.ts` 里 re-export，src、tests、scripts 里的导入方逐个改路径。例外只有两个：上面第 3 条的公开面，以及 ⑧ 的 settings 类型 re-export（拍板第 4 条）。
5. **I4 不能变得更差**：新文件不准引入模块级 `let`。`stack.ts` 现有的 18 个 `let previous*` 留给 ⑦，④⑤ 期间原样保留。
6. **I5**：被移动的代码里，`unref()` 调用一处都不能少（§2.5 第 5 条做计数比对）。

### 0.3 串并行与在途热点

```
冻结窗口（拍板第 1 条）：④⑤ 施工期间，只有 P4/P5 可以提交 src/stack.ts、src/index.ts
④ ──► ⑤ ──► #61-C1（index.ts 组装）──► ⑦-7-2（独占 stack/index；7-0/7-1 可提前写）
               #61-C2（web-hub/agent/index.ts）──► ⑨-H1
               #61-H2（web-hub/hub/hub.ts cap）──► ⑨-H3
               #66 ──► ⑨-H2、⑩-U
               #59 收尾 + #54 包B/C ──► ⑧            （⑧ 与 ⑨/⑩ 可并行）
               #54 包A ──► ⑩-S
```

| 在途包                                                                      | 文件域（据其 plan / 提交）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 与本批的冲突点与排期                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#59** archive keep count                                                  | `src/archive/{control,sweep}.ts`、`src/config/{settings,setting-specs}.ts`、`src/stack.ts`（archive.start 改为三参数）、`src/web-hub/agent/index.ts`（3 行）；主体已在 `43d892fd`                                                                                                                                                                                                                                                                                                                                                                                                                                               | ④⑤：冻结窗口内 #59 不能再往 `stack.ts`/`index.ts` 提交；开工前跑 §8.1 预检。⑦：矩阵里有 `archive.dispose()` 一行，要等 `ArchiveControl` 定稿后再写基线。⑧：硬依赖                                                                                                                                                                                             |
| **#61** schedule confirm（`docs/dev/scheduled-reports/confirm-plan.md` §7） | C0：`web-hub/protocol/{schedule,messages}.ts`🔥、`web-hub/hub/feishu/schedule.ts`、`web-hub/agent/command-policy.ts`；C1：`schedule/core/claim.ts`、`schedule/agent/{ops,confirm,surface,wire,dispatch}.ts`、`tools/schedule-tool.ts`、`commands/schedule.ts`、**`src/index.ts`🔥**；C2：`schedule/agent/coordinator.ts`、`web-hub/agent/connection.ts`、**`web-hub/agent/index.ts`🔥**；H2：`web-hub/hub/schedule/*`、`web-hub/hub/agent-server.ts`、**`web-hub/hub/hub.ts`**；F2：`web-hub/hub/feishu/{schedule-confirm,service}.ts`；W2：UI schedule 组件、`DetailHeader.vue`、`logic/schedule.js`、`i18n/schedule-extra.ts` | **排期：#61 的开发排在 ④⑤ 之后**（用户口径）。C0/H2/W2/F2 不碰 stack/index，冻结窗口内可以先做；**C1 等 P5 合入以后再动 `src/index.ts`**（它只改 schedule tool/command 的 deps，这几行 ⑤ 不移动，所以冲突只是机械性的）。⑦：7-1 的期望表和轨迹 golden 要在 #61-C1 合入后的基线上确认（C1 可能增减 schedule 相关的注册）。⑨-H1 排在 C2 后面，⑨-H3 排在 H2 后面 |
| **#54** settings-rename                                                     | 包 A：`src/secure/**`（含 `bin/helper.mjs`、`settings-lock.ts`、`domain.ts`）；包 B/C：`src/config/settings.ts`、`setting-specs.ts`、`commands/webhub.ts`、`cache-ttl/cache-ttl.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                             | ⑧ 和包 B/C 都改 `config/settings.ts`，**⑧ 排在 #54 后面**。⑩-S 和包 A 都改 `helper.mjs`，**⑩-S 排在包 A 后面**。⑤ 不碰 index.ts 里 `persistSettingOverride`/`defaultSettingsPath` 的调用，它们留在原位                                                                                                                                                        |
| **#66** web-hub auth hardening                                              | `hub/{kdf,kdf-upgrade,admin,lan-store,lan-auth,lan-login,db,db-child,ports}.ts`、`protocol/{password-policy,common-passwords,lan,token-file}.ts`、`agent/{passwd-prompt,lan-status}.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                         | ⑨-H2 的 `handleLanLogin`/`createLanTransport` 和 #66 在同一条 LAN 登录链上，**H2 排在 #66 后面**；⑩-U 的 password transport 同理                                                                                                                                                                                                                              |

---

## 1. 现状摘要（43d892fd 实测）

### 1.1 `src/stack.ts`（3531 行，顶层声明，按符号）

| 段                                                                                                                                                                                                                                                                                                                   | 行（参考）         | 性质                                                                   | ④ 去向                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------- | -------------------------------- |
| 18 个 `let previous*`（Xs、RootWakeRecovery、FleetWidget、UsageBroadcaster、Coalescer、AckHold、BackgroundCompletions、BashJobs、Archive、BashJobRecovery、FabricMailbox、Keepalive、Quota、WorkflowRuns、WorktreeLate、WorktreeOrphansStartup、HostBashViewCapabilityRelease、External；consult 那个已在 #40 删除） | 217–302            | 同模块跨激活的交接（§4.1）                                             | 不动（⑦）                        |
| bash 通知常量与格式化、tail                                                                                                                                                                                                                                                                                          | 305–519            | bash 子系统逻辑                                                        | `src/bash/notify.ts` + `host.ts` |
| `buildFabric`                                                                                                                                                                                                                                                                                                        | 521–727            | fabric 构建                                                            | `src/fabric/stack.ts`            |
| `currentSessionId`                                                                                                                                                                                                                                                                                                   | 729–735            | pi 适配小工具（stack 内 5 处调用）                                     | `src/adapters/session-id.ts`     |
| `buildBashJobManager`、`BASH_JOB_RECOVERY/RECONCILE_DEADLINE_MS`、`scheduleBashJobRecovery`                                                                                                                                                                                                                          | 748–922            | bash 宿主侧组装                                                        | `src/bash/host.ts`               |
| `WorkflowSupport`、`StackModelPort`、`Stack` 接口                                                                                                                                                                                                                                                                    | 924–949、991–1161  | 栈契约                                                                 | **留在 stack.ts**                |
| `CompactHintState` + `createCompactHintHook`                                                                                                                                                                                                                                                                         | 951–987、1172–1512 | compact-hint 钩子；子会话经 `context-switch/child.ts` 值导入（反向边） | `src/compact-hint/hook.ts`       |
| `createNotificationReceiptHook`、`createBackgroundCompletionEventHook`                                                                                                                                                                                                                                               | 1514–1544          | holder 转发钩子（index.ts 注册）                                       | `src/delivery/stack-hooks.ts`    |
| `safeSetQuotaStatus`、`hostWarn`、`rankLoadLevel`、`safeSetLoadStatus`                                                                                                                                                                                                                                               | 1551–1594          | buildSessionStack 私用的小工具                                         | **留下**（体量小，没有反向边）   |
| `StackExternalInput`                                                                                                                                                                                                                                                                                                 | 1602–1604          | build 入参                                                             | 留下                             |
| `StackXsInput`、`StackXs`、`StackXsReply`、`XS_REPLY_INBOUND_SCAN_CAP`、`buildStackXs`                                                                                                                                                                                                                               | 1607–2058          | xs 栈构建                                                              | `src/fabric/xs/stack.ts`         |
| `buildSessionStack`                                                                                                                                                                                                                                                                                                  | 2060–3531          | 真正的组装                                                             | 留下（内部不拆，见 §2.7 非目标） |

`tsc --noUnusedLocals` 对 `stack.ts` 当前报 **0** 条，下沉以后也必须保持 0。

### 1.2 `src/index.ts`（2128 行；`activate()` 在 171–1921 行）

`tsc --noUnusedLocals` 当前报 **16 条诊断，涉及 17 个死导入符号**，位置在 `index.ts:10,11,15,18,20,31,74–81`。其中 **14 个是值导入**：`MemoryOutboxStore`、`MemoryRunStore`、`probeReadBackEntries`、`createPiOutboxStore`、`wrapWithRunLog`、`createNotifier`、`EscalatingReaper`、`PiSessionDriver`、`SingleSlotPool`、`EventWatchdog`、`createQueryService`、`createRunRegistry`、`createRuntimeRunnerAdapter`、`createSpawnService`。另外 3 个是类型导入：`RunSnapshot`、`UsageDelta`、`PersistedDelivery`。它们都是当初把 `stack.ts` 从 index.ts 拆出去时留下的。

`activate()` 按段划分（行号是参考值）：

| 段                                                                                                                                                                                                                                           | 行        | ⑤ 处置                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| pre-guard（secure → capture → web_search → date → todo → promptHub → memory → child）+ `if (g[HOST_KEY]) return;`                                                                                                                            | 171–318   | 不动                                                                                                                                              |
| claim、`loadSettingsFromFile()`、secure 命令、`holder`/`reloadRef`                                                                                                                                                                           | 319–332   | 不动                                                                                                                                              |
| **xs 门控与状态**：`xsEnabled`、`webHubRef`、`xsFencePorts`、`replyEnabled`、`channelsOn`、`aliasOn`、`xsLedger`、`xsCapability`、`xsSessionOf`、`xsAttached`、inbox 三变量 + `refreshXsInbox`、`xsSessionId`、`xsCollisions`、`xsHubLimits` | 333–383   | → `createXsActivation`（P5-5）；`webHubRef`、`xsFencePorts` 留在 index.ts，作为依赖传入                                                           |
| **xs B1** `before_agent_start` + `turn_start/turn_end/agent_end` 转发                                                                                                                                                                        | 385–423   | → `xs.registerTriggerGuard(pi)`（阶段 a）                                                                                                         |
| archive `restoreArchive` + `activateResultTool` + `session_tree`/`session_compact`                                                                                                                                                           | 424–449   | 不动（必须排在 xs fence 的 `session_tree`/`session_compact` 前面）                                                                                |
| **xs fence 钩子** 7 个 + `agent_settled`（xs/rootWake）+ `session_shutdown`（C1，同步）                                                                                                                                                      | 450–493   | → `xs.registerFenceHooks(pi)`（阶段 b）                                                                                                           |
| `memoryWiring.attachTidy`、`publishBackgroundStatus`、claim 释放、`onDisabled` 告警、askUser、`wireCacheTtl`、扩展点、types、compat                                                                                                          | 494–586   | `attachTidy` 的入参改为 `createTidyPort(holder)`（P5-1）；其余不动。`wireCacheTtl(pi` 有源码钉（§3.6）                                            |
| receipt / background-completion 钩子                                                                                                                                                                                                         | 587–600   | 不动（④ 之后只改导入路径）                                                                                                                        |
| **compact 钩子**：`handoffStore`、`loadHintState`、`turn_end`(compact-hint)、`tool_call`/`session_compact`/`model_select`(dynamic)                                                                                                           | 601–632   | → `registerCompactHooks`（P5-4）；`handoffStore`、`loadHintState` 后面还要用，留在 index.ts                                                       |
| load hint / quota hint `turn_end`                                                                                                                                                                                                            | 633–685   | 不动                                                                                                                                              |
| compat 失败桩 + `return`                                                                                                                                                                                                                     | 687–699   | 不动（由 §3.1 的 compat-failure 画像钉住）                                                                                                        |
| schedule（message/orphan guard/wiring/surface/tool/command）                                                                                                                                                                                 | 701–777   | 不动（schedule-off golden 敏感区；#61-C1 的施工区）                                                                                               |
| **xs 发送面**：`xsSender`、`xsHubChannelCap`、`xsAliasUsable`、`xsChannelView`、`createXsSender`、3 个工具、`/fabric`                                                                                                                        | 779–953   | → `xs.registerSurface(pi)`（阶段 c）                                                                                                              |
| fabric entry renderer                                                                                                                                                                                                                        | 955–977   | 不动                                                                                                                                              |
| **核心工具**：`resolveMarkdownTheme`、Agent、get_run_result（+legacy renderer）、list_subagents、steer、set_model、abort、extend（门控）                                                                                                     | 978–1068  | → `registerSubagentTools`（P5-2）                                                                                                                 |
| **compact 工具**：switch_context + `session_before_compact` + `session_compact_failed` + `session_shutdown`(C3) + compact_context + set_compact_threshold                                                                                    | 1069–1141 | → `registerCompactTools`（P5-4）                                                                                                                  |
| **bash 工具**：bash + bash_job                                                                                                                                                                                                               | 1142–1181 | → `registerBashTools`（P5-3）                                                                                                                     |
| promptHub 三段注册、workflow 工具、goal                                                                                                                                                                                                      | 1182–1234 | 不动                                                                                                                                              |
| `activeSubagentRunCount` + `/agent` 命令（deps 约 95 行）                                                                                                                                                                                    | 1235–1331 | 不动（5-7 按拍板取消）                                                                                                                            |
| `/task` + message renderers                                                                                                                                                                                                                  | 1332–1345 | 不动                                                                                                                                              |
| **mention**：`sessionParseDeps`、`sessionNoticeMessage`、`mentionSessions`、`mentionRouteDeps`                                                                                                                                               | 1347–1425 | → `createMentionWiring`（P5-6）                                                                                                                   |
| `wakeAttributeRef` + 两个 `input` 钩子（wake level、root-wake controller）+ `installMentionInput`                                                                                                                                            | 1426–1446 | `wakeAttributeRef` **提前声明**到 xs 段附近（schedule 的闭包也引用它）；两个 input 钩子保持原位；`installMentionInput` 改为 `mention.install(pi)` |
| `session_start`                                                                                                                                                                                                                              | 1448–1585 | ⑤ 只替换其中的 xs 片段和 autocomplete 片段；拆栈部分留给 ⑦                                                                                        |
| `session_shutdown`（主）                                                                                                                                                                                                                     | 1587–1690 | ⑤ 只把 `killBashJobsBounded` 改成导入；其余留给 ⑦                                                                                                 |
| hud / feishu / session-nav / title / deferred reload                                                                                                                                                                                         | 1692–1729 | 不动（注册顺序有约束）                                                                                                                            |
| web-hub（deps 约 140 行）+ `/webhub`                                                                                                                                                                                                         | 1731–1874 | 不动（5-7 取消）                                                                                                                                  |
| topic-switch、traffic host                                                                                                                                                                                                                   | 1876–1920 | 不动                                                                                                                                              |
| 文件尾：`killBashJobsBounded`、`mentionAutocompleteEntries`、`mapMentionSendOutcome`、`requireStack`、`mapTidySpawnRequest`、`forward*` ×8                                                                                                   | 1924–2128 | → `bash/host.ts`、`mention/wire.ts`、`src/holder.ts`                                                                                              |

### 1.3 现有守卫中能当证据用的

| 守卫                                                                                    | 钉住什么                                                                                                                                                             | ④   | ⑤                   | ⑦   |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------- | --- |
| `tests/integration/schedule-off-golden.test.ts` + `schedule-off-golden.json`（A）       | 真实 `activate()` 的**工具顺序**、**命令顺序**、**各事件 handler 数**（`session_start:8`、`session_shutdown:8`、`turn_end:6`、`input:4`……）、system prompt           | ✓   | ✓                   | ✓   |
| `fabric-xs-off` / `fabric-xs-reply-off` / `fabric-wake-off` golden（A）                 | 主会话工具顺序、reserved 名、message_agent schema、web-hub hello/HubConfig                                                                                           | ✓   | ✓                   | ✓   |
| `tests/secure/off-golden.test.ts` + `activation-trace.ts`                               | 用 Proxy 记录真实 `activate()` 的**全部** ExtensionAPI 调用，但只比较各场景之间是否一致。调用总数既没有断言，也没有存档（golden 的 `note` 文本里的数字不受测试约束） | –   | 复用其 harness      | –   |
| `compact-hint-golden.json`（A）+ `tests/integration/compact-dynamic-off-golden.test.ts` | compact-hint 钩子输出的字节                                                                                                                                          | ✓   | ✓                   | –   |
| `bash-tools-golden.json`（A）                                                           | bash/bash_job 工具表面                                                                                                                                               | ✓   | ✓                   | –   |
| `tests/web-hub/agent/input-order.test.ts`                                               | `input` handler 的先后顺序                                                                                                                                           | –   | ✓                   | –   |
| `tests/cache-ttl/measure-command.test.ts:607`                                           | **源码钉**：`index.ts` 里 `wireCacheTtl(pi` 出现在 `if (g[HOST_KEY]) return;` 之后                                                                                   | –   | ✓（保留在原位）     | ✓   |
| `tests/workflow/wc14-testhooks-gate.test.ts:159`                                        | 扫描 `src/index.ts`、`tools/`、`commands/`、`ui/`，不许引用测试专用模块                                                                                              | –   | ✓（要扩展扫描范围） | –   |
| `npm run test:conformance`                                                              | 真实 pi 用 jiti 加载整个包（rpc-spawn、rpc-bash-jobs、slash-args、history-restore 等），以及 fabric C-P/C-X、schedule C-S                                            | ✓   | ✓                   | ✓   |

---

## 2. ④ `stack.ts` 机械下沉（包 P4，单 writer，6+1 个提交）

### 2.1 目标结构

```
src/stack.ts                  —— 只剩：18×previous*、WorkflowSupport/StackModelPort/Stack 接口、
                                 StackExternalInput、小工具（hostWarn/safeSet*/rankLoadLevel）、buildSessionStack
src/bash/notify.ts      (新)  —— bash 完成/宽限/延长通知的 customType、格式化、日志 tail 读取（纯格式层，值导入 pi 的 formatSize）
src/bash/host.ts        (新)  —— 主会话 bash 宿主侧：开关判定、manager 组装、恢复双定时器、返回滞后告警、
                                 SEAL 宽限常量（⑤ 再把 killBashJobsBounded / registerBashTools 放进来）
src/adapters/session-id.ts (新) —— currentSessionId(ctx)
src/compact-hint/hook.ts (新) —— CompactHintState、CompactHintHolder、createCompactHintHook
src/delivery/stack-hooks.ts (新) —— createNotificationReceiptHook、createBackgroundCompletionEventHook
src/fabric/stack.ts     (新)  —— buildFabric（改为 export）
src/fabric/xs/stack.ts  (新)  —— StackXsInput、StackXs、StackXsReply、XS_REPLY_INBOUND_SCAN_CAP、buildStackXs（改为 export）
```

依赖方向：`stack.ts → {bash/notify, bash/host, compact-hint/hook, delivery/stack-hooks, fabric/stack, fabric/xs/stack, adapters/session-id}`。这些新文件**不准**值导入 `stack.ts`。需要 `Stack` 类型的地方，改用 §2.3 收窄后的 holder 类型。按这个设计，没有新文件需要导入 `Stack`。

### 2.2 符号移动清单（精确到声明）

**通用规则**：声明体逐字移动，被移声明上方的文档注释块跟着一起走。只允许下面几种改动：

- (a) 给原来不导出的声明加 `export`，只限清单里标了「→导出」的；
- (b) import 语句；
- (c) §2.3 列出的 holder 参数**类型**收窄；
- (d) 把 `src/` 下注释里对旧位置的引用改成新位置。

| 提交 | 新文件                        | 移入的声明（`43d892fd` 行号）                                                                                                                                                                                                                                                                                                                                                                                                                         | 新文件需要的导入（实施时以 tsc 为准；绑定以 §2.5 第 1 条的机器检查为准）                                                                                                                                                                                                                                                                                                                                                                                             | 要改导入的地方                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4-1  | `src/bash/notify.ts`          | `BASH_JOB_NOTIFICATION_TYPE`(305)、`BASH_JOB_TAIL_BYTES`(307)、`BASH_JOB_TAIL_LINES`(308)、`bashJobElapsedMs`(359)、`bashJobOutcomePhrase`(364，私有)、`formatBashJobNotification`(382)、`BASH_JOB_DEADLINE_NOTIFICATION_TYPE`(414)、`BASH_JOB_GRACE_SUGGESTED_EXTEND_S`(417，私有)、`formatBashJobGraceNotice`(427)、`formatBashJobExtendedNotice`(451)、`tailOffset`(464，私有)、`BashJobTail`(468)、`lastLines`(475，私有)、`readBashJobTail`(490) | `formatSize`（pi-coding-agent，值导入）；`describeJobStatus`/`previewCommand`/`isTerminalJobStatus`/`type JobRecord` 一律从 **`./types.js`** 导入（`describeJobStatus` 定义在 `bash/types.ts:180`，`job-tool.ts` 只是转发，不从 job-tool 导入可以避免 notify → job-tool 的工具组装依赖）；`type BashJobManager`（`./manager.js`）；`formatDuration` 从 **`../core/format.js`** 导入（`ui/fleet-panel.ts:14,20` 转发的就是这个绑定，从源头导入可以避免 bash → ui 边） | src：`src/index.ts`（`readBashJobTail`）、`src/todo/index.ts:37`（`BASH_JOB_NOTIFICATION_TYPE`）、`src/stack.ts`（buildSessionStack 内部仍在用的符号）。tests：`tests/conformance/ask-user-wired.test.ts`、`tests/integration/bash-jobs-wiring.test.ts`（`formatBash*`、`readBashJobTail`）、`tests/todo/nudge-wiring.test.ts`                                                                                                                                                                                                                                                                                                                           |
| 4-2  | `src/bash/host.ts`            | `BASH_JOB_SEAL_GRACE_MS`(314)、`BASH_JOB_TOOL_LAG_WARN_MS`(316)、`checkBashToolReturnLag`(327)、`bashJobsEnabled`(354)、`buildBashJobManager`(748，→导出)、`BASH_JOB_RECOVERY_DEADLINE_MS`(846)、`BASH_JOB_RECONCILE_DEADLINE_MS`(848)、`scheduleBashJobRecovery`(873)                                                                                                                                                                                | `getAgentDir`（pi，值导入）、`ExtensionAPI`/`ExtensionContext`（type）、`mkdir`/`writeFile`、`join`、`systemClock`、`createBashJobManager`、`createJobStore`、`sanitizeSessionDirName`、`createProcessPort`、`type PiShellSettings`、`type AgentSettings`、`type SendMessageFn`（`../service/background-completions.js`）、`./notify.js`、`../adapters/session-id.js`                                                                                                | src：`src/index.ts`（`bashJobsEnabled`、`BASH_JOB_SEAL_GRACE_MS`）、`src/stack.ts`。tests：`tests/integration/child-bash-jobs.test.ts`（`bashJobsEnabled`、`checkBashToolReturnLag`、`scheduleBashJobRecovery`）、`tests/integration/bash-jobs-wiring.test.ts`（`bashJobsEnabled`）                                                                                                                                                                                                                                                                                                                                                                      |
| 4-2  | `src/adapters/session-id.ts`  | `currentSessionId`(729)                                                                                                                                                                                                                                                                                                                                                                                                                               | `type ExtensionContext`                                                                                                                                                                                                                                                                                                                                                                                                                                              | `src/stack.ts`（4 处）、`src/bash/host.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 4-3  | `src/compact-hint/hook.ts`    | `CompactHintState`(951–987)、`createCompactHintHook`(1172–1512)，外加新增的 `export interface CompactHintHolder`（§2.3）                                                                                                                                                                                                                                                                                                                              | `./threshold.js`（12 个符号）、`./dynamic/threshold.js`、`./dynamic/markers.js`、`type DynamicRuntime`（`./dynamic/wire.js`）、`type DynamicThresholdOutcome, ThresholdBasis`、`RESUME_TEXT`（`./compact-tool.js`）、`type ExtensionContext`                                                                                                                                                                                                                         | src：`src/index.ts`；`src/context-switch/child.ts:28`（值 + type；`:305` 的 `{} as { current?: Stack }` 改成 `{} as CompactHintHolder`，并删掉对 `Stack` 的 type 导入，**context-switch → stack 这条值边随之消失**）；`src/compact-hint/threshold-tool.ts:12`（type）；`src/stack.ts`（`Stack.compactHint` 字段类型、build 内的构造）。scripts：`scripts/exp/compact-dynamic-smoke.ts`。tests：`tests/compact-hint/{headless,threshold-tool}.test.ts`、`tests/integration/{compact-dynamic-wiring,compact-hint-wiring}.test.ts`、`tests/integration/helpers/compact-hint-golden.ts`（这些文件把 `as Stack` 当类型断言用，可以继续从 stack.js 导入 type） |
| 4-4  | `src/fabric/stack.ts`         | `buildFabric`(521–727，→导出)                                                                                                                                                                                                                                                                                                                                                                                                                         | 约 25 个 fabric/delivery/core/adapters 符号（照搬 stack.ts 现有的导入，按 tsc 增删）                                                                                                                                                                                                                                                                                                                                                                                 | 只有 `src/stack.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4-5  | `src/fabric/xs/stack.ts`      | `StackXsInput`(1607)、`StackXs`(1626)、`StackXsReply`(1647)、`XS_REPLY_INBOUND_SCAN_CAP`(1662)、`buildStackXs`(1665–2058，→导出)                                                                                                                                                                                                                                                                                                                      | unread、membership、channel、inbox、directory、receiver、reply-ledger、reply-notice、fence、root-wake、`type XsStackPort`（`../../web-hub/agent/xs.js`，**只许 type 导入**）、`type GoalSessionStartReason`、`type CausalLevel` 等                                                                                                                                                                                                                                   | src：`src/commands/status.ts:32`（type `StackXs`）、`src/stack.ts`（`Stack.xs` 字段、build 参数 `xsInput: StackXsInput`）。tests：`tests/commands/status-xs.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 4-6  | `src/delivery/stack-hooks.ts` | `createNotificationReceiptHook`(1514)、`createBackgroundCompletionEventHook`(1532)                                                                                                                                                                                                                                                                                                                                                                    | `runIdsFromNotificationDetails`（`./context-receipt.js`）、`type ContextReceiptTracker`、`type BackgroundCompletionHub`                                                                                                                                                                                                                                                                                                                                              | src：`src/index.ts`。tests：`tests/integration/{context-receipt-wiring,ask-user-interrupt,fabric-wake-quiet}.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

> `src/` 里要同步改的注释（只改路径和位置描述，§2.6 的 rg 必须 0 命中）：
>
> - `src/bash/child.ts:41`（「Mirrors `src/stack.ts`'s … `buildBashJobManager`」）；
> - `src/index.ts:1139`（「src/stack.ts's `buildBashJobManager`」）；
> - 新文件里自己引用旧位置的注释。
>
> `src/context-switch/child.ts:221`（「mirrors `src/stack.ts`'s main-session construction」）**保留**：它描述的构造仍然在 stack.ts 里。tests 里的注释不强制改。

### 2.3 允许的类型层改动（收窄 holder，切断反向边）

被移走的三个钩子各自只读 `Stack` 的一个字段。已核实：`createCompactHintHook` 只用 `holder.current?.compactHint`，另外两个分别只用 `contextReceipt` 和 `backgroundCompletions`。把参数类型改成只含这个字段的结构化窄类型，运行时零变化，调用方传入的 `{ current?: Stack }` 仍然可以赋值：

```ts
// src/compact-hint/hook.ts
export interface CompactHintHolder {
  current?: { compactHint: CompactHintState };
}
export function createCompactHintHook(holder: CompactHintHolder, deps: /* 原样 */): (event: unknown, ctx: ExtensionContext) => void;

// src/delivery/stack-hooks.ts
export function createNotificationReceiptHook(holder: {
  current?: { contextReceipt: ContextReceiptTracker };
}): (event: { message: { role?: string; customType?: string; details?: unknown } }) => void;
export function createBackgroundCompletionEventHook(holder: {
  current?: { backgroundCompletions: BackgroundCompletionHub };
}): {
  /* 返回类型原样 */
};
```

除了这三处签名和 `context-switch/child.ts:305` 的类型断言，**不准**改任何其它类型。唯一的例外见 R4a。

### 2.4 提交粒度

| 提交 | 标题（Conventional Commits）                                                                   | 独立可绿 |
| ---- | ---------------------------------------------------------------------------------------------- | -------- |
| 4-0  | `test(governance): pin activate() call traces as a registration-order golden`（§3.1，⑤⑦ 共用） | ✓        |
| 4-1  | `refactor(bash): move bash job notice formatting out of stack.ts`                              | ✓        |
| 4-2  | `refactor(bash): move host bash job manager assembly and recovery out of stack.ts`             | ✓        |
| 4-3  | `refactor(compact-hint): move the compact hint hook out of stack.ts`                           | ✓        |
| 4-4  | `refactor(fabric): move buildFabric out of stack.ts`                                           | ✓        |
| 4-5  | `refactor(fabric): move the cross-session stack builder out of stack.ts`                       | ✓        |
| 4-6  | `refactor(delivery): move holder-routed delivery hooks out of stack.ts`                        | ✓        |

4-2 的 host.ts 要导入 notify.ts，所以 4-2 排在 4-1 后面。4-3 到 4-6 两两之间没有文件交集，但都要改 `stack.ts` 的 import 段，由同一个 writer 串行做，避免机械冲突。

### 2.5 行为零变化的证明手段

1. **声明体逐字一致，且自由标识符绑定到同一个声明（主证据，全部机器枚举）**。verifier 用 TypeScript 编译器 API 写一个临时脚本，放 `/tmp`，不入库。仓库里有 `typescript@6.0.2`，没有 ts-morph，用原生的 `ts.createProgram` + `TypeChecker` 就够了。步骤：
   - **基线树**：`git archive <base> | tar -x -C /tmp/sg-base`（不在仓库里做 git 写操作），再用 `ln -s` 把仓库的 `node_modules` 链接进去，基于 `tsconfig.json` 建一个 Program；**新树**直接用工作区建 Program。
   - **(1a) 文本**：对 §2.2 的每个符号，取出声明节点（连同前导 JSDoc）的文本，去掉行首 `export `、逐行 trim 后比较。允许的差异只有 §2.3 那三处签名行。
   - **(1b) 绑定**：遍历声明体内的每个 `Identifier`（包括类型位置），用 `checker.getSymbolAtLocation` 取符号；如果是别名，用 `getAliasedSymbol` 一直解析到底。声明不在本声明内部的就是**自由标识符**。对每个自由标识符记录 `(声明所在文件相对仓库根的路径, 声明名)`，新旧两棵树的结果必须**完全相等**。例外只有 §2.3 新增的三个类型名（`CompactHintHolder` 和两个内联窄类型），也由机器检查：例外集合必须精确等于这三个名字，多一个少一个都算失败。这样不再需要人工白名单：`formatDuration` 在两棵树里都会解析到 `src/core/format.ts`（fleet-panel 只是转发），`describeJobStatus` 都会解析到 `src/bash/types.ts:180`。从错误的模块导入同名符号会被直接抓住。
   - **输出**：`符号 | 旧位置 | 新位置 | text: identical/whitelisted | bindings: N identical / 0 diff` 表，贴进报告。
2. **冻结 golden 不动**：`git diff <base>..HEAD -- tests/fixtures` 为空（4-0 新增的 governance golden 除外，它只增不改）。重点套件：`tests/integration/compact-dynamic-off-golden.test.ts`、`tests/bash/tools-golden.test.ts`、`tests/integration/{fabric-xs-off,fabric-xs-reply-off,fabric-wake-off,schedule-off}-golden.test.ts`、`tests/secure/off-golden.test.ts`。
3. **激活轨迹不变**：4-1 到 4-6 的每个提交都要让 `tests/governance/activate-trace.test.ts` 全绿。④ 本来不碰 `activate()`，这一条是防误伤。
4. **反向边消失**（设计收益的证据）：`rg -n 'from "\.\./stack\.js"' src/todo src/context-switch src/compact-hint` 只剩 `src/context-switch/session-facts.ts`（type `Stack`，属于合理的类型依赖）。
5. **I5 计数守恒**：基线 stack.ts 里 `unref` 的出现次数（`rg -c 'unref'`）必须等于新 stack.ts 加 6 个新文件的计数之和。

### 2.6 每步验收命令

每个提交都跑：

```sh
npm run format:check && npm run typecheck && npm run build
# 新文件与 stack.ts 不得出现未用导入（基线 0）
node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.json --noUnusedLocals 2>&1 \
  | grep -E '^src/(stack|bash/(notify|host)|adapters/session-id|compact-hint/hook|delivery/stack-hooks|fabric/stack|fabric/xs/stack)\.ts' ; test $? -eq 1
# §2.5-1 的文本 + 绑定双检查（/tmp 脚本），输出表贴进报告
node /tmp/sg-decl-check.mjs --base <base> --symbols <本提交移动的符号表>
# 旧位置引用（src 里的注释和字符串）
rg -n 'stack\.ts.{0,60}(buildBashJobManager|formatBashJob|readBashJobTail|scheduleBashJobRecovery|createCompactHintHook|buildFabric|buildStackXs|createNotificationReceiptHook|createBackgroundCompletionEventHook)' src
git diff --quiet <base> -- tests/fixtures ':!tests/fixtures/governance'
npx vitest run tests/governance
```

按提交补跑的定向测试（都用 `npx vitest run …`）：

- 4-1/4-2：`tests/bash tests/todo tests/integration/bash-jobs-wiring.test.ts tests/integration/child-bash-jobs.test.ts tests/integration/bash-auto-background.test.ts tests/integration/child-bash-exit-facts.test.ts tests/conformance/ask-user-wired.test.ts tests/conformance/rpc-bash-jobs.test.ts`
- 4-3：`tests/compact-hint tests/context-switch tests/integration/compact-hint-wiring.test.ts tests/integration/compact-dynamic-wiring.test.ts tests/integration/compact-dynamic-off-golden.test.ts tests/integration/child-context-switch.test.ts tests/integration/context-switch-wiring.test.ts`
- 4-4/4-5：`tests/fabric tests/commands/status-xs.test.ts tests/integration/fabric-wiring.test.ts tests/integration/fabric-wake.test.ts tests/integration/fabric-wake-level.test.ts tests/integration/fabric-wake-quiet.test.ts tests/integration/fabric-wake-revive.test.ts tests/integration/fabric-wake-subscribers.test.ts tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts tests/conformance/fabric-wake.test.ts tests/conformance/fabric-xs.test.ts`
- 4-6：`tests/integration/context-receipt-wiring.test.ts tests/integration/ask-user-interrupt.test.ts tests/integration/fabric-wake-quiet.test.ts tests/integration/notification-complement.test.ts`
- 包收口（P4 最后一个提交之后）：`npm test` 全量，再跑 `npm run test:conformance`。后者是真实 jiti 加载门禁，参照第一批 §4.4(b)，其中 rpc-spawn、rpc-bash-jobs、slash-args、history-restore 必须跑过。因为门控被 skip 的套件必须写明原因，由主会话收口时补跑。

### 2.7 非目标与风险

- **非目标**：
  - 不拆 `buildSessionStack` 内部。按「运行时/投递/外部/workflow/web 端口」分子函数，就要在子函数之间传一大串局部 ref（`runnerRef`、`widgetRef`、`quotaRef`、`spawnRef` 等），而且和 ⑦ 的拆栈顺序强相关，等 ⑦ 做完再评估。
  - 不移动 `Stack` 接口。
  - 不动 `hostWarn`（只有 stack 自己在用，移走没有收益）。
- 风险：

| #   | 风险                                                                                   | 缓解                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R4a | `declaration: true` 下，导出的 `buildFabric` 推断出的返回类型无法命名（TS2742/TS4058） | `npm run build` 会报出来。真报错时，给 `buildFabric` 补一个显式返回类型 `export interface BuiltFabric {…}`。这是纯类型层改动，算作 §2.3 例外集合的追加项：§2.5-1b 的例外名单相应加一项，并在报告里注明 |
| R4b | 模块初始化顺序变化                                                                     | 文件级值导入图无环（analysis §2.2）；新文件顶层只有 `const` 字面量和函数声明，没有副作用。另外补跑 `tests/integration/traffic-lifecycle-process.test.ts`、`tests/integration/entry-loader.test.ts`     |
| R4c | `fabric/xs/stack.ts` 被 hub 闭包间接导入                                               | hub 只白名单了 `fabric/xs/channel.ts`（`tests/web-hub/boundary.test.ts:105,125`），新文件不在 hub 闭包里，boundary 测试会自动兜底                                                                      |
| R4d | 与并行功能包在 `stack.ts` 的 import 段机械冲突                                         | 冻结窗口（拍板第 1 条）；开工前跑 §8.1 预检                                                                                                                                                            |

---

## 3. ⑤ `index.ts` 抽子 wire（包 P5，单 writer，串行于 ④，7 个提交）

### 3.1 先决守卫：激活调用轨迹（提交 4-0，④⑤⑦ 共用；B 档契约 golden）

**为什么需要**：pi 按**注册顺序**分发同一事件的多个 handler。I3 的 pre/post-guard 规则、「deferred reload 必须排在 session-nav 之后」、「topic-switch 的 input 必须最后」都依赖这一点。现有 golden 只钉了工具顺序、命令顺序和**各事件的 handler 数**，没有钉住 handler 之间的**先后**。⑤ 要把散在 `activate()` 各处的注册收进子函数，最大的风险就是顺序漂移。

**做法**：新增 `tests/governance/activate-trace.test.ts`、`tests/governance/trace-profiles.ts` 和 golden `tests/fixtures/governance/activate-trace.json`。记录器复用 `tests/secure/activation-trace.ts` 的 Proxy：把它挪到 `tests/helpers/activation-trace.ts`，secure 测试只改导入；同时给它加一个 `omit?: readonly string[]` 选项，被 omit 的属性在 Proxy 上读出来是 `undefined`，用于构造 compat 失败。

- **阶段 1 轨迹**：`traceActivation(activate)` 记录的有序调用串，包括 `on(event)`、`registerTool(name)`、`registerCommand(name)`、`registerMessageRenderer(type)`、`registerEntryRenderer(type)`、`registerToolRenderer(name)`、`events.on(ch)` 等。
- **阶段 2 轨迹**（⑤ 改 session_start 片段、⑦ 改拆栈时需要）：用 `tests/integration/helpers/schedule-activate.ts` 的 `fakePi`/`fakeCtx`，依次 emit `session_start{reason:"startup"}` → `session_shutdown{reason:"new"}` → `session_start{reason:"new"}`。期间用 Proxy 记录 pi 上和 `ctx.ui` 上的调用：`sendMessage`、`appendEntry`、`setStatus`、`setWidget`、`addAutocompleteProvider`、`notify`。
- **golden 内容**：每个画像存 `{ calls: string[], count: number, phase2: string[], phase2Count: number }`。`count` 就是调用总数，单独断言一次（评审 nit：总数写进 golden）。
- **画像**（profiles）：
  1. `default`：设置文件为空；
  2. `minimal`：`schedule-activate.ts` 的 `BASELINE`（合并插件全部关闭）；
  3. `max`：所有能离线运行的开关全开：fabric + wake + crossSession(xs) + reply + channels + alias、compact.switchTool + keepCompactTool、bashJobs、extend、workflow、load、quota、cacheTtl.keepalive、schedule、topicSwitch、askUser、todo(nudge)、memory、webSearch、title、hud、sessionNav，以及 `webHub.enabled` + `autoStart:false`；
  4. `child`：先设置 `Symbol.for("pi-subagent:host")`，走子会话路径；
  5. **`compat-failure`**（评审 nit）：`omit: ["appendEntry"]`，于是 `assertCompatible` 返回 `ok:false`（`src/adapters/pi-compat.ts:226-236`）。这个画像钉住 `index.ts:687-699` 早退段的桩工具 `Agent (unavailable)`，以及它前面已经注册的部分。这个画像只跑阶段 1。
- **开工前要验证**：`max` 画像在激活和阶段 2 期间不能产生真实网络连接或子进程（web-hub 用 `autoStart:false`，HOME 指向沙箱；测试里把 `node:net.connect` 和 `node:child_process.spawn` 打桩成抛错）。做不到的开关从 `max` 里拿掉，并在测试文件头写明原因。
- **更新规则**（B 档）：只有在有意新增或调整注册时，才用 `PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance` 重新生成，并在 commit 里说明原因。本批的所有治理提交都**不允许**更新它。
- **AGENTS.md 同步**（评审 nit）：4-0 这个提交要在 AGENTS.md「Frozen artifacts」表的 B 档里追加 `governance/activate-trace.json`（registration-order contract；按上面的更新规则刷新）。还要确认 `tests/docs/agents-md.test.ts` 仍然通过：K4 只校验 A/A′ 档，体量上限是 32 KiB，追加一行不会超。

### 3.2 目标结构

```
src/index.ts                —— activate()：pre-guard、HOST_KEY、settings、holder/ref 声明、各 wire 调用（按原位置）、
                               session_start / session_shutdown（拆栈部分留给 ⑦）、/agent、合并插件、web-hub、topic-switch、traffic
src/holder.ts         (新)  —— StackHolder 类型、requireStack、forward*×8、createTidyPort
src/tools/register.ts (新)  —— registerSubagentTools（7 个核心工具 + legacy result renderer）
src/bash/host.ts      (④建)—— + registerBashTools、killBashJobsBounded
src/compact-hint/register.ts (新) —— registerCompactHooks、registerCompactTools
src/fabric/xs/activate.ts (新) —— createXsActivation：xs 门控/状态 + 分阶段注册 + session_start 片段 + web-hub/build 的 xs 入参
src/mention/wire.ts   (新)  —— createMentionWiring：@run / @session 路由依赖、session 通知、autocomplete 挂载；
                               mentionAutocompleteEntries、mapMentionSendOutcome
```

依赖方向：`index.ts → 上面各模块 → holder.ts / stack.ts（type）`。子 wire 之间只能单向依赖：`mention/wire → fabric/xs/activate`（需要 xs 的 sender/attached/directory）。**禁止**子 wire 反向导入 `index.ts`。

### 3.3 接口契约

```ts
// src/holder.ts
import type { Stack } from "./stack.js";
export type StackHolder = { current?: Stack };
export function requireStack(holder: StackHolder): Stack; // 抛错文案逐字保留 "pi-subagent: no active session yet"
export function forwardSpawn(holder: StackHolder): SpawnService;
export function forwardResolveRun(holder: StackHolder): (handle: string) => ResolvedRun; // 文案 "pi-subagent: run resolver unavailable"
export function forwardQuery(holder: StackHolder): QueryService;
export function forwardWorkflow(holder: StackHolder, isReloadPending: () => boolean): WorkflowToolDeps;
export function forwardWorkflowQuery(holder: StackHolder): WorkflowQueryPort;
export function forwardBashJobs(holder: StackHolder): () => BashJobManager | undefined;
export function forwardOrphans(holder: StackHolder): OrphanRegistry;
export function forwardNotifier(holder: StackHolder): Notifier;
/** 原 index.ts:494-500 的对象字面量 + mapTidySpawnRequest（私有，逐字移动）。 */
export function createTidyPort(holder: StackHolder): TidyPort;
```

```ts
// src/tools/register.ts —— 原 index.ts:978-1068 逐字搬进函数体，局部变量改从 deps 取
export interface SubagentToolsDeps {
  holder: StackHolder;
  settings: AgentSettings; // 传引用（budget 等字段会被原地修改，不能拷贝）
  caps: PiCapabilities; // 用到 caps.canSetModel
  isReloadPending: () => boolean;
}
export function registerSubagentTools(pi: ExtensionAPI, deps: SubagentToolsDeps): void;
// 顺序固定：Agent → get_run_result →（有 registerToolRenderer 时）legacy renderer → list_subagents → steer_subagent → set_model → abort_subagent →（extend.enabled 时）extend_subagent_timeout
```

```ts
// src/compact-hint/register.ts
export function registerCompactHooks(
  pi: ExtensionAPI,
  deps: {
    holder: StackHolder;
    handoffStore: PendingHandoffStore;
  },
): void; // 原 606-632：turn_end(createCompactHintHook) → tool_call → session_compact → model_select
export function registerCompactTools(
  pi: ExtensionAPI,
  deps: {
    holder: StackHolder;
    settings: AgentSettings;
    handoffStore: PendingHandoffStore;
    todoTracker?: () => TodoTrackerSnapshot; // 只在 todoWiring?.getTrackerSnapshot 存在时传入（保留原来的展开写法）
  },
): void; // 原 1069-1141，整段在 settings.compact.enabled 门控之内
```

```ts
// src/bash/host.ts（在 ④ 的基础上追加）
export function registerBashTools(pi: ExtensionAPI, deps: { holder: StackHolder; settings: AgentSettings }): void; // 原 1142-1181；调用方仍然用 if (bashJobsEnabled(settings)) 包住
export async function killBashJobsBounded(bashJobs: BashJobManager, graceMs: number): Promise<void>; // 原 1924-1931，逐字移动
```

```ts
// src/fabric/xs/activate.ts
export interface XsActivationDeps {
  settings: AgentSettings;
  holder: StackHolder;
  webHubRef: { current?: WebHubControl };
  fencePorts: { topicSwitch?: () => boolean; goal?: () => boolean }; // 就是 index.ts 的 xsFencePorts（schedule/goal/topic-switch 也会写它）
  notifyCtx: { current?: ExtensionContext }; // 就是 notifyCapabilityCtx（alias 建议、alias-lost 提示）
  scheduleMessage: () => { resetBlockers(): void } | undefined; // 晚绑定（/fabric 的 afterFenceReset）
}
export interface XsActivation {
  // —— 激活期冻结的门控（原 xsEnabled / replyEnabled / channelsOn / aliasOn）
  readonly enabled: boolean;
  readonly replyEnabled: boolean;
  readonly channelsOn: boolean;
  readonly aliasOn: boolean;
  attached(): boolean; // 原 xsAttached
  hubChannelCap(): boolean; // 原 xsHubChannelCap
  aliasUsable(): boolean; // 原 xsAliasUsable
  readonly channelView: XsChannelView; // 原 xsChannelView
  sender(): XsSender | undefined; // 原 xsSender（阶段 c 之后才有值）
  // —— 分阶段注册：每个方法都在原代码块所在的位置调用
  registerTriggerGuard(pi: ExtensionAPI): void; // a：原 385-423
  registerFenceHooks(pi: ExtensionAPI): void; // b：原 450-493（fence ×7、agent_settled、session_shutdown C1）
  registerSurface(pi: ExtensionAPI): void; // c：原 779-953（sender、2 或 3 个工具、/fabric）
  // —— session_start 片段（原 1449-1451、1463-1465、1488-1506、1510-1541）
  beginSessionStart(ctx: ExtensionContext): void; // xsAttached=false；算出 nextXsSessionId
  defensiveTeardown(): void; // 原 1463-1465：会话身份变了就 ledger.teardown（⑦ 之后改由 Stack.dispose 的 env 调用）
  stackInput(): StackXsInput | undefined; // 原 1491-1506，作为 buildSessionStack 的入参
  attach(stack: Stack, ctx: ExtensionContext, pi: ExtensionAPI): void; // 原 1508-1541：xsSessionId、inbox 重渲染、attached、工具冲突检测
  webHubDeps(): { xs?: WebHubXsDeps }; // 原 1745-1790 的 `...(xsEnabled ? { xs: {...} } : {})`
}
export function createXsActivation(deps: XsActivationDeps): XsActivation;
```

```ts
// src/mention/wire.ts
export interface MentionWiringDeps {
  pi: ExtensionAPI;
  settings: AgentSettings;
  holder: StackHolder;
  xs: XsActivation;
  webHubRef: { current?: WebHubControl };
  notifyCtx: { current?: ExtensionContext };
}
export interface MentionWiring {
  readonly routeDeps: MentionRouteDeps; // 原 mentionRouteDeps（web-hub 的 mention dep 也要用）
  sessionNoticeMessage(notice: SessionMentionNotice): {
    customType: string;
    content: string;
    display: true;
    details: unknown;
  };
  install(pi: ExtensionAPI): void; // = installMentionInput(pi, routeDeps)，在两个 input 钩子之后调用（原 1446）
  attachAutocomplete(ctx: ExtensionContext): void; // 原 1542-1572（ctx.hasUI ∧ addAutocompleteProvider 的门控留在函数内部）
}
export function createMentionWiring(deps: MentionWiringDeps): MentionWiring;
export function mentionAutocompleteEntries(holder: StackHolder): readonly MentionAutocompleteEntry[]; // 原 1944，逐字移动
// src/index.ts 保留：export { mentionAutocompleteEntries } from "./mention/wire.js";
```

**错误约定**：所有 `throw new Error(...)` 的文案和 `console.warn("[pi-subagent] …")` 的前缀逐字保留。不新增任何 try/catch，也不删除任何 try/catch。

### 3.4 提交清单（每个提交独立可绿；下表顺序就是执行顺序）

| 提交 | 内容                                                                                     | 移动/抽取的符号（`43d892fd` 行号）                                                                                                                                                                                                                                                               | 风险点                                                                                                                                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5-0  | `refactor(index): drop imports left behind by the stack extraction`                      | 删除 §1.2 的 17 个死导入符号                                                                                                                                                                                                                                                                     | 其中 **14 个是值导入**（runtime/service/delivery/adapters/core 模块），删掉以后这些模块首次求值的时机会后移。它们顶层没有副作用（I4），而且 stack.ts 仍然会导入它们。需要补跑 `tests/integration/entry-loader.test.ts`、`traffic-lifecycle-process.test.ts` 和真实加载门禁                                                |
| 5-1  | `refactor(index): move holder forwarders to src/holder.ts`                               | `requireStack`(1996)、`mapTidySpawnRequest`(2004)、`forwardSpawn`(2020)、`forwardResolveRun`(2039)、`forwardQuery`(2046)、`forwardWorkflow`(2058)、`forwardWorkflowQuery`(2069)、`forwardBashJobs`(2085)、`forwardOrphans`(2088)、`forwardNotifier`(2108)；494-500 改为 `createTidyPort(holder)` | 纯移动。`forward*` 内部的 getter（`get recent()` 等）逐字保留，以保持 `this` 语义。§3.4 末段的 wc14 扫描范围扩展也放在这个提交里                                                                                                                                                                                          |
| 5-2  | `refactor(index): register the subagent core tools from tools/register.ts`               | 978-1068（含 `resolveMarkdownTheme`）                                                                                                                                                                                                                                                            | 工具顺序由 schedule-off/xs-off golden 钉死；`settings.extend.enabled` 门控随代码一起移入                                                                                                                                                                                                                                  |
| 5-3  | `refactor(bash): register the bash tools from bash/host.ts`                              | 1142-1181 → `registerBashTools`；`killBashJobsBounded`(1924)                                                                                                                                                                                                                                     | `bash-tools-golden`                                                                                                                                                                                                                                                                                                       |
| 5-4  | `refactor(compact-hint): register compact hooks and tools from compact-hint/register.ts` | 606-632 → `registerCompactHooks`；1069-1141 → `registerCompactTools`                                                                                                                                                                                                                             | 两个调用点各自留在原位置。`turn_end` 的顺序（compact → load → loadStatus → quota）以及 `session_shutdown` 里 C3（`handoffStore.clear`）排在 C4 前面，都由轨迹钉住                                                                                                                                                         |
| 5-5  | `refactor(fabric): wire cross-session activation from fabric/xs/activate.ts`             | 333-383（`webHubRef`/`xsFencePorts` 除外）、385-423、450-493、779-953、session_start 里的 xs 片段、web-hub deps 里的 xs 块                                                                                                                                                                       | **风险最高的提交**。xs 状态被很多闭包分散捕获。`xsAttached` 这类 `let` 会变成 activation 对象内部的 `let`，所有读点都要改成经 `xs.attached()` 读取，不能被复制成快照值（`rg -n 'xsAttached' src/index.ts` 必须 0 命中）。三个注册阶段在原位置调用。验收必须跑完 fabric-xs 的全部 golden 和 conformance C-X1–C-X11         |
| 5-6  | `refactor(mention): wire mentions from mention/wire.ts`                                  | 1347-1425、1446、1542-1572、`mentionAutocompleteEntries`(1944)、`mapMentionSendOutcome`(1967)；`wakeAttributeRef` 提前到 xs 段附近声明                                                                                                                                                           | `input` 顺序是 wake-level → controller → mention → (web-hub) → topic-switch，由 `tests/web-hub/agent/input-order.test.ts` 和轨迹共同钉住。公开面要保留 re-export（§0.2 第 3 条）。`tests/integration/mention-autocomplete-wiring.test.ts` 改从 `src/mention/wire.js` 导入（继续从 `src/index.js` 导入也行，有 re-export） |

5-7（把 `/agent` deps 和 web-hub deps 移出 `activate()`）**按拍板第 4 条取消**。

**注释与源码钉**：`tests/cache-ttl/measure-command.test.ts:607` 钉住的 `wireCacheTtl(pi` 留在 index.ts 原位。`tests/workflow/wc14-testhooks-gate.test.ts:159` 的 `productionGlobs` 在 5-1 里追加 `src/holder.ts`、`src/fabric/xs/activate.ts`、`src/mention/wire.ts`、`src/compact-hint/register.ts`、`src/bash/host.ts`（`src/tools/` 已经在扫描范围内）。只许追加，不许删减。

### 3.5 行为零变化的证明手段

1. **激活轨迹 golden 全绿**（§3.1，5 个画像 × 阶段 1/2，外加调用计数），每个提交都比对，任何一行差异都算失败。**这是 ⑤ 的主证据**：它直接证明注册顺序和 session_start 期间对外可见的副作用顺序都没变。
2. **A 档 golden 零 diff**：schedule-off（工具顺序、命令顺序、handlerCounts、system prompt）、fabric-xs-off/reply-off/wake-off、secure-off、compact-hint、bash-tools。
3. **源码钉与顺序测试**：`tests/cache-ttl/measure-command.test.ts`、`tests/web-hub/agent/input-order.test.ts`、`tests/reload/activation.test.ts`、`tests/integration/merged-plugins-wiring.test.ts`、`tests/workflow/wc14-testhooks-gate.test.ts`。
4. **未用导入归零**：`tsc --noUnusedLocals` 对 `src/index.ts` 和 §3.2 的新文件报 0 条（5-0 之后的基线就是 0）。
5. **体量指标**（不是门禁，写进报告）：`activate()` 的行数，5-6 之后预计约 1050 行，⑦ 之后约 900 行。

### 3.6 每步验收命令

每个提交都跑：

```sh
npm run format:check && npm run typecheck && npm run build
npx vitest run tests/governance tests/integration/schedule-off-golden.test.ts tests/integration/fabric-xs-off-golden.test.ts \
  tests/integration/fabric-xs-reply-off-golden.test.ts tests/integration/fabric-wake-off-golden.test.ts tests/secure/off-golden.test.ts \
  tests/cache-ttl/measure-command.test.ts tests/web-hub/agent/input-order.test.ts tests/reload/activation.test.ts \
  tests/integration/merged-plugins-wiring.test.ts tests/workflow/wc14-testhooks-gate.test.ts
git diff --quiet <base> -- tests/fixtures
```

按提交补跑：

- 5-0：`tests/integration/entry-loader.test.ts tests/integration/traffic-lifecycle-process.test.ts tests/conformance/rpc-spawn.test.ts`
- 5-1：`tests/integration/workflow-background-wiring.test.ts tests/integration/explicit-timeout-e2e.test.ts tests/memory tests/commands/status.test.ts`
- 5-2：`tests/tools tests/conformance/result-tool-rename.test.ts tests/integration/timeout-policy-persistence.test.ts`
- 5-3：`tests/bash tests/integration/bash-auto-background.test.ts tests/integration/bash-jobs-wiring.test.ts tests/conformance/rpc-bash-jobs.test.ts`
- 5-4：`tests/compact-hint tests/integration/context-switch-wiring.test.ts tests/integration/compact-dynamic-wiring.test.ts tests/integration/compact-dynamic-off-golden.test.ts`
- 5-5：`tests/fabric tests/integration/fabric-xs-*.test.ts tests/integration/fabric-wake*.test.ts tests/commands/fabric-xs.test.ts tests/conformance/fabric-xs.test.ts tests/conformance/fabric-wake.test.ts tests/integration/web-hub-control.test.ts tests/integration/schedule-wiring.test.ts`
- 5-6：`tests/mention tests/integration/mention-autocomplete-wiring.test.ts tests/integration/topic-switch.test.ts tests/integration/web-hub-e2e.test.ts`
- 包收口：`npm test` 全量；`npm run test:conformance` 全量（特别是 rpc-spawn、slash-args、history-restore、web-resume、topic-switch-hop、schedule C-S）；`npm run build:web && npm run check:web`（防止误伤 UI 构建）。

### 3.7 风险

| #   | 风险                                                                   | 缓解                                                                                                                                                |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| R5a | 同一事件的 handler 顺序漂移（pi 按注册顺序分发）                       | 轨迹 golden 逐行比对；分阶段注册的方法只在原位置调用；评审时逐个核对调用点和原行号                                                                  |
| R5b | 闭包捕获从「活变量」变成「快照」（例如把 `xsAttached` 当参数值传进去） | 一律传 getter 或 ref 对象；5-5 的 rg 检查；阶段 2 轨迹覆盖 session_start 之后的 attached 状态（autocomplete 的 sessions 源、/fabric 的 statusView） |
| R5c | `settings` 被拷贝（`{...settings}`），`/agent settings` 的原地修改失效 | 契约规定传引用；`tests/commands/status.test.ts`、`tests/integration/timeout-policy-persistence.test.ts` 兜底                                        |
| R5d | 公开面变化（`mentionAutocompleteEntries`）                             | §0.2 第 3 条的 re-export；验收时比对 `npm run build` 生成的 `dist/index.d.ts` 的导出名集合，前后必须相同                                            |
| R5e | `max` 画像在测试里起了真实 hub 或网络连接                              | 测试里把 `net.connect` 和 `child_process.spawn` 打桩成抛错（§3.1）                                                                                  |
| R5f | #61-C1 在冻结窗口内改 `src/index.ts`                                   | 排期规定 C1 在 P5 合入后开工（§0.3）；§8.1 预检                                                                                                     |

---

## 4. ⑦ `Stack.dispose()` 统一拆栈（L3，概要 + 矩阵 + 决策）

### 4.1 各入口的真实时序（r2：读 pi 1.3.0 源码核实，7-0 用 conformance 实测确认）

**扩展缓存**（`node_modules/@earendil-works/pi-coding-agent/dist/core/`）：

- `extensions/loader.js:86-100`：模块级 `extensionCache: Map<path, factory>`，带 `extensionCacheCwd` 和 `extensionCacheGeneration` 两个键。`resolvedCwd` 和缓存的 cwd 不同时，调用 `clearExtensionCache()`（`:96-97`）。
- `extensions/loader.js:461-489` `loadExtensionModule`：如果缓存令牌仍然有效并且命中缓存，直接返回**缓存的 factory**，也就是同一个模块实例；否则用 jiti（`moduleCache:false`，`:478`）重新导入，再写回缓存。
- `resource-loader.js:511、530`：两条扩展加载路径都走 `loadExtensionsCached`。
- `resource-loader.js:356-359` `reload()`：**只有 `this.loaded` 为真时**才调用 `clearExtensionCache()`。
- 运行时替换（`agent-session-runtime.js:102-170` 的 `teardownCurrent` + `createRuntime`）：每次都通过 `createAgentSessionServices` 新建一个 `DefaultResourceLoader`。新 loader 的 `loaded` 是 false，所以它第一次 `reload()` **不会**清缓存。

**推论**（7-0 必须实测）：

| 入口                              | 旧激活收到                          | 模块                                   | 新激活                           | 路径 A（`previous*` 交接）                          | 路径 B（同激活防御块）  | 路径 C（shutdown） |
| --------------------------------- | ----------------------------------- | -------------------------------------- | -------------------------------- | --------------------------------------------------- | ----------------------- | ------------------ |
| startup                           | —                                   | 新                                     | `activate()` + session_start     | 不触发（`previous*` 为空）                          | 不触发                  | —                  |
| **new / resume / fork（同 cwd）** | `session_shutdown{reason}`          | **同一实例**（命中 extensionCache）    | 再次 `activate()`，holder 是新的 | **触发**：新 build 拆掉上一个激活留下的 `previous*` | 不触发（holder 是新的） | 触发（在 A 之前）  |
| resume / fork（跨 cwd）           | `session_shutdown{reason}`          | 新模块（`loader.js:96-97` 清缓存）     | 再次 `activate()`                | 不触发                                              | 不触发                  | 触发               |
| `/reload`                         | `session_shutdown{reason:"reload"}` | 新模块（`resource-loader.js:356-359`） | 再次 `activate()`                | 不触发                                              | 不触发                  | 触发               |
| quit                              | `session_shutdown{reason:"quit"}`   | —                                      | —                                | —                                                   | —                       | 触发               |
| 同一激活第二次 session_start      | —                                   | —                                      | —                                | 触发                                                | 触发                    | 无                 |

这和仓库代码自己的注释一致（`stack.ts:211-216`：「This module-level handoff only covers SAME-module session swaps (new/fork/resume)… /reload re-imports … fresh module」）。由此得出四条结论：

- 路径 A **在同 cwd 的 new/resume/fork 上真实生效**。bash 的 `handoffInProcess`（把 LocalHandle 转交给新 manager）在这些入口上确实在工作。
- **只出现在 A、不在 C 里的组件，缺口只在 `/reload` 和跨 cwd 切换时出现**（加上 quit 之后进程没有退出的 SDK 嵌入场景）。r1 写的「生产中从不拆」是错的。
- 路径 B 在 pi 1.3 的运行时流程里**不可达**：每次替换都是新的激活，holder 是空的。它只在某个激活收到两次 session_start 时才会触发，属于纯防御。
- 同 cwd 的 new/resume/fork 上，同时出现在 C 和 A 的组件会被拆**两次**（先 C，后 A），依赖各自的幂等性。

### 4.2 组件 × 路径 × 顺序矩阵（现状，`43d892fd`）

各列含义：

- **A** = `stack.ts:2078-2121` 顶部交接；**B** = `index.ts:1456-1479` 防御块；
- **C1** = `index.ts:484-493`（同步，注册得早）；**C4** = `index.ts:1587-1690`（主 shutdown，async）；**C2** = `:518`；**C3** = `:1105`；
- 格子里的数字是该路径内的执行序号，`—` 表示该路径不处理。

**生效**列：「同 cwd 切换」= 同 cwd 的 new/resume/fork（C 加 A）；「reload/跨 cwd」= 只有 C。

**持有方**列：S = `Stack` 的公开字段；L = `buildSessionStack` 的局部变量（不是 `Stack` 成员，只通过 `previous*` 或局部 ref 可达）；P = activate 级，或者不属于任何栈的进程级/激活级资源。

**Stack 内组件**

| 组件                                                                                                                                                                                                                                                                                   | 持有方                                                                     | A                                                                            | B               | C                                                                                                                                                          | 同 cwd 切换                           | reload/跨 cwd | 备注 / 缺口                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| xs（fence 事件 + dispose）                                                                                                                                                                                                                                                             | S `xs`                                                                     | 1                                                                            | 1               | C1-②③（先 `fence.onEvent(session_shutdown)`，再 dispose）                                                                                                  | ✓                                     | ✓             | C1 必须保持「独立、早注册、同步」的形态                                                                                                                                                                            |
| rootWakeRecovery                                                                                                                                                                                                                                                                       | S                                                                          | 2                                                                            | 2               | C1-④                                                                                                                                                       | ✓                                     | ✓             |                                                                                                                                                                                                                    |
| backgroundCompletions                                                                                                                                                                                                                                                                  | S                                                                          | 3                                                                            | 4               | C4-1                                                                                                                                                       | ✓                                     | ✓             | 三条路径都要求它**最先**处理                                                                                                                                                                                       |
| schedule（`await shutdown()` / `dispose()`）                                                                                                                                                                                                                                           | S                                                                          | —                                                                            | 12              | C4-3                                                                                                                                                       | ✓                                     | ✓             | 必须排在 run drain 之前（closeEpoch）                                                                                                                                                                              |
| scheduleBackground                                                                                                                                                                                                                                                                     | S                                                                          | —                                                                            | 13              | C4-4                                                                                                                                                       | ✓                                     | ✓             | 必须在 closeEpoch 之后                                                                                                                                                                                             |
| fleetWidget                                                                                                                                                                                                                                                                            | S                                                                          | 4                                                                            | 5               | C4-5                                                                                                                                                       | ✓（拆两次）                           | ✓             | X7b                                                                                                                                                                                                                |
| **usageBroadcaster**                                                                                                                                                                                                                                                                   | **L**（`stack.ts:2993`，经 `usageRef` 和 `previousUsageBroadcaster` 可达） | 5                                                                            | —               | —                                                                                                                                                          | ✓                                     | **✗ G1**      | 有活动 run 时 1Hz poke，unref                                                                                                                                                                                      |
| **coalescer**                                                                                                                                                                                                                                                                          | **L**（`previousCoalescer`）                                               | 6                                                                            | —               | —                                                                                                                                                          | ✓                                     | **✗ G2**      | 有 hold 窗口定时器                                                                                                                                                                                                 |
| **ackHold**                                                                                                                                                                                                                                                                            | **L**（`previousAckHold`）                                                 | 7                                                                            | —               | —                                                                                                                                                          | ✓                                     | **✗ G3**      | 同上                                                                                                                                                                                                               |
| **bashJobs manager**（dispose + 交接）                                                                                                                                                                                                                                                 | S `bashJobs`                                                               | 8（先捕获 `prevBashJobs`，再 dispose，再交给新 build 的 `handoffInProcess`） | —               | 只在 `quit ∧ shutdownPolicy=kill` 时 `killBashJobsBounded`（C4-22）                                                                                        | ✓（**进程内交接生效**）               | **✗ G4**      | reload 时旧 manager 的 poll 定时器没人停，新栈又通过 `adoptOrphans` 接管同一批 job，可能出现双通知，或者用旧的 pi 发通知。7-1 和真机冒烟要核实                                                                     |
| archive                                                                                                                                                                                                                                                                                | S                                                                          | 9                                                                            | 6               | C4-6                                                                                                                                                       | ✓                                     | ✓             | #59 刚改过 `start` 签名                                                                                                                                                                                            |
| bashJobRecovery                                                                                                                                                                                                                                                                        | S                                                                          | 10                                                                           | —               | C4-12                                                                                                                                                      | ✓                                     | ✓             | B 里缺（**G5**，B 在 pi 1.3 不可达）                                                                                                                                                                               |
| fabric（= `mailbox.dispose`）                                                                                                                                                                                                                                                          | S `fabric`（`stack.ts:3514` 的包装）                                       | 11                                                                           | 15              | C4-13（必须在 run drain 之前）                                                                                                                             | ✓                                     | ✓             |                                                                                                                                                                                                                    |
| ↳ wake service 定时器（`fabric/wake.ts:605,645,770`：retain/recheck）                                                                                                                                                                                                                  | L（`buildFabric` 内部）                                                    | —                                                                            | —               | —（`fabric.dispose` 只拆 mailbox）                                                                                                                         | ?                                     | ?             | **G12（待核实）**：7-1 用 fake timers 确认 recheck 会不会自我续期。如果不会，属于有界（`SUBSCRIBER_RETAIN_MS`/`RECHECK_MS`），可以不处理                                                                           |
| keepalive                                                                                                                                                                                                                                                                              | S                                                                          | 12                                                                           | 7               | C4-7                                                                                                                                                       | ✓                                     | ✓             |                                                                                                                                                                                                                    |
| quota                                                                                                                                                                                                                                                                                  | S                                                                          | 13                                                                           | 8               | C4-8                                                                                                                                                       | ✓                                     | ✓             |                                                                                                                                                                                                                    |
| dynamic（`dispose(ctx)`，落盘遥测）                                                                                                                                                                                                                                                    | S                                                                          | —                                                                            | 10              | C4-9                                                                                                                                                       | ✓                                     | ✓             |                                                                                                                                                                                                                    |
| load                                                                                                                                                                                                                                                                                   | S                                                                          | —                                                                            | 11              | C4-10                                                                                                                                                      | ✓                                     | ✓             |                                                                                                                                                                                                                    |
| rpc.close                                                                                                                                                                                                                                                                              | S                                                                          | —                                                                            | 14              | C4-11                                                                                                                                                      | ✓                                     | ✓             |                                                                                                                                                                                                                    |
| workflow.runs                                                                                                                                                                                                                                                                          | S                                                                          | 14（`abandon`）                                                              | 16（`abandon`） | C4-14 `shutdown` → 15 `spawn.abort(pending)` → 16 `waitAll ∥ runs.drain`（共享 `min(abortGraceMs×3, 15s)`）→ 17 `runJournal.flushPending` → 18 `runs.seal` | ✓（C 先 seal，A 再 abandon 是空操作） | ✓             | 「abandon（不报告）」和「shutdown→drain→seal（报告）」是两种语义                                                                                                                                                   |
| worktreeLate                                                                                                                                                                                                                                                                           | S                                                                          | 15                                                                           | —               | C4-19（在 seal 之后）                                                                                                                                      | ✓                                     | ✓             | **G6**（B 里缺）                                                                                                                                                                                                   |
| worktreeOrphansStartup                                                                                                                                                                                                                                                                 | S                                                                          | 16                                                                           | —               | C4-20                                                                                                                                                      | ✓                                     | ✓             | **G6**                                                                                                                                                                                                             |
| hostBashViewCapability                                                                                                                                                                                                                                                                 | S                                                                          | 17（release）                                                                | —               | C4-21                                                                                                                                                      | ✓                                     | ✓             | **G6**                                                                                                                                                                                                             |
| **external**                                                                                                                                                                                                                                                                           | S                                                                          | 18                                                                           | 9               | —                                                                                                                                                          | ✓（经 A）                             | **✗ G7**      | `Stack.external` 的注释说「index.ts 的 session_shutdown 经它 dispose」，**代码里没有**（目录探测定时器）                                                                                                           |
| **notifier**（重试定时器）                                                                                                                                                                                                                                                             | S `notifier`（`stack.ts:2478`）                                            | —                                                                            | —               | —                                                                                                                                                          | **✗ G10**                             | **✗ G10**     | `delivery/notifier.ts:60` 默认用 `setTimeout`，stack 传的是 `systemClock`（unref）。没有 dispose 接口。上限是 `maxAttempts × backoffMs`；shutdown 之后挂起的重试仍会对旧栈的 outbox 执行，需要评估是否会写进新会话 |
| 有界的 run 级定时器：watchdog tick（`runtime/watchdog.ts:78`，只在有 armed run 时续期）、reaper finish（`reaper.ts:201`）、slot-pool 排队等待（`slot-pool.ts:59`）、spawn-service waiter（`spawn-service.ts:1228,1293,1372`）、runtime-adapter（`:234`）、query-service poll（`:129`） | L/S                                                                        | —                                                                            | —               | 随 C4-15/16 的 run drain 自然结束                                                                                                                          | ✓                                     | ✓             | 不需要拆。7-1 要断言 drain 之后 fake timers 里没有残留的这类定时器                                                                                                                                                 |
| contextReceipt、mention、mentionNotes、tombstones、runJournal、models                                                                                                                                                                                                                  | S                                                                          | —                                                                            | —               | —                                                                                                                                                          | —                                     | —             | 纯内存，没有定时器，不需要拆                                                                                                                                                                                       |
| `loadHintState` 复位                                                                                                                                                                                                                                                                   | P（activate 级状态）                                                       | build 开头复位（`stack.ts:2123`）                                            | —               | —                                                                                                                                                          | —                                     | —             | 由 build 负责                                                                                                                                                                                                      |

**activate 级（不属于 Stack，由 index.ts 负责；⑦ 用 `ActivationTeardown` 统一表达，见 §4.3）**

| 项                                                                                                                     | 位置                                                                                                            | C            | 各入口生效            | 备注 / 缺口                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| xsLedger.teardown                                                                                                      | C1-⑤（`reason≠reload`）、B-3（会话身份变化时）                                                                  | C1           | reload 时**故意保留** | 进程级账本                                                                                                                               |
| scheduleSurface.shutdown                                                                                               | C4-2                                                                                                            | ✓            | ✓                     |                                                                                                                                          |
| 子会话 bash `getChildBashRegistry().sealAll`                                                                           | C4-23（只在 `quit`）                                                                                            | ✓            | 按设计                | 进程级                                                                                                                                   |
| handoffStore.clear                                                                                                     | C3（compact.switchTool）                                                                                        | ✓            | ✓                     |                                                                                                                                          |
| background status 发布 + HOST_KEY 释放                                                                                 | C2                                                                                                              | ✓            | ✓                     | **不能**并入 Stack                                                                                                                       |
| **goalHook** 的 delivery/eval 看门狗                                                                                   | `index.ts:1206` → `goal/hook.ts:100-107`（unref setTimeout，返回 `cancel`）                                     | —            | **✗ G9**（所有入口）  | 没有 shutdown 时的取消。旧激活的计时器可能在 shutdown 后触发，读旧 holder（已拆的栈），用旧 pi 发 `sendUserMessage`。单个计时器，有界    |
| **child-switch capability 的 `onDisabled` 监听**                                                                       | `index.ts:531` → `context-switch/capability.ts:156`（进程级 `Symbol.for`，`index.ts` 丢掉了返回的 unsubscribe） | —            | **✗ G11**（所有入口） | 每次 `activate()` 都累积一个监听。首次 disabled 时，N 个旧监听会用各自过期的 `notifyCapabilityCtx` 弹 N 次 toast                         |
| `holder.current` 置空                                                                                                  | —                                                                                                               | **从不置空** | **G8**                | shutdown 之后迟到的工具调用会打到已拆的栈上                                                                                              |
| 其他 wire 模块自己的 `session_shutdown`（cacheTtl、web-hub、hud、title、session-nav、reload、topic-switch、traffic……） | 各模块                                                                                                          | 各自         | —                     | **不在 ⑦ 范围内**，只在矩阵测试里作为顺序锚点记录（schedule-off 画像下 `session_shutdown` 一共有 8 个 handler；#61-C1 合入后要重新确认） |

**缺口汇总**（r2 修正后的定性）：

- **/reload 与跨 cwd 专属**：G1 usageBroadcaster、G2 coalescer、G3 ackHold、G4 bashJobs manager、G7 external；
- **所有入口**：G8 holder、G9 goalHook、G10 notifier、G11 capability 监听；
- **只在不可达的路径 B 上**：G5、G6；
- **待核实**：G12 wake service。

### 4.3 目标设计（7a：零行为合并）

```ts
// src/stack.ts（或拆出 src/stack-teardown.ts）
export type StackTeardownEntry =
  | { kind: "rebuild-handoff" } // 路径 A：同模块下一次 build 开头（含同 cwd 的 new/resume/fork）
  | { kind: "defensive" } // 路径 B：同一激活第二次 session_start（pi 1.3 不可达，保留）
  | { kind: "shutdown"; reason: "quit" | "reload" | "new" | "resume" | "fork" }; // 路径 C4
export interface Stack {
  /* …原字段… */
  /** 7a：按 entry 执行与现状逐项一致的步骤表；幂等。 */
  dispose(entry: StackTeardownEntry, env: StackTeardownEnv): Promise<void>;
  /** C1 的同步子集（xs/rootWake），单独暴露，保持「早注册、同步」的形态。 */
  disposeXsSync(event: { reason: string }): void;
}
```

- **非字段组件怎么触达**（回应评审）：`Stack.dispose` 是在 `buildSessionStack` **内部**创建的闭包，可以直接捕获局部的 `usageBroadcaster`、`coalescer`、`ackHold`、`notifier`、`bashJobs`。所以**不需要**把它们提升成 `Stack` 的公开字段，公开面不增加。备选方案是提升为字段，那样会扩大 `Stack` 契约，不推荐。
- **路径 A**：18 个 `let previous*` 合并成一个模块级 `let previousParts: Partial<PreviousParts>`，其中包括 `prevBashJobs` 交接物。写入点和现在的 18 处 `previousX = x` **一一对应，按原来的位置增量写入**。不能在 build 结束时一次性写入 `previousStack`：如果 build 中途抛错，现在的行为是「已经赋值的部分会被下一次 build 拆掉」，一次性写入会改变这个行为。A 按 `rebuild-handoff` 列执行 `previousParts` 上的步骤；`prevBashJobs` 先捕获，再照旧交给 `handoffInProcess`。
- **步骤表**：用一个声明式数组 `TEARDOWN_STEPS: { id, run, entries }[]` 表达。数组下标就是执行顺序，每行逐一对应 §4.2 的现状，**包括缺口**；缺口行用 `// GAP-Gn preserved (7b)` 标注。以后评审顺序约束只需要看这一张表。
- **activate 级**：`ActivationTeardown`（index.ts 内的局部对象）收拢 C1 的 ledger 部分、C2、C3、scheduleSurface、子会话 sealAll、goalHook、capability 监听。它通过 `env` 回调插进步骤表，占用自己原来的序号，不改变相对顺序。
- index.ts 的 B 块和 C4 块都改成调用 `stack.dispose(...)`。AGENTS.md 里 `src/stack.ts` 那一行（目前写着「no stack dispose hook」）、I2 条目和 `docs/dev/subagent-core/README.md` 同步改写。

### 4.4 实施步骤与提交

| 步   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 提交                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 7-0  | **conformance 探针** `tests/conformance/lifecycle-entries.test.ts`。在 fixture 里放一个最小探针扩展：模块顶层执行 `globalThis.__probeModuleLoads++`，factory 里执行 `__probeActivations++`。用真实 pi 1.3 的 `AgentSessionRuntime` 依次跑 new、resume（同 cwd 和跨 cwd 各一次）、fork、`/reload`、quit，断言每个入口的模块是否复用、激活次数，以及 `session_shutdown` 的多个 handler 是否按顺序 await。实测结果回填 §4.1 的表                                                                                                                                                       | `test(conformance): pin the extension module lifecycle per session entry` |
| 7-1  | **矩阵测试** `tests/integration/stack-teardown-matrix.test.ts`。entry 覆盖 startup、同 cwd 的 new/resume/fork（同一模块、两次 activate）、reload/跨 cwd（新模块，用 `vi.resetModules` 模拟）、quit、同激活两次 session_start。用 `vi.spyOn` 包装 Stack 成员和 L 类局部组件（通过 `createUsageBroadcaster` 等工厂的 spy）上的 `dispose/close/abandon/shutdown/drain/seal/release/cancel`，记录有序调用日志，与测试内嵌的期望表（= §4.2）比对；再用 fake timers 统计 shutdown 之后残留的定时器数量（G9/G10/G12 的证据）。**必须在当前代码上全绿**，而且要在 #61-C1 合入后的基线上确认 | `test(stack): pin teardown order per entry and component`                 |
| 7-2  | 7a 合并：步骤表 + `Stack.dispose` + `previousParts` + `ActivationTeardown` + index.ts 两处改为调用。7-1 和 §3.1 阶段 2 的轨迹必须**零改动全绿**                                                                                                                                                                                                                                                                                                                                                                                                                                     | `refactor(stack): route all teardown paths through Stack.dispose`         |
| 7-3… | 7b 缺口修复：每个 G\* 一个提交，改动矩阵期望表里的一格，并写明理由（拍板第 3 条）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `fix(stack): dispose the usage broadcaster on session shutdown` 等        |

验收：`npm test`、`npm run test:conformance`、7-1 矩阵、§3.1 轨迹 golden，以及 `tests/integration/{fleet-widget-lifecycle,worktree-late-dispose,bash-jobs-wiring,child-bash-jobs,workflow-background-wiring,schedule-wiring,ask-user-interrupt}.test.ts`。另外做一次 tmux 真机冒烟（按 memory 里 live-acceptance-tmux 的流程）：`/reload` ×3、同 cwd 的 `/new`、`/resume`、跨 cwd 的 `/resume`，以及带着运行中的 subagent 和后台 bash 退出 pi。G4 的双通知要在真机上专门观察。

### 4.5 ⑦ 的拍板状态

- **D7-1 缺口策略**：**已拍板**（第 3 条）：先零行为合并，每个缺口单独一个 fix 提交。r2 新识别的 G9–G12 需要确认是否纳入 7b（§9 Q-r2-2）。G5/G6 只存在于 pi 1.3 不可达的路径 B，建议降为可选（§9 Q-r2-3）。
- **D7-2（r2 重新表述）**：同 cwd 的 new/resume/fork **已经**通过模块级 `previous*` 实现了进程内交接（包括 bash LocalHandle 转交）。要讨论的是：是否用 `Symbol.for("pi-subagent:prev-stack")` 全局，把这种交接**扩展到 `/reload` 和跨 cwd 切换**。这会让 G1–G4、G7 在 `/reload` 上由交接方拆掉，bash 进程内交接也会在 reload 时生效。这是**行为变化**，还牵涉 I4 的「容量/TTL」声明。**已拍板：本批不做**（第 3 条）。
- **D7-3 shutdown 后是否把 `holder.current` 置空**（G8）：按拍板第 3 条，作为 7b 的一个独立 fix。置空之后，迟到的调用会由 `requireStack` 抛出「no active session yet」，这一点要写进 fix 提交的说明。

---

## 5. ⑧ settings 子系统化（L3，概要；拍板已按推荐）

**前置条件**：#59 收尾（`43d892fd` 已落地，开工前确认没有后续提交），#54 包 B/C 合入（它们改 `defaultSettingsPath`、迁移逻辑和 `persistSettingOverride`）。

**目标结构**：`config/settings.ts`（3753 行）只保留读文件、迁移、锁、聚合 `AgentSettings`、`DEFAULT_SETTINGS`、`parseSettingsSource` 编排，目标 ≤1000 行。各子系统自己负责的部分（类型 + 默认值 + 纯解析）下沉到 `<子系统>/settings.ts`。仓库里已有先例：`topic-switch/settings.ts`、`memory/tidy/batch-settings.ts`、`external-agent/droid/settings.ts`、`extensions/worktree-settings.ts`。

| 子系统文件（新）                                        | 移入（`settings.ts` 现有符号）                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fabric/settings.ts`                                    | `FabricSettings`、`FabricWakeSettings`、`FabricXs*Settings`、`FabricCrossSession*`、`parseFabricSettings`、`parseFabricWakeSettings`、`parseFabricXs{Alias,Channel,Reply}Settings`、`parseFabricCrossSessionSettings`；`effectiveReceive`/`isValidXsSessionId`（第一批 Q1 推迟到这里处理，目的地建议是 `fabric/xs/receive.ts`） |
| `web-hub/agent/settings.ts`（或 `web-hub/settings.ts`） | `WebHubProxySettings`、`FeishuBotSettings`、`parseWebHubSettings`、`parseWebHub{Spawn,Proxy,Lan}Block`、`parseFeishuBotBlock`、`parseAllowClients`，以及上传、预览、命令补全等小解析器                                                                                                                                          |
| `cache-ttl/settings.ts`                                 | `CacheTtlSettings`、`parseCacheTtlSettings`（顺便消除 `config → cache-ttl/keepalive-state` 这条反向值边）                                                                                                                                                                                                                       |
| `quota/settings.ts`                                     | `QuotaSettings`、`parseQuotaSettings`、`parseDroidPools`、`parse*WindowThresholds`                                                                                                                                                                                                                                              |
| `sysload/settings.ts`                                   | `LoadSettings`、`LoadHintSettings`、`parseLoadSettings`                                                                                                                                                                                                                                                                         |
| `compact-hint/settings.ts`                              | `CompactSettings`、`DynamicThresholdSettings`、`parseCompactSettings`、`parseDynamicThresholdSettings`                                                                                                                                                                                                                          |
| `bash/settings.ts`                                      | `BashJobsSettings`、`parseBashJobsSettings`                                                                                                                                                                                                                                                                                     |
| 其余小块                                                | memory、workflow、traffic、schedule、external-agents、ask-user、todo、hud、goal、title、reload、systemPrompt、extend、agent dispatch，按同一模式各回各的目录                                                                                                                                                                    |

**行为零变化的证明**：

1. 开工前在基线上采集一份语料：`parseSettingsSource` 对 `tests/config/**` 的全部输入，加上一批 seeded 随机 JSON 的输出，用 `JSON.stringify` 存档，**键序也算在内**（HubConfig 等下游会序列化 settings 的子对象）。每个提交都要逐字节比对。
2. `DEFAULT_SETTINGS` 深相等，并且键序相同。
3. `setting-specs.ts` 的 TUI 项顺序不变（`tests/ui/settings-editor*`）。
4. A 档 golden 零 diff（`secure-off` 的 `defaultSettingsUnchanged` 和 `loadSettingsIdentity`）。
5. `tests/web-hub/boundary.test.ts` 的 `SYSLOAD_FILE_CLOSURE` 表按 D8-2 口径更新。

**拆包**：每个子系统一个提交，可以多个 writer 并行写，但 `config/settings.ts` 由一个人串行合入。`setting-specs.ts` 分片作为 P8 的最后一个提交（D8-3）。

**拍板**（第 4 条，按推荐）：

- D8-1：`config/settings.ts` 保留子系统类型的 `export type {…} from`；
- D8-2：口径是「规则不放宽，文件集合可以变」，闭包里仍然不许出现 pi 值导入或 hub 以外的值导入；
- D8-3：本批分片。

---

## 6. ⑨ web-hub 巨型闭包分拆（L3，每个文件一个包；拍板：只做纯抽取，测试跟着改）

| 包  | 文件（行数）                                           | 目标（纯抽取）                                                                                                                                                          | 被测试钉住的代码段（测试跟着改为读新文件）                                                                                                                                                                                                  | 在途依赖                      |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| H1  | `web-hub/agent/index.ts`（2501；`wireWebHub` 1807 行） | hold 接线（约 `:728` 一带）、dialogs、各 StatusInfo slot 的投影函数，拆到 `agent/{hold-wire,dialogs-wire,status-slots}.ts`。**不做** slot 注册表（D9-1，另开一个包）    | `tests/web-hub/agent/restart.test.ts:250`、`admin-cmds.test.ts:292`（正则匹配 `const restart = … => {…}` 的函数体）、`tests/web-hub/hub/commands.test.ts:725`                                                                               | **#61-C2 之后**               |
| H2  | `web-hub/hub/http.ts`（4073）                          | `handleLanRequestInner`（599 行）+ `createLanTransport` + `handleLanLogin` 拆到 `http-lan.ts`；`dispatchCmdOrDialog`（281 行）拆到 `http-cmd.ts`；`createRouteSet` 不动 | `tests/web-hub/protocol/spawn.test.ts:289`                                                                                                                                                                                                  | **#66 之后**                  |
| H3  | `web-hub/hub/hub.ts`（2421；`startHub` 2006 行）       | 按「存储/注册表/频道/飞书/spawn/预览/调度」拆成子装配函数，共享一个显式的 `HubAssembly` ctx（沿用 `createHttpFrontend` → `createPreviewRoutes` 的先例）                 | `tests/web-hub/hub/hub-feishu.test.ts:697`、`hub-preview.test.ts:260,400`、`hub-startup-gate.test.ts:78`、`hub-spawn.test.ts:483,523`、`tests/web-hub/protocol/feishu.test.ts:104`（`config.feishuBot === undefined ? [] : [FSB_HUB_CAP]`） | **#61-H2 之后**（hub.ts cap） |

**零行为证明**：

- hub 不变式 I1–I4，加上 `tests/web-hub/boundary.test.ts`（新文件自动纳入 hub/agent 规则；B3 要求 agent 不能值导入 hub）；
- 冻结 golden：`fabric-xs-off`（hello/HubConfig wiring）、`schedule-off`（wiring）、`web-hub-ui/{keepalive,quota}-legacy-golden`；
- `tests/integration/web-hub-*.test.ts` 全部；
- `npm run test:conformance` 里的 web-resume、cmd-history、slash-args、history-restore；
- `npm run build:web && npm run check:web`；
- 被钉住的代码段，测试的正则或路径要同步指向新文件，钉住的意图保持不变（D9-2）。

**并行**：H1、H2、H3 互相独立，各自等自己的在途依赖合入后再开（D9-3）。

---

## 7. ⑩ UI transport 去重 + `helper.mjs` 拆分（L3，两件事独立；拍板已按推荐）

### 7.1 ⑩-U `password-client.js`（2474）/ `token-client.js`（1998）

- 目标：把两边共用的 EventSource 生命周期（看门狗、退避、重开、状态回调）抽成 `ui/src/logic/transport-core.js`，两种认证模式只保留各自的差异（握手、刷新、401 处理）。**只去重，不做 TS 化**（D10-1）。
- 证据面：
  - `tests/web-hub/ui/{transport-contract,logic-contract,logic-client,logic-client-password,password-auth,logic-proxy,source-scan,hub-http-integration}.test.ts`；
  - `tests/web-hub/hub/{lan-auth,deadline-nesting}.test.ts`；
  - `npm run build:web && npm run check:web`；
  - `npm run probe:csp`（真浏览器）。
- 冲突：排在 #66 后面。

### 7.2 ⑩-S `secure/bin/helper.mjs`（6690）

- 目标：拆成三个文件，`helper.mjs` 只保留 CLI 分发和共用原语。硬约束不变：零依赖、纯 ESM、git 安装零构建。
  - `private.mjs`：`cmdPrivate*` 4842–5100、`lockPrivate`/`lockOuter`/`underMountLock` 5185–5400、`cmdMountWork` 5765、`cmdNsRoot` 5899；
  - `init.mjs`：`cmdInit` 3081–3429；
  - `finalize.mjs`：卸载、占用扫描。
- 两个已核实的约束：
  - 测试把 `helper.mjs` 当 API 用（`H.cmdX`，见 `tests/secure/{archive,init-cleanup,convert-fixtures,helper-v0-api}.test.ts`），所以 helper 必须继续导出被移走的函数；
  - `tests/secure/launcher-cli.test.ts:156` **只拷 `helper.mjs` 一个文件**到模拟安装目录。所以新拆出的文件必须沿用现有的**惰性 `await import("./x.mjs")`** 模式（`helper.mjs:1197,1739,3348,3404`；拍板 D10-2）。
- 冻结面：`secure-contract-parity.json`（A）、`secure-launcher-off-golden.json`（A′，只许 USAGE 变化）、`secure-off-golden.json`（A）；`tests/conformance/secure-*.test.ts`（自门控，没有 gocryptfs 时会 skip，必须写明原因，由主会话补跑）。
- 冲突：排在 #54 包 A 后面。

---

## 8. 拆包、冲突预检、合入顺序

### 8.1 开工前预检（主会话执行）

```sh
git fetch && git log --oneline origin/dev -5                     # 确认基线
git log --oneline 43d892fd..origin/dev -- src/stack.ts src/index.ts src/archive src/config src/web-hub/agent/index.ts   # #59/#61 等是否有新提交
node skills/dev-flow/scripts/conflict-check.mjs /tmp/sg-batch2-spec.json
```

### 8.2 冲突预检 spec（`/tmp/sg-batch2-spec.json`）

> 按波次分别跑：第一波放 `P4` 和全部 `ext:*`；P4 合入后换成 `P5`。⑦⑧⑨⑩ 各自开工时重新写一份。
> 预期的交集：`P4`/`P5` 和 `ext:#61-C1` 会在 `src/index.ts` 上报交集（exit 1）。**这是靠排期化解的**：冻结窗口内 #61-C1 不开工，P5 合入后才开（§0.3），不能拿来当成可以并行的依据。另外，`ext:#59` 和 `ext:#54` 都包含 `src/config/**`，它们之间的交集是两个外部包的关系，与本批无关，可以忽略。

```json
[
  {
    "id": "P4:stack-sink",
    "globs": [
      "src/stack.ts",
      "src/bash/notify.ts",
      "src/bash/host.ts",
      "src/adapters/session-id.ts",
      "src/compact-hint/hook.ts",
      "src/compact-hint/threshold-tool.ts",
      "src/delivery/stack-hooks.ts",
      "src/fabric/stack.ts",
      "src/fabric/xs/stack.ts",
      "src/context-switch/child.ts",
      "src/commands/status.ts",
      "src/todo/index.ts",
      "src/bash/child.ts",
      "src/index.ts",
      "scripts/exp/compact-dynamic-smoke.ts",
      "AGENTS.md",
      "tests/governance/**",
      "tests/fixtures/governance/**",
      "tests/helpers/activation-trace.ts",
      "tests/secure/activation-trace.ts",
      "tests/secure/off-golden.test.ts",
      "tests/conformance/ask-user-wired.test.ts",
      "tests/integration/bash-jobs-wiring.test.ts",
      "tests/integration/child-bash-jobs.test.ts",
      "tests/todo/nudge-wiring.test.ts",
      "tests/compact-hint/headless.test.ts",
      "tests/compact-hint/threshold-tool.test.ts",
      "tests/integration/compact-dynamic-wiring.test.ts",
      "tests/integration/compact-hint-wiring.test.ts",
      "tests/integration/helpers/compact-hint-golden.ts",
      "tests/commands/status-xs.test.ts",
      "tests/integration/context-receipt-wiring.test.ts",
      "tests/integration/ask-user-interrupt.test.ts",
      "tests/integration/fabric-wake-quiet.test.ts"
    ]
  },
  {
    "id": "P5:index-wire",
    "globs": [
      "src/index.ts",
      "src/holder.ts",
      "src/tools/register.ts",
      "src/bash/host.ts",
      "src/compact-hint/register.ts",
      "src/fabric/xs/activate.ts",
      "src/mention/wire.ts",
      "tests/integration/mention-autocomplete-wiring.test.ts",
      "tests/workflow/wc14-testhooks-gate.test.ts"
    ]
  },
  {
    "id": "ext:#59-archive-config",
    "globs": ["src/archive/**", "src/config/**", "tests/archive/**", "tests/config/**"]
  },
  {
    "id": "ext:#61-C0-protocol",
    "globs": [
      "src/web-hub/protocol/schedule.ts",
      "src/web-hub/protocol/messages.ts",
      "src/web-hub/hub/feishu/schedule.ts",
      "src/web-hub/agent/command-policy.ts",
      "tests/web-hub/protocol/**"
    ]
  },
  {
    "id": "ext:#61-C1-agent",
    "globs": [
      "src/schedule/core/claim.ts",
      "src/schedule/agent/ops.ts",
      "src/schedule/agent/confirm.ts",
      "src/schedule/agent/surface.ts",
      "src/schedule/agent/wire.ts",
      "src/schedule/agent/dispatch.ts",
      "src/tools/schedule-tool.ts",
      "src/commands/schedule.ts",
      "src/index.ts"
    ]
  },
  {
    "id": "ext:#61-C2-link",
    "globs": [
      "src/schedule/agent/coordinator.ts",
      "src/web-hub/agent/connection.ts",
      "src/web-hub/agent/index.ts",
      "tests/schedule/agent/coordinator.test.ts",
      "tests/schedule/agent/webhub-wiring.test.ts"
    ]
  },
  {
    "id": "ext:#61-H2F2W2",
    "globs": [
      "src/web-hub/hub/schedule/**",
      "src/web-hub/hub/agent-server.ts",
      "src/web-hub/hub/hub.ts",
      "src/web-hub/hub/feishu/schedule-confirm.ts",
      "src/web-hub/hub/feishu/service.ts",
      "src/web-hub/ui/src/components/schedule/**",
      "src/web-hub/ui/src/components/detail/DetailHeader.vue",
      "src/web-hub/ui/src/logic/schedule.js",
      "src/web-hub/ui/src/i18n/schedule-extra.ts"
    ]
  },
  {
    "id": "ext:#54-settings-rename",
    "globs": ["src/secure/**", "src/config/**", "src/commands/webhub.ts", "src/cache-ttl/cache-ttl.ts"]
  },
  {
    "id": "ext:#66-auth-hardening",
    "globs": [
      "src/web-hub/hub/kdf*.ts",
      "src/web-hub/hub/admin.ts",
      "src/web-hub/hub/lan-*.ts",
      "src/web-hub/hub/db*.ts",
      "src/web-hub/hub/ports.ts",
      "src/web-hub/protocol/password-policy.ts",
      "src/web-hub/protocol/common-passwords.ts",
      "src/web-hub/agent/passwd-prompt.ts",
      "src/web-hub/agent/lan-status.ts"
    ]
  }
]
```

### 8.3 顺序与验收流程

1. **冻结窗口开始**（拍板第 1 条）：从现在到 P5 合入，只有 P4/P5 可以提交 `src/stack.ts` 和 `src/index.ts`。#61 的 C0/H2/W2/F2 可以在窗口内推进，C1 等窗口结束。
2. **P4**（④，4-0…4-6）：开发 → verifier（§2.5 的文本 + 绑定双检查、§2.6）→ 主会话按精确路径提交。
3. **P5**（⑤，5-0…5-6）：开发 → verifier（轨迹 golden、§3.6）→ 提交。**冻结窗口结束**。
4. **#61-C1 → #61-C2**，按 #61 自己的计划推进。
5. **P7**（⑦）：7-0/7-1 只新增测试文件，可以和 P5 并行**编写**。但 7-1 的期望表和轨迹 golden 要在 #59 定稿、#61-C1 合入之后的基线上重新确认。7-2 独占 `stack.ts`/`index.ts`，期间再开一次冻结窗口。
6. **P8**（⑧）：等 #54 包 B/C；可以和 P9-\*、P10-U 并行。
7. **P9-H1** 等 #61-C2；**P9-H3** 等 #61-H2；**P9-H2** 等 #66。
8. **P10-U** 等 #66；**P10-S** 等 #54 包 A。
9. 每个包返回后立即派 verifier（验收模型 ≠ 开发模型）。push 和发版要用户确认。
10. 批次收口：`npm run format:check && npm run typecheck && npm test && npm run build && npm run build:web && npm run check:web && npm run test:conformance`；`git diff <批次首包基线>..HEAD -- tests/fixtures` 除了新增的 `tests/fixtures/governance/` 之外必须为空。

---

## 9. 待拍板汇总（r2）

r1 的 D0-1、D5-1、D5-3、D7-1、D7-2、D7-3、D8-\*、D9-\*、D10-\* 都已经在文末「用户拍板（2026-10-26）」里定了，各节已经按拍板改写。下面是还没拍板的：

| #      | 问题                                                                                                                                                 | 推荐                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| D5-2   | ⑤ 的 xs 抽取（5-5，风险最高）放在本批，还是推后                                                                                                      | 放在本批，排在 5-1…5-4 之后，单独验收                           |
| Q-r2-2 | r2 新识别的缺口 G9（goalHook 看门狗）、G10（notifier 重试）、G11（capability 监听累积）、G12（wake service 定时器，待核实）是否纳入 7b，每个一个 fix | 纳入。G12 先由 7-1 核实，确认是有界的就关闭                     |
| Q-r2-3 | G5/G6 只存在于 pi 1.3 不可达的路径 B 上，还修不修                                                                                                    | 降为可选：7a 保留 B 块原样，如果以后决定删除 B 块，它们自然消失 |

---

## 用户拍板（2026-10-26）

1. ④⑤ 施工期间冻结 `src/stack.ts` / `src/index.ts`：其它包不往这两个文件提交，先做 ④⑤。
2. 激活调用轨迹守卫作为 B 档契约 golden 入库。
3. ⑦ 先写矩阵测试零行为合并，8 个缺口各自单独 fix 提交；跨模块 `Symbol.for` 交接本批不做。
4. ⑧⑨⑩ 全部按方案推荐（settings.ts 保留子系统类型 re-export；⑨ 只做纯抽取、被测试钉住的代码段让测试跟着改；可选 5-7 不做）。

---

## r2 修订对照表

| #   | 评审意见（级别）                                                                                                                                          | 处理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 位置                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | **[blocker]** ⑦ 的前提错误：同 cwd 的 new/resume/fork 命中 extensionCache，复用同一个模块实例，只有 `/reload` 换新模块；G1–G4 的定性要改；D7-2 要重新表述 | **接受**。核实了 pi 1.3.0：`loader.js:86-100`（缓存的键和跨 cwd 清空）、`:461-489`（命中缓存时返回同一个 factory）、`resource-loader.js:356-359`（只有 `loaded=true` 时才清缓存）、`:511/530`（`loadExtensionsCached`），以及运行时替换会新建 `DefaultResourceLoader`（`loaded=false`）。§4.1 改为按入口列表：同 cwd 切换 = C + A，`/reload` 和跨 cwd = 只有 C，路径 B 不可达。§4.2 的 G1–G4、G7 改定性为「/reload 与跨 cwd 专属」，并注明同 cwd 下组件会被拆两次、bash 进程内交接确实生效。D7-2 改述为「把交接扩展到 /reload」（§4.5），按拍板本批不做。7-0 探针增加跨 cwd 用例                         | §4.1、§4.2、§4.4、§4.5     |
| 2   | **[major]** 冲突表漏了在途的 #61（C1 改 `src/index.ts`，C2 改 `web-hub/agent/index.ts`）；#61 开发排在 ④⑤ 之后；补 §8.2 的 ext globs                      | **接受**。§0.3 冲突表新增 #61 行，按 confirm-plan §7 列出 C0/C1/C2/H2/F2/W2 的文件域。排期：C1 在 P5 合入后开工，C0/H2/W2/F2 可以在冻结窗口内推进；⑦ 的基线在 #61-C1 之后确认；⑨-H1 排在 C2 后面，⑨-H3 排在 H2 后面（评审没提，r2 顺带补上：H2 改了 `hub.ts` 的 cap）。§8.2 新增 4 个 `ext:#61-*` 伪包，并说明 `src/index.ts` 的交集靠排期化解。§8.3 和 R5f 同步                                                                                                                                                                                                                                         | §0.3、§3.7、§8.2、§8.3、§6 |
| 3   | **[major]** ⑦ 矩阵漏了持有计时器的组件：goalHook、Notifier；usageBroadcaster/coalescer/ackHold 不是 Stack 成员，要说明 dispose 怎么触达；其余遗漏一并补   | **接受**。§4.2 新增「持有方」列（S/L/P），把 usageBroadcaster/coalescer/ackHold 标为局部变量 L。新增行：notifier（G10）、goalHook（G9）、capability `onDisabled` 监听累积（G11，r2 自查发现：`index.ts:531` 丢弃了 unsubscribe）、wake service 定时器（G12，待核实）、一组有界的 run 级定时器（watchdog/reaper/slot-pool/spawn-service/runtime-adapter/query-service，注明随 drain 结束并由 7-1 断言），以及无定时器的纯内存组件。§4.3 说明 `Stack.dispose` 是 build 内部的闭包，可以直接捕获局部变量，**不需要提升为公开字段**；activate 级的项收进 `ActivationTeardown`。7-1 增加 fake timers 残留计数 | §4.2、§4.3、§4.4           |
| 4   | **[minor]** ④ 的验收要对每个被移声明的自由标识符，比对新旧两边解析到的模块路径，用机器枚举替代人工白名单                                                  | **接受**。§2.5 第 1 条改为「文本 + 绑定」双检查。仓库里没有 ts-morph，就用 `typescript@6.0.2` 的 `TypeChecker`：基线树用 `git archive` 解包到 `/tmp`，沿别名解析到最终声明后比对 `(文件, 声明名)`。例外集合由机器精确比对，只含 §2.3 那三个新类型名，`formatDuration` 的人工白名单取消。§2.6 增加对应命令，R4a 的例外也同步进这个集合                                                                                                                                                                                                                                                                    | §2.5、§2.6、§2.7           |
| 5   | [nit] 值导入实际是 14 个                                                                                                                                  | **接受**。§1.2、§3.4 的 5-0 改为「16 条诊断 / 17 个符号，其中 14 个值导入、3 个类型导入」，并逐个列名                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | §1.2、§3.4                 |
| 6   | [nit] activation-trace 的计数写进 golden；补一个 compat-failure 画像                                                                                      | **接受**。§1.3 删掉了无法核实的「176」；§3.1 的 golden 每个画像都存 `count`/`phase2Count` 并单独断言；新增第 5 个画像 `compat-failure`（记录器加 `omit` 选项，`omit:["appendEntry"]` 触发 `assertCompatible` 失败），钉住 `index.ts:687-699`                                                                                                                                                                                                                                                                                                                                                             | §1.3、§3.1                 |
| 7   | [nit] `describeJobStatus` 应从 `./types.js` 导入                                                                                                          | **接受**。4-1 的导入列改为从 `./types.js` 导入（定义在 `bash/types.ts:180`，job-tool 只是转发），避免 notify → job-tool 这条边；§2.5-1b 的绑定检查会验证它解析到同一个声明                                                                                                                                                                                                                                                                                                                                                                                                                               | §2.2                       |
| 8   | [nit] D5-1 把轨迹入库为 B 档 golden 时，要同步更新 AGENTS.md 冻结物表                                                                                     | **接受**（拍板第 2 条已经定了入库）。4-0 提交在 AGENTS.md「Frozen artifacts」的 B 档追加 `governance/activate-trace.json` 及其刷新规则（`PI_TOOLKIT_UPDATE_TRACE=1`，只在有意改动注册时刷新）；确认 `tests/docs/agents-md.test.ts`（K4 只校验 A/A′，32 KiB 上限）仍然通过；§8.2 的 P4 文件域加入 `AGENTS.md` 和 `tests/fixtures/governance/**`                                                                                                                                                                                                                                                           | §0.2、§3.1、§8.2           |
| —   | 拍板落实                                                                                                                                                  | 第 1 条：§0.3、§8.3 改为冻结窗口；第 2 条：§3.1 改为 B 档；第 3 条：§4.5；第 4 条：5-7 删除（§1.2、§3.2、§3.4），⑧⑨⑩ 各节按推荐改写；§9 只保留没定的 D5-2 和 r2 新增的 Q-r2-2、Q-r2-3                                                                                                                                                                                                                                                                                                                                                                                                                    | 全文                       |
