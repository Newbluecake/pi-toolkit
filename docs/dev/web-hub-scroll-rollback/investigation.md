# web-hub 会话切换滚动回退排查（investigation）

状态：**取证中**（2026-10-13 立案）。面包屑已上线，等复现数据。

## 症状（用户报告，2026-10-13）

会话 A 已滚动到底部 → 切换到会话 B → 做了一些操作（不确定是否有影响）→ 回到 A → **A 的消息视图往回滚动了一些内容**（显示的是比底部更早的内容）。单纯快速切换会话（A→B→A）**不复现**（未大量验证，简单试过几次）。桌面端。

用户直觉：「消息定位的变量可能被某种方式影响了」。

## 相关机制（读码结论）

- 滚动记忆（`useScrollMemory.ts` + `Transcript.vue`，session-switch 计划 §1.4 E1）：按 agentKey 存 `{following}` 或 `{following:false, anchorIds, anchorOffsetPx}`；离开（Transcript onBeforeUnmount）时保存，回来（setup + onMounted nextTick）时恢复。`following:true` ⇒ 回底部；否则锚点行 + 像素偏移恢复。
- keep-alive（E1+D2）：切走后 A 仍保持订阅（K=3），**A 的消息在离开期间继续流入 state**——这是「做了一些操作才有感」的结构性基础（离开期间 A 增长了）。
- 已知限制 R8（plan.md:380）：恢复后异步排版/快照替换造成的小幅偏移，v1 接受。用户感知的偏移量**疑似超出** R8 的「小幅」。

## 候选嫌疑（按可能性排序）

1. **following=false 离开 + 离开期间 A 流式增长**：保存走的是锚点恢复，锚点行以下的流式内容（assistant 消息/工具卡）在离开期间继续变高/增多 → 恢复后锚点行位置精确还原，但新尾巴在视口外 → 感知「回滚了一截」，回滚量≈离开期间的增长量。前提：保存时 following=false 而用户自认为在底部（>64px 阈值裂缝，或某条非用户路径误翻）。
2. **following 被非用户路径误翻 false**：`onScroll` 里 `distanceFromBottom > 64` 就翻 false。静态分析过流式 pin/窗口移动/clamp 路径均未找到桌面端的误翻点，但没有实证。
3. **快照替换时序**：回到 A 时主订阅切换触发 snapshot_reply 整体替换 entries（H1→H2），锚点 id 集在替换前后的歧义集可能变化（同毫秒时间戳的 k: id）。

## 取证（2026-10-13 已上线）

- commit `7b0a8b1`：`Transcript.vue` 写 `pwh_diag_scroll`（localStorage，12 条 ring 覆盖写）：`save`（following/锚点/scrollTop/scrollHeight/clientHeight/entriesLen）、`restore-setup`（j/start/off）、`restore-write`/`restore-el-miss`/`restore-setup-miss`、`mount`（following 初值）、`unfollow`（**翻转瞬间的距离与几何**——嫌疑 2 的冒烟枪）。
- commit `361a4be`：source-scan allowlist 补 Transcript.vue（TEMPORARY 注释）。
- 复现步骤：`/webhub restart` 刷新 → A（有流式输出的会话）滚到底 → 切 B 做操作 → 回 A 复现 → `localStorage.pwh_diag_scroll` 读数（deveye 可直接读，先 `deveye tabs` 找 192.168.31.25:7879 的 tab）。

## 退出条件

根因确认并修复后：移除 `Transcript.vue` 的 diagScroll 及全部调用点、移除 `tests/web-hub/ui/source-scan.test.ts` 的 allowlist 条目与注释、关闭 todo #19、本文档标记结案（或归档结论）。

## 2026-10-14 更新

#11（Aw Snap）根因 content-visibility:auto 已移除；怀疑本问题同根因（屏外条目按 120px 占位，恢复 scrollTop 时落点偏）；pwh_diag_scroll 面包屑暂留观察。
