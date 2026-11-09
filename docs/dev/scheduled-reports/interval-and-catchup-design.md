# schedule 间隔调度与聚合补跑设计（#76）

> 基线：`14e95e95`；调研日期：2026-11-09；评审修订：折叠 conditional_pass 的 6 条条件及 2 条观察。本文是新增设计契约，不代表已有能力；本次只改本文，不再调研、不执行实现、测试、安装或迁移。

## 1. 背景与目标

「每 1.5 小时提醒一次」应只有一个任务 ID、一处启停和一次删除，不能要求用户维护两条互补 cron。
目标：新增 elapsed-time 间隔、明确恢复语义、消除无声误排班；保留会话归属、单账本仲裁、执行门与零挂起保证，并在 P1 补齐 secure/locked 注册前硬门。
非目标：常驻全局执行器、hub 代跑、通用排班分组、可靠执行恰好一次、历史副作用重放、修改 cron 的 DST 规则。
最终选择：外部 `every` 字符串；从创建提交时刻起算；仅 `every` 使用聚合补一次；原有 cron/at 仍跳过错过运行。

## 2. 现状摘要（基线能力与评审纠正）

所有坐标相对仓库根；原调研时相关 schedule 文件与 HEAD 无工作区差异，工作区其他已有修改不属于本文。此次修订只采纳评审证据，不重新调查代码。

| 核验项               | 代码证据与结论                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cron 语法与值域      | `src/schedule/core/cron.ts:66-72,86-147`：5 段，数字、`*`、范围、步进、列表及月/星期名；分钟 `0..59`，小时 `0..23`。`x/n` 从 x 到该字段上限，不跨字段进位。                                                                                                                                                                         |
| **起因中的事实修正** | `cron.ts:94-98` 仅要求步进为 1–2 位数字且 ≥1，**没有上界校验**；`:101-120` 对 `*/90` 展开为 `[0]`。因此完整 `*/90 * * * *` 当前不报错，而是每小时第 0 分钟运行，绝不是每 90 分钟；裸 `*/90` 才报 `cron: need exactly 5 fields`（`:128`）。这是静默误排班。                                                                          |
| 当前时间定义         | `src/web-hub/protocol/schedule.ts:61-66,95-113` 定义 `form: background                                                                                                                                                                                                                                                              | message`，`when = {kind:cron,expr,tz} | {kind:once,at,tz}`；`src/schedule/core/spec.ts:39-60` 转出类型。无 every、group、alias 或父子任务字段；background 的 handoff 是结果接手，不是子排班。 |
| 下一次与 DST         | `cron.ts:249-270,359-409` 编译并找严格晚于 after 的 occurrence，前瞻 400 天/50,000 候选。`:229-236,266-268,329-335`：cron 春季不存在的本地分钟跳过，秋季重复分钟只取较早 instant；at 是本地 `YYYY-MM-DDTHH:mm`，落在 DST gap 则拒绝。                                                                                               |
| 关闭会话为何不补     | `src/schedule/agent/clock.ts:188-195` 候选下限含 `armedSince-1`；`core/claim.ts:137,142-145,174-179` 拒绝 armed-after，超过 60s 容差记 missed，不派发。`core/occurrence.ts:167-205,221-245` sweep 裁定旧 occurrence，重开时容差内旧项等 supplemental sweep 也不会执行。                                                             |
| 恢复、锁与 poll      | `agent/clock.ts:244-277,374-381` 启动先 sweep 再 recover 后 arm；`core/recovery.ts:143-181` 只把死 holder 的运行置 unknown/queued→dropped，不重试；`core/lock.ts:4-22,39-41` 为内核 flock、有界等待、无过期锁抢占。`clock.ts:384-405` 现有 poll 仅在文件变化时 sweep/rearm，不能承担无 rev 变化的补跑重试。                         |
| 持久化证据与版本缺口 | `core/spec.ts:174-203,219-243,279-298`：`state.json` 为 `v:1`，有 rev、occ 水位/计数/missedLog、runs；`core/writer.ts:4-20` 锁内重读、原子替换/fsync。评审确认 writer 当前每次写入会强制 `draft.v=1`，reader 的版本和 when 校验也不接受 every；P1 必须改读写版本逻辑，不能只加字段。                                                |
| 参数与错误入口       | `src/tools/schedule-tool.ts:37-45,62-74,148-158` 是工具描述、cron/at/tz schema 和二者互斥文案；`src/commands/schedule.ts:121,160-174` 是 flags 与互斥；`agent/ops.ts:118-135,240-253` 统一解析/调用 validateWhen；cron 错误从 `cron.ts:86-133` 返回。                                                                               |
| **secure 现状纠正**  | `src/schedule/settings.ts:28-32` 默认 false；但评审确认 `src/config/settings.ts` 的强制关闭清单**没有 schedule**，`src/index.ts:573-635,723-726` 只看 `settings.schedule.enabled` 就注册。`agent/mode.ts:42-47,72-84,110-135` 的 E_SECURE 是执行拒绝，**不等于无工具/命令/cap 注册**；secure 零表面是本稿 P1 新要求，不是已有保证。 |
| 展示与 hub 唤醒缺口  | 评审确认 `src/schedule/agent/status.ts` 直接使用 when.tz 且只显示分钟；无 tz 的 every 需类型/秒级分支。hub 除 observation 判定外，`armObserve` 也会枚举候选，新增 every 必须同时排除两处。                                                                                                                                          |
| 冻结件               | `tests/fixtures/schedule-off-golden.json` 为 A 级，禁止重生；`tests/integration/schedule-off-golden.test.ts:29-42,143-159` 固定表面/钩子/提示/HubConfig/无目录。原调研 SHA-256：`23d9d21dee235ba1fdd94e4bc0539b07f97233664dc0bd213e746159359895b6`，当时与 HEAD、origin/dev 均无差异。                                              |

