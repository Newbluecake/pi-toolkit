# #36 记忆治理 · 现状调研（Explore r_W6S30PGX，2026-11-05，由主会话落盘）

> 只读调研结论的落盘版（原文由 deepseek-flash Explore 产出；行号以 HEAD c7a134df 为准）。配套：`docs/dev/memory/predict-eval-2026-11-05.md`（预测注入准确率评测）。

## A. 现有机制（触发方式 / 效果 / 缺口）

### A1 写入路径

- `memory` 工具七命令（`tool-surface.ts:26-41` 冻结 schema；`tool-v2.ts:1219-1290` 分发）。`delete` = 软删进 `.trash/<id>-<name>`（`restore --trash`）。写/append 返回 `budget:` 行。**缺口**：写路径不表达条目寿命。
- 硬上限：`tool-v2.ts:340-368 assertWithinHardLimit`，文件增长越过 `coreBytes`(1600)/`topicMaxBytes`(16384) 抛错。只有字节压力，没有时间压力。
- Jev 写后打标 `write-port.ts:186-289 runAfterWrite`（同步，总预算 6s），只对新增 hash 条目打标，产 `EntryTags{type,importance,tags,guard,temporal,userLike}`。delete/rename 不在打标域。
- `temporal`：`questions.ts:213-226`（permanent/dated/event），`decide.ts:137-145` 落库，默认 permanent；`review.ts:199-214` 正文命中日期/版本号也算 dated。**判的是「措辞带日期」不是「会过时」**。
- `looks temporary` 回显：`format.ts:183-185`（temporal∈{dated,event} 且无 expires/until）。纯建议；skill 要求看到就补 expires ⇒ 诱导给永久用户令加到期日。
- `similar:`/`conflict:`：`write-port.ts:150-178` + `format.ts:176-196`，只在写入瞬间、compare 池 = 同文件 + 词法 top-N。
- 行内注释解析：`entries.ts:71-190 parseInlineMeta`（user/lesson/expires/until/tags/private），authority 缺省：手写=user，`source: agent`=agent（`entries.ts:494-505`）。
- `expires` 到期：只有谓词 `entries.ts:227-235 expiredEntries`；**不隐藏、不过滤、不删、不降级**。可见后果：`/mem` 计数（`command.ts:390-396`）、doctor D17 warn（`doctor.ts:503-512`）、启动提醒一行（`wire.ts:2578-2579`）、Jev U/A/E/P 注入注记「（已到期，待用户确认）」（`jev/format.ts:46-58`，`wire.ts:1161`）。
- `until`：`entries.ts:237-239`，只列给人看（`/mem expired`，`expired-command.ts:141-151`），无条件语义、无「已问过 N 次」记账。

### A2 治理路径

- `/mem doctor`（D01–D19）：手动 + 启动提醒（仅 error/D01 + extraLines 软提示，`doctor-command.ts:283-326`、`wire.ts:2566-2600`）。
- `/mem tidy`（journaled txn，`tidy/*`）：手动 TUI；`--batch` 归档信号 `archive-signals.ts:49-63`（S1 archived/S2 status:stale/S3 updated 超 180 天/S4 完成词/S5 孤儿/T triage≥0.9），**不含 expires/until/temporal**，粒度是**文件**。
- `/mem restore`（`tidy/restore.ts`，`--trash`）。
- `/mem review`：周期自动但只产建议，`wire.ts:1096-1121 maybePeriodicReview`（≥7 天 ∧ corpus 变化 ∧ 每会话最多一跳）；`/mem review` 逐条 select（`review-command.ts:84-270`）；obsolete 候选只覆盖 dated/event 或带日期版本的条目。
- `/mem expired`：唯一到期执行器，纯手动、仅交互主会话（`expired-command.ts:114-152`）。
- 预算默认 `coreBytes 1600 / blockBytes 2400 / topicWarn 8192 / topicMax 16384`（`settings.ts:423-427`）；超额 → D02/D04/D09 + tiered 降级 L1–L5。
- schedule/goal 无 memory 接线；无任何自动 tidy。

### A3 注入路径

- system prompt `## Memory`（`inject.ts` → `tiered.ts`）：primary（core.md，或首个 `pin:true`）整文件/整 section + 额外 pin 文件 + topic 索引行（name + `when` + description + ` · stale`），超预算 L1–L5 降级（`tiered.ts:706-713` 选 primary/extraPinned/topics）。**过期条目原样注入**；`tiered.ts` 不读 expires/until/temporal；jev on 时 `stripInlineMeta` 剥掉注释 ⇒ 期限在 prompt 里不可见。
- Jev U 层（`before_agent_start`，threshold 0.6 / max 3 / 4096B，同会话去重，`isStaticCore` 排除 core 条目）、A 层（high risk tag + 24h 冷却）、E 层（tool 报错 0.7 top-2）、B 层（被改后重注）、P 层（预测预注入，max 2 / 2048B，与 U 合并）。

### A4 临时性信号（全部只读、无动作）

`expires`、`until`、sidecar `temporal`、正文日期正则、frontmatter `status: stale`（无代码写它）、frontmatter `updated`（任一编辑即刷新 ⇒ 活跃项目永不 stale）、归档信号 S4、侧车 `at`、review `dismissed`。

## B. 数据画像（2026-11-05，`~/.pi/agent/memory/-home-bluecake-ai-pi-toolkit/`）

- 17 文件 / 179 条（55,027 B）；行内注释 36（`mem user` 32、`mem lesson` 0）；`expires`/`until` **0/0**。
- 侧车 `.jev/index.json` 226 条，约 **62 条孤儿（27%）**（`gcIndex` 仅上限触发，`index-store.ts:301-340`）；15 条存活条目未打标。
- 存活条目 temporal：permanent 106 / dated 48 / event 10。
- 5/32 条用户令被判 dated|event（userLike ≥0.90），原因是用户令规范格式带日期戳「（2026-11-05 用户令）」。
- review 上次 2026-11-02；现存 1 条 obsolete 建议悬空（目标条目已改写）。
- `core.md` 1579B / 1600B（98.7%）。
- 全机 21 个项目约 700 条，`expires=` 仅 2 条、`until=` 仅 3 条。
- 已推翻未清理实例：`core.md:13`「验收优先 deepseek-flash」（11-05 用户令）vs `pitfalls.md:33-34`「验收走 deepseek-v4-pro」（两条均为用户令，互斥并存）。
- 时效性条目例：`quota.md:16`（读数快照）、`multi-agent-experiments.md:11`（冻结进度）、`pitfalls-subagent.md:14`（条件型事实写成散文，无 until）。

## C. 五个治理缺口

1. 到期机制从写入到执行全线空转，唯一执行器是人手且只在 TUI。
2. 过期信息在 system prompt 通道被完全抹掉（不读期限 + stripInlineMeta + core 条目被 `isStaticCore` 排除出 Jev 注记层）。
3. `temporal=dated` 语义错位（措辞带日期≠会过时），同时污染写入建议与 review 覆盖面。
4. 只有字节压力没有时间压力；core 98.7% 时挤谁无规则；tidy 全手动；review 自动半场只产建议。
5. 矛盾/重复无周期核对；派生数据（侧车孤儿 27%、注入时间戳孤儿、悬空建议）不自清。
