# AL1 报告：hub 别名绑定表（alias-plan r4 §3）

纯 hub 模块，没有接线（接线属于 AL2）。没有改 router/members/broadcast/hub.ts/main.ts/audit.ts，没有 import `src/fabric/**`（boundary 测试通过）。

## 改动文件

- `src/web-hub/hub/xs/aliases.ts`（新）
- `tests/web-hub/hub/xs-aliases.test.ts`（新，63 个用例）
- `tests/web-hub/hub/xs-aliases.property.test.ts`（新，fast-check 200 轮 × 5–60 步）

## 导出 API（供 AL2 使用）

hub 不能 import `src/fabric/xs/types-alias.ts`，所以记录、结果、端口类型在本模块里**按结构重新声明**，形状与 `XsAliasStorePort` 一致。另外多了 `resolveQuery`、`touchPresence`、`close`、`inspect` 四个方法；`status()` 是原有类型的超集。

```ts
// 常量
XS_ALIAS_FILE = "xs-aliases.json"; XS_ALIAS_MAX_RECORDS = 256; XS_ALIAS_MAX_FILE_BYTES = 65536;
XS_ALIAS_MAX_TOMBSTONES = 256; XS_ALIAS_TOMBSTONE_TTL_MS = 30d; XS_ALIAS_QUEUE_MAX = 4;
XS_ALIAS_TXN_BUDGET_MS = 4000; XS_ALIAS_WRITE_STEP_MS = 2000; XS_ALIAS_RENAME_WAIT_MS = 1000;
XS_ALIAS_WEDGE_DISABLE_MS = 60000; XS_ALIAS_ZOMBIE_MAX = 2; XS_ALIAS_LOAD_BUDGET_MS = 2000;
XS_ALIAS_TOKENS_MAX = 32; XS_ALIAS_TOKEN_TTL_MS = 5min; XS_ALIAS_CWD_LABEL_MAX = 120;
XS_ALIAS_DEFAULT_PARAMS = { offlineLeaseH: 168, coolMin: 10, takeMinOfflineMin: 10 }

// 纯函数
resolveXsAliasHubParams(raw: unknown): XsAliasHubParams        // 逐项钳制：1–720 / 1–1440 / 10–1440；缺失或非法 ⇒ 用默认值（缺失永远不表示关闭）
isAliasShaped(query: string): boolean                           // §5.1 degraded 守卫：normalizeAlias(q,{stripAt:false}).ok
xsAliasFailureWire(f): { code: string; effect: "none"|"unknown" } // "E_XS_ALIAS_TAKEN{confusable}"；只有 UNKNOWN 是 unknown
sanitizeAliasCwdLabel(s): string                                // 去掉 \p{C}，最多 120 个码点
xsAliasFilePath(stateDir): string
createXsAliasFs(): XsAliasFs                                    // 默认 node fs 实现

// 工厂
createXsAliasStore(deps: {
  stateDir: string;
  params?: Partial<XsAliasHubParams>;            // HubConfig.crossSession.alias 原值，在这里钳制
  isOnline(sessionId): boolean;                  // 读时在场：members.effectiveAll() 中存在该 sid 的成员
  isRequesterLive(r: XsAliasRequester): boolean; // rename 前复核：同 sid/epoch 仍是有效成员（agentKey 由 AL2 在闭包里用）
  fs?: XsAliasFs; now?: () => number; timer?: XsAliasTimer; randomHex?: (bytes) => string;
  log?: { warn(msg, data?) };
}): XsAliasStore

interface XsAliasStore {
  readonly advertised: boolean;                  // load 前为 false；之后整个运行期固定（= 首次加载结果为 ready）
  load(): Promise<{state:"ready";records;fresh} | {state:"degraded";reason:"corrupt"|"unreadable"|"timeout"}>; // 幂等、不抛错
  status(): XsAliasStoreStatus;                  // state/degradedReason/disabledReason/path/advertised/records/held/cooling/tombstones/tokens/queue/zombies
  lookup(canonical): Readonly<XsAliasRecord> | undefined;      // held，或未过期的 cooling
  resolveQuery(q): {kind:"miss"} | {kind:"hit"; record};       // §5.1 第 3 层：不剥 @；miss ⇒ 进入名字层
  heldBy(sessionId): string | undefined;                       // rows/target/from 盖章用
  get(r): XsAliasStateWire;                                    // {alias?, state, lost?}；lost 不消耗，由 agent 按 (sid, at) 去重
  set(r, rawAlias, cwdLabel): Promise<XsAliasWriteResult>;     // 剥一个 @；cwdLabel 由 AL2 传入（abbreviateHome 之后的值）
  clear(r): Promise<XsAliasWriteResult>;
  takePreview(r, rawAlias): XsAliasPreviewResult;              // 同步；计入 listPerMin 由 AL2 负责
  take(r, rawAlias, token, cwdLabel): Promise<XsAliasWriteResult>; // 一进来就摘除 token
  touchPresence(sessionId): void;                // 由 AL2 在 members observer 的 onMember/onSession/onInvalidate **之后**调用
  close(): void;                                 // hub dispose
  inspect(): { records; tombstones; seq };       // 测试/诊断
}
```