## 3. 总体设计（新增）

### 3.1 模块职责与依赖方向

文字版结构图：`schedule 工具 / /schedule → agent/ops → core/cron + occurrence → claim → writer → lock/state.json`；`agent/clock → claim → 已有 background/message executor`；`hub/scan → reader → 同一时间数学 → projection → UI`，hub 不反向调用 writer。
不建第二个调度器、分组服务或额外账本；数学分支放在现有 `core/cron.ts`，裁定放 `occurrence.ts/claim.ts`，时钟只负责唤醒、去重、有界重试和移交执行。
`core` 保持 pi-free；hub 复用既有白名单闭包，不新增越界导入；无模块级可变状态，新计时继续使用 segmented/unref 时钟及 clampSpanMs。

### 3.2 分组的可判定结论

**不引入 group/别名/父子排班**。`every:"90m"` 是一个原子任务，pause/delete 只需操作这个 ID，不再拆两条 cron。
存量两条 cron 不自动识别/合并（名称相同不能证明语义相同）；用户明确要求迁移时先暂停两条，创建一个 every，核对 next 后删除两条；失败时保留暂停的原任务，不静默恢复执行。

## 4. 接口契约（新增，开发据此实现）

### 4.1 外部字段、归一化与错误

- 工具新增 `every?: string`，命令新增 `--every <duration>`；不公开 `intervalMs`/`everyMs`/`anchorAt`，对绕过 schema 的内部字段输入也显式拒绝。
- 单位仅小写 `s,m,h,d`，`d = 24h`；支持至多 3 位小数，去首尾空白但不接受内部空白、正负号、指数、复合单位、周/月/年；输入 ≤32 字符。
- 语法为 `^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?(s|m|h|d)$`；用十进制整数比例换算（中间乘积也不能丢精度），不用浮点四舍五入。结果须为整秒、安全整数毫秒，范围 **30s..365d（30,000..31,536,000,000ms，含端点）**。
- `90m`、`1.5h` 都归一为 5,400,000ms；`45s`/`0.75m` 为 45,000ms；`0.001s` 因不是整秒而拒绝。相同归一值不是一次定义变更。
- create 必须且只能给 `cron/at/every` 一个；update 三者皆缺则保留原 when，给一个则完整替换旧 when，给 ≥2 个拒绝；空字符串/null 也是错误，不能用来清除或绕过互斥。
- `tz` 只允许伴随本次提交的 cron/at；**every 与 tz 显式同给即拒绝**，从 cron 切换 every 不继承原 tz。every 展示与报告统一 UTC、保留秒，不受进程时区变化影响。
- 统一复用 `OpResult<T>` 的 `E_INVALID` + detail；工具/命令在转换 RawFields 前做同一互斥检查，ops 再防御校验。参数错误不得创建目录、改 rev 或留下半条任务；先校验再 sweep/ensureStore，不能沿用 changeTask 先 sweep 后发现非法输入的路径。

| 输入                             | 必须出现的错误与可执行改法（示例）                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `cron:"*/90 * * * *"`            | `E_INVALID: cron minute step 90 exceeds 59; for an elapsed 90-minute interval, remove cron and use every:"90m" (CLI: --every 90m)`      |
| `cron:"0 */24 * * *"`            | `E_INVALID: cron hour step 24 exceeds 23; use cron:"0 0 * * *" for daily midnight, or remove cron and use every:"24h" for elapsed time` |
| `every:"90min"`                  | `E_INVALID: every unit must be s/m/h/d; use every:"90m" or every:"1.5h"`                                                                |
| `every:"1ms"` / `every:"10s"`    | `E_INVALID: every must be whole seconds within 30s..365d; use every:"45s"`                                                              |
| `every:"90m",cron:"0 * * * *"`   | `E_INVALID: give exactly one of cron, at, every; remove cron and keep every:"90m"`                                                      |
| `every:"90m",tz:"Asia/Shanghai"` | `E_INVALID: every uses elapsed UTC time; remove tz and keep every:"90m"`                                                                |

