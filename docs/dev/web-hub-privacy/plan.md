# web-hub 会话隐私锁（privacy mode）设计 v2.1

状态：v2.1（2026-10-13，按复审 r_X9GBY3TX 的轻量打回修订：N1 取消标记路径、N3 R4 诚实化、N4 帧管线入拆包、N5 fork 时序提前、N6–N9 小项）。
v1 评审（r_GDBGK5S6）：打回——P0 + 6 P1，v2 已全部落实。
实施：P1 hub / P2 UI / P3 收尾均已提交（2026-10-13）。

## 需求裁决（用户四问，2026-10-13，不变）

| 维度 | 裁决                                                                                    |
| ---- | --------------------------------------------------------------------------------------- |
| 防谁 | **投屏 / 路过瞥见**（shoulder-surfing），不防同 LAN 恶意登录用户                        |
| 粒度 | **按会话单独标记**                                                                      |
| 强度 | **L2 查看时二次验证**：查看锁定会话要输 LAN 密码；transcript 数据照常下发（见「边界」） |
| 回锁 | **切换 + 超时 + 手动** 三路；(v2 增补评审 #8) **`visibilitychange: hidden` 立即回锁**   |

## 边界（明确不做）

- **不做 L3 服务端隔离**：锁定会话的 SSE/快照数据照常到达客户端，L2 的固有残余面（评审 #14，全部知情接受）：`GET /api/history`、`/api/run/*`、`/api/preview`（任意绝对路径）、wtdiff 端点不受锁约束；锁定会话仍参与 keep-alive 订阅（数据驻留内存但不渲染）；会话名与 cwd 不打码；懂 devtools 的登录用户可绕过。
- **不做 per-user ACL**；**飞书通知通道不在防护范围**（用户裁决）。
- **首版不做独立 PIN**：复用 LAN 密码。(v2 评审 #12) 风险显式记录：高频二次验证键入的恰是主密码，投屏/旁观场景恰好暴露它，且 plaintext HTTP 下每次解锁是一次明文传输——这是用户已做的取舍；方案在低权限 PIN 上留演进位（verify 端点届时换校验对象即可，UI 不变）。
- pi 原生 `/fork`（agent 侧发生，hub 无感知）不带锁 = 已知限制（见 R2）。

## 数据模型（v2 按评审 #4/#9 改）

- 锁标记按 **sessionId** 持久化：hub 侧 `<stateDir>/privacy.json`（**走 `HubPaths.stateDir`**，复用 avatar/spawn 的原子写与私有目录助手；0600；先写盘后改内存，写失败整体报错）。
  形状：`{ "version": 1, "locked": { "<sessionId>": true } }`（v2 评审 #15：去掉无消费者的键前缀与 lockedAt）。
- **上限拒绝而非淘汰**：条目超 **4096** 返回 `E_LIMIT` 拒绝新增（v2.1 N7：每条几十字节，4096 也毫无成本；避免孤儿标记叠加 512 硬上限导致 E_LIMIT 先于真实需求触发。孤儿标记首版不 GC，无害：集合求交无匹配项）。
- 文件损坏/不可读：改名 `.bak` 后以空集启动，日志 + `/webhub status` 告警；`webHub.privacy=off` 不删文件，重开标记仍在。
- 孤儿标记（会话文件已删）首版不 GC（无害：集合求交时无匹配项），记录为开放问题。

## 接口（v2 按评审 #2/#3/#5 改写——无状态，无授权表）

两个端点：**`lock` 两个 listener（LAN + loopback）都挂；`verify` 仅 LAN**（评审 #7/#10 + v2.1 N1）：

- `POST /api/privacy/verify` `{ password }` → `200 {ok:true|false}`：**无状态**校验当前会话用户的 LAN 密码。用于查看解锁。错误密码返回 `200 {ok:false}`——**绝不用 401/E_AUTH**（那是会话失效语义，会触发 UI 的 conn:"auth" 掉线流程；评审 #3）。
- `POST /api/privacy/lock` `{ agentKey, sessionId, locked, password? }`：
  - `locked:true`：直接生效（标记不需要密码——把东西锁起来不是敏感操作）。
  - `locked:false`：**LAN 上**必须内联 `password`，服务端当场校验后才解除（评审 #2：这才是服务端强制执行点）；**loopback 上不要求 password**（v2.1 N1：token 模式无第二凭证，与「点击确认查看」同强度，按 listener 分支）。
  - **sessionId 一致性校验**（评审 #5）：与 preview 的 ⑤ 先例相同——hub 校验该 agent 当前 `session.sessionId === sessionId`，不符返回 `409 E_SESSION_CHANGED`（**复用** `API_ERRORS` 已有码，http-contract.ts:85；agent 无 session 时同码处理），防止「看到 A 点锁、期间 /new、锁落到新会话」的竞态。
- `POST /api/privacy/verify` **loopback 上不挂**（404）——它没有密码可验（v2.1 N1）。
- **取消标记的 UI 流程**（v2.1 N1）：LAN 上「移除隐私标记」走独立密码弹窗（密码只存在于该请求内，不缓存、不复用查看解锁的任何状态）；loopback 上是一个确认对话框。**命名区分两个动作**：「隐私标记」（持久，卡片/头部操作）vs「立即锁定」（视图回锁，详情头部按钮）——i18n 文案分开，不混用。
- **标记入口补触屏路径**（v2.1 N1；v2.1+ 用户裁决后弱化）：卡片锁标悬停显示是桌面便利；详情头部保留锁按钮作为键盘/备用入口。**手机 band 整体不启用本功能**（见「客户端行为」），不再需要专门的触屏设计。
- **校验管线**（评审 #3）：从 `runLanLogin` 抽出 `verifyPassword(userId, password)`——会话取 userId → `getUserSummary(userId)` 取 username → `getUser` → 共用 KDF admission → 比对。**计入同一个 per-IP login limiter**（fail 计数与登录互相影响是特性：同一凭证同一强度），429/E_LOCKED 复用登录的 `Retry-After` 倒计时 UI。请求体上限 `LAN_LOGIN_BODY_BYTES`（4KiB）。
- 审计：`audit.ts` 新增 `auditPrivacy`（强类型 per-feature 惯例）；agentKey 按现有惯例明文（评审 #10 指出 v1 的「哈希级标识」与惯例不一致，纠正）；**password 永不入日志**。
- cap：`privacy.v1`，由 `extraHubCaps` 在 hub 启动时按 `config.privacy` 存在与否**静态**计算（评审 #10：必须 HubInfo.caps 与 hello_ack.caps 两面同源；LAN 是否起来是运行时的，cap 不跟随它变）。

## 锁状态下发（v2 按评审 #4 改：hub 全局帧，不动卡片投影）

- 新增 SSE 事件 **`privacy`**：payload = 当前锁定的 sessionId 集合（全量，集合很小）。`openEvents` 连接突发里**排在 `agents` 之前**（与 spawns/load 同构先例）；lock/unlock 变更时广播全量。
- UI 客户端求交：`lockedSet.has(agent.session?.sessionId)`。`/new`、`/resume` 换 sessionId 自动正确；agent_up/session 帧时序无需关心（评审 #4 的三处投影改动全部消失）。
- **fail-closed**：cap `privacy.v1` 存在但尚未收到 `privacy` 帧时，UI 不渲染任何会话详情（防降级窗口）。
- (v2 评审 #11；v2.1 N3 诚实化) 版本错配残余：旧 UI 标签页遇到新 hub 会忽略 `privacy` 帧（fail-open），见 R4。

## 客户端行为（v2 按评审 #1/#7/#8 改）

- **P0 修复——门控放在 DashboardView 层**：锁定会话**不挂载 `<AgentDetail>`**，改挂独立 `<PrivacyLockScreen>`（只含：会话名、锁图标、密码框、解锁按钮）。一次性移除 DetailHeader（WorktreePanel/GraphPanel/TodoPanel/BashJobsPanel——后者带命令+日志尾部，是投屏最危险的泄露面）、AskUserForm 弹窗、FleetDrawer、DetailDock（待发消息队列）、Composer、PreviewHost 浮层。
  - 回锁/标记瞬间：若正在查看该会话，立即切锁屏；**同时关闭该会话已打开的 preview/wtdiff/graph 对话框、清 toast/cmdResult**。
  - ask_user 等待中的锁定会话：卡片保留 needsAnswer 徽标，内容解锁后才可见。
  - **测试断言「锁定态下 AgentDetail 整棵子树不存在」**（不只 transcript）。
- **标记入口**：AgentCard 锁图标（锁定态常显；未锁定悬停显示）；详情头部有同功能锁按钮（键盘/触屏通用入口）。
- **仅桌面端生效**（用户裁决 2026-10-13：手机端不需要）：UI 只在桌面 band（视口 ≥768px，`useMedia`）启用锁定交互与锁屏；移动 band 完全忽略 `privacy` 帧（照常渲染、无锁标）。服务端照发不误（帧很小），强度边界随之变为「手机端不防」——与威胁模型（投屏的是电脑屏）一致。
- **回锁四路**：切换路由即回锁（视图态纯内存）；无交互超时（**「交互」= 键盘/指针/触摸/滚动事件，只在 viewing 该会话时计时**；超时为 **browser pref，默认 10 分钟，范围 1–60**，`pwh_*` localStorage 先例，入口放设置浮层）；手动锁定按钮；`visibilitychange: hidden` 立即回锁。
- **解锁**：锁屏输密码 → `verify` 200{ok:true} → 渲染详情。密码错误/429 复用登录同款错误与倒计时 UI。
- **loopback/token 模式**（评审 #7，取 (a)）：锁同样生效，但 loopback 没有第二凭证——锁屏显示「点击确认查看」而非密码框（诚实降级：不假装有密码强度，也绝不出现「看似锁着实则没锁」）。`/webhub status` 提示该差异。
- 旧 hub 无 `privacy.v1` cap ⇒ UI 无任何锁定痕迹（锁标也不显示），字节级回到无此功能。

## 设置（v2 按评审 #9）

- `webHub.privacy`（默认 `true`）：settings 规格注册；经 `HubConfig.privacy` 注入，`hub.ts` 是唯一装配点；非 live（改后 `/reload` + `/webhub restart`）。off ⇒ 不挂路由、不发 `privacy` 帧、不下 cap、UI 零痕迹、已有标记文件保留。

## Fork 继承（v2 按评审 #6；v2.1 N5 定时序）

- **hub 发起的 fork 继承锁**：session-history 对话框的 fork 走 hub 快照，新 sessionId 在 spawn 前已知（`hub/spawn/routes.ts` 的 `newId = randomUUID()`）——**先把新 sessionId 的标记写入 privacy.json，再发起 spawn**；写盘失败/E_LIMIT ⇒ 整个 fork 请求失败（fail 方向与 store 一致，不放行无锁会话）。
- pi 原生 `/fork` 在 agent 侧发生，hub 无法感知 → **已知限制**写进风险节。
- **发布顺序**：fork 继承并入 P1 包，P1/P2 不得先于它发布（否则 fork 绕过是线上已知漏洞）。

## 风险

- R1（接受）：L2 固有残余面，见「边界」节完整列举（评审 #14）。
- R2（接受+部分缓解）：fork 绕过——hub 发起的 fork 已继承；pi 侧 /fork 是已知限制。盯梢：若用户实际用 fork 绕过自己，说明威胁模型变了，应升级 L3。
- R3（接受）：keep-alive 驻留。（可选优化，非首版：回锁时退订锁定会话。）
- R4（v2.1 N3 诚实化）：旧 UI 标签页遇新 hub 会忽略 `privacy` 帧 = fail-open，**接受，不可缓解**（旧 JS 里根本没有可追加的文案机制；buildId 仅用于版本戳显示）。升级说明写明「升级 hub 后刷新所有标签页」。
- R5（v2 评审 #12）：主密码高频暴露——见「边界」PIN 演进位。

## 实施拆包（v2 按评审 #13）

| 包      | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 测试锚点                                                                                                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 hub  | `hub/privacy/{store,routes}.ts`、`ports.ts` 端口、两 listener 分发点、`audit.ts`、`version.ts` cap（`privacy.v1`）、`extraHubCaps` 两面同源、`verifyPassword` 抽取（**只记 fail，成功不调 `limiter.succeed()`**——避免解锁成功重置登录退避，复审 N-3）、settings 规格 + HubConfig 装配、**`privacy` SSE 帧管线**（v2.1 N4：`SSE_EVENTS` 注册、`HubEvent` 联合、`onHubEvent` 分支、sse.ts 事件名类型；**直发不入 replay ring**——连接突发必发全量快照且排在 `agents` 之前，ring 回放不得出现 privacy；UI 侧两个 transport 同形适配 + `logic/contract.js` 常量 + `types.ts`）、**fork 继承**（先写标记后 spawn，失败则 fork 失败） | privacy store（原子写/E_LIMIT/损坏 .bak）、routes（CSRF/sessionId 409/密码错误 200{ok:false} 不 401/limiter 共享/loopback 无 verify）、caps-coexist、deadline-nesting、两 listener 对等、**verifyPassword 抽取后的登录回归**、**privacy 帧先于 agents 的顺序测试**、**fork 先写标记后 spawn** |
| P2 UI   | `privacy` 帧进 state.js（fail-closed 窗口）、DashboardView 门控、PrivacyLockScreen 组件（含 loopback 点击确认变体）、卡片锁标 + 详情头部锁按钮、**桌面 band 门控（≥768px，手机 band 零痕迹）**、标记 vs 立即锁定命名分离、四路回锁、密码框复用登录错误 UI、取消标记弹窗（LAN 密码 / loopback 确认）                                                                                                                                                                                                                                                                                                                            | 锁定态 AgentDetail 子树不存在、回锁四路、浮层关闭、无 cap 降级、loopback 变体、**手机 band 忽略 privacy 帧**                                                                                                                                                                                  |
| P3 收尾 | `/webhub status` 提示（含 loopback 无密码差异）、文档/AGENTS.md                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | status 输出                                                                                                                                                                                                                                                                                   |

每包真机验收：标记→锁屏→密码解锁→三路回锁（含切标签页）→hub 重启锁还在→/new 后新会话无锁→restore 同 sessionId 锁保持→多标签页一致→两 listener 行为。
