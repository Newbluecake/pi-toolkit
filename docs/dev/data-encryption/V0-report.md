# V0 报告：helper 最小 API（convert/export/import 的注入端口）

> 状态：已完成（2026-10-24），未提交 commit。方案：`convert-plan.md` r3 §0、§1.4（第 2/14 步）、§3.3–§3.5、§5、§6、§8.1 V0 行、§8.2（registerVault 统一 / init --fix-settings 挂点 / describeVault 边界）、§R1 #9/#10、§R2。
> 前置：private 方案 L0–N5 全部合入。本包只改 `src/secure/bin/helper.mjs` 与测试；`src/secure/*.ts` 未碰，V1（tar.mjs）/V2（tree.mjs）/V3（sessions.mjs）并行包的文件未碰，未接线任何新命令（V6 的事）。
> 结论：V4（convert）/V5（archive）需要的六个端口全部就位并以 `V0_PORTS` 冻结对象导出；N2 的 `registerVault` 调用点已按 §8.2 迁移到条目对象签名，写入字节与退出码不变。

## 1. 改动清单

| 文件                                        | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/secure/bin/helper.mjs`                 | `registerVault` 统一为 `(name, entry, opts)`（`expectAbsent`/`pending`/`home`/`lockWaitS`）；`registerVaultUnlocked` 扩展同名 opts（位置参数签名不变）；新增 `patchVaultEntry`/`patchVaultEntryUnlocked`、`removeVaultEntry`/`removeVaultEntryUnlocked`（「仅本 txid」清除）；`CliError` 导出；`unlockVault` 导出并加 `postMount:false`；`PENDING_RE`/`TXN_ENTRY_KEYS` 常量；`spawnUnderSettingsLock` 共享 flock 子进程协议（73/69/78 类型化）；`main` 分派 `__register`（扩展 `--expect-absent`/`--pending`）与新增 `__vault-patch`/`__vault-remove` 内部子命令；`cmdInit` 调用点迁移；`V0_PORTS` 冻结导出 |
| `tests/secure/helper-v0-api.test.ts`        | 新文件，30 例：认领矩阵（expectAbsent 竞争 78、键序、坏参数在碰锁前拒绝、锁忙 73、`__register` 协议）、patch 全表（提交点、relocate、错 txid ⇒ mismatch 且字节不动、allowlist、missing、锁忙 73、子命令协议）、remove 全表（仅本 txid、已提交不可删、fail closed）、真 gocryptfs 两例（`postMount:false` 裸挂载 + 三错口令 77）、`CliError`/`V0_PORTS`/`PENDING_RE`                                                                                                                                                                                                                                         |
| `tests/secure/launcher-helper.test.ts`      | 仅调用形状迁移（9 处 `registerVault` 位置参数 → 条目对象），断言不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tests/secure/launcher-private-cmd.test.ts` | 同上（2 处，`--private` 改放进 entry），`__register --bogus` ⇒ 78 断言不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tests/secure/settings-lock.test.ts`        | 同上（内联 worker 脚本 1 处），并发不丢更新断言不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

parity fixture **未追加**（本包没有改任何双侧解析语义——`pending`/`origin`/`backup`/`relocate` 仍不被两侧 `parseSecureConfig` 读取，属 V6）；N0 golden、secure-off golden、三份 fabric off golden 未触及且全过。

## 2. V0 端口签名（V4/V5 消费面，全部已导出 + `V0_PORTS` 冻结打包）

```js
// 认领（convert §1.4 第 2 步 / import §3.3 第 1 步；init 的 N2 调用点同函数、无 expectAbsent）
registerVault(name, entry, opts?) → undefined
  entry : { dir: string /*绝对*/, mnt: string /*绝对*/, private?: boolean }
  opts  : { home?: string = homeDir(), expectAbsent?: boolean, pending?: string, lockWaitS?: number = 10 }
  throws: CliError 73（设置锁忙）/ 69（flock 不可执行）/ 78（expectAbsent 认输、设置文件拒绝、子进程失败）
          Error（调用方 bug：名字/entry/pending 形状不对——在取锁之前抛，零副作用）
  pending 须匹配 PENDING_RE = /^[a-z][a-z0-9]{0,15}:[!-~]{1,64}$/（"convert:<txid>" / "import:<txid>"）
  写出的条目键序固定 {dir, mnt, private?, pending?}；不带 expectAbsent 时保持 N2 的覆盖语义（字节不变）

