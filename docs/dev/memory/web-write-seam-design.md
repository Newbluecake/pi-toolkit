# Web `/mem session add` 写入口装配设计

> r5 实现附件 r2；按异源评审 B1/S1/G1/G2 及 Q1–Q3 裁定修订。设计稿，尚未实现。基线由调用方指定为 `1996647e`；本次只读核验工作区，不执行 git、不声称工作区与该提交逐字相同。日期：2026-11-08。
>
> 主方案：[web-command-confirm.md](./web-command-confirm.md) r5。本附件只收敛第一步 `session add` 的闭环，不把其它写域宣称为完成。下文“新增/拟改”签名均是实施契约，不冒充现有导出。

## 1. 背景与目标

### 1.1 本步范围

- 仅开放 Web `op:command, name:"mem", args:"session add <全文>"`，真人批准完整领域计划后，向当前实际 session manager **恰好追加一个** session memory entry。
- 已支持的同步只读仍走 `memoryRead`，不转异步、不弹业务确认、不扩大只读能力集合。分类为 read 但执行器不支持的语法继续返回原错误。
- `session rm` **排除**：native 只有 session add；rm 必须先新增语法及原文/rev/CAS 设计，另立任务。Hub、migrate、import、restore、tidy、init、tags/Jev/review 等所有写操作继续拒绝；其中只读变体按现有只读执行器处理。
- 不调用 native handler，不伪造 `ExtensionCommandContext`，不 mint HumanTurn/模型 OpCap，不改变 `trustedNativeMemoryCommand`。
- 不加 setting、协议字段、PROTO/cap，不造第二 ledger、持久审批队列、通用事务框架。复用 remote dialog、32 槽 completion、once settle、queryOnly 和既有会话级 abort。
- main/plain/memory enabled/session scope on 才能接写端口；child、secure/locked、scope off 均拒绝。Web off 不构造确认 kernel/领域 Web 状态，不改 native 输出或注册次序。
- DetailDock 提供 mem 专属、**idle 可用**的“停止本会话（尝试撤销记忆写入）”动作；不修改 Composer.vue。关闭结果只隐藏，不撤销写。

### 1.2 现状必须准确表述

**现有“总写门”描述不精确。** `src/memory/command.ts:239–247` 先调用 scopedRouter；`:598–600` 是交互判定，不是统一 Web 写拒绝门。当前 session 写拒绝来自 bridge 只有 `memoryRead`（`src/web-hub/agent/builtin-bridge.ts:638–674`）、只读执行器不执行写，以及 `src/memory/scopes/command.ts:96–97` 的 native 环境门。因此在 `command.ts` **新增独立 Web 受保护路由**，不是删除一个不存在的总 if，更不是添加 `native || confirmedWeb`。

**session 不是普通 Markdown 文件覆盖。** `session-store.ts:361–384` 通过 SDK append 写领域 entry；SDK 自己生成 envelope 的 id/parentId/timestamp。即使有 sessionFile，custom-only 会话也可能在首次 conversation flush 前**尚未落盘**。预期新 hash 只承诺领域内容，不能假称已知道完整新 JSONL 字节，亦不保证 fsync 或跨进程原子 CAS。

### 1.3 本轮评审闭合登记

- **B1**：before/planned-after/observed-after 统一使用 §4.3 唯一规范化投影，剔除外层 `inherited`，保留完整 item 与全部持久字段；不改 native planner/fold。
- **S1**：§7.3 增 idle 可操作的 DetailDock 撤销入口，真实按钮→abort→cancel→ledger→DOM 是生产注入前硬门。
- **G1**：100ms 是单调时钟驱动的协作式软预算；8MiB 是**整份 session JSONL** 硬字节界。软预算超时在 consume 前拒绝，不承诺抢占同步 I/O。
- **G2**：按四职责包实施；预计实现 18–19 文件、测试/probe/tiers 14–18、文档 3，合计 35–40。修改清单与仅运行的回归分别列在 §8。
- **Q1/Q2 有条件接受、Q3 接受**，条件已写入正文；它们不再作为开放选项让开发者自行选择。当前没有新增待用户拍板问题，条件是否落实由实施评审和验收证明。

## 2. 现状摘要与证据坐标

以下坐标经只读核验；实施时按符号定位最新行，不从旧稿整文件覆盖。

- `src/memory/command-policy.ts:10–89`：保守分类；session add 为 single，没有完整写请求 parser，也不授权。
- `src/memory/command-confirm.ts:53–113,144–203,279–322,345–370`：opaque call/receipt、start 仅 rawArgs、私有引用身份、120 秒确认、29 分钟墙钟、reserve/check/consume/close；尚无真实 cmdId/owner 绑定。
- `src/memory/command-confirmed-step.ts:1–111`：任意 runLocked 回调原语；浅冻结 CommandPlan 字符串；类型及运行时检查不能阻止 detached effect，未接生产。
- `src/memory/scopes/owner.ts:46–115,178–208`：唯一 actual manager/MemoryOwner、session store、native grant、abort/dispose；新 Web 权限归此 owner，不创建第二 store。
- `src/memory/scopes/wire.ts:82–155,158–186,203–225`：session/tree 换 owner，旧 owner dispose；普通 append 不换 branchGen；复用现有生命周期。
- `src/memory/scopes/session-store.ts:189–397`：有界 FIFO，最后 await 后同步 run，fresh fold、gate、owner、cap、一次 append、事后 fold、unknown poison；**没有跨进程 session 文件锁**。
- `src/memory/scopes/session-ops.ts:64–177,180–194`：纯 planner；create 分配 nextN；第 32 次生成单个 snap；新 snap 的 sid 是当前 writer、没有 inherit；planned.after.items 只含 item/rev，itemToPlain 保留 from/originSid/grant。
- `src/memory/scopes/session-fold.ts:80–98,128–162`：实际 fold 依 entry writer/seed 派生外层 inherited；put 保留未改项的继承标记，新当前 writer snap 重新建立折叠基底。不能直接将完整 fold.items 与 planner.after.items 做 hash 对比。
- `src/memory/scopes/types.ts:129–136`：MemoryOwner 含 incarnation 引用、sid、sessionFile、sessionEpoch、branchGen。
- `src/memory/index.ts:91–108,421–448`：wireMemory 只返回 webRead；已有 opts.scopes，可按次取 current owner，没有异步写端口。
- `src/web-hub/agent/commands.ts:293–324,855–873,1136–1191`：memoryWaiters/29 分钟/Promise reply-only/finishMemory；timeout/clear 目前仅收结果；handleAbort 已校验 expect.sessionId 并调用 ctx.abort，但未撤销 memory 写。
- `src/web-hub/agent/ledger.ts:214–234,278–295`：32 memory 保留槽、终态 30 分钟、once；数据表不存 cap、ctx、Promise。
- `src/web-hub/agent/commands.ts:383–386,723`：prompt/held/replay 最终分发拒 slash-shaped mem，必须保留。
- `src/web-hub/agent/command-policy.ts:323–368`：scoped hard deny 优先 override；completion 依赖同判定，不能只改 bridge。
- `src/web-hub/agent/command-complete.ts:161–194,274–278,323`：normalize/base 两处均须同步传递 session add 能力位。
- `src/web-hub/agent/index.ts:922–931,988–1007,1308–1371,1442–1450,1928,1982,2462`：completion/bridge/handler/dialog/边界接线；bridge 先于 wireDialogs，remote readiness 必须闭包晚取。
- `src/web-hub/ui/src/components/detail/DetailDock.vue:135–186,329–416,426–500`：history 仅覆盖同步 mem；async 按 name 找 id，query 回调只比 name，inner failure 可误当 success。
- `src/web-hub/ui/src/logic/control.js:388–414,435–464,478–551`：failed late/terminal ctl 可直接 failed/删除；query failure 丢真实 effect。
- `src/web-hub/ui/src/composables/useControl.ts:115–121,200–208,281–308,316–339`：现有 `abort(agentKey)` 生成独立 abort cmdId、带 expect.sessionId；queryOnly 可复用，但缺同查询 single-flight 和操作身份检查。
- `src/web-hub/ui/src/composables/useHub.ts:636–659`：自动 lateQuery/unknown 查询；须与 Dock 合并为一条查询路径。
- `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:795–823,913–923`：本地 SDK 同步 persist，envelope 由 SDK 生成；没有 conversation 时可只写内存。有 sessionFile 不等于已刷盘；不是升级 SDK 授权。

已读 memory README（含 B1 限界与 scope owner/poison）、Web Hub 总体不变式、ask-user README、secure README。不修改 message-speed/archive、模型工具授权或 frozen artifact。

## 3. 总体设计

