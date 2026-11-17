# schedule macOS 完整支持：架构设计

> 状态：架构设计稿，供后续方案拆分与实施使用。范围覆盖 `src/schedule/agent/` 会话内执行与 `src/web-hub/hub/schedule/service.ts` hub 只读协调两侧。

## 需求摘要（已拍板）

- **目标**：macOS 上 schedule 完整可执行：create、run_now、时钟自动触发、list、approve 等调度生命周期入口可用；agent 与 web-hub hub 两侧均支持。说明：当前产品已移除 approval/approve 流程（auto-approve r2），这里的“approve”按调用方验收原文保留为既有管理入口兼容表述，实际实施不得复活已删除的 approval 功能；可验证的是当前有效的管理/查询全链路。
- **不做**：secure 域仍由 D8 强制禁用；Linux 当前行为、错误码与性能特征不变；不引入原生 Node 模块（pi 通过 jiti 直接加载 TS 源码，git 安装不构建）。
- **已定取舍**：①范围为完整支持；②macOS 无可穿透的目录 fd 相对打开能力，改用 realpath + 逐级 lstat/打开后 fstat 快照校验，并明确接受残留 TOCTOU 风险；③锁使用 Perl `flock(2)` 后端与现有 Linux `flock(1)` 同构，锁属于我方 fd 的 open file description，无 stale 回收。
- **本机实测事实**：`sysctl kern.bootsessionuuid` 可读 boot id；`ps -o lstart= -p <pid>` 可读秒级启动时间；`/dev/fd/<dirfd>/name` 不可穿透打开（ENOENT）；系统无 `flock(1)`，但 Perl `-MFcntl` 可用；`process.kill(pid, 0)` 可用于探活。
- **验收**：macOS schedule create / run_now / 自动时钟触发 / list 与现存管理链路可用；Linux 现有测试零回归；Darwin 测试按 `tests/tiers.ts` 显式归属；`tests/fixtures/` A 级冻结件字节不变。

## 1. 背景与目标

当前 S1 的路径实现依赖 `/proc/self/fd/<fd>/<name>` 逐级相对打开；持有 fd 可阻断祖先路径被替换的竞态。身份实现读取 `/proc/<pid>/stat` 的 starttime clock ticks 与 `/proc/sys/kernel/random/boot_id`。锁实现使用 `flock(1)` 在目标进程持有的文件描述符上施加内核 flock。macOS 不提供前两项 Linux 接口，也没有 `flock(1)`，因此 agent 的 store 初始化和 hub reader 均会 fail closed；hub 的 schedule 投影、观察和 receipt 流程也随 root 初始化失败而整体空缺。

设计目标是把这三项**平台差异收敛在显式可注入 seam**，而不拆分/重写事务、holder 判定矩阵、只读 reader、调度器或 wire。Linux 默认分支保持原调用路径与结果。Hub 仍只读账本；secure 域门禁、模式矩阵、账本 schema 与 schedule 协议不变。

## 2. 现状摘要

