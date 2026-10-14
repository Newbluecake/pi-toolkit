# web-hub 切换会话 Aw Snap 崩溃排查

状态：**已定位并修复**（2026-10-14）。根因为 transcript.css 的 `.tx-item { content-visibility: auto }` 与跟随到底滚动补偿形成排版振荡，详见下方「根因」。

## 根因（2026-10-14 定位）

`.tx-item { content-visibility: auto; contain-intrinsic-size: auto 120px }` 的 120px 占位 ↔ 真实高度互换，与 Transcript 跟随到底的滚动补偿（scrollTop 追 scrollHeight）形成**排版振荡**：屏外条目进出视口时占位/真实高度反复互换，滚动补偿又不断改写 scrollTop 引发新一轮互换，主线程卡 30–50s 而 JS 堆不涨，随后渲染进程崩溃并生成转储。用户 Edge 155/Win10 的 `edge://crashes` 在 8 分钟内记录了 11 条崩溃。

## 二分过程

1. hub 日志对齐崩溃时刻，排除服务端因素。
2. 真机 DevTools Console 不刷新页面，用 `document.styleSheets[0].insertRule('<sel>{display:none!important}',0)` 逐类隐藏：隐藏 `.transcript` 不崩 → 在 transcript 内逐类隐藏，隐藏任意体量大的一类都不崩 → 判断为高度/排版相关而非某类内容。
3. 注入 `.tx-item{content-visibility:visible!important;contain-intrinsic-size:none!important}` 后不再崩溃——实锤。

## 排除项（红鲱鱼）

隐私锁/密码表单、`.tool-progress` 遮罩动画、`pwh_motion` 动画偏好、localStorage 内容、图片解码均与根因无关。早前怀疑的「僵尸 SSE socket」「keep-alive OOM」「内容路径渲染」也均被排除（见下文排查记录）。

## 教训

无头 Chromium（Linux 软件合成、较旧版本）复现不了此类排版振荡崩溃，真机 CSSOM 二分（insertRule 逐类隐藏）最有效。

## 修复

删除 `.tx-item` 的 `content-visibility` / `contain-intrinsic-size` 规则（styles/transcript.css），视觉巡检反转为 `tx-item-no-content-visibility`（scripts/web-hub/visual/checks-body.ts + checks-body-applicability.test.ts）。

## 诊断代码清理（2026-10-14）

trace.js（pwh_diag_trace ring + 启动 dump + pwhDiag）、App.vue 的 pwh_diag_route 面包屑、两个 THROWAWAY 测试（bunker-repro / bunker-render-repro）及 source-scan 两条对应 TEMPORARY allowlist 均已移除；pwh_diag_scroll 面包屑暂留给 #19（怀疑同根因，观察中）。

---

## 2026-10-13 晚 决定性取证链（bunker = a2162331-iOEqbE，「AgentEnv部署架构调研」）

**症状**：主页/其他会话正常；切 bunker ⇒ 主线程 30–50s 循环 block，堆平（32MB 不动）、DOM 静止 357 节点（骨架），最终 Aw Snap。

1. `pwh_diag_trace`（85026ea，sync localStorage 面包屑，`pwh_trace=1` 门控）崩前轨迹：全部组件 mount 完成、`state:history:done`（400 entries/2MB 帧/reduce 1ms）⇒ **freeze 在 history 应用之后、首个内容渲染完成之前**。
2. 离线回放真实 live 帧（tests/web-hub/ui/bunker-repro.test.ts，THROWAWAY 未提交）：reduce 1ms / buildTxEntries 2ms / parseMarkdown 262 文本 54ms / findPathRefs 527 文本 64ms / Prism 58 fence 36ms——**内容无辜**。
3. happy-dom 全挂载（bunker-render-repro.test.ts）：首个内容 flush ~1s（TxAssistant 850ms/MarkdownView 650ms），全树仅 6071 节点——也远低于 50s。
4. **headless Chromium + CDP Profiler 在 loopback（127.0.0.1:7878，token）切 bunker 完全不卡**（dom=6552 渲染完，heap 10MB，98.2% idle）——`/tmp/bunker-prof.mjs`。
5. 结论：**bunker × LAN（password 客户端）组合才崩**；loopback 同会话不崩、LAN 其他会话不崩。嫌疑：两 client 差异路径（password-client.js vs token-client.js，各 ~1900 行平行实现）/ LAN plaintext 非安全上下文 API 差 / LAN SSE 故障面。

