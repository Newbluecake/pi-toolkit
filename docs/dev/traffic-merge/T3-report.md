# T3 报告：traffic 装配进 toolkit（settings / 注册时序 / 认领协议 / 冻结面 / T5 接线）

> 状态：**完成**（自验见 §7；安全评审处置见 §10）。plan r3 §0 拍板 8 项 / §2 / §2.4 / §6 / §7 / §10 T3 行 / §8.2 #1。
> 前置：T1+T2a+T2b+T4 已提交（6e75de9c）；secure P2 已提交（799f9ee4）。
> T5 在本包进行中落码（T5-report.md 出现，状态完成）——已按其 §1 签名接线，见 §5。

## 1. 设置组（§2.2）

`src/config/settings.ts`：

- `TrafficSettings { enabled; childSessions; web: { host: "127.0.0.1"|"0.0.0.0"; port } }`，`DEFAULT_TRAFFIC_SETTINGS = { enabled: false, childSessions: true, web: { host: "127.0.0.1", port: 4177 } }`（拍板①②）。
- 四处同步：接口 / `DEFAULT_SETTINGS.traffic` / `parseTrafficSettings`（逐字段回落、永不抛错：host 只接受两枚举值、port 整数 1024..65535）/ `parseSettingsSource` 接入。不提供 dbPath（§3.3 固定路径）。
- `applySecureDomainOverrides`（两个文件加载入口 `loadSettingsFromFile` / `readSettingsNoMigrate` 的共同出口）secure 与 locked 分支均加 `traffic: { ...settings.traffic, enabled: false }`（克隆，不动 DEFAULT）。**settings.ts 零新增 import** ⇒ `tests/web-hub/boundary.test.ts` 的 `SYSLOAD_FILE_CLOSURE` 无需也不曾改动。
- `src/config/setting-specs.ts`：`traffic.enabled` / `traffic.childSessions`（bool）、`traffic.web.host`（enum 两值）、`traffic.web.port`（integer 1024..65535）。

## 2. 注册时序与装配（§2.3）

`src/index.ts` 两处调用（文件域内最小改动）：

- **子会话（pre-guard，`wireChildSession` 之后）**：`assembleTrafficChild(pi, { settings: preGuardSettings.traffic, cwd })`——只注册录制钩子（turn_start / agent_settled / cache_warming_decision / before_provider_headers / before_provider_request / after_provider_response / message_end，T2b 报告 §9 的两个新增钩子已计入），无命令、无 session_start/model_select/session_shutdown；`isActive = toolkitClaimIsLive`（进程内 claim）；`childPersist = traffic.childSessions`。
- **主会话（activate 末尾，wireTopicSwitch 之后 = 全 activate 最后一个 wiring）**：`assembleTrafficHost(pi, { settings: settings.traffic, cwd })`——排在 cache-ttl 之后（§2.3「录到最终 payload」），同步执行认领，注册 `/record` + 钩子 + session_start 复核 + session_shutdown 释放 + HUD 状态键。

`src/traffic/index.ts` 新增 `assembleTrafficHost` / `assembleTrafficChild`（T3 装配层，`AssembleTrafficOptions` 可注入 agentDir/cwd/packageRoot/fs 供测试）：

1. `enabled !== true` 或 `isSecure()`（§6：env + `getSecureDomain()`，secure.ts 直 import `src/secure/domain.ts`）⇒ 首行返回 `undefined`，零注册零 IO。
2. `externalActiveInProcess()`（墓碑版 v0.3.0 已活动）⇒ **不发布 claim、零注册**，只留一个 session_start notify-once 让位说明（§2.4 步骤 1）。
3. 否则 `publishToolkitClaim(owner)`——**claim.token 与 wireTrafficHost 的 owner 是同一对象**（T2a 约定），`isActive = toolkitClaimIsLive`；`scanExternalTrafficReferences`（dup-detect）只产出 session_start 告警文案（步骤 2，永不让位）。
4. session_start 复核（步骤 3，权威证据）：`pi.getCommands()` 存在 `/^record(:\d+)?$/` 且 `sourceInfo.path` 不在 toolkit 包根（`TOOLKIT_PACKAGE_ROOT`，从本模块 URL 推导；前缀比较带分隔符，`/pkg/toolkit-other` 不算 under；sourceInfo 缺失/畸形按外部处理 fail-closed）⇒ `yielded` 一次性守卫 + 身份校验释放 claim（钩子/命令经 isActive 立即失效）+ notify 一次。pi 面无 getCommands（不可能于真 pi，测试面）⇒ 静默跳过。
5. session_shutdown（任何 reason）：释放 claim + 注销 T5 keepalive 端口 + dispose warming 否决（engine 关闭在 wireTrafficHost 内部，T2a 已有）。**按方案字面「任何 reason」**：切会话（/new 等）后 claim 已释放、/record on 被 isActive 拦下，回复文案已澄清为「已让位给外部 pi-traffic-record，或本激活已随会话切换/关闭结束（/reload 后重开）」——拍板⑤「切会话停录」的字面执行；恢复录制需 /reload。

