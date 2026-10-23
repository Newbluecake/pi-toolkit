# AL2 报告：hub 别名路由（alias-plan r4 §3.3 矩阵 / §3.6 / §5 / §6 / §8）

未 commit。没有改 `aliases.ts`（AL1 API 够用，没发现缺陷），也没有改 `limits.ts`、`ports.ts`、`audit.ts`、UI 和 stack/index。

## 改动文件

- `src/web-hub/hub/xs/router.ts`：别名层、精确发送、op alias、`from.alias` 盖章、配置校验和装配辅助函数（`createXsAliasBinding`、`normalizeHubXsAliasConfig`、`mergeHubXsAliasConfig`、`hubXsAliasParamsOf`、`HubCrossSessionConfigWithAlias`），以及喂在场的观察者包装和 `createXsRelay({aliases})`。
- `src/web-hub/hub/xs/members.ts`：有效成员加 `aliasCapable`（hello caps ∋ `xs.alias.v1`）；加 `sessionOf(agentKey)`，返回存储记录的 sid，供在场喂入用。
- `src/web-hub/hub/xs/broadcast.ts`：加可选依赖 `fromAliasFor(recipient)`，按每个收件人决定是否写 `from.alias`。
- `src/web-hub/hub/hub.ts`：装配点（见下）。
- `src/web-hub/hub/main.ts`：重新校验 alias 子键并合并回配置。
- 测试：
  - `tests/web-hub/hub/xs-alias-router.test.ts`（新，30 例）
  - `tests/web-hub/hub/hub-xs-alias.test.ts`（新，3 例，真实 startHub + socket）
  - `tests/web-hub/hub/xs-router-v071-diff.test.ts`（追加 5 例：无 cap 请求方 × 持有别名的成员）

## 路由规则表

记号：`adv` = 本次运行绑定表加载为 ready（固定不变）；`aliasUsable(m) = adv ∧ m.aliasCapable`；`guarded(m) = 有表 ∧ ¬adv ∧ m.aliasCapable`（只在 degraded 时出现）。

| 操作                    | aliasUsable 请求方                                                                                                                                                                                                                                                              | degraded 且请求方 aliasCapable                                                                                        | 其他请求方（含无表 hub）                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| resolve                 | sid 精确 → 前缀 ≥8 → **别名层** → 名字精确 → 名字忽略大小写。别名层用 `store.resolveQuery(q)`（不剥 `@`）：未命中进入名字层；命中后只看这一层：记录为 held 且持有者在可见池里 ⇒ 命中（仍按全表 holders 判重）；否则（cooling、离线、未 join、跨频道、是自己）⇒ `E_XS_NO_TARGET` | sid 精确 → 前缀 → 别名形状（`isAliasShaped`）⇒ `E_XS_ALIAS_UNAVAILABLE`（none），不进入名字层；不是别名形状才走名字层 | 旧四层，输出字节不变                                    |
| target                  | `ref, alias?, name?, sessionId`（**一律**带完整 sessionId；目标持有别名就带 alias）                                                                                                                                                                                             | 旧形状                                                                                                                | 旧形状（sessionId 仍只在 reply 双方都具备能力时带）     |
| candidates              | `ref, alias?, name?, channels?`                                                                                                                                                                                                                                                 | 旧                                                                                                                    | 旧                                                      |
| list                    | 行为 `ref, alias?, name?, …`；有别名的行排前，组内按 activity 降序（Q11）；query 额外匹配别名前缀（query 做 NFKC + ASCII 小写）                                                                                                                                                 | 旧                                                                                                                    | 旧                                                      |
| 普通 send               | **只做精确匹配**（`m.sessionId === to`，不 trim、不前缀、不走别名和名字层）；保留可见池、排除自己、全表 holders 判重；找不到（含名字、别名、ref、前缀、`root`）一律 `E_XS_NO_TARGET`（none）                                                                                    | 旧四层 + 守卫（别名形状 ⇒ UNAVAILABLE）                                                                               | 旧四层                                                  |
| 带回复字段的 send       | 精确匹配，保留原有的 BAD_FRAME 诊断（不变）                                                                                                                                                                                                                                     | 同左                                                                                                                  | 同左                                                    |
| `xs_deliver.from.alias` | 按**收件人**判定：收件人 aliasUsable 且发件人持有别名才写（send、reply、broadcast 三条路径）                                                                                                                                                                                    | 从不写                                                                                                                | 从不写                                                  |
| `op:"alias"`            | 见下                                                                                                                                                                                                                                                                            | `E_XS_BAD_FRAME`                                                                                                      | `E_XS_BAD_FRAME`（与改动前 hub 对该帧的回答逐字节相同） |

`op:"alias"` 子操作按帧字段判定：

