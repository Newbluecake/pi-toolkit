# web-hub 文件预览多窗口（弹窗内点文件链接开新的可拖动窗口）：实施方案 r2

> 状态：r2 修订稿。依据评审 `review-r1.md`（打回，#1–#14）和用户 2026-10-21 的最新拍板，重写 r1。调研全程只读，基线是仓库 HEAD `e3d33494`，演示页参考 `/tmp/pwh-demo/preview-windows.html`。
> 继续沿用 r1 的 spike 结论：在 happy-dom 里，`matchMedia` 按 innerWidth 求值，`inert` 和 `setPointerCapture` 都存在；`:style` 的对象绑定在 `style-src 'self'` 下有效，依据是 `csp-probe/Probe.vue:29-30`，以及评审方核实过的 Vue 3.5.43 `patchStyle → style.setProperty` 路径。

---

## r2 修订记录

| 来源                              | 处理                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 章节             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 用户 1：桌面改为非模态            | 桌面端根节点改为 `.preview-overlay.is-windows.is-modeless`：`pointer-events:none`，没有遮罩层（scrim），不锁 body 滚动，z 层级降到新档 **25**。每个窗口是 `role=dialog aria-modal=false`，桌面端不做 Tab 焦点陷阱。Esc 只在焦点位于某个窗口内时关闭该窗口。对话里点路径改为**追加**窗口：从活动窗口错开摆放，触发去重和上限检查。层级与其它浮层逐一定档，见 §5.1。4 处 `OVERLAY_ROOTS` 收敛成一个共享常量，并排除非模态根节点（§5.2）。composer 的快捷键逐键核对，见 §5.6 | §5               |
| 用户 1：手机仍用全屏叠层          | `<768px` 时根节点不带 `is-modeless`，保留 z60 和滚动锁；只有顶层窗口可交互，`aria-modal=true`，焦点陷阱只在顶层内循环；非顶层加 `inert`                                                                                                                                                                                                                                                                                                                                   | §6               |
| 用户 2：目录列表的文件/symlink 行 | file 行开新窗口。symlink 行和 other 行类型未知，走「推测开窗 + 回折」（§3.3）                                                                                                                                                                                                                                                                                                                                                                                             | §3               |
| 用户 3：去掉「点空白处全部关闭」  | 非模态下没有遮罩层。每个窗口标题栏加「⋯」窗口菜单，内含「全部关闭（N）」「重置位置和大小」和窗口列表；菜单完全可用键盘操作                                                                                                                                                                                                                                                                                                                                                | §5.5             |
| 用户 4：高度、上限、同路径        | 默认高度为 `min(85vh, 900, 可用高度)`。上限 6 个，超限时在发起窗口内打开，并显示 `role=status` 提示。同路径已经打开时：提到最前，**并且转移键盘焦点**                                                                                                                                                                                                                                                                                                                     | §3.4、§4.3、§5.4 |
| 用户 5、评审 #1（阻塞）目录路由   | 判定为已知目录的链接一律在发起窗口内 `navigate`：md 的 `dir:true`、`probe.kindOf==="dir"`、目录行。未知类型（symlink 行、未探测的 md 链接）先开新窗口；如果首次结果是目录，就**回折**到发起窗口并关闭这个新窗口。补齐相应用例                                                                                                                                                                                                                                             | §3.2、§3.3       |
| 评审 #2 HTML 凭据被 FIFO 驱逐     | 删掉 r1 里「6<8 大体受保护」的错误论证。首版做纯前端方案：一份标签页级凭据账本，模拟 hub 的每 principal 8 个凭据 FIFO 加 TTL，在「可能已被驱逐」时给出确定性的失效提示；「重新加载」按钮改为**常驻**。hub 侧的释放端点单列为可选包 W-H，附安全论证，推荐首版不做（待拍板）                                                                                                                                                                                                | §8               |
| 评审 #3 aria 语义矛盾             | 桌面端没有任何 `aria-modal=true`，所有窗口都是非模态对话框（有 ask-float 先例），不再出现「活动窗口模态、却能跨窗切换」的矛盾。手机端只有顶层 `aria-modal=true`，其余窗口加 `inert` 退出无障碍树                                                                                                                                                                                                                                                                          | §5.3、§6         |
| 评审 #4 inert 与焦点查询          | 桌面端不做陷阱，所以没有跨窗口的焦点查询。手机端的陷阱只查顶层窗口，并且用 `focusablesIn()` 显式过滤掉 `[inert]`、`[aria-hidden=true]`、`[hidden]` 子树。测试覆盖双向边界、焦点落在 panel 自身、关闭顶层、跨断点                                                                                                                                                                                                                                                          | §6.2             |
| 评审 #5 去重转焦点、加载期去重    | 去重的依据是窗口当前 `view.path`，**包括 loading 阶段**。把「提到最前」和「转移焦点」拆成两件事，由 manager 发出 `focusRequest`，宿主在 nextTick 落焦。发起窗口已关闭时，这次打开是空操作                                                                                                                                                                                                                                                                                 | §4.3、§5.4       |
| 评审 #6 tree 请求遇到会话变更     | 明确会话变更覆盖的请求集合：主请求、415 回退、分块流、**tree**。tree 回调发出前先校验代际和 scope 键；manager 只在 scope 键等于当前键时才 closeAll                                                                                                                                                                                                                                                                                                                        | §4.4             |
| 评审 #7 source-scan 下载例外      | 下载链搬到 `composables/usePreviewDownload.ts`，例外条目精确迁移到这个文件；`source-scan.test.ts` 列入 W2 的文件域                                                                                                                                                                                                                                                                                                                                                        | §9、§11          |
| 评审 #8 pointer capture 失败      | 统一一个手势控制器。capture 失败或没有生效时，改挂 document 级监听并按 pointerId 过滤。以下情况都会结束手势：pointerup/cancel、lostpointercapture、blur、页面隐藏、跨断点、关窗、卸载                                                                                                                                                                                                                                                                                     | §7.4             |
| 评审 #9 几何约束没有闭合          | 有效最小尺寸取 `min(MIN, 可用)`，约束优先级写成表；错开摆放遍历候选槽位，最后兜底到原点；部分离屏后缩放的规则单独定义；补纯函数用例和属性测试                                                                                                                                                                                                                                                                                                                             | §7.3             |
| 评审 #10 上限提示调用链           | 所有入口统一走 `openWindow`，提示由 manager 的 `limitNotice` 发出，窗口内用 `role=status` 显示，清除时机有定义。逐个入口测试                                                                                                                                                                                                                                                                                                                                              | §3.4、§4.3       |
| 评审 #11 内存上界                 | 新增跨窗口的全局**历史快照字节预算**（桌面 96 MiB，触屏 32 MiB），超出时把最老的快照降级为「重新加载桩」；单窗 `usePreview` 不注入，行为不变。给出当前视图的上界算式和压力验收标准                                                                                                                                                                                                                                                                                        | §4.5、§14        |
| 评审 #12 键盘可达                 | 标题栏可以获得焦点：方向键移动，Shift+方向键缩放；菜单里有「重置位置和大小」；对话与窗口之间用 Ctrl+` 切换                                                                                                                                                                                                                                                                                                                                                                | §5.5、§5.6、§7.5 |
| 评审 #13 与 mermaid 的依赖        | 把容器 ResizeObserver 写进 mermaid P2 的文件域和验收；本方案 W4 加一条联合验收                                                                                                                                                                                                                                                                                                                                                                                            | §13              |
| 评审 #14 legacyFace               | **删除**生产代码里的遗留适配分支。PreviewHost 只认 windows face；测试用 `tests/.../helpers/preview-windows-fake.ts` 测试替身，并说明哪些用例走生产路径                                                                                                                                                                                                                                                                                                                    | §9、§10.2        |
| 任务新增：对话与窗口的键盘切换    | `Ctrl+`` / `Ctrl+Shift+``，语义类似 Alt+Tab 的 MRU 环（对话 → 活动窗口 → 更早激活的窗口）；有模态层打开或正在输入法组合时不生效；不与 composer 冲突（待拍板键位）                                                                                                                                                                                                                                                                                                         | §5.6             |
| 评审「已核查项」：list 路由       | 更正 r1 §3.4 的说法。手机端切到 list 时 reducer 把 selected 置为 null，scope 随之失效，所以会 closeAll。加真实路由集成断言                                                                                                                                                                                                                                                                                                                                                | §4.4、§10.2      |
| preview-perf P0：几何变量非继承   | §7.1 的 `--pw-x/y/w/h/z` 在 `styles/preview.css` 以 `@property` 注册为不继承（syntax `<length>`×4 / `<integer>`，`inherits:false`，见 preview-perf plan §3）——避免每次拖动/激活/缩放重算整棵内容子树样式；R2（不用 transform）不变，写入端仍只经 `varsOf`/`zOf` 的对象式 `:style`                                                                                                                                                                                         | §7.1             |
| preview-perf P3/P5 补登           | 大源码预览体（>600 行非流式 / 一切行号开流式，构建期开关 `PREVIEW_VIRTUAL_ENABLED`）改用 `VirtualCode` 32 行块虚拟渲染，窗口几何与手势零改动；虚拟体内 Ctrl/⌘+F 拦截为窗口内查找栏（焦点在查找框内再按一次放行给浏览器页面查找；Esc 只关查找栏不关窗），完整视图是窗口级开关（渲染与行号关同径的单文本 DOM，跨导航保持）；高亮经 P5 Worker 放宽闸门（256 KiB/80k token，粘滞回落主线程原闸门）。详见 preview-perf plan r3 §4–§5 与 P3/P5 报告                             | §5、§7           |

---

## 1. 结论摘要

