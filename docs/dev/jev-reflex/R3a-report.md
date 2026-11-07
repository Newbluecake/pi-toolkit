# R3a 报告 · autoresolve（AUTO 分支、命中消息、降级、repeat/correction）

日期 2026-11-05 · 基线 dev（R0 ab14948b / R2a 18aad043 / R1 645050a4 / R2a′ f833a129 / R2b b669a255，均未推送）· 无任何 git 写操作（add/commit/stash/checkout/reset/restore 均未执行）· 未跑全量 `npm test`（并行资源禁令，root 单份执行）。

root 裁定已执行的三项（2026-11-05，message_agent 往返）：

1. `tests/reflex/governance.test.ts` G4 收紧放开（进本包文件域）：仅 wire.ts 可出现 `.sendMessage(`；每调用点 240 字符内必须 `customType: "subagent:reflex"`；调用点数 >0；顶层只有一个对象实参（括号/花括号深度扫描，无第二个 options 参数）；全局 sendUserMessage/triggerTurn/"transform" 扫描逐字节不变。
2. 否决「setStatus 能力探测」（测试形状不入生产逻辑）：AUTO 无条件作答；`setStatus` 用可选调用 `ctx.ui?.setStatus?.(...)` 容错，不作为作答条件。放开 `tests/reflex/wire-shadow.test.ts` **仅一条**用例（完整 diff 见 §4）。
3. `src/reflex/command.ts` status 文案改为「auto 命中时直接作答…」+ `tests/reflex/command.test.ts` 两处内联快照行同步（diff 见 §4）。

## 1. 文件清单

修改（绝对路径）：

- `/home/bluecake/ai/pi-toolkit/src/reflex/wire.ts`（R2b shadow 接线 → R3a AUTO 全链路）
- `/home/bluecake/ai/pi-toolkit/src/reflex/render-tui.ts`（骨架 → 紧凑 renderer）
- `/home/bluecake/ai/pi-toolkit/src/reflex/command.ts`（仅 status 文案一行，root 批准）
- `/home/bluecake/ai/pi-toolkit/tests/reflex/wire-shadow.test.ts`（仅一条用例改写，root 批准；其余逐字节不变）
- `/home/bluecake/ai/pi-toolkit/tests/reflex/governance.test.ts`（G4 按裁定收紧放开，root 批准）
- `/home/bluecake/ai/pi-toolkit/tests/reflex/command.test.ts`（两处快照行，root 批准）

新建：

- `/home/bluecake/ai/pi-toolkit/tests/reflex/wire-auto.test.ts`（18 例）
- `/home/bluecake/ai/pi-toolkit/tests/reflex/render-tui.test.ts`（5 例）
- `/home/bluecake/ai/pi-toolkit/docs/dev/jev-reflex/R3a-report.md`（本文件）

冻结面核验：`git diff --quiet HEAD -- tests/fixtures/ src/reflex/core/ src/reflex/ports/ src/index.ts` 退出 0；`tests/reflex/wire-shadow.test.ts` 的改动仅 root 裁定放开的这一条用例（§4 全 diff）。

## 2. plan §4 R3a 各步骤落点（`wire.ts` 除注明）

