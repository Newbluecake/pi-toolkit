# 统一 `memory` 工具设计稿（v3）

- 日期：2026-11-09；仓库基线：`9e1a83d0`。
- 已拍板方向：主工具默认 `project`；复用既有存储；不做跨作用域写事务。实际 blocks surface 发布统一 v4，非 blocks 保留原 memory surface 与 scoped 兼容入口。
- 除明确标为“阶段 2 新增”的能力外，不得借合并改变现有权限、存储、错误或审批行为。

## 1. 背景、目标与约束

### 1.1 目标

1. blocks 的主工具以 `scope: "project" | "session" | "hub"` 选择记忆边界；`all` 仅用于只读聚合。
2. 保留 project blocks、session JSONL fold、hub block/侧车/审计的格式与准入规则。
3. 统一 blocks 新入口的参数和 DTO；旧门面在兼容期保持原校验顺序与可观察行为。
4. 默认 `project` 只作用于实际判定为 blocks 的 v4，不得改变旧 `scoped_memory` 或 v2/legacy 的默认语义。
5. session/hub 的 `search`、聚合 DTO、结构化 project 错误均是阶段 2 新契约，不伪装成现状。
6. 阶段 3 只在实际 v4 surface 退役别名；v2/legacy 没有 v4 等价入口，故继续保留 `scoped_memory`，不得全局删除其 session/hub 能力。

### 1.2 约束

- I12：机制进入 description/schema；选择、纠错和草稿策略进入 `memory-jev` skill。
- I8：存储与域逻辑保持 pi-free；I4：dispatcher、owner、approval 均无 module-scope 可变状态。
- D8：secure/locked 根本不接 scopes；统一入口不得 lazy-resolve 被禁存储。
- 不做数据迁移，不新增 dispatcher 限流，不新增 grant CAS、拒绝审计或 hub 多文件事务；这些若要做必须另行设计申报。
- 不为统一错误名称修改现有 store 或 alias：session 与 hub 的容量错误按各自现状保留。

## 2. 已核实现状

### 2.1 三类存储

- project v3：`command/path`；`update` 整块替换且 `rev` 必填；`delete path [rev]` 的 `rev` 可选，缺省或空串不做 CAS，提供但不匹配返回 `E_CONFLICT`。
- session：JSONL append/fold；条目 `rev` 是 fold 结果上的 8 位令牌，`update/delete` 必须带当前值，不匹配返回 `E_CONFLICT`。容量为单条 1024B、最多 48 项、活跃正文合计 8192B；项数超限为 `E_FULL`，总正文超限为 `E_TOO_LARGE`。
- hub：公开 `rev` 是 block version + 原文件 hash；`items.json` grant 侧车不进入 hash，只须与 block 的 `rev/updated` 独立一致。容量为单条 1024B、最多 32 项、活跃正文合计 4096B；项数或总正文超限均为 `E_FULL`。
- session 默认 agent 权威写不需审批；显式 user 权威写、更新/删除既有 user 条目均需 `sharedApproval.request`。hub 写始终需要真人审批；hub 输入里的 `authority` 当前被忽略。

### 2.2 surface 与冻结件

- project 仍有 blocks/v3、v2/tiered、显式 `files`/legacy 三种 surface；v4 **只对 `toolSurfaceFor` 实际返回 v3 的 blocks surface 发布**，不得仅凭配置标签或目录名判断。held、files+auto、secureLocked 等分支按该函数真实结果处理，v2/legacy 保持原工厂、schema、文本和 frozen/off golden。
- scoped wiring 与 scoped 工具注册是两个判断：wiring 可在 child 仅 hub 开启时存在，但工具不注册；scoped 注册也不以 blocks 布局为条件。
- `tests/fixtures/memory-tool-surface.json`：既有 variant key 做 canonical equality；v4 必须新增完整 variant，不得把字段追加进旧 v3。
- `tests/fixtures/scoped-memory-tool-surface.json`：精确固定 `scoped_memory` description/schema；虽未登记进 AGENTS frozen 表，仍有测试约束，属于治理登记缺口，不等于可重生。
- `tests/fixtures/tools/agent-nested-surface-golden.json`：**byte-for-byte FROZEN**，只冻结 Agent 工具的 allowedTypes/parameters/description；本方案全程要求其字节不变。
- `tests/fixtures/agents-md` 与 compact/reflex 等 off golden 不在本次变更中重生。

