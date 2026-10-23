# pi-traffic-record 并入 pi-toolkit：实施方案（traffic-merge）r2

> 状态：**r3**。r1 评审（reject，2B/9M/3m/1n）→ r2；r2 复审（reject，剩 R1-1/3/8/9 四项，`/tmp/traffic-review-r2.md`）→ 按 dev-flow 收敛规则第三轮由主会话裁定（§R2），本版按裁定修订，由主会话核对闭合，不再开评审。8 项产品决策用户已拍板（§12）。HARD GATE：主会话核对闭合前不开发。
> 车道：dev-flow **L3**（多包、跨模块、安全面、进程级共享状态）。
> 来源：`~/ai/pi-traffic-record`（`main` 9 个提交 + 未提交的 `PI_SECURE_SESSION` 适配，已验收，视为合并基线；T0 先固化为提交）。
> 目标：`~/ai/pi-toolkit` `dev` 分支。先例：`docs/dev/plugin-merge/merge-plan.md`（含评审修订 B1/S1–S8）。
> 外部源码路径一律相对 `/home/bluecake/ai/pi-traffic-record/`。

---

## 0. 决策摘要（一页）

| #   | 问题                  | 结论（r2）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 目录/设置/注册        | `src/traffic/`；设置组 `traffic.*`，**`traffic.enabled` 默认 false**（非 live）。主会话在 `activate()` **末尾**注册（排在 cache-ttl 后，录到最终 payload）；子会话 guard **前**只注册钩子。off ⇒ 零注册、零 IO、零全局符号、零进程监听器、不加载 `node:sqlite`（§7.1）。                                                                                                                                                                                                                                            |
| 1b  | 数据兼容              | 路径**固定** `homedir()/.pi/agent/records/traffic.db`（与源实现同算法，不随 `PI_CODING_AGENT_DIR`），表结构一字不改。旧 `dumps/` 目录**不再自动搬迁**：检测到即拒绝并给人工步骤，半迁移状态拒绝打开（§3.3）。                                                                                                                                                                                                                                                                                                       |
| 1c  | 防双写（Blocker 2）   | **单向优先级的认领协议**（§2.4）：toolkit 只在「确有活动的外部录制器」时让位；外部墓碑版只对**有效且存活**、身份可校验的 toolkit claim 让位；claim 由主会话 activate 发布、shutdown 身份校验释放，`enabled=false` 永不发布。两种加载顺序 × 旧版/墓碑版 × reload 开关均断言「活动录制器恰为 1」（真实加载测试）。                                                                                                                                                                                                    |
| 1d  | 请求身份（Blocker 1） | **不从 holder 猜，也不按「唯一未配对票据」猜**。会话请求在 `before_provider_headers` 注入一次性票据头 `x-pi-traffic-ticket`；`before_provider_request` 只在**可证明**时绑定（该 runner 的存活票据集合恰为 {T}，且退役规则可靠，§5.3），否则不绑定任何票据、不应用改写、原样发送并记 `unattributed`。同一 T 上 strict-tools 回退产生新 **payload generation**，旧改写缓存失效；只有同 generation 的网络重试复用改写结果。fetch 层凭票据 +「generation 首次绑定的正文摘要」认领并**剥离票据头**。原全局串行闸门退役。 |
| 2   | SQLite                | `node:sqlite`，零依赖；运行需 Node ≥22.13，engines 仍 `>=22`。**首次显式 DB 访问（`/record on` 或 `/record status`）才加载**。写入走写后账本 + **每 tick 工作预算**：`busy_timeout=0`、每个 tick ≤2ms 或 ≤1 次 BUSY 尝试，忙则 unref 退避让出；读（历史/导出）同样分页让出。T2b **硬验收门**：持锁基线下 provider 发送延迟增量 ≤10ms、心跳间隔 ≤80ms；不达标即切 `worker_threads` 分支（接口与失败处置已定，§3.2），不预设 worker。                                                                                 |
| 3   | 网页                  | 第一期保留独立 HTTP 服务（4177 起）。**默认绑 127.0.0.1，LAN 需 `traffic.web.host="0.0.0.0"` 显式开启**（拍板②）。**硬规则：网页服务与重放只存在于主会话的交互模式（tui/rpc）**；print/json 模式不启动服务、无重放入口；子会话只录制不重放。会话结束（`session_shutdown`）走 dispose 中止在途重放（§4.1）。加固：Host 白名单、反嵌入、`no-store`/`no-referrer`/`nosniff`、全部 `/api/*` 要 token（摘要定长比较）、无 ACAO、accepted socket 记账并 unref。web-hub 整合列第二期（拍板③）。                            |
| 3b  | 前端依赖              | 不新增 devDeps；vendor 保留 Vue **3.5.42** 原字节（拍板⑧），`VENDOR.json`（版本+sha256）锁定，与 node_modules 解耦；Vue MIT 全文随 vendor 入库。                                                                                                                                                                                                                                                                                                                                                                    |
| 4   | 加密会话              | 判定 = `PI_SECURE_SESSION==="1"` **或** `getSecureDomain()?.kind ∈ {secure, locked}`（直接 import 工作区已有的 `src/secure/domain.ts`，secure P2 开发中未提交）。所有落库点经唯一 `persist()` 闸口，每次执行前复查 secure + engine 纪元；流捕获每批复查。`applySecureDomainOverrides`（`src/config/settings.ts`）加一行 `traffic.enabled=false`（两个加载入口都测）（§6）。                                                                                                                                         |
| 5   | 冻结面与共存          | 三份 off golden 不动；`traffic-wiring` 断言 off 零面。traffic 钩子恒返回 `undefined`。cache-ttl keepalive：会话一旦有请求被实际改写，其旧 capture 即被否决，改写规则启用期间暂停 ping，并否决 pi 原生 cache warming（§7.3）。toolkit 内部模型/HTTP 调用（keepalive、quota、title、topic judge、measure/probe）**结构上无票据**，天然不录不改写（拍板⑥，§5.4 接入矩阵）。                                                                                                                                            |
| 5b  | 进程模型              | engine 带 owner 身份与纪元，异步续体固定持有入口 engine，`closing` 同步撤销接纳。trampoline：**每次安装新建 wrapper 闭包，下游固定为安装时捕获的函数**（不共享可变 `orig`），旧 wrapper 一律退役为纯透传；同一时刻最多一个活动 wrapper；ALS 重入守卫把环路请求直送平台原生 fetch 并计数（§5.2）。                                                                                                                                                                                                                   |
| 6   | 测试                  | 迁 13 个文件（160 例）到 `tests/traffic/`；新增 13 组（含交错配对、generation、fetch 链重挂、模式门禁、持锁预算、真子进程退出、真实加载共存），全量增量估 <3%（§8.4，以 T7 实测为准）。                                                                                                                                                                                                                                                                                                                             |
| 7   | 原仓库                | 拍板④：T0 先在原仓库提交加密适配并发 v0.2.1；toolkit 发版后发墓碑版 v0.3.0（按 §2.4 协议让位 + 弃用提示），README 指向 toolkit，GitHub 归档（push/发版/归档各需用户授权）。                                                                                                                                                                                                                                                                                                                                         |
| 8   | 估时                  | 第一期 10 包约 **9.2 人日**；若 T2b 硬验收门不达标，追加 worker 分支 **+1.5 人日**（条件项）。第二期 web-hub 另计 6–8 人日。                                                                                                                                                                                                                                                                                                                                                                                        |

**需用户复核（评审驱动的行为变化，非拍板冲突）**：

- **R-d 无法证明归属的请求不改写**（r3 裁定 R1-1）：交错窗口内（例如失败请求未退役时紧接的重试、streaming warming 与真实请求交错）请求按原样发出并记 `unattributed`，改写规则不作用于它；规则启用时 warming 已被 stop，常态影响很小，status 计数 `unattributedPayloads` 可见。
- **R-a 改写不再全局串行**：原 README「provider 请求被串行化」的承诺来自用闸门换归属；r2 用票据精确归属，闸门退役，启用规则时并行子 agent 不再排队。`rewrite_settings` 表里的四个 `serialize_*` 参数保留不删但不再生效（status 标注「已停用」）。
- **R-b 改写覆盖面以票据可达为准**：只有 conformance 证明票据头能经 SDK 到达 fetch 且被剥离的 provider API 才启用改写与线级录制（首批 anthropic-messages / openai-completions / openai-responses）；其余 API（含 Codex，除非证明 SSE 可达且 WS 握手不携带）只录钩子级字段（payload/状态/响应头/消息），**改写不生效并显式标注**。若用户依赖 Codex 改写，需在 T6 后复核。
- **R-c 旧 `dumps/` 自动搬迁取消**：本机已无 `dumps/`，改为检测 + 人工步骤。

---

## 1. 读码确认的关键事实（方案前提）

