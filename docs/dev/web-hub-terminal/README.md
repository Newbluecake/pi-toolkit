# WebHub 会话终端 · 开发者必读

> 改动 `src/web-hub/{agent/terminal,hub/terminal,ui/src/components/terminal}/**`、终端协议、设置、装配或测试之前阅读。
> 总体边界见 [WebHub 索引](../web-hub/README.md)；安全域见 [data-encryption](../data-encryption/README.md)。
> [验收清单](acceptance.md) 区分自动化证据与 NOT RUN；不要把方案矩阵或单包报告当作跨层 PASS。

## 产品边界与设置

这是 **agent-owned Linux + Python 3 PTY**，不是 pi 原 TUI、不是模型工具、不是 `bash_job`，不使用 BashJobManager、bash job 持久化或 bash timeout/grace。
受支持登录 shell 为 bash/zsh，按系统 uid 记录启动原生 interactive login shell、加载用户 rc；不重复 source bashrc，也不向未知 shell 回退。

`webHub.terminal` 默认缺省（稀疏默认，缺 block 不补键），全部 non-live：改动需 `/reload`，再 `/webhub restart`。
还需 WebHub 与 control 开启、可信 plain/main/live agent。设置编辑器与 JSON 的公开秒键如下，内部协议/运行时使用 ms：

| 设置键（`webHub.terminal.*`） |    默认 | 范围         |
| ----------------------------- | ------: | ------------ |
| `enabled`                     | `false` | boolean      |
| `maxPerSession`               |       2 | 1–4          |
| `maxPerPrincipal`             |       2 | 1–8          |
| `maxTotal`                    |       8 | 1–32         |
| `inputIdleS`                  |    3600 | 300–86400 秒 |
| `maxLifetimeS`                |   28800 | 900–86400 秒 |

### #45：启动机器 policy 与逐目标资格

终端不再由「拉起 hub 的那个会话是否合格 / launch config 是否有旧 `terminal` 键」决定。
hub 在创建 assembly/admin/agent server/HTTP 之前，**一次性只读**其选定 agentDir 的
`pi-toolkit.json`（新名优先、旧名只读 fallback；env agentDir 缺文件按既有继承规则）中的
`webHub.terminal`。不迁移、不 heal、不加锁写文件。机器策略及全局上限冻结到这次 hub shutdown；
从正确 agentDir 的 plain 会话 `/webhub restart` 才能改变。其他 agentDir 的声明不能改变当前机器策略。

- 合法缺文件/缺 block/`enabled:false` 为 off；`enabled:false` 时无用坏 limits 不参与准入。
  true off 的公共 wire/HTTP/SSE/DOM 不变，但 **新增启动 settings 读取本身不是零 I/O**。
- 读失败、坏 JSON、非 regular/不安全路径/属主/权限、超限文件为固定 `settings-*` unavailable；
  不继承到其他目录掩盖坏文件。enabled block 的非整数/越界/错误类型使**整块 unavailable**，不 clamp 或回落到更大默认。
  秒键优先；合法旧 ms 必须是整秒；非法秒值不能 fallback 到旧 ms。此严格包装不同于 agent 的旧 tolerant parser。
- 私有 bootstrap 环境只接受 `PI_WEBHUB_TERMINAL_SOURCE=plain|denied`。
  launcher 从已冻结 domain 生成它，覆盖继承标记；plain→plain、secure/locked→denied。
  缺失（含旧 launcher）、坏值为 unknown，**不从清洗后的 PI_SECURE 缺席推断 plain**。
  denied/unknown 启动为 unavailable（`startup-domain-denied/unknown`），不会由后来合格目标自动解禁；
  必须从 plain 会话及正确 agentDir 显式 `/webhub restart`。source 不明时不读取机器配置正文来猜 off。
  该字段只是否决门，不授予任何会话或浏览器执行权；同 uid 恶意 producer 不在隔离承诺内。
- legacy launch `config.terminal` 从新本地副本剥离；只有合法机器 policy + plain provenance 才可重新装配。
  **旧键与机器 off 冲突时终端不再启用，这是声明式行为变化，不是旧 terminal-on 的 byte parity。**
- 机器 `maxTotal/maxPerPrincipal` 是唯一全局 P；声明的同名值无论 1 还是 32 都不能放大或压低其他目标。
  `maxPerSession/inputIdleMs/maxLifetimeMs` 取机器、目标有效声明、私有 ready 三者最小值；所有未知物理态继续占额。

机器 enabled 时 service/fence/两个 browser cap 从启动到 shutdown 常驻，不随合格目标数变化。
`terminal.ui.v1` + `terminal.session.v1` **均仅 browser HubInfo**，不进 hello_ack、不 bump PROTO。
agent 的 optional `status.terminalSession` 是匹配当前 session/epoch 的闭合声明，不含 cwd/路径/秘密。
新 hub 无声明即拒绝，不能主动探测旧 agent。正声明只是候选，实际 open 仍须完整本地 authority、独立
/proc/namespace、真实本 boot 登录、原 SSE binding、privacy 与 quota 验证。

原 status slot 永不保存正声明：每次实际 flush 先投影 XS，再重新核当前 owner readiness/authority、guard、
session/epoch/link。异常回落为无声明原帧；重连第一张 status 不能 replay 旧资格。
withdraw/detach/断线/epoch 变化先同步 deny；已建立的 exact resource flight 只能完成原 challenge 的物理证明，
不得借此开新协商。A→零→B 使用同一 boot service/fence/SSE，无第二次激活或强制登录。

### cwd：每次首次 open 捕获，已有 shell 不迁移

生产 `wireWebHub` 提供 trusted `currentCwd()` 闭包；owner 在每个**首次 open 的同步 admission/CAS**
读取当前事件 context 的 cwd，一次捕获给该 backend。同 creation ticket 重试不重读 cwd、不二次 fork。
同会话 cwd 改变后，新 shell 用新 cwd，已打开 shell 保留原 PID/kernel cwd；`new/resume/fork` 的
session_start 按既有 owner 边界清理旧 shell，再采用新 context，不承诺跨边界保活。
空/相对/NUL/不存在/非目录/不可 traverse 的 cwd fail-closed，绝不回退 HOME、hub 或 agent process cwd；
helper 在 exec gate 后仍真实 chdir，应对目录在预检后消失的竞争。失败依原 receipt/OS/durable 链结算，不能逻辑 close 就释放。
保证的是 **exec 前的内核 cwd**；原生 login rc 仍可主动 cd，不禁 rc，也不在首 prompt 后注入 cd。
cwd 仅存在于获授权 panel metadata，不加入声明、hub.json、audit、普通 list/state。

