# 源码治理第二批 · ⑩-S 报告：`secure/bin/helper.mjs` 拆分

基线 `dev@74703578`，分支 `gov/step10s`。方案：`batch2-plan.md` §7.2（拍板 D10-1/D10-2：helper 拆分沿用惰性 `await import`，不做 TS 化）。

## 行数

| 文件                          | 前   | 后   |
| ----------------------------- | ---- | ---- |
| `src/secure/bin/helper.mjs`   | 6927 | 5826 |
| `src/secure/bin/init.mjs`     | —    | 237  |
| `src/secure/bin/private.mjs`  | —    | 877  |
| `src/secure/bin/finalize.mjs` | —    | 148  |
| 合计                          | 6927 | 7088 |

合计多出的 161 行是三个新文件的头注释、导入块和 `export` 关键字；函数体一字未改。

## 提交

| 步骤 | hash       | 标题                                                                                   |
| ---- | ---------- | -------------------------------------------------------------------------------------- |
| 1    | 20f88805   | refactor(secure): move cmdInit out of helper.mjs into init.mjs                         |
| 2    | 6d9155b9   | refactor(secure): move the in-namespace finalize steps into finalize.mjs               |
| 3    | 75d53135   | refactor(secure): move the --private command bodies out of helper.mjs into private.mjs |
| 4    | 02a36680   | docs(secure): describe the helper.mjs / init / private / finalize split                |
| 5    | （本报告） | docs(governance): report batch 2 step 10-S                                             |

## 移动清单

- `init.mjs`：`cmdInit`（191 行）。
- `finalize.mjs`：`lazyDetach`、`finalizeInNs`（`__ns-root` 在 ns 内的收尾序列）。
- `private.mjs`：`cmdPrivateClaim/Update/Release/AbortStart/Terminate`、`lockPrivate`、`lockOuter`、`cmdMountWork`、`cmdNsRoot`，以及只被它们使用的 `deletePrivateRecordSync`、`LOCK_WAIT_MS`、`waitInstanceGone`、`supervisorMountinfo`、`waitInnerUserNs`。静态导入 `finalize.mjs`。
- `helper.mjs` 的分发处（`main` 的 `init` / `__private-*` / `__ns-root` / `__mount-work` 分支，`cmdLock` 里调 `lockPrivate` 的一行，`cmdNsRoot` 迁出前对 `finalize.mjs` 的调用）改成 `await (await import("./x.mjs")).fn(...)`。
- 新文件从 `helper.mjs` 具名导入原语（环形引用，但只会从 helper 进入：`private.mjs` 等只被 helper 的分发器动态加载，动态导入发生在 helper 求值完成之后）。为此 18 个 helper 内部绑定补了 `export` 关键字：`usageText must requireNewLayout runPrivate out lstatOrNull otherRegisteredVaults requirePrereqs requireTty runInherited err printWarnings sleep TIMEOUT HEX32_RE freshView readTextOr deadlineRace fsyncDirSync`。除此之外 helper 的导出面没有变化，只增不减。

## 与方案文字的偏差（需要知道）

方案说「helper 必须继续导出被移走的函数（测试当 API 用）」，同时又要求「`launcher-cli.test` 只拷 `helper.mjs` ⇒ 必须惰性 import」。这两条对**已导出**的函数互相冲突：`export … from "./x.mjs"` 是静态导入，helper 单拷时加载就会失败。解法是只移动**没有导出的**命令体和只服务于它们的内部函数；已导出的函数（私有记录解析/扫描/spawn spec、`finalize`/`finalizeBounded`/`scanCwdOccupants`/`spawnUnmount`、`releaseRecord`/`updateRecord`、`underMountLock` 等）全部留在 `helper.mjs`，所以 `H.x` 的测试用法零改动。代价是 helper 没有降到方案设想的 ~5000 行以下（5826）；`finalize.mjs` 只装得下 ns 内收尾两个函数，不是整个「卸载/占用扫描」。要继续瘦身，需要先改 launcher-cli 的拷贝方式或让测试直接导入新文件（不在本包范围）。`underMountLock` 方案点名要移，但导出的 `updateRecord`/`releaseRecord` 在用它，同理留下。