| 路径 | 现状职责与相关约束 |
|---|---|
| `src/schedule/core/paths.ts` | 只读 fd-anchored 路径原语、vault 谓词注入、root pin、owner/mode/size 校验；只 import `node:crypto/fs/path`。`SchedFsError.reason` 含 `platform`；无 `/proc/self/fd` 时拒绝。属于 hub 精确 value-import 闭包。 |
| `src/schedule/core/reader.ts` | 零写入账本/报告 reader，唯一 schema 校验器；`vHolder` 要求 `start` 为非负安全整数、`boot` 为字符串。 |
| `src/schedule/core/recovery.ts` | `ProcessIdentity`、`LivenessProbe`、`readSelfIdentity`、`judgeHolder`、run recovery。holder 判定规则平台无关；仅 identity 的采集依赖 Linux `/proc`。仅 import `node:fs/os/spec`，闭包不可扩张。 |
| `src/schedule/core/lock.ts` | 同步事务体外的有界异步抢锁：打开 `.lock` / `.store.lock`，启动 `flock -x -n -E 75 3` 子进程绑定 fd 3；内核锁在我方 fd 上保持到关闭。不同 inode 检查避免锁文件回收竞态。 |
| `src/schedule/core/writer.ts` | root/session store 与原子写事务；`SessionStoreOpts.flockBin` 下传锁后端；目前原子写、GC、目录创建等依赖 `fdPath`。 |
| `src/schedule/agent/wire.ts` | 创建 agent、`readSelf` 注入点、启动身份/锁探测、secure gating、HubConfig schedule root 生成。当前 `defaultFlockProbe()` 仅检查 `flock -V`。 |
| `src/web-hub/hub/schedule/service.ts` | hub 直接调用 `resolveStoreRoot()` 与 `readSelfIdentity()`；root 不可用时投影为空，`self` 缺失时未知运行预测返回空。需注入平台 paths/identity。 |
| `src/web-hub/protocol/schedule.ts` | 五类 `sched_*` wire 帧不携 Holder/identity；strict schema。`HubConfig.schedule` 也不携身份。无需扩 wire。 |
| `docs/dev/scheduled-reports/README.md`、`S1-report.md` §偏差 #9 / §7.6 | schedule 当前边界、不变量、门禁；Linux-only 原决策明确记录 `/proc/self/fd` 依赖。本设计以本文件取代该平台限制，不放宽其他安全约束。 |
| `tests/web-hub/boundary.test.ts` | paths/recovery 精确 value-import 闭包：paths 仅 `node:crypto/fs/path`，recovery 仅 `node:fs/os/spec.js`。不得在这两个文件新增 import。 |

## 3. 总体设计

### 3.1 依赖结构

```text
schedule agent wire ──构造/注入──┐
                                 ├── schedule/core platform seams
web-hub schedule service ─注入────┘       ├── identity: recovery 比较逻辑 + platform probe
                                         ├── paths: 同一 API，Linux fd 后端 / Darwin path-snapshot 后端
schedule/core writer ──LockOpts.acquire(fd)── lock protocol
                                         ├── Linux acquire = flock(1)
                                         └── Darwin acquire = perl -MFcntl flock(2)

reader/writer/claim/clock/reconcile 与协议保持原有职责；平台差异不向 wire 传播。
```

模块复用优先，不新增“platform manager”单例。测试与宿主可按需构造 dependency port；默认分支由 `process.platform` 解析，但不在 `paths.ts` / `recovery.ts` 增加 import。所有可变状态仍属于 `wireSchedule`、service 或单次 store/agent 实例，遵守 I4。

### 3.2 抽象 seam 与接口草案

以下为**签名草案**，最终实现可在现存模块增加可选参数/opts，避免新文件形成 boundary 闭包扩张。类型可定义于现存 paths/recovery/lock；`writer.ts` 仅负责逐层透传。

#### Identity seam

```ts
// recovery.ts：不新增 import；复用现有 LivenessProbe 形态。
export interface IdentityProbe {
  self(): ProcessIdentity | undefined;
  startOf(pid: number): number | undefined | "error";
  bootId(): string | undefined;
  pidMayExist(pid: number): boolean;
}
export function readSelfIdentity(probe?: IdentityProbe): ProcessIdentity | undefined;
export function judgeHolder(
  holder: Pick<Holder, "pid" | "start" | "host" | "boot"> & { epoch?: string },
  self: ProcessIdentity,
  opts?: JudgeOpts & { probe?: LivenessProbe },
): LivenessVerdict;
```

为最小兼容，也可维持 `readSelfIdentity()` 默认 Linux 语义，仅让 `wire.ts` 的 `readSelf` 注入经 resolver 选定的 Darwin reader；hub service 同样通过 deps 注入 `readSelf` / `judgeOpts`。重要约束是：`judgeHolder`、`recoverDeadRuns`、`closeEpochRuns`、`unknownRunKeys` 的纯判定逻辑不分平台；仅 `readSelfIdentity` 默认 probe 与 `LivenessProbe` 具体实现有平台差异。路径闭包禁止 import child_process；Darwin identity probe 应放在 agent/wire 的宿主层，或由调用方注入 `readFile` / `execFileSync` 能力，hub service 也从其构造依赖获得，而非 recovery 引入新依赖。