// 提交点 / 迁址推进（convert §1.4 第 14 步、import §3.3 第 7 步、§3.4 第 5 步）
patchVaultEntry(name, guard, patch, opts?) → {kind:"ok", entry} | {kind:"missing"} | {kind:"mismatch", reason}
  guard : { pending?: string, relocateTxid?: string }   // 至少一个；全部条件都必须匹配【当前】条目
  patch : { set?:   { origin?: string /*绝对*/, backup?: string /*绝对*/, pending?: string, relocate?: {from,to,txid,phase} },
            remove?: ("origin"|"backup"|"pending"|"relocate")[] }
  opts  : { home?, lockWaitS? }
  throws: CliError 73/69/78；Error（allowlist/形状——不写任何东西）
  mismatch/missing 是【返回值】不是异常：条件不满足 ⇒ 零写入、settings 字节不动，由调用方映射退出码
  （convert 提交失败按 §1.4 第 14 步 ⇒ 74 + 提示 --resume；对已提交条目再次操作 ⇒ mismatch）

// 回滚（convert §1.6 R-A 第 4 步 / import 恢复表「撤销本 txid 登记」）
removeVaultEntry(name, { pending }, opts?) → {kind:"ok"} | {kind:"missing"} | {kind:"mismatch", reason}
  guard.pending 必填（无无条件删除，I-C8）：pending 仍等于本 txid 才删整条；
  已提交（pending 已清）或他人持有 ⇒ mismatch，条目保留

// 挂载（convert 第 2 步自己的挂载 / §3.4 迁址受控入口）
unlockVault(v, { fix = false, postMount = true }) → Promise<{ how: "mounted-now"|"already", realMnt: string }>
  postMount:false ⇒ 裸挂载：不建 work/state 目录、不写 sessionDir（ensureVaultDirs/syncProjectSettings 都跳过）
  该入口不经 resolveVault 的 pending 拒绝（那是 V6 对命令面加的），convert「凭本 txid 豁免」由此结构性成立
  失败自动回滚本次新挂载（r2 A3 语义不变）；口令三错 ⇒ CliError 77（§6），mount.lock 忙 ⇒ 73

// 既有函数，纳入端口打包（签名未动）
finalizeBounded(v, { lazy?, budgetMs?, deps? }) → Promise<{ code, lines: string[] }>   // 从不抛、从不过预算
scanCwdOccupants(realMnt, { deadline, procRoot?, maxEntries?, delayMs?, selfPid? })
  → Promise<{kind:"done", occupants:[{pid,cwd,comm}]} | {kind:"timeout"} | {kind:"too-many",count} | {kind:"error",message}>
preflight() → { ok: boolean, problems: string[], version?: [number,number,number] }
  // V4 的 getfattr / mv -n -T / sync -f / git 前置属 V2/V4 自己的扩展检查，不并入此函数

// 类型化错误与常量
CliError            // 已导出；.code 即 §6 退出码（73 LOCK_BUSY、78 CONFIG、76 BUSY、77 BAD_PASSWORD…）
PENDING_RE          // pending/guard.pending 的形状
TXN_ENTRY_KEYS      // patch 允许触碰的条目键 ["origin","backup","pending","relocate"]
V0_PORTS            // Object.freeze({unlockVault, registerVault, patchVaultEntry, removeVaultEntry,
                    //   finalizeBounded, scanCwdOccupants, preflight}) —— V4/V5 以注入端口接收，
                    //   测试可整体替换为假实现；冻结，不可增删
