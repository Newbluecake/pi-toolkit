# B4 · 运行时草案加载（shadow-only）— 交付报告

> 包：#25 jev-reflex B4（`backtest-plan.md` §B4 4 步；架构 `backtest-arch.md` §4.5–§4.6、BD8/BD9/BD11）
> 基线：dev，HEAD `dc036048`，B0_COMMIT `cd1d6c4a`。未做任何 git 写操作。

## 1. 实现摘要

| 步骤 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 落点                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1    | `loadDrafts` 真实实现：受信目录（`<agentDir>/reflex` 与 `drafts` 均须真目录 / 属主 / `mode&0o077===0`）→ `opendir` 流式 ≤64（第 65 个 ⇒ `dir-cap` 并立即 close）→ 名字白名单、排序后读前 16、余者 `cap` → no-follow fd + **同 fd** `stat`（非普通 ⇒ `not-regular`；uid/mode ⇒ `perm`；>16 KiB ⇒ `size`）→ 读 cap+1（stat 后增长 ⇒ `size`）→ `validateDraft` → 草案间 `duplicate` → 结束复核 drafts 目录 dev/ino（变 ⇒ `dir-changed`，全丢）。整个加载一个 `clampSpanMs(500)` 预算（走注入 Clock）+ abort；每个 await 与 stop 信号竞速，stop 胜出后迟到的 open/opendir handle 由 `late` 回调 close，timer 与 abort 监听在 `finally` 清理；永不 throw / reject，内部意外 ⇒ 整体失败（fail closed）。`defaultDraftFs` 把 `FileHandle.read` 适配成 B0 约定的 `(buffer, position, length)`。                                                             | `src/reflex/drafts/load.ts`       |
| 2    | `wire.ts`：可选 `draftsDir?` / `draftFs?`（BD9，默认 `<resolveAgentDir(process.env, homedir()).dir>/reflex/drafts`，仅 drafts 开启时才计算/访问）；BD8 加载时机（每次 `session_start` 若无结果且无在飞加载 ⇒ 启动；`session_shutdown` abort 并丢弃在飞结果，下次 start 重试；完成结果保留到 `/reload`）；`scheduleShadowPort` 拆为 `runPortAttach`（port 执行 + 挂接，不碰状态）+ `accountBuiltin`（strike / overlay / 降级 notify，仅 builtin）；`Pending.origin`；`agent_settled` 按 origin 取脚本（草案同样走 `judgeAgreement`）；`admitAuto(id)=scriptById.has(id)&&stateOf(id)==="auto"`；草案候选走独立 `draftCandidate`（只在 builtin **miss** 时参与，K2）；草案纠正写带 `targetOrigin/targetTemplateHash` 的条目、不调 `onCorrected`、不降级；草案记录写 `origin/draftHash/templateHash/port.portId`；**builtin 记录零新增字段**（BD11）。 | `src/reflex/wire.ts`              |
| 3    | `command.ts`：`/reflex drafts`；`status` 的「草案：…」行与「autoResolve 含 draft.* id」提示、`reset draft.x` 的明确报错、usage 里的 `drafts` **只在 drafts 开启时**出现，关闭时文本与原先逐字节相同；`ReflexCommandDeps.drafts?` 为可选依赖（旧测试的 deps 不用改）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `src/reflex/command.ts`           |
| 4    | G5：`runAuto(` 单调用点（且位于 `admitAuto(script.id)` 之后）、`catalog.ts` 无 `draft.`、每个 `accountBuiltin(` 调用点前紧邻 `origin === "builtin"`（扫描排除定义）、`draftCandidate` 函数体不得出现 `stateOf/effectiveState/runAuto/accountBuiltin/rtOf/runtimes./onExecOutcome/onRepeat/onCorrected`；G4 本来就扫整个 `src/reflex/**`，已覆盖 `drafts/`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tests/reflex/governance.test.ts` |

## 2. 实施中的决定（含与方案的细节出入，请 root 知情）

1. **目录不存在（ENOENT）⇒ 空结果、无 failure**，不报 `dir-untrusted`。理由：「开关已开、还没生成草案」是正常态，报 untrusted 会误导；仍是 fail-closed（什么都不加载）。`/reflex drafts` 输出里带 `dir=<path>` 供用户核对，并提示「目录为空或不存在」。0755 / symlink / 他人属主仍是 `dir-untrusted`。
2. **B3 必须把 `<agentDir>/reflex` 建成 0700**（方案要求两层都受信）。`reflex/` 若是 0755，草案加载会整体 `dir-untrusted`。我没碰 B3 域。
3. **草案的 ambiguous 命中也落记录**（`kind:"ambiguous"`，带 `origin:"draft"`），与 builtin 对称；晋升 V2 只看 high，无影响。
4. **草案计数用独立 counter 键** `draft.candidates/ambiguous/reasked/corrected`，不污染 builtin 的 `candidates/…`（「本激活计数」行不变）。
5. **`reset draft.x` 的专用报错仅在 drafts 开启时出现**；关闭时仍是原有的「未知脚本 id」文案（字节不变）。
6. **改了 B0 的一条已过时测试**：`tests/reflex/core/draft-schema.test.ts` 中 `loadDrafts — B0 skeleton`（断言「恒空且零 I/O」）随骨架被替换而作废，已删除该 describe 与两个不再使用的 import（`loadDrafts`、`FakeClock`）；文件不在本包文件域，属必要的联动修改，其余用例（含 `DRAFT_READ_FLAGS === SESSION_READ_FLAGS`）未动。
7. 新增共享测试工具 `tests/reflex/drafts/helpers.ts`（`tmpAgent` / `fakeDraftFs` / `queueDraft`；不是 test 文件）。`queueDraft` 的词汇（「队列还剩多少活」…）刻意不命中任何 builtin 模板：builtin 的 weak 词 `job` 会让「后台 job 有哪些」成为 builtin ambiguous，草案层（只在 builtin miss 时参与）根本看不到——所以 `makeDraft` 的默认意图不适合直接用于 wire 测试。
8. perf 断言取 p99 ≤ 5 ms（= 目标 1 ms × 5 CI 宽容，与 `core/perf.test.ts` 同口径），max 只打印不断言。

## 3. 测试（新增 / 改动）

| 文件                                    | 用例数          | 要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/reflex/drafts/load.test.ts`      | 24              | 真实 fs：合法加载（hash 与 `identity` 一致）、`DRAFT_READ_FLAGS` 经注入 fs 核对、缺/空目录、`perm`(0644)、`name`、`json`、`size`、`schema/namespace/port-mismatch/regex/examples`、`duplicate`、`cap`(18→16+2)、文件名控制字符脱敏、目录 0755 / reflex 0755 / drafts symlink / reflex symlink / 他人 uid ⇒ `dir-untrusted`、65 dirent ⇒ `dir-cap` 且 `next()` ≤65 且目录 handle 已关且零 open、恰 64 个不触发、永不 reject、已 abort ⇒ 零 fs 访问、各出口 timer 清零                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tests/reflex/drafts/load-race.test.ts` | 9               | 真实 fs 竞态（钩子落在 loader 步骤之间）：open 前文件被换成 symlink ⇒ `not-regular` 且未读到 symlink 目标；stat 后增长 ⇒ 读 cap+1 ⇒ `size`；加载中目录整体替换 ⇒ `dir-changed` 全丢。FakeClock 预算：hung open ⇒ 恰 500 ms `timeout`、迟到 handle 被 close、timer 清、后续文件未打开；hung read；第 2 个文件 hang 时第 1 个的结果也被整体丢弃；abort 中途 / opendir 挂起 abort 同理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tests/reflex/drafts/load-fifo.test.ts` | 1（**Tier 2**） | `mkfifo` 的 `pipe.json`：open 不阻塞（<400 ms）、`not-regular`、同目录合法草案照常加载；`mkfifo` 不可用则 skip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tests/reflex/drafts/perf.test.ts`      | 2               | 16 份满额草案（strong12/weak8/exclude32，全部过 `parseDrx`）× 经 S0 + builtin miss 过滤后的 1 万次匹配（含 120 字符对抗输入）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tests/reflex/wire-drafts.test.ts`      | 19              | 状态隔离：`autoResolve=["draft.queue"]` + 草案 high ⇒ 同步 continue、非 thenable、零 sendMessage、record `state:"shadow"`；record 字段；agreement（agree/no-tool/diverge 均非 unknown）；草案 port error×2 且 id 在 autoResolve ⇒ 无 notify、builtin `git.status` strikes=0、对照组 builtin 同样失败则降级；builtin/草案交替占槽各自 origin 正确、builtin strike 只算 builtin（builtin 记录无任何草案键、`port` 无 `portId`）；草案目标纠正写 `targetOrigin/targetTemplateHash`、无降级、builtin 计数不变；builtin 目标纠正字节不变；builtin 命中优先于草案；草案 reasked；**drafts 关 ⇒ `DraftFs` spy 零调用**、`/reflex drafts`=disabled、status 无「草案」；drafts 开对照；加载仅在 `session_start`、结果跨 re-arm 保留；shutdown 中止在飞加载→丢结果→下次 start 重试；fs 永久挂起不阻塞输入；secure/locked 零注册零 fs；`dir-untrusted` ⇒ 草案句子仍是 miss；**真 `activate()` 冒烟**（§5） |
| `tests/reflex/command-drafts.test.ts`   | 12              | `/reflex drafts` 各形态、status 草案行 / 提示仅开启时出现且关闭文本与「无 drafts deps」逐字相同、`reset draft.x` 开/关两种文案、usage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tests/reflex/governance.test.ts`       | +5（G5a–e）     | 见 §1 步骤 4（含扫描自测）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tests/tiers.ts`                        | +1 行           | `TIER2_FILES` 登记 `load-fifo.test.ts`（`test-tiers` 治理测试绿；其余新测试无 child_process/socket/长 sleep，不需登记）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**有效性抽查（变异）**：临时让草案也走 `accountBuiltin` 并删掉其内的 id 守卫 ⇒ `wire-drafts`「port error ×2」用例红（该用例因此特意把草案 id 放进 `autoResolve`——否则 runtimes 泄漏不可观察）；已还原，复跑全绿。

