## J6 交付报告

J6 已全部完成，没有走 plan 第 8 条的 J6a/J6b 拆分。自验命令全绿（off-golden 在 98b279e4 的 harness 修复之后也是 8/8）。没有 commit。HEAD 是 98b279e4，同一工作树里还有 J5、J8 在改代码。

### 1. 文件清单

新建（行数是 prettier 之后的）：

- `/home/bluecake/ai/pi-toolkit/src/memory/jev/wire.ts`：1479 行。`wireJev` 内部分成 status、recall、ports 三段私有函数，没有另建 pi-facing 文件。
- `/home/bluecake/ai/pi-toolkit/src/memory/jev/segment.ts`：210 行，pi-free。
- `/home/bluecake/ai/pi-toolkit/src/memory/jev/config.ts`：60 行，pi-free。
- 测试共 6 个：
  - `tests/memory/jev/config.test.ts`（81 行）
  - `tests/memory/jev/segment.test.ts`（103 行）
  - `tests/memory/jev/wire-recall.test.ts`（625 行）
  - `tests/memory/jev/wire-status.test.ts`（318 行）
  - `tests/memory/inject-jev.test.ts`（106 行）
  - `tests/integration/memory-jev-recall.test.ts`（200 行）

修改：

- `src/memory/index.ts`（+40）：
  - 新增 `WireMemoryOpts.secureDomainKind?`；
  - `resolveJevWiring` 判为 on 时才调 `wireJev`；
  - 有端口时才给 `createMemCommand` 传 `jev: commandPort`；
  - `onRender` 带第三参，并记录 render info；
  - jev 开时打开 `stripInlineMeta`；
  - 写后 hook 链；
  - 返回值加 `attachJevBashJobs`，本包只是占位。
- `src/memory/inject.ts`（+38）：
  - `onRender(cwd, block, info)`；
  - 新增 `jevRenderInfoOf`；
  - `stripInlineMeta?: boolean`，并且只在块里真的有 `<!-- mem` 时才剥。
- `src/index.ts`（+7）：`wireMemory(…, { secureDomainKind: secureDomain.kind })`。`secureDomain` 恒有值，所以没写 `?.`。
- `tests/memory/jev/off-golden.test.ts`（+27）：只追加了 `PI_API_ALLOWED_DIFF`，另外按 root 同意的方式改了 dev 断言。
- `tests/fixtures/governance/activate-trace.json`：按声明刷新，见 §6。

### 2. 导出与 §2 冻结表对照

- `resolveJevWiring(memory, domainKind)` 返回 `{on:true, config}` 或 `{on:false, reason}`。判定顺序是 secure → legacy → disabled → empty-list。另外导出了 `jevConfigOf`（会去重保序）。
- `wireJev(pi, deps)` 返回 `{ commandPort, makeWritePort(), doctorPort, attachBashJobs, client }`。deps 按 §4 J6 的签名，另有几个可选测试接缝：`now`、`clock`、`client`、`entryIndex`、`platform`、`log`。
- `makeWritePort` 的处理：J5 的 `write-port.ts` 在 J6 开工时还不存在，所以我加了可选的 `deps.createWritePort`，形状就是 J5 文档里的 `createJevWritePort` deps。不传时调用会抛 "wired by J7"。J7 只要在 index.ts 里把工厂传进来即可。
- `createSegmentState()` 提供 plan 列的全部 API：`seed`、`markInjected`、`isInjected`、`latch`、`isLatched`、`resetOnCompaction`、`lastInjected`、`count`。额外加了 `markGate`、`pendingReinject`、`markReinjected`、`full`、`compactionId`、`stats`，以及记录构造函数 `recallRecord`。
- J4 端口可选依赖已接上：`config`、`usage=client.usage`、`segment=segment.stats`、`health=getHealthTable()`。`triggerBulk` 接到后台 `tagBulk`，`onEntryTags`/`base` 用来写侧车。

### 3. 四层召回：触发点、时机、预算

