# merged-plan · P4 UI 传输 交付报告（2026-10-25）

范围：merged-plan r3 §7.1 / §8.1 P4 行。基线 HEAD 含 P0 协议提交（`wtgraph.merged.v1`、
`WTGRAPH_MERGED_CLIENT_TIMEOUT_MS` 48 s、`WTGRAPH_MERGED_QUERY`）。

## 改动文件

| 文件                                                              | 改动                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/logic/gitGraphScope.ts`                       | `GraphScope` 加必填 `merged: boolean`；`wtgraphScopeOf` 以 caps 含 `WTGRAPH_MERGED_HUB_CAP` 填充。无额外门：§5.1 规定 merged cap 与 `wtgraph.v1` 同条件声明（loopback / LAN-without-preview.lan.v1 天然不带）。                                                                                                                 |
| `src/web-hub/ui/src/transport/types.ts`                           | `WorktreeGraphTransport.graph()` req 加 `readonly merged?: true`，注释写明 48 s 切换语义。                                                                                                                                                                                                                                      |
| `src/web-hub/ui/src/logic/token-client.js` / `password-client.js` | 同一改动：`wtgraphGet(url, signal, merged)` 按 merged 选 48 s / 35 s deadline；`wtgraph()` 在 `req.merged === true` 时 URL 追加 `&merged=1`（query 键取自 protocol 的 `WTGRAPH_MERGED_QUERY`，非手抄）。无 cap 时 URL 与超时逐字节同基线。                                                                                      |
| `src/web-hub/ui/src/composables/useWorktreeGraph.ts`              | `pull()` 按 `sc.merged` 条件带上 `merged: true`（exactOptionalPropertyTypes 用条件展开）；新增 `mergedKeyOf` watch（R2-11）：同 agent/session 下 cap 变化 ⇒ ① abort 在途；② 失 cap 立即剥离显示数据的 `merged`（解构去键）；③ 展开态立即重拉不收起，未展开只标脏（`mergedDirty`），下次展开补拉。scope 变化仍走原逻辑并清脏标。 |

**零改动（经核查天然透传）**：`transport/{token,password}.ts`（`satisfies WorktreeGraphTransport`
薄转发，req 类型沿 types.ts 流动）、`logic/contract.js`（merged 常量由 clients 直接 import
protocol，同现有 `WTGRAPH_*` 模式，contract.js 无对应表面）、`composables/useHub.ts`
（`...(transport.worktreeGraph === undefined ? {} : …)` 纯透传）。

## 测试（只追加 + 最小同步）

- `tests/web-hub/ui/logic-git-graph.test.ts`：真值表三处 `toEqual` 同步 `merged:false`；追加「merged 列」用例（token/loopback/password 三模式 cap ⇒ `merged:true`；merged cap 单独存在不出 scope）。
- `tests/web-hub/ui/transport-contract.test.ts`（两 adapter 同跑）：`merged:true` ⇒ URL 恰为 `…&merged=1` + X-PWH；48 s 用例（35 s 处未结算、48 s 触发 E_DEADLINE、单次请求不重试）；基线钉（无 merged ⇒ URL 精确等于基线串、35 s 整超时、35 s−1 ms 未结算）。
- `tests/web-hub/ui/worktree-graph.test.ts`：scope 字面量同步 `merged:false`；追加 composable 直测三例——cap 增（展开态立即带 `merged:true` 重拉、不收起）、cap 减（显示数据 `merged` 当即剥离、按基线重拉、不收起）、未展开 cap 变化不发请求、下次展开按新能力补拉。
- `tests/web-hub/contract/types.test-d.ts`（主会话授权）：graph request 的 expectTypeOf 同步 `merged?: true`。

## 自验（尾部四命令）

- `npx vitest run tests/web-hub/ui tests/web-hub/contract` ⇒ **272 文件 / 5963 测试全过**。
- `npm run typecheck` ⇒ 三个 tsconfig（含 vue-tsc）全部通过，无输出。
- `npx prettier --check <9 个改动文件>` ⇒ All matched files use Prettier code style（两处测试文件先 `--write` 收口后复跑 vitest 仍绿）。
- `git diff --quiet HEAD -- tests/fixtures/ && echo fixtures-ok` ⇒ `fixtures-ok`。

## 修订（2026-10-25 验收后）

- 「cap LOST」用例的第二次 `graph` 调用改为永挂 promise：剥离断言在 re-pull 在途时判定（`refreshing:true` + `merged` 已消失），变异自检通过（临时注释 `useWorktreeGraph.ts` 剥离块 ⇒ 该测试变红，恢复后复绿）。
- 补「cap flip aborts the in-flight request（§7.1 ①）」用例：双向 cap 翻转 ⇒ 旧 signal aborted、第二次请求带/不带 `merged` 正确。

## 遗留

- 无。P2（hub 路由）在途的 `hub/*`、`tests/web-hub/{hub,http}/*` 改动不属于本包，未触碰。
- `GraphPanel.vue` / `WorktreeGraph.vue` 不在 P4 文件域：scope 对象新增字段经既有 computed/prop 链路自动流入，无需改动。
