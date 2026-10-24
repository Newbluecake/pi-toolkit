# W1 网页包报告 — 定时任务（#32）web-hub Vue UI

> 依据：`docs/dev/scheduled-reports/plan.md` r3（§0 拍板 D4/E3、§5.2 web 策略表、§5.6 面板、§12 W1 行）+
> S0 冻结契约（`src/web-hub/protocol/schedule.ts`，commit ec4297b0）。
> 范围：`src/web-hub/ui/src/**` 的 schedule 相关新文件 + 挂接点最小改动 + `tests/web-hub/ui/schedule*.test.ts`。
> 未碰 `src/web-hub/{protocol,hub,agent}/**`、未碰并行包（S1 的 `src/schedule/core/**`、cmd-history）、零 git 写操作。

## 0. 静态预览（用户确认用）

`/tmp/schedule-panel-preview.html` — 纯静态 mock（内联 token 复制自 `styles/tokens.css`），覆盖：
在线常规 + 待确认 / 离线只读 / degraded / stale / 审阅对话框（message 与 background 两种形式）/ 移动端 375px / 入口位置说明。
**请主会话拿给用户确认。**

## 1. 改动文件清单

### 新文件（W1 独占）

| 文件                                                        | 内容                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/logic/schedule.js`                      | 纯逻辑：`SCHED_CAP`/`SCHED_EVENT` 手工镜像（禁 value-import protocol/schedule.ts —— 它会拖 typebox 进 bundle）、`isSchedulesPayloadLike`（结构性校验、容忍未知键、8 任务/64 会话上限）、`sessionProjectionOf`、`scheduleBadgeOf`/`scheduleBadgeText`（⏰n / ⏰!）、`fmtTs`/`relIn`/`whenParts`/`runStateKey`/`feishuKey`（stale ⇒ `q`）、`approveArgs`/`shortHash`、`panelView`（面板视图模型一处推导） |
| `src/web-hub/ui/src/components/schedule/SchedulePanel.vue`  | 懒加载 PickerSheet 对话框：任务列表（名称、已启用/已暂停/待确认 chip、时间+tz、下次运行、totals、错过提示 chip）、运行记录（状态/原因/时长/feishu 回执/报告路径）、degraded 修复提示、droppedReports 提示、离线只读提示（E3）、stale 横幅；行内切换到审阅视图                                                                                                                                           |
| `src/web-hub/ui/src/components/schedule/ScheduleReview.vue` | 审阅对话框：完整定义（全 prompt `<pre>` 纯文本、时间+tz、形式、type/model/thinking/timeout/consult/handoff/isolation、feishu、创建者、defHash 前 8 位）+ 「批准」（`useTrackedCommand` 发 `/schedule approve <id> <fullHash>`，E_CONFIRM_REQUIRED 走通用 CommandConfirm，E_REV 提示「内容已变更，请重新审阅」且内容随 SSE 快照实时刷新）                                                                |
| `src/web-hub/ui/src/i18n/schedule-extra.ts`                 | 懒加载 `schedule` 命名空间（en/zh 平价，`satisfies Record<keyof typeof en>` + 测试钉住）；紧凑标记（runState/feishu 词汇）按 AGENTS.md 规则双语均为英文 token，散文提示翻译                                                                                                                                                                                                                             |
| `src/web-hub/ui/src/styles/schedule.css`                    | 面板/审阅/徽标样式（token-only；source-scan 禁 `<style>` 块）                                                                                                                                                                                                                                                                                                                                           |
| `tests/web-hub/ui/fixtures/schedule.ts`                     | mock `SchedulesPayloadWire`（typed against protocol/schedule.ts；含 `<script>` 注入 prompt 用例）                                                                                                                                                                                                                                                                                                       |
| `tests/web-hub/ui/schedule-logic.test.ts`                   | 逻辑 16 项 + 契约钉（`SCHED_CAP === SCHED_HUB_CAP`、`SCHED_EVENT === SCHED_SSE_EVENT`）                                                                                                                                                                                                                                                                                                                 |
| `tests/web-hub/ui/schedule-state.test.ts`                   | reducer 5 项（接帧/拒坏帧/覆盖/hello 清空/caps 掉 sched.v1 清空）                                                                                                                                                                                                                                                                                                                                       |
| `tests/web-hub/ui/schedule-panel.test.ts`                   | 组件 15 项（列表/运行记录/离线只读/degraded/stale⇒`?`/空态/错过 chip/审阅流/批准参数断言/E_REV/离线无批准钮/非待确认无操作行/i18n 平价/详情头入口门控/卡片徽标）                                                                                                                                                                                                                                        |

### 挂接点最小改动

| 文件                                                    | 改动                                                                                                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/logic/state.js`                     | `case SCHED_EVENT`（校验后落顶层 `schedules` + `schedulesReceivedAt`，hello 清空、`hub` 帧 caps 掉 `sched.v1` 清空——与 `load` 同一规则）；文件头注释加段注            |
| `src/web-hub/ui/src/types.ts`                           | `HubState.schedules?: SchedulesPayloadWire` + `schedulesReceivedAt?: number`（`import type`，不进 bundle）                                                            |
| `src/web-hub/ui/src/components/detail/DetailHeader.vue` | 「⏰ 定时」按钮（仅门控 hub cap sched.v1 + sessionId，**不**门控 control —— 面板默认只读，离线可读）+ 懒加载 SchedulePanel（挂在 AgentDetail 树内，隐私重锁自动卸载） |
| `src/web-hub/ui/src/components/agents/AgentCard.vue`    | ⏰ 徽标（compact + detailed 两处，`compactChips` 加条件；只显示数量/`!`，沿用 needsAnswer「锁定卡片保留徽标」先例）                                                   |
| `src/web-hub/ui/src/styles/detail.css`                  | `.detail-sched-btn` 并入现有标题栏按钮族选择器（不复制语法、防漂移）                                                                                                  |
| `src/web-hub/ui/src/i18n/{en,zh}/agents.ts`             | `schedBadge` / `schedBadgePending`（徽标 title）                                                                                                                      |
| `src/web-hub/ui/src/i18n/{en,zh}/detail.ts`             | `scheduleOpenTitle` / `scheduleOpenLabel`（入口按钮）                                                                                                                 |

