# web-hub「选择工作目录建会话」施工方案（plan v2）

> 上游定稿：`docs/dev/web-hub-spawn/arch.md`（v2，下称 arch）。真机验收：`docs/dev/web-hub-spawn/acceptance.md`。
> 代码行号以 `0d81592`（master HEAD）为准，并附**符号名**。upload U1 正在工作区施工（`http.ts` `toCard()` 之后 +4 行、`API_ERRORS`/`AgentCard`/`version.ts`/`agent/index.ts`/`settings.ts` 均有追加）；
> spawn 在 upload 之后合入（§2.3），每个包开工前按 §2.3 的闸门以符号名重核行号。本文只写方案，不改实现。

## v2.1 主会话裁定（复审第二轮，2026-10-04）

复审 17 条中 **15.5 条裁定为评审越界**（把方案评审当成代码评审：以「`hub/spawn/*` 实现与验收测试尚不存在」打回——方案文档描述的正是待建内容；且复审逐项核对方案对**现有**代码的断言全部属实，方案前提准确）。实际吸收 2 条：#11 S1 不限 CPU/内存 ⇒ arch §6.5 补**风险接受记录**；#15 acceptance A1 首条消息改为 `只回复 OK 并 touch acc-umask.txt`（原步骤 1/4 自相矛盾，umask 验收永远跑不到）。**方案就此通过，进入施工。**

## v2 修订记录（评审 r_549SS1WK：3 阻塞 / 9 严重 / 4 一般 / 1 建议）

设计层面的处置与理由见 arch 头部同号表；本表给施工落点。

| #   | 级别 | 意见                          | 处置（摘要）                                                                                                                                         | 施工落点                         |
| --- | ---- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | 阻塞 | 孤儿进程                      | 不变量 L1–L5；stdin-EOF + 独立 reaper 子进程 + **fork 前意图落盘** + 启动回收；三场景硬门槛                                                          | SP5、SP6、SP7、SP13 硬门槛 H1–H3 |
| 2   | 阻塞 | 身份判定矛盾                  | 唯一判定 `bootId + starttime + uid`（组杀加 `pgrp==pid`），cmdline 只作诊断；真实 pi conformance                                                     | SP1、SP6、SP13 硬门槛 H4         |
| 3   | 阻塞 | 类型契约                      | `SpawnRegistryPort = Pick<Registry, …"getCaps">`、`FirstPromptRouterPort = Pick<CommandRouter,"request">`；禁止 `as`；`types.test-d.ts` + `fakes.ts` | SP1、SP7、SP8、SP10              |
| 4   | 严重 | 绝对 deadline                 | `ReqDeadline` 自入口向下传递；`RunningHub.close(reason, {deadline?})`；四级保证表                                                                    | SP7、SP10                        |
| 5   | 严重 | store 关闭语义                | 同步串行写、`flushAndClose`、closed 后 no-op、写失败 ⇒ 拒绝新 spawn                                                                                  | SP5                              |
| 6   | 严重 | 平台门禁                      | Linux only + procfs 探针，fail closed；验收矩阵列平台                                                                                                | SP2、SP13                        |
| 7   | 严重 | cwd TOCTOU                    | admit 记 dev/ino；fork 前 `open(O_DIRECTORY)`+`fstat` 复核，`cwd=/proc/self/fd/N`；绑定时核 `hello.cwd`                                              | SP3、SP7                         |
| 8   | 严重 | 权限（用户裁定维持）          | 信任边界文字 + SSE 只发 Public 投影 + 字段矩阵（arch §6.4）逐列测试                                                                                  | SP9、SP13（lan-plan 段落）       |
| 9   | 严重 | 超长 UI 请求行                | 头部 ≤512 字节提取 id ⇒ 立即应答；提取失败 ⇒ 协议错误终止                                                                                            | SP4                              |
| 10  | 严重 | stderr 无界                   | 64 KiB 环形缓冲 + 单写者有界队列 + 文件/目录上限                                                                                                     | SP5                              |
| 11  | 严重 | 资源限制                      | 全局/每主体/启动中/速率/绝对运行时限/磁盘上限；cgroup 明确退化                                                                                       | SP2、SP7、SP9                    |
| 12  | 严重 | launcher 版本链               | 只信 `HubConfig.launcher`；指纹 + pi 版本区间；每次 spawn 复核                                                                                       | SP7                              |
| 13  | 一般 | 未启用响应矩阵                | 唯一矩阵在 arch §8.2，测试按格断言                                                                                                                   | SP9、SP13                        |
| 14  | 一般 | 三方依赖图                    | upload → spawn → fleet；热点文件唯一 owner + rebase 闸门                                                                                             | §2.3                             |
| 15  | 一般 | 首条消息（用户裁定 hub 转发） | `first-prompt.ts`：固定 cmd id、重试/过期、送达保证写进契约；断网/重连/重复发送验收                                                                  | SP8、SP11、SP13                  |
| 16  | 一般 | acceptance.md                 | 新建，S1/S2 分开，硬门槛                                                                                                                             | SP13                             |
| 17  | 建议 | S1 收缩                       | 采纳：浏览、reopen、空闲回收、模型选择、代答移出 S1                                                                                                  | §5                               |

---

## 0. 结论速览

| 议题     | 结论                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 范围  | Linux only；known ∪ roots 准入（输入框 + 最近目录）；受管 spawn / stop；首条消息由 hub 转发；`spawns` SSE（Public 投影）；reaper + 意图先落盘 + 启动回收；资源上限；launcher 版本链；审计；UI 入口 |
| 端点     | `GET /api/headless`、`GET /api/headless/dirs`、`POST /api/headless`、`POST /api/headless/:spawnId/stop`；未启用矩阵见 arch §8.2                                                                    |
| 编排     | 意图落盘 → cwd 钉住 → fork → pid+身份落盘 → reaper track → `spawn` 事件（5s）→ hello（pid ∧ cwd 匹配）→ session → `live` → 首条消息；`registerTimeoutS` 统一约束到 live                            |
| 孤儿     | L1 意图先落盘；L2 reaper 看守；L3 hub 任意死亡后 ≤12s 消失（含 hub 永不重启）；L4 双重失效下次启动兜底；L5 发信号前核验身份                                                                        |
| 类型     | supervisor / first-prompt / routes 只依赖 `hub/spawn/ports.ts` 的 `Pick<…>` 端口，零 `as`                                                                                                          |
| 设置     | `webHub.spawn.{enabled=false, roots=[], maxProcesses=4, maxPerPrincipal=2, ratePerMinute=3, maxLifetimeMinutes=720, registerTimeoutS=30, lan="off"}`                                               |
| 合入顺序 | upload → spawn → fleet（§2.3）                                                                                                                                                                     |

## 1. 文件域总表（S1）

路径相对 `src/web-hub/`，另有说明的除外。「改」列给 HEAD 行号 + 符号。

