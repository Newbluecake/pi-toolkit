# 本仓记忆治理现状与 Dream 缺口

> **现状固定于 `cebf26f240467fc7e35a298fc88922119962900e`，研究日期 2026-11-11。** “源码已有”“生产接线已有”“真实现场可用/已授权”分别陈述。本轮没有访问真实记忆、配置、布局或运行中宿主，不能证明现场 ready。

## 1. 背景与核验方式

本仓不是缺少“清理器”，而是需要把已有确定性治理、受控 revision 与新增跨会话证据组织成**只读可审阅提案**。不再实现另一套到期、写入、确认、计费和恢复系统。

输入本仓研究报告已完整读取；按交接坐标定向复核关键源码，而非重扫私有会话。已读 [memory README](../../docs/dev/memory/README.md) 的总约束、#36 及 #50 后续装配记录，[memory-jev skill](../../skills/memory-jev/SKILL.md) 全文。README 保留历史分包记录，后面的实际 wire/native/I1 状态覆盖前面的 pending；不能只摘早期“未实现”，也不能把最终接线误称 stock provider 已认证。

以下均为**基线静态证据**，不是本轮运行测试或调用真实工具的结果。

## 2. 现有能力地图与精确坐标

| 能力/职责            | 基线事实                                                                                                                          | 源码坐标（基线行号）                                                                                                                                                                           | Dream 复用方式/限制                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 块模型、日期         | 一块正文上限 1024B；authority、scope、audience、status、expires、until、private 等；`isExpired` 为 `expires < today`，当天有效    | [blocks/format.ts](../../src/memory/blocks/format.ts) `BlockMeta:9–33`、`isExpired:46–48`、日期验证 `156–164`                                                                                  | 复用解析/日期，不引入模型日期判定；文件布局不自动迁移                                            |
| rev/CAS              | rev 为 version + 原文 SHA1 前 6 位；update 锁内两次读 rev、原子替换                                                               | `src/memory/blocks/rev.ts:1–4`；[blocks/store.ts](../../src/memory/blocks/store.ts) `replaceBlockLocked:193–224`                                                                               | rev 防陈旧，不是抗恶意碰撞证明；候选另绑 raw SHA256                                              |
| 确定性提案           | active agent 日期到期进 archive 计划；user 到期、until、snapshot、oversize、resident budget 等只建议                              | [govern/sweep-plan.ts](../../src/memory/govern/sweep-plan.ts) `planSweep:16–95`                                                                                                                | 首期只调用纯 planner，不调用 `runSweep` 获取计划                                                 |
| 到期注入资格         | blocks 到期 agent 不再入选，user 保留相应范围资格；private/secret 过滤；并非所有用户令常驻                                        | [govern/eligibility.ts](../../src/memory/govern/eligibility.ts) `eligible:58–73`；`src/memory/blocks/render.ts:120–194`                                                                        | 治理和注入分开；不会擦除已投递上下文                                                             |
| sweep 生产接线       | startup/write、自然 turn_end 的 task/push/release/budget 机会；不是 nightly cron；until 没有通用条件求值器                        | `src/memory/index.ts:312–405,534–574,653–782,966–978`；`src/memory/jev/wire.ts:2981–3090`                                                                                                      | Dream 不启动宿主来“只读查看”，避免自动迁移/sweep/模型首检副作用                                  |
| sweep 应用与恢复     | 仅确定性 agent 日期到期自动归档；1000ms 总墙钟、50 写类成本单位（不是 50 块）、锁等至多 500ms                                     | `src/memory/govern/sweep.ts:57–121,166–326,399–476,482–558`                                                                                                                                    | 不抢原归档 owner；恢复不改 expires，仍过期可能再归档                                             |
| 目录单写者           | `withMemoryDirLock<T>(dir, body:()=>T, opts?)`；body 同步；只回收可证明死亡的同机 owner，年龄不能破锁                             | [lock.ts](../../src/memory/lock.ts) `MemoryLockOpts:43–48`、`withMemoryDirLock:57–131`                                                                                                         | 应用复用同 canonical memDir 锁，不持锁等模型/人；首期严格只读不取真实记忆锁                      |
| 原生命令展示         | blocks `/mem review`、`/mem expired` 只读，`review --run` 也只显示                                                                | [command.ts](../../src/memory/command.ts) `491–514`；`src/memory/govern/display.ts:1–76`                                                                                                       | 不能把旧 review-lite 可写工厂当原生命令菜单；不新建 Dream slash                                  |
| 旧写后取代           | 非 explicit 仅 whole supersedes≥0.85、每写最多2；conflict 不自动；agent→user 永禁；旧块单边 CAS                                   | `src/memory/tool-v3.ts:576–627`；`src/memory/govern/supersede.ts:4–14,131–206,284–337`                                                                                                         | 已实现但不是 Dream 的授权入口；不借 explicit 字段绕过审核/新证据门                               |
| 普通项目用户令       | #26 后通用项目工具改写/删除用户令无确认硬门，只有回显/TUI warning/skill 策略；不是 Hub/session 权限                               | `src/memory/tool-v3.ts:896–996`；`docs/dev/memory/README.md` Jev 不变式11与残留风险                                                                                                            | Dream 必须额外落实精确授权；标签 authority=user 不证明真人来源                                   |
| 增量预算/调度        | `incremental.enabled=true`，`auto=false`，`jobCostCapUsd=0`；quiet/idle/cooldown，自然活动 owner                                  | [settings.ts](../../src/memory/settings.ts) `172–183,347–360,468–477`；`src/memory/govern/incremental.ts`                                                                                      | 不是默认付费或自动改正文；不为了 Dream 改 cap/auto 或另造 timer                                  |
| P50 唯一 host        | selector/source/prepare/review/E 已接；当前菜单产 merge-survivor/retire，不产普通 pair rewrite、expires 或 delete                 | [govern/revision-host.ts](../../src/memory/govern/revision-host.ts) `RevisionHostDeps:73–98`、`createRevisionHost:202`、`actionLocked:884–893`；`src/memory/govern/revision-selector.ts:81–99` | 可复用窄动作，不能把 E 支持集当现有 producer 支持集                                              |
| D 冻结/custody       | 真实锁内冻结 raw/rev/身份，模型锁外；只有真 freeze 授私有 LIVE；历史解析不授能力                                                  | [govern/revision.ts](../../src/memory/govern/revision.ts) `RevisionFreezeSpec/Deps:414–434`、`revisionBlockFromRaw:456–513`、`freezeRevisionInputsLocked:516+`                                 | Dream JSON 只能供导航，不能重造 LIVE、source custody 或确认收据                                  |
| C raw 审计           | `before.md` 精确 Buffer；prepared/expected-after 屏障；真实 syscall observation 后 committed；unknown 不补偿/重试                 | `src/memory/govern/revision-audit.ts:582–863`；README 的 C/E/I1 节                                                                                                                             | 并非普通 CRUD、sweep、旧 supersede 都有相同 raw 审计；不许泛称全系统一键回滚                     |
| E 唯一 revision 提交 | `commitAction(memDir,request,deps)`；request 只有 origin/actionId/expectedRev/proposalDigest/signal；来源/lease/审计/CAS/权限再核 | [govern/revision-commit.ts](../../src/memory/govern/revision-commit.ts) `CommitActionRequest:37–43`、`RevisionCommitDeps:72–88`、锁内 `294–470`                                                | 不能塞 Dream 自定义 origin、正文/自然语言条件；user delete 所有 origin 硬禁；merge 不隐式 retire |
| 原恢复入口           | native `restore --revision <actionId>` 已接：plain main TUI、真实 owner、完整预览、一次确认、raw+audit CAS                        | `src/memory/command.ts:610–770`；`src/memory/govern/revision-audit.ts:1123–1268`                                                                                                               | committed 精确恢复，不修 unknown；native popup 不是 Web 真人来源证明                             |
| Web review / ledger  | I1 有当前 LIVE custody→R4→E/C 链；history 仅 view/keep；commands 唯一32槽/29min once ledger                                       | `src/memory/index.ts:1081+,1140–1264`；`docs/dev/memory/README.md:1375–1450`                                                                                                                   | 复用现有确认与结算，不创建第二个命令账；报告存在不等于 LIVE                                      |
| provider binding     | trusted CODE 精确 registry 稳定 binding；要求真实 tokenizer/template/prices/routes/classifier hard cap；stock 不具认证            | [jev/p50-binding.ts](../../src/memory/jev/p50-binding.ts) `P50BindingResolution:31–39`、`resolveNativeP50Binding:43–69`、token contract `72–86`；`src/memory/jev/wire.ts:864–913`              | 缺能力就是 unsupported，不猜 token/模型路由/价格，不绕 proxy 或 A ledger                         |

