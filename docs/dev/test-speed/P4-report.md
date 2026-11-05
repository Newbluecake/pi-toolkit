# #27 P4 报告 — 门禁与文档

基线 HEAD `322975fc`（dev，即 P3 提交；其上另有 #21 B3 的在途改动，未触碰）。范围：plan r3 §1 D6、D7、
§2「P4」、§3 中属于 P4 的验收，外加两处「后续项」（两个 launcher-private 文件的本地
`awaitNoForeignGocryptfs` 换成 harness 导出版）。`src/**`、`tests/fixtures/**`、`vitest.workspace.ts`、
`tests/tiers.ts` 零改动。

## 改动文件

- `/home/bluecake/ai/pi-toolkit/scripts/release/release.sh`（D6）— 第 5 步 `npm test` 拆为
  `npm run test:tier1` → `npm run test:tier2`，worker 数照旧，且两段都用
  `env -u PI_TOOLKIT_SECURE_PREFLIGHT -u PI_TOOLKIT_SECURE_PREFLIGHT_FAKE` 清掉继承的预检开关/注入。
  任一失败：`err` 打印失败 tier + 分诊提示（tier1：`kind:"timing"` 文件按 Tier 2 分诊、分诊不能绕过中止；
  tier2：单文件复跑 + `[secure-preflight]` 是环境问题不按 flake、先卸自己的保险库），然后 `exit 1`，
  不进入第 6 步。`ok "Pre-release checks passed"` 只在两段都绿后打印。头注释（--skip-tests 说明、第 6 步
  描述）同步。`set -euo pipefail` 语义不变：`if [[ $DRY_RUN -eq 0 ]] && ! env … npm …; then … exit 1; fi`。
- `/home/bluecake/ai/pi-toolkit/tests/release/release-script.test.ts` — 新增 `makeStubNpm`（stub `npm`
  放 mkdtemp 目录、前置 PATH，避免弄脏 fixture 的 clean-tree 检查；记录每次调用的参数到
  `$STUB_NPM_LOG`，`$STUB_NPM_FAIL` 匹配的 script 退出 1，其余 0）和 `run(dir, args, env)` 的可选 env。
  三个新用例全部走**真实门禁路径**（`0.1.1 --skip-push --skip-publish`，非 dry-run / 非 skip-tests）：
  1. tier1 失败：非零退出；调用序列为 format:check→typecheck→build→build:web→check:web→test:tier1，
     **无 `run test:tier2`**；输出含 `test:tier1 failed` 与 `kind:"timing"` 提示；无 release commit、无 tag。
  2. tier2 失败：tier1 已运行、tier2 被调；非零退出，输出含 `Triage`、`rerun the failing file(s) alone`、
     `environment problem, never a flake`；无 release commit、无 tag。
  3. 两段都绿：调用序列与门禁顺序完全一致（7 项 `toEqual`），`Pre-release checks passed`，出现
     `chore(release): bump version to v0.1.1` 提交与 `v0.1.1` tag，`Skipped push (--skip-push)`。
     文件仍登记为 `TIER1_DECLARED` `proc`（新代码未引入 sock/wait/mount 词法标记）。
- `/home/bluecake/ai/pi-toolkit/.github/workflows/ci.yml`（D7）— 一个 `Test` 步骤拆成
  `Test (tier 1)`（`id: tier1`，`npm run test:tier1`）与 `Test (tier 2 + secure)`
  （`if: ${{ !cancelled() && (steps.tier1.outcome == 'success' || steps.tier1.outcome == 'failure') }}`，
  `npm run test:tier2`）。env（PWH_REQUIRE_UI_DIST、PI_TOOLKIT_TEST_WORKERS=2）两步保持不变，覆盖面不变；
  npm ci/构建失败 ⇒ tier1 被 skip ⇒ tier2 不跑；取消时 `!cancelled()` 拦住。runner 无 FUSE 的 real-mount
  自跳过保持现状（注释写明）。
- `/home/bluecake/ai/pi-toolkit/AGENTS.md` — 仅三节：Commands（新增 `test:tier1`/`test:tier2`/`test:secure`
  三行、`npm test` 注明全量语义、CI 链改为 tier1→tier2、日常循环说明、指向 `tests/tiers.ts`）；
  Test tiers（归属以 `tests/tiers.ts` 为准的开头段 + tier1 的 timing 豁免 + 新增 secure 条目：预检失败是
  环境问题修好再跑、不按 flake 放行、发版/跑 secure 前卸自己的保险库 + 收尾段的 release.sh 两段门禁语义）；
  Releasing Flow（`test` → `test:tier1` → `test:tier2`）。**K0/K2/K5 锚点全保**
  （27288 B ≤ 32768；`tests/docs/agents-md.test.ts` 10/10 绿）。其他节未动。
- `/home/bluecake/ai/pi-toolkit/docs/dev/data-encryption/README.md` — Gates 句后补一句：secure project 预检
  fail-fast（含自己的保险库/并发轮/TMPDIR 符号链接 ⇒ 开跑前中止，修好再跑，绝不按 flake 分诊）与
  `npm run test:secure`，指向 `docs/dev/test-speed/README.md`。