| 层             | 钩子                                                                                                                              | 前置条件                                                                | 落点                                                                                                                                                              | 预算                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| U              | `before_agent_start`，`messageType=user`                                                                                          | 状态为 full 或 probing；剥掉 skill 块后 ≥8 码点且不是应答短句；候选非空 | 在 `waitMs`（默认 1500）内拿到结果就作为本次返回的 `{message}`；超时则后台继续，代际仍是当前时用 `sendMessage(triggerTurn:false)` 补发；新 prompt 会 abort 旧调用 | 4000ms，外层再套 +500ms                               |
| 子会话派单召回 | 同上                                                                                                                              | 同上                                                                    | 同上；`session:"child"`，`user_message` 取 2000 码点，不带上一条消息                                                                                              | 同上                                                  |
| A              | `tool_call`，同步执行，零 await、零调用                                                                                           | 状态不是 off，也不是 inactive                                           | `sendMessage(triggerTurn:false)`，partial 时带 `·partial` 标记；handler 恒返回 undefined                                                                          | ≤3 条、4KB                                            |
| E              | `tool_result`（恒返回 undefined）；`before_agent_start` 的 custom 唤醒轮（bash-job 失败通知）；`message_start`（空闲静默 append） | 状态为 full 或 probing；同签名每段问一次；每段最多 10 次                | 唤醒轮作为 message 返回，其余走 sendMessage                                                                                                                       | 4000ms +500；取 p≥0.7 的前 2 条；候选 >150 时词面预筛 |
| B              | `session_compact`；`turn_end` 检查点（子会话 switch）                                                                             | 不是 off，也不是 inactive                                               | sendMessage；条目已删跳过，hash 变了注明「（已修改）」，记录 `bFor`                                                                                               | 零调用，≤3 条                                         |

其他召回规则：

- **候选排除**：private、secret、本段已注入、archived（EntryIndex 本身就跳过）、静态 core。
- **静态 core 判定**：条目属于 primary 文件且所在 section 不在 `omittedSections` 里才算静态。还没渲染过、或 core 未内联（L4/L5）时不排除。
- **CJK 对照测试**：section 名带 CJK 和 `###` 嵌套的情况和 tiered 的 `omittedSections` 对得上。重名 section 会退化为不排除，这是保守方向。
- **>360 候选**：先本地词面预筛到 360，`/mem jev` 末尾显示 `recall truncated N→360`。J4 的 `formatJevReport` 是冻结的，所以这一行是在 wire 里包装 report 追加的。
- **两条防线**：`before_agent_start` 只返回 `message`，从不返回 `systemPrompt`，有测试断言；每个 handler 都 try/catch。

### 4. 状态机与通知接线

| 项          | 接线                                                                                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| off(pi-api) | 每个 handler 第一行检查 `ctx.modelRegistry` 三个方法；缺任一则零调用、零注入。在见到一个完整 registry 之前，`statusLine` 显示 `jev: off (pi-api)`                                                                                                               |
| 探测        | 只在主会话：`session_start` 后后台先 `client.probe()`，再发一次 bool 探测调用。通知判定在探测落定之后才开始                                                                                                                                                     |
| 通知        | 只在主会话且有 UI，通过 `notifyFor` + `formatNotify`：first-full 每个 activation 一次；degraded 同一原因一次；recovered 每次；startup-partial 带 451 代理提示。四条文案都有逐字断言                                                                             |
| inactive    | 定义为：覆盖率 0、没有行内 gate/tags=，并且没有任何凭证（全部 no-auth/not-found）。有凭证但 451 的用户算真正的 partial，会通知                                                                                                                                  |
| 恢复        | 用最早的 `until` 经 `clampSpanMs` + `createSegmentedClock`（unref）设一次性探测                                                                                                                                                                                 |
| /reload     | `session_shutdown(reload)` 时由主会话 `clearHealthTable()`；子会话不清                                                                                                                                                                                          |
| 后台任务    | 只在主会话，串行队列，每个任务 120s 上限，shutdown 时 abort：首次 full 触发 tagBulk（迁移或 taxonomy rev 变化时）；full 期间每 ≥60s 补打一次 pending（tagOne，每次 ≤8 条）；周期整理需同时满足 full、距上次 ≥intervalDays、corpusFp 变化，`intervalDays=0` 不跑 |
| 子会话      | 不注册 `session_start`，所以不探测、不通知、不打标、不整理、不写侧车；共享健康表和令牌桶。`childSessions=false` 或 `injectInChildSessions=false` 时所有 handler 惰性                                                                                            |
| doctorPort  | `extraReminder` 给出到期数（用 J1 的 `expiredEntries`）、待审建议数，以及非 inactive 时的 partial 状态行                                                                                                                                                        |

### 5. 关闭路径逐字节一致的证据

- **四个设置期 off 配置**（disabled、legacy-layout、legacy-tool、secure-sim）都不调用 `wireJev`，也不向任何模块传端口。off-golden 四例逐字节绿。
- **pi-api 配置**走白名单比对。追加的 token 及来源：
  - J6 注册：`registration:on:{before_agent_start,tool_call,tool_result,message_start,session_start,session_compact,turn_end,session_shutdown}`、`registration:registerMessageRenderer:subagent:memory-inject`；
  - J4 的 `/mem` 描述变化：`registration:registerCommand:mem`；
  - 状态行：`command-line:jev: off (pi-api)`；
  - J4 补全：`completion:jev`、`completion:tags`；
  - J8 补全：`completion:review`、`completion:expired`（只在有 jev 端口时出现）。
