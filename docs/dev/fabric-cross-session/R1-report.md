# fabric 二期 R1：RootWakeController 实施报告

- 基线：隔离 worktree `/tmp/pi-subagent-worktrees/r_MPB2CZ7V`，`4f0dcfb3`（XS0 契约）。
- 依据：`phase2-plan.md` §4.5、§6.2–§6.7、§11.1/§11.2，以及优先级更高的 §13/§14 拍板和 r3 B1/S1/N1。
- 范围：仅 R1 源文件、对应测试和本报告。**未改 `src/stack.ts` / `src/index.ts`、XS0 冻结契约、golden、设置或依赖文件。**
- 状态：纯模块、自验完成；尚未装配，也未代替独立 verifier 或 X5 的真实 pi conformance。

## 改动文件

| 文件                                         | 内容                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/adapters/pi-compat.ts`                  | 保持原 kind/prompt 判定，custom 分支结构化读 `customType?` / `details?`；新增 `readTriggerShape`，无版本门控 |
| `src/fabric/wake-input.ts`                   | 仅抽出 `classifyHumanInput`；旧 hook 的 level/归因端口读取顺序、惰性和 continue 行为不变                     |
| `src/fabric/root-wake.ts`                    | Controller、B1 独立进程 hook、同步证据与降级结果、绝对截止/慢启动/idle/abort-grace 监管                      |
| `src/fabric/xs/wake-ledger.ts`               | 容量 8 的进程账本、每会话排他认领、证明驱动的释放；无 TTL、惰性时间清理或淘汰                                |
| `src/fabric/xs/host-cap.ts`                  | 进程粘滞四态能力机：unknown/observed/verified/absent                                                         |
| `tests/adapters/pi-compat-trigger.test.ts`   | 新旧联合形状、缺字段、custom 元数据读取与原行为兼容                                                          |
| `tests/fabric/root-wake.test.ts`             | 45 个行为用例，覆盖下列转移及 B1/S1/N1/reload/降级                                                           |
| `tests/fabric/root-wake.property.test.ts`    | seed `20261021`、250 条随机事件序列（每条 30–150 个事件）的不变量测试                                        |
| `tests/fabric/xs-wake-ledger.test.ts`        | 11 个认领、跨 token 每会话排他、容量、墓碑、证明释放、跨模块 reload 用例                                     |
| `tests/fabric/xs-host-cap.test.ts`           | 6 个首次 unknown、旧 peer absent、custom 缺形状、粘滞及 reload 用例                                          |
| `docs/dev/fabric-cross-session/R1-report.md` | 本报告                                                                                                       |

## 生命周期转移落实

| 状态 / 事件                                     | 实现与验证                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| idle → starting                                 | send 前已写账本、占位、武装截止；send 后同步 `!isIdle()` 为 applied+woke。支持 send 内重入绑定，重入 dispatch 返回 busy  |
| idle → deferred                                 | send 后仍 idle，unknown/start_deferred+woke；仅截止 timer，不把正常 idle 当结束                                          |
| 同步 send 抛错                                  | none/host_rejected，清除账本、认领和 timers，不收费、不传播 level                                                        |
| starting/deferred → bound                       | 只有本 token 的真实 trigger 验证能力、记录 boundAt；deadline 始终取 dispatchedAt + budget，不因绑定/重建延长             |
| deferred 遇 user / 其他 token / 其他完整 custom | 不改变本 token 所有权；另一个 marked orphan 仍独立执行 B1 abort                                                          |
| deferred 遇缺失 custom message/details          | 能力 absent + 一次告警；推定 bound 监管该 run，但不把推定升级为本 token 的执行证据，见下文偏差                           |
| starting 遇 foreign start                       | wake_foreign_start，仅诊断，不改归属                                                                                     |
| starting/bound settled                          | 证明本 token 已启动时，释放账本、认领及 timers；never-bound 且查不到 xid 时 wake_lost_after_accept。仅推定绑定则保留墓碑 |
| deferred settled                                | 前驱的完成，与本 token 无关，继续等待                                                                                    |
| 非 deferred 占位状态连续两次 idle               | 间隔 2s；忙观察清零，wake_end_unobserved 后清理；仅推定绑定仍不能释放真实延迟 token                                      |
| starting/bound 人类输入 → handedOver            | 必须有本 token 实际启动证据；撤截止、慢启动计时器，保留 idle 观察；超过任意期限也不 abort                                |
| deferred 人类输入                               | r3 B1 优先：不 handover，人的输入属于前驱 run，不授权尚未执行的动作                                                      |
| starting/bound 截止 → aborting                  | 绝对截止包含预启动压缩；abort 发出即走，宽限在 abort 调用前武装，Promise 永不 settle 也不阻塞                            |
| deferred 截止 → idle + 墓碑                     | 不 abort 前驱，不释放容量；真实 token 任意迟到仍首请求前 abort                                                           |
| aborting → stuck                                | 原始 abort 时间起 10s；一次告警/abortStuck，绝不因宽限到期再 abort；继续 idle 观察，占位只使新 wake 降级                 |
| handedOver/aborting/stuck settled 或 idle 证明  | 释放本 token 的已结束执行；handedOver 永不由 Controller abort                                                            |
| dispose/session_shutdown                        | 清本 stack 的 timers/lease，保留进程记录；新 Controller 显式 recover 重建绝对期限、接管/abort 宽限                       |

全部 timer 使用注入 `Clock`；默认唯一实现为 `systemClock`（分段 + 每段 unref），没有新增裸 `setTimeout` / interval。账本和能力态无 timer。

## B1 / S1 / N1

### B1：授权账本，不是缓存

- Controller 发出的消息固定为 `customType:"subagent:xs"`，`details:{xsWake:true,wakeToken,xid,from,level?}`；token 不进入 content。
- `observeRootWakeTrigger` 可在没有 stack 的窗口独立调用：marked trigger 无记录、无 token、token 属于另一会话，一律同步调用 abort 并记录 `wake_orphan_aborted`，不依赖人类是否在场。
- 已撤销或过期授权的真实 trigger：`wake_late_aborted`；记录 abort 已发出，重复观察同一个尚未结算的执行不重发 abort。完成/两次 idle 证明后才释放。
- **绝不按时间清理、惰性清理或淘汰仍可执行记录。** 100 年后才执行的 deferred trigger 测试仍被中止；容量满直接 `ledger_full`，由 X4 降级只投递。
- `handedOver` 仅能建立在 `started` 的真实证据上（Fpi2 或精确 token），不是 deferred/推定绑定的豁免。
- 所有权 lease 按会话排他，不只是按 token 排他。性质测试曾找到“旧已 abort token 与新 token 被不同 Controller 同时认领”的反例，已修复并增加固定回归。

### S1：真正起 turn 才提交 hop

- starting 的同步接受证据或精确 token 的真实启动：`raise(root, senderLevel+1)`。
- deferred：先 carry(senderLevel)，真正启动再 +1；被拒绝的迟到动作不 +1。
- `levelCommitted` 跨 reload 保留，重复 hook/recover 不会在人的 reset 后重新抬高 level。
- 无 stack/level 端口时观察到真实启动，不提前标记 levelCommitted；端口恢复后 recover 再提交一次。
- 普通只投递和 wake 降级后的 carry 归 X4；Controller 不实施那些投递。无 level 时不传播，不新增 root reset 点。

### N1：首次未知只能投递

- unknown → `host_unverified`，不做试启动；任意已发生的 user/custom 联合事件才能 observed。
- 精确授权 token 触发才能 verified。旧 peer prompt 形状或 deferred custom 形状丢失会 absent，进程内粘滞，后续 `host_unsupported`。
- 两个单例均挂在规范 `Symbol.for("pi-subagent:xs-…")` 上，fresh module/reload 保留对象与判定；无 pi 版本读取或新设置。

## 给 XW / X4 的装配接口

1. **进程入口**：激活时取得 `getXsWakeLedger()` / `getXsHostCapability()`；post-guard 的 `before_agent_start` 应调用当前 Controller 的 `beforeAgentStart(event)`；没有 Controller 时调用 `observeRootWakeTrigger(event,{sessionId,abort:()=>ctx.abort(),ledger,capability,…})`。**不要两者都调同一个 orphan 事件。** 即使设置刚被关闭，也不能跳过旧在途 marked token 的 B1 识别。不要将库的 TriggerResult 当成 pi handler 返回值，首请求中止靠同步 abort 副作用。
2. **每 stack**：构造 `new RootWakeController(deps)`，先 dispose 旧实例，再 `recover()`，最后才接收入站 wake。固定当前 sessionId，host 端口封装 `ctx.isIdle()` / `ctx.hasPendingMessages()` / `pi.sendMessage` / `ctx.abort()`，避免裸方法丢失 this。
3. **接收管道**：通过成员/策略/栅栏/速率/inbox 等校验后，在同一个同步块内 `dispatch({xid,from,content,expiresAt,level?})`。`guard()` 是同步 sessionGen/fence 最终复核端口。`level` 传当前栈 CausalLevel，quota 读/收费端口均为同步。
4. **dispatch 结果**：`dispatched:false + wakeDowngraded` 表示**尚未投递**，X4 执行 `triggerTurn:false` 并 carry；`effect:none` 是拒收/host_rejected，不 carry；`dispatched:true` 直接用 applied 或 unknown/start_deferred，`woke:true`。`token`/`dispatched` 为本地信息，勿放进 XS0 ack wire。Controller 只对实际 send 成功调用一次 `chargeInboundWake`，不得由外部重试发送。
5. **事件**：input 在原有 wake-input 的 human 判定旁调用 `controller.input(event,lateBoundWebAttribution)`；不额外 reset level。agent_settled 调 `settled()`；session_shutdown / stack 替换调 `dispose()`。结束证据与人的 handover 是唯一释放监管的正常途径。
6. **账本释放**：`dispose`/reload/shutdown **不是** `ledger.teardown` 的证据。只有确认原会话对应动作不可能再执行时才 `teardown(sessionId)`；拿不到证明就保留，最终满容量只投递。不可添加 TTL GC 或清空全表。
7. **诊断**：`state` / `activeToken` / `busy` 可读；`audit(event,token)` 接计数/审计，`warn(text)` 接警告；无正文进入审计。`host.hasXid(xid)` 接 branch/leaf 中的本 xid 证据，只影响 lost-after-accept 诊断。

## 自验输出（均 exit 0；没有运行全量 npm test）

```text
timeout 90 npx vitest run \
  tests/fabric/root-wake.test.ts tests/fabric/root-wake.property.test.ts \
  tests/fabric/xs-wake-ledger.test.ts tests/fabric/xs-host-cap.test.ts \
  tests/adapters/pi-compat-trigger.test.ts