新建/修改 cron 的步进要求 `1 ≤ n ≤ field.max`（分钟 59、小时 23、日 31、月 12、星期 7）；不同于要求步长 ≤ 当前子范围长度。
存量已保存的大步进 cron **不自动改义/禁用**：历史编译保留旧展开规则；get/list 明示 `legacy-step` 及改法；新写入或重新提交 when 必须严格校验，单改名称/prompt 不强制修旧 cron。
因此 `parseCron(expr, {strictSteps?:boolean})` 默认保留旧行为；工具写入校验显式 strict，历史编译保持宽容；不是全局替换 parser 后让旧任务失效。
工具描述中现有「错过永不补」改成按种类说明：cron/at 不补、every 聚合一次；所有 every 成功回显给唯一 ID、规范化间隔、anchor、next 和 catch-up 策略。

### 4.2 内部类型与函数边界

以下是新增接口示意，原 cron/once 形状不变；存储类型与旧 wire 类型不再强制是同一个别名。

```ts
type EveryWhen = { kind: "every"; everyMs: number; anchorAt: number };
type StoredWhen = LegacyScheduleWhen | EveryWhen;
type CatchUp = { cause: "resume" | "reopen" | "late"; fromExclusive: number;
  through: number; dueCount: number; recoveredAt: number };
// v2 RunRecord 追加 catchUp?: CatchUp；kind 仍为 auto|manual。
// v2 OccState 追加 resumePending?: true；MissedCause 追加 paused。
parseEvery(text: string): { ok: true; everyMs: number } | { ok: false; error: string };
nextEvery(w: EveryWhen, after: number): number | undefined;
planEveryDue(task: StoredTask, occ: OccState, now: number, openedAt: number): EveryDuePlan;
reconcileEvery(store: SessionStore, input: { taskId: string; holder: Holder;
  openedAt: number; deadlineMono: number; gate: ClaimGate }): Promise<AutoClaimResult>;
displayTz(when: StoredWhen): string; // every→UTC；cron/once→原 tz
```

`LegacyScheduleWhen` 即旧 protocol ScheduleWhen；`StoredTask` 为原任务字段但 when 使用 StoredWhen；共享纯类型置于 protocol/schedule.ts，core/spec.ts 转出，不引入 hub→agent 依赖。
`EveryDuePlan` 固定包含 `defHash,decidedThrough,validUntil,latest?,dueCount,catchUp?`，无到期项时 latest 缺省、dueCount=0；N=0→lost，busy→overlap，expired→missed，派发→fired，其余复用原错误/不合格结果。
`openedAt` 为该 owner clock/epoch 创建时固定的 UTC 时刻，在线 poll/changed/refresh/retry 均不重设；deadlineMono 为单轮共享的单调时钟截止点。触发来源仅作诊断，不参与 catchUp 分类。
`CompiledWhen` 改为判别联合，every 分支不创建 Intl formatter；既有 next/count/between/isOccurrence 都支持 every，cron/once 分支结果不变，count 的 capped/区间开闭契约不变。
所有 epoch 值为非负安全整数且在 Date 支持范围内；相加/相乘溢出返回无 next，工具写入拒绝 `E_INVALID`，读到损坏字段则 degraded，不能归零重跑。
解析出的 every 草稿只含 everyMs；ops 在事务中先用旧 anchor 比较归一化执行定义，再决定保留还是重锚，不能每次 resolveDef 都生成新 anchor 导致等价更新也变 hash。
展示门禁：`status.ts`、view、报告、工具/命令、hub/UI 全部按 kind 分支；every 统一 displayTz 与秒级格式，cron/once 继续原分钟格式、原输出字节。实施必须全量 grep `when.tz` 及 cron/once 二分 kind/三元分支，逐项适配或记录安全理由，不以 typecheck 代替检查 JS/模板分支。

### 4.3 起点、暂停、恢复、修改、DST

