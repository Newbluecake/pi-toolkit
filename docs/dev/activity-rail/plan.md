# Activity rail #41 / #42 — L2 联合方案与交互预览（B 已确认）

状态：用户于 2026-11-06 确认 D1=B；其它按预览。**没有待用户决定项**。已进入正式实现，源码文件域严格限定 §5；不改协议/设置/fixtures、不操作真实 hub、不提交 git。contracts.ts 经 root 本轮独占授权由同一实现包追加可选props/新增emit，不是放开冻结面。

## 1. 已确认范围与现状证据

- #41：两个独立入口，上 bot（Agent）、下 terminal（后台命令），各自运行计数，绝不混数。`fleetSummary(rows).running` 与 `summaryCounts(bashJobs).running` 分开；后者含 staged 非终态。新需求取代 2026-10-15 合并数字的旧拍板。
- active>0 才呼吸：3.2s opacity-only 光环，峰值 .22；idle 静止。图标tone、数字角标、aria-label 表达运行，不仅靠动画/颜色。reduced-motion 关动画、保留数字/静态圆halo。>99 显示 `99+`，aria-label 仍为全数。
- total=0 的类隐藏；有历史但无 active 保留静止入口。无两类记录则 rail 隐藏。
- #42：**只有 hover peek 保证主会话布局不变**。用户 B：点击固定恢复既有 viewport 模式，宽屏 docked 会变窄，保留持久化与默认打开；不是所有打开都 overlay。
- 120ms 进入 / 280ms 离开；focus 不 peek；点击固定，再点同类型入口关闭。pinned 时 hover 另一类型不切换，click 才切换。手机无 hover，click 沿 fullscreen。

| 现状证据（源码坐标为本轮只读快照）                                                              | 事实                                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/components/fleet/FleetSummaryBar.vue` L1–90，`styles/fleet.css` L29–85/L540 | 目前单按钮 `.fleet-summary-bar`、`aria-controls="fleet-drawer"`、bot + 合并 badge，absolute 锚在 detail-body                             |
| `components/detail/AgentDetail.vue` L525–555、L560–635                                          | 状态 owner，drawer 是 `.detail-split` 下 `.detail-main` 的兄弟；rail 却在 DetailBody 内，**现状不是同层**                                |
| `styles/detail.css` L675–700、`styles/drawer.css` L33–69                                        | split 已 position:relative；≥1280 docked grid 右列 clamp(480px,38vw,760px)，768–1279 overlay，≤767 fullscreen；原 docked-open 隐藏入口   |
| `components/drawer/FleetDrawer.vue` L24–85                                                      | useFleetDrawerMode/Open；storage `webhub.fleetDrawer.open` 默认非0即开；只 docked 持久；跨断点重置为新模式初态                           |
| 同文件 L456–512                                                                                 | onKey/onPointer 与 watch(open)；当前打开 overlay 一律 focus close，关闭 querySelector 首个 aria-controls（两按钮后会错误返 Agent）       |
| 同文件 L520–594                                                                                 | 单 tree-scroll 同时 FleetTree、FleetArchived、FleetBashJobs，选 run 后 RunHeader/RunTranscript；共享 fillBudget/archive toast            |
| `components/fleet/summary.ts` L96–106；`components/detail/bashJobsView.ts` L44–48               | 两类计数来源已存在，不需要新 wire                                                                                                        |
| `icons/IconSprite.vue` L61/L167；`icons/names.ts`                                               | 已有 bot、terminal，不新增图标依赖                                                                                                       |
| `components/quota/QuotaPill.vue` L132–134、L187–245                                             | hoverFine gate、peek 不抢焦点、双侧退出取消计时、click pins 的现成先例（约150/200ms）。本任务采用用户确认的120/280，沿其策略而非照抄数值 |

## 2. 可执行拓扑与定位（修正“假同层”）

**把 rail 挂载从 DetailBody 提升到 AgentDetail 的 `.detail-split`，与 FleetDrawer 共同使用 split 定位锚。**不 Teleport 到 body，不跨 CONTROL_CTX，不新增尺寸测量/动态内联 style。

目标 DOM（不必额外创建包裹 div，图示用于说明层级）：

```text
AgentDetail main.detail
  DetailHeader
  div.detail-split (position:relative; grid basis)
    div.detail-main (grid-column:1)
      DetailBody -> transcript （不再挂 rail）
      dock/composer
    FleetSummaryBar .activity-rail (absolute; right:20px; top:50%; z31)
    FleetDrawer #fleet-drawer (grid-column:2 if docked; otherwise absolute/fixed)
