# sysload macOS（Darwin）支持：实施方案（第 1 轮修订版）

> 状态：方案稿（plan，第 1 轮评审后修订），供 dev 包并行派发与 verifier 验收使用。基线：分支 `feat/schedule-darwin`，核对日期 2026-11-18（行号以该日 HEAD 为准，施工前以 HEAD 复核）。修订处置见文末「修订记录」。
> 先例：schedule darwin 支持（`docs/dev/scheduled-reports/darwin-arch.md` / `darwin-plan.md`）——platform seam 注入、探测落 protocol 层的边界闭包理由、测试平台自门控、tiers 登记规则（含「隐藏 spawn」）、E-CI/E-MAC/E-AUX 证据类别。本文沿用，不重述。
> 用户拍板（2026-11-18，第 2 轮，已写入正文，不重开）：**Q1 做 S3**（顶层可选 `LoadWire.cores?`，仅 cpu 缺席时下发，不动 `LoadCpuWire.busyPct` 的 required 性）；**Q2 挂载身份用 `fs.stat().dev`**（不起子进程）；**Q3 darwin 内存只展示不 gate**（机制见 §2.9，验收与启用决策点见 §7.2 M15/D1）；**Q4 top 用 `ps pcpu`**（衰减均值，文档披露语义差，差分留后续）。
> 已拍板、不重开：CPU `busyPct` 在 mac 缺席（unknown，不参与 gate，tracker「overall=已知指标最大等级」兜底）；不引原生模块；不改 Linux 行为/文本；I10 wire append-only。

## 1. 需求摘要

- macOS 上 sysload 可用：pi 侧采样 → tracker → 闸门/hint/HUD，hub 侧采样 → `load` SSE 帧 + `GET /api/load/top`，均不再「mac 瘫痪（恒 unknown）」。
- 根因三处：`sampler.ts` 硬编码 `/proc/*`；`hub/load.ts:84-86 hubLoadProbe` 非 linux 直接 `false`（hub 无 cap/无路由）；`top.ts` 扫 `/proc`。
- mac 原语：`sysctl -n vm.loadavg kern.memorystatus_level hw.ncpu`（一次子进程）；`fs.statfs`（磁盘，平台无关，现有逻辑原样复用）；`mount` 输出（fstype → 本地/远程）；`fs.stat().dev`（挂载身份，见 §2.5 偏差说明）；`ps -A -o pid=,pcpu=,rss=,comm=`（top）。
- mac 指标面（**修订**）：DISK ✔（gate）、loadavg/cores 展示 ✔、TOP ✔；**MEM 仅展示、不 gate（advisory，§2.9，取证通过前）**；CPU busy/PSI 缺席（已拍板）。故 **mac 上当前唯一参与 gate 的指标是 DISK**；CPU 打满、内存吃紧均不会拦派发——已接受的取舍，须在 README 披露。
- 不做：CPU busy 估算、原生模块、Windows/BSD、cgroup、Linux 任何行为/文本/wire 变化；mem gate 的启用（取证后另议）。
- 验收：mac 真机 smoke 取到 mem（展示）/disk/loadavg/top 真值；Linux 现有套件零回归（含冻结快照差分）；A/B 级冻结件字节不变；`activate-trace.json` 不变；mem 取证报告落盘（结果不影响本期验收通过与否，只决定后续是否启用 gate）。

## 2. seam 设计

### 2.1 总体与落位裁定（protocol 层 vs `src/sysload/platform.ts`）

- **默认（`SamplerIo.host === undefined`）= 今天的 Linux 路径，逐字不变。** 平台判定**不放进 `sampleOnce`**（现有 Linux fixture 测试在 mac 上用 `process.platform` 分流会被误路由到 darwin 后端而变红；探索确认 `tests/sysload` 40/40 在 mac 全绿，全部 fixture 注入、无真 `/proc` 依赖，必须保持）。平台判定放在两个生产装配点（`activation.ts`、`hub/load.ts`），用 `resolveSysloadHost()` 一次性解出 host，经 `SamplerIo.host` 与既有的 `scanTop` 注入口下发。
- **落位裁定：选 protocol 层**（`src/web-hub/protocol/sysload-darwin-parse.ts` + `sysload-darwin.ts`），**否决** 探索提出的 `src/sysload/platform.ts`（`LoadSampleBackend` + linux/darwin 双实现）。已读 `tests/web-hub/boundary.test.ts` 核实：
  - 选 protocol 的理由：① hub→sysload 可达闭包由 `SYSLOAD_FILE_ALLOWLIST`（:29-38）+ `SYSLOAD_FILE_CLOSURE`（:94-217，每文件**精确** value-import 集合，`sampler.ts`=`node:fs,node:os,./io-ledger,./mounts,./procfs`；`top.ts`=`node:fs,./io-ledger,./procfs`）+ 用例 :415 共同钉死。protocol 方案**零放宽**：sysload 侧文件零新增 import，只新增 protocol 文件的精确 import 钉子（镜像 `sched-identity.ts` 钉子 :480-489）。② AGENTS I8 写明「白名单只收紧」；boundary 文件注释虽允许「conscious table update」，但 sysload 方案要同时：加 allowlist 项、加 closure 条目、给 `sampler.ts` 的精确集合加 `./platform.js`、并把 `node:child_process` 引入 hub 可达的 sysload 文件——是四处**扩张**。③ 先例一致：`sched-identity.ts`、`proc-identity.ts` 均为 hub 可 import 的 protocol 子进程/探测模块。④ hub 直接 import protocol 在 `{protocol,hub}` 内，无需任何跨目录白名单。
  - 否决 `sysload/platform.ts` 的理由：除上面的扩张外，它要把 Linux 采样路径也改写成接口实现（`LoadSampleBackend` 的 linux 实现），即使是封装也触碰 Linux 代码，与「Linux 字节不变」的最小面原则冲突；其优点（sysload 内聚、linux 也收口）不值这个代价。
  - 唯一边界测试改动：`boundary.test.ts` **新增**两条钉子（扫描结果不过滤 `typeOnly`），**不改** `SYSLOAD_FILE_ALLOWLIST`/`SYSLOAD_FILE_CLOSURE`；`protocol/hub files are discovered`（`arrayContaining`）断言原样保留。
- 结构类型镜像：protocol 文件不得 import sysload（含 type-only），故 `SamplerHost` 等类型**声明在 `sampler.ts`**，protocol 实现按结构满足；首个编译期兼容检查点见 §3.0。

### 2.2 契约 C0（类型声明所有权与变更规则）

- **类型唯一声明处**：`src/sysload/sampler.ts`，以 `// C0:BEGIN` … `// C0:END` 标记包住；**写入者 = S1**。S0 在 `tests/web-hub/protocol/sysload-darwin-contract.test.ts`、S1 在 `tests/sysload/host-contract.test.ts` 各持一份**逐字副本**（同样的 `C0:BEGIN/END` 标记）并做**运行时形状**断言（键集合 + 函数 arity）。三份副本的一致性由验收命令 `diff` 钉死（§7.1 C0-1）。
- **S0/S1 不得擅自扩契约**：任何新增/修改字段、方法、语义（含 `timeoutMs` 约束）都**先回报调度方**，三处副本同提交更新；违规以 C0-1 红灯暴露。

```ts
// ── C0:BEGIN ── sampler.ts（S1 声明；S0 结构满足；零运行时 import）
export interface SamplerHostMount {
  // = MountInfoRecord 的字段集（host 解析器须填满：root:"/"、optionalFields:[]、superOptions:[]、mountId:0、majorMinor:"0:0" 占位）
  mountId: number;
  parentId: number;
  majorMinor: string;
  root: string;
  mountPoint: string;
  mountOptions: readonly string[];
  optionalFields: readonly string[];
  fstype: string;
  source: string;
  superOptions: readonly string[];
}
export interface SamplerHostReading {
  // 任一字段缺失 ⇔ 该项本拍不可用（互相独立）
  loadavg?: readonly [number, number, number];
  memAvailPct?: number; // kern.memorystatus_level，整数 0..100
  cores?: number; // hw.ncpu，正整数
}
export interface HostProcess {
  pid: number;
  comm: string;
  cpuPct: number;
  rssBytes: number;
}
/** 所有带 timeoutMs 的方法：调用方保证 timeoutMs 为有限正数；host 收到非有限/≤0 的值**不得启动进程**，直接 resolve undefined。 */
export interface SamplerHost {
  readonly kind: "darwin";
  readonly localFilesystems: ReadonlySet<string>; // 替代 mounts.ts 的 Linux LOCAL_FILESYSTEMS
  readHost(opts: { timeoutMs: number }): Promise<SamplerHostReading | undefined>; // 永不 throw/reject
  readMounts(opts: { timeoutMs: number }): Promise<string | undefined>; // 原始 mount(8) 文本 ≤1 MiB；永不 throw
  parseMounts(text: string): readonly SamplerHostMount[]; // 同步纯函数
  deviceOf(path: string): Promise<number | undefined>; // fs.stat().dev；失败 ⇒ undefined；永不 throw
  listProcesses(opts: {
    timeoutMs: number;
    maxPids: number;
  }): Promise<{ procs: readonly HostProcess[]; truncated: boolean } | undefined>;
}
export interface SamplerIo {
  /* …现有字段… */ readonly host?: SamplerHost;
} // 追加
// ── C0:END ──
// types.ts（S1 写）：LoadSample 追加 append-only 可选字段（Linux 样本永不携带）
//   readonly cores?: number;           // 无 CPU 读数的平台仍披露逻辑核数
//   readonly memAdvisory?: true;       // mem 读数只展示、不进 gate（§2.9）
```

### 2.3 darwin 采样如何进 `sampleOnce`（函数级步骤）

`sampleOnce`（sampler.ts:188）只在取数点用三元/条件分支接入 host；`resolvePath`、`statMount`、`beforeDeadline`、`seenMounts` 去重循环、`sample` 组装**零改动共用**。**Linux 分支表达式一个字符不改，只加 `host === undefined ? <原表达式> : <host 表达式>`。**

| 取数点（现行 Linux 行）                                                | `host` 缺省（Linux，逐字不变）          | `host` 在场（darwin）                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cpu（`/proc/stat`+PSI，201-210）                                       | 原表达式                                | 不读；`cpu={kind:"invalid"}`；不产出 `nextCpu`                                                                                                                                                             |
| mem（`/proc/meminfo`，211-221）                                        | 原表达式                                | `availPct=reading.memAvailPct`，`usedPct=100−availPct`（满足 `memRaw` 的 \|used−(100−avail)\|≤0.01）；缺失 ⇒ `invalid`；`DARWIN_MEM_ADVISORY===true` 时样本带 `memAdvisory:true`（§2.9）                   |
| loadavg / cores                                                        | `/proc/loadavg`；无 cores               | `reading.loadavg`；`reading.cores` ⇒ `sample.cores`（条件展开，Linux 不产出该键）                                                                                                                          |
| mountinfo 文本（225-227）                                              | `plan.mountinfoText ?? read(mountinfo)` | `plan.mountinfoText ?? await hostBounded("mount", …)`；`parsedMounts=host.parseMounts(text)`；仍用**同一** `mountinfoText` 缓存位（activation/hub 的 60 s 缓存与 `SampleResult.mountinfoText` 回传零改动） |
| 磁盘循环内 `resolveMount`（实测 `/` 与 HOME 在本机落同一挂载或同 dev） | `resolveMount(path, mounts)`            | `resolveMount(path, mounts, host.localFilesystems)`；**命中本地挂载后**按下面「deviceOf 步骤」覆盖 `mountId/majorMinor`；`ioPsiPct` 不读                                                                   |