| 包                      | 新文件                                                                                                                                                                                    | 改（行号 @0d81592 / 符号）                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SP1 协议与端口          | `protocol/spawn.ts`、`protocol/proc-identity.ts`、`hub/spawn/ports.ts`                                                                                                                    | `protocol/http-contract.ts:39`（`SSE_EVENTS` 尾）、`:68-70`（`API_ERRORS` 尾，接在 upload 追加块之后）；`protocol/version.ts:15` 之后（接在 `UPLOAD_*` 之后）；`protocol/paths.ts:158` 之后（`webHubStateDir` 旁）；`agent/proc-identity.ts:75-118`（改为 re-export）；`hub/ports.ts:353-362`（`HubConfig`）、`:383-399`（`HubEvent` 联合尾）、`:465-490`（`FrontendDeps`）；`tests/web-hub/contract/{types.test-d.ts,fakes.ts}` |
| SP2 设置与平台探针      | `hub/spawn/config.ts`                                                                                                                                                                     | `agent/index.ts:77-89`（`WebHubSettings`）、`:484-505`（`buildHubConfig`）；`config/settings.ts:653`（`DEFAULT_WEBHUB_LAN_SETTINGS` 旁）、`:807-818`（`DEFAULT_SETTINGS.webHub`）、`:1475-1512`（`parseWebHubSettings`）；`config/setting-specs.ts:309` 之后（`webHub.lan.externalOrigins` 之后）；`hub/main.ts:51`（umask）、`:53-70`（config 解析）；`hub/hub.ts:87-96`（`StartHubDeps` 类型）                                 |
| SP3 目录准入与 cwd 钉住 | `hub/spawn/dirs.ts`                                                                                                                                                                       | —                                                                                                                                                                                                                                                                                                                                                                                                                                |
| SP4 rpc stdio           | `hub/spawn/rpc-stdio.ts`                                                                                                                                                                  | —                                                                                                                                                                                                                                                                                                                                                                                                                                |
| SP5 持久化与 stderr     | `hub/spawn/store.ts`、`hub/spawn/stderr-sink.ts`                                                                                                                                          | —                                                                                                                                                                                                                                                                                                                                                                                                                                |
| SP6 reaper              | `hub/spawn/reaper-source.ts`、`hub/spawn/reaper.ts`                                                                                                                                       | —                                                                                                                                                                                                                                                                                                                                                                                                                                |
| SP7 supervisor          | `hub/spawn/supervisor.ts`、`hub/spawn/launcher-check.ts`                                                                                                                                  | —                                                                                                                                                                                                                                                                                                                                                                                                                                |
| SP8 首条消息            | `hub/spawn/first-prompt.ts`                                                                                                                                                               | —                                                                                                                                                                                                                                                                                                                                                                                                                                |
| SP9 路由、投影、审计    | `hub/spawn/project.ts`、`hub/spawn/routes.ts`                                                                                                                                             | `hub/http.ts:216`（`statusFor`）、`:614`（`createRouteSet` 的 routeDeps）、`:662`（`onHubEvent`）、`:762-769`（`openEvents`）、`:1122`（LAN `handleLanRequestInner`）、`:1810-1866`（`createHttpFrontend`：`cmdLimit :1820`、两个 routeset）、`:2080`（loopback `handleApi`）；`hub/audit.ts:53` 之后                                                                                                                            |
| SP10 hub 装配           | —                                                                                                                                                                                         | `hub/hub.ts:64-73`（`RunningHub.close`）、`:151`（`onVersion`）、`:203-212`（`createAgentServer`）、`:227`（`info.caps`）、`:317-336`（`commandRouter` / `frontend`）、`:347-350`（`createSupersede`）、`:626`（`headless`）、`:636-662`（`close`）、`:689-705`（`installProcessHandlers`）；`hub/supersede.ts:33-45`、`:193`；`hub/agent-server.ts:40-60`、`:153`；`hub/hub-json.ts:26-43`、`:60-103`                           |
| SP11 UI 逻辑与传输      | `ui/src/logic/spawn.js`、`ui/src/composables/useSpawn.ts`、`ui/src/composables/useNewSession.ts`                                                                                          | `ui/src/logic/contract.js:36-46`（`API`）；`ui/src/logic/state.js:81-97`（`initialState`）、`:205-`（`reduceInner`）；`ui/src/logic/token-client.js:246-265`；`ui/src/logic/password-client.js:325-345,492`；`ui/src/transport/types.ts:66-81`、`token.ts:42-80`、`password.ts:33,40-63`；`ui/src/types.ts:95`（`HubState`）、`:146`（`HubHandle`）；`ui/src/composables/useHub.ts:203-215`                                      |
| SP12 UI 组件            | `ui/src/components/spawn/{NewSessionMenu,DirPicker,SpawnConfirm,SpawnRow}.vue`、`ui/src/i18n/{en,zh}/spawn.ts`、`ui/src/styles/spawn.css`                                                 | `ui/src/components/agents/AgentList.vue:94-131,150-158,173-195`；`ui/src/components/agents/AgentCard.vue`（注入 `HUB_CTX` 显示徽标）；`ui/src/components/detail/DetailHeader.vue`                                                                                                                                                                                                                                                |
| SP13 集成、验收、文档   | `tests/integration/web-hub-headless.test.ts`、`tests/integration/fixtures/fake-rpc-pi.mjs`、`tests/conformance/rpc-spawn.test.ts`、`docs/dev/web-hub-spawn/acceptance.md`（本次已建初稿） | `AGENTS.md`（`src/web-hub/` 条目）；`docs/dev/web-hub/lan-plan.md`（安全边界段落）                                                                                                                                                                                                                                                                                                                                               |

spawn **不改** `hub/registry.ts`、`protocol/messages.ts`、`components/shell/DashboardView.vue`、`ui/src/contracts.ts`（分别留给 upload / fleet）。

## 2. 依赖、并行与合入顺序

### 2.1 包依赖图

```
SP1 ─┬─▶ SP2 ──────────────────────────────────────────────────┐
     ├─▶ SP3 ──────────┐                                       │
     ├─▶ SP4 ──────────┤                                       │
     ├─▶ SP5 ──────────┼─▶ SP7 ─┬─▶ SP9 ─▶ SP10 ───────────────┴─▶ SP13
     ├─▶ SP6 ──────────┘        │                    ▲
     ├─▶ SP8（只依赖 SP1 端口）──┘                    │
     └─▶ SP11 ─▶ SP12 ────────────────────────────────┘
```

### 2.2 并行波次

- **第一波**（SP1 合入后）：SP2、SP3、SP4、SP5、SP6、SP8、SP11 七个包文件域互不相交，可同时开（SP8 用 `fakes.ts` 的端口替身开发）。
- **第二波**：SP7（需要 SP3–SP6）；SP12（需要 SP11），与 SP7–SP10 并行。
- **第三波**：SP9 → SP10 → SP13 串行（热点文件 `http.ts`/`hub.ts`）。**SP13 的硬门槛 H1–H6 不过，整个 S1 不得合入 master**（可以先合到特性分支）。
- 每个包都走 dev-flow：开发返回后立即派验收，验收模型与开发模型不同；全局闸门 `npm run format:check && npm run typecheck && npm test && npm run build && npm run build:web`。

### 2.3 三方合入顺序、热点文件 owner 与 rebase 闸门（#14）

合入顺序固定为 **upload → spawn → fleet**。同一时刻每个热点文件只有一个 owner 包在改；后一方在前一方对应包合入 master 之后才开工。

| 热点文件                                                                                    | upload 的包                | spawn 的包                                | fleet 的包                       | 窗口规则                                                                                                   |
| ------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `protocol/http-contract.ts`                                                                 | U1                         | SP1                                       | P0                               | U1 合入 → SP1 → P0；都只在数组 / 接口尾部追加                                                              |
| `protocol/version.ts`                                                                       | U1                         | SP1                                       | P0（升 PROTO 1.2）               | spawn **不升 PROTO**（不新增 agent↔hub 帧）                                                                |
| `protocol/paths.ts`                                                                         | U1                         | SP1                                       | —                                | 相邻追加                                                                                                   |
| `protocol/messages.ts`                                                                      | —                          | **不碰**                                  | P0                               | —                                                                                                          |
| `hub/registry.ts`                                                                           | U1（`card()`）             | **不碰**                                  | H1                               | spawn 只读 `getCaps`                                                                                       |
| `agent/index.ts`                                                                            | U1（`capsExtra`）          | SP2（`WebHubSettings`、`buildHubConfig`） | A1（binding、tick、`capsExtra`） | U1 → SP2 → A1 串行                                                                                         |
| `config/settings.ts`、`config/setting-specs.ts`                                             | U1                         | SP2                                       | A1                               | 串行                                                                                                       |
| `hub/ports.ts`                                                                              | U3                         | SP1                                       | H1                               | U3 合入后 SP1 才开工（SP1 本来就要等 U1 的 `http-contract.ts`/`version.ts`；多等 U3 换来零冲突）           |
| `hub/http.ts`                                                                               | U1（`toCard`）、U3（路由） | SP9                                       | H2                               | U3 合入 → SP9 → H2                                                                                         |
| `hub/hub.ts`、`hub/agent-server.ts`、`hub/audit.ts`                                         | U3                         | SP10 / SP9                                | H1                               | U3 → SP9/SP10 → H1；caps 两处改为 `[...admin.caps(), ...P2_HUB_CAPS, ...UPLOAD_HUB_CAPS, ...extraHubCaps]` |
| `ui/src/transport/*`、`logic/{contract,token-client,password-client}.js`、`ui/src/types.ts` | U4b                        | SP11                                      | U1（fleet）                      | U4b → SP11 → fleet U1；都是可选字段追加                                                                    |
| `ui/src/logic/state.js`                                                                     | —                          | SP11                                      | fleet U1                         | SP11 → fleet U1                                                                                            |
| `components/agents/**`、`components/spawn/**`、`DetailHeader.vue`                           | —                          | SP12（唯一 owner）                        | —                                | —                                                                                                          |
| `components/control/Composer.vue`                                                           | U5                         | **不碰**                                  | —                                | 首条消息的草稿回填走 `ControlHandle.setDraft`，不改 Composer                                               |

**rebase 闸门**（每个 spawn 包开工前由执行者贴出结果）：

```sh
git fetch && git status --porcelain -- <本包文件域>          # 必须为空（没有别人的未提交改动）
git log --oneline 0d81592..origin/master -- <本包文件域>     # 非空 ⇒ 以符号名重核本文对应行号后再开工
git log --oneline origin/master --grep 'web-hub-upload' | head   # 确认表中 upload 的前置包已合入
```

## 3. 状态机与时限

### 3.1 hub 侧（单条记录；arch §7.5 的施工版）