- **状态层**（W1）：从 `usePreview` 抽出 `createPreviewMachine(deps)`，`usePreview` 保留为单窗包装，`use-preview.test.ts` 原有用例不改。新增 `usePreviewWindows` 作为窗口集合 manager，DOM 无关，可以在 node 里测：scope 和 probe 全局一份，每个窗口一台状态机。新增全局历史预算，以及只给多窗用的 `adopt`/`navEpoch`。
- **路由**：判定为已知目录的链接在发起窗口内进入；文件开新窗口；未知类型推测开窗，结果是目录就回折。对话里点击总是追加窗口。上限 6，超限在发起窗口（对话里点击时为活动窗口）内打开并提示。同路径（含加载中）已打开时提到最前，并转移焦点。
- **桌面非模态**：根节点不拦截指针，每个窗口 `role=dialog aria-modal=false`；没有遮罩、滚动锁和 Tab 陷阱。层级新增 **25** 档：在 composer、dock、对话之上，在抽屉、弹出卡片、ask-float 和所有模态之下（§5.1）。Esc 只关闭焦点所在的窗口。「⋯」菜单提供全部关闭、重置和窗口列表。Ctrl+` 在对话和窗口之间按 MRU 环切换。
- **手机**：全屏叠层，实质上是模态（z60、滚动锁），焦点陷阱只在顶层窗口，非顶层加 inert。
- **拖动和缩放**：对象形式的 `:style` CSS 变量，配合 `left/top`，不用 transform。z 序只改变量，**绝不重排 DOM**，避免 iframe 重新加载。手势控制器负责兜底清理。几何约束完全闭合，有键盘等价操作。
- **HTML 凭据**：前端账本做确定性的「可能已失效」提示，「重新加载」常驻；hub 释放端点作为可选包 W-H，推荐首版不做。
- **拆包**：W1 状态（L2）→ W2 窗口组件与非模态外壳（L3）‖ W3 跨切面集成（L2，可与 W2 并行，最后合）→ W4 文档与真机（L1）；W-H 可选。

---

## 2. 现状坐标（改动起点）

| 位置                                                                                                     | 现状                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `composables/usePreview.ts:198-715`                                                                      | 单个闭包，包含 scope（201）、tree 抓取（273-288，失败直接返回 `{ok:false,error}`，**不经过 settleError**）、scope watcher（313）、settleError（322，遇 session-changed 就 close）、probe（360）、流（401-510，`d.close` → close）、`settleOutcome`/415 回退（528-620）、`load/open/navigate/back/up/retry/dispose` |
| `usePreview.ts:163`                                                                                      | `asDirHandle()` 鸭子类型，冻结类型约定的先例                                                                                                                                                                                                                                                                       |
| `components/preview/PreviewHost.vue`                                                                     | 只有一个 panel。子树重新 provide `open→navigate`（110-125）；`onDirEntry` 处理 dir/文件/symlink（137-152）；`onPathBarGo`；下载链与 `saveBlob`（`URL.createObjectURL`，266-345）；焦点、滚动锁、Tab 陷阱、Esc（354-420）；模板是 `.preview-overlay@click.self` > `.preview-panel[role=dialog][aria-modal=true]`    |
| `components/transcript/MdInline.vue:50-56`                                                               | `resolveMdLinkTarget` 产出 `{path, dir}`，`dir` 时调用 `open({path, dir:true})`                                                                                                                                                                                                                                    |
| `components/preview/PathText.vue:146-198`                                                                | 「先探测后标记」：只有探测确认的路径才可点击，所以点击时通常已经有 `probe.kindOf(path)`                                                                                                                                                                                                                            |
| `composables/usePreviewProbe.ts`                                                                         | 按 scope 键分组；`kindOf` 的结果是 `"text"\|"image"\|"dir"\|"file"\|"missing"`；探测走完整准入链（realpath），symlink 指向目录时会回答 `dir`                                                                                                                                                                       |
| `components/preview/PreviewDirRows.vue:118-168, 258`                                                     | 目录行：单击展开，双击或 Ctrl/Cmd+Enter 进入（emit `navigate`）；文件和 symlink 行单击 emit `navigate`（带 parentPath）                                                                                                                                                                                            |
| `protocol/preview.ts:384`                                                                                | 目录项类型：`"dir"\|"file"\|"symlink"\|"other"`                                                                                                                                                                                                                                                                    |
| `styles/ask-float.css:8-21`                                                                              | **全站层级表（唯一权威）**：5 / 20 / 30 / 40 / 45 / 50 / 55 / 60 / 70。新增层级必须登记                                                                                                                                                                                                                            |
| `components/dialog/AskUserFloat.vue`                                                                     | **非模态浮窗先例**：`role=dialog aria-modal=false`、无陷阱、无滚动锁、Esc 用 stopPropagation、方向键微移、标题栏 `tabindex=0`、限制在 topbar 下方                                                                                                                                                                  |
| `composables/useAskFloat.ts:263-324`                                                                     | 拖动先例：capture 是尽力而为，监听器挂在 bar 上；**capture 失败后的兜底没有闭环**（评审 #8 的根源）                                                                                                                                                                                                                |
| `DirPicker.vue:633`、`SessionHistoryDialog.vue:450`、`PrivacyUnmarkDialog.vue:83`、`ProxyDialog.vue:144` | 4 份 `OVERLAY_ROOTS` 定义（`ResumeDialog.vue:6` 只在注释里引用）：「document 顺序里最后一个浮层根节点是最顶层」，含 `.preview-overlay`                                                                                                                                                                             |
| `shell/DashboardView.vue:254-266`                                                                        | window 上的 Esc：先关抽屉；单视图 band 里返回列表；尊重 `defaultPrevented`，忽略输入框                                                                                                                                                                                                                             |
| `control/Composer.vue:684` + `logic/control.js:188`                                                      | composer 的键：Enter 发送、Alt+Enter 追加、Shift+Enter 换行；palette/mention 用 ↑↓/Tab/Esc。**全 UI 没有其它全局组合键**（grep 过 ctrlKey/metaKey/altKey）                                                                                                                                                         |
| `composables/usePrivacyLock.ts:359`                                                                      | 只要当前会话转入锁定状态就 `onRelock` → `previewCtx.handle.close()`                                                                                                                                                                                                                                                |
| `hub/preview/html-cap.ts:248-262`                                                                        | 每 principal 8 个、全局 64 个，按铸造顺序 FIFO，**不看是否还在显示**；驱逐会 abort 在途请求；没有释放接口                                                                                                                                                                                                          |
| `PreviewHtml.vue:199-210`                                                                                | 「重新加载」只在本地 idle/hard 计时到期后显示；被提前驱逐时**没有提示**                                                                                                                                                                                                                                            |
| `tests/web-hub/ui/source-scan.test.ts:74-77`                                                             | `createObjectURL` 的例外精确指向 `components/preview/PreviewHost.vue`                                                                                                                                                                                                                                              |
| `tests/web-hub/ui/column-align.test.ts:67-82`                                                            | 层级断言：`.preview-overlay` 是 z60（AttachmentImagePreview 复用这个基类，保持不动）                                                                                                                                                                                                                               |
| `control/AttachmentImagePreview.vue:93-96`                                                               | 复用 `.preview-overlay/.preview-panel`，属于模态，z60                                                                                                                                                                                                                                                              |

---

## 3. 交互路由

### 3.1 路由表

| 触发点                                                                  | 新行为                                                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 对话、ToolCard、用户气泡里的 PathText / MdInline / MdImage（根 `open`） | **追加窗口**（文件和目录都追加，因为没有发起窗口）。走去重；到上限时在**活动窗口**内 navigate 并提示；没有窗口时开第 1 个 |
| 窗口内的 PathText（md 渲染或源码视图）                                  | 按 `routeOf` 判定：dir → 发起窗口内 navigate（入栈，可返回）；file → 新窗口；unknown → 推测开窗（§3.3）                   |
| 窗口内 md 链接 `[x](p)`（MdInline）                                     | `dir:true` 或 kindOf=dir → 本窗进入；其余同上                                                                             |
| 窗口内 md 图片（MdImage）                                               | file → 新窗口                                                                                                             |
| 目录列表：子目录双击、Ctrl+Enter、「上级」、路径栏 Go                   | 本窗 navigate（不变）                                                                                                     |
| 目录列表：**file 行**单击（含内联展开出的子行）                         | 新窗口（用户拍板 2）                                                                                                      |
| 目录列表：**symlink / other 行**单击                                    | unknown → 推测开窗；symlink 实际指向目录时回折到本窗                                                                      |
| HTML 渲染 iframe 内部的链接                                             | 不变，也拦截不到（沙箱、不透明源）                                                                                        |
| 错误重试、分块「重新打开」、tooLarge 复制路径                           | 本窗（不变）                                                                                                              |

### 3.2 类型判定 `logic/previewWindowRoute.ts`（纯函数，W1）

```ts
export type PreviewRoute = "dir" | "file" | "unknown";
export function routeOf(
  ref: { path: string; dir?: true },
  kindOf?: (p: string) => PreviewProbeKind | undefined,
): PreviewRoute;
//  ref.dir === true                      → "dir"
//  kindOf(path) === "dir"                → "dir"
//  kindOf ∈ {"text","image","file","missing"} → "file"   (missing 交给窗口显示错误)
//  其它（无 probe、未探测）              → "unknown"
export function routeOfDirEntry(type: PreviewDirEntryType): PreviewRoute; // dir→"dir"、file→"file"、symlink|other→"unknown"
```

### 3.3 未知类型：推测开窗 + 回折（用户 5、评审 #1）

规则：**只要最终确认是目录，就在发起窗口内进入。** 类型在请求之前无法得知，所以按以下步骤处理：

1. 未知类型并且没到上限时，新建窗口 B，记录 `meta = { originId: A, speculative: true, originEpoch: A.navEpoch }`，`B.open(ref)`。
2. manager 监视 B 的首次落定（phase 第一次离开 `loading`）：
   - 满足 phase=`dir`，且 A 仍存活，且 `A.navEpoch === originEpoch`（A 在此期间没有翻页），且 `B.stackDepth===0`，则：`A.adopt(B.view)`（把 A 的当前视图入栈，直接使用 B 已经取回的 listing，不重新请求）→ `closeWindow(B)` → `focusWindow(A, {moveFocus:true})`。这种关闭**不触发**常规的焦点归还。
   - 其它情况（文件、错误、unsupported，或 A 已关闭、已翻页）都清除 `speculative`，B 作为普通窗口保留。
3. 推测窗口照常显示 loading。回折时会闪一下，这一点可以接受（R7）。
4. 走 415 `not-regular` → `dir:true` 回退得到的目录，同样按「首次落定 = dir」处理。
5. 如果已到上限，unknown 直接在 A 内 navigate（和上限规则一致）。

### 3.4 去重与上限

- **去重**：在全部窗口里按 MRU 顺序，找当前 `view` 带 `path` 并且 `path === ref.path` 的窗口（**包括 `loading`**，以及 error/unsupported/tooLarge）。命中就 `focusWindow(id, {moveFocus:true})`，返回 `"focused"`。路径按字符串精确比较（`~/x` 和 `/home/u/x` 不算同一个，可以接受）。窗口内的目录路由（dir → 本窗）**优先于**去重。
- **上限**：`windows.length >= 6` 时，目标窗口 = 发起窗口，没有发起窗口时取活动窗口。在目标窗口内 `navigate(ref)`，然后发出 `limitNotice{id}`，返回 `"navigated"`。
- **提示显示**（评审 #10）：目标窗口 header 下方显示一行 `<p role="status" class="preview-window-limit">`，文案为「已达 6 个窗口上限，已在当前窗口打开」。以下情况清除：①该窗口下一次 navigate、back 或 openFrom；②窗口总数降到上限以下；③8 秒后。计时器在窗口卸载时清理。

---

## 4. 状态模型（W1）

### 4.1 分层

```
usePreviewWindows (App 级)
 ├─ scope (computed, previewScopeOf)         全局一份
 ├─ probe (usePreviewProbe)                  全局一份（随 App，不随窗口销毁）
 ├─ watch(scopeKeyOf(scope)) → closeAll()    全局一份
 ├─ history: PreviewHistoryBudget            全局一份（§4.5）
 ├─ windows: shallowRef<PreviewWindow[]>     创建顺序 = DOM 顺序，永不重排
 ├─ order:   ref<number[]>                   激活顺序，末尾 = 活动 = 最高 z
 ├─ focusRequest / limitNotice: ref<{id, seq} | null>   给宿主的 DOM 侧指令（manager 自身不碰 DOM）
 └─ 每个窗口: createPreviewMachine({scope, preview, coarse, probe, createFileReader, history,
                                    onSessionChanged: (scKey) => scKey === scopeKeyOf(scope.value) && closeAll()})
