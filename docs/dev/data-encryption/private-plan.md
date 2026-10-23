# `pi-secure run --private`（私有挂载命名空间）实施方案 — r3

> 状态：r3（2026-10-23；同日补记用户拍板：§9 的 Q-L0/Q2/Q10/Q3 已定，退出码表随 convert-plan r3 删除 79）。r1 经评审（`/tmp/secure-private-review-r1.json`：3 Blocker / 5 Major / 4 Minor）逐条处置，见「§R1 评审处置」；r2 复审（`/tmp/secure-private-review-r2.json`：其余项闭合、§L 无新 Blocker，余 2 个 Blocker）按 dev-flow 第三轮由主会话裁定，处置见文末「§R2 评审处置」。
> r2 同时纳入用户 2026-10-23 的新拍板：**保险库布局改为挂载点即 `~/secure/<名字>/`**，真实项目路径为 `~/secure/<名字>/work`（§L，独立前置包 L0）。
> 前置：可行性实测 [`private-ns-probe.md`](./private-ns-probe.md)（探针 `scripts/dev/secure-ns-probe.sh`）、现方案 [`plan.md`](./plan.md) r4（D1–D9、§2.1 布局与哨兵、§2.2 命令面、§2.2.1 参数审查、§2.4 两阶段域判定、§2.5 有界收尾、§5 残留表）、[`acceptance.md`](./acceptance.md)。并列方案 [`convert-plan.md`](./convert-plan.md) r3（两份共用 §10 退出码表与 §7.1 包顺序）。本文只写方案，不改代码。
> 适用：pi 1.3.0（peer `>=1.0.0 <1.4.0`）、gocryptfs ≥1.8、util-linux 提供 `unshare --map-root-user/--map-user/--map-group/--propagation` 与 `flock`。

---

## 0. 一页结论

- **布局（§L，L0 包，先于一切）**：`<dir>`（缺省 `~/.local/share/pi-toolkit-secure/<名字>/`）只放密文与元数据（`cipher/`、`mount.lock`、`mount.lease`、`private.json`）；**挂载点 `<mnt>` = `~/secure/<名字>/`**（0700 目录，未挂载时只含 `work`、`state` 两个 0 字节 0400 哨兵）；项目根 `~/secure/<名字>/work`，私有区 `~/secure/<名字>/state`。入口符号链接取消，`--path` 改为指定挂载点位置。
- **做什么**：`pi-secure run <名字> --private` 把 gocryptfs 明文挂载放进一个**只属于这次 pi 进程树**的挂载命名空间。外部同用户进程按路径看到的 `~/secure/<名字>/{work,state}` 始终是哨兵；全局 mountinfo 里没有这个挂载。
- **互斥靠内核锁 + 成员证据**（§2.1、§3.1–§3.3）：每一次 gocryptfs 启动（普通与私有）都在 `mount.lease` 的 flock 之下；锁 fd 9 由**外层 shell** 以无 CLOEXEC 方式打开并锁住（Node 启动时会给继承的 fd 置 CLOEXEC，`stdio:"inherit"` 不传它——已实测），之后凡需要持锁的 Node 子进程（gocryptfs、内层 unshare→pi）都经**显式 stdio 槽 9** 拿到它。私有模式 gocryptfs 用 `-fg` 作为 P1 的直接子进程，自己持锁直到退出。判活不只看租约：只有「租约可获取 **且** 没有任何进程处于记录的 mount ns」才判 stale；任一证据表明仍有成员 ⇒ 不释放、不允许新挂载。r1 的 F1′「超时静默放行」删除。
- **交接无窗口，删除者在 ns 外**（§2.2、§3.2、§3.6）：P0 认领时写入随机 `instanceId`；shell 链锁住租约后 exec 成 unshare→P1，不留包装进程；P1 的每次记录变迁都是对 `instanceId` 的读-比较-写。**P1 从不删除记录**：它完成 ns 内收尾后直接退出，由 ns 外的 P0 以 `flock -w` 真正取得租约（证明所有 fd 9 持有者已退出）、确认 ns 无成员后，在持锁状态下删除记录。
- **终止权只来自记录**（§3.3）：只有 `instanceId` + pid/starttime + ns id 全部吻合的进程才会被信号；扫描发现的「未登记持有者」只报告、阻止新挂载，绝不杀。另一个保险库已全局挂载时拒绝 `run --private`（unshare 会把它复制进新 ns 且无法单独拆除，Q10）。
- **进程结构**（§2）：`P0` 启动器（初始 ns）→ `sh`（`exec 9<>mount.lease; flock -n 9`）→ `unshare --user --map-root-user --mount --propagation private` → `P1` ns-root 监督者（只挂载、收尾，不跑负载）→ `gocryptfs -fg`（setsid、槽 9；口令仍由用户在 TTY 上直接输给 gocryptfs）与 `unshare --user --map-user=<uid> --map-group=<gid>` → `pi`（真实 uid、CapEff=0、槽 9）。挂载内的同步 fs 检查全部放进可被 KILL 的 worker 子进程（§2.6）。
- **阶段**（§3.2）：`starting → mounting → launching → session → finalizing`（setup 模式 `… → setup → finalizing`）。`lock` 只在 `finalizing` 上等待；`launching` 与 `session` 同样受保护（不带 `--kill` 拒绝）。
- **web-hub**（§4）：对策 2——私有 ns 内永不拉起 hub。ns 判定基于**证据**（`/proc/self/ns/mnt` 与登记库的 `private.json` 比对），不依赖会被剥离的 env；闸门落在唯一出口 `spawnHub` 与 `/webhub restart`。agent 发一个事实标记 `agent.nospawn.v1`，hub 经 `registry.getCaps()` 跳过它的版本替换观察（Q2）。
- **如实边界**（§5）：防路径直读、`find/grep` 扫描、备份工具、其他程序/agent 的无意识访问；**不防**懂 `/proc/<pid>/root`、`/proc/<pid>/cwd` 或 `setns` 的同 uid 定向进程。`--lazy` 只摘除 ns 里的挂载路径，既有 cwd/打开的文件/运行中的作业可能继续访问。
- **工作量**：L0 约 1d；`--private` 约 6d（§7）。
- **冻结面**（§7.2）：L0 之后，不带 `--private`、未配置 `private`、无 `private.json` 时，`pi-secure` 全部子命令的输出与退出码不变（N0 golden 在 L0 之后生成）；新增的租约检查只在出现私有实例或未登记 gocryptfs 时产生输出。`secure-off-golden.json` 与三份 fabric off golden 不变。parity fixture 除 L0 一次性改动外只追加。

---

## L. 布局迁移（前置包 L0）

### L.1 新布局（取代 plan.md §2.1 的布局图）

```
~/.local/share/pi-toolkit-secure/<名字>/   <dir>   0700  明文区，只放元数据（缺省位置，可由 entry.dir 指定）
  cipher/                 gocryptfs 密文（gocryptfs.conf、gocryptfs.diriv、加密名…）
  mount.lock              0600  状态变迁串行化（flock，从不跨口令/会话持有）
  mount.lease             0600  挂载租约（L0 建空文件；N1 起每次挂载都持有）
  private.json            0600  仅 --private 实例期间存在（N1）
~/secure/<名字>/          <mnt>   0700  挂载点（缺省位置，可由 entry.mnt / init --path 指定）
  work                    未挂载：0 字节 0400 普通文件（哨兵）；挂载后：项目根
  state                   未挂载：0 字节 0400 普通文件（哨兵）；挂载后：私有区（sessions/default、memory、tmp、bash-jobs…）
```

- 旧布局：`<dir>/mnt` 是挂载点，`~/secure/<名字>` 是指向 `<dir>/mnt/work` 的符号链接。新布局里挂载点本身就是 `~/secure/<名字>`，没有符号链接；pi 的物理 cwd 就是 `~/secure/<名字>/work`（`$HOME` 本身不经符号链接时）。
- 设置条目：`secure.vaults.<名字> = { dir?, mnt?, private?, origin?, backup?, pending?, relocate? }`（后五个分别由 `--private` 与 convert 方案引入，缺省不出现）。`dir` 缺省 `~/.local/share/pi-toolkit-secure/<名字>`，`mnt` 缺省 `~/secure/<名字>`；两者都经 `expandSecurePath`（绝对路径或 `~/…`）。
- 派生：`work = <mnt>/work`，`state = <mnt>/state`，`sessionDir = <state>/sessions/default`，`cipher = <dir>/cipher`，`lock = <dir>/mount.lock`，`lease = <dir>/mount.lease`。
- 物理路径：`realDir = realpath(dir)`、`realCipher = <realDir>/cipher`；`realMnt = join(realpath(dirname(mnt)), basename(mnt))`——**永不对挂载点本身做 realpath**（挂载着或 ENOTCONN 时会穿过/卡住）。`realWork = <realMnt>/work`。
- 位置规则（`checkLayout` 与 `createLayout` 共用）：
  - `<mnt>` 必须是本用户的 0700 目录、不是符号链接；未挂载时恰好只含 `work`、`state` 两个哨兵（多余条目 ⇒ 拒绝挂载 78，提示人工检查；这类条目是锁定期间写进挂载点底层的明文）。
  - `dirname(<mnt>)` 必须存在（缺省 `~/secure` 不存在时由 `init` 以 0700 创建，其他位置不代建）、属于本用户、不是组/其他可写；可以经符号链接（按 realpath 解析一次）。
  - `<mnt>` 与 `<dir>` 互不包含；不在任何其他已登记库的 `dir`/`mnt` 之内，也不包含它们；不在 pi agent 目录之内。
- 锁定时 `cd ~/secure/acme` 可以进入（看到两个哨兵），`cd ~/secure/acme/work` 报 ENOTDIR；写进 `~/secure/acme/` 本身的文件会让下次挂载被拒（上一条）。

### L.2 代码改动（L0 包）

| 文件                               | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/secure/bin/helper.mjs`        | `deriveVault(name, dir, mnt)`（去掉 `link`，增 `lease`）；`parseSecureConfig` 解析 `mnt`（非法 ⇒ invalid reason `"mnt"`），识别旧条目（§L.3）；`defaultVaultLink` → `defaultVaultMnt`；`physicalPaths` 按 §L.1 计算 `realMnt`；`checkLayout` 拆成 `<dir>` 检查（cipher/conf/lock/lease）与 `<mnt>` 检查（含父目录规则）；`createLayout`：`<mnt>` 已存在 ⇒ 78，缺省父目录不存在时 0700 创建，`mkdir(<mnt>, 0700)` 独占创建后写两个哨兵，建空 `mount.lease`；删除 `linkState`/`createLink` 与 status 的 `link` 列（改为 `mnt` 列）；`resolveRunCwd` 去掉「经链接」的分支；`ensureVaultDirs`/`verifyRunPaths`/`syncProjectSettings` 的 `realMnt` 来源随 `physicalPaths`；`cmdInit --path` 语义改为挂载点；`registerVault*` 写 `{dir?, mnt?}`；USAGE 与 init/unlock 结束语改为新路径 |
| `src/secure/config.ts`             | `SecureVault` 去掉 `link`、增 `mnt`；`deriveVault` 同 helper；旧条目解析为 `layout: "legacy"`（只在旧条目上出现该键）；invalid reason 增 `"mnt"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/secure/domain.ts`             | `SecureVaultRoots` 增 `mntReal`；`statePathsOf`/`inVaultMount`/`inVaultWriteZone`/`judgeVaultMount` 改用 `mntReal`；`inVaultDir(p) = within(root) ∨ within(mntReal)`；`computeSecureDomain` 的 cwd 命中改用 `inVaultDir`；旧布局库仍按旧派生路径判定（只为让旧库的 LOCKED/plain 判定保持正确）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/secure/guards.ts`             | `vaultOfPath`/`vaultSpellings` 使用 `dir`/`root`/`mnt`/`mntReal`（convert 方案的 V6 再加 `origin`）；D3 的「严格位于 `work`/`state` 之下」与「挂载点根条目与哨兵路径拒绝」改按 `mntReal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/secure/command.ts`            | `/secure status` 每库一行由「入口链接」改为「挂载点」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/runtime/session-driver.ts` 等 | 不受影响（只用 `<state>` 派生值）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### L.3 旧布局条目的兼容（已拍板：只读兼容 + 指引迁移，Q-L0）

- 识别：条目含 `link` 键；或不含 `mnt` 且 `<dir>/mnt` 是目录。解析为 `layout:"legacy"`，按旧规则派生路径。
- 允许：`status`（库行显示 `legacy-layout`）、`lock`（卸载旧挂载点 `<dir>/mnt`）、`export`（只读 `cipher/`，与布局无关，convert 方案 §3.2）。
- 拒绝（78）：`unlock`、`run`、`run --private`、`init --fix-settings`。文案：「保险库 acme 使用旧布局（挂载点 `<dir>/mnt`）。没有真实数据：`pi-secure` 登记项与目录删除后重新 `init`；有真实数据：`pi-secure export acme <文件>` 后 `pi-secure import <文件> acme2`（新布局，会话与 sessionDir 自动迁址），确认无误再删除旧库。」
- 不做就地自动迁移：旧挂载点路径会出现在会话头 cwd、项目 `.pi/settings.json` 与 memory slug 里，就地改要碰明文区以外的一堆文件，正确的工具就是 export → import 的迁址引擎（convert 方案 V5）。用户目前大概率还没有真实保险库，代价很低。
- 插件：旧布局库的 domain 判定保持旧行为（cwd 在旧挂载点下且挂载着 ⇒ secure；未挂载 ⇒ locked），以免升级插件后旧会话被误判为 plain。

### L.4 测试与验收改动

- parity fixture `tests/fixtures/secure-contract-parity.json`：vault 对象形状变了（`link` → `mnt`），**L0 一次性修订既有 expect**——这是用户批准布局变更带来的唯一一次「非追加」改动，helper 与 `config.ts` 两侧同一提交、同一测试同步改；同时追加旧布局用例（含 `link` 的条目 ⇒ `layout:"legacy"`）与 `mnt` 非法用例。此后恢复只追加。
- `secure-off-golden.json` 与三份 fabric off golden 不受影响（无库场景）。
- 需改路径断言的测试：`tests/secure/{launcher-helper,launcher-cli,launcher-fuse,domain,guards,guard-points,stack-roots,settings-*}.test.ts`；`tests/conformance/secure-gocryptfs.test.ts` 用探针自己的临时布局，预计不受影响（L0 中核实）。
- 新增：挂载点父目录规则、`<mnt>` 已存在拒绝、未挂载时 `<mnt>` 多余条目拒绝挂载、旧布局条目的允许/拒绝矩阵、`realMnt` 不经挂载点 realpath（ENOTCONN 下不卡住）。
- acceptance.md 路径修订：`~/secure/acme` 是目录（锁定时可 `cd`，内含两个哨兵）、`~/secure/acme/work` 锁定时 `cd` 失败；项目根 `~/secure/acme/work`；`<state>` = `~/secure/acme/state`；`status` 显示 `mnt` 列。
- plan.md：§2.1 布局图与哨兵说明、§0.5 用户影响（路径）在 L0 的文档部分修订（本文不改 plan.md）。

### L.5 对两份方案的影响

- `--private`：外部视角哨兵在 `~/secure/<名字>/{work,state}`；`realMnt = ~/secure/<名字>`（物理）；记录里的 `realMnt` 即此路径。
- convert：原路径符号链接直接指向 `~/secure/<名字>/work`（= 物理路径，一跳，也就是登记项派生的 `work`，r1 的 Q1 自然消解）；`--path` = 挂载点；会话迁到 `~/secure/<名字>/state/sessions/default`。

---

## 1. 命令面

### 1.1 新增/变化的命令与参数

| 命令                                                                      | 变化                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-secure run <name> [--private\|--no-private] [-C <子目录>] [pi 参数…]` | **固定顺序**：`--private`/`--no-private` 只在紧跟 `<name>` 的位置识别；其后若是 `-C <子目录>` 则按原规则取一次（`-C` 仍只认第一个位置）；其余一切原样交给 pi parseArgs（§2.2.1 审查不变）。未出现两个新参数时，切分与旧代码完全相同（`rest[0]==="-C"`）。未给出时取 `secure.vaults.<name>.private`，缺省 `false`。**兼容例外**：`run acme --private …` / `--no-private …` 过去会把该参数交给 pi，现在被启动器消费（显式列入冻结面例外） |
| `pi-secure init <name> [--path <挂载点>] [--private]`                     | `--path` 语义按 §L 改为挂载点位置。`--private` ⇒ 登记 `private:true`，首次挂载建目录、写 sessionDir、卸载在私有 ns 内完成（P1 setup 模式）                                                                                                                                                                                                                                                                                              |
| `pi-secure init <name> --fix-settings`                                    | 对 `private:true` 的库：在私有 ns 内改写 sessionDir 后卸载（普通库保持「改完保持挂载」的原语义）                                                                                                                                                                                                                                                                                                                                        |
| `pi-secure lock <name> [--lazy\|--kill]`                                  | 新增 `--kill`（只对私有实例有意义；对普通挂载等同于不带参数并提示）。语义见 §3.7                                                                                                                                                                                                                                                                                                                                                        |
| `pi-secure status [<name>]`                                               | 私有实例显示见 §3.8；无私有记录且租约空闲的库输出不变                                                                                                                                                                                                                                                                                                                                                                                   |
| `pi-secure unlock <name> [--global]`                                      | `private:true` 的库默认拒绝全局解锁（exit 64，提示 `--global`）；`--global` 只解除这条默认，**从不绕过互斥**；`run <name> --no-private` 对私有库照常可用但打印一行可见性提醒。普通库不受影响                                                                                                                                                                                                                                            |