### `/webhub status` 的 unknown 与重新登录

本地 status 使用当前 activation settings + 同一个当次资格投影，不把 stored status 当实时声明。
新 hub.json 的 `terminal.mode:"per-session"`、state/fixed reason/source scope/effective machine limits 是
**经过 hub 身份校验的启动快照**，不是实时 browser ack、eligible count、physicalUsed 或当前用户登录证明。
合法 off 省略 terminal 字段；旧记录/缺字段必须诚实显示 **unknown / off-or-legacy**，不能由版本号或 hello_ack
猜 browser cap，更不能把本地 eligible 说成 hub 已开启。unknown 提示核对启动环境，不臆断 secure/旧版原因。
任何 hub restart 都丢失本 boot fence 登录 proof；旧 cookie/SSE 重连不能补 proof，须真实重新登录。
不复制 logins/bootNonce/grants/leases，也不用 authorize/touch/repair 冒充 loginComplete。

### privacy=false + terminal=true：明确的旧 bug 修正

内部 privacy store 始终先于 terminal/spawn 加载，并由 spawn 捕获同一实例；机器终端启用时 fork 要求
healthy store。locked source 的 NEW sessionId **先持久化 mark，再 supervisor.start**；missing/degraded/
unknown-health/查询异常/mark 写失败都不允许无锁 fork。公开 privacy cap/routes 仍只受 `privacy===true` 控制。
旧实现会因内部 store 存在而错误暴露 public privacy routes；现在关闭这些意外 routes，
**所以 privacy=false+terminal=true 路径不是字节不变**。不得把真正 machine-off + agent-off 合同套到此 terminal-on 修复路径。

只有非空、实际用户输入更新 idle；输出、自动终端 response、attach、ACK、renew 不续命。硬寿命不可续期。

首次 open 在 reservation 后创建全新 Python backend，并明确 await exec-ready；agent/protocol READY 不代表尚未创建的 backend 已就绪。capability probe、全局有界 proc scan、shell/exec 失败不能靠补一个测试前置 READY 消除。`E_BACKEND_CAPABILITY` 可能是暂态启动检查失败；UI 提示先从列表确认原请求再手动重试，绝不自动换票据重开 `effect:unknown` 的 shell。内部 body-free diagnostic 区分 capable/ready、probe/startup deadline、helper error/closing 等固定原因，不扩 HTTP/wire、不带环境/正文/路径。
两条 settings loader 对 secure **及 locked** 的显式 block clone 后强制 `enabled:false`；默认对象和原文件不 mutation。

## 威胁模型：不是沙盒，也不是安全传输

- **当前 OS 用户的命令执行权**：用户无需模型审批即可执行任意 shell 命令。LAN 登录者也拥有这一能力。HTTP 明文下口令、cookie、命令与输出可能被窃听/劫持，进而执行命令；这是用户已接受的风险，不等于 HTTPS，也不声称同网段可信。
- **同 uid 本地 producer 信任**：guarded owner 的本地文件证明 plain/main；hub 独立核验 `/proc` 身份与 namespace，但不隔离恶意同 uid 代码，不提供 SO_PEERCRED/native sandbox 承诺。0600/0700 不是对文件属主本人的防护。
- pi→helper 使用环境 allowlist + 不可绕过 deny；API key/token/provider/PI/ARMORY/loader/proxy/rc 定位变量不继承。helper 从 uid record 重建 HOME/USER/LOGNAME/SHELL。**rc 可以重新读取/设置秘密、联网、写 history；环境过滤不是文件/proc/vault 隔离。** plain shell 仍能主动访问同 uid 可读资源（包括已挂载 vault）。
- 飞书、Composer/普通 `/api/cmd`、模型工具均无终端入口。secure/locked、child/print、缺 trusted guard、privacy marked（手机或本地解屏也不例外）、unknown/degraded privacy 恒禁。不能用 UI 状态或 status 声称代替权威。
- 每个 POST 要真实登录、严格同源 JSON/X-PWH 与原 SSE 实例/token；缺失/跨域/null origin 拒绝。SSE GET 的无 Origin/Fetch Metadata 兼容不构成写权限。
- revoke 首个同步事件先安装 deny fence，再异步删 session；删失败/迟到 auth 不解除 fence。2048 selector 饱和使用 sticky 宽 fence；只有可信 repair/新 login proof 能恢复，不靠 TTL。

## 不变式：off、装配、私有通道

1. **真正 off ⇒ byte-identical**：plain 来源、机器合法 off、agent terminal off、无旧 launch terminal 时，无终端 owner/factory/service/maps/timers、journal/local state 读取/创建、cap/token/event；终端路径 404，旧 DOM/sprite/图标不变。启动 policy 的只读 settings 判读是明确 I/O 例外。machine off + agent on 仍可能由 agent 创建其本地 authority，不等同全 off。旧键冲突及 unavailable 必须分别验，不归一化成 off；冻结 fixtures 不重录。
2. **唯一生命周期 owner 是既有 post-HOST_KEY `wireWebHub`**。不新增 pi tool/hook/command、Stack owner 或 teardown 步骤。`initSecureDomain()` 仍是 activate 第一语句。dispose/revoke 先于 connection detach；旧异步完成不得 adoption 到新会话。
3. `terminal.ui.v1` / `terminal.session.v1` **仅 browser HubInfo**，不进入 agent hello/hello_ack，不 bump PROTO。普通 bash 图标按 hub cap 一致切 jobs-list，目标不支持也不切回。旧 hub/off 保留原字节。
4. 普通 cmd 只回无秘密 offer/固定拒绝，**没有敏感首次 cmd_result 例外**。先 dedicated prepare/challenge/ready CAS，才 mint/read/send 私有材料；interactive 另须 grant→bind，resource-only 只能库存/回收。旧 hub 不能诱导新 agent 发送秘密。
5. **F1 前置隔离**：decoder→agent-server 在 registry/bus/SSE ring 之前消费保留命名空间、私有 cmd tombstone、未知/伪造/嵌套终端结构；服务缺席/抛错也绝不 fall through。普通旧帧不全局 sanitize。私有 correlation tombstone 留至 link 退休，offer 则在原截止清除能力值。
6. 定向 `terminal_connection` / `terminal` 只向原实际 socket 发，不进普通 SSE_EVENTS、broadcast、replay ring、session/history/通知。enqueue 再核身份、expiry/fence、原 binding/attachment、socket pressure；撤销关闭原 SSE，使页面立即失效。
7. 所有 computed deadline 经 clamp/segmented clock；所有运行时 timer unref；每层 bounded queue/deadline 独立，不能靠放大 timeout/缓冲假装恢复。Hub/protocol 保持 I8 pi-free 边界及原白名单。

