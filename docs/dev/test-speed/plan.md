# #27 全量测试提速 — 方案（plan r3）

> 输入：`docs/dev/test-speed/explore.md`（E§x）、r1 评审 r_JP6HEQVB（处置见文末）。基线 `13cc2946`（dev），`vitest list --filesOnly` = **1760** 文件。
> 已核对：vitest 2.1.9 的 workspace 只能写成 `vitest.workspace.ts` 文件；**只有本轮选中了文件的 project 才执行它的 globalSetup**（`cli-api…js:10787-10795`）。
> 用户已拍板（2026-11-05）：
>
> - `npm test` 保持全量，日常跑 `test:tier1`；
> - secure 环境不干净时立刻失败并给修复提示，缺依赖仍按现状自跳过；
> - 产品侧 symlink bug 另开 #28，本期只修测试侧；
> - `tests/integration` 整个目录进 Tier 2。

## §0 需求摘要

- **需求**：
  - ① secure 前置条件不满足时 fail-fast，不再逐例等到超时，断言不动；
  - ② Tier 1 / Tier 2 拆成独立脚本，日常只跑 Tier 1，发版和 CI 照跑全部。
- **约束**：
  - 发版门禁不削弱：Tier 1 全绿，Tier 2 必跑并走复跑分诊；
  - 不改断言，frozen golden 不动；
  - 改 config / scripts / release / CI 时同步 AGENTS.md 的 Commands 与 Test tiers；
  - 新增计时器一律 `unref`（I5）。
- **事实**：secure 慢在四处（E§2.3）：跨轮抢锁；symlink 路径拼写不一致导致判 foreign；不可检查进程门；残留挂载导致每例空等 60 s 后 skip。

## §1 设计决定

### 1.1 分层：workspace 三个 project，共用一套分区定义

- **D1 `vitest.workspace.ts` 定义 `tier1`、`tier2`、`secure` 三个 project**。
  - `secure` 属于 Tier 2，单列是为了挂 secure 专属的 setup。
  - 否决环境变量门控：globalSetup 看不到 CLI 文件过滤，secure 预检会混进 Tier 1 运行，还会误占运行锁。
- **D2 分区唯一来源 `tests/tiers.ts`**（纯数据加纯函数，无 pi import）。导出：
  - `TIER2_DIRS = ["tests/integration/", "tests/conformance/"]`；
  - `SECURE_MOUNT_FILES`：16 个文件，判定标准是含真实 gocryptfs 挂载块，逐个读过源码；
  - `TIER2_FILES`：目录外的 Tier 2 文件，分两组：
    - 「普通真实进程」：`tests/secure/gocryptfs-test-lock.test.ts`（私有锁文件、不挂载）、`tests/secure/private-real-harness.test.ts`（普通子进程）；
    - 「构建产物/真脚本」：`tests/governance/bundle-parity.test.ts`（147 s，依赖 `dist/bundle`）、`tests/release/package-zip.test.ts`（36 s）；
  - `TIER1_DECLARED: Record<path, {kind: "proc"|"timing"|"false-positive", why}>`（见 D4）；
  - `projectOf(rel)` 和 `validateManifest(files, read)`。
  - 规则：**分区只看显式元数据，绝不按类名或标记推断**。标记只用来强制登记（D4）。r1 用 `RealHarness` 等通用名推断是错的，`tests/web-hub/agent/commands-hold.test.ts:421` 就是反例。
- **D2a 文件三分类清单**（扫描范围与 vitest include 相同：`tests/**/*.test.ts`、`tests/**/*.test-d.ts`；`tests/fixtures/**` 下没有此类文件，已核对）：

