# Test-speed tiers (#27) — 不变式与残留风险

方案：`plan.md`（r3）；实施报告：`P1-report.md`（分层基础设施）、`P2-report.md`（secure 预检）、
`P3-report.md`（secure 测试侧修复）、`P4-report.md`（门禁与文档）。改任何本目录覆盖的东西前先读对应章节。

## 归属与门（D1–D4）

- **唯一来源是 `tests/tiers.ts`**（纯数据 + 纯函数，无 pi import）：`TIER2_DIRS`（`tests/integration/`、
  `tests/conformance/`）、`TIER2_FILES`（4 个目录外文件）、`SECURE_MOUNT_FILES`（18 个真实挂载文件，以 `tests/tiers.ts` 实际长度为准）、
  `TIER1_DECLARED`（带标记的 tier1 文件登记表）。`vitest.workspace.ts` 的三个 project（tier1 / tier2 /
  secure）的 include/exclude 全部由这些常量生成——**不要在 workspace 里手写 glob**，也不要在别处复制清单。
- **分区只认显式元数据**，绝不按类名（`RealHarness` 之类）或标记推断归属；标记只用来强制登记。
  两个治理门钉住它：`tests/governance/test-tiers.test.ts`（登记反例）和
  `tests/integration/test-tiers-actual.test.ts`（`vitest list` 实际集合 = 常量推导、两两不相交、并集无漏）。
- `npm test` 仍是全量（三 project 并集）；日常 `npm run test:tier1`；发版与 CI 走 tier1 → tier2；
  secure 单跑 `npm run test:secure`。`test:tier2` = tier2 + secure 两个 project。

## 不变式

1. **发版门禁不削弱（D6）**：release.sh 第 5 步先 `test:tier1` 再 `test:tier2`（worker 数照旧，
   `env -u PI_TOOLKIT_SECURE_PREFLIGHT -u PI_TOOLKIT_SECURE_PREFLIGHT_FAKE` 保留清理旧环境变量的防御（正式入口已忽略它们））。
   任一失败都打印分诊提示并以非零码退出，**不进入提交/tag**；分诊只能把红判为 flake（复跑绿 ⇒ 重跑
   release），不能绕过中止。stub-npm 用例（`tests/release/release-script.test.ts`）钉住三种路径。
2. **tier1 的 timing 豁免有边界（§6 已定）**：`TIER1_DECLARED` 中 `kind:"timing"` 的文件失败按 Tier 2
   分诊（单文件复跑）；其余 tier1 失败一律按真 bug。分诊不改变 release.sh 的中止行为。#47c 的全 tests 挂钟审计把仍需真实调度/磁盘/进程的
   latency、性能和 deadline 上界也显式登记为 timing（即使没有字面 ≥1 s sleep）；保留原阈值，
   不把纯可控 Promise/假 fs 的 deadline 文件纳入豁免：先用进入步骤的 deferred 信号配合虚拟钟检查 D−1/D、abort 与迟到回收，撤回这些文件的新增 timing；原 proc/剩余词法标记仍须登记。CPU sentinel 拆入独立 `.perf.test.ts` 并保留原阈值（stderr push、connection send、preview 扫描），主行为文件继续是硬门。混合真实 CPU 门与假钟预算的文件（如 graph/budget）仍按文件整体登记 timing，不声称断言级分诊；其中所有确定性断言照常执行、失败仍中止门禁。能用队列状态、SQL 路径、字节/操作预算证明的断言优先改为
   确定性行为门；真实 IO 的超时上界不是可移植性能 SLA。登记理由在 `tests/tiers.ts` 的 `why`。
3. **CI 覆盖面不变（D7）**：tier2 步骤条件 `!cancelled() && (steps.tier1.outcome == 'success' ||
outcome == 'failure')` —— 只有 tier1 确实执行过才跑；npm ci / 构建失败 ⇒ tier1 被跳过 ⇒ tier2 不跑。
   runner 上无 FUSE，real-mount 套件继续自跳过（现状）。
4. **secure 预检（D8–D11，2026-11-13 政策）**：`secureEnvVerdict` 为可注入纯判定；正式入口
   忽略旧 `PI_TOOLKIT_SECURE_PREFLIGHT=0` / `PI_TOOLKIT_SECURE_PREFLIGHT_FAKE`，不设新后门。
   incapable 保留原自门控；clean 严格运行；仅外部 `fuse.gocryptfs` 是唯一阻塞原因时 external-mounts
   整组显式 skip（18 文件，含 fake/unit 块，**mount coverage NOT RUN**）；其余或混合错误 dirty/fail。
   globalSetup dirty 在抛错前释放运行锁，clean/external 交给 teardown 释放；provide 失败也释放。
   缺 inject/坏 schema 由 setup 与 secure 专属 runner fail-closed，runner 文件级失败不依赖 beforeAll，
   所有文件 collection 自 skip 也必须 exit 非零，且不执行 fixture/cleanup。
   `/proc` 枚举故障、意外 I/O、子进程启动错误不能当 unavailable；逐进程 ENOENT/ESRCH 是退出竞态，
   权限 census 是 note。其它错误优先于外部-only skip，不按 flake 放行；修复报告条件再跑。
