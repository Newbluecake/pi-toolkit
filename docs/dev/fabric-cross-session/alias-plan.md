# fabric 跨会话：会话别名（alias）实施方案（r4）

> 车道：**L2+**（协议加可选字段和一个新 op、hub 新增一张持久化绑定表、mention/工具/web 都要改；不改运行状态机与投递语义）。
> 前置：频道方案 `channel-plan.md` r3 **全部合入**。核对基线 dev@b76e4e69：CH0–CH5、CHU、IB1/IBP/IBU/IBW、CH1（`62f62d94`）已提交；CHW 在工作区开发中（`stack.ts`、`index.ts`、`agent/xs.ts`），CH6 未做。本文是 phase2 / reply / channel 三份方案的增量，凡未提及处沿用它们的正文与拍板。
> 评审：r1 打回（2 Blocker / 10 Major / 3 Minor，见「§R1 评审处置」）；r2 复审打回（0 Blocker / 7 Major / 1 Minor，见「§R2 复审处置」）；r3 复审打回（0 Blocker / 3 Major / 1 Minor，见文末「§R3 复审处置」）。
>
> **r4 的变化（只补 r3 复审指出的三条误投路径和一处表格遗漏，其余不动）**
>
> 1. **别名模式下 send 只做精确解析**：hub 对 `aliasUsable` 请求方的 send 一律只按完整 sessionId 精确查找；找不到 ⇒ `NO_TARGET`，不回落到前缀、别名或名字层。线上没有新字段（R3-1）。
> 2. **能读与能写分开**：`aliasUsable` 改为按「本次运行是否声明了 cap」判定。`wedged` 和 `disabled` 期间只禁写，读路径继续用内存里的旧表，别名层照常生效；降级守卫覆盖所有「没有可信表」的状态。新增状态×行为矩阵（R3-2）。
> 3. **损坏不自动挪走**：主文件损坏或不可读时原地保留，每次启动都是 `degraded`，直到有人手动修复或移走它；删掉 `.bak` 自动改名（R3-3）。
> 4. **授予的共同步骤**：所有成功的 set/take 都先执行同一个步骤 G（S 原有的 held 转为 cooling，并清理 S 自己同骨架的 cooling），然后再执行各行的差量（R3-4）。
>
> **r3 的变化（都朝更保守、更小的方向）**
>
> 1. **绑定表只有一个写者**：人发起的 op 事务。在线/离线状态改为**只存内存、不落盘**的派生状态；过期和冷却到期都是**读时谓词**，不再有任何自动写入。hub 重启后，每个离线持有者的保留期从加载时刻重新起算（R2-2/R2-3）。
> 2. **钉住完整 sessionId**：r2 的 `pin` 字段（12 字符 ref）被删掉。别名模式下，sender 用 resolve 返回的**完整 sessionId** 作为 send 的 `to`，与回复分支相同，线上没有新字段。mention 不再自带 pin（R2-1）。
> 3. **写盘有界**：单一物理写、队列上限 4、唯一临时文件、rename 之前复核；rename 迟迟不结束 ⇒ 写服务进入 `wedged`（之后的写一律 busy），rename 真正结束后再按结果收尾（R2-6）。
> 4. **能力门控**：`aliasUsable = 绑定表 ready ∧ 请求方 cap`。绑定表损坏、不可读或加载超时 ⇒ `degraded`：不声明 cap；对具备 cap 的请求方，凡是「形如别名」的名字寻址一律拒绝，不回落显示名。删掉「丢失即失败关闭」的错误断言，人为删除文件按全新处理（R2-7）。
> 5. **agent 缓存不再跨 reload**：每个 stack 独立，按 sessionId 隔离；只接受当前连接的回包、按到达顺序应用；删掉 gen（R2-5）。
> 6. **web 用自建的命令跟踪**：新 composable `useTrackedCommand`，覆盖 cmdId 跟踪、cmd_late、queryOnly、策略确认和取消；抢占 token 只取自该次预览命令的最终输出（R2-4/R2-8）。
> 7. **token 生命周期冻结**：任何一次执行尝试都消耗 token；hub 重启后一律失效（R2-8）。

---

## §拍板（2026-10-22 用户）

| #   | 结论                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------ |
| Q1  | **hub 全局唯一**；可见性仍按共享频道                                                                         |
| Q2  | 持有者离线后**保留 7 天**，可配 `offlineLeaseH` 1–720                                                        |
| Q3  | 重连后发现别名已不属于自己 ⇒ 本地显示清除，并**提示一次**                                                    |
| Q4  | clear 或改名后**冷却 10 分钟**，冷却期只有原会话能收回                                                       |
| Q5  | **抢占 `--take`：TUI 和 web 都可以**，两边都要确认；只有持有者离线时才能抢；飞书硬拒；agent 没有途径（§3.5） |
| Q6  | 字符集 = **ASCII + 中日韩文字**                                                                              |
| Q7  | 骨架表包含 **CJK↔ASCII 形近**字符                                                                            |
| Q8  | **16 字形簇 / 48 字节**；卡片显示前 8 个                                                                     |
| Q9  | `alias.enabled` **默认开启**                                                                                 |
| Q10 | **别名优先于名字**；结果回带 ref/alias/name                                                                  |
| Q11 | **有别名的行排前面**（只对具备 cap 的请求方）                                                                |
| NQ1 | 持有者**离线 ≥10 分钟**才可抢占                                                                              |
| NQ2 | 别名存在但不可达 ⇒ **NO_TARGET，不回落到显示名**                                                             |
| NQ3 | 旧版 agent 或关闭了别名的 agent **不解析别名，保持旧行为**                                                   |
| NQ4 | **离线到期释放不冷却**                                                                                       |
| NQ5 | 首版包含**假名与韩文预组合音节**                                                                             |

---

## 一页决策摘要（给用户）

**做什么**

1. **别名是人给会话起的短称呼**，如 `前端`、`小王`、`web`。你说「给前端发一条消息」，模型就把 `前端` 原样填进 `message_session.to`；你也可以直接写 `@前端 帮我看下接口`。
2. **规则**：NFKC 规范化后把 ASCII 转成小写。允许的字符：ASCII 字母数字、`_`、`-`、汉字、平假名、片假名、韩文**音节**。长度 1–16 个字形簇且 ≤48 字节；至少含一个字母或汉字；不能像 sessionId；不能是保留词。零宽字符、各类填充符、控制字符、组合符、西里尔/希腊字母一律拒绝。
3. **唯一性**：同一个 hub 上，一个别名只属于一个会话（按 sessionId 绑定）。只有和你共享频道的在线会话才能被你用别名找到；别名存在但你够不着 ⇒「找不到」，**绝不改投给恰好同名的别的会话**。
4. **生命周期**：
   - 先到先得；
   - 持有者离线后保留 7 天，期间 resume 回来自动恢复；超过 7 天后，**别人可以直接认领**，在被认领之前持有者回来仍然保有；
   - clear 或改名后冷却 10 分钟；
   - 持有者离线满 10 分钟后，人可以用 `--take` 抢占（需要确认；确认框只显示持有会话的目录和离线时长）；
   - hub 重启后，离线持有者的保留期从重启时刻重新起算。
5. **只有人能设置**：TUI 用 `/fabric alias 前端`、`/fabric alias --clear`、`/fabric alias 前端 --take`；web 在「频道与别名」弹窗里设置，抢占也在这里；飞书硬拒；agent 没有任何途径。
6. **寻址**：hub 的解析顺序为 sessionId 精确 → 前缀 ≥8 → **别名（命中即定，不往下找）** → 名字精确 → 名字忽略大小写。发送时钉住 resolve 得到的**完整 sessionId**；目标在两步之间离线 ⇒ 不发。
7. **显示**：卡片上有 `@前端` chip（在频道 chip 之前）；`list_sessions` 的行带 `alias="前端"`；来信头部带 `alias="前端"`；`/fabric status` 多一行。web 的 @ 面板显示别名，但插入的仍然是 `@session:<ref>`。
8. **兼容**：能力位 `xs.alias.v1`。旧 agent 和关闭了别名的 agent 行为完全不变；`alias.enabled=false` 时线上帧与持久化逐字节不变；三份 off golden 不重新生成。

**不做**：别名转移或继承（fork 与 `/new` 都拿不到）；频道内的独立命名空间；拼音或近似匹配；agent 用的别名工具；飞书设置入口；agent 侧持久化。

**风险**

1. 不同频道的会话之间也会撞名。
2. 设置失败时，提示会暴露「hub 上已经有人在用这个名字」。
3. 抢占预览会暴露持有会话的目录和离线时长（Q5 已接受）。
4. 防同形只做到「限定字符集 + 小骨架表」，不是完整的 UTS #39。
5. 人为删除绑定文件 ⇒ 所有别名消失，名字寻址恢复为旧行为（R1）；文件损坏时 hub 不会自动挪走它，别名功能停用，直到有人手动修复（R10）。

**规模**：11 个包，约 **12 人日**，关键路径约 5.5 天。纯规则包 AL0a 在 r3 获批后即可开工；其余包排在 CH6 合入之后。

---

## 1. 现状（对照 dev@b76e4e69 + CHW 工作区核实）

