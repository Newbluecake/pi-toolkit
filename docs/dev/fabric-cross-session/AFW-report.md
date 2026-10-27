# AFW 交付报告：别名自动认领与强制抢占的会话装配（#72）

基线：`feat/alias-72` = dev + AF0 + AF1 + AF2 + AF3 + AF4 + AFU。本包只做装配，不新增 wire、PROTO、设置键或注册项。

## 第一波跟进项（A 部分，各一个提交）

| 项           | 处理                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AF3 M1       | BUSY 重试测试改为注入 `random=0.4321`，延迟固定为 2728ms，不与 `END_DESTROY_MS=1000` 等任何计时器重合；断言「该延迟的计时器恰好一个且 `hasRef()===false`」。**已验证**：删掉 `xs.ts` 里的 `autoRetryTimer.unref()` 后该例变红。      |
| AF4 minor 1  | `runAlias` 两处 `markDecided` 改走 `markDecidedSafe`（try/catch）。补测试：set / clear / TUI take / TUI force / web `--take=<token>` 五条路径在 `markDecided` 抛错时请求照常发出，并断言四个标记点都真的被调用。回退源码后三例变红。 |
| AF3 N1 / AF4 | `/fabric join` 成功后调用 `refreshAlias(deps)`（`onPolicyChange` 的 member 帧已排在 get 之前）。补 4 例：join 触发恰好一次 reconcile；已加入/被拒不触发；alias 关或缓存降级不触发；reconcile 抛错不影响 join。回退源码后变红。       |
| AFU minor 1  | `alias-ui.test.ts` 增加负例：v2 caps 下，「没有可抢占的持有者」与 stale 预览的 `--take` 回显都不出现 `.alias-force-row`，也不出现确认框。                                                                                            |
| AFU minor 2  | `ChannelsDialog.vue` 的 `forceOffer` 上加注释，说明两层 v2 门控：`takeRejected` 只在 v2 成立时才设置，但 caps 是实时值，渲染层再判一次，防止 offer 展示期间 hub 失去 v2 而发出会被拒绝的 `--force`。                                 |

## 装配（B 部分）

### 改动文件

