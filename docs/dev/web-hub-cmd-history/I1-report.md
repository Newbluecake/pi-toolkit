# web-hub 命令历史 I1 — 集成 / conformance / 真机验收清单包 · 实施报告

> 2026-10-24 · 方案 `docs/dev/web-hub-cmd-history/plan.md` v2（§8.1 I1 行、§8.3 集成与 conformance 清单、§8.5 真机验收要点、§9 风险）。前置包已提交：P0 `e33b984f`、H1 `b6cff217`、U1 `a48559ea`、A1 `1e5633fe`。
> 文件域（越界零项）：`tests/integration/web-hub-cmd-history.test.ts`(新)、`tests/conformance/cmd-history.test.ts`(新)、`docs/dev/web-hub-cmd-history/acceptance.md`(新)、`AGENTS.md`（src/web-hub/ 段命令历史说明 + cmd-history conformance 进 pi peer bump 前必跑清单）、本报告。**`src/**` 一行未改**（并行包在改 `src/web-hub/protocol/**`、`src/web-hub/hub/ports.ts`、`src/config/settings.ts`、`src/web-hub/agent/command-policy.ts`、`src/schedule/**`，全程未触碰）。**零 git 写操作**；冻结 fixture（三份 fabric off golden、keepalive-legacy、legacy-xs-v071、preview corpus）零改动（`git status tests/fixtures/` 干净）。

## 交付物

