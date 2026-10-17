# web-hub-version V2（前端）实施报告

> 状态：**完成**。包域严格限定 `src/web-hub/ui/**`、`tests/web-hub/ui/**`、`tests/fixtures/version/**`；未触碰 V0 冻结面（`protocol/version.ts`、`protocol/version-info.ts`、`hub/ports.ts`、`protocol/http-contract.ts`）与 V1 域（`src/web-hub/hub/**`、`protocol/paths.ts` 及其测试）——工作树里这些路径的改动全部来自并行的 V1。未执行任何 git stash/checkout/reset/commit。

## 改动文件清单

### 纯逻辑（`src/web-hub/ui/src/logic/`）

| 文件                                     | 改动                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build-stamp.js`                         | §5.1：`shortCommit` 兼容 hub buildId 的 `*` 脏后缀（修复 `abc1234*` ⇒ `null` 的存量 bug）；新增 `tabAssets(doc)`（启动时从自身 DOM 收集 `script[type=module]`/`link[rel=stylesheet]` 的 `/assets/*`，排序去重；空 ⇒ `null`=未知，dev server 下不误判）                                                                                                                |
| `version-match.js`（新）                 | §4 全部规则：`versionMatch()`（9 类 finding、dot 汇总 warn>info、dirty 只出 info 行不亮点、unverifiable 台账、其他会话 older/newer/drift 汇总计数、uiStatus/sessionStatus 状态词）+ `parseHubUiFrame`/`parseCommitRefLoose`/`compareVersions`/`sessionStatusOf`。hub 侧 commit 一律 `bootHead ?? buildId`；`ui-drift` 被 `tab-stale` 抑制；所有输入防御式收窄、永不抛 |
| `contract.js`                            | `API.versionInfo = VERSION_INFO_PATH`（`@protocol/version-info.ts` 引入，防漂移）+ `VERSION_INFO_CLIENT_TIMEOUT_MS = 15_000`（覆盖 hub 4s 预算与 LAN `deriveBudget(8000,…)` 的客户端 padding）                                                                                                                                                                        |
| `token-client.js` / `password-client.js` | 各自新增 `versionInfo(signal)`：`wtdiffGet`（`X-PWH:1`、body 上限 `VERSION_LIMITS.bodyBytes`=64KiB、`parseVersionInfoWire` 契约门、E_ABORT/E_DEADLINE/E_NETWORK 本地码），`{ok:true,data}` 形状对齐 `loadTop`                                                                                                                                                         |

### 传输（`src/web-hub/ui/src/transport/`）

- `types.ts`：`VersionInfoOutcome`（同 `LoadTopOutcome` 两半形状；命名注释说明 ≠ V0 hub 端口同名类型）+ `HubTransport.versionInfo?(signal?)`（可选，缺失按无 cap 处理）。
- `token.ts`：`withAuthNotice` 薄包装；`password.ts`：直通 + `REST_AUTH_PATHS` 精确匹配项 `API.versionInfo`（401 ⇒ 登录视图，不双发）。

### 组合式与组件（`src/web-hub/ui/src/composables/`、`components/shell/`）

- `useVersionInfo.ts`（新）：`idle|loading|ok|error|unsupported` 状态机；cap 缺失 ⇒ `unsupported` 且**永不请求**；单飞（并发 refresh 共享一轮）；结果过 `parseVersionInfoWire` + `pid:startedAt` 代际过滤（settle 时与当前帧不符 ⇒ 丢弃，代际变化 ⇒ 清空快照）；`visibilitychange` 成对注册/注销、可见且 ≥10min 且有 cap 才刷新；`match` 为响应式 computed（hub 帧/选中会话/快照变化即重算，前端零轮询零定时器）。`VERSION_CTX` 由 TopBar provide，popover 与设置卡共享同一实例（D4：共用单飞）。
- `VersionHost.vue`（新，首屏）：`defineAsyncComponent`（loader=VersionPanel、timeout 8000、errorComponent=VersionLoadError）；popover 模式照 SettingsOverlay 桌面分支（Esc `preventDefault`、外部 pointerdown 关闭+防焦点抢占、焦点进面板/回 chip）；`embedded` 模式无外壳直渲染面板（设置卡用）；重试=key 重建。
- `VersionLoadError.vue`（新，首屏）：`stale`（§4 已证实 tab-stale）⇒「页面版本已过期」+ 刷新；否则「面板加载失败」+ 重试，**绝不声称过期**。
- `VersionPanel.vue`（新，懒块）：六区（建议 / 界面 / hub / 当前会话 / 仓库 / 更新日志）；tab-stale 用刷新按钮、其余 finding 用 `detail/CopyButton.vue` 命令（§4 右列映射）；hub 运行时长打开时计算一次（`up 3h 12m` 英文标记）；仓库提交纯文本插值；changelog 仅经 `transcript/MarkdownView.vue`（零 v-html）；cap 缺失 ⇒ 5/6 区替换一行「hub 版本过旧，升级后可见」；快照 loading/error/分段 error 各有降级文案；`onMounted → refresh()`（打开面板/设置卡才请求）。
- `TopBar.vue`：`topbar-meta` span ⇒ `.version-anchor > button.topbar-meta.version-chip`（`aria-haspopup/expanded/controls`，`id=version-panel`）；chip 内 + 齿轮内各一个 0/1 项 `v-for` 圆点（无发现/无法验证 ⇒ 零节点）；`useVersionInfo`+`provide(VERSION_CTX)`+卸载时 `dispose()`。**模版注释节点逐字节保持原样**（Vue 在测试下渲染注释，历史金样钉住了它们；V2 说明移入 script 注释）。
- `SettingsView.vue`：「版本」卡（`settings-card-wide`，无条件渲染——无 cap 时面板自身降级为一行提示），内联 `<VersionHost embedded />`；桌面设置面板与手机 sheet 共用同一 SettingsView，D4 的「设置弹窗内联」在两个分支自动成立。

### 样式 / i18n

- `styles/version.css`（新）：chip/dot（`--c-warning`/`--c-info`）、齿轮镜像圆点 <1025px 显示、popover（CSS 锚定 `.version-anchor`，同 `.settings-panel` 层级）、面板各区、embedded 紧凑间距。`shell.css`：`.topbar-meta` 的 ≥1025px 显示规则改挂 `.version-anchor`（基 `display:none` + `min-width:0` 链）。
- `i18n/{en,zh}/version.ts`（新，zh `satisfies` 对齐 en）：紧凑标记（`ui 0.5.5@33a89f1`、`dirty`、`up 3h 12m`、命令串）双语均英文 token，散文中文。删除 `detail.ts` 的 `versionMismatch`（zh+en，全仓无引用）。

### 测试（`tests/web-hub/ui/`、`tests/fixtures/version/`）

- `version-match.test.ts`（新，31 用例）：§4 逐行 + 每条 finding 的消失条件；assets 不同但 commit/builtAt 相同 ⇒ tab-stale；hub.ui 缺失+cap ⇒ ui-unservable 而非 refresh；`hub-disk-changed` 与 `ui-drift` 可共存（向后回退的 HEAD 也只算 differ，R2#4）；newer managed agent ⇒ agent-newer 而非 agent-older；dirty 同 HEAD 不亮点；nogit/unknown/npm 与旧 hub 回落矩阵；summary 计数（含 semver-older 无 outdated 旗标的会话——测试驱动出的逻辑修正）；`tabAssets` 收集/排序/空 ⇒ null。
- `version-info-composable.test.ts`（新，14 用例）：unsupported 永不请求；单飞；代际过滤与代际清空；垃圾体 ⇒ error；失败后可恢复；visibilitychange 成对+10min 下限+无 cap 不触发；match 接线（选中会话切换改 sessionStatus）。
- `version-panel.test.ts`（新，13 用例）：chip 按钮语义与文案；干净态零圆点；ui-unservable ⇒ chip+齿轮各一个 warn 点；popover 开关/Esc preventDefault+焦点回 chip/外部 pointerdown 关、内部不关；六区齐全、5/6 折叠 `<details>`、changelog 走 MarkdownView、打开才请求 1 次；cap 缺失 ⇒ 0 请求+一行提示+无 repo/changelog UI；hub 区字段+`up 3h 12m`；dirty 行渲染但无点；embedded 无 dialog 外壳且挂载即请求；仓库数据纯文本。
- `version-panel-lazy.test.ts`（新）+ `version-panel-lazy-reject.test.ts`（新）：挂起 loader ⇒ 7999ms 不出、8000ms 出 errorComponent（已证实 stale ⇒ 「已过期」分支）；loader 被拒 + stale 未证实 ⇒ 「加载失败」而非「过期」；`VersionLoadError` 两分支直挂单元测试 + retry emit。（两文件分离：vitest 模块 mock 工厂每文件只结算一次，见文件头注释。）
- `quota-pill.test.ts`：**历史金样原样保留**；比较前做经审计的限定归一化（`.version-anchor` 子树 ⇒ 旧 `<span class="topbar-meta" translate="no">…</span>`，字符串级、无 DOMParser），其余 DOM 逐字节比对（54 用例全过）；新增 `version-anchor-golden.html` 逐字节钉新子树（`UPDATE_VERSION_GOLDEN=1` 脚本化再生成）。
- `build-stamp.test.ts`：`*` 后缀用例；`.topbar-meta` 断言改为 BUTTON。
- `settings-overlay.test.ts`（+2 用例）：设置弹窗内联版本卡、5/6 折叠、打开设置才请求端点（VERSION_CTX 单飞）。
- `logic-contract.test.ts`（+1 用例）：`API.versionInfo === VERSION_INFO_PATH === "/api/version"`。

## 偏差与说明（均为小项，无范围外文件）

1. **`hub-disk-changed` 与 `ui-drift` 可同时出现**（repo HEAD 变化时被服务 bundle 也落后于 HEAD）——两行各自为真、建议动作不同（restart / rebuild），§4 未规定互斥，按条件原样实现并在测试钉住。
2. **summary 的 older 计数**把「semver 旧但无 hub 侧 outdated 旗标」的会话也计入（与 `sessionStatusOf` 对选中会话的判定一致）——测试驱动出的逻辑选择。
3. 运行时长标记为 `up 3h 12m`（复用 `logic/duration.js` 仓库标准格式），计划写作 `up 3h12m`——纯空格差异。
4. **懒块重试的「loader 再次调用」断言**在 vitest 模块 mock 下不可实现（工厂结果按文件缓存），改为：retry 点击 emit + 宿主存活的轻断言 + `VersionLoadError` retry 单元测试；8s 超时与「加载失败≠已过期」分支均已钉死。
5. `useVersionInfo.refresh()` 在 hub 帧到达前是 no-op（cap 未知 ⇒ 永不请求），面板挂载早于首帧的极端竞态不重试——真实时序里 hub 帧在任何用户操作前到达，未加补偿机制。
6. `AgentCard.buildId` / `HubInfo.ui` / `bootHead` 无需 UI 侧镜像改动：卡片与 hub 帧在 `state.js` 整体镜像（`Record<string,unknown>`），`version-match.js` 防御式解析即消费；`logic/contract.js` 的「镜像」落为 `API.versionInfo` 常量镜像（`logic-contract.test.ts` 钉住）。
7. 面板打开时若 cap 已到但 hub 帧尚未携带 `ui`（理论窗口），按规则出 `ui-unservable`——`hub.ts`（V1）构造后即 probe，实际不可达。

## 自验输出（真实命令与结果）

```
$ npx prettier --write <changed 29 files>
# 全部格式化完成（列出省略；多文件 "(unchanged)"）

$ timeout 280 npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
# 无输出 = 零错误（含 V1 已完成的 hub 文件）

$ timeout 580 npx vitest run tests/web-hub/ui
 Test Files  179 passed (179)
      Tests  4219 passed (4219)
      Duration  25.69s

$ timeout 300 npm run build:web && timeout 120 npm run check:web
✓ built in 5.02s
✓ check:web — dist/web-hub-ui/ OK (15 files, first-screen JS 268383B gz/524288B, lazy JS 39871B gz/131072B, CSS 29026B gz/65536B)
```

预算解读：懒块新增 `VersionPanel-*.js` ≈ 11.7 KiB raw（≈4 KiB gz，符合 §5.3 预估）；首屏 +2.7 KiB gz（chip/dot/Host/LoadError/composable/i18n），远低于 512 KiB 报警线；CSS 全量 29 KiB gz / 64 KiB。

## 未完成 / 移交项

- **§8 真机验收**（tmux：各 finding 出现/消失、`tab-stale` 刷新语义、481–1024 设置卡、旧 hub 降级）属 V3 集成包，未在本包执行。
- `ui-unservable`/`tab-stale` 依赖 V1 的 `hub.ui` 广播与 `/api/version` 端点真联调（V3）。
- 未跑全仓 `npm test`（17k+ 测试，非本包门禁且 V1 并行改动中共享套件；本包门禁 = ui 套件 + typecheck + build:web + check:web，全绿）。

## R1 rework（2026-10-17 用户真机检查后返工，基于 79a4aa3，未提交）

用户 hub 仍是旧 hub（未重启、无 `version.v1`）；按四项问题返工：

### 1. 弹出方式对齐 QuotaPill/QuotaCard + LoadPill/LoadCard

- **`TopBar.vue`**：chip 侧照 `QuotaPill.vue` 的 pinned+peek 状态机逐行复刻（无共享组合式可引，LoadPill 也是同样内联复刻）：`versionPinned`/`versionPeek`，`open = pinned || peek`；点击 = 切换 pinned 并清 peek；hover peek 仅 `(hover: hover) and (pointer: fine)` 且非 ≤480px——~150ms 进入延迟、~200ms 关闭宽限，卡片 `mouseenter` 取消待关闭（listener 经 attrs 落到 VersionHost 根元素）、`mouseleave` 重新排程；卸载时清理两个定时器。按钮新增的只有事件绑定，渲染 DOM 逐字节不变（quota 金样与 version-anchor 金样均未重抓、仍全过）。
- **`VersionHost.vue`**：新增 `peek` prop + QuotaCard 的 `wasPeek` 挂载快照语义——peek 挂载不取焦点、卸载不「归还」焦点；点击固定挂载才 focus-in/focus-return。Esc `preventDefault` + 外部 pointerdown（排除锚点、`preventDefault` 防焦点抢占）不变。
- **CSS**：`shell.css` `.version-anchor` 加 `position: relative`（成为卡片的定位祖先，同 `.q-anchor`/`.ld-anchor`）；`version.css` `.version-pop` 重写为 QuotaCard/LoadCard 卡片几何——`position:absolute; top:calc(100% + 6px); left:0; z-index:30`、`--r-md`/`--sp-3`/surface/shadow-3、`max-height + overflow-y:auto`（原来是右锚 `right:0` 的 560px 浮层，视觉与层级都不同）。设置卡内联（embedded）模式不变；懒加载 VersionPanel + errorComponent 不变。
- pin-on-top-of-peek 不重挂载（QuotaPill 原语义），焦点不因 pin 移动——按复用模式原样保留并测试钉住。

### 2. i18n 原始键泄漏（bug）

`VersionPanel.vue` 三处模板字符串拼键全部改为静态映射：`version.sessionStatus.${x}` → `SESSION_STATUS_KEYS`（i18n 定义的是扁平 `sessionStatusSame` 等）；**同类排查又发现两处**——`version.sectionError.${x}` → `SECTION_ERROR_KEYS`（同样拼错，repo/changelog 分段错误文案此前也会渲染原始键）。新增 27 键 × en/zh 双语解析测试（`t(key) !== key` 且非空），覆盖 sessionStatus×5、status×3、sectionError×5、finding 文案×10、uiServedNone/uiServedUnverifiable。

### 3. 旧 hub 的「hub 正在服务」行

`hub.ui` 缺失按 cap 分流：有 cap ⇒ 「无（无可服务的 UI 根）」（ui-unservable 证据文案）；无 cap（旧 hub）⇒ 新键 `uiServedUnverifiable`「无法验证（hub 版本过旧）」（en: "unverifiable (hub is older — no version info)"）。两条路径均有面板测试。

### 4. ui-drift 按实际参照物措辞

`version-match.js` 的 ui-drift finding 新增 `ref: "repo" | "hub"`（比较右操作数来源：repo.head vs hub 自身 commit）。面板按 ref 选词：repo ⇒ 「UI 构建与仓库 HEAD 不一致…」（原文案）；hub ⇒ 新键 `findingUiDriftHub`「UI 构建与 hub 构建 commit 不一致（暂无仓库信息），可尝试重新构建 UI」。matcher 与面板双层测试各覆盖两分支。

### 自验输出（真实命令与结果）

```
$ npx prettier --write <changed 10 files>   # 全部完成（多文件 unchanged）

$ timeout 280 npm run typecheck
# 零输出 = 通过（一次 exactOptionalPropertyTypes 报错已修：textKeyOf 参数 ref?: string | undefined）

$ timeout 580 npx vitest run tests/web-hub/ui
 Test Files  180 passed (180)
      Tests  4259 passed (4259)        # R1 前为 179/4219，+40 用例（hover/peek×5、措辞×4、i18n×27、ref 断言等）

$ timeout 300 npm run build:web && timeout 120 npm run check:web
✓ built in 5.12s     （VersionPanel-DmbXYGOm.js 12.28 kB）
✓ check:web — dist/web-hub-ui/ OK (16 files, first-screen JS 270271B gz/524288B, lazy JS 41621B gz/131072B, CSS 29246B gz/65536B)
```

金样：`topbar-no-quota-golden.html` 与 `version-anchor-golden.html` 均未重抓、逐字节仍然通过（改动只加了事件绑定与 CSS，closed 态 DOM 不变）。范围外零触碰（并行 P2 html-preview 的 preview/logic/transport/i18n 文件未动）；未提交。
