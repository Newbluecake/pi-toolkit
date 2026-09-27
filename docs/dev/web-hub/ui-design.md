# web-hub 浏览器界面 — 视觉与交互设计（todo #26 设计阶段）

> 状态：设计稿，待用户拍板（见 §17）。本文只描述**设计**；实现（Vue SFC + Vite，产物不进 git）另起施工计划。
> 样稿：`docs/dev/web-hub/ui-mockups/`（纯 HTML + CSS，无 JS、无外部资源）；截图：`ui-mockups/screenshots/`。
> 设计系统原始输出（已被本文覆盖）：`design-system/pi-web-hub/MASTER.md`。

## 0. 一句话方向

**「清爽的薄荷白实验台」**：冷调近白底 + 一抹青绿（teal）主色，系统字体、细边框代替重阴影，信息密度按仪表盘调高，动效只用来表达「正在发生」（运行光晕、流式光标、工具进度条）。浅色默认，暗色跟随系统；手机是一等公民，不是桌面缩小版。

## 1. 现状评估（2026-09-27 只读截图，用户已登录的 LAN 会话）

- 纯暗色、单一字号，卡片信息靠 `·` 串成一行，状态只有文字徽章（`busy`/`stale`），层级几乎为零——就是「古朴」的来源。
- 子 agent 树是等宽文本行（`↳ • label phase · model · 42s · $0.12`），没有展开/折叠，没有阶段图标。
- 对话流是同一种灰框，用户/助手/工具只靠小号大写 role 区分；工具卡是 `<details>` + 单字符标记（`▸ ✓ ✗`）。
- 横幅是整行裸文字（黄底 + 等宽字体），醒目但刺眼；明文 HTTP 提示只在登录页。
- 没有任何移动端适配（固定 300px 侧栏，窄屏直接横向挤压）。

## 2. 设计原则

1. **状态先于内容**：一眼看清「谁在跑、跑到哪、花了多少、卡没卡住」。状态用「颜色 + 图标 + 文字」三重编码，从不只靠颜色。
2. **清新但不轻浮**：大面积中性色，主色只出现在交互与「活着」的信号上；细边框 + 1px 阴影，不用渐变/毛玻璃（唯一例外：品牌标与登录页背景的极淡径向晕染）。
3. **移动优先、触控优先**：先设计 375px 单栏，再向平板、桌面扩展；所有可点元素 ≥44×44，任何信息都能点按获得，不依赖 hover。
4. **只读且安全**：界面永远不渲染任意 HTML；危险/风险提示醒目但克制（柔和底色 + 深色文字 + 图标），长期存在的提示可折叠为一行但不可关闭。
5. **实时而不吵**：流式与工具输出节流渲染，屏幕阅读器只播报「有意义的状态变化」，动效全部尊重 `prefers-reduced-motion`。

## 3. 设计 Token

权威定义：`ui-mockups/tokens.css`（Vue 实现直接搬过去）。暗色两条生效路径：`@media (prefers-color-scheme: dark)`（`<html>` 无 `.theme-light` 时）或 `<html class="theme-dark">` 强制；样稿额外支持 `#mock-dark` 复选框（`:root:has(#mock-dark:checked)`，无 JS）。

### 3.1 颜色

| Token                             | 浅色（默认）                                      | 暗色                              | 用途                               |
| --------------------------------- | ------------------------------------------------- | --------------------------------- | ---------------------------------- |
| `--c-bg`                          | `#F4F7F7`                                         | `#0D1417`                         | 画布（冷调、微带薄荷）             |
| `--c-surface`                     | `#FFFFFF`                                         | `#141C20`                         | 面板/卡片                          |
| `--c-surface-2`                   | `#F8FAFA`                                         | `#192328`                         | hover / 次级抬升                   |
| `--c-sunken`                      | `#EEF3F3`                                         | `#10171A`                         | 代码、输入框、meter 轨道           |
| `--c-border` / `-strong`          | `#E1E8E9` / `#C9D4D6`                             | `#243037` / `#33424A`             | 分隔线 / 控件边框                  |
| `--c-text`                        | `#132026`（16.6:1）                               | `#E4ECEE`（14.4:1）               | 正文                               |
| `--c-text-2`                      | `#3B4A52`（9.2:1）                                | `#B6C3C8`（9.6:1）                | 次要文字                           |
| `--c-text-3`                      | `#5A6A72`（5.6:1）                                | `#8D9DA4`（6.2:1）                | 元信息；**可读文字的最低一级**     |
| `--c-primary`                     | `#0B7A70`（5.2:1）                                | `#3CCBB9`（8.6:1）                | 主色：链接、主按钮、选中、运行     |
| `--c-primary-soft`                | `#E3F4F1`                                         | `#12302D`                         | 选中卡片、助手头像底、用户气泡近似 |
| `--c-on-primary`                  | `#FFFFFF`（5.2:1）                                | `#062522`（8.1:1）                | 主按钮文字                         |
| `--c-accent`                      | `#7046D8`                                         | `#A98BF5`                         | 次强调（thinking）                 |
| `--c-user-bubble`                 | `#E6F4F1`                                         | `#153330`                         | 用户气泡                           |
| `--c-success`                     | `#177A3E`                                         | `#4CC77E`                         | 成功                               |
| `--c-warning` / `-text` / `-soft` | `#9A5A06` / `#7A4604`（7.3:1 on soft）/ `#FFF7E8` | `#E5A93D` / `#F0C77A` / `#2A2112` | 警告（横幅用 `-text` 保证可读）    |
| `--c-danger` / `-soft`            | `#C0262D` / `#FDEEEE`                             | `#F2767A` / `#2E1719`             | 错误                               |
| `--c-info` / `-soft`              | `#1F5FC4` / `#E8F0FC`                             | `#72A7F5` / `#16243A`             | 信息                               |
| `--c-focus`                       | `#1F8F84`                                         | `#5FD8C8`                         | 焦点环                             |

对比度用脚本逐对验证（WCAG 相对亮度公式）：所有「文字 / 其底色」组合 ≥4.5:1，含状态色文字压在各自 `-soft` 底上（最低 `#0B7A70` on `#E3F4F1` = 4.58）。

### 3.2 agent / 子 agent 状态色

