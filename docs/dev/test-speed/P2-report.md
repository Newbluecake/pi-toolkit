# #27 P2 报告 — secure 预检

基线 HEAD `5c11d443`（dev，即 P1 提交）。范围：plan r3 §1 D8–D12（D12 属 P2 的部分：不加开关、不改用例）、§2「P2」、§3 中属于 P2 的验收（③ 场景按 r3-1 裁定）。用户拍板（2026-11-05）：secure 环境不干净（另一轮在跑 / 任何 gocryptfs 挂载含用户自己的保险库 / scratch 根是符号链接等）**立刻失败并给修复提示**；缺依赖（无 gocryptfs / FUSE）仍按现状自跳过；不加绕过不可检查进程确认门的开关。

## 改动文件

- `/home/bluecake/ai/pi-toolkit/tests/secure/preflight.ts`（新）— 预检核心：`SecureEnvVerdict`（四态 + reasons/notes，纯 JSON 可序列化，经 `provide("secureEnv")` 过 RPC）、纯函数 `secureEnvVerdict`（D9/D10 全矩阵，输入全可注入）、`gocryptfsMountPoints`（mountinfo 解析 + `\040` 等转义还原）、`tmpRootUnsafe` / `runLockFileUnsafe`（D11 校验矩阵）、`runLockPath(uid)`（字面 `/tmp/pi-toolkit-secure-tests-<uid>.lock`）、`prepareRunLock`（不存在则以 0600 `wx` 创建；已存在 lstat 核验类型/owner/权限）、`renderPreflightFailure` / `renderCleanLine`（global 打印与 worker 抛错共用同一文本）、`parseFakeVerdict`、`runPreflight`（管线：FAKE → disabled → capability → fuse 才做锁/挂载/TMPDIR/不可读进程普查；任何异常 → `preflight-error` dirty，绝不抛出）。`declare module "vitest"` 补 `ProvidedContext.secureEnv`。
- `/home/bluecake/ai/pi-toolkit/tests/setup/secure-preflight.global.ts`（新）— secure project 的 globalSetup：**所有正常出口先 `provide` 再返回**；clean 打一行摘要；dirty 打印 reasons+修复命令；返回 teardown 释放运行锁。`PI_TOOLKIT_SECURE_PREFLIGHT_FAKE` 只在此（tests/ 内）读取。
- `/home/bluecake/ai/pi-toolkit/tests/setup/secure-preflight.setup.ts`（新）— worker 半边：`inject("secureEnv") === undefined` ⇒ 模块顶层直接抛（接线错误，失败即关闭）；dirty ⇒ 文件级 `beforeAll` 抛 `[secure-preflight] …`；incapable / disabled / clean 空操作（与现状逐字节一致）。
- `/home/bluecake/ai/pi-toolkit/vitest.workspace.ts` — 仅 secure project **追加** `globalSetup` / `setupFiles` 各一项（展开 base 数组，`global-tz`、`sandbox-home` 保留在前）；tier1/tier2 不变。
- `/home/bluecake/ai/pi-toolkit/tests/secure/preflight.test.ts`（新，tier1，30 例，纯注入）— 四态 × fuse/private 组合（含有 fuse 无 unshare）、各 reason 与顺序、mountinfo 解析、`/tmp` 与锁文件校验矩阵、渲染文本（含 `pi-secure lock` / `pi-secure status` / `fusermount3 -u` / `#28`）、fake 解析（坏输入失败关闭）、`runPreflight` 管线顺序与异常转 dirty（deps 全注入）、verdict JSON round-trip、以及动态 import worker hook 验证「inject 拿不到 ⇒ 抛错」。刻意不含 D4 标记字面量。
- `/home/bluecake/ai/pi-toolkit/tests/integration/secure-preflight-setup.test.ts`（新，tier2，3 例）— mkdtemp 临时 workspace + 真实两个 hook 文件，子进程 `vitest run` 三场景（见下）。
- `tests/tiers.ts` — **无改动**：`preflight.test.ts` 不命中任何 D4 标记（治理门对真实文件集跑过，绿），无需登记；`secure-preflight-setup.test.ts` 经 `TIER2_DIRS`（tests/integration/）自动归 tier2。P3 无经 root 转来的登记请求。
- 本报告。

