# ALW 报告：会话别名装配（alias-plan r4 §4/§5/§6/§7/§10 ALW 行）

未 commit。三份 off golden 未改动且通过；`tests/fixtures/legacy-xs-v071/` 未改动。

## 接线清单（逐条对应各包「端口需求 / 供 ALW」）

冻结量：`src/index.ts` 在 activate 时算出 `aliasOn = xsEnabled ∧ settings.fabric.crossSession.alias.enabled`，非 live，和 `replyEnabled`/`channelsOn` 同一套做法。另有一个 live 探针 `xsAliasUsable() = aliasOn ∧ webHubRef.current.xs.hubPort().aliasUsable()`，它读的是 AL3 桥里同一份「本端开启 ∧ 当前 link live ∧ hub 声明 xs.alias.v1」状态。

| 包   | 端口需求                                                                          | 接线位置 / 做法                                                                                                                                                                                                                                                                                                                                               |
| ---- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AL3  | `aliasEnabled?()`，activate 冻结                                                  | `index.ts` 的 `deps.xs`：`aliasOn` 时提供 `aliasEnabled: () => true`；关闭时**不写这个键**（桥按缺省 false 处理，与旧形状逐字节相同）                                                                                                                                                                                                                         |
| AL3  | `aliasHubConfig?()`                                                               | 同上，只在 `aliasOn` 时提供 `{offlineLeaseH, coolMin, takeMinOfflineMin}`，取自设置                                                                                                                                                                                                                                                                           |
| AL3  | `notifyAliasLost?(text)` 接 `ctx.ui.notify`                                       | 同上。用 `notifyCapabilityCtx.current`（指向最近一次 session_start 的 ctx），条件是 `hasUI` 且 `ui.notify` 可用，调用 `notify(text,"info")`，try/catch 包住。去重由桥负责                                                                                                                                                                                     |
| AL3  | stack attach 时对账                                                               | `web-hub/agent/index.ts` `connectWith()`：在 `xsBridge.publishMember()` **之后**调 `xsBridge.onHubCapsAlias()`。每次 session_start 都走这里，包括复用 link 的 /new、/resume、/fork。link 还没 live 时是 no-op，由 hello_ack 补上                                                                                                                              |
| AL3  | hello_ack 对账                                                                    | AL3 已接（`onHubCaps` 的 publishMember 之后），未改                                                                                                                                                                                                                                                                                                           |
| AL3  | `aliasBridge()`/`aliasCache()` 交给 `/fabric alias`                               | `WebHubControl.xs` 增加 `aliasBridge()`、`aliasCache()`，透传 `xsBridge` 的同名方法                                                                                                                                                                                                                                                                           |
| AL4  | `/fabric` 的 `alias?()` 端口；xs 开启时始终传入                                   | `createFabricXsCommand({... alias: () => ({localEnabled: aliasOn, bridge?, cache?, leaseDays, coolMin, suggestions})})`。`aliasOn=false` 时也传，status 因此显示 `alias n/a (alias.enabled=false)`。web-hub 侧没有 xs 时不带 bridge/cache，命令在本地拒绝。`leaseDays = offlineLeaseH/24`（保留 1 位小数）                                                    |
| AL4  | 补全推荐 `suggestions()`                                                          | 新增纯函数 `src/fabric/xs/alias-suggest.ts`：候选依次为 cwd 末段、会话名首词、cwd 中的 CJK 段（从深到浅），去重，最多 8 个。cwd 和会话名取自 live ctx。规范化和过滤由命令自己做                                                                                                                                                                               |
| AL4  | 收件侧 `input.from` 带 hub 盖章的 alias（仅 aliasUsable 时）                      | 帧的 `from` 本来就原样交给 receiver，再进入 `formatXsMessage/Reply`。ALW 加了本地门：`StackXsInput.aliasUsable`（`aliasOn` 时传 `xsAliasUsable`）。`buildStackXs.deliver` 遇到 `from.alias` 但本端不满足 aliasUsable 时先剥掉再交给 receiver，所以 alias 关闭的 agent 即使碰上不合规的 hub，模型可见内容也逐字节不变。`XsDeliverInput.from` 类型补了 `alias?` |
| AL5a | `createListSessionsTool({..., alias})` / `createMessageSessionTool({..., alias})` | `aliasOn` 时传 `alias: true`，否则不传这个键（即 legacy 实例）。冻结策略见下                                                                                                                                                                                                                                                                                  |
| AL5a | `XsHubPort.aliasUsable?()`                                                        | 两处：① `web-hub/agent/xs.ts` 的 `hubPort()` 增加 `aliasUsable: () => aliasUsable()`，与 hello cap 同源；② `index.ts` 的 sender port 只在 `aliasOn` 时加 `aliasUsable: xsAliasUsable`（关闭时这个键不存在，sender 与旧版逐字节相同）                                                                                                                          |
| AL5a | resolve/send 透传 `target.alias`、`rows[].alias`、新错误码                        | 桥的 `roundTrip` 原样返回 `xs_res`，`listRows` 原样返回 `res.rows`，不需要改                                                                                                                                                                                                                                                                                  |
| AL5b | `createMentionSessionPort` 的 `aliasMode`/`lookupAlias`                           | `sessionParseDeps()` 在 `aliasOn` 时增加 `aliasMode: xsAliasUsable`（LIVE）和 `lookupAlias`。关闭时两个键都不存在，parse 走旧路径                                                                                                                                                                                                                             |
| AL5b | 未命中且 token 形似别名 ⇒ `directory.refresh("mention")`                          | 放在 `lookupAlias` 包装里：`directory.lookupAlias(a)` 返回 undefined 时 `void directory.refresh("mention")`（已节流、单飞）。AL5b 只在 token 通过 `normalizeAlias`、label 检查和同名文件检查之后才会调用 `lookupAlias`，所以这里正好等于「未命中且形似别名」，不需要在 index.ts 里重复判断形状。写法与现有 `lookupExact` 的 miss 刷新一致                     |
| AL5b | 补全 source：条目带 alias、`sessionBareAlias`                                     | `aliasOn` 时 `sessions()` 条目增加 `alias: row.alias`，并提供 `sessionBareAlias: (a) => sessionCompletionAlias(sessionParseDeps(), a)`                                                                                                                                                                                                                        |
| AL2  | agent 侧写 hub 配置：alias 关闭 ⇒ 不写键（偏离 1）                                | 桥的 `hubCrossSessionConfig()` 只在 `aliasEnabled()` 为真且提供了 `aliasHubConfig` 时写 `crossSession.alias`；ALW 只在 `aliasOn` 时提供这两项。集成测试已断言：alias 关闭时没有这个键，开启时为 `{168,10,10}`                                                                                                                                                 |
| —    | `StatusInfo.xs.alias`                                                             | AL3 的 `statusProjection` 已实现（usable 且缓存为 held 才写），ALW 不需要改                                                                                                                                                                                                                                                                                   |