## 2. 关键决策（含 consult r_R8Q7WNM2 结论）

1. **首期写操作 = 仅「批准」**。创建/编辑表单（`/schedule __put <json> <hash>`）**未实现**，原因（consult Q1）：
   - `__put` 末尾的 hash 是「渲染后新定义的 defHash」，编辑还需 json 带 `baseHash` 做 CAS —— 该 json 结构 S0 未冻结，应由 **A3** 冻结；
   - 浏览器在明文 LAN 上无 `crypto.subtle`，**前端算不出 defHash**；需 A3 提供预览往返（如 `__put --preview`/`__hash` 只校验返回 hash，command-policy 需补一条 allow）。
   - 批准路径不受影响：投影自带完整 `defHash`，`/schedule approve <id> <hash>` 已冻结，本期已交付。
2. **`feishu: "?"`**（consult Q3）：hub 永不发送该值；hub 断连（`conn !== "open"`）时面板整体标 stale（横幅 + chip），所有 feishu 回执列渲染 `?`。数据缺失不按 `?` 处理。
3. **`SSE_EVENTS`**（consult Q4）：`schedules` 由 **H1** 加入 `protocol/http-contract.ts`（插到 `privacy` 之前、`agent_removed`/`spawns` 之前的既有位置约束内）。W1 **没有**在 transport 里另补监听名——`token-client.js`/`password-client.js` 遍历的是 `@protocol/http-contract.ts` 的同一个数组（anti-drift 设计），H1 落地后 UI 自动开始收帧。state.js 的 case 用的是 UI 侧镜像常量，并在注释里说明 `pinnedEvent` 漂移钉只能等 H1 后补。
4. **门控与零面**：所有入口（按钮/徽标/面板）都先查 hub caps ∋ `sched.v1`；reducer 的 `schedules` case 对无 cap 的 hub 永远收不到帧（transport 只监听契约事件名）。无 cap ⇒ UI 与现状字节一致。现有 golden 零改动（`git status` 确认 `tests/fixtures/**` 无变更；keepalive-golden、logic-state、i18n-parity 等全部通过）。
5. **离线只读（E3）**：`agent.down` ⇒ 提示「到任意本地终端执行 /schedule … --all」，审阅视图无批准钮；批准还需 control 通道（`enabled ∧ commandsEnabled`）。
6. **隐私锁**：面板/审阅挂在 AgentDetail 树内（DetailHeader 挂载点），重新上锁即整体卸载；卡片徽标只含数量，与 needsAnswer 徽标同例保留。
7. **cron 人类可读形式**：UI 不内置 cron 解析器——表达式 + tz 原样展示，「下次运行」用 hub 预算好的 `nextAt`（`fmtTs + relIn`）。
8. 面板打开时若 `schedules` 槽位尚未到达（hub 还没发过帧）显示空态；hub 重连后会随 `agents` 重发快照（H1 职责），属短暂窗口，已披露。

