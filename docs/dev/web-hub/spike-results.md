# W0 spike 真机实测结果（2026-09-25）

环境：pi v0.87.1（npm 全局，`/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent`），Node v22.22.1，
模型 `deepseek/deepseek-flash --thinking low`，TUI 经 tmux（`-x 220 -y 55`，cwd=`/tmp/webprobe-scratch`）。
探针：`/tmp/webhub-probe/probe.ts`（plan §1 原文 + 追加 `tool_execution_start` 监听以满足 K8 判据的相对顺序记录）。
日志：`/tmp/webhub-probe.log`（TUI）、`/tmp/webhub-probe-k7p.log`（`-p` 独立运行）、`/tmp/webhub-probe-k1.log`（沙盒 HOME）。
本次 spike 产生的 pi 会话文件（保留，供复核，均在 `~/.pi/agent/sessions/--tmp-webprobe-scratch--/`）：

- `2026-09-25T13-15-47-767Z_01a0d8b5-2eb6-7315-984b-e103373c5d5b.jsonl`（startup 原会话）
- `2026-09-25T13-16-24-173Z_01a0d8b5-bced-7315-984b-e10539c7f7f5.jsonl`（/new #1 + "hi" 轮 + /resume 目标）
- `2026-09-25T13-17-19-077Z_01a0d8b6-9364-7315-984b-e106c1916f2d.jsonl`（/new #2）
- `2026-09-25T13-17-47-866Z_01a0d8b7-03d9-7315-984b-e1095176fa51.jsonl`（/fork + K7/K8 主战场，含 compaction `9599fb40`）
- `2026-09-25T13-20-47-067Z_01a0d8b9-bfda-7153-8421-334194271646.jsonl`（K7 `-p` 运行）
- 沙盒 HOME 的 `-p hi` 会话（`/tmp/webhub-sb` 内，随沙盒一并删除，不影响结论）

---

## K1-git：`pi install git:` 形态下 hub 可被 pi 自带 jiti 运行

**命令**（网络可用，未触发回落）：

```sh
SB=/tmp/webhub-sb; mkdir -p $SB
HOME=$SB PI_CODING_AGENT_DIR=$SB/.pi/agent pi install git:github.com/Newbluecake/pi-toolkit
# → "Installed git:github.com/Newbluecake/pi-toolkit"（npm 装依赖 1s）
CL=/tmp/webhub-sb/.pi/agent/git/github.com/Newbluecake/pi-toolkit
ls $CL/node_modules/@sinclair/typebox   # 存在
node <pi>/node_modules/jiti/lib/jiti-cli.mjs $CL/src/__probe/probe-hub.ts
# probe-hub.ts: import {Type} from "@sinclair/typebox"; import "./dep.js"; import net from "node:net"
HOME=$SB PROBE_LOG=/tmp/webhub-probe-k1.log pi -e /tmp/webhub-probe/probe.ts -p hi   # 取 argv1
```

**判据对照**：

| 判据                                                                | 结果 | 证据                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ① `$CL/node_modules/@sinclair/typebox` 存在                         | ✅   | `ls` 列出 `typebox/`（git 安装确实装 deps）                                                                                                                                                                                                         |
| ② jiti-cli 跑 probe-hub.ts 输出 `ok function function`、exit 0、<3s | ✅   | `ok function function dep-ok`，exit 0，real 0m0.269s（还额外验证了相对 `./dep.js`→`dep.ts` 解析）                                                                                                                                                   |
| ③ argv1 realpath 能定位 pi 包并解析出 jiti-cli.mjs                  | ✅   | 手算：`realpath(argv1)=…/pi-coding-agent/dist/bundle/cli.js` → 向上命中 `…/pi-coding-agent/package.json` → `createRequire().resolve("jiti/package.json")` → `…/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs` exists:true（与 ② 所用同一文件） |

**结论**：K1-git 全通过。`git:` 安装形态下 hub 代码（TS + typebox + 相对 `.js` import + `node:*`）可被 pi 自带 jiti-cli 直接执行，D 包 `resolveJitiCli` 算法（realpath→向上找包→createRequire.resolve）真机成立。无需 `webHub.nodeLoader` 逃生口。

---

## K4：`/new` `/resume` `/fork` `/reload` 的 activate 时序与模块求值