- 无 `alias` 且无 `clear` ⇒ get；
- `clear:true` ⇒ clear；
- `alias` ⇒ set；
- `alias` + `take:"preview"` ⇒ 抢占预览；
- `alias` + `take:<token>` ⇒ 抢占执行。

以下组合在进入 store 之前直接拒绝，回 `E_XS_BAD_FRAME`：`clear` 同时带 alias 或 take、take 缺 alias、token 不匹配 `XS_ALIAS_TAKE_TOKEN_RE`。get 和预览计入 `listPerMin`。cwdLabel 用请求方自己的 `abbreviateHome(cwd)`。失败一律经 `xsAliasFailureWire` 转换，所以 `E_XS_ALIAS_TAKEN{confusable}` 这类码不回显任何已有别名，只有 `E_XS_ALIAS_UNKNOWN` 的 effect 是 unknown。审计行为 `op:"alias"`、`reason:<子操作>`、`code`、`fromSession`（截 8 字符）、`ms`，**不含**别名明文、token 和 cwd，有测试断言。

在场喂入：`createXsRelay` 在有表时把 `members.observer` 包一层，在 `onMember`、`onSession`、`onInvalidate` 执行**之后**对受影响的 sid 调 `touchPresence`。受影响的 sid 包括旧 sid（取自 `members.sessionOf`）和新 sid。`isOnline(sid)` 的判定是 `members.effectiveAll()` 里存在这个 sid。`isRequesterLive` 要求同一 agentKey 当前的有效成员 sid、epoch 都一致，并且 `aliasCapable`。

## cap 广告条件

只有 `HubConfig.crossSession` 存在、`crossSession.alias` 存在且合法、`store.load()` 结果为 `ready` 三者同时成立时，才声明 `xs.alias.v1`。它追加在 `xs.channel.v1` 之后，HubInfo.caps 和 hello_ack.caps 共用同一个 `extraHubCaps` 数组。

- 键缺失 ⇒ 不建表、零磁盘 IO、cap 字节不变。
- 键非法 ⇒ `main.ts` 丢掉 alias 子键并写 stderr，等同于键缺失。
- 加载结果为 degraded（损坏、不可读、超时）⇒ 不声明 cap，文件一个字节都不动，hub 日志记 warn `xs alias store degraded {reason, path}`。

## 装配点

- `main.ts`：先 `normalizeHubCrossSessionConfig`，再调 `mergeHubXsAliasConfig(raw, normalized)`。没有 alias 子键时直接返回**同一个对象**，配置字节不变，有测试钉住。
- `hub.ts`：在单例锁之后、`extraHubCaps` 之前依次执行 `hubXsAliasParamsOf(config.crossSession)` → `createXsAliasBinding({stateDir: paths.stateDir, params, log, now})` → `cleanup.push(store.close)` → `await startupStep(store.load())`（store 自带 2s 预算）。这远早于 `createAgentServer`，所以 router 开始收请求之前加载必定已完成。`createXsRelay({…, aliases: binding})` 负责 attach members，并接管 dispose（`relay.dispose()` 会关闭 store；正常关闭路径上原有的 `xsRelay?.dispose()` 就覆盖了它，`close()` 幂等）。
- 文件：`<stateDir>/xs-aliases.json`，路径来自 AL1 的 `xsAliasFilePath`。

## 偏离（需主会话知晓）

1. **键缺失即关闭，与 §3.6 原文不同（已 consult 方案作者 r_9TWX8QV1，按其结论 B 执行）**。§3.6 原文是「crossSession 存在即建表，`alias` 缺失只表示用默认值」。实现改为：`crossSession.alias` 缺失 ⇒ 不建表、不声明 cap，hub 字节不变；非法 ⇒ 丢掉该键并记日志；存在且加载 ready ⇒ 声明 cap。这与 AL3 对齐（agent 只在 `alias.enabled=true` 时才写这个键），所以 `alias.enabled=false` 的含义就是「spawn hub 时不写 alias 键」。无表时 hub 等同于旧 hub：对 aliasCapable 请求方也**没有**降级守卫，只有 degraded 才有守卫。
   - 请主会话把 §3.6 改成「`crossSession.alias` 缺失 ⇒ 关闭（字节不变）；非法 ⇒ 丢键并记日志；存在且加载 ready ⇒ 声明 cap」。
   - 请在 §11 新增一条残留：「谁 spawn hub，谁决定本次 hub 运行期内别名是否开启。由 `alias.enabled=false` 的会话 spawn 时，所有人都用不了别名（全部回落到旧行为），直到有 alias-enabled 的会话执行 `/webhub restart`」。