| 文件                                            | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/web-hub-cmd-history.test.ts` | **真 hub 子进程 × 真实 stack**（同一 CHILD 脚本双角色：hub 角色 = 真 `startHub` 组合根 + stub HTTP 前端（socket/registry/history/bus/store 全真，浏览器监听换成记录 `append` bus 事件与 `cmd_late` 的探针）；agent 角色 = 完整 `activate()`（src/index.ts）+ 真 `SessionManager` 落盘 + 真 agent-socket 连接 + 真 status/leaf 投影，仅 pi host/model 为 fake——夹具形态取自 `fabric-xs-process.ts`/`web-hub-feishu-bot.test.ts` 家族，因 I1 文件域单文件而内联）。4 个用例覆盖任务全部 10 项（见下）。 |
| `tests/conformance/cmd-history.test.ts`         | 真 pi（devDependency，进程内）：§8.3 全部 6 条前提，7 个用例（#3 拆 streaming/settled 两半）。复用 `agent-session-harness.ts`/`tui-harness.ts`；带 gate 的 runtime 与 runtime 切换 harness（#6，web-resume C1 形态）本文件内自建。                                                                                                                                                                                                                                                                    |
| `docs/dev/web-hub-cmd-history/acceptance.md`    | 真机验收清单（操作→预期→取证，A–J 十组），含生效方式三步（`/reload` + `/webhub restart` + 刷新）、G7 拖延探针源码、日志卫生 grep、关闭开关回归。                                                                                                                                                                                                                                                                                                                                                      |
| `AGENTS.md`                                     | ① src/web-hub/ 段新增 **Command history** 块（冻结面、开关、G7/离开拦截、§4.10 回落、残留与闸门索引）；② Conventions 的 pi peer bump 段落把 `tests/conformance/cmd-history.test.ts` 加进「Also run」清单（六条前提逐条列名）。                                                                                                                                                                                                                                                                        |

## 集成用例 × 任务清单对照

任务列出的 10 项覆盖（全部真 hub × 真 stack）：

| #   | 任务项                                                                | 落点（用例）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | web 执行 toolkit 命令 ⇒ 文件出现 start/end、hub 投影给 UI、刷新后仍在 | 用例 1：`/agent status`（sync）⇒ 会话文件 1 条自包含 end（cmdId=帧 id、source web、state done、output 非空）；hub `history.snapshot`（浏览器刷新路径）投影出 `custom 墓碑 + cmd`（display:false）；append bus 事件携带同一 cmdId；二次 snapshot 仍在（「刷新后仍在」）。start+end 两条由用例 2 的 >400 ms 路径覆盖。                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | 同步 / 异步 / 确认后重发 / 忙时延迟                                   | 同步=用例 1；异步=用例 1 `/fabric status`（真 xs round-trip，completion async + `cmd_late` 带 output+`history`；另测 `/webhub status` 的 sync 前缀，record 正文含 `cmd-history: on · hub-cap on` 计数行）；确认后重发=`webCommandPolicy {goal:"confirm"}` ⇒ 首发无 confirm 得 `E_CONFIRM_REQUIRED`（effect none、无 data、零记录），confirm:true 后记录 done；忙时=busy 态下 allow 命令照常执行并记录。agent_settled 窗口（拖延处理器=夹具 `settleHold`，忠实复刻 `_isEmittingAgentSettled` 压栈语义）：**<5 s 认领路径**（completion unknown ⇒ release ⇒ 记录 cmdId=帧 id+完整 output）与 **>5 s 意图账本路径**（等 5.4 s 越过 FALLBACK_TTL 后 release，记录仍 cmdId=帧 id）——G7 的集成级回归钉。 |
| 3   | TUI 执行 toolkit 命令记录且终端输出不变                               | 用例 2：on/off 双 agent 对照——`/goal`、`/webhub token` 的 ui 调用序列**逐字节相等**（终端不变），on-agent 记 source tui；off-agent 零条目。>400 ms 懒 start：`/resume-recent` 挂在 pending `ctx.ui.custom` 上 ⇒ 先 start（source tui）后 end（interactive 条目 + `needsTerminal`）。                                                                                                                                                                                                                                                                                                                                                                                                               |
| 4   | /model 鉴权拒绝记 failed                                              | 用例 1：`setModel` resolve(false) ⇒ 记录 state failed、error=`authentication not configured for that model`；`cmd_late` 为 `E_SUBAGENT_REJECTED`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | /new 离开前写 end                                                     | 用例 1：done+`left-session` 记录落在**旧**会话文件（写序即证据），新会话零条目、内部跳板 `__exec` 零记录；cancel 模式 ⇒ 同 cmdId 两条（done→failed「新建会话被取消」，最后一条生效）。附 hub 侧事实钉：切换后 hub 重置 tail 基线（"browsers re-snapshot"），/new 卡不走 live append——由旧文件 + 新会话干净断言承担。                                                                                                                                                                                                                                                                                                                                                                               |
| 6   | 第三方扩展占位卡                                                      | 用例 1：第三方命令（启动前直插宿主表，绕过 wrapCommandApi ⇒ `owns=false`；web 侧默认 confirm 需 confirm:true）⇒ `notice:"terminal-only"`、无 output、`captured:false`、history recorded；终端确有输出（THIRDPARTY-PROBE 探针串）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7   | /webhub 敏感子命令只记头部                                            | 用例 2（TUI `/webhub token`：终端照常输出用法行，记录 `notice:"sensitive"` 无 output）；用例 1 附 web 侧事实钉：command-policy 对非 status 子命令一律 deny ⇒ effect-none 拒绝零记录（敏感面在 web 不可达，正确行为被钉住）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 8   | secure LOCKED 不写                                                    | 用例 3：`PI_SECURE_VAULT=<未登记名>` ⇒ 域 locked（inspect 佐证）；`/goal` TUI 照常执行（ui 调用在）但零条目；`/webhub status` 的 `cmd-history: on · … appended 0 · skipped [1-9] … failed 0` 计数行钉住 M1。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 9   | cmdHistory=false 全面不变                                             | 用例 2 off-agent：TUI 零条目、web 回复**无 `history` 字段**且 legacy capture 照常（sync+output）、hub 卡上 status.features 无 `cmd.history.v1`、终端输出与 on-agent 逐字节一致。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 10  | hub.log 与 agent 日志 grep 不到命令输出                               | 用例 1 收尾：hub.log 与 agent 子进程 stderr 对四个探针串（会话文件绝对路径、THIRDPARTY-PROBE、`cmd-history: on`、`新建会话被取消`）全部零命中。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

额外集成覆盖（方案 §8.3 I1 段的自然延伸）：**§4.10 ENOENT 回落**用例 4——无首条消息的会话（文件在磁盘上不存在、路径已报给 hub）里 web 命令的记录经 `branch_req` 从 agent 内存分支实时 append 给「浏览器」，snapshot `source:"agent"`，且全程未强制建文件（`existsSync` 保持 false——conformance #5 的前提在集成层再钉一次）。

## conformance 用例（§8.3 六条前提，真 pi）

1. **custom 不进 LLM**：`appendEntry` 后条目在 `getBranch`；`buildSessionContext().messages` 零贡献（长度相等）、`session.systemPrompt` 逐字节不变、后续真实回合的 provider payload 无探针串。
2. **无渲染器不渲染**：真 `InteractiveMode` + FakeTerminal——命令的 notify 上屏（证明命令真的跑了、TUI 活着），custom 条目正文与 `subagent:cmd` 类型名在 raw 流与整帧里都零出现。
3. **执行时序**：streaming 中（gate 住的真模型调用）`prompt("/cmd")` 在调用内立即执行（无需 streamingBehavior）；`agent_settled` 发射窗口（真 handler await gate）内两个 `prompt` 都先返回、命令未执行，release 后**按序**执行（`settled-done → one → two`）。
4. **`expandPromptTemplates:false` 不执行 slash**：`sendUserMessage("/zzcmdh …")` 默认形态——命令零执行、文本作为普通 user 消息进入 provider payload；显式 `{expandPromptTemplates:true, deliverAs:"followUp"}`（builtin-bridge 的原样调用形态）执行。
5. **无对话不落盘**：新会话里执行命令（零对话消息）⇒ 条目在内存分支、`existsSync(sessionFile)===false`；首条消息后文件创建且等待中的条目随整体刷出。
6. **newSession 语义**：真 `AgentSessionRuntime` + `bindExtensions({commandContextActions})`——`session_before_switch` 返回 `{cancel:true}` ⇒ `ctx.newSession()` 得 `{cancelled:true}` 且旧 ctx 仍可读（纠正性 end 合法窗口）；放行 ⇒ `{cancelled:false}`、会话真实替换、旧 ctx 任何读取抛 stale 错误。

## 夹具与实现要点（审阅索引）

- **CHILD 单脚本双角色**（`--import tsx --input-type=module -e`，仓库根 cwd）：hub 角色 stub 前端返回 `listen(){port:43211}`（fabric 先例，不真绑定）；agent 角色的 fake pi 忠实复刻 pi 的关键语义——`sendUserMessage` 仅在 `expandPromptTemplates:true ∧` slash 时在调用内执行（settleHold 时压 deferred 队列、**调用先返回**，release 后按序执行）；`events.on` 返回退订函数（一次踩坑：返回 EventEmitter 导致栈拆卸 `pop()()` 崩溃——`/new` 用例首轮失败定位）；`newSession` 走 teardown→swap→re-activate 全链（activate 复入、HOST_KEY 正常释放）。
- **cmd_late 不经 `registry.onFrame`**：registry 在内部消化并以 bus 事件 `{type:"cmd_late"}` 广播（`registry.ts` "cmd_late" case）——夹具在 bus 上捕获（fabric 夹具的 onFrame 包裹实为捕不到 late 的历史误例，本包已按事实修正）。
- **web 命令默认 confirm 面**：第三方命令与 `/new`、`/webhub <非 status>` 在 web 侧分别需要 confirm:true / 一律 deny——与 `command-policy.ts` 现行为一致地钉住（该文件在并行包域内，若其默认面变化，本套件按「策略面」而非「实现细节」断言的只有 deny/confirm 的存在性）。
- **conformance 夹具**：`withGatedSession`（本文件）= agent-session-harness + 逐 turn gate + 全量 provider context 记录；`withRuntimeSession`（本文件）= web-resume C1 的 createAgentSessionRuntime 形态（该文件的 harness 不是可导入 helper，按署名复制）。

## 自验（真实输出尾部）

新测试各连续 2 次：

`npx vitest run tests/integration/web-hub-cmd-history.test.ts --maxWorkers=1`（两次）：

```
 ✓ tests/integration/web-hub-cmd-history.test.ts (4 tests) 21094ms / 20868ms
   Test Files  1 passed (1)    Tests  4 passed (4)
   Duration  21.44s / 21.22s
