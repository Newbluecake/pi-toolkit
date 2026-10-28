# bash auto-background — 实施方案（v1）

> 只读调查 + 本文档，不含实现。目标：让 pi 的内置 `bash` 工具支持「执行超过阈值自动转后台」——
> 工具调用提前返回 `job_id`（进程不杀，输出持续写日志文件），模型后续用管理工具查看状态、
> 收取增量输出、终止进程；进程结束时注入完成通知。语义对齐现有 Agent auto-background
> （见 docs/dev/auto-background/plan.md）。行号均已对照当前代码与 pi@0.84.4 dist 复核。

## 0. 核实基线

- **同名覆盖机制**（pi dist/core/agent-session.js `_refreshToolRegistry` :2096-2145）：
  先把内置工具 definition 放入 `definitionRegistry`/`toolRegistry`（Map），再把扩展工具
  `set()` 进去——**同名扩展工具覆盖内置**，且 LLM 看到的 description/promptSnippet/
  promptGuidelines 也以扩展版本为准。多个扩展同名时 `getAllRegisteredTools()`
  （dist/core/extensions/runner.js:324-335）**首个注册 wins**。官方先例：
  examples/extensions/tool-override.ts、sandbox/。
- **内置 bash 工具结构**（dist/core/tools/bash.js）：`createBashToolDefinition(cwd, options)`
  → `createShellToolDefinition`。execute 内联做了：spawnContext 解析（PI_* env）、
  `OutputAccumulator`（未公开导出）、节流 onUpdate、`formatOutput`（截断页脚文案）、
  错误包装（"Command aborted" / "Command timed out after N seconds" /
  "Command exited with code N"）。进程执行全部收敛在可替换的
  **`BashOperations.exec(command, cwd, { onData, signal, timeout, env })`**——
  内置实现 `createLocalShellOperations`（bash.js:44-118）：`spawn(shell, args, { detached:
非win32, stdio: [ignore|pipe, pipe, pipe] })`，stdout/stderr **合并进同一个 onData**
  （:90-91，内置本就不分流）；abort/timeout 均 `killProcessTree(pid)`；timeout 是
  **杀进程语义**（不能复用做转后台）。
- **pi 公开导出**（dist/index.d.ts:24）：`createBashToolDefinition`、`createBashTool`、
  `createLocalBashOperations`、`createLocalPowerShellOperations`、`BashOperations`、
  `BashToolOptions`、`DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES`、`truncateTail`、`formatSize`、
  `getShellConfig`（:35）、`getAgentDir`（:2）。**未导出**：`OutputAccumulator`、
  `killProcessTree`、`waitForChildProcess`、`trackDetachedChildPid`、`getShellEnv`。
- **ToolDefinition.execute 签名**（dist/core/extensions/types.d.ts:342-377）：
  `execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext)`；`ctx.cwd`（:217）
  在调用时可用——**覆盖工具可以在 execute 内按当次 ctx.cwd 现建 definition**。
- **detached 子进程跟踪**：内置 localOps 会 `trackDetachedChildPid(pid)`，进程退出才
  untrack；`killTrackedDetachedChildren()` 在 pi 的 **interactive / print / rpc 三种模式**的
  SIGTERM/SIGHUP 处理器里都会被调用（另有 interactive 的 `emergencyTerminalExit` 与
  `uncaughtCrash`），*不是*只有 RPC（#73 调查，grep pi `dist/` 核实；本条此前「仅 RPC」已过时）。
  但它只杀**登记过**的 pid：`trackDetachedChildPid` 不在 pi 的公共导出里，本仓自己
  `spawn` 的 job 从未登记，所以 pi 不会杀我们的 job；TUI `/quit`、Ctrl+C/D 走
  `shutdown()` → `runtimeHost.dispose()` → `process.exit(0)`，也不调用它。记为已知边界（§11）：
  若将来改成复用 pi 的 localOps，`keep` 会在上述信号下被 pi 杀掉。
- **本仓既有件**：settings 加载/校验（src/config/settings.ts:104-176 模式）；
  `/agent settings` SETTING_SPECS（src/commands/status.ts:121-147）；holder 转发 +
  assembly-only index.ts（src/index.ts）；buildSessionStack 组装 + previousX dispose
  模式（src/stack.ts:52-58, 89-98）；通知注入 `pi.sendMessage({customType,
content, display:true, details}, {triggerTurn:true})`（stack.ts:160-200）；
  notifier 的 `DeliveryPayload` 强绑定 `runId:generation`（src/core/types.ts:311-327）；
  id 生成 CROCKFORD 8 位 `r_XXXXXXXX`（src/core/ids.ts:13-21）；目标解析
  exact→prefix→label（src/service/resolve-target.ts:114-134）；Agent 降级文案与
  details 结构（src/tools/agent-tool.ts:329-337，relay 模式 :266-285）。

## 1. 总体架构与调用流程

