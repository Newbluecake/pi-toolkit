# Fleet 自动归档槽满停摆 · 实现方案（#91）

> **需求摘要**：`ARCHIVE_ENTRIES_CAP=256` 填满后自动归档静默停摆（取证见 `forensics.md`：候选是 `query.list()`
> 的无界并集，gone≈0 ⇒ room=0 ⇒ `selectAutoArchives` 恒空）。目标：①槽满后自动归档持续推进，新终态条目总能
> 按 keep/age 门归档；②**不复活 flip-flop**（已归档→弹回→再归档的循环，含 A/B/A 与 at-only 两种形态）；③UI 语义
> 可预期。约束：不改 run-registry/store 无界合并语义；不动 wire（I10，`StatusInfo.archived` 仍只有 `{rev, entries}`）；
> web-hub 关闭时零差异（I9）；`subagent:archive` 快照新增字段向后兼容（旧快照可读、旧代码读新快照不炸）。
>
> 方案制定：2026-10-29，只读调查。选定：**方案 a′「单调结算水位线（压缩墓碑）」**。

---

## 1. 方案评估

| 方案                                  | 结论             | 理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a) `dropped` 墓碑集合                 | 否（但取其思想） | 不设帽则无界（本会话 741 run/7 天，且只增不减，每个 run 终将进墓碑）；设 FIFO 帽则最老墓碑掉出后该 id 重新可选 → 归档 → 挤掉另一条 → 又一个墓碑掉出……变成每分钟一写的慢速轮转（flip-flop 的变种）。墓碑必须覆盖「归档窗口以外的全部老条目」，这正是一个单调水位线能用 O(1) 表达的东西。                                                                                                                                                                                                                                                          |
| b) 候选限定到 wire 可见集             | 否               | ①把归档语义耦合到三处显示帽（`web-hub/agent/status.ts:35-36` 的 64/8、bash 投影的 20/12+24h retention+字节预算、TUI 的另一套帽），任何一处改常量都会静默改变归档行为；②bash 侧会回归：`omittedIds`（`bash-jobs.ts:88-91`）= 超出 12 行帽且未归档的终态 job，若候选只取 wire 行，这些 job 永不被自动归档，`(+N more)` 常驻增长——候选至少得是 `rows ∪ omittedIds`，等于在 stack.ts 注入点复刻整套投影；③keep 计数口径改为「窗口内」，与 README #59 文档不一致；④需改 `stack.ts:1393-1397` 注入点并让 archive 依赖 web-hub/agent 投影（反向依赖）。 |
| c) 按 settledAt 固定年龄 X 视为可驱逐 | 否               | 固定 X 与槽位无关：低流量会话里 8 行终态窗口可能横跨数天，X 天前归档的条目被驱逐后仍在窗口内 → 在抽屉里「弹回」未归档；若同时不再选它也只是把问题换成可见回归。                                                                                                                                                                                                                                                                                                                                                                                  |
| **a′) 单调结算水位线**（推荐）        | **是**           | 状态加一个按 kind 的 `horizon`（epoch-ms）。**仅当槽位溢出**时驱逐最老结算的条目，并把该 kind 的 horizon 抬到被驱逐者的 settledAt；settledAt ≤ horizon 的条目视为「隐式已归档」：永不被 sweep 选中、不计入 keep 计数。horizon 单调不减 ⇒ 被驱逐者**按构造**永不再被选 ⇒ 不可能 flip-flop；状态恒为 2 个数，无增长问题；持久化随快照走，跨重启/重种不丢。驱逐只发生在 256 深处（远离 8 行 wire 窗口），UI 不可见。                                                                                                                                |

不考虑的方向：调大 CAP（只推迟停摆，候选仍无界）；改 run-registry 淘汰（违反约束）。

---

## 2. 语义（完整状态机）

### 2.1 状态

```ts
export interface ArchiveHorizon {
  run?: number;
  bash?: number;
} // epoch-ms，缺省 = -∞
export interface ArchiveState {
  entries: ArchiveEntry[];
  held: ArchiveHold[];
  horizon?: ArchiveHorizon; // 仅当至少一个 kind 有值时存在（exactOptionalPropertyTypes：缺省即不写键）
}
```