**AL2 接线须知**

1. hub 启动时，在 router 开始接收请求之前 `await store.load()`。之后仅当 `store.advertised` 为真时，在两个 cap 面上声明 `xs.alias.v1`。
2. `aliasUsable(self) = store.advertised ∧ self caps ∋ xs.alias.v1`。degraded 时 store 的读接口一律返回空或 miss，守卫逻辑由 router 用 `isAliasShaped` 自己实现（⇒ `E_XS_ALIAS_UNAVAILABLE`）。`advertised` 为假时 `op:"alias"` 应在 router 层直接拒绝；store 本身对写返回 `BUSY{io}`、对 get 返回 `{state:"none"}`，只作兜底。
3. `resolveQuery` 命中 cooling 记录 ⇒ router 返回 NO_TARGET，不往下找（NQ2）；只有 held 且持有者在可见池中才算命中。
4. 错误回包：`const {code, effect} = xsAliasFailureWire(failure)`。

## 状态机与 IO 设计要点

- **单写者（I6）**：记录和墓碑只在 set/clear/take 事务里修改。在场状态 `Map<sid,{online,offlineSince}>` 只存内存，只给 held 的 sid 建条目。读时调用 `isOnline(sid)`：在线 ⇒ 记为 online；表里记着在线、实际已不在（或没有条目）⇒ 补记 `offlineSince = now`（偏向持有者）。过期（`> lease`）、可抢（`≥ takeMin`）、`coolingLive` 都是读时谓词，没有任何后台定时器。`load()` 时所有 held 的 sid 记为 `offlineSince = loadAt`（R8）。
- **转移表 §3.2**：先 normalize；R 属于 S（held 或 coolingLive）⇒ reclaim；R 为 held(H≠S)：过期 ⇒ 就地转移，写 Tombstone(H, expired)，不留冷却；否则 ⇒ `TAKEN{taken}`；R 为 coolingLive(H≠S) ⇒ `taken`；其余 ⇒ 新建。新建和过期转移会检查骨架（对方的 held ∪ coolingLive 撞骨架 ⇒ `TAKEN{confusable}`，不回显）；容量只在新建时检查（满 256 ⇒ FULL）。**共同步骤 G**：S 名下除 x 以外的 held 转为 cooling(S)，然后删除 S 名下与 x 同骨架的记录（包括刚转成 cooling 的那条，对应 §2.2「同会话改同骨架名直接删旧」）。set/clear 时清掉 S 的墓碑。过期的 cooling 和超过 30 天的墓碑只在下一次写事务里顺带删除。无实际变化的 set/clear（例如同一 label 重复 set）**不落盘**。
- **rev**：用全表单调序列 `seq`（落盘），每次修改取 `++seq`。删除后重建的记录也不会撞旧 rev，token 不存在 ABA。
- **事务管线**（物理上一次只跑一个）：
  1. 准入：store 不是 `ready` ⇒ `BUSY{io}`；已有在跑的事务且等待队列已有 4 个 ⇒ `BUSY{queue}`。每个等待者有自己的 4s 定时器（unref，出队时取消）。
  2. 出队时检查剩余预算，不足以容纳 1s 的 rename 窗口 ⇒ `BUSY{queue}`（不做 IO）。然后用**当前**表和当前在场算出新表（克隆 + 差量）。
  3. 写临时文件 `xs-aliases.json.<8hex>.tmp`（O_EXCL|O_NOFOLLOW 0600 + fsync；本进程内用 Set 保证不复用；随机源异常时有界失败 ⇒ busy）。上限 = min(2s, 剩余预算 − 1s)。超时 ⇒ zombie +1，晚到的结果被忽略，等它结束后再删临时文件；累计 zombie > 2 ⇒ `disabled{zombie}`。写失败 ⇒ 删临时文件，返回 `BUSY{io}`。
  4. rename 前复核：store 仍是 ready、全表 gen 未变、请求方仍有效、目标记录 rev 未变、op 自身的条件（过期转移：持有者仍离线且仍过期；take：持有者、rev、offlineSince 都与 token 一致且仍可抢），以及剩余预算 ≥ 1s。任一项不满足 ⇒ 删临时文件；take 返回 `TAKE{stale}`，过期转移返回 `TAKEN{taken}`，其余返回 `BUSY{io}`。
  5. rename：1s 内成功 ⇒ commit（替换内存表、重建 held 索引、给新持有者记在线，目录 fsync 尽力而为且同一时刻只有一个）；1s 内失败 ⇒ 内存不变，返回 `BUSY{io}`；1s 未结束 ⇒ 返回 `E_XS_ALIAS_UNKNOWN`，进入 `wedged`。wedged 期间写一律 busy，读继续用旧表；rename 最终成功 ⇒ 补做 commit，失败 ⇒ 内存不变，两种情况都回到 ready。`wedged` 超过 60s ⇒ `disabled{wedge-timeout}`。这一步在读时判定（status 或准入时），不用定时器；之后 rename 即使成功也会补做 commit，让内存与磁盘一致，但状态保持 disabled。
