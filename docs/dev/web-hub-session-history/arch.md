# web-hub「历史会话浏览与恢复」架构设计（arch v1，2026-10）

> 状态：架构稿，待评审。只设计，不含实现。
> 前置阅读：`docs/dev/web-hub-spawn/{arch,plan}.md`（managed spawn S1）、`docs/dev/web-hub-spawn-restore/plan.md`（跨 hub 重启恢复）、`docs/dev/web-hub-delete-session/plan.md`（B-alive / B-fork / B-stream）。
> 代码基线：`7086ad2`；pi 安装版本 `@earendil-works/pi-coding-agent@1.0.2`（下文 `PI` = `~/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/dist`）。

---

## 0. 结论速览

1. **列表**：新增只读端点 `GET /api/headless/history`。hub 侧有界扫描 `<agentDir>/sessions/*/*.jsonl`，不 import pi。流程：先枚举目录、stat 文件，按 mtime 倒序排列；再按需读每个文件的**头部窗口**（≤256 KiB，读到首条 user 消息就停），解析 header、首条消息、`session_info` 名称和子代理标记；结果放进**进程内**头部索引（按 ino/size 判定失效）。翻页用 keyset 游标 `(mtimeMs, key)`。每个请求都有扫描预算，预算用完的那一页停在第一个还没进索引的文件上，返回 `partial`，**从不跳过文件**。
2. **引用**：浏览器用 `session:{key, id}` 指代会话。`key` 是相对 sessionsRoot 的 `<dir>/<file>`，`id` 是 header id，两者绑定。不发一次性 token，也不接受任意绝对路径。spawn 时 hub 重新做完整复核：lstat 无 symlink、regular、owner、`O_NOFOLLOW` 打开后 fstat 的 dev/ino 与 lstat 一致、header 的 type/id/cwd 匹配。fork 前再同步复核一次 dev/ino。
3. **启动**：复用 spawn supervisor。原地恢复用 `pi --mode rpc --session <abs>`。fork 用 `pi --mode rpc --fork <abs> --session-id <hub 生成的新 uuid>`：pi 自带 `--fork`（`SessionManager.forkFrom` 语义），而且能和 `--session-id` 组合，新会话 id 由 hub 预先确定。两种模式都**不传 `--model`**（pi 从会话分支恢复模型，与 restore D8 同理）。
4. **在用检测**分三档：
   - `open`（确定）：已连接或 stale 卡片的 `session.sessionId/sessionFile` 命中；或非终态受管记录的 `sessionTarget/sessionId` 命中。
   - `maybe`（启发式）：有同 uid、`comm=pi`、**未连到 hub** 的进程，其 cwd 等于会话 cwd，并且该会话文件的 mtime 不早于这个进程的启动时间。
   - `none`。

   命中 `open` 或 `maybe`，或者会话属于子代理，就**强制 fork**：先弹警告，用户确认后才发起。`/proc/<pid>/fd` **检测不到**：pi 用 `appendFileSync` 写会话文件，不常驻 fd。cmdline 也被 `process.title="pi"` 改写，看不到参数。漏检的后果是两个进程同时追加同一个 jsonl，会话树分叉，但不会写坏 JSON 行（§4.5）。

5. **cwd**：只有 header cwd 存在、是目录、可 R|X 访问，**并且** `realpath(cwd) === header.cwd` 时才能启动。否则行置灰，原因为 `gone|not-dir|no-access|moved`。准入新增 **session-backed known**：一个通过复核的会话文件，其 header cwd 视为已知目录，不受 dirs.ts 的 30 天 / Top-50 限制。
6. **开关**：`webHub.spawn.history`。设置层默认 `true`，hub 侧缺省视为 `false`，只在 `spawn.enabled` 打开时下发。cap 为 `spawn.history.v1`。关闭时 HTTP 面、schema、caps、spawns 投影与现状逐字节一致。LAN 受 `spawn.lan` 约束，`off` 时 404，与未启用一致；其他模式下全量展示（U1）。审计不记 key、id、标题、查询串。
7. **UI**：新建会话下拉菜单新增「历史会话…」，打开 `SessionHistoryDialog`。弹窗提供搜索（服务端 q）、「含子代理」开关、置灰行、在用徽标；在用行提供「转到」和「复制为新会话」。启动流程复用 `useNewSession`：沿用其幂等、409、SpawnRow 占位，live 后跳转到新卡片。

---

## 1. 背景与目标

### 1.1 用户裁定（不得更改）

| #    | 裁定                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-H1 | 恢复 = 经现有 spawn supervisor 新起一个受管 `pi --mode rpc --session <绝对路径>`。不对任何在线 agent 做 switch_session。                                       |
| U-H2 | 会话文件正被某个活着的 pi（TUI 或 rpc）打开时，不得双开：fork 出一个新会话文件（`SessionManager.forkFrom` 语义或等价物）再启动它，并在启动前或启动时明确警告。 |
| U-H3 | header cwd 已不存在的会话：列表里置灰，不可启动。                                                                                                              |
| U-H4 | 列表范围：所有项目，按最新排序，可搜索（目录 / 标题 / 首条消息），分页；LAN 上同样全量展示（U1：LAN 唯一用户，有密码保护）。                                   |

### 1.2 约束（沿用 web-hub 不变量）

- hub 不 import pi（`tests/web-hub/boundary.test.ts:7-20,141`）。pi 的 `SessionManager.list/listAll` 会读整份 transcript，没有上限，不可用。
- 零 hang：每个 fs 步骤都有 deadline；被 race 掉的 IO 计入 zombie 计数；timer 一律 `unref()`。
- 默认关闭的 spawn 之下再加一层开关；关闭时逐字节一致。
- 规模实测（本机，2026-10）：208 个会话目录、5601 个 `.jsonl`，共 3.3 GB。单文件大小 p50 380 KB、p90 1.2 MB、p99 4.2 MB。首条 user 消息的字节偏移 p50 717 B、p90 107 KB、p99 123 KB、max 166 KB：主会话前面有体积很大的 `subagent:prompt-sections` 快照条目。**因此 4 KiB 的 header 探针读不到标题**，读标题需要 ≤256 KiB 的头部窗口，再配合索引缓存。

### 1.3 非目标

- pi 设置里自定义 `sessionDir`，或 `PI_CODING_AGENT_SESSION_DIR` 指向的会话目录。hub 不读 pi settings，与 dirs.ts 现状相同（arch §4.5）。
- 删除、重命名历史会话；预览完整 transcript（只显示标题和首条消息摘要）。
- 跨 uid、跨机器。
- 非 Linux 平台（spawn 本身 fail-closed；`maybe` 档依赖 `/proc`）。

---

## 2. 现状取证（文件:行号 @7086ad2）

