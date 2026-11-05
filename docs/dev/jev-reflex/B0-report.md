# B0 · 契约冻结 — 交付报告

> 包：#25 jev-reflex B0（`docs/dev/jev-reflex/backtest-plan.md` §「B0 · 契约冻结」13 步）
> 依赖文档：`backtest-arch.md`（BA，r3）、`backtest-plan.md`（r3）、`README.md`（R-I1…R-I14）
> **B0_COMMIT: `<TODO — 由 root 在提交后填入>`**
> 分支 dev，开工基线 `6c41c123`（`git log origin/dev..HEAD` 当时为空）

## 1. 实现范围（13 步逐条对照）

| 步骤 | 内容                                                                            | 状态 | 落点                                                                                                                               |
| ---- | ------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1    | drafts-off parity 先捕获（X4）                                                  | ✅   | `tests/reflex/drafts-off-parity.test.ts`、`tests/fixtures/reflex-drafts-off-parity.json`                                           |
| 2    | `core/types.ts` 只追加全部跨包类型                                              | ✅   | 28 个 BA 类型 + `lineage?` / `origin?` / `draftHash?` / `templateHash?` / `port.portId?` / `targetOrigin?` / `targetTemplateHash?` |
| 3    | 设置三件套（默认关、非 live、D8）                                               | ✅   | `core/settings.ts`、`src/config/settings.ts`、`setting-specs.ts`                                                                   |
| 4    | pin / corpus 刷新 + secure/locked 断言                                          | ✅   | `setting-specs-pin.json`、`settings-corpus.json`、`settings-override.test.ts`、`reflex-settings.test.ts`                           |
| 5    | `core/branch-like.ts` 逐字搬迁                                                  | ✅   | `core/branch-like.ts`（`wire.ts` 仅换 import）                                                                                     |
| 6    | `core/port-defaults.ts` 从 catalog 派生                                         | ✅   | `MVP_PORTS` / `portDefaultsOf` / `portSignatureOf` / `TOOLLESS_PORTS` / `portOfScript` / `derivePortTable`                         |
| 7    | `core/draft-regex.ts` DRX 递归下降解析器                                        | ✅   | `parseDrx` / `drxToSource` / `DRX_*` 常量                                                                                          |
| 8    | `core/draft-schema.ts` validateDraft ①–⑦                                        | ✅   | `validateDraft` / `DRAFT_CAPS` / `DRAFT_LOAD_BUDGET_MS` / `DIR_SCAN_CAP` / `DRAFT_NAME_RE`                                         |
| 9    | `core/identity.ts`                                                              | ✅   | `templateHash` / `draftHash` / `identityKey` / `resolveIdentity`                                                                   |
| 10   | `core/schema.ts` lineage + draft 前缀；`shadow-scan.ts` 宽进 + `scanReflexLine` | ✅   | `RScriptV1Schema.lineage`、`validateCatalog` 拒 `draft.`、`scanReflexLine`                                                         |
| 11   | `drafts/load.ts` 骨架                                                           | ✅   | `DraftFs` / `DRAFT_READ_FLAGS` / `loadDrafts`（恒空、零 I/O）                                                                      |
| 12   | pi-free 门禁加 `drafts/**`                                                      | ✅   | `tests/boundary/pi-free.test.ts`                                                                                                   |
| 13   | 文档（README / data-encryption / AGENTS.md）                                    | ✅   | 见 §5                                                                                                                              |

新增测试 8 个文件 + 共享构造器，追加用例 2 个既有测试。

## 2. 门禁输出摘要

### 2.1 方案 §B0「门禁」第一条（全量定向套件）

```
npx vitest run tests/reflex tests/config tests/secure/settings-override.test.ts \
  tests/boundary tests/web-hub/boundary.test.ts tests/governance \
  tests/integration/reflex-off-golden.test.ts tests/docs/agents-md.test.ts
→ Test Files  90 passed (90)
  Tests      1208 passed (1208)
```

### 2.2 FX 门禁第一段（X4）

