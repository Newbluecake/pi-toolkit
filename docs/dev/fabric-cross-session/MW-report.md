# 包 MW 交付报告：@mention 寻址会话装配

基线 HEAD 5a2874e8，未 commit；冻结面（src/mention/_、fabric/xs/_、root-wake、web-hub/*、settings、tools、ui、三份 golden）未改。

## 改动文件

- `src/stack.ts`：`StackXsInput.listRows`（目录数据源，晚绑定）；`StackXs.directory`（`buildStackXs` 内 `createXsDirectoryCache`，`dispose()` 一并释放）。`view()` 的 key = `${sessionId}#${epoch}`，未 join / 已 dispose ⇒ `undefined`；`fetch` 经 `input.listRows`。
- `src/index.ts`：
  - `xsSender` 提升到 activate 作用域（与 `message_session`/`list_sessions` 共用同一个 sender 实例）；
  - `mentionSessions = createMentionSessionPort({...})`（仅 xs on 时创建）：`joined()` 现查 `xsAttached ∧ membership.joined ∧ webHub 桥存在`；`isLabel` = 当前 stack 的 mention registry；`cwd` = 当前 ctx.cwd；`lookupExact` = 当前 stack 目录缓存；`send` = `sender.message({to, text, wake:true, expectReply:{}（reply_unsupported 重发时省略）, origin:"human", levelOverride:0})` + `mapMentionSendOutcome`；
  - `mentionRouteDeps.sessions`（TUI `installMentionInput` 与 web `deps.mention()` 共用，spread 传递）；web 额外 `notifySession`（`pi.sendMessage`，`triggerTurn` 不传）；TUI 的 notify 仍由 `installMentionInput` 内部接线；
  - 补全 provider 增 `sessions()`（目录行投影，`refresh("complete")` 不 await）与 `sessionBareName`（`sessionCompletionBare`）；
  - `session_start` 的 `xsInput.listRows` = `webHubRef.current?.xs?.hubPort().list({origin})`（即 web-hub agent bridge 的 list）。
- `tests/integration/fabric-xs-mention.test.ts`（新，8 用例）。
- `tests/integration/helpers/fabric-xs-process.ts`（扩展，对旧用例无影响）：hub op `webPrompt`；agent op `mention`（跑 input handler 链）/`complete`（叠加已注册补全工厂）；`XW_UI=1`（hasUI + addAutocompleteProvider）、`XW_SESSION_NAME=1`（发布会话名）；inspect 增 `userMessages`/`mentionNotices`/`turns`；`sendUserMessage` 改为记录。

## R4 回复呈现

RX5/RXW 已提供标记：ticket 的 `origin:"human"` + `wakeOnReply:false`（sender 在 `origin:"human"` 时写入，签发后不重新推导），receiver 对该票的回复走 deliver-only 路径：`sendMessage({display: ticket.origin==="human", ...}, {triggerTurn:false})`。MW 只需让 `send` 传 `origin:"human"`、`levelOverride:0`，未改任何冻结文件。成功/错误通知（`subagent:mention-session` / `subagent:mention-error{source:"mention-session"}`）均 `display:true` 且不传 `triggerTurn`。

## §12.2 第 10 项 ↔ 测试

| 要求                                                                           | 测试                                                                                    |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| TUI 显式形式往返：B 收到带 reply_to 的唤醒、帧 level 0；A 只展示回复且不起轮次 | `TUI explicit form: …`                                                                  |
| web 输入同样往返（不落入原生 prompt，`mention:{action:"session"}`）            | `web composer path: …`                                                                  |
| 裸名唯一命中路由；补全插入 `@name`                                             | `bare @name msg: …`                                                                     |
| 同名 cwd 文件 ⇒ 裸形式放行、补全插入显式 ref                                   | `a cwd file with the same name wins …`                                                  |
| subagent 同名优先                                                              | `a subagent label wins over a same-named session …`（真实 Agent 工具注册 label `beta`） |
| 未 join / leave 后放行（TUI + web 原生路径）                                   | `off states: not joined / left …`                                                       |
| xs off 放行                                                                    | `xs off: the port is never injected …`                                                  |
| 错误呈现 subagent:mention-error                                                | `errors surface as subagent:mention-error{source:mention-session} …`                    |

补全/路由的三态字节比对由 M 的 `tests/mention/session-off.test.ts` 钉住，本包只验证装配。

## 装配决策与限制

1. **目录缓存的刷新触发**：方案只写补全触发。web composer 无补全，裸名永远冷启动 ⇒ 我在 `lookupExact` 未命中（且形状合法的裸名）时额外 `refresh("lookup")`（节流 30s、single-flight、不 await）：本次仍放行（RR8），下次可命中。显式形式不受影响。
2. `reply_quota` 的 `pendingReplies` 取 `reply.maxPending`（sender 的 outcome 不带实时计数；per-target 触顶时数字只是近似）。
3. `reply_unreceivable`（A 自己 receive off/blocked）映射为 `error`，文案「未送达（reply_unreceivable:<原因>），可稍后重试」。
4. 裸形式的 `joined()` 要求 web-hub 桥存在；已 join 但连接断开时，显式 `@session:` 会被拦截并给出「未送达」错误（effect none），不会静默落入模型。
5. web composer 补全仍按方案本期不做。

## 自验

```
$ npx vitest run tests/integration/fabric-xs-mention.test.ts tests/integration/fabric-xs-reply.test.ts tests/integration/fabric-xs-activation.test.ts tests/integration/fabric-xs-child-scope.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-wake-off-golden.test.ts tests/mention --maxWorkers=2
 Test Files  13 passed (13)
      Tests  117 passed (117)

$ npm run typecheck      （tsc ×2 + vue-tsc，无输出 = 通过）
$ npx prettier --check src/index.ts src/stack.ts tests/integration/fabric-xs-mention.test.ts tests/integration/helpers/fabric-xs-process.ts
All matched files use Prettier code style!
```
