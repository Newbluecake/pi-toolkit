# AL3 报告：agent 连接（别名桥接 / 缓存 / 对账）

规格：`alias-plan.md` r4 §4/§5/§10 AL3 行、§R1–R3。未 commit。

## 改动

- `src/web-hub/agent/xs.ts`：别名桥接、缓存、status 投影、cap、hub 配置键。
- `src/web-hub/agent/index.ts`：`onHubCaps` 在 `publishMember()` 之后调用 `xsBridge?.onHubCapsAlias()`（每次 hello_ack）。
- `src/web-hub/agent/connection.ts`：**未改**。`XS_REQ_DEADLINE_MS.alias = 5000` 已由 AL0b 进入协议表，`connection.request` 经 `xsReqDeadlineMs(frame.op)` 取值，测试已钉住 5s。
- `tests/web-hub/agent/xs-alias.test.ts`（新，16 条，真实 `Connection` + fake socket）。

## 导出端口 / 工厂（供 ALW 接线）

`createXsAgentBridge(deps)` 返回的 `XsAgentBridge` 新增：

- `aliasBridge(): XsAliasBridgePort`（`supported/get/set/clear/takePreview/take`，5s 有界）。
- `aliasCache(): XsAliasCachePort`（`current/reconcile/usable`）。
- `onHubCapsAlias()`：fire-and-forget 对账（index.ts 已接）。
- `hubCrossSessionConfig()` 新增 `alias?`（仅 alias on 且 port 提供 `aliasHubConfig` 时，夹到设置边界 1..720 / 1..1440 / 10..1440）。

`XsAgentPort` 新增三个**可选**方法（缺省 ⇒ 与旧行为字节相同）：

- `aliasEnabled?()`：`fabric.crossSession.alias.enabled`，非 live；ALW 在 activate 时冻结。
- `aliasHubConfig?()`：hub 全局别名参数。
- `notifyAliasLost?(text)`：只显示的一次性提示文案（桥已按 `(sessionId, lost.at)` 做进程级去重）。ALW 接 `ctx.ui.notify`。

ALW 需要做的：

1. 在 `deps.xs` 里提供上面三个方法。
2. stack attach 时调 `bridge.aliasCache().reconcile()`。
3. 把 `aliasBridge()` / `aliasCache()` 交给 `/fabric alias`（AL4）。命令执行 set/clear/take 后无需手动刷新缓存（成功回包已按到达序应用），`/fabric status` 之后调一次 `reconcile()`。

## 行为要点

- **零帧守卫**：`op:"alias"` 只在 `aliasEnabled ∧ 当前 hub 声明 xs.alias.v1` 时发送，否则 `{kind:"off"}`，不写任何帧。alias off 时 caps、`xs_member`、status、`xs_req` 与 off golden 逐字节相同。
- **本地错误码**：未启用/hub 无 cap 为 `E_XS_OFF{alias|hub}`；读超时/断链为 `E_XS_DEADLINE` / `E_XS_LINK_LOST`；**写**超时/断链为 `E_XS_ALIAS_UNKNOWN{client_deadline|link_lost}`（帧可能已到 hub）；hub 错误码（含花括号后缀）原样透传。
- **缓存**：桥闭包内 `Map<sessionId,{alias?,lostAt?}>`，≤8 FIFO，不持久化，随 activate 重建而清空。
- **应用规则**：发起时记 `HubConnection` + `conn.caps` 数组引用（每次 hello_ack 换新数组，作为连接世代）+ 当前 sessionId；回包返回时三者任一变化 ⇒ 仍返回给调用方但**不应用**；否则按到达序应用。预览不写缓存；get/set/clear/take 成功回包都应用。
- **丢失提示**：回包带 `lost` 时，缓存清掉 alias、记 `lostAt`；`(sid, lost.at)` 不在 `Symbol.for("pi-subagent:xs-alias-lost")` 集合（上限 64 FIFO）里才调用 `notifyAliasLost`。该集合是唯一跨 reload 的状态。
- **status**：`StatusInfo.xs.alias` 仅在 usable 且缓存持有时写；alias 变化时调 `publishStatus`。`slotFlush` 对 status 帧在目标 hub 无 `xs.alias.v1` 时剥掉 `xs.alias`（重放安全，存储帧保持原样）。

## 偏离

1. connection.ts 无需改动（见上）。
2. 缓存挂在桥（每次 activate 一个）而不是 stack 闭包里：桥已经按 activate 重建、并通过 `port.stack().sessionId()` 隔离，语义等同「不跨 /reload」；ALW 不需要另建缓存。
3. attach 触发对账留给 ALW（stack.ts 域）；本包只接了 hello_ack。

## 自验

```
npx vitest run tests/web-hub/agent tests/fabric tests/integration/fabric-xs*.test.ts --maxWorkers=3
 Test Files  137 passed (137)
      Tests  2306 passed (2306)
npm run typecheck   → 通过（tsc ×2 + vue-tsc，无输出错误）
npx prettier --check src/web-hub/agent/xs.ts src/web-hub/agent/index.ts tests/web-hub/agent/xs-alias.test.ts
 All matched files use Prettier code style!
```