## 3. 权限、到期与冲突的实际边界

### 3.1 用户规则不能由预算、年龄或标签作废

- `scope=global` 是本项目常驻，不是 Hub；global 预算超额仍完整保留并提示，不截断/自动降级。topic/user 仍按相关性召回，不是每轮常驻。
- user 到期标待确认；agent 明确日期到期的注入过滤和归档已有确定性实现。`until` 只有核对建议；task/push/release 成功只提供 sweep 机会，不证明任意自然语言条件成立。
- scope/authority/audience 改动与用户令正文改写，需要用户明确决定；模型不能自封 user、从 global 降 topic，或用频率/字节数代替授权。
- 不得用“较新”独自证明覆盖。Dream 新增规则应更保守：原始用户 **explicit correction** 可核验才提议 supersede；否则留 conflict/unknown。既有旧路径有更宽能力，不代表本任务可调用。

### 3.2 既有审核不是无条件执行权

- `handleReviewLite` 的可变更工厂不能证明原生 `/mem review` 具备对应写菜单；现 command 明确只读。
- Web revision review 需同 owner 当前 LIVE，历史 JSON 不能恢复执行资格。
- E 自动权限核独立真实 relation/generation/coverage、完整输入、≥0.90 等；不能用旧取代的 0.85 或 `autoEligible` 替代。用户 delete 在 E 永禁，不代表普通 project delete 也被全局禁止。
- 原生归档/取代恢复、trash 恢复和 raw revision 恢复对象不同。恢复过期块不续期；恢复旧块不递归恢复关系链；删 successor 不等于撤销旧块被取代。

