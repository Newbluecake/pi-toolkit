# sysload macOS（Darwin）支持 — 实施报告（S0-S5）

> 依据：`darwin-plan.md`（方案第 1 轮修订版，§7 验收矩阵 / §8 已拍板 Q1-Q4）。本文记录 S0-S4 的交付、实测证据、偏差登记与已知遗留；事实源回写见 `README.md`「macOS（Darwin）支持」小节。
> 证据类别口径（darwin-plan §7）：**E-MAC** = mac 真机运行；**E-CI** = Linux CI；E-MAC 不得签收「Linux 不变」，E-CI 不得签收「darwin 可用」。

## 1. 版本与执行环境（全部 E-MAC 在此环境取得）

- 机型 Mac18,1（Apple Silicon），macOS 27.0，物理内存 16 GiB，逻辑核 12（`os.cpus().length === 12`）。

## 2. 包交付记录（分支 `feat/schedule-darwin`，S0-S4 全部合入）

| 包  | commit                            | 内容                                                                                                                                                                                                              |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0  | `8503dbd`                         | darwin host 原语与解析器（protocol 层：`runBounded`/`probeDarwinHost`/`resolveSysloadHost` + `sysload-darwin-parse.ts` 纯解析函数族）+ boundary 精确钉子 + 真实进程纪律测试（`sysload-bounded-exec.test.ts`）     |
| S1  | `284710b` + `12deabf` + `300b136` | sysload 核心 seam：C0 类型声明（`sampler.ts`）、`sampleOnce` hostBounded 三元分支与 deviceOf 步骤、`resolveMount` 第三参、`rankTopRows` 提取、tracker `memAdvisory`/cores 分支、gate `platform`（+ 两轮评审修正） |
| S2  | `3db0848`                         | 装配：`resolveSysloadHost()` 两个生产装配点 + hub 探测一次性共享（`ctx.loadProbeOk`）+ `stack.ts` 的 `evaluateLoadGate` 选项追加 `platform: process.platform` 一行                                                |
| S3  | `859d525`                         | `LoadWire.cores?` 顶层可选（仅 cpu 缺席时下发）+ UI loadavg 条分母 `cpu?.cores ?? load.cores ?? 1`                                                                                                                |
| S4  | `c82280a`                         | mac 真机 smoke（`sysload-darwin.test.ts`）+ `web-hub-load.test.ts` 门控翻转 + mem 取证脚本 `scripts/dev/sysload-darwin-mem-observe.mjs`                                                                           |
| S5  | 本提交                            | 文档回写（README macOS 小节、`plan.md` 三处指引、本报告）                                                                                                                                                         |

## 3. 验收证据摘要（E-MAC，mac 真机；对应 darwin-plan §7.2 各条）

> 以下数字均为本机实测值，不是判据门槛；判据本身见 darwin-plan §7.2。

- **M1 原语真值**：`sysctl -n vm.loadavg kern.memorystatus_level hw.ncpu` 实测输出 `⇒ {1.37 1.56 2.28} / 59 / 12`（loadavg 三值 / memorystatus_level / ncpu）；`cores === 12 === os.cpus().length`；`memAvailPct` 为 0..100 整数。
- **M3 mount/dev 身份**：`/` 与 `~` 同 APFS 容器 ⇒ `deviceOf` 返回同一 dev（16777233），连续多次调用稳定；`mount` 子进程 <500 ms。
- **M4 端到端采样**（真实 `sampleOnce({host})`）：`cpu.kind === "invalid"` 恒 unknown；`memAdvisory === true` 且 `usedPct = 100 − availPct`；`~` 与 `/` 同 dev ⇒ 去重单行。
- **M5 状态机（CPU 缺席、mem advisory）**：crit 压力的 advisory mem 样本（`availPct = 3`）⇒ `metrics.mem.level === "unknown"`、显示值保留（availPct 可读）、`overall` 仅由 disk 驱动（ok）、`gating === false`；`gateLevel = "warn"` 下 crit mem 同样不 gate；全部 invalid ⇒ overall unknown（fail-open）。
- **M7 top**：真实 `createHostTopScanner(host)`（`ps -A -o pid=,pcpu=,rss=,comm=`）⇒ `byRss` 非空、pid 均正整数、`cpuPct ∈ [0, 1200]`（单核%、内核衰减均值可 >100）、`rssBytes > 0`；vitest 进程标题被内核改写为 `"node (vitest 1)"` ⇒ 断言按 pid + 非空 comm 落（不以 comm 字面量匹配测试自身）。
- **M8 子进程纪律**：各原语 <500 ms（整个 smoke 文件 8 用例共 267 ms）；跑后 `pgrep` 无残留进程；`probeDarwinHost() === true`。
- **M9 hub 全链路**：首帧 `v:1`、**无 `cpu` 键**、`cores = 12`、`mem` level unknown + availPct 有值；`dispose()` 干净（无残留 timer/子进程）。
- **M11 gate/render 文案**：darwin 拒绝文案为 BSD `ps -A -r -o pid,pcpu,rss,comm | head`（无 `--sort`）；linux/缺省串逐字不变（E-CI 同跑）。
- **mem 取证（S-idle 场景，30 拍 × 2 s）**：`kern.memorystatus_level` 稳定在 58-60，与 `memory_pressure` 的 System-wide free percentage 高度一致（58↔58 拍）；`vm_stat` free/inactive/speculative/purgeable（freeish 池）约 30-34%。
  - **P1 无假阳性**：level > 15 占比 100%（30/30 拍）、level ≤ 8 违例 0 拍。
  - **P2 真阳性**：`vm_pressure_level ≥ 2` 共 0 拍（S-idle 本不含压力，**真阳性未证**，需 S-stress 补测，见 §5）。
  - **P5 矛盾解释**：level 与 `vm_pressure_level` 矛盾拍 0（此前方案期观察到的单点矛盾 level=46 vs pressure=2 未在本轮复现，仍以待解释项身份留在取证标准里）。
