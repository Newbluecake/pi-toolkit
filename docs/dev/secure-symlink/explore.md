# pi-secure 在符号链接路径下把自己的挂载判为 foreign —— 调研（explore）

> 任务 #28。**只做读代码与纯静态/纯路径验证**：本轮未运行任何 `tests/secure/**`、未创建或卸载任何挂载、未执行 gocryptfs/fusermount 命令（主仓正在跑含 secure 的门禁，并行会争锁）。
> 标注：**[F]** = 读代码（或读仓库内已留存的现场证据）确认；**[I]** = 推断（给出推断依据）。
> 代码基线：工作区 HEAD（`git status` 干净，含今日 `4d992b96`）。
> 必读来源：`docs/dev/data-encryption/README.md`（不变式/威胁模型）、`docs/dev/test-speed/explore.md` §2.3(b)/§2.5（发现现场）、`plan.md` §2.1/§5、`private-plan.md` §L.1/§2.2。
> **勘误（2026-11-05，随 `plan.md` r2 / 评审 r_NEWTSAGQ）**：
>
> - `tests/fixtures/secure-contract-parity.json` 是 **A 级（永不重生）**，原文误写为「B 类、可申报重生成」，已全部更正。
> - §3(a) 的 TOCTOU 表述已更正：重算只能检测词法别名被重指向，检测不到物理路径上的目录项替换。
> - §5.1 #2/#5 已由用户拍板：不加兼容垫；运行时 status 诊断延后，只写 README 恢复小节。

---

## 0. 结论速览

1. **缺陷是"同一路径的两种拼写"**。[F]（现场证据见 `docs/dev/test-speed/explore.md:96-120`）
   - 普通挂载把**词法** `v.cipher` 交给 gocryptfs（`helper.mjs:3080`）。
   - 挂载判定要求 mountinfo 的 `source` 精确等于**物理** `realCipher`（`helper.mjs:286`、`helper.mjs:3017`、`src/secure/config.ts:342-352`）。
   - gocryptfs 把命令行给的 cipher 串原样当 fsname 写进 mountinfo ⇒ 两者不等 ⇒ `foreign`。
2. **能分歧的只有 `<dir>`（元数据/cipher）一侧，`<mnt>` 一侧不可能分歧**。[F]
   - `<mnt>` 的整条祖先链被强制"不得是符号链接"（`helper.mjs:1142`，规则文档 `plan.md:118`），因此 `physicalPaths().realMnt === path.resolve(v.mnt)` 恒成立。
   - `<dir>` 只 lstat 自己（`helper.mjs:1233`），祖先链无人过问。
3. **private 模式的挂载拼写是一致的**：它在挂载前就取 `physicalPaths(v)`，两侧都用 `realCipher/realMnt`（`private.mjs:664,694,751`，设计见 `private-plan.md:134,177,250`）。同一份代码里有两套写法，普通模式是漏网的那一半。注意：这只说明写法一致，不构成安全证明，private 的就绪轮询 `751` 用的还是缓存值。[F]
4. **后果不是"报个错"**。[F]
   - 挂载成功但判定失败 ⇒ 回滚也判定失败 ⇒ **拒绝卸载**（`helper.mjs:2505` `foreign ⇒ 不动它`）。
   - 明文挂载**留在全局**，`mount.lease` 被 gocryptfs 持有。
   - 之后 `unlock/run/lock/export/status` 全部卡在 `foreign`，**只能手工 `fusermount3 -u`**。
   - 用户想要的"锁定"没有发生，但非 0 退出码容易被当成"已处理"。
5. **插件侧同样判 foreign**。[F]
   - `judgeVaultMount` 用 `join(realpath(dir),"cipher")`（`domain.ts:558`，root 定义 `domain.ts:161-163`）⇒ `PI_SECURE_VAULT` 会话被判 `locked`（`domain.ts:644`），所有输入/工具被拦。
   - 所以**只放宽启动器校验（选项 b）而不改挂载串，会立刻被插件重新判死**。
6. **`$HOME` 本身是符号链接时走另一条路径**（更早、更干净地失败）：`<mnt>` 祖先链检查直接 78 拒绝（`helper.mjs:1142`），init 什么都不会创建。真正命中"挂载成功但判 foreign"的是**只有 `<dir>` 一侧带符号链接**的布局（如 `~/.local/share → 另一块盘`）。[F]
7. **今天已落地的只是测试侧绕过**：`tests/secure/launcher-convert.test.ts:84` 在 `4d992b96`（今日 15:31）改成 `realpathSync(join(REPO,"node_modules"))`。产品侧缺陷一字未改，任何用户布局命中就会踩。[F]
8. **推荐 (a) 挂载前统一 physical（`realCipher`）**：[F]/[I]
   - 改动一处；
   - 恢复 `private-plan.md:250` 明写的契约（`mountPoint = realMnt、source = realCipher`）；
   - 不碰任何判定严格性；
   - 不动 A/A′ golden 的字节（前提是测试根自身是物理路径）。

---

## 1. 完整的路径流

### 1.1 三个根的来源