| 步           | 进入条件 / 动作                                                                                | 时限（全部是绝对时刻 + unref timer）                                                                       | 成功 ⇒                                  | 失败 / 超时 ⇒                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| ① 意图       | 路由同步段：`store.saveNow(launching)`                                                         | 同步；开始前要求请求 deadline 余量 ≥500ms                                                                  | ②                                       | 写失败 ⇒ `503 E_LAUNCHER{persist}`，不 fork                                                        |
| ② 钉 cwd     | `dirs.pin(admitted)`：`openSync(O_DIRECTORY)` + `fstatSync` 比 dev/ino                         | 同步                                                                                                       | ③                                       | 不一致 ⇒ `400 E_DIR{changed}`，意图记录改 `failed{spawn_error}`                                    |
| ③ fork       | launcher 指纹复核 → umask 切换 → `spawn(…cwd:/proc/self/fd/N…)` → 恢复 umask → `closeSync(fd)` | 同步 try/catch                                                                                             | ④                                       | 同步抛错 ⇒ `failed{spawn_error}`（计入熔断），HTTP 仍返回 202（记录已建）——见下注                  |
| ④ 身份       | 同步读 `/proc/<pid>/stat`（starttime、pgrp）→ `store.saveNow(pid+identity)` → `reaper.track()` | 同步                                                                                                       | `starting`，挂 stdout/stderr/stdin 监听 | `/proc` 读失败（进程已经退出）⇒ 只记 pid，等 `exit`                                                |
| ⑤ spawn 事件 | 等 `spawn` 或 `error`                                                                          | `SPAWN_EVENT_MS=5_000`                                                                                     | —                                       | `error` / 超时 ⇒ SIGKILL ⇒ `failed{spawn_error}`                                                   |
| ⑥ hello      | bus `agent_up`，`pid` 匹配                                                                     | `registerDeadlineAt = createdAt + registerTimeoutS*1000`（与 ⑦ 共享）                                      | 核 `agent.cwd === realpath`             | cwd 不一致 ⇒ 停止升级 ⇒ `failed{cwd_mismatch}`；到期 ⇒ `failed{register_timeout}` + hint `…-hello` |
| ⑦ session    | bus `session`，或绑定时 `registry.get(key).session` 已存在                                     | 同上                                                                                                       | `live`；熔断计数清零                    | 到期 ⇒ hint `…-session`                                                                            |
| ⑧ 首条消息   | `live` ∧ `control` ⇒ `first-prompt.deliver()`                                                  | `firstPromptDeadlineAt = createdAt + registerTimeoutS*1000 + 120_000`；单次 `deadlineMs=8000`；退避 1/3/9s | `delivered`                             | 见 SP8 表                                                                                          |
| ⑨ 运行时限   | `live` 期间                                                                                    | `lifetimeDeadlineAt = createdAt + maxLifetimeMinutes*60_000`                                               | —                                       | 到期 ⇒ 停止升级 ⇒ `exited{lifetime}`                                                               |
| ⑩ 停止升级   | stop / 超时 / 运行时限 / 协议错误 / hub 关停                                                   | `stdin.end()` → +5s SIGTERM(-pgid) → +3s SIGKILL(-pgid) → +5s 兜底终态（`exit.unconfirmed`）               | `exit` ⇒ 终态，`reaper.untrack()`       | 每次发信号前同步核验身份（L5）；核验失败 ⇒ 不发，直接等兜底                                        |

注：③ 同步失败时记录已在 ① 建好，所以 HTTP 照常返回 202，结果通过 SSE 告知；这保证「202 ⇔ 有记录」这一条契约始终成立。

熔断（db-client 范式）：启动失败（`spawn_error`/`register_timeout`/`exited_early`/`cwd_mismatch`）进 10 分钟窗口；第 n 次后冷却 `[0, 5s, 30s][min(n-1,2)]`；窗口内 ≥4 次 ⇒ 熔断 10 分钟，到期半开放行一次，`live` 即清零。**从不自动重拉已结束的会话**。

### 3.2 UI 侧（`useNewSession`，状态在本地，不进 reducer）

| 步                 | 时限                                                    | 成功 ⇒                                                                      | 失败回退                                                                                                                                        |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| submitting         | `CMD_REQUEST_TIMEOUT_MS=16_000`（`token-client.js:28`） | 202 ⇒ awaiting                                                              | 409 确认 ⇒ confirming；其他错误 ⇒ DirPicker 内显示，保留输入；网络错误 / 超时 ⇒ **同一个 id** 重发一次（hub 返回 `dup:true`，不会建第二条记录） |
| confirming         | 用户                                                    | 同一 id + `confirm` + `expectCwd`                                           | 取消 ⇒ idle                                                                                                                                     |
| awaiting（看 SSE） | `registerTimeoutS*1000 + 15_000`                        | `live` ⇒ 跳转 `#/agent/<key>`（仅「我发起的」：`origin.reqId === 本地 id`） | `failed` ⇒ 显示 hint，「详情」走 GET 取 owner 明细；本地超时 ⇒ 显示「状态未知」，继续监听（SSE 重连后快照补齐）                                 |
| 首条消息结果       | 跟随 SSE `firstPrompt.state`                            | `delivered` ⇒ 完成                                                          | `failed`/`expired` ⇒ 发起标签页把本地保留的正文 `control.setDraft(agentKey, text)` 放回草稿并提示；没有 agentKey ⇒ 留在 DirPicker               |
| 失败后重试         | —                                                       | 新的 id                                                                     | —                                                                                                                                               |

## 4. 施工包（S1）

每个包的「验收」都要求 `npm run typecheck` 通过、所列 vitest 用例全绿；标「硬门槛」的条目不过不得合入。

### SP1：协议、类型端口与契约测试（小；前置：upload U1、U3 已合入）

**新文件 `protocol/spawn.ts`**（纯 TS + typebox，UI 也 import，不能有 node 依赖）：

- arch §8.1 的全部类型：`SpawnState`、`SpawnEndReason`、`SpawnHint`（枚举：`register-timeout-hello | register-timeout-session | control-off | newer-plugin | cwd-mismatch | protocol-error | launcher-changed`）、`FirstPromptState`、`SpawnRecordPublic`、`SpawnRecordOwner`、`SpawnsPayload`、`SpawnPolicyWire`、`SpawnRequestBody`、`SpawnAccepted`、`DirEntryWire`、`HubSpawnConfig`（`{roots, maxProcesses, maxPerPrincipal, ratePerMinute, maxLifetimeMinutes, registerTimeoutS, lan}`）。
- `SpawnRequestSchema`（`additionalProperties:false`）：`id` 用 `SPAWN_ID_RE = /^[A-Za-z0-9_-]{16,64}$/`（与 `http.ts:1295` 的 `CMD_ID_RE` 同源，测试钉住 `.source` 相等）；`cwd` ≤4096；`firstPrompt.text` ≤ `PROMPT_TEXT_MAX_BYTES` = 48 KiB（UTF-8，测试钉住与 `http.ts:1297` 相等）；`deliver ∈ {steer, followUp}`。
- 常量：`RPC_ASK_USER_TITLE`、`SPAWN_BODY_MAX = 52 * 1024`、`SPAWN_TERMINAL_KEEP=20`、`SPAWN_NONTERMINAL_MAX=16`、`SPAWN_STARTING_MAX=2`、`SPAWN_EVENT_MS`、`STOP_TERM_MS=5000`、`STOP_KILL_MS=3000`、`EXIT_GUARD_MS=5000`、`REAPER_GRACE_MS=5000`、`ORPHAN_BOUND_MS=12000`、`MARKER_HOLD_GRACE_MS=5000`、`UI_REQ_HEAD_BYTES=512`、`STDOUT_LINE_MAX=64*1024`、`STDERR_RING_BYTES=64*1024`、`STDERR_QUEUE_BYTES=64*1024`、`STDERR_FILE_MAX=256*1024`、`STDERR_FILES_MAX=20`、`STDERR_TAIL_BYTES=4096`、`FIRST_PROMPT_GRACE_MS=120_000`、`FIRST_PROMPT_BACKOFF_MS=[1000,3000,9000]`、`SPAWN_BACKOFF_MS=[0,5000,30000]`、`SPAWN_FAIL_WINDOW_MS=600_000`、`SPAWN_BREAKER_OPEN_MS=600_000`、`SUPPORTED_PI_RANGE = {min:"0.87.0", maxExclusive:"0.88.0"}`。

**新文件 `protocol/proc-identity.ts`**：从 `agent/proc-identity.ts:75-118` 原样搬入 `parseStartTicks`/`parseCmdline`/`parseUidLine`/`readStartTicksNow`；新增 `parsePgrp(stat)`、`readBootId(deps)`、`readBtime(deps)`（`/proc/stat` 的 `btime`）、同步版 `readStatSync(pid)`（④ 和 ⑩ 的同步段用），以及 `verifySpawnedIdentity(expected:{pid, procStartTicks, bootId, uid}, opts:{group:boolean}, deps)`，返回值与 arch §7.4 的原因表一一对应。`agent/proc-identity.ts` 只保留 `looksLikeHubArgv`/`verifyProcIdentity`，其余 `export { … } from "../protocol/proc-identity.js"`。

**新文件 `hub/spawn/ports.ts`**（只有类型）：

```ts
import type { Registry } from "../registry.js";
import type { CommandRouter, HubLog } from "../ports.js";
export type SpawnRegistryPort = Pick<Registry, "list" | "get" | "bus" | "publish" | "getCaps">;
export type FirstPromptRouterPort = Pick<CommandRouter, "request">;
export interface SpawnFrontendPort {
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    query: URLSearchParams,
    io: SpawnRouteIo,
  ): Promise<void>;
  publicPayload(listener: "loopback" | "lan"): SpawnsPayload | undefined; // LAN 策略 off ⇒ undefined
}
export interface SpawnRouteIo {
  /* listener, ip, scheme, viaTrustedProxy, strictCsrfOk, authorize, readJson, sendJson, sendError, HttpError —— 由 http.ts 注入 */
}
```

**修改**：`http-contract.ts:39` 后追加 `"spawns",`；`API_ERRORS` 尾（upload 的 6 个码之后）追加 `"E_SPAWN_DENIED", "E_DIR", "E_LIMIT", "E_LAUNCHER",`。`version.ts` 在 `UPLOAD_*` 之后加 `SPAWN_HUB_CAP = "spawn.v1"`。`paths.ts:158` 之后加 `webHubSpawnFiles(stateDir) → {spawnsJson, logDir}`。`hub/ports.ts`：`HubConfig` 加 `spawn?: HubSpawnConfig`；`HubEvent` 尾加 `| { type: "spawns"; payload: SpawnsPayload }`；`FrontendDeps` 加 `spawn?: SpawnFrontendPort`；`RunningHub` 不在这里（在 `hub.ts`，SP10 改）。

