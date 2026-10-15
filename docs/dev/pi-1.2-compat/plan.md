# pi 1.2.0 适配实施方案（plan.md，2026-10-15）

姊妹文档：`baseline.md`（真机测试基线）、`explore.md`（调用点盘点）。本文给下游开发 agent 用：
每一条都写明文件:行号（行号以主工作区 HEAD = c807d62 为准）、具体改法和验收方式。
本方案阶段的实验都在 `/tmp/pt-pi12`（pi 1.2.0）和一个临时的 pi 1.1.0 源码树里做（`git archive HEAD`
解出来，node_modules 软链到主工作区；做完已删除）。实验脚本与 T1 试修 diff 存档在
`/tmp/pt-pi12-logs/plan-experiments/`（`zz-s4-debug` / `zz-s4b` / `zz-busy-debug` / `zz-wake-debug`
四个 vitest 文件 + `t1-fix.diff`）。worktree 已还原，只剩 baseline 自带的 package.json/lock 改动。

---

## 0. 需用户拍板的决策

> **2026-10-15 用户已拍板：D1=A、D2=A、D3=B、D4=A（全部采纳推荐项）。**

| #   | 决策点                                                                                | 选项                                                                                                                                                                                                              | 推荐  | 理由（一句）                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `systemPrompt.wakeReplay` 回放层（`src/sysprompt/wake-replay.ts`，默认 true）怎么处理 | **A** 代码和默认值都不动，只补文档，再加一条 conformance 钉子证明它在 1.2 下已冗余；**B** 结构性自动跳过（hub 记录“本 run 走过 before_agent_start”，走过的 run 不回放）；**C** 默认改 false；**D** 按 pi 版本跳过 | **A** | 实测 1.2 下 pi 自己的强制投影最后执行、每次都盖掉回放结果（字节零差异），1.1 下回放仍然必要；B 两版输出字节相同、只省一点 CPU，却多出 run 边界状态，一旦出错会回退 1.1 的缓存；C 让 1.0/1.1 用户回到唤醒轮 prefix 分叉；D 违反 I14（`pi-compat.ts` 头注释：版本号只能用于 WARN 文案） |
| D2  | title 在 pi 1.2 唤醒 run（`messageType:"custom"`）上的行为                            | **A** handler 直接早退：不计数、不起首标、不累计 busy 时长；**B** 只计数、不起首标；**C** 当用户轮处理                                                                                                            | **A** | 和 1.1（唤醒轮根本不经过该 handler）逐字节一致，也符合 `docs/dev/title/plan.md:97`“唤醒轮不计入用户输入”的原拍板                                                                                                                                                                      |
| D3  | 不带 `deliverAs` 的 `sendUserMessage` 加固范围                                        | **A** 只改 3 个 compact/switch 续跑闭包（`src/index.ts:355/563/593`）；**B** A 加上 `src/topic-switch/command.ts:123`（新会话 withSession 投递）；**C** 都不改                                                    | **B** | 实测 1.2 下 busy 时（启动窗口现在包含 `_prepareRun` 全程）不带 deliverAs 会被拒，报错只进 extension_error，文本静默丢失；idle 时两版都忽略 deliverAs，加上之后行为逐字节不变                                                                                                          |
| D4  | 1.1 不回退怎么守                                                                      | **A** 本次 PR 验收时手工在 1.1 源码树跑一次 tsc + 定向测试（§3.5）；**B** 另加常驻脚本或 CI 矩阵                                                                                                                  | **A** | peer 下限要到下次升级才动，一次性核验的成本最低；常驻矩阵可以另开 todo                                                                                                                                                                                                                |

> 下文默认按推荐项（D1=A、D2=A、D3=B、D4=A）展开；用户改选时只影响 §3.3、§5、§6.1 对应段落。

---

## 1. 结论速览

| 问题                                                       | 根因                                                                                                   | 改哪里                                                                                                                                 | 包                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| R1 版本范围                                                | peers `<1.2.0`、`SUPPORTED_PI_RANGE.maxExclusive 1.2.0`（hub 硬失败，RH1–RH4 挂掉）、`TESTED_PI_RANGE` | §2，照搬 b86b86a 那 10 个文件                                                                                                          | A                   |
| T1 编译失败                                                | `BeforeAgentStartEvent` 在 1.2 改成按 `messageType` 区分的 union，`custom` 分支没有 `prompt`           | 新增结构性 helper `readBeforeAgentStartTrigger`（放 `src/adapters/pi-compat.ts`），title 和 feishu-notify 改用它；hub 和 date **不改** | A                   |
| T1′ 3 个连带失败（package-zip / request-threading / wc14） | 都会跑 tsc/build                                                                                       | T1 修好后自动恢复（已实测：15 个文件 302 项全绿）                                                                                      | A                   |
| C1 S4 callCount 期望 3 得到 2                              | **测试的等待条件过时**；产品代码没问题，I2 成立                                                        | 只改测试：S4 改等待条件，新增 S4b 钉住 1.2 的连发语义                                                                                  | B                   |
| C2 RH1–RH4                                                 | 和 R1 是同一个原因                                                                                     | R1 修好即恢复                                                                                                                          | A                   |
| wake-replay                                                | 1.2 原生修复后，回放层被 pi 的投影完全覆盖                                                             | 按 D1 定                                                                                                                               | B（只改文档和测试） |
| 5（+1）处不带 deliverAs 的 sendUserMessage                 | 1.2 busy 时被拒、静默丢失                                                                              | 按 D3 补 `{ deliverAs: "followUp" }`                                                                                                   | B                   |
| compact onComplete / `__go` 跳板 / consult reachesTools    | 见 §6                                                                                                  | 不改（compact 那条由 D3 兜住）                                                                                                         | —                   |

---

## 2. 版本范围（R1）—— 包 A

照搬 `git show b86b86a` 的标准动作，边界整体右移一个 minor。**peer 下限 `1.0.0` 不动**。