```
$ git diff --quiet origin/dev -- tests/fixtures/ ':!tests/fixtures/reflex-drafts-off-parity.json'
→ PASS（既有冻结文件对 origin/dev 字节相同）
```

**逐项核对**：

```
tests/fixtures/activate-trace.json       IDENTICAL vs origin/dev
tests/fixtures/reflex-off-golden.json    IDENTICAL vs origin/dev
```

### 2.3 parity 测试（X4 第二段的口径）

```
npx vitest run tests/reflex/drafts-off-parity.test.ts
→ Tests  3 passed (3)      （连续 8 次纯读复跑全绿）
```

三个用例：① 与 fixture 逐字节相等；② 两次捕获自相等（确定性）；③ 序列自检（5 record + 1 correction + 1 answer、record 无 drafts 字段、status 文本含 demote）。

### 2.4 DRX ReDoS 三类隔离（BA §4.5 r3）

```
npx vitest run tests/reflex/core/draft-regex.test.ts tests/reflex/core/draft-regex-redos.test.ts
→ 34 + 2 passed
```

- ① 拒绝集（主进程）23 条形状 × 3 role 全部只断言 `parseDrx` 拒绝、**不执行**；
- ② 危险演示独立子进程（`timeout: 2000`）断言「被信号终止 或 耗时 >1 s」→ 实测 2006 ms 被截止；
- ③ 接受集独立子进程（硬截止 5 s）1,000 个 DRX 源 × 7 类对抗输入（7,000 次匹配）→ `status===0`、无信号、自报 < 2 s。

### 2.5 `npm run format:check`

```
[warn] src/index.ts
[warn] src/reload/command-port.ts
[warn] src/web-hub/agent/reload-track.ts
[warn] tests/reload/command-port.test.ts
[warn] tests/web-hub/agent/reload-result-compat.test.ts
[warn] tests/web-hub/agent/reload-track.test.ts
[warn] tests/web-hub/agent/wiring-reload-status.test.ts
→ exit 1
```

**B0 文件域 0 警告**。剩余 7 个文件全部属于在途 reload 包（`src/reload/**`、`src/index.ts`、`src/web-hub/**`、`tests/reload/**`、`tests/web-hub/**`），按派单要求不碰。

配套改动：`.prettierignore` 加入 `tests/fixtures/reflex-drafts-off-parity.json`（A 级金身必须与测试自身序列化 `JSON.stringify(v, null, 2) + "\n"` 逐字节一致，prettier 排版会破坏它 —— 与 `tests/fixtures/quota/`、`version/` 同一先例）。

### 2.6 `npm run typecheck`

```
src/web-hub/agent/reload-track.ts(428,13): error TS2412 …
src/web-hub/agent/reload-track.ts(434,11): error TS2412 …
src/web-hub/agent/reload-track.ts(465,9):  error TS2412 …
→ exit 1
```

**B0 文件域 0 错误**。隔离验证（只把我的源码 + 测试作为 `files` 编译）：

```
$ node node_modules/typescript-7/bin/tsc -p /tmp/tsconfig.b0b.json
→ B0-domain errors: 0
```

（该隔离跑仍会带出 `reload-track.ts` 的同 3 条错误，因为它经由 `src/reflex/core/*` 的间接依赖被拉进编译图；已逐条确认错误文件只有它一个。）

### 2.7 `npm run build`

```
→ exit 2，失败原因 = 上面 reload-track.ts 的同 3 条 TS2412
```

**B0 自身不阻塞构建**；build 被在途 reload 包的未完成改动阻断。见 §6 遗留问题。

### 2.8 `npm run test:tier1`（日用门禁，`PI_TOOLKIT_TEST_WORKERS=6`）

**第一轮**（4m30s）：

```
Test Files  1 failed | 1568 passed (1569)
     Tests  1 failed | 31729 passed | 3 skipped (31733)

FAIL |tier1| tests/startup-bundle/dispatcher.test.ts > build script gates
  AssertionError: build:bundle FAILED — dist/bundle/index.js on disk differs from a fresh build
```