**命令**：tmux 起 `pi -e /tmp/webhub-probe/probe.ts`（TUI），依次提交 `/new`、`/resume`（列表选中上一会话）、`/fork`、`/reload`；`jq -c . /tmp/webhub-probe.log`。
注意：本机 `reload.defer` 开启，裸 `/reload` 被 pi-toolkit 重写为 `/agent reload`（parked，且产生一条 222-token 的 followUp 轮，约 15s 内未自动 fire）；用 `/agent reload now` 强制执行后才观察到原生 reload。这是本机扩展的 confound，不影响下述时序结论（`now` 走的就是 pi 原生 reload 路径）。

**日志摘录**（jq 过滤，file 取 basename）：

```jsonl
{"ev":"activate","inst":"nvkkje","act":1,"argv1":"/home/bluecake/.nvm/versions/node/v22.22.1/bin/pi"}
{"ev":"session_start","reason":"startup","mode":"tui","file":"…13-15-47….jsonl"}
{"ev":"session_shutdown","reason":"new"}      {"ev":"activate","inst":"nvkkje","act":2}
{"ev":"session_start","reason":"new","file":"…13-16-24….jsonl"}
{"ev":"session_shutdown","reason":"resume"}   {"ev":"activate","inst":"nvkkje","act":4}
{"ev":"session_start","reason":"resume","file":"…13-16-24….jsonl"}   // resume 续写原文件，不新建
{"ev":"session_shutdown","reason":"fork"}     {"ev":"activate","inst":"nvkkje","act":5}
{"ev":"session_start","reason":"fork","file":"…13-17-47….jsonl"}     // fork 新建文件，entry id 原样复制（5ca08511 两文件同 id）
{"ev":"session_shutdown","reason":"reload"}   {"ev":"activate","inst":"7n83or","act":6}
{"ev":"session_start","reason":"reload","file":"…13-17-47….jsonl"}   // reload 后会话文件不变
```

**判据对照**（任一结果都可接受，只需写实）：

| 观察项                                                                         | 结果                                                                                                                              |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 每次替换序列均为 `session_shutdown(reason) → activate → session_start(reason)` | ✅ 四种 reason（new/resume/fork/reload）全部如此，中间无其他事件（除 /resume 选择器先弹 `ui_prompt_start{kind:"custom"}`，见 K8） |
| `/new` `/resume` `/fork` 模块是否重新求值                                      | **否**——`inst` 保持 `nvkkje`（读码预判"必然重求值"**不成立**；`/reload` 才清 jiti 缓存）                                          |
| `/reload` 模块重新求值                                                         | ✅ `inst` `nvkkje`→`7n83or`                                                                                                       |
| globalThis 跨激活存活                                                          | ✅ `act` 1→2→4→5→6 单调递增（跨 reload 也存活）                                                                                   |
| pid 不变                                                                       | ✅ 全程 3311778（同一进程）                                                                                                       |

**结论**：D 包「每次 `session_start` attach / `session_shutdown` detach、handler 每 activate 注册一次」的设计对实测成立且更简单——**连接可按进程内稳定标识复用**；仅 `/reload` 会换模块实例，但 globalThis 存活，hub 若把「会话句柄/订阅表」挂在 globalThis（Symbol.for 键）上可跨 reload 存活，否则 reload 后需重连重握手。K7 附带发现：`/resume`/`/fork` 后 jsonl 的 entry id 在副本中原样保留。

---

## K7：`message_end` 先于落盘；messageKey 两侧对齐

**命令**：`pi -e probe.ts -p "read /tmp/webhub-probe/probe.ts and summarize in 1 line"`（独立日志）；TUI 内 `/probe-custom`（`sendMessage({customType:"probe:custom"},{triggerTurn:false})`）；读 3 个大文件（~84k token）后 `/compact`；`node /tmp/k7-compare.mjs <jsonl> <log>` 逐条比对。

**日志摘录**（`-p` 运行）：

