# web-hub「选择工作目录建会话」架构设计（arch v1，2026-09）

> 上游：`docs/dev/web-hub/arch.md`（P1–P3 总体架构，§5.3 已勾勒「无头进程生命周期」、§13.1 把它列入 P3，本文把那一节落成可施工的设计）、
> `docs/dev/web-hub/control-plan.md`（P2 控制面，鉴权/CSRF/审计/confirm 先例）、`docs/dev/web-hub/lan-plan.md`（LAN 信任边界）。
> pi 源码坐标相对 `~/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/`（0.87.1）。
> 本文只做设计，不改 `src/`。标 **〔需核实〕** 的点集中在 §10。

---

## 1. 背景与目标

**要解决的问题**：web UI 目前只能对**已在运行**的 pi 进程发命令。网页上的「新建会话」按钮（进行中的改动，`src/web-hub/ui/src/components/agents/AgentList.vue:118-125`）发的是 `/new`，只能在被选中 agent 的**原 cwd** 里新开会话；pi 进程的 cwd 在启动时就定死了，`/new` 改不了。用户要的是：在网页上选一个目录 → 系统在这个目录拉起一个新的 pi 进程 → 它作为新 agent 自动出现在 AGENTS 列表 → 之后和现有 agent 一样收发消息、停止。

**约束（沿用 web-hub 不变量）**

- 零 hang：每一步等待都有 deadline；hub 不 import pi（`docs/dev/web-hub/arch.md` §3.1）；所有 timer 都 `unref()`。
- 功能默认关闭（`webHub.spawn.enabled=false`）。关闭时 hub 的 HTTP 面、`HubConfig`、hello 帧和现在**逐字节一致**（`/api/headless` 仍回 501，见 `src/web-hub/hub/http.ts:2135`）。
- 运行时依赖仍然只有 typebox；不引入 tmux 之类的外部二进制依赖。
- 从浏览器起本机进程等于远程执行，必须挂在现有鉴权面（loopback token / LAN 密码）、CSRF 闸门和审计之上。

**非目标（v1）**：网页代答**其他扩展**的 `select/confirm/input/editor` 对话框（v1 一律自动取消，见 §4.4）；Detach（把进程交给终端，见 §7.4）；跨机器 / 跨 uid 拉起；在网页里选模型以外的启动参数。

## 2. 现状摘要（事实 + 坐标）

| 事实                                                                                                                                                                               | 坐标                                                                                                            | 对本设计的意义                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rpc 模式在 web-hub 里已经是一等公民：`session_start` 只排除 print/json，tui 和 rpc 都会 attach                                                                                     | `src/web-hub/agent/index.ts:561-562`                                                                            | 新进程用 `--mode rpc` 就会自动注册，**agent 侧不用改代码**                                                                                                                                                          |
| `AgentKind = "tui" \| "rpc"`，hello 里带 `kind`，UI 已经在读                                                                                                                       | `src/web-hub/protocol/messages.ts:20`、`:329-334`；`ui/src/components/agents/agentCardModel.ts:92`              | 不用新增 kind；「是不是网页拉起的」由 hub 另行登记（§4.3）                                                                                                                                                          |
| hello 已经为 P3 预留了 `ticket?`、`launcher`；`hello_reject` 预留了 `E_TICKET`                                                                                                     | `messages.ts:331`、`:397`、`:547`、`:612`                                                                       | v1 不用 ticket（理由见 §5 D3），字段继续保留                                                                                                                                                                        |
| socket 地址由 `~/.pi/agent` 和 env 推导出来，与 cwd 无关                                                                                                                           | `src/web-hub/protocol/paths.ts:198-210`                                                                         | 同 uid、同 HOME、同 `XDG_RUNTIME_DIR` 的新进程一定能连到同一个 hub；子进程继承 hub 的 env，这一条天然成立                                                                                                           |
| `PI_WEBHUB_HEADLESS=1` 时进程永远不会去拉起 hub                                                                                                                                    | `src/web-hub/agent/launcher.ts:122-148`、`connection.ts:143,708`、`agent/index.ts:531`                          | 防止「hub 死了被子进程复活」的回环，P1 起就已生效                                                                                                                                                                   |
| hub 空闲计数里已经有 `headless` 位，但写死为 0                                                                                                                                     | `src/web-hub/hub/idle.ts:10,24`；`src/web-hub/hub/hub.ts:626`                                                   | 由 supervisor 填真实值                                                                                                                                                                                              |
| 每个 agent 的 hello 都带 `launcher=[execPath, argv1]`；拉起 hub 时 `HubConfig.launcher` 也会经 env 传下来                                                                          | `agent/connection.ts:466-482`；`agent/launcher.ts:95-112`；`hub/ports.ts:353-362`                               | 拉起命令有现成来源（§4.2）                                                                                                                                                                                          |
| 子进程监管的现成模板：spawn + 管 stdout + exit 驱动 + deadline 后 SIGKILL + close                                                                                                  | `src/web-hub/hub/db-client.ts:152-212`、`:300-308`、`:393-424`                                                  | supervisor 照这个范式写；**不要**照抄 `launcher.ts` 的 fire-and-forget                                                                                                                                              |
| `ChildSpawner`/session-driver 用的是同进程 `createAgentSession`，子会话因为 `HOST_KEY` 已被占用而走不到 post-guard 的 `wireWebHub`                                                 | `src/index.ts:142,222-224,855-860`                                                                              | 不能复用（§3.1 方案 B）                                                                                                                                                                                             |
| `pi --mode rpc`：stdin EOF 会触发有序 shutdown；stdout 是 JSONL，所有会话事件都写进去，并按背压等待；扩展对话框以 `extension_ui_request` 输出，等 stdin 回 `extension_ui_response` | `modes/rpc/rpc-mode.js:581-597,617-654`、`:47-77`、`:84-191`                                                    | hub 必须**持有 stdin、持续读空 stdout**，并应答对话框请求，否则 pi 会被背压或对话框卡住（§4.4）。这一点修正了探查交接里「与 rpc 的 stdin/stdout 无关」的说法：控制面确实不走 stdio，但生命周期和背压都绑在 stdio 上 |
| rpc 模式下 `newSession/switchSession` 的 commandContext 动作都齐                                                                                                                   | `rpc-mode.js:228-256`                                                                                           | 拉起来的 agent 照样能用网页 `/new`（builtin-bridge 走 `/webhub __exec new`，`agent/builtin-bridge.ts:302-304`）                                                                                                     |
| ask_user 在 rpc 下会让 RPC select 和网页对话框同时竞速，网页先答就 abort 本地 select                                                                                               | `src/ask-user/index.ts:144-200`；marker 为 `src/ask-user/channel-handler.ts:4`                                  | hub 对 marker select **不应答**，交给网页对话框；agent 不支持 `dialog.v1` 时自动取消（§4.4）                                                                                                                        |
| 项目信任：rpc 模式没有交互式信任提示，`hasUI` 为 false，未信任的目录不会加载项目本地 `.pi` 资源和扩展                                                                              | `main.js:564-611`；`core/project-trust.js:resolveProjectTrusted`（`!hasUI ⇒ false`）                            | 一条重要的安全属性：拉起时**绝不**传 `--approve`，也不传 `--no-approve`（否则会覆盖用户已经信任过的目录）                                                                                                           |
| 会话文件首行是 header，带 `cwd`                                                                                                                                                    | `~/.pi/agent/sessions/--<cwd>--/*.jsonl` 的首行 `{"type":"session",…,"cwd":…}`                                  | 「已知目录」的数据源（§4.5）                                                                                                                                                                                        |
| 写路径的 HTTP 管线：严格 CSRF → 鉴权 → 限流 → 读 body → 二次鉴权 → 审计                                                                                                            | `src/web-hub/hub/http.ts:1585-1700`（`dispatchCmdOrDialog`），LAN 分支 `:1124-1145`，loopback 分支 `:2081-2101` | spawn 端点复用这些闸门函数，不复用 cmd 路由器                                                                                                                                                                       |
| cmd 路由器以 agentKey 为目标，按 agent 的 hello caps 准入，并转发到 agent 侧台账                                                                                                   | `src/web-hub/hub/commands.ts:84-104`、`:644`                                                                    | spawn 没有目标 agent（可能一个 agent 都没连着），**不能**做成 cmd op                                                                                                                                                |
| confirm 先例：`E_CONFIRM_REQUIRED` 后由客户端带 `confirm:true` 重发                                                                                                                | `agent/builtin-bridge.ts:110-113,357-359`；`messages.ts:178-185`                                                | spawn 沿用这个两段式，但把确认**绑定到解析后的真实路径**（§6.3）                                                                                                                                                    |
| 审计只记白名单字段                                                                                                                                                                 | `src/web-hub/hub/audit.ts:1-60`                                                                                 | 新增 `auditSpawn`                                                                                                                                                                                                   |
| supersede 的「静默」判据只看对话框、在途命令和 kdf                                                                                                                                 | `src/web-hub/hub/supersede.ts:193`                                                                              | 要加上「拉起的 agent 不在忙」（§7.3）                                                                                                                                                                               |

