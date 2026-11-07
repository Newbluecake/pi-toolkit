# #27 P1 报告 — 分层基础设施

基线 HEAD `c2fefa18`（dev）。范围：plan r3 §1 D1–D5、D4a、§2「P1」、§3 中属 P1 的验收。

## 改动文件

- `/home/bluecake/ai/pi-toolkit/vitest.config.ts` — 导出 `baseProject`（plugins/resolve/define/environment/globalSetup=[global-tz]/setupFiles=[sandbox-home]/testTimeout）；根配置保留 include、maxWorkers/minWorkers。
- `/home/bluecake/ai/pi-toolkit/vitest.workspace.ts`（新）— `tier1`/`tier2`/`secure` 三个 project，均展开 `baseProject`（因此各自带 global-tz 与 sandbox-home），include/exclude 全由 `tests/tiers.ts` 生成。secure 的 preflight 钩子留给 P2 追加。
- `/home/bluecake/ai/pi-toolkit/tests/tiers.ts`（新）— `TIER2_DIRS`、`TIER2_FILES`(4)、`SECURE_MOUNT_FILES`(16)、`TIER1_DECLARED`(136)、`projectOf`、`validateManifest`、`scanTier1Markers`、include/exclude 生成函数。
- `/home/bluecake/ai/pi-toolkit/package.json` — 新增 `test:tier1`、`test:tier2`、`test:secure`；`test` 仍为 `vitest run`（全量）。
- `/home/bluecake/ai/pi-toolkit/tests/governance/test-tiers.test.ts`（新，tier1，11 例）— 真实清单校验 + 5 种合成反例（重复登记、漏登记、登记但缺失、mount 误标 proc、不属任何 project）+ 正例。
- `/home/bluecake/ai/pi-toolkit/tests/integration/test-tiers-actual.test.ts`（新，tier2，3 例）— 子进程 `vitest list --filesOnly --project <p>` ×3，断言实际集合 = `globSync + projectOf`、两两不相交、并集 = 全部文件。
- 本报告。

## TIER1_DECLARED 基线（D4a）

按 D4 标记机械扫描后人工复核：tier1 共 1556 个文件，135 个命中标记（proc 68 / sock 60 / wait 16 / mount 1）+ 本包新增的 test-tiers 自身（其合成 fixture 含标记字面量）= 136 条。

- `kind:"timing"`（仅 wait 命中，11 个）：`bash/tool`、`memory/tidy`、`web-hub/http/proxy-redaction`、`web-hub/http/proxy-wiring`、`web-hub/hub/command-complete`、`web-hub/hub/feishu/service`、`web-hub/hub/hub-lan`、`web-hub/hub/lan-login`、`web-hub/hub/preview/dir`、`web-hub/hub/proxy/listener-allowlist`、`web-hub/hub/spawn/launcher-check`。
- `kind:"false-positive"`（mount 命中）：`secure/launcher-cli`（假 gocryptfs 二进制）与 `governance/test-tiers`（自身字面量）。
- 其余为 `proc`（含 sock-only，按 plan「sock-only ⇒ proc」处理）。
- 注意：`commands-hold.test.ts` 的 `RealHarness` 不命中任何 mount 标记（它是 r1 对「按名称推断」的反例，不是词法命中）。
- 偏差：plan D4a 写 proc 63，本次扫描 68（基线 commit 之后文件有增加）；wait 16、sock 60、mount 1 与审计一致。
- 可信度：timing 的 11 个是「只有 wait 命中」的机械结果，我没逐个读源码复核时长是否真实；只判定了标记。

## 文件集合比对（`npx vitest list --filesOnly`，未执行任何测试）

基线 `/tmp/tiers-before.txt` = **1760**（含另一包已在磁盘上的 3 个 `tests/fabric/xs-*` 文件）。

| project | 文件数 |
| ------- | ------ |
| tier1   | 1556   |
| tier2   | 190    |
| secure  | 16     |
| 合计    | 1762   |