## 4. 门禁（真实输出）

```
$ npx vitest run tests/reflex tests/boundary/pi-free.test.ts tests/integration/reflex-off-golden.test.ts tests/governance
 Test Files  46 passed (46)
      Tests  578 passed (578)
exit=0                                   # 含 tier2 bundle-parity 147 s；此次先于 wire-drafts 的冒烟两例

$ npx vitest run tests/reflex tests/boundary/pi-free.test.ts tests/integration/reflex-off-golden.test.ts \
    tests/governance/test-tiers.test.ts tests/governance/activate-trace.test.ts     # 最终代码复跑
 Test Files  45 passed (45)
      Tests  552 passed (552)
exit=0

$ npm run typecheck        # tsc7 ×2 + vue-tsc
TC_EXIT=0                  # 全仓 0 错误

$ git diff --quiet origin/dev -- tests/fixtures/ ':!tests/fixtures/reflex-drafts-off-parity.json' ':!tests/fixtures/web-hub/reload-result-compat-golden.json' \
    && git diff --quiet cd1d6c4a -- tests/fixtures/reflex-drafts-off-parity.json; echo FX=$?
FX=0

$ npx prettier --check <本包全部源码/测试文件>
All matched files use Prettier code style!
```

冻结面：`wire-shadow` / `wire-auto` / `drafts-off-parity` 测试未改且全绿（parity 含 `/reflex status` 全文，逐字节通过）；`reflex-off-golden`、`activate-trace` 全绿；`src/index.ts`、`core/**`、`ports/**`、`render-tui.ts`、`catalog.ts`、`tests/fixtures/**` 未碰。

