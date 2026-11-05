# #21 包 B2（ask-user 侧）实施报告

> 依据：`docs/dev/xs-ask-redirect/plan.md`（r3 + root 2026-11-05 裁定）§1 D2/D8、§2.0、§2「包 B2」、§3 T4 中属于 B2 的部分。基线 `dev@e31968b1`。

## 改动清单

| 文件                               | 改动                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/ask-user/redirect.ts`         | **新建**。§2.0 冻结契约类型的逐字拷贝（`AskRedirectReason` / `AskUserRedirectResult` / `AskUserRedirectPort`，B1 只做结构兼容不 import）；`renderRedirectBody(questions, budgetChars)`（D8 四级压缩阶梯）；`redirectResultText`（各终态模型可见文本）、`redirectDetails`（`details.redirected` 映射）、`redirectRenderMarker`（renderResult 行内标记）。无 pi 依赖（仅 type import `Question` / `AskRedirectDetails`）。 |
| `src/ask-user/index.ts`            | `AskUserWireOptions.redirect?: () => AskUserRedirectPort \| undefined`（late-bound，同 `remote`/`background` 先例）；execute 在 `signal.aborted` 早退（:648）之后、`const isTui`（:650）之前加分支：`ask()` 同步返回 `undefined` ⇔ O 类 ⇒ 原代码原样继续；否则 await 结果直接返回（不进 queue/bg/parked/remote，不弹本地对话框）；`renderResult` 在 `dismissed` 分支后加 `redirected` 分支。                             |
| `src/ask-user/types.ts`            | `AskRedirectDetails` 接口 + `AskUserDetails.redirected?`。                                                                                                                                                                                                                                                                                                                                                               |
| `tests/ask-user/redirect.test.ts`  | **新建**，29 例（覆盖见下）。                                                                                                                                                                                                                                                                                                                                                                                            |
| `docs/dev/xs-ask-redirect/plan.md` | §2.0 类型块一处：answered 变体新增必填 `originRequestId: string`（root 裁定，见下）。plan 其余部分未动。                                                                                                                                                                                                                                                                                                                 |

## 契约裁定记录（root，2026-11-05）

- **answered 的 `<origin>` 来源**：D8 文案的 `ORIGINAL replyTo <origin>` 槽位取 `result.originRequestId`（answered 变体新增必填字段），**不是** `requestId`。所有变体的 `requestId` 一律表示本次提问的 q2 票据。B2 与 plan §2.0 已同步；B1 已收到通知。`details.redirected` 仍按 D8 形状 `{state, attempt?, limit?, requestId?, reason?}`（answered 的 `requestId` 即 q2），不加新字段。

## 设计要点

- **分支位置**（D2）：HEADLESS throw 与 `signal.aborted` 早退**之后** ⇒ print 模式仍走 HEADLESS（测试断言 port 从未被咨询、工具照旧被禁用）；pre-aborted 仍返回 `AGENT_ABORTED_TEXT`。只支持 tui/rpc。
- **I9 字节不变**：选项缺席、或 port/`ask()` 返回 `undefined`（O 类）时，唯一的额外工作是零副作用的 `opts?.redirect?.()` 求值；测试用「有选项 + O 类 port」与「无选项」两次确定性 TUI 交互结果 `toStrictEqual` 相等来钉住。
- **D8 压缩阶梯**：完整 → 去 option description → context 截到 120 字（`REDIRECT_CONTEXT_TRUNCATE_CHARS`，纯 slice 无省略号）→ 去 context；question 文本与全部 option label 永不截断；四级都放不下 ⇒ 返回 `undefined`（⇒ B1 侧 `too_large`，不发送、不预留——B2 侧无需处理，`render` 返回 undefined 即契约）。budget 判定用 JS string length（与 fabric `maxChars` 同口径）。
- **终态文本**：answered 为 D8 英文原文逐字（`attempt/limit`、`originRequestId`、`answerText` 第二行）；其余终态一律 `Do not assume an answer.` 开头 + 原因 token + U 类指引（defensible default / 列出问题与所选默认 / 交给原 replyTo）；timeout/not_woken 额外带 r3 版双窗口说明（dueAt 前可能唤醒 / 到期后宽限期只投递不唤醒），无「不会再唤醒」绝对化表述（测试用 `/won'?t wake you again/i` 反向断言）。
- **exactOptionalPropertyTypes**：port `ask` 入参的 `signal` 用条件展开传入（`...(signal !== undefined ? { signal } : {})`），不改 §2.0 冻结签名。
- **multiSelect** 标记为 `(multi-select)` 后缀；header 不进正文（D8 压缩清单只涉及 question/context/label/description）。