| #   | 事实                                                                                                                                                                                                                              | 坐标                                                                                       | 对本设计的意义                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| E1  | dirs.ts 有界扫描范式：`KNOWN_CACHE_MS=60s`、`KNOWN_SCAN_BUDGET_MS=2s`、`KNOWN_DIR_LIMIT=50`、`KNOWN_SESSION_MAX_AGE_MS=30d`、`SESSION_HEADER_BYTES=4KiB`；single-flight；`raceDeadline` 逐步限时；超时置 `partial`                | `hub/spawn/dirs.ts:46-60,239-257,257-345`                                                  | 枚举、限时、partial 照搬这套范式；`DirFs` 注入接缝可复用                                        |
| E2  | `parseSessionHeaderHead` 只要求首行带绝对 cwd，不要求 `type:"session"`                                                                                                                                                            | `dirs.ts:196-211`                                                                          | 历史列表要求更严：必须有 `type/id/cwd/timestamp`                                                |
| E3  | `admit`：known 集合 = Top-50 / 30 天；`scope:"known"` 时不在集合里就 `not-allowed`                                                                                                                                                | `dirs.ts:362-416`                                                                          | 老项目的会话会被拒，必须新增 session-backed known（§4.8）                                       |
| E4  | `pinSync`：`O_DIRECTORY` + fstat dev/ino 复核，`cwd=/proc/self/fd/N`                                                                                                                                                              | `dirs.ts:421-441`                                                                          | cwd TOCTOU 主防线不变                                                                           |
| E5  | `SpawnRequestBody` 没有会话字段；schema `additionalProperties:false`                                                                                                                                                              | `protocol/spawn.ts:208,354-375`                                                            | 新字段只在开关打开时进入 schema（§8.1）                                                         |
| E6  | POST 闸门顺序 CSRF → auth → policy → body → schema → 幂等 → rate → admit → confirm → auth2 → start；`intentDigest` 只含 cwd/model/firstPrompt                                                                                     | `hub/spawn/routes.ts:412-683,155-165`                                                      | 新增 session 预检和在用判定，插在 admit 之后、confirm 之前；同步复核放在 auth2 与 start 之间    |
| E7  | `supervisor.start` 只同步执行：限额 → 意图落盘 → pinSync → `forkInto(argvTail)`                                                                                                                                                   | `hub/spawn/supervisor.ts:1454-1598,1603-`                                                  | argvTail 已经是参数化接缝（restore 复用过）                                                     |
| E8  | 注册时校验 `e.agent.cwd !== rec.cwd ⇒ cwd_mismatch`；rec.cwd 是 realpath                                                                                                                                                          | `supervisor.ts:1372-1375`                                                                  | `--session` 下 agent 报告的 cwd 是 header cwd 字面值（E10），所以要求 `header.cwd === realpath` |
| E9  | `planSessionArgv`：lstat 无 symlink、regular、uid，header `type/id/cwd` 匹配 ⇒ `["--session", file]`                                                                                                                              | `hub/spawn/restore-plan.ts:136-185`                                                        | 复核逻辑抽成共享的纯函数（§5.3）                                                                |
| E10 | agent 上报的 cwd = `ctx.cwd` = `sessionManager.getCwd()`；`SessionManager.open` 的 cwd 取 header cwd                                                                                                                              | `agent/index.ts:863,1224-1227`；`PI/core/session-manager.js:1326-1348`                     | 同 E8                                                                                           |
| E11 | pi CLI：`--session <含/的路径>` 不提示直接 open；文件缺失时**静默建空会话**；id 形式可能走全局匹配，并在 stdio 上提问                                                                                                             | `PI/main.js:191-216,308-326`；restore F21/F22                                              | 只用绝对路径形式，并且必须预检文件存在                                                          |
| E12 | pi CLI：`--fork <path>` 走 `SessionManager.forkFrom(path, cwd=process.cwd(), sessionDir, {id: --session-id})`；`--fork` 与 `--session/--continue/--resume/--no-session` 互斥，与 `--session-id` **可组合**；路径形式不提示        | `PI/main.js:230-262,275-284,289-307`                                                       | fork 交给 pi 自己做，hub 预先确定新 id                                                          |
| E13 | `forkFrom`：整份读取源文件（尾部被截断的行跳过），以 `wx` **立即**写新文件；新 header 为 `{type,version,id,timestamp,cwd:resolve(targetCwd),parentSession:源路径}`，复制全部非 header 条目                                        | `PI/core/session-manager.js:1374-1410,325-360`                                             | fork 产物立即落盘，cwd 是 realpath（进程 cwd 已被钉住）                                         |
| E14 | rpc 模式下 header cwd 不存在 ⇒ `MissingSessionCwdError` 后 `exit(1)`，不提示                                                                                                                                                      | `PI/main.js:552-565`；`PI/core/session-cwd.js`                                             | 仍要预检，以给出友好错误、避免占用熔断计数                                                      |
| E15 | `assertValidSessionId`：`^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`                                                                                                                                                            | `PI/core/session-manager.js:15-19`                                                         | hub 生成的 `randomUUID()` 符合；也符合 `RESTORE_SESSION_ID_RE`                                  |
| E16 | pi 写会话文件：首次 `openSync(wx)` 批量写入，此后每条 `appendFileSync`（开-追加-关），**不常驻 fd**                                                                                                                               | `PI/core/session-manager.js:794-812`                                                       | `/proc/<pid>/fd` 扫描无效（§4.5）                                                               |
| E17 | pi 启动时 `process.title="pi"`：cmdline 变成 `pi`，`comm` 也是 `pi`                                                                                                                                                               | spawn arch §2「pi 启动时执行 process.title」行                                             | 看不到 `--session` 参数；但能用 `comm` 筛出 pi 进程                                             |
| E18 | 卡片 `AgentCard{pid,cwd,state:"live"\|"stale",session?:SessionInfo{sessionId,sessionFile?,name?}}`；registry 在 pid 死亡后的下一个 tick 摘卡                                                                                      | `protocol/http-contract.ts:117-147`；`protocol/messages.ts:87-100`；`hub/registry.ts:1-13` | `open` 档的主信号源                                                                             |
| E19 | `FleetRowWire` 不带 sessionFile                                                                                                                                                                                                   | `protocol/messages.ts:316-331`                                                             | 正在运行的子代理会话无法按文件匹配，所以子代理会话一律 fork（D9）                               |
| E20 | 子代理会话用 `SessionManager.create(cwd)` 建在**父会话同一目录**里，header 不带父指针；`subagent:run` 条目写在父会话 transcript 中                                                                                                | `src/runtime/session-driver.ts:713-717`；`src/adapters/pi-run-log.ts:9`                    | 便宜识别子代理只能靠头部启发式，或新增标记（§4.3）                                              |
| E21 | 实测（本仓库目录 12 个样本）：子会话的 `subagent:prompt-sections` 只有 `pi_project_memory`；主会话还有 `pi_subagent_types`、`pi_subagent_models`，以及 `pi-hud-session-start`、`subagent:web-origin` 等只属于主会话的 custom 条目 | 实测；sysprompt 架构见 AGENTS.md「agent-types/models post-guard」                          | 头部启发式依据（§4.3）                                                                          |
| E22 | session-nav 的标题清洗（`stripSkillEnvelope`）是纯函数，但所在文件 `import type … from "@earendil-works/pi-coding-agent"`；子代理标记需要全量扫描父 transcript                                                                    | `src/session-nav/skill-titles.ts:13-50`；`subagent-sessions.ts:20-24,103-150`              | hub 不能 import。清洗逻辑在 hub 内移植一份并用对拍测试钉住；不复用全量扫描                      |
| E23 | 上传附件尾注格式由 protocol 定义                                                                                                                                                                                                  | `protocol/upload.ts:213,258`                                                               | hub 可以 import，用来从标题里剥掉附件尾注                                                       |
| E24 | hub caps：`extraHubCaps` 仅在 `config.spawn` 存在时加入 `spawn.v1/spawn.model.v1`                                                                                                                                                 | `hub/hub.ts:245-251,385-402`；`protocol/version.ts:49,63`                                  | `spawn.history.v1` 同法追加                                                                     |
| E25 | LAN `cfg.lan==="off"` ⇒ `handle` 在鉴权前 404；SSE 不发                                                                                                                                                                           | `routes.ts:852,880`                                                                        | history 端点继承                                                                                |
| E26 | `useNewSession`：每个 flow 一个幂等 id，409 后带 confirm 重发，SpawnRow 占位，`isMine` 判定后在 live 时 `navigate(agentKey)`                                                                                                      | `ui/src/composables/useNewSession.ts:1-60,210-220`                                         | 历史恢复直接复用                                                                                |
| E27 | `NewSessionMenu` 是分裂按钮 + `role=menu` 下拉，动作由 `@logic/spawn.js` 的 `newSessionActions` 计算                                                                                                                              | `ui/src/components/spawn/NewSessionMenu.vue:1-60`                                          | 新增 `history` 动作                                                                             |
| E28 | 两个进程写同一文件时 pi 没有任何锁；pi-toolkit 唯一的防护是 restore 的「先杀旧再 fork」（L6）                                                                                                                                     | `supervisor.ts:2201+`；restore plan §3.1                                                   | U-H2 的防护要在本特性里新建                                                                     |

---

## 3. 总体设计

### 3.1 模块划分与依赖方向

```
protocol/session-history.ts  (新, pi-free)  HistoryItemWire / HistoryQuery / HistoryPage / SessionRefWire / 常量 / key 与游标校验
protocol/spawn.ts            (改, 只追加)   SpawnRequestBody.session?、SpawnRequestSchemaWithSession、HubSpawnConfig.history?、
                                            SpawnRecordPublic.from?、SPAWN_HISTORY_HUB_CAP（或放 version.ts）

hub/spawn/history/                          (新目录；避开已有的 hub/history.ts＝消息历史)
  head.ts        纯函数：头部窗口逐行解析 → HeadInfo（header/首条消息/name/kind 信号）；不做 IO
  title.ts       纯函数：stripSkillEnvelope 移植 + 附件尾注剥离 + 折叠空白 + 截断；与 session-nav 对拍
  index.ts       SessionIndex：枚举（readdir/stat，带缓存 + single-flight）+ 头部索引（Map，按 ino/size 判定失效）
                 + cwd 状态缓存 + page(query, budget)
  liveness.ts    LivenessProbe：registry/managed 同步部分 + /proc 有界扫描（maybe 档）
  ref.ts         会话引用解析与 spawn 时复核：resolveRef（异步、有界）+ pinSessionSync（同步）
  routes.ts      GET /api/headless/history 处理器（由 spawn/routes.ts 的 handle 分发）
hub/spawn/routes.ts          (改) handleSpawn 插入 session 分支；intentDigest 追加 session
hub/spawn/supervisor.ts      (改) AdmittedRequest.session?；record.sessionTarget；argvTail 选择；不传 --model
hub/spawn/dirs.ts            (改) admit(…, opts?: {sessionBacked?: true})
hub/spawn/restore-plan.ts    (改) header 校验抽成 checkSessionHeader()，两处共用（restore 行为逐字节不变）
hub/audit.ts                 (改) SpawnAuditRecord 追加 session / sessionLive / sessionKind；endpoint 联合加 "history"
hub/hub.ts                   (改) 装配 SessionIndex / LivenessProbe；caps 追加
agent/index.ts               (改) buildHubConfig 在 spawn 块内写 history
src/config/*                 (改) webHub.spawn.history 设置项
src/child/wire.ts            (可选包 H0) 子会话写 `subagent:child` 标记条目（§4.3）

ui/src/logic/sessionHistory.ts    (新, 纯逻辑) 行模型/徽标/可启动性/动作集/分页与自动续扫状态机
ui/src/transport/{types,token,password}.ts (改) SpawnTransport.history?()
ui/src/components/spawn/SessionHistoryDialog.vue (新)  列表 + 搜索 + 行
ui/src/components/spawn/HistoryForkConfirm.vue  (新)  fork 警告
ui/src/components/spawn/NewSessionMenu.vue      (改)  新增「历史会话…」
ui/src/composables/useNewSession.ts             (改)  NewSessionInput.session?；409 session-open 分支
ui/src/i18n/{zh,en}/*                            (改)
```

依赖方向：`history/*` → `protocol/*`、`req-deadline`、`dirs.ts`（只读 `DirFs` 类型和 `admit`）、`ports.ts`（`SpawnRegistryPort`）。`liveness.ts` 只通过注入的回调读 registry 和 supervisor 记录，不 import supervisor，避免循环。`routes.ts` 组合上述模块，supervisor 只认 `AdmittedRequest.session`。

### 3.2 组件图（文字版）

```
浏览器 SessionHistoryDialog ──GET /api/headless/history?q&kind&cursor──▶ history/routes
                                                                           │
                                  ┌──────────── SessionIndex ──────────────┤
                                  │  enumerate(): readdir+stat (10s 缓存)    │
                                  │  ensureHead(file): ≤256KiB 头窗 → head.ts│
                                  │  cwdState(cwd): realpath/stat/access    │
                                  └──────────────────────────────────────────┤
                                  LivenessProbe.snapshot(): cards+managed+proc ┘
浏览器 ──POST /api/headless {cwd, session:{key,id,mode}}──▶ spawn/routes.handleSpawn
     gate 8  admit(header.cwd, sessionBacked) + ref.resolveRef + liveness(含 proc)
     gate 9' mustFork? mode≠fork ⇒ 409 E_CONFIRM_REQUIRED{reason:"session-open", live}
     gate 10 auth2 → [同步] liveness 复核(cards+managed) → ref.pinSessionSync → supervisor.start(session)
                                                                └▶ forkInto(argvTail = --session | --fork … --session-id …)
```

---

## 4. 关键设计

### 4.1 会话枚举与头部索引（`history/index.ts`）

**sessionsRoot** = `deps.agentDir + "/sessions"`，与 dirs.ts 同源。每次枚举都做一次有界 `realpath`，得到 `R`。key 和 spawn 引用都相对于 `R`。

**枚举** `enumerate(deadline) → {files: FileStat[], partial}`：

- `readdir(R)` 取子目录，上限 `HISTORY_DIR_LIMIT=4096`；对每个子目录 `readdir` 取 `*.jsonl` regular 文件，总量上限 `HISTORY_FILE_LIMIT=50_000`；每个文件 `stat` 取 `{ino, dev, size, mtimeMs}`。
- 每步都用 `raceDeadline`；整体预算 `HISTORY_ENUM_BUDGET_MS=1500`（取与请求余量的较小值）。超时就返回已扫到的部分，置 `enumPartial:true`。
- 结果按 `(mtimeMs desc, key asc)` 排序，缓存 `HISTORY_ENUM_CACHE_MS=10s`，single-flight。key = `<dirName>/<fileName>`。
- 不进子目录递归，不跟随 symlink：用 `withFileTypes` 判 `isDirectory()/isFile()`，symlink 两者都为 false，因此被跳过。

**头部索引** `Map<key, IndexEntry>`，其中 `IndexEntry = {ino, size, mtimeMs, head: HeadInfo | HeadError, tail?: {mtimeMs, name?}}`：