5. **运行锁（D11）**：`/tmp/pi-toolkit-secure-tests-<uid>.lock`（字面 `/tmp`，不随 TMPDIR），打开前校验
   `/tmp` root+sticky、锁文件是普通文件、owner 是当前 uid、无 group/other 写位；复用
   `acquireGocryptfsTestLock`（holder 带 pdeathsig，随 vitest 主进程死）。每套件锁 `GOCRYPTFS_TEST_LOCK`
   的位置不动。
6. **运行期不静默 skip（D14）**：`awaitNoForeignGocryptfs`（`tests/secure/private-real-harness.ts`）60 s 后抛错
   并列出外来挂载，不再 `ctx.skip()`；同一文件第一次超时后，后续调用立即抛错（模块级记忆）。**所有
   real-mount 文件都必须用这一份导出**，不得再写本地副本。
7. **I5**：预检/分层代码零计时器（无 `setTimeout`/`setInterval`）；锁持有者是子进程。
8. **golden 冻结**：`tests/fixtures/**` 不动。XC2 修正为 flags 集合+无重复，保留拒绝合同；
   精确 diriv 0440 只约束 1.8.x，其它受支持版本仅跳独立 mode 用例，未知/失败/过旧版本必须 fail。
   其余严格断言不减，工具 init/mount/version 均同一绝对 binding。详见 secure README。
9. **报告与未验证边界**：默认 reporter 显式 skipped files/tests 与原因；JSON assertion status 和
   `meta.securePreflightSkip` 携带真实原因（toy workspace 已断言），passed tests 为零。
   Vitest 2.1.9 内置 JSON suite aggregate / file status 不表达 skipped，不能据其 passed suite 统计
   宣称真实 mount pass。collection 仍发生；skip 不运行 fixture/cleanup。无挂载门不替代另获授权的真实门。
10. **隔离 Git fixtures 允许**：Tier1 既有测试可在自建临时目录内 init/commit；不能改主仓 Git 状态。

## 残留风险

- **过渡期不受锁保护**：升级前（#27 之前）的测试代码不拿运行锁。旧进程 × 新进程并发时，
  跨轮互斥不生效——直到所有跑测试的机器/检出都升到新代码。期间避免新旧两轮 secure 并发。
- **#28 产品侧符号链接 bug（已修）**：`<dir>` 词法链含符号链接时，普通挂载以词法 cipher 传给 gocryptfs，判定却用物理路径 ⇒ 自有挂载全判 foreign、unlock/lock 卡死。修复与边界（检测能力 R1/R2/R3、cipher 物理祖先链裁定 (ii)）：`docs/dev/secure-symlink/plan.md`（r3）；测试侧缓解（D15/D16：E2E_ROOT 取 realpath、REPO 用 layoutRoot）保留；`TMPDIR` 指向符号链接时预检仍判 `symlinked-tmpdir`（预检判定的现状保留）——把 TMPDIR 设成物理路径再跑。
- **词法登记门会漏判**：D4 只认字面标记（`node:child_process` import、`.listen(`、≥1 s 的
  `setTimeout` 字面量、mount 关键字）。时长写在变量里、经 helper 间接 sleep/spawn、真实 I/O 慢
  （例：`tests/workflow/m34-script-api.test.ts` 曾负载超时但无任何标记）都会漏。**新增测试的分类
  必须人工复核**，不得宣称机械门覆盖全部慢/环境敏感测试。
- **collection 自 skip 不豁免错误**：正式 global dirty 在 workers 前终止；runner 对缺失/坏 schema/dirty
  写文件级真实失败结果，即使全体 describe 自 skip 也不可能 exit0。外部-only 不抹 collection 错误。
- **旧进程残留挂载**：在正式启动采样时也是“非本轮创建”，若仅此原因则整组 skip，不能自动清理。
  clean 启动后出现的外部挂载仍由 D14 等待有界后失败；不得追溯称整组 skipped。

## 测试工具绑定的无挂载门