## 3. 总体设计与装配生命周期

### 3.1 模块边界

```text
memory v4（仅实际 blocks surface）─┐
scoped_memory（按注册谓词）────────┼─> per-activation scoped dispatcher
legacy/v2 project factory ─────────┘        │
                                            └─> scopes wiring.current()
                                                  ├─> 当前 owner + session store
                                                  └─> 当前 owner + hub store + sharedApproval
```

dispatcher 只做 scoped 参数归一化、DTO 组装和转发，不直接持文件路径、owner、cap，不自行实现审批。`src/memory/index.ts` 每次 activation 唯一创建并注入 dispatcher；v2/legacy project factory 不接入 v4。`src/memory/scopes/wire.ts` 仍是 owner/group、human-turn tracker、cap registry 与 sharedApproval 的唯一创建和销毁者。

### 3.2 注册谓词、顺序与关闭路径

每 activation 重新计算，不缓存布局结论：

```ts
wiringExists = memoryEnabled && domain === "plain" && (scopes.session || scopes.hub);
scopedRegistered = wiringExists && (!child || scopes.session);
actualSurface = toolSurfaceFor(/* 当前真实设置、目录与 secure 状态 */);
v4Active = memoryEnabled && actualSurface === "v3"; // 阶段 2 起由同一分支创建 v4
```

因此 `session=false, hub=true, child=true` 时 wiringExists=true 而 scopedRegistered=false，注册表中不得出现 `scoped_memory`。v4 的创建、replacement 和阶段 3 退役都只认 `v4Active`，不得把 wiringExists 当作工具已注册，也不得把 files/held 等配置标签直接当作 blocks。

注册与关闭顺序：

1. `initSecureDomain()` 仍为 `activate()` 首语句；随后按 `toolSurfaceFor` 的实际结果创建 memory surface。
2. 仅满足 wiringExists 时创建 scopes wiring；secure/locked 或 scopes-off 时该对象为 absent。
3. 各布局的 memory 每 activation 只注册一次；仅 scopedRegistered=true 时注册一次 `scoped_memory`。scopes 关闭不影响 project surface 的原有命令。
4. reload/teardown 先使旧 wiring 不可达并 dispose owner、revoke turn/cap，再释放 dispatcher；新 activation 不 reuse 旧对象。注册顺序若改变 `governance/activate-trace.json`，须单独申报。

### 3.3 owner 重建与两种撤权路径

`open(manager)` 换 session manager、`tree()` 换分支时，wire 先 dispose 旧 group，再增加 epoch/branchGen 并 publish 新 owner。dispatcher 每次 execute 都解析 `wiring.current()`，不得跨 await 复用旧 owner。旧调用在最后 await 后仍须通过 lifecycle、owner identity、read gate 和 cap 检查，否则返回现有错误且零提交。

必须区分：

- **tree/reload/teardown**：真实路径为 `owner.dispose → abort signal`；sharedApproval 的 abort 分支结算 `E_HUB_DECLINED`、关闭可关闭的确认渠道并撤 cap，旧 owner 不能提交。
- **仅 tracker/input 失效**：只撤 turn/cap，不保证立即关框或立即结算 promise；已显示的框等待 signal、选择、Web 回答或 120s timer。

生命周期验收逐项断言：activate → reload 后同名工具各只有一个；A → B 与 tree 切换后 A 的 cap 不可 consume；tree 切换时 pending approval 因 abort 返回 `E_HUB_DECLINED`，迟到 approve 不写 A 或 B；scopes-off 与 secure/locked 下 project 按原配置可用且 hub path resolve 次数为零；child 重建后仍禁止 hub，任何 authority 字段仍返回 `E_CHILD_AUTHORITY`。

## 4. 接口契约

### 4.1 v4 schema

