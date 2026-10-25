# 定时任务（schedule）非飞书部分真机验收报告

- 日期：2026-10-25 · pi 1.3.0 · 被测代码：**adebe2d6 快照**（`git archive` 导出到 /tmp/sched-live/toolkit，已随环境删除）
- 模型：deepseek/deepseek-flash（主会话与 background 任务），tmux 里跑真实 TUI。
- 范围：用例 1a（用例 1 的非飞书部分）、3、4、5、8、9、10、11、12、15、16、SC1。飞书相关的 1（卡片）、2、6、7、13、14 留给用户。

## 环境说明（重要：隔离泄漏）

- 起步用 `PI_CODING_AGENT_DIR=/tmp/sched-live/agent`。**插件自己的设置文件和 traffic.db 路径取 `homedir()/.pi/agent`，不跟 `PI_CODING_AGENT_DIR`**（`src/config/settings.ts:3434`、`src/traffic/db.ts`）。所以第一段（1a、5、3、SC1、4、11-pause）的被测 pi 实际读了真实 `~/.pi/agent/pi-subagent.json`：webHub、`fabric.crossSession`、feishuBot 都是开着的，会话已向真实 hub 注册（`~/.pi/agent/web-hub/hub.db*`、`hub.json` 有写入），另有 `bash-jobs/*`、`quota-state.json`、`feishu-notify.log` 被写。`~/.pi/agent/schedules/` 没有创建，调度账本都在隔离目录，所以该段取证仍有效。
- 发现后改用 `HOME=/tmp/sched-live/home` + `home/.pi/agent/pi-subagent.json`（schedule 开、webHub/feishu/xs 关、traffic 开）跑用例 8、9、10、12。traffic.db 落在隔离 home 下，真实库没被写（mtime 仍是 10/24）。
- 小窗口：`models.json` 里 `providers.deepseek.modelOverrides.deepseek-flash.contextWindow=36000`；`compaction.reserveTokens=19000`、`keepRecentTokens=2000`。
- 开 tmux 前确认过：`/schedule` 命令存在、状态栏 `sched …` 出现。
- 助手脚本：`/tmp/sched-live/t.sh`（send/slash/cap/wait）。注意 `slash` 会发两次 Enter，第二次会替 confirm 对话框点掉 Yes——对话框相关用例（3、/settings）改用单次 Enter。

## 用例矩阵