| 类别            | 文件                                                                                                                                                                                                                                                                                                          | project |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| real-mount (16) | `tests/secure/{archive,convert-state,helper-v0-api,init-cleanup-real,launcher-convert,launcher-fuse,launcher-off-golden,launcher-private-cmd,launcher-private-unit,launcher-private,launcher-v6-wiring}.test.ts` + `tests/conformance/secure-{convert,convert-xc2,convert-xc89,gocryptfs,private-ns}.test.ts` | secure  |
| 普通真实进程    | 上面 `TIER2_FILES` 中的 4 个，以及 `tests/integration/**`、`tests/conformance/**` 的其余文件                                                                                                                                                                                                                  | tier2   |
| 纯注入/本地进程 | 其余 23 个 `tests/secure/*.test.ts`（guards/domain/settings-*/tree/tar/launcher-cli 用假 gocryptfs，launcher-helper 等）以及所有其他目录                                                                                                                                                                      | tier1   |

- **D3 不用 `extends`**：vite 的 `mergeConfig` 会拼接数组，include 会叠加。
  - `vitest.config.ts` 导出 `baseProject`（plugins/resolve/define/environment/globalSetup=[global-tz]/setupFiles=[sandbox-home]/testTimeout），根 config 保留 `maxWorkers`/`minWorkers`（`:37-38`），三个 project 都沿用这个 worker 上限。
  - include/exclude 全由 `tests/tiers.ts` 的常量生成：
    - tier1：基础 include，exclude 掉 `TIER2_DIRS` 派生的 glob、`TIER2_FILES`、`SECURE_MOUNT_FILES`；
    - tier2：include 为 dirs 派生 glob 加 `TIER2_FILES`，exclude 掉 5 个 secure conformance；
    - secure：include 为 16 个字面路径。
  - **secure 是追加，不是替换**：`globalSetup: [...base, secure-preflight.global]`，`setupFiles: [...base, secure-preflight.setup]`。
- **D4 新文件分类门**（`tests/governance/test-tiers.test.ts`，Tier 1）：对每个落进 tier1 的文件按标记扫描：
  - `proc`：`node:child_process` import；
  - `sock`：`.listen(`/`createServer(`/`createConnection(`/`new WebSocket(`；
  - `wait`：`setTimeout(…, ≥1000)` 字面量；
  - `mount`：`acquireGocryptfsTestLock(|realSkipReason(|HAVE_FUSE_STACK|"gocryptfs"`。
  - 命中任一标记却不在 `TIER1_DECLARED` ⇒ 失败，提示「登记到 TIER1_DECLARED / TIER2_FILES / SECURE_MOUNT_FILES 之一」。
  - 已登记但文件不存在 ⇒ 失败；同一路径出现在两张表 ⇒ 失败；`mount` 标记命中而 kind 不是 `false-positive`（例如 commands-hold）⇒ 失败。