| #   | 位置                                                                                                                                                          | 现状                                                                                                                                                                                                | 对别名的影响                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A1  | `hub/xs/members.ts` `effective()`；`hub/registry.ts:314`                                                                                                      | `name: v.sessionName` 取自 pi 显示名，可能是自动标题，不唯一                                                                                                                                        | 别名必须是 hub 另存的独立字段                                                                                     |
| A2  | `hub/xs/router.ts` `resolveTarget`                                                                                                                            | 在可见池里逐层回落（sid 精确 → 前缀 → name → name 忽略大小写），之后用 `holders(sid)` 全表判重                                                                                                      | 要插入「别名层，命中即定」，并按 `aliasUsable` 门控                                                               |
| A3  | `fabric/xs/sender.ts:500,538-552,645`                                                                                                                         | 普通发送：先 `await resolve`，再用**原始 `to`** 发 send，hub 在 send 时**再解析一次**；只有 expectReply/replyTo 改用完整 sessionId（`sendTo = fullId`）                                             | 别名模式沿用回复分支的做法：用完整 sessionId 发送（§5.2）                                                         |
| A4  | `hub/xs/members.ts:106` `XS_REF_LEN = 12`；pi `session-manager.js` 用 UUIDv7 生成 sessionId                                                                   | ref 是 UUIDv7 的时间戳前缀，同一时间窗口创建的会话可能共享同一个 ref                                                                                                                                | **ref 不是身份**，钉住必须用完整 sessionId（R2-1）；`@session:<ref>` 遇到同前缀会返回 ambiguous（既有行为，不变） |
| A5  | `sender.ts:208-217`、`router.ts` `reservedAddress`                                                                                                            | `@`、`r_`、`wf_` 前缀和 `root/system/main` 在本地与 hub 都被拒                                                                                                                                      | `to:"@web"` 不支持；只有设置入口和 mention 解析会剥掉 `@`                                                         |
| A6  | `hub/xs/members.ts:245-270` 观察者（同步执行）                                                                                                                | `onMember` 直接覆盖；`onInvalidate`（close/detach/reclaim/down）与 `onSession` 换会话时删除记录                                                                                                     | 在线状态只能作为内存派生状态，不能进入落盘快照（§3.3）                                                            |
| A7  | `agent/connection.ts:602-643`；`agent/index.ts:1264-1274` 的 `onHubCaps`                                                                                      | 每次 hello_ack：先重放 slot，再通知，最后在 `onHubCaps` 里重发 commands slot 与 `xs_member`                                                                                                         | 别名对账挂在 `onHubCaps` 的 `publishMember` 之后（§4）                                                            |
| A8  | `mention/session.ts:83-88`；`directory.ts` `lookupExact`                                                                                                      | ASCII 裸名按原串比对 name/ref；行数满 20 时不判唯一                                                                                                                                                 | 先规范化查别名，再走旧分支（§5.4）                                                                                |
| A9  | `fabric/format-fence.ts:24-25`                                                                                                                                | `fenceMeta = JSON.stringify(v).slice(0,64)`，截断的是整个 JSON                                                                                                                                      | 别名作为头部独立字段，不放进 `from` 对象                                                                          |
| A10 | `ui/.../control/Composer.vue:357-360,1204-1207`                                                                                                               | 插入 `session:<ref>`；候选显示 `name` 或 `ref`                                                                                                                                                      | web 只改显示，不改插入值                                                                                          |
| A11 | `hub/xs/broadcast.ts`（`stampFrom`）；`fabric/xs/format.ts` `formatXsReply`                                                                                   | 广播和回复各有独立的 from 盖章/格式化路径                                                                                                                                                           | 三条路径都要覆盖                                                                                                  |
| A12 | `protocol/xs.ts`                                                                                                                                              | `xs_member`、`xs_req`、`xs_deliver.from`、`XsStatus` 是严格对象；`xs_res.rows`/`candidates`/`target` 是开放对象                                                                                     | 新字段一律按 cap 写出                                                                                             |
| A13 | `agent/builtin-bridge.ts:225-241,408-413`；`ui/composables/useControl.ts:231-275`；`detail/DetailDock.vue:106-217`；`detail/ChannelsDialog.vue:63-79`         | 需要 await 的扩展命令先返回 `completion:"async"`，最终输出要等 cmd_late 之后经 `queryOnly` 取回；`E_CONFIRM_REQUIRED` 由调用方自己处理（DetailDock 有实现），ChannelsDialog 只看初始的 `outcome.ok` | web 别名操作需要新的命令跟踪 composable（§7.1）                                                                   |
| A14 | `agent/command-capture.ts:576,584`（`isWebInvocation`/`isFeishuInvocation`）；`agent/commands.ts:277`（prompt 文本拦截）；`command-policy.ts:124-135,240-243` | 已有扩展点                                                                                                                                                                                          | 抢占门控直接复用                                                                                                  |
| A15 | `hub/privacy/store.ts:58-78`（临时文件 → fsync → rename → 替换内存）；`hub/avatar/store.ts:121-180`（pending/zombie/disabled）                                | 原子替换与「卡死 IO」隔离都有先例                                                                                                                                                                   | 绑定表的写服务照这两个先例组合（§3.3）                                                                            |
| A16 | UI 能 import `@protocol/*`（如 `useAvatarEditor.ts`）                                                                                                         | —                                                                                                                                                                                                   | 规范化函数放在 protocol，hub、agent、UI 共用一份                                                                  |

---

## 2. 别名规则（新文件 `src/web-hub/protocol/xs-alias.ts`，纯函数，不用 Node API）

### 2.1 `normalizeAlias(input) → {ok:true, alias, skeleton} | {ok:false, reason}`

1. 非字符串或为空 ⇒ `invalid`。剥掉**一个**前导 `@`（只在设置入口和 mention 解析时调用这一步；`message_session.to` 的 `@` 前缀照旧被拒，A4）。
2. `normalize("NFKC")`，然后断言 `s === s.normalize("NFKC")`（幂等）。
3. **先拒绝**：凡是 `\p{Default_Ignorable_Code_Point}`、`\p{C}`、`\p{M}`、`\p{White_Space}` 的码点；韩文 Jamo 各块（U+1100–11FF、U+3130–318F、U+A960–A97F、U+D7B0–D7FF、U+FFA0–FFDC；包括填充符 U+115F/U+1160/U+3164/U+FFA0）；变体选择符；Bidi 控制符。
4. **白名单**（逐码点）：`[A-Za-z0-9_-]`；`\p{Script=Han}`；`\p{Script=Hiragana}`；`\p{Script=Katakana}`（不含半角块，NFKC 已经转成全角）；`U+30FC ー`；**韩文只收预组合音节 U+AC00–D7A3**。其余一律拒绝，包括标点（`.` `/` `:` `#` `@`）、emoji、非 ASCII 拉丁、西里尔、希腊。
5. ASCII 大写转小写，得到 **canonical `alias`**。存储、展示和线上一律用它。
6. 长度：`Intl.Segmenter` 字形簇 1–16，且 UTF-8 ≤48 字节，否则 `too_long`。
7. 形状：至少含一个 `\p{L}`；首字符不能是 `_`、`-`、`ー`，否则 `invalid`。
8. 不能像 id：`/^[0-9a-f-]{8,}$/` ⇒ `id_like`。uuid、ref、前缀都会落在这一类（`q`+18 位十六进制有 19 个字符，已经被第 6 步拒绝，m15）。
9. 保留词（§2.3）⇒ `reserved`。
10. `skeleton = aliasSkeleton(alias)`（§2.2）。

NFKC **不是**完整的异体字或视觉等价消除（例如 `﨑` 不会被折成 `崎`），本文只承诺语料里列出的防护。

### 2.2 骨架（只用于判断「抢注冲突」，不参与解析）

`XS_ALIAS_SKELETON_VERSION = 1`，逐字符映射：

- ASCII 内部：`0→o`、`1→l`、`_→-`。
- CJK↔ASCII（Q7）：`〇/口/ロ→o`、`ー/一/－/—→-`、`丨→l`。

**不收** CJK↔CJK（如 `カ/力`），这一项列为残留 R4。

不变量：**按当前骨架版本新建或改名的记录，同一 skeleton 只能属于同一个 sessionId**（B1；骨架表升级后保留下来的历史冲突是唯一例外，见本节末）。因此：

- 同一会话改成同骨架的新名字时，它自己的旧冷却记录直接删除；
- 不同会话撞骨架 ⇒ 拒绝 `confusable`，**不回显**任何已有的别名文本（M10）。

骨架表升级后，启动时用新表重算；历史记录如果因此撞骨架，可以保留（属于既有事实，只写 hub 日志），新的认领按新表检查。改表必须 bump 版本，并同步更新 `tests/fixtures/xs-alias-corpus.json`。

### 2.3 保留词 `XS_RESERVED_ALIASES`

- 频道保留名全集，加上 `default self me you user human assistant agent bot model pi subagent workflow channel broadcast reply`；
- 前缀 `pi-`、`r_`、`wf_`；
- 中文：`所有人 全部 大家 自己 我 你 主会话 系统`。

它是 `router.ts` `RESERVED_EXACT`/`RESERVED_PREFIXES` 与 `sender.ts:208-209` 的超集，用单测钉住。

### 2.4 与其他名字的关系

| 对象             | 规则                                                            |
| ---------------- | --------------------------------------------------------------- |
| sessionId / ref  | 由 §2.1-8 拒绝                                                  |
| 频道名           | 不会冲突（别名不能含 `#`）                                      |
| 子 agent label   | 设置时不检查；`@x` 时 label 优先（`parseMention` 先运行，不变） |
| 其他会话的显示名 | 允许相同；具备 cap 的请求方，别名层先命中（Q10）                |
| cwd 下的同名文件 | `@x` 仍做 `lstat` 冲突检查，有同名文件就放行给 pi               |

---

## 3. hub 绑定表（新文件 `src/web-hub/hub/xs/aliases.ts`）

### 3.1 数据：落盘的「意图」与内存里的「在场」分开

```ts
// 落盘（xs-aliases.json）——只有 §3.3 的事务会改
type AliasRecord = {
  alias: string;
  skeleton: string;
  sessionId: string;
  state: "held" | "cooling";
  coolUntil?: number;
  rev: number; // 每条记录的修订号，每次修改 +1
  cwdLabel: string; // 最近一次 set 或认领时的 ~ 缩写 cwd（只用于抢占确认框）
};
type Tombstone = { sessionId: string; alias: string; reason: "taken" | "expired"; at: number };
// 仅内存——成员观察者同步更新，从不落盘
type Presence = Map<sessionId, { online: boolean; offlineSince: number }>;
```

