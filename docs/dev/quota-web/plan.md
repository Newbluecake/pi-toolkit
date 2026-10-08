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
