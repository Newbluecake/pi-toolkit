# web-hub「选择工作目录建会话」架构设计（arch v2，2026-10）

> 上游：`docs/dev/web-hub/arch.md`（P1–P3 总体架构，§5.3 已勾勒「无头进程生命周期」、§13.1 把它列入 P3，本文把那一节落成可施工的设计）、
> `docs/dev/web-hub/control-plan.md`（P2 控制面，鉴权/CSRF/审计/confirm 先例）、`docs/dev/web-hub/lan-plan.md`（LAN 信任边界）。
> pi 源码坐标相对 `~/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/`（0.87.1）。
> 本文只做设计，不改 `src/`。代码行号以 `0d81592`（master HEAD）为准；upload U1 正在工作区施工（`http.ts:357` 之后 +4 行等），
> spawn 在 upload 之后合入，开工前按 `plan.md` §2.3 的 rebase 闸门按**符号名**重核行号。施工拆包、验收用例见 `plan.md`，真机验收见 `acceptance.md`。

## v2 修订记录（评审 r_549SS1WK：3 阻塞 / 9 严重 / 4 一般 / 1 建议）

两份文档（本文与 `plan.md`）按同一张表修订；`plan.md` 头部有同一张表的施工落点版。

| #   | 级别 | 意见                                                   | 处置                                                                                                                                                                                                                                                                                           | 本文落点         |
| --- | ---- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | 阻塞 | 孤儿进程：生命周期不变量与平台未定                     | 定稿五条不变量 L1–L5（§7.2）；比较「不 detach + PDEATHSIG」「Job/cgroup 监管」「stdin-EOF + 独立 reaper + 先落盘意图」三套，选第三套（§7.3）；**spawn 前同步落盘意图**，fork 后同 tick 落盘 pid+身份；独立 reaper 子进程在 hub 以任何方式死亡后升级 TERM→KILL；下次 hub 启动再回收一次（§7.7） | §7.2、§7.3、§7.7 |
| 2   | 阻塞 | 身份判定与 v1 §7.3「cmdline 含 --mode rpc」矛盾        | 只用一套：`bootId + starttime + uid`，组杀额外要求 `pgrp == pid`；cmdline/comm **只作诊断字段**（pi 改写 `process.title`，实测 cmdline 变成 `pi`）。arch/plan/实现/验收共用 `verifySpawnedIdentity`，conformance 用真实 pi 覆盖                                                                | §7.4             |
| 3   | 阻塞 | supervisor 依赖类型不成立（需强转）                    | 依赖改为 `SpawnRegistryPort = Pick<Registry, "list" \| "get" \| "bus" \| "publish" \| "getCaps">`（`getCaps` 已在 `registry.ts:51`）；`CommandRouter` 只取 `Pick<CommandRouter, "request">`；禁止 `as` 强转（源码扫描钉住）；`types.test-d.ts` + `contract/fakes.ts` 三方同契约                | §4.1、§4.3       |
| 4   | 严重 | 缺统一可传递的绝对 deadline                            | 复用 `ReqDeadline`（`req-deadline.ts:35`）作唯一载体，自 HTTP 请求 / `close()` / crash 处理器创建并向下传递；等待、信号、持久化各自 `deriveBudget`；正常 close / SIGTERM / crash / SIGKILL 四级保证表                                                                                          | §7.6             |
| 5   | 严重 | store 缺关闭语义                                       | `flushAndClose(deadline)`：generation 递增 + closed 态、取消防抖 timer、全部写路径为**同步**串行 tmp+rename、close 后写 no-op；ENOSPC/rename 失败 ⇒ 持久化降级、**拒绝新 spawn**（意图落不了盘就不 fork）；同步 IO 不假装可取消，只在开始前检查余量                                            | §7.7             |
| 6   | 严重 | 平台未门禁                                             | S1 **仅 Linux**（需要 procfs：`/proc/<pid>/stat`、`boot_id`、`/proc/self/fd`）；其他平台或 procfs 探针失败 ⇒ fail closed（`reason:"platform"`），验收矩阵列出各平台行为                                                                                                                        | §7.1             |
| 7   | 严重 | cwd TOCTOU                                             | admit 记下 `dev/ino`；fork 前同步 `open(O_DIRECTORY)` + `fstat` 复核 dev/ino，以 `/proc/self/fd/<n>` 作 cwd 启动（已用 node 22 / libuv 1.51 验证），不一致 ⇒ `E_DIR{reason:"changed"}`；绑定时再核 `hello.cwd === realpath`，不一致 ⇒ 杀掉并 `failed{cwd_mismatch}`                            | §4.2、§4.5       |
| 8   | 严重 | 权限模型（**用户裁定：LAN 任何人可停受管会话，维持**） | 吸收工程部分：新增「信任边界」一节写明「同 hub 全信任」；`spawns` SSE 一律广播脱敏投影，owner 明细只经鉴权 GET 返回；给出字段级可见性矩阵                                                                                                                                                      | §6.0、§6.4       |
| 9   | 严重 | 超长 UI 请求行会挂起                                   | 以前缀识别出 `extension_ui_request` 后，即使整行超过上限，也从头部 ≤512 字节提取 `id/method/title` 并**立即**应答 `cancelled`（marker 按 §4.4 规则）；头部解析失败 ⇒ 视为协议错误，终止子进程 `failed{protocol_error}`                                                                         | §4.4             |
| 10  | 严重 | stderr 无界                                            | 内存 64 KiB 环形缓冲 + 单写者有界队列（≤64 KiB 待写，溢出丢最旧并计数）+ 每文件 256 KiB 封顶 + 目录 20 文件；磁盘错误 ⇒ 关闭该文件、环形缓冲继续；close 期间按 deadline 刷写，超时放弃                                                                                                         | §7.8             |
| 11  | 严重 | 资源限制不足                                           | S1：全局 `maxProcesses`、每主体 `maxPerPrincipal`、同时启动 2、每主体速率、**绝对运行时限** `maxLifetimeMinutes`、stderr/记录磁盘上限；空闲回收明确不做（S2）；cgroup 明确退化（S1 不限 CPU/内存，S2 可选 systemd scope）；耗尽时的错误码、回收顺序、审计字段成表                              | §6.5             |
| 12  | 严重 | launcher 版本链                                        | S1 **只用当前 hub 的 `HubConfig.launcher`**，从不信任 `hello.launcher`；init 时 realpath + `dev/ino/size/mtime` 指纹 + 读 pi `package.json` 版本并校验 peer 区间；每次 spawn 前同步复核指纹。`/reload`、`/webhub restart`、磁盘更新、stat 成功但版本不兼容各有可测行为                         | §4.2             |
| 13  | 一般 | 未启用响应矩阵不统一                                   | 一张矩阵（loopback/LAN × GET/POST × 未启用/LAN off/非 Linux），arch、plan、测试、验收都引用它                                                                                                                                                                                                  | §8.2             |
| 14  | 一般 | 三方依赖图                                             | 合入顺序 **upload → spawn → fleet**；热点文件唯一 owner 与 rebase 闸门见 `plan.md` §2.3                                                                                                                                                                                                        | §12.3            |
| 15  | 一般 | 首条消息（**用户裁定：hub 转发**）                     | 推翻 v1 D5：`firstPrompt` 随创建请求提交，hub 内存持有，live 后经 `commandRouter.request()` 送达（固定 cmd id，借 agent 台账幂等）；重试/过期/hub 重启语义与「202 的送达保证级别」写进契约                                                                                                     | §4.6、§8.1       |
| 16  | 一般 | acceptance.md 不全                                     | 新建 `acceptance.md`，S1/S2 分开；orphan、权限、超长 UI 请求、资源上限列为合入硬门槛                                                                                                                                                                                                           | §12.1            |
| 17  | 建议 | S1 范围收缩                                            | **采纳**。S1 = known/roots 准入、受管 spawn/stop、基本 SSE、生命周期回收、首条消息；目录浏览、reopen、空闲回收、模型选择、网页代答其他扩展对话框、cgroup 全部移到 S2/S3                                                                                                                        | §12.1            |

---

## 1. 背景与目标

**要解决的问题**：web UI 目前只能对**已在运行**的 pi 进程发命令。网页上的「新建会话」按钮（`060c33b` 已合入，`src/web-hub/ui/src/components/agents/AgentList.vue:94-131,150-158`）发的是 `/new`，只能在被选中 agent 的**原 cwd** 里新开会话；pi 进程的 cwd 在启动时就定死了，`/new` 改不了。用户要的是：在网页上选一个目录 → 系统在这个目录拉起一个新的 pi 进程 → 它作为新 agent 自动出现在 AGENTS 列表 → 之后和现有 agent 一样收发消息、停止。

**约束（沿用 web-hub 不变量）**

- 零 hang：每一步等待都有 deadline；hub 不 import pi（`docs/dev/web-hub/arch.md` §3.1）；所有 timer 都 `unref()`。
- 功能默认关闭（`webHub.spawn.enabled=false`）。关闭时 hub 的 HTTP 面、`HubConfig`、hello 帧和现在**逐字节一致**（逐格定义见 §8.2 的未启用响应矩阵）。
- 运行时依赖仍然只有 typebox；不引入 tmux 之类的外部二进制依赖。
- 从浏览器起本机进程等于远程执行，必须挂在现有鉴权面（loopback token / LAN 密码）、CSRF 闸门和审计之上。

**非目标（S1）**：非 Linux 平台（fail closed，§7.1）；网页代答**其他扩展**的 `select/confirm/input/editor` 对话框（一律自动取消，§4.4；S3）；Detach；子目录浏览、reopen、空闲回收、模型选择（S2，§12.1）；跨机器 / 跨 uid 拉起。

## 2. 现状摘要（事实 + 坐标）