## D8–D11 落实对照

- **D8**：`fuse` = linux + PATH 有 gocryptfs + fusermount3（偏宽：launcher-fuse / helper-v0-api / launcher-off-golden 不需要 unshare）；`private` = 复用 `realSkipReason() === ""`（从 `tests/secure/private-real-harness.ts` 导入，不复制判定）。锁检查与挂载检查按「有 fuse 即做」。
- **D9**：四态表逐行实现；global 每个 return 前都有 `provide`；内部异常 → `preflight-error` dirty；worker 侧 undefined ⇒ 抛。disabled 只关启动预检（D14 不受影响，P3 落地后恒生效）。
- **D10**：`concurrent-run`（fuse 检查，holder 尽力而为——读 D13 约定的 `<lock>.holder.json` 侧车文件，pid+starttime 校验 `/proc/<pid>/stat`，读不到/不匹配 ⇒ `holder unknown`）；`gocryptfs-mounted`（private 才是 reason，逐个列挂载点，提示含 `pi-secure lock <name>`、`pi-secure status`、`fusermount3 -u <挂载点>`，明确「自己的保险库也算、不自动卸载」；fuse-only 时降为 note）；`symlinked-tmpdir`（`realpath(tmpdir()) !== tmpdir()`，提示指向 #28）；`run-lock-unsafe`；不可检查同 uid 进程只计数进 notes（D12：不加产品开关、不改测试用例）。
- **D11**：锁固定 `/tmp/pi-toolkit-secure-tests-<uid>.lock`；打开前校验 `/tmp`（lstat：非符号链接、目录、uid 0、sticky）；锁文件 lstat 必须普通文件（符号链接即拒）、owner 当前 uid、无 group/other 写位；缺失则以 `wx` 0600 创建（umask 只会收窄）；复用 `acquireGocryptfsTestLock(1_000, RUN_LOCK)`（holder 带 pdeathsig，随 vitest 主进程死）。每套件 `GOCRYPTFS_TEST_LOCK` 位置不动。
- **I5**：新增代码零计时器（已 grep 验证）；持有者是子进程。

## 自验输出（全部 `set -o pipefail` 下取退出码；日志在 /tmp/p2-*.log）

- `npx vitest run tests/secure/preflight.test.ts tests/integration/secure-preflight-setup.test.ts tests/governance/test-tiers.test.ts tests/integration/test-tiers-actual.test.ts` ×4（prettier 前后各 2 次）：**4 files / 47 tests 全绿**（`/tmp/p2-battery-{1..4}.log`）。
- `npx vitest list --filesOnly --project secure`：**16 个文件，与 P1 完全一致**（workspace 追加后配置正常解析；`/tmp/p2-secure-list*.log`）。
- `npm run typecheck`：exit 0（`/tmp/p2-typecheck2.log`）。
- 补充：临时 tsconfig（同严格旗标）对 6 个新/改文件跑经典 tsc：我的文件零错误；唯一报错 `tests/secure/private-real-harness.ts(168,27)` 为** HEAD 上就存在**（已用 `git show HEAD:` 比对同一段代码）且属 P3 冻结域，与 P2 无关（`/tmp/p2-tsc3.log`）。
- `npx prettier --check`（6 个新/改文件）：All matched。
- `git diff --quiet HEAD -- tests/fixtures/`：exit 0。
- 未跑任何真实挂载的 secure 测试（P3 在跑，会争锁）；三场景均不触碰真实运行锁（incapable/disabled 不拿锁，fake 直接替换探测）。

