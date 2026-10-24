# web-hub 命令历史 U1 — 前端包 · 实施报告

> 2026-10-24 · 方案 `docs/dev/web-hub-cmd-history/plan.md` v2（§4.7 UI 契约、§4.8 PathText 接入、§6 兼容矩阵、§8.1 U1 行、§8.2 冻结面、§8.3 U1 测试）；样式基准 `/tmp/cmd-history-preview.html`（用户已认可）。
> 文件域（越界零项；A1 agent 侧 / H1 hub 侧的并发改动未触碰）：`src/web-hub/ui/src/{logic/cmdRecord.ts(新),composables/useCmdHistory.ts(新),components/transcript/{TxCommand.vue(新),entries.ts,Transcript.vue},components/detail/DetailDock.vue,logic/state.js,types.ts,styles/transcript.css,i18n/{en,zh}/{transcript,control}.ts}`；`tests/web-hub/ui/**`（fixture 先行：`fixtures/cmd-records.ts`）。

## 实现要点

### 数据流（plan §3.2 下半段）

```
WireEntry.custom(墓碑)+cmd → state.js entryItem ⇒ kind:"cmd" item（isCmdRecordWire 轻校验）
  → entries.ts buildTxEntries(items, cmdLive?)：foldCmdRecords 按 cmdId 折叠
     · 首次出现位置持卡；有 end ⇒ 最后一条 end 渲染；其余条目隐藏（不进 TxEntry/anchors）
     · start-only ⇒ resolveCmdState(cmdRunning 集 ∧ 本标签页 5 s seen 宽限 ⇒ running，否则 unrecorded)
  → Transcript.vue：TxCommand 渲染 + 本地占位卡（transcript 末尾）+ 宽限翻转一次性定时器
DetailDock.vue：historyMode = hubCaps ∋ cmd.history.v1 ∧ status.features ∋ cmd.history.v1
  ⇒ runCommand 自铸 cmdId（= 线帧 id，ControlHandle.runCommand 的 opts.id 既有通道）→
    store.begin 占位卡；回复 history==="recorded" ⇒ 等真卡（60 s store 降级）；
    none/缺失 ⇒ 「已执行 /x」4 s 自动消失；effect-none 错误 ⇒ 手动关错误提示；
    E_CONFIRM_REQUIRED ⇒ 占位移除 + CommandConfirm 原样；「需回终端操作」横幅保留为独立行
```

### 关键决策（与方案偏差点，均已对齐方案意图）

1. **useCmdHistory 用模块级 `Map<agentKey, store>` 而非 provide/inject**：DetailDock 与 Transcript 是兄弟，公共祖先 AgentDetail.vue 不在 U1 文件域——与 `useControl` 的 drafts Map 同一先例。有界：≤32 agent FIFO、每 agent ≤16 占位 / ≤8 提示 / ≤64 seenRunning。定时器句柄放在 reactive 之外的闭包里（Node/vitest 下 `clearTimeout` 拒绝 reactive Proxy 包装的 Timeout 对象）。
2. **不动 contracts.ts**（不在文件域）：`TranscriptSource` 的 Pick 不加宽；`cmdRecord.ts` 提供防御性读者 `cmdRunningOf(source)`（运行时 `AgentState.status` 是未 narrowed 的 StatusInfo 原文，reducer 本就整个 `status = d.status` 镜像，无需改 reducer）与 `cmdHistoryModeOn(caps, status)`。抽屉 RunTranscript 的源无 `status` ⇒ 天然 inert。
3. **占位状态机只读同步回复的 `history` 字段**：同步回复（含 completion async/unknown）必带 `history`（A1 契约），缺失视同 none（n1）——不再需要 legacy 的 pendingCtl→queryOnly 跟踪链；60 s 兜底在 store 里。late 数据带 `history` 是 A1 侧义务（m2），UI 不依赖。
4. **foldSig 落点**：plan §4.7 说「`itemRenderKey` 对 kind:"cmd" 返回 `${it.id}|${foldSig}`」——foldSig 需要折叠结果（最后一条 end 的条目 id），单个 item 的 `itemRenderKey` 拿不到；实现为 entries.ts 里 `${itemRenderKey(it)}|cmd:${lastEndEntryId}:${state}`（renderKeys 测试钉住）。注：当前 Transcript 模板用 `:key` + props 更新即原地刷新（renderKeys 暂无 v-memo 消费者，签名供未来启用）。
5. **chip 文案语言分界**：done/failed/running 两个语言都保留英文 token（预览基准如此）；timeout/unrecorded 按 §4.7 中文「已截止 / 结果未记录」；来源 chip web/tui/rpc/other 原样 token、feishu 本地化为「飞书」；「不进上下文」chip 与正文散文案走 i18n（transcript 命名空间），dock 提示走 control 命名空间（i18n-parity 全绿）。
6. **占位卡渲染在 Transcript 尾部**（不进窗口计数，不占滚动锚）；真卡到达时占位在**同一帧**即被过滤（`visiblePlaceholders` computed 减去已在流的 cmdId）+ store 清理定时器——二者不会同时存在（§4.7 末条）。

