# pi-secure --private：外部扫描毒化（scan poison）修复方案

> **需求摘要**：在 `pi-secure --private` 下，判活与释放共用的 ns 成员扫描 `scanNsMembers` 有一条 fail-closed 规则：只要存在**同 uid、`/proc/<pid>/ns/mnt` 读不到（EACCES/EPERM）、starttime ≥ supervisor.start** 的进程，整次扫描就判 `incomplete`。
> 结果是：用户的 SSH 会话进程（`sshd: user@pts/N`，登录晚于 supervisor，特权分离后 non-dumpable）会让 `run` 判 `unknown/scan-incomplete` 拒绝启动、`release` 拒绝删记录、`status` 显示 `private:unknown`、`lock`/`lock --kill` 拒绝。用户只要从 SSH 登录在操作，这个进程就一直存在，`--private` 也就一直不可用（实测病例：rsi-evo 的记录残留了 5 天）。
> 目标：恢复可用性，同时**不放松「可证明属于本实例的进程都能被看到」**这一 fail-closed 保证。
> 选型：**② 血缘判定（主修，所有 ns 外调用方共用一套证明级别）**；① 不采用（证明见 §5）；④ 已被 ② 包含；③ 逃生口作为可选的第二个包，**是否做待用户拍板**（§9 Q1）。
> 本文是只读调研后的方案，没有改任何代码。

---

## 0. 证据坐标（已在主会话实查，此处只列位置）