推荐可落地的简化接口：

```ts
export interface IdentityDeps {
  readSelf: () => ProcessIdentity | undefined;
  judgeOpts?: JudgeOpts; // 若 probe 已随平台 identity resolver 配置
}
// ScheduleWireOpts 增加 identity?: IdentityDeps；service deps 同样加 identity?: IdentityDeps。
```

生产默认 resolver：Linux 继续用既有 `/proc` probe；Darwin 由 hub/agent 装配层提供系统 probe。测试直接注入确定性 identity。不要用跨 activation 模块级 mutable cache。

#### Paths seam

```ts
// paths.ts 保持无新增 import，依赖调用方注入平台与低层 path snapshot 原语。
export interface PathBackend {
  readonly platform: "linux" | "darwin";
  readonly fdAnchoringAvailable: () => boolean;
  // 内部可选能力：path(open) 及 post-open lstat/fstat 快照比较；API 仍输出现有 OpenedDir/BoundedRead。
}
export interface StoreRootOpts extends FsCheckOpts {
  inVault?: InVaultPredicate;
  backend?: PathBackend;
}
export function resolveStoreRoot(path: string, opts?: StoreRootOpts): StoreRoot;
export function openStoreRoot(root: StoreRoot, opts?: StoreRootOpts): OpenedDir;
```

不把后端做成新 import；`fdAnchoringAvailable()` 已是自然能力探测 seam。也可用可选 `platform?: "linux" | "darwin"` 并在 `paths.ts` 内用现有 `node:fs`/`node:path` API 分支，前提是所有外部 syscall 均无需新增 import。平台选择由 wire 与 hub 显式传递，测试可强制平台。Linux 默认保持现有 `/proc/self/fd` 路径；Darwin `OpenedDir.fd` 仍是实际 open fd（供 fsync 与后端兼容），但子项访问用已核实路径而非 `/dev/fd` 穿透。

writer 大量通过 `fdPath(dirFd, name)` 拼接 syscall 路径，故 Darwin 不能只改 `openDirAt`：需要在 `paths.ts` 提供对应 root/session/child 的**已核验路径快照**，并让 writer 所有 open/rename/unlink/mkdir/opendir/lstat/fsync 路径操作经一个受控 helper 产生路径。路径 helper 在 Darwin 每次使用前核对祖先快照；不得让裸 fd 数字被错误当作可寻址路径。Linux helper 必须逐字保持旧 `fdPath` 结果与调用路径。

#### Lock seam

```ts
export type AcquireResult = "held" | "busy" | { kind: "fail"; detail: string };
export type LockAcquire = (fd: number) => AcquireResult;
export interface LockOpts {
  acquire?: LockAcquire;
  // 原 timeoutMs / monotonic / sleep / holderInfo / name 保留
}
```

对现有同步 `spawnSync` 调用保持同步契约：Linux 默认 acquire 执行原 `flock -x -n -E 75 3`；Darwin 默认 acquire 执行 Perl `-MFcntl` 冒烟/获取，使用同一 fd 的 stdio 槽位并调用 `flock(fd, LOCK_EX | LOCK_NB)`，busy 映射为 `busy`，其他错误为 `fail`。锁成功后父进程保留原 fd 到同步事务体结束。`SessionStoreOpts` 将 `flockBin?: string` 替换/兼容为 `acquire?: LockAcquire` 并透传 `LockOpts`。仅在 lock adapter/agent wiring 层引入 `node:child_process`；不得触碰 hub 的 import allowlist。