```jsonl
{"ev":"message_end","role":"system","ts":1790342449757,"leafIsThis":false,"leafId":"d998d67f","leafType":"custom"}
{"ev":"message_end","role":"user","ts":1790342449756,"leafIsThis":false,"leafId":"f95ef727","leafType":"message"}
{"ev":"message_end","role":"assistant","ts":1790342449770,"leafIsThis":false,"leafId":"ce41e651","leafType":"custom"}
{"ev":"message_end","role":"toolResult","ts":1790342450511,"leafIsThis":false,"leafId":"c687f8ed","leafType":"message"}
{"ev":"turn_end","entryId":"c687f8ed","leaf":"80384f15"}   // 工具轮：entryId=assistant(toolCall)，leaf=toolResult，不等！
{"ev":"turn_end","entryId":"b6d30a69","leaf":"b6d30a69"}   // 末轮：相等
{"ev":"session_compact","id":"9599fb40","leaf":"9599fb40"} // compaction 先落盘后发事件
```

**判据对照**：

| 判据                                                   | 结果                                                                                                                                                                                                                                                | 证据 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| ① 所有 `message_end` 均 `leafIsThis=false`             | ✅ 三个日志共 30+ 条 message_end（system/user/assistant/toolResult）无一例外；且事件时刻的 leaf 常是其他扩展刚追加的 `type:"custom"` 条目（见下）                                                                                                   |
| ② `turn_end.entryId == leaf`（可作落盘栅栏）           | ❌ **仅无工具轮成立**。工具轮中 `messageEntryId`=带 toolCall 的 assistant 条目，turn_end 时 leaf 已是 toolResult（`c687f8ed≠80384f15`）。entryId 本身已落盘（在 leaf 之前），可作「该条目已持久化」的栅栏，但**不能**当「已到 leaf/全部落盘」的栅栏 |
| ③ user/assistant/toolResult 两侧 `role:timestamp` 相等 | ✅ 各会话文件内 1:1 全匹配（system 也匹配）。注意事件只能与本会话文件比对：/fork 前旧分支的事件在新文件里查不到（fork 分支不含旧叶轮，属分支语义而非对齐失败）                                                                                      |
| ④ custom 消息 jsonl 是否带可对齐时间戳                 | ❌ 与读码预判一致，且更糟（见结论）                                                                                                                                                                                                                 | 见下 |

**custom 条目实测形态**（TUI 会话 jsonl，两种类型并存）：

```jsonl
{"type":"custom_message","customType":"probe:custom","content":"hello","display":true,"id":"a7842bcd","parentId":"3052599a","timestamp":"2026-09-25T13:21:25.409Z"}   // 对话可见自定义消息（sendMessage）
{"type":"custom","customType":"subagent:prompt-sections","data":{…},"id":"d998d67f","parentId":…,"timestamp":"…ISO…"}                                                // 扩展侧通道条目（appendCustomEntry），本会话 52 条 vs custom_message 3 条
```

两者都**没有** `message.timestamp`（顶层 `timestamp` 是条目级 ISO 落盘时刻）。源码佐证（0.87.1 `dist/core/session-manager.js` `appendCustomMessageEntry`）：持久化字段为 `{type,customType,content,display,details,id,parentId,timestamp:ISO}`——内存 appMessage 的 `timestamp:Date.now()` **不落盘**。
更关键的时序事实（`dist/core/agent-session.js:1524` `_appendCustomMessage`）：idle 时 `sendMessage(…,{triggerTurn:false})` **先 appendCustomMessageEntry 落盘，再只向应用总线 `_emit` message_start/message_end，不经 extension runner**——本机实测 `/probe-custom` 后探针的 message_end 零记录；只有经 agent 轮投递（steer/followUp/triggerTurn）的 custom 消息才走 `_emitAgentEvent`→extension `message_end`（先事件后落盘，且 `event.message.role==="custom"` 分支落盘）。

**结论**：A 包 `keys.ts` 必须双轨——普通消息 `role:timestamp(+toolCallId)` 可用（含 system）；custom 两类条目一律不能靠时间戳对齐，且**事件流根本看不见 idle 直发的 custom_message**（只能靠会话文件 watch / snapshot 刷新发现）。`custom:<customType>:<fnv1a(canonical content)>` 的备选规则从「备选」升级为「唯一可行」，且需同时覆盖 `custom`（content→data 字段名不同）与 `custom_message` 两型。compaction 与预判一致（先落盘后事件，`id==leaf`）。

---

## K8：TUI 下 ask_user 的 `custom()` 是否触发 `ui_prompt_start/end`

**命令**：TUI 内 `/probe-ui`（`ctx.ui.select` + `ctx.ui.custom`）；再发「请用 ask_user 工具问我一个单选题，选项 A/B」，TUI 作答 A。

**日志摘录**：

