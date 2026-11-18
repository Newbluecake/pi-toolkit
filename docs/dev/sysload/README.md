# sysload · 开发者要点

> 何时读：改动 `src/sysload/**`、`load.*`/`webHub.load` 设置键、spawn 负载准入之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`plan.md`

## src/sysload/

`src/sysload/` — load-aware dispatch (`docs/dev/sysload/plan.md` v2.1). Pi-free core except `hook.ts`: `procfs`/`mounts`/`sampler`
read CPU (incl. PSI), memory, IO pressure and per-mount disk from /proc + statfs under a process-wide IO ledger
(`io-ledger.ts`, `Symbol.for("pi-subagent:sysload-io")` — the one documented process-global: ≤2 async ops, ≤1 per key, slots
released only when the operation really settles, late results generation-fenced); `tracker.ts` runs the frozen
sustain(60s)/recover(30s)/hysteresis state machine per metric (overall = max known level, all unknown ⇒ unknown;
`levelSinceMono`/`gatingSinceMono` give the gate duration); `top.ts` scans /proc on demand (deadline, single ledger slot,
pid+starttime reuse check, aggregated by comm, instantaneous CPU% across scans, `cpuPct`/`rssBytes` omitted ⇔ n/a — never
NaN on the wire); `gate.ts` evaluates admission + renders the rejection text; `hook.ts` turn_end hints (`subagent:load`,
`triggerTurn:false`). Settings `load.*` + `webHub.load` are non-live (session_start / hub start). Entry matrix (P2a,
`src/stack.ts` + `spawn-service.ts`): top-level and nested `Agent` (incl. resume) are rejected while gated (before any
run/label/worktree), workflow `agent()` waits FIFO via the injected `LoadAdmission` (`src/workflow/host.ts`), tidy / `/task` / @mention / RPC / cron are exempt; gate off, unknown, stale, print/json ⇒ fail open.
Hub side (`src/web-hub/hub/load.ts`): one hub sampler, fingerprint-gated `load` SSE frames, cap `load.v1`,
`GET /api/load/top` (X-PWH + same auth as other GETs, LAN same width, per-principal rate limit, 1.5 s deadline); UI
`src/web-hub/ui/src/components/load/` (pill / card / drawer banner from `StatusInfo.loadGate`). `load.enabled=false` /
`webHub.load=false` ⇒ zero wiring.

## macOS（Darwin）支持（2026-11，darwin-plan S0-S5）

> 设计与验收矩阵：`darwin-plan.md`；实施与实测证据：`darwin-report.md`。上文 Linux 段落的行为、展示文本与冻结件不变（`sampleOnce` 三元分支与
> `rankTopRows` 提取对 `tests/sysload/compat/{sampler-v0,top-v0}.ts` 两层差分钉住）；本节只描述 darwin 后端。

### 支持矩阵

| 指标          | linux                                 | darwin                                                                                                                                          |
| ------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU busy/PSI  | `/proc/stat` + PSI，全功能（gate）    | **缺席**：`cpu.kind="invalid"` 恒 unknown，不参与 gate、不触发升级/恢复/hint（tracker 兜底：overall = 已知指标最大等级）                        |
| MEM           | `/proc/meminfo`，全功能（gate）       | **只展示不 gate**（`memAdvisory`，见下）：`mem.level` 恒 unknown ⇒ 无告警色、不进 overall；显示值 `availPct`/`usedPct` 照常保留（含 Pill/Card） |
| DISK          | mountinfo + statfs，全功能（gate）    | 全功能（statfs 复用）；**darwin 当前唯一参与 gate 的指标**——CPU 打满、内存吃紧均不会拦派发，这是已接受取舍，勿报 bug                            |
| top           | `/proc` 按需扫描，两次扫描差分 CPU%   | `ps -A -o pid=,pcpu=,rss=,comm=`，`pcpu` 为内核**衰减均值**（非差分），不标 `avg`；差分口径留后续                                               |
| loadavg/cores | `/proc/loadavg`，cores 来自 `cpuN` 行 | `sysctl vm.loadavg` + `hw.ncpu`；UI loadavg 进度条分母来自顶层 `wire.cores`（mac 无 `cpu` 键时唯一来源）                                        |

### darwin 取数链