- **在场判定**（读时执行）：sid 在 `members.effectiveAll()` 中 ⇒ 在线。观察者的 `onInvalidate`/`onSession` 只负责给 `offlineSince` 盖时间戳；读时发现「表里记着在线，实际已不在」时，补记 `offlineSince = now`（偏向持有者）。
- **hub 加载后**：每个 held 记录的 sid 一律记为 `offlineSince = 加载时刻`，直到它重连。所以 hub 重启会给离线持有者重置一次保留窗口（偏向持有者，残留 R8）。

| ID  | 不变量                                                                          |
| --- | ------------------------------------------------------------------------------- |
| I1  | 每个 alias 至多一条记录                                                         |
| I2  | 每个 sid 至多一条 `held`                                                        |
| I3  | 按当前骨架版本新建或改名的记录，同一 skeleton 只属于一个 sid（历史例外见 §2.2） |
| I4  | `cooling` 只能由自己的 sid 收回                                                 |
| I5  | 在线 sid 的 held 永远不会被他人认领或抢占                                       |
| I6  | 记录与墓碑**只**由 §3.3 的事务修改；在场与过期从不触发写入                      |

### 3.2 状态转移（确定性）

读时谓词（不写入）：

- `coolingLive(R) = R.cooling ∧ now < R.coolUntil`；已过期的 cooling 视同不存在。
- `expired(R) = R.held ∧ holder 离线 ∧ now − offlineSince > leaseMs`（默认 7 天）。
- `takeable(R) = R.held ∧ holder 离线 ∧ now − offlineSince ≥ takeMinOfflineMs`（10 分钟）。

**共同步骤 G（凡是把 x 授予 S 的成功 set/take 都先执行）**：S 名下除 x 以外的 held 全部转为 `cooling(S)`，`coolUntil = now+10m`；S 自己与 x 同骨架的 cooling 删除。之后才执行各行的差量。G 只改状态、不增加记录，所以容量（256）只在「新建记录」时判定；转移和转冷却不会触发 `E_XS_ALIAS_FULL`。

| 事件（sid S 发起）         | 前置条件（事务内校验，rename 前再复核）                    | 结果                                                                                          |
| -------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `set x`                    | x 无记录，或只有已过期的 cooling；且 skeleton 不撞其他 sid | G；新建 `x:held(S)`                                                                           |
| `set x`                    | x 是 `held(S)`，或 `coolingLive(S)`                        | G；x 改为 `held(S)`                                                                           |
| `set x`                    | x 为 `held(H≠S)` 且 `expired`                              | G；x **就地转移给 S**（`sessionId=S`，`rev+1`），不冷却（NQ4）；写入 Tombstone(H, expired)    |
| `set x`                    | x 属于其他 sid（held 未过期，或 coolingLive）              | `taken`（不区分 held/cooling、在线/离线）                                                     |
| `set x`                    | skeleton 撞其他 sid 的有效记录                             | `confusable`（不回显已有别名）                                                                |
| `clear`                    | S 有 held                                                  | → `cooling(S)`，`coolUntil = now+10m`                                                         |
| `take x`（带 token，§3.5） | `held(H≠S)` ∧ `takeable` ∧ token 有效且绑定元组一致        | G；**原记录就地转移**给 S（`sessionId=S`，`rev+1`）；写入 Tombstone(H, taken)。H 不留 cooling |
| `take x`                   | 否则                                                       | `take_refused`（`online` / `recent` / `stale` / `not_held`）                                  |

- 墓碑每个 sid 只保留最新一条，总数 ≤256，30 天后在下一次事务里清理；S 自己 set 或 clear 时删除 S 的墓碑。
- 过期的 cooling 与过期墓碑，只在下一次事务里顺带删除（I6）。

### 3.3 唯一写入口与提交协议

**入口**：`xs_req{op:"alias"}` 由 `aliasUsable` 的有效成员发出，而且只来自人发起的 `/fabric alias …`。`xs_member` **不携带**别名字段；别名变化不 bump epoch。

**事务**（物理上一次只跑一个）：

1. **准入**：等待队列上限 4；第 5 个 ⇒ `E_XS_ALIAS_BUSY{queue}`（none）。排队时间计入 hub 侧总预算 **4s**（客户端截止 5s）。store 处于 `wedged`/`disabled` ⇒ 立即 `E_XS_ALIAS_BUSY{io}`（none）。
2. **校验**：用当前内存表和当前在场状态做 §3.2 判定，算出新表。新表 = 当前记录集合 + 本次操作的差量，不使用早先的整表快照。
3. **写临时文件**：`xs-aliases.json.<8 位十六进制>.tmp`（每个事务独立文件名），写入 + fsync，预算 2s。超时 ⇒ 放弃本事务（none），这个临时文件登记为 zombie，晚到的结果一律忽略，结束后尽力删除。zombie 累计 >2 ⇒ store 进入 `disabled`（直到 hub 重启）。
4. **rename 前复核**：
   - 请求方仍是同一 sid/epoch 的有效成员；
   - 目标记录的 `rev` 未变；
   - take 时持有者仍满足 `takeable`；
   - 总预算未用完。

   任一项不满足 ⇒ 删除临时文件，返回 none（`stale` 或 `busy`）。**take 的线性化点就在这里**：复核之后才发生的重连，排在 take 之后（被抢方回来会收到提示）。

5. **rename**：一旦开始即视为提交。预算 1s 内结束 ⇒ 用第 2 步的差量更新**当前**内存表，再回复。超过 1s ⇒ 回复 `E_XS_ALIAS_UNKNOWN`（**不是** none），store 进入 `wedged`：期间所有写都 busy；**读继续用内存里的旧表，别名层照常生效**（见下面的状态×行为矩阵）。rename 最终成功 ⇒ 补做内存更新；失败 ⇒ 内存不变。两种情况都退出 `wedged`。rename 超过 60s 仍未结束 ⇒ `disabled`。
6. **读**：resolve、list、get 都不加锁，读当前内存。

在场状态从不进入落盘内容，所以「旧快照覆盖新在场」在结构上不可能发生（R2-2）。

**加载**：hub 启动时，在 xs router 开始接收请求之前，先 `await load()`（预算 2s）。结果三态：

| 结果            | 条件                   | 行为                                                                                                                  |
| --------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ready`         | 加载成功               | 正常服务，声明 `xs.alias.v1`                                                                                          |
| `ready`（空表） | **文件不存在**         | 按全新处理（包括人为删除，R1），不创建文件，声明 cap                                                                  |
| `degraded`      | 文件损坏、不可读、超时 | **原地保留文件，不改名、不覆盖、不删除**；**不声明 cap**；拒绝所有 op；对 `aliasCapable` 的请求方执行 §5.1 的降级守卫 |

**损坏的处理**（R3-3）：

- 文件损坏（JSON/schema 不合法、超过 64 KiB）或不可读（EACCES、EISDIR 等）时，hub 一个字节都不写，主文件原地保留。所以**下次启动读到的仍是同一个坏文件，仍是 `degraded`**，不会因为「文件不存在」而变成空表放行。
- 加载超时只影响本次运行：文件完好，下次启动可能就是 `ready`。
- 恢复只能由人完成：`/webhub status` 显示 `alias store degraded (corrupt|unreadable|timeout) · <路径>`，并给出修复提示：「检查后修复、或手动移走该文件，然后 /webhub restart；移走即放弃全部别名」。不新增重置命令；人手动移走文件，就等同于 R1 的人为删除。

**状态 × 行为矩阵**（R3-2；「请求方」指声明了 agent cap 的 `aliasCapable` 请求方，无 cap 的请求方在任何状态下都是旧的四层）：

| store 状态 | 本次运行声明 cap         | 读（resolve/list/get、别名层）            | 写（set/clear/take）  | `aliasUsable` | 寻址守卫                                                        |
| ---------- | ------------------------ | ----------------------------------------- | --------------------- | ------------- | --------------------------------------------------------------- |
| `loading`  | —（router 尚未接收请求） | —                                         | —                     | —             | —                                                               |
| `ready`    | 是                       | 当前内存表                                | 允许                  | 是            | 别名层（§5.1）                                                  |
| `wedged`   | 是                       | **当前内存表（旧表，rename 结束前不变）** | busy                  | 是            | 别名层照常，**不回落**                                          |
| `disabled` | 是                       | 当前内存表（最后一次成功提交的状态）      | busy（直到 hub 重启） | 是            | 别名层照常，**不回落**                                          |
| `degraded` | 否                       | 没有可信表                                | 拒绝                  | 否            | 请求方：别名形状的名字 ⇒ `E_XS_ALIAS_UNAVAILABLE`，不进入名字层 |

状态转换只有这几条：`loading → ready | degraded`；`ready → wedged`（rename 超过 1s）；`wedged → ready`（rename 结束，成功则补做内存更新，失败则内存不变）；`wedged → disabled`（超过 60s）；`ready → disabled`（zombie > 2）。`degraded` 和 `disabled` 在本次运行内不会恢复。任何一次转换都**不改变**「本次运行是否声明 cap」，因此 agent 与 hub 对别名模式的判断始终一致。

**落盘**：`<stateDir>/xs-aliases.json`，0600，≤256 条记录、≤64 KiB；满 ⇒ `E_XS_ALIAS_FULL`，从不淘汰 held。

**同一会话在两个进程里打开**：两边都只能由人操作，按串行顺序后写者生效；不存在自动写入。

### 3.4 op 形状

```
xs_req{op:"alias", alias?, clear?:true, take?:"preview"|<token>}
  既没有 alias 也没有 clear ⇒ get：只读，计入 listPerMin
