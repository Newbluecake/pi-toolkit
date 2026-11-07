# batch2 ⑨-H2 实施报告（gov/step9h2）

> 基线：`dev@74703578`（worktree `/tmp/gov-step9h2`，分支 `gov/step9h2`）。
> 范围：`docs/dev/source-governance/batch2-plan.md` §6 H2 行 —— `src/web-hub/hub/http.ts` 的
> `handleLanRequestInner` + `createLanTransport` + `handleLanLogin` 拆到 `http-lan.ts`，
> `dispatchCmdOrDialog` 拆到 `http-cmd.ts`；`createRouteSet` 不动。纯抽取（拍板第 4 条）。

## 行数前后

| 文件                          | 前（74703578） | 后   |
| ----------------------------- | -------------- | ---- |
| `src/web-hub/hub/http.ts`     | 4094           | 2170 |
| `src/web-hub/hub/http-cmd.ts` | —              | 642  |
| `src/web-hub/hub/http-lan.ts` | —              | 1392 |

## 提交列表（按逻辑步骤）

| sha        | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b0642c99` | `refactor(web-hub)`：cmd/dialog 写管线（`dispatchCmdOrDialog` + 其独占 helper/常量：`parseCmdBody`/`parseDialogBody`/`parseExpect`、`byteLenOk`、`limitCategoryFor`、`cmdErrorStatus`/`sendCmdResult`、`CmdAuthResult`/`CmdAuthHandled`、`CMD_ID_RE`/`COMMAND_NAME_RE`、各 `*_MAX_BYTES`、`HUB_INFLIGHT_CAP`、`RATE_AUDIT_WINDOW_MS`、`REF_FLUSH_*_MS`）→ `http-cmd.ts`；`spawn.test.ts` 的同源常量 pin 指向新文件（D9-2，意图不变）                                                                                                      |
| `f6b6af93` | `refactor(web-hub)`：`createLanTransport` + `LanTransportCtx` + `SocketWithLease` + `hostPartOf` + 传输层独占常量（`LAN_BIND_HOST`/`LAN_SOCKET_IDLE_MS`/`LAN_HEADERS_TIMEOUT_MS`/`LAN_KEEPALIVE_TIMEOUT_MS`）→ `http-lan.ts`；`lan-allowlist.test.ts` 改从 `http-lan.js` 导入                                                                                                                                                                                                                                                             |
| `0a73c38c` | `refactor(web-hub)`：LAN 应用层（`LanRuntime`、`sharedTouchSession`/`releaseClientInflight`/`touchForExpiryRecheck`/`recheckLanSseExpiry`/`scheduleAbsoluteExpiry`/`clearAbsoluteExpiry`/`LanAuthed`/`LanAuthFailure`/`requireLanSession`/`csrfOkLan`、`writeLanLoginReply`、`handleLanLogin`、`handleLanRequestInner` + `handleLanRequest` 包装、LAN 独占常量 8 个）→ `http-lan.ts`；`lan-sse-verifiedat.test.ts`（`recheckLanSseExpiry`/`LanRuntime`）与 `lan-login-integration.test.ts`（`writeLanLoginReply`）改从 `http-lan.js` 导入 |

## 零行为证据

1. **机械文本比对**：脚本抽取 74703578 的 54 个被移声明（23 个 → http-cmd.ts、31 个 → http-lan.ts）与新位置逐个 diff，规范化掉新增的 `export ` 前缀后**全部逐字节相同**；30 个应留在 http.ts 的声明（`createRouteSet`、`strictCsrfOk`/`apiCrossSiteOk`/`isProxyApiPath`/`uploadCsrfOk`、`isHeadlessPath`、`sendCookieConflict`、`serveSchedules`/`serveLoadTop`/`serveVersionInfo`、`buildLanStatus`、`createHttpFrontend`、低层 helper 群等）全部仍在。`createRouteSet` 一行未动。
2. **I5**：三个文件的 `unref` 出现次数合计 12，与 74703578 的 12 相同。
3. **I4**：两个新文件无模块级 `let`/`var`（grep 验证）；移动的全是顶层 `const`/函数/类型声明。
4. **导出面**：只是给 http.ts 的既有模块私有 helper 加 `export` 关键字供同包新文件回导（`HttpError`、`field`/`stringField`、`readJson`、`sendJson`/`sendError`、`normalizePeerIp`、`toAbortError`、`setSecurityHeaders`、`requestFailedFields`、`CLOSE_DEADLINE_MS`、`sendCookieConflict`、`serveSchedules`/`serveLoadTop`/`serveVersionInfo`、`isHeadlessPath`、`proxyBrowserHost`、`uploadCsrfOk`、`isProxyApiPath`、`RouteSet` 类型）；无设置键、wire 字段、tool schema/描述、命令表、注册顺序、模型可见文本的改动。http.ts ⇄ http-cmd.ts / http-lan.ts 的循环 import 全部在函数体内解析，模块求值期互不触碰（已用全量测试证明）。
5. **安全语义**：#66 已先于本包合入；`handleLanLogin`/`createLanTransport`/`requireLanSession` 等整段按 #66 后的原样移动，未编辑任何语句。
6. **import 清理**：http.ts 中只服务被移代码的 import 已剪枝（`tsc --noUnusedLocals` 对三个文件仅剩 `CmdOp` 1 条——该死导入在 74703578 上就已存在，不在本包范围）。

## 自验命令与结果

| 命令                                                                                                             | 结果                                                               |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `npm run typecheck`（tsc ×2 + vue-tsc，每个提交后均跑）                                                          | ✅ 通过                                                            |
| `npx vitest run tests/web-hub --maxWorkers=3`                                                                    | ✅ 707 文件 / 15853 passed / 4 skipped                             |
| `npx vitest run tests/integration/web-hub- --maxWorkers=2`                                                       | ✅ 28 文件 / 217 passed / 5 skipped                                |
| 冻结 golden：`tests/integration/{schedule-off,fabric-xs-off,fabric-xs-reply-off,fabric-wake-off}-golden.test.ts` | ✅ 11 passed                                                       |
| `tests/conformance/{cmd-history,slash-args,history-restore,web-resume}.test.ts`（§6 证据面）                     | ✅ 23 passed                                                       |
| `tests/web-hub/boundary.test.ts`（I8；新文件自动落入 hub 规则）                                                  | ✅ 20 passed                                                       |
| 被钉住代码段：`tests/web-hub/protocol/spawn.test.ts`（改指 http-cmd.ts）                                         | ✅ 70 passed                                                       |
| `npm run format:check`                                                                                           | ✅ 通过                                                            |
| `git diff --quiet 74703578 -- tests/fixtures/`                                                                   | ✅ 空 diff                                                         |
| `npm run build:web && npm run check:web`                                                                         | **未跑**：本包不触碰 `src/web-hub/ui/**`（任务口径「涉及 UI 时」） |

## 遗留

- `src/web-hub/hub/http.ts:61` 的 `CmdOp` 是 74703578 上就存在的死导入（`tsc --noUnusedLocals` 唯一残留），不在 ⑨-H2 范围内，未动。
- ⑨ 的 H1（`web-hub/agent/index.ts`）与 H3（`web-hub/hub/hub.ts`）是另外两个包，不在本 worktree。