## 3. 选型结论：hub 直接 spawn `pi --mode rpc`

### 3.1 三方案对比

| 维度              | **A. hub 直接 spawn `pi --mode rpc`（选中）**                                     | B. 复用/改造 ChildSpawner                                                                                   | C. tmux 包一层 TUI                                                   |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 拉起方            | hub daemon（常驻、不 import pi）                                                  | 必须是某个 pi 进程（它在 runtime 里）                                                                       | hub 调用 `tmux new-session -d`                                       |
| cwd 隔离          | 真正的独立 OS 进程，cwd 由 `spawn({cwd})` 决定                                    | 同进程 SDK 会话；`process.cwd()` 是进程级的，换不了；扩展缓存按 cwd 失效（`docs/dev/web-hub/arch.md` §3.2） | 独立进程                                                             |
| 注册进 hub        | **零改动**：post-guard 的 `wireWebHub` 在 rpc 下 attach（`agent/index.ts:561`）   | 子会话被 HOST_KEY 拦在 post-guard 之外（`src/index.ts:222`）；要放开就得拆掉「子会话 inert」这个核心不变量  | 零改动（TUI 本来就注册）                                             |
| web 收发消息      | 现有 cmd 通道全部可用；ask_user 走网页对话框                                      | 只能经父进程的 `steer_subagent`，不是一等 agent                                                             | 全部可用                                                             |
| 其他扩展对话框    | hub 是 stdio 的唯一客户端：v1 自动取消，以后可以做网页代答                        | —                                                                                                           | 只能在终端里答（和现有 TUI agent 一样）                              |
| 生命周期与零 hang | stdin 绑在 hub 上：hub 一死就 EOF，pi 有序退出，**天然不会有孤儿**；exit 事件精确 | 跟着父 pi 进程走，父进程 `/reload`、退出都会把它带走                                                        | hub 拿不到 exit 事件，只能轮询；tmux server 独立于 hub，孤儿要自己管 |
| 跨 hub 重启存活   | ✗（hub 升级 / 重启会结束这些会话；会话文件还在，可以「重新打开」，§7.4）          | ✗                                                                                                           | ✓（最大的优点）                                                      |
| 外部依赖          | 无                                                                                | 无                                                                                                          | tmux 二进制、pty、终端尺寸                                           |
| 资源              | 一个 node 进程，不渲染                                                            | 共享父进程                                                                                                  | 外加一个 TUI 渲染循环（CPU）和 tmux server                           |
| 与原架构的一致性  | 就是 `docs/dev/web-hub/arch.md` §5.3 / K-3 / K-9 的既定方案                       | 与 §11「SDK 进程内会话」这一被否决的方案同类                                                                | 原架构未考虑                                                         |

**结论：A。** B 走不通：cwd 是进程级的，而且注册必须打破 HOST_KEY 不变量。C 唯一的优势是能跨 hub 重启存活，代价是外部依赖、拿不到 exit 事件、孤儿管理和 TUI 渲染开销；A 用「会话文件可以重新打开」的办法，以较低成本弥补这个缺口。C 记作扩展点：如果以后要做 `spawn.backend:"tmux"`，supervisor 的状态机（§7）不用变，只换启动/停止/存活探测三个函数。v1 不做。

### 3.2 rpc 模式下 wireWebHub 能走到哪一步（问题 1、2 的答案）

hub 拉起的 `pi --mode rpc` 是一个**顶层**进程：HOST_KEY 没被占（`src/index.ts:142`），所以完整走过 post-guard。只要 `settings.webHub.enabled=true`（拉起的进程和 hub 的拉起者读的是同一份 `~/.pi/agent/pi-subagent.json`），就会执行 `wireWebHub`（`src/index.ts:857`）→ `session_start` 时 `c.mode==="rpc"`，attach（`agent/index.ts:561-562`）→ `acquireConnection({kind:"rpc", headless:true})`（`:521-532`）→ 按确定性的 socket 路径连上现有 hub → 发 hello，registry 新建一张 `kind:"rpc"` 的卡片（`hub/registry.ts:307-339`，发布 `agent_up`）→ 发 `session` 帧 → 能力 `cmd.v1/dialog.v1/command.v1` 由 `capsExtra` 照常声明（`agent/index.ts:507-515`）。

注册链路天然成立，有三个前提：

1. 用户是用 `pi install` 安装的 pi-toolkit，settings.json 里列着它。如果父进程是用 `-e` 加载的，拉起的进程里**就没有这个扩展**，这和 AGENTS.md 里 todo #27 说的是同一类问题。这种情况走注册超时，诊断信息里给出提示（§7.2）。
2. `webHub.enabled=true`，否则同样超时。
3. 同 HOME、同 uid、同 `XDG_RUNTIME_DIR`：子进程继承 hub 的 env，这一条天然满足。

TUI 专属的部分会自动失效：`setStatusLine`、`ui.notify` 都在 `mode!=="tui"` 时直接返回（`agent/index.ts:286,389`）；LAN 初始密码在 rpc 下不显示（lan-plan §6.2）。这些都是预期行为。

## 4. 总体设计

### 4.1 模块划分与依赖方向

```
浏览器 UI (ui/src)                       hub daemon (src/web-hub/hub)                      新 pi 进程
──────────────────                       ────────────────────────────                      ──────────
NewSessionMenu ─┐                        http.ts ── (闸门复用) ──┐
DirPicker ──────┼─ transport.spawn* ───▶ spawn/routes.ts ───────┼─▶ spawn/supervisor.ts ──spawn()──▶ pi --mode rpc
SpawnRow/Badge ─┘   (POST/GET /api/headless*)                   │      │  ▲ stdin(持有) / stdout(读空)
state.js reducer ◀── SSE "spawns" ──────── sse/http publish ◀───┘      │  │ stderr(环形缓冲+落盘)
                                                                spawn/rpc-stdio.ts (扫描 extension_ui_request, 自动应答)
                                                                spawn/dirs.ts (路径校验 / 已知目录 / 子目录列表)
                                                                spawn/store.ts (spawns.json 持久化 + 孤儿回收)
                                         registry.ts ◀── hello{kind:"rpc", pid} ── hub.sock ── wireWebHub (零改动)
                                           └─ bus(agent_up/session/status/agent_down) ─▶ supervisor 按 pid 绑定
```

依赖方向不变：`hub → protocol ← agent`、`ui → (HTTP 契约)`。新增文件：