同一套 token 同时服务 agent 卡片、状态 pill、子 agent 行图标、工具卡。每个状态 = `--st-X`（前景）+ `--st-X-soft`（底），外加固定图标，**不靠颜色单独表意**。

| 状态                             | 浅色 fg / soft         | 暗色 fg / soft        | 图标/形态                            | 来源字段                                        |
| -------------------------------- | ---------------------- | --------------------- | ------------------------------------ | ----------------------------------------------- |
| running（agent busy / 运行）     | `#0B7A70` / `#E3F4F1`  | `#3CCBB9` / `#12302D` | 实心点 + 呼吸光晕；子 agent 为转圈弧 | `status.busy`；`FleetRowWire.status=running`    |
| thinking                         | `#7046D8` / `#F0EBFD`  | `#A98BF5` / `#231C3A` | sparkle                              | `phaseLabel`（model_turn）/ 流式 thinking 块    |
| tool                             | `#1F5FC4` / `#E8F0FC`  | `#72A7F5` / `#16243A` | wrench；工具卡顶部 2px 进度条        | `phaseLabel`（tool_exec）/ `tool_execution_*`   |
| idle / queued                    | `#5A6A72` / `#EDF1F2`  | `#8D9DA4` / `#1B2428` | 空心点；queued 用 clock              | `busy=false`；`status=queued`                   |
| done                             | `#177A3E` / `#E6F4EA`  | `#4CC77E` / `#13291C` | check；整行降为 text-3               | `terminal && status=completed`                  |
| failed / timed_out               | `#C0262D` / `#FDEEEE`  | `#F2767A` / `#2E1719` | x；行左 2px 红线                     | `status∈{failed,timed_out}` 或 `highlight=crit` |
| waiting（被 dialog 阻塞）/ stale | `#8F6412` / `#FBF3E2`  | `#D6A84E` / `#2A2112` | message（dialog）/ 虚线点（stale）   | `prompts[]` 非空；`card.state=stale`            |
| offline（down）                  | `#5E6B73` / `#EDF0F1`  | `#7D8B92` / `#1A2125` | unplug；空心点，卡片 72% 不透明度    | `agent_down`                                    |
| aborted                          | 同 idle                | 同 idle               | ban                                  | `status=aborted`                                |
| 行级 `highlight=warn`            | warning 左线 + soft 底 | 同左                  | —                                    | 看门狗子阶段超时预警                            |

### 3.3 字体

系统字体栈（**禁止任何 webfont**；设计系统推荐的 Cinzel/Josefin/JetBrains Mono Google Fonts 全部作废）：

```css
--font-sans:
  system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC",
  "Source Han Sans SC", Roboto, "Helvetica Neue", Arial, sans-serif;
--font-mono:
  ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono",
  "Noto Sans Mono CJK SC", monospace; /* JetBrains Mono 仅在本机已装时命中，不下载 */
```

字号阶梯（px）：`11`（仅 chip/徽章，600 字重）· `12` 元信息 · `13` 密集 UI/代码 · `14` 桌面正文 · `16` 手机正文、表单输入（≥16 防 iOS 聚焦缩放）、区块标题 · `18` 详情标题 · `22` 登录标题。
行高：`1.25` 标题 / `1.4` 紧凑块 / `1.55` 正文 / `1.5` 代码。字重只用 400/500/600。数字列一律 `font-variant-numeric: tabular-nums`（花费、时长、百分比）。

### 3.4 间距 / 圆角 / 阴影

- 4/8 栅格：`4 8 12 16 20 24 32 48`（`--sp-1…--sp-12`）。仪表盘密度：卡片内边距 10–12，区块间 16–24。
- 圆角：`4` 行内代码/meter · `6` 按钮/输入/chip · `10` 卡片/工具卡 · `14` 气泡/登录卡 · `999` pill。
- 阴影（浅色）：`--shadow-1` 1px 细影（工具卡）、`--shadow-2` 浮起、`--shadow-3` 弹层/登录卡；暗色阴影基本关闭，靠边框分层。

### 3.5 动效

| Token                 | 值                         | 用途                   |
| --------------------- | -------------------------- | ---------------------- |
| `--dur-fast`          | 120ms                      | hover / press 颜色     |
| `--dur-base`          | 180ms                      | 折叠箭头旋转、开关     |
| `--dur-slow`          | 240ms                      | （预留）移动端视图切换 |
| `--ease-out`          | `cubic-bezier(.2,.7,.2,1)` | 进入                   |
| `--pulse` / `--blink` | 1.6s / 1.05s               | 运行光晕 / 流式光标    |

只动 `transform` / `opacity`（骨架屏 shimmer 例外，见 §16）。**reduced-motion**：所有时长归零；光晕、转圈、骨架 shimmer、工具进度条停止，改为静态终态（光晕固定 1.15 倍淡环、进度条满宽半透明、光标常亮 70%）。

### 3.6 断点（CSS 变量不能用于 `@media`，这里是约定值）

| 名称 | 范围       | 布局                                                                  |
| ---- | ---------- | --------------------------------------------------------------------- |
| 手机 | ≤480px     | 单栏；列表 ⇄ 详情导航；子 agent 行两行式；正文 16px；无头像           |
| 平板 | 481–1024px | 仍是列表 ⇄ 详情单栏导航，但列表为 2 列卡片网格、详情头部指标右置      |
| 桌面 | >1024px    | 左侧 agent 列表（288px，≥1280 时 340px）+ 右侧详情常驻；子 agent 单行 |

另有 `@media (pointer: coarse)`：任何宽度下只要是触控主指针，按钮/摘要行/输入框最小 44px。

## 4. 需要展示的数据与状态（来自现有代码）