// 锁内半函数（与 registerVaultUnlocked 同居一对，测试/未来复用可直接调）
patchVaultEntryUnlocked(name, guard, patch, home?) / removeVaultEntryUnlocked(name, guard, home?)
```

内部 flock 子命令协议（仅本文件自用，非用户面）：`__register <name> <dir> <mnt> [--private] [--expect-absent] [--pending <v>]`（垃圾 flag/缺值/重复 ⇒ 78，未写任何东西）；`__vault-patch <name> <guardJson> <patchJson>`、`__vault-remove <name> <guardJson>`（stdout 恰一行 JSON 结果；坏参数 ⇒ 78）。三个子命令都在 `flock -E 73 -w <lockWaitS> <settings锁>` 内执行。

## 3. 逐条落点（对方案）

| 方案条目                                                                                              | 实现                                                                                                                        | 测试                                                                       |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| §1.4 第 2 步 名字认领 `registerVault(name, {dir,mnt}, {expectAbsent:true, pending:"convert:<txid>"})` | 就位；settings 锁内复核（`__register` 子进程持锁读现值，键存在即拒——即使现值是坏条目也拒，I-C5）；锁忙 ⇒ CliError 73        | 认领矩阵 8 例                                                              |
| §1.4 第 14 步 唯一提交点（清 pending 仅当仍为本 txid + 写 origin/backup）                             | `patchVaultEntry(name, {pending}, {remove:["pending"], set:{origin,backup}})`；一次原子写；键序 dir,mnt,origin,backup       | 提交点 + 错 txid 字节不动                                                  |
| §1.6 R-A 第 4 步 「settings 锁内删除 pending === 本 txid 的登记项」                                   | `removeVaultEntry(name, {pending})`；已提交 ⇒ mismatch 不删（提交后不允许 abort 的机制基础）                                | remove 全表                                                                |
| §3.3 第 1/7 步 import 认领与提交（`import:<txid>` + relocate）                                        | 同上；`set.relocate` 形状校验 {from,to 绝对路径, txid, phase∈[a-z0-9_-]{1,32}}                                              | import 提交 + relocate                                                     |
| §3.4 第 5 步 清 relocate 仅本 txid                                                                    | `patchVaultEntry(name, {relocateTxid}, {remove:["relocate"]})`；双条件 guard（pending+relocateTxid）须全匹配                | relocate 清除 + 双条件                                                     |
| §3.4 第 1 步 「挂载不做 postMount（V0 的 `unlockVault(v,{postMount:false})`）」                       | `unlockVault` 导出 + `postMount` 选项（默认 true，现有调用点字节不变）；false ⇒ 跳过 ensureVaultDirs 与 syncProjectSettings | 真 gocryptfs：挂载后 `<mnt>` 为空、无 work/.pi，finalizeBounded 卸载回哨兵 |
| §8.2 registerVault 统一签名、迁移 N2 调用点                                                           | `cmdInit` 一处迁移；普通条目仍写 `{dir, mnt}`、私有写 `{dir, mnt, private:true}`（N2 断言原样通过）                         | launcher-private-cmd N2 例                                                 |
| §8.2 init --fix-settings 迁址挂点                                                                     | V0 只提供 `postMount:false` 挂载；`--fix-settings` 的迁址逻辑与私有库 setup 模式整合属 V6                                   | —（V6 接线时补）                                                           |
| §6 退出码（73/69/78；77 挂载口令）                                                                    | `spawnUnderSettingsLock` 类型化：锁忙 73、flock 缺 69、其余子进程失败 78；`CliError` 导出供 V4/V5 捕获                      | 锁忙 73 ×3、三错口令 77                                                    |
| §R1 #9（名字认领竞态）                                                                                | `expectAbsent` 在锁内复核；convert/import 两个新认领方之间恰好一个成功                                                      | 竞争 78 例                                                                 |
| §R1 #10（引用的 helper 导出不存在 / unlockVault 总是 postMount）                                      | 本包整体即该修复                                                                                                            | 全部                                                                       |

## 4. 决策与残留

1. **init 不加 `expectAbsent`**（行为冻结优先）：init 对「已登记但目录缺失」的库走重建+覆盖登记，N0 golden 之后这是既有语义；改它超出 V0 的「迁移 N2 调用点，行为不变」。convert/import 之间（以及二者各自并发）的竞争已由 `expectAbsent` 关闭；init 撞上活动 convert 认领的实际窗口需要 `<dir>` 已被删除（convert 在场时目录必在 ⇒ init 在更早的「保险库已存在」处拒绝），理论残窗是 convert 回滚删除目录与登记之间的毫秒级交错，且彼时登记项已随事务撤销，撞上也只是覆盖一个已死条目。V6 若要把 init 也改为认领式，是独立的一包（会动 N0 冻结面，需按 Q9 流程加 USAGE/golden 例外）。
2. **`lockWaitS` 测试缝**：默认 10 s 不变；仅作为 opts 注入让锁忙 73 的单测不必睡 10 秒。行为面（用户可见输出/退出码）与生产路径完全一致。
3. **patch/remove 的 mismatch/missing 是返回值不是异常**：方案要求「清除失败 ⇒ 状态文件保持、exit 74、提示 --resume」这类由调用方决定语义；V0 不越权映射退出码。编程错误（allowlist、形状）在取锁前抛 plain `Error`——这是 V4/V5 的 bug，应当响亮地崩，而不是变成用户可见的退出码。
4. **`scanCwdOccupants` 维持 cwd 扫描**：§1.3/§1.4 的 exe/fd/fdinfo/maps 全量占用扫描属 V2（tree.mjs）的 `worker 协议`邻域，V0 不改它的形状（N0 golden 与既有 e2e 依赖它的输出契约）。V4 复扫若需要更强判据，用 V2 的实现。
5. **`preflight` 不并入 getfattr/`mv -n -T`/`sync -f`/git**：这些是 convert 专属前置（§1.3 前置行），V4 自查并映射 69/2；公共 `preflight` 的输出被 status/N0 golden 钉死。
6. **`origin`/`backup`/`pending`/`relocate` 尚无解析方**：两侧 `parseSecureConfig` 都还不读这些键（V6 加），带 `pending` 的库当前仍可被 unlock/run 打开——这正是 V0 只做 API、不做接线的既定边界；parity fixture 无需动。

## 5. 自验

过程中发现并修复一个本包引入的缺陷：`unlockVault` 的同名**选项** `postMount` 遮蔽了模块级的同名**函数**，默认路径（`postMount:true`）一挂载就 `TypeError`——我的首批测试只覆盖了 `postMount:false`，是 N0 golden 的 real 块先抓到的（`unlock-already-first` 用例：exit 1 + 内部错误栈）。修复：内部函数改名 `runPostMount`（未导出，仅一处调用点），并在本包测试里补上默认分支回归例（真 gocryptfs：默认路径建 work/state + sessionDir）。

| 命令                                                                                                                         | 结果                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/secure tests/config --maxWorkers=3`（含并行包文件，修复前）                                            | 1407 例中 1391 过；16 失败 = 本包 postMount 遮蔽缺陷（launcher-fuse 12、N0 golden 1、private-cmd N2-real）+ 并行包 V1/V2/V3 新文件自身的失败 + 2 例 gocryptfs 测试锁竞争超时（多 agent 同机并行） |
| 修复后定向：`npx vitest run tests/secure/{launcher-fuse,launcher-off-golden,launcher-private-cmd}.test.ts`                   | **80/80 过**（含 N0 golden fake 70 + real 17 全部字节比对、真机 --private 命令面）                                                                                                                |
| `npx vitest run tests/secure tests/config --maxWorkers=3 --exclude 'tests/secure/{tar,tree,sessions}.test.ts'`（修复后全量） | 1156 例中 1155 过；唯一失败是 `launcher-private-cmd > lock --lazy` 的 `/proc` 扫描预算超时（`scan-incomplete`，同机多 agent 高负载所致；本包 diff 不涉该路径，且该用例在隔离重跑中通过）          |
| `npx vitest run tests/secure/launcher-private-cmd.test.ts`（隔离重跑上一行那例）                                             | **41/41 过**                                                                                                                                                                                      |
| `npx vitest run tests/secure/helper-v0-api.test.ts`                                                                          | **31/31 过**（含真 gocryptfs 3 例：裸挂载、默认 postMount 回归、三错口令 77；mktemp HOME + 假口令）                                                                                               |
| `npx vitest run tests/conformance/secure-*.test.ts`                                                                          | **4 文件 41/41 过**（secure-gocryptfs C1–C5、secure-private-ns，以及并行包的 secure-convert-xc2/xc89 当前状态）                                                                                   |
| `npm run typecheck`                                                                                                          | 过（tsc 双段 + vue-tsc）                                                                                                                                                                          |
| `sh -n src/secure/bin/pi-secure`                                                                                             | 过                                                                                                                                                                                                |
| `npx prettier --check`（5 个改动文件）                                                                                       | 过                                                                                                                                                                                                |
| `pi-secure status`（用户真实环境，demo 旧布局库）                                                                            | 正常输出，未被破坏                                                                                                                                                                                |