1. **规模**：源码约 4.0k 行 TS + `app.js`（1590 行，运行时编译模板）+ vendor Vue global build；13 个测试文件 160 例全绿（2026-10-23 实跑 1.36s）。
2. **顶层副作用**：`db.ts` 模块顶层 `createRequire(...)("node:sqlite")`；`page.ts` 顶层读 vendor/app.js 并 `gzipSync`；`jq.ts:77` 顶层 `process.once("exit", cleanupOnExit)`。import 即有 IO、全局监听与 ExperimentalWarning（本机 Node 22.22.1 实测打印）。
3. **peer**：外部包声明 `>=0.84 <0.86`，toolkit `>=1.0.0 <1.4.0`；本机 pi 1.3.0 上两包当前**同时加载**（settings packages：`["../../ai/pi-toolkit","../../ai/pi-traffic-record"]`）。所用事件在 1.3 `types.d.ts` 齐备；`ExtensionContext.signal` 存在；`cache_warming_decision` 可返回 `{action:"stop"}`。
4. **`moduleCache: false`**（`core/extensions/loader.js:478`）：主会话、每个子会话、每次 `/reload` 都是新模块实例。外部包每次加载都 `patchFetch()` 在当前 `globalThis.fetch` 外再包一层，卸载无条件写回自己保存的 `originalFetch`，非 LIFO；`recording` 每实例一份（子会话从未被录）。
5. **身份是猜的**（Blocker 1 根因）：`correlate.beginAttempt()` 用 `holder ?? pendingSlot`；`bypassWaiter()`（queue-wait 超时）放行的请求在 fetch 时拿到的是**别人**的 holder，`claimPending()` 随后按 slot 认领别人的 pending、套别人的规则、写别人的行；max-hold、no-fetch 后迟到、超过 `retryGraceMs` 的重试同理。`correlate.stashedHookHeaders` 是进程单槽，跨会话覆盖。
6. **钩子与请求路径**（pi 1.3 `core/sdk.js:193–275`，pi-ai `models.js:422–442`、`api/anthropic-messages.js:436–478`）：会话请求先 `applyAuth → transformHeaders → before_provider_headers`（就地修改 headers，进入 `options.headers` → SDK client 默认头 → 每次 fetch 及 SDK 内重试都携带），再 `buildParams → onPayload → before_provider_request`（值顺序传递），再 `client.create → fetch`，再 `onResponse → after_provider_response`。strict-tools 回退会在同一 headers 下再调一次 `onPayload`。
7. **非会话请求**：`ctx.modelRegistry.complete/streamSimple` 直通 runtime（`core/model-registry.js:74–78`），**不经扩展钩子**——title（`src/title/index.ts:183`）、topic judge（`src/topic-switch/wire.ts:515–531`）、keepalive pipeline（`src/cache-ttl/pipeline-ping.ts:365`，自带 transformHeaders，不是扩展 runner 的）均如此；quota/ping-client/measure/probe/web-search/feishu 是裸 fetch。pi 原生 **cache warmer**（`core/cache-warmer.js:135,239`）复制会话的 `requestOptions`（含 `transformHeaders` 与 `onPayload`）⇒ 两个钩子都会触发，`maxTokens:1`，可与真实请求在同会话并发（streaming warming）。**compaction** 用 `agent.streamFunction` 但 options 不含 `onPayload`（`compaction.js:480–487`）⇒ 只触发 headers 钩子。
8. **子会话真实退出**：`PiSessionHandle.dispose()`（`src/runtime/session-driver.ts:591–598`）→ `AgentSession.dispose()` 只 abort/invalidate/断监听，**不发 `session_shutdown`**；toolkit 先例用 `agent_settled` + 主栈 `onReaped` 兜底（`src/cache-ttl/child.ts:199`、`src/stack.ts:2743–2759`）。
9. **toolkit 现状**：secure **P2** 正在工作区开发（未提交）：`src/secure/domain.ts` 已提供 `getSecureDomain()`（冻结的 `plain|secure|locked` 判定，`Symbol.for("pi-subagent:secure-domain")`），`src/index.ts:163` 已在 activate 开头 `initSecureDomain()`，`src/config/settings.ts` 的 `applySecureDomainOverrides` 已是两个设置加载入口的共同出口；D5 检测属 P1 的 `helper.mjs`。`webCommandPolicy` 对表外扩展命令默认 `confirm`（`command-policy.ts:269`）。hub 先例：`hub/auth.ts:61,167` SHA-256 摘要后 `timingSafeEqual`；`hub/http.ts:196,387–389` CSP `frame-ancestors 'none'`、XFO DENY、no-referrer。CI 测试只跑最新 Node 22；`web-min-node`（22.12.0）只 `build:web`。
10. **外部服务鉴权**：绑 `0.0.0.0`，回环完全免 token，无 Host/Origin 校验，`===` 比 token，无安全响应头；`request_headers` 存 `x-api-key`/`Authorization` 明文。
11. **严格模式**：以 toolkit tsconfig 试编译外部 src 仅 **4 个错误**；已用 `.js` 后缀；tab 缩进需过 prettier。
12. **数据**：本机 `traffic.db` 约 73 MB，无 `dumps/` 目录，未设 `PI_CODING_AGENT_DIR`。`app.js` 只识别 `rewrite_status ∈ {applied, blocked}`，其它值不显示徽标（新值向后兼容）。

---

## 2. 目录、设置与注册（问题 1）

### 2.1 目录

```
src/traffic/
  index.ts        wireTrafficHost(pi, deps) / wireTrafficChild(pi, deps)：唯一面向 pi 的装配
  command.ts      /record on|off|status
  claim.ts        认领协议：发布/身份校验释放/读取外部 active 标记（§2.4）
  engine.ts       进程级容器 Symbol.for("pi-subagent:traffic") + TrafficEngine（owner/epoch/状态机，§5.2）
  tap.ts          fetch trampoline 与状态机（§5.2）
  ticket.ts       票据铸造/配对/台账/TTL 回收（§5.3）
  persist.ts      唯一落库闸口：secure+纪元复查、写后账本、每 tick 预算调度（§3.2、§6）
  db-port.ts      DbPort 接口 + 同线程实现（§3.2）；db-worker.ts 仅在 T2b 硬门不达标时新增
  mode.ts         运行模式门禁：服务/重放只允许主会话 tui/rpc（§4.1）
  cancel.ts       engine 级可取消域：重放、读流、后台捕获（§4.1）
  keepalive-port.ts  轻量只读端口：rewriteArmed()/vetoCapture(sessionId, capturedAt)（§7.3；不 import 重模块）
  warming.ts      registerWarmingVeto：规则启用时 stop pi 原生 cache warming（§7.3）
  secure.ts       加密判定端口（§6）
  dup-detect.ts   settings 扫描（只告警/辅助）+ getCommands 判定（§2.4）
  capture.ts correlate.ts rewrite.ts jq.ts redact.ts sse.ts db.ts server.ts page.ts   源模块迁入后改造
  web/app.js
  web/vendor/vue.global.prod.js   （prettier 忽略）
  web/vendor/VENDOR.json          { version:"3.5.42", sha256, source }
  web/vendor/LICENSE              Vue MIT 全文
tests/traffic/**                       原 13 文件 + 新增（§8）
tests/integration/traffic-*.test.ts    装配、冻结面、共存、真子进程
tests/conformance/traffic*.test.ts     真 pi + 本地 stub（§8.3）
scripts/traffic/vendor-vue.mjs         vendor 刷新（替代 vendor:check）
scripts/traffic/node-floor-smoke.mjs   最低 Node 真进程冒烟（§3.1）
docs/dev/traffic/                      原 docs/dev/{page-vue,traffic-rewrite} 原样迁入
```

`serialize.ts` 不迁入（§5.3）；其测试中与 poison/重试语义相关的用例改写到 `ticket` 测试。

### 2.2 设置（`src/config/settings.ts` + `setting-specs.ts`，仿 `webSearch`/`memory` 组）

| 键                      | 类型                       | 默认                     | 语义                                                                                                          |
| ----------------------- | -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `traffic.enabled`       | bool                       | **false**                | 总开关；off ⇒ 不调用任何 wire 函数                                                                            |
| `traffic.childSessions` | bool                       | **true**（拍板①）        | 子会话请求是否**落库**。为 false 时子会话钩子仍注册（票据仍用于改写的精确归属），只是不写行                   |
| `traffic.web.host`      | `"127.0.0.1" \| "0.0.0.0"` | **`127.0.0.1`**（拍板②） | 绑定地址；`0.0.0.0` 时 `/record on` 与 status 额外提示「明文 HTTP：token、请求正文与 API key 可被同网段嗅探」 |
| `traffic.web.port`      | int 1024–65535             | 4177                     | 起始端口，占用自增，最多 20 次                                                                                |

全部**非 live**；进 `SETTING_SPECS`；四处同步（接口/默认/解析/specs）。不提供 dbPath。

拍板①的含义写入 README：开启后 consult fork、`/goal` verifier、workflow 子 agent 的完整 prompt 与输出也会落库，数据量约随子 agent 用量线性增长；`childSessions=false` 只禁止落库，**不禁止子会话请求被改写规则作用**（规则是用户显式启用的出站改写，按票据精确作用于所属请求）。

### 2.3 注册位置（`src/index.ts`）

```ts
// pre-guard（:197 已算 isChildSession；只读 preGuardSettings，不写盘——merge-plan B1）
if (isChildSession && preGuardSettings.traffic.enabled && !isSecure())
  wireTrafficChild(pi, { settings: preGuardSettings.traffic });
...
if (g[HOST_KEY]) return; // :277
...
// activate() 最末尾（wireWebHub 之后）：主会话 before_provider_request 排在 cache-ttl 之后
if (settings.traffic.enabled && !isSecure()) wireTrafficHost(pi, { settings: settings.traffic, cwd });
```

- **主会话**：同步执行认领（§2.4），注册 `/record`、六个钩子、`cache_warming_decision`、`session_start` 共存复核、HUD status（录制中 `traffic` = `rec`）。engine 在**首次显式 DB 访问**时创建（§3.1）；trampoline 在首次 `/record on` 时安装。网页服务只在 `ctx.mode ∈ {tui, rpc}` 时随 `/record on` 启动（§4.1 模式门禁）。
- **子会话**：只注册 `before_provider_headers`/`before_provider_request`/`after_provider_response`/`message_end`/`turn_start`/`agent_settled`/`cache_warming_decision`。每个钩子在入口读一次全局 engine 并固定持有（§5.2）；engine 不存在、非 open、未录制或 claim 不属于 toolkit ⇒ 立即 return，不做 `JSON.stringify`、不铸票据。
- **print/json**：无定时器、无服务、无重放入口（§4.1 硬规则）；若以 `pi -p "/record on"` 方式开启，只录制，`/record on` 的回复注明「print 模式不启动网页服务」。

### 2.4 认领协议与迁移（Blocker 2）

**原则**：活动录制器恰为 1；优先级单向——**已证实活动的外部录制器优先，toolkit 让位**；外部墓碑版只对有效、存活、身份可校验的 toolkit claim 让位。仅凭 settings 字符串**不构成**让位依据（可能被过滤或未加载）。

**两个进程级符号（纯内存，不落盘）**：

```ts
// toolkit 发布（claim.ts）
g[Symbol.for("pi-traffic-record:claim")] = { v: 1, owner: "pi-toolkit", token: {}, pid: process.pid, isLive(): boolean };
// 墓碑版 v0.3.0 成为活动录制器时发布
g[Symbol.for("pi-traffic-record:external-active")] = { v: 1, version: "0.3.0", pid: process.pid };
```

**toolkit 主会话 activate（同步）**：