条目 x（kind k，结算时刻 s）的状态由下表唯一决定（优先级自上而下）：

| 条件                  | 状态                      | UI                                                                      | sweep                        |
| --------------------- | ------------------------- | ----------------------------------------------------------------------- | ---------------------------- |
| x ∈ entries           | 显式已归档（auto/manual） | 折叠到「已归档」                                                        | 不选、不计数                 |
| x ∈ held              | 用户取消归档              | 显示                                                                    | 不选、**计数**（现语义不变） |
| 终态 ∧ s ≤ horizon[k] | **隐式已归档**（新）      | 不在 wire 归档集里；按构造位于 256 深处，不在任何显示窗口内（见 §5 R1） | 不选、**不计数**             |
| 终态 ∧ s > horizon[k] | 未归档                    | 显示                                                                    | 按 keep+age 门可选、计数     |
| 非终态                | 运行中                    | 显示                                                                    | 不选、不计数                 |

### 2.2 选择（`selectAutoArchives`，纯函数）

- 计数集 `remaining(k)` = 终态 ∧ ¬archived ∧ 去重 ∧ (held ∨ s > horizon[k])。
- `excess = keep===0 ? |remaining| : max(0, |remaining| − keep)`；
- 选 `remaining` 中满足 `autoArchiveDue`（新增 `s > horizon[k]` 条件；held 排除；age 门）的项，按 settledAt 升序取前 `excess`。
- **去掉现有 room 截断**（`sweep.ts:88-95` 与 `archiveRoom`/`goneEntries` 的选择侧用法）：容量处理整体移到 §2.3 的 trim，必须让 trim 看到完整选择集，才能一次性把落选的老条目折进 horizon（否则下一 sweep 会再选它们，多一写，且 S1 的「24h 只写 1 次」会红）。

### 2.3 入槽与驱逐（新纯函数 `trimToCap`，sweep 与手动路径共用）

```
trimToCap(state, live: Map<key, settledAt>, protect: Set<key>): ArchiveState
  overflow = entries.length − CAP；≤0 ⇒ 原样返回（同一引用）
  victims 按优先级取前 overflow 个：
    P1 未保护 ∧ gone（key ∉ live）            —— 插入序（最老插入先）
    P2 未保护 ∧ live ∧ auto                  —— settledAt 升序，平手按插入序
    P3 未保护 ∧ live ∧ manual                —— settledAt 升序，平手按插入序
    P4 protect 内                            —— 插入序（= 现 capTail 语义）
  对每个 live victim：horizon[kind] = max(horizon[kind] ?? −∞, settledAt)
  entries = 原序去掉 victims；held 不动
```

`live` 由 control 从候选 getter 构建（run：`diag.settledAt ?? updatedAt`；bash：`endedAt ?? createdAt`，与 `sweep()`/`terminalInstant` 同口径；重复 id 取首次出现，与 selection 的 `seen` 去重一致）。仅终态项进入 `live`？——**不**：非终态但在列表里的项也算 live（不进 P1），但它们不可能在 entries（归档要求终态），无影响；为简单起见 live = 全部候选。

### 2.4 sweep 流程（`ArchiveControl.sweep`）

1. 构建 candidates（不变）与 `live` map。
2. `selected = selectAutoArchives(state, candidates, now, policy)`；空 ⇒ return（无写）。
3. `next = fold(archiveItem(·, {auto:true, now}, Infinity))` —— `archiveItem` 新增可选 `cap` 参数（默认 `ARCHIVE_ENTRIES_CAP`，旧调用方行为不变）。
4. `next = trimToCap(next, live, ∅)` —— 新选中项与旧条目**同台按 settledAt 竞争**：一次 sweep 内「最新结算的 256 个」成为显式条目，其余（含落选的新选中项）折入 horizon。
5. `commit(next)`（不变：`sameArchiveState` 去重 + lastPersisted 基线）。

性质：