| 根                                            | 来源                                                                                                   | 规范化                                                           | 出处                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `home`                                        | `os.homedir()`（POSIX 下就是 `$HOME` 原样返回，**不 realpath**）                                       | 无                                                               | `helper.mjs:454-456`；实测 `HOME=/tmp/ps-sym2/home node -e 'os.homedir()'` 原样返回（附录 A.1）[F]          |
| `dir`（元数据 + cipher + mount.lock/lease）   | 设置 `secure.vaults.<name>.dir`，`~/x` 或绝对路径；缺省 `$HOME/.local/share/pi-toolkit-secure/<name>`  | `path.resolve`（**纯词法**）                                     | `helper.mjs:83-88`（`expandSecurePath`）、`90-92`、`217`；`src/secure/config.ts:129-133` [F]                |
| `mnt`（挂载点 = `work/` + `state/` 的父目录） | 设置 `secure.vaults.<name>.mnt`；或 `init/convert/import --path`；缺省 `$HOME/secure/<name>`           | `path.resolve`（纯词法），**随后由布局规则强制祖先链无符号链接** | `helper.mjs:93-95`、`243`；`init.mjs:109-118`；`convert.mjs:2534-2541`；祖先规则 `helper.mjs:1129-1161` [F] |
| `cwd`（项目根）                               | 用户 cwd / `-C <sub>`；`pi-secure` bash 入口把**物理** cwd 放进 `PI_SECURE_ORIG_CWD`（`pwd -P`）       | 词法 → 物理两段式（`resolveRunCwd(...,{physical:true})`）        | `bin/pi-secure:32`、`helper.mjs:3552-3571` [F]                                                              |
| `sessionDir`                                  | 派生 `<mnt>/state/sessions/default`，写进 `<work>/.pi/settings.json`                                   | 词法派生；`verifyRunPaths` 用 realpath 复核                      | `helper.mjs:99`、`2196-2214`、`2140-2172` [F]                                                               |
| 环境变量                                      | `PI_SECURE_VAULT`（名字）/`PI_SECURE_SESSION`/`PI_SECURE_NS`/`TMPDIR=<state>/tmp`/`ARMORY_MEMORY_ROOT` | 由 `v.state` 派生（词法）                                        | `helper.mjs:3531-3545`、`domain.ts:644` [F]                                                                 |

> 关键事实：设置文件里存的 `dir`/`mnt` **就是用户输入（或由 `$HOME` 派生）的词法串，注册时不 realpath**（`helper.mjs:1563-1565` `initWrittenEntry`；`convert.mjs:2632,2768` 同）。`parseSecureConfig` 是纯函数（`helper.mjs:187-266`，parity 测试要求），不做 I/O。[F]

### 1.2 每个环节用哪种拼写

`realDir = realpath(dir)`、`realCipher = <realDir>/cipher`、`realMnt = join(realpath(dirname(mnt)), basename(mnt))`（`helper.mjs:326-350`）。

| 环节                                           | 入口                                                                                                                               | `<dir>` 侧拼写                                                                            | `<mnt>` 侧拼写                                              | 判定/比较用                                                           | 结论                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------- |
| **mount（普通）**                              | `cmdInnerMount`                                                                                                                    | **词法** `v.cipher` → `gocryptfs -nonempty -- v.cipher v.mnt`（`helper.mjs:3080`）        | 词法 `v.mnt`（但 == `realMnt`）                             | `waitMountState`(3089) / `verifyMountPointIdentity`(3017) 用 **物理** | **不一致点** [F]                      |
| **lease（flock）**                             | `leaseChainArgs`（`helper.mjs:4920-4922`）                                                                                         | 词法 `v.lease`                                                                            | —                                                           | 按 inode flock，两种拼写等价                                          | 无影响 [F]                            |
| **mount 前置探测**                             | `probeMountState`（`366-383`）                                                                                                     | 物理                                                                                      | 物理                                                        | `vaultMountState`(283-287)                                            | 无影响 [F]                            |
| **mount 前置布局校验**                         | `checkLayout`（`1226-1271`）                                                                                                       | 词法 lstat（`1231-1235`）+ 位置规则**词法/物理双查**（`1072-1109`）                       | 词法 lstat（`1248-1266`）+ 祖先链（`1142`，符号链接即拒绝） | ——                                                                    | 见 §2 情形 B [F]                      |
| **unmount**                                    | `finalize`→`spawnUnmount`：`flock … fusermount3 -u v.mnt`（`2431-2442`）                                                           | —                                                                                         | 词法（== 物理）                                             | `foreign ⇒ 不动它`（**2505**）                                        | 判定卡住时**不卸** [F]                |
| **status**                                     | `describeVault`（`3312-3347`）                                                                                                     | 词法（打印 `dir`）                                                                        | 物理（探测）                                                | `vaultMountState`                                                     | foreign 会直接打在状态列（`3344`）[F] |
| **run**                                        | `cmdRun`→`unlockVault`→`resolveRunCwd(physical)`→`verifyRunPaths(realMnt)`→`runPiChild(--session-dir v.sessionDir)`（`3600-3635`） | 词法（sessionDir 传给 pi）                                                                | 物理（校验）                                                | realpath 复核（`2154,2162`）                                          | 挂载判定已是前置门槛 [F]              |
| **convert**                                    | `unlockVault(v,{postMount:false})`（`convert.mjs:2796`）后全程物理（`2798-2802` `T.dirTarget(realCipher)`）                        | 挂载词法 / 后续物理                                                                       | 物理                                                        | realMnt/realCipher                                                    | 挂载判定失败即回滚 74 [F]             |
| **export / import / --verify-password / 迁址** | `ownRawMount`→`unlockVault`（`archive.mjs:1739`）；导出前置要求 `probeMountState === "absent"`（`archive.mjs:626-627`）            | 同上                                                                                      | 物理（`1838`）                                              | 物理                                                                  | 见 §2.3 [F]                           |
| **private（run --private / init --private）**  | `runPrivate`                                                                                                                       | **物理** `realCipher`（`private.mjs:694` → `gocryptfsSpawnSpec`，`helper.mjs:4940-4946`） | **物理** `realMnt`                                          | 物理（`private.mjs:751`，缓存值），记录里也存物理（`257-267`）        | **拼写一致** [F]                      |
| **init**                                       | `createLayout` + `gocryptfs -init -- v.cipher`（`init.mjs:158`）+ 首次 `unlockVault`（`init.mjs:218`）                             | `-init` 词法（不产生 mountinfo，无碍）；首挂走上面的普通挂载                              | 词法                                                        | ——                                                                    | 首挂会踩 [F]                          |

