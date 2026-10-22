# AL0b 报告：会话别名契约包（alias-plan r4）

纯契约 + 设置解析，不含任何行为。三份 off golden 与 `tests/fixtures/legacy-xs-v071/` 未改动且通过。

## 新增契约清单

### `src/web-hub/protocol/xs.ts`（全部可选/追加）

- **常量**：`XS_ALIAS_HUB_CAP` / `XS_ALIAS_AGENT_CAP` = `"xs.alias.v1"`；`XS_REQ_DEADLINE_MS.alias = 5000`（`xsReqDeadlineMs("alias")`）；`XS_ALIAS_TAKE_PREVIEW = "preview"`。`XS_AGENT_CAPS` 不变。
- **类型**：`XsAliasReqOp`、`XsAnyReqOp` 增加 `"alias"`；`XsAliasStateWire`（`alias?`、`state:"held"|"none"`、`lost?{alias,reason:"taken"|"expired",at}`）、`XsAliasTakePreviewWire`（`take{cwdLabel,offlineForS,token,expiresAt}`）、`XsAliasResWire`；`XsAliasTakenDetail/TakeDetail/BusyDetail`。
- **xs_req**：op 字面量 `alias`；可选 `alias`（string 1–128，宽松，由 hub 规范化）、`clear`（仅 `true`）、`take`（string 1–64，`"preview"` 或 token，由 router 校验）。
- **xs_res**：可选 `alias`（开放对象，body 为 `XsAliasResWire`）；`target` 接口增加 `alias?`；`XsSessionRowWire.alias?`、`XsResolveCandidateWire.alias?`（rows/candidates/target 线上本来是开放对象，仅类型追加）。
- **xs_deliver.from.alias**：独立可选字段，`maxLength = XS_ALIAS_MAX_BYTES(48)`，不进截断的 from 元数据。
- **XsStatus.alias**：可选，1–48。
- **错误码**（`XsErrorCode`）：`E_XS_ALIAS_INVALID`、`_TAKEN`、`_TAKE`、`_FULL`、`_BUSY`、`_UNKNOWN`、`_UNAVAILABLE`（详情走花括号后缀）。
- **发送 exact-only**：按 §R3 M1，**线上没有新字段**（由已协商 cap 推导）；契约层不新增任何东西。
- 新增对 `./xs-alias.js` 的 import（仅取 `XS_ALIAS_MAX_BYTES`，在 protocol 内）。

### `src/fabric/xs/types-alias.ts`（新，仅类型）

`XsAliasRecord/Tombstone`、`XsAliasStoreState`（loading/ready/wedged/disabled/degraded）、`XsAliasDegradedReason`、`XsAliasStoreStatus`、`XsAliasHubParams`、`XsAliasWriteFailure`、`XsAliasRequester`、`XsAliasWriteResult/PreviewResult`、`XsAliasStorePort`（hub 绑定表端口）、`XsAliasCacheEntry`、`XsAliasBridgeResult`、`XsAliasBridgePort`、`XsAliasCachePort`。

### 设置 `fabric.crossSession.alias.*`（`src/config/settings.ts`，非实时）

| 键                                                                                                                                                                 | 默认 | 钳制                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | --------------------- |
| `enabled`                                                                                                                                                          | true | 非 boolean 回落默认   |
| `offlineLeaseH`                                                                                                                                                    | 168  | 1–720，取整           |
| `coolMin`                                                                                                                                                          | 10   | 1–1440，取整          |
| `takeMinOfflineMin`                                                                                                                                                | 10   | 10–1440（下限即 NQ1） |
| 非对象/错类型字段逐项回落；导出 `parseFabricXsAliasSettings`、`FabricXsAliasSettings`、`FABRIC_XS_ALIAS_*` 边界常量。未新增值导入，`SYSLOAD_FILE_CLOSURE` 无需改。 |

## 偏离

1. **`coolMin` 范围**：方案未给范围，取保守的 1–1440（不允许 0，以免关掉冷却）。
2. **越出文件域的一行**：`src/web-hub/hub/audit.ts:798` 的 `op` 联合类型加 `| "alias"`——`XsAnyReqOp` 加宽后 router 的 audit 调用不再通过 typecheck；纯类型改动。AL2 可按需接管。
3. **越出域的测试更新**：`tests/config/settings-fabric-xs.test.ts`（defaults 全量 toEqual 加 alias）、`tests/web-hub/protocol/xs-frames.test.ts`（deadline 表加 `alias: 5000`）。这两个是对「新增键」的锁定断言，只追加。
4. 严格解读下 `take` 与 `alias` 同时出现的组合合法性（预览/执行都带 alias）留给 router 校验，schema 保持宽松（与 `expect/replyTo` 同一风格）。

## 测试

- 新增 `tests/web-hub/protocol/xs-alias-frames.test.ts`（cap/deadline、op 字段 decode/拒绝、旧 schema 拒绝新字段 ⇒ 说明必须 cap 门控、旧帧形状不变、res/rows/target/错误码、from.alias 边界 48、status.alias）与 `tests/config/settings-fabric-xs-alias.test.ts`。
- 自验：
  - `npm run typecheck`：通过（tsc ×2 + vue-tsc）。
  - `npx prettier --check <全部改动文件>`：通过。
  - 宽范围 `npx vitest run tests/web-hub tests/config tests/fabric tests/integration/fabric-xs*.test.ts tests/conformance/fabric-xs.test.ts --maxWorkers=3`：713 文件，仅 1 个失败（settings-fabric-xs defaults 断言），已修复；
  - 修复后 `npx vitest run tests/config tests/web-hub/protocol tests/web-hub/boundary.test.ts`：82 files / 2153 passed / 3 skipped。
  - 指定命令 `tests/web-hub/protocol tests/config tests/web-hub/boundary.test.ts tests/fabric tests/integration/fabric-xs*.test.ts` 首轮（修复 audit 类型前）为 130 passed / 2 failed（deadline 表断言 + typecheck 先发现的 router），均已修；上述宽范围运行覆盖了它们，整体 15325 passed。