- **加载三态**：有界读取（O_NOFOLLOW|O_NONBLOCK，fstat 不是普通文件 ⇒ 不可读，超过 64 KiB ⇒ 损坏），预算 2s。文件不存在 ⇒ ready 空表，不创建文件；严格 v1 schema 不合法、违反 I1/I2、UTF-8 非法 ⇒ `degraded{corrupt}`；EACCES、符号链接、目录 ⇒ `degraded{unreadable}`；超时 ⇒ `degraded{timeout}`，晚到的读取结果被忽略。degraded 状态下**一个字节都不写**（不改名、不覆盖、不建临时文件、不生成 `.bak`），所以下次启动仍是 degraded。加载时用当前骨架表重算 skeleton，变化只写日志（§2.2 允许历史冲突存在）。
- **token**：`k` + 16 位十六进制，绑定 (请求方 sid, alias, 持有者 sid, rev, offlineSince)，有效期 5 分钟，最多 32 个。满了且没有可清理的过期 token ⇒ `BUSY{tokens}`，不淘汰。`take()` 进入的第一步就把 token 从表里删掉，之后无论 INVALID、stale、busy、IO 失败还是 UNKNOWN 都算已消耗。token 只存在内存，重启即失效。preview 只返回 `{cwdLabel(已清洗), offlineForS, token, expiresAt}`。
- **定时器**：只有事务预算定时器（默认实现 `setTimeout` + `unref`，结束即取消）；时钟和定时器工厂都可注入。