- 在 create 的**成功 writer 事务**里以 `ctx.now` 写 anchorAt（不是参数解析时的 now）；第一轮是 `anchorAt + everyMs`，创建不立即运行。
- 定义 `A=anchorAt,D=everyMs`，所有 occurrence 为 `A+kD, k≥1`；下一次取 `k=max(1,floor((after-A)/D)+1)`，严格晚于 after；不对齐整点/分钟网格，不按上次完成时刻滚动。
- pause 仍立即撤销 queued message/handoff、不自动杀已有 in-flight；在同一任务变更事务把暂停前未裁定到期项记 missed，推进水位，然后关闭 enabled。暂停期间不 arm、不 sweep、不移动 anchor/水位；重复 pause 是语义 no-op。
- 真正 `false→true` resume：every **不调用 voidUntil(now)**，只开 enabled 并持久化 resumePending；归属会话的 clock 聚合暂停期间的到期项。重复 resume 不产生新补跑；`--all resume` 本身不能代跑，等归属会话重开。
- 恢复保留 A、D 和原网格；3 小时暂停若欠两次，只补一次，下一次仍是原网格中严格晚于恢复裁定时刻的点。暂停不足一个周期且无到期项则不补，并在 owner 裁定事务清 resumePending，避免未来正常轮次被误标补跑。
- 允许编辑的执行字段发生变化，先裁定旧定义、不执行旧 backlog；若最终仍为 every，则在提交时以 now 重置 anchor、void 到 now、清 resumePending。name/enabled 不进 hash；仅改 name 或等价 `90m→1.5h` 不重置；ownerCwd 仍禁止外部编辑。
- 暂停中改定义也重置 anchor，后续 resume 仅聚合新定义提交后的到期项；手动 run_now 不动 anchor/自动水位。
- every 只做 UTC epoch 算术，DST 春进/秋退不影响相邻 occurrence 的 D；本地日期可能重复/跨过，但 UTC instant 不重复、不漏。cron/at 继续现有墙钟/DST 规则，不能承诺 cron 在 gap 也触发。
- 墙钟回拨不早跑，水位不后退；前跳/休眠按同一聚合策略处理，不承诺 NTP 调整时物理耗时精确等于 D；reload/重启绝不重新设置 anchor。

### 4.4 错过运行、唯一标签优先级与有界推进

**唯一政策为聚合补一次，适用新增 every 的两种 form；cron/at 新旧任务均维持 skip。** 不新增 catchUp 设置/工具参数，不把补跑默认为所有旧任务开启。
宽限期固定 **24h**：最新到期项 T 到获得锁的时间 `now-T ≤ 86,400,000ms`（含边界），不是离线期限。只执行最新代表点、不重放历史；长间隔的最新点过期则不补。**D≤24h 的短周期任务不会因长期离线自动失效，关闭多年后仍可聚合补一次。**
恢复/重开/晚到 timer 的一次裁定，处理全部未裁定到期项：

1. 锁外算 `lastK=floor((now-A)/D)`，`firstK=max(1,floor((decidedThrough-A)/D)+1)`，`N=max(0,lastK-firstK+1)`；N=0 不派发。N>0 时首个未裁定点 `F=A+firstK*D`，最新点 `T=A+lastK*D`。
2. 通过 preflight、claim gate、owner/epoch/vault 检查后，在 transactPlanned 内复核 enabled、when.kind、rev、hash、水位。validUntil 为下一网格点减 1ms；若 T 尚在宽限内，再取与 T+24h 的较小值；已过期计划不能设过去的 deadline。过期/时钟漂移重算，计划/锁尝试同时受 deadlineMono 约束。
3. 宽限内且无本任务非终态运行：一次事务将早于 T 的 N-1 项记 missed，T 记 fired，水位推进 T，创建 **至多一个** `${taskId}@${T}` auto run，并清 resumePending。background→dispatching，message→queued；仅 durable commit 后调用 executor。
4. every 若已有非终态运行（两种 form 均同）则不新增、不替换旧 queued：N 项都记 skipped，水位推进 T；已有那一次负责结果。没有非终态但 now-T>24h 时 N 项全记 missed，无 run；两分支均清 resumePending，不遗留可重放 backlog。
5. gate 拒绝/锁忙不推进水位，也不要求改 rev；交下面的独立 poll 与受限重试推进。提交 uncertain 不 dispatch、不盲重试；沿用读回与 unknown(no-outcome)。一旦已 claimed，即使 crash/失败/拒绝也不补发同一窗口。

