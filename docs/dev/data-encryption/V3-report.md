# V3 报告 — sessions 引擎（`src/secure/bin/sessions.mjs`）

> 包 V3（convert-plan r3 §8.1）：pi 头规则镜像、发现/入选/预算闭包、只读复制 + 复读校验、副本改写、memory 精确 slug 复制、迁址引擎。
> 文件域：`src/secure/bin/sessions.mjs`（新，1338 行）、`tests/secure/sessions.test.ts`（新，31 用例）。零依赖 ESM（仅 Node ≥22 内建），不接线命令（V4/V5 消费），未触碰 helper.mjs / `src/secure/*.ts` / V1 tar.mjs / V2 tree.mjs。
> 核心约束（用户拍板）：旧会话与旧 memory **只复制，绝不修改或删除源文件**——模块对源只做 `openSync(…, "r")` / `readFileSync` / `lstat` / `stat`，没有任何指向源的写路径。

## 1. API（全部导出，V4/V5 以此消费）

### 常量

| 导出                                                                        | 值                   | 依据                                                    |
| --------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------- |
| `SESSION_HEADER_SCAN_MAX_BYTES`                                             | 1 MiB                | pi `MAX_SESSION_HEADER_SCAN_BYTES` 镜像                 |
| `SUBAGENT_RUN_CUSTOM_TYPE`                                                  | `"subagent:run"`     | 钉住 `src/adapters/pi-run-log.ts`（与 provenance 同源） |
| `CLOSURE_MAX_FILES` / `CLOSURE_MAX_BYTES`                                   | 2000 / 512 MiB       | §2.2 #4                                                 |
| `COPY_MAX_ATTEMPTS`                                                         | 3                    | §2.3                                                    |
| `TREE_WALK_MAX_ENTRIES` / `TREE_WALK_MAX_DEPTH` / `SETTINGS_JSON_MAX_BYTES` | 100 000 / 64 / 1 MiB | §2.2 #1 树内 settings 扫描预算                          |
| `MEMORY_AMBIGUITY_MAX_DASHES`                                               | 10                   | §2.5（k>10 ⇒ 不枚举直接判歧义）                         |
| `PARENT_SCAN_MAX_DIRS` / `PARENT_SCAN_MAX_FILES`                            | 4096 / 20 000        | R28 报告型扫描预算                                      |
| `SessionsError`                                                             | `{code}`             | `stateSessionsDirFor` 的入参错误                        |

### pi 头镜像与路径

- `readSessionHeaderLikePi(filePath)` → `{status:"ok", header}` | `{status:"invalid", reason:"not-session"|"scan-limit"|"unreadable"|"empty", message?}`。逐行镜像 pi `readSessionHeader`（含 4096 字节分块、1 MiB 窗口、窗口尽头的 1 字节 EOF 探测）。
- `sessionDirSlug(cwd)`：`--<cwd 去掉开头 / 后把 / \ : 换成 ->--`；`sessionDirSlugPrefix(cwd)`：slug 去掉最后一个 `-`，是「根自身 slug + 一切子目录 slug」的共同前缀（也覆盖 dash 同名兄弟——toSlug 有损，逐文件头 cwd 过滤才是权威）。
- `memorySlug(cwd)`：镜像 `src/memory/paths.ts` 的 `toSlug`（去尾 `/`、`/`→`-`）。
- `isPathWithin(child, root)`、`matchWithinRoots(cwd, roots)`：按路径段对齐；先字面 `resolve` 再 `realpath` 双侧匹配，返回 `{root, remainder, via}` 供 cwd 改写切片。

### 发现 / 入选 / 闭包（无写）