| 事实                                                                                                                                                                               | 坐标                                                                                                            | 对本设计的意义                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rpc 模式在 web-hub 里已经是一等公民：`session_start` 只排除 print/json，tui 和 rpc 都会 attach                                                                                     | `src/web-hub/agent/index.ts:561-562`                                                                            | 新进程用 `--mode rpc` 就会自动注册，**agent 侧不用改代码**                                                                                                                                                          |
| `AgentKind = "tui" \| "rpc"`，hello 里带 `kind`，UI 已经在读                                                                                                                       | `src/web-hub/protocol/messages.ts:20`、`:329-334`；`ui/src/components/agents/agentCardModel.ts:92`              | 不用新增 kind；「是不是网页拉起的」由 hub 另行登记（§4.3）                                                                                                                                                          |
| hello 已经为 P3 预留了 `ticket?`、`launcher`；`hello_reject` 预留了 `E_TICKET`                                                                                                     | `messages.ts:331`、`:397`、`:547`、`:612`                                                                       | v1 不用 ticket（理由见 §5 D3），字段继续保留                                                                                                                                                                        |
| socket 地址由 `~/.pi/agent` 和 env 推导出来，与 cwd 无关                                                                                                                           | `src/web-hub/protocol/paths.ts:198-210`                                                                         | 同 uid、同 HOME、同 `XDG_RUNTIME_DIR` 的新进程一定能连到同一个 hub；子进程继承 hub 的 env，这一条天然成立                                                                                                           |
| `PI_WEBHUB_HEADLESS=1` 时进程永远不会去拉起 hub                                                                                                                                    | `src/web-hub/agent/launcher.ts:122-148`、`connection.ts:143,708`、`agent/index.ts:531`                          | 防止「hub 死了被子进程复活」的回环，P1 起就已生效                                                                                                                                                                   |
| hub 空闲计数里已经有 `headless` 位，但写死为 0                                                                                                                                     | `src/web-hub/hub/idle.ts:10,24`；`src/web-hub/hub/hub.ts:626`                                                   | 由 supervisor 填真实值                                                                                                                                                                                              |
| 每个 agent 的 hello 都带 `launcher=[execPath, argv1]`；拉起 hub 时 `HubConfig.launcher` 也会经 env 传下来                                                                          | `agent/connection.ts:466-482`；`agent/launcher.ts:95-112`；`hub/ports.ts:353-362`                               | 拉起命令只用 `HubConfig.launcher`；`hello.launcher` 是自报值，不作 exec 依据（§4.2，评审 #12）                                                                                                                      |
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
| supersede 的「静默」判据只看对话框、在途命令和 kdf                                                                                                                                 | `src/web-hub/hub/supersede.ts:193`                                                                              | 要加上「拉起的 agent 不在忙」（§7.8）                                                                                                                                                                               |
| pi 启动时执行 `process.title="pi"`，Linux 下 `/proc/<pid>/cmdline` 被改写成 `pi`，`comm` 也是 `pi`                                                                                 | `dist/bundle/cli-runtime.js` 的 `setupCli`；实测 `pgrep -x pi`                                                  | cmdline 不能用于身份判定（§7.4，评审 #2）                                                                                                                                                                           |
| hub 进程 `process.umask(0o077)`，子进程会继承                                                                                                                                      | `src/web-hub/hub/main.ts:51`                                                                                    | spawn 时必须恢复原始 umask（§4.2）                                                                                                                                                                                  |
| `Registry` 已有 `getCaps(agentKey)`，`RegistryView` 没有                                                                                                                           | `src/web-hub/hub/registry.ts:35-60`（`getCaps` 在 `:51`）                                                       | supervisor 依赖 `Pick<Registry,…>`，不强转（§4.1，评审 #3）                                                                                                                                                         |
| 运行期 `close()` 不执行 `cleanup` 数组（只有启动失败时执行）                                                                                                                       | `src/web-hub/hub/hub.ts:636-662` 对比 `:677`                                                                    | supervisor 关停必须显式写进 `close()`（§7.8）                                                                                                                                                                       |
| `ReqDeadline` 已是可传递的绝对 deadline 载体，`deriveBudget` 切预算                                                                                                                | `src/web-hub/hub/req-deadline.ts:35-60`                                                                         | 关停与请求路径共用（§7.6，评审 #4）                                                                                                                                                                                 |
| node 22 / libuv 1.51 下 `spawn({cwd:"/proc/self/fd/N"})` 能把子进程 cwd 钉到已打开目录的 inode                                                                                     | spike（§10 V7）                                                                                                 | cwd TOCTOU 的主防线（§4.2，评审 #7）                                                                                                                                                                                |

## 3. 选型结论：hub 直接 spawn `pi --mode rpc`

### 3.1 三方案对比

| 维度              | **A. hub 直接 spawn `pi --mode rpc`（选中）**                                                                     | B. 复用/改造 ChildSpawner                                                                                   | C. tmux 包一层 TUI                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 拉起方            | hub daemon（常驻、不 import pi）                                                                                  | 必须是某个 pi 进程（它在 runtime 里）                                                                       | hub 调用 `tmux new-session -d`                                       |
| cwd 隔离          | 真正的独立 OS 进程，cwd 由 `spawn({cwd})` 决定                                                                    | 同进程 SDK 会话；`process.cwd()` 是进程级的，换不了；扩展缓存按 cwd 失效（`docs/dev/web-hub/arch.md` §3.2） | 独立进程                                                             |
| 注册进 hub        | **零改动**：post-guard 的 `wireWebHub` 在 rpc 下 attach（`agent/index.ts:561`）                                   | 子会话被 HOST_KEY 拦在 post-guard 之外（`src/index.ts:222`）；要放开就得拆掉「子会话 inert」这个核心不变量  | 零改动（TUI 本来就注册）                                             |
| web 收发消息      | 现有 cmd 通道全部可用；ask_user 走网页对话框                                                                      | 只能经父进程的 `steer_subagent`，不是一等 agent                                                             | 全部可用                                                             |
| 其他扩展对话框    | hub 是 stdio 的唯一客户端：v1 自动取消，以后可以做网页代答                                                        | —                                                                                                           | 只能在终端里答（和现有 TUI agent 一样）                              |
| 生命周期与零 hang | stdin 绑在 hub 上：hub 一死就 EOF，pi 有序退出，孤儿防线的第一层（完整不变量与回收链见 §7.2–§7.3）；exit 事件精确 | 跟着父 pi 进程走，父进程 `/reload`、退出都会把它带走                                                        | hub 拿不到 exit 事件，只能轮询；tmux server 独立于 hub，孤儿要自己管 |
| 跨 hub 重启存活   | ✗（hub 升级 / 重启会结束这些会话；会话文件还在，可以「重新打开」，S2，§12.1）                                     | ✗                                                                                                           | ✓（最大的优点）                                                      |
| 外部依赖          | 无                                                                                                                | 无                                                                                                          | tmux 二进制、pty、终端尺寸                                           |
| 资源              | 一个 node 进程，不渲染                                                                                            | 共享父进程                                                                                                  | 外加一个 TUI 渲染循环（CPU）和 tmux server                           |
| 与原架构的一致性  | 就是 `docs/dev/web-hub/arch.md` §5.3 / K-3 / K-9 的既定方案                                                       | 与 §11「SDK 进程内会话」这一被否决的方案同类                                                                | 原架构未考虑                                                         |

**结论：A。** B 走不通：cwd 是进程级的，而且注册必须打破 HOST_KEY 不变量。C 唯一的优势是能跨 hub 重启存活，代价是外部依赖、拿不到 exit 事件、孤儿管理和 TUI 渲染开销；A 用「会话文件可以重新打开」的办法，以较低成本弥补这个缺口。C 记作扩展点：如果以后要做 `spawn.backend:"tmux"`，supervisor 的状态机（§7）不用变，只换启动/停止/存活探测三个函数。v1 不做。

### 3.2 rpc 模式下 wireWebHub 能走到哪一步（问题 1、2 的答案）

hub 拉起的 `pi --mode rpc` 是一个**顶层**进程：HOST_KEY 没被占（`src/index.ts:142`），所以完整走过 post-guard。只要 `settings.webHub.enabled=true`（拉起的进程和 hub 的拉起者读的是同一份 `~/.pi/agent/pi-subagent.json`），就会执行 `wireWebHub`（`src/index.ts:857`）→ `session_start` 时 `c.mode==="rpc"`，attach（`agent/index.ts:561-562`）→ `acquireConnection({kind:"rpc", headless:true})`（`:521-532`）→ 按确定性的 socket 路径连上现有 hub → 发 hello，registry 新建一张 `kind:"rpc"` 的卡片（`hub/registry.ts:307-339`，发布 `agent_up`）→ 发 `session` 帧 → 能力 `cmd.v1/dialog.v1/command.v1` 由 `capsExtra` 照常声明（`agent/index.ts:507-515`）。

注册链路天然成立，有三个前提：

1. 用户是用 `pi install` 安装的 pi-toolkit，settings.json 里列着它。如果父进程是用 `-e` 加载的，拉起的进程里**就没有这个扩展**，这和 AGENTS.md 里 todo #27 说的是同一类问题。这种情况走注册超时，诊断信息里给出 hint `register-timeout-hello`（§7.5、§12.2 R3）。
2. `webHub.enabled=true`，否则同样超时。
3. 同 HOME、同 uid、同 `XDG_RUNTIME_DIR`：子进程继承 hub 的 env，这一条天然满足。

TUI 专属的部分会自动失效：`setStatusLine`、`ui.notify` 都在 `mode!=="tui"` 时直接返回（`agent/index.ts:286,389`）；LAN 初始密码在 rpc 下不显示（lan-plan §6.2）。这些都是预期行为。

## 4. 总体设计

### 4.1 模块划分与依赖方向

```
浏览器 UI (ui/src)                      hub daemon (src/web-hub/hub)                                    新 pi 进程
──────────────────                      ────────────────────────────                                    ──────────
NewSessionMenu ─┐                       http.ts ──(闸门复用 / io 注入)──┐
DirPicker ──────┼─ transport.spawn? ──▶ spawn/routes.ts ──────────────┼─▶ spawn/supervisor.ts ──fork──▶ pi --mode rpc
SpawnRow ───────┘  (/api/headless*)     spawn/project.ts（可见性投影）  │     │ ▲ stdin(持有) / stdout(读空)
state.js ◀── SSE "spawns"（脱敏投影）◀── registry.publish ◀────────────┘     │ │ stderr → spawn/stderr-sink.ts
                                                                          ├─ spawn/rpc-stdio.ts（ui_request 自动应答）
                                                                          ├─ spawn/first-prompt.ts ──▶ commandRouter.request()
                                                                          ├─ spawn/dirs.ts（准入 / 已知目录 / cwd 钉住）
                                                                          ├─ spawn/store.ts（意图先落盘 / flushAndClose）
                                                                          └─ spawn/reaper.ts ══pipe══▶ reaper 子进程（独立看门狗）
                                        registry.ts ◀── hello{kind:"rpc",pid,cwd} ── hub.sock ── wireWebHub（零改动）
                                          └─ bus(agent_up/session/status/dialogs/agent_down) ─▶ supervisor（SpawnRegistryPort）
```

依赖方向不变：`hub → protocol ← agent`，`ui → (HTTP 契约)`。**agent 侧 hello、connection、事件 tap 一律不改**。

| 层       | 文件                                                                                                                                                                                 | 职责                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| protocol | `protocol/spawn.ts`（新）                                                                                                                                                            | wire 类型（`SpawnRecordPublic`/`SpawnRecordOwner`/`SpawnsPayload`/`SpawnPolicyWire`/`SpawnRequestBody`/`DirListingWire`）、typebox schema、常量、`RPC_ASK_USER_TITLE`   |
| protocol | `protocol/proc-identity.ts`（新，从 `agent/proc-identity.ts:75-118` 下沉纯函数）                                                                                                     | `parseStartTicks`/`parsePgrp`/`parseUidLine`/`readBootId`/`verifySpawnedIdentity`；hub 和 reaper 共用                                                                   |
| protocol | `http-contract.ts`、`version.ts`（只追加）                                                                                                                                           | `SSE_EVENTS += "spawns"`；`API_ERRORS += E_SPAWN_DENIED/E_DIR/E_LIMIT/E_LAUNCHER`；`SPAWN_HUB_CAP`；`SUPPORTED_PI_RANGE`                                                |
| hub      | `hub/spawn/ports.ts`（新）                                                                                                                                                           | `SpawnRegistryPort = Pick<Registry, "list" \| "get" \| "bus" \| "publish" \| "getCaps">`、`FirstPromptRouterPort = Pick<CommandRouter, "request">`、`SpawnFrontendPort` |
| hub      | `hub/spawn/{config,dirs,rpc-stdio,store,stderr-sink,reaper,reaper-source,supervisor,first-prompt,project,routes}.ts`（新）                                                           | 各司其职，见 `plan.md` §4                                                                                                                                               |
| hub      | `http.ts`、`hub.ts`、`main.ts`、`agent-server.ts`、`audit.ts`、`supersede.ts`、`hub-json.ts`（改）                                                                                   | 接线 / 装配 / umask / caps / 审计 / 静默判据 / 状态文件                                                                                                                 |
| agent    | `agent/index.ts`（只改 `WebHubSettings` 类型与 `buildHubConfig`）                                                                                                                    | `spawn.enabled` 为真时才写 `config.spawn`；关闭时 `PI_WEBHUB_CONFIG` 深相等                                                                                             |
| config   | `config/settings.ts`、`config/setting-specs.ts`                                                                                                                                      | `webHub.spawn.*`                                                                                                                                                        |
| ui       | `transport/*`、`logic/{contract,state,spawn,token-client,password-client}.js`、`composables/useSpawn.ts`、`components/spawn/*`、`AgentList.vue`、`AgentCard.vue`、`DetailHeader.vue` | 入口、目录选择、进度行、web 徽标、停止                                                                                                                                  |