**设置**：`secure.vaults.<name>.private`（boolean，缺省 false）。非布尔 ⇒ invalid reason `"private"`。`parseSecureConfig` 只在 `true` 时输出 `private: true`。

### 1.2 互斥与共存矩阵

「本库可能存在挂载」的判据是**租约忙**（`/proc/locks` 中有本库 `mount.lease` 的 (dev, ino) 的 FLOCK 条目）**或**存在非 stale 的私有记录（§3.3：记录 ns 仍有成员）；任一成立即拒绝新挂载。全局 mountinfo 照旧用于识别普通挂载与旧 helper 留下的无租约挂载。

| 已有状态 → 新操作                                                              | 结果                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 普通挂载存在（全局 mountinfo `mounted` 或租约忙且无私有记录）→ `run --private` | 拒绝 76，挂载前、问口令前：「acme 已普通挂载（对所有同用户进程可见）。先 `pi-secure lock acme`，再 `run --private`；或去掉 `--private`」                                                                   |
| 普通挂载失效（ENOTCONN）且租约空闲 → `run --private`                           | 与现 `__mount` 一致：先 `fusermount3 -u` 清理再继续；租约忙 ⇒ 76（gocryptfs 仍活着）                                                                                                                       |
| **另一个已登记库 B 全局挂载着 → `run --private A`**                            | 拒绝 76：「保险库 B 正全局挂载：私有命名空间会复制这个挂载，且无法在其中单独拆除，导致 B 之后无法干净卸载。先 `pi-secure lock B`」（Q10）。A 私有运行中再普通解锁 B 不受影响（private 传播，不进 A 的 ns） |
| 私有实例运行中 → `unlock` / 普通 `run` / 第二个 `run --private`                | 拒绝 76（租约忙或记录 ns 仍有成员；有记录时文案带 pi pid）。P1 已死、gocryptfs 或后台成员仍活时同样拒绝                                                                                                    |
| 私有实例运行中 → 另一个库的任何操作                                            | 互不影响（另见 Q10 行）                                                                                                                                                                                    |
| 私有实例运行中 → `lock`（不带参数）                                            | `launching`/`session` ⇒ 76；`finalizing` ⇒ 等待后复判（§3.7）                                                                                                                                              |
| 私有实例运行中 → `status`                                                      | 显示 `private`（§3.8）                                                                                                                                                                                     |
| 在私有 ns **内部**执行 `pi-secure lock/unlock/run`                             | `lock` 拒绝 76（「不能在私有会话内部收尾自己；退出 pi 即自动收尾」）；`unlock`/`run` 按上表拒绝；`status` 正常并标注所在 ns                                                                                |
| 租约忙但无有效记录（未登记持有者）                                             | 一切挂载入口拒绝 76；`status` 显示 `lease held (unrecorded)` 与扫描到的持有者（只报告）；`lock` 不杀（§3.3），给出人工排查指引                                                                             |
| 失效记录（§3.3：bootId 不符；或租约可获取且记录 ns 无任何进程）                | 认领、`lock` 经释放协议（§3.2：真正取得租约 + instanceId 比对 + ns 扫描为空）删除并提示一行；`status` 只读，显示 `stale record`                                                                            |

---

## 2. 进程链

### 2.1 进程树、身份与租约 fd

```
shell
 └─ pi-secure (bash: readlink -f、Linux 检查、ulimit -c 0、umask 077、cd /)
     └─ P0  node helper.mjs run acme --private               初始 ns · 真实 uid · TTY 前台进程组
         │   ① 参数审查 ② 前置检查 ③ 认领(mount.lock 内，写 starting 记录 + instanceId) ④ web-hub 提示
         └─ /bin/sh -c 'exec 9<>"$lease" && flock -n 9 || exit $BUSY; exec unshare … -- node helper.mjs __ns-root'
             │   （shell 自己打开 fd 9，无 CLOEXEC；flock(1) 锁住该打开文件描述后退出；shell exec 成 unshare，不留包装进程）
             └─ unshare --user --map-root-user --mount --propagation private --     （exec 链，fd 9 原样保留）
                 └─ P1  node helper.mjs __ns-root               ns-root · 私有 mntns · 持 fd 9（Node 启动时给它置 CLOEXEC，但仍持有）
                     ├─ node helper.mjs __mount-work <op>        挂载内同步 fs 检查（不给 fd 9）
                     ├─ gocryptfs -fg -notifypid=<P1> -nonempty -- <realCipher> <realMnt>
                     │      spawn: detached(setsid) + stdio 显式槽 9 ⇒ 持 fd 9；口令由 gocryptfs 从继承的 TTY fd 直读
                     └─ unshare --user --map-user=<uid> --map-group=<gid> --        spawn: stdio 显式槽 9
                         └─ pi --session-dir <state>/sessions/default …           真实 uid · CapEff=0 · 持 fd 9
                             └─ bash 工具 / 后台 job / 子进程 …                    同一 mntns；**不持 fd 9**（pi/toolkit 的 Node spawn 不传）
```

- 不 unshare pid ns ⇒ 全局 pid 一致；没有 pid 1 收养问题。
- **负载永不以 ns-root 运行**（I-P6）：内层 userns 的父是外层 userns，负载对外层无能力，无法 umount 保险库（NC3）。
- **fd 传递事实**（本机 Node v22.22.1、util-linux 2.37.2 实测，2026-10-23；NC12 钉住）：
  1. shell `exec 9<>file` 打开的 fd 无 CLOEXEC（fdinfo `flags: 0100002`）；经 `exec unshare` 与 `exec node` 原样进入 P1。
  2. **Node 启动时给继承来的 fd 9 置了 CLOEXEC**（P1 内 fdinfo `flags: 02100002`），因此 `spawn(…, {stdio:"inherit"})`、`stdio:["ignore","inherit","inherit"]`、`detached:true`、以及嵌套 Node 再 spawn 的子进程**都拿不到 fd 9**。r2「锁 fd 一路自动继承给整个 ns 树」的假设不成立（评审 B1 的依据，已实测证实）。
  3. 显式 stdio 槽 `stdio:["inherit","inherit","inherit","ignore","ignore","ignore","ignore","ignore","ignore",9]` 会把 fd 9 以**无 CLOEXEC** 的形式交给子进程（子进程 fdinfo `flags: 0100002`），`detached:true` 下同样有效；槽 3–8 的 `ignore` 在子进程里是关闭的。
  4. flock 锁属于打开文件描述：只要还有任一进程持有引用该描述的 fd 就不释放；P1 退出后、只要经槽 9 拿到 fd 的子进程还活着，`/proc/locks` 仍有条目、新的 `flock -n` 失败（实测）。`/proc/locks` 里的 pid 是**最初加锁者**（已退出的 shell），不代表当前持有者，只能按 inode 匹配。
  5. 同一描述上再次 `flock -n 9` 成功（自身重锁），另开新描述的 `flock -n <file>` 失败——P1 自检用前者证明自己的 fd 9 确实持锁。
- **租约持有者（fd 9 持有者）清单**：P1、gocryptfs（槽 9）、内层 unshare→pi（槽 9）。凡 Node 派生、需要持租约的子进程一律用显式槽 9；`__mount-work` worker、`flock`/`umount` 等短命工具不给 fd 9。pi 及其后代（bash 工具、后台 job、扩展守护）**不持** fd 9——它们的存活由 ns 成员扫描覆盖（§3.3）。
- **租约语义（裁定）**：「`mount.lease` 上的 flock，只要 gocryptfs 或任一 fd 9 持有者还活着就被持有」；判活与删除记录还要求 ns 成员扫描为空（§3.3），两者缺一不可。
- `BUSY` 是与 gocryptfs 退出码表不重叠的专用码（实现定，例如 213；NC11 钉住），helper 统一映射为 76。

### 2.2 P0：启动器（初始 ns）

1. `parseRunFlags(rest)`（§1.1 固定顺序）→ `{ private?, sub, piArgs }`；`private===undefined` 时取 `vault.private ?? false`。**非私有 ⇒ 原 `cmdRun` 余下逻辑**（普通挂载路径的唯一变化是 `__mount` 改用同样的 shell 租约链启动 gocryptfs，§3.1）。
2. 同现状：`resolveVault`（旧布局 ⇒ 78）、`enabled` 检查、定位 pi 包、`parseArgsShapeOk`、词法审查（问口令前）。
3. `requirePrereqs()` + `privatePreflight()`（§2.7），失败 69。
4. **认领**：`flock -o -E 73 -w 10 <dir>/mount.lock node helper.mjs __private-claim <name> <instanceId>`（`instanceId` = P0 生成的 128 位随机 hex）。认领子进程在锁内，任一项不确定即拒绝：
   - 全局 mountinfo：本库 `mounted`/`foreign`/`hung` ⇒ 76/1/75；`stale` ⇒ 租约空闲时 `fusermount3 -u` 清理，租约忙 ⇒ 76。
   - 其他已登记库任一全局 `mounted` ⇒ 76（Q10）；扫描不完整 ⇒ 75。
   - 租约忙（`/proc/locks` 只读探测）⇒ 76。
   - `private.json`：存在 ⇒ 按 §3.3 判定；只有判为 `stale` 才按 §3.2 的释放协议删除（锁内只能非阻塞取租约），否则 76；损坏/非本用户普通文件 ⇒ 拒绝（fail closed），提示人工核对。
   - `checkLayout(unmounted)` 哨兵校验；lstat `mount.lease`（本用户 0600 普通文件），把其 (dev, ino) 写入记录。
   - O_EXCL 写 `private.json`：`{v:3, instanceId, phase:"starting", owner:P0 身份, lease:{dev,ino}, bootId, …}`。退出 0。
5. web-hub 提示（§4.1，只打印）；§5.1 边界长句（每次私有启动都打印）。
6. spawn `/bin/sh -c 'exec 9<>"$1" && flock -n 9 || exit <BUSY>; shift; exec unshare --user --map-root-user --mount --propagation private -- "$@"' sh <lease> <node> <helper.mjs> __ns-root`，`stdio:"inherit"`（fd 9 由 shell 自己打开，不依赖 Node 传递）；规格经 `PI_SECURE_NS_SPEC`（`{v:3, mode, name, instanceId, sub, piArgs, piBin, piPkg, fix}`）传入。
   - 退出码 `BUSY`（另一个挂载抢先持有租约）⇒ 本链从未 exec 出 P1、从未建 ns。P0 在 `mount.lock` 内删除**自己 instanceId、仍为 `starting`、且没有 `ns` 字段**的记录（§3.2 的唯一「无需租约」删除例外），exit 76。
7. 信号：`SIGINT`/`SIGQUIT` 置空（交给 TTY 前台组），`SIGTERM`/`SIGHUP` 转发给 P1。
8. P1 以**任何方式**结束后，P0 按 §3.6 判定；**记录只由 P0（或 `lock`/认领）经 §3.2 释放协议删除，P1 从不删除自己的记录**。
9. P0 自身被 SIGKILL：租约仍由 P1/gocryptfs/pi 持有；P1 照常在 pi 退出后做 ns 内收尾；记录留待下次 `lock`/认领经释放协议清理（§3.9）。

### 2.3 P1：ns-root 监督者（`__ns-root`）