### 逐字节不变承诺（§1.3/§6）

- `historyMode` 假 ⇒ DetailDock 的 legacy 路径**零条件分支改动**（`runCommand` 首行一处 `if (historyMode.value) return …` 提前分流；新增 DOM 全部包在一个 `<template v-if="historyMode">` 里，为假时只剩一个 v-if 注释锚点）——`detail-dock.test.ts` / `command-result.test.ts` / `command-confirm.test.ts` 原样全绿，另有本包「historyMode OFF ⇒ legacy CommandResult 照旧」两条反向钉。
- 旧 agent/旧 hub ⇒ 无 cmd 字段 ⇒ entryItem 不产出 cmd item ⇒ transcript 逐字节不变（`cmd-history-state.test.ts` 钉：无 `cmd`/非法 `cmd` 的 custom 墓碑不可见）。
- `keepalive-legacy-golden.json` 未触碰（keepalive-golden.test.ts 绿）；`CommandResult.vue` 未改一字。
- 隐私锁：锁整个会话详情视图，命令卡是 transcript 一部分，自动覆盖（§5.4）；移动端：复用 `.msg-assistant` 网格（≥481px 才有头像列），`.is-clamped` 用相对单位。

### TxCommand 渲染（对齐预览基准）

- `article.msg-cmd.tx-item`：⌘ 紫色头像（`--c-accent`/`--c-accent-soft`）+ msg-head（「命令」+ 来源 chip +「不进上下文」chip + 时间）；
- 卡头：`/name args`（mono，超长省略）+ 状态 chip（running 旋转符/done/failed/已截止/结果未记录，原地更新）+ CopyButton（复制 `cmdPlainText` = 命令行 + 原文输出块 + 失败原因）；
- 正文：notify ⇒ level 徽标（info/warning/error 三色）+ `<pre><PathText/></pre>`；widget/status ⇒ 按 `kind+key` 分组（key 副标题，文本 `\n\n` 合并，clip 标记 OR 累积）；text/error ⇒ `<pre>`；interactive ⇒ 收成一行（web 来源「以下交互步骤需在终端完成：…」/ 其它来源「已在终端交互：…」）；`truncated` 页脚、`clipped` 尾标（复用 `control.cmdOutput.*` 文案）；
- notice：terminal-only「已发送，输出仅在终端」/ sensitive「敏感命令，输出未记录」/ no-output「无输出」；left-session 无额外横幅（正文自带离开行）；
- **纯文本节点渲染，零 `v-html`**（source-scan 测试面全绿）；绝对路径/本机 `http://` 链接逐行走既有 `PathText`（含 proxy URL 识别与 probe 管线，§4.8/G3）；
- `cmdLineCount > 6` ⇒ `.is-clamped`（≈6 行 max-height）+「展开全部 / 收起」（复用 `transcript.showAll/collapse`，组件本地状态）。