Perl 锁脚本须使用 `fcntl` 导出常量与 `flock` 函数，对 fd 3 执行非阻塞 exclusive lock；子进程退出后锁仍附着于父进程同一 open file description。冲突 exit status 使用专用码；其余非零状态是 fail closed。`wire.ts::defaultFlockProbe` 改为平台感知：Linux `flock -V`；Darwin Perl flock 冒烟（能加载 Fcntl 并成功锁临时 fd）；不可用时保持 E_BUSY fail-closed，并给出 `Perl/Fcntl flock 不可用，schedule 事务拒绝` 的清晰 warning。测试注入 `acquire`，不再伪造 flock binary。

**B1/M6 安全论证原样成立**：锁属于内核管理的 open file description；持锁 fd 只由持锁进程持有，进程退出/崩溃时内核关闭 fd 并释放锁；锁文件内容仅诊断，不参与锁判定；任何进程都不按 holder 年龄/pid 迁移、unlink 或“修复”锁文件，因此不存在 stale-lock 回收者竞态，也不存在强拆 live lock 入口。`repair()` 仍走普通锁，live/wedged holder 只会到期返回 E_BUSY。

## 4. Darwin identity 与账本兼容

### 4.1 采集格式

- `boot`：读 `sysctl -n kern.bootsessionuuid`，去空白后存 UUID 字符串；读失败返回 identity unavailable，不猜测 boot id。
- `start`：`ps -o lstart= -p <pid>` 输出仅秒精度；固定 `LC_ALL=C`、`TZ=UTC0`，按固定英文格式 `Wdy Mon DD HH:MM:SS YYYY` 严格解析，转换为 UTC Unix epoch **毫秒**（整秒对应的 `...000`），确认 `Number.isSafeInteger(start) && start >= 0`。不得把秒数直接存入 `start`；不得依赖本地语言/时区。
- `host` 继续使用现有 hostname 语义；`pid` 用 `process.pid`；`epoch` 仍由每次 stack 创建生成的随机 epoch 提供。
- 探测他者：先 `process.kill(pid, 0)`，ESRCH ⇒ dead，EPERM/其他异常保守视为可能存活；再读取 `ps -o lstart= -p pid`，不存在/不可读区分为 undefined/error。对比使用同一转换后的 epoch ms。

### 4.2 秒级精度与判定矩阵

现有矩阵不变：异 host ⇒ unprovable；同 host、boot 不同 ⇒ dead(crash)；同 host/boot、pid 消失 ⇒ dead；进程启动值不同 ⇒ dead(crash)；值相同 ⇒ alive；同进程不同 epoch 仅在调用方已知 disposed 时判 dead(reload)，否则 alive。

`epoch + host + boot + pid + start` 组合会避免跨机器、重启及本进程 epoch 混淆，但**不能**消除“同一 boot 内 pid 在同一秒被复用”的碰撞：Darwin `ps lstart` 没有亚秒信息。为安全收敛，必须遵守“只有 start 完全相等才判 alive；取值缺失/格式错误/无法证明时判 unprovable/alive，不因时间过期推断 dead”。相等碰撞可能把已退出旧 holder 暂时当成 alive，导致 run recovery 延后或 E_BUSY（可用性损失）；不能错误回收仍活进程。对本进程自身，以 `pid + start + host + boot` 确认身份，再使用 epoch/disposed 规则。若未来有可靠的更高精度系统 API，再替换 probe，不改 `judgeHolder` 矩阵。

### 4.3 持久化与跨平台混读

`Holder` 字段名/类型不变：`pid:number, start:number, host:string, boot:string, epoch:string`。`start` 仍满足 `reader.ts::vHolder` 的 safe natural 校验，`boot` 仍是 bounded string；不加必填字段、不改 wire、不 bump state version，符合 I10 append-only。新 Darwin holder 写 epoch ms，Linux holder 继续写 clock ticks。