xs_res.alias = { alias?, state:"held"|"none", lost?:{alias, reason, at} }        // get / set / clear 成功
             | { take:{ cwdLabel, offlineForS, token, expiresAt } }               // take 预览
错误码：E_XS_ALIAS_INVALID{invalid|too_long|id_like|reserved}、E_XS_ALIAS_TAKEN{taken|confusable}、
        E_XS_ALIAS_TAKE{online|recent|stale|not_held}、E_XS_ALIAS_FULL、E_XS_ALIAS_BUSY{queue|io|tokens}（以上全部是 none）、
        E_XS_ALIAS_UNKNOWN（rename 在途，可能已生效，§3.3-5）
```

### 3.5 抢占流程与 token 生命周期

**token**：`k` + 16 位十六进制（`XS_ALIAS_TAKE_TOKEN_RE`）。只存在当前 hub 实例的内存里，最多 32 个；满了 ⇒ 预览返回 `E_XS_ALIAS_BUSY{tokens}`，不淘汰未过期的。

| 阶段     | 规则                                                                                          |
| -------- | --------------------------------------------------------------------------------------------- |
| issued   | 预览时签发，绑定 `(请求方 sid, alias, 持有者 sid, 记录 rev, 持有者 offlineSince)`，5 分钟有效 |
| reserved | 执行请求一到达（进入准入之前）即从表中摘除。同一 token 的并发请求，后到的 ⇒ `stale`           |
| consumed | **任何结果都消耗**：成功、校验失败、IO 失败、busy、unknown。需要重试就必须重新预览            |
| 失效     | 过期；hub 重启（内存清空）；同一 alias 被其他 token 抢先提交（rev 变了）                      |

token 只证明「这个请求方对这一确切状态做过预览」，不能证明真人点过确认。人的确认是 UX 闸门；「只有人能触发」靠的是 agent 拿不到命令入口（§8）。

**流程**

1. **预览**：`/fabric alias 前端 --take` ⇒ hub 返回 `{cwdLabel, offlineForS, token, expiresAt}`，不返回 ref、名字、频道。`cwdLabel` 视为不可信纯文本：去掉 `\p{C}`，最长 120 字符。
2. **确认**：
   - **TUI**（`ctx.mode==="tui"`，且不是 web 或飞书调用）：`ctx.ui.confirm("抢占别名「前端」？", "持有会话：~/ai/foo，已离线 3 天 4 小时。抢占后对方回来会失去此别名并收到提示。")`，确认后直接用 token 执行。
   - **web**（`isWebInvocation`）与 **RPC**：handler 不弹窗，回显说明文字，最后一行固定为 `确认抢占请执行：/fabric alias 前端 --take=<token>（5 分钟内有效）`。web 由 §7.1 的 `useTrackedCommand` 拿到**这一次预览命令**的最终 captured 输出，用 `XS_ALIAS_TAKE_CONFIRM_RE` 只解析这份输出（绝不扫描转录、模型文本或目录文本），弹出确认框，确认后再发一个带 token 的新命令。
3. **执行**：`/fabric alias 前端 --take=<token>` ⇒ 按 §3.3 走事务。
4. **门控**：
   - `alias` 加入 `FABRIC_KNOWN_SUBS`，基线 allow，受 `webCommandPolicy.fabric` 控制（设为 confirm 时，预览和执行**各自**会多一次通用确认，由 `useTrackedCommand` 处理；设为 deny 时 web 完全禁用）；
   - 飞书：handler 第一行调用 `isFeishuInvocation` 硬拒（`FEISHU_REFUSED_SUBS` 加 `alias`，在任何查询、预览、执行之前）；`agent/commands.ts:277` 的 prompt 文本正则加 `alias`。
5. **被抢一方**：重连后 get 返回 `lost{reason:"taken"}`，提示一次（§4）。

### 3.6 新旧互通

- **hub cap**：`HubConfig.crossSession` 存在**且**加载结果为 `ready` 时，本次运行声明 `xs.alias.v1`（记作 `aliasAdvertised`，整个运行期不变）。可选参数 `HubConfig.crossSession.alias?: {offlineLeaseH, coolMin, takeMinOfflineMin}`；缺失 ⇒ 默认值 168/10/10，**缺失永远不表示关闭**；`takeMinOfflineMin` 的范围是 10–1440（下限即 NQ1，不能调到 0）。`hub/main.ts` 复核时，有任何非法值就丢弃整个子键。
- **agent cap**：`xsOn ∧ alias.enabled`。
- **`aliasUsable(self) = aliasAdvertised ∧ self.aliasCapable`**（与 agent 侧「本端 alias on ∧ hub 声明了 cap」完全对称）：别名层、按别名排序、`target.sessionId`/`target.alias`、`rows/candidates.alias`、**send 只做精确解析**（§5.2）全部按它门控；`ready`/`wedged`/`disabled` 下都成立，差别只在写（矩阵见 §3.3）。`from.alias` 按收件方的 `aliasUsable` 写出。

| 组合                                      | 结果                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 无 cap 的请求方 × 新 hub                  | 解析、排序、帧都与频道版**完全相同**（NQ3）                                                                                                                                          |
| 新 agent × 旧 hub，或新 hub 处于 degraded | agent 看不到 hub cap，所有别名功能关闭，`/fabric alias` 本地拒绝（「hub 不支持别名或别名服务降级，需 /webhub restart」）。degraded 时 hub 对 `aliasCapable` 的请求方执行 §5.1 的守卫 |
| `alias.enabled=false` 的新 agent          | ≡ 旧 agent；hub 上已有的绑定原样保留，直到离线满 7 天后被他人认领                                                                                                                    |
| `aliasUsable` 的请求方，全场无别名        | 与无 cap 相比只有一个差别：send 的 `to` 改为完整 sessionId，hub 对它只做精确解析（resolve 本来就带 `target.sessionId`）                                                              |

**逐字节不变**（`alias.enabled=false`）：`xs_member`、`xs_req`、status 帧、membership entry、`formatXsMessage`/`formatXsReply`。证明沿用 channel-plan §9.4 的三角锚定；三份 off golden 不动。

---

## 4. agent 侧状态（不持久化、不跨 reload）

- membership entry **不写任何别名字段**。每个 stack 闭包里有一个 `Map<sessionId, {alias?, lostAt?}>`，上限 8，FIFO。`/reload` 时随 stack 重建而清空。
- **对账时机**：
  - stack attach；
  - 每次 hello_ack（在 `agent/index.ts` `onHubCaps` 的 `publishMember` 之后，hub 有 cap 才做）；
  - `/fabric status`、`/fabric alias` 之后。

  每次发一个有界的 get（5s）。

- **应用规则**（替换 r2 的 gen）：
  - 回包必须来自**当前连接世代**，并且对应**当前 sessionId**，否则丢弃；
  - 同一连接上按**到达顺序**应用。hub 的读总是反映已提交的状态，set/clear 在提交之后才回复，所以在同一条有序连接上，后到的回包不会比先到的更旧；
  - 失败就等下一个时机，不轮询。
- **一次提示**（Q3）：get 返回 `lost`，且 `(sid, lost.at)` 不在进程级去重集合里（`Symbol.for("pi-subagent:xs-alias-lost")`，上限 64，只存去重键）⇒ 发一条只显示的通知：「别名「前端」已被其他会话抢占（或离线超过 7 天后被他人认领），可以用 /fabric alias 重新设置」。
- `/new`、fork 产生新 sessionId，缓存里没有对应条目，get 返回 none。切回旧会话 ⇒ 用旧 sessionId 重新对账。resume、web 恢复、managed restore 沿用原 sessionId，自动恢复别名。

---

## 5. 寻址

### 5.1 hub 解析（`router.ts` `resolveTarget`）

```
aliasUsable(self) 时：
1. sid 精确   2. sid 前缀 ≥8
3. 别名：n = normalizeAlias(q)（不剥 @；@ 前缀已被保留规则拒绝）
   n 合法 ∧ 表里有记录 R（held，或 coolingLive）⇒ 只看这一层：
     R 为 held ∧ R.sid 在可见池中（在线、joined、共享频道、不是自己）⇒ 命中（照常用 holders 判重）
     否则 ⇒ NO_TARGET（不往下找，NQ2）
   n 不合法，或表里没有记录 ⇒ 进入第 4 层
4. name 精确   5. name 忽略大小写
降级守卫（¬aliasAdvertised ∧ store 为 degraded ∧ self.aliasCapable；wedged/disabled 已在上面的 aliasUsable 分支内，不会走到这里）：
   第 1/2 层照旧；n 合法 ⇒ E_XS_ALIAS_UNAVAILABLE（none），不进入名字层；否则进入第 4/5 层
