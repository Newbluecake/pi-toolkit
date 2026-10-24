# web-hub 详情页 Agents / Bash 归档 — 实施报告

> 需求（用户已确认 `/tmp/archive-preview.html` 交互基准）：web-hub 详情页 fleet 抽屉的 Agents 列表与
> Bash 列表支持归档终态条目（悬停「归档」→ 底部 toast 4s 可撤销）；终态超过 N 分钟自动归档（设置项，
> 默认 30，0 = 关）；「已归档 N」可展开、可「取消归档」，自动归档带 `auto` 标记；Bash 标题
> `N running · N done · N archived`（英文 token）；归档状态记在 **pi 会话**里（/reload 与多浏览器一致）；
> web → agent 走现有控制面命令通道；终端侧 TUI fleet widget 同步隐藏；**只隐藏、不删除任何记录**。

## 1. 机制选型（及理由）

| 面               | 选型                                                                                                                                                                                                                    | 理由 / 先例                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态存储         | **session entry**：每次变更 `pi.appendEntry("subagent:archive", {entries, held})` 全量快照（todo-archive 先例 `src/todo/index.ts`；读回 `getBranch()` 取最后一个合法候选，`src/prompt-sections/store.ts` 先例）         | /reload、`/new`·`/resume`·`/fork`、跨浏览器/设备一致性都由「会话文件是唯一真相」免费获得；不落第二份盘上状态                                            |
| 状态归属         | `ArchiveControl`（`src/archive/control.ts`）由 `buildSessionStack` 创建（`webHub.enabled` 门控），`Stack.archive` 暴露，`previousArchive` 双路径 dispose（下一次 build 顶部 + index.ts 的 session_shutdown/防御性清理） | bash-jobs manager 的同款生命周期。**dispose 是硬要求**：旧 control 的自动清扫若活着，会把旧会话的归档快照 appendEntry 进新会话文件                      |
| 自动归档         | control 内 60s unref'd 清扫（`webHub.archiveAfterMin`，默认 30，0 = 不起 timer），按轮**批量提交**（一轮 N 行 ⇒ 1 个 entry、1 次 rev bump）                                                                             | 归档精度只需要分钟级；`archiveItem` 纯函数保证幂等（同方向重复 ⇒ 无变更不落盘）                                                                         |
| 取消归档的防复扫 | `held` 集合：任何 unarchive 都记录（kind,id）；`autoArchiveDue` 对 held 条目永不再自动归档，重新手动归档时清除 hold                                                                                                     | 否则 31 分钟的 run 在 12:31 被取消归档后，下一轮清扫立刻又归档回去——取消等于没做                                                                        |
| web → agent 操作 | 新 cmd op `archive`：`POST /api/cmd {op:"archive", kind:"run"\|"bash", target, set:"archive"\|"unarchive"}`，走 `/api/cmd` 现有授权（loopback token / LAN cookie+CSRF 同一管线，无新入口）                              | control-plan 的 cmd 通道是最贴近的既有机制（steer/abort_subagent 同款）；hub `parseCmdBody` 白名单需加一个 case（见 §4 生效方式）                       |
| wire 下发        | `StatusInfo.archived?: { rev, entries: {kind,id,at,auto?}[] }` — 开放可选槽（todo/worktrees/bashJobs/quota 同款），**无 PROTO bump、无 caps**；空归档 ⇒ 字段缺省（字节不变），旧 hub 的开放 schema 原样转发、旧 UI 忽略 | TypeBox 默认允许额外字段，`tests/web-hub/protocol/archive-schema.test.ts` 里有「旧 hub schema 转发新帧」的兼容证明；`rev` 单调，1Hz tick 指纹门只比 rev |
| agent → TUI      | `FleetWidgetDeps.archived?: () => FleetArchiveView`（晚绑定 getter，每 tick 重读）；`renderFrame` 里过滤 runs 与 bash 记录                                                                                              | widget 自带 1Hz tick，无需额外刷新接线；getter 缺省（web-hub off / 子会话）⇒ 逐字节旧渲染                                                               |
| UI 端分区        | **agent 不过滤行**——wire 带全部行 + 归档集合，浏览器分区（`archiveView.ts` 纯函数）；归档折叠区要显示行的标题/成本/时间，数据必须在线上                                                                                 | 「已归档」区保留完整行数据 ⇒ 取消归档原地放回树；旧的 fleet 8-terminal 截断之外的老 run 本就不在 wire 上，属既有行为                                    |