- 失效规则：`ino` 变了，或 `size < 已记录的 size`（文件被重写或截断），就重新读头部。头部内容只追加不变，mtime 变化**不会**使 head 失效，只会让 tail 失效。
- `ensureHead(file)`：用 `open(O_RDONLY|O_NOFOLLOW)` 打开，按 32 KiB 一块往后读，最多 `HISTORY_HEAD_MAX_BYTES=256 KiB`；每读完一块交给 `head.ts` 增量解析，拿到「首条 user 消息」或窗口读满就停。每个文件单独限时 `HISTORY_HEAD_FILE_MS=400`；请求级并发 4。
- `ensureTail(file)`：只对**当页要返回的行**执行，并且只在 `mtimeMs` 比上次 tail 探测新时执行。读文件最后 `HISTORY_TAIL_BYTES=16 KiB`，取其中最后一条 `session_info.name`。这样 rename 后的名字大概率能拿到，但**是尽力而为**：名字条目如果落在头窗与尾窗之间，就看不到，会回退到头窗里看到的最后一条 name 或首条消息。实测 884 个文件里只有 8 个有 `session_info`。
- 在线卡片覆盖：卡片 `session.sessionId === header.id` 且带 `session.name` 时，直接用卡片上的名字（实时，零 IO）。
- 容量：最多 `HISTORY_INDEX_MAX=50_000` 条。不在最近一次完整枚举结果里的 key 会被删掉；`enumPartial` 时不删。单条内存 ≤ ~1.5 KB（标题 200 字符、检索文本 1 KiB、cwd ≤4 KiB 字节但通常很短）。
- **进程内，不落盘**（决策 D3）。hub 重启后第一次打开要重建；首页约 50 个文件 × 中位约 60 KB，通常在一个预算内完成。全量检索靠后续请求逐步填满（§4.1.1）。

#### 4.1.1 分页与 partial 语义（核心不变量：**不跳过文件**）

`page(query, cursor, limit, deadline)`：

1. `files = enumerate()`。从 cursor 之后开始，按 `(mtimeMs desc, key asc)` 顺序遍历。cursor 是 keyset `(mtimeMs, key)`，无状态。
2. 对每个文件：已在索引中就直接过滤；不在索引中且请求预算 `HISTORY_INDEX_BUDGET_MS=1500` 和读量上限 `HISTORY_INDEX_BYTES_MAX=64 MiB` 都还有余量，就 `ensureHead` 后再过滤；**预算用完时立刻结束本页**，`next` 指向**这个文件之前**的位置，并置 `partial:{reason:"budget"}`。
3. 过滤：`kind` 过滤（`main` = `main|unknown`；`all` 不过滤），然后 `q` 子串匹配（§4.2）。
4. 满 `limit` 条，或累计响应体超过 `HISTORY_PAGE_BYTES_MAX=192 KiB` 时，结束本页，给出 `next`。
5. 返回 `{items, next?, partial?, stats:{files, indexed, enumPartial}}`。

性质：

- 翻页时文件被追加，mtime 变大、跑到顶部。keyset 游标的后果是这一行出现在「上方」，本轮翻页**不会重复**，刷新后可见；不会丢已有行。
- 预算截断的页一定在第一个未索引文件处停下，所以 `next` 续读时不会漏掉任何文件。
- 带 `q` 搜索时，命中稀疏的页可能「0 条 + next + partial」。UI 自动续扫（§7.3），直到凑满、到底，或达到续扫上限。

### 4.2 标题、首条消息、检索文本（`history/head.ts` + `title.ts`）

逐行增量解析。每行**先做前缀判定，再决定是否 JSON.parse**，避免解析 120 KB 的 prompt-sections 快照行：

| 行                                                              | 判定                                                                                                                                             | 产出                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 第 1 行                                                         | 必须完整（4 KiB 内出现换行），JSON 对象，`type==="session"`，`id` 符合 `RESTORE_SESSION_ID_RE`，`cwd` 为绝对路径且 ≤4096 B，`timestamp` 为字符串 | `id, cwd, startedAt`；`parentSession` 存在 ⇒ `forkedFrom:true`（只取布尔值，不上 wire 路径） |
| `{"type":"custom","customType":"subagent:child"` 开头           | —                                                                                                                                                | `kindSignal: "sub-marker"`（H0 标记，§4.3）                                                  |
| `{"type":"custom","customType":"subagent:prompt-sections"` 开头 | 行内出现未转义子串 `"pi_subagent_types":` ⇒ 主会话；否则 ⇒ 子会话候选。依据：JSON 字符串内的引号必须转义，未转义的形式只能是真实的键             | `kindSignal: "main" \| "sub-heuristic"`                                                      |
| `customType` 为 `pi-hud-session-start` 或 `subagent:web-origin` | —                                                                                                                                                | `kindSignal: "main"`                                                                         |
| `{"type":"session_info"` 开头                                   | JSON.parse，取 `name`（trim 后非空）                                                                                                             | `name`（保留最后一条）                                                                       |
| `{"type":"message"` 开头，且前 256 字符内含 `"role":"user"`     | JSON.parse，取 `message.content`：字符串，或第一个 `{type:"text"}` 的 `text`。**解析结束后停止读取**                                             | `firstMessage`                                                                               |
| 首条 user 消息行在窗口末尾被截断                                | 宽松提取：正则 `"text":"((?:[^"\\]                                                                                                               | \\.){0,4000})`，再 `JSON.parse('"'+m+'"')`，失败就放弃                                       | `firstMessage`（尽力而为） |
| 其他                                                            | 跳过                                                                                                                                             | —                                                                                            |

`title.ts` 清洗，只作用于首条消息：

1. `stripSkillEnvelope`：移植 `src/session-nav/skill-titles.ts:17-50` 的正则与语义，得到 `[skill名] 剩余文本`。
2. 截掉 `protocol/upload.ts` 定义的 `[web-hub attachments] …` 尾注块。
3. 空白折叠为单空格，trim。
4. 显示文本截断到 200 个 UTF-16 单位（不切开代理对）。检索文本另存：`NFKC → toLowerCase`，截到 1 KiB。

显示优先级：卡片实时 name > tail name > head name > 清洗后的首条消息 > 无（UI 显示「（无标题）」+ 短 id）。`titleSource: "name" | "first" | "none"`。

**检索** `q`：trim 后 1..128 字符，经 NFKC 小写化，做子串匹配，范围是 `cwd`（header 字面值）、显示标题、首条消息检索文本（前 1 KiB）和 `id` 前缀。只检索已进索引的文件（未进索引的文件在分页规则下根本不会被越过）。

### 4.3 子代理会话识别与默认隐藏

子代理会话在数量上占多数（本仓库目录抽样，最近 30 个文件里约 27 个是子会话），默认必须隐藏。分级：

| kind      | 判据（按优先级）                                                                                                                             | 默认（`kind=main`） | `kind=all`          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------- |
| `sub`     | 头窗内有 `subagent:child` 标记（H0，确定），或 `subagent:prompt-sections` 不含 `pi_subagent_types` 且头窗内没有任何主会话标记（启发式，E21） | 隐藏                | 显示，带 `sub` 徽标 |
| `main`    | 有主会话标记（`pi_subagent_types` 键、`pi-hud-session-start`、`subagent:web-origin`）                                                        | 显示                | 显示                |
| `unknown` | 都没有（memory 关闭或 legacy 模式，或其他扩展环境）                                                                                          | 显示                | 显示                |

- 启发式的误判方向：主会话被判成子会话，只会在主会话**既没有** agent-types/models section、**也没有** hud/web-origin 条目时发生。那意味着主会话关闭了 sysprompt 的 stable 模式和 hud。这时用户打开「含子代理」就能看到，不会丢。
- **H0（可选包，建议做）**：`src/child/wire.ts` 的 `wireChildSession` 在子会话首个 `session_start` 时执行 `pi.appendEntry("subagent:child", {v:1})`。consult fork 豁免：它由 `isConsultForkSpec` 判定，而且 fork 文件在 `cache/consult-sessions/`，不在 sessionsRoot 下。这条条目在首条 user 消息之前，随 pi 的懒落盘一起写入头部，零额外成本，让新会话的识别变成确定的。老会话继续用启发式。
- 不复用 session-nav 的 `collectSubagentMarks`：它要全量扫描父 transcript，没有上限，而且 import 了 pi 类型。不读 session-nav 的缓存文件：那是另一模块的私有格式，耦合不值得。

### 4.4 cwd 状态（列表置灰，U-H3）

按**不同的 header cwd** 做缓存（本机只有 208 个），`HISTORY_CWD_CACHE_MS=30s`：

```
cwdState(cwd):
  realpath(cwd)                 ENOENT/ENOTDIR → "gone"；其他错误 → "no-access"
  stat(rp).isDirectory()        否 → "not-dir"
  access(rp, R_OK|X_OK)         失败 → "no-access"
  rp !== cwd                    → "moved"（header cwd 现在是 symlink 或经过 symlink；--session 下 agent 会上报字面值，
                                   注册时会触发 cwd_mismatch，见 E8/E10）
  否则                          → "ok"
```

- 每步限时 `HISTORY_CWD_STEP_MS=200`；单请求总预算 `HISTORY_CWD_BUDGET_MS=500`，并发 8。预算外的 cwd 记为 `"unknown"`：UI 视为可启动，由 spawn 时的准入最终判定。
- 被 race 掉的 realpath/stat 计入 zombie 计数（沿用 preview 的 `PreviewIoTracker` 范式）。zombie 数 ≥ `HISTORY_ZOMBIE_MAX=16` 时停止新的 cwd/head 探测，直接返回 `unknown/partial`，防止挂死的 NFS 挂载点拖垮 hub。
- `startable = cwdState ∈ {ok, unknown} ∧ head 完整有效`。`blocked` 取值 `gone|not-dir|no-access|moved|invalid`，只用于展示。

### 4.5 「正被活进程打开」检测（`history/liveness.ts`）

#### 4.5.1 能检测到什么

| 信号                                                                                                                                                               | 来源                           | 档位      | 精确度                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------- |
| C1 卡片（`live`/`claiming`/`stale`）的 `session.sessionId === header.id`，或 `session.sessionFile` 归一后等于 `R/key`                                              | `registry.list()`（同步）      | `open`    | 确定。id 是 uuid，优先按 id 匹配，绕开路径字符串差异。`stale` 卡片的进程可能还活着，保守算 `open`                     |
| C2 非终态受管记录：`launching/starting` 的 `sessionTarget.{id,file}` 命中；`live` 的 `sessionId` 命中；`stopping` 且死亡尚未 confirmed 的也算                      | `supervisor.records()`（同步） | `open`    | 确定。覆盖「两个标签页同时恢复同一会话」：第二个请求能看到第一个请求 starting 记录上的 `sessionTarget`                |
| C3 同 uid、`comm==="pi"` 的进程，pid **不属于** C1/C2 任何已知 pid，且不是 hub 自身；`readlink(/proc/<pid>/cwd) === header.cwd`；会话文件 `mtimeMs ≥ 进程启动时刻` | 有界 `/proc` 扫描（异步）      | `maybe`   | 启发式：同目录下未连到 hub 的 pi，在它启动后写过这个文件                                                              |
| 子代理会话（kind `sub`）                                                                                                                                           | §4.3                           | 强制 fork | 运行中的子会话由父进程在进程内持有，fleet 行不带 sessionFile（E19），无法按文件判定；子会话本身也不该被原地续写（D9） |