```
模型调用 bash(command, timeout?)
   │  pi 路由到本扩展注册的同名 bash 工具（覆盖内置）
   ▼
src/bashjobs/bash-tool.ts execute
   │  按 ctx.cwd 现建 createBashToolDefinition(cwd, { operations: autoBgOps })
   ▼
autoBgOps.exec（src/bashjobs/ops.ts）
   │  ① manager.begin()：分配 job_id、开日志流、写 status.json(running)
   │  ② 调 pi 的 createLocalBashOperations().exec（原信号经 relay 转发，
   │     onData tee 到日志文件 + 原 accumulator）
   │  ③ race(进程退出, autoBackgroundMs 阈值)
   ├── 阈值前退出 → 正常返回 { exitCode }（definition 走内置 formatOutput，
   │     结果与内置逐字节一致）；manager.discard() 清理 job 文件
   ├── 阈值前 abort/timeout → 原样抛错（"Command aborted"/"Command timed out…"），
   │     行为与内置一致；清理 job 文件
   └── 阈值先到 → relay 关门（此后调用方 abort 不再传导）、manager.background()、
        抛 BACKGROUNDED 哨兵 → definition 原样 rethrow → bash-tool 捕获哨兵 →
        返回 job_id 文案 + details { jobId, background: true }
        进程继续跑；exitPromise 由 manager 持有
             │
             ▼ 进程终态（退出/被杀/超时）
        manager 收尾：关日志流、写 status.json 终态、触发 onFinished
             │
             ▼
        stack.ts 回调 → pi.sendMessage(customType "bashjob:finished",
        triggerTurn: true) 注入主会话
             │
             ▼
模型用 bash_job 工具：action=list / output（增量收日志）/ kill
```

## 2. bash 覆盖工具设计（src/bashjobs/bash-tool.ts）

### 2.1 注册与复用策略

- activate() 中 `pi.registerTool(createBashOverrideTool(deps))`，name 恒为 `"bash"`。
- **静态表面整体复用**：模块内以 `createBashToolDefinition(process.cwd(), {})` 建一次
  `proto`，注册对象取 `proto` 的 `label / parameters / promptSnippet / promptGuidelines /
constrainedSampling / renderCall / renderResult` 原样转发——schema、renderers、
  截断页脚、TUI 卡片与内置完全一致（这是「短命令结果与内置完全一致」的结构性保证：
  执行路径本身也是 `proto` 同款 definition，只换了 operations）。
- `description` = proto.description + 追加一段（阈值与 bash_job 工具的存在，§8 文案）。
- **cwd 处理**：definition 的 cwd 是构造期烘入的，而工具注册发生在 activate（无 session
  cwd）。因此 execute 内**每次调用现建** `createBashToolDefinition(ctx.cwd, { operations })`
  并委托其 execute——definition 构造是纯函数、廉价；renderers 不读 cwd，用 proto 的即可。

### 2.2 新参数

- **v1 不加 `run_in_background`**：保持 parameters 与内置逐字节一致，最大兼容
  （provider 侧 constrained sampling、缓存的 tool schema 均不变）。模型想立刻后台化可在
  command 里自己 `nohup … &`，或等阈值。列为开放问题（§13）。

### 2.3 阈值竞态与哨兵（ops.ts 核心伪代码）

```ts
export const BACKGROUNDED = Symbol.for("pi-subagent:bash-backgrounded");
type BackgroundedError = Error & { [BACKGROUNDED]?: { jobId: string } };

// autoBgOps.exec(command, cwd, { onData, signal, timeout, env }):
const mgr = deps.manager(); // holder 转发到当前 session stack
const thresholdMs = deps.autoBackgroundMs(); // 0 = 关闭（纯透传，见下）
if (thresholdMs <= 0 || mgr === undefined)
  // 关闭/无 session：完全透传
  return deps.localOps.exec(command, cwd, { onData, signal, timeout, env });
const job = mgr.begin({ command, cwd }); // 分配 j_id、开日志、status.json(running)
const relay = new AbortController();
let forwardAbort = true; // 状态门（同 agent-tool relay 语义）
const onAbort = () => {
  if (forwardAbort) relay.abort();
};
// signal?.aborted → relay.abort()（保持内置"已 aborted 仍 spawn 立即取消"语义）
// signal 否则 addEventListener("abort", onAbort, { once: true })
const exitP = deps.localOps.exec(command, cwd, {
  onData: (d) => {
    job.write(d);
    onData(d);
  }, // tee：日志 + 内置 accumulator
  signal: relay.signal,
  timeout,
  env,
});
mgr.attach(job.id, exitP); // 终态收尾 + 通知（无论前后台）
const waited = await raceExitOrDelay(exitP, thresholdMs); // delay timer 必须 unref()
if (waited.kind === "threshold") {
  forwardAbort = false;
  signal?.removeEventListener("abort", onAbort); // 统一清理序
  mgr.background(job.id); // status.json 记 backgroundedAt
  const err: BackgroundedError = new Error("bash job backgrounded");
  err[BACKGROUNDED] = { jobId: job.id };
  throw err; // definition catch 只特判 aborted/timeout:，原样 rethrow
}
// 进程先终态：mgr.discard(job.id)（删 job 目录，前台命令不留痕），原样返回/抛错
```

外层 `bash-tool.ts` execute：

```ts
try {
  return await def.execute(toolCallId, params, signal, onUpdate, ctx);
} catch (err) {
  const bg = (err as BackgroundedError)?.[BACKGROUNDED];
  if (bg) return backgroundResult(deps.manager()!.get(bg.jobId)!); // §8 文案
  throw err;
}
```

**哨兵安全性**：Symbol.for 键不会与 pi 内部的 `"aborted"`/`"timeout:"` 字符串判据碰撞；
definition 的 catch 分支（bash.js:325-340）对非特判错误原样 rethrow，哨兵必达外层。

