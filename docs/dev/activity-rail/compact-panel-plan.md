# Task60 · 紧凑 Activity 面板布局方案（L2）

状态：**用户已确认开发；Sonnet（run_id: r_9AB4HADW）条件通过，本文闭合3项机械细节；Root核闭合后派前端开发。**
制定模型：`localcodex/gpt-6-astra`。本轮只修订本文及交接JSON，不实现源码、测试、README 或配置。

## 一页摘要

- 已定产品范围：**彻底取消展开面板右侧整列预留，入口改位**；不是把 84px 改成 60px，也不是隐藏 Agent/Bash 功能。
- 手动/锁定展开：同一组 Agent/Bash 入口横排进面板头部正常文档流；列表、头部、子详情恢复普通内边距。docked 列宽策略不改。
- hover：保留原右缘悬浮入口及其 DOM，面板与按钮净距由 20px 收到 **8px**，桥同步为 8px。按钮仍为 44×44，不移走正在 hover 的按钮。
- 保留分项计数、99+、完整可访问名称、badge、既有 pulse、焦点归还、pin/close、子详情返回、类型切换及订阅生命周期。
- 不新增模式、settings、resize handle、动画、图标资产、tooltip 业务；不移到主 transcript 上方覆盖文字，不改数据/协议。
- 技术取舍：尺寸优先 CSS；单实例入口在两个**局部稳定宿主**间用 Vue Teleport 移动，避免双份按钮/状态。只有打开完成且非 held 时才入头部。
- 主要代价：头部容纳 44px 命中与 badge；子详情保留自己的 RunHeader，公共入口行增加一行高度，由现有 fill/滚动布局消化，不用右侧空列换高度。
- 验收核心：展开时右侧无专用空带；hover/held 不抖动、不漏 click；窄宽可点、键盘可达、479/599 容器跳档与高度预算正确。
- live 资源本轮不可覆盖；后续只用 own outDir + 隔离 fixture 浏览器验收，不能把源码通过说成 live 已生效。

## 1. 核验依据与新旧口径

以下路径前缀为 `src/web-hub/ui/src/`，行号是方案核验快照。

| 依据                                                        | 当前事实 / 方案约束                                                                                                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `styles/drawer.css:43–65`                                   | docked 的 tree-scroll/drawer-head/run-head 被加 84px padding；overlay right=84、width=min(440px,100%-96px)，桥20。删除整列预留，不删正常8/12px padding。 |
| `styles/fleet.css:2–46`                                     | rail 默认 right8，fine 指针 right20，top50%；44px 按钮。hover 按 fine 几何计算，不能把所有指针都当 right20。                                             |
| `components/detail/AgentDetail.vue:549–577,637–667`         | 唯一 rail owner；docked-open 按 effectiveMode；一个 SummaryBar 与 Drawer 同属 split。                                                                    |
| `composables/useActivityRail.ts:20–60,112–163`              | peeking 或 layoutHeld 均保持 overlay；held 在动作完成后释放。仅 effectiveMode 无法区分手动 overlay 与 held。                                             |
| `components/drawer/FleetDrawer.vue:430–455,523–560,583–651` | 按类型还焦点、capture 后释放、fullscreen inert/trap；列表头和 RunHeader 是互斥分支，不能把唯一入口放进会销毁的分支。                                     |
| `components/fleet/FleetSummaryBar.vue:17–73`                | 计数/按钮过滤和既有事件已齐全；复用组件，不复制计算和事件处理。                                                                                          |
| `styles/fleet.css:602–646`；`FleetDrawer.vue:298–395`       | 599/479 容器断点；ResizeObserver 测量实际高度和行高，显式 panel 预算分流。                                                                               |

旧 `activity-rail/plan.md` §2 的“预留80px”由本文替代；实际源码是84px。
web-hub README 的“absolute overlay, never a reserved column”描述收起/手机入口，不应继续被理解为展开内容也保留右带。
`styles/agents.css:1134–1178` 的 #51 Bash **terminal+count 整块背景 pulse**与 rail 原有圆 halo 是不同对象：两者原样保留，不能用旧 rail 文案把 #51 改回圆圈。
实施成功后再更新 web-hub README，说明三种入口位置、held 和预算；本轮不修改它，也不重写旧设计史。

## 2. 最小结构与几何

### 2.1 单实例、局部双宿主

