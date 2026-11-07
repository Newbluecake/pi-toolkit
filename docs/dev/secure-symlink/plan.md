# #28 pi-secure 符号链接路径下自有挂载被判 foreign —— 实施方案（plan r3）

> 输入：`explore.md`（本目录，[F]/[I] 与行号以它为准）、`docs/dev/data-encryption/README.md`、`private-plan.md` §L.1/§2.2、`docs/dev/test-speed/README.md`。行号基线 dev `f91ec0c1`。
> r2（2026-11-05）：吸收 GPT 评审 r_NEWTSAGQ（有条件通过，0B/4M/2m）与用户拍板（运行时 status 诊断延后、不加兼容垫、A′ 测试根 realpath 化）。
> r3（2026-11-05）：第 2 轮复审后按 root 裁定改两处 —— 插件复检时序描述（§1.1）、cipher 物理祖先链定为 (ii)（§1.3/§2/§6）；处置见 §7。全程未运行任何 secure 测试、挂载、gocryptfs 或 fusermount 命令。

## 0. 需求摘要

- **缺陷**：普通挂载 `cmdInnerMount` 把词法 `v.cipher` 交给 gocryptfs（`helper.mjs:3080`），gocryptfs 原样写成 mountinfo source；判定却要求 `source === realCipher`（`helper.mjs:286`、`3017`；`config.ts:350`；插件 `domain.ts:558`）。
  - `<dir>` 祖先链含符号链接（如 `~/.local/share → /data/share`）时：挂载成功 → 判 foreign → 回滚按 `foreign ⇒ 不动它`（`2505`）拒绝卸载 → 全局明文挂载残留、`mount.lease` 被占 → unlock/run/lock/export 全部卡死。
- **目标**：
  - 普通挂载的 argv 与判定使用同一种物理拼写；
  - 判定严格性一字不放宽；
  - A/A′ golden 字节不变；
  - 补防回归测试：普通挂载 argv 目前没有单测，真实挂载套件的根全是物理路径。
- **非目标**：`<mnt>` 祖先链含符号链接 ⇒ 78（explore 情形 B）不变；不改设置存储（选项 c）；不给 `<dir>` 加祖先规则（下文 (i)）；不做运行时 status 诊断、不加兼容垫 (b)/(b′)（用户拍板）。

## 1. 设计决定

### 1.1 采用 (a)：挂载前取物理路径，复用 `physicalPaths(v)`

- **计算**：在 `cmdInnerMount` 中，于 `const pin = pinMountPoint(v)`（`helper.mjs:3071`）之后、口令循环之前，算一次 `const { realCipher, realMnt } = physicalPaths(v)`（`326-350`），不另写 realpath 逻辑。
- **参数**：
  - 新增纯函数 `plainMountSpawnTail(realCipher, realMnt)`，返回 `["gocryptfs","-nonempty","--",realCipher,realMnt]`，放在「spawn specs」段、`gocryptfsSpawnSpec`（`4940`）旁；
  - 调用改为 `leaseChainArgs(v.lease, plainMountSpawnTail(realCipher, realMnt))`。
- **挂载点字符串断言**：spawn 前检查 `realMnt === pin.path`，否则抛 `CliError(EXIT.FAIL, "挂载点物理路径与固定时不一致，拒绝挂载")`。
  - 这条**只约束挂载点字符串**，使 argv 与 `verifyMountPointIdentity` 比对的 `pin.path` 字面相同。
  - 挂载点**身份**由既有机制证明：pin fd 跟随改名、父目录 dev/ino、挂载后 `stat(v.mnt).dev` 等于 mountinfo maj:min（`2994-3040`）。
  - 它**不证明 cipher 身份**：cipher 一侧没有任何身份证明（§1.2）。
- **不改的拼写**：
  - `gocryptfs -init -- v.cipher`（`init.mjs:158`、`helper.mjs:5708`）不产生 mountinfo，A′ golden 第 307 行不动；
  - `fusermount3 -u v.mnt`（`2431-2442`）中 `v.mnt` 与 realMnt 相等。