```

### 4.2 `usePreview.ts` 抽取

- 导出 `createPreviewMachine(deps: PreviewMachineDeps): PreviewMachine`，其中 `PreviewMachine = PreviewHandleDir & { readonly navEpoch: Readonly<Ref<number>>; adopt(v: PreviewViewDir & {phase:"dir"}): void }`。
- 内容是把 usePreview 现在的 L227-L700 原样搬过来，只改以下几点：
  - `settleError` 的 session-changed 分支、流的 `d.close`、**tree 回调**（§4.4）改为调用 `deps.onSessionChanged(scopeKeyOf(sc))`；
  - `isDirHint` 改用 `deps.probe`；
  - `load/back/adopt` 时 `navEpoch++`；
  - `navigate` 入栈时，如果有 `deps.history`，就登记字节数（§4.5）；
  - `back()` 遇到「桩」条目时执行 `load(path, dir)`，而不是恢复快照；
  - `dispose` 只清理自己的东西，不拥有 watcher，并且置 `disposed=true`。
- `usePreview(opts)` = scope + probe + `createPreviewMachine({..., onSessionChanged: () => m.close()})`（不注入 history）+ scope watcher + 冻结接口的桥接 cast。**原有 `use-preview.test.ts` 用例一行不改**；只新增 tree 会话变更用例（这一处行为修正对单窗同样适用）。
- `PREVIEW_NAV_STACK_MAX = 64` 不变。

### 4.3 新文件 `composables/usePreviewWindows.ts`（接口冻结，W2/W3 据此并行）

```ts
export const PREVIEW_WINDOW_MAX = 6;
export interface PreviewWindow {
  readonly id: number;
  readonly handle: PreviewMachine;
}
export type OpenWindowResult = "opened" | "focused" | "navigated" | "in-place" | "ignored";
export interface PreviewWindowsFace {
  readonly windows: Readonly<ShallowRef<readonly PreviewWindow[]>>; // 创建顺序
  readonly order: Readonly<Ref<readonly number[]>>; // 激活顺序
  readonly activeId: Readonly<Ref<number | null>>;
  readonly focusRequest: Readonly<Ref<{ readonly id: number; readonly seq: number } | null>>;
  readonly limitNotice: Readonly<Ref<{ readonly id: number; readonly seq: number } | null>>;
  /** 从窗口 fromId 内发起，fromId 为 null 表示从对话发起；kindOf 由 manager 自取共享 probe */
  openWindow(ref: PreviewNavRef, fromId: number | null, opts?: { route?: PreviewRoute }): OpenWindowResult;
  closeWindow(id: number): void; // 未知 id → 空操作
  focusWindow(id: number, opts?: { moveFocus?: boolean }): void; // 只改 order；moveFocus 时发出 focusRequest
  closeAll(): void;
}
export type PreviewWindowsHandle = PreviewHandle & PreviewWindowsFace;
export function usePreviewWindows(opts: UsePreviewOptions): PreviewHandle; // 冻结接口 + 一处 cast
export function asWindowsHandle(h: PreviewHandle): PreviewWindowsHandle | null;
```

**根 handle**（冻结的 `PreviewHandle`）：`view` = 活动窗口的 view，没有窗口时是 closed；`open(ref)` = `openWindow(ref, null)`（**追加**）；`close()` = closeAll（隐私回锁走这里）；`retry()` 转给活动窗口；`scope`/`probe` 是共享的那一份；不提供 navigate，所以 `asDirHandle(根) === null`。

**`openWindow(ref, fromId, opts)` 算法**：

```
0. scope 为 null 或没有 transport → "ignored"
1. from = fromId===null ? null : 存活窗口(fromId)；fromId!==null 且 from 不存在 → "ignored"（失效发起窗口不做任何事）
2. route = from===null ? "file"(仅表示「开窗」) : (opts.route ?? routeOf(ref, probe.kindOf))
3. route==="dir" → from.handle.navigate({path, dir:true})；返回 "in-place"
4. 去重（§3.4）命中 → focusWindow(hit,{moveFocus:true})；返回 "focused"
5. windows.length ≥ MAX → target = from ?? active；target 为 null 则 "ignored"；target.handle.navigate(ref)；limitNotice=target；返回 "navigated"
6. 新建机器 → push windows/order；meta={originId, speculative: route==="unknown", originEpoch}；
   machine.open(ref)；focusRequest=新 id；返回 "opened"