### 3.1 依赖方向

```text
认证 cmd → commands.beginOrReply(new) → reserveMemoryCompletion
  → commands 创建本地 admission（owner、代际、deadline、撤销/释放登记）
  → builtinBridge.execute(frame, admission)
      ├─ read → 原 memoryRead → 原同步 completion
      ├─ 非 session add 写 / 缺端口 → 拒绝，绝不 generic fallback
      └─ session add → wireMemory.webWrite.start(request, actualCtx)
           → 同一 MemoryOwnerRuntime 的 lazy Web controller/kernel
           → session-store.prepareWebAdd（同一 FIFO 内只读冻结）
           → kernel.confirm（显式 remote，不持 FIFO 等人）
           → command.ts.executeConfirmedMemoryWrite（本 call 凭据门）
           → session-store.enqueueConfirmedCommand
                同 FIFO → 规范化计划复核 → check/consume → 同步 append → 观察
           → WriteOutcome → bridge 映射 CmdResultBody
  → commands.finishMemory（唯一结果 latch）→ ledger → ctl/cmd_late
  → finish finally 释放 task/领域计划（最终纯数据观察已缓存）
  → UI queryOnly（唯一查询点）→ 匹配 cmdId/owner/操作代际 → CommandResult

DetailDock mem专属按钮（idle可用）→ ControlHandle.abort(agentKey)
  → 既有 op:abort / expect.sessionId → commands.handleAbort
  → 当前 owner task.cancel → 原 mem cmdId 的 completion → queryOnly → DOM
  ╳ abort 自己的 ok 回执不代表原 mem 已撤销
```

### 3.2 不将任意 `runLocked` 接生产

复用 **kernel 授权状态机与 store 的真实同步临界段**，不接受 Web/command 提供 `runLocked/validate/apply` callback。生产 consumer 在 `createSessionMemoryStore` 内封闭定义，只收数据计划与 opaque 凭据。

session 的锁是同 store FIFO 中无 await 的 run 临界段。prepare/commit 各短占用一次，确认期间释放 FIFO。native/model 可继续写；commit 发现变化即 PLAN_CHANGED，不扩计划、不重弹。B1 原语仍未接线，不改为“已集成”；未来 hub/迁移必须另做各自锁内 consumer。

### 3.3 模块责任

- `command-policy.ts`：session add 严格 parser，不将所有 single 放行。
- `command-confirm.ts`：bound call 元数据和同步有效性检查，仍用私有 Map 引用校验。
- `command.ts`：独立受保护的 Web commit 路由；native handler 不收 Web 参数。
- `scopes/session-store.ts`：prepare/commit/cancel/observe/release 端口、FrozenPlan 注册、唯一 hash 投影、文件 guard；复用 FIFO/poison/append。
- `scopes/owner.ts`：lazy Web controller/kernel，同 store 实例绑定；任务及最终观察由此持有。
- `memory/index.ts`：按次取实际 owner/manager 的 pi-facing facade，保留同步 read。
- bridge/commands：传输与领域适配、撤销/释放登记、唯一终态；不增加账本或发布 latch。
- UI：mem 身份化结果、单一路径 query、idle 撤销按钮；不修改 Composer 或其它命令的状态机。

## 4. 接口契约

下列为拟新增/扩展签名，使用现有实际类型；相对 import 用 `.js`。opaque brand 只作类型限制，运行时必须校验同实例 Map 的引用。`as`、JSON、模型参数绝不产生权限。可选字段缺失时省略，不显式写 undefined。

### 4.1 请求与 call

`src/memory/command-policy.ts` 新增：

```ts
export interface MemoryWriteRequest {
  readonly kind: "session.add";
  readonly rawArgs: string;
  readonly text: string;
}
export function parseMemoryWriteRequest(
  rawArgs: string,
):
  | { ok: true; request: MemoryWriteRequest }
  | { ok: false; code: "E_MEM_WEB_UNSUPPORTED" | "E_MEM_ARGS"; message: string };
```

先用已有 classify 分读写；写 parser 对 `rawArgs.trim()` 匹配 `^session add ([\s\S]+)$`。prefix 后正文不 split/rejoin，正文 `--foo` 不当 flag；空白正文拒绝。1024B 单条与 entry 容量仍由 planner 验证，拒绝而非截断。rawArgs 保留原值绑定摘要；其它写始终 unsupported，未来分类器扩展不能顺带开放。

`command-confirm.ts` 保留 opaque `MemoryWebCall`，扩展私有 CallRecord：

```ts
export interface MemoryWebCallBinding {
  readonly cmdId: string;
  readonly commandOwner: string;
  readonly operationGeneration: number;
  readonly owner: MemoryOwner;
  readonly manager: object;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly current: () => boolean;
}
export type ConfirmResult =
  | { readonly approved: true; readonly receipt: MemoryCommandApproval }
  | CommandFailure;

// CommandConfirmKernel 拟扩展；reserve/check/consume/close 保持
start(rawArgs: string, binding?: MemoryWebCallBinding): MemoryWebCall | undefined;
binding(call: MemoryWebCall): Readonly<MemoryWebCallBinding> | undefined;
confirm(call: MemoryWebCall, plan: CommandPlan): Promise<ConfirmResult>;
```

绑定含 cmdId、handler activation 身份、本地单调派发代际、真实 owner/manager、统一绝对 deadline；不是 UI 代际。binding 字段拷贝冻结，owner.incarnation/manager 按引用不 clone。metadata 来自认证 bridge→host facade，不能 DTO 自填。

无 binding 的旧 start 留给既有原语/单测；**生产 consumer 必须拒绝无 binding call**。`valid()` 增 signal/current/真实 owner-manager 复核，deadline 取 `min(binding.deadline, now+COMMAND_WALL_TIMEOUT_MS)`。binding/lease/check/reserve/consume 均同步检查到期，不依赖 timer 已触发。close 清 timer/abort 监听和 receipts，失效 Web 永不变 native。

`current()` 复核 actual manager、sid/file、activation/派发身份及 idle/pending/compaction/switch/control 门；异常为 false，不按“最近 mem”或同名文本找权限。

### 4.2 dispatch、结果与任务所有权

pi-facing facade 在 `memory/index.ts`；domain 类型在 `command.ts` / `command-confirm.ts`，store 不 import pi。

```ts
export interface MemoryWebDispatchRequest {
  readonly write: MemoryWriteRequest;
  readonly cmdId: string;
  readonly commandOwner: string;
  readonly operationGeneration: number;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly current: () => boolean;
}
export type MemoryCancelReason = "abort" | "timeout" | "tree" | "session" | "reload" | "dispose";
export interface MemoryWriteTask {
  readonly done: Promise<WriteOutcome>;
  cancel(reason: MemoryCancelReason): WriteOutcome;
  release(): void;
}
export interface MemoryWebWritePort {
  start(
    request: MemoryWebDispatchRequest,
    ctx: ExtensionContext,
  ): { accepted: true; task: MemoryWriteTask } | { accepted: false; outcome: WriteOutcome };
}
```

facade 每次读 `opts.scopes.current()`，核对 actualCtx.sessionManager、sid/file/main/plain/feature，不在 activate 捕获 owner，不构造假 ctx，不调用 native scopes.command。start 的业务工作从**返回 task 之后的 microtask**开始，确保撤销句柄已登记；同步前缀不能 prepare 写盘/开框。

bridge 内存接口（不进 wire）：

```ts
export interface MemoryBridgeTaskControl {
  cancel(reason: MemoryCancelReason): CmdResultBody;
  release(): void;
}
export interface MemoryBridgeAdmission {
  readonly commandOwner: string;
  readonly operationGeneration: number;
  readonly deadline: number;
  readonly signal: AbortSignal;
  current(): boolean;
  attach(control: MemoryBridgeTaskControl): boolean;
}
execute(frame: CmdFrame, admission?: MemoryBridgeAdmission): CmdResultBody | Promise<CmdResultBody>;
```

commands 仅在 begin=new/reserve 成功后生成 admission；调用 bridge **之前**登记 waiter/timer，attach 同步一次性保存 cancel/release。缺 admission/attach 失败时 bridge cancel task、复制结果、finally release，再拒绝；不能漏出任务。同步 read 完成立即清 waiter，不影响原同步签名。

领域结果在 `command.ts` 定义，store 只 type-import：

```ts
export type WriteOutcome =
  | {
      readonly ok: true;
      readonly effect: "completed";
      readonly id: string;
      readonly rev?: string;
      readonly persistence: "appended" | "memory-only";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly effect: "none" | "unknown";
      readonly code:
        | CommandErrorCode
        | ScopedMemoryErrorCode
        | "E_MEM_ARGS"
        | "E_MEM_WEB_UNSUPPORTED"
        | "E_MEM_FILE_TOO_LARGE"
        | "E_MEM_PLAN_BUDGET";
      readonly message: string;
      readonly retryable: false;
      readonly recovery?: "explicit-reopen-and-verify";
    };
```