1. **自检**（不符 ⇒ exit 1，不挂载）：`getuid()===0`；`uid_map`/`gid_map` 恰为 `0 <realUid> 1` / `0 <realGid> 1`；spec 合法；**fd 9 存在、`fstat(9)` 的 (dev, ino) 等于记录 `lease`、且 `spawn("flock", ["-n","9"], {stdio: 槽 9})` 成功（证明本描述持锁）**；读记录：`instanceId` 等于 spec、`phase==="starting"`；不等于 spec 的 instanceId ⇒ 立即退出、绝不挂载或写记录；删除 env 中的 spec。
2. 信号：`SIGINT`/`SIGQUIT` 在 `mounting` 阶段 ⇒ TERM 本实例 gocryptfs 并中止（gocryptfs 已 setsid，不会收到终端信号，见第 4 步），其他阶段置空；`SIGHUP` ⇒ 转发给 pi；`SIGTERM` ⇒ 结束会话（§3.7 `--kill`）；`SIGUSR2` ⇒ lazy 切断；`SIGUSR1` ⇒ gocryptfs 就绪通知（第 5 步）。所有 stderr 写入 try/catch（EIO 不得让 P1 崩溃）。
3. 记录变迁（每一次）：在 `mount.lock` 内（`flock -w` 2 s，经短命子进程完成，异步、带截止）读-比较 `instanceId` 后写；比较失败 ⇒ 停止后续动作并进入收尾。`starting → mounting` 时写入 `supervisor`（P1 pid+starttime）与 `ns`（`/proc/self/ns/{mnt,user}`），**先于启动 gocryptfs**。
4. **挂载循环**（D9 不变；裁定：`-fg`）：spawn `gocryptfs -fg -notifypid=<P1 pid> -nonempty -- <realCipher> <realMnt>`，`detached:true`（setsid：脱离 TTY 作业控制，Ctrl-C/终端挂断不会直接打到它；没有控制终端的进程读继承来的 TTY fd 不受 SIGTTIN 约束），`stdio` = 显式槽数组（0/1/2 inherit、3–8 ignore、9 = 9）。**不使用守护化**：守护化会由 gocryptfs 自己重新 exec 子进程，fd 9 是否保留取决于其实现，裁定不依赖它。每次尝试：180 s 时 TERM，+2 s KILL，+3 s 放弃等待。gocryptfs 退出码 12 ⇒ 1/2/4 s 后重试，三次 ⇒ 77；其他退出码沿用现有映射。gocryptfs 是 P1 的直接子进程，P1 直接 `wait` 它。
5. **就绪判定**：收到来自该 gocryptfs pid 的 `SIGUSR1`（`-notifypid`）∧ 本 ns `mountinfo` 显示 `mounted` ∧ worker 的 readdir 探活通过（≤3 s）。SIGUSR1 之前 gocryptfs 退出 ⇒ 按退出码处理。记录升级为 `launching`，写入 `gocryptfs` 身份（就是这个子进程，无需再去定位守护进程）。
6. **挂载后检查**全部在 worker 中执行（§2.6）：`ensureVaultDirs`、`syncProjectSettings({fix})`（冲突 ⇒ 78）、`resolveRunCwd(physical)`、第 2 遍物理审查、`verifyRunPaths`——与现 `cmdRun` 同序同函数，worker 经 JSON 行回报。失败 ⇒ §3.4 收尾（无 pi），exit 对应码。`mode:"setup"` 改记 `setup` 阶段、完成后直接收尾。
7. spawn `unshare --user --map-user=<realUid> --map-group=<realGid> -- <piBin> --session-dir <v.sessionDir> …piArgs`，`stdio` = 显式槽数组（同第 4 步，pi 因此持 fd 9），`cwd` 物理 cwd，`env` = `piChildEnv(v, cwd)` + `PI_SECURE_NS=1`。记录升级为 `session`，写入 `pi` 身份。
8. 等 pi 退出 ⇒ 记录写 `piExit` ⇒ §3.4 ns 内收尾 ⇒ 记录写 `inNsDone:true`（或 `inNsDone:false` + 原因）⇒ **直接退出**（不删记录；P1 退出码 = `piExit`，收尾不完整时 75）。

### 2.4 环境变量契约（`src/secure/env.ts` 增补）

| 变量                                                                                             | 设置方                     | 含义                                                                                                   |
| ------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `PI_SECURE_VAULT` / `PI_SECURE_SESSION` / `PI_SECURE_ORIG_ENV` / `TMPDIR` / `ARMORY_MEMORY_ROOT` | P1 经 `piChildEnv`（不变） | 同 plan §2.4                                                                                           |
| `PI_SECURE_NS=1`                                                                                 | **新增**，P1 给 pi         | 提示「在私有 ns 内」。只会让行为更保守（§4.1 的判定是「证据 ∨ 提示」）；被剥离也无妨，证据判定照样命中 |
| `PI_SECURE_NS_SPEC`                                                                              | P0 → P1，P1 读后立即删除   | 内部规格                                                                                               |

`hubSafeEnv` 已剥离全部 `PI_SECURE_*` ⇒ 无需改；parity fixture 追加一条含 `PI_SECURE_NS` 的用例钉住。

### 2.5 技术选型说明

| 点                 | 选定                                                                                                                                                                                | 理由 / 备选                                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 互斥机制           | `mount.lease` 上的 flock，fd 9 由 shell 打开并锁住，Node 子进程经显式 stdio 槽 9 继承；判活另加 ns 成员扫描                                                                         | 内核持有，持有者死即释放；Node 会给继承的 fd 置 CLOEXEC，所以不能依赖「自动继承」（§2.1 实测）；pi 的后代不持 fd，由 ns 扫描覆盖。探测用只读的 `/proc/locks`；删除记录前真正取锁。Node 没有 flock API，util-linux `flock` 已是前置 |
| gocryptfs 运行模式 | **私有：`-fg`**（裁定），P1 的直接子进程，`detached:true`（setsid）+ 槽 9，就绪信号为 `-notifypid=<P1>` 的 SIGUSR1；普通：保持守护化（fd 9 由 shell 直接交给 gocryptfs，不经 Node） | `-fg` 不做自我重新 exec，fd 9 不会在 gocryptfs 内部丢失；P1 可直接 wait。setsid 让它脱离 TTY 作业控制（不受 Ctrl-C/终端挂断影响），无控制终端时读继承的 TTY fd 不受 SIGTTIN 约束。NC2 用生产命令链验证（T1 关闭）                  |
| 口令               | 仍由 gocryptfs 从继承的 TTY 读取                                                                                                                                                    | D6/Q1 不变                                                                                                                                                                                                                         |
| ns 内卸载          | `umount -n <realMnt>`，EBUSY ⇒ `umount -n -l`                                                                                                                                       | 私有挂载对外部 `fusermount3` 不可见                                                                                                                                                                                                |
| 外部收尾           | 只走信号，以 ns 销毁为最终卸载手段                                                                                                                                                  | 前提是没有额外的 ns 引用（nsfs bind mount、他人持有的 ns fd），见 R23                                                                                                                                                              |
| P0↔P1 通信         | env 入、`private.json` + 退出码出                                                                                                                                                   | 不引入额外 IPC                                                                                                                                                                                                                     |

### 2.6 有界性：worker 与预算表

挂载内的 fs 操作（`ensureVaultDirs`、`verifyRunPaths`、`syncProjectSettings`、readdir 探活，以及其中的 `fsyncSync`）都是同步调用，一旦 FUSE 卡住就会把调用进程卡死。r2 规定：

- 监督者（P1、P0、`lock`、`status`）**从不在挂载路径上做同步 fs 调用**。挂载内操作一律交给 `node helper.mjs __mount-work <op>` worker：独立进程组，结果经 stdout JSON 行返回；到期 TERM → +2 s KILL → +1 s 放弃等待（unref，计为「未完成」），与 `probeReaddirChild` 同模式。
- 记录（`<dir>` 是普通文件系统）读写走异步 fs，每次 ≤2 s 截止。
- 有界承诺**不含**交互时间（用户输入口令的时间——仍受每次尝试 180 s 上限约束——与会话本身的生命期）。

| 阶段                                          | 执行者      | 预算                                                  | 超出后                               |
| --------------------------------------------- | ----------- | ----------------------------------------------------- | ------------------------------------ |
| 认领（等 `mount.lock` + 检查 + 写记录）       | P0 子进程   | 10 s 等锁 + 3 s                                       | 73 / 75                              |
| `privatePreflight`                            | P0          | ≤3 s                                                  | 69 / 75                              |
| 每次 gocryptfs 尝试（`-fg`，到 SIGUSR1 为止） | P1          | 180 s TERM，+2 s KILL，+3 s 放弃                      | 75（三次口令错 77）                  |
| 就绪判定（SIGUSR1 之后）                      | P1 + worker | ≤3 s                                                  | 回滚                                 |
| 挂载后检查                                    | worker      | 20 s（每个 op 独立截止）                              | 收尾，75                             |
| 记录变迁                                      | P1          | 每次 ≤2 s（含 2 s 等锁）                              | 进入收尾                             |
| P1 ns 内收尾 `finalizeInNs`                   | P1          | 10 s，硬兜底 10.5 s                                   | 写 `inNsDone:false`，75，P0 外部收尾 |
| P0 释放记录 `releaseRecord`（正常路径）       | P0          | 取租约 `flock -w 3`；取 `mount.lock` 2 s；ns 扫描 2 s | 记录保留，75                         |
| 外部收尾 `outerPrivateCleanup`（含释放）      | P0 / `lock` | 10 s，硬兜底 10.5 s                                   | 记录保留，75                         |
| 状态/判活/扫描                                | 任意        | 单次 ≤2 s                                             | 「不完整」（从不当作空）             |

最坏路径：P1 10.5 s + P0 外部收尾 10.5 s ≤ 21 s（测试断言 ≤22 s）；正常路径：P1 ns 内收尾（通常 <1 s）+ P0 释放（取租约立即成功，<1 s）。

### 2.7 私有前置检查 `privatePreflight()`

1. `unshare --help` 含 `--map-root-user`、`--map-user`、`--map-group`、`--propagation`（按功能探测）。
2. `/proc/sys/kernel/unprivileged_userns_clone`（存在时须为 1）、`/proc/sys/user/max_user_namespaces` > 0。
3. `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` 存在且为 1 ⇒ 预判失败。这是**保守的支持范围限制**：系统管理员可能为 `unshare` 配了允许规则，但 r2 不检测 profile，统一拒绝并说明。
4. 实测：`unshare --user --map-root-user --mount --propagation private -- mount -t tmpfs -o size=4k pi-secure-probe <0700 临时目录>`，3 s 超时 KILL。
5. `umount` 存在。

失败 ⇒ 69，列出具体项与处置（「去掉 `--private` 仍可用普通模式」）。

### 2.8 失败回滚

| 失败点                                   | 回滚                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| 认领前（参数、前置、冲突）               | 无副作用，问口令前退出                                                              |
| 租约忙（shell 链以 `BUSY` 退出，被抢先） | P0 按 §3.2 唯一例外删除自己 instanceId、仍为 `starting` 且无 `ns` 的记录，76        |
| `unshare` 失败 / P1 自检失败             | P1 不删记录、直接退出；P0 按 §3.6 `releaseRecord`，69/1                             |
| 口令三次错误 / gocryptfs 失败            | P1 确认 gocryptfs 子进程已退出、写 `inNsDone:true` 后退出；P0 `releaseRecord`，77/1 |
| 挂载后、pi 启动前检查失败                | P1 §3.4 ns 内收尾后退出；P0 `releaseRecord`；不完整 ⇒ P0 外部收尾，记录保留时 75    |
| P1 崩溃                                  | P0 §3.6                                                                             |

### 2.9 插件侧：ns 判定与两阶段域判定

- **挂载判定无需改**：ns 内 `/proc/self/mountinfo` 能看到本库挂载（mountPoint = `realMnt`、source = `realCipher`），`judgeVaultMount` 与每次 `tool_call`/`input` 的复检原样生效；`--lazy` 后复检看不到挂载 ⇒ `secure:locked`。
- **ns 判定基于证据**（`src/secure/domain.ts`）：`initSecureDomain` 读 `readlink /proc/self/ns/mnt`，对每个已登记的有效库读 `<dir>/private.json`（普通 fs，≤4 KiB，lstat 本用户普通文件、`v===3`、bootId 匹配）；`ns.mnt` 等于自身 ⇒ `privateNs = { vault }`。与 domain 种类无关——cwd 在 `/tmp` 的 plain 域 pi 只要在该 ns 内同样命中。`PI_SECURE_NS==="1"` 是附加提示：证据 ∨ 提示 ⇒ 判为 ns（提示只会让行为更保守）。冻结在所有 domain 变体的可选字段 `ns` 上（非 ns 时不写该键）；导出 `isPrivateNsSession()`。
- 记录解析器在 `src/secure/config.ts`（`parsePrivateRecord`）与 helper 两侧各一份，parity fixture 追加用例。
- `src/secure/command.ts`：ns 内「加密会话」段追加两行（§5.1）；普通会话列库时，若 `<dir>/private.json` 存在则该库行追加「（存在 --private 实例记录，用 pi-secure status 查看）」，否则行不变。

---

## 3. 生命周期

### 3.1 挂载租约 `mount.lease`（互斥权威之一）

- 文件：`<dir>/mount.lease`，0600，本用户普通文件，空内容，由 `createLayout`（L0）创建；`checkLayout` 要求它存在且合规。shell 的 `exec 9<>` 会跟随符号链接、不存在时会创建，所以必须预先 lstat 校验，并由持有者用 `fstat` 复核 (dev, ino)（P1 自检第 1 步；普通模式由 `__mount` 在 `mount.lock` 内预检）。
- **每一次** gocryptfs 启动都在租约下，且 fd 9 一律由 **shell** 打开（不经 Node 传递）：
  - 私有：§2.2 第 6 步的 shell 链 → unshare → P1；P1 再以显式槽 9 交给 gocryptfs（`-fg`）与 pi（§2.3）。
  - 普通：`__mount`（已在 `mount.lock` 内）把原 `gocryptfs …` 换成 `/bin/sh -c 'exec 9<>"$1" && flock -n 9 || exit <BUSY>; shift; exec gocryptfs "$@"' sh <lease> -nonempty -- <cipher> <mnt>`。shell exec 成 gocryptfs，fd 9 无 CLOEXEC；普通模式保留守护化，守护进程继承并长期持锁的事实来自 P0 实测（P0-report：「不加 `-o` 则守护进程长期占锁」，即 fd 不经 Node 直接交给 gocryptfs 时守护会继承），NC2c 用生产命令链复核。`__mount` 之后启动的 pi 不持 fd 9。