- **与 private 只是写法对齐，不作安全证明**：private 也在循环前取一次 `physicalPaths`（`private.mjs:664`）、以 `realCipher realMnt` 挂载（`694`），但复检时序不同：
  - private 的就绪轮询（`751`）用**缓存值**，身份核验（`473`→`verifyMountPointIdentity`）才重算；
  - 普通 launcher 的探测（`waitMountState`→`probeMountState`，`372`）与 `verifyMountPointIdentity`（`2994`）**每次重算**；
  - 插件在初始化时解析 `SecureVaultRoots` 并冻结（`domain.ts:160-165`、`553-560`、`613`），运行期复检只重读 mountinfo、使用冻结的 root（`guards.ts:308-315`）。
  - 普通 launcher 保留重算，是为了与 status、插件的判定口径一致（插件拿到的 `root` 本身就是 realpath 结果）。**插件代码不需要改，也不以 §6 的裁定为条件。**

### 1.2 TOCTOU：检测能力的真实边界

fsname（mountinfo source）**只是挂载者自填的标签**，内核不校验，不能证明 gocryptfs 打开的是哪个 inode。判定只能证明"source 字符串等于此刻重算出的 realCipher 字符串"。下表各情形均发生在 realpath 之后、复检之前。

| 竞争情形              | 描述                                                                                       | 复检                                   | 能否检测           | 后果                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| R1 词法别名被重指向   | `<dir>` 词法链上的符号链接改指他处                                                         | 重算串 ≠ fsname ⇒ foreign              | **能**（字符串层） | argv 已无别名，gocryptfs 打开的仍是原目录 ⇒ 实为误报；fail-closed、不卸载，留下的挂载按 §1.7 人工处理（只影响可用性） |
| R2 物理路径上的项被换 | 物理链上的真实目录或 cipher 目录被 rename 掉，原位置换成另一目录（也可能 open 前就已换好） | realpath 串不变、fsname 相同 ⇒ mounted | **不能**           | 实际挂载的不是受检目录，见 §1.3                                                                                       |
| R3 变了又恢复         | R1/R2 发生后在复检前复原                                                                   | mounted                                | **不能**           | R1 复原无害；R2 复原同 R2                                                                                             |

- (a) 相对今天是**收窄**：今天 argv 带别名，open 时还受别名影响；(a) 之后只剩 R2。R2 窗口今天同样存在，与本缺陷无关。[I]
- **谁能做 R2**：`<dir>` **物理祖先链上任一可写层的属主**（包括其他 uid：该层对组/其他可写且非 root+sticky，或属主为他人）以及 root。`<dir>` 自身是 0700，**不能**据此把攻击者限定为同 uid，因为父目录可写者能 rename 掉整个目录项。

### 1.3 cipher 物理祖先链：已定 (ii) 维持现状并写入威胁模型

> 用户 2026-11-05 拍板：(ii) 维持现状，**不新增任何拒绝规则**。

- **(ii) 本次做法**：不加祖先规则，只在 `docs/dev/data-encryption/README.md` 的威胁模型里写明残留。
  - 原文要点：**cipher 的物理祖先可被可写父目录的属主替换 ⇒ 检测不到（R2）**，但机密性由挂载点祖先链规则、cipher 的 0700 与口令兜住，只影响可用性和目录级完整性，且该缺口在本次修复前就存在。
  - 文档另给一句用户侧建议：把 `<dir>` 放在只有本人和 root 可写的链下。