| 来源                               | 字段 / 状态                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AgentCard`（`agents`/`agent_up`） | `agentKey`、`kind`（tui/rpc）、`pid`、`cwd`、`state`（live/stale）、`pluginVersion`、`outdated`、`prompts[]`（kind/title/since）                                                                                         |
| `SessionInfo`（`session`）         | `sessionId`、`name`、`cwd`、`model{provider,id}`、`thinkingLevel`、`mode`、`sessionFile`、`leafId`                                                                                                                       |
| `StatusInfo`（`status`）           | `busy`、`pending`、`contextUsage{tokens,contextWindow,percent}`、`costUsd`、`subagentCostUsd`                                                                                                                            |
| `agent_down`                       | `down` + `downReason`                                                                                                                                                                                                    |
| `FleetRowWire`（`fleet`）          | `runId`、`parentRunId`、`label`、`type`、`model`、`status`、`phaseLabel`、`elapsedMs`、`phaseMs`、`costUsd`、`toolTrail`、`streamLine`、`highlight`（none/warn/crit）、`terminal`                                        |
| transcript `Item.kind`             | `message`（role：user / assistant / toolResult / custom / 其它）、`custom`（customType）、`compaction`、`branch_summary`、`model_change`；`truncated`                                                                    |
| assistant 内容块                   | `text`（安全 markdown）、`thinking`、`toolCall{id,name,arguments}`、`image`（仅占位）、`usage.cost.total`、`model`、`stopReason=error` + `errorMessage`                                                                  |
| 流式 / 工具                        | `streaming`（进行中的助手消息）、`LiveTool{toolName,args,partial,result,isError,done,truncated}`、`ToolView.state`（pending/running/done/error）                                                                         |
| history                            | `history`（none/waiting/loaded/error）、`historyError`、`hasMore`、`paging`、`oldestEntryId`、`needsResync`                                                                                                              |
| 全局                               | `conn`（connecting/open/reconnecting/auth）、`hub.version`、auth 模式（`data-auth-mode`：password(LAN)/token/错误）、登录错误（E_AUTH/限速倒计时/saturated/E_DB/网络）、初始密码横幅、明文 HTTP 提示、Sign out（仅 LAN） |

## 5. 信息架构与布局（桌面 >1024）

```
┌ topbar 48 ─ [π pi web-hub] (●Live) hub v0.2.1 [👁 Read-only] ········ [user] [Sign Out] ┐
├ notices（全局横幅，可 0–2 条）──────────────────────────────────────────────────────────┤
├ sidebar 288/340 ─────────┬ detail ──────────────────────────────────────────────────────┤
│ AGENTS 6   [filter…]     │ head: 标题 [Working]            CONTEXT ▬▬▬▬ 62% 124k/200k   │
│ ┌card(selected)───────┐  │       📁 ~/ai/pi-toolkit  ⚙ model · high  # 01a0d892  ›  COST │
│ │● ai/pi-toolkit TUI $│  │ (dialog/offline/stale 详情级横幅)                            │
│ │  session name       │  ├ ▾ Subagents (● 4 running) 8 total · $5.61 ─────────────────┤
│ │  model ▬▬ 62% ⑂4    │  │  ▾ ✦ Plan-vue-rewrite [Plan]  Thinking …   model 6m02s $2.31│
│ │  [Working]          │  │     └ ✓ consult → main …                                    │
│ └─────────────────────┘  │  ▾ 🔧 ui-design … └ ⏱ verifier-ui Queued …                  │
│ STALE & OFFLINE          │  (树区最大 30vh，内部滚动)                                   │
│ …                        ├ transcript（居中，max 880）─────────────────────────────────┤
│                          │           [↑ Load Older Messages]                            │
│                          │   ── ≡ Context compacted · 09:12 ──（点开看摘要）            │
│                          │                              ┌ 用户气泡（右，teal 淡底）┐    │
│                          │ π pi  ✦Thinking·18 lines ›   model · 10:39              │    │
│                          │   markdown…  [✓ read src/…  664 lines ›]                    │
│                          │   [✓ bash npm run typecheck … exit 0 ▾ Input/Output]        │
│                          │   ── ⇄ Model → provider/id ──                               │
│                          │   ┆subagent:notice┆（虚线卡）                                │
│                          │   [● bash deveye … 12s]（进度条 + Live output）+ 文字▌       │
├──────────────────────────┴ dock: 👁 Read-only · reply from the terminal   (◯ Follow) [↓ Latest 3 new] ┤
```

### 5.1 agent 卡片（`AgentCard.vue`）

- 行 1：状态点 · 标题（`shortCwd(cwd)`，单行省略）· kind chip（TUI/RPC）· 右侧总花费（own + sub，等宽数字）。
- 行 2：会话名；无名时显示 sessionId 前 8 位（等宽）；再无则 `(no session name)`。
- 行 3：模型短名（去 provider）· 上下文 meter（56px，<70% 主色、70–85% 警告、>85% 危险）+ 百分比 · `⑂ N running`（有子 agent 运行时）。
- 行 4：状态 pill，只在「非 idle」时出现：Working / Waiting on dialog / Stale · no heartbeat 3m / Offline · process exited / Plugin newer than hub。
- 分组：`live` 在上；`stale` + `down` 归入「Stale & offline」分组并降低不透明度（标题与元信息 72%，pill 保持全色以便读清原因）。
- 选中：teal 淡底 + 左侧 3px 圆头竖条 + `aria-current="page"`。
- 卡片是 `<a href="#/agent/<key>">`（导航语义，可新标签打开、可后退）。

### 5.2 详情头部（`DetailHeader.vue`）

- 标题行：返回（仅 ≤1024）· 会话名（手机两行截断、桌面一行）· 状态 pill。
- 会话信息行（`<details>` 可点开）：`cwd` 短形 · `model · thinkingLevel` · sessionId 前 8 位 · `›`。点开是 `dl` 全量值（cwd、完整 sessionId、model、pid/plugin），每个可复制值旁一个 44px 复制按钮。**无 hover tooltip**。
- 指标：Context（meter + % + `tokens / window`）、Cost（总额 + `sub $x`）。桌面在右侧两列，手机为头部下方一条浅底指标带。

### 5.3 子 agent 树（`FleetPanel.vue` / `FleetNode.vue`）

- 数据：继续用 `fleetTree(rows)`（纯函数、已测）得到 `{row, depth}`，Vue 侧再折成嵌套结构递归渲染；环/孤儿规则不变。
- 面板头：`▾ Subagents` + `● N running` pill + `M total · $sum`；整个面板可折叠，折叠态仍显示这一行汇总（实时更新）。
- 行（桌面单行）：`[▸] [阶段图标] label [type chip] | 活动（phase 词 + streamLine/toolTrail，等宽省略）| model · elapsed · cost`。
- 行（≤1024 两行）：第一行 `图标 label chip ··· elapsed cost`，第二行活动文字。
- 有子节点的行可折叠（默认展开；深度 ≥3 默认折叠）；嵌套用左侧 1px 引导线缩进（桌面 21+12px，手机 10+8px，最多视觉缩进 4 级，更深的平铺并在 label 前加 `↳`）。
- 实时进度：`elapsedMs` 在两次 `fleet` 帧之间本地每秒递增（仅非 terminal 行；帧到达即校正）；`phaseMs` 超阈值由 hub 侧 `highlight` 决定，UI 只负责 warn/crit 样式。**没有**百分比进度条（线上没有总预算字段，伪造进度比不显示更糟）。
- terminal 行降灰；超过 3 条已完成时折叠为「Show N Finished Runs」按钮。
- 树区高度：桌面 ≤30vh、手机 ≤34dvh，内部滚动，永不把对话挤出屏幕。

### 5.4 对话流（`Transcript.vue` 及子项）

| 条目                        | 呈现                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| user                        | 右对齐气泡，teal 极淡底，`pre-wrap` 纯文本；下方时间                                                                                                                                                     |
| assistant                   | 左侧 28px「π」头像（手机隐藏）+ 头行（pi · model · 时间）+ 内容块序列 + 尾行（花费 · tokens）                                                                                                            |
| thinking                    | 紫色小 pill「✦ Thinking · N lines ›」，默认折叠；展开为左 2px 紫线的次级文字块（max 320px 内滚）                                                                                                         |
| text                        | 安全 markdown（段落/列表/标题/行内代码/围栏代码/http(s) 链接）                                                                                                                                           |
| 代码块                      | 卡片：头部语言标签 + 复制按钮；`pre` 横向滚动**在块内**，max 420px 纵向内滚                                                                                                                              |
| toolCall + toolResult       | 工具卡：`[状态图标] name  args 摘要（等宽省略） 结果摘要（行数/exit/error） ›`；展开为 Input（JSON）/ Live output / Output 分区，各自 max 280px 内滚；错误态输出红淡底；截断显示 `truncated 64 KiB` chip |
| 运行中的工具                | 卡片顶 2px 不定进度条 + 转圈图标 + 计时；默认展开显示 partial（只保留尾部 200 行，见 §6.5）                                                                                                              |
| 孤儿 toolResult / live tool | 单独工具卡（无父助手消息）                                                                                                                                                                               |
| custom                      | 虚线卡，头部 `customType`（等宽）                                                                                                                                                                        |
| compaction / branch_summary | 居中分隔线 pill「≡ Context compacted · 时间」，点开看摘要（虚线框）                                                                                                                                      |
| model_change                | 居中分隔线 pill「⇄ Model → provider/id」                                                                                                                                                                 |
| image                       | `[image]` 占位（img-src 仅 self/data，不内联远程图）                                                                                                                                                     |
| assistant error             | 红淡底错误条（`stopReason=error`）                                                                                                                                                                       |
| 流式                        | 头像转为实心 teal、头行 pill「● Streaming…」、文字末尾 8px 闪烁块光标；`aria-busy="true"`                                                                                                                |

- 历史分页：顶部「↑ Load Older Messages」按钮（滚动到距顶 `PAGE_TRIGGER_PX` 内也自动触发），加载中变为分隔线 pill「⟳ Loading older messages…」；前插后保持滚动锚点（沿用 app.js 的 prevTop 补偿逻辑）。
- 跟随：底部 dock 的 **Follow** 开关（`role="switch"`）。开启时新内容自动滚到底；用户向上滚动超过 64px 自动关闭跟随并出现「↓ Latest · N new」主按钮；点它回到底部并重新开启跟随。

## 6. 移动端（一等公民）

### 6.1 断点与布局

- **移动优先**：`app.css` 的基础样式就是 ≤480 手机版；`@media (min-width: 481px)` 叠加平板、`@media (min-width: 1025px)` 叠加桌面分栏。
- 375px 宽度下**无横向滚动**：已用无头浏览器在 375×812 逐页测 `documentElement.scrollWidth === 375`（列表/详情/登录，浅/暗）。要点：所有网格容器显式 `grid-template-columns: minmax(0, 1fr)`（否则 `nowrap` 子元素会把隐式列撑到 max-content——样稿首轮就踩了这个坑）、flex 子项 `min-width: 0`。
- 平板 481–1024：仍用列表 ⇄ 详情导航（避免 481–767 分栏时详情只剩 200px），列表改为 `auto-fill minmax(300px,1fr)` 卡片网格，详情恢复头像、单行指标。

### 6.2 导航：列表 → 详情

- 单栏两视图：`#/`（列表）与 `#/agent/<encodeURIComponent(agentKey)>`（详情）。**URL hash 即状态**：可深链、可收藏、刷新可恢复；agentKey 不存在时详情显示「This agent is not connected」空态 + 返回列表。
- 进入详情用 `history.pushState`（点卡片是真实 `<a href>`），因此浏览器后退键、iOS 边缘右滑、Android 返回手势全部天然可用；详情顶部返回按钮 = `history.back()`（若是深链直达、无历史，则 `replace('#/')`）。
- 不做自定义水平滑动手势（避免与系统返回手势冲突）。
- 样稿用 `:target`（`#detail`）无 JS 演示同一行为：`.app:has(#detail:target)` 隐藏列表、显示详情，后退即回列表。
- 视图切换保留列表滚动位置（Vue 侧 KeepAlive 或手动记录 scrollTop）。

