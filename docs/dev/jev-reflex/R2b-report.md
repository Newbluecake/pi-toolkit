# R2b 报告 · shadow 接线 + `/reflex status | explain | reset`

日期 2026-11-05 · 基线 dev（R0 ab14948b / R2a 18aad043 / R1 645050a4 / R2a′ f833a129，均未推送）· 无任何 git 写操作 · 未跑全量 `npm test`。

## 1. 文件清单

修改：

- `/home/bluecake/ai/pi-toolkit/src/reflex/wire.ts`（骨架 → shadow 全链路）
- `/home/bluecake/ai/pi-toolkit/src/reflex/command.ts`（骨架 → status/explain/reset）
- `/home/bluecake/ai/pi-toolkit/tests/reflex/wire-skeleton.test.ts`（命令/快照断言随 R2b 更新；注册清单、守卫、PD11 断言原样保留）
- `/home/bluecake/ai/pi-toolkit/docs/dev/jev-reflex/README.md`（R1/R2a 偏差与 port 输出约定、R2b shadow 语义、手动冒烟步骤）

新建：

- `/home/bluecake/ai/pi-toolkit/tests/reflex/wire-shadow.test.ts`（35 例）
- `/home/bluecake/ai/pi-toolkit/tests/reflex/command.test.ts`（9 例）
- `/home/bluecake/ai/pi-toolkit/tests/reflex/governance.test.ts`（5 例）
- `/home/bluecake/ai/pi-toolkit/docs/dev/jev-reflex/R2b-report.md`

## 2. plan §4 R2b 各步骤落点

| 步骤               | 落点（`wire.ts` 除注明）                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 input 同步段     | `pi.on("input")`：超龄检查 `flushIfOverAge` → correction（PD12，`detectCorrection` + 当场 `safeAppend("subagent:reflex-correction")`）→ `evaluateGate`（GateFacts 全字段按 plan）→ `matcher.match(caps)` → ambiguous 单槽 / high 单槽 + `queueMicrotask` 内 `executePort`（`scheduleShadowPort`）。同步返回 `{action:"continue"}`；整体 try/catch fail-open（注释写明与 pi 文档 fail-closed 建议相反的理由）。high∧auto 按 shadow 处理。 |
| 单槽 / 重复（PD6） | `settlePending(old, unknown)` 后替换；`recent` Map（cap 64）判 `REPEAT_WINDOW_MS` 内同 `id@ver+digest` ⇒ `reasked:true`。                                                                                                                                                                                                                                                                                                                |
| 2 agent_settled    | 超龄检查 → `toBranchLike(getBranch())` → `collectToolShapes` → `judgeAgreement` → 恰好一条 `subagent:reflex-record` → 清槽 + 建 `CorrectionMemo`。                                                                                                                                                                                                                                                                                       |
| 3 shutdown/start   | shutdown：`abort()`、pending 丢弃（不落盘）、`disposed=true`、`generation++`；start：re-arm、新 `AbortController`、清 pending/memo/recent。port 续体捕获 `gen`，`isStale(gen) \|\| pending !== p` 丢弃。同步入口不检查 `disposed`。                                                                                                                                                                                                      |
| 4 `/reflex`        | `command.ts`：`statusText`（脚本状态 + 激活计数 + `getBranch()` 汇总 + `evaluatePromotion` + 跨会话提示 + 未知 autoResolve id）、`explainText`（S0+S1 理想 TUI 事实，输出 veto 码 / band+脚本+`strong#i\|weak#i`，不执行 port）、`reset [id]`（经 wire 注入的 `reset` 回调，纯内存）。                                                                                                                                                   |
| 接线依赖           | `createReflexCommand(deps)` 的 `ReflexCommandDeps` 由 wire 构造；`ReflexWireDeps` 追加三个**可选**字段 `clock`/`monoNow`/`scripts`（默认 `systemClock`/`performance.now`/`BUILTIN_SCRIPTS`），`src/index.ts` 未改。                                                                                                                                                                                                                      |
| 横切（G2/G3/G4）   | `tests/reflex/governance.test.ts`：去注释后扫描 `src/reflex/**` 无 `Symbol.for(`、无裸 `setTimeout/setInterval/setImmediate`、无 `sendUserMessage/triggerTurn/"transform"`；另断言 `wire.ts` 不含 `sendMessage`（R3a 才引入）；含扫描器自检用例防空转。                                                                                                                                                                                  |

## 3. 偏差 / 实现裁量（请 root 知悉）