**web 线程化**：`WireTrafficOptions.web`（`traffic.web.*`）传入 `createTrafficServer(engine, { host, port })`（`/record on` 处）；`traffic.web.host === "0.0.0.0"` 时 `/record on` 与 `/record status` 附 `LAN_PLAINTEXT_WARNING`（明文 HTTP 嗅探提示，§2.2）。

**HUD 状态（§7.5）**：状态键 `pi-subagent:traffic`（pi 通用 extension-status 行），录制中 `rec`、有丢弃 `rec·drop N`（2s unref tick，读 `engine.dbPort.stats().droppedRows`），off/关闭/异常清除；print/rpc 无 `setStatus` 时静默。

## 3. 认领协议（§2.4）与 dup-detect

`src/traffic/claim.ts`（新，pi-free 零 IO 零模块级可变状态）：

- `Symbol.for("pi-traffic-record:claim")` = `{ v:1, owner:"pi-toolkit", token, pid, isLive() }`；`Symbol.for("pi-traffic-record:external-active")`（外部墓碑版发布，形状容错 v===1 ∧ 同 pid）。
- `publishToolkitClaim(token)` / `releaseToolkitClaim(claim)`（身份校验：符号上仍是同一对象才 isLive=false + 删除；发布/释放同一激活同一模块实例，kill 句柄经 const symbol 可达）/ `toolkitClaimIsLive()`（isActive 端口与子会话钩子入口）。进程崩溃 ⇒ 符号随进程消失；`enabled=false` 激活永不发布 ⇒ reload 开→关无残留压制。

`src/traffic/dup-detect.ts`（新，纯函数 + 注入 fs，永不抛错）：

- 扫描 `<agentDir>/settings.json`（`$PI_CODING_AGENT_DIR` else `~/.pi/agent`）与 `<cwd>/.pi/settings.json` 的 packages/extensions（数组与对象形状）含 `pi-traffic-record` / `@bluecake/pi-traffic-record`（含 `/<name>` 路径形式；pi-toolkit 自身不匹配），及 `<agentDir>/extensions/traffic-dump.ts` 存在 ⇒ `DupFinding[]` → `formatDupWarning`（含迁移步骤）。
- `findExternalRecorderCommand(commands, packageRoot)`：getCommands 权威判定（见 §2 步骤 4）。

**本机现状提醒**：本机 `~/.pi/agent/settings.json` 仍装着 `../../ai/pi-traffic-record`（外部 v0.2.x）——真 pi 主会话里外部录制器实际加载 ⇒ session_start 复核会让位（设计行为，恰是 §8.2 #2 矩阵的「外部旧版先加载」列）；按 §2.4 迁移步骤移除后 toolkit 才接管。

## 4. 冻结面证据（§7.1/§7.2）

- **off ⇒ 零注册零 IO 零符号不加载 sqlite**：`tests/traffic/wiring.test.ts` 真 `src/index.js` 激活（throwaway HOME）：默认（无 settings 文件）⇒ 无 `/record`、无 claim 符号、`peekTrafficKeepalivePort() === undefined`、`Symbol.for("pi-subagent:traffic-rewrite-marks")` 不在 globalThis（T5 §1.1 建议的两条断言）；`tests/integration/traffic-lifecycle-process.test.ts`（真子进程）在自验套件中全绿。`assembleTraffic*` 单元级：enabled=false / secure env ⇒ 零注册。
- **三份 fabric off golden + secure-off golden**：未触碰（`git status tests/fixtures/` 零改动；`tests/integration/fabric-xs-off-golden.test.ts` 与 `tests/secure/**` 全绿）。
- **子会话惰性 / HOST_KEY 不变**：wiring 测试子会话分支（HOST_KEY 预占）只钩子无命令；169 个测试文件全绿。
- **无 module-scope 可变状态**：claim.ts / dup-detect.ts 全部 const + 闭包；status 控制器在 wireTraffic 闭包内；`/reload` 每次激活重建。
- **钩子恒返回 undefined / 排 cache-ttl 后**：注册位置在 activate 末尾（代码序即注册序）；T2b 的 `traffic` payload 处理器行为未动。