**类型契约（#3）**：supervisor、first-prompt、routes 只依赖 `hub/spawn/ports.ts` 里的 `Pick<…>` 端口；`hub.ts` 把真实 `Registry`、`CommandRouter` 直接传入，不做任何 `as`。测试替身放在 `tests/web-hub/contract/fakes.ts`，`types.test-d.ts` 断言 `Registry extends SpawnRegistryPort`、`CommandRouter extends FirstPromptRouterPort`，替身 `satisfies` 同一端口；`tests/web-hub/hub/spawn/source-scan.test.ts` 禁止 `hub/spawn/**` 出现 `as` 断言（`as const` 除外）。

### 4.2 拉起命令与 launcher 版本链（#7 #12）

**launcher 唯一来源**：当前 hub 的 `HubConfig.launcher`（`agent/index.ts:493`，即拉起这个 hub 的 pi 进程的 `[process.execPath, argv1]`）。**从不使用 `hello.launcher`**：它是 agent 自报的值，hub 不对自报值做 exec。

| 时机                       | 校验                                                                                                                                                                                                                                                                                                                                                        | 失败行为                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| supervisor `init()`（≤1s） | 两段都是绝对路径；`realpath` 后 `stat` 为普通文件；`launcher[1]` 以 `.js/.mjs/.cjs` 结尾；从 `launcher[1]` 向上 ≤5 级找 `name === "@earendil-works/pi-coding-agent"` 的 `package.json`，读 `version`，必须落在 `SUPPORTED_PI_RANGE`（`>=0.87.0 <0.88.0`，测试钉住与本包 `package.json` peer 区间相等）；记录 `{realpath, dev, ino, size, mtimeMs}` 两份指纹 | `policy.allowed=false`，`reason:"launcher"`，`detail ∈ {missing, not-file, unverifiable, incompatible}`；POST 返回 `503 E_LAUNCHER{reason}` |
| 每次 spawn 前（同步）      | `statSync` 两份路径，指纹必须与 init 时完全一致                                                                                                                                                                                                                                                                                                             | `503 E_LAUNCHER{reason:"changed"}`，并把策略切到 `launcher/changed`，提示 `/webhub restart`；不重新探测（不在请求路径里读 package.json）    |

可测行为：

- **父 pi `/reload`**：不影响 hub（hub 的 `HubConfig` 是快照），已有受管会话与 launcher 都不变。
- **`/webhub restart`**：新 hub 从发起 restart 的 pi 拿到新的 `HubConfig.launcher`；旧 hub 的受管会话随旧 hub 结束（D4），由 §7 的回收链清理，记录变成 `exited{hub}` 或 `exited{orphan}`。
- **磁盘上 pi 被升级 / nvm 切换**：指纹变化 ⇒ `E_LAUNCHER{changed}`，直到 `/webhub restart`。
- **stat 成功但版本不兼容**（例如 0.88）：init 判 `incompatible`，整个生命周期 fail closed。
- **拉起的进程加载了更新版本的 pi-toolkit**（settings.json 指向新包）：不触发 supersede（§4.3），记录 `hint:"newer-plugin"`。

**argv 与环境**：

```ts
argv = [launcher[1], "--mode", "rpc", ...(model ? ["--model", model] : [])]; // 固定前缀 + 可选 --model 尾部（default-model plan D2/§3）；S1 不支持 --session（S2）
cwdFd = openSync(admitted.realpath, O_RDONLY | O_DIRECTORY); // 同步；fstat dev/ino 必须等于 admit 记录
spawn(launcher[0], argv, {
  cwd: `/proc/self/fd/${cwdFd}`, // 钉住 inode（Linux；node 22 + libuv 1.51 已验证子进程 cwd = realpath）
  detached: true, // 独立进程组：pid == pgid，组杀用 kill(-pid)
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...strip(process.env, /^PI_WEBHUB_/),
    PI_WEBHUB_HEADLESS: "1",
    PI_WEBHUB_SPAWN_ID: spawnId,
    PWD: admitted.realpath,
  },
});
closeSync(cwdFd); // node 打开的 fd 自带 O_CLOEXEC，不会泄漏到 pi
```

- **umask**：hub 进程在 `main.ts:51` 把 umask 设成 `0o077`，子进程会继承，导致 pi 在项目里新建的文件都是 0600。`main.ts` 记下原始 umask（`process.umask(0o077)` 的返回值），spawn 的同步区内先 `process.umask(inherited)`，spawn 返回后立即恢复 `0o077`。
- `PI_WEBHUB_SPAWN_ID` 只在 §7.7「意图已落盘、pid 未落盘」的极小窗口里用于孤儿识别；它会经 bash 工具泄漏给嵌套进程，这一点可以接受（R7 同类），因为它只会扩大「杀掉孤儿会话的后代」这一范围。
- **绝不传** `--approve`、`--no-approve`、`-e`、`--no-extensions`（项目信任与扩展发现保持 pi 默认行为，§2）。

### 4.3 「受管 agent」与 registry 的关联

supervisor 通过 `SpawnRegistryPort.bus` 订阅：

- `agent_up{agent}`：`agent.pid === child.pid` 时绑定 `agentKey`；**同时核对 `agent.cwd === admitted.realpath`**，不一致 ⇒ 立即走停止升级，记录 `failed{cwd_mismatch}`（#7 的事后兜底）。绑定后同步检查 `registry.get(key)?.session`，有就直接进入 `live`。
- `session{agentKey}`：已绑定的记录进入 `live`，记录 `control = getCaps(key)?.includes("cmd.v1")`。
- `dialogs{agentKey}` / `agent_down{agentKey}`：驱动 §4.4 的 marker 挂起规则；`agent_down` 只把 `linked=false` 记下，进程真相以 `exit` 为准。
- **版本观察**：`hub.ts` 包一层 registry 的 `onVersion`（`registry.ts:338` 在 `publish(agent_up)` 之后调用），受管 agent 的版本不送进 `supersede.observe`，否则一个加载了更新 pi-toolkit 的网页会话会立刻触发 hub 版本替换，自己随 stdin EOF 一起结束。

AgentCard 形状不改。UI 用 `spawns.items[].agentKey` 关联卡片，显示 `web` 徽标与「停止会话」按钮；TUI 进程永远不能从网页停止。

### 4.4 stdio 处理（rpc-stdio.ts，#9）

stdout 从 fork 那一刻起就挂上 `data` 监听（在任何 await 之前），否则 pi 会被 `waitForRawStdoutBackpressure` 卡住（`rpc-mode.js:611-638`）。只按 `\n` 切行（与 pi 的 `jsonl.js` 一致）。

| 行                                                                       | 处理                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 不以 `{"type":"extension_ui_request"` 开头                               | 不解析、丢弃（事件以 socket 通道为准）；超过 64 KiB 的部分进入丢弃模式，不累积                                                                                                                                                                                                                                                                         |
| 以该前缀开头，整行 ≤64 KiB                                               | `JSON.parse`，按下面的 method 表处理                                                                                                                                                                                                                                                                                                                   |
| 以该前缀开头，**整行超过 64 KiB**                                        | 只保留头部 ≤512 字节，用有界正则提取 `"id":"…"`、`"method":"…"`、`"title":"…"`（pi 的 `output({type, id, ...request})` 保证 `id` 是第二个键、`method/title` 紧随其后，`rpc-mode.js:77`），其余字节丢弃。提取到 `id` ⇒ 按 method 表立即应答（marker 也照表处理）；提取不到 ⇒ 协议错误，停止子进程，`failed{protocol_error}` 或 `exited{protocol_error}` |
| `method ∈ {notify,setStatus,setWidget,setTitle,set_editor_text}`         | 忽略（fire-and-forget）                                                                                                                                                                                                                                                                                                                                |
| `method==="select"` 且 `title === RPC_ASK_USER_TITLE`（ask_user marker） | 满足以下全部条件才**挂起**：绑定 agent 的 `getCaps` 含 `dialog.v1`，且 `linked`。挂起后的三条兜底（各 `MARKER_HOLD_GRACE_MS=5s`）：(a) 5s 内该 agent 的 `dialogs` 槽位没有出现 open 项；(b) `linked=false` 持续 5s；(c) 挂起期间 open 项清空持续 5s。任一触发 ⇒ 应答 `cancelled`。不满足挂起条件 ⇒ 立即应答 `cancelled`                                |
| `method ∈ {select,confirm,input,editor}`（其他扩展）                     | 立即应答 `{type:"extension_ui_response", id, cancelled:true}`（confirm 因此为 `false`）；记录 `uiCancelled`（最近 3 条，`{method, title≤120, at}`，title 只对 owner 可见，§6.4）                                                                                                                                                                       |

重复应答同一 id 是安全的（pi 侧 pending 不存在就忽略，`rpc-mode.js:617-629`），所以兜底不需要知道 pi 是否已经因为网页先答而 abort 了 select。stdin 只写应答和最后的 `end()`，挂 `error` 监听（EPIPE）。

### 4.5 目录准入（dirs.ts）

**已知目录**按三个来源取并集：① registry 里所有卡片的 `cwd`；② `$PI_CODING_AGENT_DIR/sessions`（hub 环境里没有这个变量时用 `<home>/.pi/agent/sessions`）下最近 30 天修改过的会话目录，每个目录取最新一个 `.jsonl`，只读前 4 KiB 的 header 取 `cwd`；③ spawns 历史记录里的 `cwd`。每项 realpath，存在且是目录才保留，按最近活动时间倒序取 50 条，缓存 60s，整次扫描 2s deadline（超时返回已扫到的部分，`partial:true`）。hub 不读 pi 的 settings，所以 `sessionDir` 自定义的情况只能退化为来源 ①③。

**准入** `admit(raw, scope, deadline) → {ok:true, realpath, dev, ino, known} | {ok:false, reason}`：

1. 拒绝 NUL、长度大于 4096、空串；`~` / `~/` 展开为 `config.home`；展开后必须是绝对路径。
2. `realpath`（`min(2s, deadline 余量)`）→ `not-found`；`stat` 不是目录 → `not-dir`；`access(R_OK|X_OK)` 失败 → `no-access`。记下 `dev/ino`。
3. `known = realpath ∈ 已知目录集合`。
4. 允许条件：`known`；或 `scope==="roots"` 且 realpath 落在某个 `roots[i]`（同样 realpath 后）之下，**按路径段对齐**（`/home/a` 不匹配 `/home/ab`）。否则 `not-allowed`。

fork 前的同步复核（§4.2）：`open(O_DIRECTORY)` + `fstat`，dev/ino 必须等于第 2 步的记录，否则 `E_DIR{reason:"changed"}`，不 fork。子目录列表（浏览）移到 S2。

### 4.6 首条消息由 hub 转发（#15，用户裁定）