> 一句话：**唯一"该物理却给了词法"的参数是 `gocryptfs` 的 cipher 串**。`<mnt>` 侧的词法==物理由祖先链规则保证（`helper.mjs:1113-1114` 的注释就是这个意思："符号链接层级直接拒绝，保证词法链＝物理链"）。[F]

---

## 2. 触发条件与用户可见症状

### 2.1 情形 A —— `<dir>` 一侧（含 cipher）有符号链接祖先，`<mnt>` 链干净 ⇒ **挂载成功但判 foreign**

调用链（全部代码可查）：

1. `checkLayout` 通过（dir 只查自身，`1233`）；
2. `pinMountPoint` 固定 mnt 的 dev/ino（`2912-2948`）；
3. `gocryptfs … v.cipher v.mnt`（`3080`）成功；
4. `waitMountState(v,"mounted",3_000)` 三秒轮询拿到 `foreign`（`3089-3091`）；
5. 子进程 `exit 1` → `doMount` 抛 `CliError(EXIT.FAIL)`（`3178`）；
6. `unlockVault` catch → `rollbackFreshMount`（`3244-3262`）；
7. `finalize` 判 `foreign` ⇒ **"上挂着别的文件系统，不动它"**（`2505`）⇒ 打印"本次挂载未能撤销——保险库可能仍挂载"。

真实用户场景（按命中概率排序）[I]（依据：`dir`/`mnt` 的派生规则 + 祖先规则的作用域）：

| #   | 布局                                                                                                  | 命中哪一侧 | 结果                                                                    |
| --- | ----------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------- |
| A1  | `~/.local` 或 `~/.local/share` 是符号链接（指到另一块盘；手工布局里很常见）                           | dir 链     | 每次 `init` 首挂 / `unlock` / `run` / `convert` / `export` 失败并留挂载 |
| A2  | 设置里 `secure.vaults.<n>.dir` 落在符号链接前缀下（如 `dir: /data/vaults/x`，而 `/data → /mnt/data`） | dir 链     | 同上                                                                    |
| A3  | 沙箱/测试用的 `$HOME` 本身挂在符号链接路径下（如 worktree 的 `node_modules` 是符号链接 —— 今日现场）  | dir 链     | 同上（`docs/dev/test-speed/explore.md:96-120` 的 2175 s 事故）          |
| A4  | `$HOME` 是符号链接，但用 `--path` 把 `<mnt>` 放到了链外（如 `/tmp/...`）                              | dir 链     | 同上                                                                    |

用户可见症状 [F]：

- 终端（子进程继承 stdio，所以这条**看得到**）：`gocryptfs 返回成功，但 mountinfo 不符（foreign），请 pi-secure status <name>`（`helper.mjs:3091`）。
- 随后还会打印：`<name>：<mnt> 上挂着别的文件系统，不动它` + `<name>：本次挂载未能撤销——保险库可能仍挂载…（必要时 fusermount3 -uz <mnt>）`（`2505`、`3260-3262`）。
- 退出码：`unlock`/`run`/`init`(首挂) = **1**（`EXIT.FAIL`）；`convert` = **74**（回滚不完整，`EXIT_IO`，现场见 `docs/dev/test-speed/explore.md:113`）[F]。
- `pi-secure status`：`<name>: foreign  layout ok  mnt …`（`3344`，状态列直接打英文 token），退出码 0 ⇒ **看起来"只是状态怪"** [F]。
- 之后的 `unlock`：`<mnt> 上挂着别的文件系统（mountinfo 不符），拒绝挂载`（`3059`，在口令提示之前）。
- `lock`：退出 1，`不动它` ⇒ **锁不上**。
- `export`（文档里的救援路径）：`probeMountState !== "absent"` ⇒ 拒绝（`archive.mjs:626-627`）[F]。
- `run --private`：`plainMountLeaseGate`/Q10 会因"全局挂载存在/租约被持有"拒绝（76）[I]（依据 `private.mjs:244-266` 的 stale/lease 判定顺序与 `helper.mjs:3060`）。
- 插件：`pi` 在库内被判 `locked`（`domain.ts:644` + `558`），理由"挂载点上不是它自己的 gocryptfs 挂载" ⇒ 输入/工具全拦 [F]。

**数据/安全后果**（分级）[F]/[I]：