- **白名单仍逐 token 校验**：追加 token 之前跑的真实输出如下，每一项多出的注册都单独失败；补 token 之后 completions 又单独失败一次，说明它对每一类差异都独立把关：
  ```
  unexpected extra registration: on:before_agent_start … on:session_shutdown (8 条) / registerMessageRenderer:subagent:memory-inject
  registration entry changed: registerCommand:mem
  → completion extra for "(empty)" …
  ```
- **dev 断言**：已改成 `if (PI_API_ALLOWED_DIFF.length === 0) expect(...)`，并注明「J6 起由 PI_API_ALLOWED_DIFF 白名单比对取代」。
- **剥注释**：只有 jev 开才剥。tiered 和 legacy 两份 golden 都绿；inject-jev 测试证明块里没有注释时开关开或关输出字节相同。

### 6. activate-trace 刷新说明

- 用 `PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance` 刷新。
- diff 只出现在 default 和 max 两个 profile 的 phase1：在 `registerTool(memory)` 之前插入上面那 9 条注册，count 分别从 182 变 191、236 变 245。
- phase2 不变（fakeCtx 没有 modelRegistry，所以是 off(pi-api)，不通知）。child profile 不启用 memory，因此不变。
- commit 说明建议写「memory jev hooks」。

### 7. 自验输出（真实结果）

- J6 定向套件：`timeout 900 npx vitest run tests/memory/jev tests/memory/inject-jev.test.ts tests/memory/inject.test.ts tests/memory/tiered.test.ts tests/memory/legacy-golden.test.ts tests/memory/wire.test.ts tests/integration/memory-jev-recall.test.ts tests/boundary/pi-free.test.ts tests/web-hub/boundary.test.ts`
  → `Test Files 33 passed (33) · Tests 683 passed (683)`
- governance：`PI_TOOLKIT_UPDATE_TRACE=1 … tests/governance` → 3 passed；不带更新复跑 → `Tests 3 passed (3)`
- 追加套件：`timeout 600 npx vitest run tests/memory/jev/off-golden.test.ts tests/memory/fs-guard.test.ts tests/governance tests/conformance/memory-jev-channels.test.ts`
  → off-golden 8 ✓，fs-guard 4 ✓，conformance `15 tests | 1 skipped`（门控项），governance 3 ✓；合计 `Tests 29 passed | 1 skipped`
- `timeout 600 npm run typecheck` → exit 0
- `timeout 300 npm run format:check` → exit 1，唯一告警是 `tests/memory/jev/entry-edit.test.ts`（J8 的文件）。我的 15 个文件单独 `prettier --check` 结果是 "All matched files use Prettier code style!"
- `git diff --stat HEAD -- tests/fixtures/` → `governance/activate-trace.json`（我的）和 `memory-tool-surface.json`（J5 的）。相对 `origin/dev` 还会多出 `memory/jev-off-golden.json`，那是本地已提交但 origin 尚未推送的 J0 文件。

### 8. 遗留与上报事项

1. **C-J6 流式 steer 路径**（已上报，root 同意列为遗留）：agent 正在流式输出时到达的 bash-job 通知走 steer 队列，没有可观察的钩子，这些后台任务失败拿不到 E 层召回。只覆盖到空闲唤醒轮和空闲静默 append。前台工具失败走 `tool_result`，不受影响。
2. **C-J4**：按断言设计，A 层在 turn_end flush，本 run 下一次 LLM 调用可见。
3. **E 层候选口径的取舍**：pending 条目（还没有侧车记录、type 未知）也当候选。否则未打标的语料永远不会有 E 层召回。arch 只写了 type 过滤，这一点需要回架构稿确认。
4. **未做**：
   - 判定缓存（J7 范围）：`/mem jev` 的 `verdict cache` 暂时恒为 0，compaction 清缓存的挂点在 `onCompaction`，留给 J7 接；
   - `doctorPort` 的「core 用量」提醒项；
   - `attachBashJobs` 只记录了端口，由 J7 消费。
5. **两处镜像代码**：
   - `review.ts` 的 `corpusFingerprint` 是模块私有的（J4 文件），我在 wire 里镜像了一份，并用测试钉住它和 `runReviewPass` 存下的值一致；
   - `tagBulk` 的 `"all"` 范围（由 `/mem tags add/enable` 触发）每次都会重问全部标签，约 22 次调用。端口不传标签 id，所以没法只补问单个标签。
6. **我的失误**（已告知 root）：中断前曾对 `src/memory/jev/*.ts` 跑过一次 `prettier --write`，可能顺带格式化了 J5/J8 的未跟踪文件。prettier 只改格式、幂等，之后我只对自己的文件跑。
7. 为了不改 `tests/memory/wire.test.ts`，子会话不注册 `session_start`（那个测试断言子会话 session_start 只有 2 个 handler）。这本来就符合 arch §8：子会话不探测，而且每次 `before_agent_start` 都会重新从分支播种。