`tests/secure/real-tool-path.test.ts` 显式列入 `TIER2_FILES`：只执行自有临时 marker 程序，
不属于真实挂载 `SECURE_MOUNT_FILES`；原有文件归属不变。覆盖 per-file 不可变 gocryptfs binding、
独立 0700 单名 bridge、fake-pi 优先、显式 PATH/坏 binding 无自动补齐，以及 fake-sync 和隔离
missing-getfattr。真实 fixture 的固定 PATH 只桥接选定 gocryptfs，不能把整个用户工具目录带入，
也不能把 bridge 失败改为依赖 skip；详见 [secure README](../data-encryption/README.md#真实挂载测试的工具路径绑定测试侧)。

受限无挂载验收仅运行 marker 与纯合成治理门、typecheck、定向 format；`convert-preflight` 的
产品 69 用例虽是注入 ports/context，其共用 fixture 在 import 时仍扫描真实 `/proc`，不能靠
`-t` 当作纯合成门。`private-real-harness.test.ts` 的 cleanup 遍历真实 `/proc`，也不能当作
仅访问 self/自建子进程的门。本轮可静态核对既有断言及未改文件，不能报告为本轮执行 PASS。
`test-tiers-actual` 只启动 `vitest list --filesOnly` 检查三个分区，不收集/运行真实挂载文件。
无挂载门通过不替代另行授权、独占机器上的正式 secure 项目运行。

## 真实子进程启动 barrier（#47d）

`tests/integration/helpers/process-startup.ts` 提供单次冷启动共享的 30s 单调钟预算：
spawn/ready/live 多阶段不重置预算。经已有 spawn seam 观察每个 singleton contender，
只有全部退出才早失败（exit/error 事件；managed grandchildren 用自有 spawns.json / bash_job status 的终态，
25ms 采样，不把记录缺席当退出）。失败附每个 pid/exit/signal 和先脱敏再按 UTF-8 截断的
stderr；managed 磁盘未记录的字段明确为 unknown，不猜测、不扫描或 signal 现场进程。
XS harness 继续原预算与行为，仅复用抽出的 sanitizer。进程已经 ready 之后的协议事件、
pid 持久化、清理/退出、register timeout 等非冷启动门保持原上限；实际 >15s 的旧启动屏障本身不改，
但其外层用例预算必须完整容纳这些旧预算。

返工约束：helper 导出 `PROCESS_STARTUP_MS`（30s）、`startupBudget(serialBoots, perBootMs)` 和
`STARTUP_MARGIN_MS`（30s）。消费用例的外层 timeout 使用预算表达式：串行相加、并行取关键路径，
同一 boot 的 ready/live 不重复加；terminal launcher 的父 peer 与内嵌 hub 属于同一外层启动路径，
不机械相加。headless 原有 `15_000 * SLOW` hub 启动仍按 45s 计；restore 的既有 75s/90s
live 门也按其原预算计入。额外余量为明确有限的 setup/协议/退出步骤留空间，而不是改其事件上限。
常规余量 30s；A9 65s（pid/stopping/退出/恢复删除）、H5 150s（三轮 UI/停止及坏头终态）、
rollback dirty 100s（包含原 65s 孤儿退出门）；wiring 保留原总计 300s。

`process-startup.test.ts` 的独立清单对 57 个注册点做 AST timeout 算术检查（含 `it.each` 和 options
写法），不运行被扫描的测试、不 eval 源码：外层预算须 ≥ 启动关键路径 + 清单中的有限余量，
且有界（最多 900s；多轮 legacy restore 的真实预算大于 300s，但外部运行命令仍可用 300s 截停）。
H9a 另以可注入的 `perBootMs=35_000` 缩放算术模型验证 3×35s+30s，不用长 sleep 造负载。
loser/winner 用真实 IPC child + 假钟推进退出采样，在放行 winner ready 前明确经历一次 loser
已退出的检查，保证 `ended.every`→`some` 变异确定性失败。

firstPrompt delivery、closure SSE live、H5 三种巨大 UI 的协议观察之前，先用该次 POST 起算的共享
managed startup 等 live（生命周期早失败 + 安全 stderr）；随后原 15s/1.5s 协议/latency 门不变。
T8 healthy fork 则把 `.privacy-entry.json` 作为 child 执行入口 ready 事件，以 POST 前创建的同一预算
观察私有 spawns.json 终态和 spawn stderr；故障路径仍按原拒绝合同，不等待不存在的 child。
刻意触发坏协议头的分支只观察原终态门，不等待可能已消失的瞬态 live（否则会与正确退出竞态）。

## 日常命令

```sh
npm run test:tier1                                  # 日常门禁（约 4–5 min @4 workers）
npx vitest run tests/integration/foo.test.ts        # 改动的 tier2 文件单独跑
PI_TOOLKIT_TEST_WORKERS=1 npm run test:secure       # clean 严格运行；仅外部挂载则整组 skip，覆盖未运行
npm test                                            # 全量（发版/CI 语义）
```

## Required corresponding-directory gate

Before committing changes under `src/fabric/**`, `src/memory/**`, `src/web-hub/**`, or `src/schedule/**`, run the entire corresponding `tests/fabric`, `tests/memory`, `tests/web-hub`, or `tests/schedule` directory, respectively. Running only individual test files does not satisfy this gate.
