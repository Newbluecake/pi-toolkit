## J5 交付报告

### 文件清单（8 个，均在 J5 域内）

| 文件                                      | 行数 | 变更                                                                                  |
| ----------------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `src/memory/jev/write-port.ts`            | 287  | 新建（pi-free，经 boundary 测试自动覆盖）                                             |
| `src/memory/tool-v2.ts`                   | 1126 | 修改（`jev?: JevWritePort` + 写路径接线）                                             |
| `src/memory/tool-surface.ts`              | 120  | 修改（+19 行：`MEMORY_TOOL_V2_TEXT_JEV`，旧常量/schema 不动）                         |
| `tests/fixtures/memory-tool-surface.json` | 24   | 只新增 `jev` key（diff 纯加行 4 行，旧 key 字节不变）                                 |
| `tests/memory/tool-surface.test.ts`       | 221  | 修改（+1 用例：新 key/预算 1638/schema 逐字节不变，双 typebox）                       |
| `tests/memory/jev/write-port.test.ts`     | 487  | 新建，20 it                                                                           |
| `tests/memory/tool-v2-jev.test.ts`        | 565  | 新建，21 test                                                                         |
| `skills/memory-jev/SKILL.md`              | 44   | 新建（只策略，I12；skills 经 package.json `pi.skills` 自动发现，无需改 src/index.ts） |

### 导出对照 §2 / J5.4

- `createJevWritePort(deps: { client, entryIndex, dirFor, taxonomyFor, confirmTimeoutMs, now })`：签名与 plan 一致；另导出 `JevWritePortDeps`、`WRITE_TAG_TOTAL_BUDGET_MS = 3000`。返回物严格实现冻结的 `JevWritePort`（afterWrite 永不 reject / checkInline 新错才拒 / touchedUserEntries 重盖 file 名 / confirmTimeoutMs）。
- `MemoryToolV2Deps.jev?: JevWritePort`：可选依赖，缺省时全部 jev 分支编译外（描述选 `MEMORY_TOOL_V2_TEXT`，`prepareJevGuard` 首行返回，do* 无 baseline/checkInline/append upsert）。
- afterWrite：hash 差集识别改动条目（private/secret 静默跳过）→ registry 缺失 ⇒ `off: pi-api` 单行；status off/partial ⇒ 单行（partial 为 §6.2.1 长句）零调用零侧车；probing/full ⇒ `tagOne` 并行 + 3000ms unref'd abort 总时限（与 tool signal `AbortSignal.any` 合并）→ `writeIndexPatch` 合并侧车（自带锁，busy 只丢不抛）→ §6.2.4 回显（比较对象 = 词面前 12 + 同文件，≤20 个 `c*`）+ usage `{costUsd, calls}`。

### 回显文案示例（实测输出，见测试）

- 成功：`section: pitfalls-git.md #1 (L6-6)` / `jev: pitfall 0.91 · important · tags git-push 0.88, network 0.83 · guard 0.12 · permanent` / `similar: core.md L5 (complementary 0.72)`（插在 head 与 `budget:` 行之间）。
- partial：`jev: not tagged (partial: 451) — fast path will not see this entry until tagged; inline tags=+… works now`（写入已落盘，条目 pending，零调用）。
- 行内注释错误拒写：`refused: n.md would introduce inline-comment errors — …`（原有错误不阻止写入，decision 8 同政策）。
- 用户令守卫：确认框 `agent 请求修改用户令`（body 含条目锚点+摘要）；子会话/无 UI/拒绝/超时抛 `用户未确认：用户令条目只有用户能作废。请在回复里向用户提议具体改法`；确认通过后输出追加 `voided user rule: core.md › Rules #1 (L3-3)`；确认期间文件被改 ⇒ `core.md changed concurrently; view and retry`；rename 不触发。

### 工具描述变体 diff 摘要

`MEMORY_TOOL_V2_TEXT_JEV.description` = 原描述 + `" "` + arch §9.3 逐字句（`Entries are tagged automatically after writes. Inline authority … <!-- mem user|lesson expires=YYYY-MM-DD until="…" gate|gate=hold|nogate tags=+a,-b private -->.`，后缀 194B）；promptSnippet/guidelines/schema 与 v2 共享（`canonicalJson` 双 typebox 逐字节相同，已断言）。预算：v2 1443 → jev **1638B**（上限断言 ≤1700，fixture `jev.bytes` 钉死）。

### 自验输出（真实命令）

```text
$ timeout 600 npx vitest run tests/memory/tool-v2-jev.test.ts tests/memory/tool-v2.test.ts \
    tests/memory/tool-surface.test.ts tests/memory/jev tests/boundary/pi-free.test.ts tests/web-hub/boundary.test.ts
 Test Files  1 failed | 29 passed (30)     # 唯一失败 = J8 在改的 tests/memory/jev/entry-edit.test.ts
 Tests  1 failed | 682 passed (683)        # off-golden 8/8 ✓、write-port 20/20 ✓、tool-v2-jev 21/21 ✓

$ timeout 600 npm run typecheck            # 三段 tsc + vue-tsc 全过，零错误

$ timeout 300 npm run format:check
 [warn] tests/memory/jev/entry-edit.test.ts   # 仅 J8 文件；我的 8 个文件 prettier --check 全过

$ git diff --stat origin/dev -- tests/fixtures/
 tests/fixtures/governance/activate-trace.json |  22 +-   ← J6（声明内）
 tests/fixtures/memory-tool-surface.json       |   4 +    ← J5 本包（只新增 key）✓
 tests/fixtures/memory/jev-off-golden.json     | 1475 +++   ← J0 已合入提交（工作区未改）

$ timeout 600 npx vitest run tests/memory/jev/off-golden.test.ts tests/memory/fs-guard.test.ts tests/memory/tool-v2.test.ts
 Test Files  3 passed (3) · Tests  71 passed (71)   # 含 off-golden 8/8（root 修日期钉后）
```

### 决策与遗留

1. **I9 证明**：off-golden 四个 settings-off 逐字节用例全绿；`tool-v2.test.ts` 59 例原样复跑全绿；description/schema 无端口时逐字节不变。
2. 实施决策（plan 未逐字规定处）：`checkInline` 在锁内对真实最终内容执行（同步、免 TOCTOU）；守卫对「create 到已存在文件 / write 到手写文件」跳过确认（锁内本会拒，不弹无意义框）；`delete/rename` 不走守卫/inline/afterWrite（arch §6.2.1 只列五个写操作，rename 不触发已有测试钉住）；`voided user rule:` 行照搬 v4.1 §3.2 ③；off(pi-api) 判定 = registry 缺失（C-J7 的方法级缺失由 client 探测兜底）；pi Usage 形状无 `calls` 字段 ⇒ usage 落 `cost.total`（tokens 置 0），calls 保留在 `/mem jev` usage 行（代码内有注释）。
3. 已上报 root：off-golden `legacy-tool` 的 UTC 日期翻转 bug（J0 harness 掩码漏了 listing 输出；root 已修复并提交，golden 未动）。
4. 遗留：J7 接线时需把 `createJevWritePort` 的 `entryIndex`/`taxonomyFor`/`dirFor` 从 wire 闭包传入（本包只交付端口与工具侧消费）；J9 用户指南需写明「append 新建文件归属 agent」的行为变化（风险清单已列）。
5. 未 commit（按约定）；未触碰 J6/J8 文件与其它 fixtures。