其他请求方：旧的四层，不变
```

- 不可达与不存在在错误上不可区分（XI5）。代价：如果某会话的显示名恰好等于一个不可达的别名，`aliasUsable` 的请求方只能用 ref 或它自己的别名找到它（R2）。
- `exact` 分支（回复用的完整 sessionId）不走别名层。

### 5.2 发送钉住完整 sessionId

- 在 `aliasUsable` 时，hub 的 resolve 结果一律带 `target.sessionId`，命中别名时再带 `target.alias`。这只进 sender 内部，不进模型可见结果：`publicTarget` 只多 `alias`。
- `sender.message()` 在 `aliasUsable`（本端 alias on 且 hub 有 cap）时令 `sendTo = target.sessionId`（resolve 在这种情况下一律带 sessionId；万一缺失 ⇒ 本地 `none{no_session_id}`，不发 send）。
- **hub 的 send 分支对 `aliasUsable` 请求方只做精确解析**（R3-1）：`router.ts` 的 send 调用改为 `resolveTarget(frame.to, self, agentKey, hasReplyFields || aliasUsable(self))`，复用现有的 exact 层（`m.sessionId === query`，不 trim、不前缀）：
  - 保留可见池、self 排除和全表 `holders` 判重；
  - **找不到时一律返回 `E_XS_NO_TARGET`（可证明 none）**，不进入前缀、别名或名字层。现有 exact 分支里把某些形状归为 `bad` 的诊断，只对带回复字段的帧保留；`aliasUsable` 的普通 send 把 `bad` 也映射为 `NO_TARGET`，避免把合法的离线 ID 归成别的错误；
  - 判定只依据已协商的能力（hub 本次运行声明了 cap，且对端 hello 声明了 agent cap），**线上没有新字段**；无 cap 的请求方仍走原来的 `hasReplyFields` 判定，行为与 off golden 不变。
- 目标已离线、离开共享频道或不再可达 ⇒ `E_XS_NO_TARGET`（none）。
- 别名在两步之间被清除或抢占：消息仍发给 resolve 时确认的那个会话。被抢的一方此时必然已离线（⇒ NO_TARGET）；自己 clear 的一方仍是原收件人。都不会改投。
- 屏障测试（普通发送和 mention 两条路径都测）：
  - 同一时间窗口生成、**12 字符 ref 相同**的两个 UUIDv7 会话 A、B：alias 先 resolve 到 A → A 下线、B 认领该别名 → send ⇒ NO_TARGET，不送到 B；
  - A 下线后，可见会话 B 的**显示名恰好等于 A 的完整 sessionId** ⇒ send ⇒ NO_TARGET，不送到 B；
  - 另一个合法的自定义 sessionId **以 A 的完整 ID 为前缀**（例如 `<A>-x`）⇒ send ⇒ NO_TARGET，不送到它。

### 5.3 `list_sessions`

- 行：`- <ref> · alias="前端" · name="…" · cwd=…`（JSON 编码；只对 `aliasUsable` 的请求方写出）。
- `query` 增加对别名前缀的匹配（规范化后比较）。
- 排序（Q11）：`aliasUsable` 的请求方看到有别名的行在前，组内按 `activityAt` 降序；其他请求方保持原顺序。别名超过 20 个时仍可能截断（R3）。

### 5.4 `@别名`（`mention/session.ts`）

别名模式（本端 alias on 且 hub 有 cap）下：

```
1. 显式 @session:<x>          → 不变
2. bare = /^@([^\s]+)[ \t]+(\S[\s\S]*)$/
3. label 优先 → 有同名文件则放行（不变）
4. n = normalizeAlias(token)；n 合法 ∧ directory.lookupAlias(n.alias) 唯一 ⇒ 拦截，to = n.alias
   （别名全局唯一，命中时豁免 20 行截断规则）
5. 否则走旧的 BARE_SESSION_NAME_RE + lookupExact；命中时改为 to = token，交给 hub 权威解析
6. 都不命中 ⇒ 放行给 pi，触发一次节流刷新
```

- 拦截之后统一走 `sender.message({to, …})`：resolve → 完整 sessionId → send（§5.2）。目录缓存只决定**拦不拦截**，不决定发给谁；r2 的 mention pin 删除。
- `BARE_SESSION_NAME_RE` 与 `parseMention` 不变。非别名模式下 1–6 与现状**逐字节相同**（第 5 步仍是 `to: row.ref`）。
- TUI 补全的插入值：通过 label、文件、唯一命中三项检查 ⇒ 插 `@前端 `，否则插 `@session:<ref> `。

---

## 6. 模型可见面

- **冻结实例**：`list_sessions` 按 (channels × alias) 选，`message_session` 按 (reply × alias) 选，都是模块常量，在 activate 时选定。旧实例一个字节不改。
- **`message_session.to` 别名版描述追加**：「When the user refers to a session by a short word (e.g. "给前端发消息"), pass that word verbatim as `to`: aliases are unique on this hub and matched before names. If the result is no_target or ambiguous, call list_sessions and ask the user — never guess or pick the closest one.」
- **`list_sessions` 描述追加**：「alias is a human-assigned, hub-unique short name; prefer it when the user names a session.」
- **结果**：`publicTarget` 增加 `alias`（不暴露 sessionId）。名字层歧义照常返回 `candidates[{ref,alias?,name?}]`；`E_XS_ALIAS_UNAVAILABLE` 的工具文本为「hub 别名服务暂不可用，请用 list_sessions 给出的 ref」。
- **来信头部**：收件方 `aliasUsable` 时，在 `from=…` 之后追加独立字段 ` alias="前端"`（`JSON.stringify`，≤48 字节，不截断）。`fenceMeta` 和 `from` 对象不变。说明句追加「alias 由 hub 核验唯一，name 由对方自报」。覆盖 `formatXsMessage`（含广播）和 `formatXsReply`（含迟到回复）；没有 alias 时输出逐字节不变。
- **hub 盖章**：`xs_deliver.from.alias?` 由 `router.ts`（send、回复）和 `broadcast.ts`（`stampFrom`）写出，都按收件方门控。
- 不新增系统提示段。

---

## 7. web / TUI

### 7.1 设置入口

- **TUI**：`/fabric alias`（显示并对账）、`/fabric alias <别名>`、`/fabric alias --clear`、`/fabric alias <别名> --take`。补全只读本地缓存：`--clear`，以及由 cwd 末段、会话名前缀生成的推荐值（都经过 `normalizeAlias`）。
- **web：新 composable `ui/src/composables/useTrackedCommand.ts`**（DetailDock 不动，避免回归）：
  - **发送**：`run(agentKey, name, args)` 自己生成 cmdId，调用 `runCommand(…, {id})`。
  - **策略确认**：返回 `E_CONFIRM_REQUIRED` ⇒ 调用方显示通用确认（复用 `CommandConfirm.vue`），确认后用**新的** cmdId 并带 `confirm:true` 重发，绝不复用旧 id。
  - **异步完成**：`completion` 为 async/unknown ⇒ 监听 `pendingCtl` 里**这个 cmdId** 的条目；条目消失 ⇒ 做一次 `query(agentKey, id)`，并解出 `result.data.output`。条目变成 failed/notExecuted ⇒ 失败。
  - **收尾**：超时 15s、弹窗关闭、切换会话、agentKey 变化 ⇒ 取消跟踪并丢弃迟到结果（**不撤销**已经发出的命令，结果以随后的 status 为准）。
  - **结果**：只返回这个 cmdId 的最终 captured 输出文本。
- **web `ChannelsDialog.vue`**（标题改为「频道与别名」）：
  - 顶部是别名区：输入框用 `@protocol/xs-alias.js` 实时预校验并提示原因；
  - 最多 3 个推荐 chip（cwd 末段、会话名首段、cwd 里的中文段）。别人已占用的置灰，依据是 hub 推送的各会话 `status.xs.alias`，只作提示；
  - 「保存」「清除」「尝试抢占」都经过 `useTrackedCommand`。抢占：预览输出 → 用 `XS_ALIAS_TAKE_CONFIRM_RE` 解析出 token（只认这一次输出）→ 确认框显示该输出 → 确认后执行；
  - 不做乐观更新，以回显加随后的 status 为准。频道的 join/leave 原有调用保持不变。
- **飞书**：硬拒（§3.5-4）。

### 7.2 显示

- `StatusInfo.xs.alias?: string`：由 agent 缓存写出，cap 门控，只在 held 时写；`XsStatusSchema` 增加可选字段。
- **卡片** chips 顺序：`kind → 状态类 → xs 徽标 → @别名 → #频道 → 未读角标`。`chip-xs-alias` 按字形簇截前 8 个，title 显示全文；沿用现有的 `chipsBelow` 测量和整组下移规则。
- **详情头部**：标题后小字 `@前端`，点击打开「频道与别名」弹窗。
- **@ 面板**：`SessionMentionTarget.alias` 参与过滤；`Composer.vue:1207` 的候选显示改为 `@alias · name`；插入值仍是 `session:<ref>`（`Composer.vue:360` 不变）。
- **`/fabric status`**：
  - `alias @前端 held · lease 7d · cool 10m`
  - `alias - (lost: taken)`
  - `alias n/a (hub-cap off)`
  - `alias n/a (alias.enabled=false)`
- **来信渲染**：TUI `render.ts` 头部优先显示 `@alias`；web `xsMessage.ts` 用独立正则从首行解析 ` alias="…"`（与 cwd、reply_to、channel 字段的先后顺序无关），`TxCustom.vue` 负责显示。

---

## 8. 安全

| 面           | 处置                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注入         | 字符集里没有空格、标点、引号、换行；进入模型可见文本时一律 JSON 编码并标注不可信；`cwdLabel` 去掉控制字符并截到 120 字符；web 只用文本插值，不用 `v-html`。这些是卫生措施，不是权限边界（XR3） |
| 冒充         | 全局唯一 + 骨架防形近 + 拒绝不可见字符和填充符；别名与名字分开展示，头部注明由 hub 核验；不能像 id，不能是保留词                                                                               |
| 只有人能设置 | 不注册工具；`/fabric` 是扩展命令，模型调不到；web 受策略门控，prompt 文本会被拦截；飞书三层硬拒；子会话没有 `/fabric`。本方案**不**防同 uid 进程（bash/curl/读宿主凭据）——那超出现有信任边界   |
| 枚举         | 解析时，不可达与不存在不可区分；`taken`/`confusable` 只透露「有人在用」；抢占预览透露离线时长和 cwd（Q5 已接受），token 绑定请求方，预览计入 `listPerMin`                                      |
| 改绑误投     | 用完整 sessionId 钉住；别名不可达不回落；degraded 时守卫别名形状的名字；冷却 10 分钟；只能抢离线 ≥10 分钟的持有者，且需确认                                                                    |
| 资源         | 记录 ≤256 / ≤64 KiB；token ≤32；队列 ≤4；zombie ≤2；没有定时器                                                                                                                                 |