| 步骤           | 落点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 handler 形态 | input handler 仍是**普通非 async 函数**；veto/miss/ambiguous/shadow/demoted/repeat 分支同步返回 `CONTINUE`（`{action:"continue"}`）；**只有 AUTO 非 repeat 分支** `return runAuto(...).catch(() => CONTINUE)`（Promise；`.catch` 兜底使其永不 reject）。R-I5 非 thenable 断言（wire-shadow）原样绿。                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 1 runAuto      | async 内部函数：`ctx.ui?.setStatus?.("reflex","reflex…")` → `executePort(port,{cwd,now,signal,budgetMs:script.budgetMs ?? REFLEX_BUDGET_MS},clock)` → `isStale(gen)`（进入时捕获）⇒ 零副作用 continue → `ok` ⇒ `renderAnswer` ⇒ `pi.sendMessage({customType:"subagent:reflex",content,display:true,details})`（**单实参**，无 options，C-R3）⇒ `bump("answered")` + `answers` 窗口记账 + 清 pending（作答不产 record，§5.1）+ memo `kind:"answer"` ⇒ `{action:"handled"}`。非 ok ⇒ `onExecOutcome`（strike；auto→demoted ⇒ `ui.notify` 一次中文散文）⇒ `bump("fallback.<kind>")` ⇒ 槽改 `kind:"fallback"` + `p.port=outcome` ⇒ continue。整体 try/catch fail-open（R-I4）；`finally` 仅 `!isStale(gen)` 时清 `inFlight`/status（root nit a；换会话的 re-arm 已重置）。 |
| 1 repeat       | AUTO 入口先查 `answers`（同 `id@ver\0digest` 在 `REPEAT_WINDOW_MS` 内被作答）⇒ `onRepeat(rt,now,state)`（3 参形态，state 恒 "auto"）+ notify 一次 ⇒ 槽 `kind:"repeat"`（`reasked:false`，避免 promotion 口径双计）⇒ **同步** continue。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2 correction   | R2b 的 PD12 持久化路径保留；新增：目标 `kind:"answer"` ⇒ `onCorrected(rtOf(id),now,stateOf(id))` 降级 + notify 一次。`memo.corrected` **只在 appendEntry 成功时翻转**（root nit b）：写入失败则一次性窗口保留、后续纠正可重试补账；降级与 counter 均以「检测到」为准，`corrected` 计数只在落盘成功时 bump（见 §3.4）。                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3 render-tui   | `reflexDisplayText`（纯函数）：`reflex · <scriptId> · <ms>ms` + `Q:` + 正文；剥 `<reflex …>` 外壳与末尾中文提示（正则锚定 §5.1 形状）；header 数字取自 `details`（权威审计），不重解析外壳。缺 details / 非 string content / 形状不合 ⇒ `undefined` 回退 pi 默认渲染。Component 用 `Text(theme.fg("dim",header)\nbody, padX, 0)`（与 date renderer 同款）。                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4 reset/status | `reset` 清覆盖层（R2b 已有，未改逻辑）；`status` 显示 `demote=<reason>`（R2b 已有）+ 文案一行更新（root 批准，§4）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

接线依赖：`ReflexWireDeps` 未增字段；`src/index.ts` 未动（X2 冻结）。

## 3. 偏差 / 实现裁量（请 root 知悉）

1. **agent_settled 的 agreement 判定条件从「kind==="shadow"」放宽为「kind!=="ambiguous"」**（wire.ts 一行 + 注释）：fallback/repeat 槽都指向单一脚本、模型也确实作答了，agreement 语义成立；ambiguous 维持 unknown（无单一脚本可比对，R2b 偏差 1 的精神保留）。这使 fallback/repeat record 带真实 agree（wire-auto 断言 no-tool/agree/diverge 各一）。promotion 口径不受影响（`accumulate` 只按 kind 分桶，agree 独立累计）。
2. **`inFlight` 生命周期**（root nit a 收口）：AUTO 分派时同步置 true（进入 gate 前的 S0 #「in-flight」否决据此工作，单飞守卫）；`finally` 仅 `!isStale(gen)` 时清；**shutdown 不清、只有 session_start re-arm 清**（PD11 原文如此）。后果：shutdown-未-restart 期间输入被 veto in-flight（保守方向「少答」），可接受；wire-auto 断言钉住该序列。
3. **repeat 槽 `reasked:false`**：`accumulate` 对 `kind:"repeat" ∧ state:"auto"` 已计一次 reasked，再带 `reasked:true` 会双计；故 repeat 槽强制 false，测试断言 `reasked` 键不存在。
4. **correction 计数/降级与落盘的关系**（root nit b 的具体化）：落盘成功 ⇒ `memo.corrected=true` + `bump("corrected")`；落盘失败 ⇒ memo 原样保留（同目标后续纠正重试 append，成功后补一次 bump），**降级照常发生**（行为与审计分离：用户确实纠正了，不能因 appendEntry 抖动放过 PD5）。极端情况（append 永远失败）下激活计数会比检测次数少——保守方向，测试覆盖「失败→恢复→补账→不再重复」。
5. **answers 窗口**：`Map<key, answeredAt>`，与 `recent` 同款插入序 LRU（cap 64）、session_start 清空（PD11：repeat/correction 窗口绑定本会话 transcript）。plan 只说「记 answered（digest、时间）」，未定容器；与 PD6 的 `recent` 对称。
6. **notify 文案**：三段中文散文（连续失败/重复提问/被纠正 ⇒ 「已降回 shadow（/reflex reset 或 /reload 恢复）」），逐字节钉在 wire-auto；比 R2b 的英文短句更贴 plan R3a 步骤 1 的示例（UI 语言规则：散文块允许中文）。
7. `runAuto` 的 `sendMessage` 失败（测试注入）⇒ catch ⇒ continue，槽保持 kind:"shadow" 落 record（wire-auto「exception ⇒ continue」例）——与 R-I4「含异常一切非 ok ⇒ continue」一致。