perf 实测：`[reflex draft perf] n=10000 reachable=8500 p99=0.0591ms max=1.8960ms`（p99 约为目标 1 ms 的 6%；max 的毫秒级尖峰是 GC/调度抖动——DRX 语法本身保证有界，**本 benchmark 不能替代 DRX 语法证明**）。

## 5. 本机冒烟（临时 agentDir，未触碰 `~/.pi/agent/reflex/`）

做法：`wire-drafts.test.ts` 末尾两例，`sandbox()` 把 `HOME` 指到临时目录（临时清除 `PI_CODING_AGENT_DIR`，走默认路径 `<HOME>/.pi/agent/reflex/drafts`，即 BD9 内部计算），跑**真 `activate()`**（`reflex.enabled=true, drafts.enabled=true`），放 1 份合法草案（0600）+ 1 份 0644 草案，`session_start` → `/reflex drafts` → 输入草案例句 → `agent_settled`（assistant 调 `bash_job list`）。输出：

```
reflex drafts: enabled · loaded 1 · rejected 1 · dir=/tmp/pi-drafts-smoke-UTV8tg/.pi/agent/reflex/drafts
  loaded draft.queue@1#ac5fede1 port=jobs.list
  rejected loose.json perm
草案恒 shadow；改动草案文件后需 /reload 才会重新加载。
record={"v":1,"kind":"shadow",...,"scriptId":"draft.queue","state":"shadow","band":"high",
  "port":{"outcome":"ok","ms":1,"portVer":1,"portId":"jobs.list"},
  "model":{"agree":"agree","tools":["bash_job:list"]},
  "origin":"draft","draftHash":"72917b1279312d87","templateHash":"ac5fede11c0a1434"}
```