**定位与处置**：该断言来自 `scripts/build-bundle.mjs --check`，比较磁盘产物与「从 `src/index.ts` 现场重建」的 sha。`src/reflex/**` 的改动确实会改变 bundle 内容，而 `npm run build` 在 tsc 阶段被在途 reload 包阻断（§2.7），**没能刷新 `dist/bundle/index.js`**（mtime 停在 16:37，早于本轮改动）。

处理：单独跑一次 `node scripts/build-bundle.mjs`（不经 tsc，直接从 `src/` 打包）：

```
build:bundle ok — dist/bundle/index.js sha256=3a54c075129b558f size=4.72 MB time=184 ms inputs=698
```

`npx vitest run tests/startup-bundle/dispatcher.test.ts` → **8 passed**。随后整轮 tier1 重跑结果见 §2.8b。

**结论**：这不是 B0 的逻辑缺陷，而是「tsc 被在途包阻断 ⇒ 产物陈旧」的次生效应。`dist/` 是 gitignore 的构建产物，不进提交。一旦在途包修好 `reload-track.ts`，`npm run build` 会自然产出同样的 bundle。

### 2.8b `npm run test:tier1` 重跑（刷新 bundle 后）

```
$ PI_TOOLKIT_TEST_WORKERS=6 npm run test:tier1      # 4m39s
→ Test Files  1569 passed (1569)
  Tests      31730 passed | 3 skipped (31733)
  exit 0
```

**日用门禁全绿。** 首轮唯一的红是 §2.8 定位的陈旧产物，与本包逻辑无关。

## 3. pin / corpus 程序化比对输出

### 3.1 `setting-specs-pin.json`

```
added keys:            ['reflex.drafts.enabled']
removed keys:          []
order preserved for shared keys: True
changed hashes:        []
```

即**只多一个键**，全部既有键的 hash 与顺序不变。刷新方式按 R0 先例：
`GOV_SPECS_GENERATE=1 npx vitest run tests/config/setting-specs-pin.test.ts` → `prettier --write`。

### 3.2 `settings-corpus.json`

```
baseline: same | seed: same | randomCount: same | blocksPerKey: same
timePaths: same | retiredPaths: same
template equal after removing reflex.drafts: True  | drafts value: {"enabled": false}
captured sha churn: 368 / 368
```

`captured` 的 368 条 sha **全部变化**是期望的：每条输出都包含 `DEFAULT_SETTINGS` 的 `reflex` 子树，新增 `drafts` 后必然变。核心等价性证明在下一节。

### 3.3 等价性证明（临时脚本，未入库）

用**逐字复刻**的 corpus 生成器（`mulberry32` / `mutate` / `randomLeaf` / `STRING_POOL` 与 `tests/config/settings-corpus.test.ts` 比对确认 IDENTICAL）+ 复刻的 `evaluate()`，做四段断言：

| 断言                                                                                                        | 结果                                                         |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `head` 元数据（baseline/seed/randomCount/blocksPerKey/timePaths/retiredPaths）与 origin/dev 相同            | ✅                                                           |
| `template` 与 origin/dev 相同，**除了**新增 `reflex.drafts = {enabled:false}`                               | ✅                                                           |
| `strip(drafts)` 后 `DEFAULT_SETTINGS` 的 sha == origin/dev 的 `defaultsSha`                                 | ✅                                                           |
| 复刻生成器在 NEW head 上重放：`randomShas` 300/300、`blockShas` 658/658 全部命中                            | ✅                                                           |
| OLD head 在**当前代码**上重放 + strip(drafts)：random **300/300**、block **658/658** 命中 origin/dev 的 sha | ✅                                                           |
| `captured` 368 条：输入逐条相同 & strip(drafts) 后 sha 逐条等于 origin/dev                                  | ✅（首轮曾因 `__undef__` 反转义漏做报 1 条，修正后 368/368） |

结论：**corpus 与 origin/dev 的差异只有 `.reflex.drafts` 一子树**，其余行为字节不变。