## 零行为证据

- 机械比对：用 TypeScript parser 解析 `74703578` 的 helper 与现在的四个文件，逐个顶层声明比较（忽略 `export ` 前缀）：324 个声明字节一致（其中 17 个换了文件），只有 `main`、`cmdLock` 两个分发函数不同，差异就是上面那几行动态导入。
- `unref()` 计数：之前 17，现在 helper 15 + private 2 = 17。新文件没有模块级 `let`/`var`（I4）。
- 冻结物：`git diff --quiet 74703578 -- tests/fixtures/` 为空（`secure-contract-parity.json`、`secure-off-golden.json`、`secure-launcher-off-golden.json` 都没动）。
- 源码钉跟着改指向新文件，断言意图不变：
  - `launcher-v6-wiring`「init 不删任何东西」：cmdInit 函数体改读 `init.mjs`，断言原样；
  - `launcher-private-unit`「只有 release/abort-start 删记录」「ns-root 从不 release」「`deniedMeans:"outside"` 只出现一次」：改读 `private.mjs`/`finalize.mjs`；新增一条断言：`helper.mjs` 里不再出现 `deletePrivateRecordSync`；`deniedMeans` 的出现次数按文件钉成 `[0, 0, 1]`。
- 步骤 1/2/3 每步都是绿的（步骤 2 的提交里随带了它需要的测试指向调整）。

## 自验

- `npm run typecheck` 通过；`npm run format:check` 通过。
- `npx vitest run tests/secure tests/conformance --maxWorkers=2`（快照目录里整套跑）：conformance 全绿；secure 里除下面三类环境问题外全绿，见「测试结果」。
- UI 没有涉及，`build:web` / `check:web` / `tests/web-hub` 未跑（本包没有碰 web-hub）。

## 测试结果

整套 `tests/secure tests/conformance` 一次跑完，失败文件 7 个，逐个归因：

| 文件                                                                                                | 整套里的结果              | 归因 / 复跑                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launcher-helper`                                                                                   | 1 失败（`findPiPackage`） | 基线同样失败（worktree 的 `node_modules` 是符号链接），与本包无关                                                                                                                                                   |
| `launcher-convert`                                                                                  | 31 失败                   | 主机上有读不到 `/proc/<pid>/exe` 的同 uid 进程（sshd、sd-pam），convert 的占用检查要求确认而拒绝。**基线 `74703578` 同样失败**（用 `git archive` 解出基线跑同样的用例，同一条 sshd 提示）；该套件不经过被移动的代码 |
| `archive`、`convert-state`、`launcher-v6-wiring`（1 个）、`launcher-off-golden`、`launcher-private` | 各 1 个失败或 skip        | 整套并行时别的 worktree / 我自己被杀掉的旧快照留下了全局 gocryptfs 挂载，`run --private` 拒绝继承全局挂载（套件靠 flock 串行，但外来挂载挡不住）。清掉残留后**单独复跑全部通过**                                    |

清理残留挂载后的复跑（无外来挂载）：`launcher-private-unit` 110/110、`archive` 121/121、`launcher-private-cmd` 42/42、`launcher-v6-wiring` 34/34、`launcher-off-golden` 24/24、`launcher-private` 21/21、`convert-state` 103/103（单独跑）。`launcher-cli`（只拷 `helper.mjs` 的 git 安装烟测）30/30。`tests/conformance` 全部通过（含 `secure-gocryptfs` 自门控的 C1–C5）。

## 遗留

- 基线上 `tests/secure/launcher-helper.test.ts > findPiPackage walks up from the real pi entry to the package root` 在 `/tmp` worktree 里就失败（期望路径落在主工作区 `node_modules`，而 worktree 的 `node_modules` 是符号链接），与本包无关。
- 真 gocryptfs 的套件互相用同一把锁串行，且遇到别的 worktree 留下的全局 gocryptfs 挂载会自动 skip（`launcher-private-unit` 的 N1 smoke 6 个用例就是这样）；已在静默后重跑，见下。
