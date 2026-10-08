# quota-web · 订阅额度 Web 展示（顶栏 pill + 弹出卡）

v1 · 2026-10-08 · 状态：mockup 已经用户确认（「效果预览可以满足要求」），待实施

## 0. 决策记录（全部已拍板）

| #   | 决策          | 结论                                                                                                                                                                                                                                                |
| --- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 展示位置      | **全局顶栏 pill + 弹出卡**（用户先选 DetailHeader 后改判顶栏：quota 是机器级资源，手机详情页也要可见）                                                                                                                                              |
| D2  | 信息深度      | MVP：pill 摘要 + 弹出卡三 provider 完整行；不做历史燃速曲线、不做设置展示                                                                                                                                                                           |
| D3  | 数据源        | 零新采集：agent 侧读 per-session `QuotaService` 的 `verdicts()`（内存），不走任何新网络请求                                                                                                                                                         |
| D4  | 传输          | `StatusInfo.quota?` 可选 slot（append-only、无 proto 升级，同 todo/worktrees/bashJobs 先例）                                                                                                                                                        |
| D5  | 全局化方式    | 数据仍随主会话 StatusInfo 走，**UI 壳层**从所有已订阅会话里取 `at` 最新的一份提升到 TopBar——协议零改动                                                                                                                                              |
| D6  | pill 文案规则 | pill 只显示「全 provider 最严重的一格窗口」（等级优先、并列取 usedPct 高者）；**5h 窗 usedPct>70% 时 pill 追加 5h 重置时间；5h 与 7d 同时触界（各自 ≥L1）时优先展示 7d 重置时间**（用户 2026-10-08 补充）。弹出卡内各窗重置时间常显，不受此规则影响 |
| D7  | L0 可见性     | L0 时 pill 安静常显（灰绿点 + `GLM 5h 62%`），不隐藏                                                                                                                                                                                                |
| D8  | 敏感面        | LAN 可见内容仅百分比/时间/等级，无任何费用数字；设置门 `webHub.quota`（默认 on，off ⇒ sampler 不挂、wire 字段不出现、字节等同现状）                                                                                                                 |
| D9  | i18n          | 全部文案走 zh/en 双侧新命名空间 `quota`，做双语样板（回应当天「多处英文」反馈）                                                                                                                                                                     |

mockup：`/home/bluecake/shots/quota-mockup.html`（8901 端口伺服，LAN 可看）——桌面/手机/L0–L3 四档 pill/双窗同越界优先级全部已演示。

## 1. Wire 形状（protocol/messages.ts，additive）

```ts
export interface QuotaWindowWire {
  scope: "5h" | "week";
  usedPct: number; // 0..100
  level: 0 | 1 | 2 | 3;
  resetAt?: number; // epoch ms
  etaMs?: number; // 预测耗尽还剩；不燃烧/样本不足时缺省
}
export interface QuotaProviderWire {
  id: "zai-coding-cn" | "zai" | "kimi-coding";
  plan?: string; // GLM 档位（max/pro…）
  level: 0 | 1 | 2 | 3; // provider 级 = 窗口 max
  stale: boolean;
  demotedUntil?: number;
  windows: QuotaWindowWire[];
}
export interface QuotaWire {
  v: 1;
  at: number; // 采样时刻（多会话提升时取 at 最大者）
  providers: QuotaProviderWire[];
}
// StatusInfo 追加：quota?: QuotaWire（absent = 无凭据/功能关闭/未采样，字节等同现状）
```

倒计时/相对时间全部由 UI 用绝对时间戳本地渲染——sampler **不**为倒计时做周期重推。

## 2. agent 侧（新文件 `src/web-hub/agent/quota-sampler.ts` + 接线）

- 源：`src/index.ts` 的 `holder.current.quota`（`verdicts()`），经 wireWebHub deps 传入 getter（同 `todo: () => todoWiring.getTodoSnapshot()` 先例）。
- 指纹门控发布：fingerprint = 每 provider (level, demotedUntil?, stale, 每窗 usedPct 取整, resetAt 分钟, etaMs 分钟) 的 JSON；不变不发。单飞、所有 timer unref、print 模式惰性。
- `webHub.quota === false` ⇒ 完全惰性。

## 3. UI 侧