进程启动时刻 = `btime + starttime / CLK_TCK`，用 `protocol/proc-identity.ts` 的 `readBtime`、`parseStartTicks`。`CLK_TCK` 按 100 计；proc-identity 已经按这个假设比较身份，口径一致。

#### 4.5.2 检测不到什么（必须写进 UI 文案与验收）

| 漏检场景                                                                                                                    | 原因                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| N1 某个未连 hub 的 pi 用 `/resume` 打开了一个**旧**会话，打开后还没写过任何条目（mtime 早于进程启动时刻）                   | C3 的 mtime 条件过滤掉了它。去掉这个条件会让同目录**所有**会话都变成 `maybe`，误报过高（D7） |
| N2 未连 hub 的 pi，cwd 与 header cwd 不同（启动后 `/resume` 了其他项目的会话；pi 不会 chdir，`/proc/pid/cwd` 仍是启动目录） | 拿不到 pi 进程打开了哪个文件：cmdline 被改写（E17），fd 不常驻（E16）                        |
| N3 其他 uid、其他 HOME/agentDir、其他机器（NFS 共享 sessions）                                                              | 超出 hub 的观察域                                                                            |
| N4 `/proc` 扫描预算耗尽或 zombie 熔断                                                                                       | 降级为只有 C1/C2，响应里标 `liveness:"partial"`，UI 加一句「未完成进程扫描」                 |
| N5 检测完成之后才打开（竞态：spawn 已经发出，随后用户在 TUI 里 `/resume` 同一个文件）                                       | 无法预防，与用户在两个终端各开一次 pi 的风险相同                                             |

`/proc/<pid>/fd` 扫描**被排除**：E16 表明 pi 只在 `appendFileSync` 的瞬间持有 fd，扫到的概率接近 0，还要付出 O(进程数×fd 数) 的代价。

**漏检的后果**（量化）：两个进程分别追加同一个 jsonl。每次 `appendFileSync` 都带 `O_APPEND`，本地文件系统上单次 write 的偏移是原子的，单行不会被撕裂。但两边各自维护内存里的 leaf，会追加两条互相交错的 `parentId` 链，会话树出现两个分支。下次 `pi --session` 打开时，leaf = 最后一条写入，用户会看到「另一边的分支」，需要用 `/tree` 切回。**不丢数据、不坏文件，但会造成困惑**。这正是 U-H2 要防的，但它不是安全或完整性事故。所以 C3 只作为第二道网，不追求零漏检。

#### 4.5.3 `/proc` 扫描边界

- `readdir("/proc")` 取数字项，上限 `PROC_SCAN_PID_MAX=8192`。对每个 pid：读 `/proc/<pid>/stat`，解析 `comm`（括号内）和 starttime，`comm!=="pi"` 就跳过；`stat("/proc/<pid>")` 的 uid 必须等于 hub uid；最后 `readlink("/proc/<pid>/cwd")`。
- 整体预算 `PROC_SCAN_BUDGET_MS=300`，单步 `raceDeadline`。结果按 `cwd → [{pid, startedAtMs}]` 汇总，缓存 `PROC_SCAN_CACHE_MS=5s`，single-flight。
- 非 Linux，或 `/proc/self/stat` 不可读：整档关闭（`maybe` 永远不出现），列表响应带 `liveness:"no-proc"`。spawn 在非 Linux 上本来就 fail-closed。

#### 4.5.4 何时计算

- **列表**：每页一次 `snapshot()`，C1/C2 是同步的，C3 走 5s 缓存。每行附 `live?: {state:"open"|"maybe", by:"card"|"managed"|"proc", agentKey?, pid?}`。仅供展示，不作为准入依据。
- **spawn**：在 gate 8' 做全量判定（C3 **绕过缓存**，fresh 扫描，预算 300ms）。gate 10 之后到 `supervisor.start` 之间再**同步**复核 C1/C2（零 await），把 auth2 期间新出现的卡片或记录也挡住。

### 4.6 fork 机制

- **执行者：pi 子进程本身**，argv 为 `pi --mode rpc --fork <R/key 的绝对路径> --session-id <newId>`（E12/E13）。
  - `newId = crypto.randomUUID()`，hub 在 start 前生成。符合 E15 的格式，也符合 `RESTORE_SESSION_ID_RE`。
  - `forkFrom` 的 `targetCwd = process.cwd()`，即被钉住的 `/proc/self/fd/N` 指向的目录；内核 getcwd 返回物理路径，等于 rec.cwd（realpath）。所以新会话 header 的 cwd 等于 rec.cwd，注册时不会 `cwd_mismatch`，之后 restore 的 `planSessionArgv` 也能对上。
  - 新文件以 `wx` 立即写入 `<agentDir>/sessions/--<encoded realpath>--/<ts>_<newId>.jsonl`，header 带 `parentSession`。源文件完全不动。
  - pi 读源文件时，若持有它的进程正在追加，尾部被截断的行会被跳过（`loadEntriesFromFile` 只解析完整行），得到的是一致的前缀快照。
- **为什么不由 hub 复制 jsonl**：hub 必须重写 header（version、parentSession、新 id）并复刻 pi 的格式约定，这是在 hub 内重新实现 pi 的会话格式，违反「hub 不懂 pi 内部」的边界。pi 一升级格式就会悄悄分叉。hub 复制还要对一个可能几十 MB、正被追加的文件做有界拷贝，复杂度更高。`--fork` 是 pi 的正式 CLI 契约，conformance 测试可以钉住（§12）。
- **为什么不用 `--session <path>` 让 pi 遇到全局匹配时提示 fork**：那是交互式 readline 分支（E11），在 rpc 下会挂住。
- **fork 的身份**：`sessionTarget = {id:newId}`（没有 file，pi 决定文件名）。goLive 时 `session.sessionId === newId`，把 `sessionFile` 记入记录，restore 就能接上。`sessionId !== newId` 时说明 pi 没按预期 fork，记 `hint:"session-unexpected"`（新增 hint 码，**不进持久化枚举**，只放在内存/owner 投影里，与 restore D11 的口径一致），会话照常 live，不终止。
- **警告 UX**（U-H2）：fork 一律由用户在 UI 里明确选择「复制为新会话」后发出（§7.4）。服务端在 `mode:"resume"` 下发现需要 fork 时，返回 409，UI 弹出同一个警告。**hub 不会自行把 resume 静默改成 fork**（D8）。

### 4.7 会话引用与 spawn 时复核（`history/ref.ts`）

**引用格式**：`session: {key: string, id: string, mode?: "resume" | "fork"}`，`mode` 缺省为 `"resume"`。

- `key` 形状：`<dir>/<file>`，恰好一个 `/`；两段都满足 `^[^/\0]{1,255}$`，不能是 `.` 或 `..`，`file` 以 `.jsonl` 结尾；总长 ≤ 512 B（UTF-8）。
- `id` 符合 `RESTORE_SESSION_ID_RE`。
- `cwd`（body 原有必填字段）必须**逐字节等于** header cwd，由客户端回显，作为第二个绑定。

**`resolveRef(ref, cwd, deadline)`**，异步，总预算 `REF_BUDGET_MS=800`：

1. 形状校验，失败 ⇒ 400 `E_BAD_REQUEST{reason:"session-ref"}`。
2. `R = realpath(sessionsRoot)`。
3. `lstat(R/dir)`：必须是目录且不是 symlink。`lstat(R/dir/file)`：regular、不是 symlink、`uid === getuid()`。ENOENT ⇒ 400 `E_DIR{reason:"session-missing"}`，**绝不让 pi 去建空会话**（E11）。
4. `open(R/dir/file, O_RDONLY|O_NOFOLLOW)` → `fstat`，dev/ino 必须等于第 3 步 lstat 的结果 → 读 ≤4 KiB 首行 → 共享的 `checkSessionHeader(header, {id, cwd})`（从 `restore-plan.ts:165-184` 抽出）→ close。不匹配 ⇒ 400 `E_DIR{reason:"session-mismatch"}`，UI 刷新列表。
5. kind：索引中有同 ino 的条目就直接用；否则做一次 `ensureHead`（≤256 KiB，400ms）。
6. 返回 `{abs: R/dir/file, dev, ino, id, cwd, kind}`。

**`pinSessionSync(resolved)`**：同步执行，紧挨 `supervisor.start` 之前，同一个 tick 内，中间没有 await。

- `lstatSync` + `openSync(O_NOFOLLOW)` + `fstatSync`，dev/ino 必须等于 resolveRef 的结果，然后 `closeSync`。失败 ⇒ 409 `E_DIR{reason:"session-changed"}`，不创建记录。

**残余 TOCTOU**：从 pin 到 pi 按路径重新打开之间，有一个微秒到毫秒级的窗口，同 uid 的攻击者可以替换文件。无法把 fd 交给 pi：`SessionManager.open` 用路径的父目录推导 sessionDir，`/proc/self/fd/N` 会推导出错误的目录。接受这个窗口：能利用它的人已经有同 uid 写权限，与 restore 的口径相同（restore plan §6.5）。

**为什么不发一次性 token**：token 需要服务端状态，hub 重启后失效、过期后要重新拉列表，而且列表本来就已经展示了 key 包含的全部信息（U1 全量展示），token 不提供额外保密性。**为什么不收绝对路径**：任意路径加上 pi「缺失即建空会话」的行为，等于允许在任意可写位置创建会话文件；把引用约束在 sessionsRoot 内，可以把攻击面收窄到 pi 自己的目录。

### 4.8 准入：session-backed known

`dirs.admit(raw, scope, deadline, opts?: {sessionBacked?: true})`：

- 前两步（形状校验、realpath/stat/access 并记录 dev/ino）不变。
- `opts.sessionBacked === true` 时，第 3 步直接判 `known:true`，不查 Top-50 集合；然后**额外要求** `realpath === raw`，否则 `{ok:false, reason:"moved"}`。
- 安全论证：会话文件已经通过 §4.7 的 owner、regular、无 symlink 复核，header cwd 是用户自己的 pi 曾经运行过的目录，与 dirs.ts 来源 ② 的信任依据相同，只是去掉了 30 天和 Top-50 这两个 UI 可用性限制。roots 模式不受影响。
- 确认流：`needConfirm = policy.confirm === "always"（LAN）|| !known`。session-backed 恒为 known，所以 loopback 不需要确认，LAN 仍然需要（明文警告照旧）。

### 4.9 与既有契约的交互