```

`closeWindow(id)`：dispose → 从 windows 里 splice（keyed v-for 只移除这一个节点）→ 从 order 里移除 → 删除 meta 和回折监视。`closeAll()` 逐个执行 dispose。id 用闭包内递增计数（source-scan 禁止 randomUUID）。

### 4.4 各子系统（含评审 #6 的会话变更覆盖）

| 子系统                 | 处置                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主请求、415 回退       | 每台机器各自的 seq/AbortController。会话变更走 `settleError`；seq 守卫保证已关闭的机器（dispose 时 `abortInFlight` 会 seq++）发不出信号                                                                                                                                                                                |
| 分块流                 | 每台机器一份，streamSeq 守卫；`d.close` → `onSessionChanged`                                                                                                                                                                                                                                                           |
| **tree**               | 在 `createPreviewTree` 的抓取回调里：开始时捕获 `sc` 和 `visitEpoch`（clearVisit 时 ++）；结束时如果 `!out.ok && out.error === "E_SESSION_CHANGED" && !disposed && visitEpoch 未变 && scopeKeyOf(scope.value) === scopeKeyOf(sc)`，就调用 `deps.onSessionChanged(scopeKeyOf(sc))`；其余仍按原样返回 `{ok:false,error}` |
| manager 层             | `onSessionChanged(k)`：只有 `k === scopeKeyOf(scope.value)` 才 closeAll，旧 scope 的迟到错误不会关掉新窗口                                                                                                                                                                                                             |
| probe                  | 共享，按 scope 键入库，旧 scope 的迟到结果不污染（已核实，补测试）                                                                                                                                                                                                                                                     |
| scope watcher          | 切会话、cwd 漂移、取消选中、caps 丢失时 closeAll。**更正 r1**：手机端回到 list 时 reducer 把 selected 置为 null，会关闭全部窗口（list 路由无论如何都会触发）                                                                                                                                                           |
| 隐私                   | 当前会话转入锁定 → `onRelock` → 根 `close()` = closeAll，不改                                                                                                                                                                                                                                                          |
| 图片、文本单次抓取预算 | 不变（16/4 MiB、40/20 MP、流上限 8/4 MiB）                                                                                                                                                                                                                                                                             |
| 下载、复制             | 每个窗口各自的 `usePreviewDownload()` 实例（§9）                                                                                                                                                                                                                                                                       |

### 4.5 内存预算（评审 #11）

- 新文件 `logic/previewHistoryBudget.ts`（纯类）。`add(winId, token, bytes)` / `remove(token)` / `dropWindow(winId)` 维护全局 FIFO；累计超过 `maxBytes` 时，从最老的条目开始回调所属机器的 `stub(token)`，把快照替换成 `{stub:{path, dir}}`。
- 字节估算：image 用 `dataUrl.length`；text 用 `demoteStream` 之后各 chunk 的字符数，没有流时用 `text.length`；dir 用 `entries.length × 128`。
- 预算值：桌面 `96 MiB`，触屏 `32 MiB`（`coarse` 时）。条数上限仍是每窗口 64。
- 单窗 `usePreview` 不注入预算，行为不变。
- **上界**（写进验收）：
  - 当前视图 ≤ 6 × 单视图上限。桌面约 6×(21.3 MiB dataURL 或 8 MiB 文本)；触屏约 6×(5.3 MiB 或 4 MiB)。
  - 历史 ≤ 预算。
  - 字符串总量：桌面 ≤ 约 224 MiB，触屏 ≤ 约 64 MiB。
  - 解码位图最坏情况：桌面 6×40 MP×4 B ≈ 960 MB，触屏 6×20 MP×4 B ≈ 480 MB。这一项**接受为残余风险**（R4），用 §14 的压力项验收。

---

## 5. 桌面非模态（≥768px）

### 5.1 层级（登记进 `ask-float.css` 的层级表）

| 档             | 内容                                                                                                                | 与窗口的关系                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 20             | dock/composer、手机 ask-anchor、中段 composer                                                                       | **在窗口之下**（窗口可以盖住它们，拖开即可）       |
| **25（新增）** | `.preview-overlay.is-windows.is-modeless` 桌面预览窗口                                                              | —                                                  |
| 30             | 抽屉遮罩/overlay、锚定弹出卡片（history/load/quota/version/模型说明/目录列表）                                      | 在窗口之上：用户主动唤起的临时层不能被常驻窗口挡住 |
| 40             | 抽屉、nsmenu 下拉                                                                                                   | 之上                                               |
| 45             | ask-float                                                                                                           | 之上：待回答的提问优先可见                         |
| 50/55          | picker/spawn 遮罩、设置面板、ctx-ring 面板、model-panel                                                             | 之上：模态或准模态，遮罩盖住窗口                   |
| 60             | AttachmentImagePreview（`.preview-overlay` 基类，不带 is-windows）、diff 对话框、ProxyPreview、**手机端的预览叠层** | 之上                                               |
| 70             | 隐私取消标记、proxy 对话框、上传 lightbox、拖放遮罩                                                                 | 之上                                               |

- topbar 没有 z 层级，靠几何限制避开：窗口的 y 不小于 topbar 底边（§7.3），topbar 始终可用。
- 窗口之间的 z 序在根节点（z25）的层叠上下文内，用 `--pw-z = 1 + order 下标`。
- 预览窗口内部没有任何 fixed 子浮层（已核实 preview.css、preview 组件），不会被 25 档的层叠上下文困住。

### 5.2 `OVERLAY_ROOTS` 收敛（W3）

- 新文件 `logic/overlayRoots.ts`：
  ```ts
  export const MODAL_OVERLAY_ROOTS = ".spawn-scrim, .picker-scrim, .preview-overlay:not(.is-modeless), .privacy-scrim";
  ```
  `ProxyDialog` 使用 `MODAL_OVERLAY_ROOTS + ", .proxy-scrim"`。
- 4 个文件改为 import 这个常量（DirPicker、SessionHistoryDialog、PrivacyUnmarkDialog、ProxyDialog）。加一条 source 断言：`src/web-hub/ui/src` 里除 `overlayRoots.ts` 外不再出现 `const OVERLAY_ROOTS =`。
- 语义：桌面非模态根节点**不参与**「谁在最顶」的判定。这些对话框打开时自身是模态（遮罩在 50/70 层），即使 keydown 的目标在某个预览窗口里，Esc/Tab 也归最顶的模态处理，这是正确的。手机叠层（不带 `is-modeless`）照旧参与判定，AttachmentImagePreview 不受影响。

### 5.3 aria（评审 #3）

- 每个 `.preview-panel` 是 `role="dialog" aria-modal="false"`，`aria-labelledby` 指向自己的标题（`pw-title-<id>`，内容为「文件预览：a.md」），`aria-describedby` 指向 sr-only 的键盘提示。
- 桌面端**没有**任何 `aria-modal="true"`，也没有焦点陷阱。窗口在 DOM 里位于 body 末尾（Teleport），Tab 从页面末尾自然进入窗口，在窗口之间按创建顺序流转。这是 APG 的非模态对话框形态，有 ask-float 先例。

### 5.4 焦点模型

- **激活**：`.preview-window` 上挂 `@pointerdown.capture` 和 `@focusin` → `focusWindow(id)`，只改 order，不移动焦点。
- **记录**：每个窗口在 focusin 时记下 `lastFocus = ev.target`。焦点从窗口外进入窗口时（focusin 的 `relatedTarget` 不在任何窗口内且不是 body），记下 `pageFocus = relatedTarget`。对话里点链接开窗前，宿主先记 `pageFocus = document.activeElement`。
- **落焦**：宿主 watch `focusRequest`，在 nextTick 后对目标窗口落焦：`lastFocus` 仍在 DOM 里、位于该窗口内、可聚焦时用它，否则聚焦 panel（`tabindex=-1`）。适用于新开窗口、去重命中、回折回到 A、窗口菜单里选窗口、Ctrl+`。
- **关闭**：被关窗口包含焦点（或者它就是活动窗口）时，对新的活动窗口落焦。最后一个窗口关闭、或「全部关闭」时，聚焦 `pageFocus`（已不在 DOM 中则什么都不做）。
- **点击对话**：窗口保持打开，焦点离开窗口，活动窗口不变。

### 5.5 Esc、「全部关闭」与窗口菜单（用户 3、评审 #12）

- **Esc**：根节点 keydown 时，如果 `!ev.defaultPrevented && !ev.isComposing` 且事件目标在某个窗口内，就关闭**那个窗口**，并且 preventDefault + stopPropagation，这样 DashboardView 的 window 级 Esc（关抽屉、返回列表）收不到。焦点在对话里时 Esc 不碰窗口。焦点在 iframe 内时收不到 Esc，与现状相同。路径栏和菜单自己的 Esc 先 stop，不受影响。
- **「⋯」窗口菜单**（新组件 `PreviewWindowMenu.vue`，键盘模型照 `shell/LangMenu.vue`/`NewSessionMenu.vue`）：
  - 位置：header 里 × 前面的按钮，`aria-haspopup="menu"`。菜单是 `role="menu"`，绝对定位在窗口内部。
  - 菜单项（`menuitem`）：「全部关闭（N）」；「重置位置和大小」（仅桌面，恢复 defaultRect 并居中）；分隔线；窗口列表，每项是「basename — 路径」，当前窗口标 `aria-current`，选中后执行 `focusWindow(id, {moveFocus:true})`。
  - 键盘：Enter/Space/↓ 打开并聚焦第一项；↑↓ 循环；Esc 关闭菜单并 stopPropagation（窗口不关），焦点回到按钮；Tab 关闭菜单；点外面关闭菜单。
  - **键盘方式的全部关闭**：Tab 到「⋯」→ Enter → 「全部关闭」。不另设组合键：Shift+Esc 在 Chrome 是任务管理器，Alt+Esc/Ctrl+Shift+Esc 被操作系统占用。
- **标题栏键盘移动和缩放**：桌面 header 设 `tabindex=0`，只在 `ev.target === header` 时响应：方向键移动 16px，Shift+方向键缩放右、下边 16px，都经过 clamp。提示写进 `aria-describedby` 和 `title`。

### 5.6 对话与窗口之间的键盘切换（任务新增）

- **键位**：`Ctrl+`` 正向，`Ctrl+Shift+`` 反向。判定条件为 `ev.code === "Backquote"`（与键盘布局无关）、`ctrlKey && !altKey && !metaKey`，macOS 上同样用 Ctrl。监听挂在 window keydown（bubble 阶段），由 `composables/usePreviewWindowCycle.ts` 实现。
- **不生效的情况**：没有窗口；`ev.isComposing`；文档里存在 `[aria-modal="true"]`（任何模态打开时，包括手机叠层）。
- **语义**（纯函数 `logic/previewWindowCycle.ts`，类似 Alt+Tab 的 MRU 环）：
  - 每次按键时，如果 `document.activeElement === cycle.lastFocused`，沿用快照，否则重新取快照。快照环为 `["page", ...order 倒序]`，即对话 → 活动窗口 → 更早激活的窗口。
  - 当前位置：焦点所在的窗口，或者 `"page"`。正向前进一格，反向后退一格。
  - 落到窗口：`focusWindow(id,{moveFocus:true})`，被选中的窗口提到最前，但快照不变，所以不会在两个窗口之间来回打转。
  - 落到 page：聚焦 `pageFocus`；它已经失效时依次回退到 `.composer textarea`，再回退为 `activeElement.blur()`。
- **与 composer 的关系**（逐键核对）：
  - composer 只处理 Enter / Alt+Enter / Shift+Enter，palette 和 mention 用 ↑↓/Tab/Esc，不碰 Ctrl+`。
  - Transcript 只处理 PageUp/PageDown/空格等滚动键。
  - PageDropZone 只在拖放进行中处理 Esc。
  - 目录行的 Ctrl/Cmd+Enter 只在窗口内的行按钮上生效。
  - 窗口自己的 Esc、方向键只在窗口内生效，不往外冒泡。
- **备注**：GNOME 的 Alt+` 是「同应用切窗」，所以不用 Alt。F6 可能被浏览器拦截，不作为主键。

---

## 6. 手机全屏叠层（<768px）

### 6.1 形态