- 探测「租约忙」（只读）：读 `/proc/locks`，查找 `FLOCK` 且 `maj:min:ino` 等于租约 (dev, ino) 的条目。读取失败或超时 ⇒ 「不确定」⇒ 拒绝。只读探测只用于判活与展示；**删除记录必须真正取得租约**（§3.2）。
- **锁顺序**（防死锁）：阻塞式获取只允许「先租约、后 `mount.lock`」；持有 `mount.lock` 时只能以 `flock -n` 非阻塞尝试租约。
- 旧 helper 留下的无租约挂载：仍由全局 mountinfo 识别（`mounted` ⇒ 拒绝）。
- 互斥结论：同库两个 gocryptfs 同时存活需要两次 `flock -n` 都成功，内核不允许；gocryptfs 自己持 fd 9 直到退出，所以「gocryptfs 活着 ⇒ 租约忙」不依赖 P1 是否存活。

### 3.2 实例记录 `private.json`、阶段与释放协议

- 位置 `<dir>/private.json`（明文区，ns 内外都可见），0600，`writeFileAtomic`（tmp + `O_EXCL|O_NOFOLLOW` + fsync + rename）。读取：本 uid 普通文件、≤4 KiB、JSON、`v===3`；否则损坏 ⇒ 所有挂载入口 fail closed。
- 内容（不含口令与明文）：

```json
{
  "v": 3,
  "instanceId": "9f3c…（128 位随机 hex）",
  "name": "acme",
  "phase": "starting | mounting | launching | setup | session | finalizing",
  "bootId": "<proc/sys/kernel/random/boot_id>",
  "createdAt": "2026-10-23T19:30:00.000+08:00",
  "realCipher": "/home/u/.local/share/pi-toolkit-secure/acme/cipher",
  "realMnt": "/home/u/secure/acme",
  "lease": { "dev": "8:1", "ino": 145137 },
  "owner": { "pid": 1200, "start": 9876543 },
  "supervisor": { "pid": 1201, "start": 9876550 },
  "gocryptfs": { "pid": 1210, "start": 9876601 },
  "pi": { "pid": 1220, "start": 9876650 },
  "piExit": { "code": 0 },
  "inNsDone": true,
  "ns": { "mnt": "mnt:[4026532871]", "user": "user:[4026532870]", "innerUser": "user:[4026532874]" },
  "lazyDetachedAt": "…（可选）"
}
```

- 阶段：`starting`（认领写入）→ `mounting`（P1 已起、ns 已登记、gocryptfs 启动中）→ `launching`（已挂载、挂载后检查、pi 启动中）→ `session`（pi 已登记）→ `finalizing`（pi 已退或启动失败，P1 做 ns 内收尾；收尾结束写 `inNsDone`）。setup 模式：`mounting → setup → finalizing`。
- 写入者：`starting` 由认领子进程写；之后只由持有匹配 `instanceId` 的 P1 写。**P1 从不删除记录**（它自己就是租约持有者之一，无法证明租约已空闲）。
- **释放协议 `releaseRecord(v, instanceId, {waitMs})`**——删除记录的唯一途径，执行者在 ns 外（P0、`lock`、认领）：
  1. 取租约：`flock -o -w <waitMs> -E <BUSY> <lease> node helper.mjs __private-release <name> <instanceId>`（`-o`：锁 fd 不进入 node 命令；flock 进程在命令运行期间持锁）。认领路径已持有 `mount.lock`，按锁顺序只能用 `-n`。取得租约 ⇒ 证明所有 fd 9 持有者（P1、gocryptfs、unshare/pi）都已退出。
  2. 在持租约状态下取 `mount.lock`（`flock -w 2`；认领路径已持有则跳过），比对 `instanceId`。
  3. ns 成员扫描（§3.3）：`bootId` 相同时，枚举同 uid 进程中 `readlink /proc/<p>/ns/mnt === 记录 ns.mnt` 者；必须**完整且为空**（pi 的后代不持 fd 9，靠这一步覆盖）。不完整或非空 ⇒ 不删，返回「仍有成员」。
  4. 删除记录（fsync 目录）→ 依次释放 `mount.lock` 与租约。
  - 取租约超时 ⇒ 记录保留，调用方按 75 处理（§3.6）。
  - **唯一例外**：P0 自己的 shell 链以 `BUSY` 退出（从未 exec 出 P1、从未建 ns）时，P0 可在 `mount.lock` 内删除 instanceId 相同、仍为 `starting` 且没有 `ns`/`supervisor` 字段的记录，无需租约（§2.2 第 6 步）。
- **不变量 I-P3（r3）**：记录只能由 ns 外的执行者，在「真正取得租约 ∧ 持 `mount.lock` 且 instanceId 一致 ∧ 记录 ns 的成员扫描完整为空」时删除；上一条例外除外。由此「无记录」只可能意味着：本实例的所有 fd 9 持有者已退出且 ns 无成员，或该实例从未建过 ns。

### 3.3 判活与终止权

`privateInstanceState(v)` 结合三类证据：租约（只读 `/proc/locks`）、ns 成员扫描、记录。

**stale（可清理）判定（裁定）**：`bootId ≠ 当前`；**或**「租约可获取（`/proc/locks` 无条目）**且**不存在任一进程其 `/proc/<pid>/ns/mnt` 等于记录 `ns.mnt`（扫描完整）」。两项证据任一表明仍有成员 ⇒ 不判 stale、不删除、不允许新挂载（fail closed）。记录没有 `ns` 字段（P1 未登记 ns）时，只看租约与 `owner`/`supervisor` 是否存活。

- ns 标识复用的约束：只有 `bootId` 与当前一致的记录才参与比对（重启后一律 stale）；扫描中 starttime 早于记录 `supervisor.start` 的进程不计为成员（它们不可能是 P1 的后代，只可能是经 `setns` 加入者——R21 范围，且 gocryptfs 本身必为后代、始终计入）。ns id 被内核回收复用给无关 ns 时，匹配会让判定偏向「仍有成员」——这是 fail closed 的误报，`status` 显示 `ns-in-use (unverified)` 与匹配的 pid，由用户核对（R23）。

```
记录不存在：
   租约空闲                                 → none
   租约忙                                   → unrecorded（只报告，阻止挂载，不杀）
记录存在：
   bootId ≠ 当前                            → stale
   租约空闲 ∧ ns 扫描完整为空                → stale（经释放协议清理）
   ns 扫描不完整                             → unknown（阻止挂载，不清理）
   phase=starting  ∧ owner 存活              → starting
   phase=mounting                            → mounting（gocryptfs 字段缺失 = 「尚未登记」，不是「已死」）
   phase∈{launching,setup}                   → launching
   phase=session   ∧ pi 存活且一致            → session
   phase=finalizing ∧ supervisor 存活         → finalizing
   supervisor 已死 ∧ gocryptfs 存活           → orphan（租约必忙：gocryptfs 持 fd 9）
   gocryptfs 已死 ∧ ns 仍有成员（租约忙或空闲）→ orphan-ns
   supervisor 已死 ∧ inNsDone ∧ 租约空闲 ∧ 扫描空 → stale（P0 收尾前崩溃留下的已完成记录）
   其余                                      → unknown（只报告，阻止挂载）
```

- **终止权**（I-P4′）：只有以下进程会被信号：pid+starttime 与记录字段一致的 `supervisor`/`gocryptfs`/`pi`；或 `readlink /proc/<p>/ns/mnt === 记录 ns.mnt` ∧ starttime ≥ `supervisor.start` 的 ns 成员。前提是记录有效、`bootId` 一致、`instanceId` 在锁内复核一致。每个信号前同步复验 starttime 与 ns id，不符即放弃。
- **扫描只做诊断，不授予终止权**：`scanCipherHolders`（读同 uid 进程的 `/proc/<pid>/mountinfo` 查 `source==realCipher`）只用于 `status` 与拒绝文案；`unshare --mount` 会把其他库的全局挂载复制进私有 ns，所以「看得到 B 的 cipher」不代表归属。扫描超时或超上限 ⇒ 「不完整」，展示为 `n/a`，绝不当作「空」。
- 判活单次 ≤2 s（异步 fs + 截止）。

### 3.4 ns 内收尾（P1 `finalizeInNs`，预算 10 s，硬兜底 10.5 s → 75）

1. 记录 `phase:"finalizing"`（instanceId 比对）。
2. 枚举本 ns 成员（排除 P1 与 gocryptfs，≤2 s）。逐个 SIGTERM（先复验）→ ≤2 s → 存活者 SIGKILL → 再扫（最多 3 轮，合计 ≤3.5 s），最后一轮必须为空。stderr 列出被终止的进程——典型是后台 bash job、ns 内首启的 tmux server（外部启动的 tmux server 不在本 ns、不受影响，文案区分）、gpg-agent、ssh ControlMaster、语言服务器。
3. `umount -n <realMnt>`（独立进程组，≤2 s，到期 KILL 不等待）。EBUSY ⇒ `umount -n -l`（≤1 s）。
4. 等 gocryptfs（P1 的子进程，`-fg`）退出（≤2 s）；仍在 ⇒ TERM ⇒ ≤0.5 s ⇒ KILL。
5. 复核：ns 成员为 0（除 P1）∧ gocryptfs 已退出 ⇒ 记录写 `inNsDone:true` ⇒ **P1 直接退出**（不删记录）。P1 退出后 fd 9 的最后一个引用关闭，租约释放；ns 无成员，内核销毁。
6. 任一步预算不足 ⇒ 记录写 `inNsDone:false` 与未完成项，打印「ns 内收尾未完成」，exit 75；P0 随后做外部收尾（§3.5）。

### 3.5 外部收尾 `outerPrivateCleanup(v)`（P0 或 `lock`，预算 10 s，硬兜底 10.5 s）

1. 在 `mount.lock` 内重新判活（§3.3），`instanceId` 比对。
2. 成员集合 = 按记录 ns id 枚举、满足终止权条件的成员（**只有记录有效时**；无记录 ⇒ 不收尾，转为报告）。
3. 非 gocryptfs 成员：TERM → ≤2 s → KILL → 复扫。
4. gocryptfs：TERM（NC7）→ ≤2 s → KILL。
5. 释放 `mount.lock`，调用 `releaseRecord(v, instanceId, {waitMs: 剩余预算})`：成功 ⇒ exit 0；取租约超时或「仍有成员」⇒ 记录保留、列出残留 pid、exit 75。

### 3.6 P0 的结果判定与记录释放（P1 以任何方式结束之后）

时序（正常路径）：

```
pi 退出 ─► P1 写 piExit ─► P1 ns 内收尾（成员清空、umount、gocryptfs 退出）─► P1 写 inNsDone:true ─► P1 退出
     ─► P0（ns 外）：flock -o -w 3 <lease> __private-release ─► 取 mount.lock、比对 instanceId、ns 扫描为空 ─► 删记录 ─► 释放
     ─► P0 以 piExit 退出
```

P0 在 P1 退出后读记录（按 `instanceId`），**不以 P1 的退出码为准**：

| 记录                                                                      | 状态                                        | P0 动作                                                                                   | P0 退出码                                                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 不存在                                                                    | §3.2 例外路径，或已被 `lock` 按释放协议清理 | 无                                                                                        | `BUSY` 例外路径：76；否则 P1 的码（= `piExit` 或启动失败码），附一行说明                                                        |
| 存在，instanceId ≠ 自己                                                   | 继任者的记录                                | **不碰**                                                                                  | P1 的码；附一行说明                                                                                                             |
| 存在，`inNsDone:true`                                                     | 正常收尾完成                                | `releaseRecord(waitMs=3 s)`                                                               | 成功：`piExit`（pi 未跑过则为记录里的失败码 1/69/77/78）；取租约超时/仍有成员：**记录保留，75**，提示 `pi-secure status`/`lock` |
| 存在，无 `ns` 字段                                                        | P1 在建 ns 前失败                           | `releaseRecord(waitMs=3 s)`（此时无持有者，应立即成功）                                   | 成功：P1 的码（1/69）；超时：75                                                                                                 |
| 存在，pi 存活                                                             | P1 被单独杀死                               | 每 500 ms 轮询 pi 的 pid+starttime，**等用户正常退出 pi**，再 §3.5 外部收尾（含释放协议） | 外部收尾成功：`piExit`（缺失时 1）；否则 75                                                                                     |
| 存在，其余（`inNsDone:false`、pi 已死而 P1 未写完、挂载前/中失败且有 ns） | 收尾未完成                                  | §3.5 外部收尾（含释放协议）                                                               | 成功：`piExit`（缺失时 P1 的码或 1）；否则 75                                                                                   |

结果码规则汇总：pi 跑过且记录已按释放协议删除 ⇒ pi 的码；记录未能删除（取租约超时、仍有成员、外部收尾不完整）⇒ 75；pi 之前的失败 ⇒ 各自的码（1/69/76/77/78）。正常退出路径不经过任何 75 分支：P1 退出即释放最后一个 fd 9 引用，P0 的 `flock -w` 立即成功（测试断言正常退出时 P0 的释放耗时 <1 s）。

### 3.7 外部 `lock` 的语义