```ts
type MemoryV4Params = {
  command: "view" | "create" | "update" | "delete" | "search";
  scope?: "project" | "session" | "hub" | "all"; // 默认 project
  path?: string;
  id?: string;
  text?: string;
  rev?: string;
  query?: string;
  topic?: string;
  from?: string;
  authority?: "agent" | "user";
};
```

发布 schema 为 `additionalProperties:false`，不包含 `op/storageScope`。字段规则如下；不满足时在存储和审批前返回对应错误：

| 字段        | project                                    | session                                    | hub                               |
| ----------- | ------------------------------------------ | ------------------------------------------ | --------------------------------- |
| `path`      | view/update/delete 使用；create 用 `topic` | 禁止                                       | 禁止                              |
| `id`        | 禁止                                       | view 可选，update/delete 必填              | view 可选，update/delete 必填     |
| `text`      | create/update 必填                         | create/update 必填；delete 使用当前正文    | 同 session                        |
| `rev`       | update 必填，delete 可选                   | update/delete 必填                         | update/delete 必填                |
| `query`     | search 必填                                | 阶段 2 search 必填                         | 阶段 2 search 必填                |
| `topic`     | create 必填                                | 禁止                                       | create 按现有 store 要求提供      |
| `from`      | 禁止                                       | 可选 `session:nN` 或 `project:<reference>` | 同 session；不授予权限            |
| `authority` | 禁止；块权威仍由 mem 注释表达              | 可选，缺省 agent；child 出现即拒绝         | 为保现状被忽略，实际权威恒为 user |

模型传入的 `authority` 只是操作元数据，不是宿主身份。owner、human turn、provenance、child、secure 状态只能由宿主注入；传 `authority:"user"` 不会绕过真人回合、弹框或 cap。

其他规则：`all` 只允许 view/search；`path+id` 同时出现返回 `E_META_INVALID`；create 不接受 `id/rev`；session/hub 的 update/delete 缺 rev 返回 `E_REV_REQUIRED`，冲突返回 `E_CONFLICT`。主入口出现 `op/storageScope` 由封闭 schema 拒绝；内部 normalizer 对 `command+op`、`scope+storageScope` 再防御性返回 `E_META_INVALID`，绝不择一继续。

**all 的字段白名单**：`view all` 只许 `command+scope`，`search all` 只许 `command+scope+query`。path/id/text/rev/topic/from/authority 以及 view 的 query 即使已在 schema 声明，也一律返回 `E_META_INVALID`；不得静默忽略或只对部分 scope 过滤。验收对每个禁用字段分别构造调用，断言三个 adapter 的 dispatch 次数均为 0、弹框数为 0、存储 diff 为空；search 缺 query 同样在 dispatch 前失败。

### 4.2 各布局注册、别名与 replacement

下表中的 scoped 均受 §3.2 的 scopedRegistered 谓词约束；表中“保留”不表示 child 仅 hub 时强行注册：

| 阶段 | 实际 blocks/v3 surface                        | v2/tiered                                 | legacy/`files`                                |
| ---- | --------------------------------------------- | ----------------------------------------- | --------------------------------------------- |
| 1    | 原 memory v3 + scoped 旧门面                  | 原 memory v2 + scoped 旧门面              | 原 memory legacy + scoped 旧门面              |
| 2    | memory v4 + scoped；仅此处生成 v4 replacement | 原 memory v2 + scoped；不生成 replacement | 原 memory legacy + scoped；不生成 replacement |
| 3    | memory v4，退役 scoped                        | 原 memory v2 + scoped，继续全功能保留     | 原 memory legacy + scoped，继续全功能保留     |

旧别名仍发布原 `op/storageScope/id/text/rev/topic/from/authority` 封闭 schema，`op` 与 `storageScope` 均必填；旧 `view` 缺 `storageScope` 仍按原错误失败。别名先执行现有校验及错误顺序，再映射 `op→command`、`storageScope→scope`，不得先映射后校验。

可观察顺序固定为：child 的任意 `authority` 先返回 `E_CHILD_AUTHORITY`；未知字段返回 `E_META_INVALID`；缺失/非法 `storageScope` 返回 `E_SCOPE_DISABLED`；随后才做 read gate、字段类型、正文大小、from/topic、op 与 rev 校验。hub 的 `authority` 继续忽略。