### 私有 SSE 与 negotiated encoder

loopback 与 LAN 都把 `openEvents` 返回的原 `SseClient.output` 经 terminal routes/assembly
显式传给 binding；`terminal_connection` / `terminal` 只绕过 publish/ring，**不得直接
`res.write` 或另建 compressor**。私有帧与公开帧共享原 FIFO、gzip `Z_SYNC_FLUSH` 和
identity drain 处理，无新公开事件/id/cap。binding 的 64 KiB 压力检查使用该 output 的
保守 pending bytes（队列 + 在途输入 + encoder + socket），不能仅看 `res.writableLength`。
每次 enqueue 前的身份、原 proof、expiry/active/fence 与 24 KiB 单帧检查不变；send=true
表示接收入队，而不是浏览器已消费。撤权先同步清 live/active 与 listeners，再 abort 原 output，
丢弃尚未写出的队列并销毁 compressor/socket，不用 `res.end()` 绕过 encoder 的生命周期；
已交给 socket 的 bytes 无法撤回。普通 SSE close 的排空语义仍由 output 管理。
尚未建立 binding 的早期 local unavailable / privacy missing 或 degraded 分支没有私有材料，
**保留公共 SSE 与 clientId**，不创建 terminal binding、不 mint/send 私有 token/event，并拒绝全部终端 POST。
旧 `output.finish()` 会同步删除公共 clientId，导致 hello 后 subscribe 404 与无限重连，连带阻断聊天/历史/fleet；
#49 P0 明确改变该 early-unavailable 设计，不放松 local authority、privacy 或冷恢复校验、不清理残留 store。
公开 browser HubInfo 仅在不可用时追加 optional `terminal:{state:"unavailable",reason}`，reason 是固定无秘密前置原因；
不新增事件/cap、不 bump PROTO、不进 agent hello_ack；健康/真正 off 省略该字段。privacy 健康变化重投影此负面提示，
旧 UI 忽略未知字段仍可使用公共流，新 UI 显示不可用原因并隐藏终端执行入口，不加载私有面板/API。
缺字段只代表 legacy/未否决，绝非 ready 或授权。混版/回滚不依赖此提示授予权限。
已建立敏感 binding 的撤销仍同步 abort 原 SSE，不排空私有队列；source/Origin 例外不扩权。
terminal off 不调用该端口、不新增字节；私有材料仍不进入 replay。

回归：`tests/web-hub/hub/terminal/sse-binding.test.ts` 用真实 zlib + 内存 Writable 覆盖
identity/gzip 的交错次序、完整 trailer/逐帧解码、无后继帧仍及时 flush、drain、encoder
积压压力、撤销丢弃队列、close/error/expiry 与 replay 隔离；
`tests/integration/web-hub-sse-output.test.ts` 以真实 startHub/HTTP 验证 unavailable/degraded 及旧 boot authority
在两个 listener 上公共 SSE 保持、subscribe 202、负面状态、无私密帧和终端 POST 拒绝。
真实双 listener 撤权接线由 `tests/integration/web-hub-terminal-http.test.ts` 验证。

## 权威链、物理 receipt 与冷恢复（F2）

### 本地 authority

guarded owner 在 owned0700 `terminal-v1/authority/` 写不可变 owned0600 文件：process nonce、session/epoch/owner、plain/main attestation、实际 boot/pid/starttime/uid、PID/mount/user namespace。
只有支持 optional authority 的私有 challenge 才启用查询；缺支持在 ready/grant/backend 之前拒绝。
capability id/nonce/SHA 仅走专用响应。hub 自读文件，检查 exact scope/hash/capability、属主/权限/no-follow，并独立核当前 `/proc` 与自身 namespace；admission/enqueue 重检。revoke 同步 unlink。最多64 authority、32 discovery flights、每次2s。

### 释放顺序：close/exit/kill 成功都不等于 reaped

pending/starting/live/closing/reaping/poison 均占物理配额。helper 使用 Linux subreaper，启动时真实双 fork 收养/waitpid 自检；HUP→TERM→KILL 按已核身份/组回收。backend 必须满足 **spawn future sealed/settled、PTY closed、helper completion + waitpid、受管身份/组 gone** 才能写不可变0600 receipt。
helper 单独退出、发 SIGKILL、HTTP close ACK、wire true/exit 都不是证明；未知保留 `reap_incomplete`。

close之后的OS/receipt核验使用**原5s物理回收预算的剩余时间**，不能在helper close后另用250ms提前判未证回收，也不能另开5s延长总界。最初done仍可能保守incomplete；owner用原≤60s升级reaper重取真实证明，期间配额不释放。真实证明成功后经H当前库存、receipt/OS核验、durable prune/ACK释放；收集/磁盘暂时失败可由后续真实lifecycle或hot-quota open的fresh collection再证，不通过TTL强行清零。丢失helper完整报告、不可读proc/残留组或损坏状态可能持续poison，满额后拒绝新建；没有自动reset。