本步单 action，不制造 partial。attempted 后 append throw/thenable/事后不符→`E_PERSIST_UNKNOWN + unknown + poison`。成功保持原 persistence 枚举：`appended` 仅标文件型目标，**不证明此刻文件存在/已 flush/fsync**；custom-only 有 sessionFile 但 SDK 尚未 flush 时也须明确“已追加到会话内存，首次 conversation flush 前可能尚未落盘”。没有公开 flush 证据时统一保守展示该提示，不读 SDK 私有 flushed 字段。

映射既有 CmdResultBody：成功为 command/extension/completion=sync/captured=true/output；busy→E_RATE、确认/墙钟/软预算超时→E_DEADLINE、stale→E_STALE_CTX、缺通道/文件过大/不支持→E_UNSUPPORTED、args→E_BAD_REQUEST，其余→E_COMMAND_DENIED。失败 message 保留领域码/effect/阶段/恢复提示；retryable=false；只有确证 none 才映射 wire none，其余 unknown。不增加 CmdErrorCode/Effect union。

**观察与释放的唯一责任链**：

1. store 在同步 append/事后 fold 返回前，将最终纯数据 outcome 写入 PreparedRecord；controller 的 Promise then 是否运行，不影响观察可读。
2. task.cancel 先 close kernel，再调用 store.cancelWeb 读取 phase/observed。已有 completed/unknown 优先，不能因为未执行 Promise then 就报 none。task 将读得的纯数据 outcome 拷贝缓存，不持有 cap 作为结果。
3. **commands.finishMemory 是已 attach task 的释放责任人**：先取得/复制正常结果或 cancel 观察，once settle ledger；finally 调注册的 control.release。publish/send 抛错、重复终态等也要幂等清理。timeout/boundary 不能先 delete waiter/释放 store 再观察。
4. control.release 委托 task.release；后者最后复制 store 最终观察到 task 纯数据缓存，然后由 **owner controller 调 `store.releaseWeb(call)`**，移除 plan/receipt/owner 活跃任务、timer/监听。正常 done 的 finally 只 revoke/close，**不提前 releaseWeb**。
5. owner.dispose 先 cancel 所有任务再 dispose store；不得抢先删除 PreparedRecord 的最终观察。commands 边界 finish 取完后释放；未 attach/start 拒绝的任务由 controller/bridge 在已复制结果后自行 release，不能留孤儿。
6. release 幂等；迟到 cancel 只读 task 缓存，迟到 Promise 不能重新提交/改 ledger。若同步 apply 内可重入撤销已形成 unknown 终态，后续更明确观察只供清理，不升级已发布终态；普通事件循环下同步 apply 不会被 abort handler 抢占。

task 的 outcome 缓存是观察快照，不是第二 completion latch；只有 commands/ledger 决定发布终态。

**Q3 已接受**：不接 beginExternal/record.sink/record.settle；history on/off 都用独立结果卡。不新增观测 append 干扰同 session 冻结，不显示“记录保存成功”。其它 recorder 的存在/抛错不是本调用结果依赖。

### 4.3 FrozenPlan、唯一 hash 投影与文件 guard

类型放 `scopes/session-store.ts`，只接受同 store 注册的 plan 引用。深冻结 entry/items/grant/affected；使用已有 `canonicalJson`、`sha256Hex`，不复制另一套摘要算法。

```ts
declare const frozenPlanBrand: unique symbol;
export interface FrozenPlan {
  readonly [frozenPlanBrand]: never;
  readonly version: 1;
  readonly kind: "session.add";
  readonly target:
    { readonly kind: "session-file"; readonly path: string } | { readonly kind: "memory-only"; readonly sid: string };
  readonly owner: MemoryOwner;
  readonly frozenAt: string;
  readonly hashDomain: "session-memory-fold/v1";
  readonly oldContentHash: string;
  readonly expectedNewContentHash: string;
  readonly entryHash: string;
  readonly entry: SessionMemoryEntryV1;
  readonly affected: readonly {
    readonly id: string;
    readonly beforeRev: string | null;
    readonly afterRev: string;
    readonly change: "create" | "retained-in-snapshot";
  }[];
  readonly commandPlan: CommandPlan;
}
interface SessionMemoryFoldProjectionV1 {
  readonly items: readonly Pick<FoldedSessionItem, "item" | "rev">[];
  readonly nextN: number;
  readonly opsSinceSnap: number;
  readonly dropped: FoldedSessionMemory["dropped"];
}
function projectSessionMemoryFoldV1(fold: FoldedSessionMemory): SessionMemoryFoldProjectionV1;
function hashSessionMemoryFoldV1(fold: FoldedSessionMemory): string;
```

这些函数属于 store 的 Web 计划实现（可提取为第 19 个 pi-free 私有 helper 文件，但不改 native planner/fold）。PreparedRecord 另存 call/manager/完整 operation、before/after fold、文件观察、phase/最终结果；一个 owner 最多一个活计划，拒绝即撤授权，最终观察按 §4.2 后释放。

#### 4.3.1 B1：三个时点必须使用同一投影

**唯一投影定义**（伪代码契约，不是实现补丁）：

```text
projectSessionMemoryFoldV1(fold) = {
  items: fold.items.map(({ item, rev }) => ({ item: 完整拷贝(item), rev })),
  nextN: fold.nextN,
  opsSinceSnap: fold.opsSinceSnap,
  dropped: 完整拷贝(fold.dropped)
}
hashSessionMemoryFoldV1(fold) = sha256Hex(canonicalJson(projectSessionMemoryFoldV1(fold)))
```

- **保留数组顺序**，不按 id 排序；完整保留 item 所有实际存储字段，包括 `originSid`、`from`、`grant`、authority、text、created/updated 等；保留 rev、nextN、opsSinceSnap、dropped。只剔除 FoldedSessionItem 外层派生 `inherited`，不能递归删所有“来源”字段。
- `oldContentHash = H(realBeforeFold)`，`expectedNewContentHash = H(planned.after)`，提交后的 `observedHash = H(realObservedAfterFold)`，三个 H 是同一函数、同一版本，禁止独立拼字段。
- 提交前 fresh fold 的 H 必须等于 oldContentHash；再以冻结时间重跑真实 planner，比完整 entryHash 和 H(replanned.after)。提交后 H(realObservedAfterFold) 必须等于 expectedNewContentHash。预检查差异→PLAN_CHANGED/consume=0；attempted 后差异→unknown/poison。
- entryHash 仍对**完整真实 SessionMemoryEntryV1** 做 canonical sha256，不通过 fold 投影删字段。
- fork/spawn 继承 + 普通 put：真实 observed fold 可以继续带 inherited，而 planner.after 不带；投影后必须一致。第 32 次 snap 按原 planner：sid 是当前 writer、新 snap 不含 inherit；真实 fold 外层继承标记因此可消失，不能误报未知。item.originSid/from/grant 等持久字段仍按原 planner 完整保留。
- 本步不另外冻结外层 inherited 身份；真实 owner/branchGen 检查保留。若未来确需“仅继承身份变化也拒绝”，须另定义**只用于提交前检查**的 before 身份摘要，不能混进 expected/observed after，更不能改 native planner/fold 迁就 Web hash。

#### 4.3.2 prepare 与确认计划

在 FIFO 短临界段内、零 mutating I/O：

1. 检查 owner/signal/capability/gate/poison；locked 前不读 branch/file。
2. 真实 manager branch 全新 fold，绕过缓存；dropped 非空拒绝，不把宽容折叠当安全计划。
3. 冻结时间一次：调用真实 `planSessionOp(fresh, owner.sid, {op:"put",authority:"user",text,grant:{via:"command"}}, () => frozenAt)`，复用容量与编号规则。
4. 用唯一 H 计算 old/expected，完整 entryHash 绑定实际 put/snap。create 的 CAS 覆盖全集 hash/nextN/opsSinceSnap，不因没有 target expectRev 省 CAS。
5. put 的 affected 仅新增 id；snap 列全体 id/rev，区分 create 与 retained-in-snapshot。展示“仅新增一条，实际追加一个快照，未删除已有项”，告知 snapshot 采用当前 writer、外层派生继承标记可能按既有语义更新；不能借 snap 改保留项正文。
6. target.path 来自实际 sessionFile，不由 args/cwd 拼接；无 file 明示 memory-only。manifest 含完整 entry（包括 snap 保留正文）、影响集合、目标、hash 域/值、版本、冻结时间、owner 非引用标识；引用身份由私有 Map 验证。
7. `CommandPlan={rawArgs,step:0,manifest:canonicalJson(完整投影),presentation}`。presentation 显示新增全文、scope/路径、entry种类、影响集合、deadline、缓冲/持久化与不可回滚提示；不重接外部 digest/presentation。

