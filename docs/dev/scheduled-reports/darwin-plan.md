# schedule macOS 完整支持：实施方案

> 状态：方案稿（plan），供 dev 包并行派发与 verifier 验收使用。技术决策一律以 [darwin-arch.md](darwin-arch.md) 为准（perl `flock(2)` 与 Linux `flock(1)` 同构、realpath + lstat/fstat 快照降级、epoch-ms `start` 编码、wire 零改动）——本文件不重开这些拍板项，只补「落位、改动点、测试、门禁、验收」。
> 分支：`feat/schedule-darwin`。基线核对日期：2026-11-17（src 行号以该日 HEAD 为准）。

## 0. 需求摘要

- macOS 上 schedule 完整可执行：create / run_now / 时钟自动触发 / list / 现存管理链路（approval 已于 r2 移除，**不复活**）；agent（`src/schedule/agent/`）与 hub（`src/web-hub/hub/schedule/`）两侧均可。
- 三个平台差异收敛为显式 seam：**identity**（`/proc` → `ps`/`sysctl`）、**paths**（`/proc/self/fd` fd 相对打开 → realpath + lstat/fstat 快照）、**lock**（`flock(1)` → Perl `flock(2)`）。
- 不做：secure 域（D8 强关）、Linux 行为/错误码/性能变化、原生 Node 模块、wire/`Holder` 字段/PROTO 变化、其他 Linux-only 门（spawn probePlatform、preview proc-fd、hubLoadProbe）。
- 已接受残余：Darwin 祖先目录 TOCTOU 弱于 Linux；`ps lstart` 秒精度同秒 pid 复用只会延迟恢复（不误杀）；缺 perl ⇒ 锁 fail closed（E_BUSY + warning）；macOS `fsync(2)` 不等价 `F_FULLFSYNC`（沿用现有 fsync 语义，见 §6 风险 R9）。
- 验收：mac 上 create/run_now/时钟/list/hub 投影全链路可用；Linux 现有测试零回归；A 级冻结件字节不变；Darwin 测试按 `tests/tiers.ts` 显式归属。

## 1. 与 arch 的核对与修正（实地核对 HEAD）

| #   | arch 假设                                                   | 实际                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 本方案处置                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Darwin identity probe「放 agent 装配层 + hub service 注入」 | hub 是独立守护进程，其 import 闭包被 `tests/web-hub/boundary.test.ts` 白名单钉死：只能 import `node:*`、`{protocol,hub}` 内部文件、以及 `src/schedule/core/{spec,cron,occurrence,paths,reader,recovery}.ts`。hub **无法** import 放在 agent 层或新的 `schedule/core/*.ts` 的 probe；`recovery.ts`/`paths.ts` 不得加 import（精确闭包断言）。                                                                                                                                                                              | probe 放 **`src/web-hub/protocol/sched-identity.ts`**（新文件，pi-free，仅 `node:child_process`/`node:os`；agent `wire.ts` 与 hub `service.ts` 都从 protocol 引用——agent→protocol 已有先例 `wire.ts` import `web-hub/protocol/schedule.js`）。该文件**不得** import `schedule/core`（protocol 文件不能逃出 `{protocol,hub}`，含 type-only），故用结构化类型，由 recovery.ts 的 `IdentityDeps` 在使用点结构兼容。 |
| C2  | writer.ts 的 syscall 需逐点「后端化」（受控 helper）        | 让 `fdPath()`/`fdRealPath()`/`closeQuiet()` 本身**随 fd 携带后端**（见 §3.P0/P2 的 fd 注册表）后，writer/lock/reader 中的 `fdPath(` 调用点**无需改参数**，只需「后端无关性」审计。**计数口径**（评审 #5）：HEAD 实测 `src/schedule/core/` 内 `fdPath(` 为 **26 个调用表达式 / 24 个调用点**（+1 个声明）；另有 `fdRealPath(` 5 个调用、`fdAnchoringAvailable(` 2 个内部调用。唯一的**多段相对路径**站点是 `writer.ts:1106`（`reports/<name>`），P0 把它迁到 `lstatAt()`，Darwin 的 `path()` 因此可以禁止 `/`（评审 #1）。 | 保持 writer.ts 改动极小（`ensureStoreRoot`、`SessionStoreOpts.acquire`、`writer.ts:1106` 一行迁移），清单由 `FDPATH_MANIFEST` 自动扫描钉死（§3.P2-c），不再靠手抄行号。                                                                                                                                                                                                                                          |
| C3  | `SessionStoreOpts.flockBin` 「替换/兼容」为 `acquire`       | `flockBin` 被 `tests/schedule/core/recovery.test.ts:208-211` 使用（`/nonexistent/flock` ⇒ `flock binary not found`）。                                                                                                                                                                                                                                                                                                                                                                                                    | **保留** `flockBin`（兼容，等价 `acquire: linuxFlockAcquire(flockBin)`），新增 `acquire`；二者同给时 `acquire` 优先。                                                                                                                                                                                                                                                                                            |
| C4  | hub 需注入 `paths`/`identity`                               | `resolveStoreRoot` 默认按 `process.platform` 选后端即可；注入仅用于测试。`StoreRoot` 可携带可选 `backend`，流经 reader/scan/writer，无需逐函数加参。                                                                                                                                                                                                                                                                                                                                                                      | `ScheduleServiceDeps` 增 `identity?`/`paths?`（测试 seam），默认走平台解析。                                                                                                                                                                                                                                                                                                                                     |
| C5  | `judgeHolder` 无需改                                        | 现有 `note.ts:172/217`、`digest.ts:222`、`service.ts:376/382` 调 `judgeHolder` **不传 probe**，默认 `procLivenessProbe` 在 mac 会读 `/proc` ⇒ ENOENT ⇒ 只能判 unprovable/dead(ESRCH)，永远判不出「pid 复用 ⇒ dead」。                                                                                                                                                                                                                                                                                                     | `ScheduleAgent` 增可选只读 `probe?: LivenessProbe`，note/digest/clock/hub 全部把 probe 传入 `judgeHolder`。Linux 不设 probe ⇒ 调用形态字节不变。完整调用链（含 `recoverDeadRuns`/`unknownRunKeys` 的间接链与 clock 配置）见 §3.P1-b 的 J1-J7 表与 `JUDGE_MANIFEST`。                                                                                                                                             |
| C6  | 现有 mac FAIL 的 suite 约 6+ 个                             | 本 worktree **无 `node_modules`**（未跑过测试）。§5 的失败清单来自静态分析（`readSelfIdentity()!`、`spawn("flock")`、`/proc` 断言），不是实测。                                                                                                                                                                                                                                                                                                                                                                           | P4-B 第一步必须 `npm install` 后在 mac 跑**基线实测**并回填红清单（§5.1 命令）。                                                                                                                                                                                                                                                                                                                                 |
| C7  | reader.test 静态断言                                        | `tests/schedule/core/reader.test.ts:90-98` 对 `reader/paths/cron/recovery.ts` 全文（含注释）正则禁止 `mkdirSync                                                                                                                                                                                                                                                                                                                                                                                                           | renameSync                                                                                                                                                                                                                                                                                                                                                                                                       | unlinkSync | rmdirSync | writeSync | O_CREAT | O_RDWR | O_WRONLY | …` 等写原语。 | Darwin 后端写在 `paths.ts` 内，**源码与注释都不得出现这些词**（P2 门禁）。 |
| C8  | arch/首版方案对 boundary 的结论不够明确                     | 读 `boundary.test.ts:292-345` 核实：`hubImportAllowed`（:292-307）对 `{protocol,hub}` 之外的相对 import **不因 type-only 放行**（type-only 豁免只有「hub 文件 → `src/config/settings.ts`」一条）；`protocol files may not escape {protocol,hub}` 扫描**含 type-only** 的全部 import；`protocol/hub files are discovered`（:323-336）只是 7 个代表文件的 `arrayContaining`，**不是**全等，更**不是**逐文件闭包保证。                                                                                                       | P1 新增 `sched-identity.ts` 精确钉子，扫描结果不过滤 `typeOnly`，断言 import 恰为 `node:child_process`+`node:os` 且零相对 import；不把 discovery 当闭包保证（§3.P1 测试）。                                                                                                                                                                                                                                      |
| C9  | Linux「不变」只靠字符串断言                                 | 评审 #4/#10：需覆盖输出、错误 reason、异常路径、开销、参数、冻结件                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 引入冻结快照 `tests/schedule/compat/paths-v0.ts` 做差分；§5.4 拆 5 条可观察契约 + 证据类别 E-CI/E-MAC/E-AUX。                                                                                                                                                                                                                                                                                                    |

## 2. 包拆分总览

依赖图：`P0 → {P1, P2, P3}（互相并行）→ P4 → P5`。P4 拆 A/B：P4-A 只需 P1；P4-B 需 P1+P2+P3 全部合入。

| 包   | 名称                                                    | 前置     | 预估改动                   | 风险 |
| ---- | ------------------------------------------------------- | -------- | -------------------------- | ---- |
| P0   | 契约 + Linux 不变重构（零行为变化）                     | —        | src ~170 行 / test ~120 行 | 低   |
| P1   | Darwin identity（probe + 域判定 + wiring 接入）         | P0       | src ~300 / test ~350       | 中   |
| P2   | Paths 后端（Darwin 快照 + fd 注册表 + ensureStoreRoot） | P0       | src ~380 / test ~500       | 高   |
| P3   | Lock adapter（Perl flock + 平台化探测与 warn）          | P0       | src ~150 / test ~260       | 中   |
| P4-A | hub service 注入 + 其测试                               | P1       | src ~40 / test ~60         | 低   |
| P4-B | 现有 suite 平台感知改造 + 共享测试 helper               | P1,P2,P3 | test ~250                  | 中   |
| P5   | 真机验收 + 文档回写                                     | 全部     | docs ~150                  | 低   |

### 2.1 文件域（写权限边界）与共享文件裁决

> 域外文件一律只读；越界需先回报调度方。每包允许新建文件列在「新建」。

**P0** 域：

- `src/schedule/core/paths.ts`（仅：新增 `PathBackend` 类型、`StoreRootOpts.backend?`、`StoreRoot.backend?`、`linuxPathBackend`、`defaultPathBackend()`、fd 注册表骨架（惰性创建）、`lstatAt`、`fdPath`/`fdRealPath`/`closeQuiet`/`openDirAt`… 改为经后端分发——**Linux 输出逐字不变**；Darwin 后端留 `undefined`，即 mac 上 `defaultPathBackend()` 仍返回 linux（行为同今天：fail closed `platform`））
- `src/schedule/core/recovery.ts`（`StartDomain`/`startDomainOf`/`LivenessProbe.startDomain?`/`IdentityDeps`、`judgeHolder` 域判定；仅 `startDomain` 被设置时生效）
- `src/schedule/core/lock.ts`（`AcquireResult`/`LockAcquire` 类型、`LockOpts.acquire?`、把 `tryLock` 内联的 `spawnSync(flock…)` 提取为 `linuxFlockAcquire()`，`tryLock` 调 `acquire(fd)`——Linux 命令行/超时/错误文案不变）
- `src/schedule/core/writer.ts`（**仅**：`SessionStoreOpts.acquire?` 字段 + `lockOpts()` 一行透传；`writeReportLocked` 内 `writer.ts:1106` 的 `lstatSync(fdPath(fd,"reports/…"))` → `lstatAt(fd, "reports/…")` 一行迁移，Linux 语义逐字不变）
- `src/schedule/agent/wire.ts`（**仅**：接口新增可选字段 `identity?`/`pathBackend?`/`acquire?`/`probe?`；把 `createAgent` 内 297-303 行抽成两个本地函数 `resolveIdentity(opts)`、`probeLock(opts, platform)`，函数体保持今天逻辑，作为 P1/P3 的各自落点；`createScheduleAgent` deps 与 `ScheduleAgent` 接口加 `probe?`；纯管线透传）
- 新建：`tests/schedule/core/seam-contract.test.ts`、`tests/schedule/core/fdpath-manifest.ts`（`FDPATH_MANIFEST`/`CLOSE_MANIFEST`/`JUDGE_MANIFEST`/`ABS_SYSCALL_MANIFEST` 纯数据）、`tests/schedule/compat/paths-v0.ts`（冻结快照）
- 不动：`tests/web-hub/boundary.test.ts`（P0 不加 import）。

**P1** 域：

- 新建：`src/web-hub/protocol/sched-identity.ts`，`tests/web-hub/protocol/sched-identity.test.ts`，`tests/schedule/core/identity-domain.test.ts`，`tests/integration/schedule-darwin-identity.test.ts`
- 修改：`src/schedule/agent/wire.ts`（**仅** `resolveIdentity()` 函数体、`proc` warn 文案 helper、把 `probe` 填入 `createScheduleAgent` deps 与 `clock` 的 `judge:`）；`src/schedule/agent/note.ts`（172、217 两处 judgeHolder 增 probe）；`src/schedule/agent/digest.ts`（222 增 probe）；`src/commands/schedule.ts`（仅 344 行文案）；`src/schedule/core/spec.ts`（仅 176 行 `start` 注释，不加 import）；`tests/web-hub/boundary.test.ts`（**仅新增**一条 `sched-identity.ts` 精确 import 钉子，只收紧不放宽）
- 不动：`recovery.ts`（P0 已定稿；P1 只消费）。

**P2** 域：

- 修改：`src/schedule/core/paths.ts`（Darwin 后端实现 + 默认后端切换）；`src/schedule/core/writer.ts`（**仅** `ensureStoreRoot`，lines 226-275）；`tests/tiers.ts`（**仅**追加一条 `TIER1_DECLARED`，见 §5.3；P2 是 tiers.ts 的唯一写者，P4-B 如需另追加须在 P2 合入后 rebase）
- 新建：`tests/schedule/core/paths-backend.test.ts`，`tests/integration/schedule-darwin-paths-race.test.ts`
- 不动：`reader.ts`（零改动：它只经 paths.ts 导出函数）、`lock.ts`。

**P3** 域：

- 修改：`src/schedule/core/lock.ts`（`perlFlockAcquire`、`defaultLockAcquire`、`withDirLock` 默认解析）；`src/schedule/agent/wire.ts`（**仅** `defaultFlockProbe()`、`probeLock()` 函数体与 flock warn 文案；ScheduleAgentDeps.storeOpts 增 `acquire?` 透传已在 P0）
- 新建：`tests/schedule/core/lock-acquire.test.ts`，`tests/integration/schedule-darwin-lock.test.ts`
- 不动：`writer.ts`（P0 已透传）。

**P4-A** 域：`src/web-hub/hub/schedule/service.ts`；`tests/web-hub/hub/schedule-service.test.ts`（仅 3 处 `readSelfIdentity()!`）。
**P4-B** 域：见 §5.2 各 suite；新建 `tests/helpers/sched-platform.ts`、`tests/integration/schedule-darwin-e2e.test.ts`；其余只改被列出的既有测试文件。
**P5** 域：`docs/dev/scheduled-reports/{README.md,S1-report.md,acceptance.md,darwin-report.md(新建)}`；`src/schedule/core/paths.ts` 头注释（仅注释，更新「non-Linux fail closed」措辞）。

**wire.ts 三方交叠的裁决**：P0 先把 `createAgent` 里的 identity/flock 探测抽成 `resolveIdentity`/`probeLock` 两个独立函数并加好全部可选字段（单次、串行、零行为变化）；此后 P1 只改 `resolveIdentity` 区域与 `proc` warn，P3 只改 `defaultFlockProbe`/`probeLock` 区域，P2 不碰 wire.ts。P1、P3 的 wire.ts 修改落在不同函数，可并行；合入顺序按 PR 先后 rebase，冲突预期为零（有冲突即越界信号）。

**writer.ts 的 opts 交叠裁决**：`SessionStoreOpts` 的字段新增（`acquire?`）与 `lockOpts()` 透传**由 P0 一次完成**；P3 不再碰 writer.ts，以「`acquire` 注入参数」形式消费（即 lock.ts 内解析默认值）；P2 只改 `ensureStoreRoot`；`writer.ts:1106` 的 `lstatAt` 迁移同样由 P0 一次完成（Linux 实现仍是同一个 `lstatSync(fdPath(...))`），P2 只实现 Darwin 的 `lstatAt`（在 paths.ts）。因 `StoreRoot` 自身携带 `backend`，`SessionStoreOpts` **不新增 backend 字段**。

---

## 3. 每包详细改动点

### P0 — 契约与 Linux 不变重构

**目标**：落定三个 seam 的最终签名；所有现有 Linux 测试不改一字全绿；mac 行为暂时不变（仍 fail closed）。Linux「不变」的举证口径见 §5.4（输出 / 错误 reason / 异常路径 / 开销预算四类可观察契约，而非单个字符串断言）。

#### P0-a `paths.ts`（无新增 import：仍仅 `node:crypto|fs|path`）

```ts
export interface PathBackend {
  readonly platform: "linux" | "darwin";
  /** fail-closed 能力探测（linux: /proc/self/fd 是目录；darwin: true） */
  available(): boolean;
  /** 目录 fd（`name` 缺省）或其 **单个基名** 子项当前应用于 syscall 的路径。
   *  linux：逐字保持 `/proc/self/fd/<fd>[/<name>]`（含历史上接受带 "/" 的 name）；
   *  darwin：`name` 必须满足 `isPlainName`（不含 "/"），否则抛 SchedFsError("bad-name")。 */
  path(fd: number, name?: string): string;
  /** 相对 `fd` 目录的相对路径 lstat —— **唯一** 允许多段 `rel` 的入口（评审 Blocker #1 方案 b，见 P2-a）。
   *  `rel` 约束：非空、≤ 8 段、每段 `isPlainName`（否则 `SchedFsError("bad-name")`）。
   *  linux：`lstatSync(fdPath(fd, rel))`（实现体为具名函数 `linuxLstatAt`），抛出原始 ErrnoException，行为逐字不变；
   *        不打开中间 fd、不触碰注册表。
   *  darwin：逐级 `openDirAt(cur, seg, opts)` 打开中间目录——每级经 `fdBackendOf(parent)` 的 `prepare → open → fstat → checkStat →
   *        confirm` 完成登记与快照校验——末段基名经 `path(cur, base)`（含 chain 重核）后 `lstatSync`；调用返回前**关闭并注销**全部中间 fd。
   *        中间段缺失 ⇒ 抛 `{ code: "ENOENT" }` 形态的 Error（调用方 `errCode(err)==="ENOENT"` 语义不变）；
   *        符号链接/非目录/owner/mode ⇒ SchedFsError。完整契约见下文「lstatAt 契约」。 */
  lstatAt(fd: number, rel: string, opts?: FsCheckOpts): Stats;
  /** 已打开目录 fd 的「当前位置」（M3：判断打开的对象而非陈旧路径串）。 */
  locate(fd: number): string;
  /** 打开前对目标路径取快照（linux: undefined；darwin: lstat，符号链接/缺失按现有 reason 拒绝）。 */
  prepare(path: string, kind: "dir" | "file"): unknown;
  /** open+fstat 之后：核对 pre-lstat / fstat / post-lstat 的 dev+ino 一致；kind==="dir" 时登记 fd（linux: no-op）。 */
  confirm(snap: unknown, a: { fd: number; path: string; st: Stats; kind: "dir" | "file"; parentFd?: number }): void;
}
export interface FsCheckOpts {
  uid?: number;
  backend?: PathBackend;
} // backend 仅入口(openDirPath*/resolveStoreRoot/openStoreRoot)读取
export interface StoreRoot {
  literal: string;
  real: string;
  dev: number;
  ino: number;
  backend?: PathBackend;
} // 仅显式传入时才出现 ⇒ 现有 toEqual 断言不变
export const linuxPathBackend: PathBackend; // 把今天的 fdPath/fdRealPath/fdAnchoringAvailable 原样搬进来
export function defaultPathBackend(): PathBackend; // P0: 恒 linux；P2: process.platform==="darwin" ? darwinPathBackend : linuxPathBackend
export function lstatAt(fd: number, rel: string, opts?: FsCheckOpts): Stats; // = fdBackendOf(fd).lstatAt(fd, rel, opts)
```

