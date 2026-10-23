# fabric 二期 X3 包报告：发送端与两个主会话工具

状态：**完成**。基线 `dev` @ `4f0dcfb3`（XS0 已合入）。依据 `phase2-plan.md` r2 + 文末 r3 主会话裁定（M2/S3 优先于正文）；XS0 契约（`src/web-hub/protocol/xs.ts`）为唯一 wire 事实源。2026-10-21。

## 交付物（全部新建，未触碰任何既有文件）

| 文件                                       | 内容                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/fabric/xs/sender.ts`                  | pi-free 发送端核心：origin 守卫（每个 await 后重验）、fail-fast resolve→send、effect 映射、wake/level 本地预检、`fabric.maxChars` 截断、16 KiB 帧预检、保留地址拒绝、工具名冲突检测 helper |
| `src/tools/list-sessions-tool.ts`          | `list_sessions` 工具（§4.3/P6：`query?`/`scope?`，行渲染，英文 token）                                                                                                                     |
| `src/tools/message-session-tool.ts`        | `message_session` 工具（§4.3/P5：`to`/`text`/`wake?`，S3 unknown 提示）                                                                                                                    |
| `tests/fabric/xs-sender.test.ts`           | 36 用例：r3 M2 两条强制用例 + §11.2 X3 行全部锚点                                                                                                                                          |
| `tests/tools/message-session-tool.test.ts` | 9 用例：保留地址、省略 wake、scope、结果形状、S3 提示、冲突 helper                                                                                                                         |

装配（工具注册、stack 接线）**不在本包**——按 §11.1 归 XW；本包未改 `src/stack.ts`/`src/index.ts`，未注册任何工具，未动 `RESERVED_TOOL_NAMES`。

## 设计要点与裁定落实

### r3 M2（send 前后区分）——逐字落实

- **send 之前**守卫失败（resolve 往返期间 `/new`/leave、signal abort、身份消失）⇒ `none{origin_changed}`，**send 帧不发出**；`接收成功后、响应返回前切换会话` ⇒ **保留远端结论**（`applied` 原样返回）；send 后身份变化且**无**远端结论（deadline/link_lost）⇒ `unknown{origin_changed_after_send}`，绝不 `none`。三条各有测试（`xs-sender.test.ts` 「r3 M2 origin guard」块）。
- hub 侧 `E_XS_STALE_ORIGIN`/admission 类拒绝码映射为**可证 `none`**（§8.3 ①–④ 全部先于 `registry.request`）；`E_XS_INTERNAL`/未知码保守 `unknown`（catch-all 无法证明异常发生在投递前——接收端 M2 分界由 X4 落实）。

### r3 S3 / N2

- 工具 description 与 unknown 结果文本均使用裁定原文：「这条消息可能已进入对方队列，通常在对方下一个 turn 边界可见；不要重发」。`effect:"unknown"` 一律附提示（`XS_UNKNOWN_HINT`，按 reason 不细分——保守方向）。

### origin 守卫（§8.1）

快照 `{sessionId, epoch}` 于调用起点；守卫点：① 调用开始（含 signal）② resolve 往返后、send 发出前 ③ send 往返后（M2 分界）。守卫失败统一 reason `origin_changed`——分界由流程位置决定，这正是 M2 的语义。

### resolve→send（fail-fast）

`message_session` 总是先走一次 `xs_req{resolve}`（地址在消耗任何 send 配额前定形：bad_target/ambiguous/no_target 早退、唯一目标供结果展示），再发**恰好一次** `xs_req{send}`（`to` 传原始地址串；hub X1 负责解析）。无任何重发路径（§3/NQ3 主证明线）。

### wake/level 预检（§4.5/§6.6）

- 发送方 `fabric.wake.enabled=false` ⇒ `wake:true` 本地降级 `sender_wake_disabled`，只投递、**不带 level**（§6.6）。
- 发送方自己的 `maxLevel` 预检失败 ⇒ `level_limit` 本地降级（只投递），**level 仍随帧携带**（接收端 carry 需要）。
- 省略 `wake` ⇒ 帧中无 `wake` 字段（Q1：omit = false）。
- `woke` 派生自 `effect==="applied" ∧ 无降级 ∧ 请求过 wake`（XS0-report §3：`xs_res` 不含 `woke`）。

### 工具 schema（provider 缓存前缀约定）

两个 schema 均为**冻结的模块常量**（比 activate 级更强）：无任何随设置变化的字段——wake 不可用时走运行期降级 + `wakeDowngraded` 说明，不改形状。与 `message_agent` 的 activate 冻结约定同向且更稳。

### 端口（X2 对接面）

`XsHubPort = { list | resolve | send } → Promise<XsPortReply>`，`XsPortReply = {kind:"res",res} | {kind:"deadline"} | {kind:"link_lost"} | {kind:"off"}`。X2 的适配器负责：组 `xs_req` 帧（补 `t`/`rid`/`origin` 原样）、按 §8.2 截止表（list/resolve 3s、send 8s）调 `connection.request(frame, "xs.v1")`、把截止/断链/无 cap 归一为后三种 kind。**X3 拥有全部 effect 决策**，X2 不得合成 `xs_res`。`origin`/`level` 端口（`XsSenderOriginPort`/`XsSenderLevelPort`）由 XW 迟绑定注入。

## 已知裁量（供 X1/X2/XW 对齐，无行为冲突）

1. **resolve 永远先行**：每条消息多一次 3s 往返，且 list+resolve 共享 `listPerMin`（默认 6/min）< `sendsOutPerMin`（10/min）——高频发送场景 resolve 配额先触顶，失败映射为可证 `none`（`client_deadline`/`link_lost`，模型可整call重试）。若 X1 希望放宽，可让 hub 对「紧跟 send 的 resolve」免计 list 配额；X3 侧无需改动。
2. **oversize 预检**用最坏 rid(64)/id(128) 的代理帧测 `XS_MAX_FRAME_BYTES`，早于 hub 拒绝（`E_XS_TOO_LARGE` 双保险）。
3. **`list` 的 post-reply 身份变化不弃行**：只读、无至多一次约束，行数据照返（M2 只约束 send 语义）。
4. 工具冲突检测（§4.3/#12）交付纯函数 `detectXsToolCollisions`（`existing===undefined` ⇒ 无冲突），`session_start` 调用、warn 与 `/fabric status` 展示归 XW。

## 自验（全部通过）

```text
npx vitest run tests/fabric tests/tools        → 45 files / 842 tests passed
npx vitest run tests/fabric/xs-sender.test.ts
             tests/tools/message-session-tool.test.ts → 45 tests passed
npm run typecheck                               → tsc ×2 + vue-tsc 通过
npx prettier --check <5 个新文件>                → 通过
```

（worktree 原无 node_modules，`npm install` 装齐后运行；未跑全量 `npm test`——按任务约束禁止，影响面由 tests/fabric + tests/tools 覆盖。）

## 遗留 / 下游依赖

- X2：实现 `XsHubPort` 适配器 + 截止表；XW：装配（工具注册仅主会话 `xsOn`、origin/level 端口、冲突检测调用）。
- `xs-sender` 的 hub 行为全部由 fake 驱动；真实 socket 往返在 XW 的 `tests/integration/fabric-xs.test.ts`（§11.2 XW 行）。
- 无范围外改动；无未解阻塞。