| 实例状态               | `lock`                                                                                                                                    | `lock --lazy`                                                                                                                                                                                                                                                                                    | `lock --kill`                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `none`                 | 原普通 `lock` 路径，输出不变                                                                                                              | 同左                                                                                                                                                                                                                                                                                             | 同左（提示 `--kill` 只用于 --private 实例）                                            |
| `starting`/`mounting`  | 73「另一个 pi-secure 正在挂载 acme」                                                                                                      | 同左                                                                                                                                                                                                                                                                                             | 同左                                                                                   |
| `launching`/`setup`    | 76（同 session 文案）                                                                                                                     | 76「会话尚未启动完成，稍后再试」                                                                                                                                                                                                                                                                 | 复验 P1 后 SIGTERM：P1 中止启动并收尾；`lock` 等记录消失 ≤10 s，否则转 §3.5            |
| `session`              | 76：「会话仍在运行（pi pid N）：退出 pi 后自动收尾；`--lazy` 摘除该命名空间里的挂载路径；`--kill` 结束会话并收尾」                        | 复验 P1 后 SIGUSR2；P1 在 ns 内 `umount -n -l`，写 `lazyDetachedAt`；`lock` 读 `/proc/<P1>/mountinfo` 确认条目消失 ⇒ 0。文案：「已在私有命名空间内摘除挂载路径。既有 cwd、已打开的文件和运行中的作业可能继续访问明文；插件会在下一次输入/工具调用时拒绝（LOCKED）。要真正结束访问请用 `--kill`」 | SIGTERM 给 P1（P1 TERM pi，≤5 s 后 KILL，再 §3.4）；`lock` 等记录消失 ≤10 s，否则 §3.5 |
| `finalizing`           | 等记录消失 ≤10 s；期间与到期都**重新判活**，只有判为 `orphan`/`orphan-ns` 才转 §3.5                                                       | 同左                                                                                                                                                                                                                                                                                             | 同左                                                                                   |
| `orphan`/`orphan-ns`   | §3.5（终止有证明归属的成员后经释放协议删除）                                                                                              | §3.5（监督者不在，无法在 ns 内 lazy；退化为 TERM gocryptfs，**明确报告**这一退化）                                                                                                                                                                                                               | §3.5                                                                                   |
| `stale`                | `releaseRecord`（真正取得租约 + instanceId 比对 + ns 扫描为空）后 0「清理了失效的 --private 记录」；取不到租约或扫描非空 ⇒ 按复判结果处理 | 同左                                                                                                                                                                                                                                                                                             | 同左                                                                                   |
| `unrecorded`/`unknown` | 76：列出扫描到的持有者（只报告），说明「无法证明归属，不会自动终止；确认后可手工 kill，或重启」                                           | 同左                                                                                                                                                                                                                                                                                             | 同左                                                                                   |
| 调用者在该 ns 内       | 76                                                                                                                                        | 同左                                                                                                                                                                                                                                                                                             | 同左                                                                                   |

### 3.8 `status`

`privateInstanceState` 为 `none` ⇒ 原 `describeVault`，输出不变。否则：

```
acme: private  layout ok  mnt /home/u/secure/acme
  dir /home/u/.local/share/pi-toolkit-secure/acme
  private: session · pi 1220 · supervisor 1201 · gocryptfs 1210 · ns mnt:[4026532871] · since 2026-10-23 19:30 · id 9f3c…
  lease: held
  outside view: not mounted · sentinels ok
  ns members: 4
  boundary: 防路径直读/扫描/备份/其他程序的无意识访问；不防同 uid 定向进程（/proc/<pid>/root、setns）
```

- 库行 token：`private` / `private:starting` / `private:launching` / `private:finalizing` / `private:orphan` / `private:orphan-ns` / `private:stale-record` / `private:ns-in-use` / `lease:unrecorded`。
- 「outside view」= 全局 mountinfo absent ∧ 哨兵通过；全局也挂着 ⇒ `! global mount also present (conflict)`。
- 「ns members」超时 ⇒ `n/a (incomplete)`。在 ns 内执行时追加 `(this process is inside the private namespace)`。

### 3.9 崩溃自愈矩阵

| 崩溃                                                | 结果                                                                                                                                          | 收敛                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| P0 SIGKILL                                          | P1 照常监督、ns 内收尾后退出；记录（`inNsDone:true`）留下，判为 stale（租约空闲 ∧ ns 扫描空）                                                 | 下次 run/lock 经释放协议清理                         |
| P1 SIGKILL（P0 在）                                 | gocryptfs（槽 9）与 pi（槽 9）继续持租约；pi 的后台 job 不持租约但在记录 ns 内 ⇒ 新挂载一律拒绝；P0 等 pi 退出后外部收尾                      | 自动                                                 |
| P1 SIGKILL 且 pi 已退，只剩 gocryptfs 和/或后台成员 | gocryptfs 活 ⇒ 租约忙；gocryptfs 也死而后台成员活 ⇒ 租约空闲但 ns 扫描非空 ⇒ 不判 stale；两种情况下 `run --private` 与普通 `unlock` 都拒绝 76 | `status` 显示 orphan / orphan-ns；`lock` 清理        |
| P0+P1 SIGKILL，pi 在                                | pi 照常；pi 退出后 gocryptfs 孤儿持 ns 与租约                                                                                                 | `status` 显示 orphan；`lock` 清理                    |
| TTY 前台进程组 SIGKILL（`kill -9 -<pgid>`）         | P0/P1/pi 死；**gocryptfs 已 setsid（`detached:true`），不在该进程组，存活并持租约** ⇒ orphan 路径                                             | `lock` 清理                                          |
| 全部进程（含 gocryptfs、成员）被杀                  | ns 无成员 ⇒ 内核拆除挂载、租约释放；记录判为 stale                                                                                            | 下次 run/lock 经释放协议清理                         |
| gocryptfs 被杀但后台 job 还在 ns                    | 挂载 ENOTCONN；后台 job 不持租约，但 ns 扫描非空 ⇒ 不判 stale                                                                                 | `status` orphan-ns；`lock` 按记录 ns id 杀成员后释放 |
| 终端关闭（SIGHUP）                                  | P0 转发 HUP→P1→pi；pi 退出后 P1 收尾（stderr EIO 被吞）                                                                                       | 自动                                                 |
| 记录被删 + 挂载仍在                                 | 租约忙 ⇒ 一切挂载入口拒绝；`status` 显示 `lease:unrecorded` 与扫描到的持有者                                                                  | **手工**（工具不杀无法证明归属的进程）               |
| 有进程持有该 ns 的 fd 或 nsfs bind mount            | 成员全死后 ns 仍存在、挂载不拆                                                                                                                | 残留 R23；`/sys/fs/fuse/connections` 排查            |
| 机器重启                                            | 一切消失；bootId 不符 ⇒ stale                                                                                                                 | 自动                                                 |

---

## 4. web-hub 与其他长期守护

### 4.1 选定：对策 2（ns 内拒绝拉起）+ 启动器非阻断提示

对比同 r1：对策 1（启动器在 ns 外预拉起 hub）要复刻 `wireWebHub` 的整套 `HubConfig` 组装，版本漂移风险大，且 hub 之后重启时发起方仍可能在 ns 内——对策 2 无论如何都要做；对策 3（只披露）不足。

落点（判定统一用 §2.9 的 `isPrivateNsSession()`）：

1. **唯一出口 `spawnHub`**（`src/web-hub/agent/launcher.ts:96-120`）：ns 内直接拒绝（返回「blocked」结果，不 spawn），这是硬闸门，覆盖所有调用方（自动拉起、respawn、restart、start）。
2. `src/web-hub/agent/index.ts:1473` 调 `acquireConnection` 时，ns 内追加 `spawnBlocked`（条件展开，非 ns 时 opts 与现状一致），用于一次性 notify：「本会话运行在私有挂载命名空间内，不会自动拉起 web-hub（它会被困在命名空间里并持有明文视图）。需要网页时，在普通终端的 pi 里执行 /webhub start。」`connection.ts` 为冻结面，不改。
3. `src/commands/webhub.ts` `restart`：ns 内在写 stop 栅栏、发 shutdown **之前**拒绝；`stop` 放行；`start` 照常清除 stop 标记并说明「本会话不会自行拉起」；`open` 只打印 URL、不调用 xdg-open。
4. 启动器提示（P0，进 ns 前）：`webHub.enabled === true` 且两个候选 socket 在 300 ms 内都连不上 ⇒ stderr 一行提示。只打印。
5. **（Q2，推荐做）版本替换循环**：ns 内 agent 在 `capsExtra` 中追加事实标记 `agent.nospawn.v1`（含义「这个 agent 不能拉起 hub」，不是能力），**放在 `control === false` 的提前返回之前**（`src/web-hub/agent/index.ts:1433-1469`），保证任何配置下都发出。hub 侧不改 `onVersion` 签名：`hub.ts:605` 处理版本观察前用现有的 `registry.getCaps(agentKey)`（caps 在 `onVersion` 之前已登记）查看该标记，带标记的 agent 与托管 agent 一样不进 `supersede.observe`。标记只在 ns 内出现 ⇒ 非 ns 与 off 场景 hub 行为不变；旧 hub 不认 ⇒ R25。

### 4.2 hub 在 ns 外处理 vault 会话（无需改 hub）

hub 在初始 ns，vault 路径对它是哨兵 ⇒ 一律 fail closed：

| hub 操作                                | 结果                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| ns 内会话经 agent socket 实时显示       | 正常（D1 不变：内容以明文进入 hub/web/飞书，R12）                                                    |
| managed spawn 到 `~/secure/<名字>/work` | cwd 是哨兵文件 ⇒ `E_DIR`/spawn 失败                                                                  |
| restore / relaunch 旧的 vault 托管会话  | 失败（R13 同类）                                                                                     |
| session-history                         | 只扫 agent dir，vault 会话不在其中                                                                   |
| 网页「从实时会话 fork」                 | 读不到会话文件 ⇒ 失败                                                                                |
| preview 读 vault 路径                   | ENOTDIR；`/proc/<pid>/root/...` 被 `VIRTUAL_ROOTS`（`src/web-hub/hub/preview/admit.ts:131-132`）拒绝 |
| worktree diff / graph                   | 失败并显示错误（agent 侧采样在 ns 内，正常）                                                         |
| web 上传附件                            | 落 hub stateDir（明文，R12）                                                                         |

### 4.3 其他会派生长期守护的路径

| 路径                                                                                         | 私有模式处置                                                                                                            |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| web-hub 自动拉起 / `restart` / supersede                                                     | §4.1                                                                                                                    |
| `/webhub open` → 浏览器                                                                      | ns 内不拉浏览器                                                                                                         |
| bash 后台 job（detached 进程组）                                                             | §3.4 收尾终止；下次 run 时 `recover()` 判 `exited_unknown`                                                              |
| cron / feishu-notify / xs / droid                                                            | secure 下已关闭（D8）                                                                                                   |
| 子 agent / consult / workflow / memory tidy                                                  | 进程内，随 pi 结束                                                                                                      |
| HUD `git fetch`、ssh ControlMaster                                                           | 被困 ⇒ §3.4 终止                                                                                                        |
| 用户在 pi bash 里启动的 tmux server / gpg-agent / credential-cache / 语言服务器 / dev server | 被困 ⇒ §3.4 终止；**仅限本 ns 内首次启动的**（例如 ns 内首启的 tmux server，之后从外部 attach 的会话也会随之结束，R24） |
| 第三方扩展的守护进程                                                                         | 同上；R11                                                                                                               |

---

## 5. 安全边界的如实表述

### 5.1 固定措辞

- 短句（`status` 的 `boundary:` 行、`/secure status`）：「防路径直读/扫描/备份/其他程序的无意识访问；不防同 uid 定向进程（/proc/<pid>/root、setns）」
- 长句（USAGE、README、acceptance、**每次**私有启动时 stderr 打印一次）：

> `--private`：明文挂载只存在于本次 pi 进程树的私有挂载命名空间里。其他程序按路径访问保险库只会看到占位文件，`find`/`grep`/备份工具/其他 agent 的无意识访问都会被挡住。它**不能**防御同一用户下有意的恶意进程：这类进程可以经 `/proc/<pid>/root`、`/proc/<pid>/cwd` 读到明文，或用 `setns` 加入该命名空间。若需要硬边界，请用独立的系统用户运行 pi-secure。

- `--lazy` 固定措辞：「摘除该命名空间里的挂载路径；既有 cwd、已打开的文件和运行中的作业可能继续访问；插件在下一次输入/工具调用时拒绝。」

### 5.2 落点

| 位置                      | 内容                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `helper.mjs` USAGE        | 新增 `--private/--no-private/--kill/--global` 用法行（固定顺序写法）+ 长句                                                                                |
| `pi-secure status`        | `boundary:` 行（仅私有实例）                                                                                                                              |
| `/secure status`（ns 内） | 「私有命名空间：是（acme）」+ 短句                                                                                                                        |
| acceptance.md J 节        | 「外部视角挡住」与「/proc root 仍可读（已知残留）」两面                                                                                                   |
| README                    | 用户指南：何时用、边界、独立用户加固；**`init --private` 库的迁移与手工操作步骤**（在 pi 会话里用 `!` 命令完成 git/拷贝，因为 r2 不提供 ns 内 shell，Q7） |
| plan.md §5                | 新残留 R20–R25                                                                                                                                            |

### 5.3 可选加固建议（README，不由工具实现）

1. 独立系统用户（唯一硬边界）。代价：web-hub、`~/.pi` 配置、ssh 密钥需按该用户单独配置。
2. `/proc` 以 `hidepid=` 重挂、`yama.ptrace_scope=2/3`：本机未实测对同 uid root/cwd 链接的效果，只作参考。
3. 不要在私有会话里启动常驻服务。

### 5.4 新增残留（并入 plan.md §5）

| #   | 路径                                                 | 影响                                                                                                                                                   | 缓解                                    |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| R20 | 同 uid `/proc/<pid>/root`、`/proc/<pid>/cwd`         | 同 uid 进程可读私有挂载中的明文                                                                                                                        | 独立系统用户                            |
| R21 | `setns` userns owner 规则                            | 同 uid 可依次加入外层 userns + mntns                                                                                                                   | 同上                                    |
| R22 | `/proc/<pid>/{maps,mountinfo}`、`/proc/locks` 信息面 | 暴露「存在私有挂载」与 cipher/租约路径                                                                                                                 | 知悉                                    |
| R23 | 孤儿窗口 / ns id 复用 / 额外 ns 引用                 | 监督者全部丢失时明文持续存在于 ns 直到 `lock`；有进程持有 ns fd 或 nsfs bind mount 时 ns 不随成员退出销毁；ns id 复用由 bootId+starttime+双 ns id 规避 | `status`；`/sys/fs/fuse/connections`    |
| R24 | 被困守护                                             | ns 内启动的常驻进程收尾时被终止（含 ns 内首启的 tmux server）                                                                                          | 不在私有会话里起常驻服务                |
| R25 | 旧 hub 的版本替换循环                                | 旧 hub 不认 `agent.nospawn.v1` 时仍可能反复替换                                                                                                        | 在普通会话里 `/webhub restart` 升级 hub |
| R29 | `--lazy` 后的既有访问                                | 已打开的 fd、cwd 在挂载内的进程、运行中的作业可继续访问到会话结束                                                                                      | `--kill`                                |
| —   | D1/R12                                               | 私有模式不改变 D1                                                                                                                                      | Q8                                      |

---

## 6. 测试与验收

### 6.1 单测（vitest，无特权、无 FUSE）

`tests/secure/launcher-private-unit.test.ts`（fs/proc 全部注入）：