- **M12 隐藏 spawn 基线（S2 交付）**：方法 = 临时（不提交）给 `runBounded`/`probeDarwinHost` 加 `PI_TOOLKIT_FORBID_SYSLOAD_SPAWN === "1"` 抛错补丁，`PI_TOOLKIT_FORBID_SYSLOAD_SPAWN=1 npm run test:tier1` 的 canary 与 control 全量对照；**canary−control 差集为空** ⇒ 无 tier1 文件隐式起 darwin 子进程；`tests/tiers.ts` 登记清单空（未动）。
- **Linux 不变（E-CI）**：由 CI 提供——`sampler-v0`/`top-v0` 两层差分（`tests/sysload/linux-parity.test.ts`）+ 全套既有套件 + 冻结件字节核对；分支 push 后核对 `format:check → typecheck → test:tier1 → test:tier2 → build` 全绿（darwin 真机项显示 skipped，不计入 Linux 证据也不得误记为 Darwin 验证）。`runBounded` 进程纪律（`sysload-bounded-exec.test.ts`）Linux CI 实跑（E-AUX 语义：不证明 mac 的 sysctl/ps，只证明进程纪律）。

## 4. 偏差登记表（与 darwin-plan 文字的逐项差异）

| #   | 偏差                                                                                                                                                                                                   | 处置 / 口径归属                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `runBounded` **不传** `execFile` 的 `options.timeout`（S0 追认）：Node 该选项由内部 **ref'd 定时器**实现，会把进程拖到 deadline 才退出，与 I5 冲突（实测 Node v26：传 `timeout:5000` 空闲进程活 5 s+） | 改由 `runBounded` 自身 **unref'd** SIGKILL 计时器执行期限；plan §4.4-1 的 `options.timeout===150` 断言改为等价验证（`"timeout" in options === false` + ETIMEDOUT + pid 被 SIGKILL/回收）；入口硬校验有限正 timeout 不变（`timeout:0` 陷阱仍关） |
| 2   | memAdvisory 语义（S1 评审收敛，`300b136`）：从「可信读数才清等级」收敛为「**无条件清等级**、仅可信读数刷新显示值」（`recordAdvisoryMem`）                                                              | 更安全的口径：advisory 期间 `mem.level` 恒 unknown（不会因一次可信读数把未知等级复活参与 overall）；可逆性测试口径不变（去 advisory ⇒ 同一数据走 Linux 同路径正常升级）                                                                         |
| 3   | `GET /api/load/top` ⇔ SSE 的全链 socket 断言（plan §2.6 末段）由 tier2 `tests/integration/web-hub-load.test.ts` 覆盖，tier1 只钉 `caps`/`loadProbed`/`createHubLoad` 三接缝（S2 §4.2-H 披露）          | tier1 不起真实 socket（`load-probe-once.test.ts` 用翻转探针 + 注入）；全链证据类别为 E-MAC/E-CI 的 `web-hub-load`，不降级为 tier1 替身证据                                                                                                      |
| 4   | M15 全量取证**未完成**（仅 S-idle 30 拍；S-normal/S-stress/P3 恢复观察待补）；D1 决策点（darwin mem 何时从只展示升级为参与 gate）未到（S4 遗留）                                                       | `DARWIN_MEM_ADVISORY` 保持 `true`；按 darwin-plan §7.2 M15「报告存在且逐条填写（含 FAIL/未测）即过验收」的口径，本期验收不受影响；补测计划见 §5                                                                                                 |

## 5. 遗留与后续

- **M15 mem 取证补测计划**（脚本已交付：`scripts/dev/sysload-darwin-mem-observe.mjs`，只读 + 受控分配，不进发布面；原始 CSV 落 **os tmpdir**，`--csv` 可改路径）：
  - **S-normal**：常规开发负载（编辑器 + 浏览器 + 构建）15 min；
  - **S-stress**：node 分配并触碰 50 / 70 / 85 / 92% 物理内存（`hw.memsize`）各持 3 min，释放后观察 ≥2 min（防交换风暴中止条件：`vm.swapusage` 增长超 4 GiB 或系统卡顿即中止并记录）；补 **P2 真阳性**（凡 `vm_pressure_level ≥ 2` 的步骤 `level ≤ 15` 出现、达 4 时 `level ≤ 8` 出现）与 **P3 恢复**（释放后 120 s 内 level 回 S-idle 基线 ±10pp）。
  - 覆盖声明：取证只代表已测机型/RAM（Mac18,1 / 16 GiB）；未测机型保持 advisory。
- **D1 决策点**（darwin-plan §7.2 D1，用户拍板，非本期验收项）：M15 报告齐备后三选一—— 翻 `DARWIN_MEM_ADVISORY = false`（单独提交，附 §4.2-T 可逆性测试与一轮 M5/M9 真机复测）； 阈值不适配 ⇒ 立项 darwin 专用 `load.mem.*` 默认值； 证据不足/未覆盖机型 ⇒ 维持 advisory。**决策记录落盘前，任何人不得翻转常量或让 darwin mem 进 gate**；决策结果与日期回写本节。
- **top 差分口径**（Q4 已拍板留后续）：macOS `ps -o time=` 累计 CPU 时间两次差分作为 `pcpu` 衰减均值的替代/对照口径，未测、不在本期。
