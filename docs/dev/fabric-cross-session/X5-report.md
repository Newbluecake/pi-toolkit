# fabric 二期 X5：可观测与终局报告

状态：**实施、自验完成，待主会话独立 verifier 与终局全量**。基线 `a515874d`，隔离 worktree；2026-10-21。依据 `phase2-plan.md` §8/§11/§13/§14、优先级最高的 r3 裁定及 `XW-report.md`。按要求未运行全量 `npm test`，未修改 `wake.ts` 或两份 off golden。

## 1. 可观测面

`/agent status` 从当前 `Stack.xs` 读取 membership、receiver quota/counters、fence、controller 与 audit；不存在 xs stack 时不增加任何行。样例：

```text
xs joined · recv wake · cap verified · in 3/30h · out n/a/60h · wakes 1/12h · fenced 1 · stuck 0 · unbound 0 · lateAbort 0 · abortStuck 0
```

- 全部为 English compact tokens。`fenced` 是接收拒收累计数，`stuck` 是当前超时未开窗的栅栏数量，`unbound` 为当前 controller 在 `starting|deferred` 的占位数（本会话最多 1）。`lateAbort` / `abortStuck` 读取真实 audit 计数。
- **出站用量不可得，不伪造 0**：hub `info` 只有限额，既有 sender 没有本地出站窗口计数。consult 方案作者 `r_P3GWCTPX` 后用 `out n/a/<local cap>h`，未为凑样例扩展协议或改变 X3 限额语义。
- `AgentCard` 仅在 hub caps 含 `xs.v1`、`status.xs.joined === true` 且 receive 合法时展示 `xs wake` / `xs deliver` / `xs off`。只读 chip，无按钮。复用现有 removing 条件分支的空占位，cap 缺失不新增 DOM 注释占位；删除中的卡片保留原 removing 提示优先级。
- 单测验证 off status 字节一致、cap-less 渲染字节一致、三种徽标及异常/缺席 status；真实双 stack 集成还断言 `/agent status` 从 `cap unknown` 到 `cap verified`。
- `AGENTS.md` 仅在 `src/fabric/` 段追加二期说明，包含设置键、门控、两层人控、唤醒/栅栏/M2、限额、conformance 闸门和设计路径。

## 2. XW minor 1–4 与追加回归

| 项                  | 修复与真实断言                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| minor1              | 两工具与 `/fabric` 的注册块移到 compat 成功之后。compat 失败时没有 xs 工具/命令；**早期 B1 hook 保留**，带 xsWake 的无授权 trigger 仍调用 abort 并审计 orphan。                                                                                                    |
| minor2              | 两工具 `execute` 把 pi 的第三参数 signal 传入真实 sender。Esc 在 resolve 阶段取消：`none/origin_changed`，send 从未调用；send 后断链：`unknown/origin_changed_after_send`；send 后拿到 applied：保留 applied。list 验证已取消时零请求，以及 live signal 原样透传。 |
| minor3              | 子进程 fixture 支持 autoJoin 参数。真实 hub × activate/buildSessionStack × socket：不调用 join 即可被发现；hub 收到该 session 的 `session` 帧之后才收到 joined `xs_member`；fork 即使 autoJoin 开启仍不加入、不出现在 list。                                       |
| minor4 web_exec     | 通过真实 hub `registry.request` 发送 web `/new` 命令，实际 X2 exec claim 被持有、trampoline 尚未执行时，跨会话 socket 发送得到 `none/fenced:web_exec`，零接收写入。                                                                                                |
| minor4 topic_switch | 真实 `wireTopicSwitch.webGate.tryClaim` 创建 hold → 真实 `fenceActive` getter → SessionFence → XsReceiver，同步返回 `none/fenced:topic_switch`、零 send；shutdown 后实际 hold 与栅栏解除。此用例是模块组合集成，不冒称真实浏览器操作。                             |
| 主会话追加 XW 回归  | index 的 xs sessionId 读取集中为 optional-chain + try/catch；xs-off 且无旧授权/marked trigger 时不新增读取；读不到 id 则跳过绑定/teardown。最小 ctx 的原 3 个失败文件全部转绿，另补 getter 抛错且不可访问的 off 用例。B1 对 marked orphan 仍失败关闭。             |