- **理由** [I]：
  1. 明文机密性靠 `<mnt>` 祖先链规则（已强制）+ cipher 0700 + 口令，R2 无法让明文出现在攻击者可读的位置：
     - 换成攻击者自建的 cipher：master key 受 scrypt(口令)+GCM 认证保护，用户口令解不开，gocryptfs 返回 12 ⇒ 不挂载；口令只输进以用户身份运行的 gocryptfs；
     - 挪走真 cipher：它仍是用户的 0700 目录，攻击者读不到内容；
     - 剩下的影响是可用性和目录级完整性（整目录调包或回滚；gocryptfs 本就不防整目录回滚）；同在 `<dir>` 的 `mount.lock/lease` 也属这一信任面，可被破坏串行化，private 的 Q10 另有 mountinfo 检查兜底。
  2. 这是既有缺口，不由 (a) 引入。
- **未采纳的 (i)（留作以后另立课题）**：比照 `mntAncestorProblems`（`helper.mjs:1129-1161`）对 `realpath(dir)` 的父链逐级要求真实目录、属主为本人或 root、组/其他不可写（root+sticky 例外）。
  - 拒绝面：0775 家目录（explore 记录本机即是，**默认 `dir` 在 `$HOME` 下会整体被拒**）、0777 无 sticky 或属主为他人的共享盘 `/data`、`/mnt/<disk>`、uid 映射的网络家目录；
  - 已登记的库升级后 `unlock` 会直接 78，需要 `init --fix-settings` 迁址 —— 对不涉及明文泄露的威胁代价不成比例。

### 1.4 各环节路径表（改后）

| 环节                                               | `<dir>`/cipher 拼写                         | `<mnt>` 拼写            | 判定                       | 改动                  |
| -------------------------------------------------- | ------------------------------------------- | ----------------------- | -------------------------- | --------------------- |
| mount（普通）                                      | **物理 `realCipher`**（原为词法）           | `realMnt`（== `v.mnt`） | 物理，每次重算             | **改**                |
| mount（private，`private.mjs:694`）                | 物理                                        | 物理                    | 就绪轮询用缓存，核验时重算 | 无                    |
| lease（`leaseChainArgs`，`4920`）                  | 词法 `v.lease`（按 inode flock，等价）      | —                       | —                          | 无                    |
| 前置探测 / `checkLayout`                           | 探测走物理；dir 只 lstat 自身               | 词法 + 祖先链规则       | 物理                       | 无                    |
| unmount / finalize（`2431-2505`）                  | —                                           | 词法（== 物理）         | `foreign ⇒ 不动`           | 无                    |
| status（`describeVault`）                          | 打印词法 `dir`；探测走物理                  | 物理                    | 物理                       | 无（诊断延后）        |
| run / unlock / init 首挂 / convert / import / 迁址 | 都经 `unlockVault`→`__mount`                | 同上                    | 同上                       | 随 mount 自动修复     |
| export（`archive.mjs:626`）                        | 要求 `absent`；读 `v.cipher` 树             | —                       | 物理                       | 无                    |
| 插件 `judgeVaultMount`（`domain.ts:558`）          | `join(realpath(dir),"cipher")` = realCipher | `mntReal`               | 物理                       | 无（修复后判 secure） |

### 1.5 判定严格性与冻结契约

一字不改：`vaultMountState` 两份实现（`helper.mjs:282-287`、`config.ts:346-351`）、`verifyMountPointIdentity`、`domain.ts`、`tests/fixtures/secure-contract-parity.json`。该 fixture 是 **A 级（永不重生）**，任何改动都等于宣告判定行为变更，不存在「申报后重生成」的路径。不加兼容垫。

### 1.6 已定事项

- **A′ golden 测试根 realpath 化**：只把 `tests/secure/launcher-off-golden.test.ts:79` 的 `mkdtempSync(...)` 包一层 `realpathSync(...)`，即规范化测试输入的根。normalize、预期值、断言、用例和 skip 条件**一律不改**，golden 文件不动。符号链接布局由 §3.2 的显式回归覆盖。
- **运行时 status 诊断延后**，本包只写 README 恢复小节（§1.7）。

### 1.7 README 恢复小节（已楔死的现场；纯文档，写入 `docs/dev/data-encryption/README.md`）