- `readSessionDirFromSettings(file)`、`resolveSessionDirValue(value, {home, projRoot})`：settings.json 的 `sessionDir`（绝对 / `~/` / 相对于项目根）。
- `findProjectSettingsFiles(treeRoot, {maxEntries, maxDepth})` → `{files, truncated, entriesScanned}`：有界、不跟随符号链接的 `.pi/settings.json` 收集（跳过 `.git` 子树——settings 不会在那里）。
- `discoverSessionSources({root, treeRoot, agentDir, home, globalSessionDir, envSessionDir, extraDirs, walkBudget})` → `{sources:[{dir, why}], notes, settingsFiles, treeWalkTruncated}`。五类来源按 §2.2 #1：slug 目录（root 字面 + realpath 两种拼写各算一次，按 realpath 去重）、全局 settings sessionDir、树内每个 `.pi/settings.json`、`PI_CODING_AGENT_SESSION_DIR`、每个 `--sessions-from`。`why` 记录来源（`slug:<名>` / `settings:global` / `settings:<文件>` / `env:…` / `sessions-from`）。
- `scanSessionDir(dir)` → `{dir, missing, files:[{file, size, mtimeMs, dev, ino, header, headerStatus, headerReason}]}`（`*.jsonl` 排序枚举）。
- `extractRunRefs(content, filePath)`：`subagent:run` → `diag.sessionFile`（便宜子串预过滤 + 严格形状检查，镜像 provenance；相对引用按所在文件目录 resolve）。
- `planSessionCopy({sources, matchRoots, newRoot, budgets})` → `{copySet:Map<absPath, {file,size,mtimeMs,cwd,headerStatus,inTree,why}>, matchRoots, newRoot, outOfTree, invalid, partial, unfinishedRefs, budget, scannedDirs}`。入选 = `matchWithinRoots(header.cwd, matchRoots)`；闭包 BFS 按 `(dev,ino)` 去重、预算先于读取判定（超预算文件不入内存）；悬空 ref 记入 `unfinishedRefs` 不失败。

### 复制 + 改写 + 校验

- `rewriteSessionContent({content, inTree, matchRoots, newRoot, pathMap, file})` → `{content, rewrote:{cwd,parentSession,runRefs}, checks, file}`。改写且仅改写：头行 `cwd`（树内会话）、头行 `parentSession`（落在 pathMap 内）、每条 `subagent:run` 的 `data.diag.sessionFile`（落在 pathMap 内，含同一 run 的多条）；其余行逐字节不变，不升级 version。
- `copySessionFile({src, destDir, inTree, matchRoots, newRoot, pathMap, hooks})` → `{src, dest, status:"complete"|"skipped"|"partial"|"conflict", attempts, reason?, rewrote?}`。流程：读全文（sha256+size）→ 改写 → tmp（`O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` 0600 + fsync + rename）→ **复读源比对**（一致 ⇒ 恢复源 mtime/atime ⇒ 读回校验）；不一致（复制期间被追加）⇒ 用新内容重做，≤3 次；从未一致 ⇒ 删掉本次副本、报告 `source-appended`。`hooks.beforeVerify({src, attempt, content})` 是 §7.1「复制期间追加」用例的测试缝（每次尝试在写完 tmp 之后、复读源之前触发）。
- `copySessions({plan, destDir, hooks})` → `{destDir, files, conflicts, partial, counts}`。pathMap = copySet 全体 → `<destDir>/<basename>`；目标先在（重入）：逐字节等于改写结果 ⇒ `skipped`；不同 ⇒ `conflict`（V4 映射 74），绝不覆盖。
- `convertCopySessionsAndMemory({root, rootRealpath, treeRoot, newRoot, agentDir, home, memoryRoot, destStateDir, globalSessionDir, envSessionDir, extraDirs, budgets, hooks})` → 一次性编排（发现 → 计划 → 会话复制到 `<destStateDir>/sessions/default` → memory 复制到 `<destStateDir>/memory`），返回 **JSON 可序列化**报告（worker 传输友好）。**`rootRealpath`：改名前捕获的源根 realpath 拼写**——改名后（步骤 10 时）`realpath(root)` 已失效（原路径不存在或已是指向库内的符号链接），而会话头可能记录的是 pre-rename realpath 拼写；V4 必须传入早检时捕获的值。`discoverSessionSources` / `memoryExactSlugs` / `copyProjectMemory` 同名参数同理（缺省回退当前磁盘 realpath，供改名前/测试场景）。
- `formatManualCleanup(report)`：完成输出用的旧路径清单（旧会话目录/文件 + 分块 `rm` 行、旧 memory 目录、歧义跳过项）。

