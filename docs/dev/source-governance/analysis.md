# 源码组织合理性分析（任务 #30）

> 只读分析，基线 `dev@569d7ea9`（2026-10-25）。不含任何改动方案的实施，只给现状证据与治理建议。
> 统计脚本放在 `/tmp/sg/`（未入库），方法见附录 A；所有数字都可以按附录 A 复现。
> 口径：「行数」= `wc -l`（含注释/空行）；`src/web-hub/ui` 单独统计（Vue/JS 前端，不在 TS 依赖图里）。

---

## 0. 一页结论

- **体量**：`src/` 共 1115 个文件、36.0 万行（不含 web-hub/ui：752 个文件、28.2 万行）；`tests/` 1634 个文件、54.0 万行，测试/源码 ≈ 1.5。web-hub 一个目录就占 18.8 万行（52%）。
- **分层底线是守住的**：`src/core`、`src/prompt-sections`、`src/git` 的值导入传递闭包里 **0 条**通往 pi 的路径；hub 侧（`web-hub/{hub,protocol}`）的值导入闭包只出界到 20 个白名单文件（git/sysload/schedule-core/secure-env/core-clock），与 `tests/web-hub/boundary.test.ts` 一致。**文件级值导入图无环**（Tarjan SCC = 0）。
- **问题集中在「目录归属」而不是运行时环**：37 个顶层目录之间有 263 条有向边，其中 32 对双向、19 对双向都是值导入；按值边求 SCC，22 个顶层目录落在**同一个强连通分量**里。原因是一批文件放错了目录（典型：`config/settings.ts` 反向导入 6 个子系统；`service/runtime-adapter.ts` 导入 4 个 tool；`todo`、`context-switch` 反向导入 `stack.ts`）。
- **两个组装点膨胀明显**：`src/index.ts` 2127 行，其中 `activate()` 一个函数就 1752 行；`src/stack.ts` 3676 行，里面混着约 1100 行「不是组装」的逻辑（bash 通知格式化、compact-hint 钩子、fabric/xs 构建），另有 19 个模块级 `let previous*` 可变量。这两个文件也是近 30 天改动最频繁的前五名（77 / 65 次提交），并行开发时最容易冲突。
- **巨型闭包工厂**是全库的系统性形态：18 个函数各自超过 1000 行（`createSpawnSupervisor` 2330、`startHub` 2006、`createFeishuBotService` 1909、`wireWebHub` 1807 ……）。
- **重复**：确认有逐字节复制的 `redactSecrets`（2 份）、两份语义不同的 `isTerminalStatus`、hub 内 4 份 `withDeadline`、28 份 `isRecord`、14 份 atomic-write；UI 侧 `password-client.js` 和 `token-client.js` 约 64% 的长行相同。
- **死代码不多但零散**：93 个值导出全库无引用（其中 37 个是 `export const X = Y` 形式的别名残留）；另有 73 个值导出只被测试引用；`rpc/client.ts`、`web-hub/hub/lan-security-stubs.ts` 是生产路径不可达的文件。
- **AGENTS.md** 157 KB（约 4 万 token），每个会话都要注入；单 `src/web-hub/` 一条就 48.7 KB，fabric 一条 22.4 KB。「pi peer bump 前要跑的测试」散在 8 处，但 `npm run test:conformance` 本来就会把整个 `tests/conformance/` 跑完。

Top 10 治理建议见 §8。

---

## 1. 规模画像

### 1.1 顶层目录（按源码行数排序，前 30）