| 契约                            | 交互                                                                                                                                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认模型（default-model plan）  | 带 `session` 时，`body.model` ⇒ 400 `E_BAD_REQUEST{reason:"model-with-session"}`；hub 偏好模型**不生效**；argv 不带 `--model`（D10）                                                                                                                                   |
| 首条消息                        | 允许，用于恢复后紧接着发一句话。机制不变（live 后 followUp）                                                                                                                                                                                                           |
| restore（spawn-restore plan）   | 恢复出来的记录 goLive 后，`adoptSessionCoords` 记下 sessionId/sessionFile，自然成为 restore 候选。fork 的同理。`sessionTarget` **不持久化**：从未 live 的 starting 本来就不是候选（restore D3）。`checkSessionHeader` 抽取时 restore 行为逐字节不变（RS 测试原样通过） |
| 删除会话（delete plan）         | 不变。B-fork（同 id 删除后重放 ⇒ spawn-gone）对带 session 的请求同样成立：digest 里含 session，LRU 命中后走同一分支                                                                                                                                                    |
| 限额、速率、熔断                | 全部照旧，由 `supervisor.start` 统一执行。`session-*` 类预检失败发生在 start 之前，**不计熔断、不建记录**                                                                                                                                                              |
| 幂等                            | `intentDigest` 在有 session 时追加 `"session":{"id":…,"key":…,"mode":…}`；没有 session 时 digest 字节不变                                                                                                                                                              |
| 会话切换（session-switch plan） | 新卡片 live 后，`useNewSession` 调 `navigate` 进入现有的 keep-alive LRU，不需要额外改动                                                                                                                                                                                |

---

## 5. 接口契约

### 5.1 protocol（`protocol/session-history.ts`，新；pi-free）

```ts
export const SPAWN_HISTORY_HUB_CAP = "spawn.history.v1";
export const HISTORY_LIMIT_DEFAULT = 50;
export const HISTORY_LIMIT_MAX = 100;
export const HISTORY_Q_MAX_CHARS = 128;
export const SESSION_KEY_MAX_BYTES = 512;
export const HISTORY_TITLE_MAX = 200; // UTF-16 单位

export type HistoryKind = "main" | "sub" | "unknown";
export type HistoryCwdState = "ok" | "gone" | "not-dir" | "no-access" | "moved" | "unknown";
export type HistoryBlocked = Exclude<HistoryCwdState, "ok" | "unknown"> | "invalid";
export type ForkReason = "open" | "maybe" | "subagent";

export interface HistoryLiveWire {
  state: "open" | "maybe";
  by: "card" | "managed" | "proc";
  agentKey?: string; // by=card|managed 且已有卡片
  pid?: number; // by=card|proc
}

export interface HistoryItemWire {
  key: string; // "<dir>/<file>"，相对 sessionsRoot，是 SessionRefWire.key 的唯一来源
  id: string; // header id
  cwd: string; // header cwd 字面值
  cwdLabel: string; // basename(cwd)
  startedAt: string; // header timestamp（原样透传，ISO 字符串）
  mtimeMs: number;
  size: number;
  title?: string; // ≤ HISTORY_TITLE_MAX
  titleSource: "name" | "first" | "none";
  kind: HistoryKind;
  forked?: true; // header 带 parentSession（只给布尔值）
  cwdState: HistoryCwdState;
  startable: boolean;
  blocked?: HistoryBlocked;
  live?: HistoryLiveWire;
  forkOnly?: ForkReason; // live 或 kind=sub ⇒ 只能 fork
  indexed: true; // 预留：v1 返回的行一律已索引
}

export interface HistoryPage {
  items: HistoryItemWire[];
  next?: string; // 不透明游标（base64url("<mtimeMs>:<key>")）
  partial?: { reason: "budget" | "enum" | "zombie" };
  liveness?: "partial" | "no-proc"; // 缺省 = 完整
  stats: { files: number; indexed: number; enumPartial?: true };
}

export interface SessionRefWire {
  key: string;
  id: string;
  mode?: "resume" | "fork";
}

export function isValidSessionKey(s: string): boolean; // §4.7 形状规则，pure
export function encodeHistoryCursor(mtimeMs: number, key: string): string;
export function decodeHistoryCursor(s: string): { mtimeMs: number; key: string } | null; // 非法 ⇒ null ⇒ 400
```

`protocol/spawn.ts`（只追加）：

```ts
export interface SpawnRequestBody {
  /* …原字段… */ session?: SessionRefWire;
}
/** 仅当 HubSpawnConfig.history === true 时使用；关闭时继续用原 SpawnRequestSchema（逐字节一致）。 */
export const SpawnRequestSchemaWithSession: TObject; // = 原 schema + session: Optional(Object{key,id,mode?}, additionalProperties:false)
export function parseSpawnRequestBody(raw: unknown, opts?: { session?: boolean }): …; // opts 缺省 ⇒ 现状行为
// SpawnBodyError 追加 "session-ref" | "model-with-session"
export interface HubSpawnConfig {
  /* … */ history?: boolean;
} // 缺失 ⇒ false
export interface SpawnRecordPublic {
  /* … */ from?: "history" | "fork";
} // 只追加，枚举仅在内存/投影中
// 409 E_CONFIRM_REQUIRED 的 body 追加（只追加字段）：
//   reason: 现有值 | "session-open"
//   live?: HistoryLiveWire; forkReason?: ForkReason
// 400 E_DIR 的 reason 追加："session-missing" | "session-mismatch" | "session-invalid" | "moved"
// 409 E_DIR{reason:"session-changed"}（pin 失败）
```

### 5.2 HTTP

| 方法与路径                   | 请求                                                                                    | 成功                                                                 | 错误                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/headless/history`  | 头 `X-PWH: 1`；query `q?`、`kind=main\|all`（缺省 main）、`cursor?`、`limit?`（1..100） | `200 HistoryPage`                                                    | 403 `E_CSRF`；401；429 `E_RATE`（独立桶 `history`：容量 4、每 500ms 补 1，按主体）；400 `E_BAD_REQUEST{reason:"q"\|"cursor"\|"limit"\|"kind"}`；未启用 / LAN off ⇒ 与 `/api/headless/*` 未启用矩阵完全相同。policy 不允许（平台等）⇒ 200 照常列出，但所有行 `startable:false`、`blocked` 不变，由 UI 按 policy 显示原因 |
| `POST /api/headless`（扩展） | `SpawnRequestBody` + `session`                                                          | `202 SpawnAccepted`（追加 `session:{mode, id}`，fork 时 id = newId） | 原有错误全部保留；新增：400 `E_BAD_REQUEST{reason:"session-ref"\|"model-with-session"}`；400 `E_DIR{reason:"session-missing"\|"session-mismatch"\|"session-invalid"\|"moved"}`；409 `E_CONFIRM_REQUIRED{reason:"session-open", resolvedCwd, live?, forkReason}`；409 `E_DIR{reason:"session-changed"}`                  |

**POST 闸门（带 session 时）**，原顺序不变，只插入下列步骤：

```
1 CSRF → 2 auth → 3 policy → 4 body(≤SPAWN_BODY_MAX) → 5 schema(WithSession) + model-with-session 拒绝
→ 6 幂等预查（digest 含 session）→ 7 rate
→ 8 admit(header.cwd = body.cwd, scope, sessionBacked) ∥ resolveRef(session, body.cwd)   [两者都有界，可并行]
→ 8' liveness.full(resolved)（C1/C2 同步 + C3 fresh ≤300ms）；mustFork = live∈{open,maybe} ∨ kind==="sub"
→ 9' mustFork ∧ mode!=="fork" ⇒ 409 {reason:"session-open", resolvedCwd, live, forkReason}（不写 LRU，审计 reject）
→ 9  原 confirm（LAN always / unknown-dir；session-backed 恒为 known）
→ 10 auth2
→ [同步，零 await] liveness.syncRecheck(C1/C2)：mode==="resume" 且命中 ⇒ 409 session-open
                   pinSessionSync(resolved) ⇒ 失败 409 E_DIR{session-changed}
                   newId = mode==="fork" ? randomUUID() : undefined
→ 11 supervisor.start({..., session:{mode, abs, id, newId}})
```

带 session 的 409 `session-open` 被 UI 确认后，用**同一个 id** 重发，内容为 `mode:"fork", confirm:true, expectCwd:resolvedCwd`。digest 里 mode 变了，但 409 不写 LRU，所以不会和第一次请求冲突（与原有「409 确认不写 LRU」规则一致）。

### 5.3 hub 内部接口

```ts
// history/head.ts（纯）
export interface HeadInfo {
  id: string;
  cwd: string;
  startedAt: string;
  forked: boolean;
  name?: string;
  firstMessage?: string; // 已清洗、≤200
  search: string; // NFKC 小写，≤1 KiB（cwd + 标题 + 首条消息）
  kind: HistoryKind;
  complete: boolean; // 找到首条 user 消息，或确认文件已读到末尾
}
export type HeadError = { error: "no-header" | "bad-header" | "too-long-header" | "io" };
export function createHeadParser(): {
  push(chunk: string): "more" | "done";
  result(eof: boolean): HeadInfo | HeadError;
};

// history/index.ts
export interface SessionIndexDeps {
  agentDir: string;
  fs: HistoryFs; // readdir/stat/realpath/access/openNoFollow/read/close，可注入
  now(): number;
  cards(): readonly { sessionId?: string; name?: string }[]; // 名字覆盖
  log: HubLog;
}
export interface SessionIndex {
  page(
    q: { q?: string; kind: "main" | "all"; cursor?: { mtimeMs: number; key: string }; limit: number },
    deadline: ReqDeadline,
  ): Promise<Omit<HistoryPage, "liveness"> & { rows: IndexedRow[] }>;
  headFor(key: string, ino: number, deadline: ReqDeadline): Promise<HeadInfo | HeadError>; // resolveRef 第 5 步复用
  sessionsRoot(deadline: ReqDeadline): Promise<string | undefined>; // realpath，缓存
}

// history/liveness.ts
export interface LivenessDeps {
  cards(): readonly {
    agentKey: string;
    pid: number;
    state: string;
    session?: { sessionId: string; sessionFile?: string };
  }[];
  managed(): readonly {
    spawnId: string;
    agentKey?: string;
    pid?: number;
    state: SpawnStateInternal;
    deathConfirmed: boolean;
    sessionId?: string;
    sessionTarget?: { id: string; file?: string };
  }[];
  procFs: ProcScanFs; // 可注入
  hubPid: number;
  uid: number;
  now(): number;
}
export interface LivenessProbe {
  snapshot(deadline: ReqDeadline, opts: { fresh: boolean }): Promise<LivenessSnapshot>;
  syncRecheck(target: { id: string; abs: string }): HistoryLiveWire | undefined; // 只看 C1/C2，同步
}
export interface LivenessSnapshot {
  lookup(t: { id: string; abs: string; cwd: string; mtimeMs: number }): HistoryLiveWire | undefined;
  procState: "ok" | "partial" | "no-proc";
}

// history/ref.ts
export interface ResolvedSession {
  abs: string;
  dev: number;
  ino: number;
  id: string;
  cwd: string;
  kind: HistoryKind;
  mtimeMs: number;
}
export function resolveRef(
  ref: SessionRefWire,
  cwd: string,
  deps: RefDeps,
  deadline: ReqDeadline,
): Promise<
  { ok: true; s: ResolvedSession } | { ok: false; status: 400; code: "E_BAD_REQUEST" | "E_DIR"; reason: string }
>;
export function pinSessionSync(
  s: ResolvedSession,
  fs: RefSyncFs,
): { ok: true } | { ok: false; reason: "session-changed" };

// restore-plan.ts（抽取，restore 行为不变）
export function checkSessionHeader(
  head: string,
  expect: { id: string; cwd: string },
): { ok: true } | { ok: false; detail: string };
```

### 5.4 supervisor 改动（`hub/spawn/supervisor.ts`）

```ts
interface AdmittedRequest {
  /* … */ session?: { mode: "resume" | "fork"; abs: string; id: string; newId?: string };
}
// Supervised 追加（仅内存，不进 StoredRecord，不 bump SPAWNS_FILE_VERSION）：
//   sessionTarget?: { id: string; file?: string };   // resume: {id, file:abs}；fork: {id:newId}
//   from?: "history" | "fork";
// start(): req.session 存在时
//   - 断言 req.model === undefined（路由已拒绝；防御）
//   - argvTail = mode==="resume" ? ["--session", abs] : ["--fork", abs, "--session-id", newId]
//     （每个参数是独立元素；abs 由 R + 已校验的 key 拼成，不可能以 "-" 开头）
//   - 其余逐字节同现状（意图落盘 → pinSync → forkInto）
// goLive(): fork 时 session.sessionId !== sessionTarget.id ⇒ hint="session-unexpected"（内存/owner 投影），不终止
// publicItem / project.toPublic / toViewer：追加 from（白名单逐字段拷贝）
```

`start()` 不带 session 时 argv、持久化、投影与现状逐元素一致（SP7 验收第 1、6 条原样通过）。

### 5.5 UI 契约

```ts
// transport/types.ts — SpawnTransport 追加（可选，additive）
history?(q: { q?: string; kind?: "main" | "all"; cursor?: string; limit?: number }):
  Promise<{ ok: true; page: HistoryPage } | { ok: false; error: string; status: number; reason?: string }>;