## 测试清单

`xs-aliases.test.ts`：

- 纯函数：参数钳制（NQ1 下限 10）、错误码线上形式、`isAliasShaped` 不剥 @、cwdLabel 清洗。
- 加载：文件不存在 ⇒ ready 且不建文件；load 之前写操作 busy；7 种损坏（坏 JSON、版本号、I1、I2、held 带 coolUntil、超过 64 KiB、非法 UTF-8）⇒ degraded、不声明 cap、写和预览都 busy、读为空、**重启后仍 degraded、磁盘字节对象不变、没有 .bak 和临时文件、只有 read 操作**；EACCES ⇒ unreadable，人手动删除文件后 ⇒ ready（R1）；慢加载 2s ⇒ timeout，晚到结果被忽略，下次启动可以 ready；load 幂等。
- 转移表：新建（get、lookup、heldBy、resolveQuery 结果一致，`@web` 为 miss）；INVALID 四类原因且零 IO；no-op 不写盘；clear ⇒ 冷却，冷却期内只有原会话能收回，到期不写盘、到期后别人可以设置且不产生重复记录；无 held 时 clear 为 no-op；被他人持有时 在线 / 离线未过期（恰好等于 lease）⇒ taken，`>lease` ⇒ 就地转移 + Tombstone(expired)，不留冷却；confusable（`web0`/`webo`、`前端一`/`前端-`）不回显，`カ`/`力` 不算撞（R4）；同会话改同骨架名会删除旧记录；**G 三条路径**（普通 set、过期接管、take）；**256 条已满**：新建 ⇒ FULL，过期接管和 take 仍然成功。
- 在场与时间：同一 sid 两个进程只断一个 ⇒ 仍在线；离线时间戳从首次观察时起算，重连后重置；在场不落盘，时间流逝不写盘；「在线 30 天 → 崩溃 → 重启 → 别人先查询」⇒ 不过期，满 7 天 + 1ms 才过期；重启重置离线保留窗口；记录和墓碑跨重启保留，token 不跨重启。
- IO：临时文件写失败；写挂起 ⇒ 2s 后 busy、zombie 1/2/3 ⇒ disabled，读不受影响，晚到完成后临时文件被删、主文件不变；rename 失败；rename 超过 1s ⇒ UNKNOWN + wedged（写、clear、预览都 busy，读旧表，advertised 不变）× 晚到成功或失败；rename 超过 60s ⇒ disabled，晚到成功后内存与磁盘一致，重启后 ready；队列：第 5 个等待者 busy、zombie 计数、剩余预算放不下 rename 窗口的等待者零 IO 返回 busy；并发写串行（物理在途 ≤1）、没有丢失更新、临时文件名不复用；close。
- 状态×行为矩阵：ready、wedged、disabled、degraded 逐格断言 advertised、读、写、clear。
- rename 前复核的交错：写期间持有者重连 ⇒ stale；重连又断开（offlineSince 变了）⇒ stale；请求方断开（take）或 epoch 变化（set）⇒ stale/busy；另一个 token 先提交 ⇒ stale；过期接管期间持有者重连 ⇒ taken；写恰好在上限内落地 ⇒ 仍能提交。
- token：预览的各类拒绝（recent、online、not_held 三种情形、invalid）；预览输出形状（只有 4 个键）；成功转移 + Tombstone(taken)，H 之后 set 会清掉墓碑；同一 token 并发两次；跨请求方、跨别名、invalid、过期、垃圾 token 都拒绝且都会消耗；过期接管导致持有者变化 ⇒ stale；IO 失败和 busy 都消耗 token；满 32 个 ⇒ busy，过期后释放。
- 真实 fs：0600、临时文件 + rename、目录里没有残留、新实例能读回；符号链接和目录 ⇒ unreadable；超过 64 KiB ⇒ corrupt 且字节不变。