| 层       | 文件                                                                                                                                                              | 职责                                                                                                                                                       | 为什么必须存在                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| protocol | `src/web-hub/protocol/spawn.ts`（新）                                                                                                                             | `SpawnRequestBody`/`SpawnRecordWire`/`SpawnState`/`SpawnPolicyWire`/`DirListingWire` 类型与 typebox schema；`RPC_ASK_USER_TITLE` 常量                      | hub 和 UI 共享的契约；hub 不能 import `src/ask-user/`，所以 marker 在这里复制一份，由测试钉住两者相等 |
| protocol | `src/web-hub/protocol/proc-identity.ts`（从 `agent/proc-identity.ts` 下沉纯函数：`parseStartTicks`/`parseCmdline`/`readStartTicksNow`，agent 侧原文件 re-export） | hub 回收孤儿时需要读 `/proc/<pid>/stat` 的 starttime                                                                                                       | hub 不能 import `agent/`；纯搬移，不改行为                                                            |
| protocol | `http-contract.ts`（追加）                                                                                                                                        | `SSE_EVENTS` 加 `"spawns"`；`API_ERRORS` 加 `E_SPAWN_DENIED`/`E_DIR`/`E_LIMIT`/`E_LAUNCHER`/`E_SESSION_IN_USE`                                             | 冻结数组只追加                                                                                        |
| protocol | `version.ts`（追加）                                                                                                                                              | 导出 `SPAWN_HUB_CAP = "spawn.v1"`，不并入 `P2_HUB_CAPS`，按配置条件追加                                                                                    | 关闭时 caps 字节不变                                                                                  |
| hub      | `src/web-hub/hub/spawn/supervisor.ts`（新）                                                                                                                       | 进程表、状态机（§7）、spawn/stop/kill 升级、按 pid 绑定 registry、计数、关停                                                                               | 核心                                                                                                  |
| hub      | `src/web-hub/hub/spawn/rpc-stdio.ts`（新，纯函数 + 小状态）                                                                                                       | stdout 行扫描器（只解析 `{"type":"extension_ui_request"` 开头的行，超长行直接丢弃），生成应答                                                              | 隔离 pi 的 rpc 协议面，方便测试                                                                       |
| hub      | `src/web-hub/hub/spawn/dirs.ts`（新）                                                                                                                             | 路径规范化 / realpath / 准入判断；已知目录扫描（带缓存）；子目录列表                                                                                       | 安全核心，必须能单测                                                                                  |
| hub      | `src/web-hub/hub/spawn/store.ts`（新）                                                                                                                            | `<stateDir>/spawns.json` 原子写（0600）、启动时读取和孤儿回收                                                                                              | 生命周期跨 hub 重启                                                                                   |
| hub      | `src/web-hub/hub/spawn/routes.ts`（新）                                                                                                                           | 4 个 HTTP 端点的处理函数，loopback 和 LAN 两个 listener 共用                                                                                               | 把 http.ts 的改动压到「接线」两行                                                                     |
| hub      | `http.ts`（改）                                                                                                                                                   | loopback `handleApi` 和 LAN 分支把 `/api/headless*` 改为调用 `spawnRoutes`；未配置时保持 501                                                               | —                                                                                                     |
| hub      | `hub.ts`（改）                                                                                                                                                    | 构造 supervisor；`idle.counts().headless = supervisor.liveCount()`；`close()` 先 `supervisor.shutdown()`；supersede 静默判据接入；caps 条件追加 `spawn.v1` | 装配                                                                                                  |
| hub      | `ports.ts`（改）                                                                                                                                                  | `HubConfig.spawn?: HubSpawnConfig`                                                                                                                         | 配置经 env 快照下发（和 `lan` 同一套范式）                                                            |
| hub      | `audit.ts`（改）                                                                                                                                                  | `auditSpawn(log, SpawnAuditRecord)`                                                                                                                        | 审计                                                                                                  |
| agent    | `src/config/settings.ts`（改）                                                                                                                                    | 解析 `webHub.spawn` 块                                                                                                                                     | —                                                                                                     |
| agent    | `src/web-hub/agent/index.ts:486-505`（改 `buildHubConfig`）                                                                                                       | `spawn.enabled` 为真时才写入 `config.spawn`                                                                                                                | 关闭时 `PI_WEBHUB_CONFIG` 深相等                                                                      |
| agent    | `/webhub status`（可选，一行）                                                                                                                                    | `spawn=on roots=N lan=off`                                                                                                                                 | 可观测                                                                                                |
| ui       | `transport/types.ts` + `token.ts`/`password.ts`                                                                                                                   | `spawnPolicy()`/`listDirs()`/`spawn()`/`stopSpawn()`                                                                                                       | —                                                                                                     |
| ui       | `logic/state.js`                                                                                                                                                  | `spawns` 事件进 reducer：`state.spawns: Map<spawnId, SpawnRecordWire>`                                                                                     | 单一状态源                                                                                            |
| ui       | `components/spawn/{NewSessionMenu,DirPicker,SpawnRow}.vue`（新）+ `composables/useNewSession.ts`（新）                                                            | 入口菜单、目录选择、启动中/失败占位行                                                                                                                      | §8                                                                                                    |

**agent 侧 hello、connection 和事件 tap 一律不改**，这是选 A 的主要收益之一。

### 4.2 拉起命令

```ts
// supervisor.ts（契约，非实现）
argv = [
  launcher[1],
  "--mode",
  "rpc",
  ...(model ? ["--model", model] : []),
  ...(sessionFile ? ["--session", sessionFile] : []),
];
child = spawn(launcher[0], argv, {
  cwd: resolvedCwd, // 必须是 realpath 之后的结果，永远不用用户原始字符串
  detached: true, // 独立进程组 ⇒ pid == pgid，用 kill(-pid) 结束整组
  stdio: ["pipe", "pipe", "pipe"],
  env: childEnv(process.env), // 见下
});
child.unref(); // 不阻止 hub 退出；hub 退出由 close() 显式收尾
```

- **launcher 的来源顺序**：① `HubConfig.launcher`（拉起 hub 的那个 pi 进程，`agent/index.ts:493`）；② 最近一个 `pluginVersion === hub.pluginVersion` 的 live agent 的 `hello.launcher`。两者都要满足：`launcher[0]` 是绝对路径且能 stat 到，`launcher[1]` 以 `.js`/`.mjs`/`.cjs` 结尾或者是一个可执行文件。都拿不到时返回 `503 E_LAUNCHER`。v1 **不提供** `piCommand` 覆盖：wrapper 会破坏 pid 绑定（§5 D3）。
- **childEnv**：从 hub 的 env 里删掉所有 `PI_WEBHUB_*` 键（`CONFIG`/`LAUNCHER`/`DB_*`/测试键），再设 `PI_WEBHUB_HEADLESS=1`。其余照常继承（HOME/PATH/provider key/XDG_RUNTIME_DIR）。已知取舍：hub 的 env 是「当初拉起 hub 的那个 pi 进程」的 env 快照，之后用户 shell 里新增的环境变量看不到（§9 R4）。
- **参数注入防护**：`model` 必须匹配 `^[A-Za-z0-9][\w.-]*/[\w.:@-]+$`，长度 ≤128，不能以 `-` 开头；`sessionFile` 只能来自 hub 自己的 spawn 记录（S2 的「重新打开」，§7.4），**不接受**浏览器传任意路径。`cwd` 不进 argv。
- **绝不传** `--approve`、`--no-approve`、`-e`、`--no-extensions`（理由见 §2 的项目信任行与 §3.2 前提 1）。

### 4.3 「受管 agent」与 registry 的关联

supervisor 订阅 `registry.bus`（`hub/ports.ts:412`）：

- `agent_up{agent}`：如果 `agent.pid` 等于某条 `starting` 记录的 `child.pid`，就绑定 `agentKey`，记录保持 `starting` 直到 `session` 事件到达。
- `session{agentKey}`：已绑定的记录进入 `live`，写入 `sessionFile`。
- `agent_down{agentKey}`：只把 `linked=false` 记下来；进程真相仍以 child 的 `exit` 为准。agent 断开但进程活着，说明 socket 掉了，正在重连，卡片上显示为 stale。

