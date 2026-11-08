# #36 S0：P5b / P7 边界与契约冻结

> 基线：`eb105111`；2026-11-08。S0 **只追加文档与未接线的共享名称**，不表示下述行为已经实现。
> 本文细化 `arch.md` §4.5 / §5.2 与 `plan.md` P5b/P7；冲突处以本文及日期化用户裁定为准。
> 不改默认值、不新增设置、不注册 hook、不新增定时器、不调用 `sendMessage` / `triggerTurn`。
> S0 不修改 `blocks/{format,migrate-plan,render}.ts`、`inject.ts`、`govern/sweep.ts`。

## 1. 范围、现状与共同准入

当前已有 startup/write sweep、过期 agent 归档、治理建议与 user↔user 建议核心；以下仍是后续包任务：

- `jev/wire.ts` 的 `tool_result` / `turn_end` 尚无三类治理事件的置位/消费。
- `renderBlocks` 有 `residentBytesUsed` / `overResidentBudget`，没有真实 index overflow 输出。
- `firstUserReviewPass` 在调用 judge **之前**构造 `n(n−1)/2` pairs；没有首次 host 与持久完成标记。
- `sweep.ts` 的 unchanged key 只有 corpus / today / legacy；预算改变会被原 key 吞掉。
- reload 提醒没有迁移代际持久去重。`/mem review` / `/mem expired` 的覆盖缺口仍归 P7，本文不宣称修复。

共同准入：实际目录是 blocks、memory 开启、主会话、当前 owner/session epoch 有效、未 abort、目录身份及 `MemoryWriteGate` 通过；自动路径不得创建原本不存在的 memory/blocks 目录。事件、预算 sweep、首次 review 另要求 `memory.governance.enabled`。首次 review 及三类事件另要求 Jev 有效接线；模型调用还需当前 registry/client 可用。secure/locked 遵守现有强制关闭及逐写 gate，不借新信号绕过 D8。

所有状态绑定 canonical memDir 与当前 activation/session epoch。shutdown/reload、会话/目录身份切换和显式取消撤销旧 epoch；迟到 tool result、judge 结果与通知回调不能让旧 pending 复活。既有 startup/write sweep 不改其 Jev-off 语义。

## 2. 三类事件：证据、置位、合并消费

### 2.1 触发定义

`tool_call` **只能捕获候选证据**，不能置位。只有对应操作可证的成功终态才置位；模型文字、工具名子串、stdout 里的一句“成功”、未结束 job、命令意图都不是终态证据。

| 事件        | 捕获点与成功触发点                                                                                                                                                                          | 不触发的情形                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `task-done` | Jev 已有 `tool_result`：匹配本 epoch 的 `TaskUpdate`，输入明确 `status: completed`，结果无 error，结构化结果 task 的 id/status 与请求匹配，且可证先前不是 completed、此次真正转入 completed | `TaskGet` / `TaskList` / `TaskCreate`、只改标题、重复 completed、缺失任务、异常/取消；仅 `changed:true` 不足以证明 status 转换         |
| `push`      | 已有 bash `tool_call` 以 shell parser 捕获真实 `git push`，对应 `tool_result` 可证该命令成功完成才置位                                                                                      | `git status` / `log`、echo/注释、解析失败、`--dry-run` / `-n` / help、失败/超时/abort、只拿到 job id                                   |
| `release`   | 同上捕获实际执行的 `release.sh`（程序或明确脚本参数的 basename 精确匹配）或 `gh release create`，成功终态才置位                                                                             | `gh release list/view/download`、未知 release 子命令、`--dry-run` / `--changelog` / help、脚本失败/取消、仅 `release-in-progress` 消失 |