```

（单用例耗时：web 全矩阵 9.1s、TUI+off 5.5s、LOCKED 3.1s、ENOENT 3.2s）

`npx vitest run tests/conformance/cmd-history.test.ts --maxWorkers=1`（两次）：

```
 ✓ tests/conformance/cmd-history.test.ts (7 tests) 631ms / 654ms
   Test Files  1 passed (1)    Tests  7 passed (7)
   Duration  1.64s / 1.64s
```

**新测试单文件耗时：集成 21s / conformance 1.6s。**

`npm run typecheck`：**本包两个 tsconfig 项目对 I1 文件零错误**；整仓当前仅 1 处错误——`src/schedule/core/paths.ts(122,8)`（并行定时任务包的**未跟踪在途新文件**，`git status` 佐证，不在 I1 文件域、按指示未触碰）。`npx tsc --noEmit -p tsconfig.json | grep -v "src/schedule"` ⇒ 零输出；`tsconfig.typecheck.json` 同（仅同一条 schedule 错误）；`vue-tsc`（UI 工程）零错误零输出。

`npx prettier --check`（AGENTS.md、acceptance.md、两个新测试文件）：

```
Checking formatting...
All matched files use Prettier code style!
```

回归（冻结面相关）：off golden 三件套 + channel-compat `8 passed`（fixture 零改动）；`tests/web-hub/agent`（A1 面）`91 files / 1621 passed`；两新文件合跑 `11 passed`。

## 遗留 / 说明

1. **实现缺陷：零**——集成/conformance 全绿，未发现需要主会话派修复的 src 缺陷。开发中夹具自身修过 3 处（TS 非空断言进 eval 子进程、`events.on` 退订形态、cmd_late 捕获通道），均为测试侧。
2. **hub 侧 /new 无 live append 是设计行为**（切换重置 tail 基线，浏览器走 re-snapshot）——已在用例内注释与报告说明；真机 D5 步骤以「旧会话末尾卡」验收。
3. **A1 遗留项 1（`/webhub status` 的 cmd-history 行接线）已由 A1 打回修复完成**（`src/commands/webhub.ts` 消费点 + `tests/commands/webhub-cmd-history.test.ts`），本包集成用例 1/3 直接消费该行作计数取证——闭环确认。
4. 真机验收（acceptance.md 全部 A–J 组）需人工执行，未跑（本机无可挂载的带凭据 live 环境）；其中 G7、日志卫生、隐私锁、双设备四组是自动化无法替代的最低要求。
5. 并行包在途改动（`src/schedule/**`、`src/web-hub/ui/src/logic/state.js` 等）与本包无交集；本报告自验时点的 typecheck 唯一错误属彼（见上）。