## 测试覆盖（tests/ask-user/redirect.test.ts，29 例）

- 压缩阶梯四级边界逐级钉住（每级 body 长度为预算时返回本级、减一落到下一级）；4×~1000 字问题在小预算下 ⇒ `undefined`，且任何能产出的 body 必含完整 question 与全部 label；context < 120 时截断级为 no-op；multi-select 标记。
- 六种终态文本逐项（answered 逐字比对 + `<origin>` 取自 `originRequestId` 而非 `requestId` 的正反向断言；timeout/not_woken 的 token、双窗口说明、无绝对化表述；unavailable 各 reason 含 `send_none:rate_pair_interval`；aborted/disposed）。
- `redirectDetails` 全 kind 映射（`toStrictEqual` 钉住 optional 字段真缺席）；`redirectRenderMarker`（`↪ requester answered 1/2` / `↪ requester <state>`）。
- execute 集成：U 类直接返回且 `ui.custom`/`ui.select` 从未被调用（tui 与 rpc 各一）；answered ⇒ `cancelled:false`；render 闭包绑定 normalize 后的 questions 且 `render(1) === undefined`、signal 原样透传；O 类与无选项字节不变（`toStrictEqual`）；print 模式 HEADLESS 且 port 未咨询、工具禁用；pre-aborted 与 dismissParked 均先于分支。
- renderResult：answered/timeout/unavailable 的标记渲染（非 answered 不落入泛化 "Cancelled"）。

## 冻结面核查

- `tests/fixtures/**` 零 diff（`git diff --quiet HEAD -- tests/fixtures/` 通过）。
- `tests/conformance/ask-user-wired.test.ts` 未改且绿（无 `redirect` 选项 ⇒ 原行为）。
- ask_user 的 schema / description / promptSnippet / 参数零改动（无 to/source 之类新参数）；`src/index.ts`、`src/fabric/**`、`src/tools/**`、`skills/**` 未动（分别归 B3/B1/A）。

## 自验（真实命令与结果）

| 命令                                                                                                         | 结果                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/ask-user tests/conformance/ask-user-wired.test.ts tests/governance tests/topic-switch` | **43 files / 605 tests 全绿**（含新增 redirect.test.ts 29 例；日志 `/tmp/b2-selfverify2.log`，prettier 化后单套件复跑亦绿）        |
| `npx prettier --check`（B2 五个改动文件）                                                                    | 全部通过（prettier --write 后复检干净；日志 `/tmp/b2-prettier.log`）                                                               |
| `git diff --quiet HEAD -- tests/fixtures/`                                                                   | 零 diff                                                                                                                            |
| `tsc --noEmit -p tsconfig.json` / `-p tsconfig.typecheck.json`（TS 7）                                       | **B2 文件零错误**（当前工作区 `src/fabric/xs/ask-redirect.ts` 为 B1 并行半成品，存在错误，属预期、不在 B2 域内；过滤后无其它错误） |

## 遗留 / 交接

- B1 对接注意：`render` 闭包由 execute 传入，B1 以 `budget = maxChars − 首行与说明长度` 调用；返回 `undefined` 时按 D7 归为 `unavailable("too_large")`。answered 结果必须填 `originRequestId`（q2 填 `requestId`）。
- B3 接线：`redirect: () => holder.current?.xs?.askRedirect`（plan §2 B3）。
- renderResult 的 redirected 分支放在 `dismissed` 之后、泛化 Cancelled 之前；与 `interrupted` 互斥（重定向结果从不进 parked/interrupt 路径）。
