# #36 记忆块化改造 + 治理 · 实施方案（plan r3）

> 版本 **r3**（2026-11-06；r2 = 第 1 轮评审处置，r3 = root 第 2 轮复审的 13 条裁定）· 基线 dev@122de638 · 架构依据：同目录 `arch.md` **r5**（下文 `arch §x` 与 `arch r4 §x` 均指 r5 中的同号章节）
> 读者：执行各包的开发子 agent、verifier、主会话调度。每个包**只许改本文为它列出的文件域**；超出文件域的需求先 `message_agent`（to:"root"，kind:"report"）报告，不得自行扩张。
> 改动 `src/memory/**` 前必读：`docs/dev/memory/README.md`（不变式与门禁）、AGENTS.md（I1–I12、Frozen artifacts）。

---

> **2026-11-07 用户新裁定优先**：本文件保留早期裁定历史；任何「conflict 自动」旧措辞不再是现行规则。当前只允许新块完整覆盖或明确废弃旧块全部有效信息时自动取代，partial conflict 仅建议；显式路径及其余权限/安全边界不变。

## r3 变更摘要（相对 r2；root 第 2 轮复审后的 13 条裁定）

架构依据升级为 arch **r5**。用户已定事项一条未改。逐条落点见文末「r5/r3 处置表（root 裁定）」。

- **P1**：文件域新增 `src/memory/blocks/state.ts`、`src/memory/safe-fs.ts`——**只新增** `renameDirNoClobber`/`removeTreeNoFollow`/`fsyncDir` 三个导出（既有导出字节不变，fs-guard 不放宽）及新测试 `tests/memory/safe-fs-dir.test.ts`；`BlockMeta` 增加 `heading/residue/origin`；`dirFormat` 改为 hold 优先；无锁读者规则。
- **P0**：`JevWritePort.afterWrite` 追加可选 `block`/`askScope`/`relations`（沿用现有方法名，不造 `runAfterWrite`）；`MemEntry.block` 去掉 heading；`MemoryInjectDetailsV1.resident`。
- **P2**：使用 P1 新增的 `src/memory/blocks/state.ts`（代际 `gen`、hold）；提交五项复核与清单校验；按 owner 身份清理暂存区（锁内隔离再删）；混合权威残留块；EXDEV fail closed；全阶段预算与 `setImmediate` 让出；新增双进程回滚交错、活 owner 暂停交错、各回滚边界崩溃、gocryptfs 目录提交、构建期 mount-loss 测试。「tidy/safe-fs 零 diff」限定为 P2 提交范围。
- **P3**：`delivered` 改为 snapshot（解析 hub 持久化文本）+ ledger（随 R details 恢复）；到期标注变化也发 R；corpus 指纹 + 日期 + snapshotKey 重算；异步结果 rev 变则丢弃；V36 改写为可成立的断言。
- **P4**：调用链改用 `afterWrite`；在 `src/memory/index.ts` 把 hub snapshot 读取函数传给 `wireJev`。
- **P5a**：archive 冲突名 `<id>.r<n>.md` + `archive/index.json`；对 `tidy/command.ts` 只做一处改动；残留块不作自动取代目标。
- **P6a/P6b**：冻结面改为引用 X1–X6 例外与开关差分；G3 扩为 8 个用例（3a/3b/3c 按 `redeemPending` 规则）。
- **PG**：不达标时派 P5a-fix / P6b-fix 改生产常量后重跑，脚本只读生产常量。
- **P5b**：governance-off 差分按 arch §7.2 比较对象表执行，排除 Jev 打标侧车字段。
- **P8**：写清「回滚 = 根目录当前旧布局；迁移前原始字节 = tar」；dry-run 过目增加残留块一节。
- **验收矩阵**：改写 V05/V06/V15/V30/V31/V33/V36/V38，新增 V40–V45。

---

## r2 变更摘要（相对 v1）

第 1 轮评审（GPT-6.1 Sol）给出 9 个 Blocker、7 个 Major、1 个 Minor，r2 全部处置，用户已定事项一条未改。逐条处置见文末「评审处置表」。

- **P2 重写**：迁移改为暂存区构建 + 单次原子 rename，不再改动 tidy 的 txn、safe-fs；增加回滚、漂移导入、源字节覆盖审计和 secure 写闸门（`src/secure/memory-gate.ts` + `src/index.ts` 装配 + `tests/tiers.ts` 中唯一一处登记）。
- **P0**：一次补齐全部契约字段与 sanitizer；新增 `memory.migrate.auto`；harness 只钉四个配置。
- **P3**：新增 `delivered` + R 层、统一 eligibility、external renderer，以及生产 hub 接线矩阵。
- **P4**：补上 tagging.ts 调用链。
- **P5a**：取代改为单边协议并在锁内复核；sweep 增加预算、中止和自触发屏蔽。
- **新增 PG 包**（G1/G2 离线门禁），作为 P5b 的前置条件；G3 并入 P6a。
- **P5b**：测试白名单改为由确定性命令生成。
- **P8 重写**：严格九步。暂停开关在 P2 合入后、默认值翻转之前就生效并取证。
- **I9**：改为「已批准例外 + 开关差分」。验收矩阵增加 V31–V39。

---

## 0. 需求摘要与用户已定事项

### 0.1 一句话需求

把项目记忆从「多条目大文件」改造成「一文件一 block（≤1 KB）」：

- **常设用户令**常驻 system prompt；其余块由 Jev 按相关性注入，另配每主题一行的自动摘要索引；
- 在 block 之上落地治理四原则：到期、事件触发、写入提示、冲突取代；
- 一并修复预测注入的窗口/预算错配，并补上评测发现的四项注入改进。

**先重构，后治理**，在同一任务内完成。

### 0.2 用户已定事项（来源：项目记忆 `memory-predict.md` 中 2026-11-05/06 的 #36 条目，以及 arch r1/r2 §9.2 的裁定）

| #   | 日期  | 决定（要点）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 落点（arch）         |
| --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| D-1 | 11-05 | **治理四原则**：①到期——agent 条目到期停注入（索引留「已到期 N 条」，可恢复），用户令到期仍注入并标「已到期待确认」；②触发——事件触发（任务完成/推送/发版/reload/预算告急）+ 分级自动：带明确期限的 agent 条目自动归档（可恢复），其余只出建议，用户令永不自动动；③写入——用户令豁免临时判定，状态快照写入照常成功但强提示补 expires/until 或改写为持久结论，不硬拦；④冲突——新令自动取代旧令（标已取代、停注入、可恢复）+ 非阻塞通知                                                                                         | §5                   |
| D-2 | 11-05 | **块化**：一文件 = 一 block，单块 ≤1 KB；`update` = 整块替换（版本号/CAS）；保留 create/delete/view/search，去掉 insert/str_replace/rename；批准对 B 级 `memory-tool-surface.json` 做申报式更新；现有条目自动拆分，mem 注释转 frontmatter，旧文件归档且可恢复。预测注入：`model.enabled` **保持开启**，直接修窗口/预算错配；评测提出的改进（子会话受众过滤、时效降权、E 层只读失败不撞词、高危 tag 冷却饿死降级出口）并入 #36                                                                                             | §3.2、§4、§6         |
| D-3 | 11-06 | **推翻** 11-05 的「core.md 常驻与 Topics 索引保留」：去掉 core.md 特殊地位与主题卡；用户令块自动常驻（不靠 Jev），其余块靠 Jev；Topics 索引每主题一行。块化设为默认布局；A′ jev-off golden 的 harness 显式钉 `layout:"tiered"`，golden 字节不动。自动取代范围：用户令之间 + agent 之间（agent 永不取代用户令）。惰性迁移 + `/mem migrate --all`。>1 KB 存量豁免并出建议；CC 导入按前缀聚合主题；已迁移目录禁用 `/mem tidy`；audience 迁移时写入、其余从 Jev 标签推导；`waitS=1.0`；疑似指针留存并出建议，纯指针才自动移出 | §3.3、§4.3           |
| D-4 | 11-06 | **用户令分两类**：常设规则 `scope:global`（每轮常驻，常驻区约 2 KB 预算，超额不截断，出合并/降级建议，并在启动提醒中提示）；决策记录 `scope:topic`（**默认**，由 Jev + 索引按需注入）。两类都受用户令保护。迁移：core.md 的用户令 → global，其余 → topic。新用户令默认 topic，只能显式标 global 或看到回显建议后再标，不自动升级                                                                                                                                                                                          | §3.3.2、§4.3.2、§5.3 |
| D-5 | 11-06 | **N1**：索引行描述只用自动摘要（标签 + 计数），不建登记表，丢弃旧主题的人工 when。**N2**：新用户令允许自动取代冲突的 agent 块（历史 supersedes≥0.85 / conflict≥0.90；2026-11-07 覆盖为仅完整取代 supersedes≥0.85，conflict 只建议，每次合计 ≤2 条，可恢复）                                                                                                                                                                                                                                                               | §3.3.3、§5.4         |
| D-6 | 11-05 | 延续 #26：agent 改/删用户令一律直接写入 + voided 回显 + 非阻塞通知，无确认                                                                                                                                                                                                                                                                                                                                                                                                                                                | §4.1.4               |

**全局约束（来自 core 记忆与 AGENTS.md）**：

- 主会话只调度，不亲自实现；
- 每个包返回后派**异源** verifier；验收若选 deepseek，用 `deepseek/deepseek-flash`；
- 验收通过后按精确路径 commit（禁止 `git add -A`）；**整个任务全部完成后才 push 一次**；发版需用户确认。

---

## 1. 分包总览、顺序与并行

```
P0 共享面先行（契约/设置/harness 钉/白名单）
   │
   ├──► P1 块存储核心 ───────────────┐
   └──► P6a 注入修复（不依赖块）──────┤   （P1 ∥ P6a）
                                      ▼
              ┌──► P2 迁移器 ────────────┐
              └──► P3 渲染与静态判定 ────┤   （P2 ∥ P3）
                                         ▼
                              P4 工具 v3 + 写入路径
                                         │
              ┌──► P5a 治理（不碰 wire.ts）─┐
              └──► P6b 受众/降权（wire.ts）─┤   （P5a ∥ P6b）
                                            ▼
                     PG 离线门禁（G1 取代困难负例 / G2 topic 用户令召回）
                                            ▼
                     P5b 治理信号接线 + 默认布局翻转 + blocks-off golden
                                            │
                                   P7 skill 与文档
                                            │
                     P8 真实数据 dry-run → 用户过目报告 → 真迁移 → 复评
```

**与 arch §8 的差异**（都是为了消除并行包之间的文件交集，arch 的顺序不变）：

- **新增 P0**：把 `jev/contracts.ts`、`src/memory/contracts.ts`、`settings.ts`/`setting-specs.ts`/corpus、off-harness 钉住、pi-free 白名单这些共享面集中先改，之后的并行组合就不再争抢这些文件（对应 pitfalls-git #1 的三选一，这里选「先集中改共享面再派」，由一个子 agent 执行 P0）。
- **P5 拆成 P5a/P5b**：`jev/wire.ts` 不能被并行包同时改。P5a 不碰 wire.ts，可以和 P6b 并行；P5b 在 P6b 之后串行接线。
- **默认布局翻转**放在 P5b 的最后一步：在此之前，`layout:"blocks"` 只用于测试，**不得写进真实 settings**（中间提交不 push，无发布风险）。
  - **2026-11-08 root 裁定（改变下面 PG 前置）**：G1 已判定长期 BLOCKED（真实数据里「完整取代」上限 12/20，见 `pg-report.md` 2026-11-08 节），**不再等 G1 PASS**。F1 照常执行——默认 `layout` 翻到 `blocks` 且 `memory.governance.enabled` 保持默认开启（**用户裁定：翻，默认开启**）。替代证据链：G2 正式评估须 PASS；自动取代维持既有阈值（`supersedes ≥0.85` / `conflict ≥0.90`，不新增档位）、单批 ≤2、可撤销并保留原文；翻转后按启动/写入抽样复核误取代。**这是已知未验证项（自动取代误判率无数据背书）被用户显式接受的残留**，不得在文档里改写成「已通过 G1」。
- **r2 新增**：
  - **PG** 离线门禁包，排在 P5b 之前；
  - **P2 合入后立即设置 `memory.migrate.auto=false` 并取证**。原因是 pi 直接从本仓库工作树加载扩展，任何提交都会对新起的会话立即生效，见 §8 第 3 步。

### 1.1 热点文件串行表（同一文件只能按此顺序依次修改）