## 集成三场景（r3-1 裁定版断言）

临时 workspace 放 `os.tmpdir()`（放 `node_modules/.cache` 被 vitest 默认 exclude `**/node_modules/**` 吞掉 case 文件，已弃）；config 用纯对象默认导出（不 import `vitest/config`，临时根下无需 node_modules 解析；case 文件的 `import "vitest"` 由 vitest 自身 alias 解析）。

- ① PATH 只含 sh（无 gocryptfs/fusermount3）⇒ incapable：退出码 0、平凡用例通过、无 `[secure-preflight]` 输出、case 的全部四个 hook 标记齐全（worker 与现状逐字节一致）。
- ② `PI_TOOLKIT_SECURE_PREFLIGHT=0` ⇒ disabled：退出码 0、通过、无输出、**不拿锁**（fuse 能力照常探测并写进 verdict，但无任何检查）。
- ③ `PI_TOOLKIT_SECURE_PREFLIGHT_FAKE=<dirty JSON>`：非零退出；输出含 `[secure-preflight]`、`gocryptfs-mounted`、`pi-secure lock`、`fusermount3 -u`；用例体、嵌套 beforeAll、**文件级 beforeAll** 标记均不存在（setup 文件先注册的 beforeAll 最先抛）；文件级 afterAll 标记存在。按 r3-1 不断言 failed/passed 计数（vitest 2.1.9 子用例标 skipped，预期）。

## 过程中的修正 / 偏差

1. 初版把临时 workspace 放 `node_modules/.cache`——被默认 exclude 吞掉（见上），改到 `/tmp` + 纯对象 config；顺带发现 vitest 2.1.9 里 `maxWorkers:1` 必须配 `minWorkers:1`，否则 tinypool `minThreads/maxThreads must not conflict`。
2. `runCase` 初版先 spread 场景 env 再 delete 预检变量，会把场景②的开关一起删掉——已改为先 delete 后 `Object.assign`。
3. 单测两处 fixture 自身错误（unsafe 场景断言了 busy 的 fix 文案；incapable 场景的 over 替换掉了记录用的 capability 桩）——改为 `baseDeps` 包装记录式注入后全绿。
4. holder 侧车读取（~10 行）在 preflight.ts 里本地实现而非 import P3 的 `describeLockHolder`：后者目前只存在于 P3 未提交的工作区改动，P2 若依赖它，先提交 P2 会造出坏树。P4 可去重。
5. disabled 态仍探测 capability（毫秒级、无副作用），使 verdict 的 fuse/private 字段真实；「不拿锁、不检查」语义不变。

## 遗留 / 交 root

- **过渡期（D11 已声明）**：升级前的测试轮不拿运行锁，旧×新并发不受保护；README 归 P4。
- **collection 期全 skip 的文件不会因 dirty 失败**（实测：`describe.skipIf(true)` 的文件在 dirty 下显示 skipped、退出码 0）——global 打印照常出现。受影响的是「环境门控到 collection 期自 skip」的文件（如 conformance 自门控），它们本来也不会跑用例，不会新增假绿；§3-4「16 个文件都报」对此类文件按「本就自 skip」理解。写入 P4 的 README 残留即可。
- `tests/secure/private-real-harness.ts:168` 的经典 tsc 既有错误（HEAD 相同代码）归 P3 顺带处理或维持现状（仓库 typecheck 不覆盖 tests/，不阻塞）。
- §3-4（真脏环境四子项）、§3-6（PATH 去掉 gocryptfs / 开关=0 的前后计数对照）需要独占本机 + P3 完成，归 P3/P4 验收；P2 的注入版等价物已全覆盖。
- `src/index.ts`、`src/fabric/**`、`tests/fabric/**`、P3 的六个文件、`tests/integration/fabric-xs-ask-redirect*.test.ts` 的改动不是我的，未触碰。未做任何 git 写操作。