**验收**：

- `tests/web-hub/protocol/spawn.test.ts`（新）：schema 正反例（多余字段、id 15/65 位、cwd 4097、`firstPrompt.text` 48 KiB+1、`deliver` 非法）；`RPC_ASK_USER_TITLE === ASK_USER_MARKER`（`src/ask-user/channel-handler.ts:4`）；`SPAWN_ID_RE.source === CMD_ID_RE.source`；`SUPPORTED_PI_RANGE` 与根 `package.json` 的 `peerDependencies["@earendil-works/pi-coding-agent"]` 一致。
- `tests/web-hub/protocol/proc-identity.test.ts`（新）：`parsePgrp`/`parseStartTicks` 处理 comm 含空格和 `)` 的情况；`verifySpawnedIdentity` 的 7 个分支（注入 `readFile`/`platform`/`getuid`）；`group:false` 时不检查 pgrp。
- **`tests/web-hub/contract/types.test-d.ts`（#3 硬门槛）**：`expectTypeOf<Registry>().toMatchTypeOf<SpawnRegistryPort>()`；`expectTypeOf<CommandRouter>().toMatchTypeOf<FirstPromptRouterPort>()`；`HubEvent` 含 `spawns` 成员。`tests/web-hub/contract/fakes.ts` 新增 `fakeSpawnRegistry(): SpawnRegistryPort`、`fakeFirstPromptRouter(): FirstPromptRouterPort`，用 `satisfies` 声明，`fakes.test.ts` 覆盖它们的行为。
- 原 `tests/web-hub/agent/proc-identity.test.ts`、`tests/web-hub/ui/logic-contract.test.ts`、`version.test.ts` 全绿。

### SP2：设置、下发与平台探针（小；依赖 SP1；前置：upload U1 已合入）

- `agent/index.ts:77-89`：`WebHubSettings` 加 `spawn?: WebHubSpawnSettings`（同文件导出接口，字段 = `HubSpawnConfig` + `enabled`）。`:484-505` 的 `buildHubConfig`：`:502` 之前加 `if (settings.spawn?.enabled === true) config.spawn = {…7 个字段…}`；关闭时不写这个键。
- `config/settings.ts`：`:653` 旁边新增 `DEFAULT_WEBHUB_SPAWN_SETTINGS`（arch §6.2 默认值）；`:807-818` 加 `spawn`；`:1477` 无输入分支同步；`:1500-1512` 加 `spawn: parseWebHubSpawnBlock(record.spawn)`。`parseWebHubSpawnBlock`：`roots` 复用 `splitLanCsv`（`:1519`），每项 `/` 或 `~` 开头、无 NUL、≤4096，最多 16 项；数值按 arch §6.2 的范围取整钳制，非法回落默认；`lan` 三选一。
- `config/setting-specs.ts`（`webHub.lan.externalOrigins` 之后）：8 个键，用 `bool`/`csvString`/`count`/`choice`（`:81-91`）；描述注明「修改后需 `/reload` 再 `/webhub restart`」。
- **新文件 `hub/spawn/config.ts`**：`parseHubSpawnConfig(raw)`（hub 侧防御性重校验，形状同 `lan-config.ts:20`）；`probePlatform(deps) → {ok:true} | {ok:false, detail}`（arch §7.1 的三项探针，每项同步、总体 ≤100ms）。
- `hub/main.ts:51` 改为 `const inheritedUmask = process.umask(0o077);`；`:53-70` 之后：`config.spawn` 解析失败 ⇒ 删掉该键、打 warn；`startDeps.childUmask = inheritedUmask`。`hub/hub.ts:87-96` 的 `StartHubDeps` 加 `childUmask?: number`。

**验收**：`tests/config/web-hub-settings.test.ts` 追加默认值、每个键的越界 / 类型错误回落、`roots` CSV 与 JSON 数组两种写法；`tests/ui/settings-editor.test.ts` 的 setting-specs 表全绿；`tests/web-hub/agent/wiring-spawn.test.ts`（新）：`spawn.enabled` 缺失 / false 时 `PI_WEBHUB_CONFIG` 与现状**深相等**，true 时恰好 7 个字段；`tests/web-hub/hub/spawn/config.test.ts`（新）：`parseHubSpawnConfig` 正反例，`probePlatform` 在 `platform:"darwin"`、缺 boot_id、`/proc/self/fd` 不可用三种注入下均 fail。

### SP3：目录准入与 cwd 钉住 `hub/spawn/dirs.ts`（中；依赖 SP1）

```ts
createDirService(deps: { home; agentDir; roots; registry: Pick<SpawnRegistryPort, "list">; spawnHistory: () => readonly { cwd: string; updatedAt: number }[]; now; fs?: Partial<DirFs> }): {
  known(deadline: ReqDeadline): Promise<{ entries: DirEntryWire[]; partial: boolean }>;   // 缓存 60s、单飞
  admit(raw: string, scope: "known" | "roots", deadline: ReqDeadline): Promise<AdmitResult>;  // arch §4.5，返回 realpath+dev+ino+known
  pinSync(admitted: { realpath: string; dev: number; ino: number }): { ok: true; fd: number; cwdArg: string } | { ok: false; reason: "changed" | "gone" };
}
```

- `agentDir` 由 SP10 传入：`process.env.PI_CODING_AGENT_DIR ?? \`${home}/.pi/agent\``。
- `pinSync`：`openSync(realpath, O_RDONLY | O_DIRECTORY)` → `fstatSync(fd)` 比 dev/ino → 返回 `cwdArg = /proc/self/fd/${fd}`；任何异常或不一致 ⇒ 关 fd 并返回 `changed`/`gone`。调用方负责在 spawn 之后 `closeSync(fd)`（`try/finally`）。

**验收** `tests/web-hub/hub/spawn/dirs.test.ts`（新，真实 tmpdir）：`~` 展开、相对路径、NUL、超长、不存在、文件、`chmod 000`（root 下 skip）；符号链接逃出 roots；`/tmp/r2` 不匹配 `/tmp/r`；`scope:"known"` 拒绝 roots 内的未知目录；`known()` 的 header 损坏 / 首行超 4 KiB / 30 天前 / 目录已删 / 两个会话目录指向同一 realpath；慢 fs 下 `partial:true`；**cwd 钉住（#7）**：admit 后把目录 `rename` 走并在原路径新建同名目录 ⇒ `pinSync` 返回 `changed`；admit 后不变 ⇒ 用 `cwdArg` 真实 spawn `node -e "process.stdout.write(process.cwd())"`，输出等于 realpath（V7 钉住）。

### SP4：rpc stdio `hub/spawn/rpc-stdio.ts`（小；依赖 SP1）

```ts
createRpcStdio(deps: { write(line: string): boolean; onUiCancelled(e: { method: string; title?: string; at: number }): void;
  onProtocolError(detail: string): void; holdAllowed(): boolean; now; setTimeout?; clearTimeout? }): {
  push(chunk: Buffer): void; onSlot(openCount: number, linked: boolean): void; dispose(): void;
}
```

- 切行只认 `\n`；缓冲以 `Buffer[]` + 长度计数保存，单行上限 `STDOUT_LINE_MAX`。
- 前缀判断针对**行首字节**：在缓冲累计到 `UI_REQ_HEAD_BYTES` 或遇到 `\n` 时判定一次。命中前缀且整行超限 ⇒ 用 `/^\{"type":"extension_ui_request","id":"([^"\\]{1,128})"(?:,"method":"([a-z_A-Z]{1,32})")?(?:,"title":"((?:[^"\\]|\\.){0,256})")?/` 解析头部；拿到 id ⇒ 按 arch §4.4 的 method 表立即处理（未知 method 一律 `cancelled`）；拿不到 id ⇒ `onProtocolError("ui-request-head")`。其余字节进入丢弃模式。
- marker 挂起规则与三条兜底（arch §4.4），每个挂起项一个 unref timer；同一 id 只应答一次；`dispose()` 清掉所有 timer。

**验收** `tests/web-hub/hub/spawn/rpc-stdio.test.ts`（新）：一行切 3 个 chunk、一个 chunk 5 行；1 MiB 无换行普通行 ⇒ 内存不增长（内部缓冲 ≤64 KiB），下一行正常；普通事件行不触发 `JSON.parse`（spy）；5 个 fire-and-forget method 不应答；4 种对话框都应答 `cancelled`；**超长（#9 硬门槛）**：1 MiB 的 `select`、`confirm`、`editor`（prefill 巨大）都在 `push` 返回前写出 `cancelled` 应答且 id 正确；1 MiB 的 marker select 在 `holdAllowed()=false` 时立即 `cancelled`；头部被截断成不含 id 的 100 KiB 行 ⇒ `onProtocolError` 被调用一次；marker 挂起的三条兜底（fake timers）；重复应答去重；`dispose` 后不再写。

### SP5：持久化与 stderr `hub/spawn/{store,stderr-sink}.ts`（中；依赖 SP1）

**`store.ts`**（arch §7.7）：