---

## 9. 测试计划

| 包                                                                                              | 要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AL0a                                                                                            | `tests/web-hub/protocol/xs-alias.test.ts` + 语料：全角、KELVIN、`ſ`、半角片假名的折叠；U+115F/U+1160/U+3164/U+FFA0 单独出现，以及作为 `web` 的前后缀；残余 Jamo；ZWJ、Bidi、VS、组合符、emoji、西里尔 `wеb`、希腊字母；纯数字、`_a`、`ーa`；8 位十六进制、uuid、`q`+18 位十六进制（`too_long`）；中文保留词；16 字形簇与 48 字节边界（含扩展汉字）；骨架 `o0`、`一`/`-`、`〇`/`o` 相撞，`カ`/`力` 不撞                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AL1                                                                                             | **property**（随机执行 set/clear/take 预览与执行、上线下线、时钟推进、重启加载、IO 挂起/晚到/失败）：I1–I6；在场从不写盘；rename 前超时 ⇒ 内存与磁盘都不变；rename 卡住 ⇒ `UNKNOWN` + wedged，之后的写全部 busy，rename 结束后状态与磁盘一致；临时文件从不复用。**确定性交错**：fsync 期间持有者最后一个连接断开或重新上线、请求方切换会话、另一个 token 先提交 ⇒ 都按 §3.3-4 复核得到 stale；「上线清除 → 长期在线 → 崩溃 → 重启后别人先查询」⇒ 不过期（从加载时刻起算）；两个持有进程只断一个 ⇒ 仍在线。**token**：同一 token 并发两次（后到的 stale）、跨请求方/别名/持有者、过期、hub 重启后的旧 token、IO 失败后重用 ⇒ 全部拒绝；满 32 个 ⇒ busy。**加载**：文件不存在 ⇒ ready（空表）；损坏、不可读、超时 ⇒ degraded 且不声明 cap；**degraded 时磁盘文件字节不变（不改名、不覆盖）**。**共同步骤 G**：S 已持有 y 时，分别经普通 set、过期接管、take 拿到 x ⇒ 最终只有 x 为 held(S)、y 为 cooling(S)（I2）；表已满 256 条时，过期接管和 take 仍然成功，只有新建记录才返回 FULL |
| AL2                                                                                             | router：**状态×行为矩阵逐格测**：ready → wedged → ready（晚到 rename 成功或失败）、wedged → disabled，每个状态下都断言「A 持有 alias=前端、B 的显示名=前端」时，`aliasUsable` 请求方用「前端」不会到达 B；send 精确解析的三个反例（§5.2）；别名层命中即定；离线、未加入、跨频道、自己 × 同名可见会话 ⇒ NO_TARGET；degraded 守卫（别名形状 ⇒ UNAVAILABLE，ref 仍可用）；**无 cap 请求方 × 有别名成员**的混合矩阵，与 v0.7.1 夹具差分一致；`from.alias` 在 router 与 broadcast 两条路径上按收件方写出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AL3                                                                                             | 对账：attach、断链重连、hub 重启；旧连接的回包被丢弃；切换 sessionId 后旧回包被丢弃；`/new`、fork、切回旧会话；`lost` 在进程内只提示一次                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| AL4                                                                                             | `/fabric alias` 各分支；TUI take 确认；web/RPC 预览回显格式与 `XS_ALIAS_TAKE_CONFIRM_RE` 的往返；飞书拒在任何 hub 请求之前；prompt 文本被拒；`formatXsMessage`/`formatXsReply` 在最长 ASCII/CJK/扩展汉字别名 × 长名字组合下，首行能被 web 正则正确解析；无别名时逐字节不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AL5a                                                                                            | 工具实例冻结且稳定；legacy 实例等于 golden；**同 ref 的 UUIDv7 屏障**（§5.2）；`aliasUsable` 时 send 的 `to` 为完整 sessionId，非别名模式下帧不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| AL5b                                                                                            | `@WEB`：A 的 name=WEB、B 的 alias=web ⇒ 发给 B；全角输入；label 优先；同名文件放行；截断豁免；非别名模式逐字节相同                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ALU                                                                                             | `useTrackedCommand`：async → cmd_late → 一次 queryOnly 解包；E_CONFIRM_REQUIRED → 新 id + confirm 重发；取消、切会话、超时丢弃迟到结果；token 只取自本次 cmdId 的输出（同时有一条带同样确认行的转录消息也不会被采用）。chip 顺序与下移；弹窗校验与推荐；@ 面板显示 alias 但插入 ref；无 cap 时字节不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 集成 `tests/integration/fabric-xs-alias.test.ts`（真实 hub 子进程 + 3 个真实 stack + 真实桥接） | A 设置 `前端`，B 用 `to:"前端"` 送达；C 设置被拒；A 下线 10 分钟后 C 抢占成功，A 回来收到提示；A clear 后 10 分钟内 C 被拒；hub 重启后别名仍在，离线保留期从重启时起算；**「损坏 → 重启 → 同名会话在线」端到端负例**：写坏文件 → 启动（degraded）→ 重启 → 仍是 degraded，磁盘文件字节不变，`aliasCapable` 请求方用别名形状的名字得到 UNAVAILABLE，不会到达同名会话；人移走文件后 → 重启 → ready 空表；跨频道 ⇒ NO_TARGET；`@前端` 端到端；fork 拿不到别名；旧 agent 混跑；**web 抢占全链路**（经 hub 的 command op，含 `webCommandPolicy.fabric=confirm`）                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 兼容                                                                                            | `alias.enabled=false`：`xs_member`/`xs_req`/status/entry/format 与 reply-off golden 逐字节相等（cap 除外）；v0.7.1 router 差分覆盖「无 cap 请求方 × 有别名成员」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| conformance C-X11                                                                               | 真实 pi：别名版工具 schema 跨请求稳定；`alias="…"` 只以独立字段出现在 content；`details` 不进 provider；与 C-X1…C-X10 一起在 pi peer 升级前运行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## 10. 分包

规则：`src/stack.ts`、`src/index.ts` 只属于 ALW。**除 AL0a 外全部排在 CH6 合入之后**：AL2/AL3/AL4/AL5/ALU 与 CHW 正在改的文件（`stack.ts`、`index.ts`、`agent/xs.ts`）以及已合入的 CH1/CH3/CH4/CH5/CHU 文件重叠（router、members、broadcast、`agent/index.ts`、`fabric-xs`、sender、directory、mention、AgentCard、ChannelsDialog）。

| 包                    | 文件域                                                                                                                                                                                                                                                                                                                                         | 冻结面                                         | 依赖                              | 估时  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------- | ----- |
| **AL0a** 规则         | `protocol/xs-alias.ts`（新：normalize、skeleton、保留词、`XS_ALIAS_TAKE_TOKEN_RE`/`XS_ALIAS_TAKE_CONFIRM_RE`）、`tests/fixtures/xs-alias-corpus.json`（新）                                                                                                                                                                                    | —                                              | **r3 获批**；与频道包没有文件依赖 | 0.75d |
| **AL0b** 契约         | `protocol/xs.ts`（op `alias`、`alias/clear/take` 字段、`xs_res.alias`、rows/candidates/target 的 `alias`、`deliver.from.alias`、`XsStatus.alias`、错误码、`XS_REQ_DEADLINE_MS.alias=5000`）、`config/settings.ts`（`fabric.crossSession.alias.{enabled,offlineLeaseH,coolMin,takeMinOfflineMin}`）、`fabric/xs/types-alias.ts`（新：端口类型） | 三份 golden；旧帧形状                          | AL0a、CH6                         | 0.5d  |
| **AL1** hub 绑定表    | `hub/xs/aliases.ts`（新：记录/在场/墓碑/token/事务/IO 状态机/加载三态）                                                                                                                                                                                                                                                                        | —                                              | AL0b                              | 2d    |
| **AL2** hub 路由      | `hub/xs/{router,members,broadcast}.ts`、`hub/{hub,main,audit}.ts`                                                                                                                                                                                                                                                                              | 无 cap 请求方的输出                            | AL1                               | 1.5d  |
| **AL3** agent 连接    | `agent/xs.ts`（op 桥接、status 投影、缓存）、`agent/connection.ts`（截止表）、`agent/index.ts`（`onHubCaps` 对账）                                                                                                                                                                                                                             | slot 顺序                                      | AL0b                              | 0.75d |
| **AL4** 命令与格式    | `commands/fabric-xs.ts`、`agent/{command-policy,commands}.ts`、`fabric/xs/{format,render}.ts`                                                                                                                                                                                                                                                  | 无 alias 时的 format 字节                      | AL0b                              | 1.25d |
| **AL5a** 发送端与工具 | `fabric/xs/sender.ts`、`tools/{list-sessions,message-session}-tool.ts`                                                                                                                                                                                                                                                                         | legacy 实例 = golden                           | AL0b                              | 0.75d |
| **AL5b** mention      | `fabric/xs/directory.ts`、`mention/{session,autocomplete}.ts`                                                                                                                                                                                                                                                                                  | 非别名模式字节；`parseMention`                 | AL5a                              | 0.75d |
| **ALU** web           | `composables/useTrackedCommand.ts`（新）、`agents/{AgentCard.vue,agentCardModel.ts}`、`detail/{ChannelsDialog,DetailHeader}.vue`、`control/{sessionMention.ts,Composer.vue}`（只改显示）、`logic/xsMessage.ts`、`transcript/TxCustom.vue`、i18n                                                                                                | 无 cap 或无字段时 UI 字节不变；DetailDock 不动 | AL0a、AL0b                        | 2.25d |
| **ALW** 装配          | `stack.ts`、`index.ts`（工具实例选择、别名缓存端口、mention 接线、提示）                                                                                                                                                                                                                                                                       | —                                              | AL1–AL5b                          | 0.5d  |
| **AL6** 终局          | AGENTS.md（`src/fabric/` 段）、`tests/conformance/fabric-xs.test.ts`（C-X11）、集成测试、`alias-acceptance.md`                                                                                                                                                                                                                                 | —                                              | ALW、ALU                          | 1d    |