## 4. 已有装配与未认证事项

### 4.1 不再是从零建设

#50 已有 A 唯一 client/费用预算、B generation/coverage、D 冻结与私有保管、C raw 审计、E 唯一提交、F scheduler/host/settings/wire、native 恢复和 I1 Web/custody/startup 诊断。I2 streaming 也有 trusted CODE 条件支持。README 中早期 pending 是历史记录。

但是，**没有任何 stock provider 因离线测试而获认证**。真实 tokenizer/模板开销、classifier 硬 cap、完整 canonical routes、价目/实际身份等仍 BLOCKED。离线 byte-token/loopback SDK、synthetic identity/usage 不等价于真实付费、Hub 部署或现场数据验收。默认 cap0 仍足以令 P50 effective-off。

### 4.2 不许被 Dream 绕过的门

| 门                             | 固定结论                                                   | 后续要求                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `auto=false / jobCostCapUsd=0` | 源码默认，不查用户配置推断现场                             | Dream 文档不改开关，不产生花费授权                                                                                                     |
| G1                             | 正式真实正例 `10<20`，仍 BLOCKED；G2 后续 PASS 不能替代 G1 | [pg-report](../../docs/dev/memory-governance/pg-report.md) `7,470–493,549–555,722–724`；不调阈值、不凑样本                             |
| P8                             | 真实数据暂停/停旧 writer/备份/dry-run/过目/迁移逐步授权    | [治理 plan](../../docs/dev/memory-governance/plan.md) `869–890` 为历史流程；其中旧工具/块数期望不能拿来验收当前现场；本轮连第1步也没做 |
| secure/locked/child            | Jev/D8、plain-main、scopes、真实 owner 硬门继续有效        | 不给后台 child 开普通主会话写权，不跨 project/session/Hub                                                                              |
| off 与 wire                    | I9 off 字节不变、I10 append-only、旧 runtime 名称保留      | 不改 frozen fixtures 让测试“适应 Dream”                                                                                                |

## 5. 真正缺口与最小新增职责

1. **证据输入清单**：未发现可直接复用的“获批跨 session 最小化证据 export + completeness manifest”合同。首期由获批离线快照输入，不新增会话爬虫。
2. **窗口与失败水位**：P50 的前16块、固定页/128 job fences 是内核有界发现，不是跨 session 完整扫描证明。Dream 需独立记录采集/已报告水位、完整性、失败/迟到输入与消费幂等。
3. **候选解释层**：把 oldrev/raw、原始 source、explicit correction、保留/丢弃事实、理由和精确建议 diff 汇成只读报告。Dream 来源证据不冒充 P50 模型 provenance。
4. **审核生命周期**：离线 report 的 reject/expired/blocked 不能直接成为 E capability；未来需重新冻结、保留同内容绑定并经现有确认。
5. **评估**：缺少本主题真实样本评测；当前块数和预算提示不是删除依据。需另授权小样本 dry-run，不外发私有/secret，也不把报告变成现场自动迁移。

## 6. 后续核验纪律与已排除路线

- 在新 HEAD 开发前按本表关键符号重核；先读对应 README，不把本文件视为永久代码真相。
- 排除：新增夜间 cron、启动完整 `wireMemory` 做只读扫描、旧 `/mem tidy`、用 `review --run` 执行整理、直接改 Markdown、复制第三方自动写 prompt、重建第二 client/ledger/锁/确认、用历史 JSON 重授 LIVE。
- 尚未知：真实布局/是否已迁移、用户生产 cap/owner/provider、运行中版本、真实样本质量和费用。保持未知，禁止为补齐报告遍历私有会话或真实 memory。

具体契约与分包见 [实施方案](implementation-plan.md)。