冻结面核实：N0 golden fixture、`secure-off-golden.json`、三份 fabric off golden、`secure-contract-parity.json` 均未修改（git 工作区里本包只改 helper.mjs + 4 个测试文件）；V1/V2/V3 的文件（tar/tree/sessions.mjs 及其测试、xc2/xc89 conformance、tar 语料）未碰。

## 6. 给 V4/V5 的接入示例

```js
import { V0_PORTS } from "./helper.mjs";
const P = V0_PORTS; // 或测试注入假实现

// convert 认领 → 自己挂载 → … → 提交 / 回滚
P.registerVault(name, { dir, mnt }, { home, expectAbsent: true, pending: `convert:${txid}` });
const { realMnt } = await P.unlockVault(v, { postMount: false }); // 口令在改名之前输完（§1.4 第 2 步）
// … 拷贝/校验/屏障（V2/V3）…
P.patchVaultEntry(name, { pending: `convert:${txid}` }, { remove: ["pending"], set: { origin, backup } }, { home }); // 唯一提交点（第 14 步）
P.removeVaultEntry(name, { pending: `convert:${txid}` }, { home }); // R-A 回滚（仅本 txid）

// import 提交带 relocate；迁址完成后清除（§3.3 第 7 步 / §3.4 第 5 步）
P.patchVaultEntry(
  name,
  { pending: `import:${txid}` },
  { remove: ["pending"], set: { relocate: { from, to, txid, phase: "pending" } } },
  { home },
);
P.patchVaultEntry(name, { relocateTxid: txid }, { remove: ["relocate"] }, { home });
```

错误处理约定：`catch (e) { if (e instanceof CliError) process.exitCode 决策用 e.code }`；`patchVaultEntry`/`removeVaultEntry` 的 `mismatch` ⇒ 按各自方案的「提交失败/回滚未完成」文案处理，`missing` ⇒ 幂等成功或报告，由调用方定。