只有当前 v4Active=true 且确实注册 memory v4 时，阶段 2 才在每次通过旧 schema 的 scoped 调用结果中追加 `deprecation.replacement`；非 blocks 不追加该字段，阶段 3 也不退役其别名。未来若要全局删除，必须另立设计，为非 blocks 提供等价 scoped 入口或明确申报能力退役。

下面是**不可直接执行的变量示意**：`3f8a9cb2` 只展示 session rev 的 8 位形态，并非已从固定 fixture 取证的值；实际调用必须把它替换为 n7 最近 view 返回的完整 8 位 rev：

```json
{
  "tool": "memory",
  "params": { "command": "update", "scope": "session", "id": "n7", "rev": "3f8a9cb2", "text": "updated" }
}
```

验收不得只检查字段重命名：从真实 view 取得 `n7` 和实际 8 位 rev，在相同初始快照的两个临时会话 A/B 中分别执行旧 update 与其 replacement，比较正文、item 与新 rev 等价；另将真实旧 view 产生的 replacement 直接交给已注册 v4 执行，断言返回同一 item。非 blocks 的 `files` 与 tiered 配置各跑 session 和 hub 的 create → view → update → delete：session 用默认 agent，hub 用有效测试真人回合与精确批准，四轮均操作真实临时存储，证明保留入口的能力未退化。

### 4.3 命令矩阵与 rev

| 命令   | project（blocks）            | session                    | hub                          |
| ------ | ---------------------------- | -------------------------- | ---------------------------- |
| view   | 原 v3 视图                   | fold 后条目及 rev          | read gate 后条目及 block rev |
| create | 原 v3 创建                   | append 后形成新 rev        | 审批后创建 block + 一致侧车  |
| update | 整块替换，强制 CAS           | append 更新，强制 CAS      | 审批前后按现有规则检查 rev   |
| delete | 软删除；rev 可选，提供才 CAS | append tombstone，强制 CAS | 审批后删除；强制 CAS         |
| search | 原 project search            | **阶段 2 新增**            | **阶段 2 新增**              |

三种 rev 都仅与同 scope、同 id 的当前值比较：project 为 version+hash；session 为 fold 结果的 8 位令牌；hub 为 block rev。hub grant 侧车只做独立一致性校验，不进入 rev hash。若未来要让 grant 变化参与 CAS，必须另立行为变更设计，不能夹入本合并。

### 4.4 审批矩阵与准入

session 规则如下；child 的“显式 agent”与“显式 user”均因**字段出现**而在最前返回 `E_CHILD_AUTHORITY`，没有例外：

| 操作与目标                  | 输入 authority  | main 行为                                 | child 行为                                |
| --------------------------- | --------------- | ----------------------------------------- | ----------------------------------------- |
| create                      | 省略            | 有效 agent，不弹框，write gate 后 enqueue | 有效 agent，不弹框，write gate 后 enqueue |
| create                      | 显式 agent      | 有效 agent，不弹框                        | `E_CHILD_AUTHORITY`，零弹框、零写入       |
| create                      | 显式 user       | 有效 user，真人回合 + 精确正文审批        | `E_CHILD_AUTHORITY`，零弹框、零写入       |
| update/delete 既有 agent 项 | 省略            | 有效 agent，不弹框                        | 有效 agent，不弹框                        |
| update/delete 既有 agent 项 | 显式 agent      | 有效 agent，不弹框                        | `E_CHILD_AUTHORITY`，零弹框、零写入       |
| update/delete 既有 agent 项 | 显式 user       | 有效 user，审批                           | `E_CHILD_AUTHORITY`，零弹框、零写入       |
| update/delete 既有 user 项  | 省略            | 有效 user，审批；delete 冻结当前正文      | `E_AUTHORITY`，零弹框、零写入             |
| update/delete 既有 user 项  | 显式 agent/user | 有效 user，审批                           | `E_CHILD_AUTHORITY`，零弹框、零写入       |