## 4. root 批准的测试面改动（完整 diff）

### 4.1 `tests/reflex/wire-shadow.test.ts`（仅此一条用例；其余逐字节不变）

```diff
--- a/tests/reflex/wire-shadow.test.ts
+++ b/tests/reflex/wire-shadow.test.ts
@@ -169,22 +169,34 @@ describe("R-I5 synchronous shadow", () => {
     expect(h.appended.length).toBe(1);
   });

-  it("no tool calls ⇒ no-tool; unrelated tool ⇒ diverge; high ∧ auto is recorded (state:auto) but never answered", async () => {
-    const h = harness({ autoResolve: ["jobs.list"] });
-    h.input(JOBS_Q);
+  it("R3a: auto answers (handled, one sendMessage) while autoResolve holds the id; live removal returns to shadow-only records (no-tool / diverge)", async () => {
+    const autoResolve = ["jobs.list"]; // the harness re-reads opts.autoResolve on every input (live)
+    const h = harness({ autoResolve });
+    const first = h.input(JOBS_Q);
+    expect(typeof (first as { then?: unknown }).then).toBe("function"); // AUTO: the only thenable branch
+    await expect(first).resolves.toEqual({ action: "handled" });
+    expect(h.forbidden).toEqual(["sendMessage"]);
+    h.settled(); // an ANSWERED question leaves no reflex-record (deep assertions: wire-auto.test.ts)
+    expect(h.records()).toEqual([]);
+
+    autoResolve.length = 0; // live removal (/agent settings): effective on the very next input
+    const second = h.input(JOBS_Q2);
+    expect(second).toEqual({ action: "continue" });
+    expect(typeof (second as { then?: unknown }).then).not.toBe("function");
     await flush();
-    h.state.branch = [userMsg(JOBS_Q)];
+    h.state.branch = [userMsg(JOBS_Q2)];
     h.settled();
-    h.input(JOBS_Q2);
+    h.input(JOBS_Q);
     await flush();
-    h.state.branch = [userMsg(JOBS_Q2), assistantTools({ name: "read", arguments: {} })];
+    h.state.branch = [userMsg(JOBS_Q), assistantTools({ name: "read", arguments: {} })];
     h.settled();
     const recs = h.records();
     expect(recs.map((r) => [r.state, r.model.agree])).toEqual([
-      ["auto", "no-tool"],
-      ["auto", "diverge"],
+      ["shadow", "no-tool"],
+      ["shadow", "diverge"],
     ]);
-    expect(h.forbidden).toEqual([]);
+    expect(recs.every((r) => r.kind === "shadow")).toBe(true);
+    expect(h.forbidden).toEqual(["sendMessage"]); // shadow never answers
   });

   it("single slot: a new candidate flushes the unsettled one as unknown", async () => {
```