## 改动文件清单（绝对路径）

新建：

- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/logic/cmdRecord.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/composables/useCmdHistory.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/components/transcript/TxCommand.vue`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/fixtures/cmd-records.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/cmd-record-logic.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/cmd-history-store.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/cmd-history-state.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/tx-entries-cmd.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/tx-command.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/detail-dock-cmd-history.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/cmd-history-transcript.test.ts`

修改：

- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/logic/state.js`（entryItem custom 分支 + Item typedef kind 并集）
- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/types.ts`（`ItemKind` 加 `"cmd"`——方案 §4.7 授权的并集 widening）
- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/components/transcript/entries.ts`（`TxEntry` 加 `command` 变体、`buildTxEntries(a, cmdLive?)`、foldSig renderKey）
- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/components/transcript/Transcript.vue`（cmdLive/占位卡/seenRunning 喂入/宽限翻转定时器，unref 纪律不适用——浏览器组件 onBeforeUnmount 清理）
- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/components/detail/DetailDock.vue`（historyMode 分流 + 精简提示 + 独立「需回终端」行）
- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/styles/transcript.css`（`.msg-cmd`/`.cmd-card*` 块 + `.cmd-note`）
- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/i18n/{en,zh}/{transcript,control}.ts`

## 自验（真实输出尾部）

`npx vitest run tests/web-hub/ui --maxWorkers=3`：

```
 Test Files  259 passed (259)
      Tests  5700 passed (5700)
   Duration  80.22s
```

（其中本包新增 7 个文件 61 用例：fold 矩阵 / resolveCmdState 全矩阵 / 复制文本 / 行数 / store 状态机（60 s 降级、降级后真卡到达移除提示、4 s 自动消失）/ entryItem 合法⇒item、非法⇒墓碑 / buildTxEntries 位置·隐藏 end·renderKey 随 end/state 变化 / TxCommand 折叠·notice·裸文本·复制 / DetailDock historyMode 正反两面 / Transcript 端到端 running→unrecorded 宽限翻转与占位→真卡交接。）

`npm run typecheck`：

```
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
（退出码 0，无输出）
```

`npm run build:web && npm run check:web`：

```
✓ built in 27.90s
✓ check:web — dist/web-hub-ui/ OK (84 files, first-screen JS 354375B gz/524288B, lazy JS 75816B gz/131072B,
  mermaid JS 1421010B gz/2097152B in 61 mmd files, CSS 36036B gz/65536B, 57 packages)
```

`npx prettier --check`（全部 20 个改动文件）：

```
Checking formatting...
All matched files use Prettier code style!
```

## 遗留 / 说明

- **真机联调待 I1**：UI 侧的 caps/feature 门控按 P0 常量（`cmd.history.v1`）接线，但 A1（agent `StatusInfo.features`/`cmdRunning`/`history` 字段）与 H1（hub cap 声明、记录到达的 append 通道）由并行包实施；真机验收（plan §8.5 全部条目，含 G7 延迟执行、占位 >60 s 降级、日志卫生）属 I1。
- 未跑 deveye 浏览器走查：本机无可直接挂载的实时 hub+agent 会话；组件级 happy-dom 渲染断言 + 构建门禁已覆盖 DOM 结构，视觉对照以 `/tmp/cmd-history-preview.html` 为准（I1 真机时核对）。
- 占位卡不参与窗口化计数与滚动锚（无稳定 entry id，同 streaming 条目先例）；翻页把 start 加载进来时卡片上移走既有 E1 prepend 补偿。
- 抽屉 RunTranscript 无 `status` ⇒ start-only 卡诚实渲染「结果未记录」；run 会话本身不写记录（child inert），属防御路径。
- 零 git 写操作；A1/H1 并行改动的文件（agent/hub/secure/config 侧）未触碰。