#### 4.3.3 Q1/G1：文件观察、8MiB 硬界、100ms 软预算

文件型目标做只读 `lstat → O_NOFOLLOW|O_NONBLOCK open → fstat → 分块 hash → fstat/lstat`；比较 canonical path、dev/ino、size、mtimeNs/ctimeNs、完整 SHA256。absent 使用不存在事实及父目录身份；异常/非 regular/symlink 拒绝；不 mkdir、不修复。无 sessionFile 的 memory-only 不触磁盘。

- **8MiB 是整份 session JSONL 文件的硬字节界**，不是 session memory 的 8192B 正文预算。先用 fstat.size 拒绝过大文件；读取时累计实际字节不得超过 8MiB，恰达界后通过 size/EOF/前后 stat 验证完整性，增长/截断不接受截断摘要。
- 超界返回 `E_MEM_FILE_TOO_LARGE / effect=none`，明确显示“会话文件超过 8MiB，此 Web 写入口不可用；未执行，请使用其它受支持入口。”consume/append=0，不截断 hash、不转 native、不自动重试；原 native 行为不变。
- 每次 prepare 检查段和 commit 复核段各有 **100ms 协作式软预算**，各自从开始执行（不含等待人类确认）记录单调 elapsed clock，如注入的 `performance.now()`；绝不用可能回拨的 Date.now 衡量这100ms。29分钟 call deadline 另按现有墙钟契约检查，两者都不能被新预算延长。
- 在每次文件/branch/规划操作**之前和之后**、每个读取块前后、最终 consume 前检查 elapsed 与 call deadline。`elapsed >= 100ms` 返回 `E_MEM_PLAN_BUDGET / none`，consume/append=0。prepare 超预算不开框；commit 超预算撤 receipt，不重弹。
- 一个同步 syscall 可能阻塞超过100ms，检查只能在它返回后发现；**100ms 不是硬时限，不承诺实时抢占或最大响应时长**。8MiB 字节界仍是硬界；它不能消除慢盘阻塞风险。

commit 在同 FIFO、最后 await 后再取相同文件观察；确认期间外部同大小改写、恢复 mtime、换 inode、symlink、absent→present 都必须拒绝，consume=0。文件变化用 PLAN_CHANGED，读取不可验证用明确 gate/预算/大小错误，不得继续提交。

物理旧文件 hash **不等于** expectedNewContentHash。SDK 生成 envelope，且首次 flush 可能输出先前内存历史；不得手写 JSONL 绕 SDK。Q1 已有条件接受“exact 领域 entry + 同 manager FIFO + 确认期间文件身份/旧字节 guard”，**不承诺跨进程原子 CAS/fsync**；custom-only 可能尚未落盘。外部 writer 在最后 guard 后、SDK append 前/中/后的竞态是明确残留风险，不把 JS 同步段或本地 FIFO说成其它进程共同遵守的锁。

### 4.4 领域端口与凭据消费者

仅向 owner Web controller 暴露，不加入模型 SessionMemoryPort：

```ts
prepareWebAdd(
  call: MemoryWebCall,
  request: MemoryWriteRequest,
): Promise<{ ok: true; plan: FrozenPlan } | Extract<WriteOutcome, { ok: false }>>;
ownsWebPlan(call: MemoryWebCall, plan: FrozenPlan): boolean;
enqueueConfirmedCommand(
  call: MemoryWebCall,
  plan: FrozenPlan,
  receipt: MemoryCommandApproval,
): Promise<WriteOutcome>;
cancelWeb(call: MemoryWebCall, reason: MemoryCancelReason): WriteOutcome;
releaseWeb(call: MemoryWebCall): void;
```

store deps 增只读 getter `webConfirm?: () => CommandConfirmKernel | undefined`，指同 owner lazy kernel。其它 kernel 签出的凭据也不能进入本 store；native/model 不取得 mint。

- prepare/commit 复用现有 chain/pending/queueLimit，可抽私有 enqueueSync；不另开 Web 队列，不公开任意工作 callback。
- prepare 退出 FIFO 才等确认；批准后 controller reserve，一次 commit 入同 FIFO，入队/出队均检查 signal/owner/lease/feature/busy，无自动重试。
- commit 校验 plan 注册引用、call、rawArgs、owner/manager/version、完整 operation，再做 §4.3 的 fresh before/重算 entry/after hash 比较。实际 append 用冻结 entry，不换时间/编号/内容。
- 所有 getter/gate/file guard/planner 在最终 consume 前；软预算与 call deadline 最后再查。consume 后同步 append/观察，无 await、native registry、Jev/sweep/onAfterWrite 或 detached 工作。
- 私有 `applyFrozenSessionAdd(record): WriteOutcome` 非 async；host append 返回 thenable 视为 unknown+poison，检测不是撤回已发生 effect。保证来自封闭实现和实际 SDK 唯一 append 接线，不靠泛型或 brand 假定可信。
- attempted=true 后任意不可确证结果复用 poison；禁止自动 retry、删尾、SDK rollback。物理提交全部同步，故本步不需要 Jev raw tracker；引入异步 effect 须退回设计。

### 4.5 对象生命周期

- Request：bridge parser 创建、controller 持有，仅本次调用，文本本身无权限。
- Admission/waiter：commands 创建，绑定 cmdId/owner/派发代际；timeout/abort/boundary 先观察/cancel，finish finally release。
- Call/binding：同 owner kernel 签发并私有持有，至拒绝/超时/撤销/owner dispose；关闭不可复活或变 native。
- FrozenPlan/PreparedRecord：store 创建，controller 只拿引用；批准后不可换计划；授权失效立即撤销，最终观察直到 finish 取完才释放。
- Receipt：有效 remote 肯定 callback 签发，minted→reserved→consumed 或 revoke，绑定一个 call/step/manifest；不可跨代/跨 kernel 复用。
- Outcome：store 产生、task 缓存、bridge 映射、ledger 保留纯数据；不含授权。
- UI key：Dock 发起前创建，cmdId+agent/session/epoch+操作代际；dismiss/新操作/切换/unmount 失效结果回调，不代表服务端写撤销。

## 5. 执行流与写门改造

### 5.1 时序与失败分支

1. **认证/新派发**：现有 handle/frame 检查；重复 cmdId 回 ledger，不调用 bridge。busy/compact/switch/expect不符拒绝 none；容量不足零call/零框。
2. **分流**：bridge 的 mem 分支早于 generic extension。read→原同步路径；其余经严格写 parser，仅 session.add 可继续。显式 deny 优先，confirm只是前置防误触，allow不免业务确认。
3. **准入/撤销登记**：reserve→waiter/admission→bridge。验证可信结构化 loopback/lan、非Feishu、实际ctx、deadline、remote ready、write facade。缺任何能力直接拒绝，不开框、不fallback。
4. **签发 call**：facade 按次取同一实际owner/manager，单owner已有写则busy。kernel绑定事实；getter异常stale，不依赖capture。
5. **prepare**：同FIFO只读冻结，规范化hash和文件guard/预算。失败零框/consume/append/目录写/record；成功释放FIFO。
6. **确认**：仅remote，MEMCMD单题、拒绝首项、allowOther=false；dialog nonce/id/epoch和kernel originKind/key/value/digest/deadline共同验证。拒绝/关闭/超时→none，不转TUI。
7. **批准/门**：reserve receipt；`executeConfirmedMemoryWrite`核本call/plan/receipt后委托store，check不消费。
8. **同步提交**：出队检查→fresh fold/文件guard→唯一投影/真实planner比较→预算/deadline→consume→attempted→单次append→真实fold/H观察。预检查变化PLAN_CHANGED/consume=0；attempt后不符unknown+poison。
9. **终态**：controller关闭权限但保留观察；commands取得正常结果或cancel观察，once settle→ctl/late，finally release；Promise reject不能一概映射none。
10. **UI**：任意terminal ctl/late→queryOnly→精确key结果卡；abort自己的ok不代替原mem终态，重连/drain/query不重执行。

零副作用指本调用的业务写、模型、mkdir/recover/lease写为零；只读扫描、内存队列和对话传输允许。其它native/观测事件单独归属，不能计为Web效果。

### 5.2 `command.ts` 前后判定

改造前事实：