| #   | 结论                          | 证据 / 现象                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a  | 通过                          | `/schedule add bg1 --cron "*/2 * * * *"` 后状态栏 `sched 1 · next 20:36`。20:38 的触发被 0.3 s 轮询抓到 fleet 行 `✓ sched:bg1-2 general-purpose deepseek/deepseek-flash·low completed 757ms`；运行中另一任务出现 `sched:slow … 🔧`，状态栏 `sched 1 · next 20:44 · run 1`。会话里出现 `[subagent:schedule] [定时任务 bg1 …] PONG` quiet 消息，主会话 `rounds 0`（没有新开模型回合）。`/schedule log` 两条 `completed`，state.json 里 `state: completed`。 |
| 3   | 通过（网页部分未做）          | AI `create` 后状态栏 `sched 1 · pending 1`，任务未执行；`run_now` → `E_UNAPPROVED: refused …`；`resume` 返回 "PENDING USER APPROVAL"，没有批准。TUI `/schedule approve` 弹确认对话框；对话框停着时第二个进程（同 session-id）`/schedule edit … -- Reply CHANGED`，再确认 Yes ⇒ `Warning: E_REV: 审阅期间任务定义已变更，未批准；请重新审阅`，state.json 里该任务无 approval。网页审阅对话框、web 只收 hash 的路径没有测（无 hub）。                       |
| 4   | 通过（60 分钟上限未等）       | msg2：触发点 21:02 落在 4×50 s 的 bash 回合内，消息没有打断，回合以 FINISHED2 结束后才执行（窗格顺序：FINISHED2 → `[定时消息 msg2]` → SCHEDMSG2-OK），run `settled`。msg3（`sleep 60`）执行中输入 "hello…" ⇒ run `continued`（21:07:00→21:07:18）。msg1 的触发恰与回合结束重合，不算排队证据。60 分钟上限机制只由自动化覆盖，真机未等。                                                                                                                   |
| 5   | 通过（飞书推送不测）          | 后台任务 `sleep 150` 运行中 `/quit` ⇒ state.json `unknown / owner-closed`；重开同一会话 digest 出现 `任务「slow」（s_zh33hae7）2026-10-25 20:42 …结果未知（owner-closed）`，`/schedule log` 显示 `unknown(owner-closed) · run r_YSDAZ3NK`。                                                                                                                                                                                                               |
| 8   | 通过（有说明）                | traffic.db（隔离 home）：同一会话在建任务前后 system prompt 哈希一致（13926 字节 / dd5f9c5d55，三次请求）；`pi_schedules` 只出现在 messages 尾部，system 里没有。`/fork` 出的新会话 `/schedule` 报「本会话没有定时任务」（pi 的 /fork 是新的主会话，不是 E_CHILD）；Agent 子会话里没有 `schedule` 工具（回复 NO-SCHEDULE-TOOL）。**偏差见缺陷 D2、说明 N1。**                                                                                             |
| 9   | 部分（未复现 pre-start 路径） | 真实 pi 1.3.0 + deepseek 下，三次让上下文高于阈值（compaction 先关、`/settings` 里再开）再让 message 任务到点：压缩都发生在定时消息**之后** 2–5 s（session 条目顺序：assistant `SCHED9B-OK` 13:36:01 → compaction 13:36:05），定时消息恰执行一次、run `settled`、无 unknown。没有观察到 "pre-start compaction"。原因没查明（pi 的 `_prepareRun` 里确有压缩检查）。pre-start 路径目前只有 conformance C-S5 覆盖。                                          |
| 10  | 部分/前提未成立               | `/fork` 选择器、`/tree` 选择器按 Esc 后，message 任务到点**立即**执行（21:41、21:45 都没排队），`/agent status` 无 fence/uiPrompts 项——这两个 Esc 取消路径在 pi 1.3.0 里没有留下 fence。`/schedule repair` 本地可用：「本会话的账本正常，无需修复。调度器的栅栏窗口与对话计数已重置（仅本地）」。`/fabric fence reset` 因 xs 关闭而未注册（被当成普通文本发给模型）；web 拒绝 `/schedule repair` 未测。ask_user 竞态（需要 web）未做。                    |
| 11  | 部分                          | pause：排队中的 msg4 在 21:11:30 `/schedule pause` 后 state.json 为 `dropped / task-changed`，`/schedule log` 显示 `dropped(task-changed) · the task was paused, changed or deleted while queued; not sent`，之后消息没有发出。rm 变体：推进失败（忙回合被模型提前结束，消息在 rm 之前已入队执行），**不作结论**。handoff 形式和 `--all` 未测。                                                                                                           |
| 12  | 通过（孤儿 guard 未测）       | `schedule.enabled=false` 新会话：`/schedule` 被当作普通文本发给模型（命令不存在）；traffic.db 里 tools 21 个、没有 `schedule`，请求体不含 `pi_schedules`；状态栏无 `sched`；`agent/schedules/` 没有新增该会话目录。hub 无 `sched.v1` cap 无从验证（hub 关）。已有 trigger 到达时的 orphan guard 需要 `/reload` 时已排队的触发，没有构造。                                                                                                                 |
| 15  | 未覆盖                        | 依赖用例 9 的 pre-start compaction（压缩进行期间挂 `/new`）；真机里没有产生 pre-start 压缩，无法构造。                                                                                                                                                                                                                                                                                                                                                    |
| 16  | 未覆盖                        | 需要 webHub + `fabric.crossSession`，会连到用户真实 hub；且 9 的前提未成立。按任务说明标未覆盖。                                                                                                                                                                                                                                                                                                                                                          |
| SC1 | 通过（有说明）                | 同一 session-id 开两个 pi（pid 1957585 / 1967449），`* * * * *` background 任务，20:47–20:53 共 7 个整分钟：每个 occurrence 恰一条 run（runKey 无重复，`firedTotal 7, missedTotal 0`）。**两个进程都在 claim**：holder 在两个 pid 之间交替（1957585 跑了 20:47、20:51），不是"只有持有者进程 spawn"。杀掉 1957585 后 20:52、20:53 由 1967449 继续，没有双跑。                                                                                             |

## 缺陷 / 偏差清单

- **D1（低-中）TUI `/schedule approve` 确认对话框的正文显示 `undefined`**。复现 3 次：AI 建任务 → `/schedule approve <id>`（单次 Enter）→ 窗格 `批准定时任务 s_…？\nundefined\n→ Yes / No`。代码 `src/commands/schedule.ts:336` 传的是 `[...taskDetail(...)].join("\n")`，pi 的 `showExtensionConfirm` 拼 `${title}\n${message}`，所以 message 在到达前就是 undefined——审阅者看不到要批准的完整定义（`/schedule show` 可替代）。未查到是谁丢了参数。证据：本会话窗格抓取，隔离 home 与真实 home 两种环境都出现。
- **D2（低-中）`/fork` 出的新会话继承了父会话的 `pi_schedules` 段**：fork 里问模型，它逐字引用了 `## Scheduled tasks (pi-subagent) … This session owns the scheduled tasks below … t8`，而 fork 的 `/schedule` 为空。fork 的 session 文件里有父会话的 `subagent:prompt-sections`（`announced` 带父 sid）和一条 sid 重绑为 fork 自己的空快照，但已发出的 `prompt-section-update` 仍在历史里。清单期望"fork 出的子会话没有父会话的任务段"。证据：`/tmp/sched-live/agent/sessions/…_01a17337-…jsonl`（已删），问答原文如上。
- **D3（信息）SC1 双进程都 claim**：见 SC1 行；不违反"每个 occurrence 一条 run"，但与清单"spawn 只发生在持有者进程"的措辞不符。
- **D4（信息）用例 9/10 的前提未在真机复现**：见各行。
- **N1（说明）** schedule 开/关对比（同配置、新会话）system prompt 相差 434 字节：多了 `schedule` 工具条目和两条 guideline（工具注册带来的），没有任务摘要。开启后建任务前后字节不变。