- **症状**：旧版本以词法拼写挂上的挂载，升级后仍读作 `foreign`。
- **精确查询**：`findmnt -J -o TARGET,FSTYPE,SOURCE --mountpoint <mnt>`。
  - `<mnt>` 取 status 打印的路径（祖先链规则保证它是物理路径）；`--mountpoint` 精确匹配，JSON 无八进制转义；多条记录时以最后一条为准。
  - 不要用 `grep <mnt> /proc/self/mountinfo`：它受子串、正则元字符和 `\040` 转义影响。
- **措辞**：结果「**可能**与本库 cipher 的另一种拼写一致，**无法据此证明归属**，需人工确认」。须全部满足：
  1. 最后一条 FSTYPE 为 `fuse.gocryptfs`；
  2. `realpath <SOURCE>` 等于 `realpath <dir>` 加 `/cipher`，且二者 `stat -c %d:%i` 相同（这只说明此刻路径相同，不证明 daemon 当初打开的是它）；
  3. `pgrep -u "$(id -u)" -a gocryptfs` 中有进程，其命令行带该 SOURCE 与 `<mnt>`，且 `ls -l /proc/<pid>/fd` 含 `<dir>/mount.lease`；
  4. `pi-secure status <n>` 无 private 实例块（若有，走 private 的 lock 流程）；
  5. 你确认没有其他会话或他人有意挂载它。
- **卸载**：先用 `fuser -vm <mnt>` 关闭占用者，再 `fusermount3 -u <mnt>`。
  - **`-uz`（lazy detach）只摘除路径**：已打开的文件或 cwd 在关闭前仍可读写明文；daemon 与租约会活到最后一个引用释放（期间 unlock 可能报 76）。**不等价于已锁定**，只作最后手段。
- **收尾核对**：`findmnt` 查无记录，且 `flock -n <dir>/mount.lease true` 成功，再 `pi-secure unlock`。

## 2. 改动清单（单包 P1，一次提交 `fix(secure): …`）

| #   | 文件:行                                                    | 改动                                                                                                                                            |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/secure/bin/helper.mjs:3071-3082`                      | pin 后算 `physicalPaths(v)`；加 `realMnt === pin.path` 断言；argv 用 `plainMountSpawnTail`；注释写明 §1.2 边界                                  |
| 2   | `src/secure/bin/helper.mjs:~4938`                          | 新导出 `plainMountSpawnTail`                                                                                                                    |
| 3   | `tests/secure/launcher-helper.test.ts`（tier1，`:630` 旁） | §3.1 的 1–3、6                                                                                                                                  |
| 4   | `tests/secure/launcher-cli.test.ts:39,339`（tier1）        | ctx 根改为 `realpathSync(mkdtempSync(...))`（只改根）；新增 §3.1-5                                                                              |
| 5   | `tests/secure/domain.test.ts`                              | §3.1-4                                                                                                                                          |
| 6   | 新文件 `tests/secure/launcher-symlink.test.ts`             | §3.2                                                                                                                                            |
| 7   | `tests/tiers.ts:49-63`                                     | `SECURE_MOUNT_FILES` 显式登记 #6（计数按 manifest 长度，无硬编码）；注释文案 16 改为 17                                                         |
| 8   | `tests/secure/launcher-off-golden.test.ts:79`              | 只把根 realpath 化（§1.6）                                                                                                                      |
| 9   | `docs/dev/data-encryption/README.md`                       | 挂载拼写契约一句；**§1.3 威胁模型残留**（cipher 物理祖先可被可写父目录属主替换 ⇒ 检测不到，只影响可用性/完整性，缺口先于本修复）；§1.7 恢复小节 |
| 10  | `AGENTS.md:185`、`docs/dev/test-speed/README.md`           | 文案 16 改为 17；「#28 产品侧符号链接 bug」残留段改为已修并附 plan 链接                                                                         |