- `ui/src/logic/quota.js`（纯逻辑，可单测）：`freshestQuota(sessions)`、`pillView(quota)`（D6 规则完整实现）、`fmtCountdown/fmtClock`。
- `components/shell/TopBar.vue`：conn pill 后插入 `<QuotaPill>`；弹出卡锚定同 SettingsOverlay 机制（Esc/外点关闭、归还焦点、aria-expanded/controls）。
- 新 `components/quota/QuotaPill.vue` + `QuotaCard.vue`：pill 四档着色（token：L0 ok/L1 warning/L2 orange/L3 danger，⚠ 前缀仅 L3）；卡片每 provider：名+plan 徽章+（demoted ⤓恢复时间 / stale 年龄徽章），每窗：进度条（等级着色）+百分比+重置倒计时，ETA<reset 时红字「按当前速率约 X 耗尽」；底部采样说明+fetchedAt。
- `styles/quota.css`（`q-` 前缀、token-only）；`i18n/{en,zh}/quota.ts`（glob 自动收录）。
- 手机 ≤767px：pill 收缩为 `⚠ 84%` 最短形态；弹出卡近全宽（mockup 已演示）。

## 4. 文件域

新增：`agent/quota-sampler.ts`、`ui/src/logic/quota.js`、`ui/src/components/quota/{QuotaPill,QuotaCard}.vue`、`ui/src/styles/quota.css`、`ui/src/i18n/{en,zh}/quota.ts`、`tests/web-hub/agent/quota-sampler.test.ts`、`tests/web-hub/ui/logic-quota.test.ts`、`tests/web-hub/ui/quota-pill.test.ts`。
改：`protocol/messages.ts`（additive）、`agent/index.ts`（deps 接线）、`src/index.ts`（传 getter）、`ui/src/components/shell/TopBar.vue`、`ui/src/composables/useHub.ts`（ hoist freshest——若 hoist 放 App.vue 侧则改为该文件，交付时说明）。
冻结：hub/**、src/quota/**（只 import 类型）、preview/diff/worktree 相关、其余 i18n 命名空间。

## 5. 测试与验收

- logic-quota.test.ts：pill 选择（等级优先/并列取高 pct）、**D6 双规则**（5h>70% 带重置；双窗触界 7d 优先）、freshest 多会话挑选、countdown 格式化。
- quota-sampler.test.ts：指纹门控（不变不发/变化发）、无 verdicts 时不产出字段、dispose 幂等。
- quota-pill.test.ts：四档着色 DOM、pill 文案规则端到端（组件级）、弹出卡开闭/Esc/归还焦点、badge（demoted/stale）、无数据零渲染、移动形态。
- i18n-parity / source-scan 自动覆盖。
- 验收：`npx vitest run tests/web-hub/ui tests/web-hub/agent tests/web-hub/contract && npm run typecheck`（**build:web 不在主工作树跑**——D5 在飞文件会污染 bundle；合入时主会话在干净 worktree 构建验证 gzip 预算 208 KiB）。

## 6. 排期

与 D3（hub/**）、D5（diff 组件/DetailHeader/WorktreePanel）文件域零交集，可立即并行。D6（worktree-diff 集成）不收口于本包。

## 7. 2026-10-08 用户裁决：多组 pill 与 GLM 合并（修订 §3 的单一最差窗口规则）

用户裁决（两连发，原文）：

> 顶部状态栏展示什么订阅可用、什么不可用；GLM 与 GLM 国际值相同时只显示 GLM，不同时分别展示。
> 如果有可用订阅，只展示可用订阅；如果都耗尽了，展示 7d 重置时间。
> （展示可用订阅时 5h 额度也要展示，不只展示最差窗口。）

### 7.1 逻辑层（`ui/src/logic/quota.js`）

- `pillGroups(quota)`：每 provider 一组（快照序；无窗 provider 跳过）。组字段：headline（该 provider 最差窗：level 降序、usedPct 降序）、`windows[]`（**双窗**，5h 在前 week 在后，各窗各自取整 pct）、`weekResetAt`（week 窗 resetAt；无 week 窗则 headline 窗的 resetAt）、D6 重置后缀（按该 provider 单独判定：week 触界⇒week 重置；5h 触界且 >70%⇒5h 重置；双触界⇒week）、L3 组恒带已知恢复时间（D6 无解时回退 headline 的 resetAt）、`available: level<3`（L3 = spawn 闸门快败 = 不可用）。`pillView`（旧单选视图）保留导出、行为不变，仅测试在用。
- `glmMergeable(a,b)`：相等定义 = window scope 集合相同，且每 scope 的 `level` 相同、`Math.round(usedPct)` 相同（原始 pct 在同一取整桶内仍算相等；NaN 永不相等）。只对 `zai-coding-cn`/`zai` 生效。
- `glmPair(providers)`：**唯一**的合并判定实现，pill（`pillGroups`）与卡片（`QuotaCard.cardRows`）共用，绝不各写一份。返回 `{skip, source, members}`：`skip` = 快照序靠后的成员（不再独立成组/行）；`source` = 恒为 cn 侧（合并组的窗口/数值来源）；`members` = `[cn, intl]`（与快照序无关，供徽章聚合）。合并组位置 = 两成员中**先出现**的那个的槽位，标签恒 `labelId:"zai-coding-cn"`（"GLM"）。
- `pillDisplay(quota)`：pill 展示选择（§7.2 两模式）；无组 ⇒ `null`（不渲染 pill）。
- 防御性 wire 策略（verifier 2026-10）：未知 provider id（未来 wire 对端）直接以裸 id 作标签（组件层 `t()` 回退到 key 时降级为 id）；非有限 `usedPct` 一律按 0% 处理——`normPct` 让比较与显示一致（NaN 窗不抛错、不漏 `NaN%`、不会在并列时挤掉有限窗）。均不抛错。

### 7.2 pill 两模式（`QuotaPill.vue`）

- **available**（≥1 组 level<3）：只渲染可用组；每组一段 `.q-seg`：自身色点 + `Label 5h p% · 7d p%`（**双窗**，5h 在前；单窗 provider 只显示那一窗）+ 该组 D6 重置后缀（`· {clock} 重置`，规则不变）。耗尽组不出现在 pill 面（弹卡仍是全量列表）。
- **exhausted**（全部 level=3）：每组渲染 `⚠ Label · 7d {clock} 重置`——clock 取 `weekResetAt`（week 窗优先，无 week 窗回退 headline 窗；未知则省略 clock，只剩 `⚠ Label · 7d`）。标签永不替换，⚠ 只是前缀。
- aria/title 恒覆盖**全部**组（含被隐藏的耗尽组，`; ` 连接各组既有 aria 句式）——屏幕阅读器/悬停仍可发现隐藏组。
- 移动（≤767px）：available ⇒ `Label p5/p7`（如 `GLM 17%/43%`）；exhausted ⇒ `⚠ Label {clock}`（如 `⚠ GLM 10/14 15:48 · ⚠ Kimi 10/12 09:06`），无 clock 则 `⚠ Label`。
- 组间分隔：桌面 1px 细分隔线（`.q-sep` 内嵌 `·` 被 CSS 裁掉），移动端显示 `·` 字符——与重置后缀自身的 `·` 不混淆。
- pill 自身 `data-level` = **展示组**的最大 level（边框/背景四级色阶不变）；段落级 `.q-seg[data-level=N]` 各自点色（success/warning/orange/danger），仅 L3 段落文字升级 danger+semibold，可用组保持 muted。
- 宽度约束（verifier #3）：`.q-pill { flex: 0 1 auto; min-width: 0; max-width: min(60vw, 640px) }` + `.q-pill-text` ellipsis——多个告警组不把顶栏右侧控件挤出视口；完整文本在 aria/title。

### 7.3 弹出卡（`QuotaCard.vue`）

- 仍是全量 provider 列表（含耗尽的）；同样的 `glmPair` 合并：相等 ⇒ 一行 "GLM"（位置=先出现成员槽位，窗口行取 cn 侧），不等 ⇒ 两行 GLM / GLM 国际。
- 合并行徽章聚合（verifier #2，绝不丢成员标志）：plan 去重各一枚；demoted 取**最早**恢复时间；每个 stale 成员各保留一枚带自身年龄的 stale 徽章（demoted 与 stale 可并存）。未合并行保持合并前的行为（demoted XOR stale、单 plan）。

### 7.4 测试锚点

- `tests/web-hub/ui/logic-quota.test.ts`：`glmMergeable` 表、`pillGroups`（排序/headline/双窗/weekResetAt/合并/拆分/单侧/倒序/重置后缀矩阵/防御性 NaN+未知 id）、`pillDisplay`（mixed ⇒ 只可用；全耗尽 ⇒ week 重置；单 provider；GLM 同耗尽仍合并；无 week 窗回退）。
- `tests/web-hub/ui/quota-pill.test.ts`：两模式渲染端到端（含 aria 覆盖隐藏组、移动形态、`⚠` 前缀永不替换标签）、卡片倒序回归 + 徽章聚合、CSS 锚点（分段色阶、pill 宽度约束）。