AgentCard 的形状**不改**。UI 用 `spawns[].agentKey` 去关联卡片，以此决定显示「web」徽标和「停止」按钮。只有受管 agent 才能从网页停止，TUI 进程永远不能。

### 4.4 stdio 处理（rpc-stdio.ts）

| stdout 行                                                                       | 处理                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不以 `{"type":"extension_ui_request"` 开头（会话事件、response 等，占绝大多数） | 不解析，直接丢弃（事件以 socket 通道为准）                                                                                                                                                                                |
| 超过 64 KiB 还没遇到换行                                                        | 进入丢弃模式，直到下一个 `\n`，不做累积分配                                                                                                                                                                               |
| `method ∈ {notify,setStatus,setWidget,setTitle,set_editor_text}`                | 忽略（这些是 fire-and-forget，不需要应答）                                                                                                                                                                                |
| `method==="select"` 且 `title === RPC_ASK_USER_TITLE`                           | 绑定的 agent caps 含 `dialog.v1` 时**不应答**（网页对话框竞速获胜后 pi 侧会 abort 掉这个 select，`src/ask-user/index.ts:161-167`）；否则立即回 `{type:"extension_ui_response",id,cancelled:true}`，防止 ask_user 永远挂着 |
| `method ∈ {select,confirm,input,editor}`（其他扩展）                            | 立即回 `{…,id,cancelled:true}`（confirm 因此得到 `false`，是安全的缺省值）；在记录里追加 `uiCancelled`（只留最近 3 条，`{method,title≤120 字,at}`），UI 提示「该扩展请求的对话框已自动取消，网页暂不支持」                |

stdin 只用来写这些应答和最后的关闭；写操作挂 `error` 监听（EPIPE）。stderr 写入 64 KiB 环形缓冲，同时追加到 `<stateDir>/spawn/<spawnId>.stderr.log`（0600，单文件上限 256 KiB，满了截断重写，只保留最近 20 个文件）。**stdout 不落盘**：内容是完整对话，涉及隐私，而且体积大。

### 4.5 目录准入（dirs.ts）

**已知目录**按以下来源取并集：① registry 里所有卡片（live 和 stale）的 `cwd`；② `~/.pi/agent/sessions/*/` 下最近 30 天修改过的最新一个 `.jsonl`，读前 4 KiB 的 header 取 `cwd`；③ spawns.json 历史记录里的 `cwd`。每一项再做 realpath，存在且是目录才保留。按最近活动时间倒序，最多 50 条，缓存 60 秒，整次扫描受 2 秒 deadline 约束（超时就返回已扫到的部分，并标 `partial:true`）。

**准入判定** `admitDir(raw, policy) → {ok:true, cwd, known:boolean} | {ok:false, reason}`：

1. 拒绝 NUL、长度大于 4096、空串；`~` 或 `~/` 开头的展开为 `config.home`；展开后必须是绝对路径（`not-absolute`）。
2. `fs.realpath`（2 秒 deadline）→ 不存在报 `not-found`；`stat` 不是目录报 `not-dir`；`access(R_OK|X_OK)` 失败报 `no-access`。
3. `known = realpath ∈ 已知目录集合`。
4. 允许的条件：`known`，或者 `realpath` 落在某个 `roots[i]`（同样先 realpath）之下且**按路径段对齐**（`/home/a` 不能匹配 `/home/ab`）。否则报 `not-allowed`。
5. LAN 策略的收紧在路由层处理（§6.2）。

子目录列表 `listChildren(path)`：仅当 `path` 落在 roots 之内（和第 4 步同一套判定）时才可用；`opendir` 逐项读取，只返回目录名，最多 200 项，默认不含点目录（前缀以 `.` 开头时才包含），2 秒 deadline。

## 5. 关键决策

| #   | 决策                                                                           | 备选                                                    | 理由                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 拉起形态选 A（hub spawn `pi --mode rpc`）                                      | B ChildSpawner / C tmux                                 | §3.1                                                                                                                                                                                                                                                                                                          |
| D2  | 新开 HTTP 端点 `/api/headless*`，不新增 cmd op                                 | `cmd{op:"spawn_session"}`                               | cmd 以 agentKey 为目标（`hub/commands.ts:84-104`，`parseCmdBody` 要求 agentKey），按 agent caps 准入，台账在 agent 侧；spawn 是 hub 本地操作，并且必须在一个 agent 都没有的时候也能用。端点名沿用早已预留的 `/api/headless`（`http.ts:2135`、`docs/dev/web-hub/plan.md:658`），不再另起名字                   |
| D3  | registry 绑定按 **pid** 匹配（`hello.agentId.pid === child.pid`），不用 ticket | env `PI_WEBHUB_TICKET` + `hello.ticket`                 | 用 launcher 直接 spawn node 时 pid 必然相等；只要 hub 持有 child 句柄且未回收，pid 就不可能被复用。agent 侧零改动，不需要改 env 也不用担心 env 泄漏：ticket 会经 bash 工具泄漏给嵌套的 pi，还得额外加清除逻辑。代价是不支持 wrapper 命令。`hello.ticket` 和 `E_TICKET` 继续保留给以后的 `piCommand`/tmux 后端 |
| D4  | 生命周期不超过 hub（stdin 绑定），不提供 Detach                                | 子进程脱离 hub 常驻                                     | stdin EOF 带来有序退出，是零 hang 的天然兜底，也不会有孤儿；常驻需要重新接管 stdio，而 node 做不到跨进程转交 fd。缺口用「会话文件可重新打开」补上（§7.4）。沿用原架构 K-9                                                                                                                                     |
| D5  | HTTP 返回 202 + SSE `spawns` 槽位推送进度，hub **不代为转发首条 prompt**       | 同步等注册完再返回；hub 先排队首条 prompt，注册完再转发 | pi 启动包含扩展加载和最长 15 秒的 model runtime（`main.js` `modelRuntimeSignal: AbortSignal.timeout(15_000)`），会超出写请求 13 秒的总预算（`WRITE_TOTAL_MS`，`http.ts:103`）。由 UI 在 `live` 之后再走现有 `/api/cmd`，cmd 通道「目标在线」的假设就自然成立，hub 也不用再造一个带 deadline 的转发队列        |
| D6  | `spawns` 采用覆盖式槽位帧（每次推全量列表，最多 24 条）                        | 增量事件                                                | 与 `dialogs/ctl/commands` 的槽位范式一致（control-plan D1/D2），断线重连后不需要对账                                                                                                                                                                                                                          |
| D7  | 默认只允许「已知目录」，任意目录必须显式配置 `roots`                           | 默认放开 `~` 下所有目录                                 | 已知目录都是用户亲自跑过 pi 的地方，最小意外；roots 是用户自己声明的信任范围                                                                                                                                                                                                                                  |
| D8  | 确认（confirm）绑定 `expectCwd`（解析后的 realpath），无状态                   | `confirm:true` 布尔；服务端 nonce                       | 让用户确认的是**真实目标**（符号链接解析之后的路径），同时保持无状态；实际 spawn 用的就是这个 realpath，所以确认后再替换符号链接也没有意义                                                                                                                                                                    |
| D9  | 其他扩展的对话框在 v1 一律自动取消                                             | 让它挂着；hub 当完整的 extension_ui 客户端              | 挂着就是 hang；完整代答属于 S3。取消对 confirm 的语义是 `false`，是安全的                                                                                                                                                                                                                                     |
| D10 | 空闲回收默认关闭（`idleMinutes:0`）                                            | 原架构的 30 分钟                                        | 不在忙的 rpc agent 可能还挂着 bash job 或 cron 计划，hub 看不到这些；数量由 `maxProcesses` 兜底。用户需要时可以自行开启                                                                                                                                                                                       |
| D11 | 设置经 `HubConfig.spawn` 快照下发，改了需要 `/webhub restart` 才生效           | hub 直接读 settings 文件                                | 和 `lan` 同一套范式；hub 不读 pi 的设置文件（`docs/dev/web-hub/arch.md` §13.3 末尾）                                                                                                                                                                                                                          |