```text
createMemCommand.handler(args, ctx):
  await scopedRouter(args, ctx)
  ... 原 project handler ...
scopes.route:
  read => read
  !trustedNativeMemoryCommand => E_AUTHORITY
  session add => native registry.issue => enqueueCommand
bridge.mem => memoryRead(args)   // 写 unsupported
```

新增独立 Web 路由，native 不变：

```ts
export function executeConfirmedMemoryWrite(
  call: MemoryWebCall,
  request: MemoryWriteRequest,
  plan: FrozenPlan,
  receipt: MemoryCommandApproval,
  deps: {
    readonly kernel: CommandConfirmKernel;
    readonly currentOwnerMatches: (binding: MemoryWebCallBinding) => boolean;
    readonly store: Pick<SessionMemoryStore, "ownsWebPlan" | "enqueueConfirmedCommand">;
  },
): Promise<WriteOutcome>;
```

```text
binding = kernel.binding(call)
if no binding or !currentOwnerMatches(binding): NEEDS_HUMAN_COMMAND
if request.kind != session.add or plan.kind != session.add: UNSUPPORTED
if !store.ownsWebPlan(call, plan): PLAN_CHANGED
if !kernel.check(call, receipt, plan.commandPlan): CONFIRM_STALE
return store.enqueueConfirmedCommand(call, plan, receipt)

store FIFO:
  复核真实owner/manager/lease/gate/poison/唯一投影/完整entry/文件/预算
  if changed: revoke; PLAN_CHANGED / none
  if !kernel.consume(call, receipt, plan.commandPlan): STALE / none
  attempted = true
  append冻结entry一次; 真实fold/唯一H观察; 保存outcome
```

有效凭据是同kernel的opaque receipt、同call、同store plan引用/摘要、当前binding，不是confirm bit、ctx字段、session字符串或模型参数。store自己再次验证，`scopes/command.ts:96` native拒绝不删。

## 6. 关键决策、取消与风险边界

### 6.1 撤销线性化与完成观察

- prepare/确认等待时撤销：close call、关dialog，none；迟到肯定不mint/提交。
- 批准后排队时撤销：revoke/lease失效，队列出队只清理；none，无重试。
- **服务端撤销先于最终consume/append**：阻止写；最后同步检查保证迟到commit拒绝。consume后但attempt前若测试可重入撤销，最终guard仍可拒绝，receipt已耗尽不复活。
- **attempted=true的同步append**：不能抢占/回滚；正常JS abort handler随后执行。可重入故障夹具下未能观察效果则unknown，不说“已撤回”。
- append/真实fold已完成但Promise then未运行：已保存outcome优先，cancel返回completed/unknown，不报none。
- ledger已终态：不覆盖、不重复late；已完成写不能撤回，不把取消请求成功当业务取消成功。

**点击时间不等于服务端撤销线性化时间。** 浏览器点击→网络排队→handleAbort实际cancel之间，原写可能已完成；届时原mem结果必须显示completed/“写入已完成，无法撤回”，而不是“取消成功”。abort ack只表示会话级停止请求已处理。

cancel幂等且不是第二结果latch；观察缓存/释放必须严格按§4.2。同步append横跨deadline时，append前有效可以开始；其后无法硬中断，实际已完成结果优先于后来触发的超时。同步FS阻塞是公开限界。

### 6.2 生命周期与前端入口

- expireMemory/clearMemoryWaiters/onSessionBoundary/dispose先cancel取观察，再finish；不得仅收unknown却留下有效写权限。
- handleAbort在现有expect/session校验后撤当前owner memory任务，再ctx.abort；idle也必须处理memory任务。abort op不带target mem cmdId，是**会话级停止**，可能影响当前模型任务。
- owner.dispose先kernel/task撤销，再store.dispose；保留最终观察直到commands释放。复用wire/root既有session/tree/reload链，不加hook。
- Q2不承诺idle TUI ESC，不新增按cmdId独立取消协议。**但必须完成§7.3的idle可用浏览器入口**，不能只以后台abort存在认定闭合。
- dismiss只隐藏结果/失效展示回调，不发abort、不调用task.release或清服务端call。确认框取消是拒绝授权；批准后只能请求停止，不能回滚。
- 临时断网不等于用户拒绝；dialog detach/close/deadline撤授权，恢复不自动重弹；批准后的结果保留ledger供查询。

### 6.3 关键取舍

不复用native grant/handler，不伪造ctx；不用callback brand证明无detached；不持锁等人；不新建SDK不遵守的文件锁；不先删hard deny再补UI；不把其它领域API包一次确认就开放。session consumer的安全保证不外推到hub/migrate/import/restore/Jev。

### 6.4 Q1–Q3 裁定落地

- **Q1 有条件接受**：exact领域entry、同manager FIFO、确认期间文件身份/旧字节guard；8MiB整份JSONL硬界、100ms协作软预算。无跨进程原子CAS/fsync承诺；custom-only即使有sessionFile也可能尚未落盘。确认期间列举的五类外部变化须拒绝；SDK写入前/中/后的外部竞态作为残留风险。不得把有条件接受改成“完整文件CAS已经实现”。
- **Q2 有条件接受**：复用会话级abort，不加wire op/按cmdId撤销、不承诺idle TUI ESC；必须提供DetailDock idle可用按钮、身份检查、范围提示、真实全链撤销验收。S1未过不得注入生产memoryWrite。
- **Q3 接受**：不新增command record，不接beginExternal/record.sink/record.settle；history开关不影响独立结果卡，无记录保存成功承诺。

无新增待裁定设计项。若实现发现无法履行这些条件，停止对应开放步骤、保持fail-closed并回评审，不自行扩大权限或缩减验收。

## 7. 异步可见性、身份与浏览器撤销

### 7.1 三种身份

服务端权限用MemoryOwner.incarnation引用/actual manager/sid/file/sessionEpoch/branchGen；command派发用handler activation+单调代际；UI用`agentKey+sessionId+card.epoch+操作代际`。三者不可互当授权，不增加wire字段。

在UI types.ts新增本地类型：

```ts
interface MemoryUiKey {
  readonly cmdId: string;
  readonly owner: { readonly agentKey: string; readonly sessionId: string; readonly epoch: string };
  readonly operationGeneration: number;
}
// runCommand opts 追加可选 memoryUiKey，仅本地，绝不 spread 到 wire req
```

缺owner身份不自动用晚结果覆盖当前卡；scope切换、新操作、dismiss、unmount使旧展示回调失效。cmdId在发请求前mint，绝不按name找id。

### 7.2 唯一查询与结果通道

1. **DetailDock.vue**：mem分支放historyMode早返回之前，read/write都用直接结果卡；每个await/回执/fallback/观察都验证完整key，旧同名query不得覆盖新操作。dismiss失效key而非只置cmdResult=null。
2. **useControl.ts**：StoredRequest保存mem key；send/query回调dispatch带expectedKey，同key query single-flight；响应时要求请求仍存在且key未失效；只queryOnly，不retry。结果保存在既有pending item供Dock读取，Dock不再发第二个query。
3. **logic/control.js**：mem窄分支在通用CLOSED_STATES早退之前；terminal ctl和任意late都保留item并设querying/lateQuery。初始async回执不得倒退terminal/querying。inner result.ok=true读result.data.output，inner false读message/effect；unknown/expired不套通用E_UNKNOWN_ID=未执行推断。
4. **logic/state.js**：expectedKey精确比较，终态信号去重；pending item的memoryResult为≤32KiB纯数据；取回结果后重复late/ctl不再查询，不从旧事件新建item。
5. **useHub.ts:636–659**：唯一自动query执行点，配合useControl single-flight合并ctl/late；失败每次reconnect最多一次自动恢复，另可手动query，无高频轮询。
6. **CommandResult.vue不改内核**：复用文本output/message，unknown可映射failed视觉但明确“结果未知，可查询，勿直接重试”，不显示done/terminal-only。Dock外层data-cmd-id用于真实DOM验收。

mem本地request/结果最多32个，不被普通128请求churn提前逐出；满则拒新操作、不发写。运行中不按旧十分钟注释淘汰，终态按30分钟/用户dismiss释放；无localStorage/跨刷新审批恢复，丢id明示不可查、不自动重发。不是第二全局ledger。

### 7.3 S1：DetailDock 内 idle 可用的会话级停止动作

**文件域**：只在已列入写域的DetailDock.vue实现按钮、提示与点击handler，使用现有ControlHandle.abort；useControl/state/useHub的mem身份与query改动仍在原授权内。**禁止改Composer.vue**或让按钮依赖其busy判定。