hub 所有写均需 user 审批；project 写不使用 sharedApproval。任何 session user 或 hub 审批必须先通过下列准入，每个失败分支均断言**零弹框、零写入、零新 cap**：

| 条件                                        | 现有结果                          |
| ------------------------------------------- | --------------------------------- |
| operation/text digest 或 nonce 不合法       | `E_META_INVALID`                  |
| 无当前 proven human turn 或 owner 不匹配    | `E_HUB_NEEDS_HUMAN_TURN`          |
| `tracker.rejected()` 已置位                 | `E_HUB_DECLINED_TURN`             |
| 本回合已有 3 次正式弹框                     | 第 4 次返回 `E_HUB_RATE`          |
| `inFlight > 0`                              | 新请求返回 `E_HUB_RATE`           |
| TUI/Web 确认渠道均不可用                    | `E_HUB_CONFIRM_UNAVAILABLE`       |
| read gate、secure、child/authority 预检失败 | 对应现有码，不进入 sharedApproval |

只有渠道可用后才 `noteDialog()` 并进入 inFlight。120s 到期、abort、TUI 非批准值以 `E_HUB_DECLINED` 结算；显式 Web reject/cancel 被接收后也按现有路径结算。审批通过仅 mint 一次性 cap，提交前仍复查 owner/lifecycle/gate。

### 4.5 回合失效、Web 回调与持久化边界

本方案**不新增“input 回合失效立即关框”**：`tracker.invalidate()` 与 `ApprovalPort.revoke()` 只撤 tracker/cap。tree/reload 的 owner.dispose 则通过 abort signal 走即时结算路径，二者不得混写。若未来要求 tracker-only 失效也即时关框，必须在 owner-local approval wiring 增加撤销接线并另行申报。

Web `onWeb` 返回 false 只表示该回调未被接收，不等于 approval promise 已以 declined 结算：非允许 origin、答案缺少有效值、turn binding 失效或 race 已失败都可能返回 false。此时 promise 可继续等待，直到有效回答、abort 或 timeout。验收必须分开：

1. ManualClock 到 119999ms 未结算，120000ms 返回 `E_HUB_DECLINED`；timeout 后 Web approve 返回 false，且不 mint、不提交。
2. tracker-only turn 失效但未 abort 时，Web approve 返回 false；若没有其他事件，119999ms 仍未结算，120000ms 才 declined，存储始终无写入。
3. tree teardown 触发 owner.dispose/abort，promise 以 `E_HUB_DECLINED` 结算；随后任何 TUI/Web approve 均不能提交。
4. abort、TUI 非批准值分别直接断言 `E_HUB_DECLINED`，不得用“Web 返回 false”替代 promise 结果断言。

拒绝、超时及准入失败对 hub 正文、`items.json`、`audit.jsonl` 均为零写入。audit 只在获批提交路径写。多文件提交可能返回 `E_PERSIST_UNKNOWN` 并留下部分状态；此时禁止盲重试，必须按现有惰化/恢复规则检查 namespace、item 与持久化状态。要补拒绝审计或事务性，须另立变更。

### 4.6 聚合 DTO 与 scoped search

`view/search all` 固定返回三组 status；**失败时 `groups[scope]` 整组省略**，不保留空容器，也不伪装 `items:[]`：

```ts
type AggregateRead = {
  ok: true;
  partial: boolean;
  scopeStatus: { project: ScopeStatus; session: ScopeStatus; hub: ScopeStatus };
  groups: { project?: ProjectReadGroup; session?: SessionReadGroup; hub?: HubReadGroup };
};
type ScopeStatus = {
  state: "ok" | "empty" | "absent" | "disabled" | "inert" | "poisoned" | "error";
  code?: string;
  message?: string;
  originalCode?: string;
  originalMessage?: string;
};
type ProjectReadGroup =
  | { kind: "listing"; text: string }
  | { kind: "hits"; hits: { path: string; rev: string; line: number; text: string }[] };
type SessionEntry = { id: string; rev: string; item: SessionItem; inherited?: unknown };
type HubEntry = { id: string; rev: string; item: HubItem };
type SessionReadGroup = { kind: "items"; items: SessionEntry[] } | { kind: "hits"; hits: SessionEntry[] };
type HubReadGroup = { kind: "items"; items: HubEntry[] } | { kind: "hits"; hits: HubEntry[] };
```