- 根节点 `.preview-overlay.is-windows`（不带 `is-modeless`），z60。
- 每个窗口 `position:absolute; inset:0; z-index:var(--pw-z)`。
- 窗口存在期间 `acquireBodyScrollLock()`。
- 只有顶层 panel 是 `aria-modal="true"`，非顶层 panel 是 `aria-modal="false"`，并且所在 `.preview-window` 加 `inert`。inert 本身会把子树移出无障碍树，不再额外加 aria-hidden。
- 没有拖动和缩放，标题栏不可聚焦。
- 窗口数大于 1 时显示 `2/3` 徽标（英文 token 规则），读屏文案用 `windowStackLabel`。
- 「⋯」菜单保留「全部关闭」和窗口列表；从列表跳到下层窗口 = 改 order 提到顶层。

### 6.2 焦点陷阱（评审 #4）

- 陷阱容器**只是顶层窗口**，用 `focusablesIn(container)` 取可聚焦元素：先用 FOCUSABLE 查询，再过滤掉 `closest('[inert],[aria-hidden="true"],[hidden]')` 命中的元素。不依赖布局，happy-dom 里也成立。
- 边界：Tab 从最后一个回到第一个；Shift+Tab 从第一个、或从 panel 自身回到最后一个；焦点在容器外时拉回。
- Esc 关闭顶层窗口。关闭后对新的顶层落焦（它的 `lastFocus` 或 panel）。最后一个关闭时，滚动锁释放，焦点回到 `pageFocus`。

### 6.3 跨断点

`useMedia("(min-width: 768px)")` 翻转时：

- **桌面 → 手机**：结束进行中的手势（§7.4）；获取滚动锁；如果焦点不在顶层窗口内，就对顶层落焦。
- **手机 → 桌面**：释放滚动锁；先 `reclampAll`，再恢复几何；焦点不动。
- 两个方向都保留 rect。

---

## 7. 拖动、缩放与几何

### 7.1 CSP

沿用 r1 §5.1：只用对象形式的 `:style`，只写 CSS 变量（`--pw-x/y/w/h/z`），由 CSS `left: var(--pw-x)` 等读取。拖动链路不用 rAF 和 `<Transition>`，不写 innerHTML、不做 `.on*` 赋值。

### 7.2 DOM

```html
<Teleport to="body">
  <div
    v-if="windows.length"
    class="preview-overlay is-windows"
    :class="{ 'is-modeless': desktop }"
    @keydown="onRootKeydown"
  >
    <section
      v-for="w in windows"
      :key="w.id"
      class="preview-window"
      :class="{ 'is-floating': desktop, 'is-active': w.id===activeId, 'is-top': … }"
      :style="desktop ? geomVars(w.id) : { '--pw-z': z(w.id) }"
      :inert="!desktop && !isTop(w.id)"
      @pointerdown.capture
      @focusin
    >
      <PreviewWindow :win="w" :face :desktop :is-top :index :count … />
      <!-- 内含 .preview-panel[role=dialog] -->
      <template v-if="desktop"
        ><div v-for="d in RZ_DIRS" class="pw-rz" :data-dir="d" aria-hidden="true" @pointerdown="…"
      /></template>
    </section>
  </div>
</Teleport>
```

- **永不重排 DOM**：v-for 按创建顺序渲染，激活只改 `--pw-z`。如果移动节点，iframe 会重新加载。用测试锁住节点身份和 iframe 身份。
- 窗口用 `left/top` 定位，**不用 transform**（transform 会给 fixed 后代造出新的 containing block）。
- 缩放热区 `aria-hidden` 是合理的，因为键盘等价操作在标题栏和菜单里（§5.5）。

### 7.3 纯几何 `logic/previewWindowGeom.ts`（评审 #9）

**常量**：`MIN_W=360`、`MIN_H=240`、`EDGE=8`、`TITLE_KEEP_X=96`、`TITLE_H=48`、`CASCADE=32`、`CASCADE_MIN_SEP=16`、`RZ_EDGE=6`（粗指针 12）。

**视口盒**：`vp = {vw, vh, top}`，`top` 是 topbar 底边，用 ask-float 的 `topOffset()` 测量。

- 可用宽高：`AW = max(0, vw−2·EDGE)`，`AH = max(0, vh−top−2·EDGE)`。
- 有效最小值：`mw = min(MIN_W, AW)`，`mh = min(MIN_H, AH)`。
- 最大值：`w ≤ AW`，`h ≤ AH`。

**约束优先级**（从高到低）：

| 优先级 | 约束                                                                         |
| ------ | ---------------------------------------------------------------------------- |
| P1     | 数值有限。出现 NaN 或 Infinity 时回到 `defaultRect`                          |
| P2     | `w ≥ mw`，`h ≥ mh`                                                           |
| P3     | `w ≤ AW`，`h ≤ AH`                                                           |
| P4     | 标题栏可达：`x ∈ [TITLE_KEEP_X−w, vw−TITLE_KEEP_X]`，`y ∈ [top, vh−TITLE_H]` |
| P5     | 被拖动的边在视口盒内：`[EDGE, vw−EDGE] × [top+EDGE, vh−EDGE]`                |
| P6     | 对边固定                                                                     |

**函数**：