**过程中发现并处理的两件事**（均为方法问题，不影响最终产物）：

1. 直接 `GOV_CORPUS_GENERATE` 再生成会**丢掉 `retiredPaths` 机制**（该 head 字段由人工维护，生成器不产出；#26 用它让 `/mem` 退休键继续作为"被容忍的陈旧输入"喂进来），并使 `timePaths` 少掉已退休的 `memory.jev.confirmTimeoutMs`。因该字段是 `template` 的语义补充（`stripRetired` 依赖它），我改用「**OLD head + 新 drafts 子树**」重建 head（保留 `retiredPaths` 与完整 `timePaths`），再由复刻生成器产出 shas。这样 diff 才真正收敛到"只多 `.reflex.drafts`"。
2. 由此可知 origin/dev 上的 corpus 在 `a820b356`（fabric ask-redirect）时是**部分更新**：`defaultsSha` + `captured` 随新代码重生，但 `randomShas`/`blockShas`/`timePaths` 未同步 —— 我的重放证明它们的**旧 sha 在当前代码上仍然全部命中**（300/300、658/658），说明那次部分更新没有引入行为漂移，只是元数据没刷。

## 4. 冻结面核对

| 冻结面                                                                                      | 状态       | 证据                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1（`src/index.ts`、fabric/web-hub/schedule/…、`catalog.ts`、`tests/fixtures/**` 既有文件） | ✅ 未触碰  | `git diff --quiet origin/dev` 对 `catalog.ts`/`promotion.ts`/`match.ts`/`gate.ts`/`state.ts`/`trace-profiles.ts` 全部 clean（`src/index.ts` 的改动属于在途 reload 包，diff 内容为 `createReloadCommandPort` 的 phase sink，与本包无关） |
| `wire.ts` 除 `toBranchLike` import 外一字不动                                               | ✅         | diff 只有：`agreement.js` 去掉 `type BranchEntryLike`、新增 `branch-like.js` import、删除本地函数体 + 3 行说明注释；`branch-like.test.ts` 用 origin/dev 原文做参考实现逐形状比对                                                        |
| `promotion/match/gate/state.ts` 不动                                                        | ✅         | 见上（clean）                                                                                                                                                                                                                           |
| `reflex-off-golden.json` / `activate-trace.json` 字节不变                                   | ✅         | 两者 `git diff --quiet origin/dev` 均 PASS                                                                                                                                                                                              |
| parity fixture 在改 wire 前捕获                                                             | ✅ 见 §4.1 | 内容 + 8 次复跑 + 捕获路径分析                                                                                                                                                                                                          |
| secure/locked 强制 drafts 关                                                                | ✅         | `applySecureDomainOverrides` + `settings-override.test.ts` 两处断言                                                                                                                                                                     |
| `core/settings.ts` 保持零 import                                                            | ✅         | 无任何 import 语句；`tests/web-hub/boundary.test.ts` 绿                                                                                                                                                                                 |
| AGENTS.md ≤ 32 KiB                                                                          | ✅         | 27,504 字节；`tests/docs/agents-md.test.ts` 10 passed                                                                                                                                                                                   |

### 4.1 parity fixture 的捕获时序（含一次重捕获，须 root 知情）

**首版**（17:07）序列用了 `git.status`（真实 git 子进程）。在 8 worker 并发的全量 `tests/reflex` 下，`queueMicrotask` 之后的 8 轮 `setImmediate` 内子进程有时未返回 ⇒ record 不带 `port` 字段 ⇒ 与 fixture 不符（单跑始终绿，全量偶红）。

**修复流程**（严格遵守"改 wire 之前捕获"）：

1. 把 `wire.ts` **临时还原**为 origin/dev 版本 —— 用 `git diff --quiet -- src/reflex/wire.ts` 验证字节相同后，才继续；
2. 删除旧 fixture；
3. 序列改为**全同步内存 port**（`fleet.status` 用于 shadow/替换，`jobs.list` 用于 AUTO/repeat；`git.status` 完全移出序列）；
4. `PI_TOOLKIT_REFLEX_PARITY_CAPTURE=1` 重新捕获（17:25:52）；
5. 重新施加惟一的 wire 改动（import 替换，17:26:45）；
6. 连跑 8 次确认稳定。