**catchUp 唯一判定顺序**（仅在 N>0 且确实创建 run 时计算）：① resumePending→resume；② 否则 F<openedAt→reopen；③ 否则 N>1 或 now-T>60s→late；④ 其余不加字段。边界 F=openedAt 不算重开遗留项，迟到恰好 60s 仍在在线容差内。
真正 startup/reopen（含 reload 重建 owner clock）才建立新的 openedAt；在线 refresh 不是重开。因失败留至启动以后处理的旧窗口仍以固定 openedAt 判定；timer/poll/changed 谁先持锁不改变优先级。相同快照和锁时 now 必须得到同一标签，跨 60s/网格边界造成分类变化属于时间变化，不是来源竞态。
`fromExclusive` 为旧 decidedThrough，through=T，dueCount=N，recoveredAt 为锁时 now；它表示合并的到期数，不授权模型重放 N 次副作用。
background prompt/header、message wakeContent、报告与 history 追加中文说明「这是补跑；合并 N 次到期，本次只执行一次」，含区间/原计划时间/恢复时间；compact badge 仅用 `catch-up ×N`。
计数互斥：正常聚合 fired+1、missed+(N-1)；busy skipped+N；expired missed+N；manual 不进这些计数。不因聚合扣回历史 missed 累计数。
每条 MissedEntry 仍 ≤10,000、只保留末 64 条；用商余数直接生成末 64 个 chunk，精确增加总量/seq/totalAfter，不逐 occurrence 或逐历史 chunk 循环，工作量 O(64)，规划测试需观测实际步骤而非只验总数。
`planSweep/autoClaim` 对 every 让位于 reconcileEvery，不能旧 sweep 全记 missed 后再补跑；pause/修改旧定义用同一算术但禁止执行。paused 缺口用 v2 cause=paused。
clock 的 every 顺序为 recover 死 holder → reconcile → arm，覆盖 startup、poll、refresh、heartbeat、timer、resume 后 changed；旧 cron/once 顺序不改。只有这个入口允许历史 T 绕过 armedSince，不能删除旧 autoClaim 的 armed-after 防线。

**poll/重试预算（P1 必须实现，不依赖文件变化）：**

- 沿用 30s poll；只要有 every 任务，每轮在安全门通过后即检查当前快照中的 enabled every 是否 `latest(now)>decidedThrough` 或有 resumePending，**stat/rev 未变也检查**。纯 cron/once 的现有 stat 快路径不变；运行时 locked 在读取/写入调度状态前拒绝。
- 所有来源共用 clock 的串行队列和每任务去重槽（≤8，含 pending/in-flight/retry-pending）；同一任务已有请求则合并，不多挂 timer、不启动并发事务；hash/epoch 变化撤销旧请求。处理顺序采用轮转游标，预算耗尽未处理项保留给下次 poll，避免长周期任务等待下一网格或固定尾部饥饿。
- **单轮最多 8 个不同任务、每任务最多 2 次逻辑 reconcile（首次 + 至多 1 次延迟 2s 重试），总计 ≤16 次；每次 transactPlanned 最多 3 次规划/锁尝试，总计 ≤48 次。** 同轮 poll/changed/timer 不重置次数或截止点；E_SECURE/E_NOT_OWNER 等永久门拒绝不安排短重试。
- 每轮共享 **10s 单调时钟预算（含 2s 退避）**；writer/lock 每次采用 `min(原 2s 锁预算, 剩余轮预算)`，重规划前再检查 deadlineMono；不足 2s 退避则留待下轮，不补挂即时重试。截止后不启动新规划/锁尝试，不用 Promise.race 丢弃已开始的写事务；同步 fsync 等不可中断 IO 仍是已有残留，不能伪称物理抢占或超时后盲重写。
- 每轮结束仍有未裁定项时，下个 poll 即使 rev 不变仍重算；gate/锁恢复即可补一次。失败后 arm 只选严格晚于 now 的正常网格，禁止将同一旧点重新挂 0ms timer；poll 是独立推进保证，不能只靠 rearm 或 heartbeat。
- every 延迟重试使用一个共享最早到期 timer，不为各触发来源各建 timer；不确定提交的读回按每任务去重、≤8 个。纯 every 会话的 clock 活跃 timer 总数 **≤12**（fire/poll/heartbeat/retry 各 1 + uncertain≤8），dispose 全清；混合会话不额外复制既有 cron supplemental timer。

上限是**每任务每个未裁定 backlog 窗口 0..1 次自动派发**，不是全局每次打开只跑一个任务；8 个任务可能各补一次，仍受已有准入预算。后续未来正常网格不算补跑，不增设改变节拍的冷却期。

### 4.5 持久化、版本与混跑