| 项           | 设计                                                                                                                                                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 提交         | `POST /api/headless {id, cwd, firstPrompt?: {text ≤48 KiB, deliver?: "steer"\|"followUp"}}`；`firstPrompt` 参与幂等摘要                                                                                                                                                                   |
| 持有         | **只在 hub 内存**（不写盘：正文属于隐私，且孤儿回收用不到）。全局上限 = `maxProcesses × 48 KiB`。spawns.json 只记 `{state, textLen}`                                                                                                                                                      |
| 送达时机     | 记录进入 `live` 且 `control===true` 后立即发送：`commandRouter.request(frame, agentKey)`，frame 为 `{t:"cmd", rid, id: "fp_" + spawnId, deadlineMs: 8000, origin: 创建请求的 {listener, ip, user?, reqId}, cmd: {op:"prompt", text, deliver, expect:{sessionId}}}`；重试时加 `retry:true` |
| 幂等         | cmd id 由 spawnId 派生且固定，重试不会产生第二次执行：hub LRU 键为 `principal`、`agentKey`、`id` 三段拼接（`commands.ts:441`），agent 侧台账同样按 id 去重                                                                                                                                |
| 重试         | 可重试结果：`E_AGENT_GONE`（链路抖动 ⇒ 等重新 `linked`）、`E_DEADLINE`、`effect:"unknown"`、`E_BUSY_COMPACTING`、`E_BUSY_STEER`。退避 `[1s, 3s, 9s]`，最多 4 次                                                                                                                           |
| 不可重试     | `E_UNSUPPORTED`、`E_COMMAND_DENIED`、`E_BAD_REQUEST`、`E_SESSION_CHANGED`（live 后用户已在终端或网页切了会话）、`control===false` ⇒ `failed{code}`                                                                                                                                        |
| 过期         | 绝对期限 `firstPromptDeadlineAt = createdAt + registerTimeoutS + 120s`。期限到 / 记录进入终态时仍未送达 ⇒ `expired{reason: deadline \| never_live \| stopped \| hub_restart}`，正文立即从内存丢弃                                                                                         |
| 浏览器断连   | 与送达无关（hub 侧完成）。重连后 SSE 快照里的 `firstPrompt.state` 给出结果                                                                                                                                                                                                                |
| 失败时的正文 | wire 上从不出现正文。发起标签页本地保留一份；`failed/expired` 时由 UI 放回该 agent 的 composer 草稿（有 agentKey 时）或 DirPicker。标签页已关闭则正文丢失，这一点写进契约                                                                                                                 |
| 审计         | `audit:"spawn", phase:"state", firstPrompt: state, textLen, code`；`/api/cmd` 本身的 control 审计照常写（`ControlAuditRecord.textLen`）                                                                                                                                                   |

**送达保证级别（写进 API 契约）**：`202` 表示「会话创建请求已受理，首条消息已被 hub 接管」。之后提供的是 **hub 进程生命周期内、截止 `firstPromptDeadlineAt` 的尽力送达，至多一次生效**。hub 在送达前重启 ⇒ `expired{hub_restart}`，不保证送达。结果只通过 `spawns` 的 `firstPrompt.state` 告知。

## 5. 关键决策

| #   | 决策                                                                        | 备选                                            | 理由                                                                                                                                                   |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | 拉起形态选 A（hub spawn `pi --mode rpc`）                                   | B ChildSpawner / C tmux                         | §3.1                                                                                                                                                   |
| D2  | 新开 HTTP 端点 `/api/headless*`，不新增 cmd op                              | `cmd{op:"spawn_session"}`                       | cmd 以 agentKey 为目标（`hub/commands.ts:84-104`），按 agent caps 准入，台账在 agent 侧；spawn 是 hub 本地操作，必须在一个 agent 都没有时也能用        |
| D3  | registry 绑定按 **pid** 匹配，并核对 `hello.cwd`                            | env ticket + `hello.ticket`                     | 直接 spawn node 时 pid 必然相等；hub 持有 child 句柄期间 pid 不会被复用。agent 侧零改动。`hello.ticket`/`E_TICKET` 保留给以后的 wrapper 后端           |
| D4  | 生命周期不超过 hub；不提供 Detach                                           | 子进程脱离 hub 常驻                             | stdin EOF 带来有序退出；node 做不到跨进程转交 fd。孤儿不变量与回收链见 §7.2–§7.3                                                                       |
| D5  | **（v2 推翻）首条消息由 hub 转发**，HTTP 仍返回 202 + SSE 进度              | v1：浏览器 live 后自己走 `/api/cmd`             | 用户裁定（#15）：标签页关闭、手机切后台、live 前后断网都不应丢首条消息。仍然不同步等注册：pi 启动可能超过 `WRITE_TOTAL_MS=13s`（`req-deadline.ts:13`） |
| D6  | `spawns` 是覆盖式槽位帧，SSE 只带脱敏投影                                   | 增量事件；按 client 定制帧                      | 与 `dialogs/ctl/commands` 槽位范式一致；SSE 全局 ring 不支持按 client 定制内容（`sse.ts:44`），owner 明细改走鉴权 GET（#8）                            |
| D7  | 默认只允许已知目录；任意目录必须显式配置 `roots`                            | 默认放开 `~`                                    | 最小意外                                                                                                                                               |
| D8  | confirm 绑定 `expectCwd`（realpath），无状态                                | 布尔 confirm；服务端 nonce                      | 让用户确认真实目标；fork 前还有 dev/ino 复核（§4.5），确认后替换目录无效                                                                               |
| D9  | 其他扩展的对话框一律自动取消；ask_user marker 按 §4.4 有界挂起              | 挂着；hub 当完整 extension_ui 客户端            | 挂着就是 hang；网页代答其他扩展属于 S3                                                                                                                 |
| D10 | **S1 不做空闲回收**；以绝对运行时限 `maxLifetimeMinutes`（默认 720）兜底    | 30 分钟空闲回收                                 | 不忙的 rpc agent 可能还挂着 bash job 或 cron，hub 看不到；空闲判据放 S2                                                                                |
| D11 | 设置经 `HubConfig.spawn` 快照下发，改了需要 `/webhub restart`               | hub 读 settings 文件                            | 与 `lan` 同一范式；hub 不读 pi 的设置文件                                                                                                              |
| D12 | 孤儿防线 = stdin EOF + 独立 reaper 子进程 + 意图先落盘 + 下次启动回收（#1） | PDEATHSIG（经 `setpriv`）；cgroup/systemd scope | 纯 node + procfs，无外部依赖；比较见 §7.3                                                                                                              |
| D13 | 身份 = `bootId + starttime + uid`，组杀加 `pgrp==pid`；cmdline 仅诊断（#2） | cmdline 含 `--mode rpc`                         | pi 启动时 `process.title="pi"` 改写 `/proc/<pid>/cmdline`（`dist/bundle/cli-runtime.js` 的 `setupCli`）                                                |
| D14 | S1 仅 Linux，其他平台 fail closed（#6）                                     | POSIX 通用实现                                  | 身份判定、cwd 钉住、boot_id 都依赖 procfs                                                                                                              |
| D15 | launcher 只信当前 hub 的 `HubConfig.launcher` + 指纹 + 版本区间（#12）      | 回退到 agent 自报的 `hello.launcher`            | 自报值不可作为 exec 依据                                                                                                                               |
| D16 | S1 范围收缩（#17）                                                          | v1 的 S1 全量                                   | 把复杂度预算让给 D12–D15 的联调                                                                                                                        |

## 6. 安全模型

### 6.0 信任边界：同一个 hub 内全信任（#8，用户裁定）

- **所有通过鉴权的网页主体彼此完全信任**：任何主体都能 prompt 任何 agent（现状）、停止任何受管会话（用户裁定，维持）。web-hub 在设计上等价于本机用户的远程 shell（`docs/dev/web-hub/arch.md` §9、K-10）。
- 「主体」= `${listener}:${user ?? "token"}`（与 `http.ts:1649` 的 `principalKey` 同源）。loopback token 主体视为**机器所有者**，对全部记录都是 owner。
- 这个边界不是「多租户隔离」：LAN 多个账号之间没有权限差别，只有**展示层**的最小暴露——非 owner 看不到别人目录的完整路径、stderr、扩展对话框标题（§6.4）。原因是这些字段可能出现在投屏、截图、共享屏幕里，而不是为了防止已登录主体的恶意行为。
- 施工时把同样的一段话写进 `docs/dev/web-hub/lan-plan.md` 的安全边界章节（`plan.md` SP13）。

### 6.1 威胁与对策

基线：已登录主体本来就能经 `prompt` 让 agent 执行 bash。spawn 没有带来新的能力类别，只扩大了两样东西：可以选择任意 cwd、无需任何在线 agent 即可执行。

| 威胁                                       | 对策                                                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 跨站伪造 / DNS rebinding                   | Host 白名单（421）；写端点用 `strictCsrfOk`（`http.ts:1481-1493`）；GET 端点要求 `X-PWH:1`；`SameSite=Strict` cookie                                                                 |
| 未登录访问 / 登出竞态                      | loopback `auth.check`、LAN `requireLanSession`；POST 在 fork 前二次鉴权（照抄 `dispatchCmdOrDialog` 步骤 ⑦），二次鉴权到 fork 之间没有 await                                         |
| 在任意目录执行（加载恶意 `.pi` 扩展）      | 准入限定 known ∪ roots（§4.5）；rpc 模式下项目信任默认 false，未信任的项目资源不加载；绝不传 `--approve`                                                                             |
| 参数注入                                   | cwd 不进 argv；固定前缀 `[launcher[1], "--mode", "rpc"]` + 可选 `--model <ref>` 尾部（default-model plan：无 shell、值经 `parseSpawnModelRef` 拒空白/控制/前导 `-`，独立 argv 元素） |
| 符号链接 / 路径穿越 / 检查后替换（TOCTOU） | realpath 后按段对齐判定；fork 前 `open(O_DIRECTORY)` + dev/ino 复核并以 fd 路径为 cwd；绑定时核对 `hello.cwd`（§4.2、§4.3）                                                          |
| 资源耗尽                                   | §6.5                                                                                                                                                                                 |
| 目录枚举                                   | S1 没有子目录浏览；已知目录列表只返回 realpath，最多 50 条                                                                                                                           |
| LAN 明文嗅探 cookie 后重放                 | LAN 默认 `off`；明文直连时封顶为 `known`；LAN 上每次都要 confirm                                                                                                                     |
| 伪造受管 agent（同 uid 进程伪造 hello）    | 同 uid 视为完全可信；绑定只认 hub 自己的 child pid + cwd                                                                                                                             |
| 误杀无关进程                               | 任何信号发送前都在同一同步段内重新核验身份（§7.4）                                                                                                                                   |
| 孤儿进程                                   | §7.2–§7.3                                                                                                                                                                            |
| 拉起的进程反过来拉起 hub                   | `PI_WEBHUB_HEADLESS=1`（`launcher.ts:148`）                                                                                                                                          |

### 6.2 策略配置（`webHub.spawn`，经 `HubConfig.spawn` 下发）

| 键                   | 默认    | 范围            | 说明                                                                                 |
| -------------------- | ------- | --------------- | ------------------------------------------------------------------------------------ |
| `enabled`            | `false` | bool            | 关闭时 `HubConfig` 没有 `spawn` 键，响应矩阵见 §8.2                                  |
| `roots`              | `[]`    | ≤16 项          | 绝对路径或 `~` 开头；为空时只允许已知目录                                            |
| `maxProcesses`       | `4`     | 1..16           | 全局非终态记录上限                                                                   |
| `maxPerPrincipal`    | `2`     | 1..16           | 每主体非终态记录上限（loopback token 主体同样受限）                                  |
| `ratePerMinute`      | `3`     | 1..30           | 每主体创建速率（令牌桶）                                                             |
| `maxLifetimeMinutes` | `720`   | 10..10080       | 绝对运行时限，从 `createdAt` 起算；到期按停止升级结束，`endReason:"lifetime"`        |
| `registerTimeoutS`   | `30`    | 10..120         | spawn 到 `live` 的 deadline                                                          |
| `lan`                | `"off"` | off/known/roots | LAN listener 的上限；明文直连封顶为 `known`；`off` 时 LAN 面与未启用字节一致（§8.2） |