- 位置：mem直接结果区旁的独立操作条，不塞入CommandResult通用渲染器。标签固定“停止本会话（尝试撤销记忆写入）”；常显说明“这是会话级停止，可能同时中止当前模型任务；已完成写入不能撤回。”dismiss标签/提示明确“仅隐藏结果，不停止操作”。
- 显示条件：本组件持有已发起mem写（等待准入/确认/执行或结果未知）的完整MemoryUiKey，且未确认原命令终态。只读mem无此按钮。history on/off相同；**不要求agent busy，不因isIdle=true隐藏/禁用**。
- 启用条件：control/commands权限仍有效、agent在线、当前agentKey/sessionId/epoch与捕获key相同、操作代际/cmdId仍为当前操作、无本次abort在途。owner缺失/换代/会话切换时禁用，必须重新定位当前操作，不向新会话盲发abort。
- 点击handler同步捕获key，重新比较当前owner/代际/cmdId及权限；检查与调用`control.abort(key.owner.agentKey)`之间不await。既有abort产生**自己的cmdId**并带expect.sessionId；不能用原mem cmdId发abort，不将UI token放wire。
- 立刻置本key的abortPending并禁重入，显示“正在请求停止；最终状态以记忆命令结果为准”。不乐观写none/failed/“取消成功”，不discard原mem请求，不清等待query的item。
- abort回执及finally再次比较key；过代回执不能改新卡。ok仅表示停止请求已处理，继续查询**原mem cmdId**（复用single-flight）；late/terminal ctl同时到来仍只一个flight。网络失败保留unknown及原请求，可查询；不自动重发abort/写命令。
- 原mem结果none且明确因撤销终结才显示“已停止，本步未执行”；completed显示“写入已完成，无法撤回”及id/持久化提示；unknown显示可能已写/勿盲重试；不能用abort的wasBusy=false推导mem未执行。
- dismiss仍只隐藏；未终态mem的轻量停止操作条可继续保留，须将“运行任务key”与“结果展示代际”分开：dismiss失效展示订阅，不失效仍在途任务的身份记录。操作条只允许对这份仍匹配当前owner的任务key停止，不把旧query恢复成已关闭结果卡。新操作/owner变化/unmount使旧操作条失效；此本地记录无服务端权限。
- **协议限界**：既有abort只携session期望，不提供目标mem cmdId/epoch撤销凭据。UI在发送与回调两端校验epoch/操作身份，服务端只在实际收到时停止当前匹配session；发送后的reload/网络竞态不能升级为按cmdId原子撤销承诺。会话级影响已向用户明示，不新增wire绕过限制。

按钮测试必须从实际Vue可见按钮点击开始，走既有ControlHandle.abort/transport、commands.handleAbort/task.cancel、原mem ledger/late/query及真实reducer/DOM。不能只spy abort函数或手工向组件塞“已取消”。详见§9的S1组。

## 8. I 窄 hunk、工作量与四包交付

### 8.1 三个装配文件仍由唯一 I 串行修改

- **src/index.ts**：`:250–269`不改，已有scopes/domain/sessionSignal足够；**只在`:1076–1078`**的plain+memory gate下保留memoryRead并追加可选memoryWrite。不得在根创建第二owner/kernel，不动其它imports/注册逻辑。没有这一参数就只有read seam，不能更小。
- **src/memory/index.ts**：`:35–43,91–108`增type-only契约/可选webWrite；`:421–448`返回前构造main/plain/session scope gate下的facade。**每次start取opts.scopes.current()**、验证actualCtx.manager，不在activate缓存owner；webRead不改Promise类型，native registerCommand不改。
- **src/web-hub/agent/index.ts**：`:326–328`增可选memoryWrite；`:922–931`向completion传内部memorySessionAdd；`:988–1007`向bridge传write及**闭包晚取的remote readiness**，因为wireDialogs在`:1442–1450`才构造，不得当场访问TDZ；`:1308–1371`仅write接线时增加独立memoryOwner=MODULE_INSTANCE，不改变hold owner行为。`:1928,1982,2462`沿用原边界调用，撤销逻辑放commands内部，不新hook。

这些hunk不能缩成只改一个类型：生产端口、实际owner、remote/终态和completion能力投影必须同时贯通；也不能扩大到整文件重写。message-speed/archive/settings/冻结fixture不在授权内。**S1浏览器全链验收未过之前，I不得注入生产memoryWrite。**

owner.ts现有`:76–115,178–208`新增lazy controller、同store getter、先撤销后dispose；scopes/wire.ts原生命周期链保持，不预授权新abort hook。

### 8.2 工作量与文件清单

估算：**实现18–19、测试/probe/tiers14–18、文档3，合计35–40个修改/新增文件**；不是把仅运行回归的文件也算作修改。

实现基线18文件：

- memory 6：`src/memory/command-policy.ts`、`command-confirm.ts`、`command.ts`、`scopes/session-store.ts`、`scopes/owner.ts`、`index.ts`。
- agent 5：`src/web-hub/agent/builtin-bridge.ts`、`commands.ts`、`command-policy.ts`、`command-complete.ts`、`index.ts`。
- UI 6：`src/web-hub/ui/src/types.ts`、`logic/control.js`、`logic/state.js`、`composables/useControl.ts`、`composables/useHub.ts`、`components/detail/DetailDock.vue`。
- 根1：`src/index.ts`。
- 可选第19个：仅当store体量需要时提取pi-free `src/memory/scopes/session-web-plan.ts`，集中唯一投影/只读guard；不得新增通用框架或第二hash codec。是否提取可由实现owner按内聚性决定，不扩大能力。

测试/probe/tiers基线14个**实际需新增/修改**的文件：

1. `tests/memory/command-confirm.test.ts`：bound call/deadline/revoke。
2. `tests/memory/command-policy.test.ts`：严格session.add语法/其它写拒绝。
3. 新`tests/memory/scopes/session-web-command.test.ts`：真实fold/consumer、B1四组、文件guard/预算/观察释放。
4. `tests/web-hub/agent/builtin-bridge.test.ts`：新写seam/no-fallback。
5. `tests/web-hub/agent/commands.test.ts`：abort、waiter、once、task释放。
6. `tests/web-hub/agent/ledger.test.ts`：32槽/TTL/迟到结果。
7. `tests/web-hub/agent/command-policy.test.ts`：窄放行与override。
8. `tests/web-hub/agent/command-complete.test.ts`：两处能力投影。
9. `tests/web-hub/ui/use-control.test.ts`：single-flight、身份、abort原请求保留。
10. `tests/web-hub/ui/detail-dock.test.ts`：真实reducer+DOM、history交叉矩阵、idle停止按钮；fixture必须接生产reducer，不只stub outcome。
11. 新`tests/integration/memory-web-command-confirm.test.ts`：生产装配、取消/终态与SDK缓冲。
12. 新`tests/conformance/memory-web-command-dispatch.test.ts`：真实SDK delayed settled/source回归。
13. 新`scripts/web-hub/memory-command-confirm-probe.ts`：真实浏览器全链，S1硬门。
14. `tests/tiers.ts`：I统一登记实际新增慢/进程测试；不是让各包抢写。

按fixture归属可额外修改4个既有测试，形成14–18区间：`tests/web-hub/ui/logic-control.test.ts`、`detail-dock-cmd-history.test.ts`、`tests/web-hub/agent/memory-lifecycle-wiring.test.ts`、`tests/memory/scopes/session-store.test.ts`。拆出这些文件只是测试组织，不减少对应矩阵断言。

文档3：本设计附件、`docs/dev/memory/README.md`、`docs/dev/web-hub/README.md`。**本次任务仅改本设计附件**；两个README待实现后记真实行为。

仅运行、不预授权修改的回归：native `session-ops/session-fold`、既有scoped模型/授权/poison、command-readonly、B1原语、capture/dialog、Web off/secure/边界/governance/frozen golden以及message-speed/archive定向回归。共享接口变更不能只靠typecheck；实际运行`tests/commands/`相关回归，禁止编造`tests/web-hub/commands`路径。fixture/SDK/planner/fold不为新Web hash迁就而改。

### 8.3 四职责包与串行门

1. **领域 kernel/store 包**：command-policy/confirm/command、session-store/owner（可选plan helper），及绑定/冻结/guard/观察单测。完成真实fold四组与取消观察，接口冻结后交I；不接生产端口，不改native语义。
2. **commands/bridge/policy 包**：新admission/control、先撤销后终态、32槽复用、窄policy/completion及agent测试；不写I的index hunk，不造第二latch。与UI包在契约冻结后并行。
3. **UI 身份/query/撤销包**：六个已列UI文件，统一查询、history无依赖、真实reducer/DOM矩阵、DetailDock idle按钮；Composer保持不动。提交可验证组件fixture给I，不能以按钮函数spy称S1通过。
4. **I 装配与真实SDK/浏览器验收包**：三文件窄hunk、tiers、整合/conformance/probe/两README；先用测试fixture连接全链，S1及其余门通过后最后注入生产memoryWrite。I独占共享文件，外部message-speed/archive hunk串行合并，不覆盖。