1. 若 `external-active` 存在且 `pid===process.pid` ⇒ 外部已在本进程活动（它先加载）⇒ **不发布 claim、不注册 `/record` 与任何钩子**；session_start notify 一次「pi-traffic-record 已在运行，toolkit traffic 让位；请从 settings.json 移除后重启」。
2. 否则发布 claim（`isLive` 闭包标志置 true），注册命令与钩子。settings 扫描（`dup-detect.ts`：`<agentDir>/settings.json`、`<cwd>/.pi/settings.json` 的 packages/extensions 含 `pi-traffic-record` 或 `@bluecake/pi-traffic-record`，及 `<agentDir>/extensions/traffic-dump.ts`）**只用于告警文案**。
3. **session_start 复核（权威证据）**：`pi.getCommands()` 中若存在名为 `/^record(:\d+)?$/` 且 `sourceInfo.path` 不在 toolkit 包根下的命令 ⇒ 证明有外部录制器实际加载（旧版 v0.2.x 不认协议）⇒ toolkit **身份校验释放 claim**、全部钩子切 inert、`/record*` 只回复让位说明、notify 一次。此时 toolkit 尚未录过一行（engine 只在命令后创建），故无双写窗口。

**释放**：主会话 `session_shutdown`（任何 reason）⇒ `if (g[claimKey]?.token === myToken) { isLive=false; delete g[claimKey]; }`。`traffic.enabled=false` 的激活**永不发布**；reload 开→关：旧激活 shutdown 已释放，新激活不发布 ⇒ 无残留压制外部包。进程崩溃 ⇒ 内存符号随进程消失。

**墓碑版 v0.3.0 activate（原仓库 T8 实现）**：`claim?.v===1 && claim.owner==="pi-toolkit" && claim.pid===process.pid && claim.isLive()===true` ⇒ 整体让位（不 patch、不注册），notify 弃用；否则成为活动录制器，发布 `external-active`，shutdown 时同样身份校验删除，并每次 session_start 提示弃用。

**子会话**：toolkit 子会话钩子只在「claim 属于 toolkit 且 isLive」时工作；墓碑版在子会话按同一规则让位；旧版在子会话的实例 `recording=false`，不录（现状）。

**用例矩阵（真实加载，§8.2/§8.3）**：toolkit 先/外部先 × 外部为 v0.2.1 旧版/墓碑版/未加载但 settings 列着/项目级 settings 过滤/未知路径(`-e`) × reload 开→关、关→开 ⇒ 断言：活动录制器数=1（以 stub provider 请求后各自新增行数判定）、无 `/record` 双活、关闭后无残留 claim。

**用户迁移步骤**（README「从独立插件迁移」）：

1. 所有运行中的 pi 执行 `/record off`。
2. 升级 pi-toolkit。
3. 从 `~/.pi/agent/settings.json` 的 `packages` 删 `"../../ai/pi-traffic-record"`（有 `extensions/traffic-dump.ts` 一并删）。
4. `~/.pi/agent/pi-subagent.json` 写 `"traffic": { "enabled": true }`（或 `/agent settings`）；需要 LAN 再加 `"web": { "host": "0.0.0.0" }`。
5. **重启 pi**（不只 /reload）。
6. 验证：只有一个 `/record`；`/record status` 计数与迁移前一致（库、规则、引擎设置在 DB 中自动沿用）；页面历史可浏览。
7. 回滚：`traffic.enabled=false` 并加回 package（另一 pi 进程仍跑旧版时可与 toolkit 共享同一库，schema 不变）。

---

## 3. SQLite（问题 2）

### 3.1 加载与版本

- `node:sqlite`（`DatabaseSync`），零依赖；不考虑 better-sqlite3（原生模块，违反无 dependencies，git 安装不编译）。
- 22.5–22.12 需 flag，**22.13 起直接可用**；engines 保持 `>=22`。`db.ts` 改为懒函数 `loadSqlite()`。**契约**：首次**显式 DB 访问**才加载——`/record on`，或 `/record status`（status 是显式查询，会打开库取计数；未录制时 status 打开短连接读完即关）。不可用时：「traffic 录制需要 Node ≥22.13（当前 vX），node:sqlite 不可用」，仅本命令失败。
- ExperimentalWarning：首次显式 DB 访问打印一行（现状是每次启动都打）。不抑制。
- **最低 Node 真进程冒烟**（`scripts/traffic/node-floor-smoke.mjs`，tsx 执行；加进 CI `web-min-node` job 一步，Node 22.12.0）：① traffic off：import `src/index.ts` 并以 fake pi 激活主/子各一次 ⇒ stderr 无 `SQLite` 字样、无 `traffic` 全局符号；② traffic on + `/record on` ⇒ 只得到本功能的版本错误，其它命令/钩子注册不受影响。迁来的 `db.test` 等直接 require sqlite 的测试**不**在 22.12 运行。≥22.13 的首次 DB 访问与重复激活由 `npm test`（最新 22）覆盖。

### 3.2 热路径与锁（Major 9；r3 裁定 R1-9）

同步 SQLite 与 provider 续体共用一个线程：把写挪进 microtask/定时器不等于不阻塞，只要一次同步执行在等锁或做大量工作，provider 的连接/发送回调就被推迟。r3 规定**每 tick 工作预算**，并以硬验收门决定是否切 worker。

**同线程实现（默认，`db-port.ts` 的 `InThreadDbPort`）**：

- `PRAGMA busy_timeout = 0`：任何语句遇锁**立即**返回 `SQLITE_BUSY`，绝不在主线程等锁（去掉 r2 的 50ms busy wait）。
- **写后账本**：钩子与 fetch 层只把记录意图推入 engine 内存账本（按票据合并：请求行、线级头、状态、改写结果、chunk 批），provider 请求从不等待 DB。
- **flush tick**：由 unref 的 `setImmediate` 调度（不用 `queueMicrotask`，保证 provider 已排队的微任务与 I/O 回调先跑）。每个 tick：`BEGIN IMMEDIATE` 一次（BUSY ⇒ 立即放弃本 tick）→ 依次执行账本条目，**每条执行后检查 `performance.now()` 预算 2ms，超出即提交并让出**，下个 tick 继续 → `COMMIT`。单 tick 最多 1 次 BUSY 尝试；BUSY 后不再在本 tick 重试，改 unref `setTimeout` 退避（10→20→40…→500ms）。
- **大条目**：单条 payload > 256 KiB 时独占一个 tick（之前先提交已累积的小条目）；单条执行时间本身不可再切分，计入 `maxStmtMs` 统计，硬门以此为观测对象。
- **读也受预算**：`/api/*` 历史查询按 id 范围分页（≤200 行/次）；`/api/export` 以 ≤200 行一批、每批后 `setImmediate` 让出的方式流式输出；不允许单次全表同步读。
- 有界：账本 ≤512 条 / ≤8 MiB，溢出按 FIFO 丢最旧并计数 `droppedRows`；流 chunk 在账本内按 250ms/64 块合并。
- 可见：`/record status`、`/api/state`、HUD（`rec·drop N`）显示 `droppedRows`、`busyBackoffs`、`maxStmtMs`。SSE 广播在行实际落库拿到 rowid 后发出。

**T2b 硬验收门**（`tests/traffic/db-contention.test.ts`，CI 跑；另在真机 V11 复测）：

| 场景                                                                  | 门槛                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 第二连接 `BEGIN IMMEDIATE` 持写锁 3s，期间 50 个请求（payload 1 MiB） | provider 发送时刻相对无录制基线的增量 p99 ≤10ms；事件循环心跳最大间隔 ≤80ms；取消延迟 ≤80ms |
| 无持锁，同样负载 + 同时打开历史页并导出                               | 同上三项门槛                                                                                |
| 锁释放后                                                              | 账本 ≤5s 落库完成，无行错位，`droppedRows` 与注入一致                                       |

**达不到即切 worker 分支（`db-worker.ts`，条件项 +1.5 人日）**：

- 接口：`persist.ts` 只依赖 `DbPort { enqueue(op: WriteOp): void; query(q: ReadQuery, deadlineMs: number): Promise<Rows>; close(deadlineMs: number): Promise<void>; stats(): DbStats }`；同线程与 worker 两个实现可互换，选择在 engine 创建时一次决定（常量，非设置项）。
- worker：`new Worker(...)` 后立即 `unref()`；worker 内独占 `DatabaseSync`，可使用 `busy_timeout=5000`（不阻塞主线程）；写操作经 `postMessage`，大正文以 UTF-8 `ArrayBuffer` transfer；回执 `{opId, rowId}` 用于 SSE；读查询带截止时间。
- 安全：secure/纪元复查在主线程 `persist` 闸口完成后才 post；op 携带纪元，engine 关闭时 worker 丢弃旧纪元的待写 op。
- 失败处置：worker 启动失败/崩溃/超时 ⇒ engine 记 `dbError`、notify 一次、`/record status` 高亮；**不回退到会阻塞主线程的同线程等锁模式**；账本继续有界缓冲，溢出丢弃计数；最多自动重启 3 次（退避 1s/5s/30s），之后需 `/record off` 再 `/record on`。`close` 先发关闭消息，1s 内未退出则 `terminate()`，不等待。
- 切换后 §3.2 硬门同样适用（以主线程测量）。

### 3.3 路径与旧目录（Major 11 / Minor 14）

- 路径算法与源一致：`join(homedir(), ".pi", "agent", "records", "traffic.db")`，**不**改成 `getAgentDir()`（目录标准化不混入本次合并）。测试一律注入路径；新增用例：设置非默认 `PI_CODING_AGENT_DIR` 时仍打开 `homedir` 下的库，历史、规则、计数可读。
- 删除 `migrateLegacyRecordDir` 的自动 rename。改为打开前检测：
  - `records/traffic.db` 不存在而 `dumps/traffic.db` 存在 ⇒ **拒绝**并给人工步骤（关闭所有 pi → `sqlite3 dumps/traffic.db "PRAGMA wal_checkpoint(TRUNCATE)"` → 确认无 `-wal` → 移动主库）；不创建空库。
  - `records/traffic.db` 存在且 `dumps/` 下仍有 `traffic.db` 或非空 `-wal` ⇒ **半迁移状态**，拒绝打开并提示人工合并；不静默打开缺 WAL 的库。
  - 两者皆无 ⇒ 正常新建。
- 用例：每一步失败/中断的目录状态组合、旧进程仍持有 `dumps` 库时的拒绝文案。schema 完全不变。

---

## 4. 网页（问题 3）