## 未覆盖

1（飞书卡片/md 附件）、2、6、7、13、14（飞书/hub）；9 的 pre-start 路径、15、16；11 的 rm/handoff/`--all`；10 的 ask_user 竞态、`/fabric fence reset`、web 拒绝 repair；12 的孤儿 guard；4 的 60 分钟上限；3 的网页审阅。

## 隔离泄漏留下的真实目录（未清理，交给主会话）

`~/.pi/agent` 下 2026-10-25 20:30 之后被写的路径（不含 `sessions/`）：

- `web-hub/hub.db`、`hub.db-shm`、`hub.db-wal`、`hub.json`（被测会话注册到了真实 hub）
- `quota-state.json`、`feishu-notify.log`
- `bash-jobs/01a17312-0e52-…`、`01a17312-0e54-…`、`01a17312-0e56-…`、`01a17315-dbd4-…`、`01a1731a-5c49-…`、`01a1731b-7172-…`、`01a1731d-eb9b-…`、`01a1731d-eb9d-…`、`01a17321-3535-…`、`01a1732a-4df8-…`、`01a17338-677f-…`、`01a17341-2072-…`、`01a17349-6299-…`（均含 session-id，部分有 b_*.log/json）；`01a1730c-d2bc-…`、`01a16242-c16b-…` 是主会话/其他会话自己的
- `~/.pi/agent/schedules/` 不存在；`pi-subagent-schedules.json` mtime 仍是 10/24 19:09（验收前就有）；`records/traffic.db` mtime 10/24。

## 修复

- **D1 已修**：`src/commands/capture.ts` observed（TUI 旁路）ui 包装的 `editor/select/input/confirm` 改为 `(...args)` 记录 title 后用 `Reflect.apply(target.x, target, args)` 原样透传全部参数（confirm 的 message、select 的 options、input 的 placeholder、各自的 opts）；记录内容不变（仍只有 title + 方法名，editor 预填/input 值/message 都不落盘，测试断言记录里不含这些字符串）。claimed（web）模式的桩本就不弹真实 UI（返回 undefined/false），按单参数 `async (title)` 定义，多余实参被忽略、无副作用，保持不变。测试（`tests/web-hub/agent/command-capture-recorder.test.ts`）：「contract 1b」逐个断言四个方法的参数（含 opts.signal 同一对象）到达底层 ui；「D1 regression」经 `wrapCommandApi` observed 路径跑真实 `/schedule approve`，断言底层 `confirm` 收到的 message 是含完整定义的字符串。
- **D2 已修**：fork/复制出的会话，其分支历史里带着父会话已发出的 `prompt-section-update` 消息。`readBackSectionStates` 现在额外返回 `foreignAnnounced`（scoped 段、sid 属于别的会话、且其持久化条目里有已宣告的 update/pointer）；`createPromptSectionHub` 把它们记入 `retractForeign`，该段在本会话拿到自己的快照后，下一个 stable 回合补发**一条**尾部更新：本会话无任务 ⇒ `removed`（「…introduced by an earlier update… no longer applies; ignore that update」），有自己的任务 ⇒ 用本会话的块 `update` 覆盖。systemPrompt 字节不变（仍是 fork 自己的 head），同会话 resume、父会话未发过 update 的 fork、无 scoped 段的会话均不受影响（hub/store 既有测试与 off golden 不变）。测试：`tests/prompt-sections/session-scoped.test.ts` 新增 5 条（fork 无任务→一次 removed 且之后静默、fork 有自己任务→替换、无需撤回的场景、同会话 resume 不撤回、`foreignAnnounced` 仅对他会话 sid 报告）。注意：撤回文案用通用的 removed 声明，不是专用的「本会话没有定时任务」措辞。
- **D3 已修（文档）**：`acceptance.md` SC1 的期望改为与实现一致——每个 occurrence 由在 writer 锁内 claim 成功的进程执行，两个进程都可能成为执行者，同一 occurrence 恰一条 run、不双跑。已核对 `src/schedule/core/claim.ts` 与 plan（§4.5a 锁内 claim；R2「claim/digest/note 都有锁内领取，保证只执行一次」）：设计即如此，`holder` 是 run 记录的执行进程而非锁的独占持有者。
