# fleet-fill-budget —— fleet 抽屉按可用高度动态分配两块已结束行的显示条数

2026-10-28 用户需求:「显示上来说，agents 和 bash 内容应该通过调配显示数量把整个高度填满。」
分配策略(主会话 steer,用户拍板):**50/50 半高分 + 余量互让**,作废早期「按已结束行数加权」方案。
2026-10-28 验收打回后重写:地板优先、用户覆盖回传、bash-only 修复、按钮高估计。

## 结构

- 纯函数:`src/web-hub/ui/src/components/fleet/fillBudget.ts`
  - `computeFillBudget(measure, counts, overrides?): FillBudget | null` —— 预算计算;测量不可用
    (clientHeight 为 0,或**存在内容的块**测不到行高,如 happy-dom)返回 `null`,调用方回退旧
    固定 3/5 行为(字节不变)。不存在的块的行高**不是**前置条件(只有 bash 没有 agent 行时
    照样出预算,bash 拿整高)。
  - `fixedAgentRowCount(nodes)` / `topTerminalRowCount(nodes)` —— agent 块必显行数与顶层终态行数。
- 测量 + 接入:`src/web-hub/ui/src/components/drawer/FleetDrawer.vue`(搜 `fleet-fill-budget` 注释块)。
- 消费方:`FleetTree.vue`(仅 depth 0 吃 `terminalBudget` prop,子层保持旧 3/5)、
  `FleetBashJobs.vue`(`fill` + `terminalBudget` 两个 prop 都传才启用配额;`fillReady` 区分
  「首轮测量未完成」与「测量失败」)。
- 测试:`tests/web-hub/ui/fleet-fill-budget.test.ts`(纯函数 + 固定种子 LCG 性质测试 + 组件 +
  FleetDrawer 测量接线,mock `offsetHeight`/`clientHeight`)。

## 算法(computeFillBudget)

输入:`heightPx`(`.tree-scroll` 的 **clientHeight**)、两个实测行高、agent 块附加必显高
(`fleet-omitted` 省略行 + 已归档折叠头)、bash 块头部高(`.bj-sum` + 归档折叠头/omitted 标记)、
两块折叠按钮高(见下「按钮高度」)、四个行数(见 FillCounts)、用户覆盖(FillOverrides)。

0. **地板**:每块地板 = 必显 + `min(3, 已有结束行数)` 行高 —— 硬保证(旧规则只在「必显超半」
   时才压缩对方,漏算下限占用,验收随机输入 5.7% 溢出)。
1. **地板超高**:`floorA + floorB ≥ H` ⇒ 两块都取地板,放任滚动(规格允许的唯一滚动情形)。
2. **50/50 目标**:否则先各到地板,每块上限 `max(H/2, floor)`;一方地板超半 ⇒ 另一方让到
   `H − 该地板`(让完后仍 ≥ 自身地板),总高 ≤ H 恒成立。某块不存在 ⇒ 另一块拿整高。
3. **余量互让**:一块行数用尽填不满自己那份 ⇒ 剩余高度让给对方(A→B 再 B→A 各一轮收敛)。
4. **取整尾差回收**:按行高向下取整后两块各剩不足一行的尾差,轮流补给还能再放一行的块。
   性质:**只要还有被藏的行,总高 + 该块行高 > H**(性质测试钉)。
5. **折叠按钮预留(不动点迭代 + 对账)**:预留集合从空开始,每轮把「上轮结果里被折叠的块」
   并入预留重算,≤3 轮收敛(给 B 预留可能把本不折叠的 A 压成折叠,必须迭代);收敛后按
   **最终折叠集合**算渲染口径总高再补一轮尾差回收(预留了却没折叠的幻影预留会还回给
   还能放行的块 —— 只增行不改折叠方向,绝不溢出)。

## 按钮高度(agentFoldPx / bashFoldPx)

「显示已完成的 N 个」按钮本身占高,折叠时必须计入该块必显,否则按钮把内容顶出滚动条:

- 两块按钮**分别测量、分别缓存**(agent:`:scope > .run-more`;bash:`.bj-fill-more .run-more`)
  —— 首轮 agent 树按旧 3/5 常已渲染折叠钮,bash 组则未必,不能共用一份实测值。