### memory（只复制）

- `memoryExactSlugs({root, memoryRoot})`：根的精确 slug（字面 + realpath 各一次，去重；空 slug 跳过）。不取前缀/子目录 slug。
- `checkMemorySlugAmbiguity(slug, ownPaths)` → `{ambiguous, collisions, reason?}`：枚举 ≤2^k 种解码（slug 首字符必为 `/`——cwd 是绝对路径，只有其余 `-` 有歧义），任一非本根解码在磁盘上真实存在且是目录 ⇒ 歧义。
- `copyMemoryDir({srcDir, destDir, hooks})`：slug 目录本身可为用户可信符号链接（`realpath` 解析一次后遍历真实目录）；文件级符号链接/非普通文件跳过并报告；逐文件 sha256 + 复读规则（同 §2.3），恢复 mtime/atime。
- `copyProjectMemory({root, newRoot, memoryRoot, destMemoryRoot, hooks})` → `{results, ambiguity, destDir, destSlug, sourceListed}`。目标 = `<destMemoryRoot>/<memorySlug(newRoot)>`；歧义 ⇒ 整体跳过 + 报告；旧目录不动。

### 报告型清单（只读）

- `listForeignHeaderMatches(dirs, matchRoots, {maxFiles})`：consult 缓存 / web-hub `spawn/fork-src/` 等目录中头 cwd 落在项目内的文件（R12 明文残留提示；目录路径由 V4 传入）。
- `findParentLinks({agentSessionsRoot, extraDirs, copySetPaths, maxDirs, maxFiles})` → `{links, truncated, filesScanned}`：其他项目里 `parentSession` 指向复制集内文件的会话（R28），只列出。

### 迁址引擎（§3.4，写发生在新库内）

- `stateSessionsDirFor(realWork)`：`<realWork>`（须以 `/work` 结尾）⇒ `<mnt>/state/sessions/default`。
- `rewritePathPrefix(p, from, to)`：按路径段对齐的前缀替换（不命中返回 undefined）。
- `relocateSessionContent(content, {from, to, fromSessionsDir, toSessionsDir})` → `{content, changed:{cwd,parentSession,runRefs}, anyChange}`（纯函数）：头 `cwd` 的 `from`→`to`、头 `parentSession` 与所有 `subagent:run` `diag.sessionFile` 的 `fromSessionsDir`→`toSessionsDir`；坏行/空行逐字节透传 ⇒ 整个操作幂等。
- `relocateSessionsInDir(dir, rules, {onProgress, batchSize})`：逐文件 tmp+rename（0600、fsync、保 mtime/atime），未变化的文件不碰（可重入）；`onProgress(已处理数)` 每 batch 回调（V5 更新 relocate phase）。
- `relocateMemoryDir(memoryRoot, {from, to})`：`state/memory/` 中精确 `memorySlug(from)` 改名为 `memorySlug(to)`；目标已存在 ⇒ `{renamed:false, reason:"target-exists"}`（不合并，报告）；源缺失 ⇒ `reason:"absent"` 无操作成功。

## 2. 入选规则与 pi 事实对照（§2.1）

| 方案 §2.1 事实                                              | 实现                                                                                                                      | 测试锚点                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 默认会话目录 slug 有损编码                                  | `sessionDirSlug` 逐字镜像 `getDefaultSessionDirPath`                                                                      | discovery 用例 + dash-兄弟目录用例                 |
| 头读取窗口 ≤1 MiB、跳过空行与坏行                           | `readSessionHeaderLikePi` 分块镜像（StringDecoder、窗口、EOF 探测）                                                       | 「空行/坏行/1 MiB 窗口/边界恰 1 MiB/空文件」5 用例 |
| 自定义 sessionDir 下按头 cwd 精确过滤                       | 复制后副本断言真 pi `SessionManager.list(work, dir)` / `list(work/sub, dir)` 可见性（即 `/resume-recent` 的真实调用形态） | 2 个可见性用例                                     |
| `parentSession` 为绝对路径                                  | 入选（指向复制集内文件时映射改写）；R28 反向链接 `findParentLinks` 只列出                                                 | parentSession 映射用例 + R28 用例                  |
| 子会话落在子会话 cwd 对应默认目录、第 2 行 `subagent:child` | 闭包按 `subagent:run` ref 追踪（子女 cwd 在树外，不改写、逐字节复制）                                                     | 闭包用例（孙会话 + 同 run 双条目）                 |
| 父会话 `subagent:run` 条目（同 run 多条）`diag.sessionFile` | 同一 run 的**所有**条目只要落在复制集内都改写                                                                             | 「同 run 两条都改写」断言                          |
| 会话目录来源链                                              | `discoverSessionSources` 的五类候选（env 缺省读 `process.env.PI_CODING_AGENT_SESSION_DIR`）                               | settings/env/extra 三个用例                        |