旧/异平台账本中 `start` 的数值语义可能不同；不可直接把“数值不同”一律解释为 pid 复用。实现需在 identity seam 识别已知编码域（Linux ticks、Darwin epoch-ms）：不同域 ⇒ `unprovable`，不回收；同域才按精确值判断。推荐明确且有测试的范围分类：Darwin epoch-ms 为当前纪元数量级（约 10^12），Linux start ticks 为相对 boot 的较小数值；域外/不确定值 fail closed。不得新增 wire 字段。跨平台运行中的 holder 因域不同会暂时 unprovable，直到其自身正常终止/新进程恢复；这是兼容安全优先的残余。由于不额外持久化平台标签，数值域识别须记录阈值假设与边界测试。

## 5. Darwin paths 降级与错误语义

### 5.1 算法

对 root、session dir、reports dir、state/report/lock 文件均统一采取以下路径快照流程：

1. 输入必须为绝对路径；按组件逐级处理，拒绝 `.`、`..`、NUL 与非法 basename。对已有路径组件 `lstat`，任何 symlink 立即拒绝（包括祖先组件）；对目录要求目录类型，对文件要求普通文件。
2. 在每一级打开前记录 `lstat` 快照（至少 `dev/ino/mode/uid/type`；文件另记 size；可用纳秒时间戳则记录 mtime/ctime）。目录以 `O_DIRECTORY | O_NOFOLLOW` 打开，文件以 `O_NOFOLLOW | O_NONBLOCK` 打开，避免 symlink 与 FIFO 阻塞。
3. 打开后 `fstat(fd)`，重新对路径 `lstat`；检查 pre-lstat、fstat、post-lstat 的 `dev/ino` 一致，类型/owner/mode 满足现有政策。任一变动、链接或类型不符即拒绝。创建目录时先对目标和祖先 realpath/vault 判定，再 mkdir 0700，随后按同样快照打开与核验；绝不先创建再做 vault 判断。
4. `StoreRoot` 仍固定 literal/real/dev/ino。每次 scan/transaction 重开 root，并重新 realpath + lstat/fstat 与 pin 的 dev/ino 比较；root location 或 identity 变化 ⇒ `moved`。对 session/report 子层逐级复核；读取 bounded file 后再检查路径快照，文件 size/read 长度不一致或快照变化 ⇒ `io`/`moved`，不返回内容。
5. vault predicate 仍注入且对 literal 与 realpath 检查；在每轮访问重新判定，hub 不 import secure。root 建立前检查 canonical 最长已存在祖先 + 剩余路径，创建每级前后复核。

这些检查保留 symlink 拒绝、owner/mode/size/dev-ino pin 和 vault 语义的大部分约束，但无法像 Linux fd-relative open 那样将“检查祖先”与“打开后代”绑定在单个内核操作中。攻击者可在快照检查与后续 pathname syscall 的极短窗口替换祖先目录（TOCTOU）。即使重复 lstat、比较快照也只能检测已发生变化，不能证明未发生后又恢复。调用方同 uid 恶意篡改本来就是已接受威胁边界；对并发恶意路径替换，Darwin 保证弱于 Linux，须在 UI/README/安全说明中明确披露。不得宣称完全等价安全。

### 5.2 接口与错误码

保持 `SchedFsError.reason` 集合与业务错误映射不扩张。mac 不应因“没有 `/proc/self/fd`”返回 `platform`：该 reason 保留给真正未支持的平台/能力。路径打开过程的 `ENOENT` 应区分缺失组件和 fd-path 不可穿透；Darwin `openDirAt` 不再把 `/dev/fd/<fd>/<name>` 的 ENOENT 误映射为 `missing`。对真实缺失仍 `missing`，symlink ⇒ `symlink`，类型错误 ⇒ `not-dir`/`not-file`，root identity 变化 ⇒ `moved`，其他拒绝 ⇒ `io`。业务层当前 `platform` 错误映射与工具错误码保持不变；不新增 schedule 错误码。

Vault 判定语义保持：字面与 canonical 路径都检查，root 每次重开复查；差异是无法验证“打开的 fd 当前物理位置”并证明其路径仍等于 canonical。此能力差距并入 M3 类安全残余。