## 5. T5 接线（T5-report.md §1）

T5 在本包进行中落码（完成态）。按其 §1 签名**已接线**（不留 TODO）：

- **keepalive 否决端口**：`assembleTrafficHost` 里 `registerTrafficKeepalivePort(createTrafficKeepalivePort(() => peekEngine(), { isSecure: () => isSecure() }))`；session_shutdown 身份校验注销。子会话不注册（同进程共享）。
- **warming 否决**：`assembleTrafficHost` 与 `assembleTrafficChild` **各一次** `registerWarmingVeto(pi, { rewriteArmed: () => wiring.rewriteArmed() })`（每个 AgentSession 一个 warmer）；host 在 session_shutdown dispose，child 随子会话销毁（T5 明确无副作用）。
- 测试补了 T5 建议断言（off 两符号不存在；on 端口已注册；cache_warming_decision 计数含 veto 处理器）。
- **未改任何 T5 写域文件**（keepalive-port.ts / warming.ts / capture.ts / cache-keepalive.ts / keepalive-state.ts——工作区中这些改动属 T5）。

## 6. 与方案/任务清单的偏差

1. **`src/traffic/server.ts` 加了 `CreateServerOptions.port`（约 5 行加法）**：任务文件域未列 server.ts，但 `traffic.web.port` 是 §2.2 的真实旋钮且 T4-report §3.6 明确「T3 落地后由 traffic.web.port 传入 / index.ts 调用点兼容」——不接则设置解析了却不生效。改动是纯加法（缺省 `BASE_PORT` 不变）。
2. `/record` 在 `isActive()` 为假时的提示语从 T2a 的「由其它录制器承担」扩为同时覆盖「让位」与「本激活已随会话切换结束」（拍板⑤下切会话也会走此分支，原文案会误导）。
3. claim 覆盖发布（activate 时符号上已有残留）按防御路径处理——理论上不可达（shutdown 必释放）。
4. 其余按方案字面（HUD 状态键、LAN 提示、认领矩阵语义、secure 双保险）。

## 7. 自验输出（最终轮）

```
$ npx vitest run tests/traffic tests/config tests/secure tests/web-hub/agent \
    tests/web-hub/boundary.test.ts tests/integration/fabric-xs-off-golden.test.ts \
    tests/integration/traffic-lifecycle-process.test.ts --maxWorkers=3
 Test Files  169 passed (169)
      Tests  2727 passed (2727)      （含 T5 并行新增的 tests/traffic/{keepalive-port,warming}.test.ts）

$ npx tsc --noEmit -p tsconfig.json                 0 错误
$ npx prettier --check <本包全部改动文件>            All matched files use Prettier code style!
```

新增测试：`tests/traffic/{claim,dup-detect,wiring}.test.ts`（47 例）、`tests/config/traffic-settings.test.ts`（11 例：默认/容错/secure 三域 + 两个文件入口）、`tests/web-hub/agent/command-policy.test.ts` 追加 `/record` 9 断言（裸/status/off allow、on/ON/"on now" confirm（命令本体 lowercase）、typo deny、显式 override 胜出）。

## 8. 改动文件清单

- `src/config/settings.ts`（+46）、`src/config/setting-specs.ts`（+22）
- `src/index.ts`（+12：import + 两处装配调用）
- `src/traffic/claim.ts`（新 97）、`src/traffic/dup-detect.ts`（新 132）、`src/traffic/index.ts`（+282：assemble 层 / web 线程 / LAN 提示 / HUD 状态 / T5 接线 / isActive 文案）
- `src/traffic/server.ts`（+5：port 接缝，见 §6.1）
- `src/web-hub/agent/command-policy.ts`（+10：record 表项）、`package.json`（+3：`piSecure.honors`，与外部 v0.2.1 同形）
- 测试：上述 4 个测试文件（3 新 1 追加）