| 目录                                 | 文件 |  源码行 |         测试文件 |  测试行 |                          测试/源码 |
| ------------------------------------ | ---: | ------: | ---------------: | ------: | ---------------------------------: |
| web-hub（合计）                      |  631 | 187,682 |              726 | 246,538 |                               1.31 |
| ├ hub                                |  178 |  78,504 |     223+78(http) | 108,882 |                               1.39 |
| ├ ui（ts 207 / vue 123 / js 33）     |  363 |  78,319 |              272 |  91,737 |                               1.17 |
| ├ agent                              |   53 |  17,846 |               93 |  29,297 |                               1.64 |
| └ protocol                           |   37 |  13,013 |               50 |  13,346 |                               1.03 |
| secure（含 bin/*.mjs 6 个 2.0 万行） |   12 |  19,281 |               35 |  21,164 |                               1.10 |
| memory                               |   45 |  13,690 |               39 |  11,956 |                               0.87 |
| cache-ttl                            |   27 |  10,578 |               42 |  18,403 |                               1.74 |
| schedule                             |   25 |   9,718 |               28 |   8,768 |                               0.90 |
| traffic                              |   26 |   9,709 |               34 |   9,700 |                               1.00 |
| workflow                             |   20 |   8,843 |               35 |  14,798 |                               1.67 |
| fabric                               |   29 |   8,051 |               40 |  11,651 |                               1.45 |
| tools                                |   24 |   7,461 |               33 |  11,008 |                               1.48 |
| config                               |    6 |   6,129 |               39 |   7,094 |                               1.16 |
| service                              |   11 |   6,033 |               41 |  11,233 |                               1.86 |
| core                                 |   22 |   5,638 |               29 |   8,976 |                               1.59 |
| consult                              |   14 |   5,505 |               18 |   6,540 |                               1.19 |
| bash                                 |   11 |   5,457 |               13 |   5,661 |                               1.04 |
| quota                                |   18 |   4,922 |               18 |   8,730 |                               1.77 |
| external-agent                       |   25 |   4,280 |               25 |   5,167 |                               1.21 |
| commands                             |    6 |   3,726 |               17 |   4,921 |                               1.32 |
| topic-switch                         |   14 |   3,410 |               14 |   4,901 |                               1.44 |
| ask-user                             |   15 |   3,379 |               27 |   4,445 |                               1.32 |
| runtime                              |    7 |   3,303 |               29 |   7,654 |                               2.32 |
| compact-hint                         |   12 |   3,122 |               15 |   3,131 |                               1.00 |
| ui                                   |    6 |   2,591 |                7 |   4,056 |                               1.57 |
| sysload                              |   12 |   2,213 |               10 |     708 |                           **0.32** |
| context-switch                       |    9 |   2,147 |               11 |   3,059 |                               1.42 |
| `index.ts` + `stack.ts`              |    2 |   5,803 | 1（tests/stack） |      30 | 另有 74 个测试文件直接 import 它们 |

> 小目录（<2k 行）：todo/session-nav/hud/git/delivery/feishu-notify/extensions/title/goal/adapters/web-search/mention/sysprompt/archive/date/rpc/prompt-sections/reload/vendor/child。
> 测试比偏低的：rpc 0.30、sysload 0.32、web-search 0.51、goal/hud 0.65。注意测试比只按同名目录统计，`tests/integration`（140 个文件、5.0 万行）和 `tests/conformance`（42 个文件、2.0 万行）没有分摊进来，sysload/goal 的一部分覆盖在集成测试里。

### 1.2 最大的 20 个文件

|   # | 行数 | 文件                                          | 30 天提交数 | 判断                                       |
| --: | ---: | --------------------------------------------- | ----------: | ------------------------------------------ |
|   1 | 6690 | `src/secure/bin/helper.mjs`                   |           — | 应拆（见下）                               |
|   2 | 4085 | `src/web-hub/hub/http.ts`                     |          53 | 应拆                                       |
|   3 | 3817 | `src/config/settings.ts`                      |          67 | 应拆（§2.4、§8#5）                         |
|   4 | 3676 | `src/stack.ts`                                |          65 | 应拆（§3）                                 |
|   5 | 3254 | `src/secure/bin/convert.mjs`                  |           — | 暂缓（引擎新、端口注入，结构清晰）         |
|   6 | 2954 | `src/web-hub/hub/spawn/supervisor.ts`         |           — | 内部就一个 2330 行闭包，碰到时再拆         |
|   7 | 2669 | `src/secure/bin/tree.mjs`                     |           — | 暂缓                                       |
|   8 | 2501 | `src/web-hub/agent/index.ts`                  |          71 | 应拆（`wireWebHub` 1807 行）               |
|   9 | 2459 | `src/web-hub/ui/src/logic/password-client.js` |          27 | 跟 #15 去重（§4.4）                        |
|  10 | 2416 | `src/web-hub/hub/hub.ts`                      |          76 | 应拆（`startHub` 2006 行）                 |
|  11 | 2399 | `src/web-hub/protocol/messages.ts`            |          45 | 可按 frame 族拆（schema 文件，风险低）     |
|  12 | 2292 | `src/web-hub/hub/uploads.ts`                  |           — | 内部是 1787 行闭包，碰到时再拆             |
|  13 | 2265 | `src/cache-ttl/keepalive-state.ts`            |           — | 57 个函数平铺，可按「窗口/断路器/读回」拆  |
|  14 | 2135 | `src/web-hub/hub/feishu/service.ts`           |           — | 内部是 1909 行闭包                         |
|  15 | 2127 | `src/index.ts`                                |          77 | 应拆（§3）                                 |
|  16 | 2100 | `src/web-hub/hub/feishu/state.ts`             |           — | 暂缓                                       |
|  17 | 2099 | `src/bash/manager.ts`                         |           — | `createBashJobManager` 1615 行，碰到时再拆 |
|  18 | 2021 | `src/workflow/host.ts`                        |           — | `attachHostCallHandler` 1517 行            |
|  19 | 1983 | `src/web-hub/ui/src/logic/token-client.js`    |           — | 跟 #9 去重                                 |
|  20 | 1863 | `src/web-hub/ui/src/logic/state.js`           |           — | 无类型 JS，见 §5                           |

> 超过 1500 行的 TS 文件有 21 个，超过 1000 行的有 40 个。近 30 天提交最多的 6 个 src 文件依次是 `index.ts`(77)、`web-hub/hub/hub.ts`(76)、`web-hub/agent/index.ts`(71)、`config/settings.ts`(67)、`stack.ts`(65)、`config/setting-specs.ts`(57)。**大文件和热点文件高度重合**：每个新功能都要往这几个组装/设置文件里加东西，这是并行车道冲突的主要来源。

### 1.3 超长函数（AST 统计，≥1000 行）

`createSpawnSupervisor` 2330（`web-hub/hub/spawn/supervisor.ts:624`）· `startHub` 2006（`hub/hub.ts:296`）· `createFeishuBotService` 1909（`hub/feishu/service.ts:225`，内层 `buildRuntime` 1483）· `wireWebHub` 1807（`agent/index.ts:517`）· `createUploadStore` 1787（`hub/uploads.ts:505`）· `activate` 1752（`index.ts:169`）· `createBashJobManager` 1615（`bash/manager.ts:467`）· `buildSessionStack` 1566（`stack.ts:2110`）· `attachHostCallHandler` 1517（`workflow/host.ts:504`）· `createSpawnRoutes` 1454 · `createSpawnService` 1223 · `createPreviewRoutes` 1187 · `createTrafficServer` 1150 · `createFeishuState` 1070 · `createMessageScheduler` 1067 · `createRuntimeRunnerAdapter` 1044（内层 `run` 748）· `createHttpFrontend` 1043。

这是项目约定「不留模块级可变状态，每次 `activate()` 在闭包里重建」的自然产物。约定本身是对的（`/reload` 同进程重激活），但闭包越长，内部状态之间的耦合越看不见。治理方向不是取消闭包，而是**把闭包拆成几个子工厂，共享一个显式的 `ctx`/`deps` 对象**。`web-hub/hub/` 里已有先例：`createHttpFrontend` 把路由下放给 `createPreviewRoutes`、`createSpawnRoutes` 等子工厂。

### 1.4 拆分边界建议（只列应拆项）

- **`secure/bin/helper.mjs`**：已有 convert/archive/tree/tar/sessions 五个拆出去的引擎，可沿用同一模式。建议拆成 `private.mjs`（`cmdPrivate*` 4842–5100、`lockPrivate`/`lockOuter`/`underMountLock` 5185–5400、`cmdMountWork`/`cmdNsRoot` 5765–6000，约 1500 行）、`finalize.mjs`（卸载/占用扫描）、`init.mjs`（`cmdInit` 3081–3429），`helper.mjs` 只保留 CLI 分发和共用原语。约束不变：零依赖、纯 ESM、settings 契约靠 parity fixture 锁死。
- **`web-hub/hub/http.ts`**：`handleLanRequestInner`（599 行）+ `createLanTransport` + `handleLanLogin` 拆到 `http-lan.ts`；`dispatchCmdOrDialog`（281 行）拆到 `http-cmd.ts`；`createRouteSet` 保持原样。
- **`web-hub/agent/index.ts`**：`wireWebHub` 里约有 92 个 `const`/`let` 状态；StatusInfo 各个 slot 的「投影 + 指纹闸门」（`lastFleetFp/lastTodoFp/lastBashFp/lastQuotaFp/lastKaFp` + archive rev + worktree）可以抽成 slot 表（§4.5）；hold 接线（`:728`）和 dialogs 也可以单独成文件。
- **`config/settings.ts`**：按子系统拆，见 §2.4。
- **`stack.ts` / `index.ts`**：见 §3。

---

## 2. 分层与依赖

### 2.1 pi-free 约束核查（值导入传递闭包，`import type` 不计）

| 范围                                          | 直接导入 pi                        |                                传递到 pi 的值路径 | 结论                                                                                    |
| --------------------------------------------- | ---------------------------------- | ------------------------------------------------: | --------------------------------------------------------------------------------------- |
| `src/core/**`                                 | 无                                 |                                                 0 | ✅ 真 pi-free，而且不导入任何 core 以外的目录                                           |
| `src/prompt-sections/**`                      | 无                                 |                                                 0 | ✅                                                                                      |
| `src/git/**`                                  | 无                                 |                                                 0 | ✅                                                                                      |
| `src/memory/{paths,frontmatter,store,render}` | 无                                 |                                                 0 | ✅                                                                                      |
| `src/delivery`、`archive`、`external-agent`   | 无                                 |                                                 0 | ✅（未声明为 pi-free，但实际是）                                                        |
| `src/web-hub/{hub,protocol}/**`               | 只有 typebox（9 个 protocol 文件） |                                      只到 typebox | ✅ 符合 boundary 测试白名单（`node:*` + typebox + 指定 git/sysload/schedule-core 文件） |
| `src/schedule/core/**`                        | 无                                 | 只到 typebox（经 `web-hub/protocol/schedule.ts`） | ✅ hub 只白名单了其中 6 个只读文件，闭包表锁死在 `tests/web-hub/boundary.test.ts`       |
| `src/sysload/**`                              | `hook.ts` 只有 type 导入           |                                                 0 | ✅                                                                                      |
| `src/quota/**`                                | `credentials.ts` 有值导入          |                                                 2 | 不是 pi-free 目录，无约束                                                               |
| `src/fabric/xs/render.ts`                     | 值导入 pi-tui                      |                                                 — | xs 的大部分 pi-free，只有 render 是 pi-facing，可以接受                                 |

**hub 进程的真实闭包**：235 个文件，出界 20 个：`core/clock.ts`、`git/{run,worktrees,diff,graph}.ts`、`schedule/core/{spec,cron,occurrence,paths,reader,recovery}.ts`、`secure/env.ts`、`sysload/{io-ledger,mounts,procfs,sampler,top,tracker,types,wire}.ts`。boundary 测试的 `SYSLOAD_FILE_ALLOWLIST` 里列了 `src/config/settings.ts`，但 hub 对它**只有 type 导入**（实测值闭包里没有它）。建议在白名单上注明「type-only」或干脆移除，免得以后有人加值导入时误以为已经被允许（§8 #6 顺手做）。

**没有发现违规。** 仓库里已有 `tests/web-hub/boundary.test.ts`、`tests/topic-switch/pi-free.test.ts`、`tests/context-switch/boundary*.test.ts` 三类边界守卫，但 **`src/core`、`src/prompt-sections`、`src/git` 的 pi-free 只是文档约定，没有测试守卫**（`tests/core/core.test.ts` 只是注释里说「no pi imports」）。建议补一个统一的 import-boundary 测试（§8 #6）。

### 2.2 顶层目录依赖图

- 37 个节点，263 条有向边（其中 204 条至少含一个值导入）。
- 出度最高：`index`(36)、`stack`(26)、`commands`(20)、`web-hub`(18)、`tools`(17)、`service`(15)。入度最高：`config`(25)、`service`(15)、`web-hub`(14)、`secure`(10)。
- **双向边 32 对，其中 19 对两个方向都有值导入**（全表见附录 B）。
- **按值边求 SCC：22 个目录构成一个强连通分量**：adapters、archive、bash、cache-ttl、child、config、consult、context-switch、fabric、memory、mention、runtime、schedule、service、session-nav、stack、todo、tools、topic-switch、ui、web-hub、workflow。
- **文件级值导入图无环**（Tarjan SCC = 0），所以没有 ESM 初始化顺序问题。只算类型导入时有 13 个文件级 SCC，最大两个各 26 个文件（`web-hub/hub/{ports,registry,lifecycle,spawn/*…}` 一组；`config/settings` ↔ `web-hub/agent/*` ↔ `fabric` ↔ `quota` 一组），运行时无害。

**解读**：目录级大环是由少数**放错目录的文件**造成的，不是架构倒置。修好下面 §2.3 这十几条边，大环就会裂成若干小块。

### 2.3 「下层/基础模块引用上层」清单（值导入，带坐标）

| 反向边                       | 证据                                                                                                                                                                                                                                              | 问题                                                                            | 建议                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config` → 子系统            | `config/settings.ts:9` → `cache-ttl/keepalive-state`（`MAX_SAFE_KEEPALIVE_INTERVAL_MS`）；→ `fabric/xs/channel`、`memory/tidy/batch-settings`、`topic-switch/settings`、`web-hub/protocol/{lan,client-allow}`                                     | 设置是被 25 个目录依赖的基础模块，它自己却反向导入 6 个功能模块                 | 子系统的设置类型和解析下沉到 `<子系统>/settings.ts`（topic-switch、memory/tidy、external-agent/droid、extensions/worktree-settings 已经这样做）；把常量移到叶子模块 |
| 子系统 → `config` 拿领域逻辑 | `fabric/xs/membership.ts:2`、`web-hub/agent/xs.ts:31` 从 `config/settings.ts` 导入 `effectiveReceive`/`isValidXsSessionId`（`settings.ts:1101`、`:1253`）                                                                                         | xs 的领域判定放在了设置文件里                                                   | 移到 `fabric/xs/receive.ts`                                                                                                                                         |
| `service` → `tools`          | `service/runtime-adapter.ts:56,66-68` 导入 `createAgentTool`/`createStructuredOutputTool`/`createMessageAgentTool`/`createSetModelTool`                                                                                                           | runtime-adapter 实际上是**子会话工具注入的第二个组装点**                        | 承认这个角色：抽成 `child/tools.ts`（子会话工具组装），runtime-adapter 只调用它                                                                                     |
| `adapters` → `tools`         | `adapters/workflow-notice.ts:15` → `tools/workflow-tool.ts`                                                                                                                                                                                       | 适配层依赖工具面                                                                | 把共享的格式化移到 `workflow/notice-format.ts`                                                                                                                      |
| `runtime` → 功能模块         | `runtime/session-driver.ts` → `consult/{fork-store,anchor,prefix-probe}`、`secure/domain`、`child/activation-signal`                                                                                                                              | 运行时核心直接认识 consult/secure                                               | consult 在 #40 整块消失；secure/child 改走 driver 的注入端口                                                                                                        |
| 功能 → 组装点 `stack.ts`     | `todo/index.ts:37` 导入 `BASH_JOB_NOTIFICATION_TYPE`；`context-switch/child.ts:28` 导入 `createCompactHintHook`（值）；`commands/status.ts:32`、`context-switch/session-facts.ts:9`、`tools/set-compact-threshold-tool.ts:12` 导入类型            | 子会话路径（`context-switch/child.ts`）值导入了整个 `stack.ts`（124 个 import） | 常量移到 `bash/notify.ts`，钩子移到 `compact-hint/hook.ts`（§3.2）                                                                                                  |
| 通用能力 → `web-hub/agent`   | `web-hub/agent/command-capture.ts` 的 `wrapCommandApi`/`isWebInvocation`/`isFeishuInvocation` 被 `index.ts:135`、`commands/{schedule,fabric-xs,webhub}.ts`、`memory/tidy/batch-command.ts:51`、`ui/settings-editor.ts:2`、`todo/index.ts:32` 使用 | 命令包装是 activate 第一步就装上的横切能力，却放在可选子系统 web-hub 里         | 移到 `src/commands/capture.ts`（或 `src/command-api/`）                                                                                                             |
| `archive`/`web-hub` → `ui`   | `archive/control.ts:31` 从 `ui/fleet-panel.ts` 导入 `isTerminalStatus`；`web-hub/agent/status.ts:12` 导入 `buildFleetViewModel`                                                                                                                   | 视图模型放在 TUI 目录里；而且 `isTerminalStatus` 是重复实现（§4.1）             | 改用 `core/status.ts`；`fleet-panel` 的纯视图模型部分移到 `src/fleet/view-model.ts`                                                                                 |
| `core` 里有功能私货          | `core/consult-summary.ts`、`core/consult-cache-marker.ts`；`core/state-machine.ts:12` 导入 `foldConsultCall`                                                                                                                                      | 本该是纯领域的核心里放了 consult 的统计                                         | #40 一并删除                                                                                                                                                        |
| `cache-ttl` ↔ `service`      | `service/cache-keepalive.ts`（1803 行）导入 `cache-ttl/{keepalive-state,ping-client,pipeline-ping,late-usage}`；`cache-ttl/child.ts` 反向导入它                                                                                                   | keepalive 服务属于 cache-ttl 子系统，放进 service 后形成环                      | 移到 `cache-ttl/keepalive-service.ts`                                                                                                                               |
| `bash` ↔ `tools`             | `bash/child.ts:28-29` → `tools/bash-tool.ts`/`bash-job-tool.ts`；`tools/bash-job-tool.ts` → `bash/manager.ts`                                                                                                                                     | bash 的工具不在 bash 目录里                                                     | 把两个工具移到 `bash/`                                                                                                                                              |
| `context-switch` ↔ `tools`   | `context-switch/child.ts` → `tools/switch-context-tool.ts`，后者导入 `context-switch/{handoff,skills,store}`                                                                                                                                      | 同上                                                                            | 工具移到 `context-switch/tool.ts`                                                                                                                                   |
| `config` ↔ `memory`          | `memory/init-command.ts:32`、`memory/tidy/command.ts:12` 导入 `DEFAULT_SETTINGS`                                                                                                                                                                  | 拆完设置后自然消失                                                              | 同第一行                                                                                                                                                            |

### 2.4 `config/settings.ts`（3817 行）结构

41 个 `*Settings` 类型、70 个顶层函数，全部平铺在一个文件里；同目录的 `setting-specs.ts`（1455 行）又把 TUI 设置项描述维护了一遍。最长的几段：`parseExternalAgentsSettings` 207 行、fabric/xs 相关的 `effectiveReceive`…`isValidXsSessionId` 一带约 560 行、`parseLoadSettings` 103 行、`parseFeishuBotBlock` 83 行。

当前是**混合模式**：一部分子系统自己维护设置（`topic-switch/settings.ts`、`memory/tidy/batch-settings.ts`、`external-agent/droid/settings.ts`、`extensions/worktree-settings.ts`、`ask-user/interrupt.ts`），其余集中在这一个文件里。建议统一成「子系统自管 `settings.ts`（类型 + 默认值 + 纯解析）+ `config/settings.ts` 只负责读文件、迁移和聚合」，预计能缩到 1000 行以内。`setting-specs.ts` 可以按同样的子系统边界分片，再在 `config/` 里汇总。

---

## 3. 组装点：`src/index.ts` 与 `src/stack.ts`

### 3.1 `src/index.ts`（2127 行，115 个 import，61 处 `pi.on`/`registerTool`/`registerCommand`）

- **pre-guard 段（169–316，约 150 行）是清楚的**：`initSecureDomain` → `wrapCommandApi` → `readSettingsNoMigrate` → secure guards → web_search → date → todo → promptHub → memory → 子会话 bash/child/traffic → `if (g[HOST_KEY]) return`。和 AGENTS.md 的描述一致。有一处文档缺口：`wireDate`（`:239` 一带）在 pre-guard 注册，但 AGENTS.md 完全没有提到 `src/date/`（§5.3）。
- **post-guard 段（316–1921，约 1600 行）已经不是「assembly only」**。一部分子系统用 `wireX(pi, deps)` 一行接入（hud/feishu/session-nav/title/topic-switch/webHub/traffic/askUser/cacheTtl/schedule），另一些仍是大段内联：
  - fabric 跨会话 xs：`772–941`（约 170 行：sender、3 个工具、`/fabric` 命令、entry renderer）
  - 子 agent 核心工具：`967–1060`（Agent/result/list/steer/set_model/abort/extend，约 95 行）
  - context-switch/compact：`1065–1110`；bash：`1119–1190`；goal/status/task：`1195–1335`
  - mention：`1392–1550`（约 160 行，含 input 钩子与 autocomplete）
  - `session_start`：`1444–1583`；`session_shutdown`：`1583–1690`。两段都在**手工逐个 dispose 栈成员**（全文件 29 处 `.dispose(`，集中在 `1455–1472`、`1590–1667`）。
- 文件尾部还有一组非组装函数：`killBashJobsBounded`（1924）、`mentionAutocompleteEntries`（1944）、`mapMentionSendOutcome`（1967）、`mapTidySpawnRequest`（2004）、`forwardSpawn/Query/Workflow/BashJobs/Orphans/Notifier`（2020–2127）。

**可下沉项**：`wireFabricXs(pi, deps)` → `src/fabric/xs/wire.ts`；`wireMention` → `src/mention/wire.ts`；`registerSubagentTools` → `src/tools/register.ts`；`forward*` 和 `requireStack` → `src/holder.ts`（late-bound holder 转发器）；`session_start`/`session_shutdown` 的拆栈逻辑 → `Stack.dispose()`（§3.3）。完成后 `activate()` 预计 500–600 行，回到 I7 的本意。

### 3.2 `src/stack.ts`（3676 行，124 个 import）

| 段落                                                                                          | 行号                | 行数 | 性质                                                           | 去向                                                                 |
| --------------------------------------------------------------------------------------------- | ------------------- | ---: | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| bash job 通知常量、格式化、tail 读取、恢复调度                                                | 325–540、794–969    | ~390 | bash 子系统逻辑                                                | `src/bash/notify.ts` + `src/bash/recovery.ts`                        |
| `buildFabric`                                                                                 | 541–749             | ~210 | fabric 构建                                                    | `src/fabric/stack.ts`                                                |
| `currentSessionId`/`mainSessionFactsFrom`                                                     | 749–794             |  ~45 | 工具函数                                                       | `src/adapters/session-facts.ts`                                      |
| `CompactHintState` + `createCompactHintHook`                                                  | 997–1036、1222–1564 | ~380 | compact-hint 钩子（子会话也通过 `context-switch/child.ts` 用） | `src/compact-hint/hook.ts`                                           |
| `createNotificationReceiptHook` / `createBackgroundCompletionEventHook` / `hostWarn` / 状态栏 | 1564–1652           |  ~90 | 通知相关的小钩子                                               | `src/delivery/hooks.ts`                                              |
| `buildStackXs`                                                                                | 1715–2110           | ~400 | xs 栈构建                                                      | `src/fabric/xs/stack.ts`                                             |
| `buildSessionStack`                                                                           | 2110–3676           | 1566 | 真正的组装                                                     | 保留，内部再按「运行时 / 投递 / 外部 / workflow / web 端口」分子函数 |

另外 **19 个模块级 `let previous*`**（`stack.ts:229–322`：FleetWidget、Xs、RootWakeRecovery、UsageBroadcaster、Coalescer×2、BackgroundCompletions、BashJobs、Archive、BashJobRecovery、FabricMailbox、Keepalive、Quota、WorkflowRuns、WorktreeLate、WorktreeOrphansStartup、HostBashViewCapabilityRelease、External、Consult），用来在下一次 build 顶部清理上一栈。代码注释（X7b）已经承认：`/reload` 时模块会被 jiti 重新导入，这些变量看不到旧值，所以 index.ts 那边还得再做一遍。**全库模块级 `let` 共 35 个，其中 19 个在 stack.ts**（其余 `workflow/worker-source.ts` 7 个、`web-hub/hub/db-child.ts` 3 个是给子进程用的源码字符串，不算违例）。

### 3.3 拆栈逻辑写了三遍：最值得做、也最需要小心的一项

同一组 teardown 散在三处：`stack.ts` build 顶部（`previous*?.dispose()`，2127 起）、`index.ts` 的 `session_start` 防御分支（1451–1472）、`index.ts` 的 `session_shutdown`（1583–1690）。顺序约束都写在注释里，例如「ask-user 广播最先停」「schedule 必须在 run drain 之前 closeEpoch」「fleet widget 无条件先杀」。AGENTS.md 也写明了「no stack dispose hook」。

建议引入 `Stack.dispose(reason: "rebuild" | "shutdown")`，把顺序约束集中在一个函数里写清楚，三个入口都调它。这直接关系到零挂起不变式，**属于 L3**，必须先补一张「组件 × 入口 × 顺序」测试矩阵再动。

---

## 4. 重复与散落

### 4.1 确认的重复实现（带坐标）

| 能力                                          |                                      份数 | 坐标                                                                                                                                                                                                                                                                                                                                                                 | 差异 / 风险                                                                                                                      |
| --------------------------------------------- | ----------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `redactSecrets`（URL key/Bearer）             |                            2 份逐字节相同 | `web-search/resilience.ts:92`、`cache-ttl/ping-client.ts:86`（注释写着「避免跨功能导入」）                                                                                                                                                                                                                                                                           | 纯复制，零风险合并                                                                                                               |
| `redactSecrets` 变体                          |                                   另 2 份 | `web-hub/hub/feishu/http.ts:187`（更强的规则集）、`web-hub/agent/redact.ts:77`                                                                                                                                                                                                                                                                                       | 规则不同，按「hub 内 / agent 内」各保留一份可以接受                                                                              |
| `isTerminalStatus(RunStatus)`                 |                                      3 份 | `core/status.ts:12`（type guard + Set）、`ui/fleet-panel.ts:41`（数组 + includes）、`consult/tool.ts:362`                                                                                                                                                                                                                                                            | **语义漂移风险**：以后新增终态时只改一处就会出错。`archive/control.ts:31` 还在用 ui 那份                                         |
| `withDeadline`/`raceDeadline`（promise 超时） | hub 内 4 份 + core 1 份 + 3 份局部 lambda | `web-hub/hub/http.ts:358`、`hub/lifecycle.ts:88`、`hub/run-routes.ts:106`、`hub/req-deadline.ts:46`；`core/deadline.ts:268`；`goal/hook.ts:210`、`hub/history.ts:486`、`bash/manager.ts:546`；`quota/http.ts:59`                                                                                                                                                     | 错误形状各不相同（`code:"E_DEADLINE"` / `HubError` / 纯 Error）；`raceDeadline` 不清理 timer。hub 内可以统一到 `req-deadline.ts` |
| atomic write（tmp + rename）                  |       14 处具名函数，33 个文件调用 rename | `bash/session-dirs.ts:71`、`secure/settings-lock.ts:106`、`web-hub/hub/privacy/store.ts:56`、`hub/feishu/credentials.ts:219`、`hub/schedule/hub-state.ts:256`、`protocol/{stop-marker:27,token-file:25,rotate-intent:47}`、`schedule/core/writer.ts:181`（fd 锚定）、`memory/safe-fs.ts:403,1185`（fd 锚定）、`secure/bin/{helper:419,archive:826,sessions:101}.mjs` | fd 锚定的三类（memory/schedule/secure）是安全设计，应保留；**纯路径版约 8 份**可以收敛成 agent 侧 1 份 + hub/protocol 侧 1 份    |
| `isRecord`/`isPlainObject`                    |                                     28 份 | web-hub 11、cache-ttl 5、quota 4、session-nav 2，其余零散                                                                                                                                                                                                                                                                                                            | 低风险的微重复；hub 侧受边界白名单限制，需要在 `web-hub/protocol/` 里另放一份                                                    |
| `sha256Hex`                                   |                                     ≥6 份 | `memory/tidy/snapshot.ts:37`、`schedule/core/spec.ts:378`、`workflow/journal.ts:56`、`memory/safe-fs.ts:911`、`web-hub/hub/auth.ts:60`、`traffic/server.ts:77`                                                                                                                                                                                                       | 微重复                                                                                                                           |
| `formatDuration`                              |                                      3 份 | `core/format.ts:11`、`hud/format.ts:34`、`feishu-notify/core.ts:88`                                                                                                                                                                                                                                                                                                  | 输出格式各不相同（按 UI 文本规范），**不建议合并**                                                                               |
| sleep/backoff                                 |                                      若干 | `web-search/resilience.ts:43`、`memory/lock.ts:38`、`feishu-notify/core.ts:258`、`schedule/agent/dispatch.ts:557`                                                                                                                                                                                                                                                    | 微重复                                                                                                                           |
| 文件锁                                        |                                      4 套 | `memory/safe-fs.ts:1473`（目录锁 + epoch）、`schedule/core/lock.ts:101`（flock 二进制）、`secure/settings-lock.ts` + `secure/bin/*`（flock）、`web-hub/hub/singleton.ts:683`（pidfile）                                                                                                                                                                              | 语义各不相同（跨主机判死、M-T4 规则等），**不建议合并**                                                                          |
| Clock 接口                                    |                                      3 套 | `core/clock.ts:3`（73 处使用）、`ask-user/interrupt.ts:89`、`web-hub/hub/feishu/http.ts:34`（`FeishuClock`）                                                                                                                                                                                                                                                         | ask-user 那份可以并入 core；Feishu 受 hub 边界限制，可保留                                                                       |
| settings 文件读取                             |                                      2 套 | `config/settings.ts:3513`；`secure/domain.ts:551` + `secure/bin/helper.mjs:447`                                                                                                                                                                                                                                                                                      | 刻意为之：secure 必须在任何设置读取之前判定域，**合理**                                                                          |

**根因**：仓库没有 `src/util`/`src/shared`；hub 又被边界测试限定只能导入 `web-hub/{hub,protocol}` 和白名单文件，所以「hub 侧一份 + agent 侧一份」是结构性的必然。治理时应**按边界分两份**（`web-hub/protocol/util/*` 与 `src/core/*` 或新建 `src/shared/*`），不要追求全库只有一份。

### 4.2 同类子系统的共性

- **`*-status.ts`（`/webhub status` 渲染行）**：`web-hub/agent/{alias,privacy,cmd-args,cmd-history,ui,proxy,lan}-status.ts`，7 个文件，17–302 行不等，都是「hub.json 字段 / caps → string[]」的纯函数，再由 `commands/webhub.ts:155 formatStatus` 拼起来。共性是 `formatXStatusLines(input): string[]` + 可选的 level。**价值低**：可以并到 `web-hub/agent/status-lines/` 子目录，配一个 `index.ts` 有序汇总，不需要再抽象。
- **sampler**：`web-hub/agent/worktree-sampler.ts`（335 行，single-flight + 世代 + unref + 僵尸保护）和 `bash-jobs-sampler.ts`（428 行，世代钉住 + 单作业 deadline）在生命周期上高度相似；`quota-sampler.ts`/`cache-keepalive.ts` 其实是纯投影，不是 sampler。可以抽一个 `createSampler({ scan, deadlineMs, onResult })` 骨架，节省有限（约 150 行），**优先级低**。
- **StatusInfo slot**：`protocol/messages.ts` 的 `StatusInfo` 有 22 个字段；`wireWebHub` 里每加一个 slot 就要新增一个 `last*Fp` 变量、一段 1Hz 闸门和一段 payload 拼装（`agent/index.ts:556–567`、`1088–1126`）。抽一张 slot 注册表 `{ name, project, fingerprint, cap? }` 能给后续每个 slot 减少约 40 行接线，并让 `wireWebHub` 明显变薄，**中等优先级**。
- **两个 web 服务器 / 两套飞书**：`traffic/server.ts` + `traffic/web/app.js`（自己的 token 认证 HTTP 查看器）与 web-hub 并存；`feishu-notify/`（被动卡片）与 `web-hub/hub/feishu/`（机器人）并存。都是合并插件留下的平行结构，各自有冻结的安全设计，**不建议合并**（§8「不建议动」）。

### 4.3 UI 侧重复

`web-hub/ui/src/logic/password-client.js`（2459 行）的文件头写着「Mirrors `createClient` in token-client」。按去掉缩进后长度 >25 的去重行比较，`token-client.js` 的 782 个唯一长行里有 501 个也出现在 password-client 里（约 64%）。另外 `ui/src/logic/` 下有 33 个 `.js` 文件、15,930 行，`tsconfig` 里是 `allowJs:true, checkJs:false`，**这些都是无类型代码**。建议把两个 transport 共用的 EventSource 生命周期（看门狗、退避、重开）抽成 `transport-core.ts`，两种认证模式只保留差异部分。涉及 LAN 认证流，**L3**。

---

## 5. 命名与目录

### 5.1 目录归属不合理的文件（除 §2.3 已列的之外）

| 文件                                                                                                        | 现在的位置                             | 问题                                                                          | 建议位置                                                                       |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `service/cache-keepalive.ts`（1803 行）                                                                     | service                                | 属于 cache-ttl，造成 cache-ttl↔service 环                                     | `cache-ttl/keepalive-service.ts`                                               |
| `service/background-status.ts`                                                                              | service                                | 和 feishu-notify 共享的全局 provider，其实是 delivery 的一面                  | 可留，或移到 `delivery/`                                                       |
| `web-hub/agent/command-capture.ts`（800 行）                                                                | web-hub/agent                          | 横切命令包装，7 个非 web 模块在用                                             | `src/commands/capture.ts`                                                      |
| `tools/bash-tool.ts`、`tools/bash-job-tool.ts`                                                              | tools                                  | 工具和 `bash/` 相互依赖                                                       | `bash/`                                                                        |
| `tools/switch-context-tool.ts`、`compact-tool.ts`、`set-compact-threshold-tool.ts`                          | tools                                  | 分别属于 context-switch / compact-hint                                        | 各自子系统                                                                     |
| `tools/schedule-tool.ts`、`tools/{list-sessions,message-session,message-channel}-tool.ts`                   | tools                                  | 属于 schedule / fabric-xs                                                     | 各自子系统                                                                     |
| `commands/{webhub,fabric-xs,schedule}.ts`（共 2638 行）                                                     | commands                               | 而 memory/title/secure/topic-switch/goal 的命令都放在自己目录里               | 各自子系统；`commands/` 只留 `/agent` 系列（status/task）                      |
| `adapters/fabric-entry-renderer.ts`、`adapters/worktree-disposition-sink.ts`、`adapters/workflow-notice.ts` | adapters                               | 「pi-facing shim」与「某个子系统的 pi 面」混在一起                            | `adapters/` 只留 pi-compat/outbox/run-log；其余回归 fabric/extensions/workflow |
| `extensions/`                                                                                               | 只有 worktree 一种扩展 + `registry.ts` | 名不副实                                                                      | 可接受；或改名 `worktree/` + 保留 `extensions/registry.ts`                     |
| `ui/fleet-panel.ts`                                                                                         | ui                                     | 纯视图模型，被 web-hub、archive 引用                                          | `src/fleet/view-model.ts`                                                      |
| `consult/watcher.ts` 的 `createCapWatcher`                                                                  | consult                                | 被 `memory/tidy/command.ts:13,377` 复用，是通用的「turn/cost 封顶」           | 移到 `runtime/cap-watcher.ts`（#40 的前置步骤）                                |
| `runtime/tool-scope.ts:75 CONSULT_READONLY_TOOLS`                                                           | runtime                                | tidy 的 readonly 域、`memory/tiered.ts:131`、`runtime-adapter.ts:1070` 都在用 | 改名 `READONLY_DOMAIN_TOOLS`（#40 时做）                                       |
| `core/consult-*.ts`                                                                                         | core                                   | 同 §2.3                                                                       | #40 删除                                                                       |
| `rpc/client.ts`、`workflow/orchestrator.testing.ts`、`web-hub/hub/lan-security-stubs.ts`                    | src                                    | 只被测试引用                                                                  | 移到 `tests/helpers/`，或删除（§6）                                            |
| `vendor/qrcodegen.ts`                                                                                       | vendor                                 | 只被 `commands/qr-render.ts` 使用                                             | 合理                                                                           |

**规律**：tools/commands 两个按「技术形态」划分的目录，和其余按「子系统」划分的目录并存。比较晚并入的插件（memory/todo/ask-user/web-search/title/secure）都把工具和命令放在自己目录里，早期 subagent 核心和部分大子系统（bash/context-switch/schedule/fabric-xs/webhub）则放进了 tools/commands。建议统一成「**子系统目录自带 tool/command，`tools/`、`commands/` 只放 subagent 核心面**」。这一条是纯移动，但触及的 import 很多，要按子系统分批做。

### 5.2 遗留 pi-subagent 命名

- 运行时标识（`pi-subagent.json`、`Symbol.for("pi-subagent:*")`、`subagent:*` customType、`[pi-subagent]` 日志前缀）按 AGENTS.md 是**刻意保留**的，不算问题。
- 源码中**不属于运行时契约**的旧名：`index.ts` 默认导出名、`SubagentExtensionPoints` 类型（`extensions/registry.ts`）、`SubagentWorkflow` 工具名等都是有意义的域名词，不是遗留问题。**没有发现需要改的「伪旧名」**，这一项不建议投入。

### 5.3 AGENTS.md 未登记的目录

`src/date/`（3 个文件，385 行，pre-guard 注册）、`src/title/`（4 个文件，1160 行）、`src/vendor/` 在 AGENTS.md 的 Repository layout 中出现 0 次（`grep -c "src/<dir>/"` = 0）。

---

## 6. 死代码与低价值代码

方法：用 TS AST 收集 `src/**/*.ts`（不含 ui）的 7808 个顶层导出名，在 `src`、`tests`、`scripts`、根 `index.ts` 全量做标识符词频统计（附录 A）。**属于粗筛**：同名标识符会造成漏报（偏保守），动态访问会造成误报。

| 类别                                             |   数量 | 置信度 | 说明                                                                                                                                                                                                                                               |
| ------------------------------------------------ | -----: | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 值导出，全库只出现在声明处（self=1，无外部引用） | **93** | 高     | 37 个是 `export const X = Y;` 别名残留（plan 命名的兼容别名，例如 `memory/tidy/journal.ts:331-333`、`sysload/tracker.ts:418`），56 个是真实未用的函数/常量（清单见附录 C）                                                                         |
| 导出但只在本文件内部使用（多余的 `export`）      |  ~1760 | 中     | 不影响行为，只扩大公开面；不建议手工清理，引入 lint 规则时一次性处理                                                                                                                                                                               |
| 值导出只被测试引用（self=1）                     |     73 | 中     | 例如 `config/agent-types.ts appendAgentTypesToSystemPrompt`、`config/available-models.ts appendAvailableModelsToSystemPrompt`（legacy 追加链，现在由 `prompt-sections/fold.ts` 复刻）、`fabric/xs/unread.ts resetUnreadForTests`（合理的测试钩子） |
| 生产路径不可达的文件                             |      3 | 高     | `rpc/client.ts`（只有 `tests/rpc/rpc.test.ts` 用）、`web-hub/hub/lan-security-stubs.ts`（P0 适配器，只有一个测试用）、`workflow/orchestrator.testing.ts`（测试辅助放在了 src）                                                                     |
| 不再需要的 async 版本                            |      6 | 高     | `web-hub/protocol/stop-marker.ts` 与 `rotate-intent.ts` 的 `read/write/remove*`（async），生产代码只用 `*Sync`                                                                                                                                     |

**已无效、但仍在代码里的设置/分支**（都是迁移路径，**属于有意保留**）：

- `cacheTtl.keepaliveMaxPings`：已移除，只保留 status 迁移提示（`config/settings.ts:375-378,2306`）；`cacheTtl.mode="adaptive"`：已移除，出现时 warn 后回落 auto（`:2294`）；遗留的 `*Ms` 键迁移（`:3706`）；`cache-ttl-state.json` 迁移（`:3725`）。建议定一个「迁移代码保留 N 个 minor」的规则，到期删除。
- `systemPrompt.wakeReplay` 和 `adapters/pi-compat.ts:257` 的 trigger shape 探针：注释写着「pi ≥1.2 时休眠，为 1.0/1.1 peer floor 保留」（`sysprompt/wake-replay.ts:12-20`）。当前 peer 是 `>=1.0.0 <1.4.0`，devDep 是 `^1.3.0`。**是否把 peer floor 提到 1.2 需要用户拍板**；提了之后约 5 处兼容分支可以删除。
- `memory.layout="legacy"` / `toolSurface="legacy"`（`memory/render.ts`、`memory/tool.ts` 与 tiered/v2 并存，golden `memory-legacy-golden.json` 冻结）：这是用户可选的回退，**不是死代码**，删除需要用户确认弃用窗口。

---

## 7. 文档：AGENTS.md

### 7.1 现状数据

- 1325 行，**157,630 字节**（约 4 万 token）；作为项目指令注入到每个 pi 会话（主会话和子 agent 都会注入）。
- 近 30 天被改了 110 次（总计 143 次），几乎每个功能 PR 都要追加一大段。
- Repository layout 一节占 1165 行，各条目体量：`src/web-hub/` **48.7 KB / 430 行**、`src/fabric/` **22.4 KB / 187 行**、`src/secure/` 8.3 KB（只有 2 行，单行极长）、`src/cache-ttl/` 7.7 KB、`src/schedule/` 7.2 KB、`src/workflow/` 7.0 KB、`src/consult/` 4.5 KB；这七条加起来约占全文 68%。
- 内容层次混杂：同一条里既有「agent 必须知道的不变式」（例如「三份 off golden 永不重生」「hub 不得导入 pi」），也有「某个 plan 第 X 包的验收细节、残留风险编号 R1–R13」这类只有动到该子系统才需要的材料。
- 「pi peer bump 前要跑」的提醒散在 8 处，「never regenerate」散在 6 处，但 `package.json` 的 `test:conformance` 就是 `vitest run tests/conformance`（会把 42 个文件全部跑完），`vitest.config.ts:20` 的 `npm test` 也包含 conformance（自带门控）。
- `docs/dev/` 有 85 个子目录、65 份 plan.md，但只有 2 份 README（`external-agent`、`feishu-bot`）。

### 7.2 建议的拆法

1. **AGENTS.md 只保留对所有任务都成立的内容**，目标 ≤ 25 KB / ≤ 300 行：What this is（压缩到 1 段）· Commands · **全局不变式清单**（零挂起、HOST_KEY、pre/post guard 规则、pi-free 边界、模块级状态禁令、unref timer、运行时旧名保留）· **冻结物清单**（13 个 golden 的路径合成一张表，加 `legacy-xs-v071`）· **peer bump 检查单**（一句「`npm run test:conformance` + `PI_TOOLKIT_DROID_CONFORMANCE=1` 的 droid 套件」，取代散落的 8 处）· Conventions · 发版。
2. **Repository layout 改成一张表**：每个目录 1–2 行职责 + 「改动前必读：`docs/dev/<x>/README.md`」。
3. **每个大子系统新建 `docs/dev/<x>/README.md`**，内容就是把现在 AGENTS.md 里对应那一大段原样下沉（web-hub、fabric-cross-session、secure/data-encryption、cache-ttl-keepalive、schedule/scheduled-reports、workflow、traffic、memory、topic-switch、external-agent），README 再链接到各 plan/report。web-hub 那段可以再按 control/preview/spawn/feishu/lan-security/proxy 拆成 README 下的小节。
4. **保持对 agent 的引导作用**：在 AGENTS.md 顶部写一条硬规则：「改动 `src/<x>/` 前先 read `docs/dev/<x>/README.md`」，再配一张「目录 → README」映射表。可选：在 `skills/dev-flow` 的探索阶段加一步「读对应 README」。这样既省下每轮约 3 万 token，又不会丢掉信息（只是按需加载）。
5. **防止再次膨胀**：在 `CONTRIBUTING`/AGENTS 里约定「功能细节进 README，AGENTS 只记不变式和冻结物」；可以加一个 CI 检查（AGENTS.md 字节数上限，例如 30 KB）。

---

## 8. 结论：治理建议 Top 10

排序依据：收益（降低 token/冲突/漂移风险）÷（风险 × 工作量）。「并行」指能否和其他条目同时由不同 agent 在独立 worktree 里做。

|   # | 建议                                                                                                                                                                                                                                                                                                             | 证据                                                    | 收益                                                                        | 风险                                                                                               | 工作量                             | 车道               | 并行                                                                |
| --: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------ | ------------------------------------------------------------------- |
|   1 | **AGENTS.md 瘦身 + 子系统 README 下沉**（§7.2）                                                                                                                                                                                                                                                                  | 157 KB，每个会话约 4 万 token；30 天改 110 次           | 高：每个会话省约 3 万 token，冲突减少                                       | 低（纯文档）                                                                                       | 中（10 份 README，内容基本是搬运） | L2                 | ✅ 可以按子系统分给多个 agent 写 README；AGENTS.md 主文件由一人收口 |
|   2 | **零风险去重小包**：`redactSecrets` 合并、`isTerminalStatus` 统一到 `core/status.ts`（改 `archive/control.ts:31`、`ui/fleet-panel.ts:41`）、hub 内 4 份 `withDeadline` 收敛到 `hub/req-deadline.ts`、`ask-user` Clock 并入 core                                                                                  | §4.1                                                    | 中：消除漂移点                                                              | 低                                                                                                 | 小                                 | L1                 | ✅                                                                  |
|   3 | **死代码清理**：37 个别名、56 个未用值导出、6 个 async 包装、3 个只服务测试的 src 文件移到 tests                                                                                                                                                                                                                 | §6、附录 C                                              | 中：缩小公开面                                                              | 低（逐个 grep 复核）                                                                               | 小                                 | L1                 | ✅（和 #2 不冲突）                                                  |
|   4 | **stack.ts 机械下沉**（bash 通知 → `bash/notify.ts`；compact-hint 钩子 → `compact-hint/hook.ts`；`buildFabric`/`buildStackXs` → `fabric/`；`BASH_JOB_NOTIFICATION_TYPE` 等常量跟着走）                                                                                                                           | §3.2；同时消除 `todo`/`context-switch` → stack 的反向边 | 高：stack.ts 约 −1100 行，热点冲突减少                                      | 低到中（纯移动，导出名不变，可以留 re-export 过渡）                                                | 中                                 | L2                 | ⚠️ 和 #5、#7 都会碰 stack/index，要串行或预先分好段落               |
|   5 | **index.ts 抽子 wire**：`wireFabricXs`、`wireMention`、`registerSubagentTools`、`holder.ts`（forward*）                                                                                                                                                                                                          | §3.1                                                    | 高：`activate()` 从 1752 行降到约 600 行，回到 I7                           | 中（注册顺序会影响 pi 的工具/钩子先后，要用 `tests/integration/*wiring*` 和 3 份 off golden 守住） | 中                                 | L2                 | ⚠️ 排在 #4 之后                                                     |
|   6 | **目录归属修正 + 补边界测试**：`service/cache-keepalive.ts` → cache-ttl；`command-capture` → `commands/capture.ts`；bash/context-switch 的工具回归各自子系统；xs 领域函数移出 config；新增 `tests/boundary/*`，守 core/prompt-sections/git 的 pi-free，并修正 sysload 白名单里 type-only 的 `config/settings.ts` | §2.3、§5.1                                              | 中高：目录级 SCC 明显缩小，可以防止回退                                     | 低（移动 + import 路径）                                                                           | 中                                 | L2                 | ✅ 按子系统分包；和 #4/#5 有少量 import 冲突                        |
|   7 | **`Stack.dispose()` 统一拆栈**（消灭 19 个 `previous*` 模块变量、index.ts 两处手工 dispose）                                                                                                                                                                                                                     | §3.3                                                    | 高：零挂起不变式的顺序约束只写在一处                                        | **中高**（顺序错就会泄漏 timer 或误终止 run）                                                      | 中                                 | **L3**             | ❌ 独占；先写「组件 × 入口 × 顺序」测试矩阵                         |
|   8 | **settings 子系统化**：各子系统 `settings.ts` 自管类型/默认值/解析，`config/settings.ts` 只负责读取、迁移、聚合；`setting-specs.ts` 同步分片                                                                                                                                                                     | §2.4；`config` 入度 25，又是 67 次提交的热点            | 高：长期降低冲突，消除 config→功能的反向边                                  | 中（解析语义必须逐字节一致；`tests/config` 有 39 个文件、7094 行守护）                             | 大                                 | L3                 | ⚠️ 可以按子系统分包，但 settings.ts 要串行合入                      |
|   9 | **web-hub 巨型闭包分拆**：`wireWebHub` 引入 StatusInfo slot 注册表；`http.ts` 拆出 lan/cmd；`startHub` 拆出子装配                                                                                                                                                                                                | §1.3、§1.4、§4.2                                        | 中：web-hub 是最大的热点（hub.ts 76、agent/index.ts 71、http.ts 53 次提交） | 中（hub 有安全不变式 I1–I4 与大量集成测试）                                                        | 大                                 | L3（每个文件一包） | ✅ 三个文件可以并行，彼此独立                                       |
|  10 | **UI transport 去重 + logic/\*.js 逐步 TS 化**；`secure/bin/helper.mjs` 拆出 `private.mjs`/`finalize.mjs`/`init.mjs`                                                                                                                                                                                             | §4.3、§1.4                                              | 中                                                                          | 中（LAN 认证流 / 私有命名空间都是安全敏感路径）                                                    | 大                                 | L3                 | ✅ 两件事互相独立                                                   |

**推荐节奏**：第一波可以同时开 #1、#2、#3（全部 L1/L2，互不冲突）；第二波 #4 → #5 串行，#6 并行；#7 单独排期；#8、#9、#10 等 #40（移除 consult）落地后再做，可以少改一轮 consult 接线。**#40 应排在 #7/#8 之前**：它会删掉 `stack.ts:322 previousConsult`、`runtime-adapter` 的 142 处 consult 引用和 `core/consult-*`，能让后续拆分少很多噪声。

### 不建议动（风险高、收益低）

- **运行时旧名**（`pi-subagent.json`、`Symbol.for("pi-subagent:*")`、`subagent:*` customType、日志前缀）：承载现有会话数据和跨模块契约（AGENTS.md 明令）。
- **冻结 golden**：13 个 `tests/fixtures/*golden*` 和 `tests/fixtures/legacy-xs-v071/`。特别是 `fabric-{xs,wake,xs-reply}-off`、`schedule-off`、`secure-off`、`compact-hint`，它们是「功能关闭时逐字节一致」的证明。任何重构都不应该需要改动它们；如果需要改，说明重构改变了行为。
- **hub 边界放宽**：不要为了去重让 hub 导入 `src/` 下的通用工具；在 `web-hub/protocol/` 里另放一份。
- **fd 锚定的 atomic write / 文件锁合并**（memory/schedule/secure 三套）：各自承载不同的安全不变式（M-T4、跨主机判死、flock 租约）。
- **`secure/bin/*.mjs` 改写为 TS**：「git 安装零构建 + 零依赖直接运行」是硬约束。
- **traffic 查看器并入 web-hub**、**feishu-notify 与 hub feishu bot 合并**：安全模型（token / LAN 认证、claim 协议）不同，合并收益低。
- **`formatDuration` 三份合并**：输出格式各自服务不同 UI（HUD 英文标记 vs 中文卡片）。
- **memory legacy layout/toolSurface 删除**：这是用户可选的回退，要先拍板弃用窗口。
- **文件级类型环**：运行时无害，不值得为它改结构。

---

## 附录 A：方法与复现

- 依赖图：`/tmp/sg/deps2.cjs` 用 `typescript` 的 AST 遍历 `ImportDeclaration`/`ExportDeclaration`/动态 `import()`/`import("x")` 类型节点。type-only 的判定：`import type`，或所有具名 specifier 都带 `type`。不含 `src/web-hub/ui/**`。共 949 个文件、4366 条边。
- 顶层图 / SCC：`/tmp/sg/graph.cjs`（Tarjan，分别按值边和全部边计算）。
- pi-free 核查：`/tmp/sg/pifree.cjs`，对每个目录的每个文件做值边 DFS，目标是 `@earendil-works/*` 或 typebox。hub 闭包：`/tmp/sg/closure.cjs web-hub/hub/ '^web-hub/(hub|protocol)/'`。
- 函数长度：`/tmp/sg/fnlen.cjs`（函数声明、箭头函数、方法；起止行差 ≥400）。
- 死导出：`/tmp/sg/dead.cjs`，词频索引覆盖 `src`、`tests`、`scripts`、`index.ts`；`self` = 本文件内出现次数，`self=1` 表示只出现在声明处。
- 热点：`git log --since=2026-09-25 --name-only -- src`。
- 相似度：`comm -12` 比较两个文件去掉缩进后长度 >25 的去重行。

## 附录 B：顶层目录双向边全表

格式：`A <-> B  A→B 总边数/值边数  vs  B→A 总边数/值边数`，★ 表示两个方向都有值边。

```
archive <-> ui            1/1 vs 1/0
bash <-> tools            2/2 vs 6/2   ★
cache-ttl <-> config      2/1 vs 1/1   ★
cache-ttl <-> service     2/1 vs 7/4   ★
child <-> runtime         1/1 vs 1/1   ★  (child/wire→runtime/input-budget-registry; runtime/session-driver→child/activation-signal)
commands <-> web-hub      19/12 vs 2/0
commands <-> config       3/3 vs 1/0
config <-> external-agent 2/1 vs 5/0
config <-> fabric         1/1 vs 2/2   ★
config <-> memory         1/1 vs 9/2   ★
config <-> web-hub        3/2 vs 6/2   ★
config <-> quota          1/0 vs 3/0
config <-> topic-switch   1/1 vs 1/1   ★
config <-> sysload        1/1 vs 6/0
consult <-> service       6/2 vs 3/2   ★
consult <-> runtime       3/3 vs 3/3   ★
consult <-> tools         2/2 vs 1/0
context-switch <-> stack  2/1 vs 1/1   ★
context-switch <-> tools  1/1 vs 4/3   ★
fabric <-> mention        1/0 vs 1/0
fabric <-> service        5/0 vs 3/1
fabric <-> web-hub        12/4 vs 7/1  ★  (fabric/xs/*→web-hub/protocol/xs; web-hub/agent/xs→fabric/xs/channel)
mention <-> service       2/0 vs 1/0
mention <-> web-hub       2/1 vs 3/2   ★  (mention/session→protocol/xs-alias; agent/commands→mention/*)
runtime <-> service       1/0 vs 7/2
schedule <-> web-hub      6/4 vs 13/10 ★  (hub/schedule/*→schedule/core/*，在白名单内；schedule/core/spec→protocol/schedule)
service <-> tools         4/4 vs 12/0
session-nav <-> web-hub   1/1 vs 3/3   ★  (agent/resume-list→session-nav/{session-head,provenance,classify})
stack <-> tools           3/3 vs 1/0
sysload <-> web-hub       1/0 vs 9/6
todo <-> web-hub          1/1 vs 2/1   ★  (todo/index→agent/command-capture; agent/todo→todo/state)
ui <-> web-hub            1/1 vs 1/1   ★  (ui/settings-editor→agent/command-capture; agent/status→ui/fleet-panel)
```

其中 `schedule↔web-hub`、`fabric↔web-hub`、`session-nav↔web-hub` 是「hub/agent 读取对方纯函数核心」，属于**被白名单认可的合理依赖**，不算放错目录；真正需要修的是 §2.3 那张表。

## 附录 C：未引用的值导出（self=1，高置信度）

**别名残留（37）**——`export const X = Y;`：
`core/message.ts:206 formatEnvelope`、`:207 createMessageKey` · `delivery/engine.ts:317 createEngine` · `extensions/worktree.ts:503 createWorktreeExtensionPoints` · `external-agent/droid/usage-fields.ts:29 droidLastCallCounts` · `memory/tidy/archive-signals.ts:69 computeArchiveSignals` · `memory/tidy/batch-plan.ts:188 packBatches` · `memory/tidy/batch-settings.ts:67 parseTidyBatchSettings` · `memory/tidy/index-edit.ts:140-142 planIndexEdit/applyIndexEdit/applyIndexEdits` · `memory/tidy/journal.ts:331-333 foldJournal/nextRunState/decideOp` · `memory/tidy/lease.ts:145-149 create/read/refresh/release/breakRunLease` · `memory/tidy/manifest.ts:602 parseManifestV2` · `memory/tidy/run-ledger.ts:59 reserveRun`、`:61 watcherAllowance` · `memory/tidy/selection.ts:90 buildSelectionItems` · `memory/tidy/txn.ts:498-499 executeStep/executeTransaction` · `memory/tidy/ui/bounded-viewer.ts:71 boundedViewer` · `sysload/render.ts:45-47 buildLoadHintText/buildLoadRejectText/buildLoadRecoveryNotice` · `sysload/tracker.ts:418 createTracker` · `sysload/wire.ts:121-123 toLoadWire/toLoadGateWire/fingerprintLoad` · `web-hub/hub/avatar/fs.ts:223 defaultAvatarFs` · `web-hub/hub/avatar/validate.ts:39-40 validateAvatarPngHub/Node` · `web-hub/protocol/ui-manifest.ts:155 UNKNOWN_COMMIT`。

> 注意：部分别名可能是 plan 文档里约定的 API 名（例如 memory tidy 的 v3.2 plan）。删除前 grep 一下 `docs/dev/**` 里有没有引用；如果有，同步改文档。

**真实未用（56）**：
`cache-ttl/keepalive-state.ts payloadLineageKey` · `cache-ttl/measure-types.ts isMeasureApi` · `consult/preserve-identity.ts snapshotToolDeclarations` · `core/message.ts isMessageKey` · `extensions/worktree-settings.ts mergeWorktreeSettings` · `external-agent/droid/settings.ts effortInfoOf` · `memory/tidy/journal.ts canTransitionRunState` · `memory/tidy/manifest.ts backupLiveFile/copyLiveFileToBackup/readBackupFile/writeManifest` · `memory/tidy/run-ledger.ts remainingUsd/canDispatch/releaseReservation` · `runtime/input-budget-registry.ts isValidInputBudget` · `schedule/core/claim.ts claimableNow` · `schedule/core/occurrence.ts withinTolerance/undecidedCount/onceVerdict` · `schedule/core/spec.ts SCHED_RECEIPT_TTL_MS/SCHED_NOTE_MAX_RESENDS/SCHED_SECTION_NAME/SCHED_UNKNOWN_REASONS/SCHED_DROPPED_REASONS/SCHED_REPORT_SKIPPED_REASONS` · `schedule/core/writer.ts runsOfTask` · `secure/config.ts isLegacyVault` · `sysload/gate.ts loadLevelAtLeast/summarizeLoad` · `sysload/io-ledger.ts createIoLedger/getIoLedgerStats` · `sysload/render.ts buildLoadNotice` · `sysload/sampler.ts createDefaultSamplerIo` · `todo/ui.ts renderTaskPreview` · `traffic/persist.ts leaseOf` · `web-hub/hub/avatar/fs.ts ensureAvatarDir` · `web-hub/hub/avatar/routes.ts AVATAR_STATUS` · `web-hub/hub/avatar/validate.ts isAvatarRejectReason` · `web-hub/hub/spawn/history/budget.ts HISTORY_INDEX_BUDGET_MS/HISTORY_INDEX_BYTES_MAX/HISTORY_INDEX_MAX` · `web-hub/hub/spawn/history/index.ts parseCursor` · `web-hub/hub/spawn/history/snapshot.ts verifySnapshotAsync` · `web-hub/hub/supersede.ts SUPERSEDE_DRAIN_MAX_MS` · `web-hub/protocol/avatar.ts AVATAR_BODY_MIN_MS/AVATAR_BODY_CAP_MS/AVATAR_AUTH2_CAP_MS/AVATAR_LOAD_TOTAL_MS` · `web-hub/protocol/feishu.ts FEISHU_CMD_ID_PREFIX` · `web-hub/protocol/lan-2fa.ts LAN_LOGIN_PATH` · `web-hub/protocol/rotate-intent.ts readRotateIntent/writeRotateIntent/removeRotateIntent` · `web-hub/protocol/stop-marker.ts readStopMarker/writeStopMarker/removeStopMarker`。

> 一部分常量（`SCHED_*_REASONS`、`AVATAR_*_MS`、`HISTORY_INDEX_*`）是 plan 冻结的「词表/预算」文档化常量，可能是作为契约故意导出的。可以先改成不导出的内部常量，或者确认无用后删除；**中置信度**。

**只被测试引用的值导出**：73 个（列表在 `/tmp/sg/testonly.txt`，筛选 `^V self=1`），按目录分布：web-hub 28、traffic 10、schedule 8、compact-hint 4、cache-ttl 4、memory 3。多数是合理的测试钩子；值得复核的是 `config/{agent-types,available-models}.ts append*ToSystemPrompt`（legacy 追加链的残留）和 `rpc/client.ts createRPCClient`。

## 附录 D：移除 consult（#40）会牵动的模块

> 只列坐标和依赖，不给移除方案。数字是对 `consult` 关键字（不区分大小写）的 grep 计数；「值导入」来自 AST 依赖图。

**D.1 consult 本体**：`src/consult/`，14 个文件、5505 行（anchor-ledger、anchor、expert-index、fork-store、index、main-facts、prefix-probe、preserve-guard、preserve-identity、prompt、shadow-tools、threads、tool、watcher）。对外依赖：core 17、service 6、runtime 3、external-agent 2、config 2、tools 2、secure 1，以及 pi-coding-agent/pi-ai/typebox。

**D.2 直接导入 consult 的模块（外部 → consult/\*）**

| 导入方                             | 目标（V = 值导入，T = 类型导入）                                                                                                                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stack.ts`                         | V `fork-store`（`:145-151`：`forkMainSessionSnapshot`/`FORK_TTL_MS`/`removeForkFile`/`resolveForkCwd`/`scanExpertSnapshot`/`sweepForkDir`）、V `index`（`wireConsult`，`:152`；构建在 `:3104`）、T `tool`、T `main-facts`；模块变量 `previousConsult`（`:322`） |
| `service/runtime-adapter.ts`       | T `index`（`:57` `ResolveExpertsResult`）、V `preserve-guard`（`:58`，`:1071` 使用）、V `shadow-tools`（`:60-65`，`:872-936`）；共 142 处提及（`isConsultRun`/`consultC2`/`consultResolveExperts`/`readonlyDomain` 判定 `:662`）                                |
| `runtime/session-driver.ts`        | V `fork-store`、V `anchor`、V `prefix-probe`；consult fork 豁免 child-extension-missing 检测（`:908`）；共 73 处                                                                                                                                                |
| `schedule/agent/wire.ts`           | V `fork-store` `consultSessionDir`（`:26`，`:278` 用来判定会话文件是不是子会话文件）                                                                                                                                                                            |
| `schedule/agent/{bg,executors}.ts` | T `index`                                                                                                                                                                                                                                                       |
| `memory/tidy/command.ts`           | V `watcher` `createCapWatcher`（`:13`，`:377`）——**tidy 依赖的是通用封顶能力**                                                                                                                                                                                  |
| `tools/agent-tool.ts`              | T `index`；`experts` 参数（22 处）                                                                                                                                                                                                                              |

**D.3 共享资产（移除时必须保留或迁移，不能跟着删）**

- `runtime/tool-scope.ts:75 CONSULT_READONLY_TOOLS`：tidy 的 `toolDomain:"readonly"`（`service/runtime-adapter.ts:1047-1070`）、`memory/tiered.ts:17,131` 都在使用。
- `consult/watcher.ts createCapWatcher` / `ConsultCapReason`：memory tidy 在用。
- `consult/fork-store.ts consultSessionDir()`：schedule wire 判定子会话、secure 域路由（AGENTS.md：「`consultSessionDir()` routes create/main-fork/remove/sweep/index through `<state>/cache/consult-sessions`」，见 `secure/domain.ts` 3 处提及）、stack 的 fork 目录清扫。磁盘上可能残留 `~/.pi/agent/cache/consult-sessions/`（以及 vault 里 `<state>/cache/consult-sessions`），需要决定是否清扫。
- readonly 域的结构化输出冻结（`runtime-adapter.ts:868`）只依赖 `readonlyDomain`，与 consult 无关，但两者交织在同一段 `isConsultRun || toolDomain==="readonly"` 判定里。

**D.4 core 与持久化数据**

- `core/types.ts`（122 处）：`ConsultExpertRef`（`:170`）、`CONSULT_MAIN_AGENT_TYPE`（`:270`）、`RunDiagnostics.consults/experts`、`SpawnRequest.consultExperts`、fork 结果类型（`:290`）、C2 请求事实（`:316`）。
- `core/consult-summary.ts`（`CONSULT_OUTCOMES`、`foldConsultCall`）、`core/consult-cache-marker.ts`、`core/state-machine.ts:12,183-201`（`consult` 事件折叠进 diag）、`core/run-journal.ts`（9 处）、`core/dispatch-meta.ts`、`core/verdict-schema.ts`（`diag.schemaPreset`，属于 consult A/B 埋点）。
- **已持久化的会话条目**里有 `diag.consults`/`diag.experts`/`diag.dispatchMeta`（terminal entry、journal、tombstone）：旧会话的读回兼容需要决定是保留宽松解析还是丢弃字段。

**D.5 workflow**
`workflow/host.ts`（38 处 experts）、`workflow/agent-opts.ts`（26 处，`experts` 是 8 个允许的 opts key 之一，拒绝信息里会列出完整 key 列表）、`workflow/worker-source.ts`（16 处，worker 侧结构快照）、`workflow/expert-scope.ts`（整个文件）、`workflow/replay.ts`（`"experts"`/`"chain_tainted"` 跳过原因，9 处）、`workflow/spawner-adapter.ts`、`workflow/types.ts`；`tools/workflow-tool.ts`（4 处）。

**D.6 service / runtime / tools 其他位置**
`service/spawn-service.ts`（31 处：experts 解析、consult slotless、readonly 拒绝）、`service/request-threading.ts`（5）、`service/resolve-target.ts`（被 consult 导入：`expert-index.ts`、`index.ts`）、`service/cache-keepalive.ts`（2）；`runtime/runner.ts`（9）、`runtime/tool-scope.ts`（19：`consult` 出现在 deny-by-default 工具名表 `:38-43`，还有注释）；`tools/result-tool.ts`（8）、`tools/list-subagents-tool.ts`（2）、`tools/extend-timeout-tool.ts`（3）。

**D.7 组装、设置与周边子系统**

- `index.ts`（8 处）；`config/settings.ts`（16）+ `config/setting-specs.ts:908-930`（`consult.enabled/timeoutS/maxAnswerChars/maxTurns/maxFirstRequestUsd/maxCostUsd` 等 7 个旋钮）；用户 `pi-subagent.json` 里残留的 `consult.*` 键需要宽松忽略。
- `external-agent/messages.ts`（5：droid 拒绝 readonly/consult 的文案）、`secure/domain.ts`（3）、`traffic/warming.ts`（2）、`quota/render.ts`（2）、`memory/tidy/cost.ts`（2）、`memory/tiered.ts`（4）、`bash/process.ts`（5）、`commands/schedule.ts`（5）、`tools/schedule-tool.ts`/`schedule/agent/ops.ts`（各 3）。
- TUI：`ui/fleet-widget.ts`（7）、`ui/fleet-panel.ts`（7，consult cache 显示）。
- web-hub：`web-hub/agent/consult-transcript.ts`（整个文件，21）、`agent/status.ts`（11）、`agent/run-transcript.ts`（4）、`agent/{index,commands,xs}.ts`；`protocol/messages.ts`（15，wire schema 字段）、`protocol/run-transcript.ts`（3）、`protocol/worktree-graph.ts`（3）、`protocol/feishu.ts`（2）；`hub/run-transcript.ts`（2）；UI `components/drawer/RunTranscript.vue`（16）、`components/fleet/FleetTree.vue`（8）、`components/schedule/ScheduleReview.vue`（3）、`i18n/{zh,en}/{fleet,drawer}.ts`、`i18n/schedule-extra.ts`。web 的 wire 字段属于 append-only 协议，删除时要考虑旧 hub / 新 agent 的兼容。

**D.8 测试、脚本、文档、skills**

- `tests/consult/`（18 个文件）；另有 136 个测试文件提到 consult（不全是依赖，含顺带提及），重点是：`tests/integration/{consult,consult-wiring,consult-reload-dispose,consult-ab-instrumentation,consult-worktree-cwd,workflow-experts,readonly-domain-shadow-real-session,explicit-timeout-producers,child-session-marker,external-disabled-bytes,fabric-xs-child-scope}.test.ts`、`tests/ui/fleet-consult-cache.test.ts`、`tests/web-hub/ui/consult-cache-display.test.ts`、`tests/core/core.test.ts`（引用 `consult-cache-fixtures.js`）、`tests/schedule/**`、`tests/memory/{wire,tiered,eval-questions}.test.ts`、`tests/commands/{task,status,fabric-xs,webhub-2fa}.test.ts`。
- **conformance**：`tests/conformance/consult-preserve.test.ts`（C1–C7；AGENTS.md 多处要求在 pi peer bump 前和 fabric C-P/C-X、schedule C-S 一起跑）。
- golden：`tests/fixtures/memory-legacy-golden.json`（12 处 `experts`/consult，来自冻结的记忆文本，不是代码契约）、`fabric-xs-off-golden.json`（1 处，同样来自记忆文本）。按「永不重生」规则，**移除 consult 不应该导致这两个 golden 变化**；如果变了，说明碰到了非 consult 的路径。
- `scripts/exp/consult-{ab-analyze,ab-arm,ab-lib,anchor-probe,cache-analyze,cache-lib}.mjs`、`consult-fork-probe.ts`。
- `skills/dev-flow/references/{consult.md,consult-ab.md}`、`skills/dev-flow/SKILL.md`、`skills/dev-flow/references/subagent-workflow.md`、`skills/agent-handoff/SKILL.md`。
- AGENTS.md：`src/consult/` 条目（4.5 KB）加其余 34 行提及（runtime/service/workflow/fabric wake 的 `wakeExclusion: consult fork`、secure 的 `consultSessionDir`、peer bump 检查单等）；`docs/dev/consult/`（17 份 plan/report）；`docs/dev/topic-switch/*`、`docs/dev/feishu-bot/F6-report.md` 有顺带引用。
- fabric wake 的排除逻辑：`wakeExclusion`（consult fork 是其中一个取值）定义与使用分布在 `core/types.ts`、`core/{state-machine,message,run-journal}.ts`、`fabric/wake.ts`、`service/{spawn-service,runtime-adapter,tombstone,request-threading}.ts`、`stack.ts`，移除后该取值会变成死分支（持久化条目里可能仍有旧值，需宽松读回）。

> 后续（#40）：consult 已按 [`../consult-removal/plan.md`](../consult-removal/plan.md) 移除；本附录保留为移除前的影响面快照，实际处置以该方案及各包报告为准。