view 的 session/hub 只用 items 分支，search 只用 hits 分支。`SessionEntry.item` 保留现有嵌套 SessionItem 全文，`HubEntry.item` 保留授权可见的 HubItem 全文；hit 复用同一 entry，因此总带当前 rev。project `view all` 无 path，使用 `kind:"listing"`，`text` 逐字保留 v3 的预算/主题列表投影，不虚构 items；project search 使用上述四个 hit 字段。

状态定义：`ok` 为成功有结果，`empty` 为成功空结果，`absent` 为存储尚未建立但可正常视为空；三者都不是失败。`disabled/inert/poisoned` 分别表示 gate/配置禁用、hub namespace inert、已观察持久化毒化或 project 语料毒化。普通读取异常（包括 `getBranch/getLeafId/getSessionFile` 直接抛错）映射为 `state:"error"`，不得误报 poisoned。disabled/inert/poisoned/error 均令 `partial=true` 并省略对应 group；原始错误字段只放该组 `ScopeStatus`。

新增只读 `inspect` port 暴露状态；project 在 `readCorpus` fallback 前取得错误，session 区分 `view().poisoned` 与 getter 异常，hub 读取 `status().state`。该 port 不写、不修复、不改变注入路径。child、secure/locked、无 hub read gate 时 hub group 整体省略，status 不得包含 id、正文、rev、grant。

完整 JSON 断言例：session `getBranch` 抛普通错误，project/hub 成功：

```json
{
  "ok": true,
  "partial": true,
  "scopeStatus": {
    "project": { "state": "ok" },
    "session": {
      "state": "error",
      "code": "E_INTERNAL",
      "message": "session memory read failed",
      "originalMessage": "getBranch failed: broken branch"
    },
    "hub": { "state": "empty" }
  },
  "groups": {
    "project": { "kind": "listing", "text": "PROJECT LISTING\nquota: 1 block" },
    "hub": { "kind": "items", "items": [] }
  }
}
```

断言 `groups` 没有 session key，project 文本与 hub 空组原样保留。另对照可用空存储 `partial:false` 与 getter 失败 `partial:true`，防止成功空/失败空混淆。

阶段 2 的 session/hub search：非空 query 对当前可见 item 正文做大小写不敏感字面子串匹配，不支持正则；按 item id 字典序排序，每 scope 最多 50 项，返回上述 entry/hits，不写存储。project 保留原匹配与排序；all 按 project → session → hub 分组。

### 4.7 错误契约与可达性

阶段 1 旧 project 门面继续返回成功文本、抛 `MemoryError` 或普通 `Error`；旧 scoped 门面继续返回原 JSON 错误。阶段 2 仅 v4 使用 `{code,message,originalCode?,originalMessage?}`，其 code 是字符串并集，不再宣称全部属于 `ScopedMemoryErrorCode`。

scoped 错误逐码原样保留；project 的 `E_NOT_FOUND/E_REV_REQUIRED/E_CONFLICT/E_TOO_LARGE/E_WRITE_GATE/E_READONLY/E_BAD_PATH/E_BAD_TOPIC/E_UNMIGRATED/E_UNSUPPORTED_COMMAND` 均映射同名 code，originalMessage 保留当前 rev、迁移、gate 等完整指引。其他带前缀 MemoryError 映射 `E_INTERNAL` + originalCode；无码 MemoryError、普通 Error 映射 `E_INTERNAL` + originalMessage。禁止把 project 异常送入 hub `asCode`，避免塌缩为 `E_PERSIST`。