### 6.3 确认流（两段式，绑定真实路径）

```
POST /api/headless {id, cwd:"~/proj"}
  → 闸门 → admit ⇒ {realpath:"/home/u/proj", known:false}
  → needsConfirm = (listener==="lan") || !known
  → 未带 confirm 或 expectCwd≠realpath ⇒ 409 {error:"E_CONFIRM_REQUIRED", resolvedCwd, reason:"unknown-dir"|"lan"}
UI 显示 resolvedCwd（textContent），LAN 下加明文警告
POST /api/headless {同一个 id, cwd, confirm:true, expectCwd:"/home/u/proj", firstPrompt?}
  → 重新 admit，realpath 必须严格等于 expectCwd（否则再 409）→ 二次鉴权 → fork 前 dev/ino 复核 → fork
```

确认只是防误触，不是安全边界；安全边界是鉴权、CSRF、准入和限额。

### 6.4 字段可见性矩阵（#8）

SSE `spawns` 是全局广播（所有通过鉴权、且当前 listener 策略不为 off 的连接都会收到），因此**只携带 Public 投影**。owner 明细只能通过鉴权的 `GET /api/headless` 拿到，hub 按请求主体逐条投影。

| 字段                                                                           | SSE 广播（Public） | GET：非 owner                              | GET：owner（含 loopback 主体）      | 说明                                                                                                                            |
| ------------------------------------------------------------------------------ | ------------------ | ------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `spawnId`、`state`、`createdAt`、`updatedAt`、`endReason`、`exit{code,signal}` | ✓                  | ✓                                          | ✓                                   | 生命周期必需                                                                                                                    |
| `agentKey`、`pid`、`linked`、`control`                                         | ✓                  | ✓                                          | ✓                                   | 已经在 AgentCard 上公开                                                                                                         |
| `cwdLabel`（realpath 的最后一段）                                              | ✓                  | ✓                                          | ✓                                   | 列表展示用                                                                                                                      |
| `cwd`（完整 realpath）                                                         | ✗                  | 仅当已绑定 live 卡片（卡片本身公开了 cwd） | ✓                                   | live 之前或失败的记录不向非 owner 暴露完整路径                                                                                  |
| `origin.listener`、`origin.reqId`                                              | ✓                  | ✓                                          | ✓                                   | `reqId` 是浏览器生成的幂等 id，UI 用它认领「我发起的」；LRU 按主体分区，别人拿到也无法复用                                      |
| `origin.user`                                                                  | ✗                  | ✗                                          | ✓                                   |                                                                                                                                 |
| `hint`（枚举码）                                                               | ✓                  | ✓                                          | ✓                                   | 只允许 `register-timeout-hello/register-timeout-session/control-off/newer-plugin/cwd-mismatch/protocol-error/launcher-*` 等枚举 |
| `hintDetail`（自由文本）                                                       | ✗                  | ✗                                          | ✓                                   | 可能包含 stderr 片段                                                                                                            |
| `stderrTail`（≤4 KiB）                                                         | ✗                  | ✗                                          | ✓（仅 failed）                      |                                                                                                                                 |
| `uiCancelled`                                                                  | 只有 `count`       | 只有 `count`                               | `{method, title≤120, at}[]`         | 扩展对话框标题可能包含敏感文本                                                                                                  |
| `firstPrompt`                                                                  | `{state, code?}`   | `{state, code?}`                           | `{state, code?, textLen, attempts}` | **任何层都不出现正文**                                                                                                          |
| `sessionFile`                                                                  | ✗                  | ✗                                          | ✗（S1 不上 wire）                   | S2 reopen 才需要                                                                                                                |
| `procStartTicks`、`bootId`、`uid`                                              | ✗                  | ✗                                          | ✗                                   | 只落盘                                                                                                                          |

投影函数集中在 `hub/spawn/project.ts`：`toPublic(rec)`、`toViewer(rec, principal)`。字段一律逐个拷贝（白名单），不做展开；测试对每一列做断言。

### 6.5 资源上限与耗尽行为（#11）

| 资源            | S1 限制                                                                                                        | 耗尽时                                                                                 | 审计字段                          |
| --------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------- |
| 全局进程数      | `maxProcesses`（非终态记录）                                                                                   | `409 E_LIMIT{limit:"global", active, max}`                                             | `limit`、`active`、`max`          |
| 每主体进程数    | `maxPerPrincipal`                                                                                              | `409 E_LIMIT{limit:"principal", active, max}`                                          | 同上 + `user`                     |
| 同时启动        | 2                                                                                                              | `409 E_LIMIT{limit:"starting"}`                                                        | 同上                              |
| 创建速率        | 每主体 `ratePerMinute`；读端点 10/1s                                                                           | `429 E_RATE` + `Retry-After`（429 审计按 `RATE_AUDIT_WINDOW_MS` 去重，`http.ts:1584`） | `code:"E_RATE"`                   |
| 运行时长        | `maxLifetimeMinutes`                                                                                           | 走停止升级，`exited{lifetime}`；首条消息未送达则 `expired{stopped}`                    | `endReason:"lifetime"`、`ms`      |
| 启动失败        | 冷却 `[0, 5s, 30s]`；10 分钟内 4 次 ⇒ 熔断 10 分钟（db-client 范式，`db-client.ts:30-32,175-200`）             | `503 E_LAUNCHER{reason:"cooldown"\|"breaker", retryAfterS}`                            | `code`、`failures`                |
| 首条消息内存    | 每条 ≤48 KiB，全局 ≤ `maxProcesses × 48 KiB`                                                                   | 由进程上限间接保证，不会单独耗尽                                                       | `textLen`                         |
| 磁盘：记录      | `spawns.json` ≤64 KiB（非终态 ≤16 + 终态 ≤20 条）                                                              | 淘汰最旧的终态记录                                                                     | —                                 |
| 磁盘：stderr    | 每文件 256 KiB，目录最多 20 个文件（≤5 MiB）                                                                   | 文件到上限后停写并追加 `[truncated]`；新建时淘汰 mtime 最旧的                          | `stderrDropped`、`stderrLogError` |
| 持久化失败      | —                                                                                                              | 意图写不进去就不 fork：`503 E_LAUNCHER{reason:"persist"}`，策略切到 `persist`          | `code:"E_PERSIST"`                |
| reaper 不可用   | 重启退避 `[1s, 5s, 30s]`，10 分钟 4 次 ⇒ 不可用                                                                | 拒绝新 spawn：`503 E_LAUNCHER{reason:"reaper"}`；已有会话继续运行                      | `code:"E_REAPER"`                 |
| CPU / 内存      | **不限制**（明确退化）。S2 可选 `systemd-run --user --scope`（会保持 pid，因为 scope 模式在调用者进程内 exec） | —                                                                                      | —                                 |
| pi 写的会话文件 | 不由 hub 管理（与终端里启动 pi 一样）                                                                          | —                                                                                      | —                                 |

**CPU/内存不限制的风险接受记录（复审 #11，主会话裁定 2026-10-04）**：S1 明确不为受管子进程设 CPU/内存硬限。接受理由：①威胁模型是「同 hub 全信任」（§6.0）——LAN 任何人本就可以停任何受管会话，滥用资源的唯一行为者就是合法用户自己；②总暴露面已被 `maxProcesses × maxLifetimeMinutes` 间接封顶（默认 4 进程 × 720 分钟），与终端里手开 4 个 pi 等价；③pi 自身还会拉起 bash/subagent，在 hub 侧单独限 pi 的 CPU/内存既不完整也不等价于限总资源；④Linux 上真要硬限，`systemd-run --user --scope` 是已记录的 S2 路径（保持 pid、调用者进程内 exec），macOS 无等价物时明示退化。残余风险：一个失控子进程可以拖慢宿主机直到 `maxLifetimeMinutes` 到期或被用户停掉——接受，因为这与用户自己在终端跑 pi 的风险完全相同。

**回收顺序**：hub **从不为了接纳新会话而结束已在运行的会话**；资源不够就拒绝新请求。只有终态记录和 stderr 文件按最旧优先淘汰。

### 6.6 审计

`auditSpawn(log, record)` 写入 `hub.log`（0600），`audit:"spawn"`，**逐字段白名单拷贝**：

```ts
interface SpawnAuditRecord {
  phase: "request" | "reject" | "state";
  endpoint?: "list" | "dirs" | "spawn" | "stop";
  reqId?: string;
  listener?: "loopback" | "lan";
  ip?: string;
  user?: string;
  spawnId?: string;
  cwd?: string /* realpath；取证需要，例外允许 */;
  known?: boolean;
  confirmed?: boolean;
  dup?: boolean;
  pid?: number;
  state?: SpawnState;
  code?: string | null;
  endReason?: SpawnEndReason;
  exitCode?: number | null;
  signal?: string | null;
  ms?: number;
  limit?: "global" | "principal" | "starting";
  active?: number;
  max?: number;
  firstPrompt?: FirstPromptState;
  textLen?: number;
  attempts?: number;
  identity?: "ok" | IdentityRejectReason;
  reaper?: "track" | "untrack" | "escalate";
}
```

不记录：stderr 内容、首条消息正文或哈希（U7）、请求原始 `cwd` 字符串、扩展对话框标题。reject 行由路由写；状态迁移每次一行。

## 7. 生命周期

### 7.1 支持平台（#6）

| 平台                          | S1 行为                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux（含 WSL2），procfs 可读 | 支持                                                                                                                                                                                                          |
| Linux，探针失败               | supervisor `init()` 依次探测 `/proc/self/stat`（可解析 starttime 与 pgrp）、`/proc/sys/kernel/random/boot_id`、`/proc/self/fd`（能 `open(O_DIRECTORY)` 一个目录并 `stat` 其 fd 路径）。任一失败 ⇒ fail closed |
| macOS / 其他 POSIX / Windows  | fail closed                                                                                                                                                                                                   |

fail closed 的含义：`spawn.v1` 照样出现在 caps 里（让 UI 能解释原因）；`GET /api/headless` 返回 `{policy:{allowed:false, reason:"platform", detail}, items:[]}`；`POST` 返回 `403 E_SPAWN_DENIED{reason:"platform"}`；不启动 reaper，不写 `spawns.json`，不 fork 任何进程。`/webhub status` 显示 `spawn unsupported(platform)`。

### 7.2 生命周期不变量（#1）

| #   | 不变量                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1  | **意图先于子进程**：每个子进程 fork 之前，`spawns.json` 里已经同步落盘了一条 `state:"launching"` 的记录（spawnId、cwd、createdAt、owner）。fork 返回后，在**同一个同步段**内读 `/proc/<pid>/stat`，并把 `pid/procStartTicks/bootId/uid` 同步落盘 |
| L2  | **hub 存活期间被看守**：每个非终态子进程都已登记给 reaper；reaper 不可用时拒绝新 spawn（§6.5）                                                                                                                                                   |
| L3  | **hub 以任何方式死亡后有界消失**：hub 死亡（正常 close、SIGTERM、crash、SIGKILL、OOM）后 ≤ `ORPHAN_BOUND_MS = 12s` 内，所有受管子进程都会结束，前提是 reaper 没有和 hub 一起被杀。即使 hub 永不重启也成立                                        |
| L4  | **双重失效时下次启动兜底**：reaper 与 hub 同时死亡（例如被一起 `kill -9`）时，残留进程由下一个 hub 启动时回收（§7.7）。两者都死、hub 也永不重启，是唯一已接受的残余风险，写进文档                                                                |
| L5  | **不误杀**：任何 `kill` 调用前，都在同一同步段内用 §7.4 重新核验身份；核验失败就不发信号                                                                                                                                                         |

