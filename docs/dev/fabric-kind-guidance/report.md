# #33 修复报告：message_agent 的 kind 语义自纠错

日期：2026-11-05 · 分支 dev（HEAD 204da159）· 车道 L1

## 问题回顾

#25 的子 run 向 root 提问失败的两条根因（pitfalls-subagent #17）：

1. `kind:"progress"` 被 accept，但 progress→root 走 `display` 通道（`effectiveChannel`：`progressChannel:"display"` 且 `canRenderEntries` ⇒ 只进 TUI），root 模型看不见；
2. `kind:"directive"` 只允许 relation(from,to)==="parent"（父→子），子发 root 被 `src/fabric/router.ts` 以裸 `message not authorized` 拒绝，无任何指引。历史 ≥7 次、跨 6 个会话；另有 SubagentWorkflow 孙代（relation="ancestor"）`finding→root` 被拒（默认 `can_message` 只含 `parent`，不含 `ancestor`），同样只收到裸错误。
3. 工具面 `kind` 是无 description 的 union，模型只能猜。

## 改动（3 个文件）

### 1. `src/tools/message-agent-tool.ts`

- **错误自纠错**：`execute` 整体包 try/catch；当 router 抛出的错误 message 逐字节等于 `"message not authorized"` 时，以原文为前缀追加 `messageAgentKindHint(...)` 指引后 rethrow。其它错误（`sender is not running` 等）原样穿透。
- 新增导出的纯函数 `messageAgentKindHint({to, kind, canMessage})`，按 kind 分支（镜像 `src/core/message.ts` 的 `authorize` 判定，但 router 的 tree 不可见，故按 kind 驱动——这正是 #33 里模型选错的东西）：
  - `directive`（含 @mention 上的 directive）：说明只能父→子；要目标会话模型看见请用 `kind:"finding"`；`progress` 只进 TUI、模型不可见；任务结果经 run 完成回报。
  - `progress`/`finding` 被拒：说明目标 relation 不在自己的 can_message 集合（用 `effectiveCanMessage` 列出实际集合，默认仅直接父）；建议发给直接父 run id，或经 run 完成（`"result"` 通道，child→parent）回报。
  - `to` 为 `@label`：说明 mention 路由需要 `can_message: mention` 且只承载 finding/progress。
- **工具描述**（`ToolDefinition.description`，I12：机制归工具面）：写全 `finding`（注入目标会话模型上下文，请教/汇报用它）/ `progress`（root 只进 TUI，模型不可见）/ `directive`（只能父→子）/ `result`（run 完成时经 result 通道回报，不是本工具的 kind）四种语义。

### 2. `tests/tools/message-agent-tool.test.ts`

新增 describe「kind guidance (#33)」，含真 fabric（MemoryOutboxStore+FabricTree+FabricRouter，非 mock）：

- 工具 description 钉住四种 kind 语义文案；
- 直接子 `finding→root` 经真 router 通过（ok:true）；
- 直接子 `directive→root` 被拒：错误以 `"message not authorized"` 开头（兼容既有 `toThrow` 子串匹配）且含指引（改用 finding / progress 模型不可见）；
- 孙代 `finding→root` 被拒且指向 direct parent / result 通道，同时验证同一孙代 `finding→直接父` 通过；
- `messageAgentKindHint` 的 @mention 分支与 can_message 集合展示。
- 另加一条：非授权类错误（`sender is not running`）不追加指引。

注意：真 router 路径要求 NodeRef 匹配 `r_[0-9A-HJKMNP-TV-Z]{8}`（`makeMessageKey` 校验），测试里的 runId 需用合法形状。

### 3. `tests/fabric/router.test.ts`

新增 resume 形状用例「keeps a resumed run's authorization intact once its old run id is tombstoned」：旧 runId `markRunning`+`tombstone` 后、同 session 新 runId 注册为 root 子——`targetState(新) === "running"`、`directive→root` 拒、`finding→root` 收。钉住「resume 不破坏 message_agent 授权」（pitfalls-subagent #17 的前提）。

## 偏差说明（对任务书第 2 点）

任务书要求「ToolDefinition.description 与 `text` 参数说明」都写 kind 语义。核实后 **`text` 参数描述不可改**：A 级 golden `tests/fixtures/fabric-wake-off-golden.json` 与 `fabric-xs-off-golden.json` 的 `messageAgentSchema` 字段逐字节钉住整个 `MessageAgentParams`（含 `"text": {"description": "Message body"}`），且 `tests/tools/message-agent-wake.test.ts:18`、conformance C-P4 都做全等比较。按任务书的冻结指令（不要重生 golden），kind 语义全部放进未被任何 fixture 钉住的 `ToolDefinition.description`，`MessageAgentParams` 一字未动。

## 冻结面核查（全部未动）

- `tests/fixtures/**`：`git diff --quiet HEAD -- tests/fixtures/` 通过；
- `src/core/message.ts` 的 authorize 矩阵：未改（仅新增 import `CanMessage`/`effectiveCanMessage` 于工具文件）；
- `src/fabric/router.ts`：整个文件未改，throw 文本逐字节不变；
- 在途包文件（`src/reflex/**`、`src/config/**`、`tests/reflex/**`、`tests/config/**`、`AGENTS.md`、`docs/dev/jev-reflex/**`、`docs/dev/data-encryption/README.md`、`tests/tiers.ts`、`.prettierignore`）：未触碰（git status 仅 3 个改动文件）。

## 自验（真实输出摘要）

| 命令                                                                                                  | 结果                                      |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `npx vitest run tests/tools tests/fabric tests/core/message.test.ts`                                  | 98 files / 1646 tests 全过                |
| `npx vitest run tests/integration/{fabric-xs-off,fabric-xs-reply-off,fabric-wake-off}-golden.test.ts` | 3 files / 7 tests 全过                    |
| `npm run typecheck`                                                                                   | exit 0（tsc×2 + vue-tsc）                 |
| `npx prettier --check`（3 个改动文件）                                                                | All matched files use Prettier code style |
| `git diff --quiet HEAD -- tests/fixtures/`                                                            | clean                                     |

完整日志：`/tmp/v-kind-main2.log`、`/tmp/v-kind-golden2.log`、`/tmp/v-kind-typecheck2.log`。

## 遗留

- 续跑 prompt 兜底（要求子 agent「提问与默认做法写进报告」）属调度侧约定，不在本包范围。
- `result` 不是 `message_agent` 的 kind（schema 无它，由系统在 run 完成时投递）；指引文案已按此准确表述，未让模型去发一个 schema 里不存在的 kind。