| 环境              | project                                                                    | session                            | hub                                    |
| ----------------- | -------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------- |
| main              | 当前布局的原权限与 write gate                                              | 当前 owner；写受 gate/权威审批     | read gate；写需真人审批                |
| child，scopes-on  | **强制只读**：`allowWriteInChildSessions` 被改写为 false，拒绝 gate 再兜底 | 按 §4.4；显式 authority 一律先拒绝 | `E_SCOPE_DISABLED`                     |
| child，scopes-off | 保持原 `allowWriteInChildSessions`：true 可写，false 只读                  | 未接线，`E_SCOPE_DISABLED`         | 未接线，`E_SCOPE_DISABLED`             |
| secure/locked     | project 独立按原配置可用                                                   | 未接线，`E_SCOPE_DISABLED`         | 未接线，禁止 resolve/read/write        |
| fabric 到接收会话 | 只操作接收会话 cwd                                                         | 只操作接收 owner                   | 跨会话消息不是真人回合，写拒绝且不弹框 |

child 交叉测试固定四格，每格都尝试 project create/update/delete：scopes-on × allow=true 与 scopes-on × allow=false 均只读并返回 `E_READONLY`；scopes-off × allow=true 在原 child gate 下可写；scopes-off × allow=false 返回 `E_READONLY`。同时断言 scopes-on 的有效 settings 快照确为 false，不能只看工具描述。

## 5. 冻结契约、预算与兼容策略

### 5.1 fixture 处置

`memory-tool-surface.json` 只新增 `blocksUnified`、`blocksUnifiedJev`、`blocksUnifiedChild` 三个完整 canonical variant，以及对应 `bytes.*` key；旧 `blocks/blocksJev/bytes.*` 字节不变。

`scoped-memory-tool-surface.json` 在阶段 1/2 保持 description/schema 字节不变；弃用提示只进 blocks 的结果。阶段 1 先把该 fixture 登记到 AGENTS 的 B 级契约表，登记本身不重生文件。阶段 3 因非 blocks 仍保留别名，该 fixture 与测试也继续保留；只有未来获批的全局删除才能退役它们。

`tests/fixtures/tools/agent-nested-surface-golden.json` 始终字节不变。child 所见 memory description/schema 由独立的 `tests/memory/tool-surface.test.ts` 直接结构断言固定，不覆盖、不追加 Agent 冻结件。

### 5.2 I12 字节预算

沿用 `description + promptSnippet + newline-joined guidelines + JSON.stringify(parameters)` 的 UTF-8 字节公式：

| variant   | 单工具上限 | blocks 兼容期与 scoped alias 合计上限 |
| --------- | ---------: | ------------------------------------: |
| v4 base   |      4096B |                                 6656B |
| v4 Jev-on |      4608B |                                 7168B |
| v4 child  |      4096B |                                 6656B |

兼容期 alias 预算固定为 2560B，超出任一上限即评审失败。description/schema 只写命令、shared 属性、审批和容量；skill 明确“project 默认、短期草稿用 session、hub 仅稳定跨项目事实”，并负责选择、冲突纠错和草稿策略。工具描述分别提示 session 48 项/8192B 与 hub shared、32 项/4096B、单条 1024B；不新增 dispatcher rate/rejection 门。

### 5.3 容量与持久化验收

- 两种 scoped 存储各自验证正文 1024B 接受、1025B 返回 `E_TOO_LARGE`；该预检在弹框前，故零弹框、零写入。
- session 在字节预算内验证第 48 项接受、第 49 项 `E_FULL`；在项数预算内验证活跃正文合计 8192B 接受，新增后 8193B 在 create 与 update 两条路径均返回 **`E_TOO_LARGE`**。
- hub 在字节预算内验证第 32 项接受、第 33 项 `E_FULL`；在项数预算内验证合计 4096B 接受、新增后 4097B `E_FULL`。不得把 session 与 hub 的边界或错误码互换，也不得为统一名称修改 store/alias。
- 对 `E_PERSIST_UNKNOWN` 注入正文成功、侧车失败和审计失败位置，不得自动重放；第二次调用前必须走现有恢复/检查路径。
- search 命中带当前 rev；随后 update 使旧 rev 的 update/delete 返回 `E_CONFLICT`，project delete 缺 rev 的既有例外不变。

## 6. 分阶段实施与不可回退点

### 6.1 阶段 1：内部单路径、旧门面不变