| 函数                                | 规则                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultRect(vp)`                   | `w=min(960, AW)`，`h=min(0.85·vh, 900, AH)`；在视口盒内居中：`x=EDGE+(AW−w)/2`，`y=top+EDGE+(AH−h)/2`。新窗口一定完整落在视口盒内                                                                                                                                                                                                                           |
| `clampRect(r, vp)`                  | 依次应用 P1→P3 的尺寸夹取，再做 P4 的平移                                                                                                                                                                                                                                                                                                                   |
| `moveRect(s, dx, dy, vp)`           | 平移后 `clampRect`                                                                                                                                                                                                                                                                                                                                          |
| `resizeRect(s, dir, dx, dy, vp)`    | 逐轴处理。拖 max 边（右、下）：`lo = s.start+min尺寸`，`hi = max(lo, min(vpEnd−EDGE, s.start+A))`，新边夹到 `[lo, hi]`。拖 min 边（左、上）：`hi = s.end−min尺寸`，`lo = min(hi, max(vpStart+EDGE, s.end−A))`，新边夹到 `[lo, hi]`。当 P5 与 P2 冲突（区间为空）时取 P2。最后做 P4 平移；**只有这一步允许移动对边**（窗口大部分离屏后再缩放就属于这种情况） |
| `cascadeRect(base, vp, occupied[])` | 尺寸取 `clampRect(base)` 的尺寸，按顺序尝试候选位置：① `base + k·32`（k=1..6）；② `origin + j·32`（origin=`(EDGE, top+EDGE)`，j=0..6）。取第一个**完整落在视口盒内**，并且与所有 occupied 左上角满足 `                                                                                                                                                      | dx  | ≥16 或 | dy  | ≥16`的位置。都不满足时兜底为 origin（一定放得下，接受重叠）。结果再经过`clampRect` |

**必测用例**：

- 768×900 视口（评审给的例子，w=736）：错开摆放的结果完整可见；没有可区分的槽位时落到 origin。
- 短视口 `vh−top < 240`：`mh = AH`，不产生矛盾。
- 窗口部分离屏后八个方向缩放。
- 属性测试（固定种子，1000 次）：任意序列的 move/resize/视口缩小之后，P1–P4 恒成立；对边发生移动时，必然是 P4 平移介入过。

### 7.4 手势控制器 `composables/usePreviewWindowLayout.ts`（评审 #8）

- 持有 `Map<id, Ref<Rect>>`。新窗口出现时，以前一个活动窗口的 rect 做 `cascadeRect(…, occupied)`；第 1 个窗口用 `defaultRect`。
- **同一时刻只有一个手势** `{pointerId, winId, kind, el, mode: "capture"|"document"}`：
  1. `pointerdown` 要求 `button===0`、桌面、当前没有手势；命中 `closest('button,a,input,select,textarea,[data-no-drag],[role=menu]')` 时不开始。
  2. 尝试 `el.setPointerCapture(id)`。如果抛错，或者 `el.hasPointerCapture?.(id) === false`，进入 **document 模式**：在 `document` 上挂 move/up/cancel；否则在 `el` 上挂 move/up/cancel/lostpointercapture。所有事件都按 `pointerId` 过滤。
  3. 移动 3px 才算开始拖动。开始后 body 加 `pwh-pw-dragging` 类，CSS 设 `user-select:none`，并给 `.preview-window iframe` 设 `pointer-events:none`。
  4. **以下情况统一 `endGesture()`**：pointerup/cancel；capture 模式下的 lostpointercapture；window `blur`；`visibilitychange` 变为 hidden；跨到手机断点；目标窗口被关闭；组件卸载。`endGesture` 幂等，移除全部监听器和 body 类。
- 视口 `resize` 时同步执行 `reclampAll`，监听器在有窗口时挂上，没有窗口时卸下。
- 平板（≥768 的粗指针设备）：标题栏和热区设 `touch-action:none`，热区加宽到 12px。

### 7.5 CSS（`styles/preview.css`，只加新类，不改基类）

- `.preview-overlay.is-windows { display:block; }`
- `.preview-overlay.is-windows.is-modeless { z-index:25; background:transparent; pointer-events:none; }`，其中 `.preview-window { pointer-events:auto; }`。
- `.preview-window.is-floating { position:absolute; left/top/width/height: var(--pw-*); z-index: var(--pw-z); }`，其中 `> .preview-panel { width:100%; height:100%; max-height:none; }`。
- `.is-floating .preview-header`：`cursor:move; touch-action:none; user-select:none`。header 内的 `.preview-path` 加 `data-no-drag`，保留划选路径的能力（解决 r1 的 R6）。`:not(.is-active)` 用更浅的阴影和淡化的标题栏。
- `.pw-rz[data-dir]` 8 条规则；`.preview-window-limit` 提示行；`.pw-menu` 菜单。
- 手机：`@media (max-width:767px) { .preview-overlay.is-windows .preview-window { position:absolute; inset:0; z-index:var(--pw-z); } }`。
- 规则全部挂在 `.is-windows`/`.preview-window` 下，AttachmentImagePreview 不受影响（`column-align` 里「`.preview-overlay` 是 z60」的断言保留）。

---

## 8. HTML capability（评审 #2）

### 8.1 事实

hub 按铸造顺序 FIFO（每 principal 8 个）。旧窗口 A 一直开着，其它窗口反复开开关关；只要在 15 分钟空闲期内累计 8 次更新的铸造（含切换源码再切回、重新加载），**A 就会被驱逐**，与同时开着几个窗口无关。驱逐之后，A 已经渲染出的页面还在，但页内链接和子资源都会 404，现有 UI 没有任何提示。同一 principal 的其它标签页也共享这 8 个名额。

### 8.2 首版产品行为（纯前端，W3）

1. **凭据账本**：新文件 `logic/htmlCapLedger.ts`（纯类），由 `components/preview/previewHtmlLedger.ts` 提供注入键 `PREVIEW_HTML_LEDGER` 和响应式包装。PreviewHost provide，PreviewHtml 可选 inject；没有注入时行为与现在相同。
   - `minted(token, now)`：先清理已过期的条目（已卸载的按 `unmountedAt + PV_IDLE_TTL_MS`，所有条目按 `mintedAt + PV_HARD_TTL_MS`）；如果存活数 ≥ `PV_CAPS_PER_PRINCIPAL`，把最老的条目标为 `evicted`；然后入队。
   - `unmounted(token, now)`：条目继续占位，因为 hub 不知道它已经卸载。
   - 常量从 `@protocol/preview-html.js` 导入，不另写一份。
   - 账本是**下界模拟**：其它标签页的铸造它看不到。假阳性（说「可能」但其实没被驱逐）可以接受；单标签页场景下是**确定性**的。
2. **失效提示**：账本把当前凭据标为 evicted 时，PreviewHtml 的工具条下显示 `role="status"` 文案：「这个页面的访问凭据可能已被后来打开的 HTML 预览挤掉（同一登录最多保留 8 个）。页面里的链接或资源加载失败时，点「重新加载」。」
3. **「重新加载」常驻**：`.preview-html-bar` 里一直显示「重新加载」按钮（位于「新标签打开」旁边）。`maybeStale` 只保留提示文字；`expired` 横幅保留自己的按钮。重新加载 = 重新铸造 + `frameKey++`，同时清除 evicted 状态。

### 8.3 可选包 W-H：hub 释放端点（**推荐首版不做**，待拍板）

- **端点**：`POST /api/preview/html-cap/release {cap}`，新能力位 `preview.html.release.v1`。PreviewHtml 卸载或重新铸造前，对旧凭据发一次即发即弃的释放请求（2 秒超时）；收到 204 后，账本里对应条目出队。
- **效果**：单标签页内同时挂载的 HTML ≤ 6 个，旧窗口不会再被这个标签页自己的操作驱逐。
- **安全论证**：
  - 走现有 `/api` 写路由的 I4 闸门：需要 X-PWH、JSON、非 `Origin: null`；需要已认证的 principal。
  - 只有 `rec.principal === principal && rec.listener === listener` 时才执行 `store.endCap(rec,"close")`。
  - 无论凭据是否存在、是否匹配，**一律返回 204**，没有预言机。
  - 不透明源的 `/pv` 页面拿不到凭据（I2：HttpOnly + SameSite=Strict ⇒ 401），也会被 `Origin:null` 拒绝。
  - 端点只能结束调用者自己的凭据，**严格缩小**权限；审计复用 `pv-end{end:"close"}`。
  - 共用铸造的速率桶。
- **成本**：hub 路由、能力位声明、UI 接线和测试，合计约 250 行，落在安全敏感区，需要 I1–I4 回归和撤销交互测试。
- **评估**：首版先上 §8.2，用确定性提示加常驻恢复入口兜底；真实使用中如果频繁出现提示，再做 W-H。

---

## 9. 改动坐标与接口

| 文件                                                                                                                     | 包    | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `composables/usePreview.ts`                                                                                              | W1    | 抽出 `createPreviewMachine`、`PreviewMachineDeps`；新增 `adopt`、`navEpoch`、历史预算挂钩、桩条目、tree 会话变更；`usePreview` 变成包装                                                                                                                                                                                                                                                                                                        |
| `composables/usePreviewWindows.ts`（新）                                                                                 | W1    | §4.3、§3.3、§3.4                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `logic/previewWindowRoute.ts`（新）                                                                                      | W1    | §3.2                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `logic/previewWindowGeom.ts`（新）                                                                                       | W1    | §7.3                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `logic/previewHistoryBudget.ts`（新）                                                                                    | W1    | §4.5                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `components/preview/PreviewWindow.vue`（新）                                                                             | W2    | 从 PreviewHost 搬入 header/body/各 phase、`holdTall`、`htmlHoldTall`、复制通道；新增 `openFrom(ref)`，统一调用 `face.openWindow(ref, win.id, {route})`，**所有入口共用**；子树 provide `PREVIEW_CTX = {plaintext, handle:{...win.handle, open: openFrom}}`；`onDirEntry` 中 dir 行走 `win.handle.navigate`，file/symlink/other 行走 `openFrom(ref, routeOfDirEntry(type))`；显示 limitNotice 提示行；标题 id 和 describedby；手机端 `2/3` 徽标 |
| `components/preview/PreviewWindowMenu.vue`（新）                                                                         | W2    | §5.5                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `composables/usePreviewDownload.ts`（新）                                                                                | W2    | 从 PreviewHost 搬入 `download/downloadUnsupported/saveBlob/downloadNameOf/downloadCap/downloadSession`，每个窗口一个实例                                                                                                                                                                                                                                                                                                                       |
| `composables/usePreviewWindowLayout.ts`（新）                                                                            | W2    | §7.4                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `components/preview/PreviewHost.vue`                                                                                     | W2    | 只剩外壳：Teleport、根节点（modeless/叠层）、根 keydown（Esc、手机陷阱）、focusRequest 落焦、pageFocus/lastFocus、手机滚动锁、跨断点协调、v-for。`asWindowsHandle(ctx.handle) === null` 时**什么都不渲染**（删除 legacyFace）。W3 再加两行：`usePreviewWindowCycle(...)` 和 `provide(PREVIEW_HTML_LEDGER, …)`                                                                                                                                  |
| `App.vue:66,201`                                                                                                         | W2    | `usePreview` 换成 `usePreviewWindows`（参数相同）                                                                                                                                                                                                                                                                                                                                                                                              |
| `styles/preview.css`                                                                                                     | W2    | §7.5                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `i18n/{zh,en}/preview.ts`                                                                                                | W2/W3 | 见下表                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tests/web-hub/ui/source-scan.test.ts`                                                                                   | W2    | 例外改为 `/composables\/usePreviewDownload\.ts/`，理由原样保留（只用于 a[download] 保存）。**不要**豁免整个 preview 目录                                                                                                                                                                                                                                                                                                                       |
| `logic/overlayRoots.ts`（新）+ `DirPicker.vue`、`SessionHistoryDialog.vue`、`PrivacyUnmarkDialog.vue`、`ProxyDialog.vue` | W3    | §5.2                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `logic/previewWindowCycle.ts`（新）+ `composables/usePreviewWindowCycle.ts`（新）                                        | W3    | §5.6                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `logic/htmlCapLedger.ts`（新）+ `components/preview/previewHtmlLedger.ts`（新）+ `PreviewHtml.vue`                       | W3    | §8.2                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `styles/ask-float.css`（层级表注释）                                                                                     | W3    | 登记 25 档                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `AGENTS.md`（web-hub「Content preview」段）+ `docs/dev/web-hub-preview-windows/acceptance.md`                            | W4    | 文档                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **不改**                                                                                                                 | —     | `types.ts`（冻结）、`previewContext.ts`（mermaid 也只改它的注释，避免冲突）、PathText、MdInline、MdImage、PreviewDir/Rows、PreviewText、hub（W-H 除外）、DashboardView、AttachmentImagePreview                                                                                                                                                                                                                                                 |

**i18n 新增**（zh / en，`preview` 命名空间；i18n-parity 测试会自动检查）：

| key                | zh                                                                          | en                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `windowLabel`      | 文件预览：{name}                                                            | File preview: {name}                                                                                                                        |
| `windowLimit`      | 已达 {n} 个窗口上限，已在当前窗口打开                                       | Window limit ({n}) reached — opened in this window                                                                                          |
| `windowStackLabel` | 第 {i} 个窗口，共 {n} 个                                                    | Window {i} of {n}                                                                                                                           |
| `windowMoveHint`   | 拖动标题栏移动；方向键移动，Shift+方向键调整大小；Ctrl+` 在对话与窗口间切换 | Drag the title bar to move; arrows move, Shift+arrows resize; Ctrl+` switches between chat and windows                                      |
| `windowMenu`       | 窗口操作                                                                    | Window actions                                                                                                                              |
| `windowCloseAll`   | 全部关闭（{n}）                                                             | Close all ({n})                                                                                                                             |
| `windowResetGeom`  | 重置位置和大小                                                              | Reset position and size                                                                                                                     |
| `windowSwitchTo`   | 切换到窗口                                                                  | Switch to window                                                                                                                            |
| `htmlMaybeEvicted` | 见 §8.2                                                                     | This page's access token may have been displaced by a newer HTML preview (8 per login). If links or resources fail to load, click "Reload". |

---

## 10. 测试计划

### 10.1 单元测试（node）