- **推进**：任何新终态 run（s 最新）只要超出 keep 且过 age，必入显式集合（它比任何被驱逐者都新）。
- **收敛**：sweep 选完后，所有 s > horizon 的未归档非 held 终态项 ≤ keep，下一 sweep 选空 ⇒ 稳定舰队零写。
- **无 flip-flop**：条目离开显式集合只有三条路：gone 驱逐（不在候选 ⇒ 不可选）；live 驱逐（horizon ≥ 其 s，horizon 单调 ⇒ 永不可选）；unarchive（进 held ⇒ 永不自动选）。没有任何路径让一个被移除的 live 条目重新可选。
- **horizon-only 写**：若选中项全部比现有 256 个更老（只在升级首扫或 settledAt 异常时出现），entries 不变、horizon 上抬 ⇒ 写 1 次（需持久化，否则重启后再算一遍），之后不再发生。

### 2.5 手动路径（同 PR，保持一致性）

现状问题：`archiveItem` 的 `capTail` 在满槽时按插入序 FIFO 驱逐（可能是 live auto 条目），被驱逐者 s > horizon ⇒ 回到「未归档」并**占用 keep 名额**（抽屉近期终态只显示 5 条），属语义瑕疵（不循环，但不可预期）。改为：

- `setArchived(kind,id,"archive")`：`next = archiveItem(state, mut, Infinity)`；`next = trimToCap(next, live, {key(id)})`。
- `setArchivedMany(kind, ids)`：fold `archiveItem(·, Infinity)`；`trimToCap(next, live, set(ids))`。P4 保证 batch 超 CAP 时仍「保留 batch 中最新插入的」（`control.test.ts:170` 的 `b-44..b-299` 保持绿）；被挤掉的 batch 内 live 项同样抬 horizon。
- `changed` 计数口径不变（仍按「此前未归档」计；`control.test.ts:170` 断言 300 不变）。
- `archiveRoomFor`/`archiveBatch` 不改：`cap − outside` 在新驱逐策略下仍是 batch 全员存活的正确上界（batch 被 protect，外部条目先走 P1→P3）。
- `unarchive`：不变。只作用于显式条目；对隐式条目（UI 不可见）调用返回 `changed:false`，不加 hold（与现「不在 entries 即 no-op」一致）。

### 2.6 Edge cases

| 场景                                                         | 行为                                                                                                                                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cap 恰好满、新选 1 项                                        | overflow=1：先 gone，否则最老结算 auto 驱逐 → horizon 上抬；新项入槽。1 写。                                                                                                                          |
| cap 满且全是 manual                                          | P2 空 → P3 驱逐最老结算 manual，抬 horizon。文档化。                                                                                                                                                  |
| held 项 s ≤ horizon                                          | 仍 held、显示、计数、永不自动选（held 优先于 horizon）。                                                                                                                                              |
| unarchive 一个 s ≤ horizon 的显式条目（manual 老条目或平手） | 移出 entries、进 held ⇒ 显示且豁免；不受 horizon 影响。                                                                                                                                               |
| 再次 archive（手动）一个 held 项                             | archiveItem 解除 hold（不变）；若 s ≤ horizon 也照常成为显式 manual 条目。                                                                                                                            |
| 手动 archive 一个 s ≤ horizon 的 id                          | 允许，成为显式条目（无害）。                                                                                                                                                                          |
| `afterMs`/keep 设置后续调大                                  | horizon 下的项不再被自动归档——它们本就隐式归档，无可见差异。                                                                                                                                          |
| 跨重启 / /reload / fork / session_tree                       | horizon 随最后一条有效快照读回；`restore()` 以读回值为 lastPersisted 基线 ⇒ 重建不写。run 重种（`stack.ts:663-666`）保留 `diag.settledAt` ⇒ 水位比较稳定。fork 到无 horizon 的旧点 ⇒ 首扫重算，1 写。 |
| gone 条目的 id 日后又回到候选（理论上：会话文件恢复）        | 若 s > horizon 会被按正常规则重新归档 1 次；非周期性。现状同。                                                                                                                                        |
| `settledAt` 缺失回退 `updatedAt` 且其后被更新                | 项可能越过 horizon 被再归档 1 次（成为最新条目），非周期。记残留风险 R3。                                                                                                                             |
| bash：256 个归档在 24h 内结算（bash 重度会话）               | 驱逐可能落在 retention 内的 bash → 重回 `omitted`。与现状（及 cd57bdf9 前）同类；`archive_omitted` 用 protect 处理、可收敛。P2 按 settledAt 驱逐使 run 远比 bash 先被驱逐，常规会话不会出现。记 R1。  |
| 时钟回拨                                                     | horizon 用 max，单调不减；最坏让少量项被视为未归档并按规则再选 1 次。                                                                                                                                 |