## 工具实例冻结策略

- 按**本端** `alias.enabled` 在 activate 时冻结（`aliasOn`），**不看** hub cap。原因是：hub cap 晚到、重连、换 hub 都不能改动已注册工具的 description，否则会破坏 provider 缓存前缀。hub 没有 cap 时，运行期自动退回旧寻址：sender 不 pin、mention 走旧分支、`/fabric alias` 本地拒绝。这与方案 §6「冻结实例……在 activate 时选定」一致。
- 参数 schema 与同模式（channels / reply）的实例是**同一个对象**（AL5a 偏离），只有 description 追加别名说明。所以 `listSessionsParamsFor(channelsOn)`/`messageSessionParamsFor(replyEnabled)` 的冲突检测不用改。
- alias 关闭 ⇒ 注册的工具 description 和 parameters 与 `createListSessionsTool({sender, channels})`/`createMessageSessionTool({sender, reply})` 的 legacy 输出完全相等（集成测试断言 `toBe`）。
- `/reload` 不会重复注册：注册仍在 activate 内的 xs 块里，每个 activate 一次，没有新增注册点。没有新增定时器，没有 module-scope 可变状态（`alias-suggest.ts` 是纯函数）。HOST_KEY 守卫和子会话惰性不变：所有接线都在 post-guard 的 xs 块和 webHub 块内。

## 改动他包文件清单（及理由）

1. `src/web-hub/agent/xs.ts`（AL3）：`hubPort()` 增加 `aliasUsable`，1 行。AL5a 要求 `XsHubPort.aliasUsable?()`，而 AL3 的 hubPort 没有暴露它。复用桥内已有的 `aliasUsable()`。
2. `src/web-hub/agent/index.ts`（AL3）：
   - `WebHubControl.xs` 增加 `aliasBridge()/aliasCache()`（含类型 import），否则 `/fabric alias` 拿不到 AL3 的端口；
   - `connectWith()` 在 `publishMember()` 后调 `onHubCapsAlias()`，实现「stack attach 时对账」。这一步只能放在 web-hub 自己的 session_start 路径里：`src/index.ts` 的 session_start 先于它运行，那时 `xs_member` 还没发出，hub 的 `isRequesterLive` 会拒绝这个 get。
