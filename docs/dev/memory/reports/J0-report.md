# J0 基线包 · 交付报告

## 新建文件清单（9 个，`git diff origin/dev -- src package.json` 为空，src/ 零改动）

| 文件                                            | 行数 | 内容                                                                                                                                         |
| ----------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/memory/jev/helpers/off-harness.ts`       | 614  | `recordMemoryOff(config)`、`recordingPi()`、`fakeHub()`、`OffRecord`/`OffConfigName` 类型、掩码（`${MEMROOT}`/`<DATE>`/`<TRASHID>`）         |
| `tests/memory/jev/off-golden.test.ts`           | 337  | 生成闸（export `assertGenerateOnceGate`）、四配置逐字节断言、pi-api 逐字段比对（export `PI_API_ALLOWED_DIFF`＝空清单，token 语法写在文件头） |
| `tests/fixtures/memory/jev-off-golden.json`     | 1475 | A′ golden，`baseline: 9e7218ae…`（＝生成时 `git rev-parse HEAD`），prettier 格式化                                                           |
| `tests/conformance/memory-jev-channels.test.ts` | 921  | C-J1–C-J15（真实 AgentSession；门控项 skip 并写明原因）                                                                                      |
| `scripts/dev/jev-eval.mjs`                      | 441  | 评测脚本；问题模板构造函数全部 `export`（J2 一致性对照用）；System One 直连/CONNECT 代理真跑路径                                             |
| `docs/dev/memory/eval/jev-recall.json`          | 415  | 召回 40 例（8 例指代型带 `previous_message`；7 例反例含 core 重复注入）                                                                      |
| `docs/dev/memory/eval/jev-gate.json`            | 31   | 门禁 24 例（`git checkout -b`/`git stash`/`reset --hard` 正例、`echo "git commit"` 干扰）                                                    |
| `docs/dev/memory/eval/jev-tag.json`             | 277  | 打标 30 例（六类 type × 0–3 重要度）                                                                                                         |
| `docs/dev/memory/eval/jev-review.json`          | 184  | 整理 20 对（12 merge / 8 keep）                                                                                                              |

数据集均取材本仓真实记忆主题，已人工脱敏（代理一律 `http://proxy.example:7897`；regex 扫描无 token/邮箱/内网 IP 命中）。

## 五个 off 配置各录制了哪些字段（OffRecord）

每配置（disabled / legacy-layout / legacy-tool / secure-sim / pi-api，dev 上各录一份）：

- **registrations**：fake pi 上有序的 `on`/`registerTool`（name+label+description+promptSnippet+promptGuidelines+`canonicalJson(parameters)`）/`registerCommand`/`registerMessageRenderer`/其余 register 面 + hub `sections.register` 名字 + 未实现属性的 `pi-access` 记录（Proxy 防漏录）。
- **render**：current-5 与 synthetic/extra-pinned（合成 core，无 `<!-- mem`）在主/子会话下 section provider 输出（经 `ARMORY_MEMORY_ROOT` 逐 fixture 切换，与生产同路径）。
- **tool**：v2 全脚本 12 步（view 目录→create→view 文件→view section→str_replace→insert→append 别名→write 别名→search→rename→delete→view 终态）或 legacy 5 步；每步输出 + 目录全部 *.md 字节 + .trash 名单（id 掩码）。
- **command**：`/mem`、`/mem list`、`/mem doctor`、`/mem path` 的 notify 文本（level+message）＋ `getArgumentCompletions` 对 `""`/`t`/`tidy `/`restore `/`j`/`r`。
- **doctor**：`collectDoctorFindings` 序列化 + `formatDoctorReport` 文本。
- **reminder**：session_start（主会话、hasUI、固定 sessionId）的启动提醒 notify 序列（进程级去重表先清空）。
- **tidyPrompt**：`buildTidyPrompt` 对 current-5 的输出（migration mode，因 fixture 无 core.md）。

确定性：fake Date 钉死 `2026-10-30T08:00:00Z`，fixture mtime 固定，tmp 根/`updated:` ISO/trash id 掩码 ⇒ 连跑 3 次逐字节一致。

## C-J1–C-J14 实际观察（★＝与架构稿表述不同，已 message_agent 上报 root）