### 2.4 abort signal 语义（正式化）

| 时机             | 原 signal abort 的效果                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| 阈值前           | 经 relay 传导 → localOps killProcessTree → "Command aborted"（与内置一致）                                           |
| 阈值后           | 状态门已关 + listener 已摘 → **进程不受任何影响**（唯一的停止手段变成 bash_job kill / 模型 timeout / shutdown 策略） |
| 进入时已 aborted | relay 立即 aborted，localOps 立即取消（与内置一致）                                                                  |

清理统一顺序 `forwardAbort = false → removeEventListener`，阈值/正常终态/异常三条路径
都走（try/finally 收拢），与 auto-background §2.1 同款。

### 2.5 timeout 参数语义（有意保留）

模型给的 `timeout`（秒）原样透传给 localOps——**转后台后依然生效**：超时被
killProcessTree 杀掉，job 终态 `timed_out`，照常发完成通知。理由：timeout 是模型对
「这条命令最多跑多久」的显式声明，转后台不应静默放大进程寿命。写进 description 追加
文案，避免模型误以为后台 = 无超时。

### 2.6 平台处理

- posix：localOps detached spawning → pgid == pid，kill 用 `process.kill(-pid, sig)`
  （自实现，pi 的 killProcessTree 未导出；先 SIGTERM、grace 后 SIGKILL）。
- win32：localOps 走 taskkill /F /T；本功能仍生效，但**跨重启 reattach 禁用**（§3.5），
  pi 退出后进程存活不保证。powershell 工具不覆盖（开放问题，§13）。

## 3. BashJobManager / job 模型（src/bashjobs/manager.ts + store.ts）

### 3.1 job id 与状态机

- id：`j_` + 8 位 CROCKFORD（仿 core/ids.ts，`newJobId(exists)`，exists 查内存 map +
  磁盘已有 status 文件）。与 runId `r_` 前缀区分，互不碰撞。
- 状态机：`running` →（`exited` | `killed` | `timed_out` | `lost`）。
  - `exited`：exitCode 已知（本进程观察到的退出）；exitCode null = 信号杀死。
  - `killed`：经 bash_job kill / shutdown 策略杀死。
  - `timed_out`：模型 timeout 触发 localOps 杀进程（exitP reject "timeout:"）。
  - `lost`：重启后发现 pid 已死或 pid 复用校验失败、且无人记录过退出码——
    「pi 不在场时结束」，exitCode 未知。
- 内部另有瞬态：`foreground`（阈值前的 job，discard 时不落终态）——不暴露给模型。

### 3.2 pid/pgid 与进程组终止

- status.json 记录 `pid`；posix 下 pgid == pid（detached），kill 走 `-pid` 进程组，
  SIGTERM → `killGraceMs`（默认 2_000，unref 定时器）→ SIGKILL 升级。
- 终止判据（reaper-orphans plan §2、§7.2–§7.3）：以「进程组是否为空」（`kill(-pgid, 0)`）而非组长 pid 存活判定；
  组长已死但成员残留时 grace 后仍整组 SIGKILL。这不违反 §3.3/§11「宁可漏杀」：Linux 保证只要组内
  还有成员 pgid 就不会被复用，故 starttime/pgrp==pid 守卫通过后非空组必为本 job 所有（pid_max 可能仅
  32768，回收的 pid 还须 setpgid 自立为组长才可能误中，窗口极窄）。仅 Linux 有此钉住保证，
  非 Linux 暴露面与旧行为相同；EPERM 视为非空（同 uid spawn 下不可达）。
- win32：`taskkill /F /T /PID`（复制 pi shell.js:184-210 的做法，System32 绝对路径）。

### 3.3 日志文件布局与上限

```
<logDir>/                              默认 join(getAgentDir(), "bash-jobs")
  <job-id>.output.log                  stdout+stderr 合并流（与内置 onData 语义一致）
  <job-id>.json                        状态文件（tmp + rename 原子写）
```

- **合并单流是有意决策**：内置 bash 的 onData 本就合流（bash.js:90-91），模型看到的输出
  也是合流；分离双流必须放弃 localOps 自实现 spawn（§11 已拒绝）。结论写入 README。
- 上限 `maxLogBytes`（默认 10 MiB）：写满后追加一行 `\n[pi-subagent] log truncated at
<n> bytes; process keeps running\n` 标记并**停止写入**（不滚动、不截头——进程继续跑，
  简单可预测）；status.json 记 `logTruncated: true`。
- 前台完成的 job：`discard()` 删除两个文件，不留痕（内置对截断输出另有 /tmp 全文文件，
  该路径不变）。

### 3.4 状态持久化：JSON 文件（选定），不写 session custom entry

| 方案                      | 优点                                                                                          | 缺点                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **JSON 状态文件（选定）** | 跨 pi 重启可发现存活 pid；生命周期独立于 session（job 本就比 session 长寿）；实现简单、可单测 | 无 read-back 校验；多 pi 实例并发操作同一 job 需自管（见 §11）                                   |
| session custom entry      | 复用 G5a read-back 验证体系                                                                   | job 跨 session/重启存活与 entry 的 session 绑定语义冲突；session 切换后 job 记录不可见，反而误导 |

### 3.5 重启/reload 恢复（reconcile）