实施 scoped dispatcher/adapter 和 wire 生命周期归属，各布局的 schema、description、成功文本/JSON、抛错顺序不变；v2/legacy 不接 v4。基础验收直接断言：v3 错误仍抛出且 message 完整；旧 scoped view 缺 storageScope 仍失败；§4.4 每种准入失败的弹框数和存储 diff 都为零；§3.3 的 abort 与 tracker-only 路径分别符合结算语义；三个冻结 fixture 与 off golden 字节不变。

**生产 wire 装配硬门**：必须调用生产 `wireMemoryScopes` + `wireMemory`，从实际工具注册表取出旧 `memory`/`scoped_memory` 后执行，参照 `tests/memory/scopes/child-readonly.test.ts` 的真实 wire + SessionManager 模式。使用真实临时存储与实际 SessionManager，依次发 session、tree、shutdown 事件；只允许 fake ExtensionAPI、确认渠道和时钟，不得 stub dispatcher、owner、store，也不得绕过注册入口直接调用 factory/runInner。

该硬门至少断言：注册表中的工具成功执行 create/view，非法 update 仍走旧错误；tree 后 pending approval 撤权且旧 owner 零提交；shutdown 后工具结果与存储均不再变化；每个事件后 memory/scoped 注册数与 §3.2 谓词一致。另跑 `session=false,hub=true,child=true`，断言 wiring 已建立而 scoped 注册数为 0；用 held、files+auto、secureLocked 输入调用真实 `toolSurfaceFor`，v4Active 必须跟随其返回值而非配置名称。factory surface 的 declared-only 测试不能替代此硬门。

此阶段无数据不可回退点，但不得再新增只修一个门面的平行业务逻辑。

### 6.2 阶段 2：仅实际 v4 surface 发布 v4

发布 v4、聚合 DTO、scoped search 和结构化错误；只有 v4Active=true 的 alias 结果增加 replacement。验收以具体样例为钉子：all 禁用字段零 dispatch；完整 getter-error JSON 与原文一致；replacement 在真实临时会话执行成功；`files`/tiered 的 scoped CRUD 序列通过；ManualClock 区分 timeout、Web false 与 tree abort；session/hub 各自容量边界及错误码准确；child 独立 surface 断言通过且 Agent golden 字节不变；六个新 variant key 与预算逐项吻合。

不可回退点：v4 schema、DTO、错误结构和新增 variant 发布后即是对外契约；不能改写旧 v3 variant 或回收已发布语义。

### 6.3 阶段 3：只退役实际 v4 surface 的别名

最短期限为 **90 天且跨过一个 minor release**，并须用户批准 blocks 工具面的 breaking change。仅当该 activation 的 v4Active=true 时删除 scoped 注册和 replacement 适配；v2/legacy 以及 scopedRegistered=false 的 child 例外均保持谓词原义，不补注册、不误删其他 surface。验收按 §3.2/§4.2 逐格断言 wiring、注册和 surface 结果，并在真实 `files`/tiered 配置重跑 session/hub CRUD；不得使用“旧工具名全局不再注册”作为验收条件。

未来全局删除是独立 breaking-change 项目，必须先给出非 blocks 等价入口或明确能力退役。blocks 别名删除后若需恢复，同样是新的兼容决策。

## 7. 主要风险与取舍

- 误写共享区：默认 project、hub 显式、真人审批、各自容量与现有 rate 门共同限制。
- child 权限被设置覆盖：scopes-on 强制只读优先于 allowWriteInChildSessions，显式 agent/user 都在参数预检拒绝。
- 非 blocks 能力被误删：别名退役按实际 surface 判定，v4Active=false 就不生成 replacement、不进入阶段 3 删除。
- wiring 与注册混淆：child 仅 hub 可建立 wiring，但 scopedRegistered=false，注册表断言必须分开。
- 聚合掩盖故障：三组状态齐全、失败整组省略、partial 显式，普通 getter 异常与 poisoned 分开。
- 撤权语义混淆：tracker-only 不承诺即时结算，owner.dispose/abort 才走 tree teardown 的即时拒绝路径。
- 持久化半状态：保留 `E_PERSIST_UNKNOWN`，禁止自动重试；grant CAS、拒绝审计、多文件事务均不暗增。