改写语义 = root 建议的「autoResolve 经 live 设置移除后回到 shadow 只记录不作答」，并保留原用例的 no-tool/diverge agreement 断言（现作用于 shadow 态记录）。

### 4.2 `src/reflex/command.ts` + `tests/reflex/command.test.ts`

```diff
--- a/src/reflex/command.ts
+++ b/src/reflex/command.ts
@@ -115,7 +115,7 @@ export function statusText(...)
-  lines.push("脚本状态（shadow 只记账不作答；R2b 中 auto 也按 shadow 处理）：");
+  lines.push("脚本状态（shadow 只记账不作答；auto 命中时直接作答，失败两次/重复/被纠正自动降回 shadow）：");
--- a/tests/reflex/command.test.ts
+++ b/tests/reflex/command.test.ts
@@ -123,7 +123,7 @@（快照一，同串替换）
-        "脚本状态（shadow 只记账不作答；R2b 中 auto 也按 shadow 处理）：",
+        "脚本状态（shadow 只记账不作答；auto 命中时直接作答，失败两次/重复/被纠正自动降回 shadow）：",
@@ -183,7 +183,7 @@（快照二，同串替换，两处仅此行）
```

### 4.3 `tests/reflex/governance.test.ts`（G4，按裁定收紧放开）

- 删除「wire.ts 不含 sendMessage」断言；新增：`offenders(/\.sendMessage\s*\(/)) === ["wire.ts"]`（全 reflex 树仅 wire.ts）；wire.ts 调用点数 >0；每调用点 240 字符内 `customType: "subagent:reflex"` 且无 `triggerTurn|deliverAs`；`callArguments` 深度扫描断言顶层逗号数 0 且首字符 `{`（单对象实参、无 options）。自检用例扩三条（单对象/双实参/非对象首参）。

## 5. 测试覆盖对照（plan R3a 清单 → `tests/reflex/wire-auto.test.ts` 18 例 + `render-tui.test.ts` 5 例）

- I1 命中：handled、恰一次 sendMessage、单实参、content 与 `renderAnswer` 输出**逐字节相等**且另钉一段完整字面量（jobs 空表 emptyText 行 + git 真行两例）、details 形状（含 `requestDigest`/`lines`/`truncated`/`facts`）、无 record、status set/clear、counters ✔
- 返回值形态：AUTO thenable；veto/miss/ambiguous/shadow 非 thenable；repeat 非 thenable ✔（wire-shadow 改写用例补 live 移除路径）
- I2 非结局：uncertain（quota 无快照）/error（git exit 1）/timeout ⇒ continue、零 send、`kind:"fallback"` record（port outcome+ms+reason）、uncertain 不计 strike、`fallback.<kind>` 计数 ✔
- I3：两次 error ⇒ demoted(strikes) + notify 恰一次（文案逐字节）；demoted 态仍 shadow 记录（state:"demoted"）；`reset git.status` ⇒ auto 恢复并再次作答 ✔
- I4/PD5 repeat：同 digest 二问 ⇒ 同步 continue、`kind:"repeat"`（state auto、reasked 键不存在、agree 被判定）、demote(reason repeat) + notify 一次、第三次纯 shadow、窗口外（REPEAT_WINDOW_MS+1）正常再答 ✔
- PD5 correction：作答 →「不对」⇒ 恰一条 `subagent:reflex-correction`（targetKind answer，逐字段）、demote(corrected) + notify 一次、二次纠正不重复、reset 恢复 ✔；nit b：append 失败不烧 memo、恢复后补账 ✔
- I7/PD11：await 期间 shutdown ⇒ 零 send/append/strike、`inFlight` 保持 true 直到 session_start re-arm；shutdown→start ⇒ 旧续体 inert、新会话同闭包正常作答、memo 重建（新 answer 可被纠正，旧候选不可）✔；runAuto 异常（sendMessage 抛）⇒ continue + 槽按 shadow 落 record + finally 清 status ✔
- 预算边界：FakeClock advance(1199) 后 resolve ⇒ handled（计时器已清）；advance(1201) ⇒ timeout fallback + 1 strike，晚到 port 结果无副作用 ✔
- I8 live：settings 每次 input 现读——live 添加 id 下一问即作答（wire-auto）；live 移除回 shadow（wire-shadow 改写用例）；未知 id 进 `unknownAutoResolve` ✔
- in-flight 单飞：await 期间第二问被 S0 veto（同步 continue、无第二次 port run、`inFlight=true`）✔
- render-tui：纯文本形态（header 取 details、剥壳剥 footer、body 逐字）、ms 取整、畸形 details/content 各 6+ 例 ⇒ undefined、`instanceof Text` ✔
- governance G2/G3/G4 ✔（G4 收紧版 + 自检）