### 7.3 方案比较与选型

| 方案                                                                      | 机制                                                                                                                                                                                             | 优点                                                                          | 缺点                                                                                           | 结论                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------- |
| P1 不 detach + 父死亡信号                                                 | node 没有 `prctl`；只能用 `setpriv --pdeathsig SIGTERM pi …` 包一层（setpriv 会 exec，所以 pid 不变）                                                                                            | 内核保证，hub SIGKILL 也立即送达                                              | 依赖 util-linux ≥2.33 的外部二进制；PDEATHSIG 绑在**父线程**上；不 detach 就没法组杀 pi 的后代 | S2 可选加固，不作为主线   |
| P2 Job / cgroup 监管                                                      | `systemd-run --user --scope` 或 cgroup v2 `cgroup.kill`                                                                                                                                          | 最强：整个 cgroup 一次清空，还能顺带做 CPU/内存上限                           | 需要用户级 systemd 或 cgroup 委托；容器、WSL、无 systemd 的环境不可用                          | S2 可选（`spawn.cgroup`） |
| **P3 stdin EOF + 独立 reaper 子进程 + 意图先落盘 + 下次启动回收（选定）** | 第一层：hub 死亡 ⇒ 子进程 stdin EOF ⇒ pi 有序退出（`rpc-mode.js:641-644`）。第二层：reaper 子进程检测到与 hub 之间的管道 EOF ⇒ 对仍存活的子进程做 TERM→KILL。第三层：L1 落盘 + 下次 hub 启动回收 | 纯 node + procfs，没有外部依赖；第二层覆盖「pi 卡在 dispose」「hub 永不重启」 | reaper 与 hub 同时被杀时只剩第三层                                                             | **选定**                  |

**reaper 设计**：

- 由 hub 用 `spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", REAPER_SOURCE], {detached: true, stdio: ["pipe", "pipe", "ignore"]})` 拉起（与 `db-client.ts:177` 同一种内联脚本方式）。`detached` 让它有自己的进程组，发给 hub 进程组的信号不会带走它。hub 对它 `unref()`。
- 协议是 NDJSON（stdin 上行，stdout 下行）：hub → reaper 发 `{op:"track", spawnId, pid, startTicks, bootId, uid}` / `{op:"untrack", pid}`；reaper 启动后 2s 内回 `{ok:"ready"}`，否则 hub 视为启动失败。
- reaper 在 stdin `end`/`error` 时（即 hub 已死或正常 close 结束）：先等 `REAPER_GRACE_MS = 5s`（给 pi 自己的 EOF 有序退出留时间），然后对每个仍被跟踪的 pid **核验身份**，通过才 `kill(-pid, "SIGTERM")`；再过 3s 重新核验，仍存活就 `kill(-pid, "SIGKILL")`；1s 后 `process.exit(0)`。整个过程 ≤ 5+3+1 = 9s，比 `ORPHAN_BOUND_MS` 少留 3s 余量。
- 第二次 SIGTERM 对卡在 dispose 的 pi 也有效：pi 的 `shutdown()` 在 `shuttingDown` 已经为真时会直接 `process.exit`（`rpc-mode.js:581-584`）。
- reaper 自身意外退出时，hub 按 db-client 的退避重启（`[1s, 5s, 30s]`，10 分钟内 4 次 ⇒ 不可用，§6.5），重启后把所有非终态记录重新 `track` 一遍。
- reaper 不写盘，也不打开 hub.log；诊断信息只通过 stdout 行回报给 hub（hub 活着时）。

### 7.4 身份判定（唯一定义，#2）

`verifySpawnedIdentity(expected, deps)` 定义在 `protocol/proc-identity.ts`，hub、reaper（内联脚本里复制同一份逻辑，测试钉住两份行为一致）、孤儿回收共用：

| 检查                 | 来源                                             | 失败原因                              |
| -------------------- | ------------------------------------------------ | ------------------------------------- |
| 平台                 | `process.platform === "linux"`                   | `non-linux`                           |
| boot id              | `/proc/sys/kernel/random/boot_id` 等于记录       | `boot-mismatch`                       |
| 进程存在             | 读 `/proc/<pid>/stat`、`/proc/<pid>/status`      | `no-proc`                             |
| 启动时刻             | stat 第 22 字段 starttime 等于记录               | `starttime-mismatch`                  |
| uid                  | status 的 `Uid:` 行 real 与 effective 都等于记录 | `uid-mismatch`                        |
| 组杀前提（仅组杀时） | stat 的 pgrp 字段等于 pid                        | `pgrp-mismatch`（退化为只杀单个 pid） |

**cmdline 与 comm 只作诊断**：pi 启动时执行 `process.title = "pi"`（`dist/bundle/cli-runtime.js`），Linux 下 `/proc/<pid>/cmdline` 会被改写成 `pi` 加填充字节，`comm` 也变成 `pi`。v1 写的「cmdline 含 `--mode rpc`」在真实 pi 上永远不成立，v2 删除。hub 只把 `comm` 写进审计的诊断字段，不参与任何判定。conformance 测试用真实 pi 钉住这两点：`cmdline` 不含 `--mode`，且 `verifySpawnedIdentity` 对真实 pi 返回 ok。

### 7.5 状态机（每条记录）

```
          意图落盘(launching) ── fork 同步抛错 / 'error' / 5s 无 'spawn' ─────────────▶ failed{spawn_error}
               │
               ▼ pid+身份同步落盘，reaper track
           starting ──agent_up(pid 匹配 ∧ cwd 匹配)──▶ starting(bound) ──session──▶ live ──(首条消息 §4.6)
               │   │            └ cwd 不匹配 ─▶ stopping{cwd_mismatch} ─▶ failed{cwd_mismatch}
               │   ├─ registerDeadlineAt 到期 ─▶ stopping{register_timeout} ─▶ failed{register_timeout}
               │   ├─ ui_request 头部不可解析 ─▶ stopping{protocol_error} ─▶ failed{protocol_error}
               │   └─ exit（未 live）──────────────────────────────────────▶ failed{exited_early}
               │
          live ──stop / lifetime / hub 关停 / protocol_error ──▶ stopping ──exit──▶ exited{user|lifetime|hub|protocol_error}
          live ──exit（非 stopping）─────────────────────────────────────────▶ exited{crash}（不自动重拉）
          stopping 内的升级：stdin.end() ─5s─▶ SIGTERM(-pgid) ─3s─▶ SIGKILL(-pgid) ─5s─▶ 兜底终态（exit.unconfirmed，pid 留给回收）
          hub 启动：持久化里的非终态记录 ─▶ §7.7 回收 ─▶ exited{orphan}
```

- 终态只由 `exit` 或升级兜底推进；每次迁移都持久化、推送 `spawns`、写审计。
- 终态记录保留最近 20 条；`launching` 是只落盘、不上 wire 的内部态（wire 上显示为 `starting`）。

### 7.6 deadline 分级（#4）

唯一载体是 `ReqDeadline`（`hub/req-deadline.ts:35-44`，`{remaining()}`，内部是绝对时刻）。它由入口创建、一路向下传递；每个下游步骤用 `deriveBudget(remaining, cap, reserve)`（`:57`）切出自己的预算。新增 `RunningHub.close(reason, opts?: {deadline?: ReqDeadline})`（可选参数，向后兼容）。