- **fd 注册表**（P0 只建骨架，P2 填实现；生命周期见 P2-b）：`globalThis[Symbol.for("pi-subagent:sched-fd-paths:v1")]` = `{ map: Map<number, FdRecord>, lastSweepAt: number }`，**惰性创建**——Linux 生产路径永远不创建它。`FdRecord` 为纯数据（`backend: "darwin"` 名字而非对象、`path`、`dev`、`ino`、`chain`、`lastUsed`），带 `:v1` 版本后缀，使 `/reload` 后新旧模块实例可安全共享同一张表。
- `fdBackendOf(fd)`：`reg = globalThis[KEY]`；`reg === undefined || reg.map.size === 0` ⇒ 直接 `linuxPathBackend`；命中记录且 `fstat` dev/ino 与记录一致 ⇒ darwin 后端；命中但不一致 ⇒ 删除记录并回落默认后端。
- **开销口径（评审 #4：不再声称「零开销」）**：Linux 生产路径每次 `fdPath` 额外成本 = 一次 `globalThis[Symbol.for-key]` 属性读取（注册表未创建时返回 `undefined`）。预算：`fdPath` p50 相对冻结的 v0 实现 **≤ +150 ns/次**；一次 `transact`（空写、tmpfs）中位数 **≤ +2 %**（一次事务约 17 次 `fdPath`，总增量 ≲ 3 µs，而 2-3 次 `flock` 子进程 + `fsync` 在毫秒级）。度量脚本放在 `seam-contract.test.ts` 的 `it.skipIf(!process.env.PI_TOOLKIT_SCHED_BENCH)`（计时不进 CI 门禁，避免 flake），数字记录进 `darwin-report.md`；超预算 ⇒ P0 不合入。
- 自由函数签名**不变**（`fdPath(fd,name?)`、`fdRealPath(fd)`、`openDirPath(path,opts)`、`openDirPathUnchecked(path)`、`openDirAt(parentFd,name,opts)`、`readFileAt(dirFd,name,max,opts)`、`closeQuiet(fd)`、`fdAnchoringAvailable()`），新增 `lstatAt(fd, rel, opts?)`（与 `openDirAt` 一样接受并透传 `opts`，`uid` 生效；`opts.backend` 只在入口函数读取，子级一律 `fdBackendOf(parentFd)`）；内部改走后端：入口函数用 `opts.backend ?? defaultPathBackend()`，子级函数用 `fdBackendOf(parentFd)`；`closeQuiet` 在 `closeSync` 同时删注册表项。
- **`lstatAt` 契约（复审 R2-#1.2：把实现链写成契约；P0 只定义签名与 Linux 实现，Darwin 实现在 P2）**：
  1. **调用链**：`lstatAt(fd, rel, opts) → fdBackendOf(fd).lstatAt(fd, rel, opts)`；Darwin 实现对 `rel` 的每个中间段调用 `openDirAt(cur, seg, opts)`，后者对子级用 `fdBackendOf(cur)` 取后端，执行 `prepare(path,"dir") → openSync(O_RDONLY|O_DIRECTORY|O_NOFOLLOW) → fstatSync → checkStat(owner/mode/type) → confirm(snap,{fd,path,st,kind:"dir",parentFd:cur})`。**`openDirAt` 接受并透传 `opts`**（`uid` 参与 owner 检查；`backend` 字段对子级无意义，被忽略）。
     1a. **`openDirAt` 内部的路径构造与 parent chain 复核次序（第 3 轮定点补充）**：`openDirAt(parentFd, seg, opts)` 先调用 `fdBackendOf(parentFd).path(parentFd, seg)` 构造子级实际路径——该调用本身**先重核 parent 的登记**（`fstat(parentFd)` dev/ino 与记录一致 + 祖先 chain 逐级 `lstat`，经 `darwinSnapshotEqual` 比较），核验失败抛 `moved`（并删 parent 记录）。因此「打开子级」永远发生在「parent 链刚被复核」之后；parent→child 的关联由「已打开、已核验的 parent fd + 子级路径构造」共同保证，**而不是仅靠子项自身的 pre / fstat / post 三方比较**。构造出的子级路径随后严格按序走：`prepare(childPath,"dir")`（pre-lstat）→ `openSync(childPath, O_RDONLY|O_DIRECTORY|O_NOFOLLOW)` → `fstatSync` → `checkStat`（类型/owner/mode）→ `confirm(snap, { fd, path: childPath, st, kind: "dir", parentFd })`；`confirm` 内做 post-lstat 并与 pre、fstat 三方比对 dev/ino，通过后才登记，`chain = parentRecord.chain + [self]`（`self = { dev, ino, bt: birthOf(st) }`）。**残余（不声称消除）**：`path()` 返回之后、`prepare`/`openSync`/`confirm` 之间 parent 再被替换的窗口，属于已披露的 **U1**（校验后 syscall 前）；`path()` 每次使用前重核只是把该窗口压到「单次 syscall 粒度」，替换若落在窗口内，最坏情形是子级经新 parent 被打开，随后在下一个校验点（下一次 `path()`/`locate()`/`lstatAt()`）因 chain 不符被检出并拒绝（见 D2）。
  2. **登记原子性**：`confirm` 的最后一步才写注册表——成功 ⇒ 已登记且校验通过；抛错（含容量满拒绝 `io`）⇒ **无记录残留**。`openDirAt` 在 open 之后任一步失败（`fstat`/`checkStat`/`confirm`）都先 `closeQuiet(fd)`（同时删可能存在的记录）再重抛——不泄漏临时 fd。
  3. **失败清理**：`lstatAt` 用 `opened: number[]` 记录本次调用打开的中间 fd，`try { … } finally { for (fd of opened.reverse()) closeQuiet(fd) }`；任一级失败（`symlink`/`not-dir`/`owner`/`mode`/`moved`/`io`，以及把 `missing` 转成 `{code:"ENOENT"}` 的路径）都经 `finally` 关闭已打开的中间 fd。
  4. **中间 fd 的归属（选择：立即关闭并注销，不随调用方）**：`lstatAt` 的返回值是 `Stats`，**不外泄任何 fd**，调用方无从关闭；末段 `lstat` 之后中间 fd 即无用途，于是在同一次调用内 `closeQuiet`（`closeQuiet` 同时删注册项）。理由：①若不注销，条目只能等 §3.P2-b 的空闲 TTL（10 min）清扫，与「合法目录 fd 生命期 ≤ 一次事务」及容量 1024 冲突——`writeReportLocked` 的报告名分配循环最坏 4096 次 `lstatAt`（`INVENTORY_SCAN_MAX`），会直接顶满容量并触发 fail-closed；②每次调用都重新「开 + 快照 + 校验」，每个 `lstatAt` 都是一次完整的链校验，语义清晰、无跨调用的陈旧快照；③成本仅 `(段数−1)` 次 open/close（现仅 1 个站点、1 个中间段 `reports`），可忽略。
  5. **资源不变量（测试断言）**：成功 / `ENOENT`（中间缺失）/ `symlink` / `not-dir` / owner·mode 违规 / 中途 `moved` 各路径，调用前后注册表 `size` 与进程打开的 fd 数**完全相等**；连续 4096 次 `lstatAt` 后 `size` 不增长。Linux 实现不开 fd、不碰注册表，用同一测试断言「注册表未被创建」。
- `resolveStoreRoot(storeDir, opts)`：若 `opts.backend` 给出，写入 `StoreRoot.backend`；`openStoreRoot(root, opts)`：`opts.backend ?? root.backend ?? default`。

#### P0-b `recovery.ts`（无新增 import）

```ts
export type StartDomain = "ticks" | "epoch-ms";
export const SCHED_EPOCH_MS_FLOOR = 1e11; // ≥1e11 ⇒ epoch-ms（1973-03 起）；Linux 起点 ticks（USER_HZ=100）需 31 年 uptime 才到
export function startDomainOf(start: number): StartDomain;
export interface LivenessProbe {
  startOf(pid: number): number | undefined | "error";
  pidMayExist(pid: number): boolean;
  /** 设置后：holder.start 与之不同域 ⇒ unprovable。procLivenessProbe 不设 ⇒ Linux 字节不变。 */
  readonly startDomain?: StartDomain;
}
export interface IdentityDeps {
  readSelf(): ProcessIdentity | undefined;
  probe?: LivenessProbe;
}
```

- `judgeHolder`：在「同进程」分支之后、`probe.startOf` 之前追加 `if (probe.startDomain !== undefined && startDomainOf(holder.start) !== probe.startDomain) return { liveness: "unprovable" };`。`procLivenessProbe` 不加字段（`Object.freeze` 对象保持原样）。
- `recoverDeadRuns`/`unknownRunKeys`/`closeEpochRuns` **代码不改**（它们经 `opts` 透传到 `judgeHolder`，第 170、190 行）；probe 如何到达它们见 P1-b 的「judge 调用链」。
- `readSelfIdentity()`、`readBootId()`、`procLivenessProbe` 保持原语义（Linux 默认）。头注释 `ProcessIdentity.start` 补「Linux ticks / Darwin epoch-ms（由 identity seam 提供）」。

#### P0-c `lock.ts`（已 import `node:child_process`，可加）

```ts
export type AcquireResult = "held" | "busy" | { kind: "fail"; detail: string };
export type LockAcquire = (fd: number) => AcquireResult;           // 同步；成功后锁属于调用方 fd 的 open file description
export interface AcquireDeps { spawn?: typeof spawnSync; timeoutMs?: number }   // 测试注入（捕获 argv/stdio/timeout；默认 spawnSync / 5000）
export function linuxFlockAcquire(flockBin = "flock", deps?: AcquireDeps): LockAcquire;
//   原 spawnSync(flockBin, ["-x","-n","-E","75","3"], {stdio:["ignore","ignore","ignore",fd], timeout:5000}) 原样提取（**不传 env**）；
//   文案不变："flock binary not found (fail closed)" / `flock: ${err}` / `flock exited ${status ?? signal}`
export interface LockOpts { …现有…; flockBin?: string; acquire?: LockAcquire }   // acquire 优先于 flockBin
```

- `tryLock(dirFd, name, acquire)`：`openSync(O_RDWR|O_CREAT|O_NOFOLLOW|O_NONBLOCK, 0o600)` → fstat 校验 → `acquire(fd)` → `held` 后**保留**现有 `lstatSync(path)` dev/ino 复核（锁文件被替换 ⇒ `retry`/`gone`，P3 测试覆盖）；`busy` ⇒ `{kind:"busy"}`；`fail` ⇒ `{kind:"fail", detail}`。`withDirLock` 里 `const acquire = opts.acquire ?? linuxFlockAcquire(opts.flockBin)`（P3 把默认换成 `defaultLockAcquire(...)`）。
- `FLOCK_CONFLICT_EXIT=75` 保留；Linux 行为（命令行、5 s 超时、事务内持锁、E_BUSY 文案）逐字不变。

#### P0-d `writer.ts` / `wire.ts` 管线

- `SessionStoreOpts`：`/** flock binary (tests) */ flockBin?: string;` 之后加 `acquire?: LockAcquire;`（`import type { LockAcquire } from "./lock.js"`）；`lockOpts()` 在 `flockBin` 那行之后加 `...(opts.acquire === undefined ? {} : { acquire: opts.acquire })`（`exactOptionalPropertyTypes` 须用条件展开）。
- **`writer.ts:1106`（`writeReportLocked` 报告名分配循环）**：`lstatSync(fdPath(fd, \`${SCHED_REPORTS_DIR}/${allocated}\`))`→`lstatAt(fd, \`${SCHED_REPORTS_DIR}/${allocated}\`)`（import `lstatAt`）。Linux 实现仍是同一个 `lstatSync(fdPath(...))`，抛出的 ErrnoException 与调用方 `errCode(err) !== "ENOENT"`判断完全不变；这是整个`src/schedule`里**唯一**的多段相对路径 syscall，迁移后 Darwin 的`path()`可以机械地禁止`/`（评审 #1）。
- `wire.ts`：`ScheduleWireOpts` 加 `identity?: IdentityDeps; pathBackend?: PathBackend; acquire?: LockAcquire;`（保留 `readSelf?`、`flockProbe?`）；`ScheduleAgentDeps` 加 `probe?: LivenessProbe; pathBackend?: PathBackend`，`storeOpts` 加 `acquire?: LockAcquire`；`ScheduleAgent` 接口加 `readonly probe?: LivenessProbe`；`buildStore` 透传 `acquire`；`resolveStoreRoot`/`ensureStoreRoot` 4 个调用点（wire.ts 260/376/521/528）透传 `backend`（`...(deps.pathBackend ? { backend: deps.pathBackend } : {})`）。抽出的两个函数 P0 阶段体为：
  ```ts
  function resolveIdentity(opts: ScheduleWireOpts): IdentityDeps; // = opts.identity ?? (opts.readSelf ? { readSelf: opts.readSelf } : { readSelf: readSelfIdentity })
  function probeLock(opts: ScheduleWireOpts): boolean; // = (opts.flockProbe ?? defaultFlockProbe)()
  ```
  `createAgent` 其余逻辑（`warnOnce("proc", …)`/`warnOnce("flock", …)` 文案）不变。

#### P0 新增测试资产

1. **`tests/schedule/compat/paths-v0.ts`**（新建，冻结快照）：`origin/dev` 时点 `paths.ts` 的逐字副本（仅为自包含，不依赖新代码；沿用 `tests/schedule/compat/v1-reader.ts` 先例，头注释写明「do not modernize」）。
2. **`tests/schedule/core/fdpath-manifest.ts`**（新建，纯数据）：`FDPATH_MANIFEST`、`CLOSE_MANIFEST`、`JUDGE_MANIFEST`（内容见 P2-c / P2-b / P1-b），seam-contract 与后续各包测试**读数组**，不手抄行号。
3. **`tests/schedule/core/seam-contract.test.ts`**（tier1，无 `node:child_process` 字面量；差分/静态/注入用例）：
   - **差分（Linux 专属 `describe.skipIf(!existsSync("/proc/self/fd"))`）**：同一场景矩阵分别跑 `paths-v0` 与现 `paths.ts`，比较 ①输出：`fdPath` 对 `(fd ∈ {0,3,4096}) × (name ∈ {undefined,"a","a/b","reports/x","x y"})` 全矩阵字符串；`readFileAt` 的 `bytes/size/mtimeMs/dev/ino`；②错误 reason 与 message：missing / 末段符号链接 / 祖先符号链接（`openStoreRoot`）/ not-dir / not-file(FIFO) / owner（`uid` 覆盖）/ mode(0o777) / too-large / grew / moved（rename 后重建）/ bad-name / relative / vault（字面量与 canonical）；③异常路径：`lstatAt` 对缺失项抛带 `code:"ENOENT"` 的原始 Error；`fdRealPath` 对已关 fd 抛同样的 `io` 消息；`closeQuiet` 对已关 fd 静默。
   - **锁参数差分**：`linuxFlockAcquire` 注入 `spawn` 捕获 `file/args/options`，`toEqual` 原值（`["-x","-n","-E","75","3"]`、`stdio:["ignore","ignore","ignore",fd]`、`timeout:5000`、**无 env 键**）；`SCHED_LOCK_RETRY_MS/TIMEOUT_MS/SHUTDOWN_TIMEOUT_MS` 值断言（25 / 2000 / 500）。
   - `judgeHolder` 对 `procLivenessProbe` 的现有矩阵不变；`startDomain` 设置后跨域 ⇒ unprovable，同域走原矩阵（fake probe）。
   - `withDirLock` 注入 fake `acquire`：`held`/`busy`/`{kind:"fail"}` 三路 ⇒ 成功/超时 E_BUSY/E_BUSY+detail；`flockBin:"/nonexistent/flock"` ⇒ 仍是 `flock binary not found`。
   - **manifest 静态扫描**（口径与算法见 P2-c）：`fdPath(` 表达式集合、`closeSync(` 站点集合、`/proc/self/fd` 字面量仅 `paths.ts`。
   - 静态：`paths.ts`/`recovery.ts` 不含 `child_process`、写原语词（复刻 `reader.test.ts:90-98` 的正则，提前保护 C7）。
   - 开销度量（`PI_TOOLKIT_SCHED_BENCH=1` 才运行，信息性）。

**P0 验收命令**：`npm run typecheck`；`npx vitest run tests/schedule tests/web-hub/boundary.test.ts tests/web-hub/hub/schedule-service.test.ts tests/governance`（Linux 上全绿；mac 上按基线不变，已红的保持原样红）；`PI_TOOLKIT_SCHED_BENCH=1 npx vitest run tests/schedule/core/seam-contract.test.ts` 记录预算数字；`git diff --quiet origin/dev -- tests/fixtures/`；`npm run format:check`。

---

### P1 — Darwin identity

#### P1-a 新文件 `src/web-hub/protocol/sched-identity.ts`

imports 仅：`node:child_process`、`node:os`。**不 import** `schedule/core`（用本地结构类型）。无模块级可变状态；全部依赖经参数注入。

```ts
export interface DarwinIdentityHost {
  // 默认 = 真实实现；测试全量注入
  execFileSync(
    file: string,
    args: readonly string[],
    opts: { env: Record<string, string>; timeout: number; maxBuffer: number },
  ): string; // 抛错 = 非零退出/超时/ENOENT（带 status/code）
  kill(pid: number, sig: 0): void; // = process.kill
  hostname(): string;
  pid: number;
}
export interface DarwinIdentity {
  readSelf(): { pid: number; start: number; host: string; boot: string } | undefined;
  probe: {
    startOf(pid: number): number | undefined | "error";
    pidMayExist(pid: number): boolean;
    readonly startDomain: "epoch-ms";
  };
}
export function createDarwinIdentity(host?: Partial<DarwinIdentityHost>): DarwinIdentity;
export function parsePsLstart(text: string): number | undefined; // 纯函数
export function parseBootSessionUuid(text: string): string | undefined; // 纯函数
```

- 命令（绝对路径、固定环境 `{ LC_ALL: "C", TZ: "UTC0", PATH: "/usr/bin:/bin" }`，`timeout: 2000`，`maxBuffer: 4096`，stderr 丢弃）：`/bin/ps -o lstart= -p <pid>`；`/usr/sbin/sysctl -n kern.bootsessionuuid`。pid 先校验 `Number.isSafeInteger(pid) && pid > 0`，否则返回 `"error"`。
- `parsePsLstart`：严格匹配 `^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|…|Dec) {1,2}(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})\s*$`（`ps` 对个位日补空格），`Date.UTC(...)` 后**回读校验**（月/日/时分秒不溢出、星期与 `getUTCDay` 一致），返回整秒 epoch **毫秒**（`…000`），且 `Number.isSafeInteger && >= 0`；任何偏差 ⇒ `undefined`（调用方映射为 `"error"`）。
- `parseBootSessionUuid`：`trim` 后须匹配 UUID（`/^[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$/`），统一小写？——**不改大小写**（原样存，避免与已存 holder 比较不一致；比较处同源同写法）；否则 `undefined`（不猜 boot id）。
- `probe.startOf(pid)`：先 `kill(pid,0)`：`ESRCH` ⇒ `undefined`；`EPERM`/其它 ⇒ 继续；再 `ps`：退出状态 1 且输出空 ⇒ `undefined`（进程不存在）；其他执行失败/解析失败 ⇒ `"error"`；成功 ⇒ epoch-ms。
- `probe.pidMayExist(pid)`：`kill(pid,0)`：仅 `ESRCH` ⇒ `false`。
- `readSelf()`：`startOf(host.pid)` 为 number 且 boot 有值 ⇒ `{ pid, start, host: hostname(), boot }`；否则 `undefined`（不执行，与 Linux「无 /proc ⇒ undefined」同构）。
- 性能与子进程预算见 P1-b 末尾「读自身身份 / 子进程启动预算」；本文件不加缓存（避免模块级状态）。