## 6. 安全模型

### 6.1 威胁与对策

基线：已登录的网页主体本来就能经 `prompt` 让 agent 执行 bash，web-hub 在设计上就等价于一个远程 shell（`docs/dev/web-hub/arch.md` §9 的「同用户进程」行、K-10）。spawn **没有带来新的能力类别**，只扩大了两样东西：一是可以选择任意 cwd，二是无需任何已在线的 agent 就能执行。因此对策的重点是：不让这个入口比 prompt 更容易被滥用，并且留下审计记录。

| 威胁                                              | 对策                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 跨站伪造（CSRF/DNS rebinding）                    | 全部复用：Host 白名单（421）、`strictCsrfOk`（JSON + `X-PWH:1` + 同源 Origin + `Sec-Fetch-Site`，`http.ts:1477-1491`）、`SameSite=Strict` cookie。GET 端点也必须带 cookie，并且只返回 JSON |
| 未登录访问                                        | loopback 用 `auth.check`，LAN 用 `requireLanSession` 加二次鉴权（照抄 `dispatchCmdOrDialog` 的步骤 ⑦），确保登出或轮换 token 的竞态里不会漏过一次 spawn                                    |
| 在任意目录执行，比如去加载恶意项目里的 `.pi` 扩展 | 准入限定为已知目录或 roots（§4.5）；rpc 模式下项目信任默认是 false，未信任的项目资源不会加载（§2）；绝不传 `--approve`                                                                     |
| 参数注入                                          | cwd 只出现在 `spawn({cwd})`，不进 argv；model 走白名单正则；sessionFile 只取自 hub 自己的记录                                                                                              |
| 符号链接或路径穿越绕过 roots                      | 先 realpath，再做按路径段对齐的前缀判断；spawn 使用 realpath                                                                                                                               |
| 耗尽资源（fork 炸弹）                             | `maxProcesses`（默认 4，统计所有非终态记录）；同时处于 `starting` 的最多 2 个；每个主体 60 秒内最多 3 次（复用 `cmdLimit` 的令牌桶）；超出分别返回 `409 E_LIMIT` 或 `429 E_RATE`           |
| 枚举文件系统（目录列表泄露目录名）                | 子目录列表只在 roots 之内可用；只返回目录名；有条数上限；LAN 策略低于 `roots` 时直接禁用                                                                                                   |
| LAN 明文：嗅探到 cookie 后重放                    | §6.2：LAN 默认关闭；明文直连时最多只能用已知目录，而且每次都要确认                                                                                                                         |
| 网页误点（一键拉起）                              | 未知目录或 LAN 下强制两段确认（§6.3）；UI 显示解析后的路径                                                                                                                                 |
| 伪装成受管 agent（同 uid 进程伪造 hello）         | 同 uid 视为完全可信（原 §9）；pid 绑定只认 hub 自己的 child pid。伪造者最多冒充一张普通卡片，拿不到「停止」或其他受管语义                                                                  |
| 审计缺失                                          | §6.4                                                                                                                                                                                       |
| 拉起的进程反过来拉起 hub，形成回环                | 设置 `PI_WEBHUB_HEADLESS=1`（`launcher.ts:148`）                                                                                                                                           |

### 6.2 策略配置（`webHub.spawn`，经 `HubConfig.spawn` 下发）

| 键                 | 默认    | 说明                                                                                                                             |
| ------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`          | `false` | 总开关；关闭时 `HubConfig` 里没有 `spawn` 键，`/api/headless*` 保持 501，caps 也不带 `spawn.v1`                                  |
| `roots`            | `[]`    | 允许选任意子目录的根目录（绝对路径或 `~` 开头）；为空时只允许已知目录                                                            |
| `maxProcesses`     | `4`     | 非终态记录的上限                                                                                                                 |
| `lan`              | `"off"` | `off` / `known` / `roots`：LAN listener 的上限。**明文直连**时（`ctx.scheme==="http"` 且不经受信代理）无论怎么配都封顶为 `known` |
| `idleMinutes`      | `0`     | 在 `agent_settled`、无 subagent、无 SSE 订阅的状态下持续这么久就停止；`0` 表示不回收（S2 实现）                                  |
| `registerTimeoutS` | `30`    | 从 spawn 到收到 `session` 帧的 deadline                                                                                          |

### 6.3 确认流（两段式，绑定真实路径）

```
POST /api/headless {id, cwd:"~/proj"}
  → 闸门 → admitDir ⇒ {cwd:"/home/u/proj", known:false}
  → needsConfirm = (listener==="lan") || !known
  → 请求未带 confirm 或 expectCwd≠cwd ⇒ 409 {error:"E_CONFIRM_REQUIRED", resolvedCwd:"/home/u/proj", reason:"unknown-dir"|"lan"}
UI 弹出确认框（显示 resolvedCwd，注明「将在此目录启动新的 pi 进程」，LAN 下另加一行明文警告）
POST /api/headless {id(同一个), cwd:"~/proj", confirm:true, expectCwd:"/home/u/proj"}
  → 重新 admitDir，cwd 必须严格等于 expectCwd（否则再回 409，带新的 resolvedCwd）→ spawn
```

确认只是 UX 层的防误触，**不是**安全边界：拿到 cookie 的攻击者可以直接带上 confirm。安全边界是鉴权、CSRF、准入和限额，这一点要在文档里写明。

### 6.4 审计

`auditSpawn(log, record)` 写入 `hub.log`（0600），`audit:"spawn"`：

```ts
interface SpawnAuditRecord {
  phase: "request" | "reject" | "state";
  reqId?: string;
  listener?: "loopback" | "lan";
  ip?: string;
  user?: string;
  spawnId?: string;
  cwd?: string /* realpath；路径属于取证必需字段，例外允许记录 */;
  known?: boolean;
  model?: string | null;
  pid?: number;
  state?: SpawnState;
  code?: string | null;
  endReason?: SpawnEndReason;
  exitCode?: number | null;
  signal?: string | null;
  ms?: number;
}
```

rejected 也要记录（CSRF 和 E_AUTH 由闸门统一写 reject 行，429 沿用 `RATE_AUDIT_WINDOW_MS` 去重）。每次状态迁移写一条 `phase:"state"`。不记录 stderr 内容（它在单独的 0600 文件里）。

## 7. 生命周期

### 7.1 状态机（每条 spawn 记录）

```
            spawn() 同步抛错 / 'error'
  ┌──────────────────────────────────────────────▶ failed{spawn_error}
  │
(admit)──▶ starting ──agent_up(pid 匹配)──▶ starting(bound) ──session 帧──▶ live
  │          │  │                                   │                       │
  │          │  └─ registerTimeoutS 到期 ─▶ stopping{register_timeout} ─▶ failed{register_timeout}
  │          └──── exit（未 live）──────────────────────────────────────▶ failed{exited_early}
  │                                                                        │
  │      live ──用户 stop / 空闲回收 / hub 关停 / supersede──▶ stopping ──exit──▶ exited{user|idle|hub}
  │      live ──exit（非 stopping 状态下）────────────────────────────────▶ exited{crash}
  │      stopping 内的升级：关 stdin ─5s─▶ SIGTERM(-pgid) ─3s─▶ SIGKILL(-pgid)（共 8s）
  └── hub 启动时：持久化里的非终态记录 ─▶ §7.3 孤儿回收 ─▶ exited{orphan}