- `logic-preview-window-geom.test.ts`（新）：§7.3 的全部必测用例，加属性测试。
- `logic-preview-window-route.test.ts`（新）：`routeOf` / `routeOfDirEntry` 的真值表。
- `logic-preview-history-budget.test.ts`（新）：跨窗口按 FIFO 降级为桩；remove 和 dropWindow；不超过预算时不降级。
- `use-preview-windows.test.ts`（新，假 transport）：
  1. 根 open 依次追加 1、2 个窗口（**不再** closeAll）；第 2 个窗口位置错开。
  2. 窗口内 PathText 指向 `dir:true`、kindOf=dir → `"in-place"`，窗口数不变，stackDepth+1。
  3. file → `"opened"`。
  4. symlink/unknown 首次落定是 dir → 回折：A 的 view 变为 listing，**不发第二次请求**；B 被移除；`focusRequest` 指向 A；A 期间翻过页（navEpoch 变了）或 A 已关闭 → 不回折。
  5. unknown 首次落定是文件 → 保留 B。
  6. 去重：已完成加载的、**加载中的**（慢请求下连点两次只产生 1 个请求）、error 阶段的窗口都会命中；命中后 `focusRequest` 发出。
  7. 第 7 次打开：从窗口内发起 → 在发起窗口内 navigate，并发出 limitNotice；从对话发起 → 在活动窗口内 navigate。
  8. `fromId` 已关闭 → `"ignored"`，什么都不做。
  9. `closeWindow(2)` 只 abort 窗口 2 的请求；`closeAll` 全部 abort；dispose 幂等；id 单调递增。
  10. scope 键变化 → closeAll；主请求、流、**tree** 收到 E_SESSION_CHANGED → closeAll。
  11. tree 迟到错误：窗口已关闭，或 visitEpoch 已变 → 不关闭任何窗口；旧 scope 的错误不关闭新 scope 的窗口；旧 scope 的 probe 结果不影响新 scope 的 kindOf。
  12. 历史预算：大量图片导航后，最老的快照变成桩，back 回到桩条目时重新请求。
  13. 根 `view` 等于活动窗口的 view；`retry` 转给活动窗口；`asDirHandle(根) === null`。
- `use-preview.test.ts`：**原有用例不改**；新增「tree 收到 E_SESSION_CHANGED → close」「迟到的 tree 错误被丢弃」两条。

### 10.2 组件测试（happy-dom）

innerWidth=1024 视为桌面；手机用 matchMedia 桩。

- **`tests/web-hub/ui/helpers/preview-windows-fake.ts`（新）**：用给定的若干 handle 构造 `PreviewWindowsHandle` 测试替身，只用于测 PreviewWindow 对各 phase 的渲染（取代生产代码里的 legacyFace）。
- **`preview-host.test.ts` 迁移**：
  - 各 phase 渲染、复制、下载、分块、HTML 保持高度 → 用替身（覆盖的是生产组件 PreviewWindow 的渲染）。
  - dir/nav 段（L330-680，原本用真实 `usePreview`）→ 参数化到真实 `usePreviewWindows` 加假 transport（生产路径）；「file 行 navigate」改为断言开新窗口，「md 里的路径 ref 在本窗 navigate」改为按类型分支断言。
  - 焦点、滚动锁、Esc、遮罩段按新语义**重写**：桌面端无陷阱、无锁、无遮罩，Esc 只关焦点所在的窗口；手机端有锁、顶层陷阱、Esc 关顶层。
  - 删除「a handle WITHOUT the navigation face…」这条根级用例，换成「root handle 没有 windows face → 宿主不渲染」。逐窗口的 `asDirHandle` 为 null 时的降级用例保留。
  - 文件头注明：哪些 describe 走生产 manager，哪些走替身。
- **`preview-windows.test.ts`（新，真实 manager，桌面）**：
  1. md 里点文件链接 → 出现 2 个 panel，窗口 1 的 DOM 还在，坐标错开；点目录链接 → 窗口数仍是 1，「返回」可用。
  2. 目录行：file 行、内联展开出的子 file 行 → 新窗口；双击子目录、上级、路径栏 Go → 本窗。
  3. **非模态**：根节点有 `is-modeless`，计算样式为 `pointer-events:none`；body 没有 overflow 锁；窗口外的按钮可以被点击和聚焦；对话里点路径会**追加**窗口。
  4. Esc：焦点在窗口 2 时只关窗口 2，并且 `defaultPrevented`（DashboardView 的处理函数不触发，用 window 级 spy 断言）；焦点在窗口外时 Esc 不关窗口。
  5. 焦点：新窗口打开后焦点在其 panel；关闭后焦点回到窗口 1 里刚才那个链接；最后一个关闭后回到 pageFocus。去重命中时**焦点移到**命中的窗口。
  6. 在后面的窗口上 pointerdown → 它的 `--pw-z` 变成最大，节点顺序和身份不变，里面的 iframe 是同一个元素。
  7. 拖动：起拖阈值 3px；从按钮上按下不拖；body 类的增删。
  8. 「⋯」菜单：「全部关闭」关闭所有窗口并把焦点还给 pageFocus；菜单内 Esc 只关菜单；「重置位置和大小」；从窗口列表跳转会转移焦点；键盘 ↑↓。
  9. 标题栏键盘操作：方向键移动，Shift+方向键缩放，都经过 clamp。
  10. 到上限时的提示：分别经 PathText、MdInline、MdImage、根列表 file 行、内联子 file 行各触发一次，`role=status` 文本出现，并按 §3.4 的规则清除。
  11. 每个窗口的下载相互独立（dlBusy 互不影响）。
  12. aria：所有 panel 都是 `aria-modal="false"`，`aria-labelledby` 指向各自标题。
- **`preview-windows-phone.test.ts`（新）**：
  - 没有 `.pw-rz`，没有几何变量，非顶层带 `inert`，顶层 `aria-modal="true"`，有滚动锁，显示 `2/3` 徽标。
  - 陷阱的双向边界；焦点在 panel 自身时 Shift+Tab 去最后一个；下层窗口里的按钮永远拿不到焦点。
  - 关闭顶层后焦点落到新的顶层。
  - 跨断点：拖动中切到手机会结束手势（body 类被移除）；切到手机时焦点进入顶层，切回桌面时滚动锁释放。
- **`use-preview-window-layout.test.ts`（新）**：
  - `setPointerCapture` 抛错 → document 模式，仍然能移动，并在 document 上 pointerup 时结束。
  - `hasPointerCapture` 为 false → document 模式。
  - blur、页面隐藏、关窗、卸载都会结束手势。
  - 其它 pointerId 的事件被忽略。