→ 5 files passed, 83 tests passed
  root-wake 45 / property 1 (250 sequences) / ledger 11 / host-cap 6 / trigger 20

timeout 120 npx vitest run tests/fabric tests/adapters
→ 25 files passed, 378 tests passed
  既有 wake.test.ts 的 reservation_quarantined/resume_unverified stderr 为原有测试预期审计

timeout 120 npx vitest run \
  tests/integration/fabric-wake-off-golden.test.ts \
  tests/integration/fabric-xs-off-golden.test.ts
→ 2 files passed, 4 tests passed（两份 golden 未修改）

timeout 180 npm run typecheck
→ tsc main + tsc typecheck contracts + vue-tsc，exit 0

timeout 120 npm run build
→ tsc -p tsconfig.build.json，exit 0

timeout 120 npm run format:check
→ All matched files use Prettier code style!（全仓格式检查，非全量测试）

git diff --check
→ exit 0
```

## 偏差、边界与后续

1. **r3 明确覆盖正文的两项**：删除正文 §6.5 的 3600s 墓碑清理/淘汰；删除 deferred human → handedOver/abortOnSight:false 路径。按 B1 保留授权/墓碑并满容量拒绝；未改方案正文。
2. **推定 bound 的额外证据收紧**：正文允许把形状缺失的 custom 推定成本次监管对象，但这不能证明真实延迟 token 已执行。新增 `executionPending` 区分“正在监管的（可能推定的）run”和 `started` 的真实 token 证据；推定 run 完成只保留墓碑，不 handover、不提交 +1。若该推定前驱被 watchdog abort，随后真正的延迟动作出现，B1 仍必须再 abort 后者——这是**两个不同物理 run**，并非对同一次 token 执行或 stuck 状态的二次 abort。对应回归覆盖这条链。
3. **恢复更保守**：!idle 并不证明 deferred token 已开始；恢复该记录仍保持 deferred。已完成的推定监管不因别的 run 开始而被复活认领。与 r3 的证明标准一致。
4. 接受证据以 Fpi1/Fpi2/Fpi5 宿主契约为前提。FakeClock 测试验证同步 abort 调用先于 fake host 首请求 continuation；**真实 pi 的零 provider 请求 / aborted settle 必须由 X5 C-X1/C-X1b conformance 验证**，本包不虚报真实 provider 取证。
5. X4 真值表全管道、XW stack/index 组装与真实 hub 集成仍属于后续包。R1 已覆盖自身可决定的各降级，不代替那些包的验收。
6. `npm ci --ignore-scripts` 只用于隔离 worktree 安装依赖，未改 lock。Node `22.22.1` 下 transitive abbrev/nopt 提示需要 `22.22.2` 的 engine WARN；类型、构建、定向测试均通过，无已知实现阻塞。