**待做实验**：

- 用户 Chrome 开 loopback（`http://127.0.0.1:7878/`，token 在 `~/.pi/agent/web-hub/token`）切 bunker ⇒ 不卡 = LAN 实锤 + 临时通道。
- 造强制走 password-client 的构建在 loopback 复现（免 LAN 密码）。
- LAN 实锤后 diff 两 client 的 SSE/subscribe/重连路径。

**环境注意**：hub 进程 pid 2162282（13:30 启动）**动态重解析 dist**——19:11/19:48 的 build:web 无重启即被伺服。用户页面已确认跑 BuMVt0qE（含 tracer 构建）。

**监控装置**：`pwh_diag_trace`（85026ea）；`pwh_diag_scroll`（7b0a8b1，滚动记忆）；deveye 主 tab eval 心跳（pwh_diag_perf，刷新即失）；reader tab 模式（同源 list tab 读 localStorage）。

**退出条件**：根因修复后移除 pwh_diag_route/pwh_diag_scroll/pwh_diag_trace 三处面包屑 + source-scan allowlist 两条 TEMPORARY + 两个 THROWAWAY 测试。

---

## 早前：第二次复现取证（2026-10-13 白天，旧构建）

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

## 第二次复现取证（2026-10-13 13:30 CST，面包屑首次实战）

时间线（UTC+8）：

- 13:30:35 hub 重启（新 build bb8a5e4-dirty，含面包屑），两个 managed rpc 会话自动 restore。
- 13:30:40–54 用户页面（已是新 UI）正常渲染 pi-toolkit 与 bunker 会话（hub.log 有 preview probe）。
- ~13:30:50–56 第一次 Aw Snap（bunker 会话页）。
- 13:30:56.6 面包屑写入：`{hash:"#/agent/a2162331-iOEqbE", heapMB:22, dom:134}` —— 这是**重载后启动早期**的值（面包屑记录的是路由切换时刻，不是崩溃时刻！dom 134 = 只有启动 splash），说明重载后卡在加载态、transcript 尚未渲染即再次崩溃。

面包屑读数排除「keep-alive OOM」假设：进入会话时 heap 22MB / dom 134，远低于基线。
注意：面包屑的 heap/dom 是**进入路由时**的采样，对崩溃时刻无代表性（设计教训，后续可考虑定时追加采样）。

### 崩溃会话画像（bunker，sessionFile 3.2MB / 408 行）

- 含 10 个 toolResult 图片块（base64 PNG，最大 477KB，解码后合计约 43MB）——但 UI 把 image 块渲染成 `[image]` 占位符（state.js resultText），**不解码**，已排除。
- 最大文本块 31KB，无病态单行/控制字符。
- 全量文本过真实 `findPathRefs`：无慢扫描、无灾难回溯（/tmp/pathregex-test.mjs）。

### 排查中发现的确定性故障面（比崩溃本身更可复现）

**新打开的页面（LAN 密码模式）卡在「加载中…」（conn 永远 "connecting"），数分钟后渲染进程主线程彻底卡死**（同源所有 tab 连带无响应——Chrome 站隔离共享 renderer），预期最终 Aw Snap。这与用户「重载后又崩」的路径吻合。

实验矩阵（2026-10-13 下午）：