- **`hostBounded(kind, ledger, left, isCurrent, op)`**（S1 新增内部函数，≈20 行；所有 host 调用共用）：
  1. `if (!isCurrent() || left() < HOST_MIN_BUDGET_MS) return undefined;`（`HOST_MIN_BUDGET_MS = 50`，**在 `withIoLease` 之前**检查 ⇒ 预算耗尽不取租约、不启动进程）；
  2. `timeoutMs = Math.floor(Math.min(HOST_MAX_TIMEOUT_MS /*800*/, left()))`（此时必为 ≥50 的有限正整数）；
  3. `lease = withIoLease(ledger, "host:"+kind, () => op(timeoutMs))`；`undefined`（账本满/同 key 在途）⇒ 返回 `undefined`；
  4. `await beforeDeadline(lease, left())`（只结束**等待**，不取消）；`!isCurrent()` ⇒ 丢弃；结果缺失 ⇒ 该项本拍不可用（⇒ `invalid`）。
- **deviceOf 步骤（#6，磁盘循环内、`resolveMount` 命中 `skipped===undefined` 的本地挂载之后、`statMount` 之前）：**
  1. `if (!isCurrent() || left() < HOST_MIN_BUDGET_MS)` ⇒ 该路径 `{kind:"invalid"}`（与 `statMount` 自身预算/代际守卫同口径），**不**取租约、**不**调 `statfs`；
  2. `dev = await hostBounded("dev:"+resolvedPath, …, () => host.deviceOf(resolvedPath))`（账本 key `host:dev:<path>`，deviceOf 是 `fs.promises.stat`，无子进程）；
  3. `dev === undefined`（失败 / 账本满 / 等待超期 / 抛错）⇒ 该路径 `{kind:"unresolved"}`（沿用 `resolvePath` 未解析口径：不能证明挂载身份就**不冒充**），**绝不调 `statfs`**、**不**加入 `seenMounts`；
  4. 取得 `dev` 后再查一次 `isCurrent() && left() > 0`，否则 `{kind:"invalid"}`（仍不调 `statfs`）；
  5. 通过后 `mount = {...mount, mountId: dev, majorMinor: String(dev)}` 参与 `seenMounts` 去重与 `statMount`。
- **挂载身份去重（本机核对）**：mac 的 `/`（`disk3s1s1`，sealed system）与 HOME（Data 卷，firmlink）在 `mount` 里是**不同**挂载，但 `fs.stat().dev` 相同（`/`、`~`、`/System/Volumes/Data` 均 16777233，`statfs` 的 blocks/bfree/bavail 也相同——APFS 容器共享）。用 `dev` 作身份后，现有去重把 `/` 并入 `~`，UI 一行；换盘 ⇒ dev 变 ⇒ 断序（§5.2 连续性语义）。
- **`mounts.ts`**：`resolveMount(path, mounts, local = LOCAL_FILESYSTEMS)` 追加可选第三参。**必须**：`LOCAL_FILESYSTEMS`（:3-18）全是 Linux fstype，无 apfs/hfs——不传 `host.localFilesystems` 则 mac 全部判 remote skipped；但**不**往该 Linux 集合里加 apfs/hfs（避免任何 Linux 语义漂移）。

### 2.4 子进程超时语义与 io-ledger（**修订 #1；不用 spawnSync**）

- 实现：host 内 `runBounded(file, args, { timeoutMs, maxBytes }, deps?)`，**异步** `execFile`（绝对路径 `/usr/sbin/sysctl` `/sbin/mount` `/bin/ps`；固定 env `{LC_ALL:"C", PATH:"/usr/bin:/bin:/usr/sbin:/sbin"}`；`killSignal:"SIGKILL"`；`maxBuffer`；`windowsHide`），`child.unref()` + `child.stdout/stderr.unref()`（I5）。不用 `spawnSync`：会阻塞事件循环至子进程返回，违反 I1；子进程不占 libuv 线程池。唯一 `spawnSync` 是 hub 启动探针 `probeDarwinHost`（常量正 timeout 1000 ms，一次性）。
- **timeout 取值与 `timeout:0` 陷阱**（Node `execFile` 的 `timeout:0` = 永不超时）：
  - **入口硬校验**：`runBounded` 首句 `if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > RUN_BOUNDED_MAX_MS /*2000*/) return Promise.reject(new RangeError("timeout"))`——**先于任何 spawn**；host 方法把 reject 吞成 `undefined`（C0：非法 timeout 不启动进程）。传给子进程的 timeout 永远是校验后的**有限正数**。
  - 调用方（`hostBounded`/`scanTopViaHost`）已在上游保证 `≥50 ms`（上节步骤 1-2）；host 的校验是第二道闸，两层互不依赖共享常量。
- **spawn→close 语义（明文）**：计时起点 = `spawn` 返回；到期 ⇒ `child.kill("SIGKILL")`，**promise 在子进程 `close`（退出 + stdio 关闭）时 settle**：正常退出且 status 0 ⇒ resolve(stdout)；超时被杀 ⇒ reject(`ETIMEDOUT`)；非零退出/信号/ENOENT/超 `maxBuffer` ⇒ reject。kill 计时器自身 `unref()`。不对 `close` 之后的任何事做假设。
- **租约与悬挂边界**：租约（`host:sysctl` / `host:mount` / `top`）在 host promise **真正 settle 后**才释放（`withIoLease` 已保证）。`beforeDeadline` 只结束调用方的**等待**（该拍记缺失），**不**提前释放。残余（与既有 statfs 同级，沿用 plan.md R4）：不可杀进程（D 状态）会让对应租约一直占用——但同 key ≤1、全局 ≤2，且占用期间不会再发同 key 新进程 ⇒ 子进程数有界、不堆积。
- 账本 key 与并发：每拍串行 `sysctl → (mount 缓存未命中) → realpath → deviceOf → statfs`，任一时刻 ≤2 租约（含 top 的 `top`），不挤占 statfs 槽。`top` 租约沿用 Linux 单飞语义，`ps` 不另占槽，租约在 `ps` 真正结束后释放。
- 与探索结论的关系：探索认为子进程不占线程池故不需要 io-ledger slot——**同意**（本方案的租约不是为线程池，而是为**进程数上界与单飞**：防止上一拍 sysctl 悬挂时每 5 s 再堆一个）。故保留租约，并明示这一理由。
- 开销：每 5 s 一次 sysctl（实测 ~2 ms）；`mount` 每 60 s 一次（~5 ms）；`ps -A` 仅按需（本机 ~600 进程、31 ms、64 KB）。

### 2.5 mac 解析与数据口径

- `vm.loadavg`：`{ 2.35 2.36 2.38 }`；严格解析：必须花括号、三个有限非负数。
- `kern.memorystatus_level`：整数 0..100 ⇒ `availPct`。**语义未证实，故仅展示**（§2.9）。
- `hw.ncpu`：1..4096 正整数。三值同一次 `sysctl -n vm.loadavg kern.memorystatus_level hw.ncpu`，输出恰 3 个非空行；非零退出 ⇒ 整次作废。
- `mount` 行：`<source> on <mountpoint> (<fstype>, opt, …)`，正则 `^(.+?) on (/.*) \(([^()]*)\)$`；不匹配行丢弃；≤1 MiB / ≤10 000 行，超限 ⇒ 空。`mountId/majorMinor` 解析器置占位，**仅**命中本地挂载后由 `deviceOf` 覆盖（逐挂载 stat 会碰远程卷，违背「绝不碰远程 FS」纪律）。
- 本地白名单（`DARWIN_LOCAL_FILESYSTEMS`）：`apfs hfs exfat msdos zfs`；其余（`nfs smbfs afpfs webdav autofs devfs ntfs ufs`、FUSE 类）⇒ `skipped:"remote"`，用户可见而非误判。
- **与已拍板原语的一处偏差（需知会）**：挂载身份去重不起 `stat -f %d` 子进程，改用 `fs.promises.stat(path).dev`（同一 `st_dev`，本机核对与 `stat -f %d` 同值）；真机 smoke 里仍用 `stat -f %d` 核对一次（§4.3-2）。
- `ps`：`-A -o pid=,pcpu=,rss=,comm=`（comm 放**最后一列**，否则非末列被截 16 字符）；前三列空白分隔，其余整体为路径 ⇒ `comm=basename(path)`（≤128、控制字符 `?`）；`rssBytes=rss(KiB)×1024`；`cpuPct=pcpu`（单核%，可>100）。**语义差异**：macOS `pcpu` 是内核衰减均值，不是两次扫描差分；不标 `avg`；README 披露。

### 2.6 `hubLoadProbe` 平台化 + 单次探测共享（**修订 #5**）

- 现状（核对 HEAD）：探针被**两处独立调用**——`assembly-channels.ts:175-177`（`assembleHubCaps` 里 `load.v1` cap）与 `hub/load.ts:198`（`createHubLoad`，由 `http.ts:1295-1305` 创建服务、:113 引入路由）。Linux 上 `/proc/stat` 探针近乎确定，两次一致；darwin 探针是**子进程**，可能一次成功一次超时 ⇒ cap 有而服务无（UI 见 cap 却永无帧），或服务有而 cap 无（UI 清空帧）。故**统一为一次结果**，而非接受不一致。
- 方案（沿用 `spawnPlatform`/`htmlEnabled` 先例：「ONE value read by the cap declaration AND the route attachment」，`assembly-channels.ts:75-81`、`assembly.ts:185-186`）：
  1. `HubAssembly`（assembly.ts）追加 `loadProbeOk: boolean`，`createHubAssembly` 默认 `false`；
  2. `prepareHubChannels`（assembly-channels.ts，与 `ctx.spawnPlatform` 同处）：`ctx.loadProbeOk = config.load !== undefined && normalizeHubLoadConfig(config.load) !== undefined && (deps.loadSeams?.probe ?? hubLoadProbe)()`——**整个 hub 生命周期探测恰好一次**；
  3. `assembleHubCaps` 读 `ctx.loadProbeOk`（取代内联 `hubLoadProbe()`）；
  4. `FrontendDeps`（ports.ts）追加可选 `loadProbed?: boolean`，hub.ts 构造 `frontendDeps`（:772-804 一带）时写入 `ctx.loadProbeOk`；`http.ts:1295` 创建服务时传 `probed: deps.loadProbed`；
  5. `createHubLoad(config, deps)`：`deps.probed !== undefined ? deps.probed : (deps.probe ?? hubLoadProbe)()`——缺省（旧测试替身未传）仍自行探测，**与改动前字节同**；
  6. `hubLoadProbe(deps?: { platform?; probeDarwin? })`：`darwin` ⇒ `probeDarwinHost()`（同步 ≤1 s，`sysctl -n kern.memorystatus_level` 须 0..100 整数）；`linux` ⇒ 原 `/proc/stat` 逻辑不动；其余 `false`。
- 一致性断言（测试，§4.2-H）：注入「首次 true、之后 false」的翻转探针，起 hub 后断言 ① 探针只被调用 1 次；② `HubInfo.caps` 含 `load.v1` ⇔ 服务存在 ⇔ `GET /api/load/top` 非 404 ⇔ SSE 有 `load` 帧；再对「恒 false」断言四者全无。
- **探针失败 = 无 cap、无路由**（现有契约不变），沙箱禁 sysctl 时 mac 与今天一致。

### 2.7 `top` 的 ps 回退形态（探索采纳：复用既有 `scanTop` 注入口）

- `scanTop`/`TopScanOptions` **不改**（撤回上一版「`options.host`」设计）。`top.ts` 新增 `createHostTopScanner(host: Pick<SamplerHost,"listProcesses">): (ledger: IoLedger, options: TopScanOptions) => Promise<TopScanSnapshot>`，返回与 `scanTop` 同签名的闭包。
- 装配：`activation.ts`/`hub/load.ts` 的默认 scanner 选择：`deps.scanTop ?? (host === undefined ? scanTop : createHostTopScanner(host))`（现有 `deps.scanTop ?? scanTop` 一行扩展，framework 零改动）。
- 闭包行为：`ledger.tryAcquire("top")`（取不到 ⇒ 与 Linux 同返回 `partial:true` 空快照）→ 上游检查 `remaining() >= HOST_MIN_BUDGET_MS`（否则直接 `partial` 空快照，**不启动 ps**）→ `host.listProcesses({timeoutMs: floor(min(remaining(), 1000)), maxPids: 2048})` → 聚合。
- 聚合：为复用排序，把 `aggregateTop` 末段（comm 分组 → rows → top-5）**原样提取**为内部导出 `rankTopRows(byPid)`（纯函数搬家，`aggregateTop` 调用它；`aggregateTop` 仍纯函数，exploration 确认）；`top.test.ts` 不改一字必须仍绿。结果 `{ at, unitsAvailable:true, byCpu, byRss, ...(truncated||超时 ? {partial:true} : {}) }`；`onPrevious` 不调用；所有在途 promise settle 后才释放 `top` 租约。`projectTop`/`topUnitsAvailable` 无需改。