## 6. 自验（真实输出；全文 tee 于 /tmp，未截断）

```
$ npx vitest run tests/reflex tests/boundary/pi-free.test.ts tests/integration/reflex-off-golden.test.ts \
    tests/integration/topic-switch.test.ts tests/governance tests/conformance/reflex.test.ts   # PI_TOOLKIT_TEST_WORKERS=2
 Test Files  30 passed (30)
      Tests  398 passed | 1 todo (399)   exit=0（全文 /tmp/r3a-vitest.log，Duration 149.00s）
 （含 reflex-off-golden 原样通过、activate-trace、bundle-parity、conformance C-R1…C-R8；todo = C-R6 既有）

$ npm run typecheck   → exit 0（/tmp/r3a-typecheck.log，tsc×2 + vue-tsc 无诊断）
$ npm run build       → exit 0，build:bundle ok — dist/bundle/index.js sha256=ba006db70838741b size=4.68 MB（/tmp/r3a-build.log）
$ npx prettier --check <改动 8 文件>  → All matched files use Prettier code style!（/tmp/r3a-format.log；先 --write 过 wire-auto/governance 后复检）
$ git diff --quiet HEAD -- tests/fixtures/ src/reflex/core/ src/reflex/ports/ src/index.ts   → exit 0（frozen=0）
$ npx vitest run tests/reflex（prettier 后复跑）→ 24 files / 318 tests 全绿（/tmp/r3a-vitest2.log）
```

## 7. 本机手动步骤（plan 验收标准，未执行，留用户）

1. `pi-toolkit.json` 保持 `reflex.enabled=true`，把 `quota.summary` **临时**加入 `reflex.autoResolve`（live，无需 /reload）。
2. 问「额度还剩多少」⇒ TUI 出现 `reflex · quota.summary · Nms` 卡片（Q + 读数，无 XML 外壳）、**无模型回合**。
3. 紧接追问「刚才那个额度是哪个 provider 的」⇒ 模型能接上（上下文中有 Q/结果行）。
4. 再问同一句「额度还剩多少」⇒ 交给模型，`/reflex status` 出现 `repeat=1`、quota.summary `demoted=repeat`，HUD 有一次中文 notify。
5. 验毕从 `autoResolve` 移除（晋升要等 §7 门槛，shadow 数据约 2 周后由 R3b 脚本判定）。

## 8. 遗留

- `docs/dev/jev-reflex/README.md` 不在本包文件域：「当前状态（R2b…）」标题与「R2b shadow 语义」小节里「high ∧ state ∈ {shadow, demoted, auto} 都按 shadow 处理」「R-I3 …wire 连 sendMessage 都不调」等句已随 R3a 过时（R-I3 的 README 原文本来就是「从不 sendUserMessage/triggerTurn/transform」，仍准确）；请 root 在 R3a 合入时顺手更新（建议：状态行改 R3a、shadow 语义小节加一句「R3a 起 high ∧ auto 走 AUTO 作答」）。
- R2b 验收 nit (a)/(b) 均已收口（§2/§3.2/§3.4）。
- 全量 `npm test` 未跑（并行资源禁令），由 root 单份执行；本包定向面全绿。
- web-hub 镜像仍按通用 custom message 显示原文（含 XML 外壳）——I10 不新增 wire 字段，维持 README 残留记录。