因此 fixture 的 mtime 晚于 `branch-like.ts`，**但捕获时 wire.ts 的 diff 为空**。这一点无法从 mtime 直接看出，故在此显式记录。fixture 内容中唯一出现的 `git.status` 字符串是 `/reflex status` 输出的脚本清单行，不是 port 调用（port 结果全为 `"outcome": "ok"`，3 条，来自同步内存 port）。

`PI_TOOLKIT_REFLEX_PARITY_CAPTURE` 只在 `!existsSync(FIXTURE)` 时写入，无覆盖路径。

### 4.2 一份额外改动：`tests/tiers.ts`（B0 globs 未列）

`tests/reflex/core/draft-regex-redos.test.ts` 用 `node:child_process`，`tests/governance/test-tiers.test.ts` 的 D4 词法门禁**强制**登记：

```
+  "tests/reflex/core/draft-regex-redos.test.ts": { kind: "proc", why: "proc:node:child_process" },
```

开工时在途 secure-symlink 包也在改此文件的 `SECURE_MOUNT_FILES` 区域，两处编辑不重叠。`tests/governance/test-tiers.test.ts` 11 passed。

### 4.3 `.prettierignore` 一处新增

见 §2.5。

## 5. 文档改动

| 文件                                 | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/dev/jev-reflex/README.md`      | 头部指向 `backtest-arch/plan`；「是什么」补 drafts 一句；R0 状态行前加 #25 B0 行；**R-I12 按 BA §6 改写**；**新增 R-I13（加载有界/no-follow/fail-closed）、R-I14（离线记录未认证、认证只在 catalog PR）**；**新增「威胁模型」一节**（同 UID 可执行任意 shell、0700/0600 只防其他 UID、四类记录 unverified、认证点 = PR）；**新增「离线回测与草案」一节**（语料/家族、confirmed-vs-lenient 与 `sourceMode` r3 判据、DRX、身份 K8、草案文件、V2 晋升、批次/manifest/暴露账本、上线流程摘要）；**新增「性能手动测法」**（B4 perf、DRX 隔离、B3 冷/热，注明不替代语法证明、不保证达标）；门禁表补 parity fixture 行、pi-free 补 `drafts/*`、D8 补 drafts、pin/corpus 行补键名 |
| `docs/dev/data-encryption/README.md` | D8 强制关闭清单补 `reflex`（含 `reflex.drafts`），理由：#25 BA §4.6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `AGENTS.md`                          | `src/reflex/` 布局行补「#25 离线回测 + 运行时草案（`reflex.drafts.enabled`，默认关、恒 shadow，DRX 语法约束）」与必读时机；Frozen artifacts A 级补 `reflex-drafts-off-parity.json` + 其 capture 环境变量。27,504 字节（≤32 KiB），`tests/docs/agents-md.test.ts` 10 passed                                                                                                                                                                                                                                                                                                                                                                                                |

**README 不含"TTY/0600/hash 可证明人工"类表述** —— 威胁模型一节明确否定了这三者。

## 6. 遗留问题

1. **`npm run build` / `npm run typecheck` / `npm run format:check` 不绿，原因全部是 `src/web-hub/agent/reload-track.ts`（及同包 7 个文件的格式）**；连带使 tier1 的 `startup-bundle/dispatcher.test.ts` 首轮红（产物陈旧，见 §2.8） —— 在途 reload/web-hub 包的未完成改动（`?? src/web-hub/agent/reload-track.ts` 未跟踪、`M src/index.ts` 等），按派单要求不碰。B0 文件域经隔离编译验证 0 错误、0 格式警告。合入顺序上，此包完成后 `format:check`/`typecheck`/`build` 应全绿；若它先于我合入且仍报错，需要它先修。
2. **`tests/tiers.ts` 不在 B0 globs**（见 §4.2），已按 D4 门禁要求登记。
3. **corpus `retiredPaths` 的人工维护**（见 §3.3 第 1 点）：未来若再动 `DEFAULT_SETTINGS` 结构，`GOV_CORPUS_GENERATE` 的朴素用法会丢该字段，建议 B3 或后续包把 head 的 `retiredPaths` 也纳入生成器输入。
4. **`loadDrafts` 目前恒返回空**（骨架，符合 B0 定义）：B4 必须保留 `DRAFT_READ_FLAGS === SESSION_READ_FLAGS` 的断言（已由 `draft-schema.test.ts` 钉住）。
5. **B0_COMMIT 待 root 补**：parity fixture 的 FX 门禁第二段 `git diff --quiet "$B0_COMMIT" -- tests/fixtures/reflex-drafts-off-parity.json` 需要在提交后由后续包执行。
6. **给 root 的 message 发送失败**（两次 `message not authorized`）：内容已完整写入 §4.1 与 §4.2 —— 即①`tests/tiers.ts` 的写权限归属、②parity fixture 的重捕获时序。

## 7. 附：文件清单（绝对路径）

**新建源码**（6）

```
/home/bluecake/ai/pi-toolkit/src/reflex/core/branch-like.ts
/home/bluecake/ai/pi-toolkit/src/reflex/core/port-defaults.ts
/home/bluecake/ai/pi-toolkit/src/reflex/core/draft-regex.ts
/home/bluecake/ai/pi-toolkit/src/reflex/core/draft-schema.ts
/home/bluecake/ai/pi-toolkit/src/reflex/core/identity.ts
/home/bluecake/ai/pi-toolkit/src/reflex/drafts/load.ts
```

**新建测试**（9）

```
/home/bluecake/ai/pi-toolkit/tests/reflex/helpers/turn.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/drafts-off-parity.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/branch-like.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/port-defaults.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/draft-regex.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/draft-regex-redos.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/draft-schema.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/identity.test.ts
/home/bluecake/ai/pi-toolkit/tests/fixtures/reflex-drafts-off-parity.json
```

**修改**（16）

```
/home/bluecake/ai/pi-toolkit/src/reflex/core/types.ts          (+28 类型 / 5 个可选字段)
/home/bluecake/ai/pi-toolkit/src/reflex/core/settings.ts        (drafts 解析，零 import)
/home/bluecake/ai/pi-toolkit/src/reflex/core/schema.ts          (lineage? + 拒 draft. 前缀)
/home/bluecake/ai/pi-toolkit/src/reflex/core/shadow-scan.ts     (宽进字段 + scanReflexLine)
/home/bluecake/ai/pi-toolkit/src/reflex/setting-specs.ts        (reflex.drafts.enabled)
/home/bluecake/ai/pi-toolkit/src/reflex/wire.ts                 (仅 import 替换)
/home/bluecake/ai/pi-toolkit/src/config/settings.ts             (默认值 + D8)
/home/bluecake/ai/pi-toolkit/tests/config/__corpus__/setting-specs-pin.json
/home/bluecake/ai/pi-toolkit/tests/config/__corpus__/settings-corpus.json
/home/bluecake/ai/pi-toolkit/tests/config/reflex-settings.test.ts
/home/bluecake/ai/pi-toolkit/tests/secure/settings-override.test.ts
/home/bluecake/ai/pi-toolkit/tests/boundary/pi-free.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/schema.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/shadow-scan.test.ts
/home/bluecake/ai/pi-toolkit/tests/tiers.ts                    (proc 登记，见 §4.2)
/home/bluecake/ai/pi-toolkit/.prettierignore                   (见 §2.5)
/home/bluecake/ai/pi-toolkit/docs/dev/jev-reflex/README.md
/home/bluecake/ai/pi-toolkit/docs/dev/data-encryption/README.md
/home/bluecake/ai/pi-toolkit/AGENTS.md
```