### 6.3 触控

- 所有可点元素命中区 ≥44×44：按钮、agent 卡片（≥64 高）、树行（≥44）、工具卡头、thinking 摘要、会话信息行、横幅摘要、搜索框、复制按钮、返回按钮、dock 开关（整个 label 为命中区）。相邻命中区间距 ≥8px（卡片间 4px margin + 卡片内 padding 使可视间距 ≥8；按钮组 `gap: 8px`）。
- `@media (pointer: coarse)` 在任何宽度下兜底放大到 44px（大屏触控笔记本/平板横屏）。
- `touch-action: manipulation` 去掉双击缩放延迟但保留双指缩放；`-webkit-tap-highlight-color: transparent` 配合显式 `:active` 反馈（按钮下沉 1px、卡片变 `--c-sunken`）。
- **不依赖 hover**：所有 `title=` tooltip 取消；完整 cwd / sessionId / 模型全名在「会话信息」展开区；截断的工具参数在工具卡展开区；hover 只作为桌面上的附加视觉反馈。

### 6.4 长内容

- 代码块、工具 Input/Output、thinking：`overflow: auto` 在**块内**横向滚动，页面本身不滚；`overscroll-behavior: contain` 防止滚动链带动整页。
- 长路径/sessionId/模型：单行 `text-overflow: ellipsis`，点「会话信息」展开看全量 + 复制；复制按钮在非安全上下文（明文 HTTP LAN 下 `navigator.clipboard` 不可用）回退为「选中该值」（`user-select: all` + `Range` 选区）并 toast「Selected — press Copy」。
- 子 agent 树窄屏：行变两行式（名字/数字一行、活动一行），引导线缩进收窄，深层自动折叠；树区上限 34dvh 内滚。**手机默认折叠整个面板**，只显示汇总行（`● 4 running · 8 total · $5.61`），点开展开（样稿截图为展开态以便评审）。
- 用户消息 `overflow-wrap: anywhere`，超长无空格 token 也不撑破气泡。