| 文件                                               | 内容                                                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/fabric/xs/stack.ts`                           | `StackXsInput.aliasDecided?: boolean`；`StackXs.aliasDecided?: XsAliasDecidedPort`；`buildAliasDecided`：读 `getEntries()`（非 getBranch）、按 sid 校验、`persist` 适配 `pi.appendEntry`。 |
| `src/fabric/xs/activate.ts`                        | `stackInput()` 在 alias 开启时置 `aliasDecided:true`；`/fabric` 的 alias 端口加 v2 字段；`webHubDeps()` 的 alias 块加 `aliasAuto` 与 `notifyAliasAuto`。                                   |
| `src/web-hub/agent/index.ts`                       | 仅类型与透传：`WebHubControl.xs.aliasBridge` 的返回类型带可选 `forcePreview`；新增可选 `aliasAutoSkip()`，透传 `xsBridge.aliasAutoSkip()`。                                                |
| `tests/integration/fabric-xs-alias-wiring.test.ts` | `boot` 增加 `hubV2 / autoFromCwd / child / seed` 选项并捕获 `appendEntry`；新增 10 例端到端用例。                                                                                          |

`src/stack.ts`、`src/index.ts` **未改**。没有新增 `pi.on`/`registerTool`/`registerCommand`，`tests/fixtures/governance/activate-trace.json` **没有变化**。

### 接线要点

- **decided 端口**：每个 stack 一个实例，仅在 `aliasOn` 时构建；alias 关 ⇒ 不读 session 文件、不写标记，stack 与改动前一致。读 `getEntries()` 抛错时 fail closed（`decided()` 恒 true，写仍可用）。`persist` 在 stack 已 dispose 或 sid 已变时丢弃（内存标志仍置位）。
- **命令端口**（`/fabric`）：`hubAliasV2`（当前连接 live ∧ caps ∋ `xs.alias.v2`，与 `hubChannelCap` 同法读 `currentConnection()`）、`autoFromCwd`（activate 冻结）、`decided`/`markDecided`（同一个 stack 实例）、`autoSkipReason`（桥缓存）。`bridge.forcePreview` 与 `cache.current().origin` 来自桥本身。
- **agent 端口**：`aliasAuto()` 提供 `enabled:true`、ctx 的 `cwd`（stale ctx 读不到时为 undefined）、`os.homedir()`、`os.tmpdir()`、`decided(sid)`、`handoffPending()`（AF7 之前恒 false）；`notifyAliasAuto` 走 `ctx.ui.notify`，与 `notifyAliasLost` 同法。
  - `decided(sid)` fail closed：栈未附着、sid 不是当前栈、或没有 decided 端口，一律视为已决定 ⇒ 不 auto。
  - **仅当 `autoFromCwd=true` 时才装配** `aliasAuto`/`notifyAliasAuto`：关闭时引擎完全惰性，agent 字节与 AF3 之前一致，`/fabric status` 也不出现 `auto skip` 后缀。
- **子会话 / secure**：xs 装配整体在 post-guard 内，子会话没有 xs、没有 hub 连接；secure 的 D8 强制 `crossSession.enabled=false` ⇒ `xsEnabled` 为 false ⇒ `webHubDeps()` 返回 `{}`。本包没有新增任何绕过路径。

### 端到端用例（真 `activate()` × 真 stack × fake hub socket）

| 用例                 | 断言                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v2 hub attach        | get(none) 后恰好一条 `intent:"auto"`，候选为 cwd 末段，帧序在 `xs_member` 之后；一次性通知；`status.xs.alias`；`/fabric status` 显示 `held (auto)`，且不再发 auto |
| `taken` 拒绝         | 不重试；`/fabric status` 显示 `auto skip:taken`                                                                                                                   |
| leave → join         | join 后 reconcile 重新获得一次 auto 尝试（N1 端到端）                                                                                                             |
| 人工 set / clear     | 标记（`via` 正确、sid 为当前）先于请求帧写出；请求不带 intent；之后 leave+join 零 auto；status 显示 `auto skip:decided`                                           |
| session 文件已有标记 | 本 sid 的标记 ⇒ 零 auto；异 sid 的标记被忽略 ⇒ 仍 auto                                                                                                            |
| `autoFromCwd=false`  | 零 intent 帧（含 leave/join/人工写之后）、无 `auto skip` 后缀                                                                                                     |
| v1 hub               | 零 intent 帧、无 force 预览帧、无 auto 后缀；`--force` 本地拒绝                                                                                                   |
| v2 hub `--force`     | 发出 `{take:"preview", intent:"force"}`；TUI 取消 ⇒ 不执行、不写标记                                                                                              |
| alias 关             | 零 alias 帧、不写标记                                                                                                                                             |
| 子会话               | 零 socket、无 `/fabric`、无 xs 工具                                                                                                                               |

变异验证：关掉 `aliasAuto` 装配 ⇒ 6 例红；关掉 `markDecided` ⇒ 2 例红；不读 `getEntries` ⇒ 1 例红；删除 join 后的 `refreshAlias` ⇒ 1 例红。

## 偏差与说明

1. **改了 `src/web-hub/agent/index.ts`**（方案 AFW 行未列）：只有类型放宽和一行 `aliasAutoSkip` 透传。`autoSkipReason` 的来源在桥里，`WebHubControl.xs` 不暴露就没有别的合规读法。
2. **`hubAliasV2` 读 `currentConnection()`**，没有给桥新增 getter（与既有 `hubChannelCap` 一致，避免再碰 agent 侧）。
3. **`autoFromCwd=false` 时不装配 `aliasAuto`**，而不是装配 `enabled:false`：方案只要求结果一致，这样「关 ⇒ 字节一致」更容易证明。
4. 「alias 关时不读 session 文件」只能由 `aliasOn` 门控保证，没有单独的读取计数断言（其它模块也会调用 `getEntries`，计数无判别力）；集成用例只断言 alias 关时零 alias 帧、零标记。
5. `tests/integration/fabric-xs-alias-wiring.test.ts` 的 `clearXsGlobals` 增加 `pi-subagent:xs-alias-auto-noticed`，否则一次性通知会在用例间泄漏。
6. 未做 AF7（`/new` 交接）：`handoffPending` 恒 false，`stashMembershipHandoff` 未动。

## 自验

见最终提交信息中的命令；结果如下（均在 `/tmp/alias-afw`，未执行 install）。

| 命令                                                                                                                                      | 结果                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `npm run typecheck`                                                                                                                       | 通过                                   |
| `npx vitest run tests/fabric tests/web-hub/agent tests/web-hub/hub tests/web-hub/protocol tests/commands tests/governance --maxWorkers=3` | 425 文件 / 10095 通过 / 3 skip         |
| `npx vitest run tests/web-hub/ui --maxWorkers=3`                                                                                          | 268 文件 / 5914 通过 / 1 skip（既有）  |
| `npx vitest run tests/integration --maxWorkers=3`                                                                                         | 132 文件 / 991 通过 / 6 skip（既有）   |
| `npm run test:conformance`                                                                                                                | 35 文件 / 361 通过 / 16 skip（自门控） |
| `npm run format:check`                                                                                                                    | 通过（报告格式化后）                   |
| `git diff --quiet 9ce5abc7 -- tests/fixtures/`                                                                                            | 干净                                   |

activate-trace golden：未变化（`tests/governance` 全绿，文件未改）。

## 遗留

- 真机验收（AF6）和集成 ①–⑧、README 两节更新仍待做。
- AF7 `/new` 交接未开始。