输入结果非 `handled`（模型照常作答）；对照：同样文件、`drafts.enabled=false` ⇒ `/reflex drafts`=disabled、零记录。

**做不到的项**：没有在真实 TUI + 真模型下手测（无交互终端，也不动用户真实 `~/.pi/agent`）；以上用真 `activate()` + fake ctx 代替，覆盖 `activate()` → `wireReflex` → 默认 drafts 路径 → 真 fs 加载 → shadow 记录全链。

## 6. 遗留 / 注意

1. **`dist/bundle` 陈旧会让 tier1 的 `tests/startup-bundle/dispatcher.test.ts`（`build:bundle` 一致性断言）变红**：`src/reflex/**` 变了而 bundle 未重建（B0 报告 §2.8 同款）。本包未跑 `build`/`test:tier1`，由主会话在后台全量前先 `node scripts/build-bundle.mjs` 或 `npm run build`。
2. B3 建目录权限：`reflex/` 0700、`drafts/` 0700、文件 0600（§2.2）。
3. 没向 root 发 `message_agent`（无阻塞性歧义，§2 全部按默认做法落地）。
4. `load.test.ts`「他人 uid」用例在无 `process.getuid` 的平台自动不断言，Linux 上实断。

## 7. 文件清单（绝对路径）

修改：

- `/home/bluecake/ai/pi-toolkit/src/reflex/drafts/load.ts`
- `/home/bluecake/ai/pi-toolkit/src/reflex/wire.ts`
- `/home/bluecake/ai/pi-toolkit/src/reflex/command.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reflex/governance.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/tiers.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reflex/core/draft-schema.test.ts`（仅删 B0 骨架用例，§2.6）

新建：

- `/home/bluecake/ai/pi-toolkit/tests/reflex/drafts/helpers.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reflex/drafts/load.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reflex/drafts/load-race.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reflex/drafts/load-fifo.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reflex/drafts/perf.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reflex/wire-drafts.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reflex/command-drafts.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/jev-reflex/B4-report.md`
