# #34 P1 实施报告 — fabric 消息 kind `finding` → `report`（P1：改名 + 未知 kind 处置）

> 任务 #34 包 P1。方案 `docs/dev/fabric-kind-rename/plan.md`（r3），按 §0/§4/§5/§6.1/§7（P1 行）/§8（P1 行）实施。
> 本报告为数据交付；P1 的 commit 由主会话执行（sha 待补）。

## 1. 基线（§7.2）

- **T0（任务基线）** = `bf7173890da800f9c53a48a7c0da2d875b4bad36`（dev，开工时 HEAD）。
- P1 开工 ① `git status --porcelain -- tests/fixtures tests/config/__corpus__` 为空 ✓（输出空，exit 0）。
- P1 开工 ② `git log --oneline origin/dev..T0 -- tests/fixtures tests/config/__corpus__`（他人已提交未推送的申报改动，**不属本任务、未触碰**）：

  ```
  cd1d6c4a feat(reflex): freeze the backtest contract and add the draft schema parser
  204da159 feat(web-hub): report reload progress and outcomes from the agent
  ```

- **P1 完成检查（工作区 vs T0）**：
  - `git diff --numstat bf717389 -- tests/fixtures tests/config/__corpus__` 恰好三行（三份 fixture 各 `1 1`）✓：
    ```
    1	1	tests/fixtures/fabric-wake-off-golden.json
    1	1	tests/fixtures/fabric-xs-off-golden.json
    1	1	tests/fixtures/message-agent-wake-schema-golden.json
    ```
  - `git diff bf717389 -- tests/fixtures | grep '^[-+] '` 恰好 6 行 = 3 对 `"const": "finding",` / `"const": "report",`（缩进、逗号不变）✓。
  - `tests/config/**` 零改动（corpus/pin 均未触碰，P2 处理）✓。
  - P1 commit sha：待 root 提交后回填。
- **P1 实施期间 HEAD 移动（已核）**：并行包在我工作期间被主会话合入（`bf717389` → `576e4af7`：
  `cc8b39b6`/`34e19878`（#25 backtest）与 `576e4af7`（#30 reload e2e））。这些提交**未碰**
  `tests/fixtures/**` 与 `tests/config/__corpus__`（`git diff bf717389..HEAD --stat` 为空），
  本包全部检查均以显式 T0 sha 为锚，不受影响；门禁 A/B 在合入后的当前树上复跑仍 PASS。

## 2. T-S1 的 PRE34 基线捕获（§7.4，改 steer-tool.ts 之前）

在 T0、未改任何源码时，用一次性 vitest 文件（跑完即删，未入库）对
`createSteerTool({ query: <stub>, fabricEnabled: () => false })` 捕获 `name/label/description/promptSnippet/`
参数骨架（递归去 description）/三个参数 description/fabric-off 下 reply ∈ {none,ack,report} 的 execute 返回。

- 捕获文件：`/tmp/pre34-steer.json`（副本 `/tmp/c34-pre34-steer-baseline.json`），
  sha256 `16bde59f470e86bb8918faf07fe0a9c0e62d3c70b4baa43d3d58fd63a8efd18e`。
- 常量已逐字节转写进 `tests/tools/steer-tool-off-surface.test.ts`（PRE34_*），P1 阶段断言只应用
  `DECLARED_SUBS` 前两条（description ×1/×0，reply ×1/×1，`reply.description` 中设置键恰好保留 1 次），与 §7.4 表一致。

## 3. 改动清单（全部落在 §7.1 P1 文件域内）

**src（16 个文件，其中 1 新增）**