### 冻结面核对

- 三份 fabric off golden、secure goldens：未触碰（本改动不进任何 fabric/secure 路径；`npm run format:check` + 全量 `tests/web-hub tests/ui tests/bash tests/archive` 通过）。
- 无归档数据 ⇒ `StatusInfo` 无 `archived` 字段、UI 无归档按钮/折叠区（按钮需要 FLEET_ARCHIVE provide + terminal 行）、TUI widget getter 缺省不过滤 —— 全部字节不变（`fleet-widget-archive.test.ts` 第 3 例钉住）。
- `tests/web-hub/contract/types.test-d.ts` 的 CmdOp 联合断言按 recall 先例补了 `"archive"`（该文件的设计就是随 op 增补而更新）。

## 2. 改动文件

**新增**

- `src/archive/state.ts` — 纯状态模型（sanitize/read-back/幂等变更/FIFO 帽/held 豁免/auto 判定）
- `src/archive/control.ts` — `ArchiveControl`（restore / persist / 手动 setArchived 终态门 / 60s 批量清扫 / dispose）
- `src/web-hub/ui/src/components/fleet/archiveView.ts` — UI 纯函数（`archivedOf` 收窄、`archiveSetOf`、`partitionArchived`）
- `src/web-hub/ui/src/components/fleet/FleetArchived.vue` — 已归档 runs 折叠区（`auto` 徽标 + 取消归档）
- 测试：`tests/archive/state.test.ts`、`tests/archive/control.test.ts`、`tests/web-hub/protocol/archive-schema.test.ts`、`tests/web-hub/agent/commands-archive.test.ts`、`tests/ui/fleet-widget-archive.test.ts`、`tests/web-hub/ui/fleet-archive.test.ts`（+ `fleet-bash-jobs.test.ts`、`tests/web-hub/http/api-cmd.test.ts`、`tests/config/web-hub-settings.test.ts` 扩展）
- 本报告

**协议 / hub / agent**

- `src/web-hub/protocol/messages.ts` — `CmdOp`+`archive`、`CmdArgs`/`CmdData` 变体、`ArchiveArgsSchema`（导出）、`ArchiveEntryWire`/`ArchiveWire`、`StatusInfo.archived` + schema、`CtlItemSchema.op` 联合
- `src/web-hub/hub/http.ts` — `parseCmdBody` 的 `archive` case（target/kind/set 校验）
- `src/web-hub/agent/commands.ts` — `handleArchive`（终态门、`E_UNSUPPORTED`/`E_BAD_REQUEST`/`E_NOT_FOUND` 映射；republish 骑 settleAndReply 的 onChanged）
- `src/web-hub/agent/index.ts` — `WebHubSettings.archiveAfterMin`、`WebHubDeps.archive`、`archiveProjection`（publishStatus + snapshot 两处）、1Hz `lastArchiveRev` 指纹门（session_start 重置）、command handler deps
- `src/web-hub/agent/status.ts` — `readStatus` 尾参 `archived?`（缺省 ⇒ 字段缺省）

**stack / 主会话 / TUI**

- `src/stack.ts` — 创建/播种/启动 `ArchiveControl`（webHub.enabled 门控），`Stack.archive`，`previousArchive` 双路径 dispose，widget deps 注入
- `src/index.ts` — wireWebHub deps `archive: () => holder.current?.archive`；session_shutdown 与防御性清理里 dispose；`session_tree`/`session_compact` 上的 `restoreArchive`（xsEnabled 块之外注册）
- `src/ui/fleet-widget.ts` — `FleetWidgetDeps.archived?` + `renderFrame` 过滤 runs/bash（display-only）

**设置**

- `src/config/settings.ts` — 默认 `webHub.archiveAfterMin: 30` + 解析（有限数 ≥0，否则回退 30）
- `src/config/setting-specs.ts` — `"webHub.archiveAfterMin"` number 条目

**web UI**