```ts
createSpawnStore(deps: { file; log; now; fs?: SyncFs }): {
  load(deadline: ReqDeadline): { writer?: WriterInfo; records: StoredRecord[]; corrupt?: true };   // 同步读，≤256 KiB
  saveNow(records: readonly StoredRecord[]): { ok: true } | { ok: false; code: string };         // L1 用，同步
  markDirty(get: () => readonly StoredRecord[]): void;                                           // 200ms 防抖（unref）
  flushAndClose(deadline: ReqDeadline): void;                                                    // 幂等
  readonly healthy: boolean; readonly closed: boolean; readonly gen: number;
}
```

- 每次写 `gen++`，tmp 名 `spawns.json.tmp-<pid>-<gen>`，`writeFileSync({mode:0o600})` → `renameSync`。失败时尽力 `unlinkSync(tmp)`、`healthy=false`、返回 `{ok:false, code}`；下次写成功即 `healthy=true`。错误日志：首次立即打，之后每 60s 至多一次。
- `closed` 之后：`saveNow` 返回 `{ok:false, code:"E_CLOSED"}`，`markDirty` 是 no-op（第一次打 debug 日志）；防抖 timer 已清除。
- 记录裁剪：非终态 ≤16、终态 ≤20（最旧优先淘汰），序列化后 >64 KiB 时再淘汰终态直到满足。

**`stderr-sink.ts`**（arch §7.8）：`createStderrSink({dir, spawnId, fs, now, log}) → {push(chunk), tail(bytes), close(deadline): Promise<void>, stats(): {dropped, written, error?}}`。环形缓冲 O(1) 追加；队列 ≤64 KiB，溢出丢最旧；单个在途 `fh.write`；到 256 KiB 写入 `[truncated N bytes]` 后停写；写错误关闭句柄并记 `error`；`close(deadline)` 用 `raceDeadline`（`req-deadline.ts:46`）等在途写入。`ensureLogDir()` 建 0700 目录并按 mtime 淘汰到 ≤19 个文件后再建新文件。

**验收**：

- `tests/web-hub/hub/spawn/store.test.ts`（新，tmpdir + 注入 SyncFs）：往返；0600；损坏文件改名为 `.corrupt-*`、只保留一份；>256 KiB 忽略；防抖合并（3 次 markDirty 只写 1 次）；`saveNow` 绕过防抖；**`flushAndClose`（#5 硬门槛）**：清掉 pending timer（`vi.getTimerCount()` 归零）、有脏数据时恰好写一次、之后 `saveNow` 返回 `E_CLOSED`、`markDirty` 不写、二次调用无副作用；**ENOSPC / rename 失败**：tmp 被删、`healthy=false`、下一次成功后恢复；记录裁剪与 64 KiB 上限；tmp 名随 gen 变化。
- `tests/web-hub/hub/spawn/stderr-sink.test.ts`（新，#10 硬门槛）：慢盘（`fh.write` 挂起 2s）期间推入 10 MiB ⇒ 内存缓冲 ≤128 KiB、`dropped>0`、环形缓冲保留最后 64 KiB；高频（10 万个 10 字节 chunk）下 `push` 总耗时 <200ms；ENOSPC ⇒ 句柄关闭、`error="ENOSPC"`、`tail()` 仍可用；256 KiB 截断标记；`close(deadline=50ms)` 在写挂起时 ≤60ms 返回；文件数上限淘汰。

### SP6：reaper `hub/spawn/{reaper-source,reaper}.ts`（中；依赖 SP1）

- `reaper-source.ts`：`buildReaperSource()` 返回内联脚本字符串（写法照 `db-client.ts:177` 的 `buildQueryScript`）。脚本只用 `node:fs`/`node:process`；内嵌一份身份核验（与 `protocol/proc-identity.ts` 同算法，**测试用同一组 `/proc` 夹具对两份实现做对照**）；协议与时序按 arch §7.3。脚本自身的硬上限：stdin EOF 后最多 10s 必定 `process.exit`。
- `reaper.ts`：`createReaper({spawnFn?, log, now}) → {start(deadline): Promise<boolean>, track(rec), untrack(pid), close(): void, readonly available: boolean, onUnavailable(cb)}`。`start` 等 `{ok:"ready"}` ≤2s；子进程意外退出 ⇒ 按 `[1s,5s,30s]` 重启，10 分钟 4 次 ⇒ `available=false`；重启成功后由 supervisor 重新 `track` 全部非终态记录（`onRestart` 回调）。`close()` = `stdin.end()`，不等待（reaper 继续自己的升级）。

**验收** `tests/web-hub/hub/spawn/reaper.test.ts`（新，**真实子进程**）：

- 启动握手 ready；`track` 一个 `sleep 600` 进程（用 `detached:true` 拉起，pgid=pid，记录真实 starttime/bootId/uid）后关闭 reaper stdin ⇒ 5s 后收到 SIGTERM（用 `trap` 的 sh 脚本观察）、忽略 TERM 的进程在 +3s 被 SIGKILL；reaper 在 ≤10s 内退出。
- 身份不符（starttime 改错）⇒ 不发信号，进程存活。
- reaper 被 SIGKILL ⇒ `createReaper` 重启并通过 `onRestart` 重新 track；连续 4 次 ⇒ `available=false`。
- 对照测试：同一组夹具下内联脚本与 `verifySpawnedIdentity` 结论一致（把内联脚本的核验函数以 `new Function` 方式加载到测试进程里执行）。

### SP7：supervisor `hub/spawn/{supervisor,launcher-check}.ts`（大；依赖 SP3–SP6）

```ts
createSpawnSupervisor(deps: {
  cfg: HubSpawnConfig; registry: SpawnRegistryPort; log: HubLog; now: () => number;
  store: SpawnStore; reaper: Reaper; dirs: DirService; launcher: [string, string] | undefined;
  env: NodeJS.ProcessEnv; childUmask: number | undefined; platform: { ok: true } | { ok: false; detail: string };
  spawnFn?: typeof spawn; proc?: ProcSyncDeps; audit: (r: SpawnAuditRecord) => void;
  onLive?: (rec: InternalRecord) => void;   // SP8 的 first-prompt 订阅
}): SpawnSupervisor

interface SpawnSupervisor {
  init(deadline: ReqDeadline): Promise<void>;          // store.load + 回收 + launcher 校验 + reaper.start
  policy(principal: string, listener: "loopback" | "lan", scheme: "http" | "https", viaTrustedProxy: boolean): SpawnPolicyWire;
  start(req: AdmittedRequest, deadline: ReqDeadline): StartResult;   // 完全同步：①–④
  stop(spawnId: string, force: boolean): { ok: true; state: SpawnState } | { ok: false; code: "E_NOT_FOUND" };
  records(): readonly InternalRecord[];               // 给 project.ts
  isManaged(agentKey: string): boolean; noteVersion(agentKey: string, pluginVersion: string): void;
  liveCount(): number; busyCount(): number;
  shutdown(deadline: ReqDeadline): Promise<void>;
}
```

- `launcher-check.ts`：`checkLauncherAsync(launcher, deadline)` 做 arch §4.2 的 init 校验并返回指纹；`recheckLauncherSync(fp)` 每次 spawn 前比对。
- `start()` 的同步顺序：限额（global / principal / starting）→ 冷却与熔断 → `platform` / `store.healthy` / `reaper.available` / launcher 指纹 → `store.saveNow(launching)` → `dirs.pinSync` → umask 切换 + `spawnFn` + 恢复 + `closeSync(fd)`（`try/finally`）→ `readStatSync(pid)` → `store.saveNow(pid+identity)` → `reaper.track` → 挂 stdio 监听（`createRpcStdio`、`createStderrSink`）→ 返回。任何一步失败都返回明确的错误码，记录状态按 §3.1。
- 绑定与 marker：订阅 `registry.bus`；`holdAllowed = () => linked && (registry.getCaps(key) ?? []).includes("dialog.v1")`；`dialogs` 事件转 `stdio.onSlot(open.length, linked)`。
- 推送：同一 tick 内的迁移合并（`queueMicrotask`）后 `registry.publish({type:"spawns", payload: toPublicPayload(records)})`，同时 `store.markDirty`、写审计。
- `shutdown(deadline)`：arch §7.6 的分级（等待预算 `deriveBudget(r, 3000, 6500)`；crash 时 `r` 很小，等待预算为 0）→ 对仍存活者核验后 SIGTERM → `store.flushAndClose(deadline)` → `stderr.close(deadline)` → `reaper.close()`。总耗时 ≤ 等待预算 + 300ms。
- 零 `as`：`hub/spawn/**` 的源码扫描测试禁止 `as`（`as const` 除外）。

**验收** `tests/web-hub/hub/spawn/supervisor.test.ts`（新，EventEmitter 假 `ChildProcess` + PassThrough + `fakeSpawnRegistry` + fake timers + 假 store/reaper/dirs），表驱动覆盖 §3.1 每一行，外加：