- `parseRunFlags`：无新参数时与旧切分逐元素相同（含重复 `-C`、`-C` 缺值、`--`、消息正文里含 `--private` 字样）；`--private` 只在紧跟名字时识别；`-C` 仍只认第一个位置；两个新参数同用 ⇒ 2。
- 记录：读写往返、O_EXCL、损坏判定（符号链接/他人属主/超 4 KiB/坏 JSON/`v≠2`）；instanceId 读-比较-写（不一致 ⇒ 不写、不删）。
- `/proc/locks` 解析：FLOCK/POSIX/OFD 条目、`maj:min:ino` 匹配、读取失败 ⇒ 不确定。
- `privateInstanceState` 全矩阵（假 `/proc` 树）：所有阶段、gocryptfs「未登记」vs「已死」、pid 复用、ns id 复用、`unrecorded`。
- 终止权：无记录时收尾函数不发任何信号（spy）；扫描到的他库 cipher 不进入成员集合。
- `lock` 决策表（§3.7 每格）、`status` 渲染。
- P0 结果表（§3.6 每行，含 P1 正常退出 1/127 而记录仍在）。
- 预算：worker TERM→KILL→放弃；记录写截止；收尾硬兜底 ≤10.5 s。
- `privatePreflight` 各失败文案。

**屏障并发测试**（注入可控屏障的假端口，断言「真实挂载至多一个、失败方停止、未授权会话从未被信号、继任者记录从未被删」）：

1. 两个 `run --private` 同时认领。
2. 普通 `unlock` 与私有 P0→P1 交接交错（屏障停在 P0 拿到租约前/后）。
3. P0 在 P1 自检通过后被杀，随即第二个 `run --private`。
4. 记录丢失 + 扫描不完整时的 `unlock` / `run --private` / `lock`。
5. B 已全局挂载时 `run --private A`（拒绝）；A 私有运行中 `lock B` 的扫描结果不导致对 A 的任何信号。
6. 释放协议竞争：P0 的 `releaseRecord` 与 `lock` 的 `releaseRecord`、与一次普通 `unlock` 交错——断言只有一方删除、删除时租约确实在删除者手里、普通 `unlock` 在记录仍在时拒绝；锁顺序（租约 → `mount.lock`；持 `mount.lock` 时只用 `-n`）下无死锁。

另增：

- `releaseRecord`：取租约超时 ⇒ 不删；ns 扫描不完整或非空 ⇒ 不删；instanceId 不符 ⇒ 不删；§3.2 例外只在「无 `ns`/`supervisor` 字段 ∧ `starting` ∧ 本 instanceId」时生效。
- stale 判定矩阵（§3.3）：租约空闲 × ns 扫描（空/非空/不完整）× bootId × 有无 `ns` 字段 × starttime 早于 `supervisor.start` 的进程。
- spawn 参数构造：gocryptfs 与内层 unshare 的 `stdio` 恰为「0–2 inherit、3–8 ignore、9 = 9」且 `detached` 符合 §2.3；worker、flock、umount 的 `stdio` 不含槽 9。
- P1 从不调用删除记录的函数（spy）。

插件侧：

- `tests/secure/domain.test.ts`：证据式 ns 判定矩阵（自身 ns × 记录 ns × env 有无 × vault cwd / 非 vault cwd）；非 ns 时 domain 对象无 `ns` 键。
- `tests/secure/guards.test.ts`：普通会话对 `/proc/<pid>/root/<vault>/…` 的 read/grep 与 bash 文本被 D4 拦截。
- parity：追加 `private:true`、`private:"yes"`、含 `PI_SECURE_NS` 的 `hubSafeEnv`、`parsePrivateRecord` 用例（L0 之后只追加）。
- `tests/web-hub/agent/*`：ns 时 `spawnHub` 不 spawn（含 respawn/restart 路径）、`acquireConnection` 收到 `spawnBlocked` 且一次性 notify；`agent.nospawn.v1` 在 `control:false` 下也发出；非 ns 时 opts 与 caps 深度相等于现状。`tests/commands/webhub*.test.ts`：ns 内 `restart` 在任何 hub 交互前拒绝、`open` 不调用 opener。
- （Q2）hub：`registry.getCaps()` 带标记的 agent 不进 `supersede.observe`；不带时不变。

### 6.2 启动器 e2e（真 gocryptfs + 真 unshare，假 pi）

`tests/secure/launcher-private.test.ts`，自门控（Linux + gocryptfs + fusermount3 + flock + script + unshare + `privatePreflight` 通过）：

1. 正路径：假 pi 报告真实 uid、`CapEff=0`、ns 不同、能读写 work；会话期间外部断言 `~/secure/acme/work` 为哨兵、全局 mountinfo 无条目、`/proc/locks` 有租约、`status` 显示 `private`；退出码透传；收尾后记录删除、租约释放、普通模式重挂读到数据。
2. 遗留成员：假 pi 起 `setsid sleep 1000` 后退出 ⇒ 收尾列出并终止，ns 消失。
3. 互斥：普通挂载中 `run --private` ⇒ 76 且无口令提示；私有运行中 `unlock`/普通 `run`/第二个 `run --private` ⇒ 76；另一库全局挂载时 `run --private` ⇒ 76；ns 内 `lock` ⇒ 76。
4. `lock` 各参数；**`lock` 落在 launching 窗口**（测试缝让挂载后检查停 2 s）⇒ 76，会话不受影响。
5. `--lazy` 控制组：假 pi 持有一个已打开 fd、一个 cwd 在挂载内的后台进程 ⇒ lazy 后它们仍可读（照实断言，R29），新的路径访问失败，插件复检 LOCKED。
6. 崩溃：SIGKILL P1；SIGKILL P0+P1；前台进程组 SIGKILL（gocryptfs 已 setsid 存活 ⇒ orphan）；删除记录 ⇒ `lease:unrecorded`、所有挂载入口拒绝、`lock` 不杀；bootId 不符记录 ⇒ 清理。
   6a. **B1 闸门（裁定新增）**：生产命令链 `sh → unshare → Node P1 → spawn gocryptfs -fg`（不得用 shell 直接 exec gocryptfs 代替）。会话内起一个后台 job（`setsid sleep 1000`，不持 fd 9），然后 SIGKILL P1，并确认 P0、P1、shell 链均已不在：
   - (a) gocryptfs 与后台 job 都活：`/proc/locks` 仍有租约条目，且持有者经 `/proc/<gocryptfs>/fd/9` 核实是 gocryptfs；新的 `run --private` 与普通 `unlock` 都 76、无口令提示。
   - (b) 再 SIGKILL gocryptfs，只剩后台 job：租约可获取，但 ns 扫描非空 ⇒ `status` 为 `orphan-ns`；`run --private` 与普通 `unlock` 仍都 76。
   - (c) 在 (a)/(b) 状态下删除 `private.json`：(a) 由租约拒绝（`lease:unrecorded`）；(b) 无记录且租约空闲 ⇒ 允许新挂载（此时只剩不持 fd 的后台进程，原 gocryptfs 已死，挂载 ENOTCONN，不存在双 gocryptfs）——测试照实断言，区分「记录拒绝」与「实际租约仍在」。
   - (d) `lock acme` 终止后台 job 并经释放协议删除记录 ⇒ 之后新挂载成功。
     6b. **B2 正常收尾**：假 pi 正常退出 ⇒ P1 写 `inNsDone:true` 后退出、P1 退出时记录仍在；P0 取租约成功（<1 s）、删除记录；全程不经过任何 75 分支；P0 退出码 = pi 退出码。另测：P1 写完 `inNsDone` 后 P0 被 SIGKILL ⇒ 记录残留，`status` 判 stale，下次 `run --private` 经释放协议清理后继续。
7. P1 正常非零退出（假 pi `exit 1`、`exit 127`；P1 自检失败 exit 1）⇒ P0 结果符合 §3.6。
8. 有界：忽略 TERM 的成员 ⇒ KILL；`SIGSTOP` gocryptfs（就绪后）使挂载内同步 fs 卡住 ⇒ worker 被 KILL/放弃，P1 75，P0 外部收尾，总时长 ≤22 s；`mount.lock` 被外部长期持有 ⇒ 73；gocryptfs 不退出 ⇒ KILL 路径。
9. 参数被拒 ⇒ 64，无认领、无口令、无记录。
10. `init --private`：setup 在 ns 内完成，结束后无任何挂载、租约空闲。

### 6.3 Conformance（真 gocryptfs + 真 unshare + 真 pi）

`tests/conformance/secure-private-ns.test.ts`，自门控；在 pi peer、gocryptfs、util-linux/内核升级前运行。探针输出统一的 `CHECK <id> PASS|FAIL|KNOWN <detail>`。

| #    | 钉住的事实                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NC1  | `unshare` 功能参数齐全；userns 内 tmpfs 挂载可行                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| NC2  | **前置闸门（生产命令链）**：`sh(exec 9<>; flock -n 9) → unshare → Node P1 → spawn gocryptfs -fg（detached + 槽 9）`：口令能从继承的 TTY fd 读入（setsid 后无 SIGTTIN）；`-notifypid` 在挂载就绪后向 P1 发 SIGUSR1；gocryptfs 与 P1 同 mnt ns、`sid==pid`；`/proc/<gocryptfs>/fd/9` 指向租约；**SIGKILL P1 并确认 shell 链与 P1 已不在后**，`/proc/locks` 仍有条目、`flock -n` 失败；gocryptfs 退出后条目消失。只观察到「挂载父进程退出而 `/proc/locks` 仍有条目」不算通过（可能是 P1 自己持锁） |
| NC2b | Ctrl-C/终端挂断：`pi -p` 运行中在 TTY 上按 Ctrl-C，gocryptfs 不受影响（setsid），由 pi 自己退出后按正常收尾；照实记录                                                                                                                                                                                                                                                                                                                                                                           |
| NC2c | 普通模式：`sh(exec 9<>; flock -n 9; exec gocryptfs)` 守护化后，在 shell 链与挂载父进程都退出的情况下，守护进程的 `/proc/<pid>/fd/*` 含租约、`/proc/locks` 有条目；卸载后消失（复核 P0-report 结论）                                                                                                                                                                                                                                                                                             |
| NC3  | 内层 uid/gid 真实、`CapEff=0`、`umount` 保险库 EPERM、无法 `setns` 回初始 ns                                                                                                                                                                                                                                                                                                                                                                                                                    |
| NC4  | 外部视角：哨兵完好、全局 mountinfo 无条目、外部 `find`/`grep -r` 看不到明文                                                                                                                                                                                                                                                                                                                                                                                                                     |
| NC5  | 外部读 `/proc/<成员>/mountinfo` 可见 `source==realCipher`；**另一库的全局挂载会被复制进新 ns**（Q10 的依据）                                                                                                                                                                                                                                                                                                                                                                                    |
| NC6  | ns 内 `umount -n` 成功；cwd 持有者 ⇒ EBUSY；`-l` 成功；最后成员退出后 ns 销毁、租约释放、可重挂                                                                                                                                                                                                                                                                                                                                                                                                 |
| NC7  | 外部 TERM gocryptfs 的实际表现照实记录                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| NC8  | 孤儿：杀监督者后 gocryptfs（setsid）存活并持租约；按 ns id 杀成员后 ns 消失、租约释放                                                                                                                                                                                                                                                                                                                                                                                                           |
| NC9  | **KNOWN**：同 uid `/proc/<pid>/root` 可读明文、`setns` PoC 成功                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| NC10 | 真 pi 在内层：`pi --version` 成功；`pi --no-extensions -p` 在 C5 隔离环境（临时 HOME、最小 env、空凭据）下 ⇒ "No API key"（零模型请求）                                                                                                                                                                                                                                                                                                                                                         |
| NC11 | gocryptfs 1.8 退出码集合不含 `BUSY`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| NC12 | Node fd 事实（§2.1）：继承的 fd 9 在 Node 内被置 CLOEXEC；`stdio:"inherit"`/`detached`/嵌套 Node 的子进程拿不到 fd 9；显式槽 9 的子进程拿到无 CLOEXEC 的 fd 9；pi 的 bash 工具与后台 job（`src/bash/process.ts` 的 `stdio:["ignore","pipe","pipe"]`）不持 fd 9。Node 升级前必须重跑                                                                                                                                                                                                             |

探针 `--fast`：跳过所有在线 pi 项；所有真 pi 项一律用 C5 隔离；探针清理时对每个 pid 先复验 starttime 再发信号。

### 6.4 acceptance.md 新增「J. --private 私有挂载命名空间」

（真机 tmux，逐项记录输出；路径按 §L 新布局）

- [ ] `pi-secure run acme --private`：stderr 先出现 §5.1 长句；口令提示；pi 启动；`/secure status` 含「私有命名空间：是（acme）」与短句。
- [ ] 另开普通终端：`ls -l ~/secure/acme` 只见两个哨兵；`cd ~/secure/acme/work` 失败；`grep gocryptfs /proc/self/mountinfo` 无；`grep -rFa "$CANARY" ~/secure/acme` 零命中；`pi-secure status acme` 显示 `private`、`lease: held`、`outside view: not mounted · sentinels ok`、`boundary:`。
- [ ] **已知残留（KNOWN）**：`cat /proc/<pi pid>/root/home/<u>/secure/acme/work/<文件>` 读到明文。
- [ ] 普通终端 `pi-secure unlock acme` / 再开 `run acme --private` ⇒ 76 且不问口令；另一库 B 已 `unlock` 时 `run acme --private` ⇒ 76。
- [ ] 会话内 `!sleep 1000 &` 后 `/quit` ⇒ 收尾列出并终止；`status` ⇒ locked。
- [ ] 会话中 `lock` ⇒ 76；`--lazy` ⇒ 先在会话里 `!cd ~/secure/acme/work && sleep 600 &`、`!exec 3<文件` 等控制项，lazy 后照实记录它们的可访问性，新的工具调用 ⇒ `secure:locked`；`--kill` ⇒ 会话结束并收尾。
- [ ] `kill -9 <P0> <P1>` 后在 pi 里 `/quit` ⇒ `private:orphan` ⇒ `lock` 清理。
- [ ] 会话内 `!setsid sleep 1000 &` 后单独 `kill -9 <P1>`：另一个终端 `run acme --private` 与 `unlock acme` 都 76；`/quit` 后再 `kill -9 <gocryptfs>`，只剩 sleep 时仍都 76（`status` 为 `private:orphan-ns`）；`lock acme` 清理后可正常挂载。
- [ ] 正常 `/quit`：退出码透传，`status` 立即为 locked（无 75、无「收尾未完成」提示）。
- [ ] web-hub：hub 未运行 ⇒ 启动器提示 + 会话内一次性 notify，hub 未被拉起；会话内 `!pi` 嵌套启动（env 已被剥离的情形同样）也不会拉起 hub；hub 已运行时网页能实时看到会话；`/webhub restart` 被拒、`/webhub open` 只打印 URL。
- [ ] 兼容性：git commit/push（ssh）、node、`ls -l /etc`（`nobody nogroup`）、`sudo -v`（预期失败）。
- [ ] 系统前置：AppArmor 限制开启时 ⇒ 69 并说明；不带 `--private` 照常可用。