forkpty父分支可能先于child的login_tty/setsid返回：exec gate前须独立读到shell真实SID==PID、PGID==PID，才发布shell身份/允许exec。进程的job-control PGID/role可合法变化，Python和Node managed表必须按完整(boot,pid,starttime,uid,SID,PGID,role)追加历史观察，不按PID:starttime覆写已发布元组。H的历史覆盖/独立组消失检查**不放宽**。256条上限按观察数计，满表仍fail-closed。

hub 直接读 `terminal-v1/receipts/` 实际文件，核 exact resource tuple/producer/witness/hash/权限，并独立证实原身份 **及记录的 pgid/SID** 消失。当前 inventory 必须 count/digest/revision/连续 chunk/complete/全预期集合一致，不接受部分证明放行：

1. 完整当前 inventory + 实际 receipt + 独立 OS 核验。
2. 第一次 durable journal CAS 记录 exact resolved rows。
3. 再查当前 challenge/link/owner/non-abort。
4. 第二次 durable CAS **只 prune 这些 exact resolved identities**。
5. 最终 current/non-abort CAS 后才释放一次，并发 private resource-only `resolved_ack`。
6. agent 的 `terminalResolvedAckMatches` 核当前已发送完整 snapshot/挑战/代次/journal revision，整批通过才删 exact receipts；未知/重复/陈旧 batch 不部分删除。

publication 2s logical deadline、late-write seal；同步文件系统调用不可抢占，不承诺内核 IO 取消。journal 不存 receipt capability/nonce。
新物理完成发生在旧 inventory fsync 期间会 dirty 当前 flight；只按真实新 lifecycle revision 因果 drain，最多32轮共用原2s，不无限轮询/延时重试。

### 首次初始化与重启

仅从未存在 `terminal-v1/` 时自动初始化：parent 的 O_EXCL durable witness `.terminal-initialized-v1`、0700 root、O_EXCL/O_NOFOLLOW0600 journal + initialized marker、文件/root/parent fsync。
已有 partial/corrupt/unsafe/unknown-version、旧 flat journal、无效 receipt、删 root 后 witness 仍在，全部 **Unavailable**；不把 ENOENT/revision0 当全新，不自动 reset/repair。残留 authority 仅有下述 #49 P1 保守隔离例外，其他情况仍封锁。并发首次 loser fail-closed，winner 完成后可 reload/restart 重新核验。`/webhub status` 只有固定 prerequisite 原因，不公开能力/路径。

- 正常 resolved+pruned 不留 consumed row，最后一个终端关闭后冷重启可用。
- resolved-before-prune 崩溃留下行：冷加载重新 unresolved/quarantine，旧 resolved 不直接放行。
- pruned-before-ACK 崩溃留下合法孤立 receipt：bounded plain handoff 与 journal 做 union，重新 quarantine；**缺行不是 ACK**。
- fresh inventory + 当前 challenge + 实际 receipt/OS 证明后再 resolve/prune/ACK。缺席 agent 变 `lost`，5/30/60s 乃至 TTL 到期均不释放、不开新 shell。
- 同 boot release tombstone 保证重证/丢 ACK 不 double-release；只有同 producer 后续完整库存真正省略该 identity 才 GC，不靠 TTL。纯数据 handoff≤32，无活 closure/fd/owner 引用。

### #49 P1：仅前 boot、已确认 PID 不存在、空物理态的 authority 隔离

这是 terminal-on/plain 的声明式行为变化，不是 store reset，也不是资源回收。唯一生产入口是
`assembleTerminal → prepareTerminalStore`，在现有 singleton 已持有之后；每个破坏性步骤前核
startup/closing、原 bound socket **及 directory** identity、held O_DIRECTORY/no-follow fd 与路径 identity。
不加 abstract socket 内锁（它按 netns 隔离，不是 stateDir 锁），不新增设置、wire、命令或修复 API。
`StartHubDeps.terminalAuthorityRecoveryTestDeps` 仅测试进程传入，main/config/env/wire 不可达。

所有 authority 和 receipt 先做完整闭合 schema/owner/mode/no-follow/名字/storeId 校验；只有合法
旧 boot UUID + `/proc` 证实该数字 PID 确实 absent 才是候选。探测前后 self/proc 必须健康，stat 子文件
ENOENT 还须目录确实 ENOENT，退出竞争最多重新采样一次。旧 namespace 要合法 readlink 形状但不要求
等于当前 boot；current authority 仍须 exact process/uid/starttime 与 peer/self namespace 全一致。
current+stale 混合集只移动 exact stale，保留 current 的名字/inode/原字节。

- 同 boot 死进程/PID reuse：`stale-authority-same-boot`；旧 boot 但数字 PID 当前存在：
  `stale-authority-prev-boot-pid-present`。不 signal，不按 TTL 猜测死亡。
- proc 不可核、namespace mismatch、坏 authority 分别为 `authority-proc-unavailable`、
  `authority-namespace-mismatch`、`authority-corrupt`。原 journal/witness/unsafe 原因保留。
- **journal 任意 resource 行（含 resolved/pending）或 receipts 非空均禁止隔离**，分别诊断
  `stale-authority-prev-boot-journal-not-empty` / `stale-authority-prev-boot-receipts-not-empty`；
  合法非零 revision 的空表允许。无候选的健康启动照旧加载非空物理态进入 F2 quarantine。
- 不改 storeId/witness/initialized/journal/receipts，不建新 epoch、不 mint reaped、不发 ACK、不释放配额。
  前 boot 非空资源仍须原 receipt/fresh inventory/两次 durable CAS/ACK 链，不是本例外。

留证在 sibling `.terminal-authority-archive-v1/<random transaction>/`（owned0700）内：
先 O_EXCL0600 snapshots 原字节及私有 `authority-retirement-only` manifest，全部 file/parent fsync，
再紧邻同步 exact inode/bytes/proc 重验→rename 到该全新事务的 `retired/`，目标身份验真与两父目录 fsync。
source/target 使用内部 held-dir `/proc/self/fd/<fd>/<validated basename>` anchor，**不放宽**通用 symlink 拒绝。
completion 只作证据，不是授权。故障留证不删，不 replay manifest，不自动回滚覆盖 live 路径。
下一次只重验当前 live+OS；剩余候选进新 transaction；最后 rename 后缺 completion 也不重建 store。