- **sysctl**：一次子进程 `/usr/sbin/sysctl -n vm.loadavg kern.memorystatus_level hw.ncpu` 取三值（输出恰 3 非空行，任一行坏仅该字段缺失，行数≠3 整次作废）；`kern.memorystatus_level`（0..100 整数）的「可用%」语义**未证实** ⇒ 仅展示（advisory），启用 gate 的取证标准与决策点见 `darwin-report.md` §5 / `darwin-plan.md` §7.2 M15/D1。
- **磁盘**：`fs.statfs` 平台无关、现有循环原样复用；挂载身份用 `fs.promises.stat(path).dev`（不起子进程），本机 `/` 与 `~` 同 APFS 容器 ⇒ 同 dev ⇒ 去重一行。
- **mount**：`/sbin/mount` 文本经 `host.parseMounts` 解析 fstype；本地白名单 `DARWIN_LOCAL_FILESYSTEMS` = `apfs hfs exfat msdos zfs`，其余（nfs/smbfs/afpfs/webdav/autofs/devfs/ntfs/ufs/FUSE 类）⇒ `skipped:"remote"` 用户可见，绝不 statfs 远程卷。
- **子进程纪律**（I1/I5）：所有 host 调用经 `runBounded`（异步 `execFile`、绝对路径、固定 env、入口硬校验有限正 timeout——Node `timeout:0` 陷阱、SIGKILL、`child`/stdio/kill 计时器全 unref）；上游 `hostBounded` 预算 <50 ms 不取租约不起进程；io-ledger 租约（同 key 单飞、全局 ≤2）保证进程数有界不堆积。实测各原语 <500 ms（`darwin-report.md` M8）。唯一 `spawnSync` 是 hub 启动探针（常量 1000 ms、一次性）。
- **探针失败降级**：沙箱禁 sysctl/ps ⇒ 采样 invalid ⇒ fail-open（gate/hint 不拦）；hub 探针失败 ⇒ 无 cap 无路由（与 darwin 支持前的现状一致）。

### C0 host seam（契约与落位）

- 类型**唯一声明处**：`src/sysload/sampler.ts`（`// C0:BEGIN` … `// C0:END` 标记）；实现落 **protocol 层** `src/web-hub/protocol/{sysload-darwin,sysload-darwin-parse}.ts`，按结构满足、**不 import sysload**（I8：白名单只收紧，钉子由 `tests/web-hub/boundary.test.ts` 钉死精确 import 清单）。
- **三副本 diff 门**：`sampler.ts`、`tests/sysload/host-contract.test.ts`、`tests/web-hub/protocol/sysload-darwin-contract.test.ts` 各持逐字副本（`diff` 验收 = darwin-plan §7.1 C0-1）；任何契约变更三处同提交，先回报调度方。
- 默认 `SamplerIo.host === undefined` = Linux 路径**逐字不变**；平台判定只在两个生产装配点（`src/sysload/activation.ts`、`src/web-hub/hub/load.ts`）经 `resolveSysloadHost()` 一次性解出——既有 fixture 测试在 mac 上仍走 Linux 分支，不被 `process.platform` 分流误路由。

### hub 探测一次性共享（`ctx.loadProbeOk`）

- darwin 探针是子进程，cap 声明（`assembleHubCaps`）与路由创建（`createHubLoad`）若各自探测可能一次成功一次失败 ⇒ cap 有而永无帧（或反之）。故 `prepareHubChannels` 探测**恰一次**写入 `ctx.loadProbeOk`，cap、`FrontendDeps.loadProbed` → `http.ts` → `createHubLoad({probed})` 全读同一值；`probed === undefined` 缺省回退自行探测（旧测试替身与改动前字节同）。一致性由 `tests/web-hub/hub/load-probe-once.test.ts` 钉住。

### wire 变化（I10 append-only）

- `LoadWire.cores?`（`src/web-hub/protocol/messages.ts`）顶层可选，**仅 `cpu` 缺席且 `sample.cores` 存在时下发**；`LoadCpuWire.busyPct` 保持 required（老前端 `isCpu` 会整帧判 false）；Linux 帧键集合与 `loadFingerprint` 字节不变，旧 hub × 新 UI / 新 hub × 旧 UI 均无害。
- 样本侧 `LoadSample.cores?` / `memAdvisory?`（`src/sysload/types.ts`）为 append-only 可选字段，Linux 样本永不携带。

### 本地运行命令（mac 真机）

```bash
npm run typecheck && npm run format:check && npm run test:tier1        # mac 日常门
# Darwin 专属（integration 前缀 ⇒ tier2，describe.skipIf 非 darwin）：
npx vitest run tests/integration/sysload-darwin.test.ts tests/integration/web-hub-load.test.ts
# 平台无关算法面（mac 上同跑，Linux CI 也实跑）：
npx vitest run tests/web-hub/protocol/sysload-darwin-parse.test.ts \
  tests/web-hub/protocol/sysload-darwin.test.ts \
  tests/web-hub/protocol/sysload-darwin-contract.test.ts \
  tests/sysload/darwin-sampler.test.ts tests/sysload/darwin-top.test.ts \
  tests/sysload/darwin-tracker.test.ts tests/sysload/linux-parity.test.ts \
  tests/sysload/host-contract.test.ts tests/web-hub/hub/load-probe-once.test.ts
# mem 取证脚本（CSV 落 os tmpdir，--csv 可改路径）：
node scripts/dev/sysload-darwin-mem-observe.mjs --scenario idle
```

### CI 覆盖说明（证据类别，darwin-plan §7）

CI 仅 ubuntu（无 macOS runner）：darwin 真实进程测试在 CI 显示 **skipped**，不得把 CI 绿记作 Darwin 验证。「darwin 可用」的唯一证据是 **mac 真机运行（E-MAC，`darwin-report.md`）**；「Linux 不变」由 Linux CI（**E-CI**，含 `runBounded` 真实进程纪律 `tests/integration/sysload-bounded-exec.test.ts` 的实跑）提供；互不替代。