## 3. C-X* 结果

环境：Node **22.22.1**，真实 pi **1.3.0**；`DefaultResourceLoader` + `createAgentSession` + `bindExtensions`，真实 extension event / AgentSession / Anthropic HTTP adapter，网络仅本地 `AnthropicStub`。Controller 注入 FakeClock **只加速 watchdog 截止**，不替代 pi、provider、compaction 或 session runtime。

| 锚点  | 结果           | 取证                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-X1  | PASS           | `sendMessage(triggerTurn:true)` 同步返回后 `ctx.isIdle() === false`；真实 before_agent_start 为 custom，携带 details.xsWake / wakeToken；ctx.abort 后 `agent_settled{aborted:true}`。                                                                                                                                                                                                                                      |
| C-X1b | PASS（4 用例） | 预启动压缩的真实 stub HTTP 等待 **10.05s**，期间 starting/owner 保持、slow-start 被计数；之后 token 真正 bound，绝对截止 abort 慢 provider；另在预启动 compaction hook 内 abort，触发 run 的 provider 请求 **0** 且 aborted settled；agent_settled handler 内派发得到 start_deferred，迟到启动仍携 token；启动期真实 rpc input 使状态 handedOver，跨截止无 abort；无授权 marked orphan 首请求前中止、provider 请求 **0**。 |
| C-X2  | PASS（2 用例） | 真实 manual compact hook 等待 **30.05s**，前后 receiver 都拒收，stuck 仍拒收；扩展 cancel 导致真实 session_compact_failed 开窗；真实 navigateTree cancel 后 input **不开窗**；真实 AgentSessionRuntime.newSession 的慢 before_switch 期间 input 仍拒收，cancel 后仍拒收，local reset 才放行。                                                                                                                              |
| C-X3  | PASS           | 真实 ask_user 工具保持已挂载；quiet notice 直接 sendMessage(false) 时 dialog 不关闭、completion broadcast/token 均为 0、无额外请求；人类 Enter 可正常回答、通知最终只追加 1 次。                                                                                                                                                                                                                                           |
| C-X4  | PASS           | 真实 SessionManager.inMemory 无文件；pi.appendEntry 的 membership 在同 manager 重建后保留 joined / receive，换 session id 的 fork 不继承。仅 session-memory，不声称跨进程 durability。                                                                                                                                                                                                                                     |
| C-X5  | PASS           | 真实 HTTP 原始请求体无 token、xid、from secret、wakeToken、xsWake；正常正文存在。xs 开启后 3 次请求 tools/system 深度相同，工具表包含两个 xs 工具；不比较开关前后前缀。                                                                                                                                                                                                                                                    |
| C-X6  | PASS           | 有界子进程实跑 fabric-wake C-P1–C-P5 + consult-preserve：**2 files passed，21 passed / 1 skipped**（既有 consult C8 / 待拍板，与本包无关）。无 golden 更新。                                                                                                                                                                                                                                                               |
| C-X7  | RECORDED       | pi 1.3.0：该装载顺序下初始 xs 工具声明可见，后加两份同名声明未执行；实际工具调用返回原 xs sender 的 `none/origin_changed`。只输出可见声明、执行记录、toolResult 与 errors，不断言赢家或把此行为当生产契约。                                                                                                                                                                                                                |

`tests/conformance/fabric-xs.test.ts` 合计 **12 passed**；与 fabric-wake 一起的指定命令 **20 passed**。C-X7 按要求为 record-only，其他测试均有行为断言。

## 4. 自验命令与输出

以下最终命令均 exit 0（日志保存在本 worktree 开发进程的 `/tmp/x5-*.log`；报告保留可移植的结果，不依赖日志存活）：