1. AgentDetail 保留唯一 FleetSummaryBar 和所有既有 props/events。`.detail-split` 保持 position:relative；其直属常驻 `[data-rail-host="floating"]` 为 position:absolute/inset:0/pointer-events:none，是浮动 `.activity-rail` 的定位祖先，rail 仍 absolute/top50%/right按指针规则，按钮 pointer-events:auto。
2. FleetDrawer 在 tree/run 分支**之前**保留公共头部行，提供可选 `activity` slot；AgentDetail 在 slot 放常驻 `[data-rail-host="header"]` 并持有 ref。header host 是 drawer-head 的正常流 flex item（position:static、display:flex、flex-shrink:0），不以split作绝对定位基准；slot是拟新增局部模板接口，不改 `contracts.ts`。
3. 单个 Teleport 在 AgentDetail 内将同一个 SummaryBar 移到这两个 HTMLElement ref 之一；不 Teleport 到 body，不使用全局 selector/id 寻址，不复制组件。
4. useActivityRail 只读暴露现有 `held`（layoutHeld的readonly/computed视图），派生 `panelFloating = peeking || held`；入口宿主用 `!open || panelFloating` 选floating，其余选header（含fullscreen），不新增状态/模式。AgentDetail显式传 `:floating="panelFloating"` 给FleetDrawer；后者仅在本文件将props类型局部扩展为 `FleetDrawerProps & { floating?: boolean }`，不改contracts。局部 `resolvedFloating = props.floating ?? props.peeking ?? false`，根绑定 `:data-floating="resolvedFloating || undefined"`（false时移除属性）；旧独立调用未传时以peeking回退，生产必传，不能由mode猜测。
5. host 在组件挂载期稳定存在；header host 不随 tree/run/type 切换销毁。初次 ref 未就绪时 Teleport disabled，nextTick 取宿主；不能先向不存在的字符串 target 传送。
6. Drawer 原有内容存在性门控不变；全部记录消失/隐私锁卸载时 Teleport 同步清理。保留唯一 `id="fleet-drawer"`、每种类型最多一个按钮及既有 aria-controls，无新公共 ID。

**为什么不纯 CSS 硬定位：** rail 当前是 aside 的兄弟；closed aside 为 display:none，fullscreen 又会 inert 背景兄弟。
只把 rail 用绝对坐标压到头部会造成占位/Tab 顺序/模态包含关系不一致；单一局部 Teleport 能让展开入口真实参与头部布局和 trap。
样式仍全部在 CSS；不引坐标测量、inline style、rAF、全局状态或新依赖。

### 2.2 头部、子详情与间距

- 公共头部从原 drawer-head 提升到分支外：列表时标题、入口、既有 pin/close；子详情时入口+pin，下面保留原 RunHeader 的 back/name/status/close，**不再重复公共 close**。
- `[data-rail-host="header"] .activity-rail` 明确覆盖为 `position:static; inset:auto; transform:none; z-index:auto; display:flex; flex-direction:row; gap:8px; flex-shrink:0`，并设 `padding:0; background:transparent; border:0; border-radius:0; box-shadow:none`；规则优先于fine/手机floating样式，只清容器装饰，不改按钮badge/pulse/focus。floating host继续沿用手机backdrop。
- header rail及每项按钮flex-shrink:0，保留44px；头部普通左右padding，block padding4（基本行高至少52px）给badge/focus空间。标题min-width:0可截断；窄到放不下只头部换行，不侵入正文。
- 子详情的 RunHeader 不改接口；正文/run-head/tree-scroll 均无84px额外 padding。back、close、状态仍可达，不隐藏类型入口。
- docked：沿现有 clamp(480px,38vw,760px) 列宽；删除43–46行 override，无新右列、margin或等价 spacer。
- `.fleet-drawer[data-mode="overlay"]:not([data-floating])`：manual right12px，width:min(440px,calc(100% - 24px))，top/bottom12px；无外侧rail栏/bridge，宽度上限不借机扩容。
- `.fleet-drawer[data-mode="overlay"][data-floating]`：hover/held共用fine rail外缘20 + hit44 + gap8 ⇒ **right72px**；width:min(440px,calc(100% - 84px))，窄split左缘至少12px；桥right:-8px/width8px。
- bridge渲染条件为 `mode === "overlay" && resolvedFloating`（resolvedFloating与根data-floating同源）；manual overlay无桥，hover/held桥连续。fullscreen inset0，头部入口位于modal内，不盖正文。
- hover 到 held 必须维持同一几何规则，不能仅由 data-peek-open 驱动：held 时 peeking 已为 false。

## 3. 布局与可点矩阵