## 9. 留给 T6/T7/主会话

- **T6**：conformance 两文件（§8.3）；退役规则前提按白名单 API 钉住。
- **T7**：AGENTS.md（absorbs、layout、peer 闸门清单）、README（迁移步骤/拍板①数据范围/LAN 风险）、CI node-floor 步骤、§11 真机验收（V2 的两种加载顺序在本机正好可复现——外部包仍在 settings）。
- **主会话**：无需统一接线的遗留 TODO（T5 已接）；工作区含 T5 与 preview-perf 并行改动，提交时按各包精确路径切分。

## 10. 安全评审处置（cr-response gpt-6.1-sol，/tmp/traffic-T3T5-secreview.json；T3 范围 3 条）

| #                            | 严重度 | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1（Major，重复宿主副本双录） | 修复   | **按实际会话身份的唯一接纳**（`src/traffic/index.ts` 会话槽）：进程级 `Symbol.for("pi-subagent:traffic-session-slot")` = WeakMap（键 `ctx.sessionManager` 对象，值 = 认领激活的 owner）。`enter()` 在 isActive 之后准入：首个拿到 engine 的激活占槽，同会话的其它副本（被 HOST_KEY 误判 child 的重复宿主副本）永久惰性——不铸票据不落库，tap-lost 反例随之消失；跨会话互不影响（真子会话有自己的 sessionManager，照常接纳，拍板①不变）；激活序 = 注册序 = 派发序保证 host 副本先认领。host 在 session_shutdown 身份校验释放（`claimedSlots` + `releaseSessionSlot`，/reload 后新激活可重新认领）；child 无 shutdown，槽随 sessionManager GC 回收。选择「首个事件按会话身份接纳」而非激活期判定：activate 无 ctx，而 HOST_KEY/activation-signal/子会话 self-marker 在激活时刻都无法区分重复副本与真子会话（前者同会话、后者新会话，唯一可靠差异就是事件携带的 sessionManager 身份）；不采用「无法区分则 fail closed」——那会杀死拍板①。回归：`tests/traffic/wiring.test.ts`「安全评审 #1」——同一 pi 双副本每请求恰一张票据、真子会话照常、shutdown 释放后重新认领、无 engine 时零副作用 |
| 4（Minor，claim 校验）       | 修复   | `claim.ts`：`toolkitClaimIsLive` 除 v/owner/pid 外增加 `claimWellFormedAndLive`——token 必须非空对象、`isLive` 必须函数且返回 true（抛错 fail closed）；已释放 claim 被挂回（isLive 已翻 false）不再有效。新增 `claimIsOurs(claim)`（符号上仍是**同一对象**且存活），主会话 `isActive` 改绑它（不再只问「进程内是否有 claim」）；子会话保持共享语义 `toolkitClaimIsLive`。回归：`tests/traffic/claim.test.ts` +3（挂回已释放 claim、六种畸形形状、claimIsOurs 身份绑定）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5（Minor，端口上界）         | 修复   | `server.ts` `listenFirstFree`：`endPort = min(startPort + MAX_PORT_TRIES - 1, 65535)`，循环 `port <= endPort`，错误文案用实际尝试范围——port=65535 被占时不再 listen(65536) 抛 ERR_SOCKET_BAD_PORT，而是有界「端口 65535-65535 均被占用」。回归：`tests/traffic/server-start.test.ts` +3（65535 占用/空闲、65530–65535 全占的截断范围文案）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**附带（非评审项）**：`tests/traffic/server-start.test.ts` 原有三个用例与并行测试文件（server-hardening / replay / lifecycle 子进程）共用默认 4177 带，跨进程端口竞争造成 canBind 假失败（单文件过、并行挂，两轮全量复现）——本文件改用私有端口带 4260（避开默认带 4177–4196），顺带把第三用例改经 T3 新增的 `web.port` 传入（覆盖新接线）。改后连续两轮全量 2740 全绿。

T5 范围两条（cache-keepalive 发送时复查、keepalive-port/capture 隔离）由另一会话并行处置，本包未触碰其文件。