3. `src/fabric/xs/receiver.ts`（AL4 邻接）：`XsDeliverInput.from` 类型补 `alias?: string`，纯类型改动，运行期本来就透传。
4. `tests/integration/fabric-xs-channel-compat.test.ts`（冻结面测试）：这份测试走真实 activate，而 `alias.enabled` 默认开启，会多出 cap `xs.alias.v1` 和 `HubConfig.crossSession.alias`，与锚定的 pre-alias golden 不符。处理方式：
   - 四个频道锚定配置显式写 `alias:{enabled:false}`（≡ 采集 golden 时的 pre-alias agent），四配置的原断言一条没改；
   - 新增 ⑤ = ③ + alias on，hub 不带 alias cap。断言它与 ③ 相比只多两项声明例外：cap 尾部恰好一个 `xs.alias.v1`、`crossSession.alias`=`{168,10,10}`。其余 member/status/slot/entry/format/工具名逐字节相等，且没有 `xs_req`。
   - golden 文件未动。

## 新增文件

- `src/fabric/xs/alias-suggest.ts`：补全推荐，纯函数。
- `tests/fabric/xs-alias-suggest.test.ts`：2 例。
- `tests/integration/fabric-xs-alias-wiring.test.ts`：5 例，真实 activate × 真实 stack × 真实桥 × fake hub socket。
  1. alias on × hub cap：hello cap 与 hub 配置键；hello_ack 后恰好一个 get，且排在 `xs_member` 之后；held ⇒ `status.xs.alias`；`/fabric alias` 收到 `lost` ⇒ `ctx.ui.notify` 只提示 1 次，重复的 lost 回包被去重；lost 后 status 里的 alias 消失；补全推荐包含 `--clear` 和 cwd 末段 `前端项目`。
  2. alias on × hub cap：`message_session{to:"前端"}` 先 resolve，send 的 `to` = 完整 sessionId，模型可见结果不含完整 id；入站 `from.alias` 出现在头部 ` alias="后端"`；工具 description 带别名说明。
  3. `@前端`：目录为空时放行，并且这次 miss 触发 list 刷新（之前没有任何 list）；刷新出带 alias 的行后再输入，被拦截，resolve 后 send 到完整 sessionId。
  4. alias on × hub 无 cap：零 alias 帧；send 用原始 `to`；不合规的 `from.alias` 被剥掉；`/fabric status` 显示 `alias n/a (hub-cap off)`。
  5. alias off：工具 description/parameters 与 legacy 工厂输出相等；没有 cap 和配置键；hub 有 cap 也不发 alias 帧；入站 alias 被剥掉；status 不带 alias；`/fabric status` 显示 `alias n/a (alias.enabled=false)`。

## 留给 AL6 的事项

1. AGENTS.md `src/fabric/` 段补别名小节（设置、冻结策略、cap 门、残留）。
2. conformance C-X11（真实 pi：别名版工具 schema 跨请求稳定；`alias="…"` 只以独立字段出现；`details` 不进 provider）。
3. 真实 hub 子进程 × 3 个真实 stack 的 `tests/integration/fabric-xs-alias.test.ts`，覆盖方案 §9 集成行：抢占全链路、损坏后重启、web `useTrackedCommand`×`webCommandPolicy.fabric=confirm`。本包的 wiring 测试用的是 fake hub socket，不能替代它。
4. `/webhub status` 的 `alias store degraded (…) · <路径>` 行（AL2 偏离 2：需要 hub.json patch 加 agent 侧渲染；本包未做）。
5. 方案文本修订（AL2 偏离 1）：§3.6 改为「`crossSession.alias` 缺失 ⇒ 关闭」，§11 增加残留「由 `alias.enabled=false` 的会话 spawn 的 hub 运行期内，所有人都用不了别名，直到 /webhub restart」。
6. `alias-acceptance.md` 真机清单，建议加一条：alias on 的会话连上旧 hub（无 cap）时，工具 description 仍是别名版、寻址退回旧行为。这是冻结策略的已知代价。

## 测试输出

```
$ npx vitest run tests/fabric tests/commands tests/tools tests/mention tests/web-hub/agent tests/web-hub/hub \
    tests/integration/fabric-xs*.test.ts tests/integration/fabric-wake*.test.ts tests/web-hub/boundary.test.ts --maxWorkers=3
 Test Files  392 passed (392)
      Tests  7931 passed (7931)
   Duration  249.45s

$ npx vitest run tests/conformance/fabric-xs.test.ts      # package.json test:conformance = vitest run tests/conformance（默认 vitest.config.ts）
 ✓ tests/conformance/fabric-xs.test.ts (19 tests) 93565ms
 Test Files  1 passed (1)
      Tests  19 passed (19)

$ npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
（无错误输出）

$ npm run format:check
All matched files use Prettier code style!
```
