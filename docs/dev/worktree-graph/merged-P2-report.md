# merged-plan P2（hub 路由）报告

基线：dev HEAD 含 P0 协议、P1 git 层提交（`51534296`）。直接在主仓库工作区开发；零 git 写操作；未碰 P3/P4 的 UI 文件；`WTDIFF_DRIVER_NAME_RE` 与 Cc 正则未改动；fixtures 零 diff。

## 实现

- **新 `hub/worktree-graph/merged.ts`**
  - 纯函数：`ancestorsInWindow`、`mergedCandidates`（HEAD 分支 / HEAD oid / 窗内祖先排除；`co` 标记；按窗内行号排序；取 24，其余只计 `omitted`）、`buildMergedBranches`（eq/part/none/anc/unk；`e` 只挂同 tip 首条；全局 ≤200，裁过的带 `eP`；同 tip 后续条目继承 `eP`）、`finalizeMergedPayload`（整响应 ≤512 KiB：先去全部 `e`，仍超则 `skipped:"bytes"`）。
  - `runMergedPhase`：头段（Cc + info/attributes ⇒ driver 并集、`sig0`）→ 循环（每个去重 tip 走 `SingleFlightCache`，`ps.withLoan` 内跑 Gm，逐条复核通过才返回）→ 尾段（整体复核，缓存命中也过；失败 ⇒ 整体 `skipped` + 逐 key `drop` + `wtgraph.merged_discarded` 告警）。
  - 调 `wtGraphArgs.cherry` 前先校验 Cc ∪ info/attributes 并集全部合 `WTDIFF_DRIVER_NAME_RE`（P1 报告第 1 条）；先判 `capped` ⇒ `too-many`，再看退出码（第 2 条）；`parseCherryMark` 的 bad ⇒ `git-failed`（第 3 条）。
- **`routes.ts`**：新增可选依赖 `mergedEnabled`。只有 `mergedEnabled && merged=1` 时才缩小 `projectGraph` 的 `maxBodyBytes`（−32 KiB）、新建 M 预算并跑 M 阶段；其余请求沿用基线路径（git 调用序列与响应字节不变，测试钉住）。M 阶段内的非中止异常降级为 `skipped:"unconfirmed"` 并 `log.error`，不影响图本身。每个 routes 实例一个 `SingleFlightCache`（TTL 10 min / LRU 1024 / 1 MiB / 单项 16 KiB），dispose 时 `abortAll` + `clear`。
- **`changeset.ts`**：`SingleFlightCache` 加法新增可选 `itemMaxBytes`（缺省 = `totalBytes`，wtdiff 的两处实例不传，行为不变）。另加 `drop(key)` / `clear()` 两个加法方法（尾段丢弃与 dispose 需要）。
- **`git.ts`**：`WtGitCmd` 加 `"Gm"`。**`audit.ts`**：键尾追加 `mergedReq/Cand/Omitted/Run/Hit/Unk/Skip/Ms`（只有计数）。**`hub.ts`**：cap 数组在 `WTGRAPH_HUB_CAP` 后紧接 `WTGRAPH_MERGED_HUB_CAP`（同一条件：preview + /proc），构造路由时传 `mergedEnabled: true`。
- `project.ts` 未改（只使用已有 `maxBodyBytes` 参数）。

## 方案未规定、我自行取的默认做法

1. **尾段在没有任何 tip 得出判定时跳过**（没有可丢弃的东西）；此时只有头段读取。
2. 无候选时输出 `{v:1, base, branches:[]}`，不 spawn Cc / Gm。
3. `skipped` 的映射：Cc 超时 / 非 0·1 退出 / spawn 失败 / pin 异常 ⇒ `unconfirmed`；Cc 或 Gm 退出 129 ⇒ `git-too-old`；Cc 不安全名 / info/attributes >64 KiB 或读 io 失败 / 并集 >16 ⇒ `filter-config`。`empty` 或无 head ⇒ `no-head`（优先于 `shallow`）。
4. 逐条复核无法读取：io 错误 ⇒ `attr-changed`；deadline/busy ⇒ 预算耗尽为 `budget`，否则 `timeout`。Gm 的 deadline 同理（`exec.deadline.remaining() ≤ 0 ⇒ budget`）。
5. 等待者自身 deadline 先到 ⇒ `unk:"timeout"`；pinned 的 `abort` 结果在共享执行里记 `timeout`（请求自身被中止时由路由按 `signal.aborted` 应答）。
6. 尾段丢弃时对本请求触及的全部 key 调 `drop`，保证「丢弃 ⇒ 不缓存」字面成立。

## 测试（逐条对 §8.1 P2 行）