- `/home/bluecake/ai/pi-toolkit/docs/dev/test-speed/README.md`（新）— 归属与门（唯一来源、显式元数据、两个
  治理门）、8 条不变式（发版门禁、timing 豁免边界、CI 覆盖面、预检四态、运行锁、D14 不静默 skip、I5、
  不动断言与 golden）、残留风险（过渡期旧进程不受新锁保护、#28 产品侧符号链接 bug、词法登记门漏判 +
  m34 实例、collection 期自 skip 不吃预检失败、kill 后残留挂载的处理）、日常命令。
- `/home/bluecake/ai/pi-toolkit/tests/secure/launcher-private-cmd.test.ts`、
  `/home/bluecake/ai/pi-toolkit/tests/secure/launcher-private-unit.test.ts`（后续项）— 删除各自的本地
  `awaitNoForeignGocryptfs`（60 s 后静默 `ctx.skip()` 的旧语义），改为
  `import { awaitNoForeignGocryptfs } from "./private-real-harness.js"`。调用点一字未改（签名兼容，
  harness 版忽略 `ctx`）；无其他断言改动。D14（超时抛错 + 同文件记忆）从此对这两个文件生效。
- 本报告。

## 自验输出（日志均在 /tmp，命令带 timeout + tee，未截断）

- `npx vitest run tests/release tests/governance` → **8 files / 109 tests 全绿**（含 AGENTS.md 锚点
  `tests/governance` 同跑的 `tests/docs/agents-md.test.ts` 亦单跑 10/10 绿；`/tmp/p4-gov-release.log`，
  Duration 147.04 s）。
- `PI_TOOLKIT_TEST_WORKERS=1 timeout 2400 npx vitest run --project secure
tests/secure/launcher-private-cmd.test.ts tests/secure/launcher-private-unit.test.ts` →
  预检 `[secure-preflight] clean (fuse=true, private=true)`，**2 files / 170 tests 全绿**，Duration 63.07 s
  （`/tmp/p4-secure-real.log`）。跑前跑后 `/proc/self/mountinfo` 均无任何 gocryptfs 残留
  （`NO_GOCRYPTFS_BEFORE` / `NO_GOCRYPTFS_AFTER`），无需 `fusermount3 -u`。
- `bash -n scripts/release/release.sh` → exit 0（SYNTAX_OK）。
- actionlint 本机没有安装：改用 PyYAML 解析 ci.yml（成功；逐步打印 name/id/if/run 人工核对：tier1 步
  `id: tier1`，tier2 步条件与命令与 D7 逐字一致，其余步骤未变）+ 人工核对表达式语法
  （`steps.tier1.outcome` 对 skip 为 `'skipped'`，条件不成立，符合「只有确实执行过才跑」）。
- `npx prettier --check`（8 个改动文件，.sh 无 parser 属预期）→ 首轮 3 个文件需重排，`--write` 后复检
  All matched；`npm run format:check`（全仓）→ All matched（`/tmp/p4-prettier*.log`）。
- `git diff --quiet HEAD -- tests/fixtures/` → exit 0（FIXTURES_CLEAN）。
- 补充：临时 tsconfig（同仓库严格旗标）对 3 个改动的测试文件跑经典 tsc，并与 HEAD 版本（影子树
  /tmp/p4shadow，已删）对照：错误集合**逐条同构**（仅行号平移），唯一新增出现的是
  `tests/secure/private-real-harness.ts(168,27)` —— HEAD 上就存在的既有错误，此前未被拉进编译单元而已
  （P2 报告已记录同一条）。仓库 `npm run typecheck` 不覆盖 tests/，不阻塞。

## 过程中的修正

1. stub npm 首版要放进 fixture 仓库内 —— 会弄脏 clean-tree 检查，改为 mkdtemp 到 tests/ 外并前置 PATH。
2. 首轮忘了 `existsSync` 未在该测试文件导入（3 用例 ReferenceError），补 import 后全绿。
3. AGENTS.md 引用 `docs/dev/test-speed/README.md` 后 K8（链接的 README 必须存在）先红——按交付顺序先建
   README 再复检，10/10 绿（预期路径，非回归）。
4. tar 影子树时 `--exclude=release` 误伤了 `tests/release/`，改为 `--exclude=./release` 重做。

## 遗留 / 交 root

- CI 拆步的真实效果（tier1 失败时 tier2 仍跑、npm ci 失败时 tier2 不跑）只能在 GitHub Actions 上观察，
  本地已用 YAML 解析 + 逐字段人工核对；建议合并后看一次真实 run。
- `private-real-harness.ts(168,27)` 的经典 tsc 既有错误仍在（不在 P4 文件域，P2/P3 已记录）；仓库
  typecheck 不含 tests/。
- P3 报告遗留的 §3-4（真脏环境四子项实测）与 §3-6（incapable/disabled 前后计数对照）需要独占机器的
  故意脏环境实验，本包未执行（P2 的注入版等价物已覆盖矩阵）；如需实测可另开验收。
- 未做任何 git 写操作；#21 B3 的在途文件（`src/index.ts`、fabric-xs 等）未触碰。
