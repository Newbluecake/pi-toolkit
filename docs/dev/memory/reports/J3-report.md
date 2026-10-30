## J3 包（设置与 secure）交付报告

**改动文件**（均为精确路径，未 commit）：

- `/home/bluecake/ai/pi-toolkit/src/memory/settings.ts`（+150）：新增 `MemoryJevSettings` 类型、`parseJevClassifiers`/`splitJevClassifiersCsv`/`truncateCodepoints` 内部 helper（无新增 import）、`parseMemorySettings` 内联解析 `jev` 块、`DEFAULT_MEMORY_SETTINGS.jev` 默认值。
- `/home/bluecake/ai/pi-toolkit/src/memory/setting-specs.ts`（+70/-一行 import）：追加 14 个 `memory.jev.*` spec，`import` 行加 `csvString`。
- `/home/bluecake/ai/pi-toolkit/src/config/settings.ts`（+3）：`TIME_SETTING_MS_PATHS` 加 `"memory.jev.confirmTimeoutMs"`；`applySecureDomainOverrides` 的 `out` 加 `memory: { ...settings.memory, jev: { ...settings.memory.jev, enabled: false } }`。
- `/home/bluecake/ai/pi-toolkit/docs/dev/data-encryption/README.md`（+1/-1）：D8 清单补 `memory.jev.enabled`。
- `/home/bluecake/ai/pi-toolkit/tests/config/memory-settings.test.ts`（+221）：默认值表加 `jev`；新增 jev garbage/range/Q34/corpus-key 共 13 个 `it`。
- `/home/bluecake/ai/pi-toolkit/tests/secure/settings-override.test.ts`（+4）：`USER` 加 `memory.jev.enabled:true`；secure/locked 两例断言 `s.memory.jev.enabled === false`。
- `/home/bluecake/ai/pi-toolkit/tests/config/__corpus__/setting-specs-pin.json`、`settings-corpus.json`：按 `4758bae5` 先例重 pin（见下方“主会话裁定”）。

## 14 个键最终默认值

| 键                                                      | 默认值                                            |
| ------------------------------------------------------- | ------------------------------------------------- |
| `memory.jev.enabled`                                    | `true`                                            |
| `memory.jev.classifiers`                                | `["opencode/jev-1.13-free","opencode/jev-1.13"]`  |
| `memory.jev.proxy`                                      | `""`                                              |
| `memory.jev.childSessions`                              | `true`                                            |
| `memory.jev.recall.threshold`                           | **0.6**（主会话 E0 基线拍板改自架构稿 0.7，见下） |
| `memory.jev.recall.maxEntries`                          | `3`                                               |
| `memory.jev.recall.maxBytes`                            | `4096`                                            |
| `memory.jev.recall.waitMs`                              | `1500`                                            |
| `memory.jev.gate.enabled`                               | `true`                                            |
| `memory.jev.gate.threshold`                             | `0.6`                                             |
| `memory.jev.review.intervalDays`                        | `7`                                               |
| `memory.jev.maxCostUsd`                                 | `0.5`                                             |
| `memory.jev.maxCalls`                                   | `800`                                             |
| `memory.jev.confirmTimeoutS`（内部 `confirmTimeoutMs`） | `60`（60_000ms）                                  |

`classifiersRejected`（非设置键，解析结果）默认 `[]`。

**中途收到主会话 steer**：E0 基线实测拍板把 `recall.threshold` 默认值从 0.7 改 0.6（gate.threshold 不变）；已回复确认并同步改了 `settings.ts` 默认值/注释、`memory-settings.test.ts` 的 pin 断言，并在重 pin 两份 corpus 时带上新默认值。未碰 `jev-arch.md`（主会话负责同步架构稿）。

## secure 强制关闭落点与反向测试

- 落点：`src/config/settings.ts` `applySecureDomainOverrides`，`domain.kind !== "plain"` 时把 `memory.jev.enabled` 强制 `false`（和 `fabric.crossSession`/`externalAgents.droid`/`feishuNotify`/`traffic` 同一处克隆覆盖，不影响其它 `memory.*` 字段）。
- 反向测试：`tests/secure/settings-override.test.ts` 的 `USER` fixture 显式写 `memory.jev.enabled:true`，secure 与 locked 两条用例都断言 `s.memory.jev.enabled === false`；plain/无判决用例维持字节级 identity（未改）。

## corpus 重 pin diff 摘要

- `setting-specs-pin.json`：用 `GOV_SPECS_GENERATE=1 npx vitest run tests/config/setting-specs-pin.test.ts` 重 pin；diff 只是新增 14 个 `memory.jev.*` key 导致的数组位移，非 jev 的既有 key 哈希值全部不变（脚本核对过）。
- `settings-corpus.json`：从 `git show origin/dev:tests/config/__corpus__/settings-corpus.json` 提取现有 368 条 `captured[i].input`（已是 tagged 形式）写入临时文件，`GOV_CORPUS_GENERATE=<tmp>.json npx vitest run tests/config/settings-corpus.test.ts` 重新生成；程序化比对 `template` 字段：只多了 `.memory.jev` 子树，`timePaths` 只多了 `"memory.jev.confirmTimeoutMs"`，`captured`/`seed`/`randomCount` 等其余字段逐项一致（368 条、seed 20261027、randomCount 300 均未变）。
- 两份 JSON 生成后跑了 `prettier --write` 修正缩进（脚本写出的是 1 空格缩进，仓库约定 2 空格），重跑测试确认内容未受影响。

## 自验命令与真实输出

```
$ timeout 600 npx vitest run tests/config tests/secure/settings-override.test.ts tests/secure/off-golden.test.ts tests/web-hub/boundary.test.ts
 Test Files  49 passed (49)
      Tests  664 passed (664)

$ timeout 300 npx prettier --check src/memory/settings.ts src/memory/setting-specs.ts src/config/settings.ts docs/dev/data-encryption/README.md tests/config/memory-settings.test.ts tests/secure/settings-override.test.ts tests/config/__corpus__/setting-specs-pin.json tests/config/__corpus__/settings-corpus.json
All matched files use Prettier code style!

$ git diff --stat origin/dev -- tests/fixtures/
 tests/fixtures/memory/jev-off-golden.json | 1475 +++++++++++++++++++++++++++++
```

## 遗留与上报事项

1. **`git diff --stat origin/dev -- tests/fixtures/` 非空**：差异来自已提交进 HEAD 的 J0 包（commit `6bd3f92f`，HEAD 比 `origin/dev` 领先 22 个提交），不是 J3 引入；我未新建/修改任何 `tests/fixtures/` 文件（`git status` 对该目录无 pending 改动）。
2. **`npm run typecheck` 整体跑会红**：错误全部在 `src/memory/jev/*.ts`（`entries.ts`/`match.ts`/`taxonomy.ts` 等）与 `src/memory/doctor.ts` 的 `findSecrets` 引用——这些是并行 J1 开发尚未完成的文件（按任务说明属于另一位开发，我未触碰）。已确认输出中**不含**我改动的三个 `src/` 文件（`memory/settings.ts`、`memory/setting-specs.ts`、`config/settings.ts`）的任何报错，判断是 J1 在制品导致，不在本包范围内，未修复。
3. **`npm run format:check` 整体跑会红**：同上，剩余 warn/error 全部集中在 `src/memory/jev/*.ts`（J1 域），我涉及文件已单独用 `prettier --check` 验证全绿。
4. 按方案未跑全量测试（`npm test`）与完整 `npm run typecheck`，仅按 J3 定向命令自验，符合 §1.4「自验收窄」约定。