#### P1-b wiring（`wire.ts`，仅 `resolveIdentity` 区域）

```ts
function resolveIdentity(opts): IdentityDeps {
  if (opts.identity) return opts.identity;
  if (opts.readSelf) return { readSelf: opts.readSelf }; // 旧测试 seam 兼容
  if (process.platform === "darwin") return createDarwinIdentity(); // import { createDarwinIdentity } from "../../web-hub/protocol/sched-identity.js"
  return { readSelf: readSelfIdentity }; // Linux/其他：今天的行为
}
```

- `createAgent`：`const idDeps = resolveIdentity(opts)`（每次 wireSchedule 一次，闭包内共享）；`self = plain ? idDeps.readSelf() : undefined`；`createScheduleAgent({ …, ...(idDeps.probe ? { probe: idDeps.probe } : {}) })`。
- `proc` warn 文案平台化：Linux **逐字保持** `"no /proc identity: scheduled tasks cannot execute here"`；darwin：`"no process identity (ps/sysctl unavailable): scheduled tasks cannot execute here"`（英文 token，符合 UI 文本规则）。
- `createScheduleAgent`：`agent.probe = deps.probe`；`createSessionClock({ judge: { currentEpoch, epochDisposed, ...(deps.probe ? { probe: deps.probe } : {}) } })`。
- `note.ts:172/217`、`digest.ts:222`：`judgeHolder(x, self, { currentEpoch, epochDisposed, ...(owner.probe ? { probe: owner.probe } : {}) })`（note 取 `schedule.probe`，digest 取 `deps.agent.probe`；`ScheduleNoteOwner`/digest deps 类型已含 agent，探针字段可选 ⇒ 现有测试 fake 无需改）。
- **`judge` 调用链全量清单（评审 #6；`JUDGE_MANIFEST`，HEAD 实测：`judgeHolder(` 7 个调用表达式 + 声明 `recovery.ts:103`；`recoverDeadRuns(` 1 个调用 + 声明 `recovery.ts:161`；`recoverRuns(` 1 个调用 + 声明 `claim.ts:333`；`unknownRunKeys(` **0 个生产调用** + 声明 `recovery.ts:186`；`closeEpochRuns`/`closeEpoch`（`wire.ts:615`）只用 `sameHolder`，**不判活**，无需 probe）**：

  | #   | 站点                                                | 直接/间接                               | probe 到达途径（P1 之后）                                                                                                                                                                                                                      | 专属测试                                                                                                                                                                                                             |
  | --- | --------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | J1  | `note.ts:172` `judgeHolder`                         | 直接                                    | `resolveIdentity().probe` → `createScheduleAgent deps.probe` → `ScheduleAgent.probe` → `schedule.probe`（`ScheduleNoteOwner`）                                                                                                                 | `tests/schedule/agent/note.test.ts`：注入 `startDomain:"epoch-ms"` 的 fake probe；holder.start 不同 ⇒ dead ⇒ 允许重发；相同 ⇒ 不重发；断言 `probe.startOf` 被调用                                                    |
  | J2  | `note.ts:217` `judgeHolder`                         | 直接                                    | 同 J1                                                                                                                                                                                                                                          | 同上（resend 前置判定分支）                                                                                                                                                                                          |
  | J3  | `digest.ts:222` `judgeHolder`                       | 直接                                    | `deps.agent.probe`                                                                                                                                                                                                                             | `tests/schedule/agent/digest.test.ts`：inflight holder dead/alive/unprovable 三路；`startOf` 被调用                                                                                                                  |
  | J4  | `recovery.ts:170` `recoverDeadRuns` → `judgeHolder` | 间接（经 `opts`）                       | `wire.ts:467` 的 `createSessionClock({ judge: { currentEpoch, epochDisposed, probe } })` → `clock.ts:79 deps.judge` → `clock.ts:291 recoverRuns(store, deps.self, deps.judge ?? {})` → `claim.ts:339 recoverDeadRuns(draft,self,ctx.now,opts)` | `tests/schedule/agent/clock.test.ts`：darwin fake probe 下，死 holder 的 running run ⇒ `unknown(crash)`；同域同值 ⇒ 不动；**负向用例**：构造 agent 时漏传 probe ⇒ 断言「未识别死亡」（证明接线真实生效而非碰巧通过） |
  | J5  | `recovery.ts:190` `unknownRunKeys` → `judgeHolder`  | 间接（经 `opts`），**当前无生产调用方** | 无（hub 走自己的 `predictUnknowns`，见 J6/J7）；契约：将来任何调用方必须传 `identity.probe`                                                                                                                                                    | `identity-domain.test.ts`：对 `unknownRunKeys(state, self, { probe })` 的单元用例；`JUDGE_MANIFEST` 扫描——`src` 新增 `unknownRunKeys(`/`recoverDeadRuns(`/`recoverRuns(`/`judgeHolder(` 调用而未登记 ⇒ 红            |
  | J6  | `service.ts:376` `judgeHolder`                      | 直接（hub）                             | P4-A：`identity.probe`（`deps.identity ?? 平台默认`）                                                                                                                                                                                          | `schedule-service.test.ts`：darwin fake probe 下 `predictUnknowns` 对 dead / alive / 同秒复用 / `"error"` 的判定                                                                                                     |
  | J7  | `service.ts:382` `judgeHolder`（rescan 复核）       | 直接（hub）                             | 同 J6                                                                                                                                                                                                                                          | 同上（二次复核分支）                                                                                                                                                                                                 |

  `JUDGE_MANIFEST` 的扫描口径与 `FDPATH_MANIFEST` 相同（去注释、不含声明），定义在 `tests/schedule/core/fdpath-manifest.ts`。

- **读自身身份 / 子进程启动预算（评审 #11）**：`readSelf()` = 1×`ps` + 1×`sysctl` = **2 次子进程启动**；`createAgent` 每个 session stack 调一次（含 `/reload` 重建），hub 在 `createScheduleService` 构造时调一次。`judgeHolder` 触发的探测：host/boot 不符、同 pid+start、`kill(pid,0)` 得 ESRCH ⇒ **0 次**；走到 `startOf` 且进程存在 ⇒ **1 次 `ps`**。时钟：`recoverRuns` 在 session_start 与每 30 s poll 各一次，每次最多「非终态且 holder 为外部进程」的 run 数 × 1 次 `ps`（本进程自己的 holder 为 0 次）；hub：每个候选 run 每轮 ≤ 2 次（第一次判 dead 后 rescan 再判一次），hub 扫描周期 60 s。**预算**：单轮（一次 `recoverRuns` 或一次 hub 扫描）≤ 8 次启动且墙钟 ≤ 250 ms；超出则在 `createDarwinIdentity` 闭包内加实例级 TTL 缓存（5 s、容量 64，无模块级状态）再议。测试用注入的 `host.execFileSync` 计数器断言：`readSelf`=2、自身 holder 判定=0、ESRCH=0、外部存活 holder=1。
- `commands/schedule.ts:344` 文案 `（/proc）` → `（/proc 或 ps/sysctl）`；`spec.ts:176` 注释补 epoch-ms。

#### P1 测试

- `tests/web-hub/protocol/sched-identity.test.ts`（tier1；注入 `host`，不字面量引用 `node:child_process` 以免触发 tier 标记——该文件内不出现该字符串）：`parsePsLstart` 正例（`Tue Nov 17 05:40:06 2026`、个位日 `Tue Nov  3 …`）、闰日、年边界、非法月/日 31 溢出、星期不匹配、中文/本地化输出、尾部垃圾 ⇒ undefined；ms 值 `% 1000 === 0` 且 safe integer；`parseBootSessionUuid` 正/负；`startOf`：ESRCH ⇒ undefined、EPERM+ps 成功 ⇒ number、ps 退出 1 空 ⇒ undefined、ps 超时/乱码 ⇒ `"error"`；`pidMayExist`；`readSelf` 缺 boot ⇒ undefined；环境固定 `LC_ALL/TZ/PATH` 断言（拦截 `execFileSync` 入参）。
- `tests/schedule/core/identity-domain.test.ts`（tier1，纯）：`judgeHolder` × (host 异/boot 异/同进程/异域 ticks vs epoch-ms ⇒ unprovable/同域同值 alive/同域异值 dead/ps `"error"` ⇒ unprovable/同秒复用 ⇒ alive（残余证据）) 的完整矩阵，用 fake `LivenessProbe{startDomain:"epoch-ms"}`；Linux probe（无 startDomain）旧矩阵不变。边界：`start=99_999_999_999`⇒ticks、`100_000_000_000`⇒epoch-ms。
- `tests/integration/schedule-darwin-identity.test.ts`（integration 前缀 ⇒ tier2；`describe.skipIf(process.platform !== "darwin")`）：真实 `createDarwinIdentity()`：`readSelf()` 有值；`probe.startOf(process.pid) === readSelf().start`；spawn `sleep 30` 取其 `startOf`，kill 后 `startOf` ⇒ `undefined`；`pidMayExist(999999)` false；boot 与直接 `sysctl` 一致。
- `tests/web-hub/boundary.test.ts`：新增钉子（**只收紧**）——扫描 `sched-identity.ts` 的**全部** import（**不**过滤 `typeOnly`，即 `scanImports` 原样结果），断言恰为 `[{spec:"node:child_process",typeOnly:false},{spec:"node:os",typeOnly:false}]`，**零相对 import（含 type-only）**。理由（评审 #3 的 boundary 结论，已读 `boundary.test.ts:292-345` 核实）：①`hubImportAllowed`（:292-307）对 `{protocol,hub}` 之外的相对 import **不因 type-only 放行**——type-only 豁免只存在于「hub 文件 → `src/config/settings.ts`」一条（`HUB_TYPE_ONLY_ALLOWLIST`）；`protocol files may not escape {protocol,hub}` 用例扫描所有 import（含 type-only），所以 protocol 文件**不能** type-import `schedule/core`，这也是 P1 用结构化类型的原因；②`protocol/hub files are discovered`（:323-336）只是 `arrayContaining` 7 个代表文件，**不是**全等也**不是逐文件闭包保证**——新文件虽会被 `globSync("src/web-hub/protocol/**/*.ts")` 自动纳入通用规则（只能 `node:*`/typebox/`{protocol,hub}` 内相对 import），但逐文件精确闭包只存在于显式钉表（`SCHEDULE_CORE_FILE_CLOSURE` 等），故必须新增本钉子，而不是依赖 discovery。P1 同时验证 `protocol/hub imports stay within…`、`protocol/hub never import @earendil-works/*…`、`protocol files may not escape…` 三条仍绿；`SCHEDULE_CORE_FILE_CLOSURE` 与 hub 只读用例不动。

**P1 验收命令**：`npx vitest run tests/web-hub/protocol/sched-identity.test.ts tests/schedule/core/identity-domain.test.ts tests/web-hub/boundary.test.ts tests/schedule/core/recovery.test.ts tests/schedule/agent/wire.test.ts`（Linux 全绿；mac 另跑 `tests/integration/schedule-darwin-identity.test.ts`）。

---

### P2 — Paths 后端（Darwin 快照）

#### P2-a `paths.ts`：`createDarwinPathBackend` / `darwinPathBackend`（无新增 import；仅用已 import 的 `lstatSync/fstatSync/openSync/realpathSync/statSync/readlinkSync/constants`；源码与注释**避开 C7 的写原语词**）

```ts
export interface DarwinBackendOpts {
  // 全部仅供测试注入；生产用 darwinPathBackend = createDarwinPathBackend()
  now?: () => number; // 注册表 lastUsed/TTL 时钟
  capacity?: number; // 默认 1024
  birthtime?: "auto" | "off"; // 默认 auto；off ⇒ 所有快照 bt=null（模拟无 birthtime 的文件系统）
  ttlMs?: number; // 默认 600_000（空闲 10 min）
  hooks?: { beforeVerify?(point: string): void; afterVerify?(point: string): void }; // 确定性竞态测试：point ∈ "path"|"locate"|"confirm-post"|"lstatAt"
}
export function createDarwinPathBackend(o?: DarwinBackendOpts): PathBackend;
export const darwinPathBackend: PathBackend;
```

**注册表记录**：`FdRecord = { backend: "darwin"; path: string; dev; ino; chain: Array<{dev: number; ino: number; bt: number | null}> /* 从 "/" 到本目录每一级 */; lastUsed: number }`。`bt` 是**可信的** `birthtimeMs`（不可信时为 `null`，规则见下「birthtime 兜底」），随 dev/ino 一并快照，降低 APFS inode 复用造成的误等（见 U5）。

- `available()`：恒 `true`。
- `prepare(path, kind)`：`lstatSync(path)`（ENOENT ⇒ `missing`；`isSymbolicLink()` ⇒ `symlink`；`kind==="dir"` 非目录 ⇒ `not-dir`；`kind==="file"` 非普通文件 ⇒ `not-file`）→ 返回 pre 快照。**FIFO**：文件分支 `lstat` 判定非普通文件即拒绝，且 open 仍带 `O_NOFOLLOW|O_NONBLOCK`，不会阻塞。
- `confirm(snap, {fd, path, st, kind, parentFd})`（调用次序与 parent 复核见 §3.P0-a「lstatAt 契约」1a）：`hooks.beforeVerify("confirm-post")`；`post = lstatSync(path)`；要求 `pre.dev/ino === st.dev/ino === post.dev/ino`，否则 `moved`；`kind==="dir"` ⇒ 登记：有 `parentFd` ⇒ `chain = parentRecord.chain + [{ dev: st.dev, ino: st.ino, bt: birthOf(st) }]`、`path = join(parentRecord.path, name)`；无 parent（入口 `openDirPath*`）⇒ 对 `path` 逐级 `lstat`（任一级为符号链接/非目录 ⇒ `moved`；每级 `bt = birthOf(lstat)`）生成 chain，并要求末级 dev/ino = fstat。`confirm` 是原子的：全部校验通过后最后一步才登记，抛错则无记录残留。
- **birthtime 兜底（复审 R2-#1.3；选择：降级为 dev/ino-only 并列残余，不 fail closed）**：
  - **归一化口径（第 3 轮统一）**：任何快照在进入比较器之前**一律**经 `birthOf()` 归一化，因此 `darwinSnapshotEqual` 的输入 `bt` 只有 `number | null` 两种取值，**不会出现 `0`/`NaN`/负值的原始 stat 值**，也就不存在「`null` 与 `0` 直接比较」的情形。
  - `birthOf(st) := darwinBirthTrusted(st) ? st.birthtimeMs : null`，`darwinBirthTrusted(st) := Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 && st.birthtimeMs < st.ctimeMs`（测试旋钮 `birthtime:"off"` 恒为 `null`）。不可信（⇒ `null`）的情形：`0`/`NaN`/负值（文件系统不提供；`darwinBirthTrusted` 要求 `> 0`）；`birthtime ≥ ctime`（libuv 在无 btime 时可能回填 ctime 的伪值——而目录 ctime 随内容变化，直接比较会产生**假 `moved`**；刚创建、尚未被修改的目录 birth≈ctime 也落入此类）；精度不足（如 1 s/2 s 粒度）不单独判定，只会让同一粒度内的重建无法区分，退化为 dev/ino-only，不引入新的误拒。
  - **比较函数**（纯函数，导出 `darwinSnapshotEqual(snap, cur)` 供表驱动测试）：`dev`、`ino` 必须相等；输入 `snap.bt`/`cur.bt` 均已经 `birthOf()` 归一化（`number | null`）：`snap.bt` 为 number 而 `cur.bt === null`（原先可信、现在不可信——含现在原始 stat 为 0/NaN/负值/≥ctime）⇒ **不等**（fail closed，视为对象/文件系统已变）；二者均为 number ⇒ 必须 `===`；`snap.bt === null`（无论 `cur.bt` 是 `null` 还是 number）⇒ 只比较 dev/ino。
  - **为何降级而不 fail closed**：①birthtime 只是对 U5（inode 复用）的**补充缓解**，主身份仍是 dev/ino；②fail closed 会让 schedule 在不提供 birthtime 的文件系统（NFS/SMB/exFAT/FUSE、旧 macOS 卷，以及 Linux 辅助测试的 tmpfs）上整体不可用，违背「完整支持」，伪 birthtime 还会制造假 `moved`；③降级的代价只是 U5 窗口在这些目录上仅靠 dev/ino，已并入 U5 残余并写入 README/report。
- **`path(fd, name?)` 的多段语义（评审 Blocker #1 的接口决议）**：
  - Darwin `path()` **只接受目录本身或单个基名**：`name !== undefined && !isPlainName(name)`（含任何 `/`、`.`、`..`、NUL）⇒ `SchedFsError("bad-name")`。因此「拼接多段后只验证 fd 祖先链、不验证中间段」这种用法在 Darwin 上**无法表达**。
  - 取记录（缺 ⇒ `SchedFsError("io","fd has no verified path")`）；`hooks.beforeVerify("path")`；`fstatSync(fd)` dev/ino 须等于记录（否则**删记录**并抛 `moved`）；**逐级重核 chain**（每个前缀 `lstat`：非符号链接、是目录、与记录按 `darwinSnapshotEqual` 一致，否则**删记录**并抛 `moved`）；刷新 `lastUsed`；`hooks.afterVerify("path")`；返回 `join(record.path, name)`。
  - **多段只走 `lstatAt(fd, rel, opts?)`**（P0 已把 `writer.ts:1106` 迁入；Darwin 实现严格按 §3.P0-a「lstatAt 契约」1-5 条）：`rel` 拆段，除末段外每段 `openDirAt(cur, seg, opts)`（`O_DIRECTORY|O_NOFOLLOW` + 类型/owner/mode 检查 + `confirm` 登记 + 快照链），末段基名走 `path(cur, base)`（含 chain 重核与 `hooks`）后 `lstatSync`；**返回前（含任一级失败）在 `finally` 里关闭并注销全部中间 fd**。中间段符号链接（含指向外部）⇒ `symlink`；非目录 ⇒ `not-dir`；中间段缺失 ⇒ 抛 `{code:"ENOENT"}` 形态 Error（保持调用方 `errCode(err)==="ENOENT"` 判据）。
  - **选择（b）「先开后验中间目录、只对基名 syscall」而非（a）「`path()` 内逐级 lstat」的理由**：(1) 中间目录因此获得与 `openDirAt` 完全相同的 O_NOFOLLOW、类型、owner、mode、dev/ino+birthtime 快照链，并受后续 `path()` 逐次重核；(a) 的逐级 lstat 没有「更早快照」可比较，只能证明「此刻不是符号链接」，无法绑定到后续 syscall；(2) 全仓只有 1 个多段站点，(b) 让「Darwin `path()` 拒 `/`」可被机械断言，未来新增多段用法会被 `bad-name` 立即拦下；(3) Linux 侧 `lstatAt` 保持 `lstatSync(fdPath(...))` 原样，零行为变化。**不得**把「Linux 也跟随中间符号链接」当作 Darwin 放行的安全依据——该事实只说明 Linux 现状有同类弱点，不构成 Darwin 的论据（本期不改 Linux）。