| 文件:行                                                  | 现状                                                                 | 改为                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json:48-50`                                     | 三个 peer `">=1.0.0 <1.2.0"`                                         | `">=1.0.0 <1.3.0"`（pi-ai / pi-coding-agent / pi-tui 三个一起改）                                                                                                                                                                                                                                                                                         |
| `package.json:65-67`                                     | devDeps `"^1.1.0"`                                                   | `"^1.2.0"`                                                                                                                                                                                                                                                                                                                                                |
| `package-lock.json`                                      | —                                                                    | 改完 package.json 后在主工作区执行 `timeout 600 npm install --no-audit --no-fund` 重新生成（1.2 去掉了 `@earendil-works/chord`、pi-client/protocol/server，lock 会大幅缩小，参考 `/tmp/pt-pi12` 的 `git diff --stat package-lock.json`：+34/−481）。验证 `npm ls @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-tui` 全是 1.2.0 |
| `src/adapters/pi-compat.ts:130`                          | `TESTED_PI_RANGE = "1.0.0 - 1.1.0"`                                  | `"1.0.0 - 1.2.0"`                                                                                                                                                                                                                                                                                                                                         |
| `src/adapters/pi-compat.ts:252-253`                      | 注释 `<1.2.0`；`major === 1 && (minor === 0 \|\| minor === 1)`       | 注释 `<1.3.0`；`major === 1 && minor >= 0 && minor <= 2`                                                                                                                                                                                                                                                                                                  |
| `src/web-hub/protocol/spawn.ts:695`                      | `maxExclusive: "1.2.0"`                                              | `maxExclusive: "1.3.0"`                                                                                                                                                                                                                                                                                                                                   |
| `tests/adapters/pi-compat.test.ts:38`                    | `["1.2.0", "2.0.0"]` 应 warn                                         | `["1.3.0", "2.0.0"]`                                                                                                                                                                                                                                                                                                                                      |
| `tests/adapters/pi-compat.test.ts:46-47`                 | 标题写 `(1.0.x and 1.1.x)`，列表 `["1.0.0","1.0.2","1.1.0","1.1.5"]` | 标题改 `(1.0.x, 1.1.x and 1.2.x)`，列表追加 `"1.2.0","1.2.7"`                                                                                                                                                                                                                                                                                             |
| `tests/web-hub/hub/spawn/launcher-check.test.ts:130`     | 坏例 `"1.2.0"`                                                       | 改成 `"1.3.0"`                                                                                                                                                                                                                                                                                                                                            |
| `tests/web-hub/hub/spawn/launcher-check.test.ts:138-143` | 只测 1.1.0 在范围内                                                  | 改成 `for (const v of ["1.1.0","1.2.0"])` 的范围内正例（或照抄再加一个 `1.2.0` 的 it）                                                                                                                                                                                                                                                                    |
| `tests/web-hub/hub/spawn/supervisor.test.ts:1150`        | `badPkgFs("1.2.0")`                                                  | `badPkgFs("1.3.0")`                                                                                                                                                                                                                                                                                                                                       |
| `tests/web-hub/protocol/spawn.test.ts:313`               | `{ min: "1.0.0", maxExclusive: "1.2.0" }`                            | `maxExclusive: "1.3.0"`（`:312` 和 package.json 互镜的断言会自动跟上）                                                                                                                                                                                                                                                                                    |
| `AGENTS.md:735`                                          | “pinned to `>=1.0.0 <1.2.0`”                                         | `>=1.0.0 <1.3.0`                                                                                                                                                                                                                                                                                                                                          |

另外：

- `tests/conformance/tui-harness.ts`：pi-tui 1.1→1.2 的 `Terminal` 接口**逐字未变**（已 diff `dist/terminal.d.ts`），FakeTerminal 不用补 stub。
- `tests/web-hub/hub/hub-spawn.test.ts:71-76` 的 fixture 写死 1.0.0，仍在范围内，不改。
- 其它 docs（`docs/dev/web-hub-spawn/**` 等）里历史版本号的描述不锁行为，不改。

---

## 3. `BeforeAgentStartEvent` 兼容（T1）—— 包 A

### 3.1 helper：放 `src/adapters/pi-compat.ts` 文件末尾（`isWithinTestedRange` 之后）

选这个位置，是因为它本来就是“结构性探测 pi 形态”的 compat 模块、不 import pi，title 和 feishu-notify
都在 post-guard，引用它不会引入循环依赖。**参数类型故意写成 `unknown`**：如果直接 import 1.2 才有的
`BeforeAgentStartUserEvent` 等类型名，或在 1.1 的 interface 上访问 `.messageType`，1.0/1.1 的类型面
都编译不过（peer 下限不变，代码必须两边都能编译）。已实测：同一份代码在 pi 1.2 下完整 `npm run typecheck`
exit 0，在 pi 1.1 源码树下 `tsc --noEmit -p tsconfig.json` exit 0。

```ts
/**
 * before_agent_start trigger shape (docs/dev/pi-1.2-compat/plan.md §3). pi 1.0/1.1 fire the event
 * only for prompt()-started runs and carry `prompt` with no `messageType`; pi 1.2 makes it a union on
 * `messageType` ("user" + prompt/images | "custom" + message, no prompt) and ALSO fires it for
 * `sendMessage(…, { triggerTurn: true })` wake runs. Read structurally off `unknown` on purpose:
 * importing 1.2-only type names, or touching `.messageType` on the 1.1 interface, would not compile
 * against the 1.0/1.1 peer floor. This is a shape probe, not a version gate (I14).
 */
export type BeforeAgentStartTrigger = { kind: "user"; prompt: string } | { kind: "custom" } | { kind: "unknown" };