容量只有内部 `TERMINAL_AUTHORITY_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024` 一个总字节帽；另有
64 transactions / 256 candidates / 单次2MiB snapshots 限制。扫描包括所有已知 partial snapshot、
retired、manifest/temp、completion 的实际逻辑 stat bytes；snapshot+retired 各计一份，创建前预留
所有计划 bytes，执行按已写/剩余预留记账。未知布局/unsafe 拒绝；无 GC/TTL，满则 `authority-archive-capacity`。
archive 不进入公共消息；仅固定审计 `authority-recovery` + E_* code/n/ms，不输出 nonce/hash/path/正文。

初查、留证、全部 rename、最终校验共用唯一绝对2s logical IO budget 与 startup abort，任何 await 后及
mutation 前都复核；没有逐文件重置。fsync 内核 IO 不可取消，超时先 unavailable，实际 settle 后才关 held fd，
迟到工作不能继续 mutation/adopt local。仅 **最后 stale rename 后首次观察到**的合法 publisher pending 或
pending+同 inode linked final 可在原 deadline 内用 5/10/20/40/80/160/320/640ms unref/abort-aware
退避做最多8次额外**整体验证**。预检/末次 rename 前 pending、unsafe pending、坏 final、journal/receipt/
原 current 变化都不获豁免。pending bytes 从不作为 authority，linked final 仍须完整 schema/current OS 验证。
只有默认严格 inspector（无 pending/nlink1）真正通过才能 ready；否则 `authority-publication-unsettled`。
默认 initialize 对 pending/nlink2 的拒绝永远不放宽；不会永久忽略 pending。

agent 初次 owner factory 仅 `TerminalLocalError("stale-authority-prev-boot")` 记为可补偿；真实新 link 的
hello_ack（不依赖 browser-only cap）后只试一次完整 guarded factory，成功再 guarded publishStatus。
已有/revoked owner 不重建；无 polling、无自动 open/restart；ordinary unresolved 不被泛化成重试权。
换 session/reload/shutdown/guard withdrawal 封 generation，迟到 owner 只能 dispose，不 adoption。
这不替 hub 最后-rename race 兜底，也不承诺补偿时另一 publisher 普通 unresolved 的同 link 重试。

威胁边界仍是同 uid 可信本地 producer、同机器单 kernel，不承诺共享网络 HOME/跨机器/恶意同 uid/root。
Node pathname 最后检查与 rename 不是 openat2/renameat2 conditional-rename；不修改 singleton 算法或
宣称跨 netns abstract 锁互斥。真实四阶段 SIGKILL 只证明同 kernel 可见集合/进程重启/调用顺序，
**不是 power-cut 证据**。固定状态诊断只追加，off/D8/source denied/unknown/P0公共SSE合同保持。

## PTY、后台、流控与 UI

- 页面后台/导航/刷新/renderer dispose 只撤 writer，不 close shell；列表接回原 termId/同 PID。**不跨 agent session/reload/hub restart 保活**；边界退出按身份有界清理，不能自动开新 shell 冒充接回。
- 单 writer CAS，15s lease/5s renew；stream epoch、raw-byte offset、input seq 幂等，未知已接受输入只查原 seq，不重打命令。creation ticket 10min、live/closing/poison pin，不因票据 TTL 重复 fork。
- raw ring 1MiB/term，scrollback1000；output8KiB、input4KiB、input pending32KiB、live64KiB、helper/UDS128KiB。hub 同时限制 raw64KiB、128项、实际序列化 frame128KiB，零 raw 控制帧也计费；只合并同 writer 相邻 state，不跨 output/gap/cutover。
- replay 固定≤16KiB suffix、0 live staging、最多8 attempts、绝对3s，write callback→replay_ready→cutover barrier 后可写，明确 gap。ResizeObserver 的 resize 在 writable 前不发送；cutover 统一发送当前最新尺寸，避免抢在 replay_ready 前被 agent 正确拒为 E_LEASE_EXPIRED 后 UI 误 detach。总512KiB/s 内预留 replay128KiB/s；慢 viewer≤2s detach，shell 继续。不能追满 ring 或声称 screen snapshot/完整 VT 历史恢复；同尺寸 resize/SIGWINCH 促重绘。
- UI 位于右侧 `FleetDrawer`，与 Agents 树、Bash 后台任务并列为第三个面板，不占对话区/dock 上方空间。沿用 ≥1280 docked / 768–1279 overlay / ≤767 fullscreen 与原打开状态持久化；rail 终端按钮或 header `TERMINAL_ENTRY.show` 显式打开抽屉并切到终端（header 的 aria-controls 指向 fleet-drawer）。只有终端可用也会挂载抽屉，但不自动加载终端 feature/renderer/API。终端面板选择不持久化，保留既有 agent/bash 偏好，防止资格恢复/刷新自动载入私有界面。关闭抽屉、切到别的面板或跨模式关闭时卸载终端 UI，沿用 `controller.dispose` 仅 detach writer、清屏/metadata/待处理材料，**不 close shell**；从终端列表显式接回。相较隐藏保活可释放 WebGL/监听且避免保留撤权材料，原 eligibility generation 同步撤销仍是最终门。页面内最大化，不用 Fullscreen API；**终端面板内 Esc 不关闭抽屉、不退出最大化**（确认框仍只取消自身）。Fullscreen 抽屉自身的 modal 是终端容器，不应被误判为高优先级确认框；其他 modal 仍阻断输入。Ctrl+Shift+F6 退出输入焦点；其他按键归 TTY，高层确认框优先。多行 paste/drop 确认，4KiB 上限；确认先移 modal、恢复焦点再 paste。原生 keyboard capture/bubble 门不能卸载宿主热键。
- optional metadata 来自 hub/validated uid/login shell/host/initial ctx，不来自 OSC/title/output；list/state 无 cwd/user/host/shell，panel 文本渲染。缺省内联英文 `unknown`；撤权清所有 metadata/屏幕/pending。
- controller 每个 HTTP/action await 前后绑定不可变 authority snapshot（认证、writer代、原 connection 对象/instance/token/expiry、client/session/epoch、AbortSignal）；迟到成功/错误/finally 不能写后继状态。忽略 abort 的 transport 也必须被挡住。卸载 detach 使用独立旧 lease 快照，不恢复 UI。