明确不改：`config.ts`、`domain.ts`、`private.mjs`、`init.mjs`、`convert.mjs`、`archive.mjs`、`tests/fixtures/**`；`launcher-convert.test.ts:84` 保留 realpath 绕过（convert 与 unlock 共用 `unlockVault`→`__mount`，已由 #6 覆盖）。

## 3. 测试

### 3.1 纯逻辑 / 无挂载（tier1；根一律取 `realpathSync(mkdtempSync(...))`，用 `symlinkSync` 构造布局）

1. **`physicalPaths` 矩阵**：
   - L0 无链接 ⇒ `realCipher === v.cipher`；
   - L1 `home/.local/share → data/share` ⇒ `realCipher !== v.cipher` 且 `realMnt === v.mnt`；
   - L2 `dir` 经符号链接前缀 ⇒ 同 L1；
   - L3 `dir` 自身是链接 ⇒ `checkLayout` 报"不得是符号链接"；
   - L4 `home/secure` 是链接 ⇒ `mntAncestorProblems` 非空。
2. **`plainMountSpawnTail("/c","/m")`** 精确匹配；`leaseChainArgs` 的尾部即该 tail。
3. **判定对拍**（L1）：source 为词法 ⇒ foreign；为 realCipher ⇒ mounted；为另一 cipher 的物理路径 ⇒ foreign。`H.vaultMountState` 与 `config.ts` 结果一致，不进 fixture。
4. **插件**：`judgeVaultMount`（L1，注入 mountinfo，`<mnt>/state` 为真实目录）在 source = `realpath(dir)/cipher` 时 ⇒ `ok`；source 为词法时 ⇒ foreign 文案。
5. **调用点**（fake gocryptfs）：L1 下 `unlock acme` 记录的首个调用 === `gocryptfs -nonempty -- <realpath(dir)>/cipher <mnt>`，防止有人把 argv 改回 `v.cipher`。
6. **竞争检测边界**（钉住 §1.2，无挂载）：
   - 先取 `p0 = physicalPaths(v).realCipher`，构造 `realMnt` 上 `fuse.gocryptfs source=p0` 的 mountinfo。
   - 两条路径都测：
     - **探测侧**：用 `physicalPaths`+`vaultMountState` 复现 `probeMountState:372`；
     - **核验侧**：直接驱动 `verifyMountPointIdentity`，`deps` 注入 `readMountinfo/stat/readlink`；pin 用 `closed:true` 的伪对象（`path: realMnt`，父目录真实 dev/ino），保证 finally 不会关闭真实 fd。
   - 三个用例：
     - **R1**：`.local/share` 改指同构的 `data2/share` ⇒ `p1 !== p0`，两侧都判 foreign 或抛错。
     - **R2**：物理位置的 `cipher` 先 rename 为 `cipher.orig` 再 `mkdir cipher`，或物理祖先 `data` 整体换成同构新树 ⇒ 重算串 `=== p0`，探测判 mounted、核验通过，并断言前后 lstat 的 dev/ino **不同**（注释写明这是已知不可检测、对应 README 残留；将来加入 cipher 身份证明时同步改这条断言）。
     - **R3**：R1 后复原链接 ⇒ mounted。

### 3.2 真实挂载回归（secure project，`launcher-symlink.test.ts`）

- **门控**：**不用** `realSkipReason()`（它要求 unshare/userns）。自定义 `PLAIN_SKIP`，照抄 `launcher-fuse.test.ts:39-42`，只查普通模式的必要条件：linux；`gocryptfs/fusermount3/flock/script` 齐全；`/dev/fuse` 可读写。
  - 沿用 `acquireGocryptfsTestLock`（beforeAll/afterAll）、`awaitNoForeignGocryptfs`、`T.cleanup()`（afterEach）与 secure project 的预检；从 `private-real-harness.ts` 只取 `RealHarness/leaseFree/until` 等工具。