## 3. 与方案的偏差

| #   | 方案                                                        | 现状                                           | 处理                                                                                                                     |
| --- | ----------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | §5.6 审阅对话框含「编辑或新建使用同一个表单，提交 `__put`」 | W1 只做展示 + 批准                             | 见 §2.1：json 结构未冻结 + LAN 无 sha256；等 A3 冻结后由后续包补表单（UI 骨架已是独立组件，可直接扩展）                  |
| 2   | §5.6「`GET /api/schedules`」                                | W1 只用 SSE 槽位，未加 GET 客户端              | W1 行只列「useHub 订阅」；SSE 重连后 hub 重发快照（同 `load` 先例）。若联调发现需要主动拉取，再加 transport 方法（小改） |
| 3   | §5.6「hash 前 8 位」                                        | 审阅对话框 note 展示前 8 位；批准提交完整 hash | 与方案一致                                                                                                               |

## 4. 给下游的接口说明

- **H1**：把 `SCHED_SSE_EVENT`（`"schedules"`）加进 `protocol/http-contract.ts` 的 `SSE_EVENTS`（位置约束见该文件注释与 spawn/agent-remove 测试钉）；SSE 帧与 `GET /api/schedules` 载荷 = `SchedulesPayloadWire`，只可追加可选字段（W1 的 `isSchedulesPayloadLike` 容忍未知键但校验模板上消费的字段类型）；连接建立后随 `agents` 重发最新快照（`load` 先例）；`sched.v1` 从两个 caps 面消失时 reducer 会自动清空槽位。
- **A3**：冻结 `__put` json（含编辑用 `baseHash`）与「hash-of-rendered」的来源（建议预览往返子命令 + command-policy 补 allow，consult Q1 选项 a）。
- **F1**：回执词汇即 `SCHEDULE_RECEIPT_STATES` + `none|n/a|waiting|expired`；UI 在断连时自行渲染 `?`。

## 5. 自验

| 命令                                             | 结果                                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/web-hub/ui --maxWorkers=3` | 262 文件全过，5735 passed（含新增 36 项 schedule 测试）                                                              |
| `npm run typecheck`（tsc ×2 + vue-tsc）          | 通过                                                                                                                 |
| `npm run build:web && npm run check:web`         | 通过（86 files；首屏 356233B gz / 上限 524288B；lazy 81729B / 131072B；`SchedulePanel-*.js` 确认为独立懒加载 chunk） |
| `npx prettier --check`（本包全部改动文件）       | 通过                                                                                                                 |

未跑全量 `npm test`：本包只触碰 `src/web-hub/ui/src/**`，其全部覆盖就在 `tests/web-hub/ui/**`（已全绿）；S0 report 记录的 4 个基线失败与本包无关且不在本包文件域。

## 6. 遗留问题

1. `__put` 创建/编辑表单待 A3 冻结（§2.1）。
2. `SSE_EVENTS` 未含 `schedules`——在 H1 落地前，真实链路收不到帧（mock 测试已覆盖 reducer/组件）；联调项。
3. 面板在槽位未到时显示空态而非 loading（§2.8，已披露的短暂窗口）。
4. 未做真机浏览器走查：面板依赖 hub `sched.v1` cap + SSE 帧，H1 落地前无真实数据源；联调阶段需补一次 deveye 真机验收（移动端 ≤640px 底部弹层、隐私锁卸载、断连 stale）。
