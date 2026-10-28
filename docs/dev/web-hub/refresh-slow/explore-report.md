# 大会话刷新慢（7.4 s）根因定位 — Explore 报告（r_WQKG58, 2026-10-28）

**会话**：`s-01a16242-c16b-7295-9019-9ccff83f5e0f` → agentKey `a1556874-vDjp6f`
**文件**：`~/.pi/agent/sessions/--home-bluecake-ai-pi-toolkit--/2026-10-22T06-18-24-491Z_01a16242-….jsonl`
**大小**：200,247,337 B（190.9 MiB，30,613 行 / 30,612 条可索引条目）——低于 256 MiB `TOO_LARGE` 上限，走「整文件读」分支
**环境**：hub pid 3434347（14:08 重启，含 `89c817a1` tail 修复），测量 15:09–15:25
**方法**：playwright 真实浏览器 + curl + 同构分阶段计时 + /proc RSS 采样

## 结论

唯一瓶颈是 `history.snapshot()` 仍走 `readBranchCached`（整文件 readFile + 全行 JSON.parse + 整条分支 30,566 条逐条投影），一次约 7.0 s，同步 CPU 堵死 hub 主线程。前端、WS 回放、runTail tail 路径、worktree/preview 端点都不是瓶颈。

## 活体测量

大会话 vs 对照（warren 154KB）：进详情页→首条 .tx-item **7,394ms vs 251ms**；subscribe→history 帧 6,957/7,038/7,133ms vs 14ms；history 帧 1.23MB/400 条。FCP 148ms——用户盯骨架屏 7.4s。UI 窗口化生效（TRANSCRIPT_CAP=300），渲染无责。

快照进行中 `GET /api/version` 需 5,746ms（所有请求排队）；空闲 p50 0.4ms。两次连续 `/api/history?limit=100`：6.67s/6.46s（FileCache 对 append-only 文件必 miss）。hub RSS 559MB→1.61GB（VmHWM 2,660MB）。

分段归因：`readFile` 652ms（179.4M chars）→ split 232ms → 30,612 次 JSON.parse 1,236ms → `walkBranch` 投影 30,566 条 4,100ms → 合计 6.22s（线上 6.96–7.13s）。

投影热点：`custom:subagent:archive` 5,524 条 / 87.2MB / 2,951ms（72.4%），其中 `canonicalJson` 递归键排序 2,634ms——这些是 wire 上 display:false 的墓碑，产物只有一个 8 位 hex dataKey。

只投影最新 400 条：覆盖尾部 4.61MB，实测 **32.1ms** ⇒ 尾读 snapshot 理论 **50–90ms（≈100×）**。

## file:line

- 慢路径：`history.ts:625 loadBranch()` → `:632 readBranch` → `:467 readBranchCached` → `:118 readFile` 整 200MB → `:243-266 parseIndex` → `:268-291 walkBranch`（:284 逐条 projectSessionEntry）→ `:664 slice(-400)`（投完全部只留 400）
- `page()` 同路径（:715/:722），"Show earlier" 每次 6.4s
- 投影成本：`protocol/keys.ts:140 projectSessionEntry` → `:253 customKey` → `:27-29 fnv1a32(canonicalJson)` → `:336-351 canonicalJson`（主热点）
- 缓存失效：`history.ts:355-372 FileCache` 键 (real,size,mtimeMs)，append 必 miss
- `TIMING.snapshotMs`=5000 形同虚设（同步投影期间定时器跑不到）
- 可复用范式：`history.ts:145-241 readBranchTail`（512KiB×4 ≤32MiB 尾读、投影到够数就停）；`hub/run-file-reader.ts:1-45`（反向扫描 + 子串预滤 + 单飞 + setImmediate 让出 + 游标 LRU + ≤2 并发）
- README:360-361 自述取舍：「snapshot()/page() still use the full reader」← 事故成因的书面依据

## 256 MiB 悬崖（约 1.8–2 天后撞线，日增 27–31MB）

- `readBranchTail` 也受 `DEFAULT_MAX_FILE_BYTES` 约束 → 超限返回 `TOO_LARGE`（非 undefined，不回落）→ `runTail` 静默 return，**实时 append 无声停摆**
- 超限后 `loadBranch` 回落 `branch_req`，agent 侧 `snapshot.ts:45-66 buildBranchReply` 全量投影再裁尾 → 4s 阻塞搬到 agent 主线程（TUI/模型流）

## 文件为何 193MB（治本线索）

- `archive/control.ts:224 appendEntry("subagent:archive", …)` 每次变更写整份状态（state.ts ARCHIVE_ENTRIES_CAP=256）；实测每分钟一条、16.5KB/条、5524 条=87.2MB=43%，内容几乎全同
- `custom:claude-code-todo-state` 410 条 / 9.4MB（4.3%）

## 修复建议（用户拍板：P0+P1，P2 另开 #89）

| #   | 改动                                                                                                      | 收益              | 落点                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| P0  | `snapshot()` 改用 `readBranchTail(file, leafId, max(tailEntries, 2×                                       | recent            | ))`，undefined/TOO_LARGE 才回落 loadBranch；readBranchTail 返回值补 `chainContinues` 保 hasMore | 7000→50–90ms；消 1.6GB RSS 尖峰 | history.ts:625-640、:683-710、:145-241 |
| P0  | `page()` 同款：从 leaf 反向走到 before，配游标缓存+字节预算+让出                                          | 翻页 6.4s→数十 ms | history.ts:715-750；机制照抄 run-file-reader.ts:1-45                                            |
| P1  | ①tail 路径不吃 maxFileBytes；②buildBranchReply 改从末尾往前投影达预算即停；③runTail 遇 TOO_LARGE 不再静默 | 拆悬崖            | history.ts:~150、agent/snapshot.ts:45-66、history.ts:~630                                       |

验收口径：首条 .tx-item <300ms；subscribe→history 帧 <150ms；快照期间 /api/version <50ms；RSS 无 GB 尖峰。
需同步：docs/dev/web-hub/README.md:343-363「History tail reads」节；tests/web-hub/hub/history.test.ts:190/:501/:731/:788（hasMore/oldestEntryId/source 断言随尾读语义更新）。wire 不变（HistoryPayload 字段不变），无 golden 影响。