`buildSessionStack` 构建 manager 后同步调用 `manager.reconcile()`（不阻塞启动，仿
stack.ts notifier.reconcile）：

1. 扫 `<logDir>/*.json`；非 running 的直接载入索引（供 list/output 查历史）。
2. state=running 的：
   - **pid 存活探测**：`process.kill(pid, 0)`；
   - **pid 复用防护**（非 win32）：spawn 时读 `/proc/<pid>/stat` 第 22 域 starttime 记入
     status.json；reconcile 时重读比对，不一致 → 视为原进程已死、pid 被复用 → `lost`；
     读不到 /proc（macOS 无 /proc！——改用 `ps -p <pid> -o lstart=` 或仅记录
     `startedAt` + cmdline 比对，实现时按平台能力降级，降级路径只信 kill(pid,0) 并在
     status.json 标 `pidGuard: "weak"`）。
   - 存活且校验通过 → **reattach**：unref 轮询（默认 2s，可配）探测存活；死亡时若
     `<jobId>.exit` 存在则按其退出码落 `completed`/`failed`（#73；原稿写的 recorder 续体
     从未实现），否则置 `lost`（即 `exited_unknown`）。
3. **reload 同进程场景**（/reload、session 切换）：旧 stack dispose 时进程未被杀
   （detached），live handle（含 tail 读取器、WriteStream、`processExitPromise`）经
   `exportLocalJobs`→`adoptLocalJobs` 移交给新 manager，由新 manager 重新 `finalizeLocal`
   并落终态（`notifiedAt` 幂等键避免重复通知）。_原稿设想的「纯 fs recorder 续体」在实现里
   并不存在；整进程退出的情形由 #73 的 exit 文件覆盖（见 §3.6）。_
4. 重启期间结束的 job：reconcile 发现 → 下次 session_start 注入一条合并摘要
   （一条 sendMessage 列全部，triggerTurn: true），保证完成通知不丢（弥补不走 notifier
   outbox 的缺口，§5）。

### 3.6 孤儿清理策略（session_shutdown）

- 配置 `shutdownPolicy: "keep" | "kill"`，**默认 "keep"**：session_shutdown / /reload
  不杀 job（进程 detached 本就独立于会话）。
- **#73 修订——"keep" 现在在「pi 进程整体退出」下也成立。** 原设计只论证了 `/reload`（同进程：
  live handle 经 `exportLocalJobs`→`adoptLocalJobs` 移交，管道没关）；**"detached" 只解决了
  进程组/信号隔离，没解决 stdio 生命周期**：job 的 stdout/stderr 当时是接到 pi 的管道，pi
  一退出读端关闭，job 下一次写就收到 SIGPIPE，退出码随 `wait()` 丢失，重启后只能报
  `exited_unknown`，且日志为空（输出发生在 pi 退出之后）。正文里的「recorder 续体」代码里并不
  存在（`/reload` 靠的是 live handle 移交）。现在的机制：
  - job 的 stdio **直接是日志文件 fd**（`stdio: ["ignore", logFd, logFd]`），日志由 job 树自己写；
    外层 `/bin/sh` 包装脚本在内层 shell 退出后把退出码原子写进 `<jobId>.exit`（tmp+rename），
    并用 `dd bs=512 | cat >/dev/null` 在 job 树内部封顶（写满后继续排空，命令不收 SIGPIPE，
    §3.3 的「写满后进程继续跑」语义不变）；
  - pi 侧的 `stdout` 是日志文件的 tail 读取器，只负责 `onData` 实时中继与计数；
  - 恢复（`recover()`、轮询 tick、`kill()` 无本地 handle、deadline 兜底）里凡判 `dead`
    先读 `<jobId>.exit`：有 → `completed`/`failed(exitCode)` + footer + 正确的 `logBytes`，
    并走正常的启动摘要通知；无（整组被 SIGKILL 等）→ 仍 `exited_unknown`。
  - `JobRecord` schema 不变（`v:1`），exit 路径由 jobId 派生。
  - 已知取舍：外部 `kill -TERM <shell>` 变成 `failed (exit 143)`；pi 不在场时没人执行
    `timeout`/grace（deadline 仅存在于 pi 内存，重启后 adopt 的 job 不再有 deadline）。
    实现细节与残余风险见 `docs/dev/bash-timeout-grace/README.md`「#73」一节。
- `"kill"`：shutdown 时对 running job 按 §3.2 升级序列杀（有界 drain，
  `min(killGraceMs*3, 10_000)`，仿 index.ts:182-191）。
- 注意边界：pi 自己的 `killTrackedDetachedChildren`（interactive/print/rpc 的信号处理器都会调，
  见 §0）只杀它登记过的 pid；本仓自己 spawn 的 job 未登记，所以不受影响（文档此前写成
  「仅 RPC、会杀我们的 job」，已更正）。

### 3.7 并发上限

`maxBackgroundJobs`（默认 8；0 = 不限）。达上限时**不杀不拒**（进程已在跑），而是本次
不转后台、继续前台等（文案不动，行为退化为内置）。已在后台的不受影响。

## 4. 管理工具设计（src/bashjobs/job-tool.ts）

**选择：单个 `bash_job` 工具 + action 判别联合**（typebox `Type.Union` 或
`action: Type.Enum + 可选参数字段`）。