- `merged.test.ts`（18，新）：候选规则（含 24/25/400）、verdict / `e` 预算 / `eP`、字节策略（评审构造的最坏例：24 分支同一 part tip、150 窗内 oid ⇒ `e` 仅一次、<32 KiB；先去 `e`；再 `skipped:"bytes"`）、全部输出过严格解析器。
- `routes.test.ts`（+34）：无 `merged=1` 与 `merged=0/true`、未启用路由 ⇒ 调用序列与响应字节同基线；`skipped` 全部七种 wire 形状（`bytes` 在纯函数测试，因 32 KiB 预留下路由层无法构造）；候选 24/25/390（`omitted` 366）/同 tip 24 分支；同 tip 只跑一次 Gm；`unk` 六种分类（一个请求内）；逐条复核（info 变化 / shallow 出现 / 读 io 错）与尾段复核（attr-changed / shallow / unconfirmed，缓存命中也丢弃、key 被 drop、告警事件）；缓存（二次零 Gm、未知不缓存、TTL、key 随 sig0、`itemMaxBytes` 超大项不入）；审计只含计数；单飞（晚加入者共享、领头断开而等待者仍在 ⇒ 继续、全员断开 ⇒ abort、dispose ⇒ abortAll、等待者自身 deadline 先到 ⇒ release + `unk:timeout` 且领头者照常入缓存）；每种结局 `leakCount()===0`。
- `budget.test.ts`（+5）：账本算术（37 / 47≤48 / 旧 23·33≤35 / 头 6 + 尾 4 留最小循环 4 s）、头段耗尽 ⇒ 全部 `unk:budget` 且零 Gm、循环 <250 ms 停止 spawn、最坏头段 + 超时 Gm ⇒ 零判定且 M ≤14 s、阶段末 shallow stat 卡死 ⇒ `unk:budget` 且只等 ~300 ms（非 2 s）。
- `source-scan.test.ts`：纳入 `merged.ts`；pinned 调用只有 Cc/Gm 且 argv 只来自 `wtGraphArgs.*`；驱动名并集在 `cherry()` 之前校验；routes 的 `merged` 门、`abortAll`/`clear`、`maxBodyBytes` 仅 merged 时缩小。
- `changeset.test.ts`（+7）：`itemMaxBytes`（超大项不入、缺省行为不变、不能抬高总上限、总字节淘汰、`drop`/`clear`、TTL、wtdiff 工厂不受影响）。`audit.test.ts`（+3）：键尾追加的精确顺序、走私字段被丢弃、无 merged 字段时与旧行一致。`project.test.ts`（+2）：真实常量下的 32 KiB 预留（构造 497 KB 的近最坏输入，缩小后 491 KB、默认调用不变）。
- `hub-preview` / `caps-coexist` / `api-worktree-graph`：caps 期望追加；仅 preview + /proc 时声明（无 /proc、preview 未配置都没有）；LAN `loopback` 模式下 `merged=1` 的 404 与普通 404 逐字节相同；真实 HTTP 下 `merged=1` 出 parser 合法的块、未启用路由忽略该键且字节相同。
- `web-hub-worktree-graph.test.ts`（+4，真实 hub + HTTP + git）：eq / part（`e`）/ none 与 `git rev-list --cherry-mark` oracle 逐分支一致；`merged` 块纯加法（去掉后与普通响应深度相等）；Gm 命令行带全部硬化项；第二次请求零 Gm spawn；审计无分支名 / oid；30 候选 ⇒ 24 + `omitted:6`；浅克隆 ⇒ `skipped:"shallow"` 且零 Cc/Gm；部分克隆缺 blob ⇒ `unk:"missing-object"`、ssh marker=0（含「未硬化命令 marker>0」对照）、对象目录不变。
- 变异验证：去掉 `cache.drop` / 逐条复核 / 尾段 / 改变 capped 与退出码的判定顺序，对应测试均变红。

## 自验（尾部）

```text
$ npx vitest run tests/web-hub/hub tests/web-hub/http tests/integration/git-wtdiff.test.ts tests/integration/web-hub-worktree-diff.test.ts tests/integration/web-hub-worktree-graph.test.ts --maxWorkers=4
Test Files  288 passed (289) | Tests 5880 passed (5881)
唯一失败：tests/web-hub/hub/feishu/requests.test.ts「20 attachments closes immediately」（fake timers；与本包无关，未触碰 feishu；单跑 3 次均 34/34 通过，即并行负载下的偶发）
$ npm run typecheck           ⇒ 通过（tsc ×2 + vue-tsc）
$ npm run format:check        ⇒ 仅 docs/dev/worktree-graph/merged-P4-report.md 未格式化（P4 的文件，非本包）
$ git diff --quiet HEAD -- tests/fixtures/ && echo fixtures-ok  ⇒ fixtures-ok
§8.3①：git diff --name-only HEAD 与未跟踪文件 ⊆ merged-files.txt（域外 0 条）
```

## 遗留

- 未提交（按约定由主会话按精确路径提交；其中本包文件见回复清单）。
- 可观察性：`mergedSkip` 只记 0/1，具体 skip 原因只在 `wtgraph.merged_discarded` 告警（尾段丢弃）里出现；若要在审计里区分原因，需另议（会超出「只追加计数键」）。
