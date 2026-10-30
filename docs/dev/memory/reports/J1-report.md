# J1 纯域 · 交付报告

## 文件清单（绝对路径 + 行数）

**新建 src（9 个，全部 pi-free、零模块级可变状态）**

| 文件                                                         | 行数 | 内容                                                     |
| ------------------------------------------------------------ | ---- | -------------------------------------------------------- |
| `/home/bluecake/ai/pi-toolkit/src/memory/jev/contracts.ts`   | 617  | 全部冻结类型、常量、两个 customType                      |
| `/home/bluecake/ai/pi-toolkit/src/memory/jev/entries.ts`     | 649  | 切分规则 1–5、双哈希、行内解析、到期判定、`EntryIndex`   |
| `/home/bluecake/ai/pi-toolkit/src/memory/jev/shell-parse.ts` | 492  | v4.1 §2.7.1 全量 bash 解析（8KB/深度≤2/永不抛错）        |
| `/home/bluecake/ai/pi-toolkit/src/memory/jev/format.ts`      | 363  | 六类文案（与 arch 逐字一致）                             |
| `/home/bluecake/ai/pi-toolkit/src/memory/jev/taxonomy.ts`    | 330  | 6 类型/4 重要度/22 预置标签、merge/validate/rev/criteria |
| `/home/bluecake/ai/pi-toolkit/src/memory/jev/match.ts`       | 288  | cmd 模式、glob、词面预筛、`namedPrograms`、`matchTags`   |
| `/home/bluecake/ai/pi-toolkit/src/memory/jev/redact.ts`      | 129  | §7.1 先匹配后截断流水线                                  |
| `/home/bluecake/ai/pi-toolkit/src/memory/jev/guard.ts`       | 33   | guardHash 多重集合配对                                   |
| `/home/bluecake/ai/pi-toolkit/src/memory/secret-patterns.ts` | 127  | doctor 搬家 + `looksSecret`                              |

**修改**：`src/memory/doctor.ts`（+5/−112，纯搬家，D13 行为字节不变）；`tests/boundary/pi-free.test.ts`（+16，新增 jev glob 根去 wire/segment + secret-patterns）。

**新建测试（9 个，共 1,955 行）**：`tests/memory/jev/{contracts,entries,format,guard,match,redact,shell-parse,taxonomy}.test.ts`、`tests/memory/secret-patterns.test.ts`。J0 的 `off-golden.test.ts` 未动。

## 冻结导出（对照 plan §2，全部落齐）

- **contracts.ts**：`MemEntry/InlineMeta/EntryHash/EntryType/Importance`；`TagDef/Taxonomy/JevIndexV1/EntryTags/ReviewState/ReviewSuggestion/DismissedPair`；`JevQuestion/JevAnswer/ClassifierRegistryLike/FetchLike/JsonObject`；`JevDuty/JevRequest/JevOutcome/JevClient/JevStatus/JevStatusReason/JevUsage`；`JevConfig`（逐字）；`InjectLayer/MemoryInjectDetailsV1/MemoryRecallItemV1/MemoryRecallEntryV1` + `subagent:memory-inject`/`subagent:memory-recall`；`GateDecision/GateCandidate/GateEvidence/VerdictKey`；端口 `JevWritePort/JevCommandPort/JevDoctorPort/JevBashJobsPort/JevRenderInfo/MemCommandUiLike`（签名逐字）；补登 `TagDefInput/TaxonomyFileV1/ReviewSuggestionView/IndexPatch/BulkResult/NotifyKind/HealthTable/TokenBucket/JevReportView/RedactField/SimpleCommand/EffectiveMeta/ExpiredKind`；常量 360/12000/64·10min/30/32/30·60s/2000·1MB/64/4096·2s + `INLINE_META_MAX_BYTES=200`。
- **entries.ts**：`expiredEntries/untilEntries` 供 J6/J8。其余模块导出按 J1 §4 签名（`prefilter` 增加 `textOf` 参数以泛型化）。

## 22 个预置标签 id（description 已定稿英文 ≤240B）

高危 9：`git-commit git-push git-history release deletion dispatch dependencies credentials frozen-files`；普通 13：`model-routing testing build ci network config shell-env background-jobs session-context docs communication workflow memory-system`。

## 主会话裁定 #3 的改动（已落实）

`deletion` 去掉 `tools:["memory"]`，matcher 定稿为 `commands: ["rm","git rm","find -delete","trash"]`；理由写入 taxonomy.ts 注释（每次 memory 写入命中高危标签 ⇒ 同步 Jev 门禁 ≤2.5s 代价过高；memory 删除已有用户令两阶段守卫）；`taxonomy.test.ts`/`match.test.ts` 补钉（memory 工具 delete/str_replace 不再命中 deletion，rm/git rm/trash 命中）。裁定 #5 的「与 D13 不同源、刻意更激进」也写入 redact.ts 注释。

## 自验输出（真实命令）

```
$ timeout 600 npx vitest run tests/memory/jev tests/memory/secret-patterns.test.ts \
    tests/memory/doctor.test.ts tests/boundary/pi-free.test.ts
      Test Files  12 passed (12)      Tests  369 passed (369)
$ timeout 600 npx vitest run tests/memory/doctor.test.ts tests/memory/jev/off-golden.test.ts
      Test Files  2 passed (2)        Tests  99 passed (99)   ← 搬家 + off golden 零影响
$ timeout 600 npx vitest run tests/memory/jev … tests/web-hub/boundary.test.ts（裁定前全量轮）
      Test Files  13 passed (13)      Tests  389 passed (389)
$ timeout 600 npm run typecheck        → exit 0（两次 tsc + vue-tsc）
$ timeout 300 npm run format:check     → All matched files use Prettier code style!
$ git diff --stat HEAD -- tests/fixtures/      → 空（J1 工作区零 fixture 改动）
$ git diff --stat origin/dev -- tests/fixtures/ → 仅 `jev-off-golden.json` +1475，
   属 J0 已提交基线（6bd3f92f，origin/dev 落后本地 5 个提交），非 J1 改动
```

- shell-parse：**87 条表驱动**用例 + argv/cwd/heredoc/深度细节断言 + `programIdentity` 直测 + 800 例种子模糊（随机 token 汤与随机 latin1 字节，永不抛错）＝ 该文件 99 测试。
- `parseInlineMeta` 种子属性测试 600 例（含整行包裹再解析），`stripInlineMeta` 幂等。
- `secret-patterns.test.ts`：与 doctor D13 同源（doctor.test.ts 的正/负样本集逐条对 `looksSecret` 断言一致）。
- 未跑全量测试、未 commit、未用任何禁用 git 命令；只对本包文件跑过 prettier --write。

## 遗留与上报事项

1. 已上报 root 并获裁定 7 条（见上），全部按裁定落实。
2. `JevReportView` 字段按 §9.4 示例定稿；J4 若不够用需走「root 在 contracts 追加可选字段」流程（plan §2 规则）。
3. 未决默认（已写入注释，root 未回复则视为保留）：文件末尾短段并入上一条；`ordinal` 为 `## ` 区域内 1-based；`jev: off (disabled)/(legacy)` 文案。
4. 范围外发现（未改）：E0（6d9923f0）把召回阈值调为 0.6 并改了召回题措辞——属 J2/J3 域，J1 文案与常量不受影响；J3 已并行合入其文件域，typecheck 在两者共存下通过。
5. 规模超出方案预估（新 src 3,028 行 vs ~1,600）：contracts.ts 类型冻结占 617 行、shell-parse 完整词法占 492 行所致，无逻辑冗余。