1. **L1 顺序（#1 硬门槛）**：spy 记录调用顺序，严格为 `saveNow(launching)` → `pinSync` → `spawnFn` → `readStatSync` → `saveNow(pid)` → `reaper.track`；`saveNow` 失败 ⇒ `spawnFn` 调用次数为 0。
2. cwd：`pinSync` 返回 `changed` ⇒ 不 fork；`agent_up.cwd` 不等于 realpath ⇒ `failed{cwd_mismatch}` 且走停止升级。
3. launcher：init 时 `incompatible`/`unverifiable`/`missing` ⇒ `policy.reason:"launcher"`；init 后修改 `launcher[1]` 的 mtime ⇒ 下一次 start 返回 `E_LAUNCHER{changed}`。
4. 资源（#11 硬门槛）：第 5 个全局 / 第 3 个同主体 / 第 3 个同时启动 ⇒ 各自的 `E_LIMIT{limit}`；`maxLifetimeMinutes` 到期 ⇒ `exited{lifetime}`；熔断 `[0,5s,30s]` 与 10 分钟打开、半开；hub 从不为接纳新请求结束已有会话（满额时 start 失败，已有记录状态不变）。
5. 停止升级时序 0/5/8/13s；每次 kill 前都调用了身份核验；核验失败 ⇒ 不发信号。
6. env：子进程 env 不含任何 `PI_WEBHUB_*`（除 `HEADLESS`、`SPAWN_ID`），`PWD === realpath`；argv 恰为 `[launcher[1], "--mode", "rpc"]`；umask 调用序列为 `[inherited, 0o077]`。
7. `shutdown`：普通 deadline（10s）下等待 ≤3s；`deadline.remaining()=2500`（crash）下等待 0、立即 TERM；之后 `start` 返回 `E_LAUNCHER{reason:"closed"}`；`store.flushAndClose` 与 `reaper.close` 各调用一次。
8. 版本：受管 agent 的 `noteVersion` 带更新版本 ⇒ `hint:"newer-plugin"`。
9. 平台：`platform.ok=false` ⇒ `policy.reason:"platform"`，start 返回 `E_SPAWN_DENIED{platform}`，不调用 reaper/store。

### SP8：首条消息转发 `hub/spawn/first-prompt.ts`（中；依赖 SP1，可与 SP7 并行）

```ts
createFirstPromptForwarder(deps: { router: FirstPromptRouterPort; now; log; audit; setTimeout?; clearTimeout? }): {
  accept(spawnId: string, fp: { text: string; deliver: "steer" | "followUp" }, origin: CmdOrigin, deadlineAt: number): void;
  onLive(spawnId: string, agentKey: string, sessionId: string, control: boolean): void;
  onLink(spawnId: string, linked: boolean): void;
  onTerminal(spawnId: string, reason: "never_live" | "stopped"): void;
  state(spawnId: string): { state: FirstPromptState; code?: string; textLen: number; attempts: number } | undefined;
  dispose(reason: "hub_restart"): void;       // 正文全部丢弃
}
```

| 事件 / 结果                                                                 | 动作                                                                                                                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `onLive`，`control=false`                                                   | `failed{E_UNSUPPORTED}`，丢弃正文                                                                                                                      |
| `onLive`，`control=true`                                                    | `sending`；`router.request({t:"cmd", rid, id:"fp_"+spawnId, deadlineMs:8000, origin, cmd:{op:"prompt", text, deliver, expect:{sessionId}}}, agentKey)` |
| `ok:true`（含 `dup`）                                                       | `delivered`，丢弃正文                                                                                                                                  |
| `E_AGENT_GONE`                                                              | 回到 `pending`，等 `onLink(true)` 后重发（加 `retry:true`）                                                                                            |
| `E_DEADLINE`、`effect:"unknown"`、`E_BUSY_COMPACTING`、`E_BUSY_STEER`       | 按 `[1s,3s,9s]` 退避重发，最多 4 次                                                                                                                    |
| `E_UNSUPPORTED`/`E_COMMAND_DENIED`/`E_BAD_REQUEST`/`E_SESSION_CHANGED`/其他 | `failed{code}`，丢弃正文                                                                                                                               |
| `deadlineAt` 到期或 4 次用完                                                | `expired{deadline}`，丢弃正文                                                                                                                          |
| `onTerminal`                                                                | 未送达 ⇒ `expired{reason}`                                                                                                                             |
| `dispose`                                                                   | 未送达 ⇒ `expired{hub_restart}`                                                                                                                        |

每次状态变化回调 supervisor 推送 `spawns`，并写审计（`firstPrompt`、`textLen`、`attempts`、`code`）。

**验收** `tests/web-hub/hub/spawn/first-prompt.test.ts`（新，`fakeFirstPromptRouter` + fake timers）：上表每一行；**重复发送（#15 硬门槛）**：一次 `E_DEADLINE + effect:"unknown"` 后重发，router 两次收到的 `id` 相同且第二次带 `retry:true`；替身模拟 agent 台账「同 id 只执行一次」⇒ 总执行次数为 1；链路抖动（`E_AGENT_GONE` → `onLink(false)` → `onLink(true)`）⇒ 恰好送达一次；`state()` 永不含正文；`dispose` 后内存里没有正文（检查内部 Map 为空）。

### SP9：路由、可见性投影、审计 `hub/spawn/{project,routes}.ts` + `http.ts` 接线（中；依赖 SP7、SP8；前置：upload U3 已合入）

- **`project.ts`**：`toPublic(rec)`、`toViewer(rec, principal, isLoopback)`、`toPublicPayload(records)`。按 arch §6.4 **逐字段白名单拷贝**（不展开对象）；`cwdLabel = basename(realpath)`；loopback 主体对所有记录都是 owner。
- **`routes.ts`**：`createSpawnRoutes({supervisor, dirs, firstPrompt, cfg, limit: CmdLimit, rejectAudit429, log, now}): SpawnFrontendPort`。路由与闸门顺序按 arch §8.2；POST 的 `reqDeadline = createReqDeadline(now, WRITE_TOTAL_MS)`，`admit` 用 `deriveBudget(r, 2000, 3000)`；幂等 LRU（256 条 / 10 分钟，键 `principal|id`，摘要 `sha256(canonical({cwd, firstPrompt}))`，`confirm`/`expectCwd` 不进摘要，409 确认不写 LRU）；速率桶 `${principal}:spawn`（`ratePerMinute`，补充间隔 `60_000/ratePerMinute`）、`${principal}:spawn-read`（10/1s）、stop 复用 `stop` 类别（10/2s，`http.ts:1465-1467`）；幂等命中不扣令牌。
- LAN 有效策略：`scope = cfg.lan === "roots" && !(ctx.scheme === "http" && !ctx.viaTrustedProxy) ? "roots" : "known"`；`cfg.lan === "off"` 时 `handle` 不会被调用（见下面的接线）。
- **`http.ts` 接线**（HEAD 行号 / 符号）：
  - `statusFor`（`:216`）：`E_SPAWN_DENIED`→403、`E_DIR`→400、`E_LIMIT`→409、`E_LAUNCHER`→503。
  - `createRouteSet`（`:614`）的 routeDeps 加 `spawns?: () => SpawnsPayload | undefined`；`onHubEvent`（`:662`）加 `case "spawns": { const p = routeDeps.spawns?.(); if (p !== undefined) sse.publish("spawns", e.payload); break; }`；`openEvents`（`:762-769`）在 `agents` 之后加 `const sp = routeDeps.spawns?.(); if (sp !== undefined) client.send("spawns", sp);`。
  - `createHttpFrontend`（`:1810`）：`const spawnRoutes = deps.spawn;`；loopback routeset 传 `spawns: spawnRoutes && (() => spawnRoutes.publicPayload("loopback"))`；LAN routeset 传 `() => spawnRoutes?.publicPayload("lan")`（LAN off ⇒ undefined ⇒ 不发）。共用 `cmdLimit`（`:1820`）与 `rejectAudit429`。
  - loopback `handleApi`：`:2080` 的 `res.setHeader` 之后、`if (method === "POST")` 之前插入 `if (spawnRoutes !== undefined && isHeadlessPath(path)) return spawnRoutes.handle(req, res, method, path, query, loopbackIo(req, res));`。
  - LAN `handleLanRequestInner`：`:1122` 之后、`:1124` 之前插入同样的分派，条件多一个 `spawnRoutes.publicPayload("lan") !== undefined`（LAN off ⇒ 落到原有逻辑 ⇒ 与未启用字节一致）。`lanIo` 的 `authorize` 复用 `:1130-1136` 的闭包。
  - 与 upload U3 的插入点（`:2103`、`:1145` 之前）相距 20 行以上，属于不同 hunk。
- **`audit.ts:53` 之后**：`SpawnAuditRecord`（arch §6.6）、`SPAWN_AUDIT_KEYS`、`auditSpawn(log, r)`（按 KEYS 逐个拷贝）。

**验收**：