```sh
timeout 600 npx vitest run tests/fabric tests/integration/fabric* tests/tools tests/commands tests/web-hub/ui
# Test Files 305 passed (305)
# Tests      6591 passed (6591)

timeout 900 npx vitest run --config vitest.config.ts tests/conformance/fabric-xs.test.ts tests/conformance/fabric-wake.test.ts
# Test Files 2 passed (2)
# Tests      20 passed (20)
# C-X6 内部：2 files passed, 21 passed / 1 skipped

timeout 240 npm run typecheck
# tsc main + tsc contracts + vue-tsc: 0 errors

timeout 400 bash -c 'npm run build && npm run build:web && npm run check:web'
# tsc exit 0; vite build exit 0; check:web OK
# 81 files; first-screen JS 324852B gz / 524288B
# lazy JS 46681B gz / 131072B; CSS 33599B gz / 65536B

timeout 120 npm run format:check
# All matched files use Prettier code style!

timeout 90 npx vitest run tests/integration/system-prompt-injection.test.ts tests/integration/mention-autocomplete-wiring.test.ts tests/integration/web-hub-disabled.test.ts
# Test Files 3 passed (3), Tests 15 passed (15)

git diff --check
# exit 0
```

`package.json` 的 `test:conformance` 使用默认 Vitest 配置；这里显式指定相同的 **vitest.config.ts**，没有另创配置或跳过 conformance。

两份 off golden 测试各 **2 passed**，文件相对 HEAD 无差异，SHA-256 前后相同：

```text
fabric-wake-off-golden.json  7706698af8ec0eb4fa2c01a30e64dafc0ab854fe5cc2539efba4eb3892e22545
fabric-xs-off-golden.json    eb65c907c4403f4e13486d25a119331573a140a6f97be00063fdb14da95e1e07
```

既有测试的预期 stderr（quota 无凭据、故意损坏 lazy chunk、fence stuck）不作为失败。Vite 仍有既有大 chunk 粗粒度告警，`check:web` 所有正式预算/安全/provenance 闸门通过。无生产 timer 新增；测试新增等待 timer 均 unref，子进程 conformance 有 180s 硬截止。

## 5. 文件清单

worktree 根：`/tmp/pi-subagent-worktrees/r_AAB5PFFH/`。

- `AGENTS.md`
- `src/commands/status.ts`
- `src/index.ts`
- `src/tools/list-sessions-tool.ts`
- `src/tools/message-session-tool.ts`
- `src/web-hub/ui/src/components/agents/AgentCard.vue`
- `src/web-hub/ui/src/components/agents/agentCardModel.ts`
- `tests/commands/status-xs.test.ts`
- `tests/conformance/fabric-xs.test.ts`
- `tests/integration/fabric-xs-activation.test.ts`
- `tests/integration/fabric-xs.test.ts`
- `tests/integration/fabric-xs-topic-fence.test.ts`
- `tests/integration/helpers/fabric-xs-harness.ts`
- `tests/integration/helpers/fabric-xs-process.ts`
- `tests/tools/xs-tool-cancel.test.ts`
- `tests/web-hub/ui/agent-card-xs.test.ts`
- `docs/dev/fabric-cross-session/X5-report.md`

## 6. 偏差与遗留

1. `out n/a/60h` 而不是伪造样例 `out 2/60h`，原因与作者 consult 已在 §1 说明。未来若需要权威用量，应独立设计 hub info 的用量投影，不在 X5 越界。
2. C-X2 的 tree/switch 取消后 input **不**开窗，严格服从 r3 M1，覆盖正文旧 X5 行的“直到下一次输入”。
3. C-X6 为真实、有界子进程回归，而不是重复 import 注册旧 suites；终局全量运行时会多跑一次相关旧 gates，换取单独指定 X5 文件也真正执行 C-X6 的可复现性。
4. 无实现 Blocker 遗留。独立 verifier 和主会话全量 `npm test` 尚待调度方执行；本报告不自称独立验收通过。既有 XW/前包报告所列范围外问题没有顺手修改。