**一处对方案措辞的修正（以 pi 源码为准，XC6 方向）**：方案 §2.1 写「取第一条合法的 `type:"session"` 记录」；pi 实际规则（`readSessionHeader`/`buildSessionInfo` 一致）是**第一条可解析行必须是会话头**——可解析的非 session 首行使整个文件无效（发现返回 null），而不是继续向后找。镜像按源码实现，且每个头规则用例都与真 pi `findMostRecentSession`（走 `readSessionHeaderForDiscovery` 同一 1 MiB 有界路径）交叉断言等价。

## 3. 校验（§2.3）

1. **复读源**：写完 tmp 后重读源，比对 sha256 与字节长度；不一致（pi 追加了）⇒ 以新内容重来，≤3 次；从未一致 ⇒ 移除本次副本（不留半成品）、`partial:"source-appended"`、源不受影响。
2. **读回副本**：整文件字节等于改写预期（⇒ 行数相同、未改写行逐字节相同）+ 每条改写行做「除映射字段外深度相等」结构校验（源快照 vs 副本，删掉映射字段路径后 deepEqual）。
3. **目标先在**：逐字节等于改写结果 ⇒ `skipped`（重入）；不同 ⇒ `conflict`（V4 → 74 回滚），目标不被覆盖（测试断言原内容原样）。
4. **源只读**：测试在整轮复制前后断言源的 dev/ino/size/mtime/内容与源目录 mtime 完全不变。

## 4. 预算

| 预算               | 值                                    | 超限行为                                                                           |
| ------------------ | ------------------------------------- | ---------------------------------------------------------------------------------- |
| 闭包               | ≤2000 文件 / ≤512 MiB                 | `plan.partial=true`，已发现部分照常复制，`unfinishedRefs` 列未追完项（只影响报告） |
| 单文件头扫描       | 1 MiB 窗口                            | 超窗 ⇒ `invalid:"scan-limit"`，不复制只报告                                        |
| 树内 settings 扫描 | ≤100 000 条目 / 深 64 / 单文件 ≤1 MiB | `truncated=true` 记入 notes（报告型）                                              |
| memory 歧义枚举    | ≤2^k（k≤10）                          | k>10 ⇒ 直接判歧义跳过 memory                                                       |
| R28/外域头扫描     | ≤4096 目录 / ≤20 000 文件             | `truncated=true`（报告型）                                                         |
| 复制重试           | 3 次                                  | 见 §3                                                                              |

## 5. 偏差与残留