export function readBeforeAgentStartTrigger(event: unknown): BeforeAgentStartTrigger {
  if (event === null || typeof event !== "object") return { kind: "unknown" };
  const e = event as { messageType?: unknown; prompt?: unknown };
  if (e.messageType === "custom") return { kind: "custom" };
  // Unknown future kinds are treated as "not a user prompt" (fail-safe for user-only handlers).
  if (e.messageType !== undefined && e.messageType !== "user") return { kind: "unknown" };
  return typeof e.prompt === "string" ? { kind: "user", prompt: e.prompt } : { kind: "unknown" };
}
```

语义表（单测要逐行覆盖）：

| 输入                                              | 来源                  | 结果        |
| ------------------------------------------------- | --------------------- | ----------- |
| `{ prompt: "x", systemPrompt }`（无 messageType） | pi 1.0/1.1 的所有 bas | `user("x")` |
| `{ messageType: "user", prompt: "x", images }`    | pi 1.2 用户轮         | `user("x")` |
| `{ messageType: "custom", message }`              | pi 1.2 唤醒轮         | `custom`    |
| `{ messageType: "other", prompt: "x" }`           | 未来新 kind           | `unknown`   |
| `{ systemPrompt }` / `null` / `"str"`             | 畸形输入              | `unknown`   |

### 3.2 `src/feishu-notify/index.ts:504-506`

```ts
pi.on("before_agent_start", async (event) => {
  // pi ≥1.2 also fires this for wake runs (no prompt): keep the current user task's prompt.
  const start = readBeforeAgentStartTrigger(event);
  if (start.kind === "user" && start.prompt) taskPrompt = start.prompt;
});
```

import 加在 `:42` 之后：`import { readBeforeAgentStartTrigger } from "../adapters/pi-compat.js";`。
行为和现状等价：custom run 上 `taskPrompt` 保留上一条用户任务（`:505` 原来的 `if (event.prompt)`
守卫本来就是这个效果）。`agent_start` 的 `isUserRun` 判定（`:510-531`，靠 `input` 事件置位
`userInputPending`）在唤醒 run 上本来就不会命中，不受影响。

### 3.3 `src/title/index.ts:234-239`（D2=A）

```ts
pi.on("before_agent_start", (event, ctx) => {
  // pi ≥1.2 also fires this for sendMessage(triggerTurn) wake runs (messageType "custom"). Those are
  // not user input (docs/dev/title/plan.md:97): skip counting / first title / busy-time entirely —
  // byte-for-byte the pi 1.0/1.1 behavior, where wake runs never reached this handler.
  const start = readBeforeAgentStartTrigger(event);
  if (start.kind !== "user") return;
  ctxRef.current = ctx;
  trigger.onBeforeAgentStart(start.prompt, buildDeps(ctx));
});
```

- import 加在 `:32` 之后。变量**不要**叫 `trigger`，会和 `:226` 的 `const trigger` 撞名。
- 同时修正 `src/title/title.ts:427-428` 的注释：“所有 before_agent_start 都计数”改为“所有**用户类**
  before_agent_start（1.2 的 messageType=user；/goal 续轮、compaction/switch_context 恢复、web 投递都
  走 sendUserMessage，属于 user）都计数；唤醒轮由接线层 `src/title/index.ts` 过滤”。`title.ts` 核心
  逻辑不改。
- 早退之后：唤醒 run 不碰 `inputSeq/inputsSinceGen/runStartedAt`。`agent_end/agent_settled` 在 1.1
  的唤醒 run 上本来也会触发（`onAgentSettled` 看到 `runStartedAt === undefined`，不累计 busy），和 1.1
  完全一致。这也顺手修掉了 explore §1.2 提到的 `prompt.trim()` 对 undefined 抛错的路径。
- `docs/dev/title/plan.md:97` 追加一句：pi ≥1.2 唤醒轮会经过 bas，由接线层按 messageType 过滤，语义不变。

### 3.4 明确**不改**的 bas handler

- `src/sysprompt/hub.ts:283-325 onBeforeAgentStart`：**不许加 messageType 过滤**。1.2 能让唤醒 run 的
  请求头和用户轮同谱系（prompt cache 字节稳定），前提就是 hub 在 custom run 上照样折叠段落、返回
  `systemPrompt`。hub 只读 `event.systemPrompt` 和 `event.systemPromptOptions?.cwd`，两种变体都有，
  类型安全。在 1.2 唤醒 run 上会多出两种副作用，接受（explore §1.1 已论证）：冻结快照可能在唤醒轮边界
  刷新；section 更新的尾消息可能挂到唤醒轮上。包 A 要给 hub 补一条单测锁住“custom 形态也折叠”（§7.1）。
- `src/date/index.ts:103`：不读 event 字段，首轮注入幂等，不改。

### 3.5 devDeps 升到 1.2 之后，怎么保证 1.1 行为不回退（D4=A）

1. **编译面**：helper 只认 `unknown`，title 和 feishu 不再直接访问 `event.prompt/messageType`，代码里
   不出现 1.2 独有的类型名。
2. **行为面单测**：title / feishu-notify / pi-compat 的测试同时喂 1.1 形态 `{prompt}`（现有用例本来就是
   这个形态，见 `tests/title/wire.test.ts:119` 的 `{ prompt: "…" } as never`，原样保留，它们就是 1.1
   回归用例）和 1.2 的 user/custom 形态（§7.1）。
3. **一次性 1.1 核验**（包 A 验收步骤，不进 CI）：
   ```sh
   D=/tmp/pt-pi11-verify; rm -rf "$D"; mkdir -p "$D"
   git archive HEAD | tar -x -C "$D"            # 在包 A 的提交上执行
   cd "$D" && npm install --no-audit --no-fund \
     @earendil-works/pi-ai@1.1.0 @earendil-works/pi-coding-agent@1.1.0 @earendil-works/pi-tui@1.1.0 --no-save
   timeout 600 npx tsc --noEmit -p tsconfig.json
   timeout 600 npx vitest run tests/title tests/feishu-notify tests/adapters/pi-compat.test.ts tests/sysprompt
   timeout 600 npx vitest run tests/conformance/topic-switch-hop.test.ts   # 包 B 合入后：S4 新写法在 1.1 也要绿，S4b 应显示 skipped
   ```
   不许在主工作区装 1.1。核验完 `rm -rf "$D"`。
   **注意（评审 #3）**：这份配方方案阶段**没有实跑过**（方案实验用的是软链主工作区 1.1 node_modules，包 A 合入后不可复用）。
   包 A 验收时先试跑一次；若 1.2 捆绑包（pi-agent-core 等）残留与 1.1 类型解析交叉导致失败，退化为：
   `cp -r` 主工作区 node_modules 到 `$D`，再只把三个 `@earendil-works/pi-{ai,coding-agent,tui}` 覆盖为 1.1.0，然后跑同样的 tsc + 定向测试。

---

## 4. C1：topic-switch conformance S4 —— 根因与修法（包 B，只改测试）

### 4.1 复现与时间线（`/tmp/pt-pi12`，`zz-s4-debug.test.ts`）

原测试在 1.2 下稳定失败（`expected 2 to be 3`）。插桩后的时间线：

```
input FOLLOWUP-1 sb=undefined
test saw input FOLLOWUP-1; isStreaming=false calls=0     ← 第一个 run 还没进 _startRun
test passed !isStreaming FOLLOWUP-1; calls=0             ← 等待条件被“启动前空隙”直接满足
input FOLLOWUP-2 sb=undefined                            ← input 时还算 idle
bas type=user prompt=FOLLOWUP-1                          ← FOLLOWUP-1 的 run 此刻才启动（busy）
test saw input FOLLOWUP-2; isStreaming=true
agent_start / settled calls=2                            ← FOLLOWUP-2 被排成该 run 的 followUp，独立一次模型调用
input FOLLOWUP-3 sb=undefined; test passed !isStreaming  ← 又是启动前空隙
END-OF-LOOP calls=2                                      ← 原断言在这里取值
bas type=user prompt=FOLLOWUP-3; settled calls=3
AFTER-200ms calls=3
req0: FOLLOWUP-1 | req1: …,FOLLOWUP-2 | req2: …,FOLLOWUP-3   ← 每条恰好一次、顺序正确、各占一次请求
```

机制（`agent-session.js` 1.2）：`prompt()` 先 `await _runInputHandlers`（`:1622`，emit input），再
`await checkAuth`，最后才 `_startRun`（`:1663`），`_startRun` 第一行才把 `_isAgentRunActive` 置真
（`:1392`）。测试“看到 input 事件之后马上查 `!isStreaming`”，落在 input 和 `_startRun` 之间的空隙里，
会立即放行。循环于是早跑完一轮，断言时第三次调用还没发生。**消息没有合并，也没有丢失。**

### 4.2 对照 1.1（临时 1.1 树，同一份插桩测试）

1.1 下同样的空隙**真的会丢消息**：插桩版（多注册了一个 bas handler，改变了时序）3 次运行都是
`calls=2`，请求里只有 F1 和 F3，**F2 从未到达模型**，也没有 extension_error。原 S4 在 1.1 能过，
纯属时序侥幸。另一个实验 `zz-busy-debug` 也显示：1.1 下在 bas 期间发的 followUp 会被拒
（“Agent is already processing a prompt”），1.2 下则正确排队。**1.2 在这一点上是严格改进。**

### 4.3 I2 判定：产品代码不改

- topic-switch 的每次释放都带 deliverAs：`src/topic-switch/wire.ts:663`（`pi.sendUserMessage(content,
{ deliverAs })`）、`release.ts:82`（`item.deliverAs`）、`release.ts:99`（`"followUp"`）。条目之间还有
  有序屏障：`release.ts:116` 的 `waitBarrier`，条件是 `wire.ts:307-316` 的 extension echo，加上
  agent_start 或 `!isIdle && hasPendingMessages`。
- 1.2 下：第一条 idle 开 run；后续条目在屏障之后发出，这时 busy，于是排成 followUp，各自恰好一个 input
  事件、一次模型调用。被扣请求和新来请求都只投递一次，**I2（每条被扣请求恰好一个决策）成立**，
  I1/I3 不涉及。
- 一个需要知道的细节：1.2 下，如果某条 prompt 的 input handler 落在另一条 prompt 的 input 与
  `_startRun` 之间的空隙里，它的 input 事件会报 `streamingBehavior: undefined`，最后却被排成 followUp
  （上面时间线里的 FOLLOWUP-2）。topic-switch 的 gate 除了看 sb，还看 `ctx.isIdle()` 和
  `hasPendingMessages`（`gate.ts:31`）。interactive/rpc 来源的输入只有在这个毫秒级窗口里才会被误判成
  “空闲新一轮”而被扣；之后释放仍走 followUp，依旧只投递一次。接受，不改。

### 4.4 修法：`tests/conformance/topic-switch-hop.test.ts`

1. **S4（`:167-200`）改等待条件**，断言保持不弱化（文件头 `:9-11` 的约定）：
   ```ts
   const markers = ["FOLLOWUP-1", "FOLLOWUP-2", "FOLLOWUP-3"];
   for (const [i, marker] of markers.entries()) {
     harness.currentPi().sendUserMessage(marker, { deliverAs: "followUp" });
     await waitUntil(() => harness.events.some((e) => e.t === "input" && textOf(e) === marker));
     // pi 1.2: a run counts as busy only from _startRun on — the input event fires BEFORE that, so
     // `!isStreaming` alone is satisfied by the pre-start gap. Wait for this marker's own model call
     // AND the run's end before reinjecting the next one (each must open its own idle turn).
     await waitUntil(() => harness.modelRuntime.callCount() >= i + 1 && !harness.session().isStreaming);
   }
   ```
   原有断言全部保留（每个 marker 恰好 1 个 input、source extension、sb undefined、`callCount()===3`），
   再追加：第 i 个请求里最后出现的 `FOLLOWUP-` 正是 `markers[i]`（证明各占一轮、顺序正确）。
   实测这个写法在 1.2 和 1.1 都能过。
2. **新增 S4b**（放 S4 后面），钉住 1.2 的启动窗口语义，也就是 topic-switch 释放队列在 1.2 下的安全余量：
   ```ts
   import { VERSION } from "@earendil-works/pi-coding-agent"; // 1.1/1.2 都导出
   const piMinor = Number(VERSION.split(".")[1] ?? 0);
   it.runIf(piMinor >= 2)(
     "S4b (pi ≥1.2): back-to-back followUp reinjections from idle — each reaches the model exactly once, in order, one request each",
     async () => {
       const harness = await createProbeHarness({ scripted: [textTurn("ack")] });
       try {
         const markers = ["B-1", "B-2", "B-3"];
         for (const m of markers) harness.currentPi().sendUserMessage(m, { deliverAs: "followUp" });
         await waitUntil(() => harness.modelRuntime.callCount() >= 3 && !harness.session().isStreaming);
         expect(harness.modelRuntime.callCount()).toBe(3);
         expect(JSON.stringify(harness.modelRuntime.requestMessages[2]).match(/B-\d/g)).toEqual(markers);
         expect(harness.events.filter((e) => e.t === "extension_error")).toHaveLength(0);
       } finally {
         await harness.dispose();
       }
     },
   );
   ```
   实测：1.2 下稳定通过；1.1 下失败（丢消息，超时），所以用 `runIf`。测试里读版本号不违反 I14，
   I14 只约束 `src/`。注释要写明：1.1 下同样的连发会丢消息，1.1 上的释放队列正确性依赖条目间屏障。
3. 文件头注释 `:1-16` 追加一句：“pi 1.2：S4 的等待条件已按启动窗口修订（plan.md §4），S4b 为 1.2 新增
   契约”。`docs/dev/topic-switch/plan.md:44`（S4 行）补一个脚注指向本文 §4。

---

## 5. wake-replay 取舍（D1，推荐 A）—— 包 B 只改文档和测试

### 5.1 证据（`zz-wake-debug.test.ts`：真实 AgentSession，挂真实 `createPromptSectionHub` 加一个固定段落；顺序为用户轮 → 唤醒轮 → 用户轮）

| pi  | wakeReplay | req0 用户轮头 | req1 唤醒轮头     | req2 用户轮头 | 唤醒轮带段落             |
| --- | ---------- | ------------- | ----------------- | ------------- | ------------------------ |
| 1.1 | true       | fe9d…         | **fe9d…**         | fe9d…         | ✓                        |
| 1.1 | false      | cd87…         | **2f96…（分叉）** | cd87…         | ✗ ← 回放层当年要修的缺陷 |
| 1.2 | true       | 06c3…         | 06c3…             | 06c3…         | ✓                        |
| 1.2 | false      | 4ade…         | **4ade…**         | 4ade…         | ✓ ← 1.2 原生已修         |

（不同 harness 实例之间哈希不同，是 cwd/timestamp 的差异；只比较同一行内部。）1.2 下唤醒 run 也会触发
`bas type=custom`，hub 照常折叠。

机制：`sdk.js:282` 的 transformContext（`emitContext`，即 `context_with_system`，回放就挂在这里）
**最先**执行；`_installAgentForcedPromptProjection`（`agent-session.js:1351`，在 `:209` 安装，排在
hidden-declarations 之后）**最后**执行，只要 `_runSystemPromptOptions.forceSystemPrompt` 有值就用同一
投影形态重写头消息。1.2 下凡是 hub 折叠过的 run（用户轮和唤醒轮都算）都有 forced，所以回放结果每次
都会被覆盖，输出字节和关掉回放完全一样。seed 分支（`hub.ts:344-353`）在 1.2 下因为每个 run 都先经过
bas，变成死路径。

### 5.2 各选项在 1.1 / 1.2 下的行为

| 选项                   | pi 1.1                               | pi 1.2                                                                                  | prompt cache 字节稳定性                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A 保留不动（推荐）** | 唤醒轮回放 = 和用户轮同谱系（现状）  | 回放层休眠：每个请求多一次 `getCurrentSystemMessage` 扫描和一次数组拷贝，输出被 pi 覆盖 | 两版都不变（sysprompt-stable plan 的 G1 在 1.1 由回放兑现，在 1.2 由 pi 原生兑现）                                                                                                                                                                            |
| B 结构性跳过           | 同 A（前提是 run 边界状态正确）      | 省掉休眠开销                                                                            | 理论上同 A；但 hub 要新增“本 run 是否经过 bas”的状态（bas 置位 → agent_start 锁存 → agent_settled 清零），唤醒消息并入启动中 run、steer 入队等路径一旦判错，就会在 1.1 上停掉回放，回到 44% 对 10% 的失效率（sysprompt-stable plan 的 field-2026-09-24 数据） |
| C 默认 false           | **回退**：唤醒轮请求头分叉、段落丢失 | 同 A                                                                                    | 1.0/1.1 用户受损                                                                                                                                                                                                                                              |
| D 按版本跳过           | 同 A                                 | 同 B                                                                                    | 违反 I14，排除                                                                                                                                                                                                                                                |

### 5.3 选 A 时包 B 要做的事

1. 新增 `tests/conformance/wake-run-sysprompt.test.ts`（照 `zz-wake-debug` 改写成断言）：
   - `wakeReplay:true`：两版都断言唤醒轮请求的 system 头和前后用户轮 `toEqual`，并且包含段落文本。
   - `wakeReplay:false`：用 `it.runIf(piMinor >= 2)` 断言同样相等。注释写明：这条失败（例如 pi 退回去了）
     ⇒ 回放层仍然必要；等 peer 下限升到 ≥1.2 时，这条就是删掉回放层的依据。
   - 断言观察到 `messageType === "custom"` 的 bas（用 `readBeforeAgentStartTrigger` 读）——**仅
     `it.runIf(piMinor >= 2)`**（评审 #2）：1.1 下唤醒 run 根本不触发 bas（1.1 只有 `prompt()` 调
     `emitBeforeAgentStart`），这正是回放层存在的原因；注释写明这一点。
2. `src/sysprompt/wake-replay.ts:1-14` 头注释：第一段改成“pi ≤1.1 的唤醒 run 从不经过
   before_agent_start……；pi ≥1.2 原生修复（CHANGELOG 1.2.0 #10267），pi 的 forced 投影最后执行、覆盖
   本层输出，本层休眠但保留，直到 peer 下限 ≥1.2（docs/dev/pi-1.2-compat/plan.md §5）”。
3. `docs/dev/sysprompt-stable/plan.md` 末尾修订记录追加同样一段。`AGENTS.md:307` 的
   `systemPrompt.wakeReplay` 句尾加“(dormant on pi ≥1.2: pi's own forced-prompt projection runs last and
   supersedes it; kept for the 1.0/1.1 peer floor)”。这一行 AGENTS.md 的编辑归包 A，避免两包冲突，见 §8。
4. 默认值（`src/config/settings.ts:1167`）、hub 注册逻辑（`hub.ts:358`）**不动**。

---

## 6. 遗留项逐条结论

### 6.1 不带 deliverAs 的 `sendUserMessage`：**要改**（D3=B）

证据：

- 1.2 运行时没有默认值。`sendUserMessage → prompt(text, { streamingBehavior: options?.deliverAs })`
  （`agent-session.js:1880-1906`）；busy 且没有 streamingBehavior 时，`prompt()` 抛
  “Agent is already processing. Specify streamingBehavior …”（`:1636-1638`）；ExtensionAPI 包装层
  `.catch` 后只发 `extension_error{event:"send_user_message"}`（`:2744-2750`）。我们代码里的同步
  try/catch 永远接不到，**文本静默丢失**。实测 `zz-busy-debug`：bas 期间（1.2 下算 busy）发出的
  NO-DELIVERAS 走 extension_error 丢失；WITH-FOLLOWUP 正确排队，独占一轮。
- idle 时两版都忽略 deliverAs：input 事件拿到的是 `this.isStreaming ? streamingBehavior : undefined`
  （1.2 `:1622`、1.1 `:1538`），随后直接开 run。所以**加上 `deliverAs:"followUp"` 在 idle 下逐字节等价**，
  只在 busy 时把“丢失”变成“排队”。
- 什么时候会 busy：`ctx.compact()` 先 `await this.abort()`（`agent-session.js:2201`，两版相同），
  压缩期间 `isStreaming` 为 false。这时任意一条 `sendMessage(triggerTurn:true)` 通知
  （`stack.ts:574/735/1783/1797/2732`、`workflow-notice.ts:129`）都会另起 run；1.2 的启动窗口
  （`_prepareRun` 全程：预压缩检查加所有 bas handler）把 onComplete 撞上 busy 的概率又放大了。

改法：

- `src/index.ts:355`（compact-hint 强制压缩后的 RESUME）、`:563`（switch_context）、`:593`
  （compact_context）三个闭包统一改为 `(text) => pi.sendUserMessage(text, { deliverAs: "followUp" })`。
  deps 签名 `(text: string) => void` 不变（`compact-tool.ts:53`、`switch-context-tool.ts:78`、
  `stack.ts:1051`），工具单测和 compact-hint golden（`tests/integration/helpers/compact-hint-golden.ts:315`
  用的是自己的 stub，`tests/fixtures/compact-hint-golden.json` 不含 sendUserMessage）都不受影响，
  **golden 不许重生**。
- `src/topic-switch/command.ts:123`：`await rctx.sendUserMessage(toContent(payload), { deliverAs: "followUp" })`。
  `ReplacedSessionContext.sendUserMessage` 两版签名都接受 `deliverAs`（1.2 `types.d.ts:334-337`）。新会话
  刚起来时，也可能有 bash job 完成之类的唤醒抢先开 run；现状是走 catch，提示用户
  `/topic-switch last --send`，改后直接排队投递。PONR 之后的 CAS（`:113`）先于发送，仍然只投递一次，
  I2/I3 不变。
- 不改：`src/web-hub/agent/commands.ts:346/437`。**评审修正（2026-10-15）**：原先“busy 时映射成 `E_STALE_CTX`
  回执”的说法是错的——`deps.pi` 是 `ExtensionAPI`（`commands.ts:51`），其 `sendUserMessage` 包装层吞掉
  rejection、只发 `extension_error`（1.2 `agent-session.js:2742-2750`，1.1 `:2712-2719` 同构），永不同步抛，外层
  `try/catch → E_STALE_CTX` 是死代码；若真走到不带 deliverAs 的 busy 路径，会是“input 事件先触发 ⇒ 观察回调以
  `okResult({delivery:"observed"})` 结算 ⇒ 文本随后被静默丢弃”。不改的真实依据是**不可达**：浏览器 `prompt` op
  的 `deliver` 在协议里必填（`protocol/messages.ts:673/:1041`），held/recall 路径必带 deliver，builtin-bridge 有
  `?? "steer"/"followUp"` 兜底。死 catch 的清理不在本次范围；`src/topic-switch/wire.ts:559`（`/topic-switch __go`
  命令走 `_tryExecuteExtensionCommand`，在 streaming 检查之前就返回了，不需要 deliverAs）。

### 6.2 compact onComplete 落进启动 busy 窗口：**由 6.1 兜住，不另改**

窗口确实存在，分析见上；3 个闭包补 followUp 后，busy 时续跑文本会排进那个 run，不再丢失。

### 6.3 `/topic-switch __go` 跳板的 idle preflight：**不改**

- 命令分发在 `prompt()` 的第一步（`agent-session.js:1611-1619` 的 `_tryExecuteExtensionCommand`），
  早于 `_startRun`，跳板自己的发送不会把会话变成 busy。conformance S3（timer 里
  `sendUserMessage('/__go', {expandPromptTemplates:true})` 能分发命令、绕过 input 和 LLM）在 1.2
  baseline 下通过。
- preflight 的 `!ctx.isIdle()`（`command.ts:76`）在 1.2 下只会因为“别的 run 正在启动或运行”而命中，
  处理方式是 `onPreflightFailed`，回到当前会话（PONR 之前，fail-open，I6）。和 1.1 下撞上流式唤醒 run
  的后果同类，只是窗口略宽，方向安全。

### 6.4 consult C2 快照指纹与 `reachesTools` / `aliases`：**不改**

- 1.2 baseline 的 conformance：`consult-preserve.test.ts`（8 tests，1 skipped = 设计上就跳过的 C8）
  **全绿**。全套 conformance 只挂了 S4 和 RH1–RH4（`/tmp/pt-pi12-logs/04-conformance.log`）。
- `src/consult/preserve-identity.ts:150-158` 的定义漂移判定用的是 pi 自己的
  `sessionToolStateChanges(session)`。shadow tools 照抄快照里的声明，新字段两边同源，不会造成误判。
  src 里没有任何 `reachesTools/aliases` 引用。我们的 Agent/consult 等工具不需要声明 `reachesTools`
  （它只给 MCP 扩展判断要不要等 server 用）。

### 6.5 其它核对过、不需要改的点（引用 explore，供验收者对照）

- sendMessage(triggerTurn) 在启动窗口内会并进启动中的 run（explore §4.1），所有调用点都不要求独占新 run。
- `ctx.isIdle()` 依赖点（explore §4.3）：启动窗口算 busy，方向都偏保守，不改。
- abort 在启动期请求 ⇒ run 一启动就中止：`session-driver.ts:546-548 requestAbort` 受益，
  steer-hold / rpc-spawn conformance 在 1.2 下全绿。
- `serializeConversation`、`pi mcp list --json`、settings-manager 类型搬移：零引用，不改。
- `src/commands/task.ts:19` 注释里“不用 nextTurn”的理由在 1.2 弱化了（nextTurn 也会随 custom run 投递），
  只是注释，可选顺手更新，不改行为。

---

## 7. 测试计划

### 7.1 新增 / 修改的单测和集成测试

| 文件                                                                   | 内容                                                                                                                                                                                                                                                                                                                                                        | 包  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `tests/adapters/pi-compat.test.ts`                                     | ① §2 的范围修改；② 新 `describe("readBeforeAgentStartTrigger")`，覆盖 §3.1 语义表 5 行                                                                                                                                                                                                                                                                      | A   |
| `tests/title/wire.test.ts`                                             | 现有 `{prompt}` 用例**原样保留**（1.1 形态回归）。新增：① `{messageType:"user", prompt, systemPrompt}` 和 1.1 形态走同一路径（会起首标）；② 未命名会话 + `{messageType:"custom", message}` ⇒ **不调** `complete`、不写名字、不抛错；③ 已命名会话（refreshEveryInputs=4 时）连续 4 个 custom 加 settle ⇒ **不触发**刷新（证明不计数），再来 4 个 user ⇒ 触发 | A   |
| `tests/feishu-notify/extension.test.ts`                                | 新增：bas `{messageType:"user", prompt:"任务X"}` 后接 `{messageType:"custom"}`，结果卡 / 等待卡里的 prompt 字段仍是“任务X”；再测 1.1 形态 `{prompt:"任务Y"}` 也能生效（沿用该文件已有的 emit / 卡片捕获 harness）                                                                                                                                           | A   |
| `tests/sysprompt/hub.test.ts`                                          | 新增：custom 形态 `{messageType:"custom", message, systemPrompt, systemPromptOptions}` 也返回折叠后的 `systemPrompt`（锁住“hub 不许按 messageType 过滤”，§3.4）                                                                                                                                                                                             | A   |
| `tests/integration/context-switch-wiring.test.ts`                      | fake pi 的 `sendUserMessage(text)`（`:39`）改为同时记录 options；新增断言：switch_context / compact_context 的 onComplete 续跑带 `{deliverAs:"followUp"}`                                                                                                                                                                                                   | B   |
| `tests/integration/context-switch-wiring.test.ts`（activate 级新用例） | 用该文件同款“真实 `activate()` + 记录 options 的 fake pi”手法（`:6/:95`），断言 compact-hint 强制路径经 `src/index.ts:355` 的真实闭包透传 `{deliverAs:"followUp"}`。不要用 `compact-hint-wiring.test.ts`：它的 `sendUserMessage: resume` 是 dep 注入 stub（`:315/:381`），测不到真实闭包                                                                    | B   |
| `tests/integration/topic-switch.test.ts:311`                           | rctx `sendUserMessage` mock 记录 options，断言 `deliverAs === "followUp"`                                                                                                                                                                                                                                                                                   | B   |
| `tests/conformance/topic-switch-hop.test.ts`                           | §4.4：S4 改等待条件，新增 S4b（runIf pi≥1.2）                                                                                                                                                                                                                                                                                                               | B   |
| `tests/conformance/wake-run-sysprompt.test.ts`（新）                   | §5.3-1                                                                                                                                                                                                                                                                                                                                                      | B   |

### 7.2 必跑闸门（每包都在主工作区、pi 1.2 devDeps 下跑全套；长命令一律加 `timeout`）

```sh
timeout 900  npm run format:check
timeout 900  npm run typecheck
timeout 3600 npm test
timeout 900  npm run build
timeout 1800 npm run build:web && timeout 900 npm run check:web
timeout 1800 npm run test:conformance       # pi 1.2 下必须全绿（含 consult-preserve、history-restore RH1–RH4、topic-switch S4/S4b、wake-run-sysprompt）
```

- `npm test` 的已知噪声：`tests/bash/process.test.ts`、`tests/git/run.test.ts` 在高并发下偶发失败
  （baseline 排除项），失败时单独复跑确认即可，不能当成通过的理由去忽略其它失败。
- external-droid 的 21 项失败已由 c807d62 修复，包 A 基于当前 HEAD，应该全绿。
- 包 A 额外跑 §3.5 的 1.1 核验。

---

## 8. 拆包建议

两包，**建议串行 A → B**（A 很小，B 的 conformance 依赖 A 的 devDeps 1.2）。如果要并行，B 在独立
worktree 里基于 A 的 package.json/lock 改动开发，合入前 rebase 到 A 之上；两包文件域互不相交。

### 包 A —— `feat(compat): support pi 1.2.x`

- **文件域**：`package.json`、`package-lock.json`、`src/adapters/pi-compat.ts`、
  `src/web-hub/protocol/spawn.ts`、`src/title/index.ts`、`src/title/title.ts`（只改注释）、
  `src/feishu-notify/index.ts`、`tests/adapters/pi-compat.test.ts`、
  `tests/web-hub/hub/spawn/{launcher-check,supervisor}.test.ts`、`tests/web-hub/protocol/spawn.test.ts`、
  `tests/title/wire.test.ts`、`tests/feishu-notify/extension.test.ts`、`tests/sysprompt/hub.test.ts`、
  `AGENTS.md`（`:735` 范围，加 `:307` 的 wakeReplay 句尾；本 PR 里**只有包 A 碰 AGENTS.md**）、
  `docs/dev/title/plan.md`（一句话）。另外，`docs/dev/pi-1.2-compat/{baseline,explore,plan}.md` 随包 A 一起提交，提交前复核三份文档过 `npx prettier --check`。
- **冻结面**：`readBeforeAgentStartTrigger` 的签名和语义表（包 B 的 conformance 会用）；hub、date、
  wake-replay 代码不改；`systemPrompt.wakeReplay` 默认值不改。
- **提交信息**照 b86b86a 的写法：正文说明在真实 pi 1.2.0 下 typecheck、全量 test、conformance 已验证，
  并列出 web-hub launcher 范围、pi-compat 测试范围、bas union 兼容（title 唤醒轮不计数、feishu 保留任务
  prompt）三点。
- **验收清单**：
  1. `rg -n '<1\.2\.0|"1\.0\.0 - 1\.1\.0"|maxExclusive: "1\.2\.0"' package.json src tests AGENTS.md` 无命中。
     `npm ls` 显示三个 pi 包都是 1.2.0。
  2. §7.2 全部闸门绿。conformance 只允许 topic-switch S4 仍然失败（留给包 B 修）；RH1–RH4 必须绿。
     如果选择 B 先并行完成、和 A 一起合入，则要求全绿。
  3. §3.5 的 1.1 核验：tsc exit 0，定向测试绿。
  4. title 和 feishu 的 diff 里不出现 `event.prompt`、`event.messageType`，也不出现 1.2 独有的类型名。
  5. `tests/title/wire.test.ts` 里原有的 `{prompt}` 用例一条都没删、没改。
  6. 验收模型 ≠ 开发模型。

### 包 B —— `fix(compact): queue resume messages as followUp while a run is starting`，加 `test(conformance): …`（可拆成两个提交）

- **文件域**：`src/index.ts`（只动 `:355`、`:563`、`:593` 三行）、`src/topic-switch/command.ts:123`、
  `src/sysprompt/wake-replay.ts`（只改头注释）、`tests/conformance/topic-switch-hop.test.ts`、
  `tests/conformance/wake-run-sysprompt.test.ts`（新）、`tests/integration/context-switch-wiring.test.ts`、
  `tests/integration/topic-switch.test.ts`（以及 §7.1 里可选的 compact-hint 断言）、
  `docs/dev/sysprompt-stable/plan.md`（修订记录）、`docs/dev/topic-switch/plan.md`（S4 脚注）。
- **冻结面**：tool deps 的 `sendUserMessage: (text: string) => void` 签名不变；`release.ts`、`wire.ts`、
  `gate.ts` 不改；`tests/fixtures/compact-hint-golden.json` 不重生；S1–S3、S5–S9 不动；S4 原有断言
  不弱化。
- **验收清单**：
  1. §7.2 全部闸门绿，**conformance 全绿**（S4、S4b、wake-run-sysprompt 都要出现在报告里，S4b 是
     passed 而不是 skipped）。
  2. 若做了 §3.5 的 1.1 核验：S4 新写法在 1.1 下也绿，S4b 和 wake-run 的 `wakeReplay:false` 用例显示 skipped。
  3. `rg -n 'sendUserMessage\(text\)\)' src/index.ts` 无命中；`command.ts:123` 带 `deliverAs: "followUp"`。
  4. 新增集成断言能捕获回退：临时去掉 deliverAs 时这些断言要失败（验收者自行变异验证一次）。
  5. 文档措辞说明的是“1.2 下休眠、为 1.0/1.1 保留”，不是“已废弃”。

---

## 附录：本方案阶段的实验与命令（可复现）

- worktree：`/tmp/pt-pi12`（pi 1.2.0 devDeps，HEAD f7421e3，不含 c807d62）。实验文件存档在
  `/tmp/pt-pi12-logs/plan-experiments/`，复现时拷回 `tests/conformance/` 后执行
  `timeout 300 npx vitest run tests/conformance/<file>`，做完删掉。
- T1 试修 diff：`/tmp/pt-pi12-logs/plan-experiments/t1-fix.diff`。应用后 `npm run typecheck` exit 0
  （日志 `/tmp/pt-pi12-logs/plan-typecheck.log`）；title / feishu / sysprompt / pi-compat 以及 3 个
  T1′ 测试共 15 个文件 302 项全绿。
- 1.1 对照：`git archive HEAD | tar -x -C /tmp/pt-pi11` 加软链主工作区 node_modules（1.1.0）。同一份
  helper 代码 `tsc --noEmit -p tsconfig.json` exit 0；原 S4 通过，插桩版丢 F2；S4b 失败；wake 对照见 §5.1。
  该目录已删除。
