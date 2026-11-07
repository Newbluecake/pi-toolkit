# J4 交付报告（侧车索引、打标编排、`/mem jev` 与 `/mem tags`）

## 文件清单

| 文件                                                                 | 行数            | 说明                                             |
| -------------------------------------------------------------------- | --------------- | ------------------------------------------------ |
| `src/memory/jev/index-store.ts`                                      | 414             | 新建：侧车 index.json / taxonomy.json 读写       |
| `src/memory/jev/tagging.ts`                                          | 292             | 新建：tagOne / tagBulk 编排                      |
| `src/memory/jev/review.ts`                                           | 354             | 新建：配对/建议/dismissed/stale/整理 pass 纯逻辑 |
| `src/memory/jev/command-port.ts`                                     | 624             | 新建：JevCommandPort 实现 + `/mem tags add` 解析 |
| `src/memory/command.ts`                                              | +185/−8         | `jev?` 端口、jev/tags 分支、状态行、补全         |
| `src/web-hub/agent/command-policy.ts`                                | +15             | mem() 的 jev/tags 子命令级策略                   |
| `tests/memory/jev/{index-store,tagging,review,command-port}.test.ts` | 291/339/398/477 | 新建                                             |
| `tests/memory/command-jev.test.ts`                                   | 292             | 新建                                             |
| `tests/web-hub/agent/command-policy.test.ts`                         | +26             | 追加 Q35 用例                                    |

新文件零 `node:fs` import（全走 safe-fs 原语）、pi-free（boundary 测试含新文件）。

## 导出对照 §2 冻结表

- `readIndex` / `writeIndexPatch` / `gcIndex` / `readTaxonomyFile` / `writeTaxonomyFile` / `removeIndex`、`tagOne` / `tagBulk`、`buildPairs` / `staleCandidates` / `runReviewPass` / `suggestionsFrom` / `isDismissed` / `anchorOf` / `markStale`、`createJevCommandPort` — 名称与签名与 §4 J4 契约一致。
- **契约补充（root 批准，全部可选向后兼容）**：`tagBulk` 增 `onEntryTags?` / `base?`；`runReviewPass` 增 `project?` / `signal?`（返回型收窄为 `ReviewPassResult = ReviewState | Extract<JevOutcome,{ok:false}>`）；`createJevCommandPort` deps 增 `config?` / `usage?` / `segment?` / `health?`；`TAG_MAJOR_BATCH_TOKENS = 20_000`（arch §5.2 分批口径的例外，root 已批，**待 J9 回写架构稿**）。

## `/mem jev` 行为表

| 输入                     | 行为                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/mem jev`               | 端口 report（§9.4 十行结构，formatJevReport）；坏侧车 JSON ⇒ status 行追加 `· index rebuilt`；非 Linux ⇒ `evidence process: bash jobs only (non-Linux)` |
| `/mem jev probe`         | 强制刷新可用集，返回 `jev: probe → <status>`；无 registry ⇒ 明确提示                                                                                    |
| `/mem jev retag [--all]` | 仅主会话+hasUI；默认只打 pending，`--all` 全量（base 传空）；失败/中断 ⇒ 余下保持 pending；锁忙 ⇒ 提示结果未保存                                        |
| `/mem jev reset-index`   | 仅主会话+hasUI；删 index.json，保留 taxonomy.json                                                                                                       |
| 其它 token               | usage 提示（warning）                                                                                                                                   |
| 子会话/无 UI 调写操作    | warning「requires the interactive main session」，不触端口                                                                                              |

## `/mem tags` 行为表

| 输入                                                                      | 行为                                                                                                                                |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/mem tags [list]`                                                        | 列启用标签（id/label/[high]/desc/preset                                                                                             | user）+ `disabled presets:` 行；taxonomy 文件非法 ⇒ 提示并回退预置清单 |
| `add <id> --label … --desc "…" [--risk] [--commands] [--paths] [--tools]` | 仅主会话+hasUI；自写最小引号解析（已上报默认做法）；新 id 新增、旧 id 更新（description 变更 rev+1）；成功后 `triggerBulk` 排队补打 |
| `rm <id>`                                                                 | 预置拒绝（提示 disable），用户标签删除                                                                                              |
| `disable/enable <id>`                                                     | 预置走 disabledPresets（enable 触发补打）；用户标签 disable=删除（文件无 user-disabled 槽，§4.3.1）                                 |

## web 端放行/确认表（Q35）

- **allow**：`mem jev`（裸）、`mem tags`、`mem tags list`
- **confirm**：`mem jev probe|retag|reset-index`、`mem tags add|rm|disable|enable`（及未知子子命令，保守归 confirm）
- **deny**：本包无新增 deny 行；`command-usage.ts` 未改；原有行不变

## 自验输出（真实命令结果）

1. `timeout 600 npx vitest run tests/memory/jev tests/memory/command-jev.test.ts tests/memory/command.test.ts tests/memory/jev/off-golden.test.ts tests/web-hub/agent/command-policy.test.ts tests/boundary/pi-free.test.ts` → **Test Files 23 passed (23) / Tests 575 passed (575)**
2. `timeout 600 npm run typecheck` → exit 0
3. `timeout 300 npm run format:check` → All matched files use Prettier code style!
4. `git diff --stat origin/dev -- tests/fixtures/` → 仅 `jev-off-golden.json +1475`（J0 已 commit 的文件，origin/dev 落后本地；`git status --short -- tests/fixtures/` 为空，本包未动任何 fixture）
5. 交付要求加跑 `timeout 600 npx vitest run tests/memory/jev/off-golden.test.ts tests/memory/command.test.ts` → **2 files / 22 tests passed**（无端口 `/mem` 输出逐字节不变）
6. 邻域回归（自愿加跑，证明无外溢）：`tests/memory/{init-command,tidy-batch-p3a-gates}` + `tests/web-hub/agent/{command-policy-fabric,real-command-matrix}` + `schedule-policy` + `webhub-2fa` + `logic-upload` → 182 passed；`tests/integration/web-hub-slash-args.test.ts` → 9 passed

## 遗留与上报事项

1. **J6 需知**：有端口时 `/mem` description 追加 ` · /mem jev · /mem tags`（root 已批）；pi-api 配置下 `registerCommand:mem` 描述会变，`PI_API_ALLOWED_DIFF` 需追加 token `registration:registerCommand:mem`；`config/usage/segment/health` 四个可选 deps 接线时补齐（缺省：models 行空、usage 0、segment 全 0）。
2. `triggerBulk(cwd)` 语义假设为「后台补打（新/改标签 + pending）」，由 J6 实现时对齐；`tags add`/`enable` 后调用。
3. `TAG_MAJOR_BATCH_TOKENS=20_000` 是 arch §5.2 分批口径的例外（J9 回写架构稿）；其余题型仍 12k。
4. `/mem review`、`/mem expired` 命令分支归 J8；本包只提供 `port.review.{list,run,dismiss,resolve}`。
5. review 问题的 `updatedAt` 用侧车 `at`（MemEntry 无 frontmatter updated 字段，冻结构不可加）；`project` 取 slug 目录 basename。
6. 用户标签 disable=删除（taxonomy 文件结构无 user-disabled 槽）——如需真「停用用户标签」，需 root 在 `TaxonomyFileV1` 追加可选字段。
7. 未 commit（按规约）；未跑全量测试（按 §1.4 收窄）。
