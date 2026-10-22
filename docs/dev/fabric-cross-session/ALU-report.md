# ALU 报告：会话别名 web UI 包（alias-plan r4）

文件域严格限于：`composables/useTrackedCommand.ts`（新）、`agents/{AgentCard.vue,agentCardModel.ts}`、
`detail/{ChannelsDialog,DetailHeader}.vue`、`control/{sessionMention.ts,Composer.vue}`（只改显示）、
`logic/xsMessage.ts`、`transcript/TxCustom.vue`、i18n（新 `i18n/alias-extra.ts`、`en/zh/agents.ts` 各加一键）、
`tests/web-hub/ui/`（新 `use-tracked-command.test.ts`、`alias-ui.test.ts`）。DetailDock.vue 未动；
未新增任何 CSS 文件/规则（见「偏离 6」）。AL0a/AL0b 已合入的 protocol 面（`xs-alias.ts`、cap `xs.alias.v1`、
`StatusInfo.xs.alias`）是全部 UI 的数据源。

## 组件改动

### 新 `ui/src/composables/useTrackedCommand.ts`

按 §7.1 把**单个命令**从发出跟踪到最终 captured 输出，供 ChannelsDialog 的别名操作使用。

```
useTrackedCommand({ view(): TrackedCommandView | null, timeoutMs? = 15000 }): {
  phase: Ref<"idle" | "running" | "confirm">           // confirm = 等用户点 CommandConfirm
  confirmReq: Ref<{ name, args } | null>               // E_CONFIRM_REQUIRED 时给出（CommandConfirm props）
  run(name, args): Promise<TrackedCommandResult>       // 一个逻辑操作；二次调用取代前一个
  confirm(): void                                      // 新 cmdId + confirm:true 重发，重新计 15s
  cancel(): void                                       // 丢弃跟踪；命令本身不撤销
}
TrackedCommandResult = { ok: true; output } | { ok: false; error; message? } | { ok: false; cancelled: true }
```

- `run()` 用 `@logic/control.js` 的 `newCmdId()` 自建 cmdId，经 `runCommand(…, {id})` 传入（web-model-switch
  §5.2 #6 先例），结果只取**这个 cmdId** 的最终输出文本（`commandOutputText` 拍平 `CommandOutputWire.entries`）。
- `completion:"async"|"unknown"` ⇒ watch `view().pendingCtl` 里这个 id：item 变 `failed`/`notExecuted` ⇒ 按 item
  报错失败；item 消失（cmd_late 结算）⇒ 恰好一次 `query()`（queryOnly），按 DetailDock 同款规则解包
  `result.data.output`（首查不到 item 时等一个微任务复查一次，防 reducer 滞后，绝不会二次 query）。
- `E_CONFIRM_REQUIRED` ⇒ phase="confirm" + `confirmReq`，**停表**（用户思考时间不计时，方案作者确认）；
  `confirm()` 换**新** cmdId 带 `confirm:true` 重发，重新起 15s。
- 15s 为**每次线上往返的预算**（往返 + async 结算 + 一次 queryOnly 一条链），超时 ⇒ `E_TIMEOUT`。
- 取消路径：`cancel()`、组件 scope dispose（弹窗关闭）、`view().agentKey` 变化（切换会话）。取消后迟到的
  watcher/query 结果一律丢弃（settle 幂等 + settle 点复核 agentKey）；已发出的命令不撤销，以随后的 status 为准。
- 另有 `commandOutputText()` 导出（纯函数，单测覆盖）。

### `agents/agentCardModel.ts`（纯函数层）

- `XS_ALIAS_CAP = "xs.alias.v1"`（镜像常量，同 `XS_CHANNEL_CAP` 先例）；`XS_ALIAS_CARD_GRAPHEMES = 8`（Q8）。
- `xsAliasOf(agent, hubCaps)`：cap ∧ `status.xs.alias` 为非空字符串（≤128 防御性上限）⇒ alias，否则 undefined。
- `truncateGraphemes(s, n)`（Intl.Segmenter，码点兜底）、`aliasChipText(alias)` = `@` + 前 8 字形簇 + `…`。
- `aliasSuggestions(self, agents, hubCaps)`：cwd 末段 → 会话名首个「别名字符最大连续段」→ cwd 最后一个含
  CJK 的段里首个 CJK 连续段；各过 `normalizeAlias`，`too_long`/非法/保留一律丢弃不截断；去重、跳过当前别名、
  至多 3 个；`taken` = 其他会话当前 `status.xs.alias` 相同（仅提示，hub 为权威）。

### `AgentCard.vue`