| 场景                                      | 入口 / 面板布局                                   | 必须可点及过渡                                                                   |
| ----------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| ≥1280 收起 → manual/default-open docked   | 收起在原右缘；展开进头部，内容普通padding         | Agent/Bash切换、同类关闭、pin/close；默认持久开同样无空列                        |
| 768–1279 manual overlay（fine/coarse）    | 入口在头部，right12，不占外侧按钮栏               | 两类型及close可达；hover另一类不换类型，click才换；外点沿旧关闭                  |
| >767 fine hover peek                      | 入口不迁移，right72/gap8/bridge8；主栏不缩        | 120ms开、280ms离开关；跨桥不关；hover不抢composer焦点                            |
| peek → pointerdown promote → held → click | held全程保留floating宿主、overlay尺寸与header高度 | 先逻辑pin，目标action完成后才迁移；click恰一次；cancel/up兜底/blur释放仍沿旧机制 |
| pinned → unpin                            | 回原floating宿主、peek几何                        | 不多触发toggle，不残留桥/悬空焦点；沿canPeek门控                                 |
| ≤767 fullscreen（含fine鼠标）             | 打开后入口进modal头部，关闭回原手机backdrop       | 无hover/pin；两类型、close、Tab trap；背景inert恢复；44px不缩                    |
| 子详情（各打开模式）                      | 公共入口稳定，RunHeader保留back与close            | back退选但不关闭；Bash切换退订；close/Esc归还当前类型；长名字不挤掉按钮          |

焦点：Teleport 移动可能使浏览器丢焦点；仅当移动前焦点属于被移动按钮，且无更高优先级打开/关闭焦点动作时，nextTick 将焦点还给**同一节点**，不一律 focus。
keyboard打开仍聚焦close；hover/pointer/默认恢复不主动抢焦点。close/Esc先关闭并迁回floating，再按原trigger/同类型fallback归还；outside/timeout不归还。
原 restoreTrigger 的 isConnected/hidden 不足以证明可见：增加实际可见且非inert校验，避免聚焦 display:none 祖先内按钮。
fullscreen 的初次迁移须在既有 nextTick inert 收集前完成/核验；关闭恢复inert后再归还。不要双建焦点owner。

## 4. 容器、fills 与 scrollbar 门禁

- `.tree-scroll` 继续是 inline-size query container 和唯一列表纵向 scroller；没有新的内容包裹层改变尺寸基准。
- 取消84px后跨479/599跳档是**正确的可用宽变化**，不以 viewport 模拟；实际 content-box 取478/479/480、598/599/600逐点验证。
- 保留现行 fillBudget 纯算法、用户show-all覆盖、单类型独占预算、undefined panel旧混合兼容；不改 fillBudget.ts。
- 复用ResizeObserver；将 `resolvedFloating` 加入FleetDrawer现有预算失效watch，改变时清行高缓存并nextTick重测。held释放即使effectiveMode仍是overlay，也因floating从true→false触发重测；不可只watch mode/peeking。零测量仍null回退，无新timer。
- 测量基于clientHeight减padding，不用scrollHeight反馈预算；行宽跳档重取行高，避免旧窄行高缓存制造少行/空白。
- 普通预算样本不新增纵向溢出；地板超高/用户show-all/长日志允许原有纵向滚动；禁止新增横向滚动、双层滚动和吞掉最后一行/折叠钮。
- hover前后主transcript bbox与scrollTop严格不变；docked因既有列分配变窄不算回归。入口和scrollbar命中区域不能交叠。

## 5. 两包最小 DAG / 文件域

`用户确认已完成 + Sonnet条件项已写入 → Root核闭合` → **P1布局与行为+定向单测** → **P2隔离浏览器验收+实施文档** → Root异源验收。
两包有硬依赖，不伪并行同改热点；root已确认与58integration/59source/61plan不相交，开工前复查变更快照。

| 包  | 允许文件（相对仓库）                                                                                                                                                                                                                                                                        | 交付                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| P1  | `src/web-hub/ui/src/components/detail/AgentDetail.vue`、`components/drawer/FleetDrawer.vue`（后者同UI前缀）；`src/web-hub/ui/src/composables/useActivityRail.ts`；`src/web-hub/ui/src/styles/{drawer,fleet}.css`；`tests/web-hub/ui/{activity-rail,fleet-drawer,fleet-fill-budget}.test.ts` | 单实例迁移、CSS布局、focus/held回归；SummaryBar和RunHeader原则上只读复用，无需改props/emits |
| P2  | `docs/dev/web-hub/README.md`；临时浏览器脚本/fixture/截图/日志仅 `/tmp/drawer60-validation/`                                                                                                                                                                                                | 实现后文档；真实编译UI验收报告和截图。若需持久probe另报root确认路径，不扩本包               |