- 新增账本 `ScheduleStateFile.v=2`，不是每个 spec 再放版本号。P1 reader 必须扩充分版本校验：v1 仅接受旧 when；v2 接受 cron/once/every 并验证 everyMs、anchorAt、无 tz、resumePending、catchUp/paused 等约束；未知版本 fail closed，repair 不得自动清空。
- **P1 writer 必须移除无条件 `draft.v=1`，改为保留读入版本**：纯 v1 继续写 v1；v2 的运行终态、receipt、GC/housekeeping 等任何写入保持 v2。首次创建/切入 every 才在同一 flock/原子写事务显式升级，再加入任务；v2 不自动降级。未经过显式升级的 v1 不得写 every。
- v1 无 every 即原义，不填默认 every、不改 anchor、不迁移 hash/计数/runs/approval 化石。every 的 when 固定为 `{kind:"every",everyMs,anchorAt}`；defHash 仍按原六执行字段 canonicalJson+sha256，自然绑定间隔与起点，不另加 hash 算法版本，v1 向量逐字不变。
- 同账本升级已有 cron run/hash 不变，v2 可混存三类任务；事务仍检查 hash、水位、rev。runKey/reportId/receipt/outbox/报告保留与文件名分配规则不变；显示统一经 displayTz，every 秒级、cron/once 原样。
- reload/重启读回 anchor/watermark/resumePending；先恢复死 run 为 unknown/dropped 再裁定新窗口；已决定 T 不重试。hub 只扫描和推送结果，归属会话关闭时不执行。
- **append-only wire**：不扩张旧 ScheduleTaskDef.when 枚举。旧 tasks 仅放 cron/once 投影，追加 `intervalTasks?: EveryTaskProjection[]`（task 为 every 分支，其余 hash/next/totals 同旧投影）；可选 run.catchUp 投影只用于 every，runs 不复制。
- 新 cap `sched.interval.v1` 仅在 schedule on 且 plain 域声明；UI/飞书合并 tasks/intervalTasks 为同一列表、一处操作。无 interval 不发扩展字段；旧帧 schema、PROTO、旧投影不变，caps 仅尾部追加，不把 every 伪装 cron。
- 新 hub×旧 agent 照读 v1；新 agent×旧 hub 的 v1 路径照旧。已连接 hub 无新 cap 时，创建 every 返回 `E_UNSUPPORTED: update hub and run /webhub restart; then retry every:"90m"`；无 hub 本地模式允许创建；启用 hub 但尚无握手则拒绝，提示先连接或显式关闭 hub 后 reload。
- 旧 reader 读 v2 会整会话 degraded，不执行/自动覆写。上线先铺读端并 reload/restart；后连旧 hub 的 v2 本地会话投影不可用，应升级而非 repair；旧 UI 看不到扩展任务，every 的 web 管理必须升级配套 UI。
- hub `service.ts:682-718` 离线 observation 对 every 停用预判 missed，只按已提交 missedLog reconciliation；**armObserve 也必须排除 every 候选**，不因其周期建立无意义 observation 唤醒。cron 两处均保持原样；截断总量/去重继续复用。
- v1 可直接回退；首次 v2 写入是旧版无法继续管理该账本的兼容边界。备份升级前文件；退旧版须人工停所有 owner 后恢复备份，承担丢失新任务/裁定与旧副作用重复风险，不宣称在线无损回滚，不在旧二进制上对 v2 repair。

### 4.6 默认关闭与 secure：P1 补齐注册前硬门

**现有 E_SECURE 执行门不足以保证零表面。P1 必须修复，不能延至 P2，也不能以 mode/wire 测试代替注册测试。**
确定落点：在 `src/config/settings.ts` 两条设置加载入口的既有 secure 强制关闭流程中，domain 为 secure/locked 时复制并覆盖 `schedule.enabled=false`，优先级高于文件/override/会话设置；`src/index.ts` 仅消费该有效设置进行原有注册装配，不往 assembly 文件塞业务逻辑。
总开关仍默认 false，无新增旁路开关/服务。secure/locked 即使原配置显式 enabled=true，也不得注册 schedule 工具、命令、prompt 段、status、hub port/cap，不得建目录或迁移账本；保留已有 orphan guard 的 off 零 IO 足迹，off golden 字节不变。
设置硬门解决激活时零注册；plain 进程运行中变 locked 时，保留 runtime locked、claim、spawn、send 的二次拒绝，阻止后续 IO/迁移/执行，不能靠启动快照永久放行，也不承诺运行中从 SDK 注销已注册工具。
新增**真实 activate 层**集成测试：调用实际 activate（可使用现有 fake pi/受控 domain 环境，不以 mock mode/wire 替代），分别 secure/locked × 配置缺省/显式 true，捕获工具、命令、prompt/status、hello caps、HubConfig 和写盘。空 store 断言无目录；预置 v1 store 断言原始字节/rev/v 均不变且无迁移/额外文件。

## 5. 关键决策与取舍

| 决策                                       | 理由与拒绝的备选                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| every 字符串，不公开 intervalMs            | 与自然需求对应；十进制归一化避免浮点 hash 漂移，毫秒仅留内部。                                               |
| UTC 创建锚点，不整点对齐                   | 「每 90 分钟」不等于某些墙钟分钟；不扩 cron 跨字段进位，不用两任务或假 cron 掩盖差异。                       |
| 仅 every 聚合一次，最新点 24h 宽限         | 只执行最新代表点、不重放历史；长间隔最新点过期不补，短周期长期离线仍可补一次；不改变 cron/at 的 skip 承诺。  |
| 两种 form 同样 0..1，无历史重试队列        | 保留 first-terminal-wins 与副作用至多尝试语义；crash 后可能无结果，不为补偿冒重复执行风险。                  |
| poll 独立推进，标签不用来源判定            | 无 rev 变化也能恢复，有限预算/去重防止自旋；固定 openedAt 与锁时快照决定标签，不让在线 refresh 伪装 reopen。 |
| v2 按需升级、读端先行；不建 group/政策矩阵 | 旧代码不会误跑 every，代价是 v2 无法由旧版管理；every 已消除本例拆排班根因，不预建无需求的扩展。             |