```
AL0a（r3 获批后即可） → [CH6 合入] → AL0b → { AL1 → AL2 } ∥ AL3 ∥ AL4 ∥ (AL5a → AL5b) ∥ ALU → ALW → AL6
```

合计约 **12 人日**；关键路径 AL0b(0.5) → AL1(2) → AL2(1.5) → ALW(0.5) → AL6(1) ≈ **5.5 天**（不含 AL0a 和等待 CH6 的时间）。

---

## 11. 残留（接受的近似）

| #   | 残留                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 绑定文件被**人为删除或移走**（包括处理损坏时人手动移走）⇒ 按全新处理，所有别名消失，`aliasUsable` 的请求方用这些词时回落到名字层（可能找到同名会话）。损坏或不可读时 hub 从不自动移走文件，每次启动都是 degraded，**不**回落；加载超时只影响本次运行 |
| R2  | 显示名恰好等于一个不可达的别名 ⇒ `aliasUsable` 的请求方只能用 ref 或它自己的别名找到它                                                                                                                                                               |
| R3  | 别名超过 20 个时，list 截断可能漏掉一部分；`@别名` 未命中就放行，并触发刷新                                                                                                                                                                          |
| R4  | 骨架表不包含 CJK↔CJK 形近字（如 `カ/力`）                                                                                                                                                                                                            |
| R5  | 冷却期只能缓解「list 快照过期」导致的误投，不能消除                                                                                                                                                                                                  |
| R6  | `lost` 提示在每个进程内只出现一次；pi 重启后，只要墓碑还在，会再提示一次                                                                                                                                                                             |
| R7  | 抢占预览向发起方透露持有会话的 cwd 和离线时长（Q5 已接受）                                                                                                                                                                                           |
| R8  | hub 每次重启都给离线持有者重置一次 7 天保留期（偏向持有者；在场状态不落盘的代价）                                                                                                                                                                    |
| R9  | `E_XS_ALIAS_UNKNOWN`（rename 在途）期间，同一 hub 上所有别名写入都 busy，直到 rename 结束或 hub 重启；读与寻址不受影响                                                                                                                               |
| R10 | 绑定文件损坏后，别名功能在人手动修复前一直不可用（每次启动都是 degraded）；用别名形状的名字寻址会得到 UNAVAILABLE，需要改用 ref                                                                                                                      |

---

## 12. 未决问题

无。NQ1–NQ5 已拍板，写入 §拍板。

---

## §R1 评审处置

评审：gpt-6.1-sol，r1 打回（reject）：2 Blocker、10 Major、3 Minor。全部采纳或部分采纳，**没有驳回**。

| #   | 严重度   | finding 摘要                                                                                                 | 处置                     | 说明                                                                                                                                                                                                            | 落点                          |
| --- | -------- | ------------------------------------------------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | Blocker  | `--take` 同时要求旧记录冷却和新持有者授予，与「每 key/skeleton 一条」冲突；同一 sid 改成同骨架名也破坏不变量 | **采纳**                 | 冻结状态转移表：take = **原记录就地转移**（被抢方不留冷却记录，改留 Tombstone）；不变量改为「同骨架的记录属于同一 sid」，同一 sid 改名时删掉自己的同骨架冷却记录；离线到期不冷却（NQ4）；每种转移都有确定性测试 | §2.2、§3.1、§3.2、§9 AL1      |
| 2   | Blocker  | `op:alias` 与 `xs_member` 回放两个写入口，没有版本/CAS，旧 slot 或丢回执可复活或撤销别名                     | **采纳（删掉一个入口）** | 删除 `xs_member.alias` 和 agent 侧持久化：hub 是唯一权威，唯一写入口是人发起的 op；串行事务，rename 前检查截止，rename 即提交，提交后替换内存；加载失败不声明 cap；重连只做只读查询（带 gen）                   | §3.3、§3.4、§4                |
| 3   | Major    | 普通发送先 resolve、再用原始 `to` send，hub 二次解析，存在改绑窗口                                           | **采纳**                 | 新增 `xs_req.pin`（resolve 得到的 ref），hub 在 send 时校验，不一致 ⇒ `NO_TARGET{changed}`；mention 同样带 pin；补屏障测试。删除 r1「单帧无 TOCTOU」的错误断言                                                  | §1 A3、§5.2、§5.4、§9 AL2/AL5 |
| 4   | Major    | 别名层只在可见池里找，不可达时落到同名显示名                                                                 | **采纳**                 | 规范化后命中绑定表即「只看这一层」，不可达 ⇒ NO_TARGET，不降级；补离线、未加入、跨频道、自己四类反例；代价列为 R2，降级与否作为 NQ2 请用户确认                                                                  | §5.1、§11 R2、§12 NQ2         |
| 5   | Major    | ASCII 裸名分支先于规范化别名分支，`@WEB` 会发给显示名为 WEB 的会话                                           | **采纳**                 | mention 先规范化查别名，再走旧分支；别名模式下旧分支改为 `to: token` + pin，由 hub 权威裁决；补大小写、全角、交叉冲突、截断用例                                                                                 | §5.4、§9 AL5                  |
| 6   | Major    | 白名单放过了韩文填充符 U+115F/U+1160/U+3164/U+FFA0                                                           | **采纳**                 | 先拒绝 `Default_Ignorable_Code_Point` 和全部 Jamo 块，韩文只收预组合音节；语料加入填充符的单独出现与前后缀；去掉「NFKC 消除异体」的表述                                                                         | §2.1、§9 AL0a                 |
| 7   | Major    | `lastSeenAt` 只在惰性 sweep 时更新，长期在线的持有者断线后可能立即过期                                       | **采纳**                 | 改为按 sid 记录 `offlineSince`：最后一个持有者失效时盖时间戳（`onInvalidate`/`onSession`）；在线判定在读取时做；崩溃后从加载时刻起算                                                                            | §3.2、§3.3、§9 AL1            |
| 8   | Major    | 只在 attach 后查询，遗漏断链重连和 hub 重启；查询失败后没有对账                                              | **采纳**                 | 对账挂在每次 hello_ack 的 `onHubCaps` 上（`agent/index.ts:1264-1274`），结果绑定连接 generation 与 gen，迟到的旧结果被丢弃；失败等下一个事件；因为不再回放，也就没有「复活」路径                                | §4、§10 AL3                   |
| 9   | Major    | 无 cap 请求方也启用别名寻址和排序，会改投、改顺序                                                            | **采纳**                 | 别名层、排序、pin、新增字段全部按请求方 cap 门控；补「无 cap × 有别名」混合矩阵，并纳入 v0.7.1 差分；NQ3 请用户确认                                                                                             | §3.6、§5.1、§5.3、§9 AL2      |
| 10  | Major    | confusable 错误回显实际的冲突别名，泄露不可见别名的文本                                                      | **采纳**                 | `taken`/`confusable` 不回显任何已有别名、持有者、频道、在线状态，held 与 cooling 也不区分；只有 take 预览透露 cwd 和离线时长（Q5 已接受）                                                                       | §2.2、§3.2、§8                |
| 11  | Major    | `fenceMeta` 截断整个 JSON，加上 alias 后会产生非法 JSON                                                      | **采纳**                 | 别名不进 `from` 对象，作为头部独立字段 ` alias="…"`（≤48 字节，不截断）；`fenceMeta` 不改；web 用独立正则解析；补最长组合测试，消息与回复都覆盖                                                                 | §6、§7.2、§9 AL4              |
| 12  | Major    | 浏览器无法做 label/文件检查；插入值实际在 Composer.vue                                                       | **采纳（MVP 收缩）**     | web 的 @ 面板只显示别名，插入值仍是 `@session:<ref>`；`Composer.vue` 列入 ALU 文件域，只改显示                                                                                                                  | §7.2、§10 ALU                 |
| 13  | Minor    | 分包漏了 `agent/index.ts`、`broadcast.ts`、`formatXsReply`                                                   | **采纳**                 | 三者都列入文件域并明确所有者；`from.alias` 覆盖发送、回复、迟到回复、广播                                                                                                                                       | §6、§10 AL2/AL3/AL4           |
| 14  | Minor    | AL0a「可立即开工」只是文件不冲突，规则尚未拍板                                                               | **采纳**                 | Q6–Q8 已拍板；AL0a 改为「r2 获批后可先行」                                                                                                                                                                      | §拍板、§10                    |
| 15  | Minor    | `to:"@web"` 早已被保留前缀拒绝；`q`+18 位十六进制并不匹配 `^[0-9a-f-]{8,}$`                                  | **采纳**                 | 删除 `to` 支持 `@` 的承诺，只在设置入口和 mention 解析时剥 `@`；q-id 改为由长度规则拒绝，并写入测试                                                                                                             | §1 A4、§2.1、§5.1             |
| —   | 建议     | MVP 收缩：砍 take、可配置租约、别名优先排序、大骨架表                                                        | **部分采纳**             | take、可配置租约、别名优先排序由用户拍板保留（Q2/Q5/Q11），其中排序只对具备 cap 的请求方生效；骨架表收缩为只含 ASCII 内部与 CJK↔ASCII；删掉回放与 agent 持久化，状态机明显变小                                  | §拍板、§2.2、§3、§4           |
| —   | 事实修正 | A11「所有对象都严格」过宽                                                                                    | **采纳**                 | 改为严格对象与开放对象分开说明                                                                                                                                                                                  | §1 A11                        |