- **布局**：
  - `const e = T.setup([], { root: realpathSync(tmpdir()) })`，并断言 `realpathSync(e.r) === e.r`；
  - 把 `e.h/.local/share` rename 到 `e.r/data-share`，再 `symlinkSync(e.r/data-share, e.h/.local/share)`（复现 A1）；
  - 设置不变；`<mnt> = e.h/secure/acme`，祖先链干净。
- **正例**：
  1. `T.tty(e, "unlock acme")` 退出 0，含「已解锁」，不含 `foreign`/`未能撤销`；
  2. 用 `H.parseMountinfo` **精确**取 `mountPoint === e.mnt` 的最后一行：source 逐字节 `=== realpathSync(e.dir) + "/cipher"` 且 `!== join(e.dir,"cipher")`（不用 `globalMounted` 的子串判断）；
  3. `status acme` 为 `mounted`；
  4. `lock acme` 退出 0，精确查询无该行；
  5. `await until(() => leaseFree(e), 5_000, "lease released")`；
  6. 第二轮 unlock → lock 同样成功，租约同样在 5 s 内释放。
- **反例（严格性）**：
  - 锁定后，测试侧用 `gocryptfs -init -q -scryptn 10 -passfile` 建另一个 cipher，并用 passfile 挂到 `e.mnt`；
  - 断言：`status` 为 `foreign`；`lock acme` 退出 1，含「不动它」；精确查询仍在；
  - 测试自行 `fusermount3 -u e.mnt`，`T.cleanup` 兜底。
- **登记**：加入 `SECURE_MOUNT_FILES`；`tests/governance/test-tiers.test.ts` 与 `tests/integration/test-tiers-actual.test.ts` 必须通过。
- **验收记录**须证明正例与反例**实际执行**、没有被 skip：单跑本文件（§4 倒数第二条），贴出两条用例的 ✓ 行与 `skipped 0`；describe 标题带 skip 原因。

### 3.3 golden 与 parity

- **A′ golden**：argv 为 `<ROOT>/…/cipher <ROOT>/…/acme`（`secure-launcher-off-golden.json:140-142,152,161,170,573-575`）。根 realpath 化后 `realpath(dir) === dir`，字节与 TMPDIR 无关、保持不变；`-init` 行（`:307`）不改。
- **机械证明**：`git diff --quiet origin/dev -- tests/fixtures/`；`launcher-off-golden.test.ts`（secure）逐字节比对通过；`off-golden.test.ts`（插件，`secure-off-golden.json`，tier1）通过。「fsname = argv 的 cipher 串」由 conformance C1（`secure-gocryptfs.test.ts:120`、`secure-probe.sh:100`）钉住。
- **parity**：`config-parity.test.ts` 与 `launcher-helper.test.ts:85-98` 不改且必须通过；A 级 fixture 一字不动；§3.1-3 是 fixture 之外的额外对拍。

## 4. 门禁命令

```sh
npm run format:check && npm run typecheck && npm run build
npm run test:tier1
npx vitest run tests/governance/test-tiers.test.ts tests/integration/test-tiers-actual.test.ts
PI_TOOLKIT_TEST_WORKERS=1 npm run test:secure        # 独占本机、挂载表干净；不得与他人 secure 门禁并发
PI_TOOLKIT_TEST_WORKERS=1 npx vitest run --project secure tests/secure/launcher-symlink.test.ts --reporter=verbose  # 验收：0 skipped
git diff --quiet origin/dev -- tests/fixtures/ && echo fixtures-untouched
```

推送前跑全量 `npm test`。跑 secure 前先卸载自己的保险库；`[secure-preflight]` 失败是环境问题，修好再跑。

## 5. 风险与残留