`xs-aliases.property.test.ts`：随机执行 上线、下线（触发或不触发 touchPresence）、推进时钟（1s 到 8 天）、set、clear、预览、take、IO 故障（ok/fail/hang）、释放挂起操作（成功或失败）、重启（挂起的 rename 随机按成功或失败处理）。每一步之后断言：I1、I2、I3（held ∪ coolingLive，skeleton 等于重算值）；I5（在线持有者不会被他人拿走）；磁盘不含在场字段；非写步骤主文件字节不变（I6）；返回可证明 none 的失败时内存和磁盘都不变；UNKNOWN ⇒ wedged 且内存不变；临时文件名不复用；token ≤32；队列清空；没有 rename 在途时内存与解析后的磁盘内容相等；重启后的加载结果恒为 ready 且等于磁盘内容。一次实测的结果分布：ok 781 / BUSY{io} 184 / TAKE{stale} 459 / TAKEN{confusable} 46 / TAKEN{taken} 86 / UNKNOWN 26。

## 偏离与需要注意的地方

1. **类型重复声明**：boundary 规则禁止 hub 引用 `src/fabric/**`，所以记录、结果、端口类型在 hub 里按结构重新声明。`XsAliasRequester` 多一个可选字段 `agentKey`；`status()` 的返回是 `XsAliasStoreStatus` 的超集。
2. **4s 预算包含 rename 窗口**：方案写的是「排队、写入、复核共 4s，rename 再给 1s」。实现改为在 4s 里预留 1s 给 rename，所以 hub 回包最长 4s，留出 1s 余量给 5s 的客户端截止。比方案更保守。
3. **rename 前复核失败时 set/clear 返回 `BUSY{io}`**：错误码表里 `stale` 只属于 `E_XS_ALIAS_TAKE`，set/clear 没有对应的 stale 码。过期转移中持有者重连 ⇒ `TAKEN{taken}`。
4. **64 KiB 上限**：序列化后如果超过 64 KiB，先丢最老的墓碑（价值最低），仍超才返回 FULL。极端情况下（256 条记录且 cwdLabel 都是长 CJK 文本），G 或转移也可能因为体积返回 FULL（cwdLabel 已截到 120 码点）。
5. **过期转移和 take 时**会一并删除旧持有者 H 与 x 同骨架的 cooling（防御性处理，正常路径下不会存在），以维持 I3。take 不检查第三方的骨架冲突（只有骨架表升级留下的历史冲突才会出现这种情况）。
6. **单一物理写**：被判为 zombie 的旧写入在后台可能仍未结束，此时新事务会写到另一个临时文件（O_EXCL，互不覆盖）。同时挂着的写最多 3 个，之后进入 disabled。
7. **崩溃残留的临时文件**：加载时不清理（load 和 degraded 都禁止写）。只是孤儿文件，可能需要人手动删除；本进程内产生的临时文件会尽力删除。
8. 等待者自己的 4s 定时器只是安全网：按 FIFO，前面每个事务都会在它自己的截止前结束，所以等待者实际总是先出队，再在出队检查时因预算不足返回 `BUSY{queue}`。

## 自验

```
$ npx vitest run tests/web-hub/hub tests/web-hub/boundary.test.ts --maxWorkers=3
 Test Files  192 passed (192)
      Tests  4608 passed (4608)
   Duration  120.06s

$ npm run typecheck
  tsc --noEmit -p tsconfig.json           ✓
  tsc --noEmit -p tsconfig.typecheck.json ✓
  vue-tsc -p src/web-hub/ui/tsconfig.json ✗ src/web-hub/ui/src/composables/useTrackedCommand.ts(227,19) TS2345
    —— 报错文件属于并行在途的 ALU 包（未跟踪的新文件），不在本包文件域内；本包文件不在 vue-tsc 的覆盖范围内。

$ npx prettier --check src/web-hub/hub/xs/aliases.ts tests/web-hub/hub/xs-aliases.test.ts tests/web-hub/hub/xs-aliases.property.test.ts
All matched files use Prettier code style!
```

