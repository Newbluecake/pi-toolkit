# pi 1.2.0 兼容基线（2026-10-15）

取证环境：`git worktree /tmp/pt-pi12`（HEAD = bee72f5，不含 c807d62 的 fake-droid 修复），
devDeps 装 `@earendil-works/pi-{ai,coding-agent,tui}@1.2.0`；对照组 = 主工作区（pi 1.1.0）。
原始日志：`/tmp/pt-pi12-logs/`（01-install … 07-main-pi11-full）。

## 结论：真正由 pi 1.2 引起的问题

| #   | 现象                                                                                                                                                                                                                                                                                                        | 位置                                                                    | 判定                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | `tsc`：`Property 'prompt' does not exist on type 'BeforeAgentStartEvent'`                                                                                                                                                                                                                                   | `src/feishu-notify/index.ts:505`（2 处）、`src/title/index.ts:238`      | 1.2 把事件改为按 `messageType` 区分的 union，`"custom"` 那种没有 `prompt`                                                                                                                                                                |
| T1′ | 3 个由 T1 连带的测试失败：`tests/release/package-zip.test.ts`、`tests/service/request-threading.test.ts`（WC13 编译闸门）、`tests/workflow/wc14-testhooks-gate.test.ts`（build）                                                                                                                            | —                                                                       | 都会跑 tsc/build，T1 修好后应自动恢复                                                                                                                                                                                                    |
| C1  | conformance `tests/conformance/topic-switch-hop.test.ts` S4：空闲时连续 3 次 `pi.sendUserMessage(marker,{deliverAs:'followUp'})`（每次等 input 事件出现 + `!isStreaming`）。每次重投仍只产生 1 个 input 事件、source/streamingBehavior 断言通过，但 **`modelRuntime.callCount()` 期望 3、实际 2**（`:200`） | `tests/conformance/topic-switch-hop.test.ts:167-200`                    | 推测：1.2 下 run “启动中”算 busy 但 `isStreaming` 可能已为 false，后一条 followUp 被并进正在启动的 run，两条重投合成一轮。需确认是测试的等待条件过时，还是 topic-switch release 队列“每条被扣请求一个独立 turn”的语义真的变了（影响 I2） |
| C2  | conformance `tests/conformance/history-restore.test.ts` RH1–RH4                                                                                                                                                                                                                                             | `src/web-hub/protocol/spawn.ts` `SUPPORTED_PI_RANGE` maxExclusive 1.2.0 | 真实 hub 的 launcher 检查拒绝 pi 1.2.0（incompatible）；放宽范围后需复验                                                                                                                                                                 |
| R1  | 版本范围：`package.json` peer `>=1.0.0 <1.2.0`、devDeps `^1.1.0`；`src/adapters/pi-compat.ts` 的测试范围；`SUPPORTED_PI_RANGE`                                                                                                                                                                              | 参考提交 `b86b86a feat(compat): support pi 1.1.x` 的 10 个文件          | 例行放宽到 `<1.3.0`                                                                                                                                                                                                                      |

## 排除项（与 pi 1.2 无关）

- `tests/integration/external-droid-{chain,hang}.test.ts`（20 项）+ `tests/integration/quota-wiring.test.ts`（1 项）：主工作区 pi 1.1 下同样失败。
  根因是 9a2c123 把 droid 协议版本钉到 1.265.0 时漏改了 `tests/external-agent/fixtures/fake-droid.mjs`，已在 c807d62 修复（25 文件 271 项通过）。
- `tests/bash/process.test.ts`、`tests/git/run.test.ts`：全量并发高负载下的偶发失败，单独复跑在 pi 1.2 下通过。

## 未覆盖（需要方案关注的行为变化，测试未必能暴露）

- `before_agent_start` 现在会在 `sendMessage(triggerTurn)` 发起的 run 上触发：所有 handler 的副作用（sysprompt hub、memory、topic-switch、title、feishu-notify）都要按 `messageType` 判断。
- `src/sysprompt/wake-replay.ts` 是给 1.2 之前的缺陷打的补丁（唤醒 run 丢 system prompt 段落）；1.2 原生修复后可能重复注入或冲突。
- run 启动期间 `ctx.isIdle()` 为 false、`sendMessage` 排进正在启动的 run：投递/通知/延迟 reload 等路径里依赖 “Agent is already processing” 报错或 isIdle 判断的逻辑。