- **W3 相关**：
  - `logic-overlay-roots.test.ts`：source 断言，4 个文件都 import 共享常量。
  - `dir-picker.test.ts`、`session-history-dialog.test.ts`、privacy-unmark、proxy-dialog 各加一条：存在 `.preview-overlay.is-modeless` 且它在 DOM 中排在后面时，本对话框仍然是最顶层。
  - `logic-preview-window-cycle.test.ts`：MRU 快照；快照复用条件；正向和反向；不会在两个窗口之间打转。
  - `preview-window-cycle.test.ts`：从 composer textarea 按 Ctrl+`→ 活动窗口；再按 → 更早激活的窗口；再按 → 回到 textarea；存在`[aria-modal=true]` 时、`isComposing` 时不生效；composer 的 Enter 发送行为不受影响。
  - `logic-html-cap-ledger.test.ts`（**确定性**）：保留 A，再铸造 8 次 → A 被标为 evicted；卸载超过 15 分钟的条目被清理、不再占位；硬上限 60 分钟；重新铸造之后清除 evicted。
  - `preview-html.test.ts`：「重新加载」常驻；账本发出 evicted 后横幅出现，点「重新加载」后消失；没有注入账本时与现在相同（横幅不出现）。
- **回归**：
  - `column-align.test.ts`：新增 `.is-modeless` 为 z25，并且低于 30/40/45/50。
  - `attachment-preview.test.ts` 保持不变。
  - `privacy-lock.test.ts`：开 2 个窗口后回锁 → 全部关闭。
  - `preview-wiring.test.ts`：App 用的是 `usePreviewWindows`；对话里点路径会开窗；**真实路由**：手机端从 detail 回到 list 时关闭全部窗口。
  - `source-scan.test.ts`、`i18n-parity`。

---

## 11. 拆包

| 包                          | 文件域                                                                                                                                                                                                                                                                                                                                                                  | 依赖                                                                     | 规模（含测试）                                 | 车道         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- | ------------ |
| **W1 状态与纯函数**         | `usePreview.ts`、`usePreviewWindows.ts`、`logic/previewWindow{Route,Geom}.ts`、`logic/previewHistoryBudget.ts` 及 §10.1 的测试                                                                                                                                                                                                                                          | 无                                                                       | 约 1000 行                                     | L2           |
| **W2 窗口组件与非模态外壳** | `PreviewWindow.vue`、`PreviewWindowMenu.vue`、`PreviewHost.vue`、`usePreviewDownload.ts`、`usePreviewWindowLayout.ts`、`preview.css`、`App.vue`、`i18n/*/preview.ts`、`source-scan.test.ts`、`preview-host.test.ts`（迁移）、`preview-windows{,-phone}.test.ts`、`use-preview-window-layout.test.ts`、helpers 替身、`column-align`/`privacy-lock`/`preview-wiring` 增补 | W1 合入（App 接线）；组件可以先对着 §4.3 冻结接口写                      | 约 1600 行（其中约 450 行从 PreviewHost 搬入） | L3           |
| **W3 跨切面集成**           | `logic/overlayRoots.ts` 和 4 个对话框、`logic/previewWindowCycle.ts` + `usePreviewWindowCycle.ts`、`logic/htmlCapLedger.ts` + `previewHtmlLedger.ts` + `PreviewHtml.vue`、`ask-float.css` 层级表、对应测试；PreviewHost 只加 2 行接线                                                                                                                                   | 冻结接口（§4.3）和 W2 的根节点类名。可与 W2 并行开发，**在 W2 之后合入** | 约 600 行                                      | L2           |
| **W4 文档与真机**           | `acceptance.md`、AGENTS.md 一句、真机执行                                                                                                                                                                                                                                                                                                                               | W1–W3                                                                    | 约 150 行                                      | L1           |
| W-H（可选，推荐首版不做）   | hub 释放路由、能力位声明、PreviewHtml 释放调用、hub 测试                                                                                                                                                                                                                                                                                                                | W3                                                                       | 约 250 行                                      | L2，安全评审 |

建议顺序：W1 → W2 ‖ W3 → 先合 W2、再合 W3 → W4。

---

## 12. 风险与明确不做

### 12.1 风险

| #   | 风险                                               | 缓解                                                                                                  |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| R1  | 重排 DOM 导致 iframe 重新加载                      | 按创建顺序固定，z 只改变量；测试锁住节点和 iframe 身份                                                |
| R2  | transform 造出 containing block                    | 用 left/top 定位                                                                                      |
| R3  | HTML 凭据被 FIFO 驱逐                              | §8.2 的确定性提示加常驻重新加载；W-H 可选；其它标签页导致的驱逐只有「常驻重新加载」兜底（账本看不到） |
| R4  | 解码位图最坏 960 MB（桌面）/ 480 MB（手机）        | 上限 6 个加单视图上限；§14 压力项给出通过标准；超标时后续可以考虑给非顶层手机窗口卸载图片             |
| R5  | 层级 25 下，窗口会被弹出卡片、抽屉、ask-float 盖住 | 这是有意设计（临时层优先）；窗口可以拖动；待拍板项 4                                                  |
| R6  | 非模态下窗口盖住 composer 或对话                   | 可以拖开或用菜单重置；Ctrl+` 回到对话                                                                 |
| R7  | 推测开窗回折时闪一下                               | 只发生在未知类型并且结果是目录的情况；在验收里观察                                                    |
| R8  | happy-dom 的 pointer、inert、布局不完整            | 几何放在纯函数里测；陷阱过滤不依赖布局；手感和 inert 靠真机                                           |
| R9  | 焦点在 iframe 内时 Esc 和 Ctrl+` 收不到            | 现状如此；点标题栏或菜单仍然可用                                                                      |
| R10 | 抽取状态机时行为漂移                               | `use-preview.test.ts` 原有用例不改且全绿                                                              |
| R11 | Ctrl+` 被个别输入法或系统占用                      | 待拍板项 3；对话和窗口仍可用 Tab 和鼠标切换                                                           |
| R12 | 切会话时窗口全部消失，非模态下用户可能意外         | 这是安全上的 scope 绑定（路径属于会话），沿用现状；待拍板项 2                                         |

### 12.2 明确不做

窗口几何的持久化；最小化、最大化、吸附、平铺；手机端的拖动小窗和手势返回；跨浏览器标签页的窗口；AttachmentImagePreview、ProxyPreview、WorktreeDiffDialog 的多窗化；iframe 内链接的拦截；去重时的路径规范化（`~` 与绝对路径）；W-H（除非拍板要做）。

---

## 13. 与 mermaid 方案的冲突面与责任（评审 #13）

- **代码文件**：没有重叠。本方案不碰 `previewContext.ts`、`MdBlock.vue`；新的注入键放在独立文件 `previewHtmlLedger.ts`。AGENTS.md 段落可能有文本冲突，合并时手工解决。
- **行为依赖（指定责任方）**：
  - mermaid P2 的文件域里，`MermaidBlock.vue` **必须**对 `.mmd-figure` 容器挂 ResizeObserver（回调驱动，不用 rAF），重新计算「原尺寸 ⇄ 适应宽度」按钮的出现条件（`naturalWidth >` 当前显示宽度）。验收加一条：「放宽或缩窄预览窗口后，按钮的显示和隐藏正确更新」。这一条写进 mermaid plan 的 §6/§11 修订，由 mermaid 包负责。
  - 本方案 W4 加联合验收：在一个缩放过的预览窗口里查看宽图，检查按钮状态和横向滚动。
  - mermaid 的 `.pwh-mmd-stage`（挂在 body 上的 fixed 元素）与本方案的 left/top 定位没有结构冲突。手机端被 inert 的窗口仍然会被 IntersectionObserver 判为可见并继续渲染，无害。
- **合并顺序**：两边可以并行。如果 mermaid P2 先合，W4 顺带完成联合验收。

---

## 14. 真机验收清单（写进 `acceptance.md`；每项都是可判定的通过标准）

### 桌面端 Chrome 与 Firefox（必要时加 Safari）

1. **非模态**：窗口打开时，对话可以滚动、选中文字、点击；composer 可以输入，Enter 能发送；对话里点路径会追加一个错开摆放的窗口。
2. **层级**：窗口打开时依次打开以下浮层，它们都显示在窗口之上并且可以操作：中段抽屉、load/quota/version 卡片、nsmenu、ask-float、设置面板、DirPicker、ProxyPreview、diff 对话框、隐私取消标记。DirPicker 打开时，Esc 和 Tab 归 DirPicker。
3. 拖动和八方向缩放；标题栏拉不出 topbar 或视口；窗口大部分离屏后再缩放，标题栏仍然可达；缩小浏览器窗口后窗口被重新夹回；768px 宽时错开摆放的新窗口完整可见。
4. capture 兜底：拖动经过 HTML iframe 时不卡住；拖动途中切换浏览器标签页再回来，没有残留的拖动状态。
5. 在后面的窗口上点击或聚焦会把它提到最前；**HTML 窗口在被提前、或其它窗口关闭时不重新加载**（看 iframe 里的时间戳和网络面板）。
6. 键盘：Ctrl+` 在 composer → 活动窗口 → 更早激活的窗口 → composer 之间循环；Esc 只在窗口内生效；标题栏方向键移动、Shift+方向键缩放；「⋯」菜单完全可用键盘操作，包括「全部关闭」后焦点回到对话。读屏器（NVDA 或 VoiceOver）各走一遍：每个窗口读作「对话框，文件预览：x」，并且不会把页面其它部分读作被禁用。
7. 路由：md 里的目录链接、PathText 目录路径、目录行双击 → 本窗进入；file 行、md 里的文件链接、图片 → 新窗口；**symlink 指向目录的行**和未探测的 md 目录链接 → 回折到本窗（闪一下，可以接受）；symlink 指向文件 → 新窗口。
8. 上限：第 7 次打开时在发起窗口内跳转，并出现提示，提示按规则消失；同路径（包括加载中连点）只聚焦，焦点跟随过去。
9. **HTML 凭据（确定性）**：打开 HTML 窗口 A，保持不关；在同一个标签页里开开关关 8 个其它 HTML 预览（或在 A 之外切换源码和渲染）。A 出现「可能已被挤掉」提示；此时 A 页面里指向同目录文件的链接会失败；点 A 的「重新加载」后，提示消失，链接恢复可用。
10. 隐私回锁、切换会话、桌面中段 band 里 Esc 返回列表 → 全部关闭。
11. **内存压力**：在 6 个窗口里各开一张约 40 MP 的图片，再在每个窗口里导航 20 张图片后逐级返回。标签页不崩溃；Chrome 任务管理器记录的峰值内存写进验收报告（参考上界：字符串 ≤ 约 224 MiB 加位图）；最老的历史条目返回时重新加载，而不是报错。

### 手机端 iOS Safari 与 Android Chrome

12. 全屏叠层；关闭顶层后回到下层，**滚动位置还在**；安全区正确；没有拖动手柄；显示 `2/3` 徽标；「⋯」菜单里的全部关闭和窗口切换可用。
13. 外接键盘或读屏下，Tab 和 Shift+Tab 只在顶层窗口里循环（真实浏览器验证 inert）；关闭顶层后焦点落到新的顶层。
14. 横竖屏切换跨越 768（平板）：拖动中旋转不会残留状态；切到手机形态后焦点在顶层，切回桌面后不再锁滚动。
15. 6 个约 20 MP 图片窗口叠放时不被系统杀掉标签页（记录现象）。

### 联合验收（mermaid 合入后）

16. 在缩放过的窗口里看宽 mermaid 图：放宽和缩窄窗口后，「原尺寸」按钮正确出现和消失。

---

## 15. 仍需用户拍板的点

1. **HTML 凭据的 hub 释放端点（W-H）是否首版就做**：首版不做，先用前端账本提示加常驻「重新加载」，观察真实使用情况（推荐）/ 首版就做（约 +250 行，涉及安全敏感路由）。
2. **非模态下切换会话或取消选中时，窗口是否全部关闭**：全部关闭，路径属于会话，沿用现状（推荐）/ 保留窗口（需要每个窗口绑定自己的 scope，大幅扩大改动面，不建议）。
3. **对话与窗口之间的切换快捷键**：`Ctrl+`` / `Ctrl+Shift+``（推荐）/ F6（APG 惯例，但可能被浏览器截获）/ `Alt+Shift+W`。
4. **桌面窗口的层级**：在抽屉、弹出卡片、ask-float 之下，在 composer 和对话之上，即 25 档（推荐）/ 在抽屉和 ask-float 之上、模态之下（约 47 档，窗口会挡住用户刚唤起的卡片和下拉）。

---

## §15 拍板结果（用户，2026-10-21）

1. W-H hub 释放端点：**首版不做**，用前端账本提示 + 常驻「重新加载」。
2. 切换会话 / 取消选中：**关闭全部窗口**（沿用现状）。
3. 对话 ⇄ 窗口切换快捷键：**Ctrl+` / Ctrl+Shift+`**。
4. 桌面窗口层级：**25 档**（在抽屉、弹出卡片、ask-float 之下，在 composer 与对话之上）。

## r2 复审结论处置（glm，有条件通过，2026-10-21）

- #13 残端已闭合：mermaid plan 末尾「r3 补充二」已写入 `.mmd-figure` ResizeObserver 要求与联合验收。
- 采纳建议：§5.4 pageFocus 改为「任何落在窗口外的 focusin 都刷新 pageFocus」；跨断点进入手机形态时关闭已打开的窗口菜单（`pw-menu`）。
- 其余建议（账本 idle 假阳性、cycle 快照 MRU 抖动）不改，真机验收观察。