- `transport/types.ts`（CmdRequest op + kind/set/target）、`types.ts`（`ControlHandle.setArchived`）、`composables/useControl.ts`（直发 transport，无乐观 ctl 项 —— queryCommand 先例）
- `components/fleet/summary.ts`（`FLEET_ARCHIVE` provide/inject 契约）、`FleetTree.vue`（terminal 行悬停「归档」按钮）、`FleetBashJobs.vue`（分区 + `· N archived` 段 + 折叠区 + 行按钮）、`drawer/FleetDrawer.vue`（分区、provide、4s 撤销 toast）、`contracts.ts`（`FleetBashJobsProps.archived`）
- i18n `en/zh` 的 `fleet.ts`（archive/unarchive/archivedFold/archivedToast/undo）与 `detail.ts`（`bashJobsArchived: "{n} archived"` — 两语言档同一英文 token，遵守 AGENTS.md UI 文案规则；`auto` 徽标是紧凑英文 token 直出）
- `styles/fleet.css`、`styles/bash-jobs.css`、`styles/drawer.css`（`.arch-act` 悬停显现、折叠区、`.arch-toast`）

## 3. 行为细节

- **可归档对象**：仅终态（run terminal / bash 终态 job）。agent 侧 `setArchived` 再查一次终态（web 端行已按 terminal 渲染按钮，属双保险）；运行中的 run/job ⇒ `E_BAD_REQUEST "not terminal"`。
- **幂等**：同方向重复归档 `changed:false`（不落盘、不 bump rev）；unarchive 未归档条目同样 ok/changed:false。同一 cmdId 重放走 ledger 去重（`dup:true`）。
- **已从内存消退的 id**（fleet 截断 / bash 回收后）手动归档仍接受（幂等归档，无害）；归档条目本身 FIFO 256、held FIFO 256。
- **自动归档**只发生在 agent 主会话（子会话不建 stack 归档路径之外的东西；web-hub off ⇒ 一切不接线）。清扫按 `settledAt ?? updatedAt`（run）/ `endedAt ?? createdAt`（bash）判龄。
- **恢复点**：stack build（session_start）+ `session_tree`（树导航不重建 stack）+ `session_compact`（todo 同款三连恢复点）。
- **只隐藏**：`get_subagent_result`、`/agent status`、通知、run/bash 记录与日志本身一概不看归档集合；bash 行为只影响 fleet widget 与 web 抽屉两处显示。

## 4. 生效方式

1. `npm run build:web`（已构建，`check:web` 通过）后**刷新浏览器**拿到新 UI；
2. **`/reload`** 让 agent 侧（新 cmd op 处理、`StatusInfo.archived` 投影、自动清扫设置、TUI 过滤）生效；
3. **`/webhub restart`** 一次：运行中的旧 hub `parseCmdBody` 白名单里没有 `archive` op（浏览器会收到 400 "unknown op"），且新 UI 产物也由 hub 服务——重启后两者齐备。此后仅改 `webHub.archiveAfterMin` 数值的话**只需 `/reload`**（该设置 agent 侧专用，`buildHubConfig` 不读，不进 hub 配置）。

## 5. 自验（全部通过）

- `npx vitest run tests/web-hub tests/ui tests/bash tests/archive --maxWorkers=3` → **683 files / 15127 passed, 3 skipped**
- `npm run typecheck`（tsc ×2 + vue-tsc）→ 通过
- `npm run build:web && npm run check:web` → 通过（首屏 JS 349587B gz / 预算 512KiB 内）
- `npm run format:check` → 通过

## 6. 已知边界 / 遗留

- 旧 hub 窗口内（未 restart）点「归档」会得到 400 `unknown op` —— UI 端该次操作无效果、无状态残留（cmd 无副作用才 settle），重启 hub 后即好。
- 「已归档」区只显示仍在 fleet wire 里的行（≤64 active / 8 recent-terminal 截断是 fleet 帧既有行为）；更早的终态 run 本就不在抽屉里，归档它们的入口也不存在——一致。
- 归档条目跨 compaction 依赖会话条目存活（pi 会话文件 append-only；`session_compact` 后仍从 branch 读回最后一个快照——todo 同款语义）。
- LAN 与 loopback 走同一 `/api/cmd` 授权管线；归档不涉及 `webCommandPolicy`（它不是斜杠命令）。