- `locate(fd)`：同 `path()` 的核验序列（`hooks.beforeVerify("locate")`）后返回 `record.path`（即「核验过的当前位置」；与 Linux 的 readlink 语义同位，残余见 §3.P2-d）。
- **错误码映射**：沿用 `mapOpenError`；Darwin `openDirAt` **不再**把穿透失败误映射 `missing`——因 syscall 路径是真实路径，ENOENT 即真缺失；`platform` 仅在后端 `available()` 为假时抛。
- **与 Linux 的 reason 对齐表**（P2 测试逐条断言两后端一致）：符号链接末级 ⇒ `symlink`；祖先被换成符号链接（`openStoreRoot`）⇒ `moved`；owner/mode ⇒ `owner`/`mode`；FIFO/目录当文件 ⇒ `not-file`；文件当目录 ⇒ `not-dir`；dev/ino 变 ⇒ `moved`；超大 ⇒ `too-large`；读取中变化 ⇒ `io`。Darwin 更严之处（中间符号链接 ⇒ `symlink`，Linux `lstatAt` 仍跟随）在对齐表中单列为「有意差异」，不计入「两后端一致」断言。
- `defaultPathBackend()`：`process.platform === "darwin" ? darwinPathBackend : linuxPathBackend`。其他平台仍走 linux（`available()` 假 ⇒ `platform`，与今天一致）。
- 导出 `darwinPathBackend` / `createDarwinPathBackend`，供测试在 **Linux 上强制 darwin 后端**对真实 tmp 目录跑——仅作**算法辅助证据**，不等同于 Darwin 真机结论（见 §5.4）。

#### P2-b fd 注册表生命周期（评审 #7）

1. **关闭路径全量盘点（grep 实测，基线 = CLOSE_MANIFEST）**：登记只发生在 `openDirPath`、`openDirPathUnchecked`、`openDirAt`（及 `lstatAt` 的中间目录，同走 `openDirAt`，但**每次调用内即开即关即注销**，见 §3.P0-a「lstatAt 契约」）。目录 fd 的关闭**全部**经 `closeQuiet`（paths.ts:259-265，现 `closeSync` 在 263）；`src/schedule/core` 里其余 `closeSync(` 站点作用对象均为**非目录 fd**，永不登记：

   | 站点                                                          | 对象                                                      | 登记? |
   | ------------------------------------------------------------- | --------------------------------------------------------- | ----- |
   | lock.ts:90 `readLockHolder`                                   | 锁文件 fd                                                 | 否    |
   | lock.ts:141 `tryLock`（失败路径）、:179 `withDirLock`（释放） | 锁文件 fd                                                 | 否    |
   | paths.ts:263                                                  | `closeQuiet` 函数体本身（唯一删注册项处）                 | —     |
   | session-proof.ts:144,277,293                                  | pi 会话文件 fd                                            | 否    |
   | writer.ts:203 `atomicWriteAt`                                 | 临时文件 fd                                               | 否    |
   | reader.ts:441、writer.ts:870,897 `dir.closeSync()`            | `opendirSync(fdPath(..))` 产生的 `fs.Dir` 句柄（独立 fd） | 否    |

   测试代码（如 `recovery.test.ts` 同时 import `closeSync` 与 `openDirPath`）可能**直接 `closeSync` 已登记 fd**——这是唯一的残留来源，由第 2 点的回收策略兜底。`CLOSE_MANIFEST` 由 seam-contract 扫描比对：`src/schedule/core/**` 新增任何 `closeSync(` 站点而未登记 ⇒ 测试红（迫使作者声明其对象类别）。

2. **回收策略（I4 要求的 stated capacity/TTL）**：容量 **1024**；空闲 TTL **10 min**（`lastUsed` 在每次 `path/locate/lstatAt/confirm` 刷新）。清扫（sweep）触发：登记时 `size ≥ 256` 或距上次清扫 ≥ 60 s。清扫删除：(a) `fstatSync(fd)` 抛 EBADF 或 dev/ino 与记录不符的条目（可证明失效）；(b) 空闲超过 TTL 的条目（对仍打开但空闲的 fd，后果只是其后 `path()` 以 `io` fail closed，**绝不误路由**——合法目录 fd 的生命期 ≤ 一次事务：锁等待 ≤ `SCHED_LOCK_TIMEOUT_MS`(2 s) + 事务体，代码库中无跨 await 长期持有 `OpenedDir` 的路径）。清扫后仍满 ⇒ 拒绝登记并抛 `SchedFsError("io","fd registry full")`（fail closed，**不**逐出近期使用的条目）。
3. **fd 号复用兜底**：`path()/locate()/lstatAt()` 每次 `fstat` 比对 dev/ino；不符 ⇒ 删记录 + `moved`，不会按陈旧路径操作新 fd。
4. **`/reload` / 多模块实例**：注册表键带 `:v1` 后缀、记录纯数据（`backend` 以名字存储，不存对象/闭包），新旧模块实例互读安全；被 dispose 实例遗留条目由清扫回收。进程退出时 fd 与注册表同亡；注册表**不跨进程**，崩溃子进程不会留下跨进程状态。
5. **测试（`paths-backend.test.ts`，E-AUX）**：重复开关 ×10 000 后 `size` 回到基线；`confirm` 失败/`openDirAt` 抛错路径无残留；测试直接 `closeSync` 已登记 fd 后以文件复用同一 fd 号 ⇒ `path()` 抛 `moved` 且记录被删；容量 = 小值（注入 `capacity: 8`）时第 9 次登记 `io` 拒绝、已登记者仍可用；注入 `now` 推进 > TTL ⇒ 空闲条目被清扫、其 `path()` 抛 `io`；`vi.resetModules()` 后重新 import 模块，新实例可读/删旧实例登记的记录；**`lstatAt` 资源不变量**（§3.P0-a 契约第 5 条：各成功/失败路径前后 `size` 与 fd 数相等，4096 次循环不增长）。

#### P2-c `fdPath` 全点位清单与自动扫描基线（评审 #5）

**计数口径**（`FDPATH_MANIFEST` 的定义，测试里用同一正则实现，注释先剥离）：

- **调用表达式**：去注释后 `\bfdPath\(` 出现次数，**不含** `export function fdPath` 声明；一行可含多个表达式（如 `renameSync(fdPath(..), fdPath(..))` 为 2 个表达式 / 1 个调用点）。
- **调用点**：含 ≥1 个表达式的不同源码行。
- **内部原语**：`paths.ts` 内部使用者（`openDirAt`/`readFileAt`/`fdRealPath`），经后端分发，不属于「外部调用点」。
- **`lstatAt` 一并纳入口径（复审 R2-#1.1）**：`FDPATH_MANIFEST` 同时登记两类「路径派生」表达式——`fdPath(`（按上两条口径）与 `lstatAt(` 的**外部调用**（`paths.ts` 之外、去注释、不含 `function lstatAt` 声明、接口/对象方法定义行与自由函数体内的 `.lstatAt(` 转发，后三者归入 `paths.ts` 内部原语）。Linux 后端的实现体必须写成具名函数 `linuxLstatAt`（其内的 `lstatSync(fdPath(dirFd, rel))` 是 1 个 `fdPath` 表达式，外层函数名因此可被扫描器识别）。
- 另设独立扫描：`fdRealPath(` 调用表达式（不含声明）。

**扫描范围仅限 `src/schedule/**` 与 `src/web-hub/hub/schedule/**`**（`src/web-hub/hub/preview/pv-admit.ts`、`src/web-hub/hub/spawn/history/*` 里另有同名但无关的 `fdPath`，不属本期，不入清单）。

**HEAD 实测基线（本文档修订时 `grep -n "fdPath(" src/schedule/core/*.ts` 结果）**：`fdPath(` 共 **26 个调用表达式 / 24 个调用点**（另有 1 个声明 `paths.ts:67`）；`fdRealPath(` 5 个调用表达式（writer.ts:253,268；paths.ts:314,336,350；另有声明 :178）；`fdAnchoringAvailable(` 2 个内部调用（paths.ts:157,188；声明 :71；无外部调用方）；`SCHED_FD_ROOT` 仅 paths.ts 内部（:38,68,73）。**P0 之后**（`writer.ts:1106` 迁到 `lstatAt`，Linux 实现体 `linuxLstatAt` 落在 paths.ts）：`fdPath(` 仍为 **26 调用表达式 / 24 调用点**（writer.ts 少 1、paths.ts `linuxLstatAt` 多 1），另有 `lstatAt(` **1 个外部调用表达式**（writer.ts `writeReportLocked`）。路径派生表达式合计 26 + 1 = **27**。

**`FDPATH_MANIFEST`（P0 后期望，按「文件 + 外层函数」逐项；seam-contract 扫描后逐项比对，并断言「含 `fdPath(` 的文件集合」恰好是下表文件集合，新文件使用 `fdPath` 而未登记 ⇒ 红）**：

| 文件      | 外层函数            | 表达式数 | syscall / 角色                                                                                                           | Darwin 要点                                           |
| --------- | ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| lock.ts   | `readLockHolder`    | 1        | `openSync` 只读锁文件（诊断）                                                                                            | 单基名                                                |
| lock.ts   | `tryLock`           | 1        | 同一 `path` 供 `openSync` 与随后 `lstatSync` dev/ino 复核                                                                | 单基名；一次计算两处使用，中间无 await                |
| paths.ts  | `fdRealPath`        | 1        | 内部原语（Linux readlink；Darwin 改走 `locate`）                                                                         | —                                                     |
| paths.ts  | `openDirAt`         | 1        | 内部原语（open 子目录）                                                                                                  | `prepare/confirm`                                     |
| paths.ts  | `readFileAt`        | 1        | 内部原语（open 文件）                                                                                                    | `prepare/confirm`                                     |
| paths.ts  | `linuxLstatAt`      | 1        | 内部原语：Linux 后端 `lstatAt` 实现体 `lstatSync(fdPath(dirFd, rel))`（P0 新增，逐字等于被迁出的 writer.ts:1106 表达式） | Darwin 不经此处（走 `darwinLstatAt`，不含 `fdPath(`） |
| reader.ts | `listSessionDirs`   | 1        | `opendirSync(fdPath(rootFd))`                                                                                            | 目录本身                                              |
| writer.ts | `atomicWriteAt`     | 4        | tmp `openSync(O_EXCL)`、`renameSync`（2 个表达式）、失败路径 `unlinkSync`                                                | 全部单基名                                            |
| writer.ts | `ensureStoreRoot`   | 1        | `mkdirSync`                                                                                                              | 父 fd 已登记                                          |
| writer.ts | `createSess`        | 1        | `mkdirSync`（store 锁内）                                                                                                | root fd 来自 `openStoreRoot`                          |
| writer.ts | `repair`            | 2        | `renameSync(state.json → .bak)`                                                                                          |                                                       |
| writer.ts | `reportInventory`   | 2        | `opendirSync`、`lstatSync`（逐项）                                                                                       |                                                       |
| writer.ts | `sessionTemps`      | 2        | `opendirSync`、`lstatSync`                                                                                               |                                                       |
| writer.ts | `unlinkReports`     | 1        | `unlinkSync`                                                                                                             |                                                       |
| writer.ts | `gcSessionReports`  | 1        | `unlinkSync`                                                                                                             |                                                       |
| writer.ts | `writeReportLocked` | 1        | `mkdirSync(reports)`（原 1106 的 `lstat` 已迁 `lstatAt`）                                                                |                                                       |
| writer.ts | `recycleSessionDir` | 4        | `rmdirSync(reports)`、`unlinkSync`×2（循环 + lock）、`rmdirSync(rootFd/dirName)`                                         |                                                       |

合计 26 = lock 2 + paths 4 + reader 1 + writer 19 ✓（与 HEAD 的 26 相等：writer 1106 迁出、`linuxLstatAt` 迁入）。**`lstatAt(` 外部调用清单**（同样自动比对）：`writer.ts::writeReportLocked` ×1（报告名分配循环，≤ `INVENTORY_SCAN_MAX`=4096 次/事务，Darwin 每次即开即关）。`fdRealPath` 调用方基线：`writer.ensureStoreRoot` 2、`paths.resolveStoreRoot` 1、`paths.openStoreRoot` 1、`paths.openSessionDirAt` 1。

**直接 syscall 而不经 `fdPath` 的路径（同样入清单，`ABS_SYSCALL_MANIFEST`，防遗漏）**：`paths.ts::openDirPath` / `openDirPathUnchecked`（绝对规范路径 `openSync`，由后端 `prepare/confirm` 覆盖）、`paths.ts::resolveStoreRoot`（`realpathSync`）、`writer.ts::ensureStoreRoot`（`statSync`/`realpathSync` 祖先规范化，先判 vault 后创建，顺序不变）、`lock.ts::tryLock`（`lstatSync(path)`，path 取自 `fdPath`）。`session-proof.ts` 的 `openSync/closeSync` 针对 pi 会话文件的绝对路径，**不属于 schedule store**，登记为「域外」。fd 直操作（`fsyncSync(dirFd)`、`fstatSync(fd)`、`writeSync`、`closeSync`）Darwin 原生可用，不需要后端化，登记为「fd-native」。

**自动扫描断言（P0 写入 seam-contract，P2 回归）**：①`FDPATH_MANIFEST` 与实际逐 (文件,函数) 相等（外层函数用「向上回溯最近的 `function`/`async function` 声明」识别）；②`fdRealPath(` 调用清单与 `lstatAt(` 外部调用清单分别相等（路径派生表达式合计 27）；③`/proc/self/fd` 字面量仅出现在 `paths.ts`（扫 `src/schedule/**` 与 `src/web-hub/hub/schedule/**`）；④任何 Darwin 后端 `path(fd,name)` 对含 `/` 的 `name` 抛 `bad-name`（单元断言，证明清单里的 `fdPath` 点位都是单基名）。

#### P2-d 威胁模型与保证边界（评审 Blocker #2：已拍板接受「弱于 Linux」，此处只把保证说清、验收判据降为可验证）

**能提供的有限保证（G）**

- **G1**：校验时刻沿路径不跟随任何符号链接（祖先链逐级 `lstat`、每个被打开的组件 `O_NOFOLLOW`、中间目录经 `openDirAt`）。
- **G2**：在某次**校验点**（`path()` / `locate()` / `lstatAt()` 入口 / `confirm` 的 post-lstat）**之前已完成**的目录替换（换成别的目录、符号链接、文件，或删除后重建）会被 dev/ino（birthtime 可信时一并比对，规则见 P2-a「birthtime 兜底」）链比对检出 ⇒ 拒绝（`moved`/`symlink`/`missing`/`io`），且该 fd 的记录被删除，之后同 fd 的使用也一并拒绝——**检测到之后不再用旧记录返回内容**。
- **G3**：fd 号复用不会误路由（每次 `fstat` 复核）。
- **G4**：被打开对象的 owner / mode / 类型 / 大小策略与 Linux 逐对象相同。

**无法覆盖的替换窗口（U，单列写入 README 与 `darwin-report.md`；测试只「记录」不「保证」）**

- **U1**：校验点**之后、实际 pathname syscall 之前**的微秒级窗口（含 `path()` 返回后到 `openSync/renameSync/unlinkSync/mkdirSync/opendirSync` 执行之间）。此窗口内的祖先替换会让 syscall 落到新目录树：可能向攻击者选定的同 uid 目录写/改名/删除，或读到其文件内容。无法在 Node 层关闭。
- **U2**：替换后在窗口内恢复原状（A→B→A）：不可检测。
- **U3**：基于路径的 `opendir`/`readdir` 枚举同样受 U1 约束。
- **U4**：威胁模型前提——攻击者需与本进程**同 uid** 且能写入 store 的某个祖先目录；异 uid 受 owner/mode 检查阻断；这与 arch §9.4 已接受的残余一致。
- **U5**：inode 号复用（删除目录后立即新建）使 dev/ino 偶然相等；`birthtimeMs` **可信**时一并比对以降低概率，但不保证消除；`bt===null`（文件系统不提供 / 伪值 / 刚创建的目录 / 旋钮 off）的目录**仅靠 dev/ino**，此时 U5 无任何额外缓解——作为已知残余写入 README 与 report。
- **U6**：Darwin 无「fd 当前物理位置」内核视图（无 `/proc/self/fd`），`locate()` 返回的是「核验过的记录路径」，不是内核对该 fd 的实时回答（M3 能力差距，arch §9.4）。

**竞态测试判据（取代原「绝不读到被换目录内容」）**

- **D1 确定性（`hooks.beforeVerify` 内完成替换）**：替换在校验点前完成 ⇒ 操作**必须**以 `SchedFsError`（reason ∈ `moved|symlink|missing|io`）拒绝；断言未返回旧目录内容、记录已删除、对同一 fd 的第二次调用也拒绝。**须在 `birthtime:"auto"` 与 `birthtime:"off"` 两种配置下各跑一遍，判据完全相同**（真实替换会改变 inode，必被 dev/ino 检出，不依赖 birthtime；off 模式即「文件系统无 birthtime」情形的断言）。
- **D2 确定性（`hooks.afterVerify` 内完成替换，即 U1 窗口）**：测试名与注释显式标注「UNCOVERED WINDOW U1 (documented, not guaranteed)」；只断言：除普通 fs 错误外无异常、注册表一致（无泄漏）、**下一个校验点检出该替换并拒绝**（即「检测到后拒绝」，不对窗口内那一次 syscall 的结果作任何断言）。
- **D3 中间目录**：对 `lstatAt`/`writeReportLocked` 分配循环/`atomicWriteAt` 写入 reports：`reports` 在调用前被换成指向外部的符号链接 ⇒ `symlink` 拒绝，外部目录无任何新增文件；已登记的 `repFd` 在其后 `reports` 被 rename 走并以新目录替换 ⇒ 下一次 `path(repFd, …)` 抛 `moved`（Linux 后端对照用例标注「Linux 跟随语义不同，仅作行为记录」）；同样在 `auto`/`off` 两配置下各跑一遍，判据不变。
- **D5 birthtime 归一化与比较器（表驱动，两层，复审 R2-#1.3 + 第 3 轮口径统一）**：(a) **`birthOf` 表**（原始 stat → `bt`）：`birthtimeMs` 为 `0`/`NaN`/`-1`/`≥ctimeMs` ⇒ `null`；`0<birthtimeMs<ctimeMs` ⇒ number。(b) **`darwinSnapshotEqual` 表**（输入只喂 `number|null`）：dev 或 ino 不同 ⇒ 不等（与 bt 无关）；同 dev/ino 且 `bt` 均为相等 number ⇒ 等；均为不同 number ⇒ 不等；`snap.bt=null` 且 `cur.bt` 为 `null` 或 number ⇒ 等（仅比 dev/ino）；`snap.bt` 为 number 且 `cur.bt=null` ⇒ **不等**（「原可信现不可信」，其中现状可来自原始 stat 的 0/NaN/负值/≥ctime，已被 (a) 归一为 `null`）。inode 复用无法确定性构造，故 U5 仅以上述两层单测 + 文档残余表达，**不**写「无法发生」的断言。
- **D4 压力集成（`schedule-darwin-paths-race.test.ts`，tier2，信息性判据）**：N=2000 轮，替换进程交替把 `reports`/session 目录在「真实目录」与「指向外部的符号链接」之间切换，工作进程循环 `reportInventory + writeReportLocked + read`。**通过判据**：每轮结果 ∈ {成功, `SchedFsError(moved|symlink|missing|io)`, 事务 `E_DEGRADED`}；无未捕获异常、无挂起（单轮 >5 s 即失败）、结束后注册表 `size` 回基线、`fd` 数不增长。**不**断言「外部目录从未被触碰」——U1 允许其发生；脚本打印触碰计数作为残余证据写入 `darwin-report.md`（若 >0，如实记录，不判失败）。

#### P2-e `writer.ts::ensureStoreRoot`（226-275 行，P2 在 writer.ts 的唯一改动）