冻结：useHub、contracts.ts、types.ts、全部protocol/wire/hub/agent/fabric、设置/配置/package、所有现存fixtures/golden、fillBudget.ts、agents.css(#51)、动画keyframes。
不改新图标/i18n/tooltip业务，不新增resize handle；冻结面确实阻塞时停下报root，不通过类型断言绕契约。

## 6. 精确验证表（实施阶段，不冒充已运行）

| 层          | 输入                                                                          | 断言                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 组件/状态   | fake timers；agent-only/bash-only/both/none；默认开/关闭/切类型               | 同一button节点跨宿主仍相等、每类唯一；badge/aria全计数；timer120/280、存储语义、无额外订阅                                             |
| held交互    | 真实down/up/click、拖出、cancel/blur；viewport1024与1280                      | down→click目标bbox不变；held期间data-floating仍在、right72/bridge8；释放后manual overlay为right12/无桥且预算重测；click/订阅恰一次     |
| 视觉几何    | viewport375/767/768/1024/1279/1280/1600；明暗、fine/coarse                    | open内容padding非84/60；header rail computed为static/row/gap8/shrink0且无手机背景边框阴影；44×44；hover净距8±1px；不交叠内容/scrollbar |
| 容器与fills | content-box478/479/480/598/599/600；大量terminal、live、archive、长名、长日志 | 断点computed grid正确；重测后预算/行数对应真实高度；无横向溢出；显示全部仍可滚到底                                                     |
| 键盘/焦点   | Tab/ShiftTab/Enter/Space/Esc、IME/input Esc；bash触发后close；peek→pin        | opens focus close；返回同类型；hover不抢焦点；fullscreen循环含header入口且背景inert；不留display:none焦点                              |
| 外观不变    | active/idle/99+、reduced motion、单按钮/双按钮、子详情                        | badge不裁切、focus ring可见；原pulse样式/周期不变，#51整段背景不被圆halo替代；back/pin/close可点击                                     |

实施命令：`timeout 180s npm run typecheck`；`timeout 180s npx vitest run --project tier1 tests/web-hub/ui/activity-rail.test.ts tests/web-hub/ui/fleet-drawer.test.ts tests/web-hub/ui/fleet-fill-budget.test.ts`。
补跑现有 `fleet-tree`/`fleet-bash-jobs`/`privacy-lock`/`detail-body` 定向回归；daily tier1由Root统一编排，不在方案阶段跑fulltests。
构建用 `timeout 180s npm run build:web -- --outDir /tmp/drawer60-validation/ui`，绝不覆盖dist/live资源；仅串行一次构建，注意Vite provenance仍写共享cache。
浏览器复用已有本机工具，不安装；隔离dev hub显式root指向own outDir、只bind loopback，用确定性fixture，无真实模型/API；run ack可本地拦截但须数真实客户端请求。
截图与断言结果保存至上述/tmp目录；浏览器/服务timeout且finally关闭。不要拿旧mock或live旧bundle充当验收。
私有产物门禁采用**一次性临时检查脚本** `/tmp/drawer60-validation/check-private-ui.mts`，通过仓库tsx执行，显式读取own outDir；不运行固定dist的CLI冒充本次检查，也不改仓库脚本/配置：

- 复用真实导出 `src/web-hub/hub/ui-root.ts` 的 `verifyUiRoot(dir,{version,protoMajor})`，version取仓库package、PROTO取现行协议；断言ok并检查额外文件白名单，不能仅“不抛异常”。该函数不是 `scripts/web-hub/ui-root.ts`。
- 复用 `scripts/web-hub/lib/ui-provenance.ts` 的 `verifyProvenance/verifyNaming/verifyImplChunk/verifyFirstScreenDisjoint/verifyNoKatex/verifyLicenses`，以及 `check-ui-dist.ts` 导出的 `classifyJsAssets/scanForbiddenPatterns/gzipBytes/budgetExceeded`；所有errors数组必须为空。
- 串行构建后立即复制本次provenance到私有目录并记录hash，核对其每个JS哈希；许可证输入只读仓库notices/overrides/vendored和已安装package facts，不使用旧sidecar或自动生成notices。
- 按 `check-ui-dist.ts:368–460` 原门禁逐项编排，补齐未导出的index CSP、路径/hash命名、CSS motion改写、manifest及首屏/lazy/mermaid/CSS预算检查；阈值/允许规则原样沿用，不降低门禁。脚本、产物hash、逐项结果落/tmp；任一失败阻止交付。
- 如需避免复制私有检查细节，可将**原检查脚本及只读依赖**复制到/tmp mirror root，私有构建放其真实 `dist/web-hub-ui` 目录（不可symlink绕过信任检查），依原入口执行完整门禁；不得指向或覆盖工作仓库dist/live。此为执行方式，不再是待拍板前提。

## 7. 条件项闭合与交付冻结

Sonnet（run_id: r_9AB4HADW）的3项条件已分别落在§2.1/2.2（宿主定位与CSS重置）、§2.1/2.2/4（局部floating数据口及held重测）、§6（私有产物门禁）。无剩余产品或接口开放问题；Root核闭合后派开发，不需用户再拍机械细节。

本轮仅修订本文与handoff；handoff为 `/tmp/drawer60-plan-handoff.json`，含fileIndex/evidence/ruledOut/openQuestions与本文SHA-256。
冻结后任何方案修订先通知Root；不得自行开编码、commit/push、reload或替换live资源。