## 6. 实施要点、验收钉子与分期

### 6.1 可执行测试（新增/扩充，不改冻结 fixture）

精确业务时间用 fake clock + 注入 now；**长 timer 另外测试 raw backend**，不能用业务 FakeClock 证明 Node 不溢出。真实锁/进程/activate 接线放 tier2；不以循环 setImmediate 代替截止时间。

| 编号 | 测试落点与断言                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | `tests/schedule/core/cron.test.ts`、`tests/schedule/agent/ops.test.ts`：提交 A=`2026-11-09T10:07:23Z`，90m 首轮 `11:37:23Z`、第二轮 `13:07:23Z`；1.5h 等价；45s 首轮 `10:08:08Z`；不立即跑、不对齐整点。                                                                                                                                                                                                                                                                                                                                          |
| T2   | `tests/schedule/agent/clock.test.ts`、`core/claim.test.ts`：A 后立即 pause，推进 3h，idle 且门通过时 resume 恰好 1 run、dueCount=2，重复刷新/恢复/reload 不重发；下一轮 A+4.5h；两种 form、--all、短暂停 N=0 清标志均覆盖。                                                                                                                                                                                                                                                                                                                       |
| T3   | `tests/integration/schedule-wiring.test.ts`：关会话 5h，90m 的 N=3，只派 1/missed+2，内容有补跑标注；离线 5d 乃至多年短周期仍最多补 1；365d 最新项超过 24h 则 0，边界 24h/24h+1ms 分开断言且不过期 E_BUSY。                                                                                                                                                                                                                                                                                                                                       |
| T4   | `tests/schedule/core/cron.test.ts`：纽约 DST 春/秋 A 分别取 `2026-03-08T06:30Z`、`2026-11-01T05:30Z`，连续 48h 的 every 90m UTC 点唯一且恒 D；进程 TZ 改变结果不变；every+tz 拒绝，cron 原测试不变。`agent/status.test.ts` 补 every 秒级/UTC，cron/once 状态文案字节不变。                                                                                                                                                                                                                                                                        |
| T5   | `tests/tools/schedule-tool.test.ts`、`tests/commands/schedule.test.ts`、ops：越界步进/单位/上下界/非整秒/互斥错误含可复制改法且无写盘；存量 */90 保留旧义并提示，新写入拒绝。                                                                                                                                                                                                                                                                                                                                                                     |
| T6   | `tests/schedule/core/{reader,spec,writer}.test.ts`：v1 hash 不变、首次 every 原子升 v2、重启 A 不变、等价间隔不改 hash、执行变更重锚；未知版本不得 repair；v2 经终态/receipt/GC 写入仍为 v2。**新建 `tests/schedule/core/interval-timer-backend.test.ts`**：以可观测 raw backend 驱动实际 createSegmentedClock 调度 365d，每段 delay>0 且 ≤MAX_TIMER_DELAY_MS，累计到期才触发一次，跨段取消后不触发；不得仅以业务 FakeClock 替代。                                                                                                                |
| T7   | `tests/schedule/core/claim.test.ts`、`agent/clock.test.ts`、`tests/integration/schedule-fault-matrix.test.ts`：竞争/锁边界/uncertain/crash 不重发，计数互斥、水位单调；gate 与锁分别失败后保持文件/rev 不变，撤销失败条件，不推进到下一网格，仅靠下一 poll 即补 1；验证每轮 ≤16 reconcile/≤48 规划锁尝试、10s 截止和轮转公平性，纯 every timer≤12、dispose 清空、无 0ms 自旋。                                                                                                                                                                    |
| T8   | `tests/schedule/core/claim.test.ts` 与 `tests/web-hub/hub/schedule-{project,service,reconcile}.test.ts`、UI/integration：注入 N=`1,000,000,123` 个到期点（远超 64×10,000），聚合 M=N-1 个 missed；设 C=ceil(M/10,000)，保留末 64 chunk、末 seq=旧 seq+C、末 totalAfter=旧 total+M，逐条 from/to/count/totalAfter 精确；注入规划步骤计数，chunk 生成≤64、逐 occurrence 步骤=0，every 路径不调用旧枚举器，大/小 backlog 的步骤上界一致，不能仅验最终 missedTotal。另验 v1/peer 矩阵、单行删除、observation 与 armObserve 均无 every 候选/多余唤醒。 |
| T9   | `tests/integration/schedule-off-golden.test.ts` + **新建 `tests/integration/schedule-secure-activate.test.ts`**：实际 activate 在 secure/locked、尤其显式 enabled=true 时无工具/命令/段/status/cap/HubConfig.schedule/目录/迁移，预置账本字节不变；mode/wire 与运行时 locked/claim/spawn/send 再拒绝用例仍保留，不能替代 activate 覆盖；off SHA 完全不变、禁止重生，回归 C-S1…C-S8 与 cron/at skip。                                                                                                                                              |
| T10  | `tests/schedule/agent/clock.test.ts`、`core/claim.test.ts`：固定同一 openedAt、快照与锁时 now=T+1ms，对 timer/poll/changed/在线 refresh 的到达顺序做排列，恰好 1 run 且均无 catchUp；真重开遗留 F<openedAt 均 reopen；resumePending 均优先 resume；N>1/迟到>60s 均 late，含 60s 边界。                                                                                                                                                                                                                                                            |