2. **`/webhub status` 的 degraded 行没做**：要改 `hub-json.ts` 和 agent 侧，不在本包文件域里。hub 目前只写日志 warn（带 reason 和 path）。`store.status()` 已能提供 state、reason、path，后续接 hub.json 的 patch 即可。
3. **审计不记别名明文**：`audit.ts` 没改（op 联合类型里 AL0b 已经加了 `alias`），子操作放在 `reason` 字段。
4. 非 alias op 上带的 `alias`、`clear`、`take` 字段一律忽略，不拒绝，以保证无 cap 请求方的行为不变。
5. aliasUsable 请求方的普通 send 遇到保留地址（如 `root`）回 `E_XS_NO_TARGET`，不再是 `BAD_TARGET`，这是 §5.2「找不到时一律返回 NO_TARGET」的直接结果；agent 本地本来也会先拒绝。
6. 只要目标持有别名就写 `target.alias`，不限于命中别名层的情况，与 rows、candidates 一致。
7. op alias 只要求请求方是有效成员，不要求已 join，与 AL1 用 `effectiveAll()` 判在场的口径一致。
8. 类型：`HubConfig.crossSession` 的类型定义在 `limits.ts`（不在域内），所以在 `router.ts` 里用交叉类型 `HubCrossSessionConfigWithAlias`，hub.ts 通过 `hubXsAliasParamsOf` 读取（它会再校验一次，直接调 `startHub` 的测试也安全）。

## 测试覆盖（§9 AL2 行）

- 状态×行为矩阵逐格：ready → wedged（UNKNOWN）→ ready（晚到 rename 成功 / 失败）、wedged → disabled（>60s）。每格都断言 aliasUsable 请求方用「前端」到不了「显示名=前端」的 B，并检查写为 busy、读用旧表、advertised 不变、无 cap 请求方保持旧行为。
- §5.2 的三个屏障反例：同 ref 的 UUIDv7（含 take 后再发）、显示名等于 A 的完整 sessionId、以 A 的完整 ID 为前缀的自定义 ID。另外断言名字、别名、ref、前缀、带空格的 id、`root` 作为 `to` 都是 NO_TARGET。
- 别名层命中即定：离线、未 join、跨频道、自己、cooling ⇒ NO_TARGET；cooling 到期后回到名字层。
- degraded：别名形状 ⇒ UNAVAILABLE（resolve 和 send 都测）；sid、前缀、非别名形状的名字仍可用；op alias 回 BAD_FRAME；无 cap 请求方是旧形状；文件字节不变。键缺失：没有守卫，op alias 回 BAD_FRAME，零 IO。
- `from.alias`：send、reply、broadcast 三条路径都按收件人判定；不持有别名时 from 的键序与旧版完全相同。
- op alias：get、set（全角和 `@` 规范化）、INVALID、clear、`taken`/`confusable` 不回显、畸形帧、预览与 `listPerMin` 计数、完整 take 链路（token 任何结果都消耗、被抢方回来 get 到 `lost{taken}`）、审计卫生。
- 在场喂入：断开时盖 offlineSince（9 分钟 recent，10 分钟可抢——不接喂入时这条会失败）；会话切换时旧 sid 下线。
- **v0.7.1 差分**：C、E、G1、I 声明 cap 并持有与他人显示名相撞的别名（`beta`/`delta`/`phi`/`alpha`），无 cap 请求方 A、B、D、H 的整份转录与冻结的 v0.7.1 router 逐字节相等；反向对照：给 A 加 cap 后输出出现分歧。
- hub 装配：cap 矩阵（无 xs、只 xs、xs+alias，两个 cap 面相等、追加在尾部、alias on 恰好只多一个 cap、全新表不建文件）；损坏文件两次启动都不声明 cap 且字节不变、无 `.bak` 和临时文件；真实 socket 上 set → 文件 0600 → hub 重启 → 仍为 held，另一会话 resolve 得到 `alias` 和 `sessionId`。

## 自验

```
$ npx vitest run tests/web-hub/hub tests/web-hub/http tests/web-hub/boundary.test.ts tests/integration/fabric-xs*.test.ts --maxWorkers=3
 Test Files  279 passed (279)
      Tests  5577 passed (5577)
   Duration  255.38s

$ npx vitest run <三份 off golden 相关测试> tests/web-hub/protocol --maxWorkers=3
 Test Files  51 passed (51)
      Tests  1666 passed | 3 skipped (1669)

$ npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.typecheck.json
（无输出，通过；vue-tsc 未跑，ALU 在途）

$ npx prettier --check src/web-hub/hub/xs/{router,members,broadcast}.ts src/web-hub/hub/{hub,main}.ts \
    tests/web-hub/hub/{xs-alias-router,hub-xs-alias,xs-router-v071-diff}.test.ts
All matched files use Prettier code style!
```

## 遗留

- `/webhub status` 的 degraded 行（hub.json + agent 侧），见偏离 2。
- 集成测试 `tests/integration/fabric-xs-alias.test.ts`（3 个真实 stack，含 web 抢占全链路）属于 AL6，依赖 ALW 接线。