- task 的前态来自已有 todo 只读快照或宿主可信的转换证据；无前态证据保守不触发，不改 todo 的持久化/工具结果契约。`toolCallId` 关联的成功结果只处理一次。
- shell parser 的 flat commands 会丢掉控制流，故**解析命中不等于执行成功**。第一版只接受可证执行的单一命令（可有明确解释器/安全 wrapper）；`git push || true`、`false && git push`、分号/管道/子替换等不能从整段 exit 0 推导目标成功，保守跳过。以后支持复合命令必须有逐命令执行证据，不回退子串匹配。
- 同步 bash 的成功凭宿主定义的终态结果语义判断；`isError:false` 必须同时排除 background、timeout/abort、明确非零 exit。不能用 `failureExitCode` 返回 undefined 直接当 exit 0，也不能把 stdout 伪装的 exit 行当正向证明。
- 后台 job 仅当已有宿主通道能关联本 epoch 的候选 toolCall/job id **及可信成功终态**才接受，复用现有回调；无法关联时跳过。`bash_job status/list` 的一次读取不是新 push/release。不得新增轮询/唤醒或靠解析通知文案补证。
- predict S 的 `release-in-progress → absent` 只可作为检查已有终态证据的时机；不能独立置位（任务可能失败、被 kill、丢失或被 prune）。本包不增加 S 依赖，predict off 不影响有证据的 release 事件。

### 2.2 置位、合并与失败处理

1. 唯一 pending owner 为未来 `govern/signals.ts`。按目录/epoch 保留事件集合（最多三个名字）而不是计数：同一回合多次 task-done、重复 job 通知只留一位。候选 toolCall/job 关联表有界（最多 128，超出丢弃最旧未完成候选，宁可漏触发），完成证据保留至关联移除；不把正文/command 原文落盘。
2. 置位后在**下一个已有 Jev `turn_end` 合并消费一次**：同步 detach 本批 pending，再提交一次 sweep 请求。选代表 reason：有预算信号取 `budget`，否则 `release > push > task-done`；原始原因集合仅作本地诊断，不扩大 `SweepReason`、不逐事件跑三次。
3. 执行中到达的新事件只进入下一批，不能附着在已 detach 的批次而丢失；下一 `turn_end` 才消费。下游 `createSweepRunner` 的同目录重入合并与最多一次尾随执行继续成立，不在完成回调里递归 drain。
4. 普通工具失败/只读结果**不新增置位**，也不抹掉同回合其他已证成功的事件。**abort/取消清全部本 epoch pending 与候选，并撤销在飞提交权**；即使远端 push 实际已发生也不重放旧成功信号。
5. 一次消费是一次调度尝试，不承诺 sweep 一定有写入。锁忙、预算用完、gate 失败只保留 dormant 的重试需要；后续新的外部事件或既有 startup/write 才可重新准入。不能仅因每个 `turn_end`、渲染或失败回调再次消费同一批。abort 不保留 dormant pending。
6. 新状态属于实例闭包，无 module-scope mutable state，无新计时器、后台线程、`sendMessage` 或 `triggerTurn`。没有下一轮就等待自然触发，不能制造一轮。

## 3. 预算信号：真实产生点、独立去重与无循环