表中 core/agent 简写相对 `tests/schedule/`。下游执行：`npx vitest run tests/schedule tests/tools/schedule-tool.test.ts tests/commands/schedule.test.ts tests/web-hub/hub/schedule* tests/web-hub/ui/schedule*`；真实接线 `npx vitest run tests/integration/schedule-*.test.ts tests/conformance/schedule.test.ts`。新集成测试按 tiers 登记；再跑 typecheck、tier1、对应 tier2、fixtures diff，并审计全量 when.tz/二分 kind 分支。本次不运行这些命令。

### 6.2 两期独立交付

P1 完成安全硬门、消费端与运行内核但**不开放新任务生产入口**；不能先发布 skip 的 every，下期再偷偷改变补跑语义。下表使用仓库相对路径，web-hub 表内省略前缀的 hub/UI 子路径沿相邻完整路径定位。

| 期                     | 文件清单（后续实施，不属于本次修改）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 验收与回退                                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1：安全/读端/内核先行 | **`src/config/settings.ts` 两入口加入 secure/locked 的 schedule 强制关闭，`src/index.ts` 仅消费有效设置的注册装配核验**；`src/schedule/core/{cron,spec,reader,writer,occurrence,claim}.ts`（reader 分版本/when 校验，writer 移除强制 v=1 并保留版本）；`src/schedule/agent/{clock,wire,ops,view,status,bg,message,report-file}.ts`（无 rev poll/预算/去重/标签、状态秒级显示、聚合内核，暂不接受外部 every 创建/转换）；`src/web-hub/protocol/schedule.ts`、`hub/schedule/{project,service}.ts`、`hub/feishu/schedule.ts`（observation+armObserve 排除 every）；cap 接线 `src/web-hub/agent/index.ts`、`src/schedule/agent/coordinator.ts`、`src/web-hub/hub/assembly-channels.ts`；`src/web-hub/ui/src/logic/schedule.js`、`components/schedule/{SchedulePanel,ScheduleTaskDetail,ScheduleRows}.vue`、`taskRow.ts`、`i18n/schedule-extra.ts`；`tests/schedule/agent/status.test.ts`、新 raw backend/secure activate 测试、对应 core/agent/hub/UI/协议测试、`tests/tiers.ts`、scheduled-reports README。 | T1…T4/T6…T10 的内核、读端、安全与旧输入不变部分；secure 实际 activate 是硬门，不能条件豁免。临时 v2/测试端口驱动，不向真实 v1 写 v2、不公开 every schema/flag。可独立发布，真实使用无持久化跨越点；混接后续 P2 的 v2 账本则适用 v2 回退限制。 |
| P2：生产入口与诊断交付 | `src/tools/schedule-tool.ts`、`src/commands/schedule.ts`、`src/schedule/agent/{ops,wire,view}.ts`、`src/schedule/core/cron.ts`：转换、严格写入步进校验、提交锚点、首次 v2 写入与 cap 准入；`src/sysprompt/schedule-section.ts` 仅复用展示、不动注册门；对应 tools/commands/ops、上述 integration/conformance 测试、scheduled-reports README。两种 form 同期支持。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | T1…T10 全部及发布门禁；P1 部署并 reload/restart 后才允许首个 every。首次 v2 写入不可直接兼容回退，首次聚合副作用不可撤销；关闭 schedule 只阻止后续执行。                                                                                      |

发布顺序不改总开关默认值；P2 才将 */90 的严格拒绝及 every 改法一起交付，避免建议指向不存在的入口。
评审 6 条条件及 2 条观察均已转为 P1 契约/验收，不新增阻塞性待定项。原产品取舍仍是暂停不冻结间隔、恢复聚合一次，以及 30s 最短间隔允许高频付费运行；本稿默认不变，未获实施授权前只交付设计。