- 签名 `opts: { inVault?; uid?; backend?: PathBackend }`；`openDirPathUnchecked(canonical, opts.backend)`（该函数增可选第二参，P0 已加）；末尾 `resolveStoreRoot(storeDir, opts)`（把 `backend` 一并带入 `StoreRoot`）。
- 顺序保持「先判 vault、再创建」：`inVault(storeDir)` → 最长已存在祖先 `statSync` → `realpathSync` → `inVault(canonical)`/`inVault(canonical+rest)` → 打开祖先 → 逐级 mkdir（`fdPath(parent.fd, comp)` 现为后端分发，`comp` 经 `isPlainName` 校验）→ `openDirAt` → `fdRealPath` 复核 vault。

#### P2 测试

- `tests/schedule/core/paths-backend.test.ts`（tier1 + 登记 `TIER1_DECLARED`，因 FIFO 用例 `spawnSync("mkfifo")`，见 §5.3；**E-AUX**）：`describe.each` 两后端 `[linuxPathBackend(仅当 /proc/self/fd 可用), darwinPathBackend]`——darwin 后端在 Linux CI 上也跑：reason 对齐表（含「有意差异」单列）；vault 字面量 + canonical 两路；`dev/ino` pin；`openStoreRoot` 祖先被换成符号链接 ⇒ `moved`；`path()` 拒 `/`（`bad-name`）与 `lstatAt` 中间符号链接 ⇒ `symlink`、中间缺失 ⇒ `ENOENT`；D1/D2/D3 确定性竞态（`birthtime` auto/off 各一遍）+ D5 比较器（见 P2-d）；`lstatAt` 资源不变量（§3.P0-a 契约第 5 条）；P2-b 第 5 点的生命周期用例；写原语词静态断言（C7）；「全点位覆盖」：对 `darwinPathBackend` 根创建的 store 依次跑 `transact` / `writeReportLocked` / `gcSessionReports` / `repair` / `recycleSessionDir` / `listSessionDirs`，结果与 linux 后端同一场景一致。
- `tests/integration/schedule-darwin-paths-race.test.ts`（integration ⇒ tier2；D4；`mkfifo`/平台不可用时 skip；Linux 与 mac 均可跑，darwin 后端强制）。
- 现有 `reader.test.ts`、`writer.test.ts`、`fault-injection.test.ts`、`schedule-scan.test.ts`：P2 阶段在 Linux 上必须零改动全绿（Linux 默认 linux 后端）。

**P2 验收命令**：`npx vitest run tests/schedule/core/paths-backend.test.ts tests/schedule/core/seam-contract.test.ts tests/schedule/core/reader.test.ts tests/schedule/core/writer.test.ts tests/schedule/core/fault-injection.test.ts tests/web-hub/hub/schedule-scan.test.ts tests/web-hub/boundary.test.ts tests/governance/test-tiers.test.ts`；`git diff --stat origin/dev -- src/schedule/core/reader.ts`（应为空）。

---

### P3 — Lock adapter（Perl flock）

#### P3-a `lock.ts`

```ts
// 单一事实源：生产 acquire 与启动期 probe 共用同一个函数与同一份脚本/参数（评审 #8）
const PERL_FLOCK_SCRIPT =
  'open(my $fh, "+<&=3") or exit 2; flock($fh, LOCK_EX|LOCK_NB) and exit 0; exit(($!==EWOULDBLOCK || $!==EAGAIN) ? 75 : 3)';
const PERL_FLOCK_ARGS = ["-MFcntl=:flock", "-MErrno=EWOULDBLOCK,EAGAIN", "-e", PERL_FLOCK_SCRIPT] as const;
export function perlFlockAcquire(perlBin = "/usr/bin/perl", deps?: AcquireDeps): LockAcquire;
//   spawn(perlBin, PERL_FLOCK_ARGS, { stdio: ["ignore","ignore","ignore", fd], timeout: deps.timeoutMs ?? 5_000, env: { PATH: "/usr/bin:/bin" } })
export function defaultLockAcquire(o: { platform?: string; flockBin?: string; perlBin?: string }): LockAcquire;
//   platform==="darwin" ? perlFlockAcquire(o.perlBin) : linuxFlockAcquire(o.flockBin)
```

- **perl 常量与导出（已本机实测，macOS 27 / perl 5.34.1 / Node 26）**：`-MFcntl=:flock` 导出 `LOCK_EX/LOCK_NB/LOCK_SH/LOCK_UN`（`LOCK_EX|LOCK_NB` = 6）；**不再依赖 `%!` 常量键**（`$!{EWOULDBLOCK}`），改为显式 `-MErrno=EWOULDBLOCK,EAGAIN` 并对 `$!` 做数值比较（Darwin 两者同为 35，Linux 同为 11，均实测加载成功；busy 路径实测退出 75，持有者 `closeSync` 后再取为 0）。
- **结果映射（全部 fail closed，文案固定，英文 token）**：

  | spawn 结果                                                                                        | `AcquireResult`                                                                     |
  | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `r.error.code === "ENOENT"`                                                                       | `{kind:"fail", detail:"perl binary not found (fail closed)"}`                       |
  | `r.error.code === "ETIMEDOUT"`（`spawnSync` 超时：`status===null`、`signal==="SIGTERM"`，已实测） | `{kind:"fail", detail:\`perl flock timed out after ${timeoutMs}ms (fail closed)\`}` |
  | 其他 `r.error`                                                                                    | `{kind:"fail", detail:\`perl: ${String(err)}\`}`                                    |
  | `r.status === null && r.signal`（被信号杀，已实测 `kill -9` 为 `SIGKILL`）                        | `{kind:"fail", detail:\`perl flock killed by ${signal} (fail closed)\`}`            |
  | `r.status === 0`                                                                                  | `"held"`                                                                            |
  | `r.status === 75`                                                                                 | `"busy"`                                                                            |
  | 其余退出码（含 perl 自身加载失败的 255、脚本 2/3）                                                | `{kind:"fail", detail:\`perl flock exited ${status}\`}`                             |

  超时/信号一律 **fail 而非 busy**：持锁状态未知时不能乱判；`tryLock` 在 `fail` 路径关闭该 fd，若 perl 恰在被杀前取得了锁，随 fd 关闭释放（`keep=false`），不会遗留。Linux 的 `linuxFlockAcquire` 文案与分类**不改**（含其 `ETIMEDOUT` 现状走 `flock: ${err}`）。

- `withDirLock` 里 `opts.acquire ?? defaultLockAcquire({ platform: process.platform, flockBin: opts.flockBin })`。`tryLock` 在 `held` 之后**保留** `lstatSync(path)` dev/ino 复核（锁文件被替换 ⇒ `retry`/`gone`），Darwin 不绕过。
- 固定 `PATH` 环境仅对 perl 子进程（防 `PERL5OPT/PERL5LIB` 注入；同 uid 威胁边界内的纵深）；Linux `flock` 调用保持**不传 env**（字节不变）。
- B1/M6 不变式保持：无 stale 回收、无强拆、`repair()` 走同一把锁；锁文件内容仅诊断。

#### P3-b `wire.ts`（仅 `defaultFlockProbe`/`probeLock` 区域）

```ts
export function defaultFlockProbe(platform = process.platform, deps?: { acquire?: LockAcquire }): boolean;
// linux/其他：原样 spawnSync("flock", ["-V"], …)
// darwin：mkdtempSync(os.tmpdir()/.sched-lock-probe-) → openSync(file, O_RDWR|O_CREAT, 0o600) → (deps.acquire ?? perlFlockAcquire())(fd) === "held" → closeSync → rmSync(dir)；任何异常/非 held ⇒ false
```

- **probe 与 acquire 参数一致性**：probe 直接调用 `perlFlockAcquire()`（与生产 `defaultLockAcquire` 同一函数、同一 `PERL_FLOCK_ARGS`、同一 `env`、同一 stdio 槽位 3），不另写一份命令；测试 T-P8 以注入 `spawn` 捕获两条路径的 `file/args/options` 并 `toEqual`。
- `probeLock(opts)`：`(opts.flockProbe ?? (() => defaultFlockProbe()))()`；`createAgent` 里 `flockOk` 为 false 时 warn：Linux 文案**逐字保持** `util-linux \`flock\` not found: every schedule transaction fails closed (E_BUSY)`；darwin：`Perl/Fcntl flock 不可用，schedule 事务拒绝（E_BUSY）`。
- `ScheduleWireOpts.acquire` → `createScheduleAgent({ storeOpts: { acquire } })`（P0 已管线，P3 仅确认 `commands/schedule.ts::openForeign` 不传 acquire 即走默认）。
- 缺 perl ⇒ 每次事务 E_BUSY + `perl binary not found (fail closed)`；**不**回退无锁写。

#### P3 测试（perl 边界独立成条，评审 #8）

`tests/schedule/core/lock-acquire.test.ts`（tier1，**不** import `node:child_process`；全部经注入 `spawn`/`acquire`）：

- **T-P1 导出/常量**：断言 `PERL_FLOCK_ARGS` 含 `-MFcntl=:flock` 与 `-MErrno=EWOULDBLOCK,EAGAIN`、脚本不含 `%!`/`$!{`；
- **T-P2 缺二进制**：注入 `spawn` 返回 `{error:{code:"ENOENT"}}` ⇒ `fail "perl binary not found (fail closed)"`；
- **T-P3 超时**：`{error:{code:"ETIMEDOUT"}, status:null, signal:"SIGTERM"}` ⇒ `fail "…timed out after …ms (fail closed)"`，**不是** busy；
- **T-P4 信号**：`{status:null, signal:"SIGKILL"}` ⇒ `fail "…killed by SIGKILL (fail closed)"`；
- **T-P5 非冲突退出**：状态 2/3/255 ⇒ `fail "perl flock exited N"`；
- **T-P6 busy/held**：75 ⇒ busy；0 ⇒ held；
- **T-P7 锁文件被替换**：注入的 `acquire` 在返回 `held` 前把锁文件原子替换为新 inode ⇒ `tryLock` 得 `retry`，重试后成功；若每次都替换 ⇒ 超时 E_BUSY（不会误持锁）；
- **T-P8 probe 与 acquire 同参**：捕获 `defaultFlockProbe("darwin")` 与 `defaultLockAcquire({platform:"darwin"})` 两条路径下的 `spawn(file,args,options)`，除 `stdio[3]` 的 fd 编号外 `toEqual`；
- **T-P9 平台选择**：`defaultLockAcquire({platform:"darwin"|"linux"})` 分别走 perl / flock（捕获 argv 区分）；`defaultFlockProbe("darwin")` 在 `acquire` 注入 held/busy/fail 下返回 true/false/false。

`tests/integration/schedule-darwin-lock.test.ts`（integration ⇒ tier2；**真实 perl**，用 `which perl` 自门控而非平台门控 ⇒ Linux CI 也取得 perl 锁的 E-AUX 证据；darwin 专有断言另用 `skipIf(platform!=="darwin")`）：真实 `perl -MFcntl=:flock -MErrno=EWOULDBLOCK,EAGAIN` 可加载并导出常量（T-P1 的真实侧）；多进程互斥；持锁子进程 `SIGKILL` 后立即可取；父进程 `closeSync` 释放；`perlBin` 指向会 `exit 3` / 自杀 `kill -9 $$` / `sleep` 超时（`timeoutMs` 小值）的脚本 ⇒ 对应 fail 文案；`/nonexistent/perl` ⇒ E_BUSY + `perl binary not found`；无 stale reclaim（锁文件 mtime 老化也不被抢）；`repair()` 在活持锁下 ⇒ E_BUSY。

- 现有 `recovery.test.ts:206-211`（`flockBin` 不存在）在 mac 上经 `linuxFlockAcquire` 仍得到 `flock binary not found`——P3 须确认。

**P3 验收命令**：`npx vitest run tests/schedule/core/lock-acquire.test.ts tests/integration/schedule-darwin-lock.test.ts tests/schedule/core/seam-contract.test.ts tests/schedule/agent/wire.test.ts`。

---

### P4-A — hub service 注入（`src/web-hub/hub/schedule/service.ts`）

- `ScheduleServiceDeps`（约 115-130 行）新增：`identity?: IdentityDeps; paths?: { backend?: PathBackend }`（测试/宿主 seam；`import type` 自 recovery/paths，二者已在白名单；value import 仅 `createDarwinIdentity` from `../../protocol/sched-identity.js`，位于 `{protocol,hub}` 内合规）。
- 约 205-213 行：
  ```ts
  const identity =
    deps.identity ?? (process.platform === "darwin" ? createDarwinIdentity() : { readSelf: readSelfIdentity });
  root = resolveStoreRoot(deps.config.dir, deps.paths?.backend ? { backend: deps.paths.backend } : {});
  const self = identity.readSelf();
  ```
- 约 376、382 行：`judgeHolder(run.holder, self, identity.probe ? { probe: identity.probe } : {})`。
- `readReport`（1033 行）、scan 函数均经 `root`（携 backend）⇒ 零改动。`self === undefined` 仍 fail closed（返回 `[]`），日志不变。
- `assembly-schedule.ts`：零改动（默认平台解析）。
- Hub 仍只读：不 import writer/lock/claim（boundary 测试 `hub may import the read-only schedule core but never its writer half` 保持）。
- 测试（`schedule-service.test.ts` 的 29/832/906 行）：改为注入 `identity: { readSelf: () => fixtureSelf }`（`fixtureSelf` 来自 P4-B helper；P4-A 阶段可内联常量 `{pid:process.pid,start:1,host:hostname(),boot:"test-boot"}`）；新增 2 例（即 §3.P1-b 的 J6/J7 链）：darwin 域探针下 `predictUnknowns` 对死/活/同秒复用 holder 的判定；`self` 缺失 fail closed。

**P4-A 验收**：`npx vitest run tests/web-hub/hub/schedule-service.test.ts tests/web-hub/hub/schedule-scan.test.ts tests/web-hub/hub/schedule-f1.test.ts tests/web-hub/boundary.test.ts`。

### P4-B — 现有 suite 平台感知改造（见 §5）

新建 `tests/helpers/sched-platform.ts`（非 `*.test.ts`，不触发 tier 扫描）导出：

```ts
platformIdentity(): IdentityDeps          // linux: { readSelf: readSelfIdentity }；darwin: createDarwinIdentity()
fixtureSelf(): ProcessIdentity            // = platformIdentity().readSelf() ?? throw（替代 fixtures.ts 的 /proc 依赖）
platformProbe(): LivenessProbe            // linux: procLivenessProbe；darwin: createDarwinIdentity().probe
spawnLockHolder(lockPath, seconds=30): ChildProcess   // linux: spawn("flock",["-o","-x",path,"sleep",s])；darwin/无 flock: spawn("/usr/bin/perl",["-MFcntl=:flock","-e",'open F,"+<",$ARGV[0] or die; flock(F,LOCK_EX) or die; sleep $ARGV[1]',path,String(s)])
acquireOnFd(fd): AcquireResult            // = defaultLockAcquire({platform:process.platform})(fd)
```

### P5 — 真机验收与文档

见 §8（验收矩阵）；文档：`README.md` 增「macOS（Darwin）支持」小节（后端选择、perl 依赖、identity 编码域、TOCTOU 残余披露、本地运行命令、CI 未覆盖项）；`S1-report.md` §偏差 #9 / §7.6 追注「被 darwin-arch 取代 Linux-only 限制」；`acceptance.md` 增 mac 真机清单；新建 `darwin-report.md` 记录实测证据（命令输出摘录、版本：macOS/Node/perl）；`paths.ts` 头注释修正。**不改** `AGENTS.md`（README 是子系统事实源）。

---

## 4. seam 签名定稿汇总（供对照）

| seam          | 类型/函数                                                                                                                               | 落位                                                              | 导出方式                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity      | `StartDomain`、`startDomainOf`、`LivenessProbe.startDomain?`、`IdentityDeps`                                                            | `src/schedule/core/recovery.ts`（P0；纯类型/纯函数，无新 import） | 具名导出                                                                                                                                                                        |
| Identity 实现 | `createDarwinIdentity`、`parsePsLstart`、`parseBootSessionUuid`                                                                         | `src/web-hub/protocol/sched-identity.ts`（P1，新）                | 具名导出；agent `wire.ts` 与 hub `service.ts` 共用；结构类型兼容 `IdentityDeps`                                                                                                 |
| Paths         | `PathBackend`、`linuxPathBackend`、`darwinPathBackend`、`defaultPathBackend()`、`FsCheckOpts.backend?`、`StoreRoot.backend?`、`lstatAt` | `src/schedule/core/paths.ts`（P0 类型+linux，P2 darwin）          | 具名导出；fd 注册表在 `Symbol.for("pi-subagent:sched-fd-paths:v1")`（容量 1024 / 空闲 TTL 10 min / 清扫 + fail closed，见 §3.P2-b）；新增 `lstatAt(dirFd, rel)`（唯一多段入口） |
| Lock          | `AcquireResult`、`LockAcquire`、`linuxFlockAcquire`、`perlFlockAcquire`、`defaultLockAcquire`、`LockOpts.acquire?`                      | `src/schedule/core/lock.ts`（P0 类型+linux，P3 perl）             | 具名导出；`SessionStoreOpts.acquire?` 由 P0 透传                                                                                                                                |
| 装配          | `ScheduleWireOpts.{identity?,pathBackend?,acquire?}`、`ScheduleAgent.probe?`、`ScheduleServiceDeps.{identity?,paths?}`                  | `wire.ts`（P0/P1/P3）、`service.ts`（P4-A）                       | 全部可选 ⇒ 默认行为 = 平台自动解析；Linux 调用形态不变                                                                                                                          |

## 5. 测试计划

### 5.1 先实测基线（P4-B 第一步，**必须**）

**(1) 失败基线**

```bash
npm install                                   # worktree 当前无 node_modules
PI_TOOLKIT_TEST_WORKERS=2 npx vitest run tests/schedule tests/web-hub/hub/schedule-*.test.ts \
  tests/integration/schedule-*.test.ts tests/commands/schedule.test.ts tests/tools/schedule-tool.test.ts \
  tests/sysprompt/schedule-section.test.ts --reporter=json --outputFile=/tmp/sched-mac-baseline.json
```

把实际红清单回填到 `darwin-report.md`；§5.2 表为静态预测，红绿以实测为准。

**(2) 词法标记与登记比对（评审 #9：人工逐文件核对，治理测试只是附加门禁）**——对**将要修改的每个既有测试文件**，改造前后各跑一次同一脚本，输出「标记集合 / `TIER1_DECLARED` kind / 是否在 `TIER2_FILES` / 是否落在 `tests/integration|conformance/`」，把前后两张表与「新增 / 移除登记清单」写入 `darwin-report.md`：

```bash
FILES="tests/schedule/core/recovery.test.ts tests/schedule/core/writer.test.ts …(§5.2 全部将改文件)" \
node --import tsx -e '
  import("./tests/tiers.ts").then(async (t) => {
    const fs = await import("node:fs");
    for (const f of process.env.FILES.split(/\s+/).filter(Boolean)) {
      const hits = t.scanTier1Markers(fs.readFileSync(f, "utf8")).map((h) => h.marker + ":" + h.evidence);
      console.log(f, JSON.stringify(hits), t.TIER1_DECLARED[f]?.kind ?? "-", t.TIER2_FILES.includes(f) ? "TIER2_FILES" : "");
    }
  });'
```

规则：