权衡：Agent 侧是一动作一工具（steer/abort/result 四个），但那是 4 个高频主流程工具；
bash job 是低频二级实体、无 label/registry 体系，三个独立工具会显著膨胀 system
prompt 与 tool 列表（每个都有 schema/description 开销），且动作间共享 job_id 解析
逻辑。单工具 + action 与 `/agent settings` 的子命令风格一致。

- actions：
  - `list`：全部已知 job（id、state、exitCode、命令预览 60 字、运行时长、logBytes）。
  - `output { job_id, offset?, tail? }`：从 `offset`（字节，默认 0；`tail: N` = 最后 N 行）
    读日志，返回 `{ content, nextOffset, state, exitCode?, logTruncated }`——增量收取
    协议；输出本身过 `truncateTail`（复用 pi 导出）防单条结果爆上下文。
  - `kill { job_id, force? }`：SIGTERM → grace → SIGKILL（force=true 直接 SIGKILL）。
    幂等：终态 job 返回 `{ ok: true, alreadyTerminal: true, state }` 正常结果，不 throw
    （对齐 abort_subagent 的 already_terminal 语义，auto-background §3.1）。
- job_id 解析：exact → 唯一前缀（复刻 resolve-target.ts matchRunId 的两段式；
  job 无 label，不做第三段）。失败/歧义抛带候选列表的自纠错错误。
- renderCall：`Bash Job: <action> <job_id?>` 单行（仿 steer-tool 模式）。

## 5. 完成通知

- **不复用 notifier**：DeliveryPayload 强绑定 `runId:generation`（core/types.ts:311），
  硬塞会污染 outbox key 域与 reconcile 语义。采用**直发** `pi.sendMessage`（stack.ts 提供
  `onFinished` 回调注入 manager，保持 manager 无 pi import）：

```ts
pi.sendMessage(
  {
    customType: "bashjob:finished", // 与 "subagent:notification" 明确区分
    content: formatBashJobFinished(job), // 见 §8
    display: true,
    details: { jobId, state, exitCode, durationMs, logPath },
  },
  { triggerTurn: true },
);
```

- 代价与补齐：直发无 outbox 持久化——进程在 pi 重启/reload 间隙结束时通知会丢。
  由 §3.5-3/4 的 reconcile 启动摘要补齐（终态且 `notifiedAt` 未置位的 job 合并为一条
  注入，置位幂等）。
- 多个 job 同 tick 结束：manager 侧 200ms unref 合并窗，凑批为一条消息（简易 coalesce，
  不复用 delivery/coalescer——它吃 DeliveryPayload）。

## 6. 配置项（settings.ts 新增 `bashJobs` 块 + status.ts SETTING_SPECS）

```ts
export interface BashJobsSettings {
  enabled: boolean; // 默认 true；false = 完全透传（连 job 文件都不建）
  autoBackgroundMs: number; // 默认 120_000；0 = 关闭自动转后台
  logDir?: string; // 默认 join(getAgentDir(), "bash-jobs")
  maxLogBytes: number; // 默认 10 * 1024 * 1024
  maxBackgroundJobs: number; // 默认 8；0 = 不限
  killGraceMs: number; // 默认 2_000
  shutdownPolicy: "keep" | "kill"; // 默认 "keep"
  reattachPollMs: number; // 默认 2_000
}
```

- **默认阈值 120s 而非 Agent 的 600s**：bash 调用是高频内联操作，前台阻塞时主会话
  完全卡死且无任何并行手段（Agent 前台等待至少有 1Hz progress 与 watchdog）；
  构建/测试类命令 2-10 分钟常见，600s 下用户体验等于没有此功能。代价是模型在
  120s 后多一次 bash_job output 往返——可接受。列为开放问题（§13）。
- loadSettings 逐字段容错校验（同现有模式：typeof/finite/>=0，否则回落默认）；
  `parseBashJobsSettings(value.bashJobs)` 仿 parseWorkflowSettings。
- SETTING_SPECS 加：`bashJobs.enabled` BOOL、`bashJobs.autoBackgroundMs` MS、
  `bashJobs.maxLogBytes` {number,min:1024}、`bashJobs.maxBackgroundJobs` COUNT、
  `bashJobs.killGraceMs` MS、`bashJobs.shutdownPolicy` enum、`bashJobs.logDir` string、
  `bashJobs.reattachPollMs` MS。全部为「/reload 后生效」语义（与现有非 budget key
  一致，提示语无需改）。

## 7. UI

- **不进 fleet widget**（选定）：fleet 面板行构建全部读 `RunSnapshot.diag`
  （fleet-panel.ts:258-266），job 无 run 状态机/deadline/phase，塞进去要平行造一套
  数据源，收益不成比例。
- **`/agent status` 增加 "Bash jobs" 段**（选定）：`renderStatus` 尾部追加
  `Bash jobs: N running, M finished`，列 running 的前 5 条（id、命令预览、elapsed）。
  deps 增加可选 `bashJobs?: { list(): readonly BashJobSnapshot[] }`，缺席（测试/最小
  host）时不渲染该段。
- 转后台的 bash 调用卡片：复用 proto renderResult，details 无 truncation → 渲染输出
  文本 + "Took xs"，可接受；v1 不做定制渲染。

## 8. 与 Agent auto-background 的语义一致性

转后台返回文案（与 agent-tool.ts:329 同构："仍运行 → 未停止 → 完成通知 → 收口工具"）：