| 项            | 判定                                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据丢失      | 无自动删除路径：`checkLayout` 在 `mounted !== "absent"` 时跳过哨兵检查（`3316-3320`），`init` 因 `<dir>` 已存在而拒绝（`2011-2012`），`status` 的恢复提示只是文案。**没有代码会自动 rm** [F] |
| 明文暴露      | 挂载**是成功的**（属于用户自己的、本来就全局可见的普通挂载），所以不产生新的暴露面；但 `lock --lazy` 之后的"看起来锁上了"是**假的**——它失败并退出 1 [F]                                      |
| 租约/挂载泄漏 | gocryptfs 持有 `mount.lease` 的 fd 9 直到卸载（`helper.mjs:3078-3082` 的 lease 链）⇒ 后续所有"取租约"的路径（含 `--private`）被挡；挂载点一直被占，`<mnt>` 不可用于新布局 [F]                |
| 手工恢复      | 唯一出口是 `fusermount3 -u <mnt>`（文案里给了 `-uz` 兜底）；用户若相信"非 0 退出码=已回滚"，就会留下一个**活着的全局明文挂载**——这是本次最值得修的一条 [I]                                   |

### 2.2 情形 B —— `<mnt>` 祖先链里有符号链接 ⇒ 早退 78（不挂载、无泄漏）

`mntAncestorProblems` 从 `dirname(mnt)` 一路检查到 `/`，任一级是符号链接即拒绝（`helper.mjs:1142`，规则文本 `plan.md:118`）。`createLayout`（`2028`）与 `__mount` 的 `checkLayout`（`1272`）都会执行它。

- 典型布局：`$HOME` 本身是符号链接（如 ostree/`/home → /var/home` 且 `HOME=/home/user`）、`~/secure` 被指到另一块盘。
- 症状：`挂载点祖先目录检查失败： … 须为真实目录（不得是符号链接/文件）`，退出码 **78**，**什么都不创建、什么都不挂载**。[F]
- 意义：这条规则存在，正是为了让"词法链＝物理链"成立。也就是说，**设计上已经承认"符号链接会毁掉词法比较"**，只是没对 `<dir>` 侧做同样的事。[F]
- 注意：插件侧不跑祖先规则（`domain.ts` 只做 `realpathOr` + 位置嵌套），所以存在"启动器拒绝、插件认为可用"的不对称（用户看到 `status` 说 incomplete，但 `pi` 仍可能判 secure/locked 混合）[I]。

### 2.3 旁证：为什么只有一部分 secure 套件全灭

`tests/secure/helpers.ts:37` 的 RealHarness **已经**对自己的根做 `realpathSync(mkdtempSync(...))`，所以 `/tmp` 系的套件不受影响。`launcher-convert` 的 scratch 根固定在 `<REPO>/node_modules/.cache/v7`（`launcher-convert.test.ts:76-84`），而 worktree 里的 `node_modules` 是符号链接 ⇒ 只有它全灭。[F]（现场：`docs/dev/test-speed/explore.md:113-120`）

---

## 3. 修复方案选项（只列选项与影响面，不含实现）

先把三条"不可动"的约束摆出来，选项才有意义：

- **C1** 挂载判定必须继续"严格"：`source` 必须证明是本库的 cipher，否则 `finalize` 的 `foreign ⇒ 不动它`（`2505`）就失去意义（绝不卸载无法证明归属的挂载）。[F]
- **C2** 判定是**纯函数**并被 parity 钉住：`helper.mjs:283-287` ↔ `src/secure/config.ts:342-352`，由 `tests/fixtures/secure-contract-parity.json`（**A 级冻结，永不重生**：任何改动都等于宣告判定行为变更）与 `tests/secure/config-parity.test.ts:42-48` 双向校验。[F]
- **C3** 插件侧另有同一份判定（`domain.ts:558`），任何放宽都必须两边同步，否则 `run` 起来立刻 LOCKED。[F]

### (a) 挂载前统一 realpath（推荐）

把 `cmdInnerMount` 传给 gocryptfs 的 cipher（必要时连 mnt）换成 `physicalPaths(v).realCipher`（`realMnt` 本来就相等），与 `private.mjs:694` 的 `realCipher realMnt` 同族。不复用 `gocryptfsSpawnSpec`（`helper.mjs:4940-4946`），因为它带 `-fg/-notifypid`。

- 影响面：`helper.mjs` 一处（`3080`）。建议顺手把该 argv 抽成可纯测的函数：今天它是内联的，只有 `leaseChainArgs` 被单测钉住，`launcher-private-unit.test.ts:1285` 只覆盖 private 分支。
- 安全不变式：
  - 判定**不变严也不变松**，只是让被比较的两个串同族 ⇒ 恢复 `private-plan.md:250` 明写的契约；插件/`status`/`archive`/私有实例记录全部自动一致。[F]
  - TOCTOU（r2 更正）[I]：
    - fsname 只是挂载者自填的标签，内核不校验，不能证明 gocryptfs 打开的是哪个 inode。
    - 挂载后重算 `realCipher` **只能检测"词法别名被重指向"**（重算字符串 ≠ fsname）。(a) 之后 argv 里已无别名，所以这种情况实为误报，fail-closed、不卸载。
    - **检测不到**物理路径上的目录项被替换（realpath 字符串不变、fsname 相同，打开的却不是受检目录），也检测不到"变了又恢复"。
    - 这一窗口今天同样存在。(a) 消除了别名在 open 时的影响，收窄而非新增风险。
    - 能替换物理目录项的不只是同 uid：`<dir>` 物理祖先链上任一可写层的属主都能做到。详见 `plan.md` r2 §1.2–§1.3。
  - 顺带暴露一个**既有**缺口（不属于本任务）：`<dir>` 的祖先链完全没有可信性校验（只有 `<mnt>` 有，`1142`）。"`realpath(dir)` 之后再挂"只是把物理串固定下来；真正的加固是给 dir 的物理祖先链加属主/可写规则（`plan.md` r2 §1.3 的 (i)，r2 推荐暂不做，写入威胁模型）。[F]/[I]
  - **不**需要放宽 `foreign` 的语义 ⇒ C1 保持。(a) 之后，一个坏掉的挂载依然不会被误卸。[F]