---

## §R2 复审处置

复审：gpt-6.1-sol，r2 打回（reject）：0 Blocker、7 Major、1 Minor。全部采纳，**没有驳回**。r1 的 15 项中，复审认定 11 项已闭合、4 项部分闭合（#2/#3/#7/#8），这 4 项的剩余部分正是下表的 #2/#1/#3/#5。

| #   | 严重度 | finding 摘要                                                                                                    | 处置                      | 说明                                                                                                                                                                                                                                                                                                                           | 落点                               |
| --- | ------ | --------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| 1   | Major  | pin 比的是 12 字符 ref；UUIDv7 同时间窗口的会话 ref 相同，目标替换后 pin 仍能通过                               | **采纳（删掉 pin）**      | 删除 `xs_req.pin`。`aliasUsable` 时 resolve 一律返回完整 sessionId，sender 用它作为 send 的 `to`（与回复分支同一机制，线上没有新字段）；mention 不再自带 pin，目录缓存只决定拦不拦截。§1 A4 写明「ref 不是身份」；补同 ref 的 UUIDv7 屏障测试                                                                                  | §1 A3/A4、§5.2、§5.4、§9 AL5a      |
| 2   | Major  | 人工 op 串行，不等于整张表的所有变化都串行；整表提交可能覆盖 offlineSince；take 可能在持有者重新上线后提交      | **采纳（拆状态 + 复核）** | 在场改为只存内存、从不落盘；过期与冷却到期改为读时谓词；记录只由事务修改（I6），新表 = 当前记录 + 差量，因此结构上不可能用旧快照覆盖在场。rename 前复核请求方身份、记录 rev、takeable、预算，take 的线性化点就在复核处。补 fsync 期间断开、重连、切会话、token 竞争的确定性交错测试                                            | §3.1、§3.2、§3.3、§9 AL1           |
| 3   | Major  | 尽力落盘的 offlineSince 会被当成当前离线周期，导致提前释放                                                      | **采纳（最保守的规则）**  | offlineSince 不再落盘；hub 加载后，所有 held 持有者一律从加载时刻起算，直到重连。代价是重启会重置保留期（R8，偏向持有者）。补「上线清除 → 长期在线 → 崩溃 → 重启后别人先查询」⇒ 不过期                                                                                                                                         | §3.1、§3.3、§11 R8、§9 AL1         |
| 4   | Major  | web 预览要 await hub，`runCommand` 只给出初始 async 回执；ChannelsDialog 没有处理 cmd_late/queryOnly 和通用确认 | **采纳**                  | 新建 `useTrackedCommand`：自建 cmdId → 跟踪 pendingCtl → 一次 queryOnly 解出最终输出；E_CONFIRM_REQUIRED 用新 id + confirm 重发；取消、切会话、超时都有规则；预览和执行都处理策略确认。DetailDock 不动。补真实桥接集成测试，`webCommandPolicy.fabric=confirm` 也覆盖                                                           | §1 A13、§7.1、§9 ALU/集成、§10 ALU |
| 5   | Major  | 缓存跨 reload，只按数值 gen 单调应用，没有 session/hub 世代命名空间                                             | **采纳（缩小）**          | 删除 gen 和跨 reload 缓存：缓存放在 stack 闭包，按 sessionId 隔离（上限 8）；只接受当前连接世代 + 当前 sessionId 的回包，同一有序连接上按到达顺序应用；只有提示去重集合跨 reload。补 `/new`、fork、切回、重连、hub 重启的测试                                                                                                  | §4、§9 AL3                         |
| 6   | Major  | 2s/5s 预算不等于物理 IO 有界；rename 在途、晚到 IO、队列积压没有规则                                            | **采纳**                  | 单一物理写；队列上限 4，排队时间计入 4s 预算；每个事务用独立临时文件名；fsync 超时 ⇒ zombie（>2 个 ⇒ disabled）；rename 超过 1s ⇒ 回复 `E_XS_ALIAS_UNKNOWN`（不是 none），进入 wedged，期间所有写都 busy，rename 结束后再按结果收尾；超过 60s ⇒ disabled。照 avatar store 的 pending/zombie 先例。补永不结束和晚结束的 IO 测试 | §3.3、§3.4、§11 R9、§9 AL1         |
| 7   | Major  | 「状态丢失失败关闭、不会误投」不成立；加载失败不声明 cap，也没有禁止 router 按 hello cap 启用别名语义           | **采纳**                  | 定义 `aliasUsable = store ∈ {ready, disabled} ∧ 请求方 cap`（r4 改为 `aliasAdvertised ∧ 请求方 cap`，见 §R3 #2），所有别名语义按它门控；加载分三态，degraded 不声明 cap，并对 `aliasCapable` 请求方守卫别名形状的名字（UNAVAILABLE，不回落）。人为删除文件按全新处理，如实列为 R1，删掉「不会误投」的断言                      | §3.3、§3.6、§5.1、§11 R1           |
| 8   | Minor  | token 缺消费时点、失败后能否重用、满额策略、重启负例                                                            | **采纳**                  | 冻结 issued → reserved（执行一到达就摘除）→ consumed（**任何结果**都消耗）；只在内存，重启即失效；满 32 个 ⇒ busy，不淘汰；绑定元组加上记录 rev；web 只从本次预览 cmdId 的 captured 输出取 token。删掉「token 证明看过预览即确认」的表述，改为「人的确认是 UX 闸门」。补全部负例                                               | §3.5、§7.1、§9 AL1/ALU             |
| —   | 澄清   | 「agent 无任何途径」的边界                                                                                      | **采纳**                  | §8 写明：不注册工具 + prompt 拦截 + 命令回显隔离；不防同 uid 进程，那超出现有信任边界                                                                                                                                                                                                                                          | §8                                 |
| —   | 澄清   | I3 在骨架升级后不应写成没有例外                                                                                 | **采纳**                  | I3 限定为「按当前骨架版本新建或改名的记录」，历史冲突是例外                                                                                                                                                                                                                                                                    | §2.2、§3.1                         |
| —   | 拍板   | NQ1–NQ5                                                                                                         | **已写入**                | NQ1 抢占门槛 ≥10 分钟（`takeMinOfflineMin` 下限 10，不能调到 0）；NQ2 不回落；NQ3 旧端保持旧行为；NQ4 离线到期不冷却；NQ5 含假名与韩文音节                                                                                                                                                                                     | §拍板、§3.6                        |

---

## §R3 复审处置

复审：gpt-6.1-sol，r3 打回（reject）：0 Blocker、3 Major、1 Minor。复审确认单写者、内存在场、完整 sessionId、token、web 跟踪这几块结构不需要推翻。本轮全部采纳，**没有驳回**，只改下表落点，其余正文不动。

| #   | 严重度 | finding 摘要                                                                                                                     | 处置                   | 说明                                                                                                                                                                                                                                                                                                                                                                                            | 落点                                                              |
| --- | ------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | Major  | 普通发送只把 `to` 改成完整 sessionId，hub 的 send 只在有回复字段时走 exact；原目标消失后，仍可能回落到显示名等于该 ID 的其他会话 | **采纳**               | send 的 exact 判定改为「有回复字段 或 `aliasUsable(self)`」，复用现有 exact 层（全等，不 trim、不前缀），保留可见池、self 排除和全表 holders 判重。`aliasUsable` 普通 send 的找不到一律映射为 `NO_TARGET`（none），不进入前缀、别名或名字层；判定只依据已协商的能力，线上没有新字段，无 cap 请求方与 off golden 不变。补「显示名等于 A 的完整 ID」和「自定义 ID 以 A 的完整 ID 为前缀」两个反例 | §5.2、§3.6、§9 AL2                                                |
| 2   | Major  | `aliasUsable` 排除了 wedged，降级守卫又只覆盖 degraded；rename 未决期间会退回旧四层，把原别名地址当显示名发给别人                | **采纳**               | `aliasUsable = aliasAdvertised ∧ 请求方 cap`，其中 `aliasAdvertised` 在整个运行期内不变，与 agent 侧的判断完全对称；ready/wedged/disabled 都读内存表、别名层照常，只禁写；守卫只用于 degraded（没有可信表的唯一状态）。新增状态×行为矩阵和转换清单，消除「disabled 同 degraded」的歧义；补 ready→wedged→ready（成功/失败）与 wedged→disabled 四种转换下「不会到达同名会话」的断言               | §3.3（矩阵）、§3.6、§5.1、§9 AL2                                  |
| 3   | Major  | 损坏文件被自动改名为 `.bak`，下次启动因主文件不存在而变成 ready 空表，恢复名字回落；R1 的「只有人为删除」不成立                  | **采纳（最保守方案）** | 删除自动改名：损坏或不可读时 hub 一个字节都不写，主文件原地保留，每次启动都是 degraded，直到人手动修复或移走（移走等同于 R1 的人为删除）；不新增重置命令，`/webhub status` 给出路径和修复提示。加载超时只影响本次运行。补「损坏 → 重启 → 同名会话在线」端到端负例和「degraded 时磁盘字节不变」断言；R1 改写，新增 R10（损坏后别名停用直到人修复）                                               | §3.3（加载、损坏的处理）、§11 R1/R10、§9 AL1/集成、一页摘要风险 5 |
| 4   | Minor  | 「过期 held 被 set 转移给 S」那一行漏了「S 原有 held 转 cooling」，违反 I2                                                       | **采纳**               | 提出共同步骤 G（S 名下除 x 以外的 held 转 cooling，并清理 S 自己同骨架的 cooling），所有成功的 set/take 先执行 G 再执行各行的差量；容量只在新建记录时判定。补「S 已持有 y 时三种方式拿到 x」和「满 256 条时过期接管/take 仍然成功」的测试                                                                                                                                                       | §3.2、§9 AL1                                                      |
