# #34 P2 实施报告 — fabric 消息 kind `finding` → `report`（P2：设置键改名 + corpus/pin 两阶段迁移）

> 任务 #34 包 P2。方案 `docs/dev/fabric-kind-rename/plan.md`（r3），按 §0（已定事项）/§3.5/§4.2（P2 行）/§4.5（P2 原文）/§6.2/§6.3/§7.1（P2 文件域）/§7.2（P2 基线）/§7.3（P2 门禁）/§7.4（T-S1 P2 阶段）/§8（P2 行）实施。
> P1 已提交为 `32406279`（`feat(fabric): rename the message kind "finding" to "report"`）。本报告为数据交付；P2 的 commit 由主会话执行。

## 1. 基线（§7.2）

- **T0（任务基线）** = `bf7173890da800f9c53a48a7c0da2d875b4bad36`（P1 报告 §1）。**P1 commit** = `3240627982d04f71d086d0f84ea1575be3836fb3`。**P2 commit** sha 待 root 提交后回填。
- **P2 开工 ①** `git status --porcelain -- tests/fixtures tests/config/__corpus__` 为空 ✓（工作区无遗留漂移）。
- **P2 开工 ②** `git log --oneline 32406279..HEAD -- tests/fixtures tests/config/__corpus__` 为空 ✓（HEAD 即 P1，之后没有别的提交碰这些路径）。
- **P2 完成**：
  - `git diff --numstat 32406279 -- tests/fixtures` **为空** ✓（P2 不新增 fixture 漂移）。
  - `git diff --numstat 32406279 -- tests/config/__corpus__` 恰好两行 ✓：
    ```
    2	2	tests/config/__corpus__/setting-specs-pin.json
    1329	1328	tests/config/__corpus__/settings-corpus.json
    ```
  - settings-corpus.json 的 diff 逐行核验：除 64-hex hash 行外，仅有 §6.2 第 4 步的 `+      "reportQuota": 10,`（template 插入）与 `retiredPaths` 一行改为 `["memory.jev.confirmTimeoutMs", "fabric.findingQuota"]`，无其他改动 ✓。
  - **任务累计** `git diff --numstat bf717389 -- tests/fixtures tests/config/__corpus__` = 三份 fixture（各 `1 1`，P1 申报）+ 两份 corpus 文件，此外没有别的文件 ✓。
- P1 报告 §1 的「P1 commit sha 待回填」由主会话处理（不在 P2 文件域内）。

## 2. 改动清单（全部落在 §7.1 P2 文件域内；19 个文件，其中 1 新增）