// types.ts — NewSessionInput 追加
session?: { key: string; id: string; mode: "resume" | "fork" };
// SpawnOutcome 的 409 分支追加 live?/forkReason?（classifySpawnError 新增 "session-open"）

// logic/spawn.ts — NewSessionAction 追加
| { kind: "history"; enabled: boolean; reason?: SpawnPolicyWire["reason"] | "unavailable" }
//   条件：hub caps ∋ spawn.history.v1 ∧ GET /api/headless 成功；unavailable ⇒ 隐藏

// logic/sessionHistory.ts（纯）
export interface HistoryRowModel {
  key: string; title: string; titleIsFallback: boolean; cwd: string; cwdLabel: string;
  relTime: string; badges: Array<"live" | "maybe" | "sub" | "forked" | "gone" | "moved" | "no-access" | "not-dir">;
  actions: Array<"resume" | "fork" | "goto">; // startable=false ⇒ []
  blockedText?: string;
}
export function toRowModel(item: HistoryItemWire, ctx: { now: number; knownCards: ReadonlySet<string> }): HistoryRowModel;
export function historyListReducer(state: HistoryListState, ev: HistoryListEvent): HistoryListState; // 查询/翻页/续扫/错误
```

---

## 6. 数据流

### 6.1 列表

```
浏览器                          hub
GET history?q=&kind=main        闸门(CSRF/auth/LAN/rate) → SessionIndex.page()
                                  enumerate()（10s 缓存）→ 从 cursor 起顺序遍历
                                  ensureHead（≤256KiB/文件，预算 1.5s/64MiB）→ kind/q 过滤 → 凑满 limit
                                  当页行：ensureTail（≤16KiB，mtime 变化时）、cwdState（30s 缓存）
                                LivenessProbe.snapshot(fresh:false) → 逐行 live/forkOnly
◀── 200 {items, next?, partial?, liveness?, stats}
（partial 且本页不满）UI 自动以 next 续请求，最多 3 轮/次输入，之后显示「继续扫描」按钮
```

### 6.2 原地恢复（无人占用）

```
点击「继续」 → useNewSession.submit({cwd: item.cwd, session:{key,id,mode:"resume"}})
POST → gate 8 admit(sessionBacked) ∥ resolveRef → 8' liveness=none, kind=main → 9 loopback 不确认 → 10 auth2
     → 同步复核 → start: 意图落盘 → pin cwd → spawn("pi --mode rpc --session /…/x.jsonl", cwd=/proc/self/fd/N)