policy内部`memorySessionAdd`缺省false，只投影端口存在，非wire cap/授权。仅mem+session.add可越过scoped hard deny；显式deny/confirm仍生效，默认allow只表示启动业务确认。hub/其它写不受allow override放行。无新hook预期trace不变，不刷新frozen artifact。

## 9. 测试矩阵与验收断言

本次只设计，不运行实现测试。全部使用own tmp/HOME、生产组件/真实SDK或本地scripted provider；无真实模型/用户记忆/生产reload。下列矩阵按“场景→断言→建议文件”列出；§8.2区分修改与仅回归。

### 9.1 领域与授权矩阵

- **批准**：真实remote肯定callback→同kernel reserve/consume各一次；批准前append/mkdir/model=0；最终exact entry、H(after)、id/rev、grant.via=command；native handler=0。新session-web-command与integration。
- **拒绝/关闭**：branch和磁盘hash/mode/mtime不变、consume=0；late answer=false；旧call/receipt不可用。confirm与领域测试。
- **确认120s/墙钟29min**：ManualClock精确边界、timer未触发仍拒；队列迟到commit=0，无ref timer。confirm、commands。
- **撤销/观察所有权**：prepare、确认、排队、consume前后、attempt内可重入、append完成但Promise then未运行参数化；none/completed/unknown按阶段，releaseWeb发生在finish取观察之后；重复release/cancel不丢结果。领域与commands/integration。
- **B1-FP：fork继承+put**：真实历史sid分支经真实fold产生inherited；真实planner/consumer添加当前sid put；保留项外层inherited仍可存在，完整item/from/originSid/grant/rev不变；H(planned.after)=H(observed)，恰一次append、completed、不poison。
- **B1-SP：spawn继承+put**：真实合法seed snap带inherit，非第32次添加；同FP断言，不能用mock hash字符串代替fold。
- **B1-SNAP：fork/spawn各一例第32次**：构造真实31次计数并确认；真实planner产一个snap，sid=当前writer、无inherit、opsSinceSnap=0。真实fold按此清除外层派生继承标记；item持久来源字段保留，计划/观察H一致，append=1、completed、不poison。不要求原派生标记在新snap中保留。
- **B1-CAS：保留项/编号仍保护**：确认后分别改保留项正文、真实存储字段（from/originSid/grant）、有效revision及nextN/opsSinceSnap；使用合法条目/真实branch让真实fold重算，不仅mock摘要。即使条目数/leaf hint相同也PLAN_CHANGED、consume调用及成功次数=0、Web append=0，不重规划/重弹。单独证明只改变外层派生inherited不改变H，绝不能由此免除owner/branchGen门。
- 上述**四组必须走真实fold和生产consumer**，在新session-web-command测试；native planner/fold只回归不修改。另测dropped/顺序变化投影敏感，dropped非空prepare拒绝。
- **文件变化**：真实tmp确认后同大小改字节、恢复mtime、换inode、换symlink、absent→present逐例拒绝；消耗/append=0；不声称这些测试证明跨进程原子CAS。领域测试，真实竞争压力归tier2。
- **G1界值/软预算**：完整JSONL 8MiB界上/界外、读取中增长/截断；过大报入口不可用，零截断hash/consume/append/native fallback。单调fake clock在每次操作前后与最终consume前越过100ms（包括最后一次read返回才超时），都E_MEM_PLAN_BUDGET/none、consume=append=0；不能用真实睡眠证明硬抢占。
- **snap/容量**：第32次一次append；1024/1025B、48/49项、8192B、id耗尽拒绝不截断；8192B正文界和8MiBJSONL界独立。领域测试+session-ops回归。
- **复用/伪造**：重复批准、跨call/owner/kernel receipt、JSON伪call、无binding call、模型cap互传全拒，consume最多成功一次。confirm与领域测试。
- **无端口/通道**：write/admission/attach/remote缺失或throw，Feishu/legacy origin、RPC hasUI不补local select；框/append/native/SDK mem dispatch=0。bridge/integration。
- **busy**：owner单槽/FIFO满/host pending/compact/switch；零consume，无自动重试，批准后门变busy撤receipt；不编造本步没有的Jev orphan。领域/commands。
- **reload/tree/dispose**：同sid/file不同incarnation拒旧call，队列drain/旧callback不写；先撤销后清资源，poison跨reload不清。integration与lifecycle测试。
- **append故障**：gate在attempt前throw→none；append throw/thenable/真实after不符→unknown+poison；无retry/SDK删尾，恢复仅原explicit reopen协议。领域/session-store测试。

### 9.2 真实 SDK、ledger 与来源矩阵

- **持久且已有conversation**：实际SDK已flush的临时session，Web一次append，branch/文件与entry相符，但不做fsync承诺。
- **有sessionFile但custom-only、尚无conversation**：实际SDK sessionFile getter有值、文件可以不存在；批准Web add后真实branch有entry，SDK首次flush前磁盘可能仍不存在。输出必须提示缓冲，不以“appended”假称已落盘。之后通过实际SDK追加conversation触发flush，确认原entry只出现一次；不由Web自动触发conversation/flush。
- **memory-only**：实际SDK无sessionFile，零磁盘guard/文件创建，branch生效、persistence=memory-only；三类都走实际manager/append，不能全用fake append。
- **ledger**：async回执仅reply-only；32满拒绝、普通512 churn不逐出未过期mem、终态30min保留；重复cmdId不start/弹框，不同payload拒；timeout/正常/abort竞速once，结果复制后release一次。
- **SDK来源回归**：真实settled hook barrier超过capture fallback TTL；Web mem即时seam，放drain后native=0、sendUserMessage/session.prompt的mem=0。conformance归tier2，不以fake ctx替代。

### 9.3 UI 交叉矩阵：真实 reducer 与 DOM

`history on/off × ctl先到/late先到 × 无覆盖/同名新操作覆盖` 共8组为最小交叉集；再覆盖重复帧、终态早于async回执、失败/unknown结果、dismiss、换session、同sid新epoch、unmount。使用生产Vue组件、真实logic/state+control reducer、useControl/useHub链，不用手工给cmdResult赋字符串。

每组断言：当前data-cmd-id可见DOM包含正确领域code/effect/message/持久化或恢复提示；inner false绝非done；旧A query barrier延迟到B后不覆盖B；ctl/late共用一个flight，不倒退running、不重执行。history off不构造recorder；history on即使其它record append抛错也不丢结果，本步beginExternal/sink/settle调用为0。

> 30秒用确认barrier覆盖，agent ManualClock推进，浏览器实际看到running后再看到终态；不能以sink/title/ledger字符串替代可见DOM。query失败/重连/expired只query，unknown不标未执行，request churn保留mem；页面刷新丢id不自动发新写。

### 9.4 S1 浏览器硬门：真实按钮→abort→cancel→ledger→DOM

1. **idle等待确认**：实际Web会话idle、未进入SDK回合，发送session add；DetailDock mem按钮可见且enabled。真实点击→已有op:abort→生产handleAbort→task.cancel；原mem ledger none/stale、query后DOM“本步未执行”；consume/append=0；abort自身ok不能提前显示业务取消成功。
2. **批准后、提交前**：测试fixture在commit入队边界设置受控barrier（不改变生产apply同步性），真实remote批准后按钮仍idle可用；点击并确认服务端cancel已线性化，再放barrier；consume/append=0、一次原mem终态，无迟到写。
3. **点击先、服务端后**：延迟abort传输，让原同步append先完成；再释放abort。原mem必须completed/id可见，明确无法撤回；不报none/“取消成功”。验证点击时间不是撤销线性化时间。
4. **同步attempt/观察**：consumer单测注入可重入cancel得到unknown；另例真实同步append完成、done微任务尚未消费时timeout/cancel得到已保存completed。两者都不因release顺序丢观察；DOM以ledger终态为准。
5. **身份/权限**：agent/session/epoch变化、同名新操作、旧按钮handler迟到时不向新目标发abort；abort回执迟到不覆盖新结果。重复点击同key仅一次abort；断网后不自动重发，原mem保持可查询unknown。
6. **范围/隐藏**：按钮说明“会话级停止，可能同时中止当前模型任务”真实可见；模型后来开始时仍不伪称仅撤mem。dismiss仅隐藏、不发abort/删服务端任务，保留操作条则按其任务key验证；history on/off均验证。不修改Composer，也不借Composer busy按钮完成此用例。