| 环境                                                      | 结果                                                |
| --------------------------------------------------------- | --------------------------------------------------- |
| 用户 Chrome @LAN（密码模式，7879）                        | 卡启动 → 主线程卡死（deveye eval 从可用到全线超时） |
| 同 tab 内手动 `new EventSource('/api/events')`            | 起初正常（hello/agents/... 全到），后期也开始挂起   |
| 同 tab 内 `fetch('/api/events')`                          | **永不响应**（请求字节已进 Node，Recv-Q=0）         |
| 同 tab 内 8 并发 `fetch('/api/session')` 等其他端点       | 全部秒回 200                                        |
| curl LAN /api/events 无 cookie                            | 秒回 401（handler 活着）                            |
| curl loopback（token，7878）/api/events                   | 完全正常，持续流                                    |
| Node harness 真实 token-client + state.js 对 live hub     | 完全正常：7ms open、history 400 条、60s CPU 582ms   |
| headless chromium 整机复现（loopback+token，进入 bunker） | 完全正常：1s 启动、5884 DOM 节点渲染、60s 稳定      |
| u2（192.168.32.49）早已打开的页面                         | 一直正常（旧连接活着）                              |

关键矛盾点：`/api/events` 带有效 cookie 在 LAN 挂起，但同一函数（requireLanSession）同 cookie 的其他端点正常；handler 代码路径（isSseRoute 分支 → attach → 同步写 hello）无挂起点。hub 进程 inspector（SIGUSR1 已开，ws://127.0.0.1:9229）显示 `process._getActiveRequests()` 为空。

**主嫌疑：Aw Snap 后 Chrome 网络栈残留的僵尸 SSE socket**——renderer 崩溃/卡死后其 SSE 连接未被正常关闭，hub 侧 response 永不结束；Node HTTP/1.1 keep-alive 语义下同 socket 的后续请求要等前一个 response 结束才解析，于是落在僵尸 socket 上的新请求（含新页面的 /api/events）永久挂起。佐证：hub 侧多个 .38 socket 曾带 46B 未确认 Send-Q（ping 帧发出无 ACK）；关 tab 后旧 socket 仍存留数分钟。

### 健壮性修复（2026-10-13，随验收结论修正机制叙述）

已修（客户端）：两个 client 新增 CONNECT_TIMEOUT_MS=10s（10s 无 hello ⇒ 关旧连接按 backoff 重建，全分支无泄漏）；App.vue 加 BOOT_FAIL_MS=15s 启动失败错误态（role=alert + 重试按钮真重建，首个 open 后失活）。

机制修正（验收时读码确认）：原叙述「主线程饿死导致 45s 看门狗回调不执行」**不成立**——`armWatchdog` 在 45s 静默时先 `onConn("reconnecting")` 再 `openStream()`，是普通 setTimeout，不依赖主线程健康。准确机制：**45s 看门狗确实会把 conn 翻成 reconnecting，但 reopen 的新 EventSource 再次挂上僵尸 socket（accepted-but-silent，无 hello 无 error），于是每 45s 循环一次「关旧开新再挂起」，永远到不了 open**。残留矛盾：卡死页实测 splash（conn=connecting）持续 15 分钟而代码应在 45s 后离开 connecting——尚未完全自洽，可能与「后期主线程饿死」或观察口径有关，留待清态复现时验证。

### 待验证 / 下一步

1. 清态复现：用户关闭所有 web-hub tab + /webhub restart 后，用**全新**页面验证是否还卡启动（排除僵尸 socket 后应恢复）。
2. 若清态后仍复现 → 用已挂的 inspector 深挖 lanSse/requireLanSession；若能复现卡死，可 CDP Debugger.pause 抓 busy stack。
3. 无论根因，客户端健壮性缺口要补：openStream 后 N 秒收不到 hello 应视为失败并换全新连接重试（防僵尸 socket 永久挂起启动流程），卡死态要有可见错误而非永远「加载中」。
4. 主线程卡死本身（wedged renderer）的具体旋转代码仍未抓到栈——下次复现且 eval 尚可用时，优先用 CDP Debugger.pause 抓栈（headless repro 脚本 /tmp/uirepro/repro.mjs 已带此逻辑）。

## 嫌疑假设（按优先级）

> 2026-10-13 更新：假设 1（keep-alive OOM）已被面包屑排除（见上节）；「内容路径」中图片解码/base64 渲染/路径正则均已排除。当前主嫌疑转为「崩溃后浏览器侧僵尸 SSE socket 导致新启动挂起 + 主线程卡死代码」（见上节）。

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