### 6.5 冻结面验证

- `secure-off-golden.json`、三份 fabric off golden：不改、必须通过。
- **N0** `tests/secure/launcher-off-golden.test.ts` + `tests/fixtures/secure-launcher-off-golden.json`：**在 L0 合入之后、N1 之前**用当时代码生成，此后永不重生成。假 gocryptfs/fusermount3/flock/pi 驱动 `status`/`unlock`/`lock`/`run`/`init` 各分支（含 `run` 的重复 `-C`、`-C` 缺值、`--`、消息含新参数字样），钉住 stdout/stderr 字节与退出码（不含 USAGE 场景，Q9）。

---

## 7. 分包、冻结面与估时

### 7.1 分包（与 convert-plan §8 统一）

| 包                       | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 文件域                                                                                                                                                                          | 依赖                     | 估时  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----- |
| **L0** 布局              | §L 全部：helper/config/domain/guards/command 路径改造、`mount.lease` 文件、旧布局只读兼容、parity 一次性修订、测试路径更新、plan.md §2.1/§0.5 与 acceptance 路径修订                                                                                                                                                                                                                                                                                                                       | `src/secure/{bin/helper.mjs,config,domain,guards,command}.ts`、`tests/secure/**`、`tests/fixtures/secure-contract-parity.json`、`docs/dev/data-encryption/{plan,acceptance}.md` | —                        | 1d    |
| **N0** 基线 golden       | 用 L0 之后的代码生成启动器 off golden                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `tests/secure/launcher-off-golden.test.ts`、`tests/fixtures/secure-launcher-off-golden.json`                                                                                    | L0                       | 0.25d |
| **N1** 启动器核心        | `parseRunFlags`、`privatePreflight`、`/proc/locks` 探测、shell 租约链（普通 `__mount` 与私有）、显式 stdio 槽 9、记录 v3 读写 + instanceId CAS、`releaseRecord`/`__private-release`、`privateInstanceState`、扫描器、`__private-claim`、`__ns-root`、`__mount-work` worker、`finalizeInNs`、P0 编排与结果表、`outerPrivateCleanup`、`piChildEnv` 加 `PI_SECURE_NS`；`parseSecureConfig` 加 `private` 与 `parsePrivateRecord`（helper + `config.ts` 同包）；parity 追加；单测与屏障并发测试 | `src/secure/bin/helper.mjs`、`src/secure/config.ts`、parity fixture、`tests/secure/launcher-private-unit.test.ts`、`tests/secure/config-parity.test.ts`                         | N0                       | 2d    |
| **N2** 命令面整合        | `cmdInnerMount` 租约与冲突检查、`cmdLock`（`--kill`、阶段表）、`cmdStatus`/`describeVault` 私有分支、`cmdInit --private`/`--fix-settings` setup 模式、`cmdUnlock --global`、`registerVault` 写 `private`、USAGE、`main` 内部子命令                                                                                                                                                                                                                                                         | `src/secure/bin/helper.mjs`、单测                                                                                                                                               | N1                       | 1d    |
| **N3** 插件 + web-hub    | `env.ts`；`domain.ts` 证据式 ns 判定；`command.ts`；`launcher.ts` `spawnHub` 闸门；`agent/index.ts` 条件 `spawnBlocked` + `agent.nospawn.v1`（提前返回之前）；`commands/webhub.ts`；（Q2）`hub/hub.ts` 经 `registry.getCaps` 跳过；测试                                                                                                                                                                                                                                                    | `src/secure/{env,domain,command}.ts`、`src/web-hub/agent/{launcher,index}.ts`、`src/commands/webhub.ts`、（Q2）`src/web-hub/hub/hub.ts`、对应测试                               | L0（记录格式在本文冻结） | 1.25d |
| **N4** e2e + conformance | §6.2、§6.3；探针 `CHECK` 行与 NC 项、`--fast` 零请求                                                                                                                                                                                                                                                                                                                                                                                                                                       | `tests/secure/launcher-private.test.ts`、`tests/conformance/secure-private-ns.test.ts`、`scripts/dev/secure-ns-probe.sh`                                                        | N1、N2                   | 1d    |
| **N5** 文档              | `plan.md` §2.8「私有模式」+ R20–R25/R29；acceptance J 节；README；AGENTS.md 一句；报告                                                                                                                                                                                                                                                                                                                                                                                                     | 文档                                                                                                                                                                            | N1–N4                    | 0.5d  |

```
L0 ─► N0 ─► N1 ─► N2 ─┬─► N4 ─► N5
 └──► N3 ─────────────┘
convert（见 convert-plan §8）：V1/V2/V3 随时可并行 ─► V0（N2 之后）─► V4/V5 ─► V6 ─► V7 ─► V8
```

合计：L0 1d；`--private` 6d（N0 0.25 + N1 2 + N2 1 + N3 1.25 + N4 1 + N5 0.5）。车道 dev-flow L3；每包返回即派 verifier（验收模型 ≠ 开发模型）；N1、N2 额外安全向 review（fd 9 持有者清单、释放协议与锁顺序、instanceId CAS、终止权、worker 有界、fail closed）。NC2/NC12 在 N1 开工前先跑（前置闸门）。

### 7.2 冻结面

| #   | 冻结项                                                                                                               | 守护                           |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| F1  | L0 之后，不带 `--private`、库未配置 `private`、无 `private.json`、租约空闲时：`pi-secure` 全部子命令输出与退出码不变 | N0 golden + 既有 launcher 测试 |
| F1a | 输出/退出码例外：USAGE 新增行（Q9）；租约忙或存在私有记录时普通入口的新拒绝（只在这些新状态下出现）                  | 单测                           |
| F1b | argv 语义例外：`run <name> --private`/`--no-private` 被启动器消费（过去交给 pi）                                     | `parseRunFlags` 冻结用例       |
| F1c | 时延例外：普通 `__mount` 增加一次 `/proc/locks` 读取（≤2 s 截止，通常 <10 ms）；无扫描                               | 单测                           |
| F2  | `secure-off-golden.json` 不变                                                                                        | `off-golden.test.ts`           |
| F3  | 三份 fabric off golden 不变                                                                                          | 既有测试                       |
| F4  | parity fixture：L0 一次性修订后只追加；`private` 缺省时无该键                                                        | parity 测试                    |
| F5  | 非 ns ⇒ domain 对象、`/secure status`、`acquireConnection` opts、caps、`/webhub` 行为不变                            | N3 测试                        |
| F6  | agent 不带 `agent.nospawn.v1` ⇒ hub supersede 行为不变                                                               | N3（Q2）测试                   |
| F7  | 普通模式 D1–D9、§2.2.1 审查规则、§2.5 有界收尾不变                                                                   | 既有测试                       |

### 7.3 不变量

- **I-P1** 口令只经 TTY 直输 gocryptfs。
- **I-P2** 同一保险库任一时刻至多一个 gocryptfs——由租约保证（每个 gocryptfs 自己持 fd 9 直到退出）；新挂载另要求不存在非 stale 的私有记录（记录 ns 无成员）；任何「不确定」（`/proc/locks` 读不到、记录损坏、扫描不完整）一律拒绝。
- **I-P3** 记录只能由 ns 外的执行者（P0、`lock`、认领）删除，条件是真正取得租约（证明所有 fd 9 持有者已退出）∧ 持 `mount.lock` 且 instanceId 一致 ∧ 记录 ns 的成员扫描完整为空；P1 从不删除记录。唯一例外：从未建 ns 的 `starting` 记录由其 P0 在 `mount.lock` 内删除（§3.2）。
- **I-P4** 只信号记录证明归属的进程；每个信号前同步复验 pid+starttime（+ns id）。
- **I-P5** 监督者不在挂载路径上做同步 fs；所有非交互阶段有界（§2.6）；定时器 unref，硬兜底 `process.exit(75)`。
- **I-P9** fd 9 只由 shell 打开；Node 层只经显式 stdio 槽 9 传给 gocryptfs 与内层 unshare→pi，其他子进程一律不给；任何「继承」结论都以 NC2/NC12 为准。
- **I-P6** 负载永远以真实 uid、零能力运行。
- **I-P7** 私有实例的外部收尾只用信号，从不调用 `fusermount3`。
- **I-P8** 冻结面 F1–F7。

---

## 8. 风险表

| #   | 风险                                                                                              | 概率/影响               | 对策                                                                               |
| --- | ------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| K1  | 用户把 `--private` 理解为「防恶意软件」                                                           | 中/高                   | §5.1 固定措辞全覆盖；acceptance 演示 `/proc/<pid>/root`                            |
| K2  | AppArmor 限制非特权 userns                                                                        | 中/中                   | `privatePreflight` 保守拒绝，69                                                    |
| K3  | 同一密文目录并发挂载损坏                                                                          | 极低（租约）/高         | I-P2；屏障并发测试                                                                 |
| K4  | 被困守护在收尾时被杀                                                                              | 中/中                   | 列出被终止进程；R24                                                                |
| K5  | ns 内 setuid 程序失效、`nobody:nogroup` 显示                                                      | 高/低                   | 文档 + acceptance                                                                  |
| K6  | 嵌套 userns 工具                                                                                  | 低/低                   | acceptance 记录                                                                    |
| K7  | fd 9 传递事实随 Node/gocryptfs 版本变化（如 Node 改变 CLOEXEC 行为、gocryptfs `-fg` 关闭继承 fd） | 低/高                   | NC2/NC2c/NC12 前置闸门，Node 与 gocryptfs 升级前重跑；判活另有 ns 扫描兜底         |
| K18 | `-fg` 的 gocryptfs 在 setsid 后读 TTY 口令的行为与预期不符                                        | 低/中                   | NC2 前置闸门；不成立时停在 N1 之前回到主会话裁定（不得退回守护化而不重做 B1 论证） |
| K8  | ns 内 `umount` 行为差异                                                                           | 低/低                   | `-n`；NC6                                                                          |
| K9  | ns id 复用误杀                                                                                    | 极低/高                 | I-P4 + 记录 instanceId + 双 ns id + starttime 下界                                 |
| K10 | 旧 hub 版本替换循环                                                                               | 低/中                   | Q2；R25                                                                            |
| K11 | IDE/普通终端看不到项目                                                                            | 中/低                   | README；`outside view` 行                                                          |
| K12 | hub 侧功能对私有会话降级                                                                          | 高/低                   | §4.2                                                                               |
| K13 | TTY 断开时 P1 写 stderr 崩溃                                                                      | 低/中                   | try/catch；e2e HUP                                                                 |
| K14 | 收尾最坏 21 s                                                                                     | 低/低                   | 测试断言 ≤22 s                                                                     |
| K15 | FUSE 中断后页缓存仍可被已打开文件读到                                                             | 低/低                   | 收尾先杀成员；R29                                                                  |
| K16 | 「未登记持有者」需要人工处理                                                                      | 低/中                   | `status` 列出持有者与排查步骤；工具宁可不杀                                        |
| K17 | 旧布局库无法直接解锁                                                                              | 低（大概率无真实库）/中 | §L.3 迁移指引                                                                      |

---

## 9. 待决问题

**已拍板（用户 2026-10-23）**：

| #    | 问题                                                     | 拍板结果                                                                                                                                                                          |
| ---- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q-L0 | 旧布局保险库的处理                                       | 只读兼容：`status`/`lock`/`export` 可用；`unlock`/`run`/`run --private`/`init --fix-settings` 拒绝（78），提示「无数据删除重建 / 有数据 export→import」（§L.3）。不做就地迁移命令 |
| Q2   | `agent.nospawn.v1` 标记让 hub 跳过 ns 会话的版本替换观察 | 做：经现有 `registry.getCaps`，标记放在 `control:false` 提前返回之前（§4.1-5）                                                                                                    |
| Q10  | 另一个保险库全局挂载时是否拒绝 `run --private`           | 拒绝（76），提示先 lock 另一库（§1.2、§2.2-4）                                                                                                                                    |
| Q3   | 收尾时 ns 内遗留进程                                     | 只终止有记录证明属于本实例的进程并列出；未登记的持有者只报告、不杀；文案区分 ns 内首次启动与外部启动的 tmux server（§3.3 终止权、§3.4-2、§3.7）                                   |

**评审已同意，按 r1 推荐保留**（无需再拍板，列出供确认）：Q1 对策 2；Q4 同库拒绝多实例；Q5 私有库全局解锁需 `--global`（不绕过互斥）、`--no-private` 打印可见性提醒；Q6 `--lazy`/`--kill` 分开（措辞按 §5.1 修订）；Q7 r2 不做 ns 内 shell（README 给出 `init --private` 库的 pi 内操作步骤）；Q8 维持 D1；Q9 USAGE 直接增加新行，每次私有启动打印边界长句。

**技术待定**（conformance 决定）：T1 已由 r3 裁定关闭（私有模式 `-fg`，NC2 只做验证）；T2 有占用时外部 TERM gocryptfs 的表现（NC7，只影响文案）；T3 `BUSY` 取值（NC11）。

---

## 10. 退出码（统一表，与 convert-plan §6 相同）