- **未启用矩阵（#13 硬门槛）** `tests/web-hub/http/headless-matrix.test.ts`（新）：按 arch §8.2 矩阵逐格断言状态码与响应体字节（未启用 / LAN off / 平台不支持 / launcher 不可用 × loopback·LAN × GET·POST，以及 SSE 是否带 `spawns`、caps 是否带 `spawn.v1`）。`tests/web-hub/http/api.test.ts:318-328` 原样保留。
- `tests/web-hub/http/api-headless.test.ts`（新）：CSRF 四种（缺 Origin、跨源、缺 X-PWH、`Sec-Fetch-Site: cross-site`）⇒ 403；GET 缺 X-PWH ⇒ 403；未登录 401；**登出竞态**（第二次 `authorize` 失败）⇒ 401 且 `supervisor.start` 未被调用；确认流三步；已知目录 loopback 免确认；幂等 `dup`、摘要冲突 409、只多 confirm 视为同一意图；429 带 `Retry-After`；`E_LIMIT` 三种；`E_LAUNCHER` 五种 reason；body 52 KiB+1 ⇒ 413 且连接关闭；`firstPrompt` 48 KiB+1 ⇒ 400；`dirs?path=` ⇒ 400 `browse-unavailable`；stop 404/202/幂等；**LAN 用户 B 停止用户 A 的会话 ⇒ 202**（用户裁定）。
- **可见性矩阵（#8 硬门槛）** `tests/web-hub/hub/spawn/project.test.ts`（新）+ `tests/web-hub/http/lan-headless.test.ts`（新）：对 arch §6.4 的每一行每一列断言（SSE 帧里不出现 `cwd`/`stderrTail`/`hintDetail`/`origin.user`/`uiCancelled[].title`/`firstPrompt.textLen`；LAN 用户 B 的 GET 看不到 A 的上述字段，A 自己能看到；loopback 主体看到全部；任何投影里都不出现首条消息正文——用一个独特的正文字符串在所有序列化输出里做 `not.toContain`）。另覆盖：`lan:"off"` ⇒ LAN 面与未启用一致；`lan:"roots"` + 明文直连 ⇒ roots 内未知目录被拒；经受信代理 https ⇒ 允许；LAN 已知目录也必须确认。
- `tests/web-hub/http/sse.test.ts` 追加：连接时 `spawns` 紧跟在 `agents` 之后；bus 事件被转发；`deps.spawn` 缺省时没有 `spawns` 帧。
- `tests/web-hub/hub/audit.test.ts` 追加：`auditSpawn` 丢掉 KEYS 之外的字段；源码里没有把 `text`、`stderr` 写进审计。

### SP10：hub 装配（中；依赖 SP2、SP7、SP8、SP9；前置：upload U3 已合入）

- `hub.ts:64-73`：`RunningHub.close(reason: string, opts?: { deadline?: ReqDeadline }): Promise<void>`（可选参数，向后兼容）。
- `hub.ts:151`：`onVersion: (v, key) => { if (spawnSup?.isManaged(key) === true) { spawnSup.noteVersion(key, v); return; } supersede?.observe(v, key); }`。
- `hub.ts:203-212` + `agent-server.ts:40-60,153`：`createAgentServer` deps 加 `extraHubCaps?: readonly string[]`，caps 为 `[...(deps.admin?.caps() ?? []), ...P2_HUB_CAPS, ...UPLOAD_HUB_CAPS, ...(deps.extraHubCaps ?? [])]`（upload 合入后的形态）；`hub.ts:227` 的 `info.caps` 用同一个 `extraHubCaps = config.spawn === undefined ? [] : [SPAWN_HUB_CAP]`。
- `hub.ts:317` 之后（`commandRouter` 已构造）：`config.spawn` 存在时依次构造 `platform = probePlatform()`、`store`、`reaper`、`dirs`（`agentDir` 见 SP3）、`firstPrompt = createFirstPromptForwarder({router: commandRouter, …})`、`spawnSup = createSpawnSupervisor({…, registry, childUmask: deps.childUmask, platform})`；`await withSignal(spawnSup.init(createReqDeadline(now, 4000)), startup.signal)`（init 内部各步有界，平台不支持时 init 只做 `store` 之外的空操作）；`spawnRoutes = createSpawnRoutes(…)`；`cleanup.push(() => spawnSup.shutdown(createReqDeadline(now, 3000)))`（启动失败路径）。
- `hub.ts:318-335`：`frontend({…, ...(spawnRoutes === undefined ? {} : { spawn: spawnRoutes })})`。
- `hub.ts:347-350` + `supersede.ts:33-45,193`：`SupersedeDeps.managedBusy?: () => number`；quiet 追加 `&& (d.managedBusy?.() ?? 0) === 0`；hub 传 `() => spawnSup?.busyCount() ?? 0`（busy = 绑定 agent 的 `status.busy` 或首条消息处于 `sending`）。
- `hub.ts:626`：`headless: spawnSup?.liveCount() ?? 0`。
- `hub.ts:636-662` 的 `close(reason, opts)`：开头 `const d = opts?.deadline ?? createReqDeadline(now, HUB_CLOSE_DEADLINE_MS);`；在 `await bounded(fe.close())`（`:648`）**之前**插入 `if (spawnSup) await spawnSup.shutdown(d);`（`shutdown` 自身有界，不再套 `bounded`）。
- `hub.ts:689-705` 的 `onCrash`：`void hub.close("crash", { deadline: createReqDeadline(Date.now, STEP_DEADLINE_MS - 500) })`。
- `hub-json.ts:26-43,60-103`：`HubRecord.spawn?: {count: number; reason?: string}` + `patchSpawn()`（照 `patchLan`）；supervisor 的 `liveCount` 或策略原因变化时调用。

**验收**：

- `tests/web-hub/hub/hub-spawn.test.ts`（新，`spawnFn` 注入假进程，reaper 用假实现）：没有 `config.spawn` ⇒ `info.caps` 与 `hello_ack.caps` 和现状**深相等**、hub.json 没有 `spawn`、`stateDir` 下没有 `spawns.json` 和 `spawn/`；有 ⇒ 两处 caps 都以 `spawn.v1` 结尾且相等；有 live 子进程时 idle 不退出；`close("signal")` 中 `spawnSup.shutdown` 早于 `fe.close`（调用顺序 spy）；受管 agent 带更新版本发 hello ⇒ `supersede.state()` 为 undefined；受管 busy 时 supersede 不 quiet。
- **deadline 分级（#4 硬门槛）**：正常 close ⇒ `shutdown` 收到的 `remaining()` ≥ 9.5s，且 close 总耗时 <10s（子进程全部拒绝退出的最坏情况）；`onCrash` ⇒ `shutdown` 收到 ≤2.5s，并且在 `process.exit` 之前完成落盘（用注入的 exit 替身断言顺序）。
- `tests/web-hub/hub/supersede.test.ts` 追加 `managedBusy`；`agent-server-admin.test.ts:70-84` 保留并追加 `extraHubCaps`；`hub-json.test.ts` 追加 `patchSpawn`。

### SP11：UI 逻辑与传输（中；依赖 SP1；前置：upload U4b 已合入）

- **新 `logic/spawn.js`**：`spawnAvailability({hubCaps, listResult})`、`newSessionActions({hubCaps, listResult, selected})`、`classifySpawnError(outcome)`（→ `confirm | dir | denied | limit | rate | launcher | deadline | network`）、`isMine(rec, localIds)`、`pendingRows(spawns)`、`managedFor(spawns, agentKey)`。
- **新 `composables/useSpawn.ts`**：`list()`/`dirs()`/`start()`/`stop()`，内部调 `transport.spawn?.*`；没有该能力时返回 `{ok:false, error:"E_UNSUPPORTED"}`。
- **新 `composables/useNewSession.ts`**：§3.2 编排器，`id` 用 `newCmdId()`（`logic/control.js:39`）；**本地保留首条消息正文**（只在内存，`Map<reqId, text>`，不写 storage），用于 `failed/expired` 时回填草稿；回填后删除。
- `logic/contract.js:36-46`：`API.headless`、`API.headlessDirs`。`logic/token-client.js:246-265`、`logic/password-client.js:325-345,492`：`spawnList`（GET，带 `X-PWH:1`）、`spawnDirs`、`spawnStart`、`spawnStop`；404 原样返回给上层（UI 视为不可用）。`transport/types.ts:66-81` 加可选 `spawn?: SpawnTransport`；`token.ts`、`password.ts` 挂上，最终 `E_AUTH` ⇒ `onConn("auth")`；`password.ts:33` 的 `REST_AUTH_PATHS` 加两个 headless 路径。
- `logic/state.js:81-97` 的 `initialState` 加 `spawns: null`；`reduceInner` 加 `case "spawns"`（覆盖式，非法 payload 忽略）；`hello` 不清空。`types.ts:95` 的 `HubState.spawns?`、`:146` 的 `HubHandle.spawn?`；`useHub.ts:203-215` 构造并导出。

**验收**：`tests/web-hub/ui/logic-spawn.test.ts`（新）真值表（0 个 agent、无 caps、GET 404、`allowed:false` 各 reason）；`logic-state.test.ts` 追加；`transport-contract.test.ts` 追加两个 transport 同形（202、409、404、401 ⇒ `onConn("auth")`、超时、GET 带 X-PWH）；**`tests/web-hub/ui/use-new-session.test.ts`（新，#15 硬门槛）**：(a) 202 之后 SSE 断开、重连后快照显示 `delivered` ⇒ 不回填、不重发；(b) 202 之前网络错误 ⇒ 用同一 id 重发一次，hub 替身返回 `dup:true`，只有一条记录；(c) live 之后断网再重连 ⇒ 状态以快照为准；(d) `expired{never_live}` ⇒ 正文回填到 DirPicker；(e) `failed{E_SESSION_CHANGED}` ⇒ `setDraft(agentKey, text)` 被调用一次；(f) 重复点击提交 ⇒ 只发一次请求；(g) 本地 Map 在回填或送达后清空。`source-scan.test.ts` 保持绿（无 `randomUUID`/`innerHTML`；`localStorage` 白名单不变）。

### SP12：UI 组件（中；依赖 SP11）