| 入口                 | 创建者                                                                                             | 总预算                                                                                  | spawn 子系统分到的预算                                                                                                                                                                                                                                   | 保证                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST /api/headless` | `routes.ts`，`createReqDeadline(now, WRITE_TOTAL_MS)`                                              | 13s                                                                                     | `admit`：`deriveBudget(r, 2000, 3000)`；意图落盘与 fork：同步，开始前要求 `r ≥ 500ms`，否则 `504 E_DEADLINE` 且不 fork                                                                                                                                   | 202 返回时：意图与 pid 已落盘、reaper 已 track（管道写入已排队）                                              |
| 正常 `close(reason)` | `hub.ts` close 开头，`createReqDeadline(now, HUB_CLOSE_DEADLINE_MS)`                               | 10s（`hub.ts:83`）                                                                      | `supervisor.shutdown(d)`：等待预算 `deriveBudget(r, 3000, 6500)`（给 fe/agentServer/owner 留出余量）；超时后对仍存活者 SIGTERM；`store.flushAndClose(d)` 同步写一次；stderr 刷写 `deriveBudget(r, 300, 6000)`；最后关闭 reaper stdin，由 reaper 继续升级 | 子进程收到 EOF，最多等 3s 优雅退出，然后 TERM；记录落盘为终态或 `stopping{hub}`；之后 ≤9s 内 reaper 保证 KILL |
| SIGTERM / SIGINT     | `installProcessHandlers`（`hub.ts:689`）调用 `close("signal")`                                     | 同正常 close                                                                            | 同上                                                                                                                                                                                                                                                     | 同上                                                                                                          |
| uncaughtException    | `onCrash` 创建 `createReqDeadline(now, STEP_DEADLINE_MS - 500)`，传给 `close("crash", {deadline})` | 2.5s（3s 硬退出之前）                                                                   | 等待预算为 0：同步 `stdin.end()` + SIGTERM 全部子进程 + 同步落盘一次；不刷 stderr                                                                                                                                                                        | 尽力落盘；reaper 负责升级                                                                                     |
| SIGKILL / OOM        | 无（hub 代码不运行）                                                                               | —                                                                                       | —                                                                                                                                                                                                                                                        | 内核关闭管道 ⇒ 子进程 EOF；reaper 管道 EOF ⇒ ≤9s 内 TERM→KILL；记录在下次启动时回收                           |
| 单条记录的等待       | supervisor 内的绝对时刻                                                                            | `registerDeadlineAt`、`lifetimeDeadlineAt`、`firstPromptDeadlineAt`、停止升级的三个时刻 | 全部用 unref timer，到期时与 `now()` 比较，不信任 timer 精度                                                                                                                                                                                             | —                                                                                                             |

同步 IO（意图落盘、`flushAndClose`、`/proc` 读取、`open(O_DIRECTORY)`）**不可取消**：只在开始前检查余量，并用体量上限保证耗时有界（`spawns.json` ≤64 KiB，单次 write + rename）。文档不把它们写成可被 deadline 打断。

### 7.7 持久化与回收（#1 #5）

**文件** `<stateDir>/spawns.json`（0600），格式：

```jsonc
{
  "v": 2,
  "gen": 17, // 每次写入递增
  "writer": { "pid": 4242, "startedAt": 1759550000000, "bootId": "…" },
  "records": [
    {
      "spawnId": "sp_Ab3dEf9hIj0K",
      "state": "launching|starting|live|stopping|exited|failed",
      "cwd": "/home/u/proj",
      "dev": 2049,
      "ino": 1234567,
      "createdAt": 0,
      "updatedAt": 0,
      "owner": { "listener": "loopback", "user": null, "reqId": "…" },
      "pid": 5151,
      "procStartTicks": 123456,
      "bootId": "…",
      "uid": 1000, // 意图态没有这四项
      "agentKey": "a5151-abcdef",
      "endReason": null,
      "exit": null,
      "hint": null,
      "firstPrompt": { "state": "pending", "textLen": 120 }, // 从不写正文
      "stderrLog": "sp_Ab3dEf9hIj0K.stderr.log",
    },
  ],
}
```

**写入语义（`store.ts`）**：

- 所有写入都是**同步**的：`writeFileSync(tmp, …, {mode: 0o600})` → `renameSync(tmp, file)`，tmp 名为 `spawns.json.tmp-<pid>-<gen>`。单线程下天然串行，不存在交错写。进程级崩溃不需要 fsync（页缓存在进程死亡后仍然有效）；整机掉电时子进程也一起消失，所以同样不需要。
- `markDirty()` 启动 200ms 防抖 timer（unref）；**L1 的两次写入**（意图、pid）调用 `saveNow()`，绕过防抖。
- `flushAndClose(deadline)`：`closed = true` → 清掉防抖 timer → 有脏数据就同步写一次 → 之后所有写调用都是 no-op（第一次时打一行 debug 日志）。可重复调用。
- **写失败**（ENOSPC、EIO、EACCES、rename 失败）：尽力 `unlink(tmp)`；把 `persistHealthy` 置为 false，`policy.allowed=false, reason:"persist"`，**新 spawn 一律拒绝**（意图落不了盘就不 fork，L1）；已有会话继续运行，每次迁移仍尝试写，第一次成功即恢复。连续失败只打一次 error 日志，之后每 60s 一次。
- 读取：≤256 KiB，解析失败就把文件改名为 `.corrupt-<ts>`（只保留一份），按空记录处理。

**回收（hub 启动时，`init()` 内，读阶段有界 2s，信号阶段异步不阻塞启动）**：

| 记录形态                                 | 处理                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 非终态，有 pid 与身份                    | `verifySpawnedIdentity` 通过 ⇒ `kill(-pid, "SIGTERM")`，3s 后再核验一次，仍存活 ⇒ `SIGKILL`；不通过 ⇒ 不发信号。两种情况都记为 `exited{orphan}`，审计带 `identity`                                                                                                                            |
| `launching`（意图已落盘、pid 未落盘）    | 扫描 `/proc/*/environ`（只看同 uid 进程，最多 4096 个，1s 预算），找 `PI_WEBHUB_SPAWN_ID=<spawnId>` 且 `comm==="pi"` 且 `pgrp===pid` 且 starttime 晚于本次 boot 内的 `createdAt - 1s`（用 `/proc/stat` 的 `btime` 换算）的进程；命中 ⇒ 按上一行处理；未命中 ⇒ `failed{spawn_error}`，不发信号 |
| 终态                                     | 保留（最多 20 条）                                                                                                                                                                                                                                                                            |
| `writer.bootId` 与当前不同（重启过机器） | 所有非终态记录直接标 `exited{orphan}`，不发任何信号                                                                                                                                                                                                                                           |

**删除会话追加字段（web-hub-delete-session plan v2 §2.1/§2.6，commit 70a15d3）**：记录可带 `removeIntent?: true`（`POST /api/agents/remove` 接受删除托管会话时**同步** `saveNow()` 落盘，然后走停止梯）与 `noProcess?: "never-forked" | "boot-changed"`（无进程可探测的正面证据）。只有「确认已死」（身份 bootId+starttime+uid 探测得 ENOENT/ESRCH，或 `noProcess` 证据）才删除记录；探测只读、不发信号，`alive`/`unknown` 一律放弃删除（清掉 `removePending`、卡片恢复，409 `E_AGENT_ONLINE{reason:"exit-unconfirmed"}`）。hub 崩溃后重启：带 `removeIntent` 的记录在上表回收流程之后进入收敛——确认已死 ⇒ 删除记录 + 广播 `agent_removed`；仍存活 ⇒ 放弃删除并清 intent。**幂等口径变化**：记录被删后，同一 `id` 在去重 TTL 内重放 `POST /api/headless` 返回 409 `E_BAD_REQUEST{reason:"spawn-gone"}`（在速率令牌消耗之前判），绝不重新 fork。

### 7.8 stderr 与 hub 收尾（#10）

**stderr sink（`stderr-sink.ts`）**：

- 内存：64 KiB 环形缓冲（按字节，O(1) 追加），用于 `stderrTail` 和 `hintDetail`。
- 磁盘：单写者队列，待写字节 ≤64 KiB，溢出时丢掉最旧的块并累计 `dropped`；同一时刻只有一个 `fh.write` 在途。文件到 256 KiB 停写并追加一行 `[truncated N bytes]`。
- 写错误（ENOSPC/EIO）：关闭该文件句柄、`stderrLogError = code`，此后只保留环形缓冲。
- 慢盘：只会让队列积压到上限然后丢弃，不会让 hub 内存增长，也不阻塞 stdout 读取（stdout 与 stderr 是两条独立的流）。
- 关闭：`close(deadline)` 在 `deriveBudget` 预算内等在途写入完成，超时就放弃剩余队列（句柄在在途写完成后关闭）。
- 目录：`<stateDir>/spawn/`，0700；最多 20 个文件，新建时按 mtime 淘汰最旧的。

**hub 收尾场景**：

| 场景                      | 行为                                                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常 / SIGTERM close      | §7.6 第二行。`close()` 里在 `await bounded(fe.close())`（`hub.ts:648`）**之前**调用 `supervisor.shutdown(d)`。注意：运行期 `close()` 不会执行 `cleanup` 数组（那只在启动失败时执行，见 upload plan #13），所以必须显式调用 |
| crash                     | §7.6 第四行                                                                                                                                                                                                                |
| SIGKILL / OOM             | L3：EOF + reaper                                                                                                                                                                                                           |
| supersede（版本替换）     | 静默判据（`supersede.ts:193`）增加「受管 live agent 都不忙，且没有正在发送的首条消息」；强制路径（30 分钟上限）照常。banner 文案提示「N 个网页会话将结束」                                                                 |
| idle 自退                 | 不会发生：子进程存在时 `idle.counts().headless > 0`（`hub.ts:626`）                                                                                                                                                        |
| `/webhub stop`、`restart` | 在 TUI 提示中显示 hub.json 的 `spawn.count`；不阻止操作                                                                                                                                                                    |

## 8. 接口契约

### 8.1 protocol/spawn.ts（摘要；完整字段以 `plan.md` SP1 为准）

```ts
export type SpawnState = "starting" | "live" | "stopping" | "exited" | "failed";
export type SpawnEndReason =
  | "user"
  | "lifetime"
  | "hub"
  | "crash"
  | "orphan"
  | "protocol_error"
  | "spawn_error"
  | "register_timeout"
  | "exited_early"
  | "cwd_mismatch";
export type FirstPromptState = "pending" | "sending" | "delivered" | "failed" | "expired";

export interface SpawnRecordPublic {
  spawnId: string;
  state: SpawnState;
  createdAt: number;
  updatedAt: number;
  cwdLabel: string;
  pid?: number;
  agentKey?: string;
  linked?: boolean;
  control?: boolean;
  origin: { listener: "loopback" | "lan"; reqId: string };
  endReason?: SpawnEndReason;
  exit?: { code: number | null; signal: string | null; unconfirmed?: true };
  hint?: SpawnHint;
  uiCancelledCount?: number;
  firstPrompt?: { state: FirstPromptState; code?: string };
}
export interface SpawnRecordOwner extends SpawnRecordPublic {
  cwd: string;
  origin: { listener: "loopback" | "lan"; reqId: string; user?: string };
  hintDetail?: string;
  stderrTail?: string;
  uiCancelled?: Array<{ method: string; title?: string; at: number }>;
  firstPrompt?: { state: FirstPromptState; code?: string; textLen: number; attempts: number };
}
export interface SpawnsPayload {
  items: SpawnRecordPublic[];
  active: number;
  max: number;
}
export interface SpawnPolicyWire {
  allowed: boolean;
  reason?: "platform" | "launcher" | "persist" | "reaper" | "cooldown" | "breaker";
  detail?: string;
  retryAfterS?: number;
  confirm: "always" | "unknown-dir";
  scope: "known" | "roots";
  max: number;
  maxPerPrincipal: number;
  active: number;
  activeMine: number;
  registerTimeoutS: number;
  maxLifetimeMinutes: number;
}
export interface SpawnRequestBody {
  id: string; // /^[A-Za-z0-9_-]{16,64}$/，主体内幂等
  cwd: string; // ≤4096
  confirm?: true;
  expectCwd?: string;
  firstPrompt?: { text: string; deliver?: "steer" | "followUp" }; // text ≤48 KiB，UTF-8
}
export interface SpawnAccepted {
  spawnId: string;
  state: "starting";
  cwd: string;
  dup?: true;
  firstPrompt?: "accepted";
}
```

### 8.2 HTTP 端点与未启用响应矩阵（#13）

| 方法与路径                                                                                    | 请求                                  | 成功                                                                                                                                                                         | 错误                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/headless`                                                                           | 头 `X-PWH: 1`                         | `200 {policy: SpawnPolicyWire, items: Array<SpawnRecordOwner \| SpawnRecordPublic>}`（按请求主体逐条投影，§6.4）                                                             | 403 `E_CSRF`（缺 X-PWH）；401 `E_AUTH`；429 `E_RATE`                                                                                                                                                                                                                                                                                                                |
| `GET /api/headless/dirs`                                                                      | 头 `X-PWH: 1`                         | `200 {recent: DirEntryWire[], partial?: true}`（S1 不接受 `?path=`，带了就 400 `E_DIR{reason:"browse-unavailable"}`）                                                        | 同上                                                                                                                                                                                                                                                                                                                                                                |
| `POST /api/headless`                                                                          | `SpawnRequestBody`                    | `202 SpawnAccepted`                                                                                                                                                          | 400 `E_BAD_REQUEST`；400 `E_DIR{reason}`；403 `E_SPAWN_DENIED{reason}`；409 `E_CONFIRM_REQUIRED{resolvedCwd, reason}`；409 `E_LIMIT{limit, active, max}`；413；429 `E_RATE`；503 `E_LAUNCHER{reason, retryAfterS?}`；504 `E_DEADLINE`                                                                                                                               |
| `POST /api/headless/:spawnId/stop`                                                            | `{force?: true}`                      | `202 {state}`（终态记录幂等返回当前状态）                                                                                                                                    | 404 `E_NOT_FOUND`；403 `E_CSRF`；401；429                                                                                                                                                                                                                                                                                                                           |
| `POST /api/agents/remove`（删除会话，plan `docs/dev/web-hub-delete-session/plan.md` v2 §2.4） | `{agentKey}` 或 `{spawnId}`（二选一） | `200 {removed:true}`（已删或本就不存在，幂等）；`202 {removed:false, pending:true, spawnId, state:"stopping"}`（托管会话进入停止宽限，确认死亡后删除并广播 `agent_removed`） | 409 `E_AGENT_ONLINE{reason:"online"\|"exit-unconfirmed"}`；403 `E_SPAWN_DENIED{reason:"lan-off"}`（LAN 且 `spawn.lan:"off"` 的非终态托管卡片）；404 `E_NOT_FOUND`（`spawnId` 形式但托管面不可用）；400 `E_BAD_REQUEST`；408 `E_DEADLINE`（读 body 超时，关闭连接）；413 `E_BAD_REQUEST`（body >4 KiB，关闭连接）；403 `E_CSRF`；401；429 `E_RATE`；504 `E_DEADLINE` |

删除端点两个 listener 都分发（`hub/agent-remove.ts`），每个请求写一行 `audit:"remove"`；离线 TUI / 外部离线 rpc 卡片只删 registry 卡片、不发任何信号；会话 jsonl 永不删除。`agent_removed` SSE 的发布顺序固定为 dropAgent → 清除该 agent 的 SSE 订阅 → publish。

**未启用 / 不可用时的响应矩阵**（唯一定义，plan、测试、验收都引用这一张；「现状」列是 `0d81592` 的实测行为）：

| 情形                                  | loopback GET `/api/headless*`                           | loopback POST `/api/headless*`                                                 | LAN GET `/api/headless*`                     | LAN POST `/api/headless*`                | SSE `spawns` | caps `spawn.v1` |
| ------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- | ---------------------------------------- | ------------ | --------------- |
| **未启用**（无 `config.spawn`）= 现状 | 401（未登录）/ 404 `E_NOT_FOUND`（`http.ts:2138-2143`） | 403 `E_CSRF`（csrfOk 失败）/ 401 / **501 `E_NOT_IMPLEMENTED`**（`:2103-2135`） | 404（不鉴权，`:1266`）                       | 403 `E_CSRF` / 401 / 404（`:1145-1228`） | 不发         | 无              |
| 启用，LAN `lan:"off"`                 | 正常                                                    | 正常                                                                           | **与未启用相同**                             | **与未启用相同**                         | LAN 不发     | 有              |
| 启用，平台不支持 / 探针失败           | 200 `policy.allowed=false, reason:"platform"`           | 403 `E_SPAWN_DENIED{reason:"platform"}`                                        | 按 LAN 策略：off ⇒ 同未启用；否则同 loopback | 同左                                     | 发（空列表） | 有              |
| 启用，launcher/persist/reaper 不可用  | 200 `policy.allowed=false, reason`                      | 503 `E_LAUNCHER{reason}`                                                       | 同左（按 LAN 策略）                          | 同左                                     | 发           | 有              |

闸门顺序（POST）：Host → strictCsrf → authorize → 平台 / 策略 → 速率 → 读 body（≤ `SPAWN_BODY_MAX` = 52 KiB，容纳首条消息）→ schema → 幂等预查 → admit（有界）→ 确认判断 → 二次鉴权 → 限额（同步）→ 意图落盘 → fork → pid 落盘 → reaper track → 202。从二次鉴权到 202 之间没有 await。

### 8.3 UI 契约

```ts
interface SpawnTransport {
  // HubTransport.spawn?（可选，additive）
  list(): Promise<
    { ok: true; policy: SpawnPolicyWire; items: SpawnRecordPublic[] } | { ok: false; error: string; status: number }
  >;
  dirs(): Promise<{ ok: true; recent: DirEntryWire[]; partial?: true } | { ok: false; error: string; status: number }>;
  start(req: SpawnRequestBody): Promise<SpawnOutcome>;
  stop(spawnId: string, force?: boolean): Promise<{ ok: boolean; state?: SpawnState; error?: string }>;
}
type NewSessionAction =
  | { kind: "same-cwd"; agentKey: string; cwd: string; enabled: boolean } // 现有 /new
  | { kind: "pick-dir"; enabled: boolean; reason?: SpawnPolicyWire["reason"] | "unavailable" };
```

`GET /api/headless` 返回 404 时（未启用或 LAN off），UI 把 `pick-dir` 视为 `unavailable` 并隐藏。

## 9. 数据流

```
浏览器                          hub                                                   reaper     新 pi 进程
  │ GET /api/headless/dirs        │ dirs.known()（缓存 60s）                             │          │
  │ POST {id,cwd,firstPrompt?}    │ 闸门→admit→(409 确认)→二次鉴权→限额                    │          │
  │──(确认后重发)────────────────▶│ 意图落盘 → open(O_DIRECTORY)+dev/ino → fork ──────────┼─────────▶│ cwd=/proc/self/fd/N
  │◀── 202 {spawnId} ─────────────│ pid+身份落盘 → track ─────────────────────────────▶│          │
  │◀── SSE spawns(starting) ──────│                                                      │          │ wireWebHub attach
  │                               │◀────────── hub.sock hello{kind:rpc,pid,cwd} ─────────┼──────────│
  │◀── SSE agent_up ──────────────│ pid 匹配 ∧ cwd 匹配 ⇒ 绑定                           │          │
  │                               │◀────────── session 帧 ───────────────────────────────┼──────────│
  │◀── SSE spawns(live) ──────────│ live → first-prompt：commandRouter.request(fp_<id>) ─┼─────────▶│ prompt
  │（浏览器此时可以已经断开）      │ firstPrompt.state = delivered                         │          │
  │ POST /api/headless/:id/stop   │ stdin.end ─5s→ TERM ─3s→ KILL                        │          │ EOF → shutdown → exit
  │◀── SSE spawns(exited) ────────│ exit → 终态 → 落盘 → untrack ───────────────────────▶│          │
  ╳ hub 被 SIGKILL                │                                                      │ 管道 EOF ─5s→ 核验 → TERM ─3s→ KILL
```

### 9.1 UI 形态

- AGENTS 面板标题栏的「新建会话」按钮（`AgentList.vue:94-131,150-158`，`060c33b` 已合入）改为 `NewSessionMenu` 分裂按钮。主按钮与现在的 `/new` 行为一致；下拉里有两项：「在 `<shortCwd>` 新建（/new）」（`newSessionEnabled` 公式不变）和「选择目录新建…」（条件：`hub caps ∋ spawn.v1`，且 `GET /api/headless` 成功并且 `policy.allowed`，**不依赖选中 agent**；0 个 agent 时也在 `EmptyState` 里显示）。
- `DirPicker`：路径输入框（预填选中 agent 的 cwd 或 `~`）、「最近目录」列表、可选「首条消息」多行输入（≤48 KiB，UI 端预检）。S1 没有子目录补全，也没有模型选择。
- 确认视图显示 `resolvedCwd`（textContent），LAN 下追加明文警告。
- `SpawnRow`：starting/failed 的占位行；failed 行的「详情」按钮调用 `GET /api/headless` 取 owner 明细（hintDetail、stderrTail）。
- `AgentCard.vue` 自己注入 `HUB_CTX`、按 `card.key` 查 `spawns` 来显示 `web` 徽标（不改 `contracts.ts`，也不改 `DashboardView.vue`，避开 fleet 方案的文件域）。
- `DetailHeader.vue`：受管卡片显示「停止会话」（二次确认）；首条消息 `failed/expired` 时显示一次性提示，并把发起标签页保留的正文放回 composer 草稿。
- 所有文本用 `textContent` 渲染；行内标记用英文 token（`web`、`starting`），提示性长文本用中文。

## 10. 需核实清单

| #   | 事项                                                            | 状态                                                                                                              |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| V1  | `extension_ui_request` 行首键一定是 `"type"`、第二个键是 `"id"` | 已核实（`rpc-mode.js:77` 的 `output({type, id, ...request})` + `jsonl.js` 的 `JSON.stringify`）；conformance 钉住 |
| V2  | ask_user marker 在 hub 挂起时网页对话框出现、答完后 pi 侧 abort | integration（假 rpc pi）+ 真机                                                                                    |
| V3  | 冷启动到 hello 的典型耗时（`registerTimeoutS=30` 是否够）       | 真机测量，写入 acceptance                                                                                         |
| V4  | stdin EOF 后 `runtimeHost.dispose()` 的上界                     | 真机：带一个运行中的 subagent 去 stop，观察是否进入 SIGTERM                                                       |
| V6  | rpc 模式下项目信任行为                                          | 读 `main.js:578-611` + 真机                                                                                       |
| V7  | `cwd: /proc/self/fd/N` 在 node 22 / libuv 1.51 下生效           | 已用 spike 验证（子进程 `process.cwd()` 与 `PWD` 都是目标 realpath）；SP3 单测钉住，pi 的 libuv 升级时复验        |
| V8  | `process.title="pi"` 改写 cmdline                               | 已实测（`pgrep -x pi` 两个进程的 cmdline 都是 `pi` + 填充、`comm=pi`）；conformance 钉住                          |
| V9  | reaper 内联脚本在 hub 被 `kill -9` 后存活（独立进程组）         | integration 硬门槛                                                                                                |

## 11. 测试策略

测试文件、硬门槛与命令见 `plan.md` §8，真机步骤见 `acceptance.md`。合入硬门槛（任一不过不得合入）：孤儿三场景（hub SIGKILL、子进程 `--ignore-eof`、hub 永不重启）、身份判定对真实 pi、超长 UI 请求不挂起、权限 / 可见性矩阵、资源上限、未启用响应矩阵字节不变。

## 12. 分期、依赖与风险

### 12.1 分期（#17 采纳）

| 期     | 范围                                                                                                                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1** | Linux only；known ∪ roots 准入（输入框 + 最近目录）；cwd 钉住；受管 spawn / stop；首条消息 hub 转发；`spawns` SSE（脱敏）；reaper + 意图落盘 + 启动回收；资源上限（含绝对运行时限）；launcher 版本链；审计；UI 入口、进度行、徽标、停止 |
| **S2** | 子目录浏览（`dirs?path=`）；reopen（`--session`）与 `E_SESSION_IN_USE`；「在终端继续」；空闲回收；模型选择；可选 `setpriv --pdeathsig` 加固；可选 systemd scope / cgroup 资源上限                                                       |
| **S3** | hub 成为完整 extension_ui 客户端，网页代答其他扩展的对话框（替换 D9）；`spawn.backend:"tmux"`                                                                                                                                           |

### 12.2 风险

| #   | 风险                                                         | 缓解                                                                 |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| R1  | 不读空 stdout 会让 pi 被背压卡住                             | fork 后立即挂监听；integration 用 8 MiB 输出验证                     |
| R2  | 其他扩展的对话框导致 hang                                    | §4.4 自动取消；超长行也立即应答                                      |
| R3  | 用 `-e` 加载的开发环境：子进程里没有扩展                     | 注册超时 hint `register-timeout-hello`；文档写明前提是 `pi install`  |
| R4  | hub 的 env 是陈旧快照                                        | 文档说明；`/webhub restart` 刷新                                     |
| R5  | hub 升级 / 重启会结束网页会话                                | supersede 静默判据纳入受管 busy；banner 提示；S2 reopen              |
| R6  | 子进程存活期间 hub 不会空闲退出                              | 有意为之；绝对运行时限兜底                                           |
| R7  | `PI_WEBHUB_HEADLESS` / `PI_WEBHUB_SPAWN_ID` 经 bash 工具泄漏 | 前者只影响嵌套 pi 不自启 hub；后者只扩大孤儿回收的后代范围；文档注明 |
| R8  | reaper 与 hub 同时被杀且 hub 永不重启                        | L4：唯一已接受残余风险；S2 可加 PDEATHSIG                            |
| R9  | 与 upload / fleet 的热点文件冲突                             | §12.3 + `plan.md` §2.3                                               |

### 12.3 与在途方案的合入顺序（#14）

合入顺序固定为 **upload → spawn → fleet**。spawn 的每个包在开工前先 rebase 到「upload 对应包已合入」的 master；fleet 的协议包在 spawn 的 SP1 合入后开工。热点文件的唯一 owner、各窗口与 rebase 闸门命令见 `plan.md` §2.3。spawn **不碰** `hub/registry.ts`（`getCaps` 已存在）和 `protocol/messages.ts`（不新增 agent↔hub 帧，也不升 `PROTO`），这两个文件留给 upload 与 fleet。
