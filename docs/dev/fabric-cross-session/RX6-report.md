# RX6 报告（可观测性 + 收尾）

## 改动

- `src/commands/status.ts`：`/agent status` xs 行 receive 有效值与偏好不同时追加 `(pref replies)`；reply 开启时追加一行 `xs replies p<pending>/<max> i<inbox> to<timedOut> late<n> rej<n> owed<n> drop<n> · ledger n/64`（源：`ledger.stats`）；reply 关闭 / xs off 时缺省，原输出逐字节不变。
- `src/commands/fabric-xs.ts`：`/fabric status` 首行同样补 `(pref …)`（其余 §8.3 展示 RX5 已具备）。
- `src/stack.ts`（**越域一行，需知会**）：`StackXsReply` 增加 `sessionId`（status 取账本统计的 key；stack 内已有该变量）。
- `src/fabric/xs/reply-ledger.ts`：票据 `noticeSent`（`clearOwed` 置位）；`release` 不再对已送达的超时通知重欠，也不再把它计入 dropped。
- `src/fabric/xs/reply-notice.ts`：`finishWrite` 对 wakeOnly（goal）的 verify 失败不计 `noticeUnverified`（与 receiver 一致）。
- 测试：`tests/commands/status-xs.test.ts`、`tests/commands/fabric-xs.test.ts`、`tests/fabric/xs-reply-ledger.test.ts`、`tests/fabric/xs-reply-notice.test.ts` 追加；新增 `tests/fabric/xs-reply-receiver.property.test.ts`（真实 XsReceiver + 真实账本，300 次随机序列：重复/同步重入回复、Controller 6 种返回/降级/抛错、宿主抛错、栅栏、sweep/时间推进、/reload、错误发送方/未知 id；断言每个 requestId 至多一次可能生效派发，且无 consuming 残留；另有 >100 次有效派发的覆盖断言）；`tests/integration/fabric-xs-reply.test.ts` #1 补 level = requesterLevel 断言；`tests/conformance/fabric-xs.test.ts` 新增 **C-X8**。
- 文档：`AGENTS.md`（新增 request-reply 段，@session 写成「回复按接收模式可唤醒、跨会话消息对用户可见（RX7）」）；`reply-plan.md` 末尾「实施回填」（保留 §10.2）。

## 自验

- 定向 8 个文件（含 3 份 off golden）：`Test Files 8 passed · Tests 73 passed`。
- `npx vitest run tests/commands`：13 files / 246 passed（改动前后）；fabric-xs 命令 36 passed。
- conformance `tests/conformance/fabric-xs.test.ts`：13 passed（含 C-X8，C-X6 委托的 fabric-wake + consult-preserve 通过）。
- `npm run typecheck`：0 错误（含 vue-tsc）。
- prettier --check：我改动的文件全部通过。
- 未跑全量 `npm test`；UI 文件未触碰。

## 遗留

- C-X8 的 level 断言在 conformance 里不涉及（level 在集成 #1 覆盖，且 fresh 会话 level=0，断言的是「无 +1」）。
- 见 reply-plan.md「实施回填」残留项。