### 2.8 gate/render 文案消费链（**修订 #2**）

- **核对结果（HEAD）**：GNU 专有 fallback 命令串只在 `gate.ts:63`（`evaluateLoadGate` 的 `topBlock`，`top===undefined` 时），**唯一生产调用点**是 `stack.ts:655` 的 `loadGate` 闭包（`spawn-service`/`runtime-adapter` 的拒绝路径消费其 `message`）。评审提到的 `render.ts:33`：`buildLoadEscalationText`（`hook.ts:86` turn_end 提示）只复用 `loadDetail()`（`[load] level · CPU/MEM/DISK · loadavg` 明细行，**不含任何 ps 命令**），其 `top===undefined` 分支文案是 `"top unavailable"`；`buildLoadRecoveryText` 无 top。故 render 链**没有** GNU `ps`，只有 gate 链需要平台化；以守卫测试把这一事实钉住（防日后有人在 render 里加命令忘了平台化）。
- **平台信息的传入路径（真实装配端）**：`stack.ts:655` 现有 `evaluateLoadGate(verdict, settings.load, { nested, top?, ownRuns? })`，**追加 `platform: process.platform`** 一个字段（装配端取值；`stack.ts` 其余零改动，**不涉及任何 `registerTool/registerCommand/on` ⇒ `activate-trace.json` 不变**）。`LoadGateRequest` 追加 `readonly platform?: NodeJS.Platform`；**缺省（`undefined`）⇒ 原 Linux 文本逐字不变**（不依赖宿主 `process.platform`，旧测试/旧调用方在 mac 上也得到原串）；`"darwin"` ⇒ ``top snapshot unavailable; run `ps -A -r -o pid,pcpu,rss,comm | head` ``；其余值 ⇒ 原串。
- **调用级测试**（两侧都覆盖）：
  - gate 侧：`tests/sysload/gate.test.ts` 追加——`platform` 缺省 / `"linux"` ⇒ 与原字符串逐字相等；`"darwin"` ⇒ BSD 命令且**不含** `--sort`；nested 与非 nested 两种消息模板各断言。
  - 装配侧：`tests/integration/load-stack-wiring.test.ts`（已有真实 `buildSessionStack` + fake gated port，`top:()=>undefined` ⇒ 恰走 fallback）追加用例：`Object.defineProperty(process,"platform",{value:"darwin"})`（`finally` 还原）后 `stack.spawn.spawn({loadPolicy:"reject"})` 的拒绝 message 含 BSD 命令、不含 `--sort`；还原为 linux 后含原串。
  - render 侧：`tests/sysload/render.test.ts` 追加守卫——`buildLoadEscalationText`（`top` 有/无、nested 有/无、verdict 含 darwin 形态（`cpu` unknown、`cores` 来自 sample））输出**不含** `ps ` 命令串、不含 `--sort`；`loadDetail` 在 cpu 缺席时产出 `CPU —` 与 `loadavg … (N cores)`（N 来自 `verdict.cores`）。
- `loadDetail` 的 `(N cores)`：tracker 需在 cpu 缺席时也取 `sample.cores`（S1：`tracker.ts:302` 后 `else if (sample.cores !== undefined) latestCores = sample.cores`；Linux 样本无该键 ⇒ 路径不变）。
- UI（探索已核实）：`LoadWire.cpu` 已 optional（`messages.ts:551-568`），`LoadCpuWire.busyPct` 为 required——**不得**改它的 required 性（老前端 `isCpu` 会整帧判 false），故核数披露只能是**顶层可选** `LoadWire.cores?`（S3）。LoadPill/LoadCard/FleetDrawer 对 `cpu` 缺席天然宽容，唯一不准的是 `LoadCard.vue:205` 的 loadavg 进度条分母 `cpu?.cores ?? 1`。

### 2.9 mem 指标的 darwin 处置：展示不 gate（**修订 #3**）

- **为什么**：`kern.memorystatus_level` 的「可用%」语义未证实，直接喂 `crit≤8 / warn≤15` 可能误拦派发。本机即时读数即有矛盾迹象：同一时刻 `sysctl kern.memorystatus_level` = 46，而 `sysctl kern.memorystatus_vm_pressure_level` = 2（内核口径 warn；1 normal / 2 warn / 4 critical）。单点读数不足以下结论，但足以说明「level→压力」映射**必须先取证**。
- **最小机制（用户 Q3 拍板后选定）：样本携带 `memAdvisory` 标志，由 tracker 消费。** `LoadSample.memAdvisory?: true`（§2.2，append-only）+ sampler 常量 `DARWIN_MEM_ADVISORY = true`（darwin 样本带此标记；Linux 永不产出）。`tracker.observe` 在 `memAdvisory === true && sample.mem.kind=="ok"` 时：只记录显示值（`mem.value`、`mem.lastValid`，使 `verdict.metrics.mem.availPct` 可供 `loadDetail`/wire 显示），**不调用 `advanceMetric`**，`mem.level` 恒为初值 `"unknown"` ⇒ 不进 overall、不触发升级/恢复/gate/hint。改动面：`sampler.ts` 一个常量 + 一处样本字段、`types.ts` 一个可选字段、`tracker.ts` 一处分支；`createLoadTracker` 签名、`activation.ts`/`hub/load.ts` 装配点**零新增接线**。
  - **落选方案 ①「装配层给 gate 侧注入『mem 不参与』标志」**：pi 侧（`activation`/`stack`）与 hub 侧（`hub/load.ts`）是两个独立装配点，各自注入一次，且 gate/hook/status/wire 多个消费端要各自读这个标志，违反 plan §5.3「只读 verdict，不各自重组」，漏注入一端即 pi 与 hub 行为不一致。
  - **落选方案 ②「tracker 增加平台参数」**：把平台概念带进 pi-free 且平台无关的状态机（`createLoadTracker(settings, mono, wall)` 签名变更，`tests/sysload/tracker.test.ts` 的构造调用要动），而标志随样本走则 tracker 对平台一无所知，只认「该样本的 mem 只作展示」，语义更窄、可测性更好。
  - 启用时（后续决策）只需把 `DARWIN_MEM_ADVISORY` 翻为 `false`（或另设 darwin 专用阈值），同一路径即与 Linux 完全相同；这一可逆性有测试守住（§4.2-T）。
- **显示效果**：wire 的 `mem.level="unknown"`，`levelRank("unknown")===0`（`logic/load.js:35-43`）⇒ Pill/Card 以中性（ok 样式）显示用量，无误导性告警色；Card 的 MEM 行照常显示。mac 当前仅 DISK 参与 gate。
- **启用门槛（上线前的真机取证验收标准，取证完成前保持 advisory）**：取证脚本 `scripts/dev/sysload-darwin-mem-observe.mjs`（S4 新增，只读 + 受控内存分配，不提交到发布面）每 5 s 记录 CSV：`kern.memorystatus_level`、`kern.memorystatus_vm_pressure_level`、`memory_pressure` 的 `System-wide memory free percentage`、`vm_stat` 的 free/inactive/speculative/purgeable 页、`sysctl vm.swapusage`；场景：
  - **S-idle**：仅终端，10 min；**S-normal**：常规开发负载（编辑器+浏览器+构建），15 min；
  - **S-stress**：`node` 分配并触碰 50% / 70% / 85% / 92% 物理内存（`hw.memsize`），各持 3 min，释放后观察 ≥2 min（防交换风暴：脚本在 `vm.swapusage` 增长超 4 GiB 或系统卡顿即中止并记录）；每步配活动监视器「内存压力」图颜色人工截图。
  - 通过判据（**逐条记录，数字为门槛**）：**P1 无假阳性**——S-idle/S-normal 中凡内核 `vm_pressure_level==1` 的样本，`level>15` 占 ≥99%、且从不 ≤8；**P2 真阳性**——凡 `vm_pressure_level` 达 2 的 S-stress 步骤，`level ≤ 15` 在该步内出现；达 4 时 `level ≤ 8` 出现，否则记录为「阈值不适配」并给出建议的 darwin 专用阈值；**P3 恢复**——释放后 120 s 内 `level` 回到 S-idle 基线 ±10pp；**P4 可分配性记录（仅记录，无门槛）**——各 `level` 区间下分配 5% 物理内存的耗时与 `vm_pressure_level` 变化；**P5 现象解释**——对「`level`=46 而 `vm_pressure_level`=2」这类矛盾点逐条解释或标注未解。覆盖声明：只代表已测机型/RAM（本机 16 GiB）；未测机型保持 advisory。
  - 取证报告写入 `docs/dev/sysload/darwin-report.md`（原始 CSV 路径 + 汇总表 + 结论）。**验收只要求报告存在且逐条填写（含 FAIL）**；是否把 `DARWIN_MEM_ADVISORY` 翻为 `false`（或给 darwin 另设默认阈值）是**后续独立决策**，需用户拍板，不在本期。
- 可逆性证据（测试）：同一组 mem 数据——带 `memAdvisory` ⇒ 不 gate；去掉标记（模拟启用）⇒ 与 Linux 同一 tracker 路径正常升级（§4.2-T）。

## 3. 包拆分（文件域零交叠）

### 3.0 依赖边、契约所有权、编译对接点

```
S0 ──┐
     ├─► S2 ─► S4 ─► S5          S3 在 S1 之后，与 S2 并行；S4 在 S2 与 S3 之后
S1 ──┘
```

- **S0 与 S1 无源码依赖**（仅共享 §2.2 的 C0 文本）；二者可并行，各自**只读**对方域。
- **C0 类型所有权**：声明在 `src/sysload/sampler.ts`（S1 写）；S0 的 protocol 实现不 import sysload，按结构满足。
- **首个编译期兼容检查点 = S2**（两侧首次在 `src/` 里相遇）：`activation.ts` 里 `const host: SamplerHost | undefined = resolveSysloadHost()`，`npm run typecheck` 通过即证结构兼容。因此 **S2 验收第 1 条 = typecheck 绿**。S0/S1 在 S2 之前靠两道保险提前暴露漂移：(1) C0 三处副本 `diff`（§7.1 C0-1）；(2) 各自的运行时形状测试（键集合 + `.length` arity + 非法 `timeoutMs` 行为）。
- **测试责任边界**：
  - **tier1（无 `node:child_process`/socket/长 sleep 字面量）**：S0 的解析/host 注入测试；S1 的 sampler/top/tracker/gate/parity 测试。假 `execFile`/`spawnSync`/`stat` 以函数参数注入，**不得 import `node:child_process`**。
  - **真实进程测试**（`runBounded` 超时/SIGKILL/无残留）= **S0 的交付物**，放 `tests/integration/sysload-bounded-exec.test.ts`（tier2 by 目录，**不加平台门**，Linux CI 与 mac 都跑，§4.4）；**S4 只负责** mac 专属 smoke、门控翻转、取证脚本，不拥有 S0 代码的测试。
  - 若 S0/S1 的 tier1 文件为方便出现了上述字面量，则必须登记 `TIER1_DECLARED`（kind `proc`）；**禁止**删字面量绕过扫描却仍起真进程（隐藏 spawn 规则）。

### 3.1 各包公开签名与文件域

**S0 — darwin host（protocol 层，纯新增）**