```
Command is still running after <fmt(threshold)> and has been moved to the background
(job_id: j_XXXX). The process was NOT stopped — it keeps running and you will receive a
completion notification when it exits; output so far and future output are appended to
<logPath>. Use bash_job(action: "output", job_id: "j_XXXX") to read incremental output,
or bash_job(action: "kill", job_id: "j_XXXX") to stop it. Note: a timeout you passed to
this call still applies and will kill the process.
```

- details：`{ jobId, background: true, autoBackgrounded: true, logPath }`（对齐 Agent 的
  `{ runId, background: true, autoBackgrounded: true }`）。
- 完成通知 content 前缀固定 `[bash job]`，与 subagent 通知（`[subagent]` 系）一眼区分。
- bash 工具 description 追加："If a command runs longer than the configured
  auto-background threshold (~<fmt>), the call returns early with a job_id — the process
  keeps running in the background; collect output with bash_job(action: \"output\") and
  stop it with bash_job(action: \"kill\"). Any timeout you pass still applies."
- bash_job description/promptSnippet 仿现有工具风格；`formatAgentTypesForPrompt` 不动
  （那是 Agent 工具协议段）。

## 9. 文件清单

### 新增

| 文件                        | 职责                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/bashjobs/types.ts`     | `BashJobState`、`BashJobRecord`（status.json 形状）、`BashJobSnapshot`、结果类型；无 node/pi import 之外的依赖                                                                             |
| `src/bashjobs/ids.ts`       | `newJobId(exists)`（`j_` + CROCKFORD 8）                                                                                                                                                   |
| `src/bashjobs/store.ts`     | status.json 原子读写、扫描、日志追加写（带 maxLogBytes 截断标记）；纯 fs                                                                                                                   |
| `src/bashjobs/kill.ts`      | killProcessTree 自实现（posix `-pid` 进程组 / win32 taskkill 绝对路径）+ pid 存活与 starttime 校验                                                                                         |
| `src/bashjobs/manager.ts`   | `BashJobManager`：begin/attach/background/discard/get/list/output/kill/reconcile/dispose（recorder 续体、幂等通知、reattach 轮询 unref）；通过构造参数接收 `onFinished` 回调，不 import pi |
| `src/bashjobs/ops.ts`       | `createAutoBackgroundOps(deps)`：BACKGROUNDED 哨兵、relay、tee、阈值竞态（§2.3）                                                                                                           |
| `src/bashjobs/bash-tool.ts` | `createBashOverrideTool(deps)`：proto 复用 + 每调用现建 definition + 哨兵捕获 + §8 文案                                                                                                    |
| `src/bashjobs/job-tool.ts`  | `bash_job` 管理工具（§4）                                                                                                                                                                  |

### 修改

| 文件                                          | 改动                                                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/settings.ts`                      | `BashJobsSettings` + DEFAULT + parse（§6）                                                                                                                                              |
| `src/stack.ts`                                | Stack 增加 `bashJobs: BashJobManager`；buildSessionStack 构建（注 onFinished → pi.sendMessage、previousBashJobs dispose 模式）、reconcile 调用、session_shutdown 按 shutdownPolicy 处理 |
| `src/index.ts`                                | 注册 bash 覆盖工具 + bash_job 工具（holder 转发 `forwardBashJobs`，同既有模式）；session_shutdown 调 manager 的 shutdown 钩子                                                           |
| `src/commands/status.ts`                      | SETTING_SPECS + renderStatus 的 Bash jobs 段（§7）                                                                                                                                      |
| `README.md` / `README.en.md` / `CHANGELOG.md` | 功能说明、settings、行为变化（bash 工具被覆盖）                                                                                                                                         |

### 测试（tests/ 镜像）

`tests/bashjobs/store.test.ts`、`kill.test.ts`（mock process.kill/spawn）、
`manager.test.ts`、`ops.test.ts`、`bash-tool.test.ts`、`job-tool.test.ts`、
`tests/config/bash-jobs-settings.test.ts`、`tests/commands/status.test.ts`（追加）、
`tests/integration/bash-jobs-wiring.test.ts`。

## 10. 测试计划（vitest；mkdtemp/tmpdir + FakeClock + vi.useFakeTimers 惯例）

用例矩阵（覆盖探索结论 §4.3 的 12 类并细化）：

| #   | 场景                                                                                                                                                                    | 测试                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| C1  | 短命令透传：结果文本/details 与内置 formatOutput 逐字节一致（含截断页脚、exit≠0 抛错文案）                                                                              | ops/bash-tool 单测（stub localOps）；断言 def.execute 被委托 |
| C2  | 阈值到 → 返回 job_id 文案 + details；进程未杀（localOps stub 仍 pending）；日志已含阈值前输出                                                                           | ops 单测 fake timers                                         |
| C3  | 阈值前 abort 原 signal → relay 传导、抛 "aborted"、job 文件已 discard                                                                                                   | ops 单测                                                     |
| C4  | 阈值后 abort 原 signal → 进程不受影响的（relay 门关 + listener 摘）                                                                                                     | ops 单测 + I2 真实 relay                                     |
| C5  | 进入时已 aborted → 立即取消（透传内置语义）                                                                                                                             | ops 单测                                                     |
| C6  | timeout < 阈值 → "Command timed out after N seconds"，无 job 残留                                                                                                       | ops 单测                                                     |
| C7  | timeout > 阈值 → 转后台后被 localOps 杀 → 终态 timed_out + 通知                                                                                                         | manager 单测                                                 |
| C8  | 增量 output：offset 续读、tail N、截断标记、终态后仍可读                                                                                                                | store/manager/job-tool 单测                                  |
| C9  | kill：running → TERM→KILL 升级序列；已终态 → alreadyTerminal 幂等返回；未知 id → 抛候选错误；前缀解析 exact/唯一前缀/歧义                                               | manager + job-tool 单测                                      |
| C10 | 完成通知：退出/被杀/超时三态各触发一次（幂等 notifiedAt）；多 job 同 tick 合并一条                                                                                      | manager 单测（spy onFinished）                               |
| C11 | 持久化/恢复：reconcile 发现存活 pid → reattach 轮询 → 死亡落 lost（#73 起：有 `.exit` 文件则采用其退出码）；pid 复用（starttime 不符）→ lost；终态未通知 → 启动摘要一条 | manager 单测（mock kill(pid,0)/procfs 读取）+ I3             |
| C12 | 日志上限：写满标记 + 停写 + status logTruncated；output 可读标记                                                                                                        | store 单测                                                   |
| C13 | shutdownPolicy：keep（dispose 后 job 与日志继续；终态由 live handle 移交或 `.exit` 文件恢复，#73）/ kill（升级序列 + 有界 drain）                                       | manager 单测 + I4                                            |
| C14 | 并发：maxBackgroundJobs 达上限 → 不转后台继续前台；多 job 并行互不串日志                                                                                                | manager/ops 单测                                             |
| C15 | 设置解析：默认值、0 关闭、非法值回落；/agent settings set/reset bashJobs.*                                                                                              | config/commands 单测                                         |
| C16 | 关闭语义：enabled=false 或 autoBackgroundMs=0 → ops 完全透传（不建 job、relay 不存在、signal 直传断言 `===`）                                                           | ops 单测                                                     |
| C17 | win32 分支：kill 走 taskkill 参数、reattach 禁用置 lost（mock platform）                                                                                                | kill/manager 单测                                            |

集成（tests/integration/bash-jobs-wiring.test.ts，仿 wiring.test.ts 真实组件装配）：

- I1：真实 createBashToolDefinition + stub localOps 全链路：前台完成/阈值转后台/哨兵
  穿过 definition catch 不被误吞（防 pi 升级改 catch 分支的回归哨兵）。
- I2：真实 relay + 真实定时器：转后台后 abort 原 signal，进程 stub 存活；随后退出，
  onFinished 触发。
- I3：manager 接真实 tmpdir store：写 running → 新 manager reconcile → reattach →
  kill(pid,0) 转死 → lost；终态未通知 → 启动摘要。
- I4：stack 级 shutdown：keep/kill 两策略下 dispose/shutdown 钩子行为（spy kill）。

## 11. 风险与边界

| 风险                                     | 处理                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 其他扩展先注册同名 bash（首个注册 wins） | 无法检测；README 写明「pi-subagent 需在扩展加载序中靠前」；compat 层后续可探测 getToolDefinition("bash") 来源并 warn（列入开放问题）               |
| pi 升级改 definition catch 分支吞掉哨兵  | I1 集成测试钉死「哨兵穿透」行为；pi peer 版本本就钉 >=0.84 <0.86                                                                                   |
| 日志膨胀                                 | maxLogBytes 硬上限 + 截断标记 + 前台 job discard 不留痕；终态 job 文件 TTL 清理（reconcile 时删 > 7 天的终态 job，对齐 workflow replayTtlMs 惯例） |
| 长进程跨 session/重启                    | JSON 状态文件 + reconcile + `.exit` 退出码文件（§3.5/§3.6，#73）；pi 的 killTrackedDetachedChildren 只杀登记过的 pid，不含本仓 job（§0）           |
| 并发 job 失控                            | maxBackgroundJobs 软上限（§3.7）；日志目录总大小不做硬治理（记录为已知缺口）                                                                       |
| 误杀别人进程                             | kill 只接受本扩展发的 job_id；kill 前校验 status.json pid 与 starttime；reattach 的 job 校验失败置 lost 后**拒绝 kill**（宁可漏杀）                |
| 模块级可变状态                           | 全部状态在 manager 实例；stack 重建走 previousBashJobs dispose 模式；timer 全 unref                                                                |
| pi -p（print 模式）                      | 覆盖同样生效；unref 定时器保证不 wedge；通知 sendMessage 在 print 模式同样 triggerTurn                                                             |
| 同机多个 pi 实例并发                     | job id 全局唯一 + status 原子写；kill/output 以文件为准；不做跨进程锁（已知缺口，job 由产生它的实例管理）                                          |

## 12. 实施步骤拆解（可独立验收的子任务）

| #   | 任务                                                                                         | 文件域                                                                                   | 依赖                | 验收                                   |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------- | -------------------------------------- |
| S1  | settings：BashJobsSettings + parse + SETTING_SPECS + 测试                                    | src/config/settings.ts、src/commands/status.ts（仅 SPECS）、tests/config、tests/commands | 无                  | C15 绿                                 |
| S2  | job 纯域：types + ids + store（fs 持久化/日志上限） + kill.ts                                | src/bashjobs/{types,ids,store,kill}.ts + 对应测试                                        | 无                  | C8(store 部分)/C12/C17(kill) 绿        |
| S3  | manager：生命周期/状态机/通知幂等/合并窗/reconcile/dispose 续体/shutdown 策略                | src/bashjobs/manager.ts + 测试                                                           | S2                  | C7-C11、C13、C14(manager 部分) 绿      |
| S4  | ops + bash 覆盖工具：relay、哨兵、阈值竞态、proto 复用、文案                                 | src/bashjobs/{ops,bash-tool}.ts + 测试                                                   | S3                  | C1-C6、C14、C16、I1、I2 绿             |
| S5  | bash_job 管理工具                                                                            | src/bashjobs/job-tool.ts + 测试                                                          | S3                  | C8(tool)/C9 绿                         |
| S6  | 接线：stack.ts（bashJobs 构建/onFinished 通知/reconcile/shutdown 钩子）+ index.ts 注册与转发 | src/stack.ts、src/index.ts、tests/integration                                            | S3、S4、S5          | I3、I4 绿；typecheck/format/build 全绿 |
| S7  | /agent status 的 Bash jobs 段                                                                | src/commands/status.ts + 测试                                                            | S3、S6（deps 形状） | 渲染测试绿                             |
| S8  | 文档：README×2、CHANGELOG、本 plan 的 as-built 校正                                          | docs、README                                                                             | S6                  | —                                      |

依赖图：S1/S2 并行 → S3 → S4 与 S5 并行 → S6 → S7/S8。
文件域交叉：仅 status.ts（S1 改 SPECS、S7 改渲染）与 stack.ts/index.ts（全部归 S6
一人），派工时 S1 与 S7 不并行或先后合入。

## 修订（2026-10-17）：shell 解析对齐 pi 内建 bash（$SHELL 不再读取）

**背景（用户报告）**：`$SHELL=/bin/zsh` 时，模型写的 bash 语法跑在 zsh 下——未匹配
通配符报 `no matches found`、数组/分词语义漂移。而 pi 自己的内建 bash 工具默认用
bash（`dist/utils/shell.js` `getShellConfig`：显式 `shellPath` → Unix 分支
`/bin/bash`（existsSync）→ `which bash` → `sh`；从不读 `$SHELL`）。

**新解析链**（`src/bash/process.ts` `resolveShell`，纯函数 ladder + 默认链）：

1. `settings.bashJobs.shellPath`（显式优先，不变）；
2. **pi 自己的 `shellPath`**（`SettingsManager.getShellPath()`：`~` 展开、
   项目覆盖全局，读法与 `src/runtime/session-driver.ts` 一致；新文件
   `src/bash/pi-shell.ts`）；
3. pi 的默认链：`/bin/bash` → `which bash` → `sh`（逐字节镜像
   `getShellConfig` 的 Unix 分支；每次 spawn 重解析，与 pi 每次 exec 重解析一致）。

**$SHELL 不再参与**。basename 白名单（bash/zsh/sh，`ALLOWED_SHELL_BASENAMES`）
改为约束两个显式 settings 路径（含显式 zsh 仍合法）；fish/nushell 等奇异 shell
一律落入下一级而非以 `-c` 使用。与 pi 的一个刻意分歧：pi 对不存在的自定义
`shellPath` 直接 throw，本插件降级为 spawn 自身的 ENOENT（`staged → failed`），
绝不炸会话构建。

**`shellCommandPrefix` 同步对齐**：pi 的 `createShellToolDefinition` 对每条命令做
`` `${prefix}\n${command}` ``（内建 bash 工具与 `!`/`!!` 同享）。覆盖工具把该 prefix
透传给内层 `createBashToolDefinition`，由 pi 自己的 execute 前置——前景、自动后台、
显式 `run_in_background` 全部生效（job 记录的是实际运行的带 prefix 命令）。

**读取时机**：主会话在 stack 构建时读一次（session_start，非 live，存于
`Stack.bashShell`，index.ts 的工具注册经 getter 取 prefix）；子会话在
`wireChildBashJobs`（= activate）读一次，与现有 `bashJobs` 设置同节奏。两处
processPort（主 manager + 恢复端口）均注入 `piShellPath`。

测试：`tests/bash/process.test.ts`（新 ladder + `$SHELL` 忽略 + spawn 级回归）、
`tests/bash/pi-shell.test.ts`（新增）、`tests/tools/bash-tool.test.ts`（prefix
前置，前景/后台/passthrough）。

## Session isolation follow-up

后台 bash job 的实现细节已由 [bash-jobs-session-isolation/plan.md](../bash-jobs-session-isolation/plan.md) 定稿并实施：存储 root 按 session 分层，支持进程内句柄交接、冷启动孤儿收养、flat 迁移和死 session GC。

## 13. 开放问题（需拍板）

1. bash 是否加 `run_in_background?: boolean`（立即后台）？v1 默认不加（保 schema 逐字节
   一致）。
2. 默认阈值 120s（本方案）还是与 Agent 对齐 600s？
3. win32 是否同步覆盖 `powershell` 工具（createPowerShellToolDefinition 同构可复用）？
   v1 默认不做。
4. 是否需要 getToolDefinition("bash") 来源探测 + warn（被其他扩展抢先时）？
5. 终态 job 文件 TTL 默认 7 天是否合适；要不要 `/agent` 子命令手动清理？