- **没测到(0)时用该块已测行高作为估计**,不按 0 预留(验收 #4:首轮按钮还没渲染时
  预留为 0 导致溢出)。行高也测不到 ⇒ 该块预算本就回退 null,估计值无所谓。

## 测量与接线(FleetDrawer)

- `ref="treeScrollEl"` + `observeResize`(useSharedResize,共享 ResizeObserver)观察
  clientHeight;行高/附加高用已渲染元素的 `offsetHeight` 实测(`--fs-scale` 字号缩放、密度变化
  自适应),bash 行高与两块折叠按钮高有 last-good 缓存(预算把 bash 组收起后行不在 DOM)。
- **无反馈环**:可用高度只取 clientHeight(不取 scrollHeight),预算 → 内容高度不会反过来
  改变 clientHeight。
- **节流**:ResizeObserver 回调天然按帧对齐;`requestAnimationFrame` 被 source-scan 全仓禁用
  (§3.5),故不另加 rAF。不新增任何 timer。
- 重算触发:resize 回调 + 行数变化(字符串键 watch,nextTick 后测)+ 用户覆盖变化。树视图
  只在未选中 run 时存在,用 `watch(treeScrollEl, flush:"post")` 接管挂载/卸载与 observe 切换。
- `fillReady`:首轮测量完成后置位。FleetBashJobs 据此区分两种「预算 undefined」:
  未 ready ⇒ 保持展开供测量;ready 仍无预算 ⇒ 测量失败,回退到与不传 `fill` 完全一致的
  旧默认开合(>5 全终态 ⇒ 收起)。注意抽屉关闭(display:none)时测量同样为 0、预算 null ——
  此时不可见,重开后 resize 回调会重算出真实预算。
- **用户覆盖回传(验收 #3,手动操作优先)**:FleetBashJobs 用户开合组标题 ⇒
  `update:open`(折叠 ⇒ bash 块只占标题高,余量全给 agents);两块的「显示已完成的 N 个」
  ⇒ `show-all-terminal`(该块全显,剩余空间给另一块,可能滚动)。预算建议不触发这些 emit,
  无反馈环;用户置位后预算不再覆盖开合。

## 已知局限

- **行高不均**:agent 行可能因长标题/窄容器换行变高,bash 行展开日志尾也会变高;预算按
  「一条代表行」的实测高估算,多行高行会导致轻微溢出(`.tree-scroll` 兜底滚动)。
- **嵌套子树是近似**:`fixedAgentRowCount` 按默认开合(depth<3 展开)与旧 3/5 折叠统计;用户
  手动折叠/展开 `<details>` 或子层「显示已完成」后,实际高度与估算有偏差(顶层「显示已完成」
  与 bash 组开合已回传重算,子层的没有 —— 不会死循环,只是可能留白或溢出少许)。
- **幻影预留**:折叠按钮预留与最终折叠集合在个别输入上振荡(不动点不存在),此时按偏保守
  的一侧收敛,可能少显示一行;对账机制已把幻影预留的空间还给还能放行的块。
- **字号缩放(`--fs-scale`)变更不触发重测**:设置页改字号后,下次 resize 或行数变化时才按新
  行高重算(期间按缓存行高,可能短时偏差)。
- **容器内边距已扣除**:可用高 = `.tree-scroll` 的 clientHeight 减去自身上下 padding,再减
  `.fleet-bash` 的上下 margin/border(验收 r2:不扣会让「恰好填满」溢出约 8–10px)。
  `.fleet-archived` 等块内的几像素间距仍未单独计入,可能差一行。
- **已归档折叠**:整个 `.fleet-archived`(标题 + 展开后的行)计入 agents 块必显高;用户开合时
  组件发 `update:open`,抽屉重算。
- 测量不可用(happy-dom/jsdom 等 offsetHeight/clientHeight 恒 0 的环境)⇒ 整体回退旧固定
  3/5 行为(FleetBashJobs 经 `fillReady` 回退到旧默认开合,与不传 `fill` 字节一致)。
  ResizeObserver 缺失只意味着「不随尺寸变化重算」,挂载时的首轮测量仍会进行,不构成回退理由。