```

- 终态：`failed`、`exited`。每次迁移都持久化（防抖 200ms，原子 rename），并推送 `spawns`。
- 终态记录保留最近 20 条（UI 用于「最近结束」和「重新打开」），失败记录带 `stderrTail`（最后 4 KiB，UI 用 `textContent` 显示）。
- `live` 期间 `agent_down` 只把 `linked=false` 记下，不改变状态；agent 重连认领后 `linked=true`。
- 只有 `exit` 事件能把记录推进终态（进程真相）。exit 之后就不会再从 registry 查 pid，也就不存在 pid 复用的风险。

### 7.2 失败诊断（注册超时）

`failed{register_timeout}` 的 `hint` 按顺序判断：stderr 里有 `Error`/`ENOENT` ⇒ 原样带上 stderr 尾部；否则给固定提示「新进程未连上 hub：确认 pi-toolkit 是用 `pi install` 安装的（不是 `-e`），并且 `webHub.enabled=true`」。

### 7.3 hub 侧收尾

| 场景                                                                                                  | 行为                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hub `close()`（idle 不会发生：子进程存在时 `headless>0`；其余场景为 signal/stop/restart/fence/crash） | `supervisor.shutdown()` 放在 `fe.close()` 之前：所有子进程同时关 stdin → 在 `bounded`（3 秒，`hub.ts:85`）内等它们退出 → 仍存活的 `kill(-pid,"SIGTERM")` → 持久化 → 返回。不等 SIGKILL，残留交给下一个 hub 的孤儿回收。整体仍在 `HUB_CLOSE_DEADLINE_MS=10s`（`hub.ts:83`）之内                                                           |
| hub 被 SIGKILL 或崩溃                                                                                 | 子进程收到 stdin EOF，pi 有序退出（`rpc-mode.js:641-644`）。没来得及持久化终态的记录交给下次启动回收                                                                                                                                                                                                                                     |
| 下次 hub 启动（孤儿回收）                                                                             | 读 spawns.json，对每条非终态记录：pid 还活着，**并且** `/proc/<pid>/stat` 的 starttime 等于记录值，**并且** cmdline 含 `--mode rpc` ⇒ SIGTERM，3 秒后 SIGKILL（unref timer，不阻塞启动）；身份对不上 ⇒ 什么也不做（pid 已被复用）。两种情况都记为 `exited{orphan}`。非 Linux 读不到 starttime 时**不发信号**，只标记（宁可漏杀也不误杀） |
| supersede（版本替换）                                                                                 | 静默判据（`supersede.ts:193`）增加「受管 live agent 都不忙」（从 registry 的 `status.busy` 读）；强制路径（30 分钟上限）照常。`hub-state-banner` 文案增加「N 个网页会话将结束，可在新 hub 中重新打开」                                                                                                                                   |
| `/webhub stop`、`restart`                                                                             | TUI 侧提示中显示受管进程数（读 hub.json 的 `spawn.count`，由 hub 维护）；不阻止操作                                                                                                                                                                                                                                                      |

### 7.4 「重新打开」和「在终端继续」（替代 Detach，S2）

- 终态记录如果带 `sessionFile`，UI 提供「重新打开」：`POST /api/headless {id, reopen: spawnId}`，hub 以记录里的 cwd 和 sessionFile 拉起 `--session <file>`（cwd 照样要通过 admitDir 再验一遍）。准入时检查 registry 里没有任何 live 卡片的 `session.sessionFile` 等于该文件，否则返回 `409 E_SESSION_IN_USE`（防止两个进程同时写一个 jsonl）。
- 「在终端继续」：UI 只显示一条可复制的 `cd '<cwd>' && pi --session '<file>'`，并提示「先在网页停止此会话」。hub 不做任何事。这就是 v1 的 Detach 语义。

## 8. 接口契约

### 8.1 protocol/spawn.ts（草案）

```ts
export type SpawnState = "starting" | "live" | "stopping" | "exited" | "failed";
export type SpawnEndReason =
  "user" | "idle" | "hub" | "crash" | "orphan" | "spawn_error" | "register_timeout" | "exited_early";
export const RPC_ASK_USER_TITLE = "\0XYZ_ASK_USER"; // 必须 === src/ask-user/channel-handler.ts ASK_USER_MARKER（测试钉死）

export interface SpawnRecordWire {
  spawnId: string; // "sp_" + 12 位 base64url
  cwd: string; // realpath
  model?: string;
  state: SpawnState;
  createdAt: number;
  updatedAt: number;
  pid?: number;
  agentKey?: string; // 绑定后才有
  linked?: boolean; // registry 卡片当前是否 live
  sessionFile?: string;
  origin: { listener: "loopback" | "lan"; user?: string; clientId: string /* 请求 id，UI 用来认领「我发起的」 */ };
  endReason?: SpawnEndReason;
  exit?: { code: number | null; signal: string | null };
  hint?: string; // §7.2
  stderrTail?: string; // 仅 failed，≤4 KiB
  uiCancelled?: Array<{ method: string; title?: string; at: number }>; // ≤3
}

export interface SpawnPolicyWire {
  allowed: boolean;
  reason?: "disabled" | "lan-off";
  browse: boolean; // 子目录列表是否可用（当前 listener 下的有效策略含 roots）
  confirm: "always" | "unknown-dir"; // LAN = always
  max: number;
  active: number;
}

export interface DirEntryWire {
  path: string;
  lastActiveAt?: number;
  source: "agent" | "session" | "spawn";
}
export interface DirListingWire {
  recent: DirEntryWire[];
  partial?: true;
  path?: string;
  children?: string[];
  truncated?: true; // 仅在请求了 path 且 browse 可用时出现
}

export interface SpawnRequestBody {
  id: string; // 16–64 字符 base64url，主体内幂等
  cwd?: string; // ≤4096；与 reopen 二选一
  reopen?: string; // spawnId（S2）
  model?: string; // 白名单正则
  confirm?: true;
  expectCwd?: string;
}
```

`HubConfig`（`hub/ports.ts:353`）追加：

```ts
export interface HubSpawnConfig {
  roots: string[];
  maxProcesses: number;
  lan: "off" | "known" | "roots";
  idleMinutes: number;
  registerTimeoutS: number;
}
// HubConfig.spawn?: HubSpawnConfig   —— enabled=false 时不写这个键
```

### 8.2 HTTP 端点（两个 listener 都挂，闸门顺序与 `dispatchCmdOrDialog` 一致）

| 方法与路径                         | 请求                                   | 成功                                                      | 错误                                                                                                                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/headless`                | —                                      | `200 {policy: SpawnPolicyWire, items: SpawnRecordWire[]}` | 401 `E_AUTH`；未启用时 501 `E_NOT_IMPLEMENTED`                                                                                                                                                                                                                           |
| `GET /api/headless/dirs?path=`     | `path` 可选                            | `200 DirListingWire`                                      | 403 `E_SPAWN_DENIED`（LAN 为 off）；400 `E_DIR{reason}`（请求了 path 但不在 roots 内，或者 browse 不可用）                                                                                                                                                               |
| `POST /api/headless`               | `SpawnRequestBody`                     | `202 {spawnId, state:"starting", cwd, dup?:true}`         | 400 `E_BAD_REQUEST`；403 `E_SPAWN_DENIED`；400 `E_DIR{reason:"not-absolute"\|"not-found"\|"not-dir"\|"no-access"\|"not-allowed"}`；409 `E_CONFIRM_REQUIRED{resolvedCwd,reason}`；409 `E_LIMIT`；409 `E_SESSION_IN_USE`；429 `E_RATE`；503 `E_LAUNCHER`；504 `E_DEADLINE` |
| `POST /api/headless/:spawnId/stop` | `{force?: true}`（force 直接 SIGKILL） | `202 {state}`（已在终态时幂等返回当前状态）               | 404 `E_NOT_FOUND`；403 `E_SPAWN_DENIED`                                                                                                                                                                                                                                  |