- 两两交集：tier1∩tier2 = 0，tier1∩secure = 0，tier2∩secure = 0。
- 并集 − 基线（新增）= `tests/governance/test-tiers.test.ts`、`tests/integration/test-tiers-actual.test.ts`（恰为声明的 P1 新增 2 项）；基线 − 并集（丢失）= 0。
- 不带 `--project` 的 `vitest list --filesOnly` 去重后也是 1762，即 `npm test` 仍覆盖全量。
- 迁移计数：tier2 = 151 integration + 39 conformance − 5 secure-conformance + 4 `TIER2_FILES` = 189，加上新增的 actual 测试 = 190 ✓；tier1 = 1760 − 189 − 16 + 1(test-tiers) = 1556 ✓。
- 当时 #21 B3 的 `tests/integration/fabric-xs-ask-redirect*.test.ts` 尚未出现，对集合无影响；之后新增的 integration 文件按目录规则自动归 tier2，不会让基线比对出现差异。

## 自验输出

- `npx vitest run tests/governance/test-tiers.test.ts` → 1 file / 11 tests passed（`/tmp/p1-gov.log`）。
- `npx vitest run tests/integration/test-tiers-actual.test.ts` → 3 passed，Duration 2.09 s（`/tmp/p1-actual.log`）。
- `PI_TOOLKIT_TEST_WORKERS=6 timeout 1500 npm run test:tier1`（`/tmp/p1-tier1.log`）：
  **Duration 271.84 s**（tests 1009.77 s，collect 278.57 s，prepare 84.26 s）；1556 个文件，1554 通过、2 失败；31505 passed / 2 failed / 3 skipped。
  与 explore 估算一致（Tier 1 约 5–7 min 区间；未做默认 worker 与 =4 的对照，只跑了 =6）。我没有汇总最慢 5 个文件。
  两个失败**都不是本包引起**：
  1. `tests/startup-bundle/dispatcher.test.ts` → `build:bundle FAILED — dist/bundle/index.js on disk differs from a fresh build`。`dist/bundle` 构建于 12:53，而工作区里并行包已改了 `src/index.ts`、`src/fabric/**`，bundle 过期；属环境（先 `npm run build:bundle`），我没有重建，因为 dist 不在我的文件域。
  2. `tests/workflow/m34-script-api.test.ts` NW5 用例 10 s 超时；单独复跑 13/13 通过（1.36 s）⇒ 负载型 timing flake，该文件不在 TIER1_DECLARED（词法标记没命中它，属于 D4a 残留：词法门漏判）。
- `npm run typecheck` → exit 0（只覆盖 src；它不含 tests/，所以另用临时 tsconfig 对 `tests/tiers.ts`、两个新测试、`vitest.workspace.ts` 做了 tsc 检查，exit 0，输出为空；`/tmp/p1-tsc-files.log`）。
- `npx prettier --check`（上述 6 个改动文件）→ All matched files use Prettier code style。
- `git diff --quiet HEAD -- tests/fixtures/` → exit 0。

## 过程中的修正

- 初版 `validateManifest` 的「不属任何 project」规则是死代码（`projectFor` 感知登记表，登记过的路径总能解析）；改为直接校验路径形状（`isTestFilePath`），对应反例用 `src/…test.ts` 路径验证会触发。
- `test-tiers.test.ts` 自身的合成 fixture 含 `node:child_process`/`gocryptfs`/`setTimeout(…,5_000)` 字面量，被 D4 门拦下，已登记为 `false-positive`（门在对自己生效，符合预期）。
- actual 测试首版的断言写成了字符串比较，伪造了失败；改为直接比较 missing/extra 数组。

## 遗留 / 交 root

- 未验证：vitest `--project secure` 实际执行时的 globalSetup（P2 要追加的钩子）——按指令没跑 secure。tier1 的整轮运行证明了 baseProject 的 global-tz 与 sandbox-home 在 inline project 中生效（31505 个用例通过，其中含 TZ 敏感 golden 与 `tests/setup/sandbox-home-guard.test.ts`）。
- 根配置 `include` 保留；workspace 存在时根 project 本身是否会再产生一份「core project」文件集——`vitest list` 的 1762 去重计数和 3 个 project 计数一致，没发现重复。
- `src/index.ts`、`src/fabric/**`、`tests/fabric/**`、`tests/config/**` 的改动不是我的，未触碰。
- 不要把 `npm test` 的 worker 分配当成变化：根配置 maxWorkers 未改。