- 域：新建 `src/web-hub/protocol/sysload-darwin-parse.ts`、`src/web-hub/protocol/sysload-darwin.ts`；`tests/web-hub/protocol/{sysload-darwin-parse,sysload-darwin,sysload-darwin-contract}.test.ts`；`tests/integration/sysload-bounded-exec.test.ts`；`tests/web-hub/boundary.test.ts`（**仅新增**两条钉子）。
- `sysload-darwin-parse.ts`（**零 import**，导出）：
  ```ts
  parseVmLoadavg(text: string): readonly [number, number, number] | undefined
  parseMemorystatusLevel(text: string): number | undefined
  parseHwNcpu(text: string): number | undefined
  parseDarwinSysctl(text: string): { loadavg?: …; memAvailPct?: number; cores?: number }      // 三行独立缺失；行数≠3 ⇒ {}
  parseDarwinMount(text: string): DarwinMount[]                                               // 结构 = SamplerHostMount
  parsePsTop(text: string, maxPids: number): { procs: DarwinProc[]; truncated: boolean }      // rssBytes 已 ×1024
  DARWIN_LOCAL_FILESYSTEMS: ReadonlySet<string>
  ```
- `sysload-darwin.ts`（import 仅 `node:child_process`、`node:fs`、`./sysload-darwin-parse.js`，导出）：
  ```ts
  interface RunDeps { execFile?: typeof execFile }
  runBounded(file: string, args: readonly string[], o: { timeoutMs: number; maxBytes: number }, deps?: RunDeps): Promise<string>   // §2.4 语义
  createDarwinHost(deps?: { run?: typeof runBounded; stat?: (p: string) => Promise<{ dev: number | bigint }> }): DarwinHost   // 结构 = SamplerHost
  probeDarwinHost(deps?: { spawnSync?: typeof spawnSync }): boolean
  resolveSysloadHost(platform?: NodeJS.Platform): DarwinHost | undefined            // darwin ⇒ createDarwinHost()，否则 undefined
  ```
  无模块级可变状态（I4）；`readHost/readMounts/listProcesses/deviceOf` 内部 `try/catch → undefined`，**永不 throw**。
- 验证：`npx vitest run tests/web-hub/protocol/sysload-darwin-parse.test.ts tests/web-hub/protocol/sysload-darwin.test.ts tests/web-hub/protocol/sysload-darwin-contract.test.ts tests/integration/sysload-bounded-exec.test.ts tests/web-hub/boundary.test.ts`；`npm run typecheck`。
- **边界验收（修订 #8）**：新钉子扫描结果**不过滤 `typeOnly`**（沿用 `scanImports` 完整输出）：`sysload-darwin-parse.ts` 的 import 列表 `toEqual([])`；`sysload-darwin.ts` 的 `toEqual([{spec:"node:child_process",typeOnly:false},{spec:"node:fs",typeOnly:false},{spec:"./sysload-darwin-parse.js",typeOnly:false}])`（不得含任何 type-only 或其他 import；**不得 import 任何 `../../sysload/**`，含 type-only**）。同时必须：① 既有 sysload closure 用例（:415，`SYSLOAD_FILE_CLOSURE`）**原样绿**——证明 S1 对 sysload 文件零新增 value import；② `protocol/hub files are discovered`（`arrayContaining`，:323-336）原样保留，**不**把它当闭包保证；③ `git diff origin/dev -- tests/web-hub/boundary.test.ts | grep '^-' | grep -v '^---'` 为空（只增不删）。

**S1 — sysload 核心 seam（`src/sysload/**` 既有文件）；C0 声明者**

- 域：`src/sysload/{sampler,mounts,top,types,tracker,gate}.ts`；`tests/sysload/{sampler,mounts,top,tracker,gate,render}.test.ts`（仅**追加**用例）；新建 `tests/sysload/{darwin-sampler,darwin-top,darwin-tracker,host-contract,linux-parity}.test.ts`、`tests/sysload/compat/{sampler-v0,top-v0}.ts`（`origin/dev` 时点冻结副本，头注释「do not modernize」）。**不碰** `wire.ts`（S3 域）、`activation.ts`（S2 域）。
- 公开签名（新增/变更）：
  ```ts
  // sampler.ts：C0 类型（§2.2）；export const DARWIN_MEM_ADVISORY = true; export const HOST_MIN_BUDGET_MS = 50
  // sampleOnce 签名不变；SampleResult.sample 可带 cores?/memAdvisory?
  // mounts.ts：resolveMount(path, mounts, local?: ReadonlySet<string>)   // 默认=LOCAL_FILESYSTEMS
  // top.ts：rankTopRows(byPid: readonly RankInput[]): { byCpu: LoadTopRow[]; byRss: LoadTopRow[] }
  //         createHostTopScanner(host: Pick<SamplerHost,"listProcesses">): typeof scanTop
  // types.ts：LoadSample.cores?/memAdvisory?
  // tracker.ts：observe() 两处分支（cores 回退；memAdvisory 只记显示值）
  // gate.ts：LoadGateRequest.platform?: NodeJS.Platform；内部 topFallbackCommand(platform)
  ```
- 验证：`npx vitest run tests/sysload`；`git diff origin/dev -- src/sysload | grep '^-' | grep -v '^---'`（人工核对：除 `top.ts` aggregateTop 末段搬家外**无删除行**）；`npm run typecheck`。**零新增 value import**（`sampler/top/mounts` 的精确集合不变）。

**S2 — 装配 + 探测共享 + 装配端 platform 传入**

- 域：`src/sysload/activation.ts`；`src/web-hub/hub/{load,assembly,assembly-channels,hub,ports,http}.ts`；`src/stack.ts`（**仅** :655 `evaluateLoadGate` 选项加一行 `platform: process.platform`）；`tests/sysload/activation.test.ts`、`tests/web-hub/hub/load.test.ts`（追加；去掉 :162 平台早退，改注入 `probe`/`io`）、新建 `tests/web-hub/hub/load-probe-once.test.ts`、`tests/integration/load-stack-wiring.test.ts`（追加 platform 用例）。
- 公开签名：
  ```ts
  // activation.ts：LoadActivationDeps 追加 host?: SamplerHost（测试注入；缺省 resolveSysloadHost()）
  // hub/load.ts：hubLoadProbe(deps?: { platform?: NodeJS.Platform; probeDarwin?: () => boolean }): boolean
  //             HubLoadDeps 追加 probed?: boolean; probe?: () => boolean; io?: SamplerIo
  // assembly.ts：HubAssembly.loadProbeOk: boolean；ports.ts：FrontendDeps.loadProbed?: boolean；HubDeps.loadSeams?: { probe?: () => boolean }
  ```
- 验收第 1 条：`npm run typecheck`（兼容检查点，§3.0）。其余：`npx vitest run tests/sysload/activation.test.ts tests/web-hub/hub/load.test.ts tests/web-hub/hub/load-probe-once.test.ts tests/integration/load-stack-wiring.test.ts tests/web-hub/boundary.test.ts`。
- **隐藏 spawn 基线**（tiers 规则，S2 完成时必做）：在 mac 上临时（不提交）给 `runBounded`/`probeDarwinHost` 加 `if (process.env.PI_TOOLKIT_FORBID_SYSLOAD_SPAWN === "1") throw new Error("HIDDEN_SPAWN")`，`PI_TOOLKIT_FORBID_SYSLOAD_SPAWN=1 npm run test:tier1`，凡因此变红的 tier1 文件 = 隐藏 spawn 候选：优先给它注入 `io`/`probe` 消除；确需真实起进程者按 `TIER1_DECLARED` 登记（kind `proc`，why `hidden-spawn: …`，仿 `tests/tiers.ts:235-248` 先例）。结果表写入 `darwin-report.md`。

**S3 — mac 核数披露：wire + UI（用户 Q1 已拍板：做）**

- 触发：§2.8 的 loadavg 进度条分母（mac 无 `cpu` ⇒ 分母恒 1 核）。用户已拍板**必做**；不再保留「不做则披露」的备选。
- 域：`src/sysload/wire.ts`（`projectLoadWire`）、`src/web-hub/protocol/messages.ts`（`LoadWire.cores?: number`，顶层可选；`LoadCpuWire.busyPct` 保持 required）、`src/web-hub/ui/src/logic/load.js`（`isLoadWireLike` 增 `cores` 可选校验）、`LoadCard.vue`（分母 `cpu?.cores ?? load.cores ?? 1`）；`tests/sysload/wire.test.ts`、`tests/web-hub/ui/load-*.test.ts`（追加）。
- 规则：**仅当 `cpu` 缺席且 `sample.cores` 存在时才下发**；Linux 帧键集合与 `loadFingerprint` 字节不变（I10）。新 hub×旧 UI / 旧 hub×新 UI 均无害（可选键）。门禁：`npm run build:web && npm run check:web`（CSS 余量仅 ~330 B，本包不新增样式；JS <1 KB）。超限（CSS/JS 预算）时**回报调度方裁定**，不自行砍包或放宽预算。

**S4 — mac 真机 smoke / 门控翻转 / mem 取证**

- 域：新建 `tests/integration/sysload-darwin.test.ts`（tier2，`describe.skipIf(process.platform !== "darwin")`）、`scripts/dev/sysload-darwin-mem-observe.mjs`；既有 `tests/integration/web-hub-load.test.ts`（`IS_LINUX` 门 → `HAS_LOAD_HOST = linux || darwin`，仅翻门控，断言不改）；`tests/integration/load-threadpool-starvation.test.ts` **不翻**（依赖 FIFO 冒充挂死 statfs，linux 专属）。`tests/tiers.ts` 仅在 S2 隐藏 spawn 基线确有登记项时编辑（S4 是 tiers.ts 的唯一写者，S2 把登记清单交给 S4 提交）。
- 验证：mac 上 `npx vitest run tests/integration/sysload-darwin.test.ts tests/integration/web-hub-load.test.ts tests/integration/load-stack-wiring.test.ts`；Linux CI：darwin 用例 skipped、其余同改动前。

**S5 — 文档回写**

- 域：`docs/dev/sysload/README.md`（追加 macOS 小节）、`plan.md`（非目标/U4/§8 I1 处加「darwin 自 2026-11 起支持，见 darwin-plan.md」，不改原文其余）、`darwin-report.md`（新建：实测证据、隐藏 spawn 基线、mem 取证报告、与本方案偏差）。AGENTS.md 的 sysload 条目不动。

## 4. 测试计划

### 4.1 解析器单测（S0，tier1，纯文本 fixture，Linux CI 同跑——证明解析器正确，不证明 mac 行为）

- **`parseVmLoadavg`**：`"{ 2.35 2.36 2.38 }"` ✔；尾换行/多空格/`"{2.35 2.36 2.38}"` ✔；拒绝：无花括号（Linux 形态）、两个值、四个值、负数、`NaN`/`Infinity`/`1e999`、空串、`"{ }"`。
- **`parseMemorystatusLevel`**：`"46\n"`⇒46；`"0"`、`"100"`；拒绝 `"101"`、`"-1"`、`"46.5"`、`"46abc"`、空、`"0x2e"`。
- **`parseHwNcpu`**：`"12\n"`⇒12；拒绝 0、负、小数、`"4097"`、空。
- **`parseDarwinSysctl`**：本机真实输出 `"{ 1.65 2.14 2.28 }\n48\n12\n"` 三字段全在；单行坏 ⇒ 仅该字段缺失；行数≠3 ⇒ `{}`；CRLF。
- **`parseDarwinMount`**：本机真实 `mount` 摘录（`/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)`、`map auto_home on /System/Volumes/Data/home (autofs, …)`、`/dev/disk6s1 on /Volumes/微信 WeChat (apfs, …)`）+ 构造：挂载点含括号 `/Volumes/Foo (1)`、含 `on`、nfs、smbfs（`mounted by u`）、非法行、空行、CRLF、>1 MiB、>10 000 行 ⇒ 空。断言 fstype/mountPoint/mountOptions 与本地/远程分类；最长前缀（HOME 无独立挂载 ⇒ `/`；`/Volumes/X/foo`⇒`/Volumes/X`；`/Volumes/XY` 不匹配 `/Volumes/X`）。
- **`parsePsTop`**：本机真实首行 `"    1   0.0  20224 /sbin/launchd"`；末列含空格与括号的 Helper 路径；`rssBytes` 已 ×1024；控制字符/超长清洗；缺列/非数值行丢弃；>maxPids ⇒ `truncated:true` 且条数=maxPids；空输出。
- **host 注入测试（`sysload-darwin.test.ts`，假 `run`/`spawnSync`/`stat`，无真实进程）**：argv 与绝对路径精确；env 恰为 `{LC_ALL:"C",PATH:…}`（无继承）；**入参 `timeoutMs` 为 `0`/负/`NaN`/`Infinity`/>2000 ⇒ 方法 resolve `undefined` 且假 `run` 零调用**（#1）；非零/超时/ENOENT/超 buffer ⇒ `undefined` 不 throw；`probeDarwinHost` 合法值 true，`"101"`/空/超时/ENOENT ⇒ false，且传给 `spawnSync` 的 timeout 为 1000；`resolveSysloadHost("linux")===undefined`。
- **契约形状测试（`sysload-darwin-contract.test.ts`）**：持 C0 副本；`createDarwinHost()` 的键集合、各方法 `.length` 与 C0 一致。