### 6.5 视口 / 安全区 / 高度

- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`——**不写** `maximum-scale` / `user-scalable=no`。
- 应用壳 `height: 100vh; height: 100dvh;`（后者跟随地址栏伸缩）；内部各滚动区用 flex + `min-height: 0`，不依赖 JS 测量。
- 安全区：topbar `padding-top/left/right: env(safe-area-inset-*)`，dock `padding-bottom: max(4px, env(safe-area-inset-bottom))`，登录页底部同理。
- 底部 dock（Read-only 说明 / Follow 开关 / Latest 按钮）**在文档流内**（详情 flex 列的最后一项），不是 `position: fixed` 覆盖层，因此永远不遮挡对话内容与焦点元素。
- 移动端正文 16px、输入框 16px（防止 iOS 聚焦自动放大）。

### 6.6 性能（手机为基准）

- 首屏只渲染最近 **N = 80** 条（≤480）/ 200 条（其它），更早的通过「Load Older」分页（hub 单页上限 `HISTORY_LIMIT_MAX = 400`）。
- DOM 上限：transcript 超过 300 个条目时卸载最旧的一段，顶部换成「N earlier messages hidden · Show」占位（点击重新挂载），而不是无限增长。
- 已完成条目加 `content-visibility: auto; contain-intrinsic-size: auto 120px`（样稿 `.tx-item`），离屏跳过布局/绘制。
- 已定稿条目按 `itemRenderKey` 缓存（沿用 `transcript.js` 思路；Vue 中为 `v-memo="[renderKey]"` 或拆成 props 不变的子组件）。
- 流式节流：`message_update` / `tool_execution_update` 先进 reducer，渲染用 `requestAnimationFrame` 合批；手机上最多 10 次/秒（≥100ms 间隔），markdown 只重解析正在流式的尾部消息；工具 partial 只保留最后 200 行/16 KiB 展示（全量仍在 state，展开「Show full output」时再渲染）。
- `document.hidden` 时暂停 DOM 渲染（reducer 继续跑，回到前台一次性渲染），省电也避免后台标签堆积。
- 本地计时（elapsed）用一个共享的 1s ticker，只驱动可见的运行中行。

### 6.7 横幅与登录页在手机上

- 横幅（改初始密码、明文 HTTP）默认**最多两行**（`line-clamp: 2`），末尾 `›` 点开读全文；不可关闭（安全提示必须持续存在），但只占约 44–60px 高度。
- 登录页：卡片 `width: min(400px, 100%)`，手机上左右 20px 内边距；明文 HTTP 提示是卡片内一行两行的盒子（点开看完整说明与建议），表单首屏完整可见（375×812 下卡片约 500px 高，登录按钮在首屏内）。
- 登录输入 44px 高、16px 字、`autocapitalize="none"`、`spellcheck="false"`、密码框带 44px「显示密码」按钮（`aria-pressed`）。

### 6.8 移动端截图

| 文件                                                            | 内容                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------- |
| `screenshots/mobile-list-light.png` / `-dark`                   | 375×812 agent 列表（含 waiting/idle/stale/offline）   |
| `screenshots/mobile-detail-light.png` / `-dark`                 | 375×812 详情：头部 + 子 agent 树（展开）+ 对话 + dock |
| `screenshots/mobile-login-light.png` / `-dark`                  | 375×812 登录（明文 HTTP 提示）                        |
| `screenshots/dashboard-mobile-light.png`                        | 同 mobile-list-light（兼容原任务命名）                |
| `screenshots/tablet-list-light.png` / `tablet-detail-light.png` | 820×1180 平板                                         |

## 7. 顶栏与连接状态

- 顶栏：品牌（π 渐变小方块 + `pi web-hub`）· 连接 pill · hub 版本（≥481）· `Read-only` chip（≥481）· 右侧用户名（≥481）+ Sign Out（手机只显示图标，`aria-label`）。Sign Out 仅 LAN 模式渲染。
- 连接 pill：`● Live`（绿，带光晕）/ `⟳ Connecting…`（灰）/ `● Reconnecting…`（琥珀）/ `🔓 Signed out`（红，auth）。
- 断线重连：顶栏下插入琥珀横幅「Connection lost. Retrying in 4s — showing data from 10:42:18.」+ `Retry Now`；数据保持可读（不遮罩、不清空），恢复后横幅消失并在 sr-only 状态区播报「Reconnected」。
- 会话过期（`event: auth` revoked/expired）：红色横幅「Session expired. Sign in again to keep watching.」+ `Sign In`，2 秒后或点击即切回登录页。

## 8. 登录页

- LAN（password）模式：见 §6.7；错误就地显示在按钮上方（`role="alert"`），文案沿用 app.js 并补下一步：E_AUTH「Invalid username or password.」、限速「Too many attempts. Try again in 27s.」（倒计时期间表单禁用）、saturated「…Ask the host to run `/webhub unlock`.」、E_DB「Hub database unavailable — retry.」、网络「Cannot reach the hub. Check that the host is awake and on this network.」。
- token 模式：无表单；token 失效时显示空态「This link is no longer valid — run `/webhub` on the host and open the fresh link it prints.」。
- auth 模式无法判定（旧页面）：红色横幅 + `Reload`。
- 样稿：`login.html`、`states.html`（错误/token/旧页面）。

## 9. 空态 / 加载态 / 错误态总表

| 场景                              | 呈现                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| 无 agent                          | 列表空态：终端图标 + 「No pi sessions connected」+ `webHub.enabled` 提示            |
| 桌面未选中                        | 详情空态「Select an agent」                                                         |
| 深链 agent 不存在                 | 详情空态「This agent is not connected」+ Back to Agents                             |
| history waiting                   | 骨架（一个气泡 + 两段文字条），`aria-busy`，sr-only「Loading history…」             |
| history error                     | 红淡底行内错误（含错误码 + 原因）+ `Retry`（派发 `retry`）                          |
| paging                            | 顶部分隔线 pill「Loading older messages…」                                          |
| agent dialog 阻塞                 | 详情头部下琥珀横幅「Waiting on a dialog in the terminal: ask_user — “title” (+N)」  |
| agent stale                       | 详情琥珀横幅「Stale — no heartbeat for 3m. Data may be out of date.」               |
| agent offline                     | 详情中性横幅「Offline — the pi process exited. Showing the last known transcript.」 |
| 无子 agent                        | 不渲染子 agent 面板（不占位）                                                       |
| 截断的 payload                    | 工具卡/消息上 `truncated 64 KiB` chip                                               |
| 断线 / 过期 / 旧页面 / token 失效 | 见 §7、§8                                                                           |

全部在 `states.html` 中有样稿（`screenshots/states-light.png` / `states-dark.png`）。

## 10. 横幅规范

- 三档：`notice--warn`（琥珀：初始密码、明文 HTTP、断线、dialog、stale）、`notice--danger`（红：会话过期、旧页面）、`notice--muted`（中性：offline）、默认 info（蓝，预留）。
- 结构：左 16px 图标（语义化，不用 emoji）+ 正文（粗体关键词 + 一句下一步）+ 可选右侧动作按钮。
- 视觉：柔和底色 + 同色系深色文字（浅色 `#7A4604` on `#FFF7E8` = 7.3:1）+ 1px 同色系下边框；不用纯黄/纯红大底，不用等宽整行字体。
- 持久性：安全类（初始密码、明文 HTTP）**不可关闭**，手机上最多两行 + `›` 展开；状态类随状态自动出现/消失。
- 层级：全局横幅在顶栏下（最多同时 2 条，初始密码优先）；agent 级横幅在详情头部下，只影响当前 agent。
- ARIA：状态类 `role="status"`；错误类 `role="alert"`；常驻安全提示是普通内容（`<details>`），不做 live region（避免每次渲染重复播报）。