| 文件                                    | 内容                                                                                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/message.ts`                   | `MessageKind`/`MESSAGE_KINDS` 的 `"finding"`→`"report"`（顺序不变）；新增导出 `isMessageKind`（注释不拼旧名）；`authorize()` 首行改用谓词                                                     |
| `src/fabric/unknown-kind.ts`（新）      | `UNKNOWN_KIND_REASON` + `retireUnknownKind`（幂等、永不抛、永不 dead letter；参数类型为结构化 `Pick<…,"transition">`，见 §6 偏差 2）                                                          |
| `src/fabric/router.ts`                  | 全部 kind 分支/计数表/hydrate/park/quota 改名（`findingQuota` 键**未动**，P2）；`hydrate` 后新增 `retireUnknownKinds()`（frozen ⇒ `{dropped:0}`，不 `onChanged`，不记日志）                   |
| `src/fabric/stack.ts`                   | E3：`hydrate()` 之后、WakeService/mailbox 构造之前调 `retireUnknownKinds()`；`dropped>0` 时 `console.warn` 一行（不含正文/key/kind 值）                                                       |
| `src/fabric/mailbox.ts`                 | kind 分支改名；E5（候选循环第一条退役并清 `waitingFor`/`parkRetryAt`）；E6（`rescheduleWake` 三个时间源排除未知 kind）；E7③（`successorRoute` 首行守卫）                                      |
| `src/fabric/wake.ts`                    | E7①（`active` 谓词）；E7②（构造时 `steerRecovered` 选择）；E8①（parked 候选排除）；E8②（未知 trigger 退役并按缺失同路径返回 `{trackInput:false,persistFailed:true}`）                         |
| `src/fabric/mention.ts`                 | `Extract<MessageKind,…>` 改名                                                                                                                                                                 |
| `src/tools/message-agent-tool.ts`       | schema 字面量（仅字面量，构造方式不变）；#33 注释/指引/description 词汇；E1 守卫（`SENDABLE_KINDS` 模块常量，execute 第一条、try 之外，文案按 §3.3 原文）；`:97` 的 `report findings to` 保留 |
| `src/tools/message-session-tool.ts`     | `:8` 注释 `Report semantics only`                                                                                                                                                             |
| `src/tools/steer-tool.ts`               | 注释、frameSteerReply 文案、description/reply description 词汇（P1 两条替换）；`fabric.findingQuota`（:56）**未动**，P2                                                                       |
| `src/fabric/thread/engine.ts`           | `degrade: "finding"\|"none"` → `"report"\|"none"`；注释                                                                                                                                       |
| `src/tools/thread-child-tool.ts`        | 注释；`markHandback` 类型；`sendHandbackFinding`→`sendHandbackReport`；GONE 回复 `A report was sent to the main session`                                                                      |
| `src/stack.ts`                          | 仅 §4.3 所列行：`sendFinding`→`sendReport`、注释、`sendHandbackReport`                                                                                                                        |
| `src/web-hub/protocol/keys.ts`          | 仅注释（:212 词汇；:228 改为 `the 「[fabric <kind> …]」 header said nothing`）                                                                                                                |
| `src/web-hub/protocol/thread.ts`        | 仅注释（degrade-to-report / no report）                                                                                                                                                       |
| `src/adapters/fabric-entry-renderer.ts` | 仅 `:40` 注释（同 keys.ts 措辞）；`:95` 普通名词保留                                                                                                                                          |

**docs/skills（4 个文件）**

- `docs/guide/subagents.md:83`：整行替换为 §4.5 P1 原文（含旧名 1 处）。
- `docs/dev/fabric-cross-session/README.md`：「In-tree fabric」节末尾追加 §4.5 P1 段落（含旧名 2 处）。
- `docs/dev/fabric-thread/README.md:60-61`：`发 report（进上下文、唤醒）` / `**不发** report`。
- `skills/dev-flow/SKILL.md:186`：`收到子 agent 的 report 消息后`。

**tests（§4.6 全清单逐文件改名 + 新增；`tests/config/**` 未动）**

- 机械改名 34 个文件（kind 字面量、用例标题、`const finding`→`const report`、helper `findings()`→`reports()`、`sendHandbackFinding`→`sendHandbackReport`、正文样本词），保护项：`findingQuota`（P2）、`successor.test.ts:388` `W3 verifier findings`（普通名词）。
- 新增/追加测试：T-U1（message.test.ts）、T-U2/U4/U5/U9–U14（新文件 `tests/fabric/unknown-kind.test.ts`）、T-U3（message-agent-tool.test.ts）、T-U6（fabric-wiring.test.ts，tier2）、T-U7/U15（keys.test.ts）、T-S1（新文件 `tests/tools/steer-tool-off-surface.test.ts`）。T-U8 两条断言均已落地：`{degrade:"report"}`（`tests/fabric/thread/engine.test.ts`，改名覆盖）与 GONE 回复含 `A report was sent to the main session`（验收跟进项，补在 `tests/tools/thread-tools.test.ts` 的 GONE 用例中，正向断言即可在文案回退旧名时变红）。
- legacy 常量书写约束满足：每文件仅一行 `const LEGACY_KIND: string = "finding"; // #34 legacy input`（message/unknown-kind/fabric-wiring/message-agent-tool/keys 五个文件），其余位置一律引用常量。

**fixtures（§6.1，手改、未走再生路径）**：三份各恰好一行 `"const": "finding",`→`"const": "report",`（见 §1 numstat）。

## 4. 门禁输出（§7.3 P1，真实结果）

| 命令                                                        | 结果                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx prettier --check <本包 79 个改动文件>`                 | `All matched files use Prettier code style!`（8 个文件先 --write 后复检通过）                                                                                                                                                                                                 |
| `npm run format:check`                                      | **仅** `src/reflex/core/backtest/{cache-format,ledger-format,orchestrate,report}.ts` 4 个 [warn] —— 全部是并行包 #25 的**未跟踪新文件**，不属本包文件域，未触碰；本包文件零 warn                                                                                              |
| `npm run typecheck`                                         | exit 0（tsc×2 + vue-tsc 全过）                                                                                                                                                                                                                                                |
| `npm run test:tier1`（第一次）                              | 1 failed：`tests/startup-bundle/dispatcher.test.ts` —— dist/bundle 为旧源码产物，`dist/bundle/index.js on disk differs from a fresh build`（本包改 src 后磁盘 bundle 过期，属预期）                                                                                           |
| `npm run build`                                             | ok（tsc + bundle：`build:bundle ok — dist/bundle/index.js sha256=3baa3f7e … inputs=705`）                                                                                                                                                                                     |
| `tests/startup-bundle/dispatcher.test.ts` 复跑              | 8 passed                                                                                                                                                                                                                                                                      |
| `npm run test:tier1`（build 后复跑）                        | **Test Files 1597 passed (1597)；Tests 32052 passed \| 3 skipped (32055)**                                                                                                                                                                                                    |
| 16 个 integration 套件（§7.3 列表全量）                     | **16 passed (16) / 80 tests**（含 fabric-wake-off-golden、fabric-xs-off-golden、fabric-xs-reply-off-golden、thread-off、thread-rebind-off、schedule-off、reflex-off、fabric-wiring(T-U6)、fabric-wake*.test、fabric-thread-e2e、fabric-thread-rebind-e2e、fabric-xs-mention） |
| `npm run test:conformance`                                  | **38 passed \| 1 skipped（39）；395 passed \| 20 skipped \| 1 todo（416）**（fabric-wake C-P1–C-P5、fabric-xs C-X1–C-X11 在内）                                                                                                                                               |
| `npx vitest run tests/governance tests/boundary tests/docs` | **6 passed / 88 tests**（含 agents-md I10 原文钉子、test-tiers 治理、web-hub boundary）                                                                                                                                                                                       |
| 门禁 A（A-P1 允许清单 + 1 处 R11 调整，见 §5）              | `diff` 无输出，**PASS**（format 后复跑仍 PASS）                                                                                                                                                                                                                               |
| 门禁 B（B-P1）                                              | `diff` 无输出，**PASS**（format 后复跑仍 PASS）                                                                                                                                                                                                                               |

完整日志：`/tmp/c34-{format,typecheck,tier1,tier1b,build,integration,conformance,gov}.txt`、`/tmp/c34-gate{A,B}.txt`、`/tmp/c34-allowA-P1.txt`、`/tmp/c34-allowB-P1.txt`。

## 5. 门禁 A 允许清单（实际命中集合 = 允许集合）

`/tmp/c34-gateA.txt` 与下表逐字节相等（`rg -i --count-matches finding`，按方案 SCOPE）：

```
docs/dev/fabric-cross-session/README.md:2      # 迁移说明（§4.5 原文）
docs/guide/subagents.md:1                      # 迁移说明
src/adapters/fabric-entry-renderer.ts:1        # 普通名词 :95
src/fabric/root-wake.ts:1                      # 普通名词 :621
src/fabric/router.ts:2                         # P2：findingQuota ×2
src/fabric/setting-specs.ts:3                  # P2
src/fabric/settings.ts:4                       # P2
src/tools/message-agent-tool.ts:1              # 普通名词 :97 report findings to
src/tools/steer-tool.ts:1                      # P2：fabric.findingQuota
tests/config/__corpus__/setting-specs-pin.json:1   # P2
tests/config/__corpus__/settings-corpus.json:1     # P2：template 键
tests/core/message-property.test.ts:2          # P2
tests/core/message.test.ts:1                   # LEGACY_KIND
tests/fabric/mailbox.test.ts:2                 # P2
tests/fabric/router-wake.test.ts:2             # P2
tests/fabric/router.test.ts:1                  # P2
tests/fabric/successor.test.ts:1               # 普通名词 :388
tests/fabric/unknown-kind.test.ts:2            # R11 调整，见 §6 偏差 1
tests/fabric/xs-inbox.test.ts:1                # P2
tests/helpers/fabric-inbox.ts:1                # P2
tests/helpers/fabric-revive.ts:1               # P2
tests/integration/fabric-wiring.test.ts:1      # LEGACY_KIND
tests/tools/message-agent-tool.test.ts:2       # LEGACY_KIND 1 + findingQuota 1（P2）
tests/tools/steer-tool-off-surface.test.ts:6   # 冻结基线：PRE34_DESCRIPTION 1 + PRE34_REPLY_DESCRIPTION 3 + DECLARED_SUBS 源串 2
tests/web-hub/protocol/keys.test.ts:1          # LEGACY_KIND
```

门禁 B 文件集合与方案 B-P1（B-P2 去掉 `fabric-report-quota-settings.test.ts`、加上 12 个 P2 待改文件）完全一致。

## 6. 与方案的偏差（逐条）

1. **R11：`tests/fabric/unknown-kind.test.ts` 计数 1 → 2**。新增的 T-U2/T-U4 router rig 需要写一次配置键
   `findingQuota: 2`（router 配置的必填键，P1 不改键名，也无法不写字面量引用它）。该命中在 P2 键改名时随之消失
   （P2 时回到 1）。已在门禁 A 允许清单中按 R11 更新并在此说明；没有为此删改任何普通名词。
2. **`retireUnknownKind` 的 engine 参数类型**：方案草案写全量 `DeliveryEngine<…>`；`wake.ts` 的 `Engine` 是
   `Pick<…>` 窄视图（缺 `put/freeze/fold/stats`），全量类型会让 E8② 调用点需要 cast。实现改为结构化
   `Pick<DeliveryEngine<…>, "transition">`（`unknown-kind.ts` 内命名 `TransitionEngine`），契约不变、更诚实。
3. **T-U6 的 warn 断言措辞**：`buildSessionStack` 在该 harness 下本身会产生 4 条与本次无关的 warn（其他子系统），
   「恰好 1 行」按方案本意落实为「匹配 `dropped 2 persisted message(s) with an unknown kind` 的 warn 恰好 1 行，
   且所有 warn 都不含正文」；第二次 build 断言「匹配该模式的 warn 为 0」。
4. **T-S1 的残留断言针**：`fabric.findingQuota` 与 `kind "finding"` 针值分别从
   `PRE34_REPLY_DESCRIPTION`（regex 派生 `P2_PENDING_KEY`）与 `DECLARED_SUBS[0][0]`（派生 `OLD_KIND_WORD`）
   获得，避免在断言里再写旧名字面量，使该文件计数恰为方案 A-P1 的 6。P2 追加第三条 DECLARED_SUBS 时该文件
   变 7，与方案一致。

其余全部按方案原文实施；未发现需要升级到 root 的阻断项。

## 7. 验收矩阵（P1 行）对照

| 项                                                                         | 证据                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| V1 类型/schema/router/mailbox/mention 改名                                 | typecheck 绿；门禁 A/B PASS                                                                             |
| V2 两种 schema kind = progress\|report\|directive 顺序不变                 | 三份 golden 属主测试绿（integration 16 套件 + conformance C-P4 + tier1 message-agent-wake）；§1 numstat |
| V3 report 准入/配额/park/revive/dead letter/节流与原 finding 一致          | 改名后原 fabric 单测+集成全绿（tier1 1597 文件）                                                        |
| V4 工具层 unknown kind 守卫                                                | T-U3 绿                                                                                                 |
| V5 router 未知 kind 不耗 seq/配额                                          | T-U2 绿                                                                                                 |
| V6 build 退役：dropped/unknown_kind、无 dead letter、warn 一行、幂等       | T-U4、T-U6 绿                                                                                           |
| V7 resume 不注入未知正文；未知 trigger 拒绝                                | T-U9、T-U10 绿                                                                                          |
| V8 全部时间源排除；退役失败零自调度                                        | T-U11–T-U14 绿                                                                                          |
| V9 历史可见；context-message 仅 content 文本差异                           | T-U7、T-U15 绿                                                                                          |
| V10 steer/#33 指引/thread/message_session 改名                             | 相关测试绿（含 T-U8 两条断言）；门禁 A                                                                  |
| V11 fabric-off 表面仅 §7.4 申报差异                                        | T-S1（P1 阶段断言）绿；off golden 套件绿                                                                |
| V12 冻结物恰好 3×1 行                                                      | §1                                                                                                      |
| V13 xs/hub wire 不变                                                       | conformance 全绿；tests/boundary 绿                                                                     |
| V14 I1/I4/I5：仅一个无状态谓词 + 一个无状态退役函数 + 同步方法，无新定时器 | 代码审（unknown-kind.ts 无状态；router/mailbox/wake 改动均为同步守卫）；governance 绿                   |
| V18 commit 无 BREAKING 标记                                                | 见 §8 正文                                                                                              |

## 8. commit 正文申报（§6.4 原文，供 root 提交 P1 使用）

主题：

```
feat(fabric): rename the message kind "finding" to "report"
```

正文（方案 §6.4 逐字）：

```
Frozen-artifact update approved by the user on 2026-11-05 (task #34, an explicit exception to the append-only wire rule I10): the A-tier goldens tests/fixtures/fabric-wake-off-golden.json and tests/fixtures/fabric-xs-off-golden.json and the B-tier tests/fixtures/message-agent-wake-schema-golden.json each change exactly one line — messageAgentSchema / kind anyOf const "finding" → "report". They were edited by hand, not regenerated; nothing else in tests/fixtures/ changed.

Incompatible on purpose (approved): persisted, undelivered fabric records whose kind is no longer known (the old "finding") are dropped with terminalReason unknown_kind on the first stack build after upgrade, with one warning line and no dead letter. With fabric off, the steer_subagent description and its reply parameter description also change wording ("finding" → "report").
```

不带 `!`，正文无 `BREAKING CHANGE:` 起始行。建议精确路径清单（root 提交用，**不含**并行包 #25/#30 的文件
`src/reflex/core/backtest/**`、`tests/reflex/core/backtest/**`、`docs/dev/jev-reflex/B{1,2}-report.md`、
`tests/web-hub/hub/reload-status-passthrough.test.ts`、`tests/integration/web-hub-reload-result-loop.test.ts`、
`tests/tiers.ts`、`docs/dev/web-hub/README.md`、`docs/dev/reload-result/PC-report.md`）：

```
docs/dev/fabric-cross-session/README.md docs/dev/fabric-kind-rename/P1-report.md
docs/dev/fabric-thread/README.md docs/guide/subagents.md skills/dev-flow/SKILL.md
src/adapters/fabric-entry-renderer.ts src/core/message.ts
src/fabric/{unknown-kind.ts,router.ts,stack.ts,mailbox.ts,mention.ts,wake.ts}
src/fabric/thread/engine.ts
src/stack.ts src/tools/{message-agent-tool.ts,message-session-tool.ts,steer-tool.ts,thread-child-tool.ts}
src/web-hub/protocol/{keys.ts,thread.ts}
tests/adapters/fabric-entry-renderer.test.ts tests/conformance/fabric-wake.test.ts
tests/core/{message.test.ts,message-property.test.ts,message-wake.test.ts,presentation-diag.test.ts}
tests/delivery/{engine.test.ts,engine-strict.test.ts}
tests/fabric/{unknown-kind.test.ts,format-fence.test.ts,mailbox.test.ts,mention.test.ts,revive.test.ts,
  router-wake.test.ts,router.test.ts,successor.test.ts,thread/engine.test.ts,throttle.test.ts,
  wake-level.test.ts,wake-result.test.ts,wake.test.ts,xs-inbox.test.ts}
tests/fixtures/{fabric-wake-off-golden.json,fabric-xs-off-golden.json,message-agent-wake-schema-golden.json}
tests/helpers/{fabric-inbox.ts,fabric-revive.ts}
tests/integration/{fabric-thread-e2e.test.ts,fabric-wake-level.test.ts,fabric-wake-subscribers.test.ts,
  fabric-wake.test.ts,fabric-wiring.test.ts}
tests/integration/helpers/fabric-xs-process.ts
tests/service/runtime-adapter-fabric.test.ts
tests/tools/{message-agent-tool.test.ts,message-agent-wake.test.ts,steer-tool.test.ts,
  steer-tool-off-surface.test.ts,thread-tools.test.ts}
tests/web-hub/protocol/keys.test.ts
```

## 9. 遗留 / 交接

- P2 待办（按方案 §7.1 P2 文件域）：设置键 `fabric.findingQuota`→`fabric.reportQuota`（src 4 文件 + 测试 6 文件 + corpus 两阶段证明 + T-Q1 + 文档两处追加 + steer-off 测试追加第三条 DECLARED_SUBS）。
- P1 commit sha 待 root 提交后回填本报告与 P2 开工检查。
- `npm run format:check` 的 4 个 [warn] 属并行包 #25 的未格式化文件（现已在 HEAD `576e4af7` 合入，仍未格式化），请 #25 或主会话在下次 format 门禁前 `prettier --write`。
- 用户 memory `pitfalls-subagent.md` #17（「必须用 finding」）按 R7 由主会话在合并后更新。