性质测试单独连跑 5 次全部通过（每次 200 轮）。开发过程中一次挂起查明是测试夹具的 bug：`<<` 产生负数，导致十六进制串里出现 `-`。顺带把 store 的 token 和临时文件名生成改成有界重试（随机源异常 ⇒ busy，不会死循环）。

## 验收修复（deepseek 打回：1 Major + 1 Nit）

导出 API 没有改动（AL2 正在按本报告的 API 接线）。

### Major：性质测试抖动（30 跑 5 败）

根因在测试模型，不在实现。`release` 分支释放挂起的 rename 时，只把这一步标记为写步骤，没有把这次提交记到发起它的事务名下。那个事务先前回过 UNKNOWN，它对自己做的改动（§2.2 同骨架改名删掉自己的旧 held、自己 clear）因此被 I5「在线持有者不会被别人拿走」误判。

修正方法：只修模型，不放宽不变量。

- `World.pendingRename = { actor, onlineHeld }`：在事务回 UNKNOWN 的那一步记下发起者和**那一步**的在线持有者快照。wedged 期间不会有第二个 rename 在途，测试里另加断言钉住这一点。
- 释放这个 rename 时：`actor` 记为原事务的发起者；I5 的基线改用原事务那一步的快照（§3.3-4：线性化点是 rename 前的复核，持有者在 rename 未决期间重连，排在提交之后），并且**不再**因为「现在离线」跳过检查。其余步骤的 I5 判定不变。
- 重启时丢弃 `pendingRename`（旧进程的晚到 rename 归属于加载结果，由重启分支里的 `memory == disk` 断言覆盖）。最后收尾阶段的释放也改为走同一个 `release` 步骤，同样做归属和全部不变量检查。
- 种子：默认固定为 `20261023`，CI 结果确定；`XS_ALIAS_PROP_SEED=random` 用新种子探索，也可以传入任意数字种子复现。

### Nit：`usedTemps` 永不裁剪

改为：临时文件**确认已不存在**时释放这个名字，包括 rename 成功（含 wedged 后晚到成功）、unlink 成功、unlink 报 ENOENT。unlink 报其它错误时，不能确定文件是否还在，名字继续保留，所以仍然不会和可能存在的临时文件撞名。集合大小因此只取决于在途的 IO 数（在途写、zombie、待 rename、待 unlink），和运行时长无关。新增单测：让随机源每次都返回同一个临时文件名，验证提交后和写失败后这个名字可以复用；zombie 未结束时 8 次尝试全部撞名 ⇒ `BUSY{io}` 且不碰磁盘；zombie 结束并被 unlink 后可以再次使用。

### 验收修复自验

```
$ npx vitest run tests/web-hub/hub/xs-aliases*.test.ts
 Test Files  2 passed (2)
      Tests  65 passed (65)

# 50 次循环（每次 200 轮 × 5–60 步）
fixed seed 20261023 (xs-aliases.property.test.ts):           pass=50 fail=0
XS_ALIAS_PROP_SEED=random (xs-aliases.property.test.ts):     pass=50 fail=0
两个文件一起 (xs-aliases.test.ts + .property.test.ts):         pass=50 fail=0

$ npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.typecheck.json   ✓
$ npx vitest run tests/web-hub/hub/xs-aliases*.test.ts tests/web-hub/boundary.test.ts  76 passed

$ npx prettier --check src/web-hub/hub/xs/aliases.ts tests/web-hub/hub/xs-aliases.test.ts tests/web-hub/hub/xs-aliases.property.test.ts docs/dev/fabric-cross-session/AL1-report.md
All matched files use Prettier code style!
```