## WebGL-only、CSP、lazy 与升级门

字体只用系统具名等宽链：SFMono-Regular / DejaVu Sans Mono / Liberation Mono / Noto Sans Mono / Noto Sans Mono CJK SC / Menlo / Consolas / Courier New，然后才ui-monospace/monospace；本机generic monospace实际会落到比例Noto Sans CJK JP，不能放在链首。无字体资产/下载/新license。xterm测量前fonts.load("Wim中文")与fonts.ready最多等500ms（包含在原3s renderer界内），超时仍打开；迟到ready或loadingdone用公开fontFamily选项的等价变更重新measure/fit/refresh，dispose撤订阅，不读私有字段、不用负letterSpacing掩盖。

A−/A+的10..24字号单独保存为非秘密UI偏好 `pwh_terminal_font_size`，默认14；仅启用后的lazy panel读写，刷新和loss重建保留。source-scan仅增加此feature-local偏好模块，I8白名单不变。浏览器门从公开option facts与真实GPU画布校验W/i/m advance差<0.5px，cell= floor(advance×DPR)/DPR，另保留中文宽glyph回退；强制比例fontFamily的实际构建必须让此门变红。

精确锁 `@xterm/xterm 6.0.0` / fit `0.11.0` / webgl `0.19.0`，只在 UI devDependencies，无 runtime dependency。
WebGL2 不可用/禁用/getContext throw/null/addon失败：**xterm/CSS/prepare/open 前拒启并中文提示**，不回落 DOM。
每 mount 最多一次自动重建，每次初始化/重建3s硬界；第二次 loss/重建失败提示重开界面，后台 shell 不受 renderer 生命周期影响。新实例 detach/attach 原 termId，不 prepare/open/close。

xterm open 同步栈仍暂用 DomRenderer 初始化三处 stylesheet：dimensions/theme/Viewport scrollbar。`constructed-styles.ts` 只兼容精确版本/已知完整三注入集，转 CSSStyleSheet/adoptedStyleSheets，finally 恢复 document factory；未知/重复/漂移拒启。无全局 Element.prototype.setAttribute patch、私有 xterm 字段或 node_modules patch。
初始化 stage hidden/inert；识别真正 WebGL2 canvas（第一个是2D link layer），公开首帧/有效尺寸后才展示/写远端 bytes。core 先于 addon dispose；迟到实例、sheet/link/listener 全清。lazy import/CSS各5s、write callback2s。

主 CSP 不变，无 unsafe-inline/eval/nonce/hash/CDN/iframe 逃门。终端 JS≤256KiB gzip、CSS≤16KiB、probe host≤4KiB（仍计 ordinary lazy）；首屏 CSS 增量0，原 ordinary/mermaid/首屏预算不挪用。
分类用真实 Rollup 图 **E=M\\A** + SHA256，不凭文件名。CSS `?url` 同源 hash 资产按需加载，actual package closure/完整 MIT notices/provenance/source+artifact hashes 必须通过。
`terminal-paths.ts` 零 import；禁止 eager http-contract 反向 import terminal schemas。UI schema 使用生成的 JSON-only projection，deep-equal/Value.Check parity + unknown-keyword fail-closed，不是第二套 wire。
xterm/core/fit/webgl 任一升级，重审注入集/版本/provenance/license/预算并重跑七案例，不能宣称跨版本兼容。

## 审计与秘密边界

`auditTerminal` 只接受白名单：时间、listener、principal/user标签、非秘密关联tag、op/reason固定枚举、latency/bytesIn/bytesOut/droppedBytes、exitCode/已证reap outcome。禁止env/cwd/命令/stdin/stdout/title/password/nonce/grant/lease或其hash；helper/agent也不能打印完整帧或携用户正文的traceback。
每请求一条final记录；input/ACK/resize/renew成功按有界窗口聚合、失败固定码限频，不逐键落日志。revoke/kill/超时不丢失；写审计失败fail-soft且留有界健康计数，不能反过来放大输出洪泛。
terminal binding token只驻当前页面私有内存，不进URL/storage/history；不是既有登录token存储机制的替代。SSE bytes旁路transcript reducer，无正文数组/日志副本。

## 门禁与手跑

### 日常/集成（全部加外部 timeout）