- **gocryptfs 将来规范化 fsname**：传入的已是物理串 ⇒ 无影响；若改写成别的标签，两种模式同时失效，C1 先红。按升级清单先跑 conformance。
- **R2 不可检测**（§1.2/§1.3，已裁定接受）：`<dir>` 物理祖先可被可写父目录属主替换 ⇒ 可用性与目录级完整性受损，不泄露明文。写进 data-encryption README 威胁模型；祖先链规则 (i) 或 cipher dev/ino pin + daemon fd 核对留作另立课题。
- **R1 误报会留下挂载**：只在主动竞争下出现，fail-closed 不卸载，按 §1.7 处理。存量楔死同样需人工确认后卸载一次；运行时诊断已延后。
- **explore 情形 B**（`<mnt>` 链含符号链接）仍以 78 拒绝，属已知限制。
- **测试 harness 的债**：`convert-state.test.ts:1513` 等测试自己用词法 `v.cipher` 挂载，根是物理路径所以无碍；换成符号链接根时会踩同样的坑。

## 6. 已定裁定

1. **cipher 物理祖先链：已定 (ii) 维持现状**（用户 2026-11-05 拍板）。
   - 实现口径：**不新增任何拒绝规则**；只在 `docs/dev/data-encryption/README.md` 的威胁模型里写明「cipher 的物理祖先可被可写父目录的属主替换 ⇒ 检测不到，但机密性由挂载点祖先链规则、cipher 的 0700 与口令兜住，只影响可用性和目录级完整性，且该缺口在本次修复前就存在」。
   - 该项在 §2 第 9 项内，归实现包 P1。
   - 未采纳的 (i) 与其拒绝面见 §1.3，留作以后的独立课题。

## 7. 评审处置表（r2: r_NEWTSAGQ；r3: 第 2 轮复审 + root 裁定）

| #    | 级别  | 要点                                                  | 处置                                                                                                                                                                                                                                 |
| ---- | ----- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Major | TOCTOU 论证过度                                       | 采纳。§1.2 分 R1/R2/R3；fsname 只是标签；`pin.path` 断言只约束挂载点字符串；不以 0700 推出同 uid；不以 private 作证明并指出 `751` 用缓存值。§1.3 定 (ii) 并列出 (i) 拒绝面。§3.1-6 加边界测试；explore §3(a) 同步更正                |
| 2    | Major | 运行时 status 诊断不能证明归属                        | 采纳（用户拍板延后）。删除运行时诊断及其单测                                                                                                                                                                                         |
| 3    | Major | 恢复指引：精确匹配、措辞、确认条件、`-uz` 语义        | 采纳。§1.7：`findmnt --mountpoint` + JSON；「可能…无法证明…需人工确认」；5 条确认条件；`-uz` 不等价于已锁定                                                                                                                          |
| 4    | Major | 真实回归不得用 `realSkipReason()`                     | 采纳。§3.2 自定义 `PLAIN_SKIP`，沿用机器锁与清理；验收记录须有 ✓ 与 `skipped 0`                                                                                                                                                      |
| 5    | Minor | `T.setup` 根未 realpath；`leaseFree(e)`；租约等待预算 | 采纳。显式传物理根并断言；`leaseFree(e)`；`until(…, 5_000)` 后再进行第二轮                                                                                                                                                           |
| 6    | Minor | `secure-contract-parity.json` 是 A 级                 | 采纳。§1.5/§3.3 更正；explore 中「B 类/申报重生成」全部改为 A 级冻结                                                                                                                                                                 |
| —    | 拍板  | A′ 测试根 realpath 化                                 | 写入 §1.6：只改根，不改 normalize/预期/断言/用例/skip                                                                                                                                                                                |
| r3-1 | 裁定  | 插件复检时序描述不准（原文暗示插件也重算 root）       | 采纳。§1.1 改为「普通 launcher 的探测与身份核验每次重算；插件在初始化时解析 `SecureVaultRoots` 并冻结，运行期只重读 mountinfo、用冻结的 root 复检」（`domain.ts:160-165,553-560,613`、`guards.ts:308-315`）；插件代码不改，不依赖 §6 |
| r3-2 | 裁定  | cipher 物理祖先链选 (ii)                              | 采纳。§1.3/§6 标为已定 (ii)，**不加新的拒绝规则**；§2 第 9 项包含 data-encryption README 的威胁模型段落                                                                                                                              |