| 码      | 含义                                                                                                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0       | 成功（convert 成功但收尾时挂载被占用而保持挂载，同 `run` 口径，仍为 0 并提示）                                                                                              |
| 1       | 一般失败 / 用户取消（只有真的什么都没改时才说「未做任何修改」；回滚后说「已回滚」）；import 已提交但迁址未完成                                                              |
| 2       | 用法错误 / 需要 TTY                                                                                                                                                         |
| 64      | pi 参数被拒；私有库不带 `--global` 的 `unlock`                                                                                                                              |
| 65      | 源目录或包内容不合格（路径、挂载点、属主/组、特殊位、xattr、特殊文件、外部硬链接、逃逸符号链接、git 结构、改名失败、恶意或损坏的 tar、MANIFEST 不符、密文 mode 超出 0o777） |
| 66      | 未找到保险库 / 文件                                                                                                                                                         |
| 69      | 前置缺失（userns；convert 的 `getfattr`、git、`mv -n -T`、`sync -f`）                                                                                                       |
| 73      | 锁忙（`mount.lock`、settings 锁、转换锁）；挂载/卸载/导出进行中（含私有实例 `starting`/`mounting`）                                                                         |
| 74      | 拷贝/校验/IO/持久化屏障失败、空间不足，已回滚；或回滚未完成（附剩余项）                                                                                                     |
| 75      | 预算耗尽 / 停滞看门狗 / 硬兜底                                                                                                                                              |
| 76      | 占用或状态冲突（已挂载、租约忙、私有实例运行中、源被占用、待完成的转换/导入、原路径在窗口内被重新占用）                                                                     |
| 77      | 口令连错 3 次（import 时导入结果保留）                                                                                                                                      |
| 78      | 配置错误（名字已登记、目录/挂载点已存在、sessionDir 冲突、旧布局、迁址未完成、目标文件已存在）                                                                              |
| 130/143 | 被中断，文案说明实际结果                                                                                                                                                    |

---

## 附：关键代码坐标

- 启动器：`src/secure/bin/helper.mjs`——`deriveVault`(76)、`parseSecureConfig`(93)、`physicalPaths`(207)、`registerVaultUnlocked`(372)/`registerVault`(397)、`resolveVault`(440)、`checkLayout`(475)、`linkState`(509)、`createLayout`(521)、`createLink`(539)、`ensureVaultDirs`(554)、`verifyRunPaths`(592)、`syncProjectSettings`(648)、`cmdInnerMount`(1265)、`doMount`(1317)、`postMount`(1338)、`unlockVault`(1360)、`cmdInit`(1420)、`describeVault`(1495)、`resolveRunCwd`(1572)；另有 `cmdRun`、`runPiChild`、`piChildEnv`、`finalize`/`finalizeBounded`/`armHardExit`、`scanCwdOccupants`、`probeMountState`/`probeReaddirChild`、`cmdLock`、`cmdStatus`、`USAGE`、`main`。
- 插件：`src/secure/domain.ts`（`statePathsOf`:105、`inVaultMount`:121、`inVaultWriteZone`:130、`inVaultDir`:136、`judgeVaultMount`:190、`computeSecureDomain`:209、`initSecureDomain`:270）；`src/secure/guards.ts`（`vaultOfPath`:54、`vaultSpellings`:70）；`src/secure/config.ts`（`deriveVault`:77、`link` 解析:139）；`src/secure/env.ts`；`src/secure/command.ts`。
- web-hub：`src/web-hub/agent/launcher.ts:96-120`（`spawnHub`）；`src/web-hub/agent/index.ts:1433-1469`（`capsExtra` 与 `control` 提前返回）、`:1473-1486`（`acquireConnection`）；`src/web-hub/agent/connection.ts:206,828-850`（冻结面）；`src/commands/webhub.ts:318-340,873-917`；`src/web-hub/hub/hub.ts:596-614`（`onVersion`）；`src/web-hub/hub/registry.ts`（`getCaps`）；`src/web-hub/hub/preview/admit.ts:131-132`。
- bash job：`src/bash/process.ts:461-464`、`src/bash/manager.ts`。
- 测试基座：`tests/secure/launcher-fuse.test.ts`、`tests/conformance/secure-gocryptfs.test.ts`、`tests/secure/off-golden.test.ts`、`tests/secure/config-parity.test.ts`。

---

## §R1 评审处置

来源：`/tmp/secure-private-review-r1.json`（3 Blocker / 5 Major / 4 Minor）。全部接受修复，无反驳项。

| #   | 严重度  | 摘要                                                                                                                      | 处置                                                                                                                                                                                                                                                                    | 落点                                           |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | Blocker | 普通挂载在扫描超时时静默放行（F1′），记录丢失时可能双挂载                                                                 | 修复：引入内核持有的挂载租约 `mount.lease`，每次 gocryptfs 启动都在 `flock -n`（不加 `-o`）之下，锁 fd 由守护继承；互斥不再依赖扫描/记录；扫描只做诊断，不完整绝不当空；删除 F1′；旧 helper 的无租约挂载仍由全局 mountinfo 拦截；NC2 钉住守护继承租约                   | §0、§2.1、§3.1、§3.3、§7.2 F1c、§7.3 I-P2、NC2 |
| 2   | Blocker | P0→P1 交接无 CAS，两个监督者可能都挂载                                                                                    | 修复：租约由 P0 启动的 flock 拿到并一路继承给 P1/gocryptfs/pi，P0 死亡不释放；记录带随机 `instanceId`，P1 自检与每次变迁都在锁内读-比较-写，不一致即停止、不挂载不发布；只删自己 instanceId 的记录；屏障并发测试 5 组                                                   | §2.2、§2.3、§3.2、§6.1                         |
| 3   | Blocker | ns 里看到 cipher ≠ 归属；unshare 复制他库全局挂载，lock B 可能误杀 A                                                      | 修复：(a) 终止权只来自记录与复验身份，扫描发现的未登记持有者只报告、阻止挂载、不杀；(b) 其他库全局挂载时拒绝 `run --private`（复制进来的挂载 MNT_LOCKED、无法单独拆除），新增 Q10；NC5 钉住复制事实                                                                     | §1.2、§2.2、§3.3、§3.7、Q10                    |
| 4   | Major   | 启动窗口（已挂载、pi 未登记）被误判为 finalizing，lock 可能杀掉刚启动的会话                                               | 修复：显式阶段 starting→mounting→launching→session→finalizing（setup 独立）；`lock` 只在 finalizing 上等待且等待中复判；launching 与 session 同等保护；区分 gocryptfs「未登记」与「已死」；e2e 覆盖 launch 窗口 lock                                                    | §3.2、§3.3、§3.7、§6.2-4                       |
| 5   | Major   | P0 只处理 P1 被杀/75，P1 正常非零退出且记录仍在的情况未定义                                                               | 修复：P1 任何方式结束后 P0 按 instanceId 读记录分情况处理；P1 在收尾前把 `piExit` 写入记录；给出完整结果表；绝不碰他人记录；e2e 覆盖 exit 1/127                                                                                                                         | §2.3-8、§3.6、§6.2-7                           |
| 6   | Major   | 挂载内同步 fs（ensureVaultDirs/verifyRunPaths/syncProjectSettings/fsyncSync）与 runInherited 只 TERM 会卡死，有界性不成立 | 修复：挂载内操作全部放进可 KILL 的 `__mount-work` worker（TERM→KILL→放弃）；gocryptfs 每次尝试 180 s TERM/+2 s KILL/+3 s 放弃；记录异步带截止；跨 P0/P1 的预算表；明确交互时间不在有界承诺内；e2e：SIGSTOP 守护、锁被占、守护不退出                                     | §2.3、§2.6、§6.2-8、I-P5                       |
| 7   | Major   | ns 标记依赖可被剥离的 env，嵌套 pi 可能拉起 hub                                                                           | 修复：证据式判定（`/proc/self/ns/mnt` 对比各库 `private.json` 的 ns.mnt），与 domain 种类无关，env 只作附加提示；闸门落在唯一出口 `spawnHub`，`/webhub restart` 在任何停机动作前拒绝；记录解析器进 config.ts 与 parity；测试覆盖无 env、vault/非 vault cwd              | §2.9、§4.1、§6.1                               |
| 8   | Major   | `--lazy` 措辞夸大（只摘路径树，既有 cwd/fd/作业继续）                                                                     | 修复：固定措辞改为「摘除挂载路径；既有 cwd/打开的文件/运行中的作业可能继续访问；插件在下一次输入/工具调用时拒绝」，真正结束用 `--kill`；监督者不在时的退化明确报告；acceptance 与 e2e 增加 fd/cwd/后台作业控制组；新残留 R29                                            | §3.7、§5.1、§5.4、§6.2-5、§6.4                 |
| 9   | Minor   | 探针 `--fast` 仍用真凭据跑真 pi                                                                                           | 修复：`--fast` 跳过在线 pi 项；conformance 的 pi 项一律 C5 隔离（临时 HOME、最小 env、空凭据）；清理前复验 starttime                                                                                                                                                    | §6.3 NC10 与说明                               |
| 10  | Minor   | 放宽 `-C` 解析会改变不带 `--private` 时的 argv                                                                            | 修复：固定顺序 `run <name> [--private\|--no-private] [-C <sub>] [pi 参数…]`，新参数只在紧跟名字处识别，`-C` 保持单一首位语义，不带新参数时切分与旧代码相同；显式列出兼容例外；基线 golden 增加重复 `-C`、缺值、`--`、正文含新参数字样；冻结说明拆分为输出/argv/时延三类 | §1.1、§6.1、§6.5、§7.2 F1a–F1c                 |
| 11  | Minor   | 崩溃矩阵：setsid 的守护不在前台进程组；ns 销毁需要无额外引用                                                              | 修复：矩阵增加「前台进程组 SIGKILL ⇒ 守护存活 ⇒ orphan」行与「ns fd/nsfs bind 引用」行；R23 补充                                                                                                                                                                        | §3.9、§5.4 R23                                 |
| 12  | Minor   | `capsExtra` 在 `control=false` 时提前返回，尾部追加的 cap 会漏发                                                          | 修复：标记放在提前返回之前；hub 用现有 `registry.getCaps(agentKey)`，不改 `onVersion` 签名；改名为事实标记 `agent.nospawn.v1`；R25 保留                                                                                                                                 | §4.1-5、§6.1、Q2                               |

注：#1、#2 的租约 fd 传递与记录删除顺序在 r3 中按 §R2 修订（落点以 §R2 为准）。

评审对待决问题的意见已吸收：Q1/Q4/Q6/Q8 同意；Q2 采用轻量 `getCaps` 方案；Q3 限定为证明归属的成员并区分内外 tmux server；Q5 `--global` 不绕过互斥、`--no-private` 提醒可见性；Q7 README 给出 pi 内操作步骤；Q9 每次私有启动打印边界长句；AppArmor 预判改称保守支持范围限制；NC2/NC2b 作为所选链路的前置闸门。

---

## §R2 评审处置

来源：`/tmp/secure-private-review-r2.json`（verdict reject；r1 其余 10 项闭合，§L 无新 Blocker，余 B1、B2）。按 dev-flow 第三轮由主会话裁定，r3 照裁定落文；闭合由主会话核对。

| #   | 严重度  | 摘要                                                                                                                                                                     | 裁定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | r3 落点                                                                                                                                                                                                        |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Blocker | 租约 fd 不随 Node spawn 传递（`stdio:"inherit"` 只映射 0/1/2）；P1 死后 gocryptfs/后台成员仍活而租约被释放，§3.3 又把「租约空闲 + 有记录」直接判 stale，双挂载风险未闭合 | ① 租约 =「`mount.lease` 上的 flock，只要还有任一持有者活着就被持有」；fd 9 由外层 shell 以无 CLOEXEC 方式打开并 `flock -n 9`，shell exec 成 unshare→P1，不留包装进程；私有模式 gocryptfs 以 `-fg` 作为 P1 的直接子进程运行（不依赖守护化重新 exec）；Node 派生、需持锁的子进程（gocryptfs、内层 unshare→pi）一律用显式 stdio 槽 9，其余不给。核对证据（本机实测）：Node v22.22.1 启动时给继承的 fd 9 置 CLOEXEC（`0100002`→`02100002`），`inherit`/`detached`/嵌套 Node 的子进程均无 fd 9；显式槽 9 的子进程拿到无 CLOEXEC 的 fd 9，P1 退出后锁仍被该子进程持有；`/proc/locks` 的 pid 是最初加锁者，只能按 inode 匹配。pi 的 bash 工具与后台 job 不持 fd 9。② 判活不再只靠租约：stale ⇔ bootId 不同，或「租约可获取 **且** 不存在任一进程其 `/proc/<pid>/ns/mnt` 等于记录 ns」（扫描完整）；ns 复用用 bootId + 记录时间（starttime ≥ `supervisor.start`）约束，复用造成的匹配一律按「仍有成员」fail closed。任一证据表明仍有成员 ⇒ 不判 stale、不释放、不允许新挂载。③ 新增测试：P1 被 SIGKILL 而 gocryptfs/后台成员存活时，新的 `run --private` 与普通 `unlock` 都被拒绝（生产命令链，区分「记录拒绝」与「实际租约仍在」，含记录缺失） | §0；§1.2；§2.1（进程树、fd 传递事实 1–5、持有者清单）；§2.2-6；§2.3-1/4/5/7；§2.5；§3.1；§3.3（stale 判定与状态表）；§3.9；§6.1；§6.2-6a；§6.3 NC2/NC2b/NC2c/NC12；§6.4；§7.3 I-P2/I-P9；§8 K7/K18；§9 T1 关闭 |
| B2  | Blocker | 正常收尾的删除顺序与租约不变量矛盾：仍持锁的 P1 要先删记录再退出，遵守 I-P3 则永远等不到租约空闲                                                                         | 记录的删除者改为 ns 外的 P0：P1 完成 ns 内收尾（成员清空、卸载、gocryptfs 退出）后写 `inNsDone:true` 直接退出，从不删记录；P0 在 ns 外以 `flock -w <预算>` 取得租约 ⇒ 证明所有 fd 9 持有者已退出 ⇒ 在持租约状态下取 `mount.lock`、比对 instanceId、确认 ns 扫描为空 ⇒ 删除记录 ⇒ 释放。P0 取租约超时 ⇒ 记录保留，按既有 75 处理。同一释放协议也用于 `lock` 与认领清理 stale；锁顺序为「租约 → `mount.lock`」，持 `mount.lock` 时只用 `-n`。唯一例外：shell 链以 `BUSY` 退出（从未建 ns）时，P0 在 `mount.lock` 内删除自己的 `starting` 记录。正常退出路径不经过任何 75 分支                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | §2.2-6/8/9；§2.3-8；§2.6 预算表（新增「P0 释放记录」行）；§2.8；§3.2（释放协议、I-P3 r3）；§3.4-5/6；§3.5-5；§3.6（时序图与结果表）；§3.7 stale/orphan 行；§6.1-6、§6.2-6b；§7.3 I-P3                          |

其余条目与 r2 相同，未改动。

补记（2026-10-23 用户拍板）：§9 的 Q-L0、Q2、Q10、Q3 均按原推荐拍板，正文设计不变；统一退出码表随 convert-plan r3（不自动删除）删除 79，`0` 增加「convert 成功但保持挂载」说明，两份文档逐字一致。