- `npm run typecheck`、`npm run build`、`npm run build:web`、`npm run check:web`。
- `tsx scripts/web-hub/gen-third-party-notices.ts --check`、`tsx scripts/web-hub/gen-terminal-ui-schema.ts --check`。
- tier1：显式文件参数覆盖 `tests/web-hub/** tests/governance tests/boundary tests/config`；`tests/web-hub/hub/spawn/golden.test.ts` 单独 `TMPDIR=/tmp`。
- tier2：`tests/integration/web-hub-terminal-*.test.ts` 全部。F1 ingress/旧hub、F2 Q1–Q4、real PTY/local/wiring/journal/HTTP 不借 secure skip。CI 安装 zsh 以覆盖 bash/zsh login shell，并移除 runner 系统 rc 文件及 symlink 目标的 group/world 写权限，避免夹具按威胁模型拒绝不安全文件。
- compat/rollback 必须有锁定 O 提交的完整 Git 历史，CI test job 用 `fetch-depth: 0`；缺对象报可执行的 fetch 指引，不跳过旧组件证据。compat 的 11 个后端项常跑，10 个独立浏览器项仅在 `TPS_PLAYWRIGHT_MODULE` 和 `TPS_CHROMIUM` 均存在时运行；缺资产明确 **offline browser not provided ⇒ NOT RUN**，已提供但无效必须失败。环境齐全共 21 项，详见 [acceptance](acceptance.md#45-ci-历史与离线浏览器门)；rollback/per-session 不依赖浏览器，独立 e2e probe 保持 Tier 3 显式失败门。
- off golden、activate-trace、boundary；不变更 I8 白名单/注册 trace/旧 fixtures。`git diff --quiet 2d802f1f -- tests/fixtures/`、`git diff --check`、Prettier 精确路径检查。
- separate-process durable-release 用例保留 revision≥before+2、零 journal rows、exact receipt ACK 删除、真实 PID gone 断言；等待对齐生产 reaper 上限60s，不以 close/exit 代替。失败输出 stage/round/journal/receipt物理字段/PID stat/agent固定诊断/lifecycle，不输出秘密；四轮总界300s。重复10次记录不能当 full-file 其余用例通过。

### 隔离 PTY fixture 的系统 rc 门

`tests/integration/web-hub-terminal-system-rc.ts` 是 fixture 与 PTY suite 共用的 **test-only** pre-exec audit；不属于生产终端准入。先枚举 Fedora/Ubuntu bash、zsh 的系统启动路径及 `profile.d/*.sh` / `sh.local`，再 `realpath` 到 `/etc` 或 `/usr` 内的 regular file，要求目标 uid 0、不可 world-write，group-write 仅允许 gid 0（将 root 组视为管理信任边界）。不以 symlink 自身常见的 0777 mode 判断目标可写性；不声称 ACL 审计或防御并发 root 改写。缺省的可选 rc 可不存在，但 dangling symlink、读取/枚举失败不静默略过；错误只带文件路径与固定原因/OS code，不带文件正文。

HOME/ZDOTDIR assignment、unset/read 的原有检测与注释过滤保持不变，发现重定向必须在 exec 前拒绝，不通过改 HOME、跳过 rc 或降低覆盖率“修复”。单元测试用私有 scratch 根、文件列表和属主 uid 替身，不改真实 `/etc`。此检查不是 shell parser，也不是 OS 沙盒；fixture wrapper 仍须验证 HOME 并禁用可选 bash-completion。

2026-11-14 CI `43509495998` 的完整 setup 日志证实 `ubuntu-latest` 已指向 **Ubuntu 26.04.1 / ubuntu26/20261111.196.1**。该镜像 [systemd 259.9-0ubuntu0.1 的 SBOM](https://github.com/actions/runner-images/releases/tag/ubuntu26%2F20261111.196) 与官方 `.deb` 内容一致：`/etc/profile.d/{70-systemd-shell-extra,80-systemd-osc-context}.sh` 是指向 `/usr/lib/systemd/profile.d/` 下同名 root:root 0644 文件的 symlink。旧 `lstat().isFile()` 因而拒绝正常安装；两目标均不命中 HOME/ZDOTDIR 检测。不能把镜像版本误当 24.04，或无证据归因于 `env_vars.sh` 的组写权限。

### CI3：用户 rc 与输入就绪（test-only）

PTY suite 与共享 fixture 一开始已创建全部 zsh startup files，所以 newuser-install 不应触发。
Ubuntu/Debian 打包的 `zshrc` 在 Ubuntu 上会先于用户 `.zshrc` 调用 `compinit`；fixture 的
`.zshenv` 使用其文档化开关 `skip_global_compinit=1`，避免宿主 completion 目录权限提示，
不设置 `NO_RCS`/`GLOBAL_RCS`，不跳过原生 login rc。PTY 回归用私有不安全 fpath 模拟该 gate。
`waitRc` 同时等待独立 `RC_READY` 行与 fixture prompt，而非把 rc 中途标记当 readline 已就绪；
Ctrl-D 回归有意拉开 marker/prompt 窗口，仍核 exit code 与真实 reaped 证明，未放大 timeout。
`until` 的失败附最多两个 backend 各 1024 字符的 PTY suffix：先替换 fixture 根、用户路径与
所有已知假秘密，再截尾并 JSON 转义控制字符；真实输出回归验证脱敏与长度。
越界 HOME 测试使用另一个私有 0700 fixture 的现存目录，测 containment，不依赖开发机账号。
这些都是测试策略，不替生产终端抑制真实用户的首次配置或 compinit 提示。

### 离线 Chromium tier3（不进 CI、不安装依赖）

前置 Linux/Python/bash、Node≥22.12、已有匹配 Playwright1.63.0/Chromium revision1243缓存。缺缓存报失败/NOT RUN，绝不隐式下载。使用 owned0700 短路径 HOME/XDG_CACHE_HOME/TMPDIR；unset XDG_RUNTIME_DIR/NODE_OPTIONS/PI_CODING_AGENT_DIR、umask0022；只读 node_modules symlink 必设私有 `PWH_UI_CACHE_DIR`。

```sh
# 先建上述私有环境并 build:web；下面两门独立，不能互相替代。
# 指向已安装的隔离离线资产；脚本不运行 npx，不下载。
export TPS_PLAYWRIGHT_MODULE=/tmp/webhub-terminal-p0-env-53xczH/home/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs
export TPS_CHROMIUM=/tmp/webhub-terminal-p0-env-53xczH/browsers/chromium-1243/chrome-linux64/chrome
export PLAYWRIGHT_BROWSERS_PATH=/tmp/webhub-terminal-p0-env-53xczH/browsers
export npm_config_cache=/tmp/webhub-terminal-p0-env-53xczH/home/.npm
export npm_config_offline=true
export PWH_TERMINAL_EVIDENCE_DIR=/tmp/webhub-terminal-p3-evidence
# 七案例：正式 TerminalPanel/renderer，HTTP 是明确 contract fake。
timeout 600s npm run probe:csp -- --suite terminal --browser chromium
# 真跨层：真实 hub + 独立 Node agent（fake-pi SDK 宿主）+ 真 Python PTY。
timeout 240s npm run probe:terminal-e2e
```

真跨层脚本使用随机短路径私有 HOME/port0/Unix socket、真实 guarded authority/receipt/journal/OS verifier，**只 DI 审核过的隔离 uid/rc fixture**；不碰用户真实 ~/.pi、rc、凭据、运行中 hub。agent 版本随 package 以免触发 supersede。
生产 manifest-verified UI 经真实 token login→按钮→drawer list→echo/PID→max/Esc→真实 loss 同 PID/零新open→后台完成→刷新接回同 PID→确认关闭→物理回收/配额再开→privacy/revoke立即失效→禁用 WebGL 中文拒启。监听原 SSE 仅观测输出，不替换后端/渲染器，不读 xterm 私有 buffer；网络路由仅允许该私有 loopback origin。
截图（返工版-r2后缀）、JSON/操作计数、CSP与console错误写 evidence 目录；warnings单独有界保存（最多64条、每条2048字符、另记droppedWarnings），主/禁用WebGL页面均采集，不混入错误判定；任何异常 exit1，不把没有测试/只截图当 PASS。先等后台 action 完成再刷新，否则人为取消尚未送出的 detach 不能当成功后台的证明。

七案例保留 normal/recovery、recovery失败、getContext null/throw、addon失败、negative、真实 --disable-webgl。六正例必须0 CSP违规/无可见DOM；negative 必须恰1 CSP违规+1 console error（证明捕获器有效），不混入正例统计。

**Firefox：NOT RUN**（用户已接受本机 GTK3/NSS 限制，不升级系统）。Chromium结果不可外推。OS级中文 IME、移动键盘/真设备、系统剪贴板/完整拖放、preview/hold-stop/drawer 全键盘共存、8路真实持续PTY+慢renderer联合内存/公平压测仍须单独记录；没有执行不能写 PASS。

## 混版与失败回滚（#45）

O 精确为 `4e15fac15ee42293eac7c19943655537bd21b7c2` 完整组件，N 为当前实现；
历史 `terminal-legacy/` 只证明 F1 ingress，不能冒充 O 真 PTY。隔离 harness 从本地对象 archive，
记录 tar/source/package/lock/Node/SDK/工具链/adapter/UI manifest 与 artifact hash；旧 production 不 patch。
先真实 O/O 后端登录/open/pwd/reap，再测各格。每个 UI 都经自身 manifest verifier，不伪造 build hash。

| hub / agent / UI                | 明确合同与实际编码限界                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| O/O/O，旧 config 有 terminal    | 真实原 #34；**O hub 有既有私帧 gzip 缺陷**，默认 gzip 浏览器连不上。identity 编码仅作为获批补充证明旧 PTY/UI 其余行为，不称 gzip PASS。 |
| N/N/N、N/N/O                    | 合格声明目标可真实 open；N hub 必须在 gzip 下通过。O UI 仍可能在不合格目标画入口，server 必须拒绝。                                     |
| O/N/O，旧 config 有 terminal    | N agent 保留 legacy launch config/原私有协议；O 忽略 optional 声明。O hub gzip 仍是旧缺陷，identity 补充可 open。                       |
| O/N/N，旧 config 有 terminal    | N UI 缺 new cap 严格隐藏、零 terminal API；O hub gzip 先于 DOM 降级就失败，只有 identity 补充能观察严格隐藏。                           |
| N/O/N、N/O/O                    | N hub 拒无声明旧 agent。N UI 隐藏零请求；O UI 点击得到固定 unsupported，零新 PTY。                                                      |
| O/N/任意，旧 config 无 terminal | 无 cap/route404，不能动态启用；普通会话继续。无 terminal 私帧，O hub 此 off 格 gzip 正常。                                              |
| N 由 O launcher 启动，缺 source | machine on 仍 startup-domain-unknown unavailable；plain 新 launcher 显式 restart 才恢复。                                               |
| 机器/agent 真正 off             | raw hello/ack/session/status/HTTP/SSE 与锁定 O golden 比较，只归一化具名随机身份/时间/端口，绝不剥 features/caps/status。               |

升级/回滚只在用户批准窗口执行，本项目验收不授权现场 restart。hub restart 是清理边界，不是 shell 保活；
先停止新 open，真实 close→reaped→exact receipt/独立 OS→durable prune/ACK，确认 clean/drained 后才可回旧组件。
隔离演练必须证明 O 真实读取 N 产生的相同 journal/witness、重新登录/open/reap；未 bump 格式不是充分证据。
crash-dirty/unknown/poison 无法证明物理释放时不启动能重开的旧版，不删 journal/receipt/witness、不 reset、不自动换
agentDir/忽略 marker/回退旧 config。graceful orphan receipt 若可被现有 fresh handoff 验真，仍须先完成真实结算；
不能把缺 receipt 的实际 SIGKILL crash 当成可安全降级。回旧 hub 会失去新声明门，不能宣传保留新授权保证。

#45 真实多 agent 集成另发现 O 既有的 inventory end 并发缺陷：全局 fence busy 会拒绝另一真实 end publication，
receipt 已 reaped 仍留 unresolved。修复在 service 层用 FIFO 串行**原 exact end publication**；排队消耗原 deadline，
轮到时重核原 producer/challenge/abort，active caller 取消不提前释放 writer，失败不毒化后继。没有重试、扩预算、
修改 receipt/OS verifier 或放松两次 durable CAS。多 agent 连续 close 的最终门必须核 revision 至少 +2、rows=0、
receipt ACK 删除及实际 PID gone，不能因 close200 就写 PASS。私帧 gzip 修复见上文唯一 encoder/FIFO 不变式。

## 残留风险

同 uid 文件/凭据访问、LAN明文劫持、rc 副作用与 shell 自行 history 不在隔离保证内；无完整历史/VT像素恢复；恶意 uid/namespace/组脱逃、内核D-state、agent/helper同时被杀可能残留。大 managed identity 集合超过16KiB页/64KiB库存预算时保守拒绝，不裁证明或伪造空库存。未知磁盘/authority状态刻意 fail-closed，无自动 reset。逻辑 IO 截止不等于可抢占 fsync。reload/重启是清理边界，不是后台保活承诺。门禁日志里的已有 skip/环境限制都要在证据包单列。

2026-11-14 曾有一次旧 probe「刷新后列表为空、整 cookie 对象 JSON 不同」；当时缺 SID/journal，无法回溯为真正 SID 轮换或独立 shell 退出，不宣称已证明那次具体原因。root 接受以强化可证伪回归+明确残留交付：新 probe 对同一 Page/Context 的真实 SID 做仅内存非秘密序号对比并断言，记录 context-wide login/Set-Cookie/SSE/list 序号及失败 journal/固定 backend 诊断；已有45次同 SID 刷新反证与真实 hub/PTY 三次 SSE 替换同 cookie/同 PID 回归。若再出现必须用这些新证据归因，不能只以「重跑绿」结案，也不把整 cookie 属性/数组比较误报成 SID 轮换。