## 11. 可访问性

- 对比度：文字 ≥4.5:1（§3.1 已验证）；焦点环 2px `--c-focus`、偏移 2px（与背景 ≥3:1）。
- 键盘：`Skip to conversation` 跳转链接；agent 列表是链接列表（Tab 顺序自然，Enter 打开）；折叠用原生 `<details>`/`<summary>` 或 `button[aria-expanded]`；Esc 在详情（≤1024）返回列表；`j/k` 在列表上下移动（可选增强，不可成为唯一路径）。
- 语义：`<nav aria-label="Agents">`、`<main id="detail">`、`<section aria-label="Conversation">`、页面级 `h1`（sr-only）→ 列表 `h2` / 详情标题 `h2`；dl 呈现键值；meter 带 `aria-label`。
- 图标：装饰性 SVG 一律 `aria-hidden="true"`；纯图标按钮必须 `aria-label`（Sign out / Copy cwd / Show password / Back to agents）。
- 播报：对话流**不是** live region（流式会刷屏）；单独一个 sr-only `role="status"` 区播报「Assistant is responding / finished」「N subagents running」「Reconnected」等有意义的变化，节流 ≥2s。
- 标识符 `translate="no"`（路径、模型名、命令、sessionId），防浏览器自动翻译弄乱。
- 自动化审计：deveye（axe-core）对 dashboard（浅/暗）、login、states 全部「No accessibility issues found」。

## 12. Vue 组件拆分建议

```
App.vue                         // 读 data-auth-mode，挑 LoginView / TokenGate / Dashboard；持有 useHub()
├─ LoginView.vue                // props: plaintext:boolean, busy, error, countdownS; emits: submit({username,password})
│  └─ NoticeBanner.vue
├─ TokenGate.vue                // token 失效 / 旧页面空态
└─ DashboardView.vue            // props: state:State; emits: select, retry, page, signout
   ├─ TopBar.vue                // props: conn, hubVersion, user?, canSignOut; emits: signout
   ├─ NoticeStack.vue           // props: notices: Notice[]（id/tone/title/body/action/persistent）; emits: action(id)
   ├─ AgentList.vue             // props: agents: CardModel[], selectedKey, filter; emits: update:filter
   │  └─ AgentCard.vue          // props: model:CardModel(+model/ctx/subRunning), selected; 纯展示，<a :href>
   └─ AgentDetail.vue           // props: agent:AgentState; emits: back, retry, page, toggle-follow
      ├─ DetailHeader.vue       // props: session, status, card, down; emits: back, copy(field)
      │  ├─ SessionInfo.vue     // 可展开键值 + CopyButton（含非安全上下文回退）
      │  └─ ContextMeter.vue    // props: percent, tokens, window（CSSOM 设置 --pct，不写 style 属性）
      ├─ NoticeBanner.vue       // dialog / stale / offline
      ├─ FleetPanel.vue         // props: rows: FleetRowWire[], defaultOpen; 内部 computed(fleetTree)
      │  └─ FleetNode.vue       // 递归; props: node, depth, now; emits: toggle(runId)
      ├─ Transcript.vue         // props: agent; emits: page; 管理滚动锚点/跟随/窗口化
      │  ├─ TxUser.vue / TxAssistant.vue / TxCustom.vue / TxDivider.vue / TxError.vue
      │  ├─ ThinkingBlock.vue
      │  ├─ ToolCard.vue        // props: view: ToolView（沿用 toolView/summarizeArgs）
      │  ├─ CodeBlock.vue       // props: lang, text
      │  └─ MarkdownView.vue    // 渲染 parseMarkdown() 的 AST（见 §13），绝不 v-html
      └─ DetailDock.vue         // props: following, newCount; emits: update:following, jump
```