- 改造后**新增**标记（如新引入 `node:child_process`）⇒ 必须在 `TIER1_DECLARED` 登记（kind `proc`）或迁到 tier2；改造后**移除**全部标记 ⇒ 手工删除遗留的 `TIER1_DECLARED` 项（`validateManifest` 只检查「重复 / 未登记 / 缺失文件 / 挂载标记」，**不会**提示陈旧登记，所以靠本核对而非治理测试发现）。
- **隐藏 spawn 规则**（词法门禁看不到的间接启动，D4a 残余）：凡调用 `tests/helpers/sched-platform.ts` 中会启动真实进程的导出（`spawnLockHolder`、`platformIdentity()` 的 darwin 实现、真实 `acquireOnFd`）的测试文件，一律按 `proc` 登记或放 `tests/integration/`，即使它自身词法上没有 `child_process`；tier1 里**默认**使用 `fixtureSelf()`（Linux：真实 `readSelfIdentity()`，行为同今；非 Linux：静态 epoch-ms 身份，**不启动子进程**）。实际 store 事务内的 `flock`/perl 子进程属既有「隐藏 spawn」先例（Linux 现状即如此），不因本期改变 tier 归属。
- 静态预测（待 (2) 实测确认）：`recovery.test.ts`、`writer.test.ts`、`fault-injection.test.ts`、`reader.test.ts`、`session-proof.test.ts`、`schedule-service.test.ts` 已登记 `proc`，改造后仍含 `spawn(…)`，登记保持；`wire.test.ts`、`stack-wiring.test.ts`、`clock.test.ts` 当前无标记，改造只引入 `fixtureSelf()`，不应出现新标记；`schedule-interval-lock.test.ts` 在 `integration/`，自动 tier2。
- 治理测试 `npx vitest run tests/governance/test-tiers.test.ts`（含 `vitest list` 交叉校验）是**附加**门禁，须在 (2) 人工核对之后再跑。

### 5.2 现有 suite 逐一处置

| #   | Suite                                                                                                                                                                                                                      | mac 失败根因（静态）                                                                                                                                      | 处置                                                                                                                                                                                                                                                           | 归属                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | `tests/schedule/core/fixtures.ts` + `fixtures/{crash-child,tx-child}.ts`                                                                                                                                                   | `self()`/`readSelfIdentity()!` 在 mac 抛 `needs /proc`；根因波及 claim/writer/reader/fault-injection/a3-helpers/session-proof 等几乎全部 core+agent suite | **fixture 注入化**：`self()` → `fixtureSelf()`（helper；Linux = 真实 `readSelfIdentity()`，非 Linux = 静态 epoch-ms 身份且**不启动子进程**）；children（独立进程，允许真实探测）用 `platformIdentity().readSelf()!`。Linux 路径等价                            | P4-B                    |
| 2   | `tests/schedule/core/recovery.test.ts`                                                                                                                                                                                     | `beforeAll` 用 `procLivenessProbe.startOf` + `/proc`（行 34-36）；kernel flock 描述块 `spawn("flock",…)`（行 143）                                        | `beforeAll` 改 `platformProbe()`；`spawn("flock")` → `spawnLockHolder()`；`flockBin:"/nonexistent/flock"` 例保持（经 linuxFlockAcquire 仍绿）；`judgeHolder` 矩阵保持 fake-probe；**拆分**：`/proc` 专有断言包 `describe.skipIf(process.platform !== "linux")` | P4-B                    |
| 3   | `tests/schedule/core/writer.test.ts`                                                                                                                                                                                       | 441、667 行外部 `spawn("flock",["-o","-x",…])` 持锁                                                                                                       | 改 `spawnLockHolder()`；其余通用事务测试无需改（走默认后端）                                                                                                                                                                                                   | P4-B                    |
| 4   | `tests/schedule/core/fault-injection.test.ts`                                                                                                                                                                              | 依赖 crash-child/tx-child（#1）与 SIGKILL 点                                                                                                              | 随 #1 修复；SIGKILL 点矩阵在 mac 实跑；若某点依赖 Linux fsync 语义 ⇒ 逐点 `skipIf` 并在 report 记录                                                                                                                                                            | P4-B                    |
| 5   | `tests/schedule/core/reader.test.ts`                                                                                                                                                                                       | 经 `env()`（#1）；路径安全 reason 断言；静态写原语正则                                                                                                    | #1 修复后在 mac 实跑；reason 差异按 P2 对齐表修**实现**，不改断言；静态正则不动                                                                                                                                                                                | P4-B（验证）/P2（实现） |
| 6   | `tests/schedule/agent/{wire,stack-wiring,clock}.test.ts`                                                                                                                                                                   | 用真实 `readSelfIdentity` 默认值 ⇒ mac `self` 缺失 ⇒ `E_UNSUPPORTED`；`clock.test.ts` 真实 store                                                          | 注入 `identity: platformIdentity()`（或固定 fixture）；另加 darwin wiring 冒烟（`skipIf` 非 darwin）：真实默认 resolver 下 `createAgent().self` 有值、`probe.startDomain==="epoch-ms"`                                                                         | P4-B                    |
| 7   | `tests/web-hub/hub/schedule-service.test.ts`                                                                                                                                                                               | 29/832/906 行 `readSelfIdentity()!`                                                                                                                       | 见 P4-A（identity 注入）                                                                                                                                                                                                                                       | P4-A                    |
| 8   | `tests/integration/schedule-interval-lock.test.ts`（21 行 `spawnSync("flock",["-x","-n","3"],{stdio:[…,fd]})`）+ `fixtures/schedule-matrix-child.ts`（`readSelfIdentity()!`）                                              | Linux flock 命令 / /proc                                                                                                                                  | 改 `acquireOnFd(fd)`；child 用 `platformIdentity()`；`schedule-fault-matrix` 的 9 个 SIGKILL 点在 mac 实跑                                                                                                                                                     | P4-B                    |
| 9   | `tests/integration/{schedule-hub,schedule-p2-producer,schedule-wiring,schedule-surface-wiring,schedule-secure-activate,schedule-tool-sdk}.test.ts`、`tests/commands/schedule.test.ts`、`tests/tools/schedule-tool.test.ts` | 经 wire/agent/fixtures 间接依赖                                                                                                                           | 以 5.1 实测为准；预期随 #1/#6 与 P1-P3 默认后端自愈；个别断言 `/proc` 文案则改平台中立（实现侧保持 Linux 文案不变）                                                                                                                                            | P4-B                    |
| 10  | `tests/conformance/schedule.test.ts`（C-S1…C-S8，真实 pi）                                                                                                                                                                 | 需真实 pi；mac 非 CI                                                                                                                                      | 保持自门控；P5 在 mac 真机尝试运行并记录（失败不阻塞，需注明环境）                                                                                                                                                                                             | P5                      |
| 11  | `tests/schedule/compat/v1-reader.ts`（历史快照，「do not modernize」）                                                                                                                                                     | 从 paths.ts 取 `fdPath/openDirAt/…`                                                                                                                       | 不改；因导出签名不变，随 paths 后端自动在 mac 生效                                                                                                                                                                                                             | 不动                    |

### 5.3 新增测试与 `tests/tiers.ts` 登记

| 文件                                                                                                | Tier              | `tests/tiers.ts` 动作                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/schedule/core/seam-contract.test.ts`（P0）                                                   | tier1             | 无（不含 child_process / socket / mount / ≥1 s 等待标记；实现时勿写 `node:child_process` 字面量，锁参数差分用注入 `spawn`）                                                                                            |
| `tests/schedule/compat/paths-v0.ts`、`tests/schedule/core/fdpath-manifest.ts`（P0，非 `*.test.ts`） | 不参与分层        | 无                                                                                                                                                                                                                     |
| `tests/web-hub/protocol/sched-identity.test.ts`（P1）                                               | tier1             | 无（host 注入；勿引用 `node:child_process` 字面量）                                                                                                                                                                    |
| `tests/schedule/core/identity-domain.test.ts`（P1）                                                 | tier1             | 无                                                                                                                                                                                                                     |
| `tests/schedule/core/lock-acquire.test.ts`（P3）                                                    | tier1             | 无（fake `spawn`/`acquire`；勿 import `node:child_process`）                                                                                                                                                           |
| `tests/schedule/core/paths-backend.test.ts`（P2）                                                   | tier1             | **`TIER1_DECLARED["tests/schedule/core/paths-backend.test.ts"] = { kind: "proc", why: "proc:node:child_process" }`**（FIFO 用 `spawnSync("mkfifo")`；与同目录 `reader.test.ts` 登记形态一致；**仅 P2 编辑 tiers.ts**） |
| `tests/integration/schedule-darwin-identity.test.ts`（P1）                                          | tier2（前缀自动） | 无                                                                                                                                                                                                                     |
| `tests/integration/schedule-darwin-lock.test.ts`（P3）                                              | tier2（前缀自动） | 无                                                                                                                                                                                                                     |
| `tests/integration/schedule-darwin-paths-race.test.ts`（P2）                                        | tier2（前缀自动） | 无                                                                                                                                                                                                                     |
| `tests/integration/schedule-darwin-e2e.test.ts`（P4-B）                                             | tier2（前缀自动） | 无                                                                                                                                                                                                                     |
| P4-B 修改的既有文件                                                                                 | 原 tier 不变      | 依 §5.1 (2) 的**人工前后比对清单**逐文件增删 `TIER1_DECLARED`；治理测试仅作附加校验                                                                                                                                    |

> Darwin 专属的真实进程/真实 `ps`/`sysctl` 测试**一律放 `tests/integration/`**，用 `describe.skipIf(process.platform !== "darwin")`（identity/e2e）或 perl 可用性自门控（lock/paths-race），因此 `tiers.ts` 只需 1 条新增登记；Linux CI 对 darwin 专有项显示 skipped，**不得**在报告中记作 Darwin 验证。

`tests/integration/schedule-darwin-e2e.test.ts`（P4-B，`skipIf` 非 darwin）：真实 `activate()`（fake pi）+ `schedule.enabled` + 临时 agentDir，走：`create`（cron/once/every）→ `run_now`（message 与 background 两种 executor）→ FakeClock 推进触发自动 claim → `list`/`history`/`get` → 启真实 hub 子进程（沿用 `schedule-hub.test.ts` 的 harness）→ 断言 hub 投影含该 session 任务、`pendingReports` 清理（receipt）与未知运行预测、hub 对账本零写入（目录 `mtime`/内容快照不变）；secure/locked 域仍无 tool（复用 `schedule-secure-activate` 断言）。

### 5.4 证据类别、本地 mac 验证命令与 CI 影响

**证据类别（评审 #10；报告与验收矩阵必须逐项标注，互不替代）**

- **E-CI**：Linux CI（或 Linux 机器）上的真实运行——证明「Linux 不变」。
- **E-MAC**：macOS 真机上的真实运行（真实 `ps`/`sysctl`/perl/`/dev/fd` 缺失环境）——**唯一**能证明「Darwin 可用」的证据。
- **E-AUX**：在 Linux 上强制 `darwinPathBackend` / 真实 perl 锁跑出的**算法辅助证据**，只说明算法在 Linux 文件系统语义下自洽，**不得**写成 Darwin 验证，也不得替代 E-MAC。

**Linux「字节不变」拆为 5 条可观察契约**（每条对应 §8 的取证项）：

| 契约                        | 内容                                                                                                                                                                                                                                                               | 取证                                                                               | 类别         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------ |
| C-L1 错误 reason / 异常路径 | 同场景下 `SchedFsError.reason`+message、原始 `ErrnoException` 透传（`lstatAt` ENOENT）、`fdRealPath`/`closeQuiet` 错误行为与冻结的 `tests/schedule/compat/paths-v0.ts` 一致；对外错误码（`E_BUSY/E_DEGRADED/E_LIMIT`、工具层 `E_*`）不变                           | `seam-contract.test.ts` 差分 + 现有 `reader/writer/ops/schedule-tool` 测试断言不改 | E-CI         |
| C-L2 超时 / 等待参数        | `SCHED_LOCK_RETRY_MS=25`、`SCHED_LOCK_TIMEOUT_MS=2000`、`SCHED_LOCK_SHUTDOWN_TIMEOUT_MS=500` 值；`flock` 子进程 argv/stdio/timeout(5000)/无 env 经注入 `spawn` 捕获后 `toEqual`                                                                                    | `seam-contract.test.ts`                                                            | E-CI         |
| C-L3 锁竞争与原子事务结果   | 既有 `writer.test` / `recovery.test`（kernel flock 块）/ `fault-injection` / `schedule-interval-lock` / `schedule-fault-matrix` 的**断言文本不改**（P4-B 只允许把 `spawn("flock",…)` 换成 `spawnLockHolder()`，其 Linux 分支 argv 与原命令逐字相同；审 diff 确认） | `git diff origin/dev -- tests/schedule/core/ tests/integration/` 人工审 + 全绿     | E-CI         |
| C-L4 冻结件                 | `tests/fixtures/` 字节不变；`activate-trace.json` 不变                                                                                                                                                                                                             | `git diff --quiet origin/dev -- tests/fixtures/`；`tests/governance`               | E-CI         |
| C-L5 wire / 账本 schema     | `Holder`、`sched_*` 帧、`HubConfig.schedule`、settings schema 零改动                                                                                                                                                                                               | `git diff --stat` 路径清单 + `schedule-confirm`/`webhub-wiring` 测试               | E-CI         |
| 开销预算                    | `fdPath` p50 ≤ +150 ns；`transact` 中位数 ≤ +2 %（信息性，不进 CI）                                                                                                                                                                                                | `PI_TOOLKIT_SCHED_BENCH=1` 运行并记录                                              | E-CI（人工） |

**本地 mac 命令**

```bash
npm install && npm run build            # TS7；P0 起每包都跑
npm run typecheck && npm run format:check
npm run test:tier1                      # mac 日常门；以 5.1 基线比对，不得新增红
npx vitest run tests/schedule tests/web-hub/hub/schedule-*.test.ts tests/web-hub/protocol/sched-identity.test.ts \
  tests/web-hub/boundary.test.ts tests/governance
