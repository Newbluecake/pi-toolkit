# Test-speed tiers (#27) — 不变式与残留风险

方案：`plan.md`（r3）；实施报告：`P1-report.md`（分层基础设施）、`P2-report.md`（secure 预检）、
`P3-report.md`（secure 测试侧修复）、`P4-report.md`（门禁与文档）。改任何本目录覆盖的东西前先读对应章节。

## 归属与门（D1–D4）

- **唯一来源是 `tests/tiers.ts`**（纯数据 + 纯函数，无 pi import）：`TIER2_DIRS`（`tests/integration/`、
  `tests/conformance/`）、`TIER2_FILES`（4 个目录外文件）、`SECURE_MOUNT_FILES`（17 个真实挂载文件，以 `tests/tiers.ts` 实际长度为准）、
  `TIER1_DECLARED`（带标记的 tier1 文件登记表）。`vitest.workspace.ts` 的三个 project（tier1 / tier2 /
  secure）的 include/exclude 全部由这些常量生成——**不要在 workspace 里手写 glob**，也不要在别处复制清单。
- **分区只认显式元数据**，绝不按类名（`RealHarness` 之类）或标记推断归属；标记只用来强制登记。
  两个治理门钉住它：`tests/governance/test-tiers.test.ts`（登记反例）和
  `tests/integration/test-tiers-actual.test.ts`（`vitest list` 实际集合 = 常量推导、两两不相交、并集无漏）。
- `npm test` 仍是全量（三 project 并集）；日常 `npm run test:tier1`；发版与 CI 走 tier1 → tier2；
  secure 单跑 `npm run test:secure`。`test:tier2` = tier2 + secure 两个 project。

## 不变式

1. **发版门禁不削弱（D6）**：release.sh 第 5 步先 `test:tier1` 再 `test:tier2`（worker 数照旧，
   `env -u PI_TOOLKIT_SECURE_PREFLIGHT -u PI_TOOLKIT_SECURE_PREFLIGHT_FAKE` 清掉继承的预检开关/注入）。
   任一失败都打印分诊提示并以非零码退出，**不进入提交/tag**；分诊只能把红判为 flake（复跑绿 ⇒ 重跑
   release），不能绕过中止。stub-npm 用例（`tests/release/release-script.test.ts`）钉住三种路径。
2. **tier1 的 timing 豁免有边界（§6 已定）**：`TIER1_DECLARED` 中 `kind:"timing"` 的文件失败按 Tier 2
   分诊（单文件复跑）；其余 tier1 失败一律按真 bug。分诊不改变 release.sh 的中止行为。
3. **CI 覆盖面不变（D7）**：tier2 步骤条件 `!cancelled() && (steps.tier1.outcome == 'success' ||
outcome == 'failure')` —— 只有 tier1 确实执行过才跑；npm ci / 构建失败 ⇒ tier1 被跳过 ⇒ tier2 不跑。
   runner 上无 FUSE，real-mount 套件继续自跳过（现状）。
4. **secure 预检四态（D8–D11）**：`tests/secure/preflight.ts` 的 `secureEnvVerdict` 是纯函数、输入全可注入；
   globalSetup 每个正常出口都先 `provide("secureEnv")`；内部异常一律转 `preflight-error` dirty（失败即关闭）；
   worker 拿不到 inject 结论 ⇒ 抛错。incapable（无 FUSE/二进制）与 disabled（`PI_TOOLKIT_SECURE_PREFLIGHT=0`，
   只关启动预检）与现状逐字节一致；dirty ⇒ 文件级 `beforeAll` 抛 `[secure-preflight]` 并给修复命令。
   **预检失败是环境问题**：修好再跑，绝不按 flake 放行；发版/跑 secure 前先卸载自己的保险库
   （`pi-secure lock <name>` / `fusermount3 -u <mnt>`）。
5. **运行锁（D11）**：`/tmp/pi-toolkit-secure-tests-<uid>.lock`（字面 `/tmp`，不随 TMPDIR），打开前校验
   `/tmp` root+sticky、锁文件是普通文件、owner 是当前 uid、无 group/other 写位；复用
   `acquireGocryptfsTestLock`（holder 带 pdeathsig，随 vitest 主进程死）。每套件锁 `GOCRYPTFS_TEST_LOCK`
   的位置不动。
6. **不静默 skip（D14）**：`awaitNoForeignGocryptfs`（`tests/secure/private-real-harness.ts`）60 s 后抛错
   并列出外来挂载，不再 `ctx.skip()`；同一文件第一次超时后，后续调用立即抛错（模块级记忆）。**所有
   real-mount 文件都必须用这一份导出**，不得再写本地副本。
7. **I5**：预检/分层代码零计时器（无 `setTimeout`/`setInterval`）；锁持有者是子进程。
8. **不动断言与 golden**：`tests/fixtures/**` 冻结；预检只拦「开始跑」，不改任何用例的断言语义。

## 残留风险

- **过渡期不受锁保护**：升级前（#27 之前）的测试代码不拿运行锁。旧进程 × 新进程并发时，
  跨轮互斥不生效——直到所有跑测试的机器/检出都升到新代码。期间避免新旧两轮 secure 并发。
- **#28 产品侧符号链接 bug（已修）**：`<dir>` 词法链含符号链接时，普通挂载以词法 cipher 传给 gocryptfs，判定却用物理路径 ⇒ 自有挂载全判 foreign、unlock/lock 卡死。修复与边界（检测能力 R1/R2/R3、cipher 物理祖先链裁定 (ii)）：`docs/dev/secure-symlink/plan.md`（r3）；测试侧缓解（D15/D16：E2E_ROOT 取 realpath、REPO 用 layoutRoot）保留；`TMPDIR` 指向符号链接时预检仍判 `symlinked-tmpdir`（预检判定的现状保留）——把 TMPDIR 设成物理路径再跑。
- **词法登记门会漏判**：D4 只认字面标记（`node:child_process` import、`.listen(`、≥1 s 的
  `setTimeout` 字面量、mount 关键字）。时长写在变量里、经 helper 间接 sleep/spawn、真实 I/O 慢
  （例：`tests/workflow/m34-script-api.test.ts` 曾负载超时但无任何标记）都会漏。**新增测试的分类
  必须人工复核**，不得宣称机械门覆盖全部慢/环境敏感测试。
- **collection 期自 skip 的文件不吃预检失败**：环境门控到 collection 期自 skip 的文件（如自门控
  conformance）在 dirty 下仍是 skipped、退出码 0——它们本来也不会跑用例，不产生假绿；global 的
  `[secure-preflight]` 打印照常出现。
- **旧进程残留挂载**：kill 全量测试后检查 `/proc/self/mountinfo` 的 gocryptfs 残留并对测试自己的
  临时目录精确 `fusermount3 -u`；残留会让下一轮预检直接 dirty（这是设计行为，不是误报）。

## 日常命令

```sh
npm run test:tier1                                  # 日常门禁（约 4–5 min @4 workers）
npx vitest run tests/integration/foo.test.ts        # 改动的 tier2 文件单独跑
PI_TOOLKIT_TEST_WORKERS=1 npm run test:secure       # 改 secure 时（独占本机 + 干净挂载表）
npm test                                            # 全量（发版/CI 语义）
```