- **D4a 现存审计**（本次只读扫描）：tier1 共 1554 个文件，131 个命中标记（proc 63 / sock 60 / wait 16 / mount 1，有重叠），集中在 `tests/web-hub/hub`（40）、`tests/web-hub/http`（35）。
  - 已知的真实等待或慢文件：
    - `web-hub/hub/feishu/service.test.ts:764`：5.6 s 真实等待，文件共 42 s；
    - `web-hub/ui/logic-markdown-perf`：43 s，性能比值；
    - `secure/convert-preflight`：39.7 s，子进程；
    - `workflow/wc14-testhooks-gate`：27.6 s；
    - `service/request-threading`：23.7 s；
    - `web-hub/hub/spawn/golden`：22.9 s；
    - `secure/launcher-cli`、`secure/settings-lock`：各约 21 s；
    - `traffic/db-contention`：16.5 s；
    - 其余 >5 s 的约 40 个，以 web-hub/hub/** 为主。
  - P1 按标记机械生成 `TIER1_DECLARED` 基线（`why` 写命中的标记）。人工复核 `wait`/`sock` 命中项，标成 `timing` 或 `proc`。
  - **本期不改断言、不 fake 化**。AGENTS 不再写「Tier 1 全是确定性测试」，改写为：tier1 project 中 `kind:"timing"` 的文件失败时按 Tier 2 分诊，其余失败一律视为真 bug（§6 已定）。
  - **分诊不绕过 D6**：timing 文件失败时，release.sh 照样以非零码中止；只有复跑或单独跑转绿之后，才能重新跑 release。分诊决定的只是「判为 flake 还是 bug」，不允许带红发版。
  - **残留**：分类门只认词法标记，时长写在变量里、经 helper 间接 sleep 或 spawn、真实 I/O 慢等形式都会漏判。因此新增测试仍须由评审人工复核分类，不得宣称机械门能覆盖全部慢测试或环境敏感测试。
- **D5 scripts**（`package.json:105-108`）：
  - `test` 仍是 `vitest run`，即全量（已拍板）；
  - `test:tier1` = `vitest run --project tier1`；
  - `test:tier2` = `vitest run --project tier2 --project secure`；
  - `test:secure` = `vitest run --project secure`；
  - `test:conformance` 不变（K2）。
  - 日常开发和 subagent 跑 `test:tier1`，再加相关 Tier 2 单文件；改 secure 时加 `test:secure`。写进 AGENTS Commands。
- **D6 release.sh 第 5 步**（`:547-556`）：`npm test` 改为先 `npm run test:tier1`，再 `npm run test:tier2`。
  - worker 数照旧，并用 `env -u PI_TOOLKIT_SECURE_PREFLIGHT -u PI_TOOLKIT_SECURE_PREFLIGHT_FAKE` 清掉预检开关和测试注入。
  - 任一失败：打印失败的 tier 和 AGENTS 分诊提示（Tier 2：单文件复跑，绿了算 flake，再重跑 release），然后**以非零码退出**，不会进入第 6 步提交。
  - 两段都成功才进入第 6 步。
- **D7 CI**（`ci.yml:44-50`）：一个 Test 步骤拆成两步：
  - `id: tier1` 跑 `npm run test:tier1`；
  - Tier 2 步骤条件为 `if: ${{ !cancelled() && (steps.tier1.outcome == 'success' || steps.tier1.outcome == 'failure') }}`：只有 Tier 1 确实执行过才跑，npm ci 或构建失败时 Tier 1 为 skipped，Tier 2 也就不跑；
  - env 与 worker 数不变；real-mount 套件在 runner 上继续自跳过，**保持现状**。

### 1.2 secure 前置探测（只改测试侧）

- **D8 能力分两级**（`tests/secure/preflight.ts`）：
  - `fuse` = linux，且 PATH 上有 `gocryptfs` 和 `fusermount3`。这是所有 real 块门控的公共子集。`launcher-fuse.test.ts:39-44`、`helper-v0-api.test.ts:539-544`、`launcher-off-golden.test.ts:55` 都不要求 unshare，因此这里刻意取**偏宽**的判定：只要有任一 real 块**可能**执行，就要锁和检查。
  - `private` = `realSkipReason() === ""`，即在 fuse 之上还要求 unshare/userns/script 等。
- **D9 四态契约**：`secureEnvVerdict(input)` 是纯函数，输入全部可注入：capability、mountinfo、tmpdir/realTmpdir、runLock 结果、unreadableCount。结果是 `{state, fuse, private, reasons[], notes[]}`。
  - globalSetup（`tests/setup/secure-preflight.global.ts`）**在每个正常出口都先 `provide("secureEnv", v)` 再返回**；内部异常一律捕获，转成 `dirty`，reason 为 `preflight-error`（失败即关闭，不让 worker 拿不到结论）。

| state     | 条件                            | globalSetup 行为                                          | worker（setupFile）行为                      |
| --------- | ------------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| incapable | `!fuse`（CI、无 FUSE 机器）     | 不拿锁、不检查                                            | 空操作，与现状逐字节一致                     |
| disabled  | `PI_TOOLKIT_SECURE_PREFLIGHT=0` | 不拿锁、不检查（只关闭启动预检；D14 照常生效）            | 空操作                                       |
| clean     | fuse 且检查全部通过             | 持有运行锁到 teardown；notes 打一行摘要                   | 空操作                                       |
| dirty     | 任一 reason                     | 打印 reasons 和修复命令；已拿到的运行锁在 teardown 时释放 | 文件级 `beforeAll` 抛 `[secure-preflight] …` |

- setupFile（`tests/setup/secure-preflight.setup.ts`）里 `inject` 拿到 `undefined`，说明接线有误 ⇒ 同样抛错（失败即关闭）。
- **实际效果**：模块收集、文件顶层代码（如 `realSkipReason()`）在此之前已经执行；文件自己的 `afterAll`/`afterEach` 仍会执行。现有的 `release?.()`、`T.cleanup()` 在未初始化时也安全，P2 会逐个核对。真正省掉的是 describe 级 `beforeAll` 取锁（240–590 s）和用例体。不用 globalSetup 直接 throw，因为那会中止同一进程里的其他 project。
- **D10 dirty 的 reason 与修复提示**：
  - `concurrent-run`（fuse 时检查）：运行锁被占。提示：「另一轮 secure 测试在跑（holder 信息尽力给出，见 D13），等它结束再跑」。
  - `gocryptfs-mounted`（private 时检查）：`/proc/self/mountinfo` 里有任何 `fuse.gocryptfs`。原因是 `run --private` 会拒绝当前挂载命名空间里的**所有** gocryptfs 挂载，**包括你自己的保险库**。提示逐个列出挂载点，并给出：「发版或跑 secure 前，请先卸载：`pi-secure lock <name>`（不知道名字就先 `pi-secure status`），或 `fusermount3 -u <挂载点>`」。不区分、也不称为「测试残留」；不自动卸载。fuse 有而 private 没有时只记 note。
  - `symlinked-tmpdir`（fuse 时检查）：`realpath(tmpdir()) !== tmpdir()`。RealHarness 默认根会命中 #28。提示：「请把 TMPDIR 设成物理路径或取消设置；产品缺陷见 #28」。
  - `run-lock-unsafe`：见 D11。
  - 不可检查的同 uid 进程只计数写进 notes，不判 dirty（D12）。
- **D11 运行锁**：位置固定为 `/tmp/pi-toolkit-secure-tests-<uid>.lock`，用字面 `/tmp`，不随 TMPDIR，也与 scratch 根无关。
  - 打开前校验：`/tmp` 属 root 且带 sticky 位；锁文件不存在就以 0600 创建；已存在则用 lstat 检查，必须是普通文件（不能是符号链接）、owner 为当前 uid、无 group/other 写权限。否则判 `run-lock-unsafe`。
  - 复用 `acquireGocryptfsTestLock(1_000, RUN_LOCK)`，不引入新原语；holder 带 pdeathsig，随 vitest 主进程一起死。
  - 过渡期：升级前的代码不拿这把锁，旧进程和新进程并发时不受保护，写进 README 的残留风险。
  - 每套件锁 `GOCRYPTFS_TEST_LOCK` 的位置（`tmpdir()`）本期不动：同一轮内所有 worker 的 TMPDIR 相同，跨轮已由运行锁兜底。
- **D12 不可检查进程门：不加产品开关，测试侧也不改**。用例已按正则应答（`launcher-convert.test.ts:305-308`、`:785`），非 TTY 路径用 `--assume-unreadable-idle`（`:591`），`:690` 本就兼容两种机器。P3 修完 symlink 后复核；如果仍有按序号对齐的应答，只改成正则应答。
- **D13 锁超时诊断（尽力而为）**：`acquireGocryptfsTestLock` 拿到锁后，写旁路文件 `<lock>.holder.json`，内容为 `{pid, starttime, vitestPid, file}`。其中 `pid`/`starttime` 指**真正持锁的 shell holder**（`holder.pid`，即 `tests/secure/gocryptfs-test-lock.ts:63-108` 中 spawn 出来、经 fd 3 持有 open file description 的 `sh`），不是调用 helper 的 vitest worker 或主进程；`vitestPid` 只作说明。
  - 超时报错时读取旁路文件，并用 `/proc/<pid>/stat` 的 starttime 校验；读不到或不匹配就写 `holder unknown`。
  - 原报错 `gocryptfs test lock not acquired (holder exit N)` 保留在最前（`gocryptfs-test-lock.test.ts:84` 的正则），诊断只追加。读取是同步的一次 ≤4 KiB 读，**不延长失败预算**。
  - 不用 `/proc/locks` 的 pid：那是已退出的 `flock -n` 子进程。
  - 诊断测试（并入 `gocryptfs-test-lock.test.ts`，使用私有锁文件，不改原有断言）：holder 已释放或已被杀死、旁路元数据却还在（pid 不存在或 starttime 不匹配）⇒ 诊断输出 `holder unknown`；元数据缺失或损坏 ⇒ 同样输出 unknown；原报错前缀不变。
- **D14 轮内外来挂载**：`private-real-harness.ts:523-536` 的 `awaitNoForeignGocryptfs` 在 60 s 后不再 `ctx.skip()`，改为抛错并列出挂载；同一文件第一次超时后，后续调用立即抛错（模块级记忆，vitest 每个文件一个模块实例）。
  - 依赖 `{readMountinfo, now, sleep}` 可注入，默认用真实实现。
  - 不受开关影响：开关只关启动预检。

### 1.3 symlink 布局（测试侧；产品缺陷 #28）

- **D15 `launcher-convert.test.ts:81`**：`E2E_ROOT` 改为 `join(realpathSync(join(REPO,"node_modules")), ".cache", "v7")`，只改布置。
- **D16 `launcher-helper.test.ts:34-38,66,191-194`**：断言表达式 `join(REPO, "node_modules", …)` 一字不改，只改 `REPO` 的绑定。
  - 新增 `SRC = join(import.meta.dirname, "..", "..")`，供 `HELPER`（`:35`）和 fixture（`:66`）使用。
  - `REPO = layoutRoot(SRC)`：`node_modules` 是符号链接且 realpath 的 basename 是 `node_modules` 时，取其父目录；否则取 SRC。
  - 布局校验在模块顶层：如果 `realpath(join(REPO, "node_modules/@earendil-works/pi-coding-agent"))` 与词法路径不相等（例如 npm link），就抛出清楚的布局错误，不静默跳过。
- 其他 Tier 1 文件在 symlink 布局下是否全绿，由 §3-5 验收；若发现新的失败，只在测试侧修布置，并补登记到本节。

### 1.4 其他手段

| 手段                                    | 决定        | 理由                                                                      |
| --------------------------------------- | ----------- | ------------------------------------------------------------------------- |
| bundle-parity / package-zip 移入 Tier 2 | 做（D2）    | 147 s 是 Tier 1 墙钟的下限；移走后日常 Tier 1 也不再需要先 `build:bundle` |
| fabric-xs 注入 hub 时钟                 | 后续        | 要改时序编排，风险面不同                                                  |
| `--no-isolate`                          | 不做        | 破坏 I2/I4/I6 的前提                                                      |
| CI shard / 加 worker                    | 不做        | secure 在 CI 已经自跳过；加 worker 收益不到 8%，还会放大 flake            |
| 每套件锁改字面 /tmp                     | 不做（D11） | 运行锁已兜住跨轮；少一处行为变化                                          |

## §2 改动清单（按包；★ 为文案联动；冻结面：`tests/fixtures/**` 不碰）

- **P1 分层基础设施**（先做）
  - `vitest.config.ts`：拆出 baseProject；
  - 新建 `vitest.workspace.ts`、`tests/tiers.ts`（D2/D2a，以及按 D4a 生成的 TIER1_DECLARED 基线）；
  - `package.json:105-108`（D5）；
  - 新建 `tests/governance/test-tiers.test.ts`（D4 门，Tier 1）。反例用合成输入：重复登记、漏登记（带标记）、登记了但文件不存在、`mount` 标记误登为 proc、路径不属于任何 project，每种都必须报错。
  - 新建 `tests/integration/test-tiers-actual.test.ts`（Tier 2）：子进程跑 `vitest list --filesOnly --project <p>` ×3（去掉 `[name]` 前缀），断言实际集合等于 `globSync` + `projectOf` 的结果，且两两不相交。这一条验证的是**实际配置**。
- **P2 secure 预检**（依赖 P1；与 P3 并行）
  - 新建 `tests/secure/preflight.ts`（D8–D11）、`tests/setup/secure-preflight.global.ts`、`tests/setup/secure-preflight.setup.ts`；
  - `vitest.workspace.ts`：只追加 secure project 的两行；
  - 新建 `tests/secure/preflight.test.ts`（纯注入，登记为 tier1）：四态 × fuse/private 组合（含有 fuse 无 unshare）、各 reason、锁文件类型和 owner 校验、异常转 dirty、`inject` 拿到 undefined 时抛错；
  - 新建 `tests/integration/secure-preflight-setup.test.ts`（Tier 2）：在 mkdtemp 里生成一个只含一个平凡用例的临时 workspace，挂上真实的 global/setup 文件，子进程跑三种场景，分别断言：
    - ① PATH 里去掉 gocryptfs（incapable）、② `PI_TOOLKIT_SECURE_PREFLIGHT=0`：进程退出码 0，平凡用例通过，没有新增 failed 或 skipped；
    - ③ 注入 dirty（用测试专用的 `PI_TOOLKIT_SECURE_PREFLIGHT_FAKE=<json>`，仅在 tests/ 中读取，生产代码不感知）：进程非零退出；该文件（套件）失败，输出含 `[secure-preflight]` 错误；用例体与嵌套 `beforeAll` 都没执行（各自写标记文件，断言标记不存在）；文件级 `afterAll` 执行了（写标记，断言标记存在）。在 vitest 2.1.9 里子用例会被标为 skipped，这是预期结果，不断言 failed 或 passed 的用例数。
- **P3 secure 测试侧修复**（与 P2 并行，文件不相交）
  - `tests/secure/launcher-convert.test.ts:81`（D15）、`tests/secure/launcher-helper.test.ts:34-38,66`（D16）；
  - `tests/secure/gocryptfs-test-lock.ts:63-108`（D13）、`tests/secure/private-real-harness.ts:523-536`（D14）；
  - 新建 `tests/secure/await-foreign.test.ts`（纯注入，tier1）：
    - 持续外来挂载：只等一次就抛错，第二次立即抛错；
    - 瞬态挂载在窗口内消失：正常返回，且不置记忆；
    - `mine` 前缀下的自有挂载不算外来；
    - 用假时钟。
- **P4 门禁与文档**（依赖 P1–P3）
  - `scripts/release/release.sh:547-556`（D6）；
  - `tests/release/release-script.test.ts` 加 stub npm 用例（PATH 前置一个记录参数、按环境变量决定退出码的 `npm` 脚本；fixture 用 `--skip-push --skip-publish`）：
    - tier1 失败：立即非零退出，tier2 未被调用，无 tag；
    - tier2 失败：非零退出，打印分诊提示，无 tag；
    - 两者都成功：进入第 6 步，fixture 内出现 tag；
  - `.github/workflows/ci.yml:44-50`（D7）；
  - ★`AGENTS.md`：
    - Commands：三个新 script，以及日常跑哪个；
    - Test tiers：归属以 `tests/tiers.ts` 为准，timing 类按 Tier 2 分诊，secure 预检失败是环境问题（修好再跑，不算 flake 放行），发版前要卸载自己的保险库；
    - Releasing Flow：`test` 改为 `test:tier1 → test:tier2`；
    - 保持 K0（≤32 KiB，现 25.6 KiB）、K2、K5 的锚点；
  - ★`docs/dev/data-encryption/README.md` 的 Gates 句：补预检和 `test:secure`；
  - 新建 `docs/dev/test-speed/README.md`：不变式，以及残留风险（过渡期旧进程、#28）。

## §3 测试与验收

1. **分区无漏无重**：
   - 在基线 commit 上执行 `npx vitest list --filesOnly | sort > /tmp/pre.txt`（1760 行）；
   - 改动后三个 `--project` 的列表两两 `comm -12` 为空；
   - 并集 = pre ∪ 本期声明的新增测试文件（test-tiers、test-tiers-actual、preflight、secure-preflight-setup、await-foreign 共 5 个）；
   - `test-tiers` 和 `test-tiers-actual` 都绿。
2. **Tier 1 墙钟**：同机且无其他 vitest 进程时，`time npm run test:tier1` 在默认 worker 和 `=4` 下各跑一次。
   - 估算：约 985 worker-s。由 E§3.2 的 1057 减去移出的 183，再加上留在 Tier 1 的纯 secure 约 110 得出。
   - 目标：@4 ≤ 7 min；贴 Duration 和最慢 5 个文件。
3. **Tier 2 完整执行**：主仓 secure 复跑结束、`mount | grep gocryptfs` 为空后，跑 `npm run test:tier2`。
   - secure 16 个文件全部执行，预检为 clean；
   - 用例数与全量中同名文件一致；
   - `launcher-convert` 不再出现 foreign，耗时降到约 250 s 量级。
4. **故意制造脏环境**（`test:secure` ≤ 60 s 结束，16 个文件都报 `[secure-preflight]` 和对应 reason）：
   - (a) 用 passfile 在 /tmp 挂一个 gocryptfs 测试目录 ⇒ `gocryptfs-mounted`，提示里含 `pi-secure lock` 和 `fusermount3 -u`；
   - (b) 两个终端分别设 `TMPDIR=/tmp/a`、`TMPDIR=/tmp/b`，并发跑 ⇒ 后启动的一轮报 `concurrent-run`，先启动的不受影响；
   - (c) 让 TMPDIR 指向一个符号链接 ⇒ `symlinked-tmpdir`；
   - (d) 预先放一个指向别处的符号链接锁文件 ⇒ `run-lock-unsafe`。
5. **symlink 布局**：在一个 `node_modules` 为符号链接的 worktree 里：
   - `npm run test:tier1` 全绿，`launcher-helper` 用例通过；
   - 单跑 `launcher-convert` 不出现 foreign。
6. **不新增失败或 skip**：改动前后，`PATH=<去掉 gocryptfs 的 PATH> npx vitest run --project secure` 与 `PI_TOOLKIT_SECURE_PREFLIGHT=0` 两种场景下，passed/skipped/failed 计数分别与改动前全量中同一批文件的计数一致。CI 的 skipped 数前后一致。

## §4 门禁命令

```sh
npm run format:check && npm run typecheck
npm run test:tier1
npx vitest run tests/governance tests/docs tests/release tests/secure/preflight.test.ts tests/secure/await-foreign.test.ts
npx vitest run tests/integration/test-tiers-actual.test.ts tests/integration/secure-preflight-setup.test.ts
npm run test:secure          # 仅 P3/P4 验收时：独占本机，并先确认没有任何 gocryptfs 挂载
npm run build && npm run build:bundle && npm run test:tier2   # P4 收尾
git diff --quiet origin/dev -- tests/fixtures/
```

## §5 风险

- **workspace 迁移**：project 是否继承 plugins/define/alias；根 core project 可能重复执行 global-tz（幂等）。由 §3-1/§3-2 验证。
- **文件级 `beforeAll` 抛错后嵌套 `beforeAll` 是否被跳过**：由 P2 的 ③ 和 §3-4 的时限实测。若不跳过，退路是在 `acquireGocryptfsTestLock` 入口读取 inject 结论并立即 reject，仍只改测试侧。
- **偏宽的 fuse 判定**：有二进制但 `/dev/fuse` 不可用时，也会拿运行锁、做检查，没有坏处。
- **TIER1_DECLARED 基线较大**（约 130 条）：分类门只拦新增，基线随文件删除由「登记了但不存在」规则自动收敛。
- **严格化成本**：发版前必须卸载自己的保险库，D14 也会让以前静默 skip 的情况显式失败。这是有意为之，提示里给命令。
- **过渡期**：旧代码的测试轮不拿运行锁。release.sh 运行期间禁止往发版分支提交（项目记忆 2026-10-29）。

## §6 已定（用户 2026-11-05）

1. tier1 project 中的 `kind:"timing"` 文件（约 20 个，D4a 基线人工复核后确定）**留在 tier1，失败时按 Tier 2 分诊**；分诊不绕过 D6 的失败中止（见 D4）。本期没有其他待拍板项。

## 评审处置表（r1 → r2）

| #    | 级别                  | 要点                                        | 处置                                                                                                                                           |
| ---- | --------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Blocker               | incapable 早退导致没有 provide              | 接受：D9 规定所有出口先 provide，四态表，异常转 dirty，inject 拿到 undefined 时抛错；P2 加无 FUSE / 开关关闭的 setup 集成测试                  |
| 2    | Blocker               | REAL 标记推断不可靠                         | 接受：D2/D2a 改为显式三分类清单（16 / 4 加两个目录 / 其余），标记只用来强制登记；写明扫描范围                                                  |
| 3    | Major                 | governance 证明不了实际 include/exclude     | 接受：include/exclude 由同一组常量生成；`test-tiers-actual` 用 `vitest list` 验证实际集合；加基线比对和反例测试                                |
| 4    | Major                 | 新文件默认进 Tier 1                         | 接受：D4 分类门（带标记却未登记就失败）；D4a 现存审计；AGENTS 文案改写；§6 Q1                                                                  |
| 5    | Major                 | 有 FUSE 无 unshare 时预检被绕过             | 接受：D8 拆成 fuse / private 两级，fuse 即拿锁；P2 补注入场景测试                                                                              |
| 6    | Major                 | RUN_LOCK 随 TMPDIR 漂移                     | 接受：D11 固定为字面 /tmp 并校验类型和 owner；§3-4(b) 验收不同 TMPDIR 并发；写明过渡期                                                         |
| 7    | Major                 | 漏了 launcher-helper 的 symlink 失败        | 接受：D16 断言表达式不变、只重绑 REPO；§3-5 验收 symlink 布局下 Tier 1 全绿                                                                    |
| 8    | Minor                 | `/proc/locks` 的 pid 不可靠                 | 接受：D13 改用带 starttime 的旁路元数据，读不到写 unknown，不替换原因、不延长预算                                                              |
| 9    | Minor                 | 开关为 0 与 D14 自相矛盾                    | 接受：开关只关启动预检，D14 恒生效；P3 加注入式 D14 测试                                                                                       |
| 10   | Minor                 | CI 条件过宽，release 缺测试                 | 接受：D7 只在 Tier 1 确实执行过时跑 Tier 2；P4 加 stub npm 三用例                                                                              |
| +    | —                     | 用户自己的保险库、afterAll 语义、追加不替换 | 接受：D10 提示和发版前卸载要求；D9 改正执行语义描述；D3 明确是追加，worker 上限沿用根配置                                                      |
| r3-1 | root 裁定             | P2 场景③ 的验收自相矛盾                     | dirty 改为断言：非零退出、文件失败、含预检错误、用例体和嵌套 beforeAll 未执行、文件级 afterAll 已执行；不再断言「1 failed」或「三种都 passed」 |
| r3-2 | root 裁定（用户拍板） | timing 文件归属与分诊                       | §6 改为已定：留在 tier1，按 Tier 2 分诊；D4 写明分诊不绕过 D6 的中止，并写明词法登记门的漏判残留，新增测试须人工复核                           |
| r3-3 | root 裁定             | D13 的 holder 元数据指向谁                  | 明确 `{pid, starttime}` 是 shell holder（`holder.pid`）；补测试：已释放或已死亡、元数据仍在 ⇒ 输出 unknown                                     |