## 6. Hub、wire 与产品入口

`createScheduleService` 当前构造时直接执行 `resolveStoreRoot(deps.config.dir)`、`readSelfIdentity()`。给 `ScheduleServiceDeps` 增加测试/宿主可注入的 `paths`（至少 `resolveStoreRoot`）与 `identity`（`readSelf`、可选 `judgeOpts`），默认 resolver 按平台取实现；hub root 建立、每轮 `openStoreRoot` / reader 调用必须使用同一 backend。`predictUnknowns` 沿用 `judgeHolder`，配置 Darwin probe；self 缺失仍 fail closed，但不再因为平台天然缺 `/proc` 而缺失。

Hub 的投影、SSE、HTTP `/api/schedules`、receipt 清理、Feishu 投递仍走既有只读 scan/reconcile/service 流程。Hub 不获得 writer/lock/claim 权限。`sched_*` 帧、`HubConfig.schedule`、settings schema 无身份字段，因此 wire 零改动、无新 cap、无 PROTO bump，满足 I10。`probePlatform(spawn)`、preview proc-fd、hubLoadProbe 等其他独立 Linux-only fail-closed 门不属于本次范围，不借机改造。

Agent 侧 `wire.ts` 使用平台 identity resolver 与 paths backend；agent mode/secure gate 与 `assertExecutable()` 不变。D8 强制 secure schedule off 在所有 settings 入口维持最高优先级，Darwin 后端不得绕过。

## 7. 测试架构与门禁

### 7.1 测试原则

- 平台原语算法用依赖注入做平台无关单测；真正调用 `ps/sysctl/perl` 的覆盖放在 `describe.skipIf(process.platform !== "darwin")` 下，真实 Linux `flock` 竞争测试则 Linux 自门控。mac 专属测试需在 mac runner 才提供证据，不把 Linux CI 绿误记为 Darwin 验证。
- Linux 原有测试必须默认走 Linux backend，继续验证 `/proc`、`flock` 路径；fixture 不得因运行平台自动切到 Darwin 行为。平台参数显式传入便于跨平台模拟和零回归比较。
- writer/path 竞争、SIGKILL、真实 Perl fd 锁测试属真实子进程/IO，按 `tests/tiers.ts` 标记 `kind:"proc"` 或放 `tests/integration/`（已有目录自动 Tier 2）；纯 parser、判定矩阵、快照算法 mock 留 Tier 1。
- 不刷新任何 A 级 frozen fixtures；schedule off golden、其他 A 级 bytes 必须保持不变。

### 7.2 需要修整的现有 Linux 假设

下列 suite 当前在 mac 会失败而非 skip，先改为平台感知 fixture 或明确 gate，不得靠改 Linux 断言绕过：

- `tests/schedule/core/fixtures.ts`：`self()` 当前因 `/proc` 抛错；改为显式 fixture identity，需真进程时按平台注入 probe。
- `tests/schedule/core/recovery.test.ts`：beforeAll `/proc` 假设及直接 spawn `flock`；Linux kernel-lock 测试留 Linux gate，通用判定矩阵用 fake probe，Darwin Perl 锁另测。
- `tests/schedule/core/writer.test.ts`：约第 438/667 行外部 `flock` 持锁测试改 Linux gate或 lock acquire 注入；通用 store 事务测试注入 acquisition adapter。
- `tests/schedule/agent/clock.test.ts`、`tests/schedule/agent/wire.test.ts`：真实 `readSelfIdentity` / `ensureStore` 改为 fixture 注入；另加 Darwin wiring smoke。
- `tests/web-hub/hub/schedule-service.test.ts`：约 29/832/906 行 `readSelfIdentity()!` 改 service identity 注入。
- `tests/integration/fixtures/schedule-matrix-child.ts`、`tests/integration/schedule-interval-lock.test.ts`：Linux flock 命令改平台对应 acquisition helper；包含真实并发的测试分平台执行或拆独立 backend 用例。