chips 顺序变为 `kind → 状态类 → xs 徽标 → @别名 → #频道 → 未读角标`：新增
`<span class="chip chip-xs-alias" :title="@全文">`（截断显示前 8 字形簇），插在 xsBadge 与 channels chip 之间。
chipsBelow 测量按 chips 组 `offsetWidth` 自动适应，机制未改。无 cap/无字段 ⇒ 不渲染任何字节。

### `detail/DetailHeader.vue`

标题后小字 `@别名`：`headerAlias = xsAliasOf(agent, caps)` 存在且 `channelsUsable`（channel cap + status.xs +
control 闸门）⇒ 按钮，点击打开同一个 lazy ChannelsDialog；闸门不满足 ⇒ 纯文本 chip（不可点）。
新增 eager i18n 键 `agents.xsAliasManage`（en/zh）。

### `detail/ChannelsDialog.vue`（别名区）

- 标题按 cap 切换：`alias.dialogTitle`「Channels & alias / 频道与别名」 vs 原 `channels.dialogTitle`——
  **无 `xs.alias.v1` cap 时整个别名区不渲染、标题不变，逐字节同现状**（`aliasOn` = cap ∧ session 有 `status.xs`）。
- 别名区（顶部）：当前别名 `当前：@x`；输入框 `@protocol/xs-alias.js` 的 `normalizeAlias` 实时预校验
  （`invalid/too_long/id_like/reserved` 四条 i18n 提示，aria-invalid/describedby）；≤3 推荐 chip
  （占用者 `data-taken` + title 提示但**仍可点击**，只填框不提交——方案作者确认，保存被拒正是抢占入口）。
- 「保存」「清除」（仅有持有别名时出现）「尝试抢占」全部走 useTrackedCommand；回显 = 该命令自己的 captured
  输出原文（`<pre class="alias-output">`），无输出时落 `alias.doneFallback`；失败显示 `channels.failed`。
  不做乐观更新，以回显 + 随后 status 推送为准。频道 join/leave 原路径逐字节未动。
- **抢占流程**（状态图）：

```
        点击「尝试抢占」(alias 合法且 idle)
            │
            ▼
  tracked.run("fabric", "alias <a> --take")            ── E_CONFIRM_REQUIRED ──▶ phase=confirm
            │                                                          │ (CommandConfirm 通用条)
   ┌────────┴─────────┐                                               │ confirm()=新 id+confirm 重发
   ▼                  ▼                                                │ cancel()=放弃
 失败/无确认行       parseTakeConfirm(本次输出最后一行) 命中 ◀───────────┘
 (echo 原样展示，      │
  如「持有者仍在线」)   ▼
              takePreview={alias,token,text,receivedAt}
                     │  确认框：标题 + 预览输出原文（持有者 cwd 标签 + 离线时长）
                     │  + 令牌剩余倒计时（本地 5 分钟钟，见偏离 2）
            ┌────────┼─────────────┐
            ▼        ▼             ▼
         「取消」  倒计时归零     「确认抢占」(未过期)
         关盒丢弃  禁用确认+提示   tracked.run("fabric","alias <a> --take=<token>")
            │      重新预览        │（同样过 policy confirm 闸门）
            ▼                     ▼
           idle              回显结果，盒子关闭
```

token 只取自**这次预览命令自己的最终输出**（`parseTakeConfirm` 只认最后一个非空行）；测试里另一条命令输出
含不同 token 的确认行，不会被采用。弹窗关闭/切会话 ⇒ scope dispose 取消跟踪；超时 15s 自动放弃。

### `control/sessionMention.ts` + `control/Composer.vue`（只改显示）

- `SessionMentionTarget.alias?`（经 `xsAliasOf`，cap 门控）；`filterSessionTargets` 增加 alias 前缀匹配
  （并容忍查询带一个前导 `@`）；插入值仍是 `session:<ref>`（Composer 的 `pickPanelRow` 未动）。
- Composer 候选标签：`@alias · name`（无 name 时 `@alias`；无 alias 时原样 `name || ref`）。

### `logic/xsMessage.ts` + `transcript/TxCustom.vue`

- `XsView.fromAlias?`：首行独立正则 `\salias=("…")` 解析（与 cwd/reply_to/channel 顺序无关），JSON 合法且
  `normalizeAlias` 幂等（即线上 canonical 形）才采纳；伪造 body 行够不着首行。
- alias 位于 `from=` 与 `cwd=` 之间时 HEADER_RE 的 cwd 分组失配 ⇒ **仅在 alias 存在时**用独立 cwd 正则回补，
  无 alias 的消息逐字节走旧路径。
- TxCustom：who 位置显示 `xs ← @别名`，自报名/ref 移到 `title`（方案作者建议：不把自报 name 与核验别名并排）；
  无 alias 时渲染逐字节不变（tx-xs 原有测试全绿）。

### i18n