- **纯逻辑原样复用**：`state.js`（`reduce` / `initialState` / `messageKey` / `resultText`）、`contract.js`、`password-client.js`、`render/fleet.js` 的 `fleetTree`、`render/tools.js` 的 `toolView`/`summarizeArgs`/`safeJson`、`render/agents.js` 的 `agentCardModel`/`shortCwd`/`costLabel`、`render/banner.js` 的 `bannerText`、`render/markdown.js` 的 `parseMarkdown`/`isSafeHref`、`render/dom.js` 的 `formatUsd`/`formatDuration`/`clip`。现有 vitest 继续覆盖它们。
- **状态接入**：`useHub()` composable 持有 `const state = shallowRef(initialState())`，`dispatch(msg){ state.value = reduce(state.value, msg) }`——reducer 本就返回新对象，`shallowRef` 的引用变化即可驱动更新，不需要 Pinia、也不做深层响应式代理（大会话下更省）。`createClient` 的 SSE/重连/看门狗逻辑搬进 `useHub` 不改语义。
- **局部 UI 状态**（折叠、跟随、过滤词、选中）放组件内或 `useUiPrefs()`（sessionStorage，只存非敏感偏好）。
- 路由：不引 vue-router，`useHashRoute()` 解析 `#/agent/<key>` 即可。
- 格式化：数字/时间改用 `Intl.NumberFormat` / `Intl.DateTimeFormat`（`formatUsd` 的「<$1 显示 4 位」规则保留）。

## 13. 与安全不变量的对应

| 不变量                                       | 设计/实现约束                                                                                                                                                                                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSP `script-src 'self'`                      | 生产用 Vite 构建产物（无内联脚本）；Vue 用 runtime-only 构建（SFC 预编译模板，运行时不 `new Function`）；不加载任何 CDN                                                                                                                                          |
| CSP `style-src 'self'`                       | 样式全部在构建出的 CSS 文件里；**不写 `style=""` 属性**、不插 `<style>`；动态尺寸（meter 百分比等）用原生 `<meter>` 或 CSSOM `el.style.setProperty('--pct', …)`（CSSOM 不受 CSP 属性限制）；Vite dev server 的注入样式只在开发期存在                             |
| `default-src 'self'`、`img-src 'self' data:` | 无 webfont、无远程图标/图片；图标为随包内联 SVG（自绘 33 个，24px 网格 1.8 描边）；favicon 用 `data:` 或同源文件                                                                                                                                                 |
| 不渲染任意 HTML                              | 全局禁用 `v-html`（加 ESLint `vue/no-v-html` 为 error，并保留现有 `no-innerhtml.test.ts` 的扫描思路覆盖 `.vue`）；markdown 走 `parseMarkdown()` → AST → Vue 组件渲染文本节点；链接只允许 `isSafeHref`（http/https），`rel="noopener noreferrer" target="_blank"` |
| 密码不落盘                                   | 登录表单只用组件内 ref，提交后清空；不写 localStorage/sessionStorage；「显示密码」只切换 input type                                                                                                                                                              |
| 明文 HTTP 提示 / 初始密码横幅                | 保留且不可关闭；视觉由「刺眼黄条」改为柔和琥珀提示（§10）                                                                                                                                                                                                        |
| `frame-ancestors 'none'`                     | 不变（样稿中 `mobile.html` 的 iframe 仅用于评审，本地静态服务下才可用）                                                                                                                                                                                          |
| 只读（P1）                                   | 不渲染输入框；dock 明示「Read-only · reply from the terminal」                                                                                                                                                                                                   |

## 14. 样稿与截图