◀── 202 {spawnId, state:"starting", session:{mode:"resume", id}}
SSE spawns(starting, from:"history") → SpawnRow 占位
pi 打开会话 → hello{cwd=header.cwd=realpath} → agent_up(pid 匹配 ∧ cwd 匹配) → session 帧(sessionId=id) → goLive
SSE spawns(live) → isMine ⇒ navigate(#/agent/<key>)，transcript 从 snapshot 回放历史
```

### 6.3 被占用 → fork

```
列表行 live={open, by:"card", agentKey:K}
  UI：行内「转到」（navigate K）+「复制为新会话」→ HistoryForkConfirm（警告文案，§7.4）→ 确认
  POST {session:{…, mode:"fork"}, confirm:true, expectCwd:cwd}
  → 8' mustFork=true，mode=fork，放行 → … → start: argv "--fork /…/x.jsonl --session-id <newId>"
  → pi forkFrom（wx 写新文件）→ goLive(sessionId=newId) → navigate
竞态：列表显示 none，但 spawn 时变成 open（TUI 刚 /resume 了它）
  → 409 {reason:"session-open", live, forkReason:"open"} → UI 弹同一个警告 → 同 id 重发 mode:"fork"
```

---

## 7. UI

### 7.1 入口

- `NewSessionMenu` 下拉菜单在「选择目录新建…」之后新增「历史会话…」（`history` 动作）。可见条件见 §5.5；policy 拒绝时显示为禁用并给出原因（沿用 `spawnDeniedKey`）。
- 0 个 agent 的 `EmptyState` 中，在「选择目录」旁加同一入口。
- 不放进 DirPicker 的标签页：DirPicker 已有 510 行，两种列表的交互（路径输入 vs 检索分页）差异大；独立弹窗的文件域更清晰，与 spawn 方案「避开热点文件」的纪律一致。

### 7.2 `SessionHistoryDialog`

- 头部：搜索框（防抖 250ms，Enter 立即提交，Esc 清空，再按一次 Esc 关闭）+「含子代理」开关（`kind=all`，偏好记在 `localStorage pwh_history_kind`）。
- 行：第一行是标题（`textContent`；回退为「（无标题）· <id 前 8 位>」）；第二行是 `cwdLabel`、完整 cwd（灰色小字，`title` 属性显示完整路径）、相对时间（mtime），开始时间放在 tooltip。徽标用英文 token（AGENTS.md「UI 文本语言划分」）：`live`、`maybe`、`sub`、`fork`、`gone`、`moved`、`no-access`。
- 置灰行（`!startable`）：整行 `aria-disabled`，不显示动作，次行显示中文原因（「目录已不存在」「目录不可访问」「目录已变为符号链接」「会话文件损坏」）。置灰行仍可被搜索到并显示（U-H3）。
- 动作：
  - `startable ∧ !forkOnly`：主按钮「继续」(resume)，溢出菜单「复制为新会话」(fork)。
  - `forkOnly`：主按钮「复制为新会话」；`live.by ∈ {card, managed}` 且卡片在本地列表中时，再加「转到」按钮（直接 navigate，不发 POST）。
- 底部：`next` 存在时显示「加载更多」，滚动到底部自动触发（IntersectionObserver，单飞）；`partial` 时显示「已索引 X / Y 个会话文件…」；`liveness:"partial"|"no-proc"` 时提示「未完成进程扫描，占用检测可能不完整」。
- 键盘：↑/↓ 在行间移动，Enter 触发主动作；listbox 语义（`role=listbox`/`option`）。
- 提交后关闭弹窗，后续由 SpawnRow 与 `useNewSession` 接管：失败行沿用现有的详情、重试，重试时带上同一个 `session`。

### 7.3 自动续扫

`historyListReducer`：同一个查询下，若响应带 `partial` 且累计行数 < `limit`，自动续请求，最多 `AUTO_CONTINUE_MAX=3` 轮。超过后停下，显示「继续扫描」按钮。查询变化就作废在途请求（按 generation 丢弃过期响应）。

### 7.4 fork 警告（`HistoryForkConfirm`，中文散文）

- `open/card`：「该会话正在 <cwdLabel> 的 pi（pid N）中打开。为避免两个进程同时写入同一会话文件，将**复制一份新会话**继续：原会话不受影响，此后两边的对话互不同步。」
- `open/managed`：同上，主语换为「网页启动的会话」。
- `maybe/proc`：「检测到同一目录下有一个未连接到 hub 的 pi 进程（pid N），它启动后修改过该会话文件，无法确认它是否仍打开着此会话。为安全起见将复制一份新会话继续。」
- `subagent`：「这是子代理会话，总是以副本方式打开，原会话保持子代理运行记录不变。」
- 按钮：「复制并启动」（主）/「取消」。LAN 下追加现有的明文警告。

---

## 8. 开关、caps、字节一致、LAN、审计

### 8.1 设置与下发

| 键                     | 默认   | 说明                                                                                                                                                       |
| ---------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webHub.spawn.history` | `true` | 只在 `spawn.enabled` 时作为 `HubSpawnConfig.history` 下发；hub 侧缺失 ⇒ `false`（老 pi 拉起新 hub 时不自行开启）。非热生效：`/reload` 后 `/webhub restart` |

### 8.2 关闭时逐字节一致（`history !== true`）

- `GET /api/headless/history`：与 `/api/headless/<未知子路径>` 的现状响应完全一致（loopback 404 `E_NOT_FOUND`；LAN 按矩阵）。
- POST schema 使用原 `SpawnRequestSchema`，带 `session` 的 body ⇒ 400 schema，与现状相同。`intentDigest` 不变。
- caps 不含 `spawn.history.v1`；`SpawnRecordPublic` 不出现 `from`；hub 不构造 SessionIndex 和 LivenessProbe（零 IO、零 timer）。
- 测试钉住：开关关闭时，`HubConfig`、hello caps、`/api/headless` 响应与基线深相等。

### 8.3 LAN

- `spawn.lan:"off"` ⇒ history 端点与其他 `/api/headless*` 一样，鉴权前 404。
- `known|roots`：列表全量（U1：标题、首条消息摘要、cwd 都可见；明文 HTTP 上同样如此，风险已由 U1 接受）。启动：session-backed known 在两种模式下都允许；确认流沿用 `confirm:"always"`。

### 8.4 审计

- `SpawnAuditRecord` 追加：`session?: "resume" | "fork"`、`sessionLive?: "open" | "maybe" | "none"`、`sessionKind?: HistoryKind`、`forkReason?: ForkReason`；`endpoint` 联合追加 `"history"`；`SPAWN_AUDIT_KEYS` 同步更新。
- **不记录**：session key、会话 id、新 id、标题、首条消息、查询串 `q`、游标。`cwd` 仍按 arch §6.6 的例外记录 realpath。
- 列表 GET 只在 reject 时写行（CSRF/auth/rate/400），与 dirs 读端点一致。成功的列表请求不写审计，只在 debug 日志记 `ms/files/indexed/partial` 这类数字。

### 8.5 零 hang 预算总表

| 步骤           | 上限                                                    | 超限行为                                                                          |
| -------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 枚举           | 1500ms；4096 目录；50 000 文件；10s 缓存，single-flight | `partial:{enum}`，返回已扫部分                                                    |
| 头部读取       | 单文件 ≤256 KiB / 400ms；单请求 1500ms / 64 MiB；并发 4 | 本页停在当前文件，`partial:{budget}`                                              |
| 尾部读取       | 单文件 16 KiB / 200ms；只针对当页行                     | 放弃 tail name                                                                    |
| cwd 状态       | 单步 200ms；单请求 500ms；并发 8；30s 缓存              | `cwdState:"unknown"`                                                              |
| /proc 扫描     | 300ms；8192 pid；5s 缓存（spawn 时 fresh）              | `liveness:"partial"`（列表）；spawn 时按已扫部分判定，响应审计 `sessionLive` 照记 |
| zombie IO      | 被 race 掉的 fs promise 计数 ≥16                        | 停止新探测，`partial:{zombie}`                                                    |
| resolveRef     | 800ms（在 admit 的 `ADMIT_CAP_MS` 内并行）              | 504 `E_DEADLINE`                                                                  |
| 列表请求总时限 | `HISTORY_REQ_TOTAL_MS=3000`                             | 已有内容以 partial 返回，绝不 504                                                 |
| timer          | 只有缓存时间戳，**不设任何后台 timer**；无后台索引任务  | —                                                                                 |

---

## 9. 失败模式表

| #   | 场景                                                | 检测点                                    | 结果                                                                                                                                    |
| --- | --------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 列表加载期间会话文件被删除                          | 下一次枚举 / spawn resolveRef             | 列表行消失；spawn ⇒ 400 `session-missing`，UI 提示后刷新                                                                                |
| F2  | 文件被替换（同名、不同 ino）                        | 索引 ino 校验 / resolveRef id 绑定        | 重新索引；id 不同 ⇒ `session-mismatch`                                                                                                  |
| F3  | resolveRef 与 pin 之间文件被替换                    | `pinSessionSync` dev/ino                  | 409 `session-changed`，不建记录                                                                                                         |
| F4  | pin 之后、pi 打开之前被替换                         | 无（残余窗口）                            | pi 打开替换后的文件；header cwd 不同 ⇒ 注册时 `cwd_mismatch` 终止；cwd 相同 ⇒ 打开的是另一个同 uid 会话（接受，§4.7）                   |
| F5  | header cwd 被删除                                   | 列表 cwdState / admit                     | 置灰 `gone`；spawn ⇒ 400 `E_DIR{not-found}`                                                                                             |
| F6  | header cwd 变成 symlink                             | cwdState / admit sessionBacked            | 置灰 `moved`；spawn ⇒ 400 `E_DIR{moved}`                                                                                                |
| F7  | pin cwd 失败（目录在 admit 之后被替换）             | `supervisor.start` pinSync                | 现有行为：`failed{spawn_error}`，`breakerExempt`                                                                                        |
| F8  | 两个标签页同时恢复同一会话                          | C2（starting 的 sessionTarget）+ 同步复核 | 第二个请求 ⇒ 409 session-open ⇒ 用户选 fork 或取消                                                                                      |
| F9  | TUI 在检测之后才打开同一文件                        | 无                                        | 双写分叉（§4.5.2 N5），不坏文件                                                                                                         |
| F10 | 未连 hub 的 pi 打开了旧会话但尚未写入               | 无（N1）                                  | 同 F9                                                                                                                                   |
| F11 | `--fork` 后 pi 报告的 sessionId ≠ newId             | goLive                                    | `hint:"session-unexpected"`，照常 live                                                                                                  |
| F12 | pi 退出：源文件损坏、header 无效、权限问题          | 现有 `exited_early` / stderr 尾部         | `failed`，SpawnRow 显示 stderr（owner）；计入熔断，与现有早退一致                                                                       |
| F13 | 大 transcript 原地恢复启动慢                        | `registerTimeoutS`                        | 超时 ⇒ 现有 `register_timeout`；文档提示用户调大 `registerTimeoutS`                                                                     |
| F14 | sessions 根目录不可读                               | 枚举                                      | 200 空列表 + `partial:{enum}`                                                                                                           |
| F15 | NFS 挂起                                            | raceDeadline + zombie 熔断                | 有界返回 partial / unknown                                                                                                              |
| F16 | hub 重启                                            | —                                         | 索引丢失，下次请求重建；已发出的游标仍然有效（keyset 无状态）                                                                           |
| F17 | 恢复出的会话在 hub restart 后                       | restore 现有逻辑                          | goLive 已记录坐标 ⇒ 按 restore 恢复                                                                                                     |
| F18 | 恢复的会话 header 版本较旧，pi 打开时迁移并重写文件 | pi 内部                                   | 索引按 size/ino 失效后重建；对 hub 透明                                                                                                 |
| F19 | 子代理会话被原地恢复（kind 误判为 main）            | —                                         | 只有启发式漏判时才可能发生；后果是续写了一份已结束子 run 的 transcript（get_subagent_result 的回看会多出内容）。H0 消除新会话的这类风险 |

---

## 10. 决策日志

| #   | 决策                                                                 | 备选                                                   | 理由                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | hub 侧自建有界扫描                                                   | pi `SessionManager.listAll`；让某个在线 agent 代为列出 | hub 不 import pi（E22/boundary 测试）；listAll 读全量 transcript，没有上限；代理列出要求至少有一个在线 agent，0 agent 时不可用                                                       |
| D2  | 头部窗口 256 KiB，读到首条 user 消息即停                             | 4 KiB header 探针；整文件读取                          | 实测首条消息 p99 在 123 KB、max 166 KB（§1.2），4 KiB 拿不到标题；整文件读取 3.3 GB 不可接受                                                                                         |
| D3  | 索引放在进程内，不落盘                                               | 落盘到 `<stateDir>/history-index.json`                 | 简单，没有损坏和迁移问题；头部只追加不变，hub 重启后增量重建的成本可接受（首页约 3 MB 读量）。**扩展点**：如果实测首次全量检索太慢，再加落盘缓存，接口不变                           |
| D4  | 请求驱动加客户端自动续扫，**没有后台索引任务**                       | hub 后台预热                                           | hub 空闲时零活动、零 timer，与 web-hub「无 unref 漏网」的纪律一致；续扫由用户的查询驱动，天然有界                                                                                    |
| D5  | keyset 游标 `(mtimeMs, key)`                                         | offset + 快照 generation                               | 无状态，hub 重启后依然有效；活跃会话上移不会造成重复                                                                                                                                 |
| D6  | 引用 = 相对 key + header id 双绑定 + cwd 回显                        | 一次性 token；绝对路径                                 | §4.7 末段                                                                                                                                                                            |
| D7  | `maybe` 档的条件是「未连 hub 的 pi ∧ 同 cwd ∧ mtime ≥ 进程启动时刻」 | 同 cwd 即算；不做 `/proc` 扫描                         | 只看同 cwd，会让用户在项目里开着 TUI 时同目录所有历史会话都被迫 fork，误报不可接受；完全不扫，就丢掉了「未连 hub 的 pi」这道网。mtime 条件把误报压到「它启动后确实写过」的文件上     |
| D8  | 需要 fork 时由用户确认（409 后弹警告），hub 不静默改写成 fork        | hub 自动 fork                                          | U-H2 要求「明确警告」；静默 fork 会产生一个用户意料之外的新会话文件                                                                                                                  |
| D9  | 子代理会话一律 fork                                                  | 按 fleet 行匹配运行中的子会话                          | fleet 行不带 sessionFile（E19）；子会话 transcript 是父会话里 run 记录的一部分（get_subagent_result、resume 依赖它），原地续写会破坏语义                                             |
| D10 | 带 session 时禁用 `--model`，`body.model` ⇒ 400                      | 允许覆盖                                               | 与 restore D8 一致，pi 从分支恢复模型；静默覆盖用户在会话里切换过的模型是更糟的结果。需要换模型时，live 后在会话内 `/model` 即可                                                     |
| D11 | fork 由 pi `--fork … --session-id` 执行                              | hub 复制 jsonl                                         | §4.6                                                                                                                                                                                 |
| D12 | 要求 `realpath(header.cwd) === header.cwd`，否则置灰 `moved`         | 允许启动（rec.cwd 取字面值）；对 moved 自动 fork       | E8/E10：`--session` 下 agent 上报字面值，注册时必然 `cwd_mismatch`；改用字面值会削弱 cwd 钉住与 restore 的不变量。fork 能把 cwd 改写成 realpath，但会改变会话所属项目，列为待确认 Q2 |
| D13 | session-backed known                                                 | 沿用 Top-50 / 30 天                                    | 历史会话天然包含老项目；会话文件本身就是「用户在此工作过」的证据，信任等级与来源 ② 相同                                                                                              |
| D14 | 新模块放在 `hub/spawn/history/`，端点挂在 `/api/headless/*` 下       | 独立 `/api/sessions`                                   | 功能依附于 spawn（开关、LAN 策略、鉴权、未启用矩阵全部继承）；避免与 `hub/history.ts`（消息历史）重名                                                                                |
| D15 | 标题清洗在 hub 内移植，并用对拍测试钉住                              | 把 session-nav 的纯函数挪进 protocol                   | protocol 只放双侧共享的契约；session-nav 不在本特性文件域内。对拍测试保证两份实现不漂移                                                                                              |
| D16 | `sessionTarget`、`from` 只放在内存和投影中，不进 StoredRecord        | 持久化                                                 | restore D11：不 bump 文件版本、不扩持久化枚举，回滚安全；未 live 的记录本来就不会被恢复                                                                                              |
| D17 | H0 子会话标记作为可选包                                              | 只用启发式；全量扫描父 transcript                      | 启发式对老会话有效，但依赖 sysprompt/hud 的配置；标记零成本、确定，只增加一个 custom 条目                                                                                            |

---

## 11. 实施要点与风险

- **R1 头部解析性能**：prompt-sections 行约 120 KB，只做前缀判定加未转义子串查找，**不要 JSON.parse**。user 消息行才 parse。用 5600 文件的夹具基准测试，冷缓存下单请求预算内至少能索引约 150 个文件。
- **R2 kind 启发式漂移**：sysprompt 的 section 名（`pi_subagent_types`，注册于 `src/index.ts` post-guard，持久化形状见 `src/prompt-sections/store.ts`）一旦改名，启发式就会失效；hub 不能 import 这些常量，所以在测试里做源码扫描对拍：读出 `src/index.ts`/`src/prompt-sections/*` 中的 section 名字面值，断言与 `head.ts` 的常量一致。
- **R3 `--fork` 契约**：pi 升级（peer 范围 `<1.1.0`）时由 conformance 测试兜底；`pi-compat` 不探测 CLI。
- **R4 对 `supervisor.ts` 的改动**：只改 `start()` 的 argvTail 选择和 goLive 的 hint 一处，保持 `forkInto` 不动；SP7 和 restore 的 RS 测试必须原样通过。
- **R5 `/proc` 扫描在进程很多的机器上**：8192 pid / 300ms 上限。超出时 `liveness:"partial"`，属于退化，不是错误。
- **R6 hot file**：`protocol/spawn.ts`、`routes.ts`、`supervisor.ts`、`http-contract.ts`（无改动，E_DIR 等错误码已存在）。新错误码不需要新增：`E_DIR`/`E_CONFIRM_REQUIRED`/`E_BAD_REQUEST` 只追加 reason。
- **R7 i18n**：行内徽标用英文 token，警告与原因用中文；en 词条同步。

### 11.1 建议分包（下游方案细化）

| 包  | 内容                                                                                                                            | 依赖     |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | -------- |
| SH0 | （可选）`subagent:child` 子会话标记 + 测试                                                                                      | —        |
| SH1 | protocol 冻结：`session-history.ts`、spawn.ts 追加、caps 常量、契约测试                                                         | —        |
| SH2 | `history/head.ts` + `title.ts`（纯）+ 对拍、夹具                                                                                | SH1      |
| SH3 | `history/index.ts`（枚举 / 索引 / cwdState / page）                                                                             | SH2      |
| SH4 | `history/liveness.ts` + `ref.ts` + `restore-plan.checkSessionHeader` 抽取 + `dirs.admit(sessionBacked)`                         | SH1      |
| SH5 | 路由：GET history、handleSpawn 的 session 分支、digest、审计；supervisor 的 argvTail / sessionTarget / from；hub 装配；设置下发 | SH3、SH4 |
| SH6 | UI 逻辑 + 传输（`sessionHistory.ts`、`history()`、`useNewSession` 409 分支）                                                    | SH1      |
| SH7 | UI 组件（Dialog、ForkConfirm、菜单入口、i18n）                                                                                  | SH6      |
| SH8 | 集成 + conformance + 真机验收 + AGENTS.md / 文档                                                                                | SH5、SH7 |

---

## 12. 测试锚点

**单元**

- `tests/web-hub/hub/spawn/history/head.test.ts`：header 校验矩阵（缺 type、id 非法、cwd 相对、首行 >4 KiB）；user 消息在第 1 块和跨块的情况；首条消息行在窗口末尾截断时的宽松提取；`"pi_subagent_types":` 出现在转义字符串里 ⇒ 不误判；`subagent:child` 标记；session_info 多条时取最后一条；**流式分块边界**（任意切分产出相同结果，属性测试）。
- `title.test.ts`：与 `src/session-nav/skill-titles.ts` 的 `stripSkillEnvelope` **对拍**（共享语料）；附件尾注剥离；代理对截断。
- `index.test.ts`（注入 fake fs + 可控时钟）：keyset 不重复、不跳过（属性测试：随机 mtime 变动 + 随机预算截断，拼接全部页 ⊇ 初始集合，且无重复）；ino 变化或 size 缩小时重新索引；预算截断时 `next` 停在第一个未索引文件；enum 部分结果；zombie 熔断；容量上限与淘汰。
- `liveness.test.ts`：C1 按 id 匹配、按路径匹配、stale 卡片；C2 各状态（launching/starting 的 sessionTarget、live、stopping 尚未 confirmed、终态不算）；C3 的 uid、comm、已知 pid 排除、mtime ≥ 启动时刻、hub pid 排除；无 /proc ⇒ `no-proc`；预算截断 ⇒ partial；`syncRecheck` 不 await（类型和源码扫描）。
- `ref.test.ts`：key 形状矩阵（`..`、多个 `/`、NUL、超长、非 `.jsonl`）；symlink 目录、symlink 文件、owner 不符、fstat 与 lstat 的 dev/ino 不一致、header id 或 cwd 不符、ENOENT ⇒ `session-missing`；`pinSessionSync` 在替换后失败。
- `dirs.test.ts` 追加：`sessionBacked` ⇒ known 恒为真；`realpath !== raw` ⇒ `moved`；不带 opts 时行为逐字节不变（现有用例原样通过）。
- `restore-plan.test.ts`：抽取 `checkSessionHeader` 后现有用例零改动通过。
- `routes.test.ts` 追加：闸门顺序（session 预检位于 admit 之后、confirm 之前）；`mode:"resume"` 加 open ⇒ 409 session-open 且不写 LRU、不建记录；同 id 改为 fork 重发 ⇒ 202；`model-with-session` ⇒ 400；digest 无 session 时字节不变；**auth2 后同步复核期间注入新卡片 ⇒ 409**；审计行里不出现 key/id/q（逐字段断言）。
- `supervisor.test.ts` 追加：resume argv = `[argv1,"--mode","rpc","--session",abs]`，fork argv = `[…,"--fork",abs,"--session-id",newId]`，均不含 `--model`；不带 session 时 argv 与基线逐元素一致；fork 时 sessionId 不符 ⇒ `hint:"session-unexpected"` 且仍 live。
- `tests/web-hub/protocol/session-history.test.ts`：游标编解码；`isValidSessionKey`；schema 开关（关闭时带 session ⇒ schema 错误）。
- 开关关闭时的字节一致（`tests/web-hub/hub/hub-config-compat.test.ts` 类）：caps、`/api/headless/history` 404 的响应体、POST schema。
- UI：`tests/web-hub/ui/session-history-logic.test.ts`（行模型、动作集、续扫上限、查询切换时丢弃过期响应）；`use-new-session.test.ts` 追加 session-open 分支（同 id 重发、mode 切换、不触发 navigate 劫持）；`transport-contract.test.ts` 追加 `history()` 在 token/password 两套传输上的一致性。

**集成（`tests/integration/web-hub-headless.test.ts`，新 describe「HH history」，真实 hub 子进程 + `fixtures/fake-rpc-pi.mjs`）**

- HH1：列表包含夹具会话，置灰 `gone`，`kind=main` 隐藏子会话，`q` 命中首条消息和 cwd。
- HH2：resume ⇒ fake pi 收到的 argv 精确为 `--session <abs>`，live 后卡片 sessionId 与 header id 一致。
- HH3：先让一个 fake TUI agent 连接并上报同一 sessionId ⇒ resume 得到 409 session-open ⇒ 以 fork 重发 ⇒ argv 精确为 `--fork <abs> --session-id <uuid>`。
- HH4：并发两个 resume ⇒ 恰好一个 202，另一个 409。
- HH5：spawn 前删除会话文件 ⇒ 400 session-missing，fake pi 从未被 fork。
- HH6：LAN `spawn.lan:"off"` ⇒ history 端点与未启用字节一致。
- HH7：开关关闭 ⇒ caps、404、schema 全部字节一致。

**conformance（`tests/conformance/rpc-spawn.test.ts`，真实 pi，临时 HOME）**

- HC1：`pi --mode rpc --session <abs>` 打开既有会话，hello cwd 等于 header cwd，session 帧的 sessionId 等于 header id，不提示。
- HC2：`pi --mode rpc --fork <abs> --session-id <uuid>` 生成新文件，header 的 `id/cwd(realpath)/parentSession` 正确，源文件字节不变，不提示。
- HC3：header cwd 被删后执行 `--session` ⇒ 进程 exit≠0 且不挂（`MissingSessionCwdError`）。

**真机验收**（追加到 `docs/dev/web-hub-spawn/acceptance.md` 新节「H：history」）：5000+ 文件规模下首屏耗时与 partial 收敛轮数；TUI 打开同一会话时的 fork 警告；手工 `kill -STOP` 一个未连 hub 的 pi，验证 `maybe` 档；LAN 上的列表与启动。

---

## 13. 待用户确认

| #   | 问题                                                                                                                                    | 本文建议                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Q1  | 是否同意做 H0：子会话写一条 `subagent:child` 标记条目（改动子会话文件内容，只增加一个 custom 条目）？                                   | 同意。否则新会话也只能依赖启发式                            |
| Q2  | header cwd 变成 symlink（`moved`）的会话：保持置灰，还是允许「复制到 realpath 下继续」（fork 会改写 cwd，会话随之归到另一个项目目录）？ | v1 置灰                                                     |
| Q3  | `maybe` 档（启发式）也强制 fork，还是允许用户「仍然原地恢复」？                                                                         | 强制 fork（误判的代价只是多一个副本；漏判的代价是会话分叉） |
| Q4  | 是否向用户开放「复制为新会话」（无人占用时也可以主动 fork）？                                                                           | 开放，放在溢出菜单里，零额外成本                            |
| Q5  | `webHub.spawn.history` 默认 `true`（与 restore 一致）还是 `false`？                                                                     | `true`                                                      |
| Q6  | 带 session 时禁止指定模型（D10），可以接受吗？                                                                                          | 接受                                                        |
| Q7  | 自定义 `sessionDir`（pi 设置 / env）下的会话不在列表中（hub 不读 pi settings），是否需要在 UI 里加一行说明？                            | 在 `stats.files===0` 时提示                                 |

## 14. 用户裁定（2026-10-08）

| #   | 裁定                                                                                |
| --- | ----------------------------------------------------------------------------------- |
| Q1  | **做 H0**：子会话写确定的 `subagent:child` 标记条目；老会话继续走启发式             |
| Q2  | header cwd 变成 symlink（`moved`）：v1 置灰不可启动（按建议）                       |
| Q3  | `maybe` 档也**强制 fork**（按建议）                                                 |
| Q4  | 开放「复制为新会话」（无人占用时也可主动 fork，放在溢出菜单）（按建议）             |
| Q5  | `webHub.spawn.history` 默认 `true`（按建议）                                        |
| Q6  | 带 session 时禁止指定模型（D10）——接受（按建议）                                    |
| Q7  | 自定义 `sessionDir` 不支持：`stats.files===0` 时 UI 提示一行（按建议）              |
| —   | 列表范围：全部项目、按最近修改排序、可搜索；LAN 下完整显示（U1 唯一 LAN 用户）      |
| —   | 被在线进程打开 ⇒ fork + **明确警告**（用户确认后才启动）；cwd 不存在 ⇒ 置灰不可启动 |

### 14.1 补充裁定（2026-10-08，评审 r_EANRRJTT 之后）

- **U-H2 放宽为「尽力检测」**：能检测到的占用（含 fail-closed 判不清）一律强制 fork + 警告；方案披露的残余窗口（复核到 pi 打开文件之间新 pi 打开同一文件、root/其他 namespace 的 pi、非 pi/node 启动器、restore 重启间隙不重跑证明）写入文档并在 UI 上提示，不再追求硬保证。不做协作式持有锁。双开的后果是会话树分叉，不丢数据、不写坏文件。
- 方案修订升级到 Fable。

### 14.2 补充裁定（2026-10-09 凌晨）

- **开发授权**：方案评审达到「通过 / 有条件通过」即可按包开发（L3 用户闸门已由用户预先放行），每包异源验收后本地提交，不 push。
- 调度方决定（用户未反对）：枚举未完成时页内按 mtime 排序 + 「排序近似」提示（PD23）；PD24 的 sessionsRoot 归属只约束 history 来源记录（v3.1a）。