### 4.2 sampler/top/tracker/gate/hub 行为单测（S1/S2，tier1，假 host，Linux CI 同跑）

- **D（`darwin-sampler.test.ts`，S1）**：
  1. 全 ok 样本：`cpu invalid`、`mem.availPct=46/usedPct=54` 且 `memAdvisory===true`、`loadavg`、`cores=12`；`/`与`~` 同 dev ⇒ 去重为一行（label `~`、`mountPath="/"`）；dev 不同 ⇒ 两行；smbfs ⇒ `skipped:"remote"` 且 `deviceOf`/`statfs` **零调用**；
  2. **预算与进程（#1）**：`plan.mono`/假 `performance.now` 令 `left()` 恰为 0 与 49 ⇒ 所有 host 方法**零调用**、`ledger` 未被取租约（`ledger.size===0`）、样本各项 invalid；`left()` 恰 50 ⇒ 调用且收到 `timeoutMs===50`；`left()` 3000 ⇒ 收到 800（≤800 的有限正整数，对每次调用断言 `Number.isFinite && >0`）；
  3. **租约释放（#1）**：host 返回挂起 promise ⇒ 到 1 s 期限样本照出（该项 invalid），`ledger.has("host:sysctl")===true`；手动 resolve 后下一微任务 `has===false`；同 key 二次取租约失败时**不调用 host**；
  4. **deviceOf 步骤（#6）**：`deviceOf`→`undefined`/reject/账本满/等待超期 ⇒ 该路径 `unresolved` 且 `statfs` 零调用、`seenMounts` 不受污染（后一路径仍可解析）；进入前 `left()<50` 或 `isCurrent()===false` ⇒ `invalid`、`deviceOf` 零调用；`deviceOf` 返回后 `isCurrent()` 翻转 ⇒ `invalid`、`statfs` 零调用；
  5. `readHost`→`undefined` ⇒ `mem invalid`、`loadavg` 缺、磁盘仍采；`plan.mountinfoText` 给定 ⇒ `readMounts` 零调用，未给 ⇒ 调一次并回传 `mountinfoText`；`io.readFileSync` 注入为「调用即 throw」⇒ 全程不读任何 `/proc` 路径。
- **T（`darwin-tracker.test.ts`，S1，M5）**：cpu 恒 invalid + disk 持续 crit ≥ sustain ⇒ overall crit 且 gating；**`memAdvisory` mem 持续 `availPct=3` ⇒ `metrics.mem.level==="unknown"`、overall 不受影响、`gating===false`，但 `metrics.mem.availPct===3`（显示值保留）**（#3）；去掉 `memAdvisory`（模拟启用）同序列 ⇒ crit 升级（可逆性）；cpu unknown + mem advisory + disk ok ⇒ overall ok；disk 全 invalid + mem advisory ⇒ overall unknown（fail-open）；`sample.cores` 在 cpu 缺席时进入 `verdict.cores`，cpu 在场时以 `cpu.cores` 优先。
- **P（`darwin-top.test.ts`，S1）**：`createHostTopScanner`：comm 聚合、`byCpu`/`byRss` ≤5、`pids` ≤8、`unitsAvailable===true`、无 `avg`；`truncated`⇒`partial:true`；**`remaining()<50` ⇒ `listProcesses` 零调用且 `partial` 空快照（#1）**；传入 `timeoutMs` 恒为有限正数 ≤1000；host 超期 ⇒ `partial` 且 `top` 租约在 host settle 后才释放；租约被占 ⇒ 空 `partial`；`projectTop` 在该快照上无 NaN。
- **G（gate/render，S1，修订 #2）**：见 §2.8 三类调用级用例。
- **H（`load-probe-once.test.ts`，S2，修订 #5）**：见 §2.6 末段；另加 `hubLoadProbe({platform:"darwin", probeDarwin})` 真/假、`platform:"win32"`⇒false、`linux` 路径原逻辑；`createHubLoad` 的 `probed:true/false` 不再调用 `probe`（计数 0）、`probed===undefined` 才调用。
- **Linux 对照（`linux-parity.test.ts`，S1，修订 #9）**：
  - `sampler-v0` 差分：同一批 Linux fixture（多核/计数回绕/缺 MemAvailable/无 PSI/远程 mount/ledger 满/symlink 未解析/重复挂载去重）分别跑 v0 与现实现（`io.host` 缺省），`toEqual` 完整 `SampleResult`，含**键集合**（断言无 `cores`/`memAdvisory` 键）；`mono`/`at` 经 `plan.mono/at` 注入（已有 seam），故确定。
  - `top-v0` 差分，**固定时钟**：`aggregateTop` 内部用 `Date.now()` 生成 `at`（top.ts:133），测试用 `vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_700_000_000_000)`，并分**两个层级**：**层级 A「完整输出逐字」**——`aggregateTop` v0 与现实现 `toEqual` 整个快照（含 `at`、`unitsAvailable`、`avg` 标志、pid 截断 ≤8、同值排序 tie-break）；**层级 B「仅排名结果」**——`rankTopRows` 的 `byCpu/byRss` 行序与 v0 `aggregateTop` 的 `byCpu/byRss` 相等（排除 `at`/`unitsAvailable`），再叠加 darwin 专有排序 tie 用例（无 v0 对应物）。两层任一红 ⇒ 提取不是纯搬家。

### 4.3 darwin 真机 smoke（S4，`tests/integration/sysload-darwin.test.ts`，tier2，`skipIf(process.platform !== "darwin")`，E-MAC）

1. `createDarwinHost().readHost()`：`loadavg` 三值有限非负且与 `os.loadavg()` 同量级（`|a−b|<5`）；`memAvailPct` 为 0..100 整数；`cores===os.availableParallelism()`。
2. `readMounts()` 含 `" on / ("`；`parseMounts` 后 `/` 为 apfs 且 ∈ `localFilesystems`；`deviceOf("/")===fs.statSync("/").dev`，且等于子进程 `stat -f %d /` 输出（子进程仅在本集成测试内）。
3. 真实 `sampleOnce({host},…)`：`cpu.kind==="invalid"`、`mem.kind==="ok"` 且带 `memAdvisory`、`disks[0]` ok 且 `freePct` 与 `fs.promises.statfs("/")` 重算值差 ≤0.5pp、`~`/`/` 去重一行（本机）、`loadavg`/`cores` 在、全程 <1 s。
4. 真实 tracker 闭环（`sustainMs=0`，3 拍）：`metrics.mem.level==="unknown"` 且 `metrics.mem.availPct` 有值；`metrics.cpu.level==="unknown"`；`verdict.level` 由 disk 决定（ok/warn/crit，不为 unknown）。
5. 真实 `createHostTopScanner(host)`：`byRss` 非空，首行 `rssBytes>0`，`comm` 非空无控制字符，耗时 <1.5 s；本进程 `node` 出现在某行 `comm`。
6. 真实 hub 段：`createHubLoad(config,{home})` 在 mac 上 `hubLoadProbe()===true`、首拍后 `latest()` 含 `mem`（`level:"unknown"`）、`cpu` 缺席；`top()` 成功；`dispose()` 后无残留 timer/子进程。
7. 翻转既有 `web-hub-load.test.ts` 的 `IS_LINUX` 门（cap 矩阵、enable/disable 矩阵、timer 生命周期、config drop 真 hub 子进程），使其在 mac 实跑；先在 mac 跑基线再翻，红则该用例保留 linux 门并在 report 记录（不放宽断言）。

### 4.3b S3 核数披露的测试（Q1，S3 交付；tier1，Linux CI 同跑）

- **`tests/sysload/wire.test.ts` 追加**：① `cpu` 缺席（`sample.cpu.kind==="invalid"`）且 `sample.cores=12` ⇒ `wire.cores===12`、无 `wire.cpu`；② `cpu` 在场（Linux 形态）⇒ **无顶层 `cores` 键**（`Object.keys(wire)` 不含），`JSON.stringify` 与改动前同输入的输出逐字相同（用内联期望字面量固定，不依赖外部 golden），`loadFingerprint` 不变；③ `cpu` 缺席且无 `cores` ⇒ 无 `cores` 键；④ `sample.cores` 为 `0`/负/`NaN`/非整数/>4096 ⇒ 不下发（投影侧自校验）。
- **契约/类型**：`tests/web-hub/contract/types.test-d.ts`（已进 `tsconfig.typecheck.json`）追加：`LoadWire["cores"]` 为 `number | undefined`（可选）；`LoadCpuWire["busyPct"]` 仍为 `number`（required，**不得**变）；`tests/web-hub/protocol/` 的 messages 模式测试（若存在 `LoadWire` 形状用例）追加带/不带 `cores` 两例。
- **UI 校验（`logic/load.js`）**：`isLoadWireLike` 接受合法 `cores`、拒绝非有限/非整数/≤0/>4096；**向后兼容**：不含 `cores` 的旧帧、含 `cores` 且无 `cpu` 的新帧均判真；`cpu` 在场时多余的 `cores` 不影响判定。
- **UI 渲染（`LoadCard`）**：loadavg 条分母 = `cpu.cores` 优先，其次 `load.cores`，最后 1：`cpu` 缺席 + `cores=12` + `loadavg[0]=3` ⇒ 条宽 25%；`cpu` 在场 ⇒ 沿用 `cpu.cores`（与改动前一致）；两者皆无 ⇒ 1 核口径（与改动前一致）。`LoadPill`/`FleetDrawer` 零改动，加快照测试证明 mac 形态帧（无 `cpu`、有 `cores`）渲染不抛、不出 CPU 段。
- **版本互通**：旧 UI（只认旧 `isLoadWireLike`，不读 `cores`）收新 hub 帧不判假（可选键）；新 UI 收旧 hub 帧（无 `cores`）行为同改动前。
- **预算**：`npm run check:web` 的 JS gzip 增量 <1 KB、CSS 零增量；超限回报调度方，不自行放宽。

### 4.4 `runBounded` 真实行为测试（S0 交付；**修订 #7**；纳入常规门禁）

- 文件：`tests/integration/sysload-bounded-exec.test.ts`（tier2 by 目录 ⇒ 无需登记；**不加平台门**；用 `/bin/sleep`，Linux/mac 都有）。**Linux CI 的 `npm run test:tier2` 即包含它（CI 已跑 tier2）**，并在 §7.1 单列命令，E-AUX 必跑（它不证明 mac 的 sysctl/ps，只证明 `runBounded` 的进程纪律）。
- 用例与证据收集方式：
  1. **SIGKILL 与 timeout 正值**：`runBounded("/bin/sleep",["31.713"],{timeoutMs:150,maxBytes:1024}, {execFile: spy})`，`spy` 包装真实 `execFile` 记录 `(args, options.timeout, child.pid)`；断言 `options.timeout===150`（正）、promise 以 `ETIMEDOUT` reject、墙钟 `<150+400 ms`；**记录的 pid 经 `process.kill(pid,0)` 轮询 ≤1 s 必须 `ESRCH`**（进程已被杀且回收）。
  2. **无残留**：用例前后各执行一次 `ps -A -o command=`（真实 ps，本文件内允许）收集含唯一标记 `sleep 31.713` 的行，断言**用例后为空**（排除并行用例/他人进程干扰：标记数字全仓唯一）。
  3. **非法 timeout 不启动**：`timeoutMs` 为 `0/-1/NaN/Infinity/5000` ⇒ 立即 reject `RangeError`，`spy` 零调用（`timeout:0` 陷阱的回归守卫）。
  4. **`maxBuffer`**：`/bin/sh -c 'yes | head -c 5000000'` + `maxBytes:1024` ⇒ reject 且进程无残留（同 2 的标记法，`sh` 命令行带唯一标记）。
  5. **正常路径**：`/bin/echo hi` ⇒ resolve `"hi\n"`；**unref**：被测 Node 子脚本（本文件内起）调用 `runBounded("/bin/sleep",["31.714"],{timeoutMs:1500,…})` 后不等待即自然退出，断言该脚本进程 **<1 s 内退出**（不被子进程句柄拖住）。