- 新 `components/spawn/NewSessionMenu.vue`（分裂按钮；键盘 Enter/Esc/方向键；`aria-haspopup="menu"`）、`DirPicker.vue`（路径输入、最近目录、首条消息 ≤48 KiB 预检）、`SpawnConfirm.vue`（`resolvedCwd` 用 textContent；LAN 明文警告）、`SpawnRow.vue`（starting / failed 行；「详情」调 `useSpawn.list()` 取 owner 明细；「关闭」「重试」）。
- `AgentList.vue`：`:94-131` 的 `newSessionEnabled`/`onNewSession` 原样搬进 `useNewSession` 的 `same-cwd` action；`:150-158` 的按钮换成 `NewSessionMenu`；`:173-183` 的 `EmptyState` 下面加 pick-dir 入口；`:184` 的列表顶部加 `SpawnRow`。
- `AgentCard.vue`：注入 `HUB_CTX`，`managedFor(spawns, card.key)` 存在时显示 `web` 徽标（不改 `AgentCardProps`/`contracts.ts`）。
- `DetailHeader.vue`：受管卡片显示「停止会话」（二次确认 → `useSpawn.stop`）；首条消息 `failed/expired` 的一次性提示。
- `i18n/{en,zh}/spawn.ts`（新命名空间）、`styles/spawn.css`（组件自行 import）。

**验收**：`agent-list.test.ts` 现有「new session」用例全绿，追加菜单 enabled 矩阵、0 个 agent 的入口、pending 行、live 后徽标；`tests/web-hub/ui/dir-picker.test.ts`（新）：最近目录、409 ⇒ 确认视图、LAN 警告、失败保留输入、48 KiB 预检；`detail-header.test.ts` 追加停止按钮（受管才有）与首条消息提示；`i18n-parity.test.ts`、`source-scan.test.ts` 绿；`npm run build:web && npm run check:web`。

### SP13：集成、conformance、验收与文档（中；依赖 SP10、SP12）

- `tests/integration/fixtures/fake-rpc-pi.mjs`：用自己的 pid 连 hub.sock 发 `hello{kind:"rpc", cwd: process.cwd()}` 与 `session`；`process.title="pi"`（模拟真实 pi 改写 cmdline）；读 stdin，EOF 时退出。开关：`--ignore-eof`、`--ignore-term`、`--emit-ui select|confirm|marker`、`--emit-ui-huge select|confirm|editor`（1 MiB 单行）、`--emit-ui-bad-head`、`--flood N`（MiB）、`--no-hello`、`--cmd-echo`（对 cmd 帧回 ok，并记录收到的 id 到 stderr）、`--stderr-flood N`。
- `tests/integration/web-hub-headless.test.ts`（新，`sandboxHome()`；hub 用真实子进程跑，复用 `tests/integration/web-hub-spawn.test.ts` 的 jiti 拉起方式；pi 的 jiti 不可解析时 skip）。

**S1 合入硬门槛**（任一不过不得合入 master）：

| #   | 场景                                                                                                   | 断言                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | hub `kill -9`；子进程为普通 fake（响应 EOF）                                                           | 子进程 ≤3s 内退出                                                                                                                                   |
| H2  | hub `kill -9`；子进程 `--ignore-eof`；**之后不再启动任何 hub**                                         | reaper 在 5s 后 TERM，子进程 ≤12s 内消失；`pgrep -f fake-rpc-pi` 为空；reaper 进程 ≤10s 内退出                                                      |
| H3  | hub 与 reaper 同时 `kill -9`；子进程 `--ignore-eof --ignore-term`；随后启动新 hub                      | 新 hub 启动回收：身份核验通过 ⇒ TERM，3s 后 KILL；记录为 `exited{orphan}`；把记录里的 starttime 改错再跑一遍 ⇒ 不发任何信号                         |
| H4  | conformance：真实 `pi --mode rpc`（临时 HOME，settings 列出本包）                                      | `/proc/<pid>/cmdline` 不含 `--mode`；`verifySpawnedIdentity` 返回 ok；注册为 `kind:"rpc"`；stdin EOF 后 8s 内退出；ui_request 行前缀符合 V1         |
| H5  | `--emit-ui-huge` 的 select / confirm / editor 三种，以及 `--emit-ui-bad-head`                          | 前三种：子进程在 1s 内收到 `cancelled` 且正确 id（fake 把收到的应答写 stderr），会话继续；第四种：`failed{protocol_error}`，进程被停止              |
| H6  | 资源：`maxProcesses=2, maxPerPrincipal=1`；`maxLifetimeMinutes` 用测试钩子缩到 2s；`--stderr-flood 50` | 第 2 个同主体 ⇒ 409；第 3 个全局 ⇒ 409；运行时限到 ⇒ `exited{lifetime}`；stderr 日志文件 ≤256 KiB，hub RSS 增长 <32 MiB                             |
| H7  | 权限 / 可见性：LAN 两个用户                                                                            | B 能停 A 的会话；B 的 SSE 与 GET 里看不到 A 的 `cwd`/`stderrTail`/`origin.user`；首条消息正文不出现在任何 SSE 帧、GET 响应、hub.log、spawns.json 里 |
| H8  | 未启用矩阵                                                                                             | 与 SP9 `headless-matrix.test.ts` 同一张表，在真实 hub 上再跑一遍                                                                                    |

其余集成用例：spawn → live → 首条消息 `delivered`（`--cmd-echo` 记录的 id 为 `fp_<spawnId>` 且只有一次）；**live 前浏览器断开**（发完 POST 立即关闭 SSE，之后重连）⇒ 快照 `delivered`；`--flood 8` 不卡；`--emit-ui confirm` 被自动取消；`--no-hello` ⇒ `failed{register_timeout}` + hint `…-hello`；hub 正常 close 时子进程全部退出、`spawns.json` 全部终态；umask：子进程里 `process.umask()` 等于测试进程的 umask。

- `tests/conformance/rpc-spawn.test.ts`：H4。
- `docs/dev/web-hub-spawn/acceptance.md`：已随本次修订建初稿，SP13 补实测数据（V3 冷启动耗时等）。
- `AGENTS.md` 的 `src/web-hub/` 条目加一段：默认关闭、Linux only、`spawn.v1` 条件 cap、reaper 与孤儿不变量、`process.title` 导致 cmdline 不可用于身份判定、umask 恢复、链接 arch/plan/acceptance。
- `docs/dev/web-hub/lan-plan.md` 的安全边界章节加 arch §6.0 的「同 hub 全信任」段落（#8）。

## 5. S2 / S3 包（S1 验收通过后另行评审）

| 包             | 内容                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| SP14 目录浏览  | `GET /api/headless/dirs?path=`（roots 内，≤200 项，2s）；明文 LAN 不可用；DirPicker 补全 |
| SP15 reopen    | `--session <file>`（file 只取自记录）、`E_SESSION_IN_USE`、「在终端继续」命令            |
| SP16 空闲回收  | `idleMinutes`：`agent_settled` ∧ 无 subagent ∧ 无订阅持续 N 分钟                         |
| SP17 模型选择  | `--model`，白名单正则                                                                    |
| SP18 加固      | 可选 `setpriv --pdeathsig SIGTERM` 包装；可选 `systemd-run --user --scope` + 资源上限    |
| SP19（S3）代答 | hub 作为完整 extension_ui 客户端，网页代答其他扩展对话框                                 |

## 6. 测试汇总

| 层          | 文件                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| protocol    | `tests/web-hub/protocol/{spawn,proc-identity}.test.ts`                                                                            |
| 类型契约    | `tests/web-hub/contract/types.test-d.ts`、`fakes.ts`、`fakes.test.ts`；`tests/web-hub/hub/spawn/source-scan.test.ts`（禁止 `as`） |
| config      | `tests/config/web-hub-settings.test.ts`、`tests/web-hub/agent/wiring-spawn.test.ts`、`tests/web-hub/hub/spawn/config.test.ts`     |
| hub 单元    | `tests/web-hub/hub/spawn/{dirs,rpc-stdio,store,stderr-sink,reaper,supervisor,first-prompt,project}.test.ts`                       |
| HTTP        | `tests/web-hub/http/{headless-matrix,api-headless,lan-headless}.test.ts`，`api.test.ts`、`sse.test.ts`、`audit.test.ts` 追加      |
| 装配        | `tests/web-hub/hub/hub-spawn.test.ts`、`supersede.test.ts`、`agent-server-admin.test.ts`、`hub-json.test.ts`                      |
| UI          | `logic-spawn`、`logic-state`、`transport-contract`、`use-new-session`、`agent-list`、`dir-picker`、`detail-header`                |
| 集成        | `tests/integration/web-hub-headless.test.ts`（H1–H3、H5–H8）                                                                      |
| conformance | `tests/conformance/rpc-spawn.test.ts`（H4）                                                                                       |
| 真机        | `docs/dev/web-hub-spawn/acceptance.md`                                                                                            |

## 7. 待确认

1. `maxLifetimeMinutes` 默认 720（12 小时）是否合适？过短会打断长任务，过长则削弱资源兜底。
2. hub 重启时未送达的首条消息只标 `expired{hub_restart}`、不落盘重放（隐私优先）。如果希望跨 hub 重启也能送达，需要把正文写盘（0600、送达即删），这会扩大 §6.4「任何层都不出现正文」的例外范围。