| 位置                                                     | 作用                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/secure/bin/helper.mjs:4201-4303` `scanNsMembers`    | 毒化发生在 `if (denied && minStart !== undefined)` 分支（:4256-4271）：同 uid 且读不到的进程只要 `start ≥ minStart` 就 `return incomplete`              |
| `helper.mjs:4366` `judgePrivateInstance`                 | `rec.ns` 存在时，`scan.kind !== "done"` ⇒ `unknown/scan-incomplete`。这一行排在**所有**状态之前，所以 session / orphan / stale 都会被它盖掉             |
| `helper.mjs:4401-4428` `privateInstanceState`            | :4421 发起扫描。调用方：claim（`private.mjs:231`）、`plainMountPrivateGate`（`helper.mjs:3123-3140`）、`vaultInstanceView`（status / lock / freshView） |
| `helper.mjs:4904-4998` `terminateInstance`               | :4925 `collect()` 扫描；不完整 ⇒ 外部收尾放弃（orphan 场景下 `lock` 同样被毒化）                                                                        |
| `src/secure/bin/private.mjs:127-147` `cmdPrivateRelease` | 唯一的删记录入口（I-P3），:134 扫描；`incomplete` ⇒ `REC.INCOMPLETE`                                                                                    |
| `src/secure/bin/finalize.mjs:53-60`                      | P1 在 ns 内收尾时用 `deniedMeans:"outside"`（不受毒化；本方案不改）                                                                                     |
| `docs/dev/data-encryption/plan.md` §5 **R35**            | 已把这个现象登记为「只损失可用性，等无关进程退出后 lock」。这个假设对 SSH 会话不成立：用户本人就在那个会话里                                            |
| `docs/dev/data-encryption/N1-report.md` #1               | 现规则的出处。当时的前提是 sd-pam / sshd 会话「早于 supervisor」，没有覆盖「supervisor 启动后才登录」                                                   |

## 1. 内核前提（新规则的论证基础，须用测试钉住）

`/proc/<pid>/ns/*` 的读取走 `ptrace_may_access(PTRACE_MODE_READ_FSCREDS)`。同 uid 时，如果目标 mm 不可 dump，还要求调用者在 **`mm->user_ns`** 中具备 `CAP_SYS_PTRACE`。下面三条前提由此推出：

- **P-SP1（谱系内可读）**：P0 及所有 ns 外调用方都在初始 userns，且 euid = `ns.user` 的 owner。按 `cap_capable` 的 owner 规则，它们在 `ns.user`、`ns.innerUser` 以及更深的嵌套 userns 中拥有全部能力。本实例谱系内被 fork 或 exec 出来的进程，其 `mm->user_ns` 都落在这个谱系里，因此**即使调用了 `PR_SET_DUMPABLE=0`（如 ssh-agent），P0 仍能读到它的 ns 链接**。N1-report 写的「P0 能读本实例 userns 谱系内所有进程」就是这一点。
- **P-SP2（不可读意味着 mm 在谱系外）**：同 uid 进程读不到的可能（评审 #2 修订）：(a) 它的 mm 在初始 userns 中创建且不可 dump，例如 sshd 特权分离子进程、setuid 程序、sd-pam，它们**不可能经 fork 成为成员**；(b) LSM 拒绝。原列的 (c)「成员 exec 了属主未映射的镜像」经评审核实**不成立**：`mm->user_ns` 在 fork/exec 时取自 creds，谱系内成员的 creds 永远留在 `ns.user` 谱系（exec setuid 到未映射 uid 直接 EPERM 失败；exec root 属主 0711 程序不改 uid），`would_dump` 只清 dumpable、不动 `mm->user_ns`，cap 检查补位 ⇒ (c) 按 P-SP1 仍可读，是空集。真实残存只剩 (b)。
- **P-SP3（世界可读字段）**：`/proc/<pid>/stat` 的 ppid 与 starttime 对 non-dumpable 进程也可读，现有代码 :4260 已经依赖这一点。`/proc/<pid>/status` 的 `Uid:` 同样可读。

成员只有三种来源：① 由成员 fork 产生（会继承 mnt ns）；② 经 setns 加入，必须先进入 `ns.user` 谱系，属于 R21 定向攻击范围；③ 无。没有 pid ns，也没有 subreaper（`helper.mjs:4773`，unshare 未带 `--pid`），所以成员的父进程死后会被收养到 `systemd --user` 或 pid 1。

## 2. 选定规则：血缘判定（lineage）

### 2.1 语义

`scanNsMembers` 新增一个**可选**选项 `lineage: { anchors: [{pid,start}…] }`。不传时行为与现在逐字节相同（finalize 和既有单测都走这条路）。

传了 `lineage`、遇到同 uid、ns 链接 EACCES/EPERM、`start ≥ minStart` 的进程 X 时，不再立即判 `incomplete`，而是先放进 `deferred` 列表；第一遍扫完、拿到全部可读的同 ns 命中集合 `H` 后，再对 X 做血缘判定：

```
walk(X):                         # 最多 64 跳，遵守 deadline，祖先的 stat 读取结果做 memo
  cur = X                        # cur = {pid, start, ppid}，来自 /proc/<pid>/stat（世界可读）
  loop:
    if cur 与某个 anchor 的 pid+start 相同   → IN   （记录身份 supervisor/gocryptfs/pi 的后代）
    if cur.pid ∈ H                         → IN   （可读的 ns 成员的后代；只比 pid，误差偏向 IN）
    if cur.start < minStart                → OUT  （链上出现早于 supervisor 的祖先 ⇒ 链没有经过 P1）
    if cur.ppid < 2                        → OUT  （到达 pid 1 / 0）
    p = stat(cur.ppid)
      ENOENT/ESRCH（祖先在遍历中途退出）    → 从 X 重走一次；重走时若 X 自身已 GONE ⇒ OUT（X 已死不持有挂载，与主循环 GONE_CODES 语义一致——评审 #3 钉死，配测试）；第二次祖先仍 ENOENT → INCOMPLETE("lineage race")
      其他错误 / 无法解析                    → INCOMPLETE("lineage <pid> <code>")
      p.start > cur.start（pid 被复用）      → 同上，重走一次，否则 INCOMPLETE
    cur = p
  超过 64 跳                               → INCOMPLETE("lineage depth")
```

- `IN` ⇒ 整次扫描 `incomplete`，reason 为 `ns <pid> <comm> <code> in-lineage`。按 P-SP1，谱系内的进程本应可读；读不到只能是 P-SP2 的 (b) 或 (c)，所以保持严格。
- `OUT` ⇒ 跳过，放进返回值的 `outside: [{pid, comm}]`，只作诊断。**只在非空时才带这个字段**，这样既有的 `toEqual({kind:"done", members})` 断言保持不变。
- 没有 `minStart`（记录没有 supervisor 字段）⇒ 与现在一样判 `incomplete`。
- 祖先的 Z（僵尸）态不特殊处理：stat 对 Z 仍有效、ppid 可用，直接穿过（评审 #4）；X 自身若为 Z，主循环的链接读 ENOENT 已按 GONE 跳过，到不了血缘判定。
- memo 记 `{start, ppid}`（评审 #5）：以 pid 为键复用上溯结果；声明假设「单次扫描（≤2s 窗口）内 pid 不复用」——复用需同 uid 定向 fork-bomb 撞 pid，在 R21 威胁模型外。
- 其他规则全部不动：他 uid 被拒绝 ⇒ 跳过；`start < minStart` ⇒ 跳过（这一步在血缘判定之前）；X 自身的 stat 读不到 ⇒ `incomplete`；status / 链接 / ns/user 出现 EIO 等其他错误 ⇒ `incomplete`；超过 `SCAN_MAX_ENTRIES`、超时 ⇒ `incomplete`。

病例验证：`sshd: bluecake@pts/0`（不可读，start ≥ minStart）→ `sshd: bluecake [priv]`（root，可读 stat）→ `sshd` 监听进程（开机启动，`start < minStart`）⇒ `OUT`，扫描为 `done`，ns 无成员，租约空闲 ⇒ `stale`，记录可以释放。测试 #69 里提到的「并发套件的 setuid fusermount3」也会因为链走到 vitest 进程而判 `OUT`。

### 2.2 每个调用方的证明级别（统一）

所有 **ns 外**调用方使用同一级别：「严格 + 血缘」。这样「judge 判 stale」与「release 能删」由同一条规则决定，不会出现 judge 判 stale、release 却报 incomplete 的错位。

| 调用方                           | 坐标                                         | 改动                                                                                               | 证明级别    |
| -------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------- |
| run 启动前判定（claim）          | `private.mjs:231` → `privateInstanceState`   | 经 `privateInstanceState` 自动生效                                                                 | 严格 + 血缘 |
| 普通挂载门（unlock / `__mount`） | `helper.mjs:3128`                            | 同上                                                                                               | 严格 + 血缘 |
| status / lock 视图               | `vaultInstanceView` → `privateInstanceState` | 同上；**status 文案不改**                                                                          | 严格 + 血缘 |
| `privateInstanceState` 本体      | `helper.mjs:4421`                            | 传 `lineage: { anchors: recordAnchors(rec) }`                                                      | —           |
| 外部终止 `terminateInstance`     | `helper.mjs:4925`                            | 传 `lineage`。终止目标仍然只来自可读且通过 `memberAuthorized` 的成员；`OUT` 的进程**永远不是目标** | 严格 + 血缘 |
| 释放（唯一删除者）               | `private.mjs:134`                            | 传 `lineage`                                                                                       | 严格 + 血缘 |
| P0 跑完后释放（§3.6）            | `releaseRecord` → `__private-release`        | 经上一行生效                                                                                       | 严格 + 血缘 |
| P1 在 ns 内收尾                  | `finalize.mjs:55`                            | **不改**（仍是 `deniedMeans:"outside"`）                                                           | 不变        |

`inNsDone` 不参与任何删除判定（§5 ①）。

## 3. fail-closed 论证：剩下哪些情况「无法证明」，为什么可以接受

新规则下会被**跳过、因而可能漏判**的进程，只有「同 uid、不可读、start ≥ supervisor.start、且 ppid 链上找不到 anchor 或可读成员」这一类。按 P-SP2，它们可以分成三组：

1. **(a) 谱系外的 non-dumpable 进程**（sshd 会话、setuid 辅助程序、sd-pam……）：按 P-SP1/P-SP2 不可能是成员，跳过是**正确的**。这正是本次修复的对象。
2. **R21 setns 定向加入者**：本来就在既定边界之外（private-plan §5.1 固定措辞：「不防同 uid 定向进程」）。而且 start 早于 supervisor 的加入者本来就会被跳过，现规则也不防这一类。
3. **新残留 R37**（评审 #2 收窄）：谱系内的成员被 **LSM 拒绝**读取（P-SP2 b），**并且**它的 ppid 链已经断了（父链全部死亡后被 init 或 subreaper 收养）。只要链还在，规则判 `IN`，扫描保持 `incomplete`；只有链断了才会被当成 `OUT`。（原 (c)「exec 不可读镜像」路径经评审核实为空集，见 §1 P-SP2。）

为什么 R37 可以接受：

- 释放时**租约已经空闲**（释放协议第 1 步：真的拿到了 flock），也就证明 gocryptfs 已退出、FUSE 连接已断。这样的进程再也无法经挂载读到明文，最多保留它进程内已有的内存副本。
- 即使保留记录，工具对这种进程也**没有任何处置能力**。终止权（I-P4′）要求读到 mnt/user ns，`signalVerified` 要复验 ns，所以读不到的进程永远不会被发信号。现规则下保留记录只会造成「`unknown`、拒绝一切挂载、只能重启」，并不能多保护什么。
- 对照现状：同样是链断的**可读**孤儿成员，现规则会把它计入成员（判 `ns-in-use`）。新规则对可读孤儿完全不变（可读 ⇒ 链接匹配 ⇒ 计为成员），只放开「读不到、链也断了」这一小块。

一句话：新规则只放过 ppid 链上找不到本实例 anchor 或成员、且读不到 ns 链接的进程。按 userns 属主规则，P0 读得到本实例谱系内的任何进程；这类进程读不到，说明它的 mm 不在谱系里。剩下的边角（链断后 exec 了不可读镜像的成员）在租约已证明 gocryptfs 已死时无法再访问明文，而且工具本来就不可能终止它。

## 4. 与 ④ 的关系

④（「晚于 supervisor 但可证明不属于 vault 进程树就排除」）就是 §2 在只看 starttime 和 ppid 时的弱化版。§2 已经给出了「可证明不属于」的精确定义（链上没有 anchor 或成员，且以早于 supervisor 的祖先或 pid 1 结束），所以不再单独实现 ④。

## 5. ① 与 ③ 的评估

### ① release 捷径（inNsDone ∧ supervisor 死 ∧ 租约空闲 ⇒ 不要求完整的外部扫描）—— **不采用**

- **证明强度**：`inNsDone:true` 只在 finalize 的 verify 扫描为空、gocryptfs 已退出时写入（`finalize.mjs` 第 5 步）。D 状态残留（R19）在 verify 时仍会被看见 ⇒ `pending` ⇒ `inNsDone:false`，所以 ① 不会把 R19 场景放过去。supervisor 被 SIGKILL 时 `inNsDone` 根本写不出来，所以 ① 也不削弱「supervisor 被杀、成员残留」场景的防护。
- **但它没有增加任何覆盖**：P1 的 verify 扫描用的是 `deniedMeans:"outside"`，对 P-SP2 (b)(c) 类进程同样看不见。也就是说，`inNsDone` 证明的东西 ⊆ §2 在 ns 外能证明的东西，外加一个时间点（finalize 之后到释放之间的 setns 加入者它看不到，§2 看得到可读的那部分）。
- **它只修 release 一个入口**：session 期间的 `status` / `lock --kill`、orphan 的外部收尾、claim 照样会被毒化。
- 它还会给 I-P3 增加第二条删除判据，扩大删除面。结论：多余，而且面更大。

### ③ 逃生口 —— **可选包 B，待用户拍板（§9 Q1）**

采用 § 2 之后，仍然会长期卡住的只剩：谱系内持续存在的不可读进程（P-SP2 b/c，链没断，说明它还活在会话树里，退出后自动解除）；`/proc` 条目超过 `SCAN_MAX_ENTRIES=4096` 的大主机（§8 风险 R-b）；`ns-in-use`（可读但链断的孤儿，已有指引：人工 kill 后 `lock`）。所以 ③ 的价值从「主修」降为「极端兜底」。如果要做，设计如下：

- 命令面：`pi-secure lock <name> --forget-record`。USAGE 新增一行，Q9 允许；launcher-off-golden 刻意排除了 USAGE 场景，所以 **A′ golden 不受影响**。
- 前置条件（任一不满足 ⇒ 76，不删）：不在 ns 内；状态 ∈ {`unknown` 且 reason=`scan-incomplete`, `ns-in-use`}；bootId 与当前一致；supervisor、gocryptfs、pi 三者的 `identityState` 都为 `"dead"`（`unknown` 不算）；stdin 是 TTY；用户逐字输入库名确认。
- 确认前打印证据：piExit、inNsDone、三个身份已死、租约空闲、扫描 reason 或未证明 pid 列表、提示「等同重启后的记录状态」。
- 执行：走与 `releaseRecord` 相同的 `flock lease → flock mount.lock → __private-release <name> <id> --forget`。新增的分支会在锁内**再验证一次**：instanceId 一致；三个身份已死；如果扫描为 done 且 `verified > 0` ⇒ 拒绝（这些成员可以用 `lock` 正常收尾），其余情况删除。
- 回写 I-P3：新增「例外 2（用户显式确认）」。

---

## 6. 实施步骤（包 A，L2：动安全判定，需要 verifier 与安全复审）

### 6.1 `src/secure/bin/helper.mjs`

1. **新增 `export function recordAnchors(rec)`**，放在 `memberAuthorized` 附近（约 :4314），返回 `["supervisor","gocryptfs","pi"].map(k => rec?.[k]).filter(Boolean)`。`memberAuthorized` 内 :4319 的 `anchors` 改为调用它（纯重构，行为不变）。
2. **新增 `export async function lineageVerdict(x, { anchors, hitPids, minStart, procRoot, fsImpl, deadline, maxHops = 64 })`**，返回 `{kind:"in", via} | {kind:"out"} | {kind:"incomplete", reason}`。它按 §2.1 的伪代码实现：祖先的 stat 用 `fsImpl.readFile(path.join(procRoot, pid, "stat"))` 读并 memo（Map），遇到 race 只重走一次，每一跳检查 deadline，超时返回 `incomplete("timeout")`。
3. **`scanNsMembers`**（:4201-4303）：
   - 选项新增 `lineage`（默认 `undefined`）。
   - :4256 分支：`if (denied && minStart !== undefined)` 中，`pst.start < minStart ⇒ continue` 保持不变；接下来如果 `lineage` 存在，就把 `{pid, start: pst.start, ppid: pst.ppid, comm}` 推进 `deferred` 并 `continue`；`lineage` 不存在时维持现在的 `return incomplete`。
   - 第一遍循环结束后，`hits` 收齐，进入第 1.5 步：`hitPids = new Set(hits)`。对每个 `deferred` 调用 `lineageVerdict`：`in` ⇒ `return { kind:"incomplete", reason:\`ns ${pid} ${comm} ${code} in-lineage\` }`；`incomplete` ⇒ 原样返回；`out`⇒ 推进`outside`。
   - 末尾返回 `{ kind:"done", members, ...(outside.length ? { outside } : {}) }`。
   - 改写 docblock 和 :4257-4259 的行内注释：写明 P-SP1/P-SP2/R37，并说明 `lineage` 只给 ns 外的权威调用方使用。
4. **`privateInstanceState`** :4421：在 `scanNsMembers(rec.ns.mnt, {…, minStart, lineage: { anchors: recordAnchors(rec) } })` 中加入 `lineage`。另外新增可选的测试接缝 `fsImpl`，透传给 scan，方便用假 `/proc` 注入 EACCES。现有的 `readFile` 接缝只覆盖身份读取。
5. **`terminateInstance`** :4925：`collect()` 内的扫描加上 `lineage: { anchors: recordAnchors(rec) }`。
6. 渲染（`renderPrivateStatus`）、判定（`judgePrivateInstance`）、`lockPrivateDecision` **都不改**。

### 6.2 `src/secure/bin/private.mjs`

7. `cmdPrivateRelease` :134：扫描选项加 `lineage: { anchors: recordAnchors(rec) }`，并在 import 列表里加上 `recordAnchors`。成功路径的 JSON 不变；`incomplete` 时 `out` 的 reason 自然带上 `in-lineage`。

### 6.3 `src/secure/bin/finalize.mjs`

8. 不改。在 §9 Q3 里记一个后续项：finalize 也可以对谱系内不可读的进程改用严格判定，让 P-SP2 c 类在 ns 内就以 `pending` 的形式暴露出来。

### 6.4 文档回写

9. `docs/dev/data-encryption/private-plan.md`：
   - §3.3「ns 标识复用的约束」后新增一条 **「r3.2 不可读进程的血缘判定（scan-poison 修复）」**：写入 P-SP1–P-SP3、§2.1 规则和 §2.2 表（所有 ns 外调用方同一级别；finalize 不变）。stale 判定一句里「扫描完整」的定义改为「严格 + 血缘」。
   - §3.2 I-P3 的「ns 扫描为空（完整）」后加注：完整的定义见 §3.3 r3.2。如果做了包 B，再加「例外 2」。
   - §5.4 残留表新增 **R37**（评审 #2 收窄后：谱系内成员被 LSM 拒绝读取、且 ppid 链已断 ⇒ 释放时可能被跳过；租约空闲 ⇒ gocryptfs 已死、无法再经挂载读到明文；工具本来就无法终止它）。
   - 文末新增「§R3 scan-poison 处置」小节：说明毒化病例、选型和 ① 不采用的理由。
10. `docs/dev/data-encryption/plan.md` §5 **R35**：把「会话期间新启动的同 uid 非 dumpable 进程……扫描判不完整」一句改为「r3.2 起按血缘判定，谱系外的进程（新登录的 ssh 会话、setuid 辅助程序）不再影响扫描；只有谱系内读不到的进程仍然判不完整」。缓解列同步修改。
11. `docs/dev/data-encryption/N1-report.md` 不改历史，只在 private-plan §R3 里引用。`AGENTS.md` 表格不改（secure 行已经指向 data-encryption README）。
12. `docs/dev/data-encryption/README.md` 中描述 private mode 扫描的句子，补一句「unreadable same-uid processes are judged by ppid lineage (§3.3 r3.2)」。

### 6.5 测试

**有意反转的既有断言（只有 1 处）**

| 文件:行                                                                           | 现断言                                                                               | 新断言                                                                                                                                   | 理由                                                                                                                                                            |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/secure/launcher-private-unit.test.ts:367-393`（real，python `prctl(4,0)`） | 新于 supervisor 的 non-dumpable holder ⇒ `releaseRecord` 返回 `incomplete`、记录保留 | 改名为「…OUTSIDE the vault lineage（sshd-session case）⇒ skipped, released」：断言 `kind:"released"`、记录已删除。前提断言（EACCES）保留 | 这个 holder 的链是 holder → vitest worker（start = SUP.start，不是 anchor，链接 ≠ `mnt:[1]`）→ vitest main（`start < minStart`）⇒ `OUT`。这就是本病例的单测复现 |

**不变但需要确认的**：:505-575 `scanNsMembers` 单测都没有传 `lineage`，走旧路径，所有断言不变；:549-551 `deniedMeans: "outside"` 计数 `[0,0,1]` 不变；:543-547「释放路径不含 deniedMeans」不变；:562-567 judge 对 incomplete ⇒ unknown 不变；`launcher-private-cmd.test.ts:955-985` 的重试循环行为不受影响（毒化消失后通常第一次就成功），只需把 :961-964 的注释改成「血缘规则后仅谱系内不可读才会出现」。

**新增**（`tests/secure/launcher-private-unit.test.ts`）：

- `describe("scanNsMembers lineage (scan-poison)")`，用 fakeProc + faultyFs，所有调用都带 `lineage`、`minStart:100`：
  1. sshd 链：X（同 uid，链接 EACCES，start 150，ppid 31）→ 31（uid 0，start 150，ppid 30）→ 30（start 10）⇒ `done`，`outside` 含 X，members 不变。
  2. X 的 ppid 是可读成员 20（mnt:[7]）⇒ `incomplete`，匹配 `/in-lineage/`。
  3. X 的 ppid 命中 anchor pi（pid+start 一致；fakeProc 里 pi 本身可以没有 ns 链接）⇒ `incomplete`。
  4. anchor 的 pid 相同但 start 不同（pid 被复用）⇒ 继续往上走 ⇒ `out`。
  5. X 的 ppid=1（孤儿）⇒ `out`。测试名标注「accepted residual R37」。
  6. 祖先 stat EIO ⇒ `incomplete`；祖先 ENOENT（race）两次 ⇒ `incomplete`；`parent.start > child.start` ⇒ `incomplete`；race 重走时 X 自身已 GONE ⇒ OUT 且不进 `outside`（进程已死，无需诊断——评审 #3）。
  7. 环或深度 > 64（构造 ppid 环）⇒ `incomplete`。
  8. X 自身的链接 EIO ⇒ 带 `lineage` 也判 `incomplete`；他 uid 被拒绝 ⇒ 跳过；没有 `minStart` + `lineage` ⇒ `incomplete`。
  9. `deadline` 在遍历途中到期 ⇒ `incomplete` timeout。
  10. 结构断言（评审 #6：数更具体的串，避免 docblock 注释误红）：`lineage: { anchors: recordAnchors(` 在 HELPER_SRC 中恰好出现 2 次（privateInstanceState、terminateInstance），在 PRIVATE_SRC 中 1 次（cmdPrivateRelease），在 FINALIZE_SRC 中 0 次。
- `privateInstanceState` + sessionFixture（:792）加一个谱系外不可读进程（经新增的 `fsImpl` 接缝注入 EACCES）：supervisor 活 ⇒ `session`（以前是 `unknown`），`lockPrivateDecision(kill)` ⇒ `kill`。gocryptfs 死、租约空闲、无成员 ⇒ `stale`。同一进程改挂在 pi 下 ⇒ `unknown/scan-incomplete`。
- `terminateInstance` orphan 场景：谱系外不可读进程不影响对已验证成员发信号（kill spy 被调用），且不可读进程从不被 kill；谱系内不可读 ⇒ `ok:false, killed:[]`。
- **real 新增**（skipIf 没有 python3）：
  - 记录 `pi = {pid: process.pid, start: worker start}`，non-dumpable holder 是 worker 的子进程 ⇒ `releaseRecord` 返回 `incomplete`，reason 匹配 `in-lineage`，记录保留。这替代了被反转那条用例原来承担的「严格」覆盖。
  - **P-SP1 前提钉子**（skipIf 不支持 unprivileged userns，探测方法沿用 `privatePreflight`）：`unshare --user --map-root-user python3 -c 'prctl(4,0); sleep'`，断言本进程**能** `readlink /proc/<pid>/ns/mnt`。如果内核改了这条语义，测试会变红，提醒血缘论证失效。同时断言 `readFileSync("/proc/1/stat")` 可读（评审 #1：hidepid≥1 的加固部署下跨 uid 读 stat 会 EACCES，本修复在该类机器上不生效——测试红时明确标注「该机器不受益」而非静默）。
- e2e（`tests/secure/launcher-private-cmd.test.ts`，Tier 2）：可选。很难造出「supervisor 之后启动的非 dumpable 谱系外进程」；fusermount3 setuid 的并发场景已由上面的 real 用例覆盖，不强制。

### 6.6 冻结面检查

- `tests/fixtures/secure-contract-parity.json`（A）：只钉 settings / mountinfo / hubSafeEnv / privateRecord 的解析结果，**不涉及**扫描或判定文案 ⇒ 不受影响。
- `tests/fixtures/secure-launcher-off-golden.json`（A′）：全部是无私有记录的 off 场景（status/unlock/lock/init/run 的 fake/real），不涉及 private 状态；USAGE 场景被刻意排除 ⇒ 包 A、包 B 都不受影响。
- `secure-off-golden.json`：插件侧，无关。
- 验收：`git diff --quiet origin/dev -- tests/fixtures/`。

## 7. 门禁

`npm run format:check && npm run typecheck && npx vitest run tests/secure && npm test`。真机验收（acceptance J 节新增一条）：在 SSH 会话里执行 `pi-secure run <v> --private`，在 pi 运行期间**再开一个 SSH 登录**，然后依次检查：`status` 显示 `private`（不是 `unknown`）；`lock --kill` 成功；pi 正常退出后记录被删除、P0 的退出码 = piExit；在第二个登录仍在线时立即再次 `run --private` 能启动。另外用 rsi-evo 的残留记录做回归：升级后 `pi-secure status rsi-evo` ⇒ `stale-record`，`pi-secure lock rsi-evo` ⇒ 0「清理了失效的 --private 记录」。

## 8. 风险与回滚

| #              | 风险                                                                                                                                         | 缓解                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-a（最大）    | **P-SP1 的内核语义前提不成立**（某些内核或 LSM 配置下，谱系内的成员对 P0 也读不到），且成员已成孤儿 ⇒ 被误判为 `OUT`，记录在成员仍存在时被删 | 用 real 前提测试钉住 P-SP1；即使误判，释放仍以「真正拿到租约」为前提（gocryptfs 已死、FUSE 已断），损失上限是 R37（进程内存中残留的明文，且工具本来就无法终止它）。链没断时仍判 `IN`（严格） |
| R-b            | `SCAN_MAX_ENTRIES=4096` 统计的是**全部用户**的 /proc 条目，大主机上会永久 `incomplete`（另一种毒化，本包不修）                               | 记为后续项（§9 Q2）：提高上限，并只对同 uid 进程读链接以压缩耗时                                                                                                                             |
| R-c            | 血缘遍历增加 stat 读取：每个不可读进程最多 64 次，有 memo；2 s 扫描预算下大量 non-dumpable 进程可能导致超时 ⇒ `incomplete`（安全方向）       | memo 让共享祖先只读一次；典型主机上不可读的同 uid 进程个位数，链长 ≤5                                                                                                                        |
| R-d            | 兄弟进程 TOCTOU：扫描与删除之间新出现的成员只能由现存成员 fork 出来；新规则下现存成员要么可读（计入），要么在链中（`IN`），要么属于 R37      | 与现规则同级别；删除时仍持有租约和 mount.lock                                                                                                                                                |
| R-e            | 文案或原因字符串变化（`in-lineage` 后缀）                                                                                                    | 没有 golden 钉住；`launcher-private-cmd` 只匹配 `scan-incomplete` 判定原因，不变                                                                                                             |
| R-f（评审 #1） | **hidepid≥1 的加固 /proc**：血缘上溯第一次要读 root 祖先（sshd [priv]/监听进程）的 stat，跨 uid 读被拒 ⇒ 重走失败 ⇒ 仍判 `incomplete`        | 方向 fail-closed 没错，但修复目标在这类机器上 silently 不达成——P-SP1 前提钉子测试附带 `/proc/1/stat` 可读断言，失败即明确标注「该机器不受益」                                                |

**回滚**：`lineage` 是 opt-in 选项。删掉三处调用点的 `lineage:`（helper ×2、private ×1），行为就逐字节回到现状；或者直接 `git revert` 包 A 的提交。不涉及记录格式、wire、设置键，也没有数据迁移；已经被正确释放的记录不需要回滚。

## 9. 待决问题（需主会话或用户拍板）

- **Q1 包 B（③ `lock --forget-record`）做不做**：✅ 2026-10-29 用户拍板 **先只做 A**（采纳推荐）。
- **Q2 R-b（4096 上限）**：✅ 2026-10-29 主会话按推荐裁定**单独立项**（todo #101）。
- **Q3 finalize 是否对齐血缘规则**（P1 内对谱系内不可读的进程判 `pending` 而不是跳过）：✅ 2026-10-29 主会话按推荐裁定**延后**（纵深加固，随包 B 一并评估）。

---

## 10. 评审修订记录（2026-10-29，reviewer kimi-k3-256k r_BCVK7VBG：有条件通过）

- #1（Major）：hidepid≥1 盲区登记为 §8 R-f；P-SP1 前提钉子附带 `/proc/1/stat` 可读断言（失败标注「该机器不受益」）。
- #2（Minor）：P-SP2 (c) 机制描述纠错（`mm->user_ns` 取自 creds，(c) 是空集），R37 收窄为「LSM 拒绝 + 链断」。
- #3（Minor）：race 重走时 X 自身 GONE ⇒ OUT（与主循环 GONE 语义一致），钉死并配测试（§6.5 新增 6 尾部）。
- #4（Nit）：Z 态祖先不特殊处理（§2.1 写明）。#5（Nit）：memo 记 `{start,ppid}` 并声明扫描窗口内 pid 不复用。#6（Nit）：结构断言改数 `lineage: { anchors: recordAnchors(`。