- C-J1：before_agent_start **被 await**；返回 message 在用户消息之后、首次 LLM 请求可见；**custom 消息在 LLM 上下文以 role:"user" 投影**（按文本定位断言）；抛错 handler 被吞、run 正常。
- C-J2：block ⇒ 工具不执行（标记文件不存在）、模型收到 reason 文本的 isError 结果、`tool_result` **不触发**；handler 抛错同样转 isError 结果（错误文本＝抛错消息），run 不中断。
- C-J3：同消息双工具调用按 content 顺序派发，默认并行（两次派发间隔 <350ms，0.4s bash 重叠执行），两个结果同轮合并进下一次请求。
- C-J4 ★：`sendMessage(triggerTurn:false)` 在本 turn 的 **turn_end 即 flush**（工具结果之后、本 run 内下一次 LLM 调用可见、不起额外一轮）——arch §6.1.3 原假设**成立**（方案表措辞照此理解）；LLM 侧投影 role:"user"，会话树为 custom_message。
- C-J5：`tool_result` 带 `input`/`isError`；内建 bash `structuredContent.exit_code=7`。
- C-J6 ★：streaming + triggerTurn:true 走 **agent.steer**（同 run 下一次请求可见；非「message_start」）；空闲 + triggerTurn:true ⇒ 新 run 以 custom 消息为 trigger（before_agent_start `messageType:"custom"`，请求末位）；空闲 + triggerTurn:false ⇒ 仅 message_start/message_end append、零新 run。
- C-J7：event ctx / tool execute ctx / 命令 ctx 三处 `modelRegistry.classify/getAvailableOfType/getModelOfType` 均为 function（ModelRegistry 包 modelRuntime）。真实调用/abort 留 E0（门控 skip）。
- C-J8：门控 skip（未设 `PI_TOOLKIT_JEV_CONFORMANCE=1`，写明原因）；错误格式已从 pi-ai 源码确认 `System One API error (<status>): …`，实测留 E0。
- C-J9：`/skill:<name> args` 展开为 `<skill name=… location=…>…</skill>\n\n<args>`（块在头部、参数跟在闭合标签后）——剥离规则的依据；未知 `/` 命令原样透传。
- C-J10：手动 `session.compact()` 产生 `compaction` 条目（含摘要文本），`session_compact` 事件一次；`turn_end` 每轮一条、turnIndex 单调、带 messageEntryId/toolResultEntryIds；压缩后请求只见摘要不见原文。
- C-J11：嵌套 `ctx.executeTool` 同过 `tool_call`/`tool_result`，nested id `<parent>/1`、`parentToolCallId` 指向父。
- C-J12：工具结果 `usage` 原样出现在 `tool_result` 事件（input/cost.total 精确相等）——`JevWritePort.afterWrite` 的 usage 落点可用。
- C-J13：`registerMessageRenderer` 接受注册；headless（print 模式）渲染器不回调（TUI 折叠留真机验收）；消息内容完整达模型。
- C-J14：命令 ctx 的 `ui` 是 noOp stub：`setEditorText` 存在且可调用、`getEditorText()` 恒 `""`、mode="print"、hasUI=false。
- C-J15（离线目录部分）：四个 jev id 全在 pi-ai provider catalog 导出（opencode.models / openrouter.models 子路径）。可用性+真实调用＝门控 skip。

## 自验命令与真实输出（J0 第 7 条）

```
$ timeout 600 npx vitest run tests/memory/jev/off-golden.test.ts tests/conformance/memory-jev-channels.test.ts
 Test Files  2 passed (2)
      Tests  22 passed | 1 skipped (23)          # skipped = 门控占位（C-J7 真调/C-J8/C-J15 真调）

$ timeout 600 npm run typecheck && timeout 300 npm run format:check
（typecheck 三段全过，无输出）
Checking formatting...
All matched files use Prettier code style!

$ node scripts/dev/jev-eval.mjs --help && node scripts/dev/jev-eval.mjs --dry-run --set recall | head -40
（--help 退出码 0；dry-run 打印 e_r01 完整问题 JSON：state.user_message + bool 问题 + criteria 后退出，零网络）

$ git diff --stat origin/dev -- src package.json tests/fixtures/
（空输出——src/package.json/受管 fixtures 零改动）
```

附加验证：

- off-golden **连跑 3 次**：`8 passed (8)` ×3，逐字节稳定。
- **单字节篡改**（golden 内翻转 1 字节）：`Tests 2 failed | 6 passed`（disabled 字节比对 + pi-api 字段比对双红）；还原后 `8 passed (8)`。
- 生成闸：`UPDATE_JEV_OFF_GOLDEN=1` 于文件已存在时直接抛 `never overwrite`（模块级失败、golden 未动）。
- 数据集条数由脚本确认：`recall(40) · gate(24) · tag(30) · review(20)`。
- 边界门（按 §1.4 模板追加）：`tests/boundary/pi-free.test.ts`、`tests/web-hub/boundary.test.ts` 连同本包测试 `4 passed (69 tests)`。

## 遗留问题

1. **E0（主会话旁路）**：真跑 `PI_TOOLKIT_JEV_CONFORMANCE=1` 的 C-J7 真调/C-J8/C-J15 与 `jev-eval.mjs` 基线（填 `docs/dev/memory/eval/jev-baseline.md`）——脚本与数据已就绪，凭证在主会话。
2. C-J13 的 TUI 折叠展示（一行 `── mem U: … ──`）headless 不可验，属真机验收面；本文件只钉注册与内容链路。
3. `PI_API_ALLOWED_DIFF` 的 `tool-line:` 语义是「删掉声明行后须与 golden 相等」；J7 接线时若写入回显是「追加整行」可直接用，若是「内联片段」需回 root 扩 token 语法。
4. `jev-eval.mjs` 的 openrouter 线路未经实测（openrouter 兼容 System One 的结论来自 pi-ai 源码注释），E0 一并验证。