npx vitest run tests/integration/schedule-*.test.ts   # tier2 的 schedule 部分（mac 真实 darwin 项在此运行）
```

- **没有 Linux 机器时**：Linux 零回归的证据由 CI（push 分支）提供；P0 首步确认 `.github/workflows/ci.yml` 的 `runs-on`（预期 ubuntu）。mac 本地无法证明 Linux 行为——**不得以 mac 绿代替 Linux 绿**，反之亦然。
- CI 影响：Linux 作业对 darwin 专有测试 skipped；新增 tier1 文件并入 `test:tier1` 总数（约 +5 个文件）；`paths-backend`（强制 darwin 后端跑 Linux fs）与 perl 锁测试在 Linux CI 实跑，仅提供 **E-AUX**。`tests/governance/bundle-parity.test.ts`（tier2，真实 tsx）会自动包含新 protocol 文件，须保持绿。
- 无新增 CI job；是否加 macOS runner 为后续决策（不在本期范围）。

## 6. 冻结面与门禁核对清单

| 项                                                                         | 结论                                                | 理由 / 核对命令                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/fixtures/` A 级冻结件                                               | **全部不变**                                        | 本期无任何 golden 重生。每包与合入前：`git diff --quiet origin/dev -- tests/fixtures/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `schedule-off-golden.json`（A）                                            | 不动                                                | off ⇒ `wireSchedule` 不被调用 ⇒ 无新 tool/command/prompt/status/`HubConfig.schedule`/cap/目录；新 protocol 文件只是被静态 import 的纯函数模块，激活期零副作用（无模块级执行、无 timer）；唯一残留仍是 `installScheduleOrphanGuard` 三钩子（本期不碰）。门禁：`npx vitest run tests/integration/schedule-off-golden.test.ts`                                                                                                                                                                                                                                                                                                                                |
| 其余 A 级（fabric/compact/reflex/secure/bash/quota/agent-nested-surface…） | 不动                                                | 无交集；批量 `git diff` 校验                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `governance/activate-trace.json`（B）                                      | **不应变化，不得 `PI_TOOLKIT_UPDATE_TRACE=1` 刷新** | 本期**没有新增/变更任何 `pi.registerTool/registerCommand/on(...)` 调用**（`wire.ts` 只增可选字段与函数内部逻辑；`turn_start` 钩子位置不变）。若 `npx vitest run tests/governance` 报 trace 漂移 ⇒ 说明误动了注册顺序，须回退而非刷新。仅当 P5 决定新增注册（本方案无）才声明式刷新                                                                                                                                                                                                                                                                                                                                                                         |
| `tests/web-hub/boundary.test.ts` 闭包                                      | **不放宽，仅新增一条收紧钉子**                      | `paths.ts` 仍仅 `node:crypto/fs/path`、`recovery.ts` 仍仅 `node:fs/os/./spec.js`（Darwin 后端只用已 import 的 fs 函数；子进程 probe 在 protocol 文件）；hub 新增的唯一跨文件 import 落在 `{protocol,hub}` 内。**结论（读 `boundary.test.ts:292-345` 核实）**：`hubImportAllowed` 对越界相对 import 不因 type-only 放行（仅 hub→`config/settings.ts` 例外），故 protocol 新文件不能 type-import `schedule/core`；`protocol/hub files are discovered` 只是 7 个代表项的 `arrayContaining`，新文件被 glob 纳入的是**通用规则**而非逐文件闭包——所以 P1 为 `sched-identity.ts` 新增的精确钉子（不过滤 `typeOnly`、零相对 import）是**必需的收紧**，不是可选项。 |
| I3 pre/post-guard                                                          | 不动                                                | 无新 `activate()` 注册；`sched-identity.ts` 为纯库                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| I4 无模块级可变状态                                                        | 合规                                                | 仅一处 `Symbol.for("pi-subagent:sched-fd-paths:v1")` 全局注册表（fd 号本质进程全局，不可模块私有）。**stated capacity/TTL**：容量 1024；空闲 TTL 10 min；回收＝`closeQuiet` 删项 + 登记时清扫（fstat 失效 / dev-ino 不符 / 空闲超 TTL）+ 清扫后仍满则 fail closed；记录为纯数据并带版本后缀，保证 `/reload` 新旧实例共享安全。须在 `paths.ts` 注释写明（I4 要求）；论证与测试见 §3.P2-b。                                                                                                                                                                                                                                                                  |
| I5 timers unref                                                            | 无新增 timer                                        | probe/lock 均为同步子进程，无定时器                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| I7 旧名                                                                    | 不动                                                | 不改 `pi-subagent:*`；新全局键沿用该前缀                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| I8 pi-free                                                                 | 合规                                                | 新文件无 pi import；`src/core                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | prompt-sections | git` 不涉及 |
| I9 off ⇒ byte-identical                                                    | 满足                                                | 见 off golden 行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| I10 append-only wire                                                       | 满足                                                | `Holder`/`sched_*` 帧/`HubConfig.schedule`/settings schema 零改动；`start` 数值域差异仅在 identity seam 内消化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| I11 secure D8                                                              | 不动                                                | `applySecureDomainOverrides` 不碰；Darwin 后端不绕过（`secure-activate` 集成测试保持）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| I1 zero-hang                                                               | 保持                                                | 锁仍有界轮询（25 ms/2 s 默认）；perl/ps/sysctl 均有 timeout（5 s/2 s）；无新长延迟                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Prettier / Conventional Commits                                            | 每包遵守                                            | `npm run format`；提交示例 `feat(schedule): darwin identity probe (P1)`、`refactor(schedule): seam contracts (P0)`；CHANGELOG 不手改                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `reader.ts`                                                                | 零 diff                                             | `git diff --stat origin/dev -- src/schedule/core/reader.ts` 为空                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

门禁命令总表：`npm run format:check` → `npm run typecheck` → `npm run test:tier1` → `npm run test:tier2`（schedule 相关）→ `npm run build`；提交前 `git diff --quiet origin/dev -- tests/fixtures/`。

## 7. 风险与回滚

| ID  | 包    | 主要风险                                                                                                             | 缓解                                                                                                                                                                                                                       | 回滚                                                                                                                                                          |
| --- | ----- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | P0    | 重构 `fdPath` 经后端分发误改 Linux 输出/错误/开销                                                                    | 差分测试对冻结 `paths-v0.ts`（输出 + reason + 异常路径，见 §5.4 C-L1）；开销有预算（`fdPath` ≤ +150 ns、`transact` ≤ +2 %，度量记录入 report）；注册表惰性创建，Linux 生产路径不分配                                       | `git revert` P0 提交；P0 之后 P1-P3 对 P0 有编译依赖，回滚 P0 须连带回滚其后各包                                                                              |
| R2  | P1    | `ps lstart` 格式差异（locale/TZ/个位日空格）、同秒复用                                                               | 固定 `LC_ALL=C TZ=UTC0`；严格解析+回读校验；格式异常 ⇒ `"error"` ⇒ unprovable（只可能延迟恢复）；子进程启动有预算与触发条件（§3.P1-b）                                                                                     | revert P1：mac 回到「无 identity ⇒ 不执行」，Linux 无影响                                                                                                     |
| R3  | P1    | hub boundary：protocol 新文件引入 `child_process`                                                                    | 精确钉子覆盖 type-only 且零相对 import；已读 `hubImportAllowed` 确认 `node:*` 允许                                                                                                                                         | 同 R2                                                                                                                                                         |
| R3b | P1    | probe 漏传到某条 `judgeHolder` 链 ⇒ mac 上判不出 pid 复用                                                            | `JUDGE_MANIFEST` 扫描 + 每条链专属测试（含 clock 的「漏传 probe」负向用例）                                                                                                                                                | 同 R2                                                                                                                                                         |
| R4  | P2    | Darwin 快照算法漏洞：reason 不对齐、`fdPath`/`lstatAt` 抛错出现在未设防调用点；**窗口 U1-U6 无法覆盖**（见 §3.P2-d） | 对齐表双后端参数化；`path()` 拒 `/`；多段只走 `lstatAt`；D1/D3 确定性用例证明「校验点前的替换必被拒」，D2/D4 只记录窗口、不作超出算法的保证；逐点核对 `FDPATH_MANIFEST` 的 26 个 `fdPath` 表达式 + 1 个 `lstatAt` 外部调用 | revert P2：`defaultPathBackend()` 回到 linux ⇒ mac 回到 fail closed `platform`；Linux 无影响（唯一 writer 改动是 `ensureStoreRoot` 的可选参数）               |
| R5  | P2    | fd 注册表残留/误路由/`/reload` 共享                                                                                  | 关闭路径盘点（`CLOSE_MANIFEST`）+ 容量 1024 + 空闲 TTL 10 min + 清扫 + fstat 复核 + `:v1` 数据化记录（§3.P2-b）；5 项生命周期测试                                                                                          | 同 R4                                                                                                                                                         |
| R6  | P2    | Darwin `path()` 每次 lstat 整条链 ⇒ 事务变慢                                                                         | 仅 mac；schedule 操作低频；P5 实测记录 p50/p95（若 >50 ms/事务再议缓存，不属本期）                                                                                                                                         | 同 R4                                                                                                                                                         |
| R7  | P3    | perl 缺失/被 CLT 提示/沙箱禁用；`/usr/bin/perl` 在未来 macOS 移除                                                    | fail closed + 明确 warning；`perlBin` 可注入；不回退无锁；ENOENT/超时/信号/非冲突退出均独立文案与测试（T-P2…T-P5）                                                                                                         | revert P3：mac `flock` 缺失 ⇒ E_BUSY（与今天同）；Linux 无影响                                                                                                |
| R8  | P3    | perl 对 fd 3 的 `+<&=3` 或 Errno 导出随版本变化                                                                      | 本机 perl 5.34.1 实测；启动 probe 与生产同一函数；集成测试真实 perl 覆盖导出/互斥/SIGKILL                                                                                                                                  | 同 R7                                                                                                                                                         |
| R9  | P2/P3 | macOS `fsync(2)` 不保证落盘到介质（`F_FULLFSYNC`），与 Linux 持久性差异                                              | 沿用现有 `fsyncSync`（目录 fsync 的 `EINVAL/ENOTSUP` 已容忍）；README 披露为已接受残余（§8.1 核对清单）                                                                                                                    | 无需回滚（披露项）                                                                                                                                            |
| R10 | P4-A  | hub 默认 resolver 在 mac 启动期调用 `ps`/`sysctl`                                                                    | 仅 `createScheduleService` 构造时一次 `readSelf()`（2 次启动）                                                                                                                                                             | revert P4-A                                                                                                                                                   |
| R11 | P4-B  | 改动面大，引入 Linux 测试回归；tier 登记偏差                                                                         | 所有改造保持 Linux 路径等价（helper 的 Linux 分支 argv 与原命令逐字相同）；§5.1(2) **人工逐文件标记前后比对**先于治理测试；隐藏 spawn 规则                                                                                 | 逐文件 revert（每个 suite 一个提交）                                                                                                                          |
| R12 | 整体  | 无法在本机验证 Linux                                                                                                 | 以 CI 为证据（E-CI）；P0 合入后立即 push 观察                                                                                                                                                                              | 分支按包提交，**逐包 `git revert` 可行**：P4-B → P4-A → P3 → P2 → P1 → P0 倒序；P1/P2/P3 互相无源码依赖（仅共同依赖 P0），可单独 revert 任一；P0 只能最后回退 |

## 8. 验收矩阵草案（verifier 用）

> 取证原则：每项给出可复制命令、期望与**证据类别**（E-CI / E-MAC / E-AUX，定义见 §5.4）。mac 项在真机跑，Linux 项看 CI（或 Linux 机器）。「期望」是通过判据；未执行写 NOT RUN，不得推断。**E-AUX 不得用来签收「Darwin 可用」，E-MAC 不得用来签收「Linux 不变」。**

### 8.0 Linux 不变（拆为 §5.4 的 5 条可观察契约）

| ID  | 契约                   | 取证命令                                                                                                                                                                                                                                                                                                  | 通过判据                                                                           | 类别         |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------ |
| L1  | C-L1 reason / 异常路径 | Linux：`npx vitest run tests/schedule/core/seam-contract.test.ts tests/schedule/core/reader.test.ts tests/schedule/core/writer.test.ts tests/schedule/agent/ops.test.ts tests/tools/schedule-tool.test.ts`                                                                                                | 全绿；差分用例对 `paths-v0` 的 reason/message/ErrnoException 全相等                | E-CI         |
| L2  | C-L2 超时/等待参数     | 同上 + `grep -n "SCHED_LOCK_\(RETRY\|TIMEOUT\|SHUTDOWN_TIMEOUT\)" src/schedule/core/lock.ts`                                                                                                                                                                                                              | 值 25 / 2000 / 500；flock argv/stdio/timeout 捕获断言绿；无 env 键                 | E-CI         |
| L3  | C-L3 竞争与原子事务    | Linux：`npx vitest run tests/schedule/core/{writer,recovery,fault-injection}.test.ts tests/integration/schedule-interval-lock.test.ts tests/integration/schedule-fault-matrix.test.ts`；`git diff origin/dev -- tests/schedule/core tests/integration \| grep '^[-+]' \| grep -E 'expect\|toBe\|toEqual'` | 全绿；上述 diff 中**无**被删除/放宽的 `expect` 行（只允许 helper 替换 spawn 命令） | E-CI         |
| L4  | C-L4 冻结件            | `git diff --quiet origin/dev -- tests/fixtures/ && echo OK`；`npx vitest run tests/governance tests/integration/schedule-off-golden.test.ts`                                                                                                                                                              | 输出 `OK`；`activate-trace.json` 无 diff；off golden 绿                            | E-CI         |
| L5  | C-L5 wire/schema       | `git diff --stat origin/dev -- src/web-hub/protocol/schedule.ts src/web-hub/agent/ src/schedule/core/reader.ts src/schedule/core/spec.ts`；`npx vitest run tests/web-hub/protocol/schedule-confirm.test.ts tests/schedule/agent/webhub-wiring.test.ts`                                                    | 前三者无 diff；`spec.ts` 仅 `start` 注释行；测试绿                                 | E-CI         |
| L6  | 全量门禁               | CI：`npm run format:check && npm run typecheck && npm run test:tier1 && npm run test:tier2 && npm run build`                                                                                                                                                                                              | 全绿                                                                               | E-CI         |
| L7  | 开销预算               | Linux：`PI_TOOLKIT_SCHED_BENCH=1 npx vitest run tests/schedule/core/seam-contract.test.ts`                                                                                                                                                                                                                | 输出的 `fdPath` p50 增量 ≤ 150 ns、`transact` 中位数增量 ≤ 2 %，记入 report        | E-CI（人工） |

### 8.1 Darwin 可用与边界

| ID  | 验收项（arch §10）              | 取证命令                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 通过判据                                                                                                                                                                                                                               | 类别                                                                                      |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| M1  | mac identity 真实可用           | mac：`npx vitest run tests/integration/schedule-darwin-identity.test.ts`；手验 `node --import tsx -e 'import("./src/web-hub/protocol/sched-identity.ts").then(m=>console.log(m.createDarwinIdentity().readSelf()))'`                                                                                                                                                                                                                                                                                                   | 通过且非 skipped；`start≈1e12` 量级、`boot` 为 UUID                                                                                                                                                                                    | E-MAC                                                                                     |
| M2  | ps/sysctl 解析严格              | `npx vitest run tests/web-hub/protocol/sched-identity.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 绿；非法/本地化输入 ⇒ undefined                                                                                                                                                                                                        | E-CI + E-MAC                                                                              |
| M3  | 同秒复用不误杀、域判定          | `npx vitest run tests/schedule/core/identity-domain.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 同域同值 ⇒ alive；跨域 ⇒ unprovable；`unknownRunKeys` 带 probe 用例绿                                                                                                                                                                  | E-CI + E-MAC                                                                              |
| M3b | judge 全链路                    | `npx vitest run tests/schedule/agent/{note,digest,clock}.test.ts tests/web-hub/hub/schedule-service.test.ts` 与 `JUDGE_MANIFEST` 扫描（在 seam-contract）                                                                                                                                                                                                                                                                                                                                                              | 7 个 `judgeHolder` 站点 + `recoverDeadRuns`/`recoverRuns`/`unknownRunKeys` 全部有 probe 到达证据；漏传 probe 的负向用例确实红→绿；`grep -rn "judgeHolder(\|recoverDeadRuns(\|recoverRuns(\|unknownRunKeys(" src` 与 manifest 一致      | E-CI + E-MAC                                                                              |
| M3c | 子进程预算                      | `npx vitest run tests/web-hub/protocol/sched-identity.test.ts`（计数器用例）+ P5 mac e2e 日志                                                                                                                                                                                                                                                                                                                                                                                                                          | `readSelf`=2 次启动；自身 holder 判定=0；ESRCH=0；单轮 ≤ 8 次且 ≤ 250 ms（超出须在 report 记录并触发缓存议题）                                                                                                                         | E-CI + E-MAC                                                                              |
| M4  | Perl flock 边界                 | mac：`npx vitest run tests/integration/schedule-darwin-lock.test.ts`；Linux/CI：同命令（perl 可用时）；另手验 `node` 一行脚本（两 OFD ⇒ 0/75，关 fd 后 0）                                                                                                                                                                                                                                                                                                                                                             | T-P1…T-P9 全绿；缺二进制/超时/信号/非冲突退出各有独立固定文案；锁文件被替换仅 retry；`repair()` 对活持锁 ⇒ E_BUSY；无 stale 回收                                                                                                       | E-MAC（签收）；E-AUX（Linux 同命令）                                                      |
| M4b | probe 与 acquire 同参           | `npx vitest run tests/schedule/core/lock-acquire.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                              | T-P8 `toEqual` 通过                                                                                                                                                                                                                    | E-CI                                                                                      |
| M5  | Darwin 路径算法                 | Linux/CI 或 mac：`npx vitest run tests/schedule/core/paths-backend.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                            | reason 对齐表绿（「有意差异」单列且断言 Darwin 更严）；`path()` 拒 `/`；`lstatAt` 中间符号链接 ⇒ `symlink`；D1（校验点前替换 ⇒ 必拒、记录已删、二次调用也拒）、D3（中间目录换符号链接 ⇒ 拒，外部目录零新增）通过；D2 用例存在且标注 U1 | **E-AUX**（Linux 上强制）；同命令在 **mac 真机**运行 ⇒ E-MAC，方可签收「Darwin 路径可用」 |
| M5b | 路径竞态压力（信息性）          | `npx vitest run tests/integration/schedule-darwin-paths-race.test.ts`（mac 与 Linux 各一份结果）                                                                                                                                                                                                                                                                                                                                                                                                                       | 判据仅为：每轮结果 ∈ {成功, `moved                                                                                                                                                                                                     | symlink                                                                                   | missing | io`拒绝,`E_DEGRADED`}；无未捕获异常/挂起；`size` 与 fd 数回基线；**不**断言「外部目录从未被触碰」；报告记录触碰计数与 U1-U6 | E-MAC（主）；E-AUX |
| M6  | `fdPath` 点位与关闭路径自动核对 | `npx vitest run tests/schedule/core/seam-contract.test.ts`；人工对照命令：`grep -n "fdPath(" src/schedule/core/*.ts \| wc -l`（仅 `src/schedule/core/`：`grep -n` 行数含声明 **P0 前 25 / P0 后 25**；`grep -o` 表达式数含声明 **27 / 27**，即调用表达式 26 / 26 + 1 声明（writer.ts:1106 迁出、paths.ts `linuxLstatAt` 迁入）；另 `grep -rn "lstatAt(" src/schedule/core` 的外部调用 0 / 1；口径见 §3.P2-c）、`grep -n "fdRealPath(\|lstatAt(" src/schedule/core/*.ts`、`grep -n "closeSync(" src/schedule/core/*.ts` | 测试读 `FDPATH_MANIFEST`/`CLOSE_MANIFEST`/`ABS_SYSCALL_MANIFEST` 并全等；`/proc/self/fd` 字面量仅 `paths.ts`；Darwin `path()` 含 `/` ⇒ `bad-name`                                                                                      | E-CI                                                                                      |
| M6b | fd 注册表生命周期               | `npx vitest run tests/schedule/core/paths-backend.test.ts -t "registry"`                                                                                                                                                                                                                                                                                                                                                                                                                                               | 10 000 次开关后 `size` 回基线；直接 `closeSync`+fd 复用 ⇒ `moved`；容量上限 `io` 拒绝且既有 fd 可用；TTL 清扫；`vi.resetModules` 后互读                                                                                                | E-AUX → mac 复跑为 E-MAC                                                                  |
| M7  | mac agent 全链路                | mac：`npx vitest run tests/integration/schedule-darwin-e2e.test.ts tests/integration/schedule-wiring.test.ts tests/integration/schedule-p2-producer.test.ts tests/integration/schedule-surface-wiring.test.ts`                                                                                                                                                                                                                                                                                                         | create/run_now/时钟触发/list/history 全绿；非 skipped                                                                                                                                                                                  | E-MAC                                                                                     |
| M8  | mac hub 只读投影                | mac：`npx vitest run tests/integration/schedule-hub.test.ts tests/web-hub/hub/schedule-service.test.ts` + e2e 中 hub 段                                                                                                                                                                                                                                                                                                                                                                                                | hub pin root、投影含任务、未知运行预测、receipt 清理通过；hub 前后账本目录快照一致（零写）                                                                                                                                             | E-MAC                                                                                     |
| M9  | secure/locked 仍拒绝            | `npx vitest run tests/integration/schedule-secure-activate.test.ts tests/secure/guard-points.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                  | 绿（mac 与 Linux 各一份）                                                                                                                                                                                                              | E-CI + E-MAC                                                                              |
| M10 | mac 无 `/proc` 意外失败         | mac：`npm run test:tier1`，与 §5.1 基线 JSON 对比                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | schedule 相关 0 失败；全套失败集合 ⊆ 本期前已有的非 schedule 红（须逐项列出并说明）                                                                                                                                                    | E-MAC                                                                                     |
| M11 | tiers 登记完备                  | 先人工：§5.1(2) 的前后比对表已提交到 `darwin-report.md`；再 `npx vitest run tests/governance/test-tiers.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                       | 比对表中每个「新增/移除」均有对应 `tiers.ts` 变更（含陈旧项手工删除）；治理测试绿；darwin 真实进程测试均位于 `tests/integration/`                                                                                                      | E-CI                                                                                      |
| M12 | 其他 Linux-only 门未被误动      | `git diff --stat origin/dev -- src/web-hub/hub/spawn src/web-hub/hub/preview src/sysload`                                                                                                                                                                                                                                                                                                                                                                                                                              | 无 diff                                                                                                                                                                                                                                | E-CI                                                                                      |
| M13 | boundary 钉子                   | `npx vitest run tests/web-hub/boundary.test.ts`；`git diff origin/dev -- src/schedule/core/paths.ts src/schedule/core/recovery.ts \| grep '^[+-]import'`                                                                                                                                                                                                                                                                                                                                                               | 绿；两文件 diff 中无 import 行变化；新钉子对 `sched-identity.ts` 断言 import 恰为 `node:child_process`+`node:os` 且无相对 import（含 type-only）                                                                                       | E-CI                                                                                      |
| M14 | 类型/格式/构建                  | `npm run typecheck && npm run format:check && npm run build`                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 全绿（mac 与 CI）                                                                                                                                                                                                                      | E-CI + E-MAC                                                                              |
| M15 | wire.ts 冲突域审计              | `git log --stat --oneline origin/dev..HEAD -- src/schedule/agent/wire.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                              | 提交仅属 P0/P1/P3，hunk 不越界（人工抽查）                                                                                                                                                                                             | —                                                                                         |

### 8.2 M16 — 残余披露人工核对清单（取代原「grep 关键词」；评审 #12）

verifier 阅读 `docs/dev/scheduled-reports/README.md` 的「macOS（Darwin）支持」小节与 `darwin-report.md`，**逐项**核对下列每一格是否有实质内容（不是仅出现关键词）；缺任一格 ⇒ 验收不通过。

| 残余                     | 风险内容                                             | 适用平台                                               | 影响                                                                    | 不可保证事项                                                         | 运行时依赖 / 前提                                           |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| R-a 路径 TOCTOU（U1-U6） | 校验点与 syscall 之间祖先被替换                      | 仅 macOS（Linux 用 fd 锚定无此窗口）                   | 同 uid 攻击者可令写/改名/删除/读落到其选定目录；M3 位置证明弱于内核视图 | 不保证窗口内不被替换；不保证 A→B→A 可检出；不保证 inode 复用下零误等 | 同 uid 威胁边界；目录 owner/mode 检查仍生效                 |
| R-b `ps lstart` 秒精度   | 同一 boot 内同一秒 pid 复用被当作同一进程            | 仅 macOS                                               | dead run 的恢复延迟或 E_BUSY（可用性），**不会**误杀存活 run            | 不保证亚秒区分；不保证旧 holder 在碰撞时被及时回收                   | `/bin/ps`、`/usr/sbin/sysctl` 可用；固定 `LC_ALL=C TZ=UTC0` |
| R-c 跨平台 `start` 域    | Linux ticks 与 Darwin epoch-ms 混读 ⇒ unprovable     | 共享 store 的混合环境（同 host+boot 实际几乎不会出现） | 旧 holder 可能持续占用恢复状态，直至其终止                              | 不保证跨域自动恢复；域阈值 1e11 为假设                               | 无新增字段（I10）                                           |
| R-d 缺 perl / perl 行为  | 缺失、超时、被信号杀、非冲突退出 ⇒ 锁 fail closed    | 仅 macOS                                               | schedule 事务 E_BUSY + warning（不执行、不无锁写）                      | 不保证在无 `/usr/bin/perl` 的系统可用；不回退                        | `/usr/bin/perl` + `Fcntl`/`Errno` 模块                      |
| R-e `fsync` 语义         | macOS `fsync(2)` 不强制写穿磁盘缓存（`F_FULLFSYNC`） | 仅 macOS                                               | 掉电场景下提交可能比 Linux 更易丢                                       | 不保证掉电持久性等同 Linux                                           | 沿用现有 `fsyncSync`，不引入原生调用                        |
| R-f 子进程开销           | `ps`/`sysctl`/perl 同步子进程                        | 仅 macOS                                               | 启动与每次锁获取多几十毫秒                                              | 不保证延迟等同 Linux                                                 | 预算与触发缓存议题的阈值见 §3.P1-b                          |
| R-g 范围外               | secure 域仍强制关闭；其他 Linux-only 门未改          | 全平台                                                 | —                                                                       | 不保证 hub spawn/preview/load 在 mac 可用                            | D8                                                          |

## 9. 派发顺序建议

1. **P0** 单包串行，合入并推送观察 CI（Linux 零回归证据）。
2. **P1 / P2 / P3** 同消息并行派发（文件域已隔离；wire.ts 由 P1/P3 各改不同函数，tiers.ts 仅 P2 写）。
3. **P4-A**（P1 合入后）与 **P4-B** 基线实测可立即开始；P4-B 改造待 P1-P3 全部合入。
4. **P5** 真机全量验收 + 文档回写 → verifier 按 §8 取证。
5. 每包提交遵守 Conventional Commits；不 release、不手改 CHANGELOG；不重生任何 golden。

---

## 10. 修订记录

### 第 1 轮（评审打回后修订，2026-11-17）

| 评审编号 | 严重度  | 处置                   | 落点小节                                                                                                                            | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------- | ------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #1       | Blocker | **采纳（选择方案 b）** | §3.P0-a（`PathBackend.path/lstatAt` 签名）、§3.P0-d（`writer.ts:1106` 迁 `lstatAt`）、§3.P2-a、§3.P2-c、§3.P2-d D3、§8 M5/M6、§1 C2 | Darwin `path()` **只接受目录本身或单个基名**（含 `/`/`.`/`..` ⇒ `bad-name`）；全仓唯一多段站点 `writer.ts:1106` 迁到 `lstatAt(dirFd, rel)`，Darwin 实现为「逐级 `openDirAt` 打开并登记中间目录（O_NOFOLLOW、类型/owner/mode、dev/ino+birthtime 快照链），只对末段基名 syscall」。选 (b) 不选 (a) 的理由写在 P2-a：中间目录获得与 `openDirAt` 一致的快照链并受后续逐次重核，(a) 无更早快照可比；`path()` 拒 `/` 可机械断言；Linux 实现保持原表达式字节不变。已删除「与 Linux 一样跟随中间链接」作为放行依据的措辞，并明确它不是 Darwin 的安全论据。补测：中间目录被换成指向外部的符号链接、中间目录被替换、`path()` 拒 `/`、`lstatAt` 中间缺失 ⇒ ENOENT。                                         |
| #2       | Blocker | **采纳**               | §3.P2-d（保证 G1-G4 / 窗口 U1-U6 / 判据 D1-D4）、§7 R4、§8 M5/M5b、§8.2 R-a                                                         | 不推翻已拍板的「弱于 Linux」降级。威胁模型与有限保证单列：「校验点之前已完成的替换必被检出并拒绝，且记录删除、之后不再用旧记录返回内容」；窗口 U1（校验后 syscall 前）、U2（A→B→A）、U3、U4（同 uid 前提）、U5（inode 复用，加 birthtime 缓解）、U6（无内核 fd 位置视图）单列并写入 README/report。竞态验收改为：D1 确定性（`beforeVerify` 内替换 ⇒ 必拒）、D2 确定性（`afterVerify` 内替换＝U1，测试名标注 UNCOVERED，仅断言下一校验点检出）、D3 中间目录、D4 压力（结果 ∈ {成功, moved/symlink/missing/io, E_DEGRADED}、无挂起/泄漏，**不**断言「外部目录从未被触碰」，触碰计数作为残余证据记录）。                                                                                            |
| #3       | Major   | **采纳**               | §1 C1/C8、§3.P1 测试（boundary 钉子）、§6 boundary 行                                                                               | 写明结论：`hubImportAllowed`（boundary.test.ts:292-307）对越界相对 import 不因 type-only 放行（仅 hub→`config/settings.ts` 例外）；`protocol files may not escape` 含 type-only；`files are discovered`（:323-336）是 `arrayContaining` 代表项，非全等、非逐文件闭包。P1 新增钉子**不过滤 `typeOnly`**、断言 import 恰为 `node:child_process`+`node:os`、零相对 import；明确不把 discovery 当闭包保证。                                                                                                                                                                                                                                                                                          |
| #4       | Major   | **采纳**               | §3.P0-a（开销口径）、§3.P0 测试资产、§5.4 契约表、§7 R1、§8 L1/L7                                                                   | 删除「Map.size===0 ⇒ 零开销」。改为有预算：注册表惰性创建，Linux 每次 `fdPath` 仅多一次全局属性读取；`fdPath` p50 ≤ +150 ns、`transact` 中位数 ≤ +2 %（`PI_TOOLKIT_SCHED_BENCH=1` 信息性度量并记录，不进 CI 门禁以免 flake）。Linux 对照扩展为冻结快照 `tests/schedule/compat/paths-v0.ts` 的差分：输出矩阵、全部 reason+message、异常路径（ErrnoException 透传、已关 fd 行为）、flock argv/stdio/timeout/无 env。                                                                                                                                                                                                                                                                               |
| #5       | Major   | **采纳**               | §3.P2-c、§1 C2、§3.P0 测试资产、§8 M6                                                                                               | 重新用命令生成清单并定义口径：调用表达式（`fdPath(` 去注释不含声明）/ 调用点（行）/ 内部原语；HEAD 实测 `fdPath(` **26 表达式 / 24 调用点 + 1 声明**（lock 2、paths 3 内部原语+1 声明、reader 1、writer 20），补上评审指出的 `lock.ts:77`、`paths.ts:180/203/235`；另列 `fdRealPath(` 5 调用、`fdAnchoringAvailable(` 2 内部调用、`lstatAt(` P0 后 1 调用，以及不经 `fdPath` 的绝对路径 syscall（`ABS_SYSCALL_MANIFEST`）与 fd-native 操作。清单落成 `tests/schedule/core/fdpath-manifest.ts` 数据，`seam-contract.test.ts` 读数组按「文件+外层函数」比对，不手抄行号；P0 后期望 26 个 `fdPath` 表达式 + 1 个 `lstatAt` 外部调用。已注明 hub 的 preview/spawn-history 里同名 `fdPath` 不在范围。 |
| #6       | Major   | **采纳**               | §3.P1-b（J1-J7 表）、§3.P4-A、§7 R3b、§8 M3b                                                                                        | 逐条列出全部链：`judgeHolder(` 7 个直接调用（note 172/217、digest 222、service 376/382，recovery 170/190 为经 opts 的间接）；`recoverDeadRuns`←`claim.recoverRuns`(339)←`clock.ts:291`←`wire.ts:467` 的 `judge` 配置（P1 补 probe）；`unknownRunKeys` **当前无生产调用方**，登记契约「将来调用必须传 probe」并由 `JUDGE_MANIFEST` 扫描强制；`closeEpoch*` 不判活无需 probe。每条链给出 probe 到达路径与专属测试，clock 链含「漏传 probe」负向用例。                                                                                                                                                                                                                                              |
| #7       | Major   | **采纳**               | §3.P2-b、§6 I4 行、§7 R5、§8 M6b                                                                                                    | 盘点全部 `closeSync(` 站点（`CLOSE_MANIFEST`）：目录 fd 只经 `closeQuiet` 关闭，其余站点对象为锁/会话/临时文件 fd 与 `fs.Dir` 句柄，永不登记；测试可能直接 `closeSync` ⇒ 以回收策略兜底。回收策略：容量 1024、空闲 TTL 10 min、登记时清扫（fstat 失效/dev-ino 不符/空闲超 TTL）、清扫后仍满则 fail closed（不逐出近期使用项）、`path()` 每次 fstat 复核、记录纯数据+`:v1` 键保障 `/reload` 共享。补 5 类测试：重复开关、异常路径无残留、直接 closeSync+fd 复用、容量上限、TTL、`vi.resetModules` 互读。取代原「4096 上限」表述。                                                                                                                                                                 |
| #8       | Major   | **采纳**               | §3.P3-a/b/测试（T-P1…T-P9）、§7 R7/R8、§8 M4/M4b                                                                                    | 脚本改用显式 `-MFcntl=:flock -MErrno=EWOULDBLOCK,EAGAIN` 与数值比较，不依赖 `$!{…}` 键（本机 perl 5.34.1 实测导出、busy=75、`spawnSync` 超时为 `ETIMEDOUT/SIGTERM`、`kill -9` 为 `SIGKILL`）。结果映射表给出 ENOENT / ETIMEDOUT / 其他 error / 信号 / 0 / 75 / 其余退出码各自固定 fail-closed 文案（超时/信号一律 fail 非 busy）。probe 直接复用 `perlFlockAcquire`（同函数同 `PERL_FLOCK_ARGS` 同 env），T-P8 以注入 spawn 断言两路参数一致。`held` 之后的 dev/ino 复核保留，T-P7 覆盖锁文件被替换。各边界独立成条。                                                                                                                                                                            |
| #9       | Major   | **采纳**               | §5.1(2)、§5.3、§7 R11、§8 M11                                                                                                       | P4-B 基线阶段增加「逐文件词法标记前后比对」脚本与表格（标记集合 / `TIER1_DECLARED` kind / 是否 tier2 文件 / 是否落在 integration），结果与「新增/移除登记清单」写入 report；明确 `validateManifest` 不检测陈旧登记，需人工删除；新增「隐藏 spawn」规则（调用会启动进程的 helper 导出的测试须按 proc 登记）；治理测试降为附加门禁（M11 先人工后跑测试）。tier1 默认使用不 spawn 的 `fixtureSelf()`。                                                                                                                                                                                                                                                                                              |
| #10      | Major   | **采纳**               | §5.4（证据类别 + C-L1…C-L5 + 开销预算）、§8.0（L1-L7）、§8 M5/M6                                                                    | 「Linux 字节不变」拆成：错误 reason/对外错误码、超时/等待参数、锁竞争与原子事务结果、冻结件、wire/schema 五条可观察契约，各配取证命令；Linux 专属测试断言不改（审 diff 去除 `expect` 行的删除/放宽）。引入证据类别 E-CI / E-MAC / E-AUX：M5（Linux 上强制 darwin 后端）明确标为「算法辅助证据」，真实 Darwin 结论必须来自 mac 运行，二者不互相替代。                                                                                                                                                                                                                                                                                                                                             |
| #11      | Minor   | **采纳**               | §3.P1-b 末尾预算项、§8 M3c、§8.2 R-f                                                                                                | 量化：`readSelf`=2 次子进程启动，`createAgent` 与 hub 构造各一次；`judgeHolder` 触发探测 0 次（host/boot/同进程/ESRCH）或 1 次 `ps`；clock 单轮 ≤「非终态外部 holder 数」×1；hub 每候选 run ≤ 2/轮、60 s 周期；单轮预算 ≤ 8 次且 ≤ 250 ms，超出再议实例级 TTL 缓存（5 s/容量 64，无模块级状态）；测试用注入计数器断言。                                                                                                                                                                                                                                                                                                                                                                          |
| #12      | Minor   | **采纳**               | §8.2（M16 人工核对清单）                                                                                                            | M13 的关键词 grep 改为逐项人工核对表：每项残余（R-a…R-g）须有「风险内容 / 适用平台 / 影响 / 不可保证事项 / 运行时依赖」五格实质内容，缺一格验收不通过。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**自查记录**（命令实测，见 §3.P2-c / §3.P1-b 数字来源）：

- `grep -o "fdPath(" src/schedule/core/*.ts | sort | uniq -c` → lock 2 / paths 4（含 1 声明）/ reader 1 / writer 20，共 27（含声明）⇒ 调用表达式 26；`grep -n "fdPath(" src/schedule/core/*.ts | wc -l` = 25 行（含声明）⇒ 24 个调用点。
- `grep -rn "fdRealPath(" src` = 6（含 1 声明）⇒ 5 个调用；`grep -rn "judgeHolder(" src` = 8（含 `recovery.ts:103` 声明）⇒ 7 个调用（recovery 170/190、note 172/217、digest 222、service 376/382）；`recoverDeadRuns(` 1 个调用（`claim.ts:339`）；`recoverRuns(` 1 个调用（`clock.ts:291`）；`unknownRunKeys(` 0 个调用。
- 以上数字与 §3.P1-b J1-J7 表、§3.P2-c 清单、§8 M3b/M6 一致。

### 第 2 轮（复审，2026-11-17）

| 复审编号                 | 严重度 | 处置                                            | 落点小节                                                                                                                                                     | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-#1（①lstatAt 进接口） | 必修   | **采纳**                                        | §3.P0-a（`PathBackend.lstatAt(fd, rel, opts?)` 成员 + 自由函数 `lstatAt(fd, rel, opts?)` + 自由函数清单）、§3.P2-c（口径与 `FDPATH_MANIFEST`）、§7 R4、§8 M6 | 接口成员签名补全 `opts?: FsCheckOpts`，并写明 `rel` 约束（非空、≤ 8 段、每段 `isPlainName`）、Linux 实现（具名函数 `linuxLstatAt` = 现 `lstatSync(fdPath(fd, rel))`，行为逐字不变、不开 fd、不碰注册表）与 Darwin 语义。manifest 口径把 `lstatAt` 纳入：`fdPath(` 仍 26 调用表达式 / 24 调用点（writer 少 1、paths.ts `linuxLstatAt` 多 1），另登记 `lstatAt(` 外部调用 1（`writeReportLocked`），路径派生合计 27；表格新增 `linuxLstatAt` 行，M6 与 R4 的数字同步（P0 前后 `grep -n` 均 25 行、`grep -o` 均 27 含声明）。                                                                                                                                                                                                                                    |
| R2-#1（②实现链写成契约） | 必修   | **采纳**                                        | §3.P0-a「lstatAt 契约」第 1-5 条、§3.P2-a（多段 bullet）、§3.P2-b（关闭路径与测试）                                                                          | 契约链：`lstatAt → fdBackendOf(fd).lstatAt → openDirAt(cur, seg, opts) → prepare/open/fstat/checkStat/confirm`；`openDirAt` 接受并透传 `opts`（`uid` 生效，`backend` 对子级忽略）；`confirm` 原子（最后一步才登记，抛错无残留）；`openDirAt` 失败先 `closeQuiet` 再重抛；`lstatAt` 以 `opened[]` + `finally` 反序关闭，任一级失败不泄漏。**中间 fd 归属：立即关闭并注销，不随调用方**——返回值只有 `Stats`、无 fd 可外泄；若不注销只能等 TTL（10 min），与「合法 fd 生命期 ≤ 一次事务」及容量 1024 冲突（分配循环最坏 4096 次 `lstatAt`）；且每次调用都是一次完整链校验。测试断言：各成功/失败路径前后注册表 `size` 与 fd 数相等，4096 次循环不增长；Linux 路径断言注册表未被创建。                                                                            |
| R2-#1（③birthtime 兜底） | 必修   | **采纳（降级为 dev/ino-only，不 fail closed）** | §3.P2-a「birthtime 兜底」、`FdRecord.chain.bt`、`DarwinBackendOpts.birthtime`、§3.P2-d（G2/U5/D1/D3/D5）、§8.2 R-a                                           | 快照条目改为 `{dev, ino, bt: number\|null}`；`birthOf` 仅在 `birthtimeMs` 有限、`>0` 且 `<ctimeMs` 时可信（排除 0/NaN、libuv 回填 ctime 的伪值、刚创建的目录）。比较函数 `darwinSnapshotEqual`：dev/ino 必须相等；原可信现不可信 ⇒ 不等（fail closed）；两侧可信 ⇒ 须 `===`；快照为 `null` ⇒ 只比 dev/ino。选择降级的理由：birthtime 仅是 U5 的补充缓解、主身份是 dev/ino；fail closed 会让 NFS/SMB/exFAT/FUSE/旧卷及 Linux 辅助测试 tmpfs 上整体不可用，且伪 birthtime 会造成假 `moved`；代价（`bt===null` 的目录 U5 窗口仅靠 dev/ino）并入 U5 残余并写入 README/report。测试：D1、D3 在 `birthtime:"auto"` 与 `"off"` 下各跑一遍、判据相同（必拒）；新增 D5 两层表驱动用例：`birthOf`（0/NaN/负值/≥ctime ⇒ `null`）与 `darwinSnapshotEqual`（输入仅 `number | null`；「原可信 number、现 `null`⇒ 不等」，不存在`null`与`0` 直接比较）；inode 复用不可确定性构造，不写「无法发生」断言。 |
| R2 自查                  | —      | 已执行                                          | 本节末                                                                                                                                                       | `grep -n "fdPath(" src/schedule/core/*.ts \| wc -l` = 25（含声明）、`grep -o` = 27（含声明）与文档 P0 前数字一致；P0 后数字由 manifest 测试在落地时核对（迁出 1 / 迁入 1，总数不变）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### 第 3 轮（定点文字修补，2026-11-17；由主会话亲自核对闭合）

| 编号                                                        | 处置     | 落点小节                                                                                   | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3-#1（openDirAt→confirm 路径构造与 parent chain 复核次序） | **采纳** | §3.P0-a「lstatAt 契约」新增 1a；§3.P2-a `confirm` 条加交叉引用                             | 写明 `openDirAt(parentFd, seg, opts)` 先用 `fdBackendOf(parentFd).path(parentFd, seg)` 构造子级路径，该调用先重核 parent（`fstat` dev/ino + 祖先 chain 逐级 `lstat`，失败抛 `moved`），故「打开子级」恒发生在「parent 链刚被复核」之后，parent→child 关联由已核验的 parent fd + 路径构造共同保证，不只靠子项 pre/fstat/post 三方比较；其后严格按 `prepare(pre-lstat) → openSync(O_DIRECTORY\|O_NOFOLLOW) → fstatSync → checkStat → confirm(post-lstat 三方比对，通过才登记，chain = parent.chain + [self])`。残余明确归入已披露 U1：`path()` 返回后到 `prepare/open/confirm` 之间 parent 被替换的窗口不声称消除，`path()` 每次用前重核只把它压到单次 syscall 粒度，下一个校验点会因 chain 不符检出并拒绝（D2）。 |
| R3-#2（D5 的 `cur.bt=0` 语义统一）                          | **采纳** | §3.P2-a「birthtime 兜底」（归一化口径 + 比较函数）、§3.P2-d D5、本节 §10 第 2 轮 R2-#1③ 行 | 统一口径：快照进入比较器前一律经 `birthOf()` 归一化（0/NaN/负值/≥ctime ⇒ `null`），`darwinSnapshotEqual` 输入只有 `number\|null`；因此「原可信现 0」实为「原可信 number、现 `null`」⇒ 不等（fail closed），`snap.bt=null` ⇒ 只比 dev/ino；不存在 `null` 与 `0` 直接比较。D5 拆为 (a) `birthOf` 表与 (b) `darwinSnapshotEqual` 表两层；三处措辞（P2-a 比较规则、D5 测试摘要、§10 记录）已一致。                                                                                                                                                                                                                                                                                                                   |
