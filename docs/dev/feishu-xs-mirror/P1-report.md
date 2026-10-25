# P1 报告 — 飞书侧（feishu-xs-mirror，plan r3 + §R3）

## 导出接口（与 §2.2 对齐，供 P2/P3）

- `src/web-hub/hub/feishu/xs-mirror.ts`
  - `interface FeishuXsMirrorEvent`：字段与 §2.2 逐一相同（sessionId/agentKey/xid/kind/from{ref,name?,alias?}/channel?/late?/queued?/wakeDowngraded?/text）。
  - `createFeishuXsMirror(deps) → { deliver(e), pump(), dispose(), stats() }`（`stats()` 仅测试/诊断，无内容）。
  - 常量：`XSM_PER_BINDING_PER_MIN/HOUR`(6/60)、`XSM_GLOBAL_CARDS_PER_MIN`(30)、`XSM_QUEUE_MAX`(16)、`XSM_MAX_QUEUED`(16)、`XSM_OUTBOX_HEADROOM`(128)、`XSM_MAX_CARD_BYTES`(8192)、`XSM_RECORD_OVERHEAD`(512)、`XSM_BYTE_HEADROOM`(256 KiB)、`XSM_WORK_HEADROOM`(64)、`XSM_MAX_AGE_MS`、`XSM_TAG_PREFIX`。
- `service.ts`：`FeishuBotService.xsMirror(e: FeishuXsMirrorEvent): void`（同步、永不抛；无 runtime/disposed ⇒ 丢弃）。**P3 在 hub.ts 里 `onQuietDelivered: (e) => bot?.xsMirror(e)` 即可**（`bot` 是 FeishuBotService）。
- `outbox.ts`：`EnqueueNoticeInput.tag?: string`（`/^xsm:[A-Za-z0-9_-]{1,60}$/`，持久化为记录的可选 `requestId`）。
- `render.ts`：`renderXsMirror(XsMirrorCardInput)`、`XS_MIRROR_CARD_MAX_BYTES`、`XS_MIRROR_BODY_MAX_CODE_POINTS`。
- 设置：`feishuBot.xsMirror`（settings 默认 true、`FEISHU_BOT_DEFAULTS.xsMirror=true`、`FeishuBotHubConfig.xsMirror?`缺省=false、`buildHubConfig` 写 `bot.xsMirror ?? true`、setting-specs、警告 `xs-mirror-invalid`）。
- 计数：并入 `info().counters.dropped`，键 `xs-mirror-<reason>`（rate/cap/bytes/work/refused/stale/unbound/invalid/dup/stopped/purged）；`FsbInfoDataSchema` 未改。

## 实现要点

- 单有界 FIFO(16) + 单 worker（`work.run` 1 槽；`run()===false` ⇒ 整队转 omitted `work`）；同步临界段内完成「陈旧检查→重取绑定→target→渲染→槽位(镜像 queued≤16、总占用<320)→字节(`state.usage()`+JSON 转义+512 开销，余量≥256 KiB)→调用 `enqueueNotice`」，其间无 await。
- 全部 p2p 绑定（`chatType==="p2p"` ∧ key 以 `p2p:` 开头 ∧ 非 offline），按 `lastServed` 最久未准入排序；逐卡预占 per-binding 6/min·60/h + 全局 30 卡/min。
- omitted 为单调 `dropped` + 已报告水位 `reported`，仅在 outbox 接受后推进；dispose 后（含 catch 分支，§R3 m1）不再写任何状态。
- `ok:true` 区分 `accepted` / `accepted-nondurable` 审计；审计与日志不含正文/名字/别名/ref/sessionId/chatId/tag。
- service：runtime 内创建（仅 `config.xsMirror===true`）；`settled()` 首行对 `notice ∧ requestId 以 xsm: 开头` 早退；`maintain()` 调 `mirror.pump()`；stop 序列仅在 `notify.dispose()` 后追加 `mirror.dispose()`（`connector.stop()` 仍第一步）；`start()` 在 `outbox.start()` 之前、`xsMirror!==true` 时清除 queued `xsm:` notice 并计 `xs-mirror-purged`。
- 卡片：`buildCard`（schema 2.0 + plain_text header + 单 markdown），零按钮/behaviors；来源字段行内代码 + `markupSafeLabel` + 反引号替换；正文 1500 code point 截断、`neutralizeMarkdown`、逐行 `> `；>8192 字节逐步缩短，最后退化为静态文案。

## 改动文件

src/config/{settings,setting-specs}.ts · src/commands/webhub.ts · src/web-hub/protocol/feishu.ts · src/web-hub/agent/index.ts · src/web-hub/hub/feishu/{xs-mirror(新),render,outbox,service}.ts · 测试：tests/config/{feishu-bot-settings,setting-specs-feishu}.test.ts、tests/web-hub/protocol/feishu.test.ts、tests/web-hub/agent/wiring-feishu.test.ts、tests/web-hub/hub/feishu/{xs-mirror(新),xs-mirror-isolation(新),render,outbox,state,service}.test.ts。`boundary.test.ts` 无需改（settings.ts 无新增值导入）。

## 测试清单

- xs-mirror.test.ts（20）：过滤/去重/tag 形状；6/min·60/h；全局按卡 30；公平轮转（40 绑定、队列 16 三轮全覆盖，被跳过绑定的尾注=1）；单 worker（enqueue 在途 ≤1）；`run()` false；work 余量；队列上限；omitted 守恒（失败/抛错不推进、在途新增丢弃不被吞、nondurable 推进）；stale/unbound/槽位/字节门；dispose 在途/抛错后无写入；审计无敏感子串。
- xs-mirror-isolation.test.ts（6，真 state+真 outbox）：15 已有 + 扇出 ⇒ 恰 16；总占用 319 ⇒ 至多再 1 张且告警仍可入、余量≥128；近满字节镜像全拒、余量字节未被占用且 40 条非镜像 notice 仍全部准入；同 tick 交错。
- outbox（tag 形状/seed 不变/非法/去重/settle 后删除）、state（带 requestId 的 notice 持久化重载）、render（renderXsMirror 8 项）、service（inert/true 出卡/群不推/stop 后无动作/dropped 计数/重启清除 vs 保留）、settings/protocol/wiring 各增断言。

## 偏离 / 未做

- service 层未单独写「stop 顺序（connector.stop 先于 mirror.dispose）」与「maintain 调 pump」的断言：stop 序仅是追加一行（代码审阅可见）；pump 行为由 xs-mirror 单测（work 余量用例）覆盖，service 的 30s 定时器路径未直接测。
- 「15+8 扇出」用例按 8 个绑定实现（预置 15 条镜像 ⇒ 仅 1 张通过、7 个 cap）。
- service 清除用例的 429 handler 在 runtime 启动后才注册，理论上有极小竞态（连跑 3 次稳定）。

## 自验输出（尾部）

```
npx vitest run tests/config tests/web-hub/protocol tests/web-hub/agent tests/web-hub/hub/feishu tests/web-hub/boundary.test.ts --maxWorkers=3
 Test Files  201 passed (201)
      Tests  5026 passed | 3 skipped (5029)
npx vitest run tests/ui + 三份 off golden: Test Files 9 passed, Tests 218 passed
npx tsc --noEmit -p tsconfig.json  → 无输出（0 错误）
npx prettier --check <全部改动文件> → All matched files use Prettier code style!
```