probe建议`scripts/web-hub/memory-command-confirm-probe.ts`，复用现有offline-first Playwright loader，不安装依赖。退出2为不可用，不是通过。I以本组真实浏览器证据作为生产memoryWrite注入前门禁，组件spy/单元通过不替代。

### 9.5 下游门禁与范围回归

定向修改测试→typecheck→test:tier1→相关tier2/conformance→真实浏览器probe；接口fake需实际执行对应测试，不能仅凭typecheck。native add不增加确认、模型无HumanTurn仍拒、其它写全拒、同步read字节/形态不变、Web off零新kernel/hook，frozen artifact不重生。build/发布门按仓库流程另行执行；本次未执行这些实现门禁，不报告虚假通过。

## 10. 风险、回退与 fail-closed

- **保留风险**：FIFO只协调同manager/store；文件guard能检测确认期间变化，不能阻止最后检查后、SDK写入前/中/后的外部writer。同步syscall无硬抢占；100ms只是协作软预算。SDK缓冲/首次flush及fsync边界必须在结果/README明示。
- **最高误实现风险**：删除真实item来源字段来“修hash”、更改native继承语义、提前release观察、任意async/detached apply。分别用唯一投影/真实四组/释放顺序/封闭consumer阻断。
- **UI风险**：后端abort存在不代表用户能点；history分支、ctl乱序、同名旧query、idle按钮都是独立门。停止是会话级、网络有延迟，不能承诺点击立即撤回。
- **投递界**：ledger纯内存有界，普通reload保留窗可查；进程崩溃/永久断网/过期不保证结果可得，不假报成功或未执行。
- **回退点**：I不传或移除根`:1076–1078`的memoryWrite，保留memoryRead；policy能力随端口缺失deny。卸载前先cancel/finish/release在途任务，不单纯断端口遗留权限。已写session entry不删除、不回滚历史。
- **实现失败**：缺binding/consumer/remote/admission/cancel/release/能力位均拒绝；部分包合入不开放生产。S1或领域矩阵失败时保持端口未注入，不能先放行再补测试。
- **最低安全线**：所有Web mem从未进入SDK slash/native；撤销Web永不变native；旧call/cap不跨代复活，模型/native授权不借路。
- **禁止扩域**：hub/迁移/record写、idle TUI ESC、跨进程锁、新wire/setting、Composer修改需另行授权并更新写域/验收，不能为修测试偷偷扩大。

## 附录 A. 结构化交接数据

本轮仅更新此Markdown中的JSON；调用方上轮已提取的`/tmp/web-mem-confirm-design-handoff.json`仍是旧版，请按需重新提取。本角色不直接写JSON文件，不声称外部文件已同步。格式检查结果以交付回执为准；正文不伪造实现测试证据。

```json
{
  "document": "/home/bluecake/ai/pi-toolkit/docs/dev/memory/web-write-seam-design.md",
  "revision": "r2: B1/S1/G1/G2 and Q1-Q3 review dispositions",
  "baseline": "caller-specified HEAD 1996647e; worktree read directly; no git verification",
  "conclusion": "只开放session add；同owner私有call/receipt、同store FIFO领域冻结与同步append；唯一规范化fold投影剔除外层inherited但保留完整item；DetailDock提供idle可用的会话级停止；终态/观察释放和UI身份闭环共同过门后I才注入生产端口。",
  "designPoints": [
    "before/planned-after/observed-after统一session-memory-fold/v1：保留顺序、完整item/rev、nextN、opsSinceSnap、dropped，仅剔除外层inherited；不改native planner/fold",
    "fork put、spawn put、fork/spawn第32次snap、保留项/来源/rev/nextN变化四组走真实fold/consumer",
    "8MiB是完整session JSONL硬界；100ms是单调elapsed clock的协作软预算，逐操作前后及最终consume前检查，超时零consume/append",
    "exact领域entry+同manager FIFO+旧文件guard，不承诺跨进程原子CAS/fsync；有sessionFile的custom-only仍可能首次flush前未落盘",
    "DetailDock mem按钮不依赖busy，调用现有ControlHandle.abort；校验agent/session/epoch/操作身份，明示会话级影响，不改Composer或wire",
    "点击不等于服务端撤销线性化，attempt后同步append不可抢占，已完成返回completed而非取消成功",
    "commands.finishMemory取完观察后finally调用control.release，owner task缓存纯数据outcome再releaseWeb；不提前丢失completed观察",
    "history on/off独立结果卡，不接beginExternal/record.sink/record.settle；真实Vue reducer+DOM交叉验证乱序和同名覆盖",
    "I保留三文件窄hunk、按次取owner、remote readiness闭包晚取；S1真实浏览器验收未过禁止生产memoryWrite注入"
  ],
  "reviewDispositions": {
    "B1": "已修订唯一投影及真实继承四组；实施验收待做",
    "S1": "已定义idle可用按钮、会话级abort语义和真实全链硬门；实施验收待做",
    "G1": "已区分8MiB硬字节界与100ms协作软预算",
    "G2": "已按四职责包重估并区分修改测试与仅运行回归",
    "Q1": "有条件接受；文件竞态/SDK缓冲/fsync边界及五类外部变化测试为实施条件",
    "Q2": "有条件接受；不承诺idle TUI ESC/按cmdId撤销，但必须有S1浏览器入口",
    "Q3": "接受；不新增command record"
  },
  "openQuestions": [],
  "pendingAcceptance": [
    "真实fold/consumer的继承四组和真实SDK持久、custom-only缓冲、memory-only三类",
    "真实按钮到abort/cancel/ledger/query/DOM，含点击早但服务端撤销晚的completed竞速",
    "history on/off × ctl/late乱序 × 同名覆盖的真实Vue reducer/DOM交叉矩阵",
    "文件guard五类变化、8MiB界值、单调软预算与finish后观察释放"
  ],
  "estimatedChanges": {
    "implementationFiles": "18-19",
    "modifiedTestProbeTierFiles": "14-18",
    "documentationFiles": 3,
    "totalModifiedFiles": "35-40",
    "regressionOnly": "native planner/fold、模型授权、只读、B1原语、capture/dialog、off/secure/boundary/governance/golden及外部功能回归不计入修改数"
  },
  "deliveryPackages": [
    "领域kernel/store与真实fold冻结验证",
    "commands/bridge/policy与撤销/终态",
    "UI身份/query/idle撤销与真实reducer/DOM",
    "I三文件装配、tiers、真实SDK/浏览器验收与README"
  ],
  "evidence": [
    {
      "claim": "真实fold含派生inherited而planned.after只有item/rev，新snap无inherit且sid为当前writer",
      "file": "src/memory/scopes/session-fold.ts; src/memory/scopes/session-ops.ts",
      "lines": "80-98,128-162;140-177,180-194"
    },
    {
      "claim": "现有abort是会话级操作，可复用wire但需新增idle可用UI入口及memory cancel",
      "file": "src/web-hub/ui/src/composables/useControl.ts; src/web-hub/agent/commands.ts",
      "lines": "200-208;855-873"
    },
    {
      "claim": "SDK有sessionFile但无conversation时可能不persist；envelope由SDK生成",
      "file": "node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js",
      "lines": "795-823,913-923"
    },
    {
      "claim": "bridge构造早于wireDialogs，remote readiness必须闭包晚取",
      "file": "src/web-hub/agent/index.ts",
      "lines": "988-1007,1442-1450"
    }
  ],
  "ruledOut": [
    { "target": "修改native planner/fold迁就hash", "why": "只规范化Web投影，不能改现有继承语义" },
    { "target": "剔除item来源字段", "why": "originSid/from/grant是真实存储内容，必须参与hash" },
    { "target": "复用Composer busy停止按钮", "why": "本功能idle运行；未授权改Composer，须在DetailDock独立入口" },
    { "target": "任意runLocked/native handler", "why": "不能证明无detached或保持Web/native授权隔离" },
    { "target": "完整新JSONL hash/100ms硬抢占", "why": "SDK生成envelope且可缓冲，同步syscall不可由JS timer抢占" },
    { "target": "command record作为结果通道", "why": "Q3已接受不新增record，history开关不能影响终态" }
  ],
  "fileIndexReference": "第2节为核验坐标，第8节为实现/修改测试/仅回归清单；按列出片段读取，不宣称长文件全部通读",
  "verification": "本轮仅允许文档prettier --check；无实现测试/构建/安装/git/commit；具体格式结果见交付回执",
  "handoffExtraction": "附录A已更新；外部/tmp JSON需调用方重新提取，本轮未直接写该文件"
}
```
