# Fleet 自动归档停摆 · 取证报告（#91）

取证：Explore (zai/glm-5.3) r_BXXB2Q9K，2026-10-29。取证对象：`/home/bluecake/ai/pi-toolkit`（只读）＋ 活数据 `~/.pi/agent/sessions/--home-bluecake-ai-pi-toolkit--/`。嫌疑会话：`2026-10-22T06-18-24-491Z_01a16242-…jsonl`（210 MB，7 天长命会话）。

## Q1. sweep 的 candidates 从哪来、行数帽在哪

- `ArchiveControl.sweep()`（`control.ts:278-301`，60s `setInterval`，`start()` 于 `stack.ts:1402-1405`；默认 `archiveAfterMin=30min / keepRuns=6 / keepBash=5`）。
- candidates 构造（`control.ts:282-294`）：`candidates.runs()` + `candidates.bashJobs()` → `{kind,id,terminal,settledAt}` 喂给纯函数 `selectAutoArchives`（`sweep.ts:61-96`）。
- 注入点 `src/stack.ts:1393-1397`：`runs: () => query.list(), bashJobs: () => bashJobs?.list() ?? []`。
- run 侧：`query.list()` → `createLiveRunRegistry(spawn, store)`（`stack.ts:1356-1357`），`list()` 合并两路（`src/service/run-registry.ts:41-46`）：spawn 服务进程内 records Map（**无淘汰**）＋ `MemoryRunStore.list()`（**无淘汰**）。store 每次 stack 重建被 `seedRunStoreFromEntries` 从会话文件 `subagent:run` 条目**整批种回**（`stack.ts:663-666`，`src/adapters/pi-run-log.ts:91` 起；唯一过滤是 `diag.sessionFile` 仍在盘上）。
- bash 侧：`BashJobManager.list()` = 进程内 entries Map，终态记录内存里**永不清除**；retention（默认 24h）**只清磁盘**（`web-hub/agent/bash-jobs.ts:10-11` 注释原话确认）。

行数帽全是显示层，不作用于 sweep 候选：

| 列表            | 帽                  | 定义处                                                                       |
| --------------- | ------------------- | ---------------------------------------------------------------------------- |
| web 舰队 run 行 | 64 活跃 + 8 近终态  | `WEB_MAX_ACTIVE_ROWS`/`WEB_RECENT_TERMINAL`，`web-hub/agent/status.ts:35-36` |
| TUI 舰队 widget | 默认 20、硬帽 40 行 | `fleetWidgetMaxRows`，`config/settings.ts:270`                               |
| web bash 行     | 共 20 行、终态 ≤12  | `web-hub/agent/bash-jobs.ts:33-35`（wire 投影另叠 24h retention 过滤）       |

sweep.ts:78-80 的注释自己也承认候选会超出这些帽。

## Q2. 条目何时从 candidates 消失；理论最大长度；帽子为何兜不住

- run：基本永远不消失（无淘汰 + append-only 日志全量重种）。
- bash：进程内终态不消失；跨重启且磁盘记录过 24h retention 才掉。
- 理论最大长度：**无界**。实测该会话 run-log 有 **741 个不同 runId**（1,798 条终态快照）。
- 占满机制：不是「把已驱逐的算进候选」——是**根本没有驱逐**。`goneEntries`（`sweep.ts:31-34`）长期 ≈0 → `archiveRoom = 0 + 0`（`sweep.ts:37-39`）→ `selectAutoArchives` 末段截到 room=0 返回空（`:88-95`）→ `sweep()` 直接 return（`control.ts:295-296`），静默停摆。

## Q3. 活数据核对（最后一条有效快照）

| 指标                        | 值                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `subagent:archive` 快照总数 | **5,526** 条                                                                                             |
| 最后快照 entries            | **256（恰好 = cap）**                                                                                    |
| kind 分布                   | run **250** + bash **6**                                                                                 |
| auto 占比                   | **100%**                                                                                                 |
| held                        | **0**（历次快照最大值也是 0）                                                                            |
| `at` 跨度                   | 2026-10-28T01:32:54Z → 2026-10-29T04:51:58Z（27.3h 滑窗）                                                |
| 全部快照的 entries 长度     | **最小值也是 256**（自 2026-10-24T05:47Z 起钉死在帽上）                                                  |
| 与活跃集合重叠              | 250/250 run id 全部仍在 run-log（741 个）里 → **gone=0**；6 个 bash 磁盘记录未过 24h → 内存仍在 → live   |
| 写入节奏                    | 滑窗推进期每分钟一写；之后 18.7h 零写入；最后一写 2026-10-29T04:51:58Z（一次归档 9 项 = 3 run + 6 bash） |

04:51 那笔写入佐证机制：某次重启/清理让 9 个旧条目变 gone（room=9），sweep 立刻用 9 个**仍 live** 的新条目填满，room 归零后再度停摆。

## Q4. held 的影响

全部快照 held 最大值 = 0。held（帽 256）只豁免 auto 归档、不占 entries 槽，对本次停摆**无贡献**。

## Q5. 结论：「256 槽被 live 占满」推断 **成立**

cap-stable（flip-flop 修复）把选择数量钳到 `archiveRoom = 空闲槽 + goneEntries`，其前提是「归档久的条目会从候选列表自然消失」。该前提对 run 侧**不成立**：候选是 `query.list()` 的无界并集（进程内 records + MemoryRunStore + 重种），bash 侧内存列表同样不清终态。稳态下 gone→0、room→0，`selectAutoArchives` 恒返回空——**结构性活锁**。修复前 `capTail` 驱逐最旧条目（哪怕 live），归档持续推进（代价是 flip-flop）；修复后推进完全依赖 gone 出现，而 gone 只在「子会话文件被删」或「bash 磁盘过 24h」这类偶发事件时产生。

**关键坐标**：`sweep.ts:31-39`（goneEntries/archiveRoom）、`:88-95`（room 截断）；`control.ts:278-301`；`stack.ts:1393-1405`（注入与启动）、`:663-666`（重种）；`service/run-registry.ts:41-46`；`core/store.ts:40-44`；`adapters/pi-run-log.ts:91`；`bash/manager.ts:918/2173`；显示帽 `web-hub/agent/status.ts:35-36`、`web-hub/agent/bash-jobs.ts:33-35`、`config/settings.ts:270`。

**修复方向提示**（供设计参考）：room 的「gone」口径需与真实驱逐语义对齐——例如把 run 候选限定到 wire 可见集合（64+8）或按 settledAt 年龄视老条目为可驱逐，否则任何「只驱逐 gone」的策略在该数据源下必然收敛到 room=0。