1. **ambiguous record**：`kind:"ambiguous"`，`scriptId`=首个候选，`model` 恒 `{agree:"unknown", tools:<实际 shapes>}`（ambiguous 没有单一脚本可比对）；不跑 port，无 `port` 字段。
2. **shadow 期 strike 记账**：port 结果在未过期且 slot 未被替换时喂 `onExecOutcome`；shadow/demoted 态下达到阈值静默置覆盖层（`status` 可见），仅 auto→demoted 才 `ui.notify`。plan 未明说 shadow 期是否计 strike，取「可见且保守」。
3. **`onRepeat`/AUTO `onCorrected` 不在 R2b 调用**：R2b 从不作答，重复/纠正不构成 AUTO 降级证据；留给 R3a。correction 的 `memo.kind` R2b 恒为 `shadow`。
4. **slot 被替换时其 port 结果整体丢弃**（含 strike），record 不带 `port`；agent 比 port 先结算时同理（port 预算 ≤1.2s，模型回合通常更久）。
5. **`inFlight` 恒 false**：shadow 不在 handler 里 await，没有 S2 在等；R3a 的 AUTO await 才置位（否则用户 1.2s 内连发会被误 veto）。
6. `ReflexWireDeps` 追加可选字段（见上）属于 wire.ts 自有类型，不动冻结面。
7. 状态命令里「promotion」每脚本一行只显示「not eligible（N 项未过）」，详细原因由 R3b 脚本给；跨会话未判定永远不 eligible。
8. 测试中的 I5 使用真 `activate()` + 真 `wireTopicSwitch` 构造 hold（沿用 `tests/integration/topic-switch.test.ts` 的 ctx 形状），其余用例用 fake pi + `FakeClock` 直接 `wireReflex`（比全 activate 更可控；注册面由 trace/golden 钉住）。

## 4. 测试覆盖对照（plan R2b 测试清单）

- R-I5：返回值非 thenable、`list` 在 microtask 之后才被调用、无 send/trigger 调用 ✔
- shadow 结局恰好一条 record、逐字段 `toEqual`（含 digest 形状、chars、port.ms、model）、不含原文 ✔；no-tool / diverge / auto 态仍记录 ✔
- 单槽替换、digest 不一致、超龄（FakeClock 推进后不调入口 ⇒ 零 append；入口触发才 flush；未超龄保留）✔
- I6：rpc/extension source、rpc/print/json mode、带图、steer/followUp、非空闲、pending messages ⇒ 零执行零记录（`it.each`）✔
- I5：真 topic-switch hold ⇒ R 层零记录且 topic-switch 第二次输入结果与 reflex 关闭时相同；无 hold 对照组记录 1 条；`source:"extension"` 放行；reflex handler 恰在 topic-switch 之前（比 off 多 1 个 input handler）✔
- goal 活跃 veto ✔
- shutdown 在 port 在飞：之后零 append、迟到结果不计 strike；shutdown→start：新会话产生新 pending/record，旧 memo/re-ask 窗口已清 ✔
- correction 持久：被短口令 veto 的「不对」当场一条 entry（逐字段）、重复不再记、窗口外不记、无候选不记、非 TUI 不记 ✔
- G2/G3/G4 ✔；`/reflex explain` 对目录全部 hit/miss 例句与直接 `evaluateGate+match` 一致 + 固定输出；`status` 内联全文快照（空 / 有会话记录 / demote / 未知 id）✔
- 额外：PD6 reasked 窗口、fail-open（ctx 抛错 / appendEntry 抛错 / 畸形事件）、strikes→demoted→跨会话保留→`reset`。

## 5. 自验

```
$ npx vitest run tests/reflex tests/boundary/pi-free.test.ts tests/integration/reflex-off-golden.test.ts \
    tests/integration/topic-switch.test.ts tests/governance tests/conformance/reflex.test.ts   # PI_TOOLKIT_TEST_WORKERS=2
 Test Files  27 passed (27)
      Tests  356 passed | 1 todo (357)        exit=0   （全文 /tmp/r2b-tests.log）
 （含 reflex-off-golden 原样通过、activate-trace、bundle-parity、conformance C-R1…C-R8；todo = C-R6 既有）

$ npm run typecheck   → exit 0（/tmp/r2b-typecheck.log，无诊断）
$ npm run build       → exit 0，build:bundle ok sha256=0d72a40e2dbb3683（/tmp/r2b-build.log）
$ npx prettier --check <改动文件 7 个>  → All matched files use Prettier code style!（/tmp/r2b-format.log）
$ git diff --quiet HEAD -- tests/fixtures/ src/reflex/core/ src/reflex/ports/ src/index.ts  → exit 0（frozen=0）
```

## 6. 手动冒烟步骤（未执行，需用户本机）

1. `pi-toolkit.json` 设 `"reflex": {"enabled": true}`，`/reload`。
2. 问「后台还有几个 job」→ 模型正常作答（无任何 reflex 输出）。
3. `/reflex status` → `candidates=1`，会话记录出现 `jobs.list@1 cand=1`；`agree` 取决于模型是否用了 `bash_job list`。
4. `/reflex explain 工作区干净吗` → `band=high script=git.status candidates=git.status（strong#0）`；`/reflex explain 把改动提交了` → `veto=imperative`。
5. 紧接着输入「不对」→ `/reflex status` 的 `corrected=1`；`/reflex reset` 清覆盖层。
6. 观察 `agree` 是否长期 `unknown`：若是，说明会话里的 user 消息文本与 input 文本不一致（前序 handler 改写），需要查 digest 口径。

## 7. 遗留

- `agree=unknown` 的 digest 口径风险（见冒烟 6）；README 已记。
- 全量 `npm test` 未跑（并行资源禁令），由 root 单份执行。
- R3a：AUTO 分支、`onRepeat`/`onCorrected`、`inFlight`、`sendMessage` 均未触碰。