- 风险/成本：
  - A′ 冻结 golden `tests/fixtures/secure-launcher-off-golden.json:140-142,152,573-575` 记录了 fake gocryptfs 的 argv `gocryptfs -nonempty -- <ROOT>/…/cipher <ROOT>/…/acme`。测试根在 `mkdtemp(tmpdir())`（`launcher-off-golden.test.ts:78-79`），`tmpdir()` 不是符号链接时 realpath==词法 ⇒ **字节不变**。若 TMPDIR 是符号链接，会先被 `tests/secure/preflight.ts` 前置 fail-fast 拦掉（`data-encryption/README.md` 的 preflight 段）[I]。
  - 升级后，**已经**被旧版本以词法串挂上的挂载仍然读作 `foreign`，需要人工确认后手工 `fusermount3 -u` 一次（用户已拍板不加 (b′) 兼容垫）[I]。
  - 不改变设置文件内容 ⇒ 无迁移、无 heal、无设置锁交互。[F]

### (b) 校验时同时接受原样路径与 realpath

把"属于我们"从 `source === realCipher` 放宽成 `source ∈ {realCipher, v.cipher}`（或等价的"源集合"）。

- 影响面（**面最大**）[F]：
  - `vaultMountState` 签名/语义（`helper.mjs:283-287` **和** `src/secure/config.ts:342-352`）；
  - `domain.ts:558`；
  - `tests/fixtures/secure-contract-parity.json`：**A 级冻结**，改它等于宣告判定行为变更，不存在"申报后重生成"的路径；
  - 所有以 `realCipher` 做"归属扫描"的地方（`private.mjs:421`、`archive.mjs` 的 mount 检查、`domain.ts` 的 D4 已知地址族）。
- 安全不变式：把"唯一物理身份"降级成"两个名字之一"。`fsname` 是挂载者自填的标签，本来就不是强判据；但"相等即我们"这条的**可审计性**会分叉，而且 C2/C3 要求两边加插件同步放宽，否则 `run` 之后立刻 LOCKED。[F]
- 它**不解决根因**：挂载串仍是词法，`private.json`（物理）、`scanCipherHolders`（物理）、`archive anchorVaultRoot`（物理）等仍按物理串比对。要么全仓跟着改，要么留下"启动器说 mounted、其他子系统说 foreign"的第二类不一致。[I]
- 唯一优点：能救**存量**楔死状态（不用手工 fusermount）。

### (b′) 变体：按"解析后同一物理路径"比较，而不是按"两个字符串之一"

`source` 先 `realpathNearest` 再与 `realCipher` 比（或由调用方传入"可接受源集合"，以保持纯函数）。

- 语义上比 (b) 更干净（"同一 inode 的两种拼写"而不是"两个白名单字符串"），且不依赖用户拼写。
- 但它把 I/O（realpath）塞进了一个今天**纯**的判定函数（C2）；parity fixture（A 级冻结）需要改契约；插件侧每次 `tool_call` 复检都会多一次 realpath。[I]
- 建议定位：**只作为 (a) 的临时兼容垫**（一个版本后删掉），不当作长期判据。（用户已拍板：不加。）

### (c) 在注册或配置时就规范化（持久化物理路径）

在 `init` / `convert` / `import` / `init --fix-settings` 写入设置时，把 `dir`/`mnt` 存成物理路径（`realpathNearest` 或 `realpath`），并给存量条目加 heal/迁移。

- 影响面 [I]：
  - 写入口 `initWrittenEntry`（`1563-1565`）、`convert.mjs:2632,2768`、`archive.mjs` 的登记；
  - `settings-lock.ts` 的 CAS 比较（entry 字节变了 ⇒ 与 `expectEntry` 的比较面要跟着变）；
  - **大量测试**里的 `join(home, …)` 断言；
  - `status` 的 `dir`/`mnt` 行会从用户输入的串变成物理串（用户可见）。
- 安全不变式：把"词法＝物理"提升为设置文件的不变式，一次性解决所有比较方（插件/status/archive/私有记录）。代价：
  - 设置文件变成**机器相关**（磁盘挂载点改名、`$HOME` 位置变化即失效），需要 heal 或 fail-closed 78；`settings-lock` 已有 heal 先例，但这里语义更重。[I]
  - `parseSecureConfig` 必须保持纯（C2）⇒ 规范化只能发生在**写**侧，读侧遇到旧条目仍需 heal 或按现状处理。[F]
  - 风险点：`realpath` 一个还不存在的目标（首挂前 `<mnt>` 已存在、`<dir>` 也刚建，问题不大；但 `import` 到新位置时要小心 `realpathNearest`）。[I]