- mac 额外（E-MAC，放 §4.3 同文件）：对真实 `sysctl`/`mount`/`ps` 各调一次，断言耗时 <500 ms、`pgrep -fl "sysctl -n vm.loadavg"` 之后为空。

### 4.5 Linux 现有套件零回归策略

1. **既有断言不改**：只**追加**用例；唯一被改的既有行：`load.test.ts:162` 平台早退（改注入 probe/io）、`web-hub-load.test.ts` 的 `IS_LINUX` 门。审 diff：`git diff origin/dev -- tests/sysload tests/web-hub/hub/load.test.ts tests/integration | grep '^-' | grep -E 'expect|toBe|toEqual'` 仅这两处。
2. **冻结快照差分**（§4.2 Linux 对照，E-CI）：`sampler-v0`、`top-v0` 两层差分是 `sampleOnce` 三元化与 `rankTopRows` 提取「Linux 字节不变」的主证据。
3. **默认路径的结构性保证**：`host===undefined` ⇒ 既有 fixture 测试在 mac 上仍走 Linux 分支。
4. **门禁分工**：Linux 零回归证据只来自 CI/Linux 机（E-CI），mac 本地绿**不得**代替。CI 上 darwin 专有测试 skipped；tier1 新文件并入总数（约 +9）。
5. **边界/治理**：`boundary.test.ts` 绿且只增钉子；`tests/governance`（`bundle-parity`、`test-tiers`）绿；`activate-trace.json` 无 diff。

### 4.6 tiers 登记

- 判定依据：词法标记命中且文件在非 integration/conformance 目录 ⇒ 须 `TIER1_DECLARED`。
- S0/S1/S2 新 tier1 文件**不含**标记 ⇒ 自动 tier1，无需登记。S0 `sysload-bounded-exec.test.ts`、S4 `sysload-darwin.test.ts` 在 `tests/integration/**` ⇒ 自动 tier2。
- 隐藏 spawn：既有测试因 `resolveSysloadHost()` 默认值在 mac 上**隐式**起真实 sysctl/ps（无词法标记）⇒ 按 S2 的「隐藏 spawn 基线」逐文件消除或登记；`validateManifest` 不检测陈旧登记，靠人工前后比对表（写入 `darwin-report.md`）。
- 新增后跑 `npx vitest run tests/governance/test-tiers.test.ts` + `npx vitest list` 交叉核对。

## 5. 冻结面与门禁核对

