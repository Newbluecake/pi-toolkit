# web-hub 切换会话 Aw Snap 崩溃排查（进行中）

状态：**等待复现**（2026-10-12 起，诊断面包屑已埋入 UI）。
本文档是调查交接：任何时候崩溃复现，按「复现 SOP」一节取证即可继续，无需重新了解背景。

## 现象（用户报告，2026-10-12）

开发 pi-toolkit 期间，web UI（LAN `http://192.168.31.25:7879`）切换到**某些**会话时页面崩溃；
切换到另一些会话正常。用户确认崩溃形态 = **浏览器 Aw Snap（渲染进程整页崩溃）**，
崩溃的会话类型没注意区分。用户无法预测何时会崩。

Aw Snap ≠ JS 异常：它是渲染进程级崩溃，典型原因是 OOM、栈溢出或触浏览器底层 bug。
Vue 报错不会导致 Aw Snap（最多白屏），所以排查方向锁定**内存/资源**而非应用异常。

## 已验证的事实（2026-10-12，deveye 真机）

- 当时在列的 4 个在线会话（apistrike / claude2api / pi-toolkit / bunker）来回切换两轮，**无崩溃**。
- 崩溃高发期截图里的离线会话（订阅转API架构方案、生成clash代理配置等）彼时已被删除，无法取样。
- 健康基线：bunker 会话 heap 45MB / DOM 4077 节点；各会话 `console` 零 error。
- 崩溃发生期间正值 toolkit 高频开发：UI 多次重建、hub 多次 restart、会话反复重连——**新旧码混部瞬态**未排除。

## 嫌疑假设（按优先级）

1. **keep-alive 多重订阅叠加 OOM**：`sessionKeepAlive`（docs/dev/web-hub-session-switch/）让浏览器保持
   最近 K 个会话的订阅与 transcript 驻留内存（默认 K=3）。若连续切换的都是巨型会话
   （长 transcript / 大 tool 输出），多个快照 + 当前渲染树叠加可能把渲染进程堆顶爆。
   崩溃表现为「切换时崩」与此吻合。
2. **开发期混部瞬态**：hub restart 后旧 UI 页面 + 新 hub 协议帧（或反之）触发路径态渲染，
   随版本稳定已自然消失——这能解释「这会又不崩了」。
3. **特定内容的路径级渲染**：超大 tool 输出 / 超长单行 / 特殊字符在 transcript、markdown
   （2 万节点预算）或 worktree graph 渲染中炸内存。需要崩溃现场才能证实/排除。

## 已埋的诊断面包屑（2026-10-12，随 build:web 进 dist，/webhub restart 后生效）

`src/web-hub/ui/src/App.vue`：每次路由切换覆写 localStorage 单 key `pwh_diag_route`：

```json
{ "hash": "#/agent/<agentKey>-<suffix>", "heapMB": 45, "dom": 4077, "at": 1739... }
```

**Aw Snap 不清 localStorage**——崩溃后重开页面即可读。零增长（覆写）、try/catch 包裹永不影响应用。

## 复现 SOP（下次崩溃后执行）

1. 用户：重开 web UI 页面，**不要**清浏览器数据；最好记住崩前点的是哪个会话。
2. 用 deveye 连上页面（`deveye tabs` 找 tab），读面包屑：
   ```js
   deveye eval -t <tabId> --no-snapshot --json \
     "JSON.parse(localStorage.getItem('pwh_diag_route') || 'null')"
   ```
   → 得到崩溃时切入的会话、当时堆内存、DOM 节点数。
3. 若 heapMB 显著高于基线（45MB）或逐次切换递增 → 假设 1（OOM）；若 heap 正常 → 假设 3（内容路径）。
4. 进一步取证（按假设选）：
   - OOM：连续切换同一批重会话，每步记 `performance.memory.usedJSHeapSize`，看是否单调涨到数百 MB；
     检查 keep-alive K 值与实际驻留（`pwh_keepalive` 浏览器偏好，默认 3）。
   - 内容路径：拿到会话名后读该会话 jsonl，找异常大的 tool 输出/长行，用同样内容在测试里复现渲染。
5. Chrome 崩溃报告（可选）：`chrome://crashes` 或 `~/.config/google-chrome/Crash Reports/`——
   有 dump 可看崩溃签名（OOM vs 栈溢出）。

## 收尾条件（根因修复后）

- [ ] 移除 App.vue 的 `pwh_diag_route` 面包屑 watch（含注释块），补一条回归说明。
- [ ] 本文档移入对应修复的 docs/dev/ 目录或归档，并在 AGENTS.md 相关段落补一行结论。