### 4.1 第一期：独立服务 + 加固（T4；Major 7/8）

| 项       | r2 规定                                                                                                                                                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模式     | **硬规则**（`mode.ts`）：仅主会话且 `ctx.mode ∈ {tui, rpc}` 时 `/record on` 启动服务；print/json 模式不启动、`/api/replay` 不存在；子会话不注册命令、不建服务、engine 无子会话侧重放入口。`engine.replay()` 在非允许模式下抛 `E_REPLAY_MODE` 作纵深防御                                                    |
| 绑定     | `traffic.web.host`，默认 `127.0.0.1`                                                                                                                                                                                                                                                                       |
| Host     | 鉴权前校验：`127.0.0.1`/`localhost`/`[::1]`（LAN 绑定时加本机各网卡 IPv4），均带端口；否则 421（防 DNS rebinding）                                                                                                                                                                                         |
| 反嵌入   | **所有响应**（页面、API、错误页、401/404/421）：`X-Frame-Options: DENY`、`Content-Security-Policy: frame-ancestors 'none'; base-uri 'none'; form-action 'self'`（不限制 script，保留运行时编译 Vue）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`                                    |
| 缓存     | 含 token 的 HTML 与全部 `/api/*`：`Cache-Control: no-store`                                                                                                                                                                                                                                                |
| token    | 页面 `/`：回环免 token，非回环须带；HTML 注入 `<meta name="record-token">` 供 app.js 读取（替换 URL token 透传；`page.test` 同步改断言）。**全部 `/api/*` 要 token**（回环亦然，`x-record-token` 头或 `?token=`）。比较：两侧 SHA-256 摘要后 `timingSafeEqual`（照 `hub/auth.ts:61,167`），空串恒拒        |
| 跨域     | 任何响应不发 `Access-Control-Allow-*`；`OPTIONS` 一律 405；非 GET：`Origin` 存在且 ≠ 本服务 origin（含 `null`）⇒ 403；`Sec-Fetch-Site: cross-site` ⇒ 403；缺元数据时仅凭 token                                                                                                                             |
| 连接记账 | `server.on("connection")` 记入 engine 连接账本，**每个 accepted socket `unref()`**；dispose：`server.close()` + 逐个 `destroy()`（`closeAllConnections()` 兜底），SSE 客户端同时从集合移除                                                                                                                 |
| 重放     | 只能由网页在主会话交互模式触发。每次重放一个 `AbortController` 注册进 `cancel.ts`；**中止的触发事件**：主会话 `session_shutdown`（quit/reload/new/resume/fork）⇒ `engine.close()` ⇒ 取消域全部 `abort()`，`reader.cancel()` 只触发**不等待**；另设截止作二级上界（响应头 60s、读流空闲 120s、总长 30 min） |
| 页面组装 | 首个 `GET /` 懒加载并缓存；资源目录候选：模块同级 `web/` → 包根 `src/traffic/web/`                                                                                                                                                                                                                         |
| LAN 提示 | `host=0.0.0.0` 时 status/notify 明示明文 HTTP 风险；Host 白名单与 token 不替代传输加密                                                                                                                                                                                                                     |

验收（`tests/traffic/server-hardening.test.ts`）：坏 Host 421；回环无 token `/api/*` 401；页面与 401/404 均带 XFO/CSP/no-store/no-referrer/nosniff；无 ACAO；OPTIONS 405；同站不同端口 Origin、`Origin: null`、`Sec-Fetch-Site: cross-site` 的 POST 403；变长 token 不抛错。

真子进程退出（`tests/integration/traffic-lifecycle-process.test.ts`）：子进程以 tui/rpc 等价配置启动 engine+服务；父进程挂一个 SSE 连接；经 `/api/replay` 发起重放到「永不回响应头」和「回头后永不结束流」两个本地上游（**有活动出站请求**）；分别触发 quit（`session_shutdown` reason=quit 后让事件循环自然退出）与 reload（`session_shutdown` reason=reload 后重新创建 engine）⇒ 均在 3s 内完成，上游观察到连接被中止，进程无残留 handle。print 等价配置单列（`tests/traffic/mode-gate.test.ts`）：`/record on` 不产生 listener，`/api/replay` 不可达，`engine.replay()` 抛 `E_REPLAY_MODE`，进程在录制若干请求后正常退出。

### 4.2 第二期（拍板③：暂不做）：并入 web-hub

需要：app.js 移植 SFC（hub CSP 禁止运行时编译）；hub 侧只读查询子进程（db-child 先例，有界分页）；重放与规则 CRUD 的跨进程写协议；实时帧；cap `traffic.v1`、LAN 同宽、privacy lock、审计。约 6–8 人日。第一期的 §4.1 安全与释放能力**不随之推迟**。

### 4.3 前端工具链

- 不新增 devDeps（toolkit 已有 `vue ^3.5.43`、`happy-dom ^20`）。vendor 保留 3.5.42 原字节（拍板⑧）；`tests/traffic/vendor.test.ts` 断言文件头版本与 sha256 等于 `VENDOR.json`；刷新走 `scripts/traffic/vendor-vue.mjs`（手动）。
- `app.js` 不进 tsc，过 prettier；`.prettierignore` 加 `src/traffic/web/vendor/`。
- 许可：`THIRD_PARTY_NOTICES.md` 由 UI 构建生成、受 `check:web` 校验，不手改；Vue MIT 全文放 `web/vendor/LICENSE`，README 注明。

---

## 5. 进程模型与请求身份（T2a/T2b；Blocker 1、Major 3/4/5）

### 5.1 为什么不能原样搬

见 §1 事实 4–5：fetch 串层与非 LIFO 卸载、跨会话误认领与误改写、单槽 headers 缓存。合并后子会话大量加载同一份代码，问题放大。

### 5.2 进程容器、engine 生命周期与 trampoline（Major 3）

```ts
interface TrafficGlobal {
  v: 1;
  epochSeq: number; // 单调纪元发号器
  tap?: TapRecord; // 每进程一个
  engine?: TrafficEngine; // 主会话持有
}
interface TrafficEngine {
  readonly epoch: number;
  readonly owner: object; // 主会话激活身份（与 claim.token 同一对象）
  state: "open" | "closing" | "closed";
  recording: boolean;
  /* 票据台账、写后账本、连接账本、取消域、jq 子进程集与 exit 监听、计数器 …（原各模块级变量全部收入） */
}
```

- **容器创建**：只在首次显式 DB 访问 / `/record on` 时创建；`traffic.enabled=false`、子会话、`keepalive-port` 的只读查询**都不创建**容器（查询时容器不存在即返回「未启用」常量）。
- **engine 认领**：`acquireEngine(owner)`：`g.engine` 不存在 ⇒ 新建（`epoch = ++epochSeq`）；存在且 `owner` 相同 ⇒ 复用；存在且 owner 不同 ⇒ 视为陈旧（上一激活未正常 shutdown），先对其执行 `close()` 再新建。`releaseEngine(owner, engine)` 只在 `g.engine === engine && engine.owner === owner` 时清空。
- **关闭**：`close()` 同步进入 `closing`：`recording=false`、撤销接纳（新钩子/新 fetch 立即透传）、中止取消域、销毁连接、kill jq 子进程并移除 exit 监听，然后异步（有界 1s）关库，进入 `closed`。
- **异步续体固定 engine**：每个钩子、fetch、重放、流捕获在**入口**取一次 engine 引用并一路传参；**禁止 await 之后再读 `g.engine`**（lint 级约定 + 测试）。每个落库点经 `persist(engine, …)` 复查 `engine.state==="open" && engine.epoch===capturedEpoch && !isSecure()`（§6），失败即丢弃。故 reload 后旧续体既不能写新库，也不能复活录制（拍板⑤的语义延伸）。
- **trampoline（r3 裁定 R1-3）**：

  - **每次安装新建 wrapper 闭包**：`install()` 执行 `const next = globalThis.fetch; const w = makeWrapper({ id: ++seq, next }); globalThis.fetch = w;`。`next` 是**安装时捕获、不可变**的下游；不存在共享的可变 `orig`。`TapRecord = { activeId, active?: { id, wrapper, next }, nativeFetch, installs: 环形记录≤8 }`，`nativeFetch` 是进程内**第一次**安装时看到的 `globalThis.fetch`。
  - **活动性只看身份**：wrapper 体 `if (record.activeId !== myId || retired) return next(stripTicket(input, init));`——非活动的 wrapper（含旧模块实例留下的）永远只剥票据后透传给自己的固定下游，不录不改写。
  - **退役**：engine 关闭时，若 `globalThis.fetch === active.wrapper` ⇒ `globalThis.fetch = active.next`；无论是否最外层，`active` 都退役（`retired=true`、`activeId` 清空）。不再有「retained 后复用」的路径。
  - **重装**：下次 `/record on` 一律走 `install()` 新建 w′，`next = 当前 globalThis.fetch`。
  - **重入守卫**：wrapper 调用下游时用进程级 `AsyncLocalStorage` 标记 `als.run(myId, () => next(...))`；入口若发现 `als.getStore() === myId`（同一 wrapper 被自己的下游同步或异步再次调用）⇒ 不再调用 `next`，改调 `nativeFetch`，计数 `tapReentry` 并记日志一次（`/record status` 可见）。这样即使第三方的下游以延迟绑定方式再次读到 `globalThis.fetch`，也只多一跳即终止，且不会二次录制。
  - **转换规则表**：

    | 当前                                         | 事件                                                             | 结果                                                                                                                                           |
    | -------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
    | 无活动 wrapper                               | `/record on`                                                     | 新建 w(next=当前全局) 并设为全局；activeId=w.id                                                                                                |
    | 活动 w 且全局 === w                          | engine 关闭                                                      | 全局还原为 w.next；w 退役                                                                                                                      |
    | 活动 w 且全局 ≠ w（被第三方包住）            | engine 关闭                                                      | 全局不动；w 退役为纯透传（仍在第三方链中，只剥票据）                                                                                           |
    | w 已退役，第三方把**持有旧 w** 的 F 挂回全局 | `/record on`                                                     | 新建 w′(next=F)；链为 w′ → F → w(退役，透传) → w.next；只有 w′ 录制，无环                                                                      |
    | 任意                                         | 下游再次调用到同一活动 w（延迟绑定环）                           | 重入守卫：改走 `nativeFetch`，计数 + 日志，不二次录制                                                                                          |
    | 任意                                         | 发现 `after_provider_response` 已到而活动 w 从未见到该请求的票据 | 判定活动 w 已被第三方丢出链：停止铸票据、engine `recording=false`、notify 一次、`/record status` 显示 `tap lost`；需用户 `/record on` 重新安装 |

- 用例（`tests/traffic/engine.test.ts`、`tap.test.ts`）：`/record on` 进行中跨 reload；重放与流捕获跨 reload；第三方 wrapper 包在外层后 reload 再 `/record on`（新 wrapper 录制一次、旧 wrapper 透传）；**第三方重新挂回持有旧 wrapper 的函数 F 后 `/record on`**（断言 w′→F→w→N 各调用一次、只一行记录、F 收到的请求已无票据头、无递归）；延迟绑定环（重入守卫生效、请求成功、`tapReentry=1`）；旧激活的 shutdown 晚于新激活的 acquire（不清新实例）；reload 后关闭 traffic（engine/claim/tap 均无残留，fetch 还原或 retained 透传）；陈旧续体 await 后写入被丢弃、不重开旧库。

### 5.3 票据身份（Blocker 1）

**铸造**（`before_provider_headers`，主/子会话，同一 runner 闭包内）：仅当入口 engine `open && recording`、claim 属 toolkit、非 secure、且 `ctx.model.api` 在**票据白名单**（首批 `anthropic-messages`、`openai-completions`、`openai-responses`；扩充须 conformance 证明 SDK 把 `options.headers` 带到 globalThis.fetch 且剥离后 provider 收不到）时，铸 128-bit 随机票据 T，`headers["x-pi-traffic-ticket"] = T`，台账登记 `{T, sessionId, epoch, mintedAt, headersSnapshot(不含票据), state:"open"}`；T 加入本 runner 的存活集合 `L`（见下）。

**配对**（`before_provider_request`；r3 裁定 R1-1：只在可证明时绑定）：

pi 的 payload 事件不携带 headers，也没有共同请求 ID，因此「headers 票据 ↔ payload」只能由**存活票据集合**证明。每个 runner 闭包维护存活集合 `L`（本 runner 铸造、未退役、同纪元的票据）。

- **绑定判据**：payload 到达时 `L` 恰为 `{T}` ⇒ 绑定到 T；否则（`|L| = 0` 或 `|L| ≥ 2`）⇒ **不绑定任何票据**：本 payload 写一条 hook 级行，`rewrite_status='unattributed'`；它的 fetch 不会被任何票据规则改写（见 fetch 表），按原样发出；计数 `unattributedPayloads`。**绝不**按「唯一未配对票据」认领。
- **payload generation**：T 首次绑定 ⇒ generation 1；之后若 `L={T}` 且 T 最近一次 fetch 结果为非成功（strict-tools 回退的 400 等）时又来一个 payload ⇒ generation +1，新 payload 取代该票据的 pending 正文，**旧 generation 的改写缓存与正文摘要绑定全部作废**。
- **退役规则**（证明的可靠性来源；每条都保证被退役的票据不会再产生 payload）：
  1. T 的某次 fetch 收到 2xx/3xx 响应头 ⇒ 立即退役（pi-ai 只在 400 拒绝时才会对同一请求再次调用 `onPayload`，已开始的流不会回退）；
  2. 本 runner 收到 assistant 角色的 `message_end` ⇒ 退役本 runner 所有**非成功**票据，**前提**是本 runner 在最近 60s 内没有放行过 cache warming（`cache_warming_decision` 结果为发送）；改写规则启用时 warming 恒被 stop，此前提恒成立；
  3. 未绑定的票据铸造后 30s、非成功票据最后一次 fetch 结束后 30s，按 TTL 退役；
  4. engine 关闭 ⇒ 全部退役。
     上述「只有 agent loop、cache warmer、compaction/branch summary 三类调用会触发本 runner 钩子，且只有 400 strict-tools 回退会对同一请求重入 `onPayload`」作为前提，由 conformance（§8.3）按 API 逐条钉住，peer 升级必跑。
- 白名单外 API / 未铸票据（录制在 headers 之后才开启等）⇒ `L` 中无对应票据 ⇒ 只写 hook 级行，不改写。

**fetch 层**（wrapper → `engine.handleFetch`）：

| 情形                                                      | 行为                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无票据头                                                  | 纯透传，不认领、不改写、不录                                                                                                                                     |
| 票据未知/已退役超时/属其他纪元                            | 剥离后透传，计数 `staleTickets`                                                                                                                                  |
| 票据从未绑定（compaction 只触发 headers；或绑定判据失败） | 剥离后透传，不改写，不录线级字段                                                                                                                                 |
| 票据已绑定，当前 generation **尚无正文摘要**              | 计算原始正文摘要（sha256，含解压后正文）并绑定到该 generation；按该 generation 的 pending 执行改写，结果按 `(T, generation, 摘要)` 缓存；录线级字段到该票据的行  |
| 票据已绑定，正文摘要 **等于** 当前 generation 的摘要      | 同 generation 的网络重试：复用缓存的改写结果（字节一致），不重跑 jq                                                                                              |
| 票据已绑定，正文摘要 **不等于** 当前 generation 的摘要    | 说明出现了未被证明的新正文（例如 strict 回退的 payload 因交错未能升 generation）⇒ 剥离后按原样透传，**不改写**，该次 fetch 记为 `unattributed`，不写入该票据的行 |
| 票据已 `blocked`（同 generation、同摘要）                 | 再抛同一错误，不重跑 jq、不放出原请求；同一 (会话, 规则集, 错误) 30s 内只通知一次                                                                                |

**hook 级行的响应回填**：`after_provider_response` 不带请求身份。票据请求的状态与响应头由 fetch 层直接从 `Response` 写入（精确）；hook 级行（白名单外 API、unattributed）只在本 runner **恰有一条**等待响应的 hook 级行、且没有存活票据时才回填，否则留空并计数 `unattributedResponses`。不用单一「当前行」冒充并发关联。

**台账回收**（与「退役」分开：退役只表示不再参与 `L` 的绑定判据；台账删除才表示 fetch 层不再识别该票据头）：未绑定 30s、已绑定未 fetch 120s、已 fetch 的保留至「响应结束 + 60s」以容纳 SDK 重试，硬上限 10 min；总量 ≤1024 条 FIFO。均由 unref 定时器/惰性扫描完成。

**闸门退役**：精确身份不再依赖全局串行，`serialize.ts`（单 holder、waiter、handoff/maxHold/queueWait/retryGrace、poison）不迁入；无 waiter 即无「取消后仍在队列」问题（Major 4 的第二半）。`rewrite_settings` 中 `serialize_*` 四键保留不读，status/UI 标注「已停用（r2 票据归属）」（需用户复核 R-a）。

**故障矩阵**（`tests/traffic/ticket.test.ts` + `tests/traffic/attribution-matrix.test.ts`）：

- **评审交错**：A 绑定 TA 并发送 → 400 → B 的 headers 铸 TB → A strict 回退的 payload 到达 ⇒ 断言该 payload **不绑定 TB**、记 `unattributed`；A 的回退 fetch（携 TA、正文摘要 ≠ generation 1）按原样透传、不改写、不写 TA 的行；B 随后的 payload（`L={TA,TB}`）同样 `unattributed`；stub 侧断言回退正文与首发正文**确实不同**（strict tools 已去除）且未被改写。
- **无交错的 strict 回退**：A 400 → 回退 payload（`L={TA}`）⇒ generation 2；stub 收到的是**对新正文**重新改写后的字节，而非 generation 1 改写结果的重放。
- **同 generation 网络重试**：529 后重试 ⇒ 字节一致、jq 只跑一次。
- **hook 级响应回填**：两条并发 hook 级行 ⇒ 均不回填，`unattributedResponses=2`。
- 其余：主/子会话同 origin 交错（正文与凭证不同）；长退避 SDK 重试；streaming warming 与真实请求交错；compaction 只 headers；票据过期后迟到 fetch；reload 后旧纪元票据；第三方丢弃 wrapper；白名单外 API；无票据的 keepalive/quota/title/topic 风格请求 ⇒ 断言：每个线级记录只落到发起它的请求行；规则只作用于可证明归属的请求；无票据/无法证明的请求字节不变。

### 5.4 子会话清理与内部请求接入矩阵（Major 4/5）

- 子会话无 `session_shutdown`。票据与 pending 都在**每次激活的 runner 闭包 + engine 台账（按会话）**里：子会话 `agent_settled` ⇒ 丢弃该会话未配对/未 fetch 票据与 turn 记录；兜底为 §5.3 的 TTL 回收与 engine 关闭。无排队、无 holder，故不需要 AbortSignal 打断等待；流捕获使用 engine 取消域。主栈 `onReaped` **不**新增接线（无可泄漏的长持资源；TTL 有界），在 §13 记残留评估。
- 内部请求接入矩阵（结论：未知请求一律不靠 holder 推断，结构上无票据即透传）：

| 请求来源                                                             | 触发钩子                    | 票据   | 录制                                  | 改写                     |
| -------------------------------------------------------------------- | --------------------------- | ------ | ------------------------------------- | ------------------------ |
| 主/子会话 agent loop（含 consult fork、verifier、workflow 子 agent） | headers + payload           | 有     | 是（子会话受 `childSessions`）        | 是                       |
| pi 原生 cache warmer                                                 | headers + payload           | 有     | 是（可证明时绑定，否则 unattributed） | 规则启用时被否决（§7.3） |
| pi compaction / branch summary                                       | 仅 headers                  | 未配对 | 否                                    | 否                       |
| title（`modelRegistry.complete`）                                    | 无                          | 无     | 否                                    | 否                       |
| topic judge（`streamSimple`/`complete`）                             | 无                          | 无     | 否                                    | 否                       |
| keepalive pipeline ping / measure / probe                            | 无（自带 transformHeaders） | 无     | 否（拍板⑥）                           | 否                       |
| quota、ping-client、web_search、feishu、hub                          | 无（裸 fetch）              | 无     | 否（拍板⑥）                           | 否                       |

拍板⑥因此无需改动 cache-ttl/quota 代码即成立；`tests/traffic/internal-requests.test.ts` 以真实调用路径（fake runtime）逐行断言。

---

## 6. 加密会话（问题 4；Major 10）

- `src/traffic/secure.ts`：`isSecure() = process.env.PI_SECURE_SESSION === "1" || (getSecureDomain()?.kind ?? "plain") !== "plain"`，`getSecureDomain` **直接 import** 自 `src/secure/domain.ts`（工作区已有，secure P2 开发中未提交）。不再自行读 symbol。`getSecureDomain()` 在 `initSecureDomain()`（`src/index.ts:163`，activate 开头）之后才有值；hub 进程/单测中为 `undefined` ⇒ 视为 plain，env 判定照常。**依赖**：T3 在 secure P2 提交之后合入（若 P2 延后，T3 等待；不复制一份临时实现）。
- **唯一落库闸口** `persist(engine, epoch, op)`：每次 `stmt.run()`/事务提交**之前**同步复查 `!isSecure() && engine.state==="open" && engine.epoch===epoch`；任一失败 ⇒ 丢弃该写并（secure 时）把 engine 推入 `closing`。不保留跨 await 的 DB/statement 引用：await 返回后一律经 `persist` 重新取连接。
- 判定点：命令入口、全部钩子入口、票据铸造、wrapper 入口、`persist`、流捕获**每批**（命中即 `reader.cancel()` 不等待、停止旁路读取）、重放（读请求体后、jq 后、上游返回后、写行前各一次）。
- 设置覆盖：在 `src/config/settings.ts` 的 `applySecureDomainOverrides`（两个加载入口的共同出口）里 secure/locked 分支加 `traffic: { ...settings.traffic, enabled: false }`（克隆，不改 `DEFAULT_SETTINGS`）；**两个加载入口**（`readSettingsNoMigrate` / `loadSettingsFromFile`）各一条测试；由 T3 负责（P2 已提交后）。
- 用例（`tests/traffic/secure.test.ts` 扩充）：慢流中途设 env / 改 locked ⇒ 之后零新增行、零新增 chunk；慢重放跨切换 ⇒ 零写入；静态 env/symbol 两源；locked 禁用；每次现场判定。
- D5 回写（T7 追加修订段到 data-encryption plan）：P1 `helper.mjs` 与 `/secure status` 的检测改为「toolkit 内置 traffic 天然遵守；packages 仍有外部 pi-traffic-record ⇒ 警告重复加载并检查其 `piSecure`」。toolkit `package.json` 增 `"piSecure": { "honors": "PI_SECURE_SESSION/1" }`。

---

## 7. 冻结面与钩子共存（问题 5）

1. **off ⇒ 零**：不调用 wire 函数；模块无顶层副作用（sqlite/page/jq exit 监听均惰性，jq 的 exit 监听在首次 spawn 时登记、engine 关闭时移除，进程内唯一）。`tests/integration/traffic-wiring.test.ts` 断言：import + 主激活 + 3 个子激活 + 调用 quota/keepalive-port 查询后——各事件 handler 数与基线一致；`globalThis.fetch` 引用不变；`traffic`/`claim`/`external-active` 符号均不存在；`process.listenerCount("exit")` 不变；records 目录零访问（fs spy）；注入的 `loadSqlite` 未调用。
2. 三份 off golden（`fabric-xs-off`/`fabric-wake-off`/`fabric-xs-reply-off`）与 `tests/fixtures/legacy-xs-v071/` 不涉及、禁止 regenerate；settings/setting-specs 快照因新增键预期更新。
3. **cache-ttl 共存**（Major 6）：
   - traffic `before_provider_request` 恒返回 `undefined`；主会话注册在 cache-ttl 之后。零规则时线上字节不变（consult preserve C1–C7 不受影响）。
   - `keepalive-port.ts`（纯读，容器不存在即「未启用」）：`rewriteArmed()` = engine open ∧ recording ∧ 存在启用规则；`vetoCapture(sessionId, capturedAt)` = 该会话 `lastRewrittenAt ≥ capturedAt`，或 `rewriteArmed()`。主会话 `src/service/cache-keepalive.ts` 的发送闸门、子会话 `src/cache-ttl/child.ts` 的发送闸门各加一行：否决时跳过本次 ping，原因 `traffic-rewrite`（HUD `ping off:traffic-rewrite`）。capture 发生在 traffic 改写之前，故「已改写请求之前的 capture」必被否决；规则关闭后下一次未改写的真实请求重建 capture 即自愈。
   - pi 原生 cache warming：traffic 注册 `cache_warming_decision`，`rewriteArmed()` 时返回 `{ action: "stop" }`（歧义路径下 warmer 可能未被改写而写错前缀）。
   - 用例（`tests/integration/traffic-keepalive.test.ts`，主/子会话各一）：规则改写 messages ⇒ 真实流结束后原 capture 的 ping **不发送**；规则关闭 + 一次真实请求后恢复；warming 在规则启用时被 stop。
4. **web 命令策略**：`PI_TOOLKIT_TABLE.record`：无参/`status`/`off` ⇒ allow；`on` ⇒ **confirm**（拍板⑦）；其它 ⇒ deny。真实命令桥用例：web `/record on` 触发 `E_CONFIRM_REQUIRED`，确认后执行。飞书 prompt 路径 `expandPromptTemplates:false`，不构成执行面。
5. **HUD**：录制中 `setStatus("traffic", "rec")`，有丢弃时 `rec·drop N`；停止清除。

---

## 8. 测试（问题 6）

### 8.1 迁移

- 13 个文件 → `tests/traffic/`，改导入路径、过 prettier。**T1**：测试内容不变，全绿（基线对照）。**T2a/T2b**：改为 `createTrafficEngine({ dbPath, loadSqlite?, now? })` 构造；`serialize.test.ts` 删除，其 poison/重试语义改写进 `ticket.test.ts`；`correlate.test.ts` 中依赖 holder 推断的用例改为断言「不再推断」。
- 依赖真 jq 的用例保留 `skipIf(!existsSync("/usr/bin/jq"))`（ubuntu-latest 自带 jq）。

### 8.2 新增（共 13 组）

| #   | 文件                                                                  | 内容                                                                                                                |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | `tests/integration/traffic-wiring.test.ts`                            | §7.1 off 零面；host/child 注册面；主会话 payload handler 在 cache-ttl 之后；secure ⇒ 零注册                         |
| 2   | `tests/integration/traffic-coexist.test.ts`                           | §2.4 认领矩阵（fake 加载器 + 外部旧版/墓碑版 fixture 模块），活动录制器=1                                           |
| 3   | `tests/traffic/engine.test.ts`                                        | owner/epoch、acquire/release、close 撤销接纳、陈旧续体写入被丢弃                                                    |
| 4   | `tests/traffic/tap.test.ts`                                           | §5.2 转换规则表逐行；每次安装新闭包、旧 wrapper 退役透传；重挂持有旧 wrapper 的 F；重入守卫；tap lost；票据头恒剥离 |
| 5   | `tests/traffic/ticket.test.ts`                                        | 铸造/配对/歧义/替换/回收/blocked 重抛与通知去重                                                                     |
| 6   | `tests/traffic/attribution-matrix.test.ts`                            | §5.3 故障矩阵（含评审交错、generation、同 generation 重试、hook 级回填并发）                                        |
| 7   | `tests/traffic/internal-requests.test.ts`                             | §5.4 接入矩阵逐行                                                                                                   |
| 8   | `tests/traffic/db-contention.test.ts`                                 | §3.2 硬验收门：持锁/无持锁+读导出下的发送延迟增量、心跳、取消延迟；账本落库与丢弃计数                               |
| 9   | `tests/traffic/server-hardening.test.ts`                              | §4.1 安全头、Host、token、跨域、OPTIONS                                                                             |
| 10  | `tests/integration/traffic-lifecycle-process.test.ts`                 | §4.1 真子进程：SSE 挂起 + 活动出站重放（上游不回/不结束）下 quit/reload 由 `session_shutdown` 触发中止              |
| 11  | `tests/integration/traffic-keepalive.test.ts`                         | §7.3 主/子会话 keepalive 否决与 warming stop                                                                        |
| 12  | `tests/traffic/{secure,db-path,legacy-dir,dup-detect,vendor}.test.ts` | §6 异步切点；§3.3 路径与旧目录状态组合；扫描与 getCommands 判定；vendor 锁定                                        |
| 13  | `tests/traffic/mode-gate.test.ts`                                     | §4.1 模式硬规则：print/json 无 listener、无重放入口、`E_REPLAY_MODE`；子会话无命令/服务/重放                        |

### 8.3 conformance（T6，进入 peer 升级闸门）

- `tests/conformance/traffic.test.ts`（真 pi `AgentSession` + 本地 Anthropic/OpenAI 兼容 stub，复用 consult-preserve 夹具模式）：钩子事件形状与顺序（headers → payload → fetch → response）；票据头经 SDK 到达 fetch、stub **从未收到**票据头（白名单逐 API）；traffic 录到 cache-ttl `mode=on` 改写后的 payload；cache warmer 触发两钩子；compaction 只触发 headers；子会话请求以子会话 id 落库。
- `tests/conformance/traffic-coexist.test.ts`：真 pi 资源加载器 + 临时 settings（toolkit 与外部 fixture 包，两种顺序、项目级过滤），断言活动录制器=1。
- **钉住 §5.3 退役规则的前提**（按白名单 API 逐条）：会话 runner 的 `before_provider_request` 只由 agent loop 与 cache warmer 触发、compaction/branch summary 只触发 headers；同一请求只有 400 strict-tools 回退会再次触发 `onPayload`；2xx 响应头之后不再有 `onPayload`。任一条在新 pi 版本不成立 ⇒ conformance 失败，阻止 peer 升级。
- Codex（`openai-codex-responses`）是否入白名单由本组的 SSE/WS 两条用例决定（R-b）。AGENTS.md 的 peer 升级清单加入两文件。

### 8.4 CI 时长

迁入 ~160 例（独立 1.4s）+ 新增约 120 例；持锁/真子进程用例各 ≤5s 且并入 fork 池。toolkit 全量约 210s，预计增量 <3%；T7 以实测回填，若 >5% 把 #8/#10 标记 `slow` 组仍在 CI 跑。conformance 不进 `npm test`。CI 另增 `web-min-node` 的 node-floor 冒烟一步（§3.1，<10s）。

---

## 9. 原仓库后续处置（问题 7；拍板④）

1. **T0（现在）**：在原仓库提交工作区加密适配（`src/secure.ts`、`src/__tests__/secure.test.ts`、`capture/db/index.ts`、`package.json` 的 `piSecure`），版本 `0.2.1`，`fix(secure): honor PI_SECURE_SESSION/1`。push 与 GitHub release 需用户授权。T1 依赖的是**该提交的 SHA**（源树基线），不依赖 push/发布成功。
2. **T8（toolkit 发版后）**：墓碑版 `0.3.0` 实现 §2.4 外部侧协议（有效 toolkit claim ⇒ 让位；否则活动并发布 `external-active`，shutdown 身份校验删除，每次 session_start 弃用提示）；README 顶部「已并入 pi-toolkit（`traffic.enabled`），本仓库归档」+ 迁移步骤；GitHub archived（需用户操作/授权）。
3. 原仓库 `docs/dev/{page-vue,traffic-rewrite}` 原样拷入 `docs/dev/traffic/`。外部仓库无 LICENSE 文件（package.json 为 MIT，作者即用户），toolkit MIT，文件头加来源注释。

---

## 10. 分包与估时（问题 8）

**写域以本表为唯一清单**；T3 只做代码装配，文档全部归 T7。

| 包                | 内容                                                                                                                                                                                                                                                             | 文件域                                                                                                                                                                                 | 依赖                      | 估时  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ----- |
| **T0**            | 原仓库提交加密适配（v0.2.1）                                                                                                                                                                                                                                     | `~/ai/pi-traffic-record`                                                                                                                                                               | —                         | 0.1d  |
| **T1**            | 原样搬迁（**不接线**）：源迁 `src/traffic/`、prettier、修 4 个严格错误、web 资源与 VENDOR.json/LICENSE、`.prettierignore`、13 测试迁移全绿                                                                                                                       | `src/traffic/**`、`tests/traffic/**`、`.prettierignore`、`scripts/traffic/vendor-vue.mjs`                                                                                              | T0 SHA                    | 1.0d  |
| **T2a**           | 进程容器/engine owner+epoch/close 语义、trampoline（每次安装新闭包、退役、重入守卫、tap lost）、取消域与连接账本、模式门禁 `mode.ts`、惰性 sqlite/page/jq-exit、`persist` 闸口与 secure 复查、固定路径与旧目录检测、#3/#4/#10/#12(secure,db-path,legacy-dir)/#13 | `src/traffic/**`、`tests/traffic/**`、`tests/integration/traffic-lifecycle-process.test.ts`                                                                                            | T1                        | 1.5d  |
| **T2b**           | 票据铸造/可证明配对/generation/退役规则/台账、fetch 层改造、闸门退役、写后账本与每 tick 预算、`DbPort` 同线程实现、#5/#6/#7/#8 与 **§3.2 硬验收门**                                                                                                              | `src/traffic/**`、`tests/traffic/**`                                                                                                                                                   | T2a                       | 2.25d |
| **T2c**（条件项） | 仅当 T2b 硬验收门不达标：`db-worker.ts`（`DbPort` 的 worker 实现、失败处置）+ 用同一硬门复测                                                                                                                                                                     | `src/traffic/{db-worker,db-port,persist}.ts`、`tests/traffic/db-*.test.ts`                                                                                                             | T2b 门失败                | +1.5d |
| **T3**            | 装配：settings 组与 specs、`applySecureDomainOverrides` 加 traffic 行、两处 wire 调用、认领协议与 dup-detect、`isSecure` 接 `getSecureDomain`、`record` 入 command-policy、HUD status、`piSecure` 字段、#1/#2                                                    | `src/index.ts`、`src/config/{settings,setting-specs}.ts`、`src/web-hub/agent/command-policy.ts`、`src/traffic/{index,claim,dup-detect,secure}.ts`、`package.json`、对应测试            | T2b、**secure P2 已提交** | 1.0d  |
| **T4**            | 服务加固（§4.1）+ #9                                                                                                                                                                                                                                             | `src/traffic/{server,page}.ts`、`src/traffic/web/app.js`、对应测试                                                                                                                     | T2a                       | 0.75d |
| **T5**            | keepalive/warming 共存（§7.3）+ #11                                                                                                                                                                                                                              | `src/traffic/keepalive-port.ts`、`src/traffic/warming.ts`、`src/service/cache-keepalive.ts`（发送闸门一行）、`src/cache-ttl/child.ts`（一行）、对应测试；T3 调用 `registerWarmingVeto` | T2b                       | 0.5d  |
| **T6**            | conformance 两文件（§8.3），决定 Codex 白名单                                                                                                                                                                                                                    | `tests/conformance/traffic*.test.ts`                                                                                                                                                   | T3、T5                    | 1.0d  |
| **T7**            | 文档与验收：AGENTS.md（absorbs eight、layout、peer 闸门清单）、README（功能/命令/配置/迁移/拍板①的数据范围说明/LAN 风险）、data-encryption 修订段、CI node-floor 步骤、§11 真机验收、CI 时长回填                                                                 | `AGENTS.md`、`README*.md`、`docs/dev/**`、`.github/workflows/ci.yml`、`scripts/traffic/node-floor-smoke.mjs`                                                                           | T3–T6                     | 1.0d  |
| **T8**            | 原仓库墓碑 v0.3.0 与归档                                                                                                                                                                                                                                         | `~/ai/pi-traffic-record`                                                                                                                                                               | toolkit 发版              | 0.1d  |

合计约 **9.2 人日**（不含评审返工与真机等待）；T2c 为条件项 +1.5 人日，只在 T2b 硬验收门失败时启动。并行：T2b 之后 T3/T5 并行；T4 可在 T2a 后与 T2b 并行（`server.ts` 的票据无关）。每包返回立即派 verifier（验收模型 ≠ 开发模型）；T2a、T2b、T4 额外一轮安全向评审。提交切分（patch 发版）：

- `feat(traffic): import pi-traffic-record sources as src/traffic (unwired)`（T1）
- `refactor(traffic): owned process engine and a single fetch trampoline`（T2a）
- `fix(traffic): attribute provider fetches by per-request ticket`（T2b）
- `feat(traffic): gate traffic recording behind traffic.enabled`（T3）
- `fix(traffic): harden the record web server`（T4）
- `fix(cache-ttl): skip keepalive pings for traffic-rewritten prefixes`（T5）
- `test(traffic): conformance against real pi` / `docs(traffic): …`

---

## 11. 真机验收清单（T7，tmux）

1. V1：未设 `traffic.enabled` ⇒ 无 `/record`；records 目录 mtime 不变；`pi -p hi` 正常退出；stderr 无 SQLite 警告。
2. V2：`traffic.enabled=true` 且**保留外部包 v0.2.1** ⇒ toolkit 让位，只一处录制（对比行数增量）；换成墓碑版 v0.3.0 ⇒ 外部让位、toolkit 活动；两种顺序各验一次。
3. V3：移除外部包重启 ⇒ `/record status` 计数一致、历史可浏览、规则仍在。
4. V4：`/record on`，主会话 turn + Agent 子 agent ⇒ 两会话 id 均落库；`childSessions=false` + /reload 后子会话不落库。
5. V5：启用改写规则（`.temperature = 0`），主子会话并行 ⇒ 改写双栏正确、无错位；HUD `rec`；keepalive 显示 `ping off:traffic-rewrite`。
6. V6：重放产生 `origin='replay'` 新记录；导出 JSONL。
7. V7：`curl -H 'Host: evil.test' 127.0.0.1:4177/api/state` ⇒ 421；回环无 token `/api/state` ⇒ 401；浏览器页面正常；用一个本地 HTML 页 iframe 该服务 ⇒ 浏览器拒绝渲染。
8. V8：`/reload` 三次 ⇒ 录制停止、fetch 还原（status 显示 tap 状态）；keepalive/title/topic 请求不在库中。
9. V9：`PI_SECURE_SESSION=1 pi` ⇒ 无 `/record`；库 mtime 不变。
10. V10：web 端 `/record on` 弹 confirm。
11. V11：另开 `sqlite3 traffic.db "BEGIN IMMEDIATE;"` 持锁 10s 期间对话 ⇒ TUI 不卡顿，status 显示退避/丢弃计数，释放后落库补齐。
12. V12：浏览器保持页面打开、一个重放正挂在不回响应的上游时 `/quit` ⇒ 进程 3s 内退出，上游看到连接中止（`session_shutdown` → dispose 中止重放）。
13. V13：`pi -p "/record on"` 与 `pi --mode json` ⇒ 不产生监听端口（`ss -ltnp` 无 4177+），回复注明「print 模式不启动网页服务」；进程正常退出。

---

## 12. 已拍板（用户 2026-10-23，全部按 r1 推荐）

| #   | 决策                                                        | 落点                      |
| --- | ----------------------------------------------------------- | ------------------------- |
| ①   | 默认录子 agent 流量（`traffic.childSessions=true`）         | §2.2、README 数据范围说明 |
| ②   | 网页默认 `127.0.0.1`，LAN 显式 opt-in（`traffic.web.host`） | §2.2、§4.1                |
| ③   | 暂不并入 web-hub（第二期）                                  | §4.2                      |
| ④   | 加密适配先在旧仓库发 v0.2.1，再发让位版并归档               | §9、T0/T8                 |
| ⑤   | `/reload` 与切会话停录（含旧异步工作不得复活录制）          | §5.2                      |
| ⑥   | toolkit 保活/quota 等内部请求不录                           | §5.4 接入矩阵             |
| ⑦   | 命令 `/record`，web 端 `on` 需确认                          | §7.4                      |
| ⑧   | 内置 Vue 3.5.42 原字节                                      | §4.3                      |

无评审意见与拍板冲突；评审对①的前置条件（Blocker 1/Major 4 先解决）已由 §5.3/§5.4 满足。评审驱动的三项行为变化列在 §0「需用户复核」R-a/R-b/R-c。

---

## 13. 风险与残留

1. **票据可达性依赖 SDK**：provider SDK 若在 patch 前捕获 fetch 引用或不用 fetch（Bedrock 自带 HTTP handler、WS 传输），票据请求不经 wrapper ⇒ 走白名单外语义（只录钩子级，不改写）；白名单靠 conformance 维护，peer 升级必跑。
2. **tap lost 窗口**：第三方把活动 wrapper 丢出链后，首个票据请求的随机 nonce 头可能到达 provider（无语义）；随即停止铸票据并停录（§5.2 转换表末行）。
3. **无法证明归属的请求不改写**（R-d）：存活票据集合非单元素时，payload 记 `unattributed` 并按原样发出。常见触发：失败请求的票据未退役期间紧接的 agent 级重试（规则启用时由退役规则 2 在 assistant `message_end` 即退役，窗口很小）、streaming warming 交错（规则启用时 warming 被 stop）。代价是这些请求不受改写规则作用，status 计数可见。
4. **改写不再串行**（R-a）：旧 README 的串行语义取消；同库另一进程若仍跑外部 v0.2.x，它对自己的请求仍串行，互不影响。
5. **钩子顺序**：在 toolkit 之后加载且改写 payload 的第三方扩展，其修改不反映在 `payload` 列（线级字段仍为真实发送）。
6. **DB 丢录与单条大语句**：锁竞争下按 §3.2 有界丢弃并计数；单条大 payload 的执行时间不可切分，由硬验收门度量，超标即走 T2c worker 分支。
7. **重入守卫的副作用**：被判为重入的请求直送平台原生 fetch，会绕过环路中第三方层（例如代理设置层）；只在真实环路时发生，计数 + 日志可见。
8. **ExperimentalWarning**：首次显式 DB 访问打印一行。
9. **未接 `onReaped`**：子会话被 reaper 强杀时，其票据/pending 依赖 TTL 回收（≤10 min、≤1024 条有界），不持有 socket/定时器 ref；若 T2b 测量发现残留可见，再按 `child-registry` 先例接线。
10. **数据敏感**：库含 API key 明文（原设计，录制默认关）；网络面加固不覆盖本机同用户直接读库。
11. **激活开销**：`moduleCache:false` 下每个子会话加载约 4k 行；T7 记录启用前后子会话 activate 耗时差，>20ms 再拆懒加载。

---

## §R1 评审处置表（r1 评审：gpt-6.1-sol，reject，2 Blocker / 9 Major / 3 Minor / 1 Nit）

| 编号 | 严重度  | 问题一句话                                                                          | 处置                                                                                                                                                                                                                                                                                         |
| ---- | ------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Blocker | 全局串行不能证明 fetch 属于当前 slot，降级后仍误认领/误改写；headers 单槽跨会话覆盖 | **已改 §5.3**：每请求票据头（headers 钩子铸造 → payload 钩子同 runner 配对 → fetch 凭票据认领并剥离）；无票据/未配对/歧义一律透传不改写；headers 快照随票据按请求隔离；闸门退役；故障矩阵 §8.2 #6；行为变化列「需用户复核」R-a/R-b （r3 修订：配对改为可证明判据 + generation，见 §R2 R1-1） |
| 2    | Blocker | 双向让位导致双方同时停用；标记无身份校验释放与 reload/off 清理                      | **已改 §2.4**：单向优先级（已证实活动的外部优先），settings 扫描只告警不让位，权威证据为 `external-active` 符号或 `getCommands` 的 `sourceInfo.path`；claim 带 token/pid/`isLive`，身份校验释放，`enabled=false` 永不发布；真实加载矩阵 §8.2 #2、§8.3                                        |
| 3    | Major   | engine 无 owner/epoch 与异步隔离；trampoline 状态转换未闭合                         | **已改 §5.2**：owner 身份 + 单调纪元、`acquire/release` 身份校验、`closing` 同步撤销接纳、续体入口固定 engine 且禁止 await 后重读；trampoline 四态表与复用规则；跨 reload 用例 §8.2 #3/#4 （r3 修订：每次安装新闭包 + 重入守卫，见 §R2 R1-3）                                                |
| 4    | Major   | 子会话不发 `session_shutdown`；`acquireSlot` 无 signal，取消后残留 waiter/holder    | **已改 §5.4/§5.3**：清理改挂 `agent_settled` + 票据 TTL/容量有界回收；闸门退役后不存在 waiter/holder，等待取消问题消失；未接 `onReaped` 的理由与再评估条件见 §13-8                                                                                                                           |
| 5    | Major   | 旁路清单不完整（title/topic judge 等），Q6 不能可选                                 | **已改 §5.4**：结构原则「无票据即透传」覆盖全部非会话请求，给出接入矩阵（含 pi cache warmer、compaction）；拍板⑥由结构保证，不再依赖逐点旁路；ALS 旁路方案撤销                                                                                                                               |
| 6    | Major   | keepalive 捕获改写前 payload，旁路 ping 重放旧前缀产生费用                          | **已改 §7.3**：`keepalive-port` 的 `vetoCapture`（会话 `lastRewrittenAt ≥ capturedAt` 或规则启用即否决），主/子会话发送闸门各一行；规则启用时 stop pi 原生 warming；集成测试 §8.2 #11                                                                                                        |
| 7    | Major   | 回环免 token 页面注入 bearer，可被 iframe 点击劫持                                  | **已改 §4.1**：全部响应 XFO DENY + `frame-ancestors 'none'`、no-store、no-referrer、nosniff；无 ACAO、OPTIONS 405、`Origin:null`/同站异端口拒绝；token 摘要定长比较；用例 §8.2 #9、真机 V7                                                                                                   |
| 8    | Major   | `server.unref()` 不解除 SSE socket 保活；重放/读流无超时与取消                      | **已改 §4.1**：accepted socket 逐个 unref 并记账、dispose 销毁；重放/读流/后台捕获进入取消域（截止 60s/120s/30min），cancel 不等待；真子进程收尾测试 §8.2 #10、真机 V12 （r3 修订：print/json 无服务无重放，见 §R2 R1-8）                                                                    |
| 9    | Major   | `DatabaseSync` + busy_timeout 5000 会阻塞整个事件循环                               | **已改 §3.2**：busy 50ms、写后账本（provider 不等 DB）、忙锁有界缓冲异步重试、溢出计数丢弃、1s/100ms 熔断、chunk 批量事务；第二连接持锁测试 §8.2 #8、真机 V11；worker 由测量决定 （r3 修订：busy 0 + 每 tick 预算 + 硬门/worker 分支，见 §R2 R1-9）                                          |
| 10   | Major   | 加密只在入口检查，流 chunk 与重放跨 await 后不复查                                  | **已改 §6**：唯一 `persist` 闸口每次 `run()` 前复查 secure+纪元，禁止跨 await 复用 DB/statement；流每批复查并取消读取；重放四个切点；两个设置加载入口覆盖测试；P1→P2 依赖更正                                                                                                                |
| 11   | Major   | dumps→records 逐文件 rename 吞错，半迁移致数据丢失                                  | **已改 §3.3**：取消自动搬迁；仅检测 + 人工步骤；半迁移状态拒绝打开、绝不开空库或缺 WAL 库；状态组合用例 §8.2 #12（需用户复核 R-c）                                                                                                                                                           |
| 12   | Minor   | jq 顶层 exit 监听与 status→ensureDb 违反懒加载；runUntapped 会建容器                | **已改 §3.1/§7.1/§5.2**：jq exit 监听纳入 engine 生命周期；契约改为「首次显式 DB 访问（含 status）才加载」；ALS 撤销，`keepalive-port` 查询不建容器；off 测试含多次子激活与监听器计数                                                                                                        |
| 13   | Minor   | 最低 Node 真进程降级与 stderr 未验收                                                | **已改 §3.1/§8.4**：`node-floor-smoke.mjs` 进 CI `web-min-node`（22.12.0）：off 无 SQLite 警告、on 只报本功能错误；sqlite 测试不在 22.12 跑                                                                                                                                                  |
| 14   | Minor   | 「路径不变」与 agentDir 适配矛盾                                                    | **已改 §0/§3.3**：固定 `homedir()/.pi/agent/records/traffic.db`，不随 `PI_CODING_AGENT_DIR`；非默认 agentDir 用例                                                                                                                                                                            |
| 15   | Nit     | 文档写域与测试组数前后不一                                                          | **已改 §10/§8.2**：分包表为唯一写域清单，T3 不写文档、文档归 T7；新增测试统一为 12 组并逐条编号                                                                                                                                                                                              |

---

## §R2 第三轮裁定处置（r2 复审剩 4 项；按 dev-flow 收敛规则由主会话裁定，2026-10-23）

| 编号 | 严重度 | 裁定要点                                                                                                          | 落点                                                                                                                                                                          |
| ---- | ------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-1 | 阻塞   | 无法证明属于 T 时一律不绑定、不改写、原样发送记 `unattributed`；绝不按唯一未配对票据认领；引入 payload generation | §5.3「配对」（存活集合判据、generation、四条退役规则及其前提由 conformance 钉住）、fetch 表（正文摘要按 generation 绑定）、hook 级回填规则、故障矩阵首四条；§0 1d、R-d；§13-3 |
| R1-3 | 严重   | 每次安装新 wrapper 闭包、下游固定；或检测到无法安全重装即停用并可见                                               | §5.2 trampoline（新闭包 + 固定 `next`、身份判活、退役透传、ALS 重入守卫、tap lost 停用）与转换规则表；§8.2 #4 新增「重挂持有旧 wrapper 的 F」与延迟绑定环用例；§0 5b          |
| R1-8 | 严重   | print/json 不启动服务、不允许重放；子会话只录不重放；其他模式会话结束走 dispose 中止在途重放                      | §4.1「模式」行与「重放」行（触发事件 = `session_shutdown` → `engine.close()`）、真子进程用例改为活动出站重放；§8.2 #10、新增 #13 `mode-gate`；§2.3；§11 V12/V13；§0 3         |
| R1-9 | 严重   | 去掉 50ms busy wait，每 tick 预算 + 退避让出；T2b 硬验收门，不达标切 worker（接口与失败处置写明）                 | §3.2（`busy_timeout=0`、setImmediate flush、2ms/1 次 BUSY、读分页、硬门表、`DbPort` 与 worker 分支）；§10 T2b/T2c；§8.2 #8；§0 2、8；§13-6                                    |
| 附   | —      | secure 现状过时：工作区已有 `src/secure/domain.ts` 与 `applySecureDomainOverrides`                                | §1 事实 9；§6（直接 import `getSecureDomain`，设置覆盖落在 `applySecureDomainOverrides`）；§10 T3 依赖「secure P2 已提交」；§0 4                                              |