| 文件                                                            | 串行顺序               | 说明                                                                                                               |
| --------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/memory/jev/wire.ts`                                        | P6a → P3 → P6b → P5b   | E 层只读规则 → 静态判定/常驻 → 受众/降权 → 治理信号 + GovernancePort deps                                          |
| `src/memory/index.ts`                                           | P2 → P4 → P5a → P5b    | 迁移钩子/失效分支 → 注册 v3 工具 + `getSectionSnapshot` 接线 → sweep 接线 → 把 port 传给 wireJev                   |
| `src/memory/command.ts`                                         | P2 → P5a               | migrate/restore --block/描述分派 → tidy 禁用、review-lite 路由                                                     |
| `src/memory/jev/entries.ts`                                     | P3 → P4                | `EntryIndex` blocks 分支 → `parseInlineMeta` 新键                                                                  |
| `src/memory/jev/write-port.ts`、`jev/format.ts`                 | P4 → P5a               | 写入回显/scope 问句 → 取代执行与回显                                                                               |
| `src/memory/jev/predict/select.ts`                              | P6a → P6b              | 冷却饿死出口 → 时效降权排序                                                                                        |
| `src/memory/settings.ts`、`setting-specs.ts`                    | P0 → P5b               | 新键 + 值域 → 默认值翻转                                                                                           |
| `src/memory/jev/index-store.ts`                                 | P0 → P2                | sanitizer 兼容 → 块布局侧车与精确 GC                                                                               |
| `src/memory/inject.ts`                                          | **只有 P3**            | 分派、render 回调（常驻 renderKey）、external renderer；ledger 在 wire.ts                                          |
| `src/memory/tool-v3.ts`                                         | P4 → P5a               | v3 五个命令 → 接入取代回显                                                                                         |
| `src/memory/jev/tagging.ts`                                     | **只有 P4**            | `askScope` 入参                                                                                                    |
| `src/index.ts`                                                  | **只有 P2**            | 只加一行 `writeGate` 装配（I2）                                                                                    |
| `src/memory/jev/contracts.ts`                                   | **只有 P0**            | 后续包不得再改；缺字段时报告 root，由 root 安排                                                                    |
| `src/memory/safe-fs.ts`                                         | **只有 P1**            | 只新增 `renameDirNoClobber`/`removeTreeNoFollow`/`fsyncDir`；既有导出字节不变（r3）                                |
| `tests/memory/fs-guard.test.ts`                                 | **任何包都不改**       | safe-fs 仍是 `src/memory/**` 唯一 fs 导入点（r3）                                                                  |
| `src/memory/tidy/command.ts`                                    | **只有 P5a，只改一处** | 入口处 blocks 目录禁用提示；P2 提交范围内 `tidy/**` 零 diff（r3）                                                  |
| `tests/memory/blocks/hub-wiring.test.ts`                        | P3 → P4                | 矩阵测试 → 追加生产装配用例（r3）                                                                                  |
| `tests/tiers.ts`                                                | **只有 P2，只加一行**  | 只把 `tests/secure/memory-gate.test.ts` 加入 `SECURE_MOUNT_FILES`；其余新测试中需要子进程的放 `tests/integration/` |
| `tests/memory/jev/wire-recall.test.ts`、`wire-predict*.test.ts` | 随 wire.ts 串行        |                                                                                                                    |

### 1.2 并行组合的冲突预检

每次并行派发**前**，主会话（或调度子 agent）必须真跑下面的预检（spec 内容即下文 §1.3 的 globs），exit 0 才能派发；exit 1 ⇒ 改成串行或调整文件域：

```sh
node /home/bluecake/ai/pi-toolkit/skills/dev-flow/scripts/conflict-check.mjs /tmp/36-<pair>.json --cwd /home/bluecake/ai/pi-toolkit
```

「潜在交集」警告（新文件可能撞车）也要逐条人工确认，确认是目录前缀的误报才放行。

### 1.3 预检 spec（三组并行）

**P1 ∥ P6a**（`/tmp/36-p1-p6a.json`）：

```json
[
  {
    "id": "P1",
    "globs": [
      "src/memory/blocks/format.ts",
      "src/memory/blocks/naming.ts",
      "src/memory/blocks/rev.ts",
      "src/memory/blocks/store.ts",
      "src/memory/blocks/marker.ts",
      "src/memory/blocks/adapter.ts",
      "tests/memory/blocks/format.test.ts",
      "tests/memory/blocks/naming.test.ts",
      "tests/memory/blocks/store.test.ts",
      "tests/memory/blocks/adapter.test.ts",
      "src/memory/blocks/state.ts",
      "src/memory/safe-fs.ts",
      "tests/memory/blocks/state.test.ts",
      "tests/memory/blocks/reader.test.ts",
      "tests/memory/safe-fs-dir.test.ts"
    ]
  },
  {
    "id": "P6a",
    "globs": [
      "src/memory/jev/predict/flight.ts",
      "src/memory/jev/predict/select.ts",
      "src/memory/jev/wire.ts",
      "tests/memory/jev/predict/flight.test.ts",
      "tests/memory/jev/predict/select.test.ts",
      "tests/memory/jev/wire-recall.test.ts",
      "tests/memory/jev/wire-predict-model.test.ts"
    ]
  }
]
```

**P2 ∥ P3**（`/tmp/36-p2-p3.json`）：

```json
[
  {
    "id": "P2",
    "globs": [
      "src/memory/blocks/migrate-plan.ts",
      "src/memory/blocks/migrate.ts",
      "src/memory/blocks/legacy.ts",
      "src/secure/memory-gate.ts",
      "src/index.ts",
      "tests/tiers.ts",
      "src/memory/jev/index-store.ts",
      "src/memory/index.ts",
      "src/memory/command.ts",
      "tests/memory/blocks/migrate-plan.test.ts",
      "tests/memory/blocks/migrate.test.ts",
      "tests/memory/blocks/rollback.test.ts",
      "tests/memory/blocks/legacy-import.test.ts",
      "tests/memory/blocks/write-gate.test.ts",
      "tests/memory/jev/index-store-blocks.test.ts",
      "tests/integration/memory-blocks-migrate.test.ts",
      "tests/integration/memory-blocks-rollback-race.test.ts",
      "tests/secure/memory-gate.test.ts",
      "tests/fixtures/memory/migrate-golden/**"
    ]
  },
  {
    "id": "P3",
    "globs": [
      "src/memory/blocks/render.ts",
      "src/memory/govern/eligibility.ts",
      "src/memory/inject.ts",
      "src/memory/doctor.ts",
      "src/memory/init-command.ts",
      "src/memory/jev/wire.ts",
      "src/memory/jev/entries.ts",
      "tests/memory/blocks/render.test.ts",
      "tests/memory/blocks/doctor-blocks.test.ts",
      "tests/memory/blocks/inject-blocks.test.ts",
      "tests/memory/blocks/hub-wiring.test.ts",
      "tests/memory/govern/eligibility.test.ts",
      "tests/memory/jev/wire-recall.test.ts",
      "tests/memory/jev/entries.test.ts",
      "tests/fixtures/memory/blocks-golden/**",
      "tests/fixtures/memory/doctor-golden/blocks-*.json"
    ]
  }
]
```

**P5a ∥ P6b**（`/tmp/36-p5a-p6b.json`）：

```json
[
  {
    "id": "P5a",
    "globs": [
      "src/memory/govern/sweep-plan.ts",
      "src/memory/govern/sweep.ts",
      "src/memory/govern/supersede.ts",
      "src/memory/govern/review-lite.ts",
      "src/memory/index.ts",
      "src/memory/command.ts",
      "src/memory/jev/write-port.ts",
      "src/memory/jev/format.ts",
      "src/memory/jev/review-command.ts",
      "src/memory/jev/expired-command.ts",
      "src/memory/tidy/command.ts",
      "src/memory/tool-v3.ts",
      "tests/memory/govern/sweep-plan.test.ts",
      "tests/memory/govern/sweep.test.ts",
      "tests/memory/govern/supersede.test.ts",
      "tests/memory/govern/review-lite.test.ts",
      "tests/integration/memory-blocks-governance.test.ts",
      "tests/integration/memory-blocks-supersede-race.test.ts"
    ]
  },
  {
    "id": "P6b",
    "globs": [
      "src/memory/govern/audience.ts",
      "src/memory/govern/decay.ts",
      "src/memory/jev/wire.ts",
      "src/memory/jev/predict/select.ts",
      "tests/memory/govern/audience.test.ts",
      "tests/memory/govern/decay.test.ts",
      "tests/memory/jev/wire-recall.test.ts",
      "tests/memory/jev/wire-predict.test.ts",
      "tests/memory/jev/predict/select.test.ts"
    ]
  }
]
```

> 注意：P5a 修改 `tool-v3.ts`（接入取代回显），所以 P4 必须先合入。上面三组以外的包都是串行执行，不需要预检；但每个包开工前仍要 `git status` 确认工作区干净，结束时逐行核对共享文件的 diff。

---

## 2. 全包通用约定

1. **代码规范**：TS strict（`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）；ESM 相对 import 带 `.js`；不在模块作用域放可变状态（I4）；新增定时器一律 `unref()`（I5）——本任务设计上**不新增**任何定时器；所有 deadline 走 `clampSpanMs`。
2. **pi-free**：`src/memory/blocks/**`、`src/memory/govern/**` 不 import `@earendil-works/*`（包括 type import）。`blocks/migrate.ts`、`govern/sweep.ts` 如果需要 ctx/notify，以端口形式注入。
3. **新 golden 只生成一次**：沿用 `UPDATE_MEMORY_GOLDEN` 的模式——环境变量 `PI_TOOLKIT_UPDATE_BLOCKS_GOLDEN=1` 才写入，**文件已存在则拒绝**并报错。录制时机统一为：实现完成 → verifier 人工审阅文本 → 在同一包内录制 → 与实现一起提交。之后不得重录；如需变化，视为行为变化，必须申报。
4. **测试分层**：
   - 新的单测放 `tests/memory/blocks/**`、`tests/memory/govern/**`（tier1，不能含子进程/≥1 s sleep/挂载等词法标记）；
   - 需要真实子进程/多进程并发的测试放 `tests/integration/memory-blocks-*.test.ts`（自动归为 tier2）；
   - **不改 `tests/tiers.ts`**；唯一例外是 P2 把 `tests/secure/memory-gate.test.ts` 加入 `SECURE_MOUNT_FILES`（r2）。
5. **门禁命令**（每包通用，另加各包自己的 targeted 测试）：
   ```sh
   npm run format:check
   npm run typecheck
   npx vitest run tests/governance tests/boundary            # activate-trace 不变 + pi-free
   npx vitest run tests/memory/legacy-golden.test.ts tests/memory/tiered.test.ts tests/memory/doctor.test.ts tests/memory/jev/off-golden.test.ts tests/memory/tool-surface.test.ts
   git diff --stat origin/dev -- tests/fixtures/              # 只允许出现本包声明的新增/申报项
   ```
   **并行期间禁止跑全量 `npm test`/`test:tier1`**（pitfalls-subagent #3），只跑 targeted 文件。全量 `PI_TOOLKIT_TEST_WORKERS=2 npm run test:tier1` 由 verifier 在串行时段执行；涉及 tier2 的包另跑 `npx vitest run tests/integration/memory-*.test.ts tests/conformance/memory-jev-channels.test.ts`。
6. **提交**：
   - 每包一个（或少数几个）Conventional Commit，scope 为 `memory`，例如 `feat(memory): block store core (#36 P1)`；
   - 按精确路径 `git add <file>...`；
   - 申报类变更在 commit 正文写明（§3）；
   - **任务全部完成（P7 验收后）才 push 一次**。
7. **交付报告**（每包写进最终回复，不写入仓库）：改动文件清单、门禁命令输出摘要、新 golden 的 sha256、与 arch 有偏差的点（如有）。

---

## 3. 冻结物处理

| 冻结物                                                                                | 等级                             | 本任务处理                                                                                                                                                                                                                   | 由谁 / commit 正文要点                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/fixtures/memory-legacy-golden.json`                                            | B                                | **不得改**；每包必须通过                                                                                                                                                                                                     | —                                                                                                                                                                                                                                             |
| `tests/fixtures/memory/tiered-golden/*.txt`                                           | B                                | **不得改**（`renderTiered` 不动）                                                                                                                                                                                            | —                                                                                                                                                                                                                                             |
| `tests/fixtures/memory/doctor-golden/current-5.json`                                  | B                                | **不得改**（files 格式 fixture；doctor 按 `effectiveLayout` 分派）                                                                                                                                                           | —                                                                                                                                                                                                                                             |
| `tests/fixtures/memory/jev-off-golden.json`                                           | A′（永不重生）                   | **字节不动**。P0 只在 `settingsFor` 的 `disabled`、`legacy-tool`、`secure-sim`、`pi-api` **四个**配置中显式加 `layout:"tiered"`；**`legacy-layout` 保持 `layout:"legacy"`**（评审 M13）。改完后逐配置跑 `off-golden.test.ts` | P0：`test(memory): pin jev-off harness (4 default-dependent configs) to layout:"tiered" (#36)`。正文写：「默认布局将改为 blocks（2026-11-06 用户裁定 Q2）；参照 legacy-golden A5 先例；legacy-layout 配置不变；golden 字节未变（附 sha256）」 |
| `tests/fixtures/memory-tool-surface.json`                                             | B（只能加 key）                  | P4 **只新增** `blocks`、`blocksJev`、`bytes.blocks`、`bytes.blocksJev`；已有 key 一字节不动                                                                                                                                  | P4：正文写「#36 申报：新增 v3 block 工具表面（用户 2026-11-05 批准 B 级申报式更新）；只新增 key，legacy/v2/jev 字节不变；v3 字节数 N ≤1700」                                                                                                  |
| `tests/fixtures/governance/activate-trace.json`                                       | B                                | **逐字节不变**（trace 也记录 session_start/shutdown 期间的生命周期副作用，不能只凭注册次数判断）。自动迁移和 sweep 在 trace 环境中不得产生任何被记录的调用。出现差异就停下报告 root                                          | —                                                                                                                                                                                                                                             |
| `tests/config/__corpus__/setting-specs-pin.json`、`settings-corpus.json`              | 测试钉                           | 按规则刷新两次：P0（新键、值域）、P5b（layout 默认值翻转）                                                                                                                                                                   | 正文写明新增/变更的键与原因（`memory.residentBytes`、`memory.governance.enabled`、`memory.layout` 值域 + 默认、`memory.jev.predict.model.waitS` 默认 1.0）                                                                                    |
| 新 golden：`tests/fixtures/memory/migrate-golden/**`                                  | **B（契约 golden）**，只生成一次 | P2 录制；之后的变化走申报式更新                                                                                                                                                                                              | 正文附 sha256                                                                                                                                                                                                                                 |
| 新 golden：`tests/fixtures/memory/blocks-golden/*.txt`、`doctor-golden/blocks-*.json` | **B**，只生成一次                | P3 录制（只覆盖与 Jev 无关的渲染/doctor 契约）                                                                                                                                                                               | 正文附 sha256                                                                                                                                                                                                                                 |
| 新 golden：`tests/fixtures/memory/blocks-off-golden.json`                             | **B**，只生成一次                | P5b 在默认值翻转后录制                                                                                                                                                                                                       | 正文附 sha256                                                                                                                                                                                                                                 |
| 其它 A 级 golden（fabric/schedule/reflex/secure/bash/compact/quota…）                 | A                                | 不涉及；收尾时 `git diff --stat origin/dev -- tests/fixtures/` 只允许出现本表列出的变化                                                                                                                                      | —                                                                                                                                                                                                                                             |

**基线录制（P0 第一步，必须在任何代码改动之前完成）**：

```sh
sha256sum tests/fixtures/memory-legacy-golden.json tests/fixtures/memory/tiered-golden/* \
  tests/fixtures/memory/doctor-golden/current-5.json tests/fixtures/memory/jev-off-golden.json \
  tests/fixtures/memory-tool-surface.json tests/fixtures/governance/activate-trace.json
```

把输出贴进 P0 交付报告。之后每个包的 verifier 都要对照：除 `memory-tool-surface.json`（P4 申报）外，以上文件的 sha256 必须保持不变。

---

## 4. 分包详述

> 每个包包含以下几项：**文件域**（新建 / 修改，未列出的文件不许改）、**冻结面**（不得改的东西）、**依赖**、**步骤**、**测试清单**、**门禁**、**验收行**（指 §7 的验收矩阵编号）。

### P0 共享面先行（r2）

- **文件域**：
  - 修改：
    - `src/memory/jev/contracts.ts`：一次性追加 arch r5 §4.4 中的全部字段。
      - InlineMeta 新键：`scope`/`audience`/`supersedes`/`title`/`when`/`clearExpires`/`clearUntil`；
      - `EntryTags.globalP`；
      - review kind 新增 8 个值，含 `legacy-drift`；
      - `DismissedPair.kind/until`；
      - `InjectLayer` 增加 `"R"`；
      - `JevRenderInfo.residentBlocks`；
      - `MemEntry.block`（含 `supersededBy`；**不含** heading——heading 统一走既有字段 `MemEntry.heading`，r3）；
      - `JevWritePort.afterWrite` 追加可选入参 `block`/`askScope` 与可选返回 `relations`，新增 `RelationVerdict` 类型（arch r5 §4.4）。**方法名沿用 `afterWrite`**，`checkInline`/`touchedUserEntries` 签名不变，不新增 `runAfterWrite`；
      - `MemoryInjectDetailsV1.resident?: { snapshotKey; ledger }`（R 层，arch §3.3.5）；
      - `MemoryInjectDetailsV1.predict.bypass`；
      - `PredictCallEntry.windowMs/attempts`。
    - `src/memory/contracts.ts`：新增 `MemoryWriteGate` 类型（arch §4.7）。**不改** `TidyManifestKind`。
    - `src/memory/jev/index-store.ts`：**只改 sanitizer**。
      - `sanitizeEntryTags` 保留 `globalP`；
      - `sanitizeSuggestions` 接受新 kind；
      - `sanitizeDismissed` 接受 `kind/until`；
      - 旧数据逐字节等价。
    - `src/memory/settings.ts`、`src/memory/setting-specs.ts`：
      - `layout` 值域增加 `"blocks"`，**默认仍为 `"tiered"`**；
      - 新增 `migrate.auto`（默认 true）、`residentBytes`（2048，取值 512–16384）、`governance.enabled`（true）；
      - `jev.predict.model.waitMs` 默认改为 1000；
      - 在设置说明中注明 tiered/legacy 专属的键。
    - `tests/config/__corpus__/setting-specs-pin.json`、`settings-corpus.json`；`tests/config/memory-settings.test.ts`。
    - `tests/memory/jev/helpers/off-harness.ts`：`settingsFor` 中 **只有** `disabled`、`legacy-tool`、`secure-sim`、`pi-api` 四个配置显式加 `layout:"tiered"`；**`legacy-layout` 保持 `layout:"legacy"` 原值**（评审 M13）。
    - `tests/boundary/pi-free.test.ts`：新增 `src/memory/blocks/*.ts`、`src/memory/govern/*.ts` 的 pi-free 断言。
    - `tests/memory/jev/contracts.test.ts`、`tests/memory/jev/index-store.test.ts`：只追加用例。
- **冻结面**：
  - jev-off golden 字节：改完 harness 后**逐配置**运行 `off-golden.test.ts`，五个配置全部通过。禁止重录。
  - activate-trace。
  - 旧侧车的读写行为。
- **依赖**：无。
- **步骤**：
  1. 录制 §3 的 sha256 基线；
  2. 改契约；
  3. 改 sanitizer；
  4. 改设置与 specs，刷新 corpus；
  5. 改 harness（四个配置）；
  6. 改 pi-free 测试；
  7. 跑门禁。
- **测试清单**：
  - `memory-settings.test.ts`：
    - 新键的默认值、clamp、非法值回落；
    - `layout:"blocks"` 可以解析，默认仍是 tiered；
    - `migrate.auto` 只接受布尔值。
  - `index-store.test.ts` 追加：
    - `globalP`、新 kind、`dismissed.kind/until` 往返；
    - 没有新字段的旧侧车读入后再写出，逐字节相同；
    - 未知 kind 照旧丢弃。
  - `off-golden.test.ts`：五个配置逐一通过。
  - `setting-specs-pin`、`settings-corpus`。
  - `contracts.test.ts` 追加：`JevWritePort` 的类型级断言——旧调用形式（不传 `block/askScope`）仍可编译；返回值不含 `relations` 时消费方行为不变；`MemEntry.block` 上没有 `heading` 键。
- **门禁**：§2 通用门禁 + `npx vitest run tests/config/memory-settings.test.ts tests/config/setting-specs-pin.test.ts tests/config/settings-corpus.test.ts tests/memory/jev/off-golden.test.ts tests/memory/jev/contracts.test.ts tests/memory/jev/index-store.test.ts`。
- **提示**：P0 之后 `layout:"blocks"` 只是能被解析，还没有实现，严禁写进真实设置。P0 的交付报告需要复述这一点。
- **验收行**：V19（前置）、V24（waitS）、V37（契约与 sanitizer）。

### P1 块存储核心（与 P6a 并行；r3）

- **文件域**：
  - 新建：`src/memory/blocks/{format,naming,rev,store,marker,adapter,state}.ts`、`tests/memory/blocks/{format,naming,store,adapter,state,reader}.test.ts`、`tests/memory/safe-fs-dir.test.ts`（r3）。
  - 修改：`src/memory/safe-fs.ts`——**只新增** `renameDirNoClobber`、`removeTreeNoFollow`、`fsyncDir` 三个导出（arch §4.2.1）。允许为它们新增私有辅助函数；**既有导出与既有私有函数的源码一字节不改**。`MemEntry`/`EntryTags` 的字段已在 P0 中加好。
- **冻结面**：
  - 除 `safe-fs.ts` 的上述新增外，不碰任何现有 `src/memory/*.ts`，也不碰 `tests/fixtures/`；
  - `tests/memory/fs-guard.test.ts` **不改、不放宽**：safe-fs 仍是 `src/memory/**` 唯一 import `node:fs` 的文件，`blocks/**` 的所有 fs 访问都经 safe-fs；
  - safe-fs 门禁：`git diff -U0 <P1 基线>..HEAD -- src/memory/safe-fs.ts | grep '^-[^-]'` 输出为空（只有新增行）。
- **依赖**：P0。
- **步骤**：按 arch §3.2、§4.2、§4.2.1、§4.3.8 实现以下内容：
  - safe-fs 三个目录原语（arch §4.2.1 的逐条规则；EXDEV/ENOTSUP/EPERM/EINVAL 等一律抛错，**禁止**复制降级）；
  - `parseBlockFile`/`serializeBlock`：字段顺序固定，使用单行 KV，复用 `frontmatter.ts` 的解析原语；包含 r5 字段 `heading`、`residue`、`origin`（`origin` 文本形式 `<file>#L<a>-L<b>`）；
  - `BLOCK_NAME_RE`、`ARCHIVE_NAME_RE`、`parseBlockName`、`parseArchiveName`、`canonicalTopic`、`nextSeq`（seq 扫描包含 archive 区的 `.r<n>` 名）；
  - `dirFormat`（r3，arch §3.2.3）：存在 `.blocks-hold` ⇒ held；否则 `<memDir>/blocks/` 是真实目录、同 dev、含 `.layout.json` ⇒ blocks；否则根目录有 v2 合法的 `.md` ⇒ files；否则 ⇒ absent。判定失败 ⇒ files，并记 diag；
  - `state.ts`：`readBlocksState`/`writeBlocksStateLocked`/`readHold`/`writeHoldLocked`（写入用 `writeTempRegular` + `replaceAtomic` + `fsyncDir`；损坏的 hold 视为存在，fail closed）；
  - `toolSurfaceFor`（arch §3.4）与 `LegacyFingerprint`；
  - 所有存储函数的 `realDir` 参数都指 `blocks/` 目录，锁使用 memDir 锁；
  - `effectiveLayout`（arch §3.4 表）；
  - `computeRev`、`isExpired`、`isResident`、`bodyBytes`；
  - `readCorpus`：复用 `listRegular` + `readRegular`；游离文件判定；按 topic 统计 archived；`fingerprint`（arch §3.3.5，只 lstat）；**无锁读者规则**（arch §4.3.8：一次解析布局、固定 realDir、读完复核 dev/ino、中途消失 ⇒ 返回上一次成功结果或空并记一次 warn）；
  - `createBlockLocked`/`replaceBlockLocked`/`trashBlockLocked`：复用 `createExclusive`/`replaceAtomic`，trash 名使用 `newTidyId`（`.trash` 不变式）；`replaceBlockLocked` 继承旧块的 `heading`；
  - `readMarker`：存在但无法解析时返回 `{v:1}`；`BlocksMarkerV1` 含 `source/gen/files`；
  - `topicSummary`：三级降级——标签 → sections → 空（arch §3.3.3）；
  - `blockToEntry`：`heading` 取 `meta.heading`（undefined 时省略该键），`block` 中不含 heading。
- **测试清单**：
  - 解析/序列化往返（所有字段含 heading/residue/origin、未知字段保留策略=丢弃并记 errors、CRLF、BOM）；
  - 1024 B 边界（1024 通过、1025 拒绝；中文按 UTF-8 计）；
  - rev：手改文件字节后 rev 变化；version 不变时 sha 变化导致 CAS 失败；
  - seq：跨 `blocks/`、archive/（含 `quota.007.r1.md`）、.trash/ 取最大值；不回收；
  - `canonicalTopic`：大小写、`_`、非法字符、截到 48 位、为空时返回 undefined；
  - `dirFormat`/`effectiveLayout`：覆盖 arch §3.4 表的全部 12 格，另加「hold 存在且 `blocks/` 仍在 ⇒ held」「`blocks/` 跨 dev ⇒ files」；
  - `isResident`：user+global+active 为真，其余组合为假；agent 带 scope 时被忽略；
  - `topicSummary`：有标签 / 无标签有 section / 两者都没有；
  - **hash 与 heading 对等**：对 `tests/fixtures/memory/current-5` 的每个文件，`splitEntries` 得到的每条 entry → 构造成 block（带 heading）→ 序列化 → 解析 → `blockToEntry`，`hash` 与 `heading` 都必须与原 entry 完全相同；
  - trash 名能被 `listTrashEntries` 识别，并能被 `restoreFromTrash` 恢复；
  - `state.test`：gen 缺失视为 0；写入后重读一致；hold 往返；损坏 hold ⇒ 视为存在；
  - `reader.test`（tier1，用钩子在读取中途 rename `blocks/`）：返回上一次成功结果、warn 只记一次、不读取根目录旧文件；
  - `safe-fs-dir.test`：arch §4.2.1 列出的全部用例（目标已存在含空目录、symlink 源、含 `/` 的名字、注入 EXDEV 后源目录完好且无复制产物、removeTree 遇外部 symlink 只删链接、`maxOps` 截断后续删、`beforeOp` 停止、`fsyncDir` 失败抛错）。
- **门禁**：§2 + `npx vitest run tests/memory/blocks tests/memory/safe-fs-dir.test.ts tests/memory/fs-guard.test.ts tests/boundary/pi-free.test.ts` + 上面的 safe-fs 只增不改检查。
- **验收行**：V01、V02（存储层）、V33（heading 部分）、V43。

### P6a 注入修复（不依赖块；与 P1 并行）

- **文件域**：
  - 修改：`src/memory/jev/predict/flight.ts`、`src/memory/jev/predict/select.ts`、`src/memory/jev/wire.ts`（只改 `recallE` 入口、P 选择调用 bypass、`appendPredictCall` 增加 windowMs/attempts 字段）、`tests/memory/jev/predict/flight.test.ts`、`tests/memory/jev/predict/select.test.ts`、`tests/memory/jev/wire-recall.test.ts`、`tests/memory/jev/wire-predict-model.test.ts`。
  - 新建：无。
- **冻结面**（r3，裁定 10）：jev-off golden；activate-trace。X1–X3（§5.1）是用户已批准的行为变化，不在字节不变范围内；其余面用 §5.2 的开关差分证明——**model-off 差分**：同一场景跑「model on 但调用被拒、无结果」与「model off」，P 层输出逐字节相同，且 model off 时没有 flight、没有 `kind:"call"`；**predict-off 差分**：与新代码去掉 P 层的输出逐字节相同。基线都是新代码，不是 HEAD 字节。
- **依赖**：P0（契约字段、waitS 默认值）。
- **步骤**：
  1. `attemptBudgetMs(budget, remaining, isLastAttempt)`：最后一档直接用 `remaining`（arch §6.5）。外层 race 宽限、zombie、breaker 都不变。
  2. `recallE`：`tool ∈ {read,grep,ls,find}` 时直接 return，并且不计入 `errorAsks`；其它工具剔除「标签全部属于 risk:high 动作类，且与 `hitTags` 无交集」的块（arch §6.3）。
  3. `select.ts`：增加高危 tag 冷却饿死出口（arch §6.4）：score ≥0.85 且 `TagDef.risk==="high"`；候选全部被冷却挡住，且不在 segment 中、也不是 static；每轮最多 1 条；同一块每个 segment 最多 1 条；details 记 `predict.bypass:true`。
  4. `kind:"call"` 追加 `windowMs`、`attempts`。
- **测试清单**：
  - `flight.test`：单模型链拿到全部 3000 ms（假时钟下第 2000 ms 返回 ⇒ ok）；双模型链第一档仍按 1500 ms 截断再 failover；zombie/breaker 用例不回归；
  - `wire-recall`：read/grep/ls/find 失败 ⇒ 零 E 注入、`errorAsks` 不增加；bash 删除失败时仍注入删除类条目；bash 非删除失败时不注入「删除只用精确路径」类条目；
  - `select.test`：饿死出口命中 / 不命中（候选在 segment 中、是 static、score 0.84、非高危 tag）；
  - `wire-predict-model`：call 记账包含 `windowMs/attempts`；model-off 差分成立（§5.2，r3）。
- **门禁**：§2 + `npx vitest run tests/memory/jev/predict tests/memory/jev/wire-recall.test.ts tests/memory/jev/wire-predict.test.ts tests/memory/jev/wire-predict-model.test.ts`。
- **G3 离线门禁**（arch r5 §7.4，8 个确定性用例：1、2、3a 承接短语全权重、3b 普通新指令 0.6 封顶、3c cancel 丢弃、4、5、6；假时钟；3a–3c 直接导入 `PENDING_CAP_P`/`isCarryPhrase`，不复制常量）写进 `tests/memory/jev/wire-predict-model.test.ts`，必须 8/8 通过。
- **验收行**：V24、V27、V28、V38（G3）。

### P2 迁移器 + 写闸门（r3 重写；与 P3 并行）

- **文件域**：
  - 新建：
    - `src/memory/blocks/migrate-plan.ts`、`src/memory/blocks/migrate.ts`、`src/memory/blocks/legacy.ts`（漂移指纹与导入）；
    - `src/secure/memory-gate.ts`（`secureMemoryWriteGate`）；
    - `tests/memory/blocks/{migrate-plan,migrate,rollback,legacy-import,write-gate}.test.ts`；
    - `tests/memory/jev/index-store-blocks.test.ts`；
    - `tests/integration/memory-blocks-migrate.test.ts`、`tests/integration/memory-blocks-rollback-race.test.ts`（r3）；
    - `tests/secure/memory-gate.test.ts`；
    - `tests/fixtures/memory/migrate-golden/**`。
  - 修改：
    - `src/memory/jev/index-store.ts`：块布局侧车路径 `blocks/.jev/` 与精确 GC（arch §3.2.5）；
    - `src/memory/index.ts`：
      - `session_start` 内的自动迁移（主会话、layout=blocks、`migrate.auto`、files、闸门）以及回滚续做（arch §4.3.5 第 1 步）；
      - 接收 `writeGate` 选项；
      - `onAfterWrite` 增加 `origin` 参数，并按有效布局选择失效分支；
    - `src/memory/command.ts`：`/mem migrate [--dry-run|--all|--report|--status|--import-legacy|--rollback]`；`/mem` 的描述字符串按布局分派（非 blocks 布局与原字符串逐字节相同）；
    - `src/index.ts`：**只增加一行装配**——把 `writeGate: secureMemoryWriteGate(secureDomain)` 传给 `wireMemory`；
    - `tests/tiers.ts`：**只把 `tests/secure/memory-gate.test.ts` 加入 `SECURE_MOUNT_FILES`**，这是本任务对该文件的唯一一次修改。
- **冻结面**：
  - **P2 提交范围内** `src/memory/tidy/**` 与 `src/memory/safe-fs.ts` 零 diff（门禁：`git diff --stat <P2 基线>..HEAD -- src/memory/tidy src/memory/safe-fs.ts` 为空，`<P2 基线>` = P2 开工时的 HEAD）。P2 只**调用** P1 新增的 `renameDirNoClobber`/`removeTreeNoFollow`/`fsyncDir`，缺能力时报告 root，不得自行改 safe-fs。`tidy/command.ts` 之后由 P5a 做唯一一处改动（见 P5a），不受本条约束；
  - `tests/memory/fs-guard.test.ts` 不改：`blocks/**`、`secure/memory-gate.ts` 之外的新代码同样不得直接 import `node:fs`（`secure/` 不在 fs-guard 范围内，但 memory-gate 只读 mountinfo，复用 `src/secure/domain.ts` 的函数）；
  - legacy / tiered / doctor / jev-off golden；
  - activate-trace：迁移挂在**已有的** session_start handler 里，在目录不存在时不能产生任何被 trace 记录的调用。
- **依赖**：P1（含 safe-fs 三个目录原语与 `blocks/state.ts`）。
- **步骤**：
  1. `planMigration`：按 arch §4.3.2 的 1–9 步实现，**第 4 步按 r5**：先判定整文件权威是否一致；一致才允许 whole 兜底；混合权威文件拆分条目，未覆盖片段各生成残留块（`authority: agent`、`residue: true`、`origin`），报告 `residue[]` 与 `files[].mixedAuthority`；`heading` 写入 frontmatter。
  2. 使用 P1 的 `blocks/state.ts`（`readBlocksState`/`writeBlocksStateLocked`/`readHold`/`writeHoldLocked`），写函数只在迁移锁内调用。
  3. `runMigration`（arch §4.3.3）：
     - 临界区 1：hold/blocks 检查 → 读 `gen0` → 快照 → 清理协议 → mkdir 暂存区 + 写 `owner.json`；
     - 锁外构建：每个 mkdir/write/fsync 前 `gate.check`；最后写含 `gen`/`files` 的 `.layout.json`；
     - 临界区 2：五项复核（hold 不存在、gen 未变、`blocks/` 不存在、源 sha 未变、owner runId/pid/startTicks 与清单逐一核对）→ gen+1 → unlink owner.json → `renameDirNoClobber` → `fsyncDir`；
     - rename 抛错（EXDEV/不支持/身份变化）⇒ fail closed，**禁止**任何复制或逐文件 rename 的降级实现。
  4. 清理协议（arch §4.3.3「清理」）：候选名精确正则；owner 分类（本进程 / 已确认死亡 / 其它一律不动）；锁内 `renameDirNoClobber` 到 `.<name>.trash-<runId>` 后 `removeTreeNoFollow`（≤500 op，`beforeOp` 内检查闸门、预算、abort）；**不读取 mtime、不按年龄判定**。
  5. 预算（arch §4.3.4）：一个 deadline + 一个操作计数器覆盖全部阶段；锁外每 32 op 检查并 `await setImmediate`；锁内只检查不让出；超预算 ⇒ 隔离本 run 暂存区、`overBudgetStreak+1`；成功 ⇒ 归零。
  6. 回滚 `--rollback`（arch §4.3.5）：gen+1 → 写 hold（`rollback.done:false`）并 fsync → rename → 改写 hold `done:true`；续做逻辑；显式 `/mem migrate` 先续做再 gen+1、删 hold。
  7. 漂移检测与 `--import-legacy`（arch §4.3.6）；`--status` 增加 `gen`、`overBudgetStreak`、`hold`（含 rollback 是否完成）。
  8. 写闸门：实现 `secure/memory-gate.ts`，在 `src/index.ts` 装配；**逐操作复检**（arch §4.7，fd 方案不可行）；自动路径不调用 `ensureMemoryDir`；显式路径建目录后立即 `gate.capture(memDir)`。
  9. 块侧车与精确 GC；`index.ts`、`command.ts` 接线。
- **测试清单**：
  - **migrate-golden**（B 级，只生成一次），输入覆盖 r1 的全部用例，另外包括：
    - 权威一致的文件含独立 fenced code ⇒ 整文件一个 whole 块 + oversize 建议；只有代码块的文件；拆出零条目但正文非空的文件；
    - **混合权威**（r3）：① `source: agent` 文件含 `mem user` 条目 + 独立 fence ⇒ user 条目成 user 块、其余 agent 条目成 agent 块、fence 成残留块；② 手写默认 user 的文件含 `mem lesson` 条目 + 未覆盖片段 ⇒ 同理；断言没有任何块取了「文件默认权威」，报告 `residue[]` 逐条列出 origin；
    - 带 H1/H2/H3 嵌套标题 ⇒ frontmatter `section`/`heading` 正确，H1 写入报告；
    - `MEMORY.md` 不拆分、不生成块，报告标「保留在旧布局」。
  - `migrate.test`：
    - 每个崩溃点（建暂存区、构建中、构建完未提交、gen 已 bump 未 rename、rename 后收尾前）都模拟进程退出，再由**独立进程**调用 `dirFormat` + 渲染：只能看到完整的旧布局或完整的新布局；重启后状态收敛；
    - 提交复核五项逐项反例：hold 出现、gen 变化、`blocks/` 已存在、源文件被改、owner.json runId 被替换 / 清单多一个文件 / 少一个文件 / 某文件 sha 不同 / 出现 symlink ⇒ 均不提交并隔离暂存区；
    - `renameDirNoClobber` 注入 EXDEV ⇒ 目录仍为 files、暂存区原样、没有任何复制产物、`lastOutcome:"aborted"`；
    - 清理：本进程旧 run 的暂存区被清；owner pid 不存在 ⇒ 清；pid 存在但 startTicks 不同 ⇒ 清；bootId 不同 ⇒ 清；owner 活着 ⇒ 不动；owner.json 缺失 ⇒ 不动且 D25；暂存区 mtime 改到 10 年前且 owner 活着 ⇒ 仍不动（证明不看年龄）；暂存区里放指向外部目录的 symlink ⇒ 只删链接；
    - 预算：2001 个源文件 ⇒ 不建暂存区；操作数超限 / deadline 超限 ⇒ 放弃、目录不变、`overBudgetStreak` +1，连续 3 次 ⇒ D25；锁外循环确有 `setImmediate` 让出（用假 `setImmediate` 计数）；
    - shutdown 时中止；已迁移目录再跑是 no-op；`.layout.json` 含 `gen` 与完整 `files`；
    - **根目录旧文件的 sha256 迁移前后完全相同**；
    - **无锁读者**（arch §4.3.8）：读取过程中把 `blocks/` rename 走 ⇒ 本次返回上一次成功结果并记一次 warn，不混读根目录旧文件。
  - `rollback.test`：
    - 正常回滚后 `dirFormat=held`，渲染与 HEAD 的 tiered 一致；`.blocks-rolledback-*` 完整保留迁移后新写的块；
    - **每个回滚边界的崩溃**：gen 已 bump 未写 hold ⇒ 仍是 blocks、可用；hold 已写未 rename ⇒ held，下次 session_start 续做 rename；rename 后未写 `done` ⇒ held，续做；
    - 显式 `/mem migrate` 先续做再清 hold、gen+1，之后可再次迁移，旧 rolledback 目录不动；
    - 回滚承诺：迁移后用 v2 往根目录 `core.md` 追加一行，再回滚 ⇒ 读到的是含追加行的当前旧布局（测试注释写明：迁移前原始字节靠 P8 tar，不由回滚保证）。
  - `legacy-import.test`：漂移检测；导入只新建 hash 不存在的块；重复导入幂等；中断后重跑；台账正确追加；旧文件不变。
  - `write-gate.test`（tier1，伪造 mountinfo）：
    - plain ⇒ ok；locked ⇒ 拒绝；secure 下挂载消失、路径越界、dev/ino 变化 ⇒ 分别拒绝；
    - 自动路径在闸门拒绝时零写入、不 mkdir memDir；
    - **构建期 mount-loss**（伪造）：第 k 个操作前把 mountinfo 切换为未挂载 ⇒ 第 k 个及之后零写入；
    - 显式建目录后未 capture 之前，自动路径 `check` 返回 `identity-changed`；capture 后放行。
  - `index-store-blocks.test`：同 hash 多块删一保留；最后一块删除后 GC；冷却表与建议同步剪除；过期 dismiss 修剪；旧侧车不受影响。
  - **integration** `memory-blocks-migrate.test.ts`（tier2）：
    - 两个子进程同时 session_start ⇒ 只迁移一次；
    - **旧版真实路径**：用 HEAD 版本的 `tool-v2` 模块（从 `git show HEAD:src/memory/tool-v2.ts` 物化到临时目录加载；加载成本过高时用当前 v2 工具并把 `layout` 设为 tiered 模拟旧会话），对 `blocks/general.001.md` 执行 str_replace/insert/append/create ⇒ 全部因非法文件名被拒，块文件字节不变；对根目录 `core.md` 执行 append ⇒ 成功 ⇒ 新代码报告漂移；
    - 旧 v2 对根目录的写入与 v3 对块的 update 并发 ⇒ 互不影响。
  - **integration** `memory-blocks-rollback-race.test.ts`（tier2，r3）：
    - **A 构建 → B 提交并回滚 → A 尝试提交**：A 在构建完成后用屏障暂停；B 完整迁移并 `--rollback`；放行 A ⇒ A 的提交复核失败（hold 存在 / gen 变化），目录保持 held，A 的暂存区被隔离；再让用户清 hold 后重放 A 的提交 ⇒ 仍因 gen 不符失败；
    - **活 owner 被暂停 + 他人清理/提交交错**：A 建好暂存区后 `SIGSTOP`；B 执行清理与完整迁移 ⇒ A 的暂存区原样保留（owner 活着）；`SIGCONT` A ⇒ A 提交时发现 `blocks/` 已存在，放弃；之后 B 的下一次清理（A 已退出）才删除它；
    - 第三种交错：A 暂停期间 B 判定 A 已死（模拟 startTicks 不同）并隔离 ⇒ A 恢复后提交复核第 5 条失败，不会 rename 一个被隔离的目录。
  - **secure**：`tests/secure/memory-gate.test.ts`（真实挂载）：
    - sweep 进行中卸载 vault ⇒ 之后零写入，且明文底层没有新建目录；
    - **构建阶段卸载 vault** ⇒ 构建停止、零后续写入、明文底层无 `blocks/` 或暂存区；
    - **gocryptfs 上的目录提交**：在已挂载 vault 内完成一次迁移（暂存区 → `renameDirNoClobber` → `blocks/`）与一次回滚，断言成功且原子；
    - locked 会话 session_start ⇒ 不迁移；`--all` 只遍历 `<state>/memory`。
  - 命令：`--dry-run` 不写盘；`--all` 只处理 files 目录；`--status` 输出字段正确；非 blocks 布局下 `/mem` 描述逐字节不变。
- **门禁**：
  - §2 门禁；
  - `npx vitest run tests/memory/blocks tests/memory/jev/index-store.test.ts tests/memory/jev/index-store-blocks.test.ts tests/memory/fs-guard.test.ts`；
  - `npx vitest run tests/integration/memory-blocks-migrate.test.ts tests/integration/memory-blocks-rollback-race.test.ts`；
  - `PI_TOOLKIT_TEST_WORKERS=1 npm run test:secure`（独占机器，挂载表干净）；
  - `npx vitest run tests/governance/test-tiers.test.ts`；
  - `git diff --stat <P2 基线>..HEAD -- src/memory/tidy src/memory/safe-fs.ts` 为空。
- **交付后的主会话动作**（属于 P8 暂停措施的第一步）：P2 合入后，按 §8 第 3 步把 `memory.migrate.auto` 设为 false 并验证。
- **验收行**：V05、V10、V13、V14、V15、V18、V30、V31、V32、V33、V35、V40、V41、V42、V45。

### P3 渲染、静态判定、常驻账本与 eligibility（r3；与 P2 并行）

- **文件域**：
  - 新建：
    - `src/memory/blocks/render.ts`（含 `renderBlocks`、`parseResidentSection`）；
    - `src/memory/govern/eligibility.ts`；
    - `tests/memory/blocks/{render,doctor-blocks,inject-blocks,hub-wiring}.test.ts`；
    - `tests/memory/govern/eligibility.test.ts`；
    - `tests/fixtures/memory/blocks-golden/*.txt`、`tests/fixtures/memory/doctor-golden/blocks-*.json`。
  - 修改：
    - `src/memory/inject.ts`：
      - 按有效布局分派；
      - render cache 指纹加入本地日期（只在 blocks 分支）；
      - `renderExternalMemoryBlock` 在 blocks 布局下走 `renderBlocks`；
      - 向 `onRender` 回调额外提供本次渲染的常驻 `Map<id, renderKey>`（供 R 层计算 `want`，不改 legacy/tiered 分支的回调参数）；
    - `src/memory/doctor.ts`：D20–D25；blocks 目录下 D01/D02/D09 不报；D17 只统计 user；
    - `src/memory/init-command.ts`；
    - `src/memory/jev/wire.ts`：
      - `isStaticCore` 增加 blocks 分支：`info.residentBlocks.includes(entry.block?.id ?? "")`；
      - `entryAnchor`；
      - **常驻账本与 R 层**（arch §3.3.5）：新增可选依赖 `getSectionSnapshot?: () => { snapshot: string | undefined; stale: boolean } | undefined`；每轮 `before_agent_start` 按 `(corpusFingerprint, today, snapshotKey)` 判定是否重算；snapshot = `parseResidentSection(snapshotText)`；ledger 在 snapshotKey 变化时重置，resume/reload/tree 后从分支上 `details.resident.snapshotKey` 相同的最近一条 R 消息恢复；`want` 与 ledger 差分出「新增 / 已变更（含到期标注变化）/ 已移除」；发出后更新 ledger 并写入 `details.resident`；`JevRenderInfo.residentBlocks = ledger 的 id`；
      - 依赖缺失（P4 接线之前）⇒ snapshotText 取本轮 provider 输出；此时 blocks 布局尚未进入生产（默认值在 P5b 才翻转），不影响真实会话；
      - **eligibility 接入**：U/A/E/P/B/S 在「选择时」和「提交时」各调用一次 `eligible(…, {ledger})`；
      - **异步结果**：U/E/P 候选选择时记录块 rev，提交时 rev 不同 ⇒ 丢弃该项；
    - `src/memory/jev/entries.ts`：`EntryIndex` 增加 blocks 分支；
    - `tests/memory/jev/wire-recall.test.ts`、`tests/memory/jev/entries.test.ts`：只追加用例。
- **冻结面**：
  - `tiered.ts` 不改；
  - `src/sysprompt/**`、`src/prompt-sections/**` **不改**。snapshot 通过 `PromptSectionHub` 已有的 `_state(name)` 成员读取；hub 接线测试直接使用真实 `createPromptSectionHub`；
  - `src/memory/index.ts` 不改（P2/P4 串行持有；生产接线 `getSectionSnapshot` 在 P4 完成）；
  - tiered / legacy / doctor(current-5) / jev-off golden；
  - activate-trace。
- **依赖**：P1。
- **步骤**：
  1. 实现 `renderBlocks`（arch §3.3.3，常驻行格式 `- [<id>] …`）与 `parseResidentSection`。常驻区的受众过滤**只看 frontmatter**，所以渲染结果不依赖 Jev/P6b。
  2. 实现 `eligible`（arch §3.3.6，`ledger` 参数）。`effectiveAudience` 的 Jev 推导部分在 P6b 补上，P3 先预留一个 `audienceOf` 参数，默认只看 frontmatter。
  3. 修改 `inject.ts`：分派、render 回调、external renderer。
  4. 修改 doctor 与 init。
  5. 修改 wire：静态判定、snapshot/ledger/R 层、两次校验、异步 rev 丢弃。
  6. 修改 entries。
- **golden 范围（评审 m17）**：P3 只录制**与 Jev 无关**的渲染契约，即常驻区 + 索引 + doctor。受众推导、降权只影响 Jev 消息，不进入这些 golden。所以 P6b 不会改动 P3 的 golden。
- **测试清单**：
  - **blocks-golden**（B 级，只生成一次），共 g1–g10：
    - g1 正常（3 条 global、17 个主题，常驻行带 `[id]`）；
    - g2 常驻超额（全部渲染，带标记行）；
    - g3 到期 global（带标注）+ 到期 agent（不进入常驻区，计入 expired）；
    - g4 子会话（frontmatter 为 `audience:main` 的块被滤掉）；
    - g5 没有标签时的 sections 摘要；
    - g6 只有计数；
    - g7 compact 溢出；
    - g8 没有 global；
    - g9 `childProfile:none`；
    - g10 superseded 不出现。
  - `render.test`：`parseResidentSection(renderBlocks(x))` 的 id 集合等于 x 中常驻块集合；正文以 `- ` 开头、多行、含 `- [` 字样的正文都能正确切分；标注变化 ⇒ renderKey 变化。
  - **hub-wiring**（生产 hub）：矩阵为 {stable 不变、变化 1/2/3 次、第 4 次 ⇒ POINTED、mode live} × {freeze on/off} × {resume、reload(exact)、tree、压缩、跨午夜、另一进程写入（直接改 `blocks/` 文件，不走本会话失效回调）}。每格断言：
    1. `snapshot` 等于 `parseResidentSection(hub._state("pi_project_memory").snapshot)`；
    2. 该轮结束后 `ledger` 等于 `want`（模型可见的 snapshot + 已发 R 通知覆盖每个应常驻块的当前 renderKey，无遗漏）；
    3. `residentBlocks` 等于 ledger 的 id 集合；
    4. 跨午夜仅到期标注变化 ⇒ 恰好一条「已变更」通知；
    5. resume/reload 之后 ledger 从 R details 恢复，已通知过的项不重复通知；snapshotKey 变化（压缩、live 每轮）⇒ ledger 重置为新 snapshot；
    6. 另一进程写入 ⇒ 下一轮 `before_agent_start` 即被发现（corpus 指纹变化）。
  - **eligibility**：七个层（U/A/E/B/P/S/R + external）× {到期 agent、superseded、受众不匹配、已在 ledger 的 global、私密} 反例。另外覆盖**异步状态变化**：U/E 判定等待期间块被 update（rev 变）、取代、删除或降级 ⇒ 提交时该项被丢弃，且本轮不注入新内容；B 层重注时块已被取代 ⇒ 丢弃。
  - 跨午夜（假时钟）。
  - `inject-blocks`：files 目录 + tiered ⇒ 与 `renderTiered` 逐字节相同；blocks 目录 + tiered ⇒ blocks 渲染 + D24；external renderer 在 blocks 布局下输出常驻区 + 索引。
  - `doctor-blocks` + doctor-golden `blocks-*.json`（含 D25 三种条件）。
  - `wire-recall`：ledger 中的常驻块不进入 U/A/E/P/B；topic 用户令是候选；anchor 为块 id。
  - `entries`：entry 数等于块数；`entry.heading` 等于块 frontmatter 的 heading。
- **门禁**：§2 + `npx vitest run tests/memory/blocks tests/memory/govern tests/memory/inject.test.ts tests/memory/inject-jev.test.ts tests/memory/doctor.test.ts tests/memory/doctor-jev.test.ts tests/memory/jev/wire-recall.test.ts tests/memory/jev/entries.test.ts tests/sysprompt`。
- **验收行**：V06、V07、V09、V12、V20、V25、V34、V36。

### P4 工具 v3 + 写入路径

- **文件域**：
  - 新建：`src/memory/tool-v3.ts`、`src/memory/normalize-v3.ts`、`src/memory/govern/snapshot.ts`、`tests/memory/tool-v3.test.ts`、`tests/memory/tool-v3-jev.test.ts`、`tests/memory/govern/snapshot.test.ts`、`tests/integration/memory-blocks-user-rule-direct.test.ts`。
  - 修改：
    - `src/memory/tool-surface.ts`：**只新增** `MemoryToolParamsV3`、`MEMORY_TOOL_V3_TEXT`、`MEMORY_TOOL_V3_TEXT_JEV`；
    - `src/memory/tool-v2.ts`：blocks 目录写命令报 `E_BLOCKS_DIR`；导出复用的辅助函数，不改其行为；
    - `src/memory/index.ts`：layout=blocks 时注册 v3 工具；**注册次数和名字不变**，activate-trace 不变；把 `getSectionSnapshot` 传给 `wireJev`（r3）；
    - `tests/memory/blocks/hub-wiring.test.ts`：只追加生产装配用例（r3）；
    - `src/memory/jev/entries.ts`：`parseInlineMeta` 新增 `scope/audience/supersedes/title/when/expires=none/until=none`；
    - `src/memory/jev/write-port.ts`：blocks 分支——compare 池按矩阵构造（只产出判定结果，**不执行取代**，执行在 P5a）；user 块无显式 scope 时加问 `g1`；写入 `globalP`；
    - `src/memory/jev/questions.ts`：新增 `g1` 问句构造；
    - `src/memory/jev/format.ts`：新增回显行，包括 created/updated 首行、budget、scope、resident、state snapshot、audience、ignored；
    - `tests/memory/tool-surface.test.ts`；
    - `tests/fixtures/memory-tool-surface.json`（只加 key）；
    - `tests/memory/jev/{write-port,format,questions,entries}.test.ts`（只追加用例）。
- **冻结面**：
  - `memory-tool-surface.json` 已有 key；
  - v2 的行为与回显（`tool-v2*.test.ts` 全绿、jev-off golden）；
  - activate-trace；
  - #26 判定域语义（直接写入 + voided + 通知 + CAS/abort）。
- **依赖**：P1、P2（`index.ts` 串行；目录格式与迁移）、P3（预算回显用渲染端口、entries.ts 串行）。
- **步骤**：
  1. 实现 schema 和文本，实测字节数 ≤1700。
  2. 实现 `normalizeV3`：旧命令 → `E_UNSUPPORTED_COMMAND`，并在 diag 记 `unsupported:<cmd>`；`action:"list"` 按 view 处理。
  3. 实现 `tool-v3` 五个命令（arch §4.1.2–4.1.4）：
     - 合并规则为继承 + 覆盖；
     - 服务端字段一律忽略；
     - user 块的改写/删除/降权、模型把 global 降为 topic，都进入 #26 判定域；
     - 从不自动升级为 global。
  4. 实现 `snapshot.ts`（arch §5.3 正则集合）。
  5. write-port 与 questions 接入 `g1`。
  6. format 回显。
  7. 录制 golden（只新增 key）。
- **测试清单**：
  - `tool-surface.test`：v3 / v3jev 的字节数、canonicalJson 与新 key 一致；已有 key 不变；jev 变体只替换 description。
  - `tool-v3.test`，`E_*` 全矩阵：
    - `E_TOO_LARGE`：1025 B，以及遗留超限块 update 后仍然超限；
    - `E_CONFLICT`：手改字节 / 并发 update；
    - `E_REV_REQUIRED`、`E_UNSUPPORTED_COMMAND`（每个旧命令）、`E_UNMIGRATED`、`E_READONLY`（子会话）、`E_BAD_TOPIC`。
  - 元数据合并：
    - 漏写 `mem user` 时权威不降级；漏写 scope 时 global 不变成 topic；`expires=none` 能清除；
    - 显式 `scope=global` 生效；
    - **没有任何路径会把 topic 自动变成 global**：分类器 `globalP=0.99` 时也只出回显。
  - `state snapshot`：命中 agent 块时有回显；user 块永不出现；写入照常成功。
  - `tool-v3-jev.test`：
    - `g1` 只对没写 scope 的 user 块询问，并且和打标合并为同一次 askAll；
    - `globalP ≥0.7` 时出回显，<0.7 时不出；
    - jev off 时不问也不提示。
  - integration `memory-blocks-user-rule-direct`（tier2，镜像现有 `memory-user-rule-direct`）：改写或删除 user 块，以及模型把 global 降为 topic，都是直接写入 + voided 回显 + TUI warning，无确认。
- **门禁**：§2 + `npx vitest run tests/memory/tool-surface.test.ts tests/memory/tool-v3.test.ts tests/memory/tool-v3-jev.test.ts tests/memory/tool-v2.test.ts tests/memory/tool-v2-jev.test.ts tests/memory/tool-v2-jev-guard-direct.test.ts tests/memory/govern tests/memory/jev/write-port.test.ts tests/memory/jev/format.test.ts tests/memory/jev/questions.test.ts` + `npx vitest run tests/integration/memory-blocks-user-rule-direct.test.ts tests/integration/memory-user-rule-direct.test.ts`。
- **验收行**：V02、V03、V04、V11、V22、V29。

### P4 工具 v3 + 写入路径（r2 补充）

- 文件域、步骤、测试沿用 r1。**新增**：
  - 修改 `src/memory/jev/tagging.ts`：`tagOne`/批量打标的入参增加 `askScope: boolean`。`write-port` 只在「写入的块为 user 且没有显式 scope ∧ jev full」时传 true。
  - 调用链（r3，名称以 arch r5 §4.4 为准）：`tool-v3` 写盘成功、释放锁之后 → `jevWritePort.afterWrite({…, block: {id, rev, authority, scopeExplicit}, askScope})` → `write-port.ts`（`input.block` 存在时用 `blockToEntry` 取 entry，compare 池按矩阵构造）→ `tagging.tagOne({…, askScope})` → `questions.buildTagQuestions(entry, taxonomy, compare, { includeScope: askScope })`。`g1` 与打标问句在**同一次** `askAll` 中发出，答案写入 `EntryTags.globalP`；relation 判定结果经返回值 `relations` 交回 tool-v3。
  - `askScope = block.authority === "user" ∧ !block.scopeExplicit ∧ jev full`。
  - **R 层生产接线**（r3）：在 `src/memory/index.ts` 调用 `wireJev` 处追加依赖 `getSectionSnapshot: () => { const s = opts.sections._state("pi_project_memory"); return s && { snapshot: s.snapshot, stale: s.stale }; }`。测试：`tests/memory/blocks/hub-wiring.test.ts` 追加一个经 `wireMemory` 完整装配的用例（只追加），断言生产路径下 ledger 与 hub snapshot 一致；activate-trace 不变。
  - 测试补充 `tests/memory/jev/tagging.test.ts`（只追加用例）：
    - `askScope=false` 时问句集合与现状逐字节相同；
    - `askScope=true` 时恰好多出 `g1`。
- v3 写入前在锁内调用 `memoryWriteGate.check`（arch §4.7）。
- 取代：P4 只产出判定与候选的 rev（arch §5.4 中的「判定」），**不执行**取代；执行在 P5a。
- **验收行**追加：V11、V29。

### 2026-11-07 用户新裁定：仅完整取代才自动（#36 小范围续包）

- 新块整体覆盖或明确废弃旧块全部有效信息才可自动取代；部分冲突保留旧块 active 并给建议。`duplicate` 也必须定向「新含旧全部有效信息」，新子集不合格；partial overlap/conflict 属于 conflict/complementary。
- `supersede` 非 explicit 拒绝所有非 supersedes kind；write-port `auto` 仅 supersedes 高 p 且未超 cap。conflict ≥ SUGGEST_P 仍回显建议；旧 authority/CAS/cycle/residue/dismissed/MAX2 与显式路径完全不扩展。
- `JevWritePort.afterWrite` 顶层、`TagOneInput` 与 builder opts 追加可选 `wholeRelation?:boolean`。tool-v3 自动 afterWrite 仅 governance on 传 true，off 不传；blocks write-port 传播给 tagOne，后者组合独立的 includeScope/wholeRelation。只有 wholeRelation===true 改 cN criteria；legacy/off/v2 问句原字节、g1 与 bulk/v2 callers/wire/jev-eval 不变。
- 生产无 cN 答案缓存：write-port 正文变更 fresh tagOne，decideTagging 不落 cN、client.callOnce 直接 classify（详见 arch §4.4 接线后的缓存核证）。完整 question 文本使评测完整请求 replyKey 自然失效，不清私有缓存、不 bump taxonomyRev、不全量 retag。
- G1 正例限完整取代，真实正例 10 < 20 仍 block；不补样本、不做 live、不迁移，不新增后台任务或历史恢复。以下旧 P5a/PG 步骤保留历史，冲突自动条件以上述新裁定为准。

### P5a 治理核心（r2；不碰 wire.ts；与 P6b 并行）

- **文件域**：
  - 新建：`src/memory/govern/{sweep-plan,sweep,supersede,review-lite}.ts`、`tests/memory/govern/{sweep-plan,sweep,supersede,review-lite}.test.ts`、`tests/integration/memory-blocks-governance.test.ts`、`tests/integration/memory-blocks-supersede-race.test.ts`。
  - 修改：`src/memory/index.ts`、`src/memory/command.ts`、`src/memory/tidy/command.ts`、`src/memory/jev/review-command.ts`、`src/memory/jev/expired-command.ts`、`src/memory/jev/write-port.ts`、`src/memory/jev/format.ts`、`src/memory/tool-v3.ts`。
  - **`src/memory/tidy/command.ts` 的唯一改动**（r3，裁定 13）：在 `/mem tidy` 命令入口最前面加一个判断——当前 cwd 的 `dirFormat === "blocks"` ⇒ 直接返回提示文本 `memory: /mem tidy is disabled for block-layout directories — use /mem review`（不做任何 fs 写入），否则原路径一字节不变。除这一处分支外，`tidy/**` 不得有其它 diff（verifier 逐行核对）。
  - 阈值常量：`src/memory/govern/supersede.ts` 导出 `SUPERSEDE_AUTO_P = 0.85`、`CONFLICT_AUTO_P = 0.90`（2026-11-07 起仅历史 cutoff，不参与自动判定）、`AUTO_PER_WRITE_MAX = 2`，其它文件不得出现这些字面量（PG 调参时只改这里，见 PG）。
- **冻结面**：`jev/wire.ts`（不得修改）、activate-trace、files 目录行为、各既有 golden。
- **依赖**：P2、P4。
- **步骤**：
  1. `planSweep`：按 arch §4.5、§5.2 实现。**任何 user 块都不进入 archive**；生成 `legacy-drift` 提醒与建议。
  2. `runSweep`：
     - 单次 ≤50 个操作、≤1000 ms；锁等待 500 ms，拿不到锁就放弃本轮；
     - 归档（r3，arch §4.5）：锁内复核 rev；存储名 `<id>.md`，冲突时 `<id>.r<n>.md`（n 取 1–999 最小未占用）；**先**写 `blocks/archive/index.json`（存储名 → 原 id）**再** rename，最后改 `status: archived`；index 中存储文件不存在的记录在下次 sweep 锁内删除；
     - 自己写入后以 `origin:"sweep"` 屏蔽自触发；
     - 用 `sweepInFlight` 防重入，运行期间到达的信号合并为一个 `pending`；
     - 无进展保护；
     - AbortSignal 中止；
     - 每个操作都过写闸门。
  3. `supersede`：按 arch §5.4 的**单边协议**——锁内复核 1–7 条，CAS 只替换旧块；jev off 时只走显式路径；被跳过的回显 `skipped: <原因>`；`restoreBlock`（清除 `supersededBy`，并把这对块记入永久 dismissed）。
  4. 迁移后首次 review pass（只跑 user↔user）。
  5. 启动提醒：常驻超额、建议计数、漂移、迁移后提示 reload。
  6. review-lite 与新 kind 的动作。
  7. 已迁移目录禁用 `/mem tidy`（只改 `tidy/command.ts` 入口一处，见文件域）。
- **测试清单**：
  - `sweep-plan`：user 块永不归档；agent 到期 ⇒ 归档；until ⇒ 只出建议；去重；dismiss 的 `until` 到期后重新出现；14 天节流。
  - `sweep`：
    - 2000 个块的大 corpus ⇒ 一轮只处理 ≤50 个操作，按预算返回；
    - 持续变更（每次操作之间都有外部写入）⇒ CAS 失败计数 ⇒ 触发无进展保护，不空转；
    - 锁忙 ⇒ 放弃；
    - shutdown/reload 中途中止；
    - 自身写入不再触发 sweep；
    - `governance.enabled=false` 差分测试：零副作用；
    - 闸门拒绝 ⇒ 零写入。
  - `supersede`：
    - 判定迟到：新块被 update 或 delete、旧块被 update ⇒ skipped；
    - 自取代被拒；
    - A→B 之后 B→A 被拒；
    - A→B→C 链，恢复 B 不影响 A；
    - 一对多部分完成后重跑，结果一致；
    - 阈值边界与上限 2；
    - agent→user 被拒；
    - 显式路径；
    - jev off 只走显式路径；
    - 恢复后这对块不再被自动判定。
  - integration `memory-blocks-supersede-race`（tier2）：两个进程同时写互相冲突的块 ⇒ 最终最多一条 `supersededBy` 边，且 `supersededBy` 图无环。
  - integration `memory-blocks-governance`：写入后 sweep 归档并通知；迁移后首次提醒；常驻超额 ⇒ 提醒 + 建议，渲染不截断。
  - `/mem tidy` 在 blocks 目录返回提示，在 files 目录行为不变。
  - 归档冲突恢复（r3）：`archive/quota.007.md` 已存在时再归档 `quota.007` ⇒ 存储为 `quota.007.r1.md`，index 记录正确；`/mem restore --block quota.007` 有两条候选时列出存储名并要求指定；`--block quota.007.r1` 恢复成功且删除 index 记录；rename 之前崩溃（index 已写）⇒ 下次 sweep 清掉悬空记录；`blocks/quota.007.md` 已存在时恢复被拒。
  - 残留块（r3）：`residue: true` 的块不会被自动取代（只出建议）；显式 `supersedes=` 仍可取代它；`update` 后 `residue` 标记被清除。
- **门禁**：§2 + `npx vitest run tests/memory/govern tests/memory/jev/review-command.test.ts tests/memory/jev/expired-command.test.ts tests/memory/jev/write-port.test.ts tests/memory/tidy.test.ts tests/memory/command.test.ts tests/memory/command-jev.test.ts` + `npx vitest run tests/integration/memory-blocks-governance.test.ts tests/integration/memory-blocks-supersede-race.test.ts`。
- **验收行**：V08、V09、V16、V20、V21、V23、V34（取代协议部分）、V42（残留块）、V44。

### P6b 受众过滤与时效降权（wire.ts；与 P5a 并行）

- **文件域**：
  - 新建：`src/memory/govern/{audience,decay}.ts`、`tests/memory/govern/{audience,decay}.test.ts`。
  - 修改：`src/memory/jev/wire.ts`（U/A/E/B/P 候选池加受众过滤；U 层 p×m；A/P 层的点名要求；U 候选裁剪时 topic 类用户令优先）、`src/memory/jev/predict/select.ts`（排序键 ×m）、`tests/memory/jev/wire-recall.test.ts`、`tests/memory/jev/wire-predict.test.ts`、`tests/memory/jev/predict/select.test.ts`（只追加）。
- **冻结面**（r3，裁定 10）：jev-off golden；activate-trace。X4/X5（§5.1）是已批准的行为变化；P6b 之后重新跑 §5.2 的 model-off、predict-off 两组差分，必须仍然成立。
- **召回参数常量**（r3，裁定 12）：`src/memory/govern/decay.ts` 导出 `TOPIC_USER_POOL_CAP`（U 候选裁剪阶段 topic 用户令的入池上限），`wire.ts` 只引用该常量；PG 的 G2 调参只改这里。
- **依赖**：P3（block 元数据、wire.ts 串行）、P4（`govern/snapshot.ts`）。
- **步骤**：
  1. 实现 `effectiveAudience`（arch §6.1 的三级规则）。
  2. 实现 `decayFactor(entry, today)`（arch §6.2）与 `namesSubject(text, entry)`（复用 `match.ts prefilter`）。
  3. 在 wire 中接线：子会话剔除 main，主会话剔除 child。
  4. 写入时的 `audience:` 回显由 P4 的 format 输出；本包只提供 `effectiveAudience` 的判定结果，不改 format.ts。
- **测试清单**：
  - `audience`：三级规则；frontmatter 优先；标签推导阈值 0.7 且该标签须是最高分。
  - `decay`：
    - 7/30 天边界；user 块不降权；带 expires 的块不降权；
    - 快照 + 没点名 ⇒ P/A 不入选；点名 ⇒ 入选。
  - `wire-recall`/`wire-predict`：
    - 子会话下派发类规则不注入；
    - 线路状态类过期事实在没被点名时不注入（复现评测 Top2/Top5 的样例）；
    - topic 类用户令在裁剪时优先。
- **门禁**：§2 + `npx vitest run tests/memory/govern tests/memory/jev/wire-recall.test.ts tests/memory/jev/wire-predict.test.ts tests/memory/jev/predict`。
- **验收行**：V17、V25、V26。

### PG 实施前离线门禁（r2 新增；P5a/P6b 合入后、P5b 之前，单包执行）

- **文件域**：
  - 新建：`scripts/dev/memory36-gate.mjs`（Tier 3；真实调用由 `PI_TOOLKIT_MEMORY36_GATE_LIVE=1` 门控，缺少该变量时零网络）、`tests/memory/govern/gate-script.test.ts`（只测脚本的离线部分：数据集解析、指标计算、缓存复跑）。
  - 数据集与缓存：`~/.pi/agent/memory-reports/eval36/{g1-pairs.jsonl,g2-turns.jsonl,cache/}`。**不入仓库**，因为包含私有记忆正文。
- **冻结面**：本包不修改任何 `src/**`；未达标时的生产调参由单独派发的 P5a-fix / P6b-fix 执行（见下表，r3）。
- **步骤与门槛**：按 arch r5 §7.4 执行。

  | 门禁 | 样本                                                                                                 | 分母                   | 门槛                                                             | 未达标处置（r3，裁定 12）                                                                                                                                                                                                                                                                                      |
  | ---- | ---------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | G1   | 困难负例 ≥60 对（agent↔agent ≥30、user↔user ≥15、user→agent ≥15）+ 正例 ≥20 对；由 verifier 人工标注 | 负例对数 / 正例对数    | 负例误自动取代 ≤1/60，且 agent↔agent 为 0；正例自动取代召回 ≥50% | 派 **P5a-fix**：文件域只限 `src/memory/govern/supersede.ts` 的 `SUPERSEDE_AUTO_P`/`CONFLICT_AUTO_P` 与 `tests/memory/govern/supersede.test.ts`；历史阶梯 (0.90/0.93)、(0.95/0.97)；2026-11-07 起仅提高 supersedes 自动阈值（conflict 仅建议），合入后重跑 G1；最高一档仍不达标 ⇒ 停下报告 root（不改取代矩阵） |
  | G2   | 主会话 transcript 中 ≥30 个用户轮，每轮至少有一条相关的 topic 用户令，由 verifier 标注               | （轮, 用户令）对的总数 | 新管线召回 ≥ HEAD 基线（非劣），且 ≥60%                          | ① 漏召回条目列为 scope-check 候选交给用户；② 派 **P6b-fix**：文件域只限 `src/memory/govern/decay.ts` 的 `TOPIC_USER_POOL_CAP` 与对应测试断言，上限翻倍，合入后重跑 G2；③ 仍不达标 ⇒ 报 root，P5b 不得开工                                                                                                      |
  - **不得只改评测脚本**：脚本先 `npm run build`，再从 `dist/memory/govern/supersede.js`、`dist/memory/govern/decay.js` 及生产选择函数导入常量与判定逻辑；脚本源码中不得出现阈值或上限的数字字面量，`gate-script.test.ts` 用正则断言这一点。
  - P5a-fix / P6b-fix 各自走「开发 → 异源 verifier → 精确路径 commit」，commit 正文写明 PG 前后的指标。
  - 标注由**异源** verifier 完成（不能和开发包用同一个模型），标注结果写进数据集目录，在交付报告里附统计数字。
  - 脚本输出：分母、命中数、比例、逐条明细（明细只写本地，不入仓库）。

- **门禁**：`npx vitest run tests/memory/govern/gate-script.test.ts`；G1/G2 的 live 结果达到门槛（贴进交付报告）。
- **验收行**：V38。

### P5b 治理信号接线 + 默认布局翻转（r2）

- **文件域**：
  - 修改：
    - `src/memory/jev/wire.ts`：信号与 `onTurnEnd`；
    - `src/memory/index.ts`：把 port 传给 `wireJev`；
    - `src/memory/settings.ts`：`layout` 默认值改为 `"blocks"`；
    - `tests/config/__corpus__/*.json`、`tests/config/memory-settings.test.ts`：**只改默认值断言**；
    - `tests/secure/settings-override.test.ts`：断言新键不在强制关闭清单中。
  - 新建：`tests/fixtures/memory/blocks-off-golden.json`、`tests/memory/blocks/off-golden-blocks.test.ts`、`tests/memory/govern/signals.test.ts`。
  - **机械钉住白名单（评审 m17）**：
    1. 开工后、修改代码之前，先运行确定性命令生成白名单：

       ```sh
       git grep -lE "DEFAULT_MEMORY_SETTINGS|DEFAULT_SETTINGS\.memory|parseMemorySettings\(|loadSettings\(" -- tests/ > /tmp/36-p5b-whitelist.txt
       ```

       把文件列表原样贴进交付报告。

    2. 翻转默认值，跑全量 tier1。
    3. **只有**同时满足「失败」和「在白名单中」的文件，才允许做机械改动：在构造设置处加 `layout: "tiered"`。每个文件的 diff 只能包含这一类改动。
    4. 不在白名单中的失败、或者需要修改断言语义的失败 ⇒ 停下报告 root。
    5. 默认值断言（`memory-settings.test.ts`、corpus）的修改与上述机械钉住**分开提交**，各用一个 commit。
- **冻结面**：
  - activate-trace **逐字节不变**（包括生命周期副作用）；
  - jev-off golden 字节；
  - legacy / tiered / doctor / tool-surface 的已有 key。
- **依赖**：P5a、P6b、**PG 达标**；以及 §8 第 3 步（`migrate.auto=false` 已设置并验证）。
- **步骤**：
  1. 接线信号；
  2. 生成白名单；
  3. 翻转默认值；
  4. 全量 tier1 并做机械钉住；
  5. 录制 blocks-off golden；
  6. 补 secure 断言；
  7. 跑全量 tier2、build。
- **测试清单**：
  - `signals.test`：每种信号置位后，在下一个 turn_end 执行一次；jev off 时只剩 startup/write/budget 三种；子会话永不执行。
  - `tests/governance`（activate-trace 逐字节）。
  - blocks-off golden。
  - 开关差分：model-off、predict-off、governance-off、migrate.auto-off（arch §7.2）。**governance-off 按 arch r5 §7.2「比较对象」表逐项比较**：取代、归档（含 `archive/index.json`）、治理 kind 的建议、治理通知行必须在 off 时为空；迁移入口与 R 层在 on/off 下相同（R 层只缺由取代/归档引起的通知）；比较侧车时只投影治理字段，**排除** `entries`（EntryTags/`globalP`）、冷却表与非治理 kind 的 review 建议这些独立 Jev 打标的合法变化。
  - 全量 tier1 + tier2；`npm run test:secure`。
- **门禁**：§2 + `PI_TOOLKIT_TEST_WORKERS=2 npm run test:tier1` + `npm run test:tier2` + `npm run build` + `PI_TOOLKIT_TEST_WORKERS=1 npm run test:secure`。
- **验收行**：V19、V21、V30、V39。

### P7 skill 与文档

- **文件域**：修改 `skills/memory-jev/SKILL.md`、`docs/dev/memory/README.md`（新增「块模型与治理」一节，写不变式、门禁、残留）、`AGENTS.md`（只改 `src/memory/` 表格行与 Frozen artifacts 表，增加新 golden 条目）、`docs/dev/memory-governance/arch.md`（只在有实现偏差时做勘误）。
- **冻结面**：I12——机制只写在工具描述里，skill 只写策略；skill 只有 `skills/` 这一份副本。
- **依赖**：P5b。
- **步骤与内容**：
  - skill 改写以下要点：
    - 先 `view`/`search` 再写；
    - 修正用 `update`（带 rev，整块替换）；
    - 一块一事实；
    - 用户令默认 topic，用户明确说「以后都要/每次都要」时才加 `scope=global`；
    - 看到 `scope:` 建议时向用户转述并询问，不自作主张升级；
    - 看到 `state snapshot` 就补期限或改写；
    - `superseded/not superseded/voided` 必须转述给用户；
    - `supersedes=` 与 `audience=` 的用法；
    - 删除 `str_replace/insert` 相关措辞。
  - README：块模型不变式（文件名即 id、1 KB、rev/CAS、常驻 = user∧global、自动摘要索引、取代矩阵、零定时器 sweep、精确 GC）；新门禁文件清单；残留风险。
  - AGENTS.md：Frozen artifacts 的 B 级行增加 `memory/blocks-golden/`、`memory/doctor-golden/blocks-*`、`memory/migrate-golden/`、`memory/blocks-off-golden.json`。
- **门禁**：`npm run format:check`；文档审阅（verifier 对照 arch r5 与实现，逐条核对）。
- **验收行**：V11（skill 转述部分）、V29。
- **收尾**：P7 验收通过后，主会话整体 `git push` 一次（core 规则：一个任务只 push 一次）。

### P8 真实数据：暂停 → 停旧 writer → 备份 → dry-run → 过目 → 显式解除 → 迁移 → 复评（r2 重写，评审 B8）

> P8 不改仓库代码，操作的是用户的真实记忆数据，**每一步都要用户确认**。前提：pi 直接从本仓库工作树加载扩展（`~/.pi/agent/settings.json` 中 `packages` 包含 `../../ai/pi-toolkit`），所以**任何提交一旦落到工作树，下一个新起的或 `/reload` 过的主会话就会运行新代码**。这正是暂停措施必须在默认值翻转之前生效的原因。

| 步  | 动作                                                                                                                                                                                                                                                                                                   | 何时                                                                                    | 验证（必须留证据）                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **暂停**：经 `ask_user` 获得同意后，在 `~/.pi/agent/pi-toolkit.json` 写入 `"memory": {"migrate": {"auto": false}}`（与已有的 `memory.jev.proxy` 合并，不覆盖）                                                                                                                                         | **P2 合入后、P5b 开工前**（§8 第 3 步）                                                 | ① `grep -n '"auto": false' ~/.pi/agent/pi-toolkit.json`；② 在 pi-toolkit 主会话执行 `/reload`——此时默认布局仍是 tiered，reload 不会触发迁移；③ `/mem migrate --status` 输出 `auto: off (settings)`；④ `ls ~/.pi/agent/memory/-home-bluecake-ai-pi-toolkit/` 中没有 `blocks/` |
| 2   | P5b、P7 照常完成并 push。默认值翻转后，所有新会话因为 `auto=false` 都不会迁移；工具表面仍为 v2，记忆写入照常可用                                                                                                                                                                                       | P5b–P7                                                                                  | P7 验收后重复步骤 1 的 ③④                                                                                                                                                                                                                                                    |
| 3   | **停旧 writer**：列出运行中的 pi 进程（`pgrep -af "pi(                                                                                                                                                                                                                                                 | $)"`或 web-hub 会话列表），请用户逐个`/reload`或退出。由于`auto=false`，reload 不会迁移 | P7 之后                                                                                                                                                                                                                                                                      | 用户确认清单；每个仍在运行的会话里 `/mem migrate --status` 都能执行（说明已经是新代码） |
| 4   | **tar 备份**：`tar czf ~/.pi/agent/memory-backup-20261106.tgz -C ~/.pi/agent memory`。secure 域使用有效 root，目标放在 `<state>/`                                                                                                                                                                      | 步骤 3 之后                                                                             | `tar tzf … \| wc -l` 与 `find ~/.pi/agent/memory -type f \| wc -l` 一致；记录 sha256                                                                                                                                                                                         |
| 5   | **dry-run**：`/mem migrate --dry-run`（pi-toolkit），把报告整理成 HTML 呈现给用户。内容包括：global 清单（期望 3 条 / 524 B）与受众；纯指针 / 疑似指针；整文件块（覆盖审计）；超限；CC 聚合；原 pin 文件中的用户令；被丢弃的旧主题 description/when 列表；主题合并；**残留块与混合权威文件清单**（r3） | 步骤 4 之后                                                                             | 报告文件路径；dry-run 前后目录 sha 一致                                                                                                                                                                                                                                      |
| 6   | **用户过目**：用 `ask_user` 让用户选择：同意 / 调整 / 暂缓。调整方式：迁移前手工给旧文件加 `<!-- mem user -->`，或迁移后到 `/mem review` 修改                                                                                                                                                          | —                                                                                       | 用户的选择记录                                                                                                                                                                                                                                                               |
| 7   | **显式解除 + 迁移**：用户同意后执行 `/mem migrate`（只作用于本目录，无视 `auto=false`），然后 `/reload`，工具表面切换为 v3                                                                                                                                                                             | 步骤 6 同意之后                                                                         | `/mem migrate --status` 显示 `dir: blocks`；`/mem doctor`；首次启动提醒中有建议计数，并包含 user↔user 冲突建议（预期是「验收优先 deepseek-flash」对「验收走 v4-pro」）；根目录旧文件 sha 不变                                                                                |
| 8   | **其它项目**：用户决定后选择：(a) 保持 `auto=false`，按项目逐个执行 `/mem migrate`；(b) `/mem migrate --all --dry-run` → 过目 → `/mem migrate --all`；(c) 把 `auto` 改回 true，恢复默认的惰性迁移                                                                                                      | 用户决定                                                                                | 各项目 `--status`                                                                                                                                                                                                                                                            |
| 9   | **复评**：一周后按 arch §7.4「现场复评」执行，另派任务，结果写入 `docs/dev/memory/predict-eval-<date>.md`                                                                                                                                                                                              | 迁移 + 7 天                                                                             | 报告                                                                                                                                                                                                                                                                         |

- **回退与承诺分工**（r3，裁定 5）：
  - `/mem migrate --rollback` 即时生效，恢复的是**根目录当前的旧布局内容**——迁移后根目录文件从未被新代码写过，内容等于迁移前字节加上旧会话写入的漂移；迁移后新写的块保存在 `.blocks-rolledback-*`；
  - **迁移前的原始字节**由步骤 4 的 tar 包保证（可用迁移报告中的 sha256 核对），回滚命令本身不承诺这一点；需要回到迁移前原始状态时用 tar 恢复。
- **验收行**：V05、V10、V12、V24（复评）、V39。

---

## 5. I9 证明与 secure/D8（r2，评审 M14）

### 5.1 用户已批准的兼容例外（不在字节不变范围内）

arch r5 §7.2 的 X1–X6：

| 编号 | 例外                                                             |
| ---- | ---------------------------------------------------------------- |
| X1   | E 层只读工具失败不注入                                           |
| X2   | 冷却饿死时的 bypass                                              |
| X3   | flight 最后一档用满剩余预算，`waitS` 默认 1.0，call 记账新增字段 |
| X4   | 受众过滤                                                         |
| X5   | 时效降权与点名要求                                               |
| X6   | 统一 eligibility                                                 |

这些都只在 jev on 时生效，且对所有布局都生效。

### 5.2 证明清单（开关差分测试，不依赖单份最终 golden）

| 开关 / 场景                                      | 字节不变的面                                                                                        | 证明                                                                                                                                                                   | 包      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 显式 `layout:"tiered"` / `"legacy"` + files 目录 | 注册、system prompt、工具表面与输出、命令、doctor、提醒、tidy prompt（jev-off golden 覆盖的全部面） | jev-off golden（四个配置钉 tiered，`legacy-layout` 保持原值）+ tiered / legacy / doctor golden                                                                         | P0/P3   |
| `predict.model.enabled=false`                    | 修复后的规则路径                                                                                    | 差分：model on 但调用被拒 vs model off，P 层输出逐字节相同；off 时没有 flight，也没有 `kind:"call"`                                                                    | P6a     |
| `predict.enabled=false`                          | 新代码去掉 P 层后的输出                                                                             | `wire-predict.test.ts`                                                                                                                                                 | P6a/P6b |
| `governance.enabled=false`（blocks，全部接线）   | 治理副作用为零（取代、归档、治理建议、治理通知）；迁移入口与 R 层与 on 相同                         | 差分：同一 fixture 依次发出全部 SweepReason，执行一次会触发取代的写入、一次跨午夜、一次使 global 到期的写入；按 arch r5 §7.2 比较对象表逐项比较，排除 Jev 打标侧车字段 | P5a/P5b |
| `migrate.auto=false`                             | session_start 不迁移、不创建 `blocks/` 或暂存区；工具表面为 v2                                      | 差分：files 目录在 auto on/off 下各跑一次 session_start                                                                                                                | P2/P5b  |
| `jev.enabled=false`（blocks）                    | 没有 Jev 注册；常驻区与索引照常；只有显式取代                                                       | `blocks-off-golden.json`                                                                                                                                               | P5b     |
| `memory.enabled=false`                           | 零注册                                                                                              | jev-off golden 的 `disabled` 配置                                                                                                                                      | 每包    |

### 5.3 secure / D8

- 不新增 D8 项。
- 所有自动写入口都经过 `memoryWriteGate`（arch §4.7）：locked 时零读写；secure 时逐个操作复检挂载、写区和 dev/ino；自动路径永不 mkdir。
- **逐操作闸门复检**（r3，arch r5 §4.7）：暂存区构建与清理的每个 mkdir/write/fsync/rename/unlink/rmdir 前都 `check`；不采用目录 fd 方案（Node 无 openat/mkdirat/renameat/unlinkat）。
- 显式路径新建 memDir 后立即 `gate.capture`，之后自动路径才允许写入。
- `--all` 与备份使用有效 root（`ARMORY_MEMORY_ROOT`）。
- 测试：
  - 真实挂载测试 `tests/secure/memory-gate.test.ts`（P2）；
  - `tests/secure/settings-override.test.ts` 断言新键不在强制关闭清单中（P5b）；
  - 门禁：`PI_TOOLKIT_TEST_WORKERS=1 npm run test:secure`，在独占且挂载表干净的机器上运行。

---

## 6. 风险、残留与回滚

### 6.1 风险与残留（对应 arch r5 §9.1；r3 增补 R15–R18）

| #   | 风险                              | 缓解（包）                                                                             | 残留                                 |
| --- | --------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------ |
| R1  | topic 用户令漏注入                | 用户令优先（P6b）；`decisions` 计数（P3）；scope-check（P5a）；**G2 门禁（PG）**；复评 | 下限取决于 Jev                       |
| R2  | 自动取代误判                      | **G1 门禁（PG）**；单边协议与锁内复核（P5a）；阈值；每次 ≤2；恢复；总开关              | agent↔agent 只回显                   |
| R3  | global 规则膨胀                   | 软预算、建议、提醒、D21                                                                | 成本线性增长                         |
| R4  | 旧会话写旧文件                    | 目录隔离（P2）；漂移检测 + 显式导入；P8 步骤 3 停旧 writer                             | 漂移内容需要显式导入                 |
| R5  | 旧文件与 `blocks/` 并存           | D24 提示                                                                               | 旧文件长期留在原处                   |
| R6  | 默认值翻转后要钉住大量测试        | P5b 白名单流程                                                                         | 改动面大                             |
| R7  | wire.ts 被多包修改                | §1.1 严格串行                                                                          | —                                    |
| R8  | 自动摘要丢掉人工 when             | 标签/sections 摘要                                                                     | 旧 when 只存在于报告                 |
| R9  | 降权/快照规则带来漏注入或噪音     | 只作用于 agent ∧ 无期限的块                                                            | 少量                                 |
| R10 | 迁移改坏数据                      | 暂存区 + rename + 旧文件不动 + 覆盖审计 + 预算 + P8 流程                               | —                                    |
| R11 | 工作树里的代码对新会话立即生效    | 默认值在 P5b 翻转；**P2 合入后立即设置 `migrate.auto=false` 并验证**                   | —                                    |
| R12 | secure 挂载消失                   | 写闸门 + 真实挂载测试                                                                  | 渲染可能读到空目录                   |
| R13 | jev off 时没有 R 通知             | hub 尾部更新                                                                           | POINTED 或 freeze 时要等下一段才更新 |
| R14 | 工具表面在 activate 时按 cwd 决定 | 双向错误码 + 提示 `/reload`                                                            | resume 到其它 cwd 需要 reload 一次   |
| R15 | 文件系统不支持目录 rename         | `renameDirNoClobber` fail closed，不复制（P1/P2）                                      | 该目录只能保持 tiered                |
| R16 | 暂存区 owner.json 缺失            | 不按年龄清理；D25 报告（P2/P3）                                                        | 极少量磁盘残留，由用户手删           |
| R17 | 残留块权威定为 agent              | 报告逐条列出 + P8 过目；不作自动取代目标（P2/P5a）                                     | 用户不处理时以 agent 身份参与注入    |
| R18 | secure 域逐操作复检开销           | 计入迁移预算；超预算改用显式 `/mem migrate`（P2）                                      | 大目录可能需要一次手动迁移           |

### 6.2 回滚方式（r2）

| 层级                 | 方式                                                           | 效果                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单块被误取代或误归档 | `/mem restore --block <id>`                                    | 清除 `supersededBy`，或从 `blocks/archive/` 移回                                                                                                                       |
| 单块被误删           | `/mem restore --trash`（块布局下作用于 `blocks/.trash/`）      | 恢复                                                                                                                                                                   |
| 整次迁移             | `/mem migrate --rollback`，然后 `/reload`                      | 立即回到**根目录当前的旧布局**（旧文件从未被新代码改动，含旧会话漂移）；迁移后的块保存在 `.blocks-rolledback-<ts>/`；写入 `.blocks-hold`；迁移前原始字节由 P8 tar 保证 |
| 暂停自动迁移         | `memory.migrate.auto=false`（全局）或 `.blocks-hold`（单目录） | 不再自动迁移                                                                                                                                                           |
| 治理动作             | `memory.governance.enabled=false` + `/reload`                  | 不再有自动写盘或自动取代                                                                                                                                               |
| 预测注入             | `predict.model.enabled=false` 或 `waitS=0.5`                   | 回到规则路径或原窗口                                                                                                                                                   |
| 代码（push 前）      | 按包 `git revert`                                              | —                                                                                                                                                                      |
| 灾难恢复             | P8 步骤 4 的 tar 包                                            | 整个目录还原                                                                                                                                                           |

---

## 7. 验收矩阵

每个用户决定至少对应一行。下表中「证据」一列给出测试文件或手工步骤；所有自动化证据都必须在 P5b 全量 tier1/tier2 通过时为绿。

| #   | 用户决定（来源）                                                        | 验收标准                                                                                                                                                                                                                                                                     | 证据                                                                                                                                     | 包        |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| V01 | 一文件 = 一 block，单块 ≤1 KB（D-2）                                    | 正文 1024 B 能写入、1025 B 报 `E_TOO_LARGE`；按 UTF-8 计量；frontmatter 不计入                                                                                                                                                                                               | `tests/memory/blocks/format.test.ts`、`tool-v3.test.ts`                                                                                  | P1/P4     |
| V02 | update 整块替换 + 版本号/CAS（D-2）                                     | 缺 rev 报 `E_REV_REQUIRED`；rev 不一致报 `E_CONFLICT` 并附当前正文；手改字节也会触发冲突；成功时 version+1                                                                                                                                                                   | `store.test.ts`、`tool-v3.test.ts`                                                                                                       | P1/P4     |
| V03 | 保留 create/delete/view/search，去掉 insert/str_replace/rename（D-2）   | schema 只有五个命令；旧命令报 `E_UNSUPPORTED_COMMAND`、给出改法并记 diag；`action:list` 按 view 处理                                                                                                                                                                         | `tool-v3.test.ts`、`tool-surface.test.ts`                                                                                                | P4        |
| V04 | `memory-tool-surface.json` 申报式更新（D-2）                            | 只新增 `blocks/blocksJev/bytes.*`；已有 key 的 sha 不变；v3 字节 ≤1700                                                                                                                                                                                                       | `tool-surface.test.ts` + sha256 对比                                                                                                     | P4        |
| V05 | 现有条目自动拆分、注释转 frontmatter、旧文件可恢复（D-2）               | migrate-golden 与期望一致（inline 注释全部转为 frontmatter，正文不残留 `<!-- mem`）；根目录旧文件迁移前后 sha256 相同；`--rollback` 后读到根目录当前旧布局，`.blocks-rolledback-*` 保留迁移后块；迁移前原始字节可由 P8 tar 恢复（sha 与报告一致）；P8 dry-run 报告获用户认可 | `migrate-plan.test.ts`、`migrate.test.ts`、`rollback.test.ts`；P8 步骤 4/5 证据                                                          | P2/P8     |
| V06 | 去掉 core.md 特殊地位与主题卡（D-3）                                    | `blocks/` 中没有 core 主题、没有主题卡文件；core.md 的条目进入主题 `general`；根目录 core.md 原地保留但 blocks 布局下任何渲染路径都不读取它（只做漂移检测）；D01/D02/D09 在 blocks 目录不报；`/mem init` 只给提示                                                            | `migrate-plan.test.ts`、`inject-blocks.test.ts`、`doctor-blocks.test.ts`                                                                 | P2/P3     |
| V07 | global 常驻，其余由 Jev 注入（D-3/D-4）                                 | `### User rules` 只包含 user∧global∧active；agent 块与 topic 用户令不在常驻区；常驻块不进入 U/A/E/P 候选；topic 用户令仍是候选                                                                                                                                               | blocks-golden g1/g8；`wire-recall.test.ts`                                                                                               | P3        |
| V08 | 两类用户令都受保护（D-4）                                               | 任何 user 块都不会被 sweep 归档；agent 块永不取代 user 块（显式和自动都不行）；到期 user 块仍注入并带标注                                                                                                                                                                    | `sweep-plan.test.ts`、`supersede.test.ts`、blocks-golden g3、`wire-recall.test.ts`（topic 到期带标注）                                   | P3/P5a    |
| V09 | 常驻区约 2 KB，超额不截断、出建议、启动提醒（D-4）                      | `residentBytes` 默认 2048；超额时全部渲染并出现标记行；生成 `resident-budget` 建议；启动提醒一行；D21 warn，>4× 时 error                                                                                                                                                     | blocks-golden g2、`sweep-plan.test.ts`、integration `memory-blocks-governance`、`doctor-blocks.test.ts`                                  | P3/P5a    |
| V10 | 迁移：core.md 用户令 → global，其余 → topic（D-4）                      | migrate-golden 中 scope 矩阵与预期一致；pi-toolkit dry-run 为 global 3 条 / 524 B、topic 32 条                                                                                                                                                                               | `migrate-plan.test.ts`；P8 报告                                                                                                          | P2/P8     |
| V11 | 新用户令默认 topic，不自动升级为 global（D-4）                          | 没写 scope ⇒ topic；`globalP=0.99` 时也只出回显；只有显式 `scope=global` 生效；skill 要求向用户转述                                                                                                                                                                          | `tool-v3.test.ts`、`tool-v3-jev.test.ts`；P7 skill 审阅                                                                                  | P4/P7     |
| V12 | Topics 索引每主题一行，只用自动摘要（D-3/D-5 N1）                       | 索引行 = topic + tags/sections + 计数；`blocks/.layout.json` 只有 v/migratedAt/runId/source；渲染路径不读取旧 description/when                                                                                                                                               | blocks-golden g1/g5/g6/g7；`migrate.test.ts`（marker 内容）；grep 断言 render.ts 不读报告文件                                            | P1/P2/P3  |
| V13 | 纯指针移出、疑似指针留存并出建议（D-3 Q10）                             | 纯指针用户令从 global 降为 topic；疑似指针保持原样并生成 `pointer` 建议                                                                                                                                                                                                      | migrate-golden 的指针用例                                                                                                                | P2        |
| V14 | >1 KB 存量豁免并出建议（D-3 Q3）                                        | 1100 B 条目原样迁移；生成 `oversize` 建议；D20 报 warn；update 时必须 ≤1024                                                                                                                                                                                                  | migrate-golden、`doctor-blocks.test.ts`、`tool-v3.test.ts`                                                                               | P2/P3/P4  |
| V15 | CC 导入按前缀聚合主题（D-3 Q4）                                         | `project_/reference_` → agent；`feedback_/user_` → user/topic；主题为前缀；`title/when` 写在块上；`MEMORY.md` 不拆分、不生成块，报告标「保留在旧布局」                                                                                                                       | migrate-golden 的 CC 用例                                                                                                                | P2        |
| V16 | 已迁移目录禁用 `/mem tidy`（D-3 Q5）                                    | blocks 目录返回提示；files 目录行为不变                                                                                                                                                                                                                                      | `tidy.test.ts`（追加用例）、`command.test.ts`                                                                                            | P5a       |
| V17 | audience 在迁移时写入，其余从 Jev 标签推导（D-3 Q7）                    | 只有 global 块被播种 audience；推导规则三级；子会话剔除 main                                                                                                                                                                                                                 | migrate-golden、`audience.test.ts`、`wire-recall.test.ts`                                                                                | P2/P6b    |
| V18 | 惰性迁移 + `/mem migrate --all`（D-3 Q8）                               | 只有主会话的 session_start 迁移当前 cwd；子会话永不迁移；`--all` 只处理 files 目录；`--dry-run` 不写盘                                                                                                                                                                       | `migrate.test.ts`、integration `memory-blocks-migrate`                                                                                   | P2        |
| V19 | 块化设为默认布局；A′ harness 钉 tiered（D-3 Q2）                        | `layout` 默认值为 `"blocks"`；jev-off golden sha 不变；harness 显式钉 tiered；blocks-off golden 已录制                                                                                                                                                                       | `memory-settings.test.ts`、`off-golden.test.ts`、`off-golden-blocks.test.ts`                                                             | P0/P5b    |
| V20 | 原则①到期（D-1）                                                        | agent 到期：不注入，计入 `N expired`，sweep 归档，可恢复；user·global 到期仍常驻并标注；user·topic 到期仍是 Jev 候选、注入时标注；跨午夜生效                                                                                                                                 | blocks-golden g3、跨午夜用例、`sweep.test.ts`、`wire-recall.test.ts`                                                                     | P3/P5a    |
| V21 | 原则②事件触发 + 分级自动（D-1）                                         | 六类信号都能触发 sweep（jev off 时只剩三类）；只有「agent ∧ expires 已过」会被自动归档；其余只出建议；没有新增注册（activate-trace 不变）                                                                                                                                    | `signals.test.ts`、`sweep-plan.test.ts`、`tests/governance`                                                                              | P5a/P5b   |
| V22 | 原则③写入（D-1）                                                        | 用户令永不出现 snapshot/temporary 提示；agent 状态快照照常写入并给强提示；7 天后生成 `snapshot` 建议                                                                                                                                                                         | `snapshot.test.ts`、`tool-v3.test.ts`、`sweep-plan.test.ts`                                                                              | P4/P5a    |
| V23 | 原则④取代矩阵（D-1/D-3/D-5 N2）                                         | user↔user、agent↔agent、user→agent 自动取代（2026-11-07：仅完整取代 supersedes≥0.85，conflict 即使 p=1 也只建议，每次 ≤2）；agent→user 永不；旧块标记已取代、停止注入、可恢复；user 取代发 TUI 通知；新块不继承 global                                                       | `supersede.test.ts`（4 格 × 显式/自动 × 阈值边界 × 上限 × 恢复）、integration `memory-blocks-governance`                                 | P5a       |
| V24 | `model.enabled` 保持开启 + P2 窗口/预算修复 + `waitS=1.0`（D-2/D-3 Q9） | 单模型链用满 3000 ms；`waitS` 默认 1.0；call 记账带 windowMs/attempts；P8 复评时主会话及时率 ≥50%、模型驱动的 P 注入 >0                                                                                                                                                      | `flight.test.ts`、`wire-predict-model.test.ts`；P8 复评报告                                                                              | P0/P6a/P8 |
| V25 | 子会话受众过滤（D-2）                                                   | 子会话的常驻区和 Jev 各层都不注入 audience=main（含推导结果）的块                                                                                                                                                                                                            | blocks-golden g4、`wire-recall.test.ts`、`wire-predict.test.ts`                                                                          | P3/P6b    |
| V26 | 时效降权（D-2）                                                         | agent 且无期限的快照/带日期块按 7/30 天降权；P/A 层未点名不入选；user 块与带期限的块不受影响                                                                                                                                                                                 | `decay.test.ts`、`wire-predict.test.ts`                                                                                                  | P6b       |
| V27 | E 层只读失败不撞词（D-2）                                               | read/grep/ls/find 失败时零 E 注入；高危动作类标签必须与失败命令的 hitTags 有交集                                                                                                                                                                                             | `wire-recall.test.ts`                                                                                                                    | P6a       |
| V28 | 高危 tag 冷却饿死降级出口（D-2）                                        | 命中条件时注入 1 条，并在 details 中记 `bypass`；不满足条件时不触发                                                                                                                                                                                                          | `select.test.ts`                                                                                                                         | P6a       |
| V29 | #26 延续：用户令改写直接写入 + voided + 通知（D-6）                     | v3 中改写/删除/降权 user 块、模型把 global 降为 topic：都直接写入，带 voided 回显和 TUI warning，没有确认                                                                                                                                                                    | integration `memory-blocks-user-rule-direct`、`memory-user-rule-direct`                                                                  | P4        |
| V30 | 先重构后治理，在同一任务内完成（D-2）                                   | 提交顺序符合 §1（P1–P4 重构 → P5a/P5b 治理），P7 验收后一次 push；整次迁移可用 `--rollback` 撤回到根目录当前旧布局                                                                                                                                                           | git log 审阅；`rollback.test.ts`                                                                                                         | 全部      |
| V31 | 迁移原子性（评审 B1–B3；r3 裁定 1/13）                                  | 独立进程在每个崩溃点读取，只看到完整的旧布局或新布局；根目录旧文件迁移前后 sha 相同；**P2 提交范围内** tidy/** 与 safe-fs.ts 零 diff；safe-fs 自 P1 起只有新增的三个导出（无删除/修改行）；fs-guard 测试未改且通过                                                           | `migrate.test.ts`；`git diff --stat <P2 基线>..<P2 末提交> -- src/memory/tidy src/memory/safe-fs.ts` 为空；P1 的 `git diff -U0` 只增检查 | P1/P2     |
| V32 | 旧 writer 隔离与漂移（评审 B4/B5）                                      | 旧 v2 对块路径的 str_replace/insert/append/create 全部被拒；根目录写入被识别为漂移；显式导入幂等                                                                                                                                                                             | integration `memory-blocks-migrate`、`legacy-import.test.ts`                                                                             | P2        |
| V33 | 源字节覆盖审计 + heading 契约（评审 B6；r3 裁定 4/6）                   | 权威一致的文件：独立 fence、只有代码块、零条目 ⇒ whole 块；heading 写入 frontmatter，`parseBlockFile` 读回、`blockToEntry` 输出的 `MemEntry.heading` 与 `splitEntries` 相同，`view <topic>` 按 `section › heading` 分组                                                      | migrate-golden；`adapter.test.ts`；`entries.test.ts`                                                                                     | P1/P2/P3  |
| V34 | 取代执行协议（评审 B7）+ 统一 eligibility（M11）                        | 锁内复核七个条件；迟到判定、双进程互相取代、链式取代、一对多、恢复全部符合 arch §5.4；七个层 × 状态变化在提交时被剔除                                                                                                                                                        | `supersede.test.ts`、integration `memory-blocks-supersede-race`、`eligibility.test.ts`                                                   | P3/P5a    |
| V35 | secure 写闸门（评审 B9）                                                | locked 时零读写；挂载在中途消失后零写入，且没有新建目录；`--all` 只遍历有效 root                                                                                                                                                                                             | `write-gate.test.ts`、`tests/secure/memory-gate.test.ts`                                                                                 | P2        |
| V36 | 常驻区与两层冻结（评审 M10；r3 裁定 8）                                 | 每个矩阵格子：snapshot = `parseResidentSection(hub snapshot 文本)`；轮末 ledger = want（无遗漏）；`residentBlocks` = ledger id；到期标注变化恰好一条「已变更」；resume/reload 从 R details 恢复 ledger、不重复通知；他进程写入下一轮即被发现；异步结果 rev 变 ⇒ 丢弃         | `hub-wiring.test.ts`、`eligibility.test.ts`                                                                                              | P3/P4     |
| V37 | 契约与侧车兼容（评审 M12）                                              | 新字段往返；旧侧车逐字节等价；dismiss 过期后被修剪；同 hash 多块时删除其中一个                                                                                                                                                                                               | `index-store.test.ts`、`index-store-blocks.test.ts`                                                                                      | P0/P2     |
| V38 | 实施前离线门禁（评审 M16；r3 裁定 12）                                  | G1、G2 达到门槛（调参只发生在 P5a-fix/P6b-fix 的生产常量中，脚本无数字字面量）；G3 八个用例（含 3a 承接全权重、3b 新指令 0.6 封顶、3c cancel 丢弃）全部通过                                                                                                                  | PG 交付报告、`gate-script.test.ts`、`flight.test.ts`/`wire-predict-model.test.ts`                                                        | PG/P6a    |
| V39 | P8 暂停顺序（评审 B8）                                                  | 默认值翻转前 `migrate.auto=false` 已生效（status 与目录证据）；严格按「暂停 → 停 writer → tar → dry-run → 过目 → 显式解除 → 迁移」执行                                                                                                                                       | P8 步骤 1–7 的证据                                                                                                                       | P2/P5b/P8 |
| V40 | 回滚与代际（r3 裁定 2）                                                 | 回滚顺序 gen → hold(fsync) → rename；每个回滚边界崩溃后读者都看到旧布局并能续做；提交五项复核逐项反例都不提交；「A 构建 → B 提交并回滚 → A 提交」被拒；hold 存在时不自动迁移                                                                                                 | `rollback.test.ts`、`migrate.test.ts`、integration `memory-blocks-rollback-race`                                                         | P2        |
| V41 | 暂存区清理（r3 裁定 3）                                                 | 只清本进程或 owner 已确认死亡的暂存区；不看 mtime；先锁内隔离再删；owner 活着（含被 SIGSTOP）时不动；提交前 runId 与完整清单核对                                                                                                                                             | `migrate.test.ts`、integration `memory-blocks-rollback-race`                                                                             | P2        |
| V42 | 混合权威与残留块（r3 裁定 4）                                           | 混合权威文件不做 whole 兜底、不选默认权威；残留块 `agent/residue/origin` 正确且逐条进报告；残留块不被自动取代                                                                                                                                                                | migrate-golden 混合用例；`supersede.test.ts`                                                                                             | P2/P5a    |
| V43 | safe-fs 目录原语（r3 裁定 1）                                           | 三个导出行为符合 arch §4.2.1；EXDEV/不支持 ⇒ 抛错且无复制产物；gocryptfs 真实挂载上目录提交与回滚成功；构建期 mount-loss ⇒ 零后续写入                                                                                                                                        | `safe-fs-dir.test.ts`、`write-gate.test.ts`、`tests/secure/memory-gate.test.ts`                                                          | P1/P2     |
| V44 | archive 冲突命名（r3 裁定 5）                                           | 冲突存储名 `<id>.r<n>.md` 满足 v2 名、不满足块名；`archive/index.json` 先写；冲突恢复与悬空记录清理正确                                                                                                                                                                      | `supersede.test.ts`/`sweep.test.ts` 中的归档用例、`naming.test.ts`                                                                       | P1/P5a    |
| V45 | 迁移全阶段预算（r3 裁定 11）                                            | 单一 deadline + 操作数上限覆盖快照/构建/复核/清理；锁外每 32 op 让出；超预算丢弃并计数；连续 3 次 ⇒ D25 与启动提醒                                                                                                                                                           | `migrate.test.ts`、`doctor-blocks.test.ts`                                                                                               | P2/P3     |

---

## 8. 调度清单（主会话用，r2）

1. **派 P0**（单包）。返回后派异源 verifier，通过后按精确路径 commit。
2. **P1 ∥ P6a**：写 `/tmp/36-p1-p6a.json`，跑 `conflict-check`，exit 0 后并行派发。P6a 包含 G3。
3. **P2 ∥ P3**：写 `/tmp/36-p2-p3.json`，跑预检后并行派发。P3 对 wire.ts 的修改必须基于已合入 P6a 的 HEAD。
   - **P2 合入后立即执行暂停**（P8 步骤 1）：
     1. 经 `ask_user` 同意后写入 `memory.migrate.auto=false`；
     2. `/reload` 主会话（此时默认布局仍是 tiered，不会迁移）；
     3. `/mem migrate --status` 显示 `auto: off`，并且目录里没有 `blocks/`。
   - 证据贴进调度记录。**拿不到证据，不得开工 P5b。**
4. **派 P4**（单包）。
5. **P5a ∥ P6b**：写 `/tmp/36-p5a-p6b.json`，跑预检后并行派发。
6. **派 PG**（单包）：G1/G2 由异源 verifier 标注，不达标按 PG 表格处置。**PG 达标是 P5b 的前置条件。**
7. **派 P5b**（单包）：全量 tier1 + tier2 + build + secure。
8. **派 P7**（单包）。验收通过后 **push 一次**。
9. **P8**：严格按 §4 P8 的步骤 2–9 执行，每一步都用 `ask_user` 确认，并留下证据。

**派单要求**：

- 开发包统一用 `subagent_type=general`。
- 派单 prompt 必须包含：本文对应小节全文；arch r5 相关章节路径（并注明 r5 摘要与本文 r3 摘要）；「只改文件域内的文件」；门禁命令；交付报告格式。
- 拿不准时用 `message_agent`（to:"root"，kind:"report"）提问，写明默认做法后继续。

---

## 评审处置表（第 1 轮，GPT-6.1 Sol）

| #   | 严重度  | plan 中的处置                                                                                                                         | 位置                          |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | Blocker | P2 不再复用 txn；`src/memory/tidy/**`、`safe-fs.ts` 列为冻结面；V31 断言二者零 diff                                                   | P2、V31                       |
| 2   | Blocker | 暂存区 + rename，没有 run 级恢复需求；崩溃点测试由独立进程读取                                                                        | P2 `migrate.test`             |
| 3   | Blocker | 同上；`dirFormat` 以 `blocks/.layout.json` 判定                                                                                       | P2、V31                       |
| 4   | Blocker | 漂移检测 + 显式导入；报告只写一次；rolledback 目录永久保留                                                                            | P2 `legacy-import`/`rollback` |
| 5   | Blocker | 子目录隔离；用旧版真实路径测试对块的改写与追加，以及与 v3 并发                                                                        | P2 integration、V32           |
| 6   | Blocker | 覆盖审计 + 整文件块 + heading 元数据；golden 增加 fence/代码块/零条目/嵌套标题用例                                                    | P2 migrate-golden、V33        |
| 7   | Blocker | 单边关系 + 锁内七条件复核；迟到判定、双进程、链式、一对多、恢复测试                                                                   | P5a、V34                      |
| 8   | Blocker | `migrate.auto` 在 P2 合入后、P5b 之前设置并验证；P8 九步表格固定顺序                                                                  | §8 第 3 步、P8、V39           |
| 9   | Blocker | `secure/memory-gate.ts` + `src/index.ts` 装配 + 真实挂载测试（tiers.ts 唯一例外）；备份使用有效 root                                  | P2、§5.3、V35                 |
| 10  | Major   | `delivered` + R 层 + 生产 hub 接线矩阵                                                                                                | P3、V36                       |
| 11  | Major   | `govern/eligibility.ts`：选择时与提交时两次校验；B/S/R/external 全部接入；异步状态变化用例                                            | P3、V34                       |
| 12  | Major   | P0 一次补齐全部字段 + sanitizer；块布局独立侧车、多对一 GC                                                                            | P0、P2、V37                   |
| 13  | Major   | harness 只钉四个配置，`legacy-layout` 保持原值，P0 逐配置比对                                                                         | P0、§3                        |
| 14  | Major   | 列出 X1–X6 例外；四组开关差分                                                                                                         | §5                            |
| 15  | Major   | 迁移与 sweep 的预算、中止、自触发屏蔽、无进展保护以及对应测试                                                                         | P2、P5a                       |
| 16  | Major   | 新增 PG（G1/G2）与 G3（P6a），写明样本、分母、门槛与处置；现场复评只作持续观察                                                        | PG、P6a、V38                  |
| 17  | Minor   | P4 补 tagging.ts 调用链；P5b 白名单用确定性命令生成，并与默认值断言分开提交；新 golden 统一为 B 级；P3 golden 只覆盖与 Jev 无关的契约 | P3、P4、P5b、§3               |

---

## r5/r3 处置表（root 裁定，第 2 轮复审后）

| #   | 裁定                    | plan r3 落点                                                                                    | 要点                                                                                                |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | 目录操作入口            | §1.1 热点表（safe-fs、fs-guard）、§1.3 P1 spec、P1 文件域/冻结面/测试、P2 冻结面、V31、V43      | 只 P1 改 safe-fs 且只新增三个导出；fs-guard 不放宽；EXDEV fail closed；gocryptfs 目录提交测试在 P2  |
| 2   | 回滚与代际              | P1 `state.ts`、P2 步骤 3/6 与 `rollback.test`/integration `memory-blocks-rollback-race`、V40    | gen → hold → rename；提交五项复核；每个回滚边界崩溃；双进程交错；无锁读者（P1 `reader.test`）       |
| 3   | 暂存区清理              | P2 步骤 4 与 `migrate.test` 清理用例、integration 活 owner 暂停交错、V41                        | owner.json；只清本进程/确认死亡；不看年龄；锁内隔离再删；提交前清单核对                             |
| 4   | 混合权威                | P2 步骤 1 与 migrate-golden 混合用例、P5a 残留块测试、V42                                       | 只有权威一致才 whole；残留块 agent/residue/origin；报告逐条列出                                     |
| 5   | 回滚承诺与 archive 命名 | P5a 步骤（归档）与归档冲突测试、P8「回退与承诺分工」、§6.2、V05、V30、V44                       | 回滚 = 根目录当前旧布局；原始字节 = tar；`<id>.r<n>.md` + `archive/index.json`；删去旧 restore 验收 |
| 6   | heading 契约            | P0 契约（`MemEntry.block` 无 heading）、P1 步骤与 hash/heading 对等测试、P3 `entries` 测试、V33 | frontmatter `heading` 全链路；adapter 输出 `MemEntry.heading`                                       |
| 7   | secure 构建与清理       | P2 步骤 8、`write-gate.test` 构建期 mount-loss 与 capture 用例、secure 测试、§5.3               | 逐操作复检（fd 方案不可行）；新目录显式创建后立即 capture                                           |
| 8   | 已交付账本              | P3（重写）、P4 R 层生产接线、§1.1 inject.ts 行、V36                                             | snapshot + ledger；到期标注变化也发 R；指纹 + 日期 + snapshotKey；异步 rev 丢弃；hub 不改           |
| 9   | JevWritePort            | P0 契约与 `contracts.test`、P4 调用链                                                           | 沿用 `afterWrite`，追加 `block/askScope/relations`；不造 `runAfterWrite`                            |
| 10  | 派单正文统一            | P6a/P6b 冻结面、P5b 开关差分、§5.2 governance 行                                                | 引用 X1–X6 + 开关差分；governance-off 比较对象表，排除 Jev 打标侧车                                 |
| 11  | 迁移全阶段预算          | P2 步骤 5 与预算测试、V45                                                                       | 单一 deadline + op 上限；锁外 32 op 让出；超预算计数，3 次 D25                                      |
| 12  | 离线门禁调参归属        | P5a/P6b 常量声明、PG 表格与「不得只改评测脚本」、P6a G3 八用例、V38                             | G1 → P5a-fix，G2 → P6b-fix，重跑 PG；G3 3a/3b/3c                                                    |
| 13  | 门禁口径与旧验收        | P2 冻结面与门禁、P5a 文件域「tidy/command.ts 的唯一改动」、V05/V06/V15/V30/V31                  | 零 diff 限 P2 提交范围；P5a 唯一一处 tidy 改动；旧验收换成新模型验收                                |

## 后续子包：#50 增量后台修正（未启动）

#50 是 #36 子项，保留编号与独立验收；#36 原 P5b/P7 继续收尾，不得用 #50 掩盖原欠账。共同前置：优先修复 #66（建议覆盖）和 #67（判定与提交 rev 不一致），其次修复 #68（Jev 超时 abort 与队列上限），作为作业级 abort 的基础。三项前置已于 2026-11-08 修完（`c3364fca`、`3be7522d`、`50cbb50b`）；权限表已由 root 于 2026-11-08 拍板（见下）。复用边界见 arch §4.5.1。

- **P50.1 聚合调度器**：前置依共同顺序处理 #66/#67、#68。验收：按 canonical memDir 聚合，N 次变更合并一次；安静窗口内新写重置等待；自写不再入队；队列、调用、费用或并发达 cap 停止。
- **P50.2 修订提案与提交器**：权限已定（见下表）。验收：模型生成修正正文，冻结双方 rev；默认建议模式，仅获批动作自动提交；超时/abort/旧 rev 零提交，调用、费用及并发达 cap 停止。
- **P50.3 审计与撤销**：前置依共同顺序处理 #66/#67、#68，并与受控提交协同。验收：记录 origin、批次幂等键及输入/输出摘要；撤销可恢复原文字节。

### 权限表（2026-11-08 root 已拍板）

| 权限项         | 裁定                            | 落地约束                                                                                                     |
| -------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 用户令         | **允许窄条件自动取代**          | 仅 user↔user；必须「完整覆盖」且 `conflict ≥0.90`；单批 ≤2 条；可撤销并保留原文                              |
| 删除           | **允许自动删 agent / 已过期块** | 仅 `authority: agent` 且（已过期 ∨ 已 archived ∨ 合并后重复）；删前写审计快照、可恢复原文字节；user 块只建议 |
| 跨主题合并     | **同主题 + 跨主题均可自动**     | 沿用既有 `conflict ≥0.90`，不新增阈值档；单批 ≤2；跨主题仅限同一 canonical memDir 内                         |
| 低置信冲突     | **仅建议**                      | 中间置信带只进建议列表，不自动、不占自动预算                                                                 |
| expires        | **允许对 agent 块自动写**       | 仅 `authority: agent`；user 块只能提议，需用户确认才落盘                                                     |
| 跨 project/Hub | **跨项目仅建议**                | 跨 canonical memDir 一律不自动落盘；同 Hub 内也只提案，落盘需用户确认                                        |

- 2026-11-09 root 重裁 Q2：#50 允许「独立、异源的 whole-coverage 完整覆盖 + 关系置信度 ≥0.90」的窄条件自动提交（单文件原子、先审计、可撤销、单批 ≤2、agent 永不取代 user）；partial/conflict-only 仍只建议；无法证明来源分离 ⇒ 只建议（见 [P50 设计 §4.3](p50-design.md#43-q2-自动资格异源判定与可信-provenance)）。