| 文件                                                                                                                             | 改动                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/fabric/settings.ts`                                                                                                         | `FabricSettings.findingQuota` → `reportQuota`（接口字段）、parser `count("reportQuota")`、`DEFAULT_FABRIC_SETTINGS.reportQuota: 10`——位置均在 `maxPerRun` 与 `directiveQuota` 之间不变                                                                                                                                   |
| `src/fabric/setting-specs.ts`                                                                                                    | `"fabric.reportQuota": count("fabric.reportQuota", 0, "Report messages per sender run")`（原位改名+改说明，listing 位置不变）                                                                                                                                                                                            |
| `src/fabric/router.ts`                                                                                                           | `FabricRouterConfig.reportQuota`；`quota()` 的 report 分支读 `this.config.reportQuota`                                                                                                                                                                                                                                   |
| `src/tools/steer-tool.ts`                                                                                                        | reply description 中 `fabric.findingQuota` → `fabric.reportQuota`（该行其余词汇 P1 已改）                                                                                                                                                                                                                                |
| `tests/fabric/{router,router-wake,mailbox,xs-inbox,unknown-kind}.test.ts`                                                        | router/config 字面量 `findingQuota:` → `reportQuota:`（机械，语义不变）                                                                                                                                                                                                                                                  |
| `tests/core/message-property.test.ts`、`tests/helpers/{fabric-inbox,fabric-revive}.ts`、`tests/tools/message-agent-tool.test.ts` | 同上（message-agent-tool.test.ts 仅此一处，LEGACY_KIND 未动）                                                                                                                                                                                                                                                            |
| `tests/tools/steer-tool-off-surface.test.ts`                                                                                     | §7.4 P2 阶段：`DECLARED_SUBS` 追加第 3 条 `["fabric.findingQuota", "fabric.reportQuota"]`；替换计数钉改为 P2 行（description ×1/×0/×0，reply.description ×1/×1/×1）；残留断言改写为「全部表面旧 kind 词 0 次 + 旧设置键 0 次 + `reply.description` 中新键恰好 1 次」（新键/旧键均从 `DECLARED_SUBS` 派生，不另写字面量） |
| `tests/config/fabric-report-quota-settings.test.ts`（新）                                                                        | T-Q1（§6.3 全表，14 测试，见 §5）                                                                                                                                                                                                                                                                                        |
| `tests/config/__corpus__/settings-corpus.json`                                                                                   | §6.2 第 4、6 步：template 插入 `"reportQuota": 10` + `retiredPaths` 追加旧键 + 1327 个 hash 刷新（见 §4）                                                                                                                                                                                                                |
| `tests/config/__corpus__/setting-specs-pin.json`                                                                                 | §6.2 第 7 步：第 216 行原位替换 + `all` 重算（diff 恰好 2 行）                                                                                                                                                                                                                                                           |
| `docs/guide/subagents.md`                                                                                                        | P1 行后追加 §4.5 P2 原文一行（含旧键 1 处）                                                                                                                                                                                                                                                                              |
| `docs/dev/fabric-cross-session/README.md`                                                                                        | P1 段落末尾紧接 §4.5 P2 原文一句（含旧键 1 处）                                                                                                                                                                                                                                                                          |

冻结面：`tests/fixtures/**` 对 P1 零 diff；`tests/config/settings-corpus.test.ts` 与 `setting-specs-pin.test.ts` 零改动；无 git 写操作。

## 3. §6.2 corpus 两阶段迁移（#21 先例做法，未用 `GOV_CORPUS_GENERATE` / `GOV_SPECS_GENERATE`）

**计数**：N（有 hash 的 corpus 文件）= 1 defaults + 368 captured + 300 random + 658 block = **1327**；M（全部证明输出）= N + 4 source = **1331**。4 份 `source-{undefined,null,number,array}.txt` 只参与规则 R 与不变性比较，不对应 hash 字段、不参与 hash 刷新。

### 3.1 第 0 步：目录与 BASE.txt

`mkdir /tmp/c34-{before,mid,after}`（先精确删除再新建，不复用旧目录）。三次 BASE.txt（mid 为 dump 时刻状态的重构记录，dump 本身先于任何 corpus 改动）：

- **before**（P1 提交、零改动）：HEAD `3240627982d0f71d086d0f84ea1575be3836fb3`；`git status --short -- src tests/config` 空；corpus sha `e9caa2e022b35bf2ea36267a7a602cc6d1a98dd4d32082127b0fbe9302141fa8`。
- **mid**（P2 改完 src+tests，template/hash 原样）：HEAD 同上；改动 = src 4 文件 + tests 13 文件（§2 清单除 corpus/docs 外）+ 未跟踪 `tests/config/fabric-report-quota-settings.test.ts`；corpus sha 仍为 `e9caa2e0…`（未动）。
- **after**（再更新 template）：HEAD 同上；改动 = mid 全部 + `tests/config/__corpus__/settings-corpus.json`；corpus sha `188e5a1547783610a6363d367efe18ecc8c5c2e4241ad6097aed2053c0607c79`。

### 3.2 第 1 步：before dump

`GOV_CORPUS_DUMP=/tmp/c34-before npx vitest run tests/config/settings-corpus.test.ts` → **Test Files 1 passed (1)；Tests 4 passed (4)**，全绿 ✓。文件数 = **M = 1331**（defaults 1 / captured 368 / random 300 / block 658 / source 4），4 份 source 文件逐一存在，无 ENOENT。日志 `/tmp/c34-dump-before.txt`。

### 3.3 第 2 步：mid dump（改码不改 template）

同命令指向 `/tmp/c34-mid` → **Test Files 1 failed (1)；Tests 3 failed | 1 passed (4)**。失败的恰好是允许的三个 it：

1. `DEFAULT_SETTINGS serialises identically (values + key order)`（defaultsSha 不匹配，断言位置 :310）
2. `captured tests/config inputs`（bad 列表 0..367 全量）
3. `seeded random whole-file mutations + per-block mutations`（bad 列表 random-0..299 + block-0..657 全量）

`the non-object sources keep their fallbacks` 通过（只断言 `concurrencyLimit`）✓。**dump 有效**：文件数 = **1331**，4 份 source 逐一存在，无 ENOENT。日志 `/tmp/c34-dump-mid.txt`。

### 3.4 第 3 步：规则 R（before → mid，全部 M 个文件）

脚本 `/tmp/c34-ruleR.py`（/tmp，不提交）。规则：before 文本中 `"findingQuota"` 恰好 1 次且形如 `"findingQuota":<num>`，原位替换为 `"reportQuota":10` 后与 mid 逐字节相等，mid 中 `"findingQuota"` 0 次。输出：

```
files=1331 matched=1331 failures=0 fellBack=113
captured_fellBack=0 random_fellBack=109 block_fellBack=4 source_fellBack=0 defaults_fellBack=0
```

与方案预期一致：k>0 且全部来自 random/block；captured、4 份 source、defaults 中 k=0。113 个回落个例（旧值 ≠ 10，即旧键不再生效、回落默认 10）：

```
block-326 -> 11    block-329 -> 65535  block-330 -> 1     block-334 -> 0
random-100 -> 0    random-101 -> 5     random-102 -> 20   random-103 -> 1000000000
random-107 -> 0    random-109 -> 1000000000  random-11 -> 0  random-110 -> 70000
random-112 -> 20   random-114 -> 20    random-116 -> 20   random-124 -> 20
random-13 -> 11    random-130 -> 20    random-131 -> 11   random-135 -> 20
random-137 -> 60   random-138 -> 25    random-139 -> 20   random-140 -> 20
random-141 -> 11   random-144 -> 20    random-145 -> 11   random-147 -> 0
random-148 -> 20   random-153 -> 5     random-156 -> 11   random-158 -> 20
random-160 -> 100  random-167 -> 20    random-168 -> 70000  random-17 -> 99
random-171 -> 60   random-172 -> 5     random-173 -> 11   random-183 -> 5
random-185 -> 20   random-186 -> 20    random-188 -> 20   random-190 -> 5
random-191 -> 65535  random-194 -> 70000  random-197 -> 11  random-198 -> 20
random-203 -> 60   random-21 -> 11     random-210 -> 11   random-211 -> 65535
random-215 -> 5    random-216 -> 11    random-22 -> 20    random-220 -> 1000000000
random-221 -> 20   random-222 -> 99    random-228 -> 1000000000  random-229 -> 11
random-235 -> 20   random-236 -> 11    random-24 -> 11    random-241 -> 20
random-244 -> 1    random-251 -> 5     random-254 -> 11   random-257 -> 1000000
random-258 -> 11   random-261 -> 100   random-264 -> 5    random-265 -> 70000
random-266 -> 70000  random-271 -> 20  random-274 -> 100  random-277 -> 5
random-280 -> 11   random-283 -> 11    random-286 -> 11   random-287 -> 5
random-290 -> 100  random-291 -> 0     random-292 -> 4096  random-293 -> 11
random-294 -> 25   random-299 -> 5     random-33 -> 20    random-35 -> 5
random-37 -> 20    random-46 -> 11     random-48 -> 20    random-5 -> 100
random-51 -> 11    random-53 -> 0      random-57 -> 7     random-59 -> 25
random-67 -> 3     random-7 -> 11      random-70 -> 5     random-71 -> 5
random-73 -> 0     random-75 -> 20     random-77 -> 11    random-80 -> 20
random-81 -> 65535  random-87 -> 20    random-89 -> 20    random-9 -> 0
random-90 -> 20    random-93 -> 7      random-96 -> 11    random-97 -> 7
random-98 -> 5
```

（完整逐行输出在 `/tmp/c34-ruleR.txt`。）

### 3.5 第 4 步：更新 template

template 的 fabric 块中紧随 `"findingQuota": 10` 插入 `"reportQuota": 10`；`retiredPaths` 追加 `"fabric.findingQuota"`。`stripRetired(template)` 由此重新等于新 `DEFAULT_SETTINGS`（键序一致），生成输入继续覆盖旧键作为被容忍的陈旧输入（与 #26 `confirmTimeoutMs` 先例一致）。

### 3.6 第 5 步：after dump（template 更新、hash 未刷）

同命令指向 `/tmp/c34-after` → **Test Files 1 failed (1)；Tests 3 failed | 1 passed (4)**，失败同 mid 的三个 it，断言位置同为 :310 / :327 / :345——即**只有三处 hash 断言失败，:315 的 template 断言（`stripRetired(corpus.template, retiredPaths) === DEFAULT_SETTINGS`）通过** ✓。dump 有效：文件数 = **1331**，4 份 source 逐一存在，无 ENOENT。日志 `/tmp/c34-dump-after.txt`。

**mid→after 不变性（373 个文件 cmp）**：`defaults.txt` + 全部 `captured-0..367` + 4 份 `source-{undefined,null,number,array}` = 1+368+4 = **373 个文件全部逐字节相同（same=373 diff=0）** ✓——证明 captured/defaults/source 输出与 template 无关。`random-*`/`block-*`（958 个）中 795 个变化、163 个不变；逐个核验 163 个不变文件的 `settings.fabric` 全部恰好等于默认 fabric 块（该轮变异把 fabric 整块替换/清空，输出本就与 template 无关），与「生成流随 template 偏移而整体重算」一致。**抽查**：全部 958 个 random/block 输出中 `"reportQuota"` 恰好 1 次、after 目录所有文件 `"findingQuota"` 0 次（0 违例）✓。

### 3.7 第 6 步：刷新 hash（只刷 N=1327 个 corpus 文件）

齐全核查（脚本 `/tmp/c34-refresh.py` 内置，任何缺失即中止）：

```
completeness check: missing=0 ALL PRESENT   # defaults 1 + captured 0..367 + random 0..299 + block 0..657 + 4 source
```

hash = `sha256(dump 文本去掉末尾一个 "\n")`。按**位置**改写 `defaultsSha`、`captured[*].sha`、`randomShas`、`blockShas`（不用全局字符串替换：1327 个旧 sha 只有 760 个唯一值，存在合法重复）。改写后结构核验通过：`baseline/seed/randomCount/blocksPerKey/template/timePaths/retiredPaths` 与 `captured[*].input` 全部不变，hash 字段逐项等于按 after 文本计算的值。1327 条 hash 全部换值（预期：规则 R 已证明每个输出都含该键）。改行数 = 1327 + retiredPaths 1 行 + template 插入 1 行 = diff numstat `1329 1328`。**不带 DUMP 复跑**：`Test Files 1 passed (1)；Tests 4 passed (4)` 全绿 ✓（日志 `/tmp/c34-corpus-final.txt`）。

### 3.8 第 7 步：pin

`tests/config/__corpus__/setting-specs-pin.json` 第 216 行**原位**替换：

```
-    ["fabric.findingQuota", "515bc97062f66635a47ea9e70f18e5f63f1d70e086b02e62a279b0b8ad02eb49"],
+    ["fabric.reportQuota", "6fd4109b29ae5a83c3c6834ba76e9c4c963b8f4f31eb36d91cd06e11f296c6da"],
```

新 spec sha 与 `all` 由一次性 tsx 脚本（`/tmp/c34-pin-compute.mts`）从真实 `SETTING_SPECS` 计算：spec JSON `{"kind":"number","path":"fabric.reportQuota","min":0,"integer":true,"description":"Report messages per sender run"}`；`all` `a8f4646d…` → `0b021d2e…`。diff 恰好这两行。pin 属主测试复跑 **2 passed** ✓（`/tmp/c34-pin-final.txt`）。

## 4. T-Q1 parser 确定性用例（§6.3）

`tests/config/fabric-report-quota-settings.test.ts`（新，14 测试，tier1，FakeClock/内存均不需要）：§6.3 全表经 `parseFabricSettings(x)` 与 `loadSettings({ fabric: x })` 两条路径逐例断言（`{}`→10 无旧键、`{reportQuota:3}`→3、旧键单独→10 且无 warn、两键并存→5、`0` 合法、`2.7`→`Math.floor`→2、`-1`/`"5"`/`NaN`/`Infinity`/`null`→10）；另断言旧键不进任何解析结果（`Object.hasOwn` + `JSON.stringify` 不含）、`DEFAULT_SETTINGS.fabric` 键序 `…maxPerRun, reportQuota, directiveQuota…`、`SETTING_SPECS` 有新键（含 description 原文）无旧键。旧键只在一行 `const LEGACY_KEY = "findingQuota"; // #34 legacy input` 出现。

## 5. T-S1 的 P2 阶段（§7.4）

`tests/tools/steer-tool-off-surface.test.ts` 追加第 3 条 `DECLARED_SUBS` 并按 P2 行改写：不变面（name/label/promptSnippet/参数骨架/run_id+text description/fabric-off execute 三种返回）仍深等于 PRE34；替换计数钉 = description 第 1 条 ×1、第 2/3 条 ×0，reply.description 第 1/2/3 条各 ×1；残留断言 = 全部表面旧 kind 词与旧设置键均 0 次、`reply.description` 中 `fabric.reportQuota` 恰好 1 次（新旧键均从 `DECLARED_SUBS` 派生）。P1 阶段的 `P2_PENDING_KEY` 派生随之移除。该文件 `finding` 计数恰为 7（PRE34_DESCRIPTION 1 + PRE34_REPLY_DESCRIPTION 3 + DECLARED_SUBS 源串 3），与 A-P2 一致。

## 6. 门禁输出（§7.3 P2，真实结果）

| 命令                                                                                                                                                                                                                                                                  | 结果                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx prettier --check <19 个改动/新建文件>`                                                                                                                                                                                                                           | `All matched files use Prettier code style!`                                                                                                       |
| `npm run format:check`                                                                                                                                                                                                                                                | `All matched files use Prettier code style!`（全仓绿；P1 时 #25 的 4 个 warn 已不在）                                                              |
| `npm run typecheck`                                                                                                                                                                                                                                                   | exit 0（tsc×2 + vue-tsc 全过）                                                                                                                     |
| `npx vitest run tests/config tests/fabric tests/tools tests/core`（§7.3 清单的超集：含 `tests/core/message-property.test.ts`、`tests/tools/steer-tool.test.ts`、`tests/tools/steer-tool-off-surface.test.ts`、`tests/tools/message-agent-tool.test.ts`、新文件 T-Q1） | **Test Files 178 passed (178)；Tests 3434 passed (3434)**                                                                                          |
| A 级 off golden 套件 + conformance fabric（fabric-wake-off、fabric-xs-off、fabric-xs-reply-off、thread-off、thread-rebind、schedule-off、reflex-off、conformance/fabric-wake、conformance/fabric-xs）                                                                 | **Test Files 9 passed (9)；Tests 53 passed (53)**（conformance fabric-xs 走真实 pi，含 C-X1b/C-X2/C-X6）                                           |
| `npm run test:tier1`（第一次）                                                                                                                                                                                                                                        | 1 failed：`tests/startup-bundle/dispatcher.test.ts` —— dist/bundle 为旧源码产物（改 src 后磁盘 bundle 过期，与 P1 报告 §4 记录的同一现象，属预期） |
| `npm run build`                                                                                                                                                                                                                                                       | ok（`build:bundle ok — dist/bundle/index.js sha256=d09bee0e… inputs=705`）                                                                         |
| `npm run test:tier1`（build 后复跑）                                                                                                                                                                                                                                  | **Test Files 1598 passed (1598)；Tests 32073 passed \| 3 skipped (32076)**，exit 0                                                                 |
| 门禁 A（对照 A-P2）                                                                                                                                                                                                                                                   | `diff` 无输出，**PASS**                                                                                                                            |
| 门禁 B（对照 B-P2）                                                                                                                                                                                                                                                   | `diff` 无输出，**PASS**                                                                                                                            |
| §6.2 全部输出                                                                                                                                                                                                                                                         | 见 §3                                                                                                                                              |
| §7.2 P2 检查                                                                                                                                                                                                                                                          | 见 §1                                                                                                                                              |

完整日志：`/tmp/c34-{dump-before,dump-mid,dump-after,ruleR,corpus-final,pin-compute,pin-final,prettier,formatcheck,typecheck,vitest-targeted,offgolden-conformance,tier1,tier1b,build,gateA,gateB}.txt`、脚本 `/tmp/c34-{ruleR,refresh}.py`、`/tmp/c34-pin-compute.mts`。

**门禁 A/B 实操备注（给 verifier）**：方案 §4.8 的门禁 A 命令把三个 glob 元素（`tests/integration/fabric-*.test.ts` 等）加了引号——ripgrep 13 **不展开位置参数 glob**，引号包裹会静默跳过这些 scope（`2>/dev/null` 吞掉 No such file 报错），恰好只漏掉 `fabric-wiring.test.ts:1` 一行。复跑时去掉引号由 bash 展开（SCOPE 74 个元素）即得完整命中集，与 A-P2 集合相等。verifier 复跑时请用未加引号的 glob。

## 7. 与方案的偏差（逐条）

1. **`tests/fabric/unknown-kind.test.ts` 在 §7.1 P2 文件域清单之外**，但其 router rig 的必填配置键 `findingQuota: 2`（P1 报告 §6 偏差 1 / R11 声明的 P2 随改点）必须随键改名，且 gate A-P2 期望该文件计数恰为 1（P1 时为 2）。本次将其改为 `reportQuota: 2`（该文件 `finding` 计数回到 1，与 A-P2 一致）。这是 P1 已申报的既定动作，非新增偏差；未触碰该文件其他内容。
2. 其余全部按方案原文实施；未发现需要升级到 root 的阻断项。

## 8. 验收矩阵（P2 行）对照

| 项                                                                                  | 证据                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V11 fabric-off 表面仅 §7.4 申报差异（P2 部分：设置 spec 列表、DEFAULT_SETTINGS 键） | T-S1 P2 阶段绿；pin diff 恰 1 条 + `all`；corpus 规则 R 逐字节证明                                                                                                                           |
| V12 P2 不新增 fixture 漂移；任务累计 = 申报集合                                     | §1（fixtures 空 diff；累计 = 3 fixture + 2 corpus）                                                                                                                                          |
| V15 设置键改名，parser 规则确定                                                     | T-Q1 14 测试绿；`tests/config` 全绿                                                                                                                                                          |
| V16 corpus 两阶段证明                                                               | §3：三次 dump 均 M=1331（4 份 source 齐全）；规则 R `files=1331 matched=1331 failures=0 fellBack=113`；mid→after 373 文件 cmp 相同；hash 刷新齐全核查 `missing=0 ALL PRESENT`（只刷 N=1327） |
| V17 残留：实际命中集合 == 允许集合                                                  | 门禁 A 对照 A-P2 PASS；门禁 B 对照 B-P2 PASS                                                                                                                                                 |
| V18 commit 申报正确，没有 BREAKING 标记                                             | §9（主题不带 `!`，正文无 `BREAKING CHANGE:` 起始行）                                                                                                                                         |

## 9. commit 正文申报（§6.4 P2，供 root 提交 P2 使用）

主题：

```
feat(fabric): rename the fabric.findingQuota setting to fabric.reportQuota
```

正文：

```
The per-run quota for report messages (previously keyed fabric.findingQuota) is now read from
fabric.reportQuota (default 10, same count() rule). The old key is not read anywhere and is
ignored silently like any other unknown key — no migration, no warning (the user's own config
never set it). The /agent settings listing keeps its position; its description changes from
"Finding messages per sender run" to "Report messages per sender run", and the steer_subagent
reply parameter description now cites the new key.

Declared corpus/pin update (two-phase proof, #21 method): tests/config/__corpus__/settings-corpus.json
template gains "reportQuota": 10 next to the retained stale "findingQuota": 10 (now listed in
retiredPaths so generated inputs keep covering the old key as a tolerated stale input), and all
1327 corpus hashes are refreshed; a before/mid/after GOV_CORPUS_DUMP proof over all 1331 outputs
shows loadSettings output changes ONLY by the declared key rename (rule: replace the single
"findingQuota":<n> with "reportQuota":10 -> byte-identical; files=1331 matched=1331 failures=0
fellBack=113). tests/config/__corpus__/setting-specs-pin.json replaces the one fabric spec hash
in place and recomputes "all" (2-line diff).
```

不带 `!`，正文无 `BREAKING CHANGE:` 起始行。建议精确路径清单（root 提交用）：

```
docs/dev/fabric-cross-session/README.md docs/dev/fabric-kind-rename/P2-report.md
docs/guide/subagents.md
src/fabric/{settings.ts,setting-specs.ts,router.ts} src/tools/steer-tool.ts
tests/config/__corpus__/{settings-corpus.json,setting-specs-pin.json}
tests/config/fabric-report-quota-settings.test.ts
tests/core/message-property.test.ts
tests/fabric/{router.test.ts,router-wake.test.ts,mailbox.test.ts,xs-inbox.test.ts,unknown-kind.test.ts}
tests/helpers/{fabric-inbox.ts,fabric-revive.ts}
tests/tools/{message-agent-tool.test.ts,steer-tool-off-surface.test.ts}
```

## 10. 遗留 / 交接

- P2 commit sha 待 root 提交后回填本报告与 P1 报告 §1。
- 两包均已完成后：主会话一次性 push（§7.1），push 前 `npm test`（tier2 红按 triage；secure 前置按 AGENTS.md）；用户 memory `pitfalls-subagent.md` #17 按 R7 由主会话在合并后更新。
- 热Reload注意：本机若开着旧进程，`fabric.reportQuota` 需 `/reload` 后生效（非 live 设置）。