| 文件                        | 说明                                                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui-mockups/tokens.css`     | 全部 token（浅/暗、字体、间距、圆角、阴影、动效、reduced-motion）                                                                                                                                                      |
| `ui-mockups/app.css`        | 组件样式，移动优先 + 481/1025 断点 + `pointer: coarse` + reduced-motion；末尾一段为样稿专用画廊样式                                                                                                                    |
| `ui-mockups/dashboard.html` | 桌面/平板/手机同一文件：6 个 agent（running/waiting/idle/outdated/stale/offline）、嵌套子 agent 树（thinking/tool/queued/workflow warn/failed crit/done）、完成与出错的工具卡、长代码块、流式中的助手消息 + 运行中工具 |
| `ui-mockups/login.html`     | LAN 登录（明文 HTTP 提示）                                                                                                                                                                                             |
| `ui-mockups/states.html`    | 状态画廊（连接、空态、加载、错误、dialog/offline/stale、登录错误、token/旧页面）                                                                                                                                       |
| `ui-mockups/mobile.html`    | 三个 375×812 iframe 并排（列表 / 详情 / 登录），便于评审                                                                                                                                                               |

截图（`ui-mockups/screenshots/`，2× 像素密度，`reducedMotion: reduce` 以得到静态帧）：
`login-light`、`login-dark`、`dashboard-light`、`dashboard-dark`（1440×900），`tablet-list-light`、`tablet-detail-light`（820×1180），`mobile-list-light/dark`、`mobile-detail-light/dark`、`mobile-login-light/dark`、`dashboard-mobile-light`（375×812），`states-light/dark`（1280 宽整页）。

截图方式说明：deveye 连接的是另一台机器上的 Chrome，后台标签页无法 `screenshot`（handler 超时），而且不能为截图抢占用户的前台标签；deveye 远程浏览器模式在本机起第二个 server 时扩展未能握手。因此截图改用本机离线的 Playwright Chromium（`colorScheme` 真实模拟 `prefers-color-scheme`，`isMobile/hasTouch` 触发 `pointer: coarse`）。deveye 用于：只读截取现状页、在自己打开的后台标签里跑 axe 无障碍审计（浅/暗）、查 console 错误、确认无外部网络请求、提取设计 token；用完已关闭该标签。

## 15. ui-ux-pro-max 使用记录

- `--design-system "light clean developer tool dashboard real-time monitoring" --density 8 --variance 2 --motion 2`（已 `--persist` 到 `design-system/pi-web-hub/MASTER.md`，文件头已加覆盖说明）。采纳：Minimalism & Swiss 风格、仪表盘密度间距（8–32）、「live 标签必须有真实来源与 stale 态」、reduced-motion 静态终态、无 emoji 图标。**拒绝**：深色默认配色（改为浅色默认 + 暗色 token）、Cinzel/Josefin Google Fonts（改系统字体栈）、GSAP ScrollTrigger（无 JS 依赖、动效偏低）。
- `--domain color`（developer tool 返回的也是深色板，只借用「code 深色 + run 绿」的语义，主色另选 teal）、`--domain typography`（推荐全等宽 JetBrains Mono，拒绝：正文等宽降低可读性，仅代码/标识符用等宽）。
- `--domain ux`：live badge 播报（单一 status 区、带上下文）、streaming（逐 token 呈现，不用长时间 spinner）、loading（稳定骨架 + aria-busy）、reduced-motion、excessive motion（每屏 1–2 处动画）。移动端专项：touch target（iOS 44pt；Web WCAG 最低 24px，我们取 44）、mobile-first、horizontal scroll、viewport meta、`dvh` 代替 `100vh`、hover vs tap、gesture conflicts（主内容不做水平滑动）、truncation（省略号 + 展开）、back button / deep linking、sticky nav 不遮挡、input ≥16px。`safe area` / `virtualization` 在 ux 库中**无命中**，按 `references/pro-rules.md` 的 Safe-area compliance 与通用做法补齐。
- `--stack vue`：props 只读、emit 上报、`defineProps<T>()` 类型化；`v-html xss` 查询无命中，按项目自身不变量处理（§13）。
- `--domain chart`：唯一的数据可视化是上下文 meter——按「数值文字与图形并列、不靠红黄绿单独表意」执行。

## 16. 自审（web-design-guidelines + ux 移动端规则 + axe）

按 Vercel Web Interface Guidelines（`command.md` 实时拉取）逐条过样稿，发现并已修复：

- `dashboard.html`：页面缺少 `h1`，且列表 `h2` 在详情 `h1` 之前 → 增加 sr-only `h1`，详情标题改 `h2`。
- `dashboard.html`：按钮文案「Show 2 finished runs」→ Title Case「Show 2 Finished Runs」。
- `app.css`：skip-link 以 `top` 做过渡（非合成层属性）→ 改 `transform`。
- `app.css`：`-webkit-tap-highlight-color: transparent` 后卡片缺 `:active` 反馈 → 补 `.agent-card:active`。
- `app.css`：仅按钮有 `touch-action: manipulation` → 提升到 `html`。
- `app.css`：`.app`、`.login-page`、`.login-card` 网格隐式列被 `nowrap` 横幅撑宽，375px 下页面宽到 446/529px → 显式 `minmax(0, 1fr)`，复测 `scrollWidth = 375`。
- `app.css`：手机上横幅摘要 36px、搜索框 32px、分隔线摘要 25px、密码显示按钮 32px（未居中）→ `pointer: coarse` 下统一 ≥44px、按钮垂直居中。
- `app.css`：横幅单行省略把「Plain HTTP」警告截成半句 → 改为最多两行 + 展开。
- `app.css`：子 agent `<details>` 的 `max-height` 不约束内容，树溢出盖住对话 → 高度上限移到 `.tree-scroll`（34dvh / 30vh）内滚。
- `dashboard.html`：`pre-wrap` 气泡/段落被 prettier 换行缩进污染 → 对这些节点加 `<!-- prettier-ignore -->` 保持单行。
- `states.html`：offline 横幅误用 info 蓝 → 新增中性 `notice--muted`。
- 手机详情：指标带「124k / 200k」「incl. subagents」溢出 → 手机隐藏 token 数，文案缩为「sub $x」。
- 平板：选中卡片高亮被网格卡片样式覆盖 → 补回 `aria-current` 样式。

复核通过项：图标按钮均有 `aria-label`；装饰 SVG 均 `aria-hidden`；无 `transition: all`；唯一的 `outline: none`（输入框）有 box-shadow 焦点替代；`…` 而非 `...`；引号为弯引号；数字 tabular-nums；`color-scheme` + 双 `theme-color`；标识符 `translate="no"`；无 `user-scalable=no`；滚动容器 `overscroll-behavior: contain`；固定层不遮挡焦点（dock 在文档流内）。

自动化：deveye axe 审计 dashboard（浅、暗）/ login / states 均 0 问题；console 0 错误；Playwright 在 15 个视口/配色组合下 0 外部请求、0 请求失败，375px 下无横向溢出（被截断容器内的 `code` 不计）。

遗留（实现期处理，样稿不适用）：

- 骨架 shimmer 动的是 `background-position`（非合成层），实现可改为伪元素 `transform: translateX`。
- 日期/金额在样稿里是写死的字符串；实现用 `Intl.*`。
- 「URL 反映状态」：样稿只演示 `#detail`，实现需 `#/agent/<key>`，折叠/跟随等偏好不进 URL（有意为之）。
- 列表 >50 项才需要虚拟化；agent 数量通常个位数，只对 transcript 做窗口化（§6.6）。

## 17. 待用户拍板

1. **主色 teal（#0B7A70）**，还是换成更「科技蓝」（如 #1F5FC4，但会与 tool 状态色撞色）？
2. **平板 481–1024 用单栏导航**（样稿方案）还是 ≥768 就分栏（窄侧栏 260px）？
3. **手机上子 agent 面板默认折叠**（只显汇总行）还是默认展开？
4. **界面文案语言**：保持英文（与现有实现/测试一致），还是改中文或跟随 `navigator.language`？
5. 是否提供手动主题切换（浅/暗/跟随系统三态，存 localStorage），还是只跟随系统？
6. 用户消息用右侧气泡（聊天式，样稿方案），还是和助手一样左对齐全宽（日志式、更省横向空间）？

### 17.1 用户拍板（2026-09-27）

1. 主色：保持 teal（#0B7A70 / 暗色 #3CCBB9）。
2. 平板：≥768px 即分栏（窄侧栏约 260px）；<768 单栏列表→详情。
3. 手机子 agent 面板：默认折叠为汇总行（主会话默认值，未单独询问）。
4. 文案语言：跟随浏览器（`navigator.language` 以 zh 开头用中文，否则英文），内置小词典。
5. 主题：提供浅 / 暗 / 跟随系统三态切换，存 localStorage，默认跟随系统。
6. 用户消息：右侧气泡（样稿方案，主会话默认值，未单独询问）。