```

- rail 与 drawer 共同锚到 split（split 不含 DetailHeader，含 composer）。因此 rail 垂直居中以 split 为准，不再宣称严格位于 transcript 中点；固定44px点击区避免遮挡底部。预览已采用此层级。
- peek：drawer absolute、上下12px、right84px；`width:min(440px,calc(100% - 96px))`（**合法 calc 语法**），shadow/z30；与 rail 间透明桥20px。rail z31。split 保持单主列，主内容 bbox/scroll 恒等。
- pinned/docked：drawer grid-column:2，右列沿原 clamp(480px,38vw,760px)，取消圆角/浮层阴影。rail 仍在 split 右缘可见，便于同按钮关闭/切类型；drawer 内容右侧预留80px，避免 rail 覆盖操作。**这替换原 docked-open 全隐藏 rail 的 CSS，不改持久化。**
- pinned/overlay（768–1279）：继续 absolute，在 rail 左侧显示；主栏不变。
- fullscreen：fixed inset:0 z40，rail z31 被盖住；手机无 peek，不显示 pin 开关；只 close 按钮关闭。
- `container-type:inline-size` 保留在实际 `.tree-scroll`；既有 FleetTree 容器查询继续按面板可用宽而非 viewport，768/1024 截图/DOM回归必须覆盖。mock 同样有 container-type 与窄容器规则，但不冒充已运行正式 FleetTree 测试。

## 3. 模式乘积、开合属性与持久化

| viewport mode    | closed           | peek（仅 fine+hover，且 >767） | pinned                               |
| ---------------- | ---------------- | ------------------------------ | ------------------------------------ |
| ≥1280 docked     | 单主列，rail可见 | overlay，不写storage、不缩主列 | docked grid，主列变窄；写既有storage |
| 768–1279 overlay | 单主列           | overlay，不缩主列              | overlay，不持久                      |
| ≤767 fullscreen  | 单主列           | **禁止**（含接鼠标的窄手机）   | fullscreen，不持久                   |

状态分离：

- `useFleetDrawerMode` 保持 viewport 三模式不变；`useFleetDrawerOpen(viewportMode)` **只拥有 pinnedOpen** 和原 storage 的读写（默认开、key、storage失败回退全保留）。peek 不调用它的 open/toggle/close。
- `useActivityRail` 拥有 `peekPanel:null|agent|bash`、`selectedPanel:agent|bash`、triggerRef、openOrigin、120/280 timer。`open = pinnedOpen || peekPanel!==null`。生产初始化 selectedPanel 选有记录的 agent，否则 bash；**不新增 panel storage**。
- `effectiveMode = pinnedOpen ? viewportMode : 'overlay'`（仅 open 时有意义）；`dockedOpen = pinnedOpen && viewportMode==='docked' && selectedPanelHasContent`。
- `data-drawer` 继续描述 viewport；**仅 `data-docked-open` 驱动 grid 右列**，不再让 `data-drawer-open` 同时负责 grid。`data-drawer-open` 表达实际可见 open；新增 `data-peek-open` 表达 peek。rail 可见性仅按 hasRecords/fullscreen遮盖决定，不按 data-drawer-open 隐藏。
- 跨断点：先 cancel timers/clear peek，再由既有 useFleetDrawerOpen 按新模式初始化。入 docked 读旧 storage（未设默认开），入其它模式关；pointer 能力变为 coarse/none 也清 peek。不得把临时 peek open 写成 pinned storage。
- 数据更新到当前类无记录：先 deselect/清理对应订阅；若另一类有记录则切另一类，否则实际 open=false/rail隐藏，沿已有数据门控避免空 dock 列。关闭/切 bash 清 runSel，经 `hub.selectRun(key,null)` 退订；不在 UI 自建 transport。
- fillBudget：显示后 nextTick 实测，按 **effectiveMode/panel/open** watch + observeResize 重算；peek→docked需重新取 clientHeight/rowHeight，缓存按类型隔离，避免 peek 窄行高缓存误用。无测量保持既有 null 回退；不引 rAF 或新 ticker。

## 4. 状态机、焦点、交互升级

| 输入                                               | 转移与副作用                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| closed + pointerenter（fine/hover、>767、非touch） | 120ms 后 peek(panel)，记录触发按钮，不 focus，不写storage                                                              |
| peek + hover另一按钮                               | 立即换peek panel；cancel leave；更新 triggerRef                                                                        |
| peek + 离开按钮/面板/桥全部区域                    | 280ms后关闭，只清peek，不focus、不写storage、不误退订持久run                                                           |
| peek + 回到任一命中区域                            | cancel leave，保持打开                                                                                                 |
| peek + run查看/行内命令操作/归档/表单交互          | **先 cancel timer 并升 pinned，再执行原交互**（root技术裁定采纳），防止280ms退出导致run退订；升pin不重渲染替换点击目标 |
| 任意 + click入口                                   | 同panel pinned→close；其它→pinned(panel)，明确点击另一类型才切；desktop持久化遵循原规则                                |
| pinned + hover另一入口                             | 不切换、不降级、不写storage                                                                                            |
| pinned + pin取消                                   | 清pinned（desktop写0）→ fine非手机时peek；其它设备无此按钮                                                             |
| close/正确处理的Esc                                | 清peek、pinned，退订run；还焦点到记录的triggerRef或当前panel入口，再fallback transcript                                |
| pointer outside                                    | 仅 pinned/overlay 关闭；docked维持原行为不因外点关闭；peek靠离开计时；fullscreen无外部                                 |

**焦点 owner 唯一**：取消 FleetDrawer 的无条件 `watch(open)` 聚焦。打开原因 `hover | pointer | keyboard | restore | interaction`；**只有 keyboard Enter/Space 打开时 nextTick focus close**。hover/指针点击/恢复持久开/peek交互升级都不主动 focus，不能从 composer 抢焦点。原生点击本身产生的自然焦点允许。

关闭焦点：peek超时不还焦点；外点点击不抢回焦点；close/Esc在面板或其入口操作时还给**该 panel 的触发元素**。trigger disconnected/隐藏时按 `[data-panel="bash"或"agent"][aria-controls="fleet-drawer"]` 找当前类型，最后 transcript；不再全局 querySelector 首个匹配。保留 isComposing/defaultPrevented/input guards；peek时若composer仍持焦点不拦输入法Esc，避免导航副作用。

DOM操作采用 `pointerdown capture` 判定实际交互目标（button/link/input/select/textarea 等）只升级、不取消默认事件；FLEET_SELECT.select 包装再作防御性 promote；复用现 archive/select逻辑。focusin Tab进入peek面板也升级以免键盘操作中收起，focus进入入口本身不peek。

## 5. 文件域与兼容契约（已实现）

以下路径除另述均以 `src/web-hub/ui/src/` 为前缀：

1. `components/detail/AgentDetail.vue` L525–635：组合状态owner；提升 rail 到 split、属性拆分；显式 selectedPanel、triggerRef；唯一订阅关闭路径。
2. `components/body/DetailBody.vue` L14/L71–75：移除内部 rail 挂载与重复事件链，保留原无参事件接口兼容，不让生产同时挂两个rail。
3. `components/fleet/FleetSummaryBar.vue` L40–90：两个button均有 `data-panel`，按各类total门控；分计数/aria；新增类型化事件。
4. `composables/useActivityRail.ts` 新文件：纯前端状态机/timer/unmount清理；与既有 useFleetDrawerOpen组合，不重写其storage语义。
5. `components/drawer/FleetDrawer.vue` L24–85/L280–410/L456–594：effectiveMode、panel内容分流、预算、焦点原因、捕获升级；保留archive toast/CTRL上下文。
6. `contracts.ts` L320–420：**frozen，root明确本轮独占授权给此实现包，单writer收口**。保留 `toggle: []`、`toggle-drawer: []` 无参签名，新增 `"toggle-panel": [panel: "agent"|"bash", origin: "pointer"|"keyboard"]`、`"peek-panel"`/`"peek-end"` 等独立 emit；新增可选 prop `panel?`/`openOrigin?`/trigger信息。不把 toggle 改成有参冒充 append-only。
7. `styles/detail.css` L675–700（split基座）；`styles/fleet.css` L29–85/L540（rail）；`styles/drawer.css` L25–69（开合/grid/overlay/rail可见规则）：共同锚/有效模式精确选择器，CSS-only animation，禁 Vue Transition、rAF、内联样式。
8. `i18n/{zh,en}/fleet.ts`：命令标题、分项运行aria、固定/取消固定；inline marker 用 English tokens。
9. **必改测试**：`tests/web-hub/ui/{detail-body,fleet-bash-jobs,fleet-drawer,fleet-tree,checks-body-applicability,fleet-fill-budget,privacy-lock}.test.ts`；新增 `activity-rail.test.ts`。fleet-tree L429/L458旧按钮断言需类型化；fleet-drawer L129 的 `summaryBtn` 16处（不是35）替换成 `summaryBtn(type)`。
10. **必改视觉消费端**：`scripts/web-hub/visual/checks-body.ts` L119起、`scripts/dev/readme-shots/shoot-web.mts` L78。选择 `button[data-panel="agent"][aria-controls="fleet-drawer"]`（agent fixture），bash-only则选bash；读取**被选类型** `aria-expanded`，不能读rail容器或首匹配。applicability fixtures同步两按钮DOM。hover check只验证peek/bbox恒等；click check验证pinned、宽屏右列和bbox变窄/中宽不变；readme截图click明确类型并等有效模式/动画完成，禁止旧`.fleet-summary-bar`容器click。

兼容取舍：`FleetDrawerProps.panel===undefined` **仅兼容旧独立调用/旧测试**，继续混合 tree+bash render 与原联合预算（旧fillBudget测试保留）。生产 AgentDetail 所有挂载**必须显式传 agent|bash**，追加测试拦截未传；显式panel只render对应内容，计数不混。显式agent预算bash固定/终态计数为0，显式bash反之；联合纯算法无需改，新增隔离预算/resize测试。`FleetTree.vue`/`FleetBashJobs.vue`源码、wire/协议/hub/settings/icons/fixtures均不动；`fleet-tree.test.ts`不属于只读。

## 6. 13项评审处置表（全部采纳闭环）

| #   | 处置与源码落点                                                        | 本文落点 / 预览验证                            |
| --- | --------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | FleetDrawer L505 首querySelector改triggerRef+panel fallback           | §4；test bash close准确还焦点                  |
| 2   | FleetDrawer L496 watch(open)去自动focus，按openOrigin仅keyboard聚焦   | §4；1280/1024/768 composer hover保焦           |
| 3   | FLEET_SELECT/面板交互capture先promote再动作                           | §4；run-click→pin，退出不收                    |
| 4   | 补fleet-tree、applicability、shoot-web、checks-body必改，summaryBtn16 | §5-9/10；按type按钮读aria，hover与click分验    |
| 5   | 拆viewport×intent，真实split共同锚，docked-open单独负责grid           | §2/3；hover bbox恒等，1280click变窄            |
| 6   | 不改无参toggle，另加toggle-panel；frozen交root集中持有                | §5-6；无wire扩大                               |
| 7   | undefined保留合并兼容；生产显式panel；各自预算                        | §5末段；正式定向测试门禁明确                   |
| 8   | CSS合法min/calc，中宽容器查询                                         | §2；width-768.png、width-1024.png及各宽DOM测试 |
| 9   | pinned hover另一类型不切，click才切                                   | §4；三宽真实hover/click测试                    |
| 10  | storage key/默认开/断点规则保留，peek不写                             | §3；默认open、close后reload、pin存1            |
| 11  | 禁Vue Transition/rAF；外部CSS-only                                    | §5-7/§7；node语法检查                          |
| 12  | 关旧LAN服务；新测试只bind127.0.0.1并结束kill                          | §8；交付时8765无监听                           |
| 13  | 引QuotaPill L132–245 gate/双侧延迟先例；用户120/280                   | §1/§4；不是引新hover范式                       |

## 7. L2实现顺序、安全性能与#43避让

仍为 **L2**：单UI子系统，复用现有三模式/持久化，无新协议/设置/服务；B增加模式乘积测试，不构成跨系统L3。frozen contracts经root本轮单writer授权给本实现包，未授权其它包并改。

实施顺序：独立状态机及转移测试→本包独占追加contracts→AgentDetail挂载/分流→样式与焦点→visual消费端/定向回归→异源verifier。不要把#41/#42分成同时写FleetDrawer的两个包。

共享热点：AgentDetail、FleetDrawer、contracts、fleet/drawer/detail CSS、上述tests。#43在 `components/agents/AgentCard.vue` / `tests/web-hub/ui/agent-list.test.ts`，**零交集、不改动**；同树memory改动也不动。提交若授权必须精确路径，不git add -A；本阶段禁止git写。

CSP：无外网/新依赖/innerHTML/inline style/inline handlers；图标沿AppIcon；计时器仅两份、unmount清理；不新增rAF/轮询/transport监听；复用useHub单订阅。无新storage key；storage异常沿旧try/catch。动画只有光环opacity，面板CSS入场仅opacity/transform，reduce全关；不保证“打开不绘制”，只保证peek不产生主列布局改变。

a11y：两原生button、各自aria-expanded/aria-controls；panel标题随类变；docked用aside非modal，其余沿dialog/fullscreen modal语义；focus不peek、Enter/Space明确打开；真实focus trap/inert策略沿现fullscreen机制回归，mock不宣称覆盖正式modal完整性；触屏入口/关闭≥44px，生产行内操作沿既有44px规范。无title依赖。数字+SR状态表达而非纯色。

## 8. 本阶段自验与预览交付

目录 `/tmp/pi-previews/activity-rail/`：index.html、mock.js、mock.css、tokens.css；`desktop.png`=1280 hover、`desktop-pinned.png`=1280停靠、`width-768.png`、`width-1024.png`、`mobile.png`/`mobile-open.png`=375收起/展开。旧desktop-bash/idle截图不是本轮模式依据，已删除以免误认。

- `node --check mock.js`：通过。
- `node test.cjs`（复用已缓存Playwright/Chromium，不安装）：**51/51**，结果 `test-results.txt`/`run.log`。真实pointer/keyboard/tap；覆盖hover bbox/scroll严格恒等、composer保焦、桥/面板留存、离开退出、交互升pin、pinned hover不换/click换、焦点按类型归还、宽屏dock宽486.4px（1280×38%）、默认持久开/关闭reload、mobile无hover/fullscreen、reduced-motion静止。
- 截图等 `getAnimations().finished`，不截半透明入场中间帧；已自行读图。测试中短时间等待仅用于验证120/280时限负断言，其它用条件等待。
- Deveye skill已读。前轮实测连接的扩展远端Chrome截图报image readback failed、hover只生成非trusted mouse，故真实pointer/截图沿用本机cached Chromium，不碰真实hub。未装浏览器依赖。
- 临时HTTP测试过程：`timeout 120s python3 -m http.server 8765 --bind 127.0.0.1`，测试结束精确kill。旧0.0.0.0服务已结束；不遗留LAN服务。
- 只方案/独立mock：**本轮不跑正式UI build/typecheck/全量测试**（范围禁止）；实际执行node语法检查、真浏览器用例、本文Prettier检查。正式实现后必须跑定向UI测试、typecheck、build:web/check:web、format门禁及visual；tier1由root单份编排。

无剩余产品决策。历史mock不作为正式实现验收证据；以下新增实现记录为本轮证据。

## 9. 正式实现记录与用户外观修正（2026-11-06）

用户看到入口图后明确否定大框，root已收口：**只保留图标+右上角标**。本修正优先于旧mock的卡片/描边外观，交互B不变。

- `.activity-rail` 无白底、无边框、无阴影，pointer-events:none；每个button为透明44×44 hitarea、pointer-events:auto，无常驻方框/内描边。
- active：图标running tone + 数字badge；3.2s **圆形 radial-gradient** 光晕仅opacity呼吸，非发光方框。idle无背景/动画；reduce静态.1圆halo，仍保留badge。pinned只改图标tone。非键盘focus不留框；keyboard focus-visible仅简洁圆形高对比outline。
- `styles/detail.css` 已有relative split基座够用，实际无需修改该文件；rail从DetailBody提升到AgentDetail的split，两个独立按钮保留`.fleet-summary-bar` alias，privacy-lock测试同时验证新rail及全部aria-controls入口都不渲染。
- 首轮真实鼠标测试发现：pointerdown即pin+dock会移动目标，导致mouseup后的click落空（mock未捕获）。修复：**逻辑pin/取消leave计时立即发生，但layoutHeld让effectiveMode暂保持overlay**；目标click capture排microtask，在目标action执行后释放docked布局。FleetTree即使stopPropagation也能完成释放。不在pointerup微任务提前移动目标。
- 临时layoutHeld仅该手势存在：pointercancel/window blur直接释放；pointerup排**下一task**的0ms无click兜底，不是ticker；close、切类型、断点/能力变更、数据消失、unmount清除。watch(layoutHeld)同步注册/清理document pointerup/pointercancel与window blur，兜底timer一并清理，不能永久卡overlay。实际down/up/click恰一次subscribe；cancel/拖外释放/blur均不误订阅且回dock。
- fullscreen背景inert沿drawer祖先链覆盖main、rail、header、sidebar、topbar，保留先前inert值并在close/resize/unmount恢复；Tab边界循环，输入法/输入字段Esc guard保留。

### 正式证据（不是mock）

`/tmp/pi-previews/activity-rail/implemented-browser.mts` 使用createDevHub隔离fixture + 编译后的真实App/useHub/transport。createDevHub不提供run端点，因此**只对/api/run/_返回确定性202 ack_*（Playwright route），观察真实useHub发出的subscribe/unsubscribe请求；这验证客户端订阅生命周期，不宣称验证真实hub服务端run tap实现。其它静态资源/SSE/会话状态均走隔离dev hub，未接触用户hub/session。

- 1280、768、1024、375触屏、1024触屏、1280 reduced、bash-only：真实hover/down/up/click/tap测试；主栏bbox/scroll在peek前后严格相等，pin/dock才变窄；composer不丢focus；进入面板不收起；退出280ms关闭；pinned hover其它不切、click切；关闭按类型返焦。
- run-click从peek先pin后选择：subscribe恰一次，移出面板超过280ms无unsubscribe，切bash再发unsubscribe。关闭/断点/卸载同样走selectRun(null)；单测验证调用。默认storage开、close后reload已由单测/前期预览覆盖；正式实现保留useFleetDrawerOpen原函数。
- 截图已自看，新外观入口：`implemented-running-rail.png`、`implemented-idle-rail.png`、`implemented-reduced-rail.png`、`implemented-mobile-running.png`；全图`implemented-1280-hover.png`/`implemented-1280-pinned.png`/`implemented-1280-bash.png`，中宽`implemented-768-hover.png`/`implemented-1024-hover.png`，手机`implemented-375-touch-pinned.png`，bash-only`implemented-1280-bash-only-hover.png`。
- `implemented-browser-results.json`保存逐项断言、订阅请求证据、console/pageerror零错误；`implemented-appearance-results.json`保存rail/button computedStyle（透明、无border/shadow、44px）。所有脚本timeout且finally close浏览器和loopback devhub；不遗留服务。
- 正式门禁日志：`implemented-typecheck.log`、`implemented-ui-tests.log`、`implemented-build-web.log`、`implemented-check-web.log`、`implemented-format.log`。精确文件清单`implemented-files.txt`。最终结果在交付报告列出；不跑全量tier1/secure、不git写。

正式门禁最新一轮：UI 286 files / 6285 tests 通过；npm run typecheck 通过；build:web + check:web通过；真实浏览器112项通过、4组外观computedStyle和截图通过。无协议、settings、fixtures、package改动；无遗留devhub。