- **头规则措辞修正**：见 §2 末段（按 pi 源码，非方案原文措辞）。
- **「保留最后一次一致读取的副本」不可达**：§2.3 该句在本实现中对应的状态不可达——任何一次复读一致都会立即提交为 complete；「从未一致」路径则不留副本。语义上两种结局都已覆盖（保留副本 = complete 的快照语义 + 报告；不写副本 = partial）。
- **闭包子女文件不做头有效性剔除**：被 ref 指到的文件即使头无效也逐字节复制（不发生改写；`headerStatus` 记录在案）——provenance 标记是权威来源，pi 懒落盘的半成品子女照样保真。
- **目标同名跨目录冲突**：不同源目录同 basename 的两个会话落到同一 `<dest>/sessions/default/` ⇒ 第二个 `conflict`（V4 → 74），不做自动改名——与方案「否则冲突 ⇒ 74 回滚」一致。
- **copySessionFile 自建 destDir**（`mkdirSync recursive`）：方案里目录由 V4 的 `ensureVaultDirs` 先建；此处防御性自建不影响行为（0700）。
- **`hooks.beforeVerify` 测试缝**：内部参数，仅供「复制期间追加」用例注入；生产调用不传。
- **`listForeignHeaderMatches` / `findParentLinks` 的目录路径由 V4 传入**（consult 缓存 `<agentDir>/cache/consult-sessions`、hub `<stateDir>/spawn/fork-src/` 等的定位属接线层）。
- **memory 文件 mtime/atime 也恢复**（方案只要求 sha 复读规则；恢复时间无害且与 §2.3 口径一致）。
- **`relocateSessionsInDir` 保持 mtime/atime**：迁址是库内重写，保持时间戳让 `/resume` 列表顺序不变（方案未明说，取 §2.3 同口径）。
- **树内 settings 扫描跳过 `.git`**：settings.json 不会位于 `.git` 内；预算省给真实目录。
- 残留（方案既有）：R26 旧数据删除 ≠ 擦除；R28 会话正文里的旧路径不改写、未知历史目录与反向链接只列出；W10 slug 有损由「头 cwd 入选 + memory 精确 slug + 歧义跳过」缓解。

## 6. 自验

```text
npx vitest run tests/secure/sessions.test.ts   → 32 passed (32)
npx vitest run tests/secure --maxWorkers=3     → 911 passed | 3 skipped | 3 文件失败
                                                （helper-v0-api / launcher-off-golden / launcher-private：
                                                 全是真 gocryptfs/FUSE e2e，波及正在并行改造中的
                                                 helper.mjs（V0 未完成，`unlockVault postMount`
                                                 报错）；三者均不 import sessions.mjs，与本包无关。
                                                 同一窗口的 tree.test.ts 失败属 V2。）
npm run typecheck                              → exit 0
npx prettier --check src/secure/bin/sessions.mjs tests/secure/sessions.test.ts → clean
```

测试要点（§7.1 清单逐项）：头规则镜像（空行/坏行/非 session 首行/1 MiB 超窗/恰 1 MiB 边界/空文件，全部与真 pi `findMostRecentSession` 交叉断言）；complete/partial/invalid 三分；树内多个 `.pi/settings.json`；`--sessions-from`/env/全局 settings；改名后（root 已不存在）凭 `rootRealpath` 仍能发现/入选/改写 realpath 拼写的会话；闭包预算超限 partial + unfinishedRefs；同一 run 多条 `subagent:run` 全改写；源只读（dev/ino/size/mtime/内容不变）；复制期间追加（缝注入：一次追加 ⇒ 重试成功且副本含新行；每轮追加 ⇒ 3 次耗尽、无副本残留、源仅多了追加行）；memory 精确 slug（不取前缀/子目录）、歧义跳过、可信符号链接目录 + 文件级符号链接跳过报告；真 pi `SessionManager.list` 可见性（根 / `-C sub`）；迁址前缀改写（含非对齐 look-alike 不改、幂等、坏行透传、memory 改名三分支）。

## 验收处置（kimi，有条件通过）

- [Minor] 头镜像对头前 falsy 标量行（`null`/`0`/`false`/`""`）与 pi 不一致：主会话已对齐——`parseHeaderCandidate` 对 falsy 解析结果继续扫描（同 pi `parseSessionEntryLine` + `!entry` 跳过），新增用例「skips falsy scalar lines … (like pi)」；`tests/secure/sessions.test.ts` 33/33 通过。
- [Nit] 本报告用例数与 §6 自验段为早期快照（现 33 例；全量 `tests/secure` 的跨包失败来自并行中的 V0 改 helper.mjs），V6 集成时统一刷新。
- [Nit] 重入跳过基于首次读取、verify-failed 不删本次副本：均符合 §2.3 措辞，V4 失败回滚整体删除新库，无残留风险；保留为已知行为。