- 与 (a) 的关系：(c) 是"存储层统一"，(a) 是"使用层统一"。做了 (c) 就可以不做 (a)；两者都做会冗余但无害。[I]

### (d) 变体：把 `<mnt>` 的同一条不变式也加到 `<dir>`（拒绝而非规范化）

给 `<dir>` 也套 `mntAncestorProblems`（`1129-1161`），"词法链＝物理链"就全域成立，现有词法 argv **不用改**。

- 优点：零判定改动、零 golden 改动、逻辑上最"自洽"（`plan.md:118` 的口径延伸）。
- 代价：
  - **拒绝掉一批合法布局**：`~/.local/share → 另一块盘` 是常见的省空间做法；属主/可写规则还会拒掉 0775 家目录下的默认 `dir`。
  - 安全增益有限：只覆盖"其他 uid 替换 `<dir>` 物理祖先"这一面，其影响是可用性和目录级完整性，不是明文泄露（`plan.md` r2 §1.3）。
  - 因此属于"为了不动一行挂载参数而牺牲可用性"。与 `plan.md:58` 的隐含假设（"`$HOME` 不经符号链接时它就是物理路径"）同源，但那条假设本身没有被强制，也不该被强制。[I]

### 选项对照

| 选项                    | 改动面                       | 判定严格性 (C1)        | parity/golden (C2)           | 插件同步 (C3)       | 救存量楔死   | 可用性                   |
| ----------------------- | ---------------------------- | ---------------------- | ---------------------------- | ------------------- | ------------ | ------------------------ |
| **(a) 挂载用 physical** | 1 处 + 抽函数                | 不变（更贴契约）       | A′ golden 需复跑确认字节不变 | 无需改              | 否           | ✔ 修复                   |
| (b) 校验收两种拼写      | helper+config+domain+fixture | **放宽**               | 改 A 级冻结契约（行为变更）  | **必须同步**        | ✔            | ✔ 修复                   |
| (b′) 按物理解析比较     | 同上 + I/O                   | 语义不变（实现变复杂） | 改 A 级冻结契约（行为变更）  | 必须同步            | ✔            | ✔ 修复                   |
| (c) 注册时规范化        | 写侧多处 + heal + 大量测试   | 不变                   | 设置相关 golden 需核         | 无需改（但见 heal） | 否（需迁移） | ✔ 修复，但引入机器相关性 |
| (d) dir 也拒绝符号链接  | 1 处                         | 不变                   | 无                           | 无                  | 否           | ✘ 拒绝合法布局           |

---

## 4. 现有测试覆盖

### 4.1 今天谁在覆盖/会受影响