- 新 lazy `i18n/alias-extra.ts`（`alias` 命名空间，`registerAliasExtra()` 随弹窗 chunk 挂载注册，zh/en 对拍）；
  与 channels-extra 同姿势，不进首屏 bundle。
- `en/zh/agents.ts` 各加 `xsAliasManage` 一键（详情头部 `@别名` 按钮 tooltip）。

## 测试（全部新增在 tests/web-hub/ui/）

- `use-tracked-command.test.ts`（12 例）：sync 输出拍平；async → item 消失 → 恰好一次 queryOnly + 解包；
  item failed/notExecuted；E_CONFIRM_REQUIRED → confirm 阶段 → 新 id+confirm 重发；confirm 期 cancel；
  async 中途 cancel 后迟到结算被丢（无 query）；agentKey 变化取消；15s 超时（fake timers）；用户思考时间不计时、
  重发重新计时；二次 run 取代前者；无 control ⇒ E_UNAVAILABLE。
- `alias-ui.test.ts`（26 例）：模型（cap 门控/截断/建议词派生与 taken/i18n 对拍）；卡片 chip（顺序在 channels
  chip 前、8 字形簇截断+title 全文、无 cap 无 chip）；详情头部（`@别名` 按钮点开弹窗、无 cap 无字段不渲染）；
  @ 面板（alias 参与过滤、Composer 显示 `@alias · name` 但插入 `session:<ref>`）；xsMessage（任意字段顺序、
  alias 在 cwd 前时 cwd 回补、非 canonical/伪造注入丢弃、无 alias 逐字节不变、TxCustom who/title）；
  弹窗（无 cap 标题与结构不变、有 cap 标题切换、四条校验提示、建议 chip 置灰可点不自动提交、保存/清除/失败回显、
  抢占全链路含「别的命令输出里的确认行不被采用」、持有者在线无确认框、5 分钟过期禁用确认、policy confirm
  新 id 重发、async 一次 queryOnly 解包、弹窗关闭后迟到结果被丢）。

## 自验

- `npx vitest run tests/web-hub/ui --maxWorkers=3` → **230 files / 5388 tests 全过**（含既有 golden/快照类：
  channels-ui、composer-mention-session、tx-xs、detail-header、agent-card-layout-css、source-scan 等无回归）。
- `npm run typecheck` → tsc ×2 + vue-tsc 无错误。
- `npm run build:web && npm run check:web` → 构建成功；check:web 全项 OK（首屏 JS 331,765B gz / 524,288B 预算，
  alias-extra 在 lazy chunk 内）。
- `npx prettier --check <14 个改动/新增文件>` → All matched files use Prettier code style。

## 偏离 / 说明

1. **useTrackedCommand 绑定视图而非传 agentKey**：方案写 `run(agentKey, name, args)`；实现把
   agentKey/control/pendingCtl 收进一个 `view()` getter（响应式读取 pendingCtl 是 watch 的前提），`run(name, args)`。
   语义不变（自建 cmdId、单命令跟踪）。
2. **抢占倒计时用本地 5 分钟钟**：web/RPC 回显文本里没有 `expiresAt`（只有「（5 分钟内有效）」固定文案），确认框
   从收到预览输出起本地计 5 分钟，过期禁用「确认抢占」并提示重新预览；真正权威仍是 hub 侧 token TTL。
3. **展示细节按方案作者 consult 定稿**：标题/别名区同条件按 cap 切换；TxCustom 用 `@alias` 独占 who（name 进
   title，不并排）；会话名首段取「别名字符最大连续段」而非按空白切；taken chip 置灰但可点（只填输入框）。
4. **xsMessage 的 cwd 回补**：仅在解析到合法 alias 时启用独立 cwd 正则（alias 插在 from 与 cwd 之间时旧
   HEADER_RE 的 cwd 分组会失配）；无 alias 路径逐字节不变。
5. **详情头部入口降级**：`@别名` 文本存在但弹窗 control 闸门不满足时渲染为纯文本 chip（不可点），不渲染按钮。
6. **未新增 CSS**：文件域不含样式文件；别名区复用 `.channels-*`/`.input`/`.btn`/`.chip` 系列，
   `.chip-xs-alias`/`.detail-alias-btn`/`.alias-*` 类名无专属规则（落在 `.chip` 基础样式上）。视觉可用但如需
   精修（建议 chip 行距、预览 pre 的滚动框）需后续包补 resume.css/detail.css。
7. **遗留**：§9 的「web 抢占全链路」真实桥接集成测试属 AL6 的 `tests/integration/` 域，本包未覆盖；
   `/fabric status` 的 alias 行、TUI 侧确认属 AL4。alias chip 的「整组下移」走的是既有 offsetWidth 测量，
   happy-dom 无布局，该路径由既有 agent-card-layout-css 测试覆盖 CSS 侧。