正面先例：`tests/web-hub/hub/spawn/config.test.ts` 的注入式 fail-closed 测试；skip gate 形式参照 `describe.skipIf(process.platform !== "linux")` 现有集成测试。新增 Darwin suite 使用要求形式 `describe.skipIf(process.platform !== "darwin")`。

### 7.3 建议新增覆盖

| 领域 | 覆盖重点 | Tier 建议 |
|---|---|---|
| Identity parser | 固定 locale/timezone 的 ps lstart parsing、非法/缺失、UTC epoch ms 与 safe integer；boot UUID；start 域交叉 ⇒ unprovable；同秒 PID 复用 ⇒ 不误判 dead；kill 0 的 ESRCH/EPERM | 纯注入 Tier 1；真实 `ps/sysctl` Darwin smoke 可 Tier 1 自门控（无子进程 marker 时），若 spawn 则登记 `kind:"proc"`/Tier 2 |
| Paths | symlink/祖先 symlink、fifo、owner/mode、realpath/vault、dev/ino pin、替换竞态检测、Darwin 不再产生伪 missing/platform；按平台注入文件系统快照 | 普通临时目录测试 Tier 1；真实并发换目录子进程 Tier 2 |
| Lock | Perl Fcntl 可用/缺失 fail-closed、holder diagnostic、同 fd 锁覆盖子进程退出、多个进程互斥、SIGKILL 自动释放、无 break/stale reclaim | Tier 2 / integration，真实 Darwin 子进程专属 suite 自门控 |
| End-to-end | create → run_now → timer fire → list/history → hub scan/projection/receipt；secure/locked 仍无 schedule；D8 off | integration Tier 2；沿用当前 schedule integration 栈 |
| Linux compatibility | 现有 suites 保持 Linux backend，golden、错误码、flock wait 与事务结果 byte-for-byte 相同 | 现有 Tier 原位，不因 Darwin 增加而降级 |

`tests/tiers.ts` 对 Tier 1 词法命中 `child_process` 的新增测试必须登记 `TIER1_DECLARED`（通常 kind `proc`），或移动至 Tier 2。现有 `tests/schedule/core/recovery.test.ts`、`writer.test.ts`、`fault-injection.test.ts` 等已有登记应复核新文件，不要假设目录名自动决定 Tier。

## 8. 实施阶段与并行切分

1. **P0 契约/测试基线（串行先行）**：核对 boundary 精确闭包、冻结件与 Linux suite；确定 `PathBackend`/`LockAcquire`/`IdentityDeps` 最小签名，更新边界测试说明（不扩 paths/recovery imports）。补充 Linux 原行为快照测试。
2. **P1 Identity + wiring**：一组负责 Darwin `ps/sysctl` probe、解析与跨域判定；另一组在 agent `wire.ts` 与 hub `ScheduleServiceDeps` 注入身份。共享 `recovery.ts` 比较矩阵不改平台逻辑。可并行，但先冻结 seam 类型。
3. **P2 Paths backend**：单独文件域负责 `paths.ts` 的 Darwin snapshot 原语与 `writer.ts` 所有 fdPath syscall 的后端化；并行另一组只写 paths/recovery 单测。由于 writer 的 syscall 面广、路径上下文必须贯穿 GC/atomic write/repair/recycle，不能只改 reader 或只改 `fdPath`；此包合入前通过 reader/writer 全套 Linux golden/行为回归。
4. **P3 Lock adapter**：独立负责 `lock.ts` acquire 注入、`writer.ts` 透传、`wire.ts` 平台感知 probe 与 Perl Fcntl 测试。与 P2 可并行（文件域分离：lock/wire vs paths/writer 有 writer.ts opts 轻微冲突，需先约定 SessionStoreOpts 字段）；B1/M6 契约不变。
5. **P4 测试 fixture 与 hub 集成**：hub service 注入与测试适配可和 P2/P3 并行；端到端 integration 在三 seam API 稳定后进行。测试代理可先使用注入 fake，不等待系统实现。
6. **P5 Darwin 验收与文档回写**：在真实 macOS 执行 Darwin 专属测试及 create/run_now/自动触发/hub 全链路；Linux 全套 schedule gate；核对 A 级 fixtures byte-identical；把已实现细节、测试命令、TOCTOU 残余写回 `docs/dev/scheduled-reports/README.md`（本设计仅作实施蓝图）。

