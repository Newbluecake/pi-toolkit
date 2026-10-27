# ⑨-H3 `web-hub/hub/hub.ts` 装配拆分报告

基线 `74703578`（dev），分支 `gov/step9h3`。依据 `batch2-plan.md` §6 H3 行、§0、§8.3 与文末拍板（只做纯抽取，测试跟着改）。

## 行数前后对比

| 对象                | 前   | 后   |
| ------------------- | ---- | ---- |
| `hub/hub.ts` 总行数 | 2434 | 1153 |
| `startHub`          | 2023 | 864  |

新文件（`src/web-hub/hub/`）：`assembly.ts`（显式 `HubAssembly` ctx + `createHubAssembly`，260）、`assembly-storage.ts`（125）、`assembly-registry.ts`（63）、`assembly-channels.ts`（217）、`assembly-feishu.ts`（162）、`assembly-spawn.ts`（350）、`assembly-preview.ts`（116）、`assembly-schedule.ts`（19）、`assembly-runtime.ts`（306，uploads / supersede / 运行期监视器）。

## 提交

- `4d2c5fd3` refactor(web-hub): extract storage registry and channel assembly
- `0dd89a71` refactor(web-hub): extract spawn preview and feishu assembly
- `29450bd2` refactor(web-hub): extract runtime monitor assembly
- 本报告（最后一个提交）

调度块已在 `assembly-schedule.ts`，没有遗漏；本步追加的修正提交：无（审查未发现行为差异）。

## 零行为证据

审查（静态）：

- 新文件无模块级 `let`/`var`/可变容器（grep 验证）；
- 未改设置键、wire 字段、tool schema/描述、命令表、注册顺序、模型可见文本；
- 跨装配块共享的状态（`kdfInFlight`、`lanBlockedByRotate`、`lastSpawnStatus` 等）都改成 `ctx` 字段，并在 `createHubAssembly` 里显式初始化。
- `cleanup.push` 顺序与 close 顺序：`hub-preview` / `hub-spawn` 的顺序钉测试通过。

被钉住的代码段，测试改为指向新文件，钉住的意图不变：

- `hub-preview.test.ts` 的 close 顺序（`previewRoutes!.dispose("close"` 等，只因 ctx 字段带 `!`）；
- `hub-spawn.test.ts`：`managedBusy` → `assembly-runtime.ts`，`onPrevAgentGone` → `assembly-spawn.ts`；
- `hub-startup-gate.test.ts`：ctx 字段显式初始值检查改读 `assembly.ts` 的 `createHubAssembly`；registry/history 的「socket 暴露前已初始化」改读 `assembly-registry.ts`；
- `protocol/feishu.test.ts`：`FSB_HUB_CAP` 条件展开 → `assembly-channels.ts`。

自验（均在 `/tmp/gov-step9h3`）：

| 命令                                                                                                                               | 结果                              |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `npm run typecheck`                                                                                                                | 通过                              |
| `npx vitest run tests/web-hub --maxWorkers=3`                                                                                      | 707 文件 / 15853 通过 / 4 skipped |
| `npx vitest run tests/integration/web-hub-*.test.ts` + conformance `web-resume` / `cmd-history` / `slash-args` / `history-restore` | 32 文件 / 244 通过 / 1 skipped    |
| `npm run build:web && npm run check:web`                                                                                           | 通过                              |
| `npm run format:check`                                                                                                             | 通过                              |
| `git diff --quiet 74703578 -- tests/fixtures/`                                                                                     | 无差异                            |

## 遗留

- `startHub` 仍有 864 行：admin handler、LAN 装配、frontendDeps、proxy 服务、`hub.json` 首写、`close()` 仍留在 `hub.ts`。它们强依赖 `closing` / `httpPort` / `owner` 等闭包局部量，不在 §6 H3 的拆分清单内；继续拆需要把 `closing` 和 `close` 做成 ctx 状态，属于另一个包，建议单独立项。
- 5 个临时脚本 `.h3-*.cjs` 已删除，未提交。
