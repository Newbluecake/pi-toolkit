# #59 Fleet 抽屉自动归档：条数触发 + 时间门槛

## 实现规则

- `webHub.archiveKeepRuns` 默认 **6**，`webHub.archiveKeepBash` 默认 **5**；分别计数已结束、未归档条目。
- 不超过条数门槛则一直保留；超过时只归档已结束满 `webHub.archiveAfterMin`（默认 **30 分钟**）的条目，最早结束的优先，直到回到门槛或没有符合时间条件的条目。
- held（手动取消归档）条目计入条数，但永不自动归档；运行中和已经归档的条目不计数、不自动归档。
- 两个新设置均校验非负整数；**0 = 无条数门槛，旧的仅时间归档行为**。`archiveAfterMin=0` 仍关闭自动清扫，不起 timer；手动操作保持原样。
- 设置通过既有 `SETTING_SPECS` 表进入 `/agent settings` 文本命令与 TUI 编辑器，无额外编辑器分支；均非 live，修改后 `/reload`，不需要 hub restart。

## 代码结构与不变式

`src/archive/sweep.ts` 的 `selectAutoArchives` 是纯函数：显式接收时间、状态、候选和策略，返回待归档列表，不修改输入。候选按 kind/id 去重，held 参与计数，按结束时间升序筛选。control 仅适配 run/bash 快照并按原有方式每轮批量提交一次。

无 wire/protocol 变更、无新增持久化格式、无新依赖或 timer；保持既有终态时间回退、session restore、dispose、FIFO 容量与 display-only 行为。不修改任何 `tests/fixtures/` 文件。既有历史实施报告见 `archive-report.md`；本报告与 README 的 #59 节补充并更新其原时间清扫规则。

## 本包改动文件（绝对路径）

- `/home/bluecake/ai/pi-toolkit/src/archive/sweep.ts`（新增）
- `/home/bluecake/ai/pi-toolkit/src/archive/control.ts`
- `/home/bluecake/ai/pi-toolkit/src/config/settings.ts`
- `/home/bluecake/ai/pi-toolkit/src/config/setting-specs.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/index.ts`
- `/home/bluecake/ai/pi-toolkit/src/stack.ts`
- `/home/bluecake/ai/pi-toolkit/tests/archive/sweep.test.ts`（新增）
- `/home/bluecake/ai/pi-toolkit/tests/archive/control.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/config/web-hub-settings.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/README.md`
- `/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/archive-threshold-report.md`（本报告）

## 自验

| 命令                                                                     | 结果                                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------- |
| `npm run typecheck`                                                      | 通过（tsc ×2 + vue-tsc）                                 |
| `npm run build`                                                          | 通过                                                     |
| `npx vitest run tests/archive tests/config tests/web-hub --maxWorkers=4` | 740 files passed；16040 tests passed，3 skipped；204.36s |
| `npx prettier --check` + 上述本包精确文件列表                            | 通过                                                     |
| `git diff --quiet HEAD -- tests/fixtures/`                               | exit 0，冻结物未改                                       |

行为断言覆盖：条数不超全保留、超出仅收最早且满时间的条目、时间不足时停止、held 计入但不收、0 的旧行为、agent/bash 独立、运行中/已归档不计数、时间关闭无归档、输入不变。control 测试验证默认门槛接线、一次批量提交与下轮幂等；settings 测试验证默认值、非法值回退及共用编辑表校验。

首次定向测试发现新测试误用了 settings parser 返回字段（应为 `stored/live`，不是 `value`），已修正断言后以上测试全部通过，生产实现未因该错误调整。

## 边界与交付约束

- 仍以现有 QueryService / BashJobManager 内存列表计数；已有归档/held FIFO 256 的边界不变。未做浏览器真机验收（本包无 UI 代码变更）。
- 并行包修改的 `tests/secure/launcher-private-cmd.test.ts`、`tests/integration/web-hub-headless.test.ts`、`tests/web-hub/ui/logic-markdown-perf.test.ts` 不属于本包，未修改或格式化它们。
- **零 git 写操作**：未 add、commit、push、checkout、建分支或修改 git 配置；只运行只读 status/diff。
- 无本包已知阻塞问题；未进行异源模型独立验收（当前可用工具无 Agent 派发入口），上述结果为真实命令自验。

建议 commit message（仅建议，未执行）：

```text
feat(archive): gate fleet auto-archive by terminal counts and age
```