代码并行边界：identity probe（agent/hub 装配层）、lock adapter（lock.ts + wire.ts）、paths/writer（paths.ts + reader/writer IO）三项可分包；paths 与 writer 不可拆成互不知情的并行改动。Hub 只能接入只读 paths/identity，不引入 writer、lock 或 secure import。

## 9. 关键决策与已接受残余

1. **不采用原生 addon / openat**：维护/构建不兼容 jiti 直载 TS 与 git 安装；Node 无 openat API。本地依赖 Perl `flock(2)` 是已确认系统工具路线，不是原生 Node 模块。
2. **不改 `judgeHolder` 判定模型**：Linux/Mac 统一使用同一确定性矩阵；秒级 start 相等碰撞保守当 alive/unprovable，容忍恢复延迟以避免误杀活 run。
3. **不加 Holder/wire 字段**：保持账本现有字段结构与所有 sched wire 帧兼容；跨平台 start 单位差异由 identity seam 识别，跨域只 unprovable。
4. **路径残余（明确接受）**：Darwin realpath/lstat/fstat 多次复核无法消除祖先在检查与 pathname syscall 间被并发替换的 TOCTOU；相较 Linux fd-relative open，安全保证降低。尤其 M3 的“打开对象真实位置”证明无法完全等价，不能把 Darwin snapshot 校验表述为原子锚定。
5. **identity 残余**：Darwin `ps lstart` 秒精度导致同一 boot 下 pid 同秒复用可能被当成同一进程，最多造成 dead run 恢复延迟；跨平台 start 格式域不可判时 unprovable，旧 holder 可能持续占用恢复状态，优先 fail-safe。
6. **平台探测依赖**：缺失 Perl/Fcntl、`ps`、`sysctl` 或解析异常时对应能力 fail closed；锁缺失返回 E_BUSY 并清晰 warning，identity 缺失仍禁止执行。不会 fallback 到无锁写入或“凭超时判死”。
7. **本次不动其他 Linux-only 门**：hub probePlatform(spawn)、preview proc-fd、hubLoadProbe 等保持现状。
8. **Linux 回归要求**：Linux 后端沿用 `/proc`、`flock(1)`、原 fd anchoring 与现有错误映射；Darwin 分支不得改变 Linux 可观察行为、错误码、等待参数/性能路径或冻结件。

## 10. 实施验收清单

- [ ] Linux paths/recovery/lock 后端默认与现状一致；现有 schedule 与 hub tests 全绿、错误与 golden 无变化。
- [ ] macOS agent 可正常构建 session store、运行 CRUD/查询与 run_now，自动时钟完成触发；secure/locked 继续拒绝。
- [ ] macOS Perl flock 多进程互斥；SIGKILL 后立即可获锁；无 stale reclaim/强拆；缺 perl 时 E_BUSY + warning。
- [ ] macOS hub 成功 pin root、读账本并投影 schedules，完成 unknown prediction 与 receipt/Feishu 既有流；hub 仍只读。
- [ ] Paths 拒绝 symlink/FIFO/错误 owner-mode，realpath/vault/dev-ino 校验及测试通过；TOCTOU 残余在文档和测试注释中清楚标记。
- [ ] Holder schema 与 wire 不变、无 PROTO bump；A 级冻结 fixtures 字节不变。
- [ ] Darwin 自门控测试在 macOS runner 实际运行；`tests/tiers.ts` 注册完备，无 macOS 缺 `/proc` 的意外失败套件。