```jsonl
{"ev":"ui_prompt_start","kind":"select","title":"probe select"}   // probe-ui 的 select
{"ev":"ui_prompt_end","kind":"select"}                            // 我按 Enter 选了 a（1.5s 后）
{"ev":"ui_prompt_start","kind":"custom","title":undefined}        // ctx.ui.custom：有 start 无 title
{"ev":"ui_prompt_end","kind":"custom"}                            // 1.5s setTimeout done(null) 自动收尾
{"ev":"tool_execution_start","tool":"ask_user"}                   // 模型调 ask_user
{"ev":"ui_prompt_start","kind":"custom","title":undefined}        // ask_user=TUI custom()，无 title
{"ev":"ui_prompt_end","kind":"custom"}                            // 作答 A
{"ev":"message_end","role":"toolResult",…} → {"ev":"turn_end"} → {"ev":"message_end","role":"assistant"} → {"ev":"turn_end"}
```

（另：K4 阶段的 `/resume` 选择器本身也产生一对 `ui_prompt_start/end{kind:"custom",无title}`。）

**判据对照**：

| 判据                                                                                  | 结果                                                                                                                 |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ui_prompt_start{kind:"select",title}` / `{kind:"custom"}`（无 title）及配对 end 出现 | ✅ 四种来源全配对：probe select、probe custom、ask_user（custom）、resume 选择器（custom）                           |
| 与 `tool_execution_start` 的相对顺序                                                  | ✅ ask_user：`tool_execution_start` **先于** `ui_prompt_start`（可据此把 custom 横幅归因到正在执行的 ask_user 工具） |

**结论**：读码预判成立——ask_user 在 TUI 走 `custom()`，事件面只有 `kind:"custom"` 无 title 无语义载荷。P1 网页对 ask_user 显示 `blocked on dialog (custom)` 可行；**但 kind:"custom" 不专属 ask_user**（内置选择器如 /resume 列表也是 custom），P2 包 G 的 dialog_open 若要区分 ask_user 与普通选择器，需靠 `tool_execution_start{tool:"ask_user"}` 叠加判定，不能只看 ui_prompt kind。异步性（queueMicrotask）未观察到错序（start 均在配对 end 前，且未与其他事件交错错乱）。

---

## 对 plan 的修正建议

1. **§1 K4 行读码预判更正**：`/new` `/resume` `/fork` **不**重新求值扩展模块（inst 不变），仅 activate 重跑、globalThis 存活；只有 `/reload` 重求值。D 包连接管理可按「进程 + globalThis 存活」简化：hub 侧句柄挂 `Symbol.for` 全局可在 reload 后存活，agent-client 无需对 /new /resume /fork 重连（只随 session_start 换订阅的 sessionFile）。
2. **§1 K7 ② 更正**：`turn_end.messageEntryId` 在工具轮 ≠ leaf；它只能栅栏「该 assistant 条目已落盘」，不能当「追平 leaf」。B 包 mergeSnapshot 的对齐点应改为 `session_compact`（id==leaf 恒真）与逐条目确认，不要用 turn_end==leaf 判「文件已追平」。
3. **§1 K7 ④ 升级**：custom 对齐键 `custom:<customType>:<fnv1a(canonical)>` 从备选转正，且要覆盖两型条目（`custom_message` 用 content、`custom` 用 data）；同时 A/B 需明确「idle 直发 sendMessage 的 custom_message 不产生扩展事件」，快照合并必须含会话文件读取路径，不能纯事件驱动。
4. **K8 补充到 P2 包 G 前置**：`kind:"custom"` 无专属语义（ask_user、/resume 选择器同型），dialog_open 归因需叠加 `tool_execution_start{tool:"ask_user"}`；P1 横幅文案 `blocked on dialog (custom)` 维持即可。
5. **K1-git**：全通过，无修正；D 包 `resolveJitiCli` 按 plan 实现即可（真机已手算验证）。附带确认 git 安装形态依赖已装（typebox 在位）、jiti 相对 `.js`→`.ts` import 可解析。
6. **杂项**：本机 `reload.defer` 会把裸 `/reload` 变成 parked + followUp 轮（约 15s 内不自动 fire，需 `/agent reload now`）；I 包 e2e 若涉及 /reload 时序，需在设置里关掉 defer 或统一用 `/agent reload now`，否则时序断言会flaky。