- 幂等：用 `principal|id` 作 LRU 键（256 条，10 分钟）→ spawnId。同 id 再次请求时，载荷摘要相同就返回 `dup:true`；摘要不同（确认重发的情况除外：只多了 `confirm`/`expectCwd`，视为同一意图）返回 `409 E_BAD_REQUEST`。确认被拒的那一次（409）**不**写 LRU。
- POST 的写闸门顺序：Host → strictCsrf → authorize → 启用/LAN 策略 → 限流 → 读 body（≤4 KiB）→ schema → 幂等预查 → admitDir（2s deadline）→ 确认判断 → 二次鉴权 → 限额（同步段）→ 获取 launcher → spawn → 202。从二次鉴权到 spawn 之间没有 await，和 `http.ts:1700` 附近的「最后一个 await」规则一致。
- 路由接线：loopback 是 `http.ts:2135` 那行；LAN 在 `:1145` 的 csrf 判断之后增加同样的分派。SSE：在 `SSE_EVENTS` 末尾追加 `"spawns"`，payload 为 `{items: SpawnRecordWire[]}`；SSE 首次 hello、resync 快照中跟在 `agents` 之后发送一次。hub `caps` 只在启用时追加 `"spawn.v1"`（`hub.ts:227`）。

### 8.3 UI 契约

```ts
// transport/types.ts（追加）
interface HubTransport {
  spawnPolicy(): Promise<{ policy: SpawnPolicyWire; items: SpawnRecordWire[] }>;
  listDirs(path?: string): Promise<DirListingWire>;
  spawn(req: SpawnRequestBody): Promise<SpawnOutcome>; // SpawnOutcome = {ok:true,spawnId,cwd,dup?} | {ok:false,error,resolvedCwd?,reason?,retryable}
  stopSpawn(spawnId: string, force?: boolean): Promise<{ ok: boolean; state?: SpawnState; error?: string }>;
}
// composables/useNewSession.ts
type NewSessionAction =
  | { kind: "same-cwd"; agentKey: string; cwd: string; enabled: boolean } // 现有的 /new
  | { kind: "pick-dir"; enabled: boolean; reason?: string }; // spawn.v1 ∧ policy.allowed
```

## 9. 数据流

```
浏览器                         hub                                          新 pi 进程
  │ GET /api/headless/dirs       │ dirs.known()（缓存 60s）                    │
  │◀──── recent[] ───────────────│                                            │
  │ POST /api/headless {id,cwd}  │ 闸门→admitDir→(409 确认)→限额               │
  │──(确认后重发)───────────────▶│ supervisor.start(): spawn ────────────────▶│ pi --mode rpc（cwd=realpath）
  │◀── 202 {spawnId} ────────────│ 记录 starting；推 SSE spawns               │ 加载扩展 → wireWebHub
  │◀── SSE spawns(starting) ─────│                                            │ session_start(rpc) → attach
  │                              │◀──────── hub.sock hello{kind:rpc,pid} ─────│
  │◀── SSE agent_up ─────────────│ registry 建卡片 → bus agent_up → 按 pid 绑定│
  │                              │◀──────── session 帧 ───────────────────────│
  │◀── SSE spawns(live,agentKey)─│ 记录 live；持久化                          │
  │ UI：发起方标签自动选中该卡片   │                                            │
  │ POST /api/cmd {agentKey,prompt}（现有通道，不变）────────────────────────▶│
  │◀── SSE ev/status/dialogs ────│◀──────── ev / status / dialogs ────────────│
  │                              │◀──── stdout JSONL（读空；只有 ui_request 才应答）│
  │ POST /api/headless/:id/stop  │ 关 stdin ─5s→ TERM ─3s→ KILL               │ EOF → 有序 shutdown → exit
  │◀── SSE spawns(exited) / agent_down ─│ exit 事件 → 终态 → 持久化           │
```

### 9.1 UI 形态与「新建会话」按钮的演进（问题 4、6）

- **现状**（进行中的改动）：AGENTS 面板标题栏有一个按钮，对选中的 agent 执行 `runCommand(key,"new","")`（`AgentList.vue:106-125,154-156`）。
- **演进**：这个按钮改成 `NewSessionMenu`（分裂按钮）。主按钮与现在行为一致；下拉里有两项：
  1. 「在 `<选中 agent 的 shortCwd>` 新建（/new）」：保持现有的 `newSessionEnabled` 公式不变；
  2. 「选择目录新建…」：打开 `DirPicker`，可用条件为 `hub caps ∋ spawn.v1 ∧ policy.allowed`，**不依赖选中 agent**。也就是说即使一个 agent 都没有，空状态（`EmptyState`）里也会出现这个入口。
- **对进行中改动的唯一建议**：把 `onNewSession`/`newSessionEnabled` 提取到 `composables/useNewSession.ts`，返回 `NewSessionAction[]`。这样 S1 只需要在数组里追加 `pick-dir`，AgentList 的模板不用重写。如果现在不提取，S1 再提取也只是一个本地重构，成本很低。
- **DirPicker**：顶部是路径输入框（预填选中 agent 的 cwd 或 `~`）。`policy.browse` 为真时，输入框随输入用 `listDirs(path)` 补全子目录（防抖 200ms）。下方是「最近目录」列表（`recent`，显示 shortCwd 和最近活动时间），点一下就填入输入框。可选的模型输入框放在 S3。提交后收到 409 `E_CONFIRM_REQUIRED` 时，切到确认视图显示 `resolvedCwd`，LAN 下另加明文警告。
- **SpawnRow**：`starting`/`failed` 状态的记录在 AgentList 顶部显示为占位行（转圈或错误摘要，可展开 stderrTail）；进入 `live` 后占位行消失，对应卡片带上 `web` 徽标。发起方标签（`origin.clientId` 等于本地发出的请求 id）在 live 时自动选中这张卡片。受管卡片的 DetailHeader 上有「停止」按钮（二次确认）。最近结束的记录放在「stale & offline」分组下，带「重新打开」入口（S2）。
- 所有文本都用 `textContent` 渲染，不得破坏 `no-innerhtml` 规则。i18n 在 `i18n/{en,zh}/spawn.ts` 新增；行内标记用英文 token（`web`、`starting`），提示性长文本用中文。

## 10. 需核实清单

| #   | 事项                                                                                                                                              | 核实方法                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| V1  | rpc 模式 stdout 中 `extension_ui_request` 行的首个 key 一定是 `"type"`（扫描器依赖这个前缀）                                                      | 读 `rpc-mode.js:77` 的 `output({type:"extension_ui_request",id,...request})` 与 `serializeJsonLine`；conformance 测试用真实 pi 钉住 |
| V2  | `ui_prompt_start`/`dialogs` 在 rpc 下对 ask_user marker 的展示与 hub 自动应答不冲突（marker select 不应答时，网页对话框出现，答完后 pi 侧 abort） | integration：用假 rpc 子进程，加真机 tmux 验收                                                                                      |
| V3  | pi 启动到 `session_start` 的典型耗时（决定 `registerTimeoutS=30` 是否够用）                                                                       | 真机：`time` 测 `pi --mode rpc` 在冷缓存下到 hello 的时间                                                                           |
| V4  | stdin EOF 后 `runtimeHost.dispose()` 的上界（是否会被 bash job 或 subagent 拖住）                                                                 | 真机：带一个运行中的 subagent 去 stop，观察是否进入 SIGTERM                                                                         |
| V5  | `--session <file>` 配合 `--mode rpc` 恢复会话（原 K6）                                                                                            | 真机                                                                                                                                |
| V6  | 项目信任：某目录在 trustStore 里为 true 时，rpc 模式会加载项目扩展；未信任时不加载，也没有 stdin 提示                                             | 读 `main.js:578-611`；真机准备一个带 `.pi/extensions` 的目录                                                                        |

## 11. 测试策略