---

## 3. 文件域

**改**（全部在 `src/archive/`，pi-free 纯函数为主；`stack.ts` 注入点**不动**）：

1. `src/archive/state.ts`
   - 新增 `ArchiveHorizon`、`ArchiveState.horizon?`、`horizonOf(state, kind): number`（缺省 `-Infinity`）、`raiseHorizon(h, kind, s)`。
   - `sanitizeArchiveState`：读 `raw.horizon`——对象且 `run`/`bash` 为有限数才保留；非法字段**只丢该字段**、不废快照；两者都无则不写 `horizon` 键。旧快照（无字段）→ 结果与今天逐字节相同。
   - `archiveItem(state, mut, cap = ARCHIVE_ENTRIES_CAP)`：仅加可选 cap；返回值保留输入的 `horizon`（`...(state.horizon ? {horizon} : {})`）。`unarchiveItem` 同样透传 horizon。
   - `autoArchiveDue`：加 `if (settledAt <= horizonOf(state, item.kind)) return false`（write-rate 反事实用空状态调用，不受影响）。
   - `sameArchiveState`：比较 `horizon?.run`、`horizon?.bash`（undefined==undefined）。
   - 头注释：删「evicting the OLDEST archive is fine」，改写为水位线模型。
2. `src/archive/sweep.ts`
   - `selectAutoArchives`：计数集排除 s ≤ horizon（held 除外）；**删除 room 截断**；更新 docblock。
   - 新增 `trimToCap(state, live, protect)`（§2.3）与导出的 `liveKey(kind,id)` 辅助；删除 `makeArchiveRoom`、`archiveRoom`、`goneEntries`（或 goneEntries 内联进 trim）。
3. `src/archive/control.ts`
   - 私有 `liveSettled(): Map<string, number>`（从两路 getter 构建，口径同 `sweep()`）。
   - `sweep()` 按 §2.4；`setArchived`/`setArchivedMany` 按 §2.5。
   - `commit()`：`appendEntry("subagent:archive", { entries, held, ...(next.horizon ? { horizon: next.horizon } : {}) })` —— 未触发驱逐的会话写出的快照与今天逐字节相同。
   - `wire()`/`view()` **不变**（I10）。