| 项                                                                                                                           | 结论                                                                                                                                                                                                                       | 核对                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/fixtures/` 中 load 相关冻结件                                                                                         | **无**。`rg -il "sysload\|loadavg\|\"load\"" tests/fixtures` 仅命中 `preview-perf/stack-3609.ts.txt`（栈快照文本）与 `legacy-xs-v071/…/audit.ts`（无关泛词 load），与 load 展示文本无关                                    | `git diff --quiet origin/dev -- tests/fixtures/ && echo OK`                                                                                |
| A 级 off golden（`schedule-off`/`reflex-off`/`secure-off`/`fabric-*`/`compact-hint`/`bash-tools`/`agent-nested-surface` 等） | 不涉及：无新增 tool/command/hook/prompt/status/cap；`load.enabled=false`/`webHub.load=false` ⇒ 零装配                                                                                                                      | `npx vitest run tests/integration/load-stack-wiring.test.ts` + 批量 `git diff`                                                             |
| B 级 `governance/activate-trace.json`                                                                                        | **不应变化**：`stack.ts` 唯一改动是 `evaluateLoadGate` 选项里加 `platform: process.platform` 一行，非 `registerTool/registerCommand/on`；`index.ts` 零 diff。漂移 ⇒ 误动注册，须回退，**禁止** `PI_TOOLKIT_UPDATE_TRACE=1` | `npx vitest run tests/governance`；`git diff -U0 origin/dev -- src/stack.ts` 恰一行新增；`git diff --stat origin/dev -- src/index.ts` 为空 |
| 展示文本类 golden                                                                                                            | 无 load 文案 golden；`tests/sysload/{gate,render,hook}.test.ts` 的 Linux 文案断言不改（fallback 串由缺省/`"linux"` 显式钉原值）                                                                                            | §2.8                                                                                                                                       |
| `tests/web-hub/boundary.test.ts`                                                                                             | 只**新增**两条精确钉子；`SYSLOAD_FILE_ALLOWLIST`/`SYSLOAD_FILE_CLOSURE` 不改                                                                                                                                               | §3.1-S0 边界验收                                                                                                                           |
| hub 装配文件（`assembly*.ts`/`hub.ts`/`ports.ts`/`http.ts`）                                                                 | 仅新增可选字段/一次探测共享；`config.load===undefined` 时路径逐字不变（I9）                                                                                                                                                | `web-hub-load` off 用例；caps 相关既有测试（`caps-coexist`）绿                                                                             |
| I1                                                                                                                           | 子进程均异步+正数期限+SIGKILL+账本租约；唯一 `spawnSync` 为 hub 启动探针（≤1 s 常量）                                                                                                                                      | §2.4、§4.4                                                                                                                                 |
| I2 / I3                                                                                                                      | `index.ts` 零改动；`stack.ts` 仅一行选项；`initSecureDomain` 首句不动；load 为 post-guard                                                                                                                                  | diff                                                                                                                                       |
| I4                                                                                                                           | 新文件无模块级可变状态；`IoLedger` 全局沿用，不新增全局                                                                                                                                                                    | review                                                                                                                                     |
| I5                                                                                                                           | `child.unref()` + stdio unref + kill 计时器 unref                                                                                                                                                                          | §4.4-5                                                                                                                                     |
| I8                                                                                                                           | `src/sysload` 仍 pi-free 且 value-import 集合不变；protocol 新文件无 pi/无 sysload import                                                                                                                                  | boundary                                                                                                                                   |
| I9                                                                                                                           | 开关关 ⇒ 字节同改动前：`resolveSysloadHost()` 只在 `load.enabled` 的 activation / `config.load` 存在的 hub 路径被调用                                                                                                      | off 用例                                                                                                                                   |
| I10                                                                                                                          | `LoadWire`/`StatusInfo`/SSE/caps 不变；仅 S3 追加 `LoadWire.cores?`（cpu 缺席才出现）；`LoadSample` 追加字段不上 wire                                                                                                      | §3.1-S3                                                                                                                                    |
| I11 / I12                                                                                                                    | 不涉及 D8 强关项；无新 tool/skill                                                                                                                                                                                          | —                                                                                                                                          |
| 其他 Linux-only 门（spawn `probePlatform`、preview proc-fd、reaper `/proc`、schedule）                                       | 不动                                                                                                                                                                                                                       | `git diff --stat origin/dev -- src/web-hub/hub/spawn src/web-hub/hub/preview src/schedule` 为空                                            |

## 6. 风险与回滚

| ID  | 包    | 风险                                                                               | 缓解                                                                                                             | 回滚                                                                  |
| --- | ----- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| R1  | S1    | `sampleOnce` 三元化/`rankTopRows` 提取误改 Linux 行为                              | host 缺省=原表达式；v0 两层差分；diff 审「无删除行」；CI 全 Linux 套件                                           | revert S1（S2 同回滚）                                                |
| R2  | S1/S4 | `memorystatus_level` 语义未证实（本机已见 level=46 而内核压力=2）                  | **mem 仅展示不 gate**（§2.9，tracker 侧 advisory）；取证标准 P1-P5；启用另决                                     | 无需回滚（默认即安全）；启用后若误拦，翻回 `DARWIN_MEM_ADVISORY=true` |
| R3  | S0    | `ps pcpu` 为衰减均值，非差分                                                       | README 披露；不标 `avg`                                                                                          | 披露项                                                                |
| R4  | S0    | `mount` 解析歧义；保守判远程（ntfs/ufs/FUSE）                                      | 行尾括号锚定 + 用例；非白名单 ⇒ `skipped:"remote"` 可见                                                          | 同 R1                                                                 |
| R5  | S0/S1 | 子进程悬挂/堆积/泄漏；`timeout:0` 陷阱                                             | 双层闸（上游 ≥50 ms + `runBounded` 入口校验）、SIGKILL、同 key 单飞租约、unref；§4.4 真实进程门（Linux CI 也跑） | revert S2 即停采样                                                    |
| R6  | S0    | 受限沙箱缺 sysctl/ps ⇒ 采样 invalid                                                | fail-open；hub 探针失败 ⇒ 无 cap；绝对路径                                                                       | —                                                                     |
| R7  | S2    | hub 启动探针 `spawnSync` 阻塞启动；探测共享改动 hub 装配                           | ≤1 s、仅一次；`probed===undefined` 回退旧行为；`load-probe-once` 测试                                            | revert S2 的装配段                                                    |
| R8  | S4    | 翻转 `IS_LINUX` 门后暴露既有测试的 Linux 隐含假设                                  | 逐文件先在 mac 跑基线再翻；红则保留 linux 门并记录                                                               | 逐文件 revert                                                         |
| R9  | S3    | UI 预算超限                                                                        | 不加样式；JS <1 KB；超限则回报调度方裁定（Q1 已拍板必做，不自行砍包）                                            | 不合入 S3                                                             |
| R10 | 整体  | mac 当前仅 DISK 参与 gate（CPU 缺席 + mem advisory）被误解为 bug                   | README + Card 无 CPU 行 + `CPU —`；取证后再议 mem gate                                                           | —                                                                     |
| R11 | S2    | 默认 `resolveSysloadHost()` 令既有 tier1 测试在 mac 隐式起进程（隐藏 spawn）/ 变慢 | S2 隐藏 spawn 基线（`PI_TOOLKIT_FORBID_SYSLOAD_SPAWN` 临时补丁）逐文件消除或登记                                 | —                                                                     |

- 回滚顺序（倒序）：S5 → S4 → S3 → S2 → S1 → S0；**只回滚 S2**（装配）即可把 mac 恢复到「恒 unknown、hub 无 cap」的现状，Linux 全程无影响。

## 7. 验收矩阵（verifier 用；E-CI=Linux CI，E-MAC=本机 darwin 真机，E-AUX=辅助）

> 「期望」为通过判据；未执行写 NOT RUN。**E-AUX 不得签收「mac 可用」，E-MAC 不得签收「Linux 不变」。**

### 7.1 Linux 不变与常规门禁

| ID     | 契约                                                  | 命令                                                                                                                                                                                                                                                                               | 期望                                                                                | 类别               |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------ |
| C0-1   | 契约三副本一致                                        | `ext(){ sed -n '/C0:BEGIN/,/C0:END/p' "$1"; }; diff <(ext src/sysload/sampler.ts) <(ext tests/sysload/host-contract.test.ts) && diff <(ext src/sysload/sampler.ts) <(ext tests/web-hub/protocol/sysload-darwin-contract.test.ts) && echo C0-OK`                                    | 输出 `C0-OK`（三份逐字相同）                                                        | E-CI               |
| L1     | sampler/top Linux 输出不变                            | `npx vitest run tests/sysload/linux-parity.test.ts tests/sysload/sampler.test.ts tests/sysload/top.test.ts`                                                                                                                                                                        | 全绿；v0 差分 A/B 两层 `toEqual`；无 `cores`/`memAdvisory` 键                       | E-CI               |
| L2     | 既有断言未放宽                                        | `git diff origin/dev -- tests/sysload tests/web-hub/hub/load.test.ts tests/integration \| grep '^-' \| grep -E 'expect\|toBe\|toEqual'`                                                                                                                                            | 仅 `load.test.ts` 平台早退与 `IS_LINUX` 门行                                        | E-CI（人工）       |
| L3     | 源码无 Linux 表达式删改                               | `git diff origin/dev -- src/sysload \| grep '^-' \| grep -v '^---'`                                                                                                                                                                                                                | 仅 `top.ts` aggregateTop 末段搬家的删除行                                           | E-CI（人工）       |
| L4     | hub 路径 Linux 不变                                   | Linux：`npx vitest run tests/web-hub/hub/load.test.ts tests/web-hub/hub/load-probe-once.test.ts tests/integration/web-hub-load.test.ts tests/integration/load-stack-wiring.test.ts tests/integration/load-threadpool-starvation.test.ts tests/integration/load-print-mode.test.ts` | 全绿                                                                                | E-CI               |
| L5     | 冻结件/trace                                          | `git diff --quiet origin/dev -- tests/fixtures/ && echo OK`；`npx vitest run tests/governance`；`git diff -U0 origin/dev -- src/stack.ts \| grep '^+[^+]'`                                                                                                                         | `OK`；绿；`stack.ts` 恰一行新增（`platform: process.platform`）                     | E-CI               |
| L6     | 边界                                                  | `npx vitest run tests/web-hub/boundary.test.ts`；`git diff origin/dev -- tests/web-hub/boundary.test.ts \| grep '^-' \| grep -v '^---'`                                                                                                                                            | 绿；无删除行                                                                        | E-CI               |
| **L7** | **`runBounded` 真实进程门（修订 #7，Linux CI 必跑）** | `npx vitest run tests/integration/sysload-bounded-exec.test.ts`（CI 经 `npm run test:tier2` 覆盖；本地/审计单独列此命令）                                                                                                                                                          | 全绿：SIGKILL/pid ESRCH、无残留标记行、非法 timeout 零 spawn、maxBuffer、unref 退出 | E-CI（E-AUX 语义） |
| L8     | 全量门禁                                              | CI：`npm run format:check && npm run typecheck && npm run test:tier1 && npm run test:tier2 && npm run build`                                                                                                                                                                       | 全绿                                                                                | E-CI               |
| L9     | 装配面最小                                            | `git diff --stat origin/dev -- src/index.ts src/web-hub/hub/http-lan.ts src/web-hub/hub/main.ts`                                                                                                                                                                                   | 空                                                                                  | E-CI               |

### 7.2 macOS 可用

| ID  | 验收项                                                | 命令                                                                                                                                                                      | 期望                                                                                                                                                                                                                                                                                                                                                                                        | 类别                         |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| M1  | 原语真值与解析一致                                    | `sysctl -n vm.loadavg kern.memorystatus_level hw.ncpu`；`npx vitest run tests/integration/sysload-darwin.test.ts -t "readHost"`                                           | 三行输出；解析值与 `os.loadavg()`/`availableParallelism()` 同量级、level∈0..100                                                                                                                                                                                                                                                                                                             | E-MAC                        |
| M2  | 解析器与 host 单测                                    | `npx vitest run tests/web-hub/protocol/sysload-darwin-parse.test.ts tests/web-hub/protocol/sysload-darwin.test.ts tests/web-hub/protocol/sysload-darwin-contract.test.ts` | 全绿                                                                                                                                                                                                                                                                                                                                                                                        | E-CI + E-MAC                 |
| M3  | mount/dev 身份                                        | `npx vitest run tests/integration/sysload-darwin.test.ts -t "mounts"`；手验 `stat -f %d / ~`                                                                              | `deviceOf("/")` == `statSync("/").dev` == `stat -f %d /`；`/` 与 `~` 去重                                                                                                                                                                                                                                                                                                                   | E-MAC                        |
| M4  | 端到端采样                                            | `npx vitest run tests/integration/sysload-darwin.test.ts -t "sampleOnce"`                                                                                                 | `cpu invalid`、`mem ok+advisory`、盘 ok 与 `statfs` 一致、<1 s                                                                                                                                                                                                                                                                                                                              | E-MAC                        |
| M5  | 状态机（CPU 缺席、mem advisory）                      | `npx vitest run tests/sysload/darwin-tracker.test.ts`（E-CI）+ smoke `-t "tracker"`（E-MAC）                                                                              | disk 驱动 overall；mem/cpu unknown 不阻塞不 gate；全 invalid ⇒ unknown；去 advisory 可逆                                                                                                                                                                                                                                                                                                    | E-CI + E-MAC                 |
| M6  | 预算/租约/deviceOf                                    | `npx vitest run tests/sysload/darwin-sampler.test.ts tests/sysload/darwin-top.test.ts`                                                                                    | §4.2-D/P 全绿（预算耗尽零进程、正 timeout、租约 settle 后释放、deviceOf 失败不调 statfs）                                                                                                                                                                                                                                                                                                   | E-CI                         |
| M7  | top                                                   | `npx vitest run tests/integration/sysload-darwin.test.ts -t "top"`                                                                                                        | `byRss` 非空、字节合理、<1.5 s                                                                                                                                                                                                                                                                                                                                                              | E-MAC                        |
| M8  | 真实子进程纪律（mac）                                 | `npx vitest run tests/integration/sysload-darwin.test.ts -t "subprocess"`；跑完 `pgrep -fl "sysctl -n vm.loadavg"`                                                        | 无残留                                                                                                                                                                                                                                                                                                                                                                                      | E-MAC                        |
| M9  | hub 全链路                                            | `npx vitest run tests/integration/sysload-darwin.test.ts -t "hub"`；`npx vitest run tests/integration/web-hub-load.test.ts`（mac 实跑）                                   | cap `load.v1` 出现、`load` 帧含 `mem`(unknown)/无 `cpu`、`/api/load/top` 200                                                                                                                                                                                                                                                                                                                | E-MAC                        |
| M10 | 单次探测一致                                          | `npx vitest run tests/web-hub/hub/load-probe-once.test.ts`                                                                                                                | 探针调用 1 次；cap⇔服务⇔路由⇔SSE 帧一致（翻转探针与恒 false 两例）                                                                                                                                                                                                                                                                                                                          | E-CI                         |
| M11 | gate/render 文案（修订 #2）                           | `npx vitest run tests/sysload/gate.test.ts tests/sysload/render.test.ts tests/integration/load-stack-wiring.test.ts`                                                      | linux/缺省串逐字不变；darwin 为 BSD `ps` 且无 `--sort`；render 链无 ps 命令；装配端 darwin 用例绿；手验 `ps -A -r -o pid,pcpu,rss,comm \| head` 在 mac 可执行                                                                                                                                                                                                                               | E-CI + E-MAC                 |
| M12 | 隐藏 spawn 基线                                       | mac：`PI_TOOLKIT_FORBID_SYSLOAD_SPAWN=1 npm run test:tier1`（临时补丁，不提交）；`npx vitest run tests/governance/test-tiers.test.ts`                                     | 变红清单已逐文件消除或登记；`darwin-report.md` 有前后比对表；治理测试绿                                                                                                                                                                                                                                                                                                                     | E-MAC + E-CI                 |
| M13 | 其他 Linux-only 门未被误动                            | `git diff --stat origin/dev -- src/web-hub/hub/spawn src/web-hub/hub/preview src/schedule`                                                                                | 空                                                                                                                                                                                                                                                                                                                                                                                          | E-CI                         |
| M14 | 构建                                                  | `npm run typecheck && npm run format:check && npm run build`（S3 必跑：另加 `npm run build:web && npm run check:web`）                                                    | 绿（typecheck 即 §3.0 编译对接点）                                                                                                                                                                                                                                                                                                                                                          | E-MAC + E-CI                 |
| M15 | **mem 取证报告（修订 #3）**                           | `node scripts/dev/sysload-darwin-mem-observe.mjs --scenario idle\|normal\|stress`；汇总写入 `docs/dev/sysload/darwin-report.md`                                           | 报告存在，P1–P5 逐条填写（含 FAIL/未解），含原始 CSV 路径、机型与 RAM、活动监视器截图索引；**不要求全部 PASS，只要求完整**；`DARWIN_MEM_ADVISORY` 仍为 `true`                                                                                                                                                                                                                               | E-MAC（人工）                |
| D1  | **mem gate 启用决策点（后续独立决策，非本期验收项）** | 前置：M15 报告已落盘；决策输入 = 报告 P1–P5 结论表；决策人 = 用户                                                                                                         | 三种结局之一，**写回 `darwin-report.md` 的「决策」小节并注明日期**：(a) 全部 P1–P3 通过 ⇒ 翻 `DARWIN_MEM_ADVISORY=false`（单独提交，附 §4.2-T 可逆性测试与一轮 M5/M9 真机复测）；(b) 阈值不适配 ⇒ 立项 darwin 专用 `load.mem.*` 默认值（改默认值须另行评估对 Linux 默认零影响）；(c) 证据不足/未覆盖机型 ⇒ 维持 advisory。在决策记录出现之前，**任何人不得翻转常量或让 darwin mem 进 gate** | 人工（用户拍板）             |
| M16 | 人工真机                                              | 启动 hub（`webHub.enabled=true`）后打开 LoadCard / `curl -s -H 'X-PWH: 1' …/api/load/top`                                                                                 | Pill 显示 MEM（中性色）/DISK、无 CPU 段；Card 无 CPU 行；loadavg 在且进度条分母=核数（如 12 核、loadavg 3 ⇒ 约 25%，**不是**按 1 核打满）；Top 两栏有数据                                                                                                                                                                                                                                   | E-MAC（人工，截图入 report） |
| M17 | 披露核对                                              | 人工读 `docs/dev/sysload/README.md` macOS 小节                                                                                                                            | 含：CPU 缺席、mem advisory 及启用门槛、仅 DISK 参与 gate、`pcpu` 语义、mount 白名单、子进程开销、探针失败降级、loadavg 条核数来自 `wire.cores`（mac）                                                                                                                                                                                                                                       | 人工                         |
| M18 | S3 wire/UI（Q1）                                      | `npx vitest run tests/sysload/wire.test.ts tests/web-hub/ui/load-*.test.ts`；`npm run build:web && npm run check:web`；`npm run typecheck`                                | §4.3b 全绿；Linux 帧无顶层 `cores` 键且指纹不变；`LoadCpuWire.busyPct` 仍 required；构建与 gzip/CSP 预算门绿                                                                                                                                                                                                                                                                                | E-CI + E-MAC                 |

## 8. 派发顺序与待决

1. **S0 ∥ S1**（同消息并行；共享仅 §2.2 C0；任何契约变更先回报，C0-1 为红灯）；S3 在 S1 合入后可与 S2 并行。
2. **S2**（S0+S1 合入后；首要验收 typecheck）→ **S4**（真机 smoke + 门控翻转 + mem 取证）→ **S5**。
3. Conventional Commits（`feat(sysload): darwin host (S0)` 等）；不 release、不手改 CHANGELOG、不重生任何 golden；每包验收模型 ≠ 开发模型（L3 车道）；S1 的「Linux 字节不变」须由 verifier 亲跑 §7.1 L1-L3。

**已拍板（用户，2026-11-18；原「待决」全部关闭）**

- Q1 **做 S3**：`LoadWire.cores?` 顶层可选，仅 `cpu` 缺席且 `sample.cores` 存在时下发；`LoadCpuWire.busyPct` 保持 required（老前端 `isCpu` 会整帧判 false）；UI 分母 `cpu?.cores ?? load.cores ?? 1`。
- Q2 挂载身份用 `fs.promises.stat(path).dev`，不起 `stat -f %d` 子进程（§2.3/§2.5）；真机 smoke 仍用 `stat -f %d` 做一次对账（§4.3-2）。
- Q3 darwin mem **展示不 gate**，机制 = 样本 `memAdvisory` 标志 + tracker 分支（§2.9）；真机取证标准见 §2.9，验收见 M15，**启用 gate 的决策点见 D1**（后续独立决策，需用户拍板，不在本期）。
- Q4 top 用 `ps pcpu`（macOS 内核衰减均值，非两次扫描差分，**不标 `avg`**）；语义差异写入 README（M17 核对）；差分（`ps -o time=` 累计 CPU 时间两次差分）留后续，不在本期。

## 9. 与探索「依赖面清单」的并轨

探索 agent 结论已并入（逐条处置见「修订记录」后半）：落位选 protocol 并写明否决 `sysload/platform.ts` 的理由（§2.1）；tracker unknown 语义与 `LoadWire.cpu` 可选性已核实，CPU 缺席零 wire 改动成立，`cores` 只能顶层可选（§2.8/S3）；top 改走既有 `scanTop` 注入口（§2.7）；子进程纪律采用 `sched-identity.ts` 先例并明确保留租约的理由（§2.4）；`LOCAL_FILESYSTEMS` 无 apfs/hfs ⇒ 经 `host.localFilesystems` 提供（§2.3）；`tests/sysload` 40/40 在 mac 全绿，tiers 的隐藏 spawn 先例（`tests/tiers.ts:235-248`）已落成 S2 基线步骤；hub 探针链 `load.ts:84-86` / `assembly-channels.ts:175-177` / `http.ts:1295`+`:113` 已落成 §2.6 的单次共享设计。

本方案自行核对的消费面清单（供与探索清单逐项比对）：`src/sysload/*`、`web-hub/hub/load.ts`、`assembly-channels.ts`（cap 探针）、`assembly.ts`（HubAssembly）、`hub.ts`（frontendDeps 构造）、`ports.ts`（FrontendDeps/HubDeps）、`http.ts:1295`（createHubLoad）、`stack.ts:606`（createLoadActivation）、`stack.ts:655`（evaluateLoadGate）、`hook.ts:86`→`render.ts`（无 ps 命令）、UI `logic/load.js`/`LoadCard.vue`/`LoadPill.vue`（`cpu` 缺席已有守卫，仅 loadavg 条分母例外）、测试平台门（`load.test.ts:162`、`web-hub-load.test.ts` 的 `IS_LINUX`×5、`load-threadpool-starvation.test.ts:57`）。若探索清单还含本节未列的消费点，按所属文件域并入 S1/S2/S4，不新增跨域写。

## 10. 修订记录

### 第 1 轮（评审打回后修订，2026-11-18）

| 评审编号 | 严重度  | 处置                               | 落点                                                                 | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | ------- | ---------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1       | Blocker | **采纳**                           | §2.3 `hostBounded` 步骤 1-4、§2.4、§4.2-D(2)(3)/P、§4.4、§7.1 L7、R5 | 调 host 前先查 `isCurrent() && left() ≥ 50`（在取租约之前）；`timeoutMs=floor(min(800,left()))` 必为 ≥50 的有限正整数；`runBounded` 入口再校验 `isFinite && >0 && ≤2000`，非法值**不 spawn**（`timeout:0` 陷阱显式回归测试）；spawn→close 语义写明（SIGKILL 于到期、`close` 才 settle、租约 settle 后才释放、不可杀进程的有界残余）；测试：预算耗尽零进程零租约、正 timeout 且被 SIGKILL（真实进程）、租约仅在底层 settle 后释放。                                  |
| #2       | Major   | **采纳（并纠正前提）**             | §2.8、§3.1-S1/S2、§4.2-G、§7.2 M11                                   | 核对 HEAD：GNU `ps` fallback 只在 `gate.ts:63`，唯一生产调用点 `stack.ts:655`；`render.ts:33` 经 `loadDetail` 复用的是明细行而非 fallback 命令，render 链无 ps 命令（以守卫测试钉住）。平台信息由装配端 `stack.ts:655` 追加 `platform: process.platform` 传入（一行，非注册，trace 不变）；`LoadGateRequest.platform` 缺省=原 Linux 串（不依赖宿主）；gate / 装配（`load-stack-wiring` 真实 stack + defineProperty）/ render 三侧调用级测试，darwin 与 linux 各一。 |
| #3       | Major   | **采纳（选 tracker 侧 advisory）** | §1、§2.2（`memAdvisory`）、§2.3、§2.9、§4.2-T、§7.2 M15、R2、Q3      | `LoadSample.memAdvisory?: true` + `DARWIN_MEM_ADVISORY=true`：tracker 只记显示值、不 `advanceMetric`，`mem.level` 恒 unknown ⇒ 不 gate/不 hint；落选「gate 侧跳过」的理由写明。上线前门槛 = 取证标准 P1–P5（场景 idle/normal/stress、数字门槛、覆盖声明、报告落盘）；取证前只展示，启用另决。引用本机即时矛盾读数（level=46 vs 内核压力=2）作动机。                                                                                                                 |
| #4       | Major   | **采纳**                           | §2.2、§3.0、§3.1 各包签名与域、§4.1/4.4、§7.1 C0-1                   | C0 类型唯一声明处 `sampler.ts`（S1 写，`C0:BEGIN/END` 标记）、三副本逐字 + 运行时形状测试 + `diff` 门；S0/S1 不得擅自扩契约（先回报）；首个编译对接点明确为 S2（typecheck 为 S2 验收第 1 条），S0/S1 靠副本 diff + 形状测试提前暴露漂移；列出每包公开签名；测试责任：tier1（无标记，注入假 exec）归 S0/S1，`runBounded` 真实进程测试归 **S0**（`tests/integration/sysload-bounded-exec.test.ts`），S4 只管 mac smoke/翻门控/取证。                                  |
| #5       | Minor   | **采纳（选「单次探测共享」）**     | §2.6、§3.1-S2、§4.2-H、§7.2 M10                                      | 现状：`assembly-channels.ts:175` 与 `load.ts:198` 各自探测（darwin 为子进程，可能不一致）。沿用 `spawnPlatform`/`htmlEnabled` 先例：`HubAssembly.loadProbeOk` 在 `prepareHubChannels` 一次探测，cap 读它，`FrontendDeps.loadProbed` → `http.ts` → `createHubLoad({probed})`；缺省自行探测保旧行为；一致性测试（翻转探针 + 恒 false，探针仅 1 次，cap⇔服务⇔路由⇔SSE 帧）。                                                                                           |
| #6       | Minor   | **采纳**                           | §2.3「deviceOf 步骤」1-5、§4.2-D(4)                                  | 进入前 `left()<50`/`!isCurrent()` ⇒ invalid 且零调用；`deviceOf` 失败/账本满/超期 ⇒ `unresolved` 且**绝不调 statfs**、不污染 `seenMounts`；返回后再查 `isCurrent()&&left()>0` ⇒ 否则 invalid；各分支断言 `statfs` 零调用。                                                                                                                                                                                                                                          |
| #7       | Minor   | **采纳**                           | §4.4、§7.1 L7、§3.0                                                  | `runBounded` 真实行为测试作为 S0 交付、tier2 目录、不加平台门，Linux CI（`test:tier2`）常规跑，并在 §7.1 单列命令 L7；kill/无残留证据收集：spy 记录 `child.pid` + `process.kill(pid,0)` 轮询 ESRCH + 唯一标记（`sleep 31.713`）的 `ps -A -o command=` 前后比对 + unref 退出计时。                                                                                                                                                                                   |
| #8       | Nit     | **采纳**                           | §3.1-S0「边界验收」                                                  | 新钉子扫描不过滤 `typeOnly`，精确列出 import 清单且禁止任何 `../../sysload` import（含 type-only）；同时跑既有 sysload closure 用例（:415）；`protocol/hub files are discovered` 原样保留；`boundary.test.ts` diff 只增不删。                                                                                                                                                                                                                                       |
| #9       | Nit     | **采纳**                           | §4.2「Linux 对照」、§4.5                                             | `top-v0` 差分用 `vi.useFakeTimers({toFake:["Date"]})`+`setSystemTime` 固定 `aggregateTop` 内部的 `Date.now()`（该函数无 `at` 注入参数）；分层 A「完整输出逐字」/ B「仅排名结果（`rankTopRows`）」；`sampler-v0` 经现有 `plan.mono/at` 注入保证确定。                                                                                                                                                                                                                |

### 探索 agent 报告并入（第 1 轮）

| #   | 探索结论                                                                                 | 处置                                                                                                                     | 落点           |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------- |
| E1  | 落位冲突：protocol 层 vs `src/sysload/platform.ts`                                       | **选 protocol，否决 platform.ts**，两侧理由写入；读 `boundary.test.ts` 核实 sysload 方案需 4 处扩张、与 I8「只收紧」冲突 | §2.1           |
| E2  | tracker unknown 语义、`LoadWire.cpu` 可选、`busyPct` required、`cores` 只能顶层可选      | 采纳；S3 的 `LoadWire.cores?` 顶层可选；UI 对 cpu 缺席零改动（仅 loadavg 分母）                                          | §2.8、S3       |
| E3  | top 缝已现成（`scanTop` 注入口、`aggregateTop` 纯函数）                                  | **采纳并撤回上一版 `TopScanOptions.host`**；改 `createHostTopScanner` 经既有注入口；activation/hub 仅扩展默认选择一行    | §2.7           |
| E4  | 子进程纪律参照 `sched-identity.ts`；不需 io-ledger slot                                  | 采纳先例；**保留租约**（理由：进程数上界与单飞，不是线程池），并写明与探索观点的差异                                     | §2.4           |
| E5  | `LOCAL_FILESYSTEMS` 无 apfs/hfs                                                          | 经 `host.localFilesystems` + `resolveMount` 第三参；不改 Linux 集合                                                      | §2.3           |
| E6  | `tests/sysload` 40/40 在 mac 全绿；tiers 隐藏 spawn 先例                                 | 采纳；「默认路径不分流」保护该事实；S2 隐藏 spawn 基线步骤                                                               | §2.1、S2、§4.6 |
| E7  | hub probe 行号链（`load.ts:84-86`/`assembly-channels.ts:175-177`/`http.ts:1295`+`:113`） | 采纳，作为 #5 设计的依据                                                                                                 | §2.6           |

### 第 2 轮（用户拍板 Q1–Q4，2026-11-18）

| 项  | 拍板                            | 落点                                         | 说明                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | **做 S3**                       | 文首、§2.8、§3.1-S3、§4.3b、§7.2 M16/M18、§8 | `LoadWire.cores?` 顶层可选，仅 `cpu` 缺席且 `sample.cores` 存在时下发；`LoadCpuWire.busyPct` 保持 required（老前端 `isCpu` 会整帧判 false，探索已证实）；去掉「可选/可砍/不做则披露」措辞，预算超限改为回报调度方裁定；新增 §4.3b 测试（Linux 帧无 `cores` 键且指纹不变、类型契约、校验器前后兼容、LoadCard 分母、版本互通）与验收 M18。                                                                                  |
| Q2  | **`fs.stat().dev`，不起子进程** | 文首、§2.3、§2.5、§4.3-2、§8                 | 已按此设计；状态由「建议采纳」改为「已拍板」；真机对账 `stat -f %d` 保留在集成 smoke 内。                                                                                                                                                                                                                                                                                                                                 |
| Q3  | **darwin mem 只展示不 gate**    | 文首、§2.9、§7.2 M15/**D1**、§8              | 从方案 ①「装配层注入标志」、②「tracker 平台参数」、③「样本携带 `memAdvisory` + tracker 分支」中选定 ③（最小面：`sampler`/`types`/`tracker` 各一处，装配点与 `createLoadTracker` 签名零改动），并把落选理由写明；取证标准 P1–P5 与报告验收仍为 M15；**新增 D1「mem gate 启用决策点」**：报告落盘后由用户拍板，三种结局（翻常量 / 立项 darwin 专用阈值 / 维持 advisory）须记入 `darwin-report.md`，决策记录出现前禁止翻转。 |
| Q4  | **top 用 `ps pcpu`**            | §2.5、§8、§7.2 M17                           | 衰减均值语义、不标 `avg`、差分留后续均写入；README 披露由 M17 人工核对。                                                                                                                                                                                                                                                                                                                                                  |
