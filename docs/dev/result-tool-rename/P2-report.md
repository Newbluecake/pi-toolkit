# P2 报告：web UI 双名渲染（get_run_result / get_subagent_result）

> 日期：2026-10-26。依据 `plan.md` §3.7（web hub 新旧混跑）、§7.1.8、§9 P2 行、r3 裁定与「用户拍板」（D1=A′、D2=`get_run_result`）。纯增量，旧会话历史里 `get_subagent_result` 卡片的现有特殊处理（markdown 渲染、runRef 头）逐字节不变。

## 改动文件（绝对路径）

- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/logic/tools.js`
  — `RUN_REF_TOOLS` 追加 `"get_run_result"`；`"get_subagent_result"` 标注「legacy (≤ v0.9)，仅历史 transcript」；`runRefOf` 头注释同步。
- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/components/transcript/ToolCard.vue`
  — `MD_RESULT_TOOLS` 追加 `"get_run_result"`，旧名同上加注。done 态结果继续走 `MarkdownView` 管线，其余卡片零改动。
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/tool-card.test.ts`
  — 新增：① `get_run_result` done 态 markdown 渲染用例（h3/表格/列表，无裸 `<pre>`），旧名 markdown 用例原样保留并继续通过；② 新 describe「result-tool rename」，`toolView` 对新旧两个名字都产出 `runRef` 且卡片头渲染 `label (run_id: …)`（循环覆盖两名）。

## 自验（2026-10-26，dev 工作区）

| 命令                                             | 结果                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `npx vitest run tests/web-hub/ui --maxWorkers=4` | ✅ 267 files / 5865 tests 全过（62s）                                                                        |
| `npm run typecheck`                              | ✅ exit=0，0 个 error TS（首次跑 exit=1 无任何错误输出，系与 P1 在途会话并发的瞬时现象，分步与整跑复验均 0） |
| `timeout 600 npm run build:web`                  | ✅ exit=0，`✓ built in 27.87s`                                                                               |
| `timeout 300 npm run check:web`                  | ✅ exit=0，全部 bundle 门禁在限内                                                                            |
| `npx prettier --check <三个改动文件>`            | ✅ All matched files use Prettier code style                                                                 |

## 边界与遗留

- 文件域严格限于 P2 三文件；未碰 P1 在途的 src/core、src/tools、src/runtime、src/schedule、tests（除 tests/web-hub/ui）及未跟踪的 `docs/dev/web-hub/outdated-reload-preview.html`；零 git 写操作。
- 旧 hub（bundle 未更新）× 新 agent 的回落行为（新名卡片退化为 `<pre>`，需 `/webhub restart`）为 plan §3.7 预期，不属本包改动。
- 真机 smoke S6（新旧名卡片实测）待 P1 合入、`/webhub restart` 后按 §7.4 执行。