| 文件                                                                                                                                           | 类型                           | 与本缺陷的关系                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/secure/config-parity.test.ts` + `tests/fixtures/secure-contract-parity.json`                                                            | tier1，纯函数                  | 钉住 `vaultMountState(mountinfo, realMnt, realCipher)` 的 10 个用例（含 "gocryptfs with another source ⇒ foreign"、"stacked: last line wins"）。fixture 为 **A 级冻结**，任何 (b)/(b′) 都意味着改动冻结契约（行为变更）；fixture 头部注释明写"realMnt/realCipher are already realpath'd"[F] |
| `tests/secure/launcher-fuse.test.ts`                                                                                                           | secure，真实挂载               | `unlock/lock/status/run` e2e；根由 `RealHarness` 提供且已 realpath（`helpers.ts:37`）⇒ **今天不可能命中**，所以也起不到保护作用 [F]                                                                                                                                                         |
| `tests/secure/launcher-off-golden.test.ts`                                                                                                     | secure + A′ golden             | fake gocryptfs 记录 argv（`secure-launcher-off-golden.json:140-142`）⇒ (a) 的**唯一字节风险点**；真实挂载块用 `mountDirect` 自己挂（`614-627`，`join(dir,"cipher")` 词法，根是真路径所以无碍）[F]                                                                                           |
| `tests/secure/launcher-convert.test.ts`                                                                                                        | secure，真实挂载 + convert e2e | 今日现场受害者；`4d992b96` 已在**测试侧** `realpathSync` 绕过（`:84`）⇒ 产品缺陷不再被这条 e2e 覆盖 [F]                                                                                                                                                                                     |
| `tests/secure/helper-v0-api.test.ts` / `convert-state.test.ts` / `archive.test.ts` / `init-cleanup-real.test.ts` / `launcher-private*.test.ts` | secure，真实挂载               | 都用 realpath 后的根；`convert-state.test.ts:1513` 自己执行 `gocryptfs … v.cipher v.mnt` 挂载（词法）⇒ 将来若给这些 harness 换成符号链接根，会同样踩坑 [F]                                                                                                                                  |
| `tests/conformance/secure-gocryptfs.test.ts`（C1–C5）、`secure-convert*.test.ts`                                                               | conformance（自门控）          | C1 钉住 mountinfo source 等于命令行 cipher 串，C2 钉住 `-nonempty` 语义；XC4/XC5/XC8/XC9 走 export/convert 真实挂载 [F]                                                                                                                                                                     |
| `tests/secure/launcher-private-unit.test.ts:1249,1285`                                                                                         | secure                         | 钉住 `gocryptfsSpawnSpec`（private，已是物理）与 `leaseChainArgs`；**普通挂载的 argv 没有任何单测** [F]                                                                                                                                                                                     |
| `tests/secure/preflight.ts`                                                                                                                    | secure 前置                    | 已有 fail-fast 家族（残留挂载/并发运行/符号链接 TMPDIR）——修复后的回归应在此扩展，或加同类断言 [F]                                                                                                                                                                                          |

### 4.2 修复需要新增的测试

> 最终测试设计以 `plan.md` r2 §3 为准（含竞争边界测试、普通模式门控、精确 mountinfo 匹配等更正）。

1. **tier1 纯单元（最便宜，先做）**
   - 符号链接祖先下 `physicalPaths()` 的三元组：`realCipher ≠ v.cipher`、`realMnt === v.mnt`（用 `mkdtemp` + `symlinkSync` 构造，无挂载）。
   - 普通挂载 argv：若按 (a) 把 argv 抽成函数，直接断言"传的是 `realCipher`"。**这条是防回归的关键**（今天没有任何单测覆盖它）。
   - `vaultMountState`：`source=物理` ⇒ mounted、`source=词法` ⇒ foreign。把本报告的契约写成断言；不进 fixture（A 级冻结）。
2. **情形 B 的纯单元**：`mntAncestorProblems` 对符号链接祖先返回"须为真实目录"（今天 `convert-preflight.test.ts:144-150` 只覆盖了位置规则，没覆盖挂载点祖先链）。
3. **secure 项目真实挂载回归（必须有）**：建议新文件 `tests/secure/launcher-symlink.test.ts`，在 `tests/tiers.ts` 的 `SECURE_MOUNT_FILES`（`tiers.ts:51-63`）登记，并取 `gocryptfs-test-lock.ts` 的机器锁。门控只查普通模式的必要条件，**不用** `realSkipReason()`（它要求 userns）。
   - 布局：`<scratch>/real` 与 `<scratch>/link → real`；`HOME=<scratch>/link/home`（**dir 链含符号链接**），`<mnt>` 用 `--path` 放到链外（如 `/tmp` 下的 mktemp，符合"mnt 祖先须属我/root + sticky"的规则）。
   - 断言：
     - `init` 成功；
     - `unlock` 报"已解锁"（今天会报 foreign）；
     - `/proc/self/mountinfo` 里该挂载点行的 `source === realpath(cipher)`（**直接钉住 fsname 契约**）；
     - `status` 状态列不是 `foreign`；
     - `lock` 报"已卸载"，且挂载真的消失。
   - 反例断言（防过度放宽）：在同一挂载点上挂**另一个** gocryptfs（不同 cipher），仍必须判 `foreign` 且**拒绝卸载**。
4. **`launcher-convert` 的去绕过**：保留 `realpathSync`（无害），但**再加**一个"根故意经符号链接"的用例，让 convert e2e 真正覆盖这条路径。（plan r2 决定不加：convert 与 unlock 共用 `__mount`，已由第 3 条覆盖。）
5. **插件一致性**：`tests/secure/domain.test.ts` 补一条"挂载的 source 是 dir 的物理拼写 ⇒ secure（不是 locked）"，用注入的 mountinfo（纯函数，无挂载）。

---

## 5. 风险与需要用户拍板的点

### 5.1 需要拍板

1. **选哪条路**：推荐 **(a) 挂载前统一 physical**（1 处、判定不变、与 private 一致、恢复 `private-plan.md:250` 的契约）；(c) 作为后续（如果希望 `status`/设置里永远是物理串）；(d) 不建议（牺牲合法布局换零改动）。需要用户确认，尤其是"是否接受升级后必须手工 `fusermount3 -u` 一次"。
2. **(a) 是否配一个临时兼容垫 (b′)**：为了让存量被楔死的挂载不必手工处理，可以在一个版本内接受"source 物理解析后等于 realCipher"。代价是改动 A 级冻结的 parity 契约（行为变更）、插件同步、多一次 I/O。推荐：**不加**（一次性手工解锁更简单，且不留放宽的判定）。**已拍板：不加。**
3. **情形 B（`$HOME`/`~/secure` 是符号链接 ⇒ 78）是否要在本次一并处理**：放宽祖先规则会削弱 L0 #2 的"祖先可替换性"保证（`plan.md:118`、`helper.mjs:1129-1161`），属于**安全口径变更**，不该顺手做。推荐：保持现状，并把这条写成明确限制（`status` 的提示文案 + `plan.md` 残留清单）。
4. **A′ 冻结 golden 的处置权**：若在某个环境下 `realpath(测试根) ≠ 测试根`，(a) 会让 `secure-launcher-off-golden.json` 的 argv 行变化。推荐：**不改 golden**，而是让该套件像 `helpers.ts:37` 一样把自己的根 realpath 化（或依赖已有 `preflight.ts` 的符号链接 TMPDIR fail-fast）。**已拍板：只把测试输入的根 realpath 化，normalize/预期/断言/用例/skip 不改。**
5. **是否补一条 `status` 诊断提示**（纯 UX，不改语义）：当判定为 `foreign` 且该挂载点的 `source` 解析后等于本库 `realCipher` 时，提示用户。**已拍板：运行时诊断延后，本包只写 README 恢复小节**。评审指出：source 解析一致也无法证明归属，恢复小节须写成"可能…需人工确认"，并用精确的 mountPoint 匹配（见 `plan.md` r2 §1.7）。

### 5.2 其它风险

- **本轮不能验证真实挂载**：本报告所有"挂载成功/不成功"的结论都来自代码路径与仓库内已留存的现场证据（`docs/dev/test-speed/explore.md` §2.3），**没有**在任何机器上复现挂载。[F]/[I]
- **`foreign` 判定的严格性不能碰**：`finalize` 的 `foreign ⇒ 不动它` 是"绝不卸载无法证明归属的挂载"这一安全不变式的实现（`2505`）；(b) 方向如果实现成"看起来像我们就卸"，会直接违反它。[F]
- **gocryptfs 行为依赖**：(a) 的前提是"fsname 就是命令行给的串"（今日 1.8.0 的实测证据见 `explore.md` §2.3；conformance C1 钉住）。若未来 gocryptfs 自己规范化 fsname，(a) 变成无操作（无害），而 (b) 会变成无用的放宽。[I]
- **插件与启动器的口径必须一起看**：只改启动器会留下 `status`/插件/私有记录三方不一致；任何选项合并前都应跑 `tests/secure/domain.test.ts` + `config-parity.test.ts`。[F]
- **测试侧绕过的债**：`4d992b96` 让 `launcher-convert` 不再暴露该缺陷；若不加 §4.2-3 的真实挂载回归，下一次回归不会被任何门禁抓到。[F]

---

## 附录 A —— 本轮做过的验证（均为纯路径/纯函数，无挂载）

### A.1 `os.homedir()` 不 realpath

```
$ HOME=/tmp/ps-sym2/home node -e 'console.log(require("os").homedir())'
/tmp/ps-sym2/home            # 该目录下 .local/share 是符号链接
```

（对应 `helper.mjs:454-456`）[F]

### A.2 情形 A：dir 链含符号链接 ⇒ 词法/物理 cipher 分歧，判定 foreign

环境：`/tmp/ps-sym2/home/.local/share → /tmp/ps-sym2/data/share`；`<mnt>` = `~/secure/acme`（真实目录）。

```
lex dir     /tmp/ps-sym2/home/.local/share/pi-toolkit-secure/acme
lex cipher  /tmp/ps-sym2/home/.local/share/pi-toolkit-secure/acme/cipher
real cipher /tmp/ps-sym2/data/share/pi-toolkit-secure/acme/cipher
realMnt     /tmp/ps-sym2/home/secure/acme | mnt unchanged: true
state(source=lexical)  ⇒ foreign
state(source=physical) ⇒ mounted
```

调用的是 `H.physicalPaths` / `H.vaultMountState` / `H.mntAncestorProblems` 本体（`import` 无副作用）。[F]

### A.3 情形 B：mnt 祖先链含符号链接 ⇒ 祖先规则拒绝

```
$ (home/secure → real/secure)
mntAncestorProblems: [ '/tmp/ps-sym3/home/secure 须为真实目录（不得是符号链接/文件）' ]
```

（对应 `helper.mjs:1142`，`init`/`__mount` 都会触发，退出 78）[F]

### A.4 交叉核对

- `git show --stat 4d992b96`：测试侧绕过，产品侧无改动。
- `git status --short` 为空（本轮未改任何既有文件）。

---

## 附录 B —— 引用索引（关键行）

| 断言                          | 位置                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| 判定要求 source == realCipher | `src/secure/bin/helper.mjs:281-287`；`src/secure/config.ts:342-352`                                      |
| `physicalPaths` 三元组        | `src/secure/bin/helper.mjs:326-350`                                                                      |
| 普通挂载传词法 cipher         | `src/secure/bin/helper.mjs:3080`（`waitMountState` 3089 / 报错 3091 / 身份核验 3017）                    |
| private 挂载传物理 cipher     | `src/secure/bin/private.mjs:664,694,751`；`helper.mjs:4940-4946`                                         |
| mnt 祖先链禁符号链接          | `src/secure/bin/helper.mjs:1129-1161`（`1142`）；`plan.md:118`                                           |
| dir 只查自身                  | `src/secure/bin/helper.mjs:1231-1235`                                                                    |
| foreign ⇒ 不动它              | `src/secure/bin/helper.mjs:2505`                                                                         |
| 卸载用词法 mnt                | `src/secure/bin/helper.mjs:2431-2442`                                                                    |
| 注册保持词法                  | `src/secure/bin/helper.mjs:1563-1565`；`convert.mjs:2632,2768`                                           |
| 首挂 = unlockVault            | `src/secure/bin/init.mjs:158,218`                                                                        |
| 插件同判定                    | `src/secure/domain.ts:161-163,553-568,644`                                                               |
| 挂载串契约（设计）            | `docs/dev/data-encryption/private-plan.md:44,134,177,250,595`；`plan.md:58`                              |
| 现场证据                      | `docs/dev/test-speed/explore.md:96-120`                                                                  |
| 测试侧绕过                    | `tests/secure/launcher-convert.test.ts:84`（commit `4d992b96`）、`tests/secure/helpers.ts:37`            |
| 冻结 golden 的 argv           | `tests/fixtures/secure-launcher-off-golden.json:140-142,152,573-575`                                     |
| parity 契约（A 级冻结）       | `tests/fixtures/secure-contract-parity.json`（mountinfo 段）、`tests/secure/config-parity.test.ts:42-48` |
| 分层登记                      | `tests/tiers.ts:51-63`（SECURE_MOUNT_FILES）                                                             |