| 层                                                      | 文件（新增）                                                         | 覆盖要点                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| protocol                                                | `tests/web-hub/protocol/spawn.test.ts`                               | schema 正反例；`RPC_ASK_USER_TITLE === ASK_USER_MARKER`；`SSE_EVENTS`/`API_ERRORS` 只追加（与 UI `logic/contract.js` 的漂移测试同一模式）                                                                                                                                                                                                                                                          |
| hub 纯逻辑                                              | `tests/web-hub/hub/spawn/dirs.test.ts`                               | `~` 展开；相对路径；NUL 与超长；不存在、不是目录、无权限；符号链接逃出 roots；`/home/a` 与 `/home/ab` 的段对齐；已知目录扫描（夹具 sessions 目录，包括 header 损坏、超过 30 天、目录已删除的情况）；扫描 deadline 返回 `partial`                                                                                                                                                                   |
| hub 纯逻辑                                              | `tests/web-hub/hub/spawn/rpc-stdio.test.ts`                          | 前缀过滤；跨 chunk 切行；超长行的丢弃模式（内存不增长）；各 method 的应答；marker 在 caps 含与不含 `dialog.v1` 时的分支；`uiCancelled` 上限 3                                                                                                                                                                                                                                                      |
| hub 状态机                                              | `tests/web-hub/hub/spawn/supervisor.test.ts`                         | 表驱动覆盖 §7.1 的全部迁移（假 `ChildProcess` 用 EventEmitter 实现，加 fake timers）：spawn 同步抛错或 `error` 事件、未 live 就 exit、注册超时后 kill 升级（5s/3s 时序）、pid 不匹配的 agent_up 被忽略、agent_down 只改 linked、stop 幂等、force、上限与 starting 并发、`shutdown()` 有界、`liveCount` 驱动 idle；持久化与孤儿回收（注入假的 `/proc` 读取：身份匹配、pid 复用、非 Linux 三种情况） |
| HTTP                                                    | `tests/web-hub/http/api-headless.test.ts`、`lan-headless.test.ts`    | 两个 listener 分别覆盖：未启用时 501（**原有「/api/headless 仍 501」用例保留为未启用分支**）、缺 Origin、跨源、缺 X-PWH、未登录、登出竞态（二次鉴权）、LAN off、LAN 明文封顶为 known、确认流（缺 confirm、expectCwd 不一致、通过）、幂等 dup、摘要冲突、429、409 上限、503 launcher；审计行字段白名单                                                                                              |
| 关闭即不变                                              | `tests/web-hub/agent/wiring-spawn.test.ts`                           | `spawn.enabled=false` 时 `PI_WEBHUB_CONFIG` 与现状深相等；hub caps 不含 `spawn.v1`                                                                                                                                                                                                                                                                                                                 |
| 集成                                                    | `tests/integration/web-hub-spawn.test.ts`（必须 `sandboxHome()`）    | 用一个**假的 rpc pi**（node 脚本：用自己的 pid 连 hub.sock 发 hello 和 session，读 stdin，EOF 时退出，可按参数发出 `extension_ui_request` 或拒绝退出）作为 launcher：端到端完成 spawn、live、`/api/cmd` 送达（假 agent 回 cmd_result）、stop、exited；拒绝退出时走完 8s 升级；hub close 时子进程全部退出；kill -9 hub 之后子进程靠 EOF 自退；重启 hub 后孤儿回收                                   |
| conformance（选跑，`npm run test:conformance` 同目录）  | `tests/conformance/rpc-spawn.test.ts`                                | 真实 `pi --mode rpc` 在临时 HOME 和临时 cwd 下：注册为 `kind:"rpc"`，stdin EOF 后 8 秒内退出，ui_request 前缀形状符合 V1；不需要模型凭据                                                                                                                                                                                                                                                           |
| UI                                                      | `tests/web-hub/ui/{new-session-menu,dir-picker,spawn-state}.test.ts` | 菜单两项的 enabled 矩阵（无 agent、无 caps、policy 拒绝）；DirPicker 补全防抖、409 进入确认视图、明文警告；reducer 对覆盖式 `spawns` 的处理；发起方自动选中；`no-innerhtml` 仍全绿                                                                                                                                                                                                                 |
| 真机验收（tmux，参照 memory `live-acceptance-tmux.md`） | `docs/dev/web-hub-spawn/acceptance.md`（S1 完成时写）                | 网页选已知目录建会话，收发消息，ask_user 网页作答，停止；未知目录在 roots 内需确认；LAN 明文下只能选已知目录；`/webhub restart` 后记录变为 exited，并可重新打开（S2）                                                                                                                                                                                                                              |

## 12. 实施要点与分期

### 12.1 分期

| 期             | 范围                                                                                                                                                                                                                                                                                                                                                                     | 验收                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **S1**         | protocol（spawn.ts、proc-identity 下沉、契约追加）；hub：supervisor、rpc-stdio、dirs（已知目录与 roots 准入，不含子目录列表）、store（含孤儿回收）、routes（GET 列表、POST、stop）、hub.ts 装配（idle、close、caps、supersede 判据）、审计；settings 与 `buildHubConfig`；UI：useNewSession、NewSessionMenu、DirPicker（输入框加最近目录）、SpawnRow、web 徽标、停止按钮 | §11 全部（不含 S2 项）；关闭时逐字节不变                |
| **S2**         | `GET /api/headless/dirs?path=` 子目录补全；reopen 与 `E_SESSION_IN_USE`；「在终端继续」；`idleMinutes` 回收                                                                                                                                                                                                                                                              | reopen 拒绝重复写同一会话；空闲回收不打断忙碌中的 agent |
| **S3（可选）** | 模型选择；hub 成为完整的 extension_ui 客户端，网页代答其他扩展的对话框（替换 D9）；`spawn.backend:"tmux"`                                                                                                                                                                                                                                                                | 另行设计                                                |

### 12.2 风险与提示

| #   | 风险                                                                                    | 缓解                                                                                          |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| R1  | **不读空 stdout，pi 就会被背压卡住**（rpc 的每个事件都 `waitForRawStdoutBackpressure`） | 从 spawn 那一刻起就挂上 `stdout.on("data")`，并且在任何 await 之前；集成测试构造大量输出验证  |
| R2  | 其他扩展的对话框挂起，导致 agent hang                                                   | §4.4 自动取消；marker 只在有 `dialog.v1` 时才保持挂起                                         |
| R3  | 用 `-e` 加载的开发环境：子进程里没有扩展                                                | §7.2 诊断；文档写明前提是 `pi install`                                                        |
| R4  | hub 的 env 是陈旧快照（新的 API key 环境变量看不到）                                    | 文档说明；`/webhub restart` 可以刷新；不做 env 注入接口（那会扩大攻击面）                     |
| R5  | hub 升级或重启会结束网页会话                                                            | supersede 静默判据纳入受管 agent 的 busy 状态；banner 提示；S2 的 reopen                      |
| R6  | 子进程存活期间 hub 不会空闲退出                                                         | 有意为之；`maxProcesses` 兜底；`/webhub stop` 显示数量                                        |
| R7  | `PI_WEBHUB_HEADLESS=1` 经 bash 工具泄漏给嵌套 pi，导致它不会自动拉起 hub                | 影响只有「嵌套的 pi 不会自启 hub」，可以接受；文档注明                                        |
| R8  | pid 绑定只成立于直接 spawn node 的情况                                                  | v1 不提供 `piCommand`；以后支持 wrapper 时启用预留的 `hello.ticket`                           |
| R9  | 和进行中的 AgentList 改动冲突                                                           | §9.1：建议现在就提取 `useNewSession`；S1 的 UI 包写清楚对 `components/agents/**` 的文件所有权 |

- **零 hang 自检清单**（评审逐条对照）：每个 fs 调用都有 deadline；`spawn` 用 try/catch 并监听 `error`；所有 timer 都 unref；stdin 和 stdout 都监听 `error`；`shutdown()` 有界；HTTP 不等注册完成；状态推进只由 exit 驱动；孤儿回收不阻塞启动。
- **AGENTS.md 同步**：S1 落地时在 `src/web-hub/` 条目下补一句 spawn 子系统说明，并链接本文。