4. `docs/dev/web-hub/README.md` 「Cap-stable sweep」一段改写为「Cap-full progression (#91)」：水位线、驱逐优先级 P1–P4、无 flip-flop 的构造性论证、快照字段 `horizon`、测试坐标。
5. `docs/dev/archive-full/plan.md`（本文）。

**测试**（`tests/archive/**`，均为 Tier 1 确定性）：见 §6。`tests/fixtures/` 无 archive golden（已 grep 确认：仅 memory/secure 的同名无关文件），不触碰 A/B 级冻结物。

---

## 4. 快照格式演化

- 新快照：`{ entries, held, horizon?: { run?: number, bash?: number } }`；仅在发生过 live 驱逐后出现。
- 新代码读旧快照：`horizon` 缺省 = -∞ ⇒ 首扫按新规则重算（卡死会话：~735 项被选，与 256 旧条目同台按 settledAt 取最新 256，horizon 一次抬到位）⇒ **恰好 1 写**，之后恢复每到达一次最多 1 写。
- 旧代码读新快照（降级/回滚）：`sanitizeArchiveState` 只取 `entries`/`held`，未知键忽略 ⇒ 不炸，退化为今天的停摆行为。
- 回滚后再升级（评审 #5）：旧代码的下一次写入只写 `{entries, held}`、丢掉 horizon；再升级按「旧快照无 horizon ⇒ 首扫重算」处理，恰好 1 写收敛。
- `readArchiveState` 的「最后一条有效快照胜出」不变；horizon 坏值只丢字段。
- wire：`StatusInfo.archived = { rev, entries }` 不变；horizon 永不上 wire（hub/UI 无需感知，无需 `/webhub restart`，agent 侧 `/reload` 即生效）。horizon-only 变化会 `rev++`（一帧多余但形状不变，可接受）。

---

## 5. 风险与回滚

| #   | 风险                                                                     | 缓解 / 残留                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 隐式归档项在 UI 中显示为「未归档」：wire 不带 horizon。                  | 驱逐对象恒为最老结算 auto（P2），通常在 256 深处。两个如实边界（评审 #2 改写，删掉「点一次即收敛」的错误论断）：(a) mass-gone 真实发生（取证实测 04:51 一笔 9 条变 gone），live 舰队大幅缩减时隐式归档项会浮进可见窗口（web 8 行终态、TUI `recentTerminal: 3`，两者都取最新**未归档**行），显示为未归档且因 s ≤ horizon 永不再被自动归档；(b) 驱逐对象落在 bash 时，`(+N more)` 的 `omittedIds` 只按显式 entries 过滤（`bash-jobs.ts:88-91`），每点一次归 N 条、同时挤出 N 条 bash，计数不变、**不收敛**（与现状 capTail 同类、非回归）。可选测试钉住「点击不收敛但有界、无自动写放大」。 |
| R2  | horizon-only 写被 write-rate 的 at-only 规则误报。                       | 同步更新 `semanticKey` 纳入 horizon（它是语义状态）；此类写有界（升级首扫/异常各 1 次）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R3  | `settledAt` 缺失回退 `updatedAt`、之后又被刷新 ⇒ 越过水位被再归档 1 次。 | 非周期；`state-machine.ts:372` 结算时必写 `settledAt`，回退路径罕见。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| R4  | keep 计数口径微调（水位下的未归档项不计）。                              | 只影响 256 深处的项；README 写明。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R5  | 手动 batch 驱逐策略从 FIFO 改为 P1–P4。                                  | `commands-archive.test.ts:212` cap-room 用例与 `control.test.ts:170` 保持原断言，作为回归门。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| R6  | 性能：每 sweep 建 Map + 排序 O((n+m) log).                               | n≈741、m≤256，微秒级；顺手把 selection 内 `isArchived`（O(n·m)）改为 Set 查找（可选）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**回滚**：单个 `fix(archive)` 提交，`git revert` 即可；已写出含 `horizon` 的快照对旧代码无害（字段被忽略）。

---

## 6. 验收标准与回归清单

### 6.1 命令

```sh
npx vitest run tests/archive tests/web-hub/agent/commands-archive.test.ts tests/web-hub/agent/status-slots-bash-archive.test.ts
npm run typecheck && npm run format:check
npm test                                    # 全量（PI_TOOLKIT_TEST_WORKERS=4）
git diff --quiet origin/dev -- tests/fixtures/   # 冻结物零差异
git diff --stat origin/dev -- src/stack.ts src/web-hub   # 期望空：注入点与 wire 未动
```

### 6.2 新增测试（先红后绿：T1/CF3 须在当前 HEAD 上为红；T2 断言新 API `horizon`，在 HEAD 上是编译错误而非红色断言——评审 #6）

`tests/archive/control.test.ts` 新 describe「cap-full progression (#91)」：

- **T1 停摆复现**：256 个 live auto 条目（候选里无 gone），再加 20 个新终态 run（过 age、超 keep）→ 一次 sweep 后新 run 中最老的 14 个（n-0..n-13）已归档、`appended` +1，且 `horizon.run` == 被驱逐 14 个中最大的 settledAt（推进的另一半：老条目被结算而非占位——评审 #7）；当前代码 0 写（红）。
- **T2 eviction 优先级**：混合 gone / live auto / live manual 条目，溢出 k 时依次驱逐 P1→P2→P3；断言 manual 在仍有 auto 时存活；live 被驱逐者使 `horizon[kind]` = 其 settledAt。
- **T3 held × horizon**：held 项 s ≤ horizon 仍计数、永不被选；unarchive 显式条目 → hold；再手动 archive 解除 hold。
- **T4 手动满槽**：满槽时 `setArchived` 一个新 id → 被驱逐的是最老结算 auto（非最老插入）、horizon 上抬；后续 60 次 sweep 零写（无 keep 名额被老条目占用）。
- **T5 bash 不先于老 run 被驱逐**：run 重度舰队 + retention 内 bash 归档，溢出只吃 run。

- **T6 隐式条目的手动交互**（评审 #3）：unarchive 一个隐式条目（s ≤ horizon、不在 entries）⇒ `changed:false` 且不加 hold；手动 archive 一个 s ≤ horizon 的 id ⇒ 成为显式条目（state/control 各一例）。

`tests/archive/sweep.test.ts`：

- 改写「archive capacity」两例：`selectAutoArchives` 不再截断（300 → 294 项）；`trimToCap` 单测：newest-settled 256 存活、`horizon.run=37`、新选中项可在同次 trim 中落选；全 live 满槽 + 2 新项 ⇒ 驱逐 2 个最老结算 live（不再是「room=0 不选」——这是本次有意反转的旧断言）。
- 计数排除：s ≤ horizon 的未归档项不计入 keep、不可选。

`tests/archive/state.test.ts`：

- 旧快照（无 horizon）sanitize 后**无 `horizon` 键**（`toStrictEqual`）；`{horizon:{run:5}}` 往返；坏 horizon（字符串/NaN/Infinity/数组）只丢字段、entries 保留。
- `sameArchiveState`：仅 horizon 不同 ⇒ 不等。
- `autoArchiveDue`：s ≤ horizon ⇒ false；边界 s == horizon ⇒ false。
- `archiveItem(..., Infinity)` 不截断且透传 horizon；默认 cap 行为不变（现「caps FIFO at 256」用例不改）。
- 从未发生 live 驱逐 ⇒ 新代码写出的快照**无 `horizon` 键**（`expect("horizon" in data).toBe(false)`；S1 首帧同断言）——I9 精神的核心承诺（评审 #4）。

`tests/archive/write-rate.test.ts`（flip-flop 对立测试主阵地）：

- `semanticKey` 纳入 horizon。
- **S5 七天到达流**：700 个历史 run（全部候选永不离开，模拟取证会话）+ 每 3 次 sweep 到达 1 个新终态 run，跑 1,440×3 sweep。**fixture 约束（评审 #1）**：到达项的 settledAt 必须「远早于 now（过 age 门）且新于全部既有候选与当前 horizon」（照抄 S2 的 `10_000 + …` 模式）——朴素写法「到达即 settledAt=now」会让断言①在 age 门内必红，而 settledAt ≤ horizon 的新项会直接落入隐式归档、永不被选。断言 ①每次 sweep 后「s > horizon 的未归档非 held 终态 run」≤ keepRuns（推进不停摆）；②`appended.length ≤ arrivals + 2`（初扫 + 至多 1 次 horizon-only）；③`checkWriteRateInvariants` 为空（无 identical / at-only / A/B/A）；④**被驱逐 id 永不回归**：记录每次快照中离开 entries 的 live id 集合，断言它们之后从未再出现在任何快照的 entries 中；⑤horizon 序列单调不减。
- **S6 重启等价**：S5 中途截取分支，新 control `restore` 后在同一舰队上 sweep 60 次 ⇒ 0 写；读回 horizon == 内存 horizon。
- **S7 升级首扫**：从「256 live 条目、无 horizon」的旧快照起步（取证现场形状）⇒ 首扫 1 写且带 horizon，随后 60 次 sweep 0 写。
- **CF3 反事实（停摆门有牙）**：内联 cd57bdf9 的 room 截断 sweep（当前 HEAD 的 `selectAutoArchives` + `makeArchiveRoom` 语义），在 S5 的到达流上跑，断言其「未归档终态数」单调增长、越过 keepRuns（即停摆检测器会红），证明 S5 ① 非空断言。
- 现 S1–S4 与两个反事实保持原断言（S1 仍「24h 只写 1 次」，现在第 1 次快照带 horizon）。

### 6.3 现有用例的预期变化

| 用例                                                                                          | 变化                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `control.test.ts` 「converges: once the cap is full…」                                        | 保持绿（r-38..r-293 归档、r-293 有、r-299 无、1 写）。                                                                                 |
| `control.test.ts` 「makes room by dropping archive entries whose run is gone, not live ones」 | **改写**：gone 足够时只驱逐 gone（原断言）；gone 不足时补驱逐最老结算 live 并抬 horizon。原「live 永不被驱逐」正是停摆根因，有意反转。 |
| `control.test.ts` 「a manual archive is not erased…」「cap overflow keeps the NEWEST…」       | 保持原断言。                                                                                                                           |
| `sweep.test.ts` 「archive capacity」两例                                                      | 改写（见 6.2）。                                                                                                                       |
| `commands-archive.test.ts` cap-room 用例                                                      | 不改，必须绿。                                                                                                                         |

### 6.4 真机验收（可选，用户确认后）

在取证会话所在 pi 中 `/reload`，≥2 分钟后：

```sh
F=~/.pi/agent/sessions/--home-bluecake-ai-pi-toolkit--/2026-10-22T06-18-24-491Z_01a16242-*.jsonl
tac $F | grep -m1 '"customType":"subagent:archive"' | jq '{n:(.data.entries|length), horizon:.data.horizon}'
```

期望：出现 1 条新快照，`n=256`、`horizon.run` 有值；之后每有新 run 结算超 keep+30min，快照随之推进；抽屉近期终态未归档行 ≤ 6；30 分钟内无连续每分钟写入。

---

## 7. 评审修订记录（2026-10-29，reviewer kimi-k3-256k r_8KCXTXH3：有条件通过）

- #1（严重）S5 fixture 写死 settledAt 约束（过 age 门 + 新于既有候选与 horizon），防实现者为变绿放宽停摆检测断言。
- #2 R1 改写：承认 mass-gone 浮窗与 bash (+N more) 不收敛两个边界，删除「点一次即收敛」。
- #3 新增 T6（隐式条目的 unarchive/手动 archive）。
- #4 新增「无 live 驱逐 ⇒ 快照无 horizon 键」断言（I9）。
- #5 §4 补回滚后再升级的 horizon 重算说明；#6 修正「T2 红」表述（新 API 是编译错误）；#7 T1 补 horizon.run 断言。

---

## 8. 落地记录（2026-10-29，实现于 dev 分支）

按 §2–§4 实现，文件与 §3 一致：`src/archive/{state,sweep,control}.ts`、`tests/archive/*`、README「Cap-full progression (#91)」段。验证：`npx vitest run tests/archive tests/web-hub/agent/commands-archive.test.ts tests/web-hub/agent/status-slots-bash-archive.test.ts`（98 通过）＋ `npm run typecheck` ＋ fixtures/stack.ts/web-hub 零差异。

与规格的偏差（均已在实现中注明理由）：

1. **CF3 加了「真臂」**（§6.2）：纯内联反事实在改动前后都绿（它钉的是旧语义本身），无法满足「T1/CF3 须在当前 HEAD 上为红」。给 CF3 追加了第二臂：对同一停摆终态调用**当前** `selectAutoArchives`，断言其选择数 > 0 —— HEAD 上该臂返回 0、红；新代码上绿。已在 HEAD（临时物化 origin/dev 源码，只读 `git show`，未动工作树提交）实测：T1 红（appended 0，停摆复现）、CF3 红（新选择臂 0）。T2 在 HEAD 上为编译错误（评审 #6 口径）。
2. **sweep.test.ts「gone entries free exactly their slots」的改写形制**：room 截断删除后溢出驱逐取「恰好 overflow 个」最小驱逐，故 gone 多于溢出时只驱逐最老插入的溢出个（5/20），测试按此断言（不再是「全部 gone 让位」）。
3. **S5 断言实现**：①④⑤用普通循环收集违规 + 单条断言（4,320 次逐条 `expect` 的 vitest 开销使单测从 ~2.7s 涨到 ~37s）；断言语义不变。
4. `liveSettled()` 是 control 的私有方法（sweep 与手动路径共用同一口径）；`liveKey` 从 sweep.ts 导出。