| 信号名                 | 唯一生产位置（后续 C2）                                                                               | 判定与载荷                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resident-over-budget` | `blocks/render.ts` 的本次完整 blocks render 计量结果；`inject.ts` 只读透传至 `memorySection.onRender` | 使用该次 renderer 的 `residentBytesUsed > residentBytes`，包括既有 projection reserve 与到期注记；不另写一套估算器。载荷为 used/budget 数值、corpus/render 输入指纹及本地日期             |
| `index-overflow`       | `blocks/render.ts::renderIndexPart` 在实际 whole-topic 行准入结束后                                   | 仅 `kept < ordered.length` 为 true，另给 omitted topic count、有效 `INDEX_MAX_BYTES` 与 index 输入指纹。恰好装下为 false；单行摘要截短、仅 archived 尾巴、文本含 `more` 不算真实 overflow |

C2 只读暴露统计，不改 rendered bytes、topic 排序、预算上限或截断算法。旧回调/布局缺统计表示 **unknown**，不是“已恢复正常”；不从最终 prompt 文本反推 overflow。冻结快照/缓存命中不是新的预算观察，不能扫描整个 corpus 来制造信号。

**不截断用户令**：resident 预算仍为软预算，所有原本合格的 user/global 正文保持完整；只可产生建议，不自动降 scope、归档/删除、缩写正文或丢弃低排序用户令。索引摘要既有截短不等于允许截短用户令。

### 3.1 独立预算 key（唯一 owner：`govern/signals.ts`）

按信号种类保存最新观察 key、pending/attempted 状态；最多每目录两项，目录集合随本 epoch 清理。key 用固定字段序列的 JSON 作 SHA-256，不包含时间戳/每次 render 序号：

- 公共部分：canonical directory identity（realpath + dev/ino）、迁移 identity（有则包含）、信号名、corpus fingerprint、localToday、render policy version。
- resident 部分：resident 输入 fingerprint（含 id/rev、到期标注、audience/projection 计量输入）、used bytes、**有效 resident budget**。
- index 部分：index 输入 fingerprint（可见 topic/计数/summary 所用标签等）、**有效 index byte limit**、omitted count。

相同 key 的普通重渲染不得再次 pending；正常值观察清该信号的超额状态，之后再次超额可再置位。budget 数值改变、影响计量的 corpus/日期/策略改变都改变 key，即使仍超额也可以再触发。失败 key 只由 §2.2 的新外部触发重新准入，不靠同 key render 自动重试。sweep-origin 写失效导致的 render 允许更新观察，但不产生新 sweep；后续非 sweep 的 startup/write/事件可以处理其新 key。

### 3.2 消费及 sweep 边界

- Jev on：与事件在下一已有 `turn_end` 合并成一次请求；Jev off：只记录预算观察，在下一既有 startup/write 机会消费。**不为 Jev off 新增 turn_end handler**。
- 独立预算 key **不塞入现有 sweep corpus 指纹**，不把两种 key 共存到 `sweepCorpusFp`。未来 `sweep.ts` 的 `reason: budget` 入口必须允许经 signals owner 准入的新 key，即使旧 corpus key 相同也不能直接 `unchanged`；其他 reason 的原去抖不变。sweep 不再建第二份预算 seen 表。
- 调用需带当前预算观察；不能复用 runner 构造时的陈旧 render 数据或把 indexOverflow 硬编码 false。同批预算与事件选择 `budget` 代表 reason，避免被旧去抖吞掉。
- `sweep.ts` 继续执行 1000ms/50 写成本/≤500ms 锁等待、CAS 与 gate；不增加调用模型的职责。不保证每个预算信号都有一个建议（例如 index 溢出却没有 global user）。不新增 suggestion kind。

## 4. 迁移后首次 user↔user review

### 4.1 准入与覆盖含义

在成功迁移后的自然 startup/turn_end 机会尝试，不在 render 里运行。只接受 `source: migrate` 且有有效 gen/runId 的已提交 `.layout.json`；fresh 布局、dry-run、失败/回滚中的迁移都不触发。Jev off、child、governance off、registry 不可用、gate 拒绝均跳过且不记完成。

“user 记忆”只指当前 project blocks 的权威元数据 `authority: user`、`status: active`；global/topic 均可、到期 user 仍可，**不以 Jev userLike 概率、正文措辞、source 字符串提升 agent 权威**。session/Hub、agent、superseded/archive/residue 不纳入此 pass。private 或 `looksSecret` 命中整条剔除（截断前检测原文）。

### 4.2 core 内先限候选，再限 pair（用户裁定）

**生效层写死：`govern/review-lite.ts` core 限候选数 → 确定性取对 → host 只做预算/取消，不得放大。**

1. 在创建任何 pair 前，流式筛选合格 user，按 block id 的码点升序选最前 **32** 个（保留总 eligible 数）。不得先全量 `flatMap` 再 slice；不得把未受限全集传给 host。候选选择可线性扫描，保留区最多 32。
2. 对这 32 个中的有序列表，先取相邻距离 1 的所有无序对，再取距离 2 的对，均按 a/b id 排序，去重并以 **64 pairs** 为硬上限。32 项实际最多 31+30=61 对；不做环绕，不自配对。少于 2 个候选合法得到 0 对。
3. 被永久 dismiss 的 pair 不外发、不重建建议；保留覆盖计数区分 examined 与已跳过。host 只能对 core 给定的白名单 pair 分批，不能扩候选或补“更相关”的 pair。
4. 完成标记记录 eligible/selected/pair 计数和选择策略版本。**完成 ≠ 全量覆盖**：不是 32 以外的条目均已复核，也不是候选之间所有关系均已复核。该偏向 id 前部的固定有界首检不承诺公平轮转，后续全面 review 属另一能力。
5. 首检 key 包括迁移 identity、**完整合格 user corpus** 的排序 id/rev/authority/status/privacy 指纹及选择策略版本；不只 hash 选中的 32 项。下次 corpus 变化（包括界外第 33 项变化）仍可再触发；普通重渲染不改变 key。

现有 core 的二次配对必须由后续实现包修复；在修复前**禁止接生产 host**。host 将收到的 n² 数组截短不算满足本契约。S0 不修改其函数签名或现有共享类型。

### 4.3 外发、预算、取消与提交

- host owner 为未来 `jev/first-user-review.ts`，通过现有 `JevClient.ask(duty: review)`；唯一模型调用仍在 `jev/client.ts`。core 给本地 id pair，host 将其转换为单次请求内 opaque alias，外发 allowlist 只含 alias、两边经过 `redactForJev(body, entry)` 的 ≤400 code point 摘录与固定 conflict 问句；先对完整条目做 private/secret 排除。不得发原文件/路径、heading、frontmatter、完整块文件、工具输出、助手/推理、session/Hub 内容。
- 沿用 `redact.ts` 实际管线（有界匹配窗口 → mask → 字段截短），不另做低强度脱敏器。模型摘要不是存储修改，不违反“用户令不截断”的注入/存储规则。被截断的摘录判定只用于建议，不能自动执行取代。
- 总 pass 墙钟预算 **6000ms**（含候选扫描、所有模型批次、锁等待与落盘）；每批 ≤16 pairs、最多 4 次 client ask，另受现有 `QUESTION_BATCH_TOKENS` 与 client maxCalls/maxCostUsd 约束。分批后装不下/额度不足即未完成，不靠新设置、无限批次或下轮自动续跑。
- 复用现有后台队列/超时与 client deadline 能力；每批预算收紧到剩余总预算。provider 不遵守 abort 时宿主仍须按总期限撤销提交权；迟到结果只丢弃。实现期限需用现有 clamp/unref 机制，不能为该功能增设轮询/唤醒链；S0 本身零计时器。
- 用户取消、shutdown/reload、owner/目录/迁移 identity 改变或 signal abort：停止新 batch、撤销提交权、清 pending；不记完成，不把 abort 的旧请求自动续上。
- 完整 pass 要求所有计划 pair 得到合法、有限、0..1 的对应答案（或本地已有效 dismiss）；missing/重复/未知 pair、部分结果、异常、超时、CAS 丢弃任一计划结果都不得标 completed。0-pair 仅在完整扫描成功、身份稳定后可成功记完成，不调用模型。
- 建议提交仍由 `review-lite.ts` 锁内复核双方 live rev/authority/active/privacy，合并并尊重 dismissed；**只建议，不自动取代或删 user**。所有计划结果处理完且建议写入成功后才允许 markers owner 写完成标记。低置信无建议也是合法完成；不能只用现有 `Promise<number>` 的“新增建议数”推导成功。
- 建议已写、标记写失败：不算完成，下次自然触发允许重试，既有 suggestion id/key 保证不重复。不要为跨两个文件的原子性虚称事务保证。需要后续 core/host 提供真实的完整性结果/提交确认，不能 `catch → []` 冒充成功。

## 5. 持久标记与迁移代际（用户裁定）

### 5.1 唯一存储与版本

唯一读写 owner：新模块 **`src/memory/govern/markers.ts`**；唯一文件 **`blocks/.jev/governance-markers.json`**。不得往 `.layout.json`、迁移报告、`ReviewState` / `JevIndexV1` 增加字段，不改其 sanitizer，不建第二个提醒侧车。

文件格式 **v: 1**，只保留当前迁移的一条记录（不增长成历史账本）：

```json
{
  "v": 1,
  "migration": { "gen": 3, "runId": "migration-run-id" },
  "markers": {
    "first-user-review/v1": {
      "completedAt": "2026-11-08T09:00:00.000Z",
      "corpusFp": "opaque-local-fingerprint",
      "policy": "bounded-neighbours-v1",
      "eligibleUsers": 40,
      "selectedUsers": 32,
      "reviewedPairs": 61
    },
    "migration-reload-reminder/v1": {
      "deliveredAt": "2026-11-08T09:01:00.000Z"
    }
  }
}
```

两个 marker 都可缺省；缺省 = 尚未成功，不是“off 时自动完成”。计数必须非负安全整数，selected ≤32、pairs ≤64，计数与本次实际计划一致。时间戳仅用于诊断，**不是去重键**。文件限 64KiB、无正文/凭据/工具输出。

- 迁移代际 = canonical memDir 隔离域内已提交 `source:migrate` marker 的 `(gen, runId)`；gen 是非负安全整数、runId 是非空合法迁移 id。重启/`/reload` 不改变代际；回滚后重新迁移应取得新 gen/runId。缺 identity 不拿时间/corpus 猜代际，跳过并报诊断。
- 写入必须在现有目录锁内 read-merge，复核 live migration identity、gate、abort/epoch；使用既有 no-follow 安全文件原语、0600 临时文件 + 同目录 atomic replace，保留另一 marker。并发 writer 不可用旧快照覆盖另一标记；不在锁内等模型/UI promise。
- 原子替换保证不读半 JSON，**不承诺跨文件事务或 fsync 级崩溃 exactly-once**。未知版本、畸形 JSON、超限、symlink/非正规文件、非法字段读为 `invalid`：**损坏不得被当成“已完成”**，也不得当空文件直接覆写。自动 pass/提醒停止并提供限频诊断，修复/明确移除该派生坏文件后自然重试。
- 物理不存在是合法 `missing`；合法旧迁移 identity 是 `different-generation`，不抑制新迁移，在锁内写新代际时才替换。不为 missing 的 memory/blocks 自动建目录；已存在合法 blocks 下的派生 `.jev` 由 owner 按 gate 安全创建。
- `/mem jev reset-index` 不顺带擦本文件；Jev index GC 不拥有它。回滚/迁移按既有 blocks 目录生命周期隔离该文件，不另对原迁移 marker 动手。

### 5.2 首检完成 key

`first-user-review/v1` 在 `(migration identity, full eligible user corpusFp, policy)` 完全匹配时才抑制。成功后保存的单个 corpusFp 可随下一成功 pass 替换；正文/权威/有效候选变化后仍可再触发。新启动读同 key 不再调用模型。失败不记完成，重试只在下一自然 startup/真实 corpus 变化/新的治理事件发生，不在 render/turn_end 空转重试。

### 5.3 一次性 reload 提醒

- `migration-reload-reminder/v1` **只按迁移代际**抑制，正文/预算变化不能重发；新迁移可再提醒。提醒与 Jev/governance enabled 无关，迁移不是 Jev 治理开关的一部分。
- 生产入口复用主会话已有 startup（迁移完成后或发现已迁移目录），文案必须明确 `/reload`。现有“迁移成功摘要”不是这条提醒的送达证据。重复启动/同代际 resume/reload 在 marker 成功持久后不再提醒。
- 只有当前实际可用 UI 通知端口、对应设置允许通知，且 `notify` 成功返回，才允许持久标记。无 UI、端口缺失/抛错、关闭启动提醒、abort、锁忙、写盘失败均不消费；不能先置 marker 再尝试 notify。console 日志不算 UI 送达。
- markers owner 在短锁内复核代际/已送达状态，调用宿主提供的**同步** notify 回调后原子记 delivered；不持锁等交互/远程回答。并发 startup 通过同锁复查，避免两方正常路径各发一次。host 不缓存一份可独立决定“已送达”的持久状态。
- notify 成功但落盘失败/进程崩溃，下一次允许重试，可能重复一次；这是“失败可重试”与不误消费的有意取舍，不声称跨 UI/磁盘 exactly-once。abort 在 notify 前检查；notify 后观察到 abort 不记 delivered。已成功持久的标记不因之后 abort 撤销。
- 不能复用现有 doctor reminder 的“调用 notify 前先记 notifiedSessions”作为该标记的消费点；P7 要接独立代际检查路径，其他 doctor 提醒语义不改。

## 6. 唯一所有权表（未来文件，不在 S0 创建实现）

| 信号/状态                                                  | 唯一 owner 文件                       | 生产者/消费者与禁止事项                                                      |
| ---------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| 事件名、预算信号名、持久 marker key                        | `src/memory/jev/contracts.ts`         | 只保留声明常量/类型；下游不自行另拼字符串                                    |
| task/push/release 的成功证据捕获                           | `src/memory/jev/wire.ts`              | 复用现有 tool_call/tool_result/终态回调；不持久化，不自行 sweep              |
| 三类事件 pending、候选关联表、epoch 及 turn_end detach     | `src/memory/govern/signals.ts`        | wire 喂证据/推进 turn；memory index 只装配同一实例，不再建第二个 pending Set |
| resident 超额与 indexOverflow 原始统计                     | `src/memory/blocks/render.ts`         | C2 只读产生，inject 透传；renderer 零副作用，不置全局 pending                |
| 两类预算独立去重 key、pending/attempted、sweep-origin 屏蔽 | `src/memory/govern/signals.ts`        | onRender 喂观察，startup/write/turn_end 消费；sweep 不保存第二份预算 seen    |
| core 候选上限/确定性 pair/建议 CAS 提交                    | `src/memory/govern/review-lite.ts`    | 先限候选再配对；host 不重做放大；不调用模型                                  |
| 首检模型批次、在飞取消与全 pass 成功判定                   | `src/memory/jev/first-user-review.ts` | 调 JevClient；只请求 markers owner 记成功；不自己写侧车                      |
| 首检完成 marker                                            | `src/memory/govern/markers.ts`        | 独立 v1 侧车、迁移+corpus+policy key；失败不记完成                           |
| reload 提醒 delivered marker / 迁移身份复核                | `src/memory/govern/markers.ts`        | 同一侧车、migration-only key；只有成功 notify 后消费                         |
| reload 提醒 UI 与启动/迁移机会                             | `src/memory/index.ts`                 | 提供同步 notify 给 markers owner；doctor-command 不再额外发同条 reload 提醒  |
| sweep 普通 corpus 去抖、重入、写预算                       | `src/memory/govern/sweep.ts`          | 原 owner 不变；budget 走已准入路径，不能被普通 unchanged 吞掉                |

`govern/signals.ts` / `jev/first-user-review.ts` / `govern/markers.ts` 是后续包唯一目标 owner，不代表 S0 已创建。新设置如需可在后续方案提出，不能在本包新增 parser/default/setting-specs。

## 7. off / child / abort 矩阵

此表描述新增能力，不能据此关闭 child 既有 A/P cooldown 或诊断等无关行为。

| 信号/标记                      | Jev off（其余门允许）                                     | child 会话                           | abort / 取消 / epoch 失效                                    |
| ------------------------------ | --------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `task-done`                    | 不捕获/不置位/不新增 hook                                 | 不捕获、不置位                       | 清候选/pending；迟到成功不重放                               |
| `push`                         | 同上                                                      | 同上                                 | 同上                                                         |
| `release`（含 S 终止观察）     | 同上                                                      | 同上                                 | 同上；S 消失不充当成功                                       |
| `resident-over-budget`         | render 可给统计；下一既有 startup/write 消费，不新开 turn | 可保持既有渲染统计；不进自动治理状态 | 清 pending/dormant；在飞 sweep 撤销；正常新 epoch 可重新观察 |
| `index-overflow`               | 同上                                                      | 同上                                 | 同上                                                         |
| 首次 user↔user review          | 不调用模型、不记完成                                      | 不扫描首检/不调用模型/不写 marker    | 停 batch、拒迟到提交、不记完成；已经成功提交的建议不回滚     |
| `first-user-review/v1`         | 保留已有标记，不视 off 为完成                             | 不读写新增标记存储                   | 未完成不写；已成功的 durable marker 保留                     |
| reload 提醒                    | 仍可提醒；没有 UI 不消费                                  | 不提醒、不读写标记                   | notify 前检查取消；失败/未送达不消费                         |
| `migration-reload-reminder/v1` | 同代际持久抑制，新代际可再发                              | 不消费                               | 已持久 delivered 保留；未持久可在自然机会重试                |

补充：governance off 时前三类事件、预算调度、首次 review 均不准入，渲染输出照旧；reload 提醒独立。memory off/locked 或无合法 blocks 目录时本表所有新增自动路径惰化。所有关闭路径不增加日志、消息或副作用；例外仅明确获准的损坏派生标记诊断。

## 8. 后续验收清单与 S0 限界

- 事件：同回合三事件恰一次 sweep；失败/只读/重复 completed/dry-run/复杂 shell 假成功零置位；背景 pending 不当成功；abort 后下一 turn 零重放。
- 预算：相同 key 重渲染 100 次仅一次准入；只改预算可再触发且不被旧 sweep unchanged 吞掉；index exact-fit / one-topic-omitted / archive-only 三个反例；sweep-origin 写→render 不形成循环；用户令正文逐字节完整。
- review：大 user corpus 在 core 构造前 ≤32 候选、≤64 pairs；相同输入顺序扰动不改变 pair；private/secret/agent 永不外发；超时/缺答案/取消/CAS 变更/写失败无完成 marker；0-pair 成功无模型；第 33 项变化后可再准入；完成只说明有界 pass。
- 标记：同代际重复启动只送一次；新迁移再送；无 UI/notify 抛错/落盘失败可重试；损坏/未知版本不当 completed、不静默覆写；并发 read-merge 保留双方 marker；旧 epoch 不覆盖新迁移。
- P7 必须另核验 blocks review 的非治理建议及 expired 四组覆盖；本契约不减少这一交付义务。
- S0 验证：`npm run typecheck`、`npx prettier --check docs/dev/memory-governance/p5b-contracts.md src/memory/jev/contracts.ts`、`npx vitest run tests/memory/govern`。不触 golden/fixture，不 install/reload/commit/push。

## 9. 裁定与交接

2026-11-08 用户确认：core 32/64 有界配对、markers 独立 v1 侧车及损坏 fail-closed、完成不等于全覆盖且 corpus 变化可再触发、预算独立去重 owner、C2 只读暴露 indexOverflow、reload 共享 markers 按迁移代际去重。**这些不是待裁定项。**

S0 不改现有 `ReviewState` / `JevIndexV1` / `JevRenderInfo` / judge 签名 / `SweepReason` / 默认值。后续实现如需要扩现有接口，交 root 在所属包集中追加可选 seam；禁止各包私改共享冻结面。本文件冻结上述行为边界，后续接口具体形状仍须同实际成功/失败证据一起验收，不能把当前返回值当作缺失的证据。
