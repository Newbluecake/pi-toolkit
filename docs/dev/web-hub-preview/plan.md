# web-hub「内容预览」施工方案（plan v3 · 最终版）

> 状态：**最终版**（v3，不再送审）。修订脉络：v1 → v2 吸收首轮评审（2 P0 / 7 P1 / 5 P2）；v2 → v3 落地主会话 2026-10-05 对二轮评审的裁定；v3 在 2026-10-05 补入三项用户拍板（§9）。
> 需求（用户已拍板）：在网页上**点击消息里的路径**就能预览，包括
> ① 已上传图片的灯箱大图（上传管线目前只进不出）；② 会话 cwd 内文件的预览（文本有大小上限；常见图片直接显示；其余二进制提示「不支持预览」）。
> http(s) 链接沿用现有 markdown 白名单，**不做** unfurl 预览卡（用户已否）。
>
> **基线：`2282fd8`（master HEAD）**。已合入：spawn SP9（`cf17193`）、SP10（`2282fd8`）、Markdown 白名单扩展（`ffb0e2a`）、ask_user 移位（`42561ec`）、notification 紧凑行（`d37c1c2`）。
> **在途线**：
>
> - spawn SP13：改 `tests/integration/**`、`tests/conformance/**`、`AGENTS.md`、`docs/dev/web-hub/lan-plan.md`、`hub/hub.ts`（一处小修）、**`ui/src/App.vue`（navigate 接线）**；
> - **上传落盘生成名改造**：落盘名改为 `<uploadId>.<ext>`，原始名只留在 wire/UI；改动集中在 `hub/uploads.ts` 及其测试；
> - fleet F3a：新文件 `hub/run-file-reader.ts`，与本方案不重叠。
>
> 本文引用代码一律以**符号名**为准，行号只作参考；每个包开工前按 §2.3 的闸门核对。本文只写方案，不改实现。

## 用户拍板（2026-10-05，经主会话转达）

| #   | 事项                        | 拍板                                                                                                          | 落点                                                        |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| U1  | `webHub.preview` 默认值     | **默认 `"on"`**（LAN 可用）。理由：用户是 LAN 上的唯一使用者，且启用了密码认证；§5.1 的风险由用户**明示接受** | §0、§4.1、§5.1、PV1、PV8                                    |
| U2  | home 作为 cwd 时的 LAN 预览 | **允许**，靠拒绝列表兜底（若拒绝，大半用途就没了）                                                            | §4.3、§5.2、R1                                              |
| U3  | 上传附件在 LAN 上的可见范围 | 改为**会话可见者共享**。这是对 upload plan §5.1「仅上传者」裁定的**修订**；影响面见 §5.4                      | §4.2、§5.4、§7-D4、PV2b、PV3、PV8（upload plan 只追加备注） |

## v3 修订记录（主会话 2026-10-05 裁定，逐条）

| #   | 裁定                                                      | 落地                                                                                                                                                                                                                                                                                                                                                                                      | 位置                    |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | App.vue 冲突窗口（采纳）                                  | `App.vue` 列入 **SP13 的文件域**（navigate 接线）；PV6 的开工闸门增加「SP13 已合入，或已 rebase 到含 SP13 navigate 接线的 master」；PV6 验收增加 navigate 回调不丢失的回归测试                                                                                                                                                                                                            | §2.2、§2.3、PV6         |
| 2   | scopeKeyOf 缺 cwd（采纳，双保险）                         | `scopeKeyOf = agentKey\|sessionId\|cwd`；`logic/state.js` 的 `sameSession` 也比较 `cwd`。不变量：同一个 sessionId 内 cwd 不会变（sessionManager 创建时钉住，resume 时是同一个文件）。仍要双保险，是因为只需一行字符串拼接，就能防住将来 fork/resume 语义变化或上报数据出错。补一条「cwd 变化 ⇒ 作用域失效」的测试                                                                         | §3.2、§4.6、§7-D13、PV4 |
| 3   | 旧布局上传兼容（采纳，legacy 分支）                       | 没有 `diskName` 的旧记录走 legacy 分支：basename 必须与 `rec.safeName` 逐字一致，所在目录名必须与 `rec.id` 逐字一致，其余准入不变；**不做文件迁移**。验收增加「hub 重启恢复后，旧上传仍可预览」                                                                                                                                                                                           | §4.2、PV2b              |
| 4   | 图片身份缓存的失败路径（采纳，改为流式哈希）              | 图片**一律边流边算 sha256**，不用身份缓存；读完后若 identity 前后不一致或哈希不匹配，立即 `destroy()`，让响应以不完整结束。**禁止**「发头之后再切到完整哈希路径」的做法。身份缓存只用于文本、且只在发头之前。补 HTTP 测试：缓存命中后 ctime 或 size 发生变化 ⇒ 客户端拿不到完整的 200                                                                                                     | §4.5、§7-D16、PV2a、PV3 |
| 5   | 哈希单飞（采纳）                                          | 文本复核的整文件哈希按 `(uploadId, identity)` 单飞；单飞任务有自己的预算和 AbortController；最后一个等待者离开时任务中止；写清超预算时的错误码和审计原因                                                                                                                                                                                                                                  | §4.5.3、PV2a            |
| 6   | 401/404 不对称（已裁定）                                  | 维持两个 listener 的现状，preview 不改变；记入 §9                                                                                                                                                                                                                                                                                                                                         | §4.7、§9                |
| 7   | 工具调用参数路径可预览（用户 2026-10-05 现场提出，采纳）  | `ToolCard.vue` 展开后的 **Input 区**（`argsText` 的 `<pre>`）经 `PathText` 渲染，read/edit/bash 等工具参数里的绝对路径可点击预览；summary 行不动（`<summary>` 点击语义与 details 开合冲突）；Output/Live output 区暂不接（只读预览无跳转价值，后续用户再提再议）。PV6 文件域增加 `components/transcript/ToolCard.vue`；验收增加「Input 区路径可点 + summary 行不抢 details 开合」两条用例 | PV6                     |
| 8   | findPathRefs 病态输入 O(n²)（PV4 验收挂账，PV5 开工闸门） | `"=/="` 重复串可使同一长候选被 O(n) 个起点反复重扫（64KB 实测 25.5s）；U3 语义下可经 transcript 远程冻结 LAN 其他用户浏览器。PV5 开工前必须修复为线性并补回归测试（64KB 病态串 <200ms 或翻倍耗时比 ≈2）                                                                                                                                                                                   | §4.6、PV4、PV5          |

## v2 修订记录（首轮评审，逐条）

| #     | 级别 | 意见（摘要）          | 处置                                                                                           |
| ----- | ---- | --------------------- | ---------------------------------------------------------------------------------------------- |
| P0-1  | P0   | 基线过期              | 基线改为 `2282fd8`；依赖图重画；PV2 拆成 PV2a 和 PV2b                                          |
| P0-2  | P0   | 404/401 矩阵          | 只分派 `GET` + `PREVIEW_PATH`；按 listener × mode × 认证状态 × X-PWH 重新定义矩阵（§4.7）      |
| P1-3  | P1   | cwd 语义              | 作用域取会话级 `session.cwd`，请求带 `sessionId`；不做 transcript 级快照（§7-D13）             |
| P1-4  | P1   | cmd.v1 权限等价不成立 | 放弃该论证；LAN 能否访问只由 `webHub.preview` 决定；§5 写明「预览端点权限强于 prompt」         |
| P1-5  | P1   | 拒绝列表              | 增加虚拟根拒绝；home 作为 cwd 的策略见 U2                                                      |
| P1-6  | P1   | 40MP 上限可绕过       | 解析不出尺寸 ⇒ 拒绝                                                                            |
| P1-7  | P1   | dispose 生命周期      | `active` 集合 + AbortSignal 贯通；三条退出路径写成契约                                         |
| P1-8  | P1   | 准入预算              | 准入总预算 8s，分阶段；完整列出每一步的错误映射                                                |
| P1-9  | P1   | upload 内容绑定       | sha256 复核（v3 细化为图片流式哈希、文本单飞）                                                 |
| P2-10 | P2   | 流式消息重扫          | 只对已落定的消息识别路径                                                                       |
| P2-11 | P2   | 限流器归属            | 独立的 `CmdLimit` 实例 + 独立审计键                                                            |
| P2-12 | P2   | 测试缺口              | 补伪装、MIME 不一致、readlink 失败等用例；hardlink / bind mount 排除在外，并用测试钉住当前行为 |
| P2-13 | P2   | 浏览器内存            | 客户端按 Dims 做预算，读 body 之前就判定；不提供下载                                           |
| P2-14 | P2   | PV7 依赖              | 拆出 PV8 文档收尾                                                                              |

---

## 0. 结论速览

| 议题        | 结论                                                                                                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 端点        | 只有 `GET /api/preview?agentKey=&sessionId=&path=` 一个，必须带 `X-PWH: 1`；成功时**直接返回原始字节**，元数据放在 `X-PWH-Preview-*` 响应头；不新增 SSE、不改帧、PROTO 不升                                                      |
| 两类准入    | **upload 类**：精确命中索引 → 结构性复核（generated：`<uploadId>.<ext>`；legacy：`<id>/<safeName>`）→ **会话可见者判定**（U3）→ 按 dirChain 打开 → sha256 复核。**cwd 类**：根目录为**会话级**的 `session.cwd`，并核对 sessionId |
| cwd 防线    | 字面前缀判定（零 fs）→ 虚拟根拒绝 → 拒绝列表 → realpath×2 → `withinRoot` → 对 realpath 结果再查一次 → stat 记 dev/ino → `open(O_NOFOLLOW\|O_NONBLOCK\|O_NOCTTY)` → fstat 核对 → `readlink(/proc/self/fd/N)` 复核（失败即拒绝）   |
| 内容复核    | 图片：每次都边流边算哈希，末块扣住不发，identity 或哈希任一不一致就 `destroy()`；文本：在发头之前完成复核（先查身份缓存，未命中再走单飞的整文件哈希）                                                                            |
| 上限        | 文本 256 KiB（在 UTF-8 字符边界截断）；图片 loopback 16 MiB、LAN 4 MiB；40MP，解析不出尺寸即拒绝；客户端在触屏设备上限 20MP                                                                                                      |
| 预算        | 准入 8s（认证最多 3s，fs 每步最多 2s）；写出截止 loopback 15s / LAN 30s；文本复核单飞 30s；客户端超时 40s                                                                                                                        |
| 生命周期    | `active` 集合 + AbortSignal；`dispose()` 幂等、有界（≤1s）；runtime close 时在 `fe.close()` 之前执行；启动失败时经 cleanup 逆序执行；客户端断开只中止它自己的请求                                                                |
| LAN 策略    | `webHub.preview: "on" \| "loopback" \| "off"`，**默认 `"on"`（U1，用户明示接受风险）**；不设 cmd.v1 门槛；不加确认弹窗；明文 LAN 时常驻警告；home 作为 cwd 允许（U2）                                                            |
| 路径识别    | 渲染层 `PathText.vue`，不改 `markdown.js`；只对已落定的消息生效；路径须在 `session.cwd` 下，或含 uploads 段；作用域键为 `agentKey\|sessionId\|cwd`                                                                               |
| 限流        | 独立的 `CmdLimit` 实例 + 独立审计键；在途请求每主体最多 2 个、全局最多 8 个                                                                                                                                                      |
| 合入顺序    | hub 热点文件：SP13 → preview → fleet；`uploads.ts`：生成名改造 → PV2b；`App.vue`：SP13 → PV6；文档：SP13 → PV8                                                                                                                   |
| conformance | **不加**：不经过 pi 边界。门禁靠真实 tmpdir + 真实 HTTP server + 8 条硬门槛                                                                                                                                                      |

---

## 1. 背景与现状

### 1.1 要解决的问题

- **上传只进不出**：`hub/uploads.ts` 的 `UploadStore` 没有回读路径。upload plan §5.3 写的是「永不回传」，§5.1 写的是「其他主体能看到路径，但无法经 HTTP 读取」。本方案对**两条都做了修订**：增加一个只读、带内容复核的回读通道；回读范围是**会话可见者**（U3，§5.4）。写入、abort、去重、引用钉住仍然只按主体绑定，不受影响。
- **会话文件看不到**：模型回复中、用户附件块中的绝对路径，在网页上只是纯文本。

### 1.2 现状摘要（@`2282fd8`，以符号名为准）

| 领域          | 现状                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| loopback 路由 | `hub/http.ts` 的 `createHttpFrontend` → `handleApi`：设 `no-store` → headless 分派 → `POST` 分支 → `GET` 分支（**先 `auth.check` ⇒ 401**，再匹配 `/api/events`、`/api/history`）→ 兜底 `throw 404`                                                                                                                                                                                                      |
| LAN 路由      | `handleLanRequestInner`：OPTIONS ⇒ 404 → `/healthz` → 静态资源 → `no-store` → headless 分派 → `POST` 分支 → `GET` 分支（只有 `/api/session`、`/api/events`、`/api/history` 调用 `requireLanSession`）→ 兜底 `throw 404`。所以**未知 GET 不认证，直接 404**                                                                                                                                              |
| 安全头        | `setSecurityHeaders`：`CSP`（`img-src 'self' data:`）、`nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`                                                                                                                                                                                                                                                                               |
| 认证 / CSRF   | Cookie 为 `HttpOnly; SameSite=Strict`；GET 的 CSRF 先例是 `hub/spawn/routes.ts` 的 `pwhHeaderOk`（先查 `X-PWH` ⇒ 403，再 `authorize`）                                                                                                                                                                                                                                                                  |
| 限流          | `hub/cmd-limit.ts` 的 `createCmdLimit`：桶数上限 `MAX_BUCKETS = 4096`，超出后按插入顺序批量淘汰 256 个；两个 listener 共用一个实例                                                                                                                                                                                                                                                                      |
| 装配          | `hub/hub.ts`：`extraHubCaps` 同时用于 `createAgentServer` 和 `info.caps`；`close()` 依次执行 `firstPromptFwd.dispose` → `spawnSup.shutdown` → `fe.close()` → `uploads.close()` → …；`cleanup` 逆序执行                                                                                                                                                                                                  |
| registry      | `AgentView.cwd`、`AgentView.session?: SessionInfo`（含 `sessionId`、`sessionFile?`、`cwd`）、`getCaps`                                                                                                                                                                                                                                                                                                  |
| 上传存储      | `CommittedRec`：`id / principal / agentKey / bucket / safeName / size / mime / dirChain / sha256 / path / state`；`byPath`；`bucketFor({sessionId, agentKey})` 有合法 sessionId 时返回 `s-<sessionId>`，否则返回 `a-<agentKey>`（`protocol/upload.ts`）；`openFileNoFollow`、`TRUSTED_READ_FLAGS`；`UploadFileHandle` 没有 `read`。**在途改造**：落盘名改为 `<uploadId>.<ext>`（下文称 `rec.diskName`） |
| 会话可见性    | hub 目前**没有按会话划分的访问控制**：已认证的主体（loopback 的 token、LAN 上的每个用户）都能订阅、查看任一 agent 的 transcript                                                                                                                                                                                                                                                                         |
| UI 状态       | `logic/state.js` 的 `sameSession` 只比较 `sessionId` 和 `sessionFile`；`applySession` 在判定为不同会话时清空 `items`；`App.vue` 持有 `hashRoute.navigate` 的接线（SP13 在途）                                                                                                                                                                                                                           |
| transcript    | `MdInline.vue` 的 text / code 分支；`TxUser.vue` 用纯文本气泡；`TxAssistant.vue` 有 `assistant.streaming`                                                                                                                                                                                                                                                                                               |

---

## 2. 文件域、依赖与合入顺序

### 2.1 文件域总表

路径相对于 `src/web-hub/`。

| 包                     | 新文件                                                                                                                                                                   | 改（符号）                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PV1 协议与设置**     | `protocol/preview.ts`                                                                                                                                                    | `protocol/http-contract.ts`（在 `API_ERRORS` 尾部、接在 `E_LAUNCHER` 之后）；`protocol/version.ts`；`hub/ports.ts`（`HubConfig.preview?`、`FrontendDeps.preview?`）；`hub/main.ts`；`agent/index.ts`（`WebHubSettings.preview`、`buildHubConfig`）；`src/config/{settings,setting-specs}.ts` |
| **PV2a hub 读取内核**  | `hub/preview/{fs,sniff,admit,stream,verify}.ts`                                                                                                                          | —                                                                                                                                                                                                                                                                                            |
| **PV2b upload 回读**   | —                                                                                                                                                                        | `hub/uploads.ts`（新增 `openForPreview`：generated / legacy 两种布局 + 会话可见者判定）；`hub/upload-fs.ts`（`UploadFileHandle.read`）                                                                                                                                                       |
| **PV3 hub 路由与装配** | `hub/preview/routes.ts`                                                                                                                                                  | `hub/http.ts`（两处 GET 分派、`LanRuntime.preview?`）；`hub/audit.ts`；`hub/hub.ts`                                                                                                                                                                                                          |
| **PV4 UI 逻辑与传输**  | `ui/src/logic/preview.js`、`ui/src/composables/usePreview.ts`                                                                                                            | `ui/src/logic/contract.js`；`ui/src/logic/{token-client,password-client}.js`；`ui/src/transport/{types,token,password}.ts`；`ui/src/logic/state.js`（`sameSession` 增加 cwd 比较）                                                                                                           |
| **PV5 UI 组件**        | `ui/src/components/preview/{PathText,PreviewHost,PreviewImage,PreviewText}.vue`、`components/preview/previewContext.ts`、`styles/preview.css`、`i18n/{en,zh}/preview.ts` | —                                                                                                                                                                                                                                                                                            |
| **PV6 接线**           | —                                                                                                                                                                        | `ui/src/App.vue`（属 SP13 文件域，闸门见 §2.3）；`components/transcript/{MdInline,TxUser,TxAssistant,ToolCard}.vue`（ToolCard 仅 Input 区接 PathText——修订 7）                                                                                                                               |
| **PV7 代码集成**       | `tests/web-hub/http/preview-e2e.test.ts`                                                                                                                                 | —                                                                                                                                                                                                                                                                                            |
| **PV8 文档收尾**       | `docs/dev/web-hub-preview/acceptance.md`                                                                                                                                 | `AGENTS.md`；`docs/dev/web-hub/lan-plan.md`（用户裁定记录）；`docs/dev/web-hub-upload/plan.md`（**只追加修订备注，不改历史措辞**，文本见 §5.4）                                                                                                                                              |

**不碰**：`ui/src/logic/markdown.js`、`components/transcript/{MdBlock,MarkdownView,Transcript}.vue`、`markdown-types.ts`、`styles/transcript.css`、`protocol/messages.ts`、`hub/registry.ts`、`components/detail/AgentDetail.vue`、`ui/src/contracts.ts`、`http.ts` 的 `statusFor`。

### 2.2 依赖图与并行波次

```
PV1 ─┬─▶ PV2a ───────────────────┬─▶ PV3 ─┐
     │   [生成名改造合入] ─▶ PV2b ─┘   ▲     │
     │                    [SP13 hub.ts 小修合入]
     └─▶ PV4 ─▶ PV5 ─▶ PV6 ──────────────────┼─▶ PV7 ─▶ PV8
                       ▲ [SP13（App.vue navigate）合入/已 rebase]      ▲ [SP13 合入]
```

- 第一波：PV1。第二波：PV2a ∥ PV4；PV2b 等生成名改造合入。第三波：PV3 ∥ PV5。第四波：PV6（需要 PV5，且 SP13 已合入或已 rebase）。收尾：PV7 → PV8。
- PV6 不依赖 PV3：hub 没有声明 cap 时，`PathText` 原样输出。
- 每个包都走 dev-flow：开发完立即派验收，验收模型 ≠ 开发模型。全局闸门：`npm run format:check && npm run typecheck && npm test && npm run build && npm run build:web`。

### 2.3 热点文件 owner、冲突窗口与 rebase 闸门

| 热点文件                                                                 | 在途 / 后继                                  | preview 包 | 规则                                                                                                                                                                        |
| ------------------------------------------------------------------------ | -------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/src/App.vue`                                                         | **SP13（navigate 接线，owner）**             | PV6        | SP13 合入（或 rebase 到含其接线的 master）后才开工；只追加 `usePreview`、两个 provide、`<PreviewHost/>`；**不得**改 `useHub(...)` 的 options                                |
| `hub/hub.ts`                                                             | **SP13（一处小修）**；fleet F3b              | PV3        | SP13 小修 → PV3 → fleet；改动只有：一行 `extraHubCaps`、routes 构造、`close()` 中在 `spawnSup.shutdown` 与 `fe.close()` 之间插一行 dispose、在 `fe.close` 之后 push cleanup |
| `hub/http.ts`                                                            | fleet F3b、F4                                | PV3        | PV3 → fleet；两处插入点都在 headless 分派之后、`if (method === "POST")` 之前                                                                                                |
| `hub/audit.ts`                                                           | —                                            | PV3        | 尾部追加                                                                                                                                                                    |
| `hub/uploads.ts`、`hub/upload-fs.ts`                                     | **生成名改造**                               | PV2b       | 改造合入 → PV2b；只新增方法                                                                                                                                                 |
| `ui/src/logic/state.js`                                                  | fleet U1                                     | PV4        | PV4 → fleet U1；`sameSession` 只改一行                                                                                                                                      |
| `protocol/{http-contract,version}.ts`、`hub/ports.ts`                    | fleet F0                                     | PV1        | PV1 → F0，尾部追加                                                                                                                                                          |
| `agent/index.ts`、`config/{settings,setting-specs}.ts`、`hub/main.ts`    | fleet A1                                     | PV1        | PV1 → A1                                                                                                                                                                    |
| `ui/src/transport/*`、`logic/{contract,token-client,password-client}.js` | fleet transport 段                           | PV4        | PV4 → fleet，追加可选字段                                                                                                                                                   |
| `components/transcript/{MdInline,TxUser,TxAssistant}.vue`                | fleet F6（改 `Transcript.vue`/`entries.ts`） | PV6        | 不重叠；若 F6 先合入，以符号名重新核对                                                                                                                                      |
| `AGENTS.md`、`lan-plan.md`                                               | **SP13**                                     | PV8        | SP13 → PV8                                                                                                                                                                  |
| `docs/dev/web-hub-upload/plan.md`                                        | 生成名改造（可能顺带改文档）                 | PV8        | 改造之后；**只在文末追加「修订备注」小节**                                                                                                                                  |

**与 fleet 的顺序**：默认 preview 先合入（fleet 目前只合入了 F1，F3a 是新文件）。PV1 开工前要与 fleet 负责人对齐；对方不同意时，把 PV1、PV3、PV4 排到 fleet 对应包之后，契约不变。

**rebase 闸门**（每个包开工前贴出以下只读命令的结果）：

```sh
git fetch && git status --porcelain -- <本包文件域>                 # 必须为空
git log --oneline 2282fd8..origin/master -- <本包文件域>            # 非空 ⇒ 以符号名重新核对本文引用
# PV2b：生成名改造已合入；核对其终态（落盘名字段名、byPath 的键、目录层级）
# PV3 ：hub/hub.ts 上能看到 SP13 的提交，或 SP13 确认不再改它
# PV6 ：App.vue 上能看到 SP13 navigate 接线的提交
# PV8 ：SP13 已合入
```

---

## 3. 状态机与时限

### 3.1 hub 单请求流水（`hub/preview/routes.ts`）

**分派条件**：`method === "GET" && path === PREVIEW_PATH`，`deps.preview` 存在；LAN 上还要求 `mode === "on"`。其余情况走原逻辑（§4.7）。

入口处创建 `r = createReqDeadline(now, PREVIEW_ADMIT_TOTAL_MS = 8_000)`，它约束 ①–⑧；同时登记一个 `active` 项（§4.5）。

| 步         | 动作                                                                                                                                                                                             | 预算                                                                              | 失败 ⇒                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| ⓪ 关停     | 处于 `closing` 状态                                                                                                                                                                              | 同步                                                                              | 503 `E_HUB_RESTARTING`                                      |
| ① CSRF     | `X-PWH === "1"`；`Sec-Fetch-Site` 若存在必须是 `same-origin`；`Origin` 若存在必须等于期望值                                                                                                      | 同步                                                                              | 403 `E_CSRF`                                                |
| ② 认证     | loopback 用 `auth.check`；LAN 用 `requireLanSession`                                                                                                                                             | `deriveBudget(r.remaining(), LAN_AUTH_CAP_MS=3000, PREVIEW_AUTH_RESERVE_MS=4000)` | 401 `E_AUTH`                                                |
| ③ 入参     | `agentKey` 匹配 `[A-Za-z0-9_-]{1,64}`；`sessionId` 为 1–128 个可打印 ASCII 字符；`validatePreviewPath(path)` 通过                                                                                | 同步                                                                              | 400 `E_BAD_REQUEST`                                         |
| ④ 限流     | 独立 `CmdLimit` 中的 `${principal}:preview` 桶（容量 20，每 250ms 补 1）；在途请求每主体最多 2 个、全局最多 8 个                                                                                 | 同步                                                                              | 429 `E_RATE`（审计键 `preview:${principal}`）/ 503 `E_BUSY` |
| ⑤ 会话     | `view = registry.get(agentKey)`，不存在 ⇒ 404；`view.session` 不存在或 `sessionId` 不一致 ⇒ 409 `E_SESSION_CHANGED`。**两类请求都要求所请求的会话当前可见**（U3：upload 类也以会话可见性为前提） | 同步                                                                              | —                                                           |
| ⑥ 分类     | 路径字面上以 `uploadsRoot + "/"` 开头 ⇒ **upload 类**；否则为 **cwd 类**，根目录为 `view.session.cwd`                                                                                            | 同步                                                                              | —                                                           |
| ⑦u upload  | `uploads.openForPreview({principal, listener, path, agentKey, sessionId}, {deadline, signal})`（§4.2）                                                                                           | fs 每步 ≤ `min(FS_STEP_CAP_MS, 剩余)`                                             | §4.2                                                        |
| ⑦c cwd     | `admitter.admit(…)`（§4.3）                                                                                                                                                                      | fs 每步 ≤ `deriveBudget(r.remaining(), 2000, 0)`                                  | §4.3                                                        |
| ⑧ 嗅探判定 | 读 `min(size, 64 KiB)`（JPEG 最多续读到 256 KiB）→ `sniff()`：binary ⇒ 415；字节数超上限 ⇒ 413；dims 为 null ⇒ 415 `dims-unknown`；像素超 40MP ⇒ 413                                             | 同上                                                                              | 此时正文还没读                                              |
| ⑨ 写出     | `readAndStream`（§4.5）                                                                                                                                                                          | `streamAt` = 15s（loopback）/ 30s（LAN）；单飞复核 30s                            | 头未发 ⇒ 按映射表应答；头已发 ⇒ `destroy()`                 |
| ⑩ 收尾     | `finally`：关 fh、释放在途名额、从 `active` 移除、写审计                                                                                                                                         | —                                                                                 | —                                                           |

**不做二次 authorize**（§7-D9）。

### 3.2 UI 侧（`usePreview`，App 级本地状态）

| phase         | 进入 / 动作                                                                                                         | 去向                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `closed`      | 初始状态 / `close()` / 作用域失效                                                                                   | `open(ref)` ⇒ `loading`                                                                                                                                          |
| `loading`     | 记录 `scopeKey = agentKey\|sessionId\|cwd`；新建 `AbortController`，`seq++`；超时 40s；收到响应头时先检查客户端预算 | image ⇒ `image`；text ⇒ `text`；415 ⇒ `unsupported`；超出预算 ⇒ `tooLarge`；其他 ⇒ `error`；被新的 `open`、`close` 或作用域失效打断 ⇒ abort，并丢弃旧 seq 的结果 |
| `image`       | `blob` → `FileReader.readAsDataURL` → 校验前缀；body 不完整 ⇒ `error{E_PREVIEW_CHANGED}`                            | —                                                                                                                                                                |
| `text`        | `r.text()`                                                                                                          | —                                                                                                                                                                |
| `unsupported` | 显示文案和文件大小                                                                                                  | —                                                                                                                                                                |
| `tooLarge`    | 显示「图片 W×H 超出浏览器预览预算」，提供复制路径                                                                   | —                                                                                                                                                                |
| `error`       | 可重试的错误显示重试按钮；`E_SESSION_CHANGED` 直接关闭                                                              | 401：token 模式走 `withRelogin`；password 模式走 `onConn("auth")`                                                                                                |

**作用域失效**：`watch(scopeKey)`，值一变化就立即 `close()`。

---

## 4. 接口契约

### 4.1 `protocol/preview.ts`（PV1）

```ts
export const PREVIEW_PATH = "/api/preview";
export type PreviewMode = "on" | "loopback" | "off";
export const PREVIEW_DEFAULT_MODE: PreviewMode = "on"; // U1：用户拍板，风险明示接受（§5.1）

export const PREVIEW_TEXT_MAX_BYTES = 256 * 1024;
export const PREVIEW_IMAGE_MAX_BYTES = { loopback: 16 * 1024 * 1024, lan: 4 * 1024 * 1024 } as const;
export const PREVIEW_IMAGE_MAX_PIXELS = 40_000_000;
export const PREVIEW_CLIENT_PIXELS_COARSE = 20_000_000;
export const PREVIEW_PATH_MAX_BYTES = 4096;
export const PREVIEW_SNIFF_TEXT_BYTES = 8 * 1024;
export const PREVIEW_SAMPLE_BYTES = 64 * 1024;
export const PREVIEW_JPEG_SCAN_MAX_BYTES = 256 * 1024;
export const PREVIEW_ADMIT_TOTAL_MS = 8_000;
export const PREVIEW_STREAM_MS = { loopback: 15_000, lan: 30_000 } as const;
export const PREVIEW_VERIFY_MS = 30_000;
export const PREVIEW_CLIENT_TIMEOUT_MS = 40_000;
export const PREVIEW_UPLOADS_MARKER = "/.pi/agent/web-hub/uploads/";

export type PreviewImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export const PREVIEW_HDR = {
  kind: "X-PWH-Preview-Kind",
  size: "X-PWH-Preview-Size",
  truncated: "X-PWH-Preview-Truncated",
  dims: "X-PWH-Preview-Dims",
} as const;

export type PreviewDenyReason = "outside" | "root-too-broad" | "virtual-fs" | "denylist" | "unreadable";
export type PreviewUnsupportedReason = "binary" | "not-regular" | "dims-unknown";
export function validatePreviewPath(p: string): boolean;
// 以 "/" 开头；UTF-8 ≤ 4096 字节；不含 NUL、\r、\n；至少 2 段且每段非空；不含 "." 或 ".." 段
```

`API_ERRORS` 尾部追加：

| 码                      | HTTP | 响应体                                                |
| ----------------------- | ---- | ----------------------------------------------------- |
| `E_PREVIEW_DENIED`      | 403  | `{error, reason: PreviewDenyReason}`                  |
| `E_PREVIEW_UNSUPPORTED` | 415  | `{error, size?, reason: PreviewUnsupportedReason}`    |
| `E_PREVIEW_TOO_LARGE`   | 413  | `{error, size, max, reason:"bytes"\|"pixels", dims?}` |
| `E_PREVIEW_CHANGED`     | 409  | `{error}`                                             |

复用的错误码：`E_NOT_FOUND`、`E_BAD_REQUEST`、`E_AUTH`、`E_CSRF`、`E_RATE`、`E_BUSY`、`E_HUB_RESTARTING`、`E_DEADLINE`、`E_SESSION_CHANGED`、`E_INTERNAL`。

**200 响应头**：`Content-Type`（四种图片 MIME 之一，或 `text/plain; charset=utf-8`）、`Content-Length`、四个 `X-PWH-Preview-*`、`Content-Disposition: attachment; filename="preview"`、`Cross-Origin-Resource-Policy: same-origin`，以及原有的 `no-store` 和 `setSecurityHeaders` 全套（**CSP 不改**）。

`protocol/version.ts`：`PREVIEW_HUB_CAP = "preview.v1"`（mode 为 loopback 或 on 时声明）、`PREVIEW_LAN_HUB_CAP = "preview.lan.v1"`（mode 为 on 时声明；按默认值，两个都会声明）。
`hub/ports.ts`：`HubConfig.preview?: "on" | "loopback"`（mode 为 off 时省略）；`FrontendDeps.preview?: PreviewRoutes`。

### 4.2 `UploadStore.openForPreview`（PV2b）

```ts
openForPreview(
  p: { principal: string; listener: "loopback" | "lan"; path: string; agentKey: string; sessionId: string },
  ctx: { deadline: Deadline; signal: AbortSignal },
): Promise<
  | { ok: true; fh: UploadFileHandle; size: number; uploadId: string; sha256: string;
      layout: "generated" | "legacy"; shared: boolean }
  | { ok: false; code: "E_BUSY" | "E_NOT_FOUND" | "E_PREVIEW_CHANGED" | "E_DEADLINE" }
>;
```

前置条件：路由层已经在 §3.1 ⑤ 确认 `(agentKey, sessionId)` 是一个**当前可见**的会话。

1. 启动扫描未完成 ⇒ `E_BUSY`；store 已禁用 ⇒ `E_NOT_FOUND`。
2. `id = byPath.get(p.path)`（精确匹配）→ `rec = committed.get(id)`；未命中或 `rec.state === "evicting"` ⇒ `E_NOT_FOUND`。
3. **结构性复核（layout）**：

| layout      | 判定                         | 复核（逐字）                                                                              | 打开名         |
| ----------- | ---------------------------- | ----------------------------------------------------------------------------------------- | -------------- |
| `generated` | `rec.diskName !== undefined` | `basename(p.path) === rec.diskName`，且 diskName 匹配 `^${rec.id}(\.[A-Za-z0-9]{1,16})?$` | `rec.diskName` |
| `legacy`    | `rec.diskName === undefined` | `basename(p.path) === rec.safeName`，且 `basename(dirname(p.path)) === rec.id`            | `rec.safeName` |

任一项不通过 ⇒ `E_NOT_FOUND`。原始上传名不参与匹配，也不会出现在响应中。**不做迁移**。

4. **可见者判定（U3，取代 v3 的「LAN 仅限本人」）**：

```
owner      = rec.principal === p.principal
sessionOk  = rec.bucket === bucketFor({ sessionId: p.sessionId, agentKey: p.agentKey })
             || rec.bucket === `a-${p.agentKey}`
allowed    = p.listener === "loopback" || owner || sessionOk
```

- **会话可见者共享**：附件属于请求者当前能看到的那个会话（bucket 与该会话一致）时，任何已认证的主体都能读取。
- 上传者本人**总能**读自己的上传（即使会话已经切换、bucket 与当前会话不符——例如上传后会话被 `/new` 替换）。
- loopback（机器属主）不受此限制。
- `!allowed` ⇒ `E_NOT_FOUND`：不暴露「存在但属于其他会话」。
- 返回值里的 `shared = !owner`，仅供审计。

5. 打开：`fh = openFileNoFollow(rec.dirChain, <打开名>, TRUSTED_READ_FLAGS, …, ctx.deadline)`；若 `fh.stat().size !== rec.size` ⇒ `E_PREVIEW_CHANGED`；`chain-mismatch` 或 `not-regular` ⇒ `E_PREVIEW_CHANGED` 并记 `log.error`，不删除任何文件。
6. 不修改任何索引或计数。**读取不算引用**：不更新 `referencedAt`，也不延长 TTL。
7. `UploadFileHandle` 新增必选方法 `read(buf, off, len, pos)`。

> 生成名改造的终态以 PV2b 开工闸门的核对结果为准；与假设不符时，只调整第 3 步，其余契约不变。

### 4.3 cwd 类准入 `hub/preview/admit.ts`（PV2a）

```ts
export interface PreviewFs {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<PreviewStat>;
  open(p: string, flags: number): Promise<PreviewHandle>;
  readlink(p: string): Promise<string>;
  procFdAvailable(): boolean;
}
export interface PreviewStat {
  dev: number;
  ino: number;
  size: number;
  ctimeMs: number;
  nlink: number;
  isFile(): boolean;
}
export interface PreviewHandle {
  readonly fd: number;
  stat(): Promise<PreviewStat>;
  read(buf: Buffer, off: number, len: number, pos: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export interface CwdAdmitInput {
  path: string;
  root: string; // session.cwd
}
export type CwdAdmitResult =
  | { ok: true; fh: PreviewHandle; size: number; realpath: string }
  | { ok: false; status: number; code: string; reason?: string };
export function createCwdAdmitter(deps: { home: string; fs?: Partial<PreviewFs>; log: HubLog; now: () => number }): {
  admit(input: CwdAdmitInput, deadline: ReqDeadline, signal: AbortSignal): Promise<CwdAdmitResult>;
};
```

| #   | 判定（第 1–4 步不发起任何 fs 调用）                                                                            | 不通过 ⇒                            |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | `root` 为绝对路径、不是 `/`、字面上不在虚拟根之下（**home 允许，U2**）                                         | 403 `root-too-broad` / `virtual-fs` |
| 2   | `path.startsWith(root + "/")`                                                                                  | 403 `outside`                       |
| 3   | 字面拒绝列表                                                                                                   | 403 `denylist`                      |
| 4   | 字面虚拟根                                                                                                     | 403 `virtual-fs`                    |
| 5   | `rootRp = realpath(root)`；为 `/` 或落在虚拟根下 ⇒ 拒绝                                                        | 映射表 / 403                        |
| 6   | `rp = realpath(path)`                                                                                          | 映射表                              |
| 7   | `withinRoot(rootRp, rp) && rp !== rootRp`（复用 `hub/spawn/dirs.ts`）                                          | 403 `outside`                       |
| 8   | 对 `rp` 再查一次拒绝列表和虚拟根                                                                               | 403                                 |
| 9   | `st = stat(rp)`                                                                                                | 映射表                              |
| 10  | `fh = open(rp, O_RDONLY\|O_NOFOLLOW\|O_NONBLOCK\|O_NOCTTY)`                                                    | 映射表（`ELOOP` ⇒ 409）             |
| 11  | `fh.stat()` 的 dev/ino 与 `st` 一致，且为常规文件                                                              | 409 / 415                           |
| 12  | 若 `procFdAvailable()`，则 `readlink(/proc/self/fd/N) === rp`；抛错或带 ` (deleted)` 后缀 ⇒ 409（fail closed） | 409                                 |
| 13  | 返回                                                                                                           | —                                   |

**虚拟根**：`/proc`、`/sys`、`/dev`、`/run`，按路径段对齐比较；字面路径和 realpath 都要检查。

**拒绝列表**（纵深防御，home 作为 cwd 时主要靠它兜底，U2）：

- 前缀：`~/.pi/agent/web-hub`、`~/.pi/agent/auth.json`、`~/.pi/agent/models.json`、`~/.config/pi/web-search.env`。
- 任意一段等于：`.ssh`、`.gnupg`、`.aws`、`.azure`、`.kube`、`.docker`、`.password-store`、`.mozilla`、`.thunderbird`、`.terraform.d`。
- 连续两段等于：`.config/gcloud`、`.config/gh`、`.config/hub`、`.config/google-chrome`、`.config/chromium`、`.config/BraveSoftware`、`.local/share/keyrings`、`.git/config`、`.cargo/credentials`、`.cargo/credentials.toml`。
- basename 等于：`.netrc`、`.pgpass`、`.git-credentials`、`.npmrc`、`.pypirc`、`.bash_history`、`.zsh_history`、`.python_history`、`.psql_history`、`.mysql_history`、`.node_repl_history`、`.lesshst`、`.viminfo`；或匹配 `^\.env(\..+)?$`、`^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$`。
- 扩展名（不区分大小写）：`.pem`、`.key`、`.p12`、`.pfx`、`.kdbx`。

**fs 错误映射表**（`mapFsError`，两类共用）：

| 情况                         | 应答                                     |
| ---------------------------- | ---------------------------------------- |
| 超出预算                     | 504 `E_DEADLINE`（迟到的 open 会被回收） |
| abort（客户端断开）          | 不应答                                   |
| abort（hub 关停）            | 503 `E_HUB_RESTARTING`（头未发时）       |
| `ENOENT`、`ENOTDIR`          | 404                                      |
| `EACCES`、`EPERM`            | 403 `unreadable`                         |
| open 时 `ELOOP`              | 409                                      |
| `EISDIR` 或非常规文件        | 415 `not-regular`                        |
| `EMFILE`、`ENFILE`、`EAGAIN` | 503 `E_BUSY` + `Retry-After: 1`          |
| readlink 失败                | 409 + warn                               |
| 其他                         | 500 `E_INTERNAL`                         |

**预算**：cwd 类最多 7 次 fs 调用（JPEG 续读算第 8 次）；upload 类为 open、fstat、3 次 lstat、一次嗅探读。每步最多 2s，共享 `r`；认证阶段之后至少还留 4s。

### 4.4 嗅探 `hub/preview/sniff.ts`（PV2a，纯函数）

```ts
export type SniffResult =
  | { kind: "image"; mime: PreviewImageMime; dims: { w: number; h: number } | null }
  | { kind: "text" }
  | { kind: "binary" };
export function sniff(sample: Uint8Array, totalSize: number): SniffResult;
export function needsMoreForDims(sample: Uint8Array): boolean;
export function utf8SafeCut(buf: Uint8Array, maxLen: number): number;
```

- **魔数**：PNG、JPEG、GIF87a/89a、`RIFF????WEBP`；扩展名和 `meta.mime` 都不参与判定。
- **尺寸**：PNG 取 IHDR、GIF 取逻辑屏幕描述符、WebP 取 `VP8 `/`VP8L`/`VP8X`、JPEG 取 SOF0–SOF15（跳过 C4、C8、CC）；`dims === null` ⇒ 拒绝。
- **文本**：空文件视为文本；取前 8 KiB 判定：不含 NUL；去掉 BOM 后能通过 `TextDecoder(fatal)` 解码；控制字符占比 ≤2%。UTF-16 视为 binary；SVG 视为文本。

### 4.5 路由、生命周期、流式写出与复核（PV2a + PV3）

```ts
// stream.ts
export interface PreviewSink {
  readonly headersSent: boolean;
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: Buffer): boolean;
  waitDrain(signal: AbortSignal): Promise<void>;
  end(): void;
  destroy(): void;
}
export type StreamFailReason =
  | "client-abort"
  | "hub-close"
  | "stream-deadline"
  | "shrunk"
  | "hash-mismatch"
  | "identity-changed"
  | "verify-timeout"
  | "verify-deadline"
  | "io";
export type StreamOutcome =
  | { ok: true; bytes: number; truncated: boolean; verify?: "hashed" | "cached" | "joined" }
  | { ok: false; reason: StreamFailReason; headersSent: boolean };
export function readAndStream(
  src: {
    fh: PreviewHandle;
    size: number;
    sniff: SniffResult;
    sample: Buffer;
    verify?: { uploadId: string; sha256: string };
  },
  sink: PreviewSink,
  opts: { signal: AbortSignal; streamAt: number; textMax: number; now: () => number; verifier: UploadVerifier },
): Promise<StreamOutcome>;

// verify.ts
export interface Identity {
  dev: number;
  ino: number;
  size: number;
  ctimeMs: number;
}
export interface UploadVerifier {
  verifyWhole(
    p: { uploadId: string; sha256: string; fh: PreviewHandle; identity: Identity },
    opts: { signal: AbortSignal; waitUntil: number },
  ): Promise<"cached" | "hashed" | "joined" | { fail: "hash-mismatch" | "verify-timeout" | "verify-deadline" | "io" }>;
  remember(uploadId: string, identity: Identity): void;
  dispose(): void;
}

// routes.ts
export interface PreviewRoutes {
  readonly mode: "on" | "loopback";
  handle(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, io: PreviewRouteIo): Promise<void>;
  dispose(reason: "close" | "startup-failure", deadline: ReqDeadline): Promise<void>; // 幂等
}
export interface PreviewRouteIo {
  listener: "loopback" | "lan";
  ip: string;
  expectedOrigin: string;
  authorize(deadline: ReqDeadline): Promise<{ ip: string; user?: string } | { handled: true; code: string }>;
  sendJson: (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;
}
export function createPreviewRoutes(deps: {
  mode: "on" | "loopback";
  home: string;
  uploadsRoot: string;
  registry: Pick<Registry, "get">;
  uploads: Pick<UploadStore, "openForPreview"> | undefined;
  log: HubLog;
  now: () => number;
  limit?: CmdLimit; // 缺省 ⇒ 内部 createCmdLimit(now)，preview 独占（§7-D14）
  admitter?: ReturnType<typeof createCwdAdmitter>;
  verifier?: UploadVerifier;
}): PreviewRoutes;
```

`routes.ts` 用自己的 `PREVIEW_STATUS` 表直接 `sendJson`，从不 throw。

#### 4.5.1 `active` 集合与生命周期

```ts
interface ActiveRequest {
  readonly ctl: AbortController; // "client-abort" | "hub-close"
  readonly done: Promise<void>;
}
const active = new Set<ActiveRequest>();
```

- 请求进入时登记；`res.once("close")` 且 `!res.writableFinished` ⇒ `abort("client-abort")`；`finally` 中移除。
- `signal` 贯通 admit 的每一步、`openForPreview`、嗅探读、每次 `read`/`waitDrain`，以及等待单飞的过程（单飞任务本身不受某个请求的 signal 控制，见 §4.5.3）。
- **迟到 fd 回收**：被放弃的 `open` promise 一律挂 `.then(fh => fh.close())`，并登记到有界的 `lateCloses`。

| 路径                  | 触发                                                                                                        | 行为                                                                                                                                                                 | 保证                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **runtime close**     | `hub.close()` 中，在 `spawnSup.shutdown` 之后、`fe.close()` 之前 `await preview.dispose("close", deadline)` | 置 `closing` → `verifier.dispose()` → 逐个 `abort("hub-close")`：头未发 ⇒ 503，头已发 ⇒ `destroy()` → `allSettled(done)`，最多等 `min(1000ms, deadline.remaining())` | 之后不再发起新的 fs 调用；fd 全部回收；≤1s |
| **startup failure**   | 在 `cleanup.push(() => fe.close())` **之后** push dispose（cleanup 逆序执行，所以它先于 `fe.close`）        | 同上                                                                                                                                                                 | 幂等，与 runtime close 共用同一个 promise  |
| **client disconnect** | 单个请求的 `res` 提前关闭                                                                                   | 只中止这一个请求：停读、关 fh、审计；若它在等单飞，引用计数减一                                                                                                      | 不再写响应；`finally` 中关 fd              |

#### 4.5.2 `readAndStream`

**图片**（不使用身份缓存）：

1. 读 `pre = fh.stat()`；`writeHead`，`Content-Length = size`。
2. 先写出样本，之后每次读 64 KiB：读 → upload 类同时 `hash.update` → 写；`write` 返回 false 时 `waitDrain`。**始终扣住最后一块**不发。
3. 到 EOF 后读 `post = fh.stat()`。upload 类要求 `digest === sha256` 且 `identity(post) === identity(pre)`；cwd 类只要求 identity 一致。
4. 全部通过 ⇒ 写出末块、`end()`，upload 类再调用 `remember`。任一不通过 ⇒ 立即 `destroy()`，审计记 `hash-mismatch` 或 `identity-changed`，客户端收到的 body 不完整。
5. **禁止**发头之后改走「完整哈希」路径；发头之后只有两种结局：写完，或 `destroy()`。

**文本**（身份缓存只在这里用，而且只在发头之前）：

1. 读 `pre`；读出要显示的部分 `min(size, textMax)`，用 `utf8SafeCut` 截在字符边界。
2. cwd 类：读 `post`，identity 不一致 ⇒ 409；一致 ⇒ 发头、写出、结束。
3. upload 类：调用 `verifyWhole`：
   - `"cached"`：缓存里的 identity 等于 `pre`，且此刻 `post` 也等于 `pre`；`post` 不一致 ⇒ 仍在发头之前改走单飞。
   - `"hashed"` / `"joined"`：复核通过。
   - `{fail}`：`hash-mismatch` ⇒ 409；`verify-timeout` / `verify-deadline` ⇒ 504；`io` ⇒ 按映射表。
   - 通过之后才发头。

**通用**：读到 0 字节但未满 `size` ⇒ `shrunk`；文件变大时只发前 `size` 字节；到 `streamAt` ⇒ `stream-deadline`；所有 timer 都 `unref`。

#### 4.5.3 文本复核单飞

- **键**：`${uploadId}|${dev}|${ino}|${size}|${ctimeMs}`。
- **任务**：用独立的 fd 从头读到 EOF 计算哈希，缓冲 64 KiB；有自己的 `AbortController`，预算 30s。
- **等待者**：每个请求以 `min(streamAt, 任务截止)` 加上自己的 signal 与任务竞速；引用计数归零 ⇒ 中止任务。
- **结果**：通过 ⇒ `remember`，发起者得到 `"hashed"`、加入者得到 `"joined"`；哈希不一致 ⇒ 所有等待者都得到 `hash-mismatch`，`log.error` 只记一次；任务超出预算 ⇒ 所有等待者都得到 `verify-timeout`；某个等待者自己的截止时间先到 ⇒ 只有它得到 `verify-deadline`。
- **图片不做单飞**：图片的哈希是在边读边发的那一遍读里顺带算的，不存在一个独立的哈希任务可以合并。
- `dispose()` 时中止全部任务。

**审计**（`hub/audit.ts`：`PreviewAuditRecord`、`PREVIEW_AUDIT_KEYS`、`auditPreview`，按白名单裁剪）：字段为 `phase`、`listener`、`ip`、`user`、`agentKey`、`cls`、`kind`、`ok`、`code`、`reason`、`verify`、`shared`（U3：upload 类的读者不是上传者本人时为 true）、`bytes`、`total`、`truncated`、`ms`、`ext`、`pathTag`（HMAC 取前 12 个 hex 字符）。**永不记录**路径原文、内容、文件名、原始上传名。

**`http.ts` 接线**：

```ts
// loopback handleApi：在 headless 分派之后、if (method === "POST") 之前
if (deps.preview !== undefined && method === "GET" && path === PREVIEW_PATH)
  return deps.preview.handle(req, res, query, { listener: "loopback", … });
// LAN handleLanRequestInner：同一位置
if (rt.preview !== undefined && rt.preview.mode === "on" && method === "GET" && path === PREVIEW_PATH)
  return rt.preview.handle(req, res, query, { listener: "lan", … });
```

### 4.6 UI 契约

**`logic/preview.js`**：

```js
/** @typedef {{ agentKey: string, sessionId: string, cwd: string | null, uploads: boolean }} PathScope */
export function findPathRefs(text, scope); // 各段 text 拼接后恒等于输入
export function pathRefOfCode(text, scope);
export function scopeKeyOf(scope); // `${agentKey}|${sessionId}|${cwd ?? ""}`（v3-2）
export function clientImageBudget({ coarse }); // coarse ? 20MP : 40MP
export function classifyPreviewError(status, body);
```

**识别规则**（冻结）：

1. 候选的起点 `/` 必须位于行首，或紧跟在空白、`( [ { < " ' =`、全角 `（「『【《：` 之后。
2. 遇到空白、`" ' < > ( ) [ ] { } | , ;`、反引号、全角 `，。；：！？、）」』】》` 即结束；结尾的 `. : ! ?` 反复去掉。
3. 末尾的 `:行号[:列号]` 只用于显示。
4. 必须通过 `validatePreviewPath`。
5. 必须按路径段对齐地落在 `scope.cwd` 之下（`scope.cwd` 不为 `/`），或者路径中含 `PREVIEW_UPLOADS_MARKER`。
6. 每个节点最多 100 个，单个路径不超过 4096 字节。

**规则 1b（相对路径，2026-10-07 补充）**：工具调用 args 里大量是相对路径（如 `"path":"src/foo.ts"`），只认绝对路径覆盖不到。追加规则：不以 `/` 起始的候选，当 ① 候选起点的上下文复用规则 1 的 START_CHARS/空白判定，但**不**把“文本节点自身的起始位置”算作合法起点（避免 `"x/home/..."`、`"1/home/..."` 这类已冻结的绝对路径反例，仅因恰好落在文本片段边界就被相对规则误判为可点击）；② 候选含至少一个 `/`；③ 末段带“看起来合理”的扩展名（`.` + 1–10 个 `[A-Za-z0-9_-]`，`.` 前至少 1 个字符 —— 因此 `src/components/detail` 这种无扩展名目录不识别，是明确接受的取舍）；④ 首段（第一个 `/` 之前）不含 `:`（覆盖 `http://`、`mailto:`、任意自定义协议，比枚举协议词更稳）。都满足时解析为 `scope.cwd + "/" + 候选`（`scope.cwd` 为 `null`/`""`/`"/"` 时不启用），解析后的绝对路径仍须过规则 4–5；显示文本保持原始相对形式，`:行号[:列号]` 仍是 display-only。

**作用域推导**：`capOk` = password 模式下要求有 `preview.lan.v1`，否则要求有 `preview.v1`；若 `transport.preview` 存在、`capOk` 成立且 `card.session` 存在，则作用域为 `{agentKey, sessionId, cwd: card.session.cwd, uploads: true}`，否则为 `null`。按默认 `mode:"on"`，LAN 上也能得到作用域。

**cwd 双保险（v3-2）**：不变量是同一个 sessionId 内 cwd 不会变。在此基础上，① `scopeKeyOf` 带上 cwd；② `sameSession` 改为 `sessionId`、`sessionFile`、`cwd` 三者都相等才算同一会话，cwd 一变即清空 transcript 并重拉。

**流式抑制**：`PATH_REFS_SUSPENDED` 由 `TxAssistant` provide `computed(() => props.assistant.streaming)`；流式期间按纯文本渲染，落定后重扫一次。

**transport**：

```ts
export type PreviewOutcome =
  | { ok: true; kind: "image"; mime: PreviewImageMime; size: number; dims: { w: number; h: number }; blob: Blob }
  | { ok: true; kind: "text"; size: number; truncated: boolean; text: string }
  | {
      ok: false;
      status: number;
      error: string;
      reason?: string;
      size?: number;
      max?: number;
      dims?: { w: number; h: number };
      retryAfterS?: number;
    };
export interface PreviewTransport {
  fetch(
    req: { agentKey: string; sessionId: string; path: string },
    opts: { signal: AbortSignal; maxPixels: number },
  ): Promise<PreviewOutcome>;
}
```

请求带 `X-PWH: 1`。收到响应头、读 body 之前先校验：Content-Type 与 Kind 一致、Content-Length 不超上限、Dims 存在且不超 `maxPixels`；不通过 ⇒ abort，并在本地返回错误。body 不完整 ⇒ `E_PREVIEW_CHANGED`。

**组件**：

| 组件               | 要点                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PathText.vue`     | 以下情况下与现状 DOM 完全相同：没有 ctx、`scope === null`、`noRefs`、`SUSPENDED`；可点击的片段渲染为 `span.path-ref[role=button][tabindex=0]`，或者 `code.md-code.path-ref`                            |
| `PreviewHost.vue`  | Teleport 到 body；点遮罩关闭；dialog 语义；显示 basename、完整路径、关闭按钮；按 phase 渲染；明文传输时显示警告；焦点进入、循环、归还；Esc 调用 `preventDefault` + `stopPropagation`；滚动锁一定会清理 |
| `PreviewImage.vue` | 只接受 data URL；可在「适应 / 原始尺寸」之间切换                                                                                                                                                       |
| `PreviewText.vue`  | 用 `<pre>` 等宽显示；截断时提示；复制按钮复制的是已显示的部分                                                                                                                                          |

样式：`max-width: 767px` 时全屏，并处理 safe-area 和 `100dvh`；`pointer: coarse` 时可点区域 ≥44px。

### 4.7 响应矩阵

表中「现状」指 `2282fd8` 的行为；mode 为 `off` 即 `deps.preview` 不存在。未认证请求在两个 listener 上的不对称（loopback 401，LAN 404）是现有行为，preview 不改变它（§9）。

| listener | mode           | 认证   | X-PWH | `GET /api/preview` | 非 GET           |
| -------- | -------------- | ------ | ----- | ------------------ | ---------------- |
| loopback | off            | 未认证 | 任意  | 401（= 现状）      | = 现状           |
| loopback | off            | 已认证 | 任意  | 404（= 现状）      | = 现状           |
| loopback | loopback / on  | 任意   | 无    | 403 `E_CSRF`       | = 现状（不分派） |
| loopback | loopback / on  | 未认证 | 有    | 401                | = 现状           |
| loopback | loopback / on  | 已认证 | 有    | 走 §3.1            | = 现状           |
| LAN      | off            | 任意   | 任意  | 404（= 现状）      | = 现状           |
| LAN      | loopback       | 任意   | 任意  | 404（不分派）      | = 现状           |
| LAN      | **on（默认）** | 任意   | 无    | 403 `E_CSRF`       | = 现状           |
| LAN      | on             | 未认证 | 有    | 401                | = 现状           |
| LAN      | on             | 已认证 | 有    | 走 §3.1            | = 现状           |

caps 对照：off 时与现状深相等；loopback 时多出 `preview.v1`；on 时多出 `preview.v1` 和 `preview.lan.v1`；两处声明的集合必须一致。

---

## 5. 安全边界

### 5.1 预览端点的权限**强于** prompt（用户已明示接受，U1）

| 维度     | 通过 prompt 让 agent 读                     | preview 端点                                            |
| -------- | ------------------------------------------- | ------------------------------------------------------- |
| 能力前提 | agent 声明 `cmd.v1`                         | 只看 `webHub.preview`（**只读 agent 同样生效**）        |
| 中介     | 经过模型、pi 工具策略、扩展、沙箱、TUI 可见 | **不经过** agent                                        |
| 留痕     | transcript 中所有查看者都能看到             | 只有 hub 审计（无路径原文），transcript 中**无痕**      |
| 范围     | 任意路径                                    | 会话 cwd 子树（拒绝列表除外）+ 会话可见者共享的上传文件 |

**用户裁定记录（U1）**：默认值为 `mode:"on"`。所有经 LAN 认证的用户，都可以无痕读取任一 live 会话 cwd 下不在拒绝列表中的文件，以及该会话的上传附件。用户确认自己是 LAN 上唯一的使用者，并且已启用密码认证，**明示接受**这一风险。PV8 会把这条裁定原文写进 `lan-plan.md`。若将来 LAN 上出现其他使用者，应把 mode 改为 `"loopback"`，这一提示写进设置说明。

### 5.2 防线与残余风险

- **边界**：会话 cwd 子树 + 虚拟根拒绝 + mode 开关 + upload 的会话可见者判定 + 内容 sha256 复核。
- **纵深防御**：拒绝列表（必然有遗漏）。
- **home 作为 cwd（U2，允许）**：残余风险是 home 下未被拒绝列表覆盖的秘密（各类应用 token、私人笔记、没有列出的应用配置），在 LAN 上可以被读取。用户已知悉并接受；理由是拒绝这种情况会废掉大半用途。
- **明文 LAN**：沿用既有裁定；预览面板常驻警告。

### 5.3 不在威胁模型内（用测试钉住当前行为）

- **hardlink**：cwd 内指向 cwd 外的硬链接会被预览。能造出这种链接的只有同 uid 进程或 agent 本身；若改为 `nlink > 1` 即拒绝，会误伤 pnpm。用测试钉住这一行为。
- **bind mount / 命名空间挂载**：需要 root 或挂载权限，只在文档中说明。
- **同 uid 的恶意进程**：沿用 upload plan §5.0 的口径。

### 5.4 上传可见范围的修订（U3）及影响面

**修订内容**：upload plan §5.1 原来裁定「上传按主体隔离，……其他主体能**看到路径**，但无法经 HTTP 读取」。现在改为：**附件内容可以由该会话的可见者通过预览端点只读读取**。可见者的判定见 §4.2 第 4 步。

**影响面**：

| 面                                     | 变化                                                                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 预览读取                               | 按会话可见者判定（§4.2）：同一会话 bucket 内的附件，任何已认证主体都能读；上传者本人永远可读；loopback 不受限；不符合 ⇒ 404，不暴露存在性                                                |
| 上传写入面（begin/chunk/commit/abort） | **不变**：仍按主体绑定；B 不能 abort A 的上传                                                                                                                                            |
| 去重                                   | **不变**：去重键仍为 `principal\|bucket\|sha256\|safeName`；回包中仍不含 sha256，因此没有跨用户的侧信道                                                                                  |
| 引用钉住 / TTL                         | **不变**：只有 `/api/cmd` 的 prompt 引用会钉住附件；预览读取既不钉住、也不延长 TTL。别人能读到的附件，可能按原 TTL 被淘汰                                                                |
| 跨会话                                 | 附件只对它所属的那个会话共享。A 在会话 X 上传的附件，B 想通过会话 Y 的请求去读 ⇒ 404                                                                                                     |
| 审计                                   | 新增 `shared` 字段，标记读者不是上传者本人的情况                                                                                                                                         |
| UI                                     | 无代码变化；LAN 上其他用户点击附件路径时，从「必定 404」变为可以预览                                                                                                                     |
| 测试                                   | v3 原来的「B 读 A ⇒ 404」改为：「同一会话 B 读 A ⇒ 200 且 `shared: true`」「B 以另一会话的身份读 ⇒ 404」「会话切换后 A 仍能读自己的附件」「会话切换后 B 读 ⇒ 404」                       |
| 隐私语义                               | 上传者应当知道：发到某个会话里的附件，该会话的所有查看者都能看到内容（与 transcript 共享的语义一致）。上传托盘的提示文案**不改**——它属于上传线的文件域；需要时由上传线自行跟进，记为 R14 |

**上传线文档的处理（只追加备注，不改历史）**：PV8 在 `docs/dev/web-hub-upload/plan.md` 的**文末**追加一个小节，原有 §5.1、§5.3 的措辞一字不动。追加内容如下：

```md
## 修订备注（web-hub-preview，2026-10-05，用户拍板）

- §5.3「永不回传」：已由 web-hub-preview 方案新增只读回读通道 `GET /api/preview`（带 sha256 内容复核）。
- §5.1「其他主体能看到路径但无法经 HTTP 读取」：修订为「附件内容对该会话的可见者共享，只读」；写入、abort、去重、引用钉住仍按主体绑定。
  详见 docs/dev/web-hub-preview/plan.md §4.2、§5.4。本节为追加备注，上文原裁定保留以存档。
```

---

## 6. 施工包与验收

所有包都要求 `npm run typecheck` 通过、所列用例全绿；任一硬门槛不过，不得合入。

### PV1：协议与设置（小；无前置）

`webHub.preview` 三选一，**默认 `"on"`**（U1），非法值回落到默认；设置说明写明「修改后需要 `/reload` 再 `/webhub restart`；LAN 上若有其他使用者，建议改为 `loopback`」。

**验收**：`tests/web-hub/protocol/preview.test.ts`：`validatePreviewPath`；`API_ERRORS` 尾部；`PREVIEW_HDR`；`PREVIEW_DEFAULT_MODE === "on"`；常量之间的关系（`ADMIT + STREAM.lan < CLIENT_TIMEOUT`，`VERIFY ≤ STREAM.lan`）。settings：三种取值、非法值回落、**默认值为 on**。wiring：默认配置下 `PI_WEBHUB_CONFIG` 恰好多一个 `preview:"on"`；off 时与现状深相等。`hub/main.ts` 会丢弃非法值。

### PV2a：hub 读取内核（中；依赖 PV1）

`hub/preview/{fs,sniff,admit,stream,verify}.ts`；源码扫描：除 `fs.ts` 外都不得 import `node:fs*`，任何文件都不得出现 `readFile(`。

**验收**：

- `sniff.test.ts`：魔数、截断、RIFF 但非 WEBP、空文件、BOM、跨边界的多字节字符、NUL、控制字符 1.9% / 2.1%、UTF-16、SVG；四种格式的尺寸；JPEG 的 SOF 位于 200 KiB 和 300 KiB+ 两种情况；伪装（文本冒充 png、png 冒充 txt、HTML 冒充 png、GIF+JS 多态文件）。
- `admit.test.ts`：§4.3 每一行；第 1–4 步零 fs 调用；虚拟根、`/proc/self/environ` 软链；拒绝列表逐项；**home 作为 cwd（U2）**：普通文件 ⇒ 200，`~/.ssh/config`、`~/.zsh_history`、`~/.config/gh/hosts.yml` ⇒ 403 denylist；`/tmp/r2` 与 `/tmp/r`；cwd 是软链；FIFO；`chmod 000`。
- **TOCTOU（HP2）**：换 inode、末段换成软链、中间目录被替换、readlink 抛错 ⇒ 409；`procFdAvailable=false` 时的残余路径。
- **预算与映射**：8 个 fs 步骤逐一注入慢操作 ⇒ 504，耗时 ≤ 8s+ε；逐一注入各种 errno；迟到的 open 会被关闭。
- **hardlink 钉住** ⇒ 200。
- `stream.test.ts`：文本截断与 UTF-8 切点；图片恰好等于上限 / 上限 +1；文件变大、变小；慢客户端；abort 后 fd 被关闭；hub-close 时头未发 / 已发；**图片**：哈希不一致、identity 变化 ⇒ 写出字节数 < size，并 destroy；图片路径从不调用 `verifyWhole`，并且每次都计算哈希；源码断言 `writeHead` 之后不会调用 `verifyWhole`；文本路径缓存命中但 post 变化时，在发头前改走单飞；所有 timer 都 unref。
- `verify.test.ts`：3 个并发请求只读一遍（1 个 `hashed` + 2 个 `joined`）；identity 不同时不合并；一个等待者断开不影响其他；全部断开后任务被中止；`verify-timeout`；单个请求 `verify-deadline`；`hash-mismatch` 时 `log.error` 只记一次；`dispose`。
- **内存（HP3）**：1 GiB 稀疏文件；100 MiB 文本复核时内存增量 < 1 MiB。

### PV2b：upload 回读（小；依赖 PV1；**前置：生成名改造已合入**）

**验收**（在 `uploads.test.ts` 中追加）：

- **可见者判定（U3）**：本人 ⇒ ok，`shared:false`；LAN 上的他人请求同一会话的 bucket ⇒ ok，`shared:true`；他人以另一会话（bucket 不一致）请求 ⇒ 404；`a-<agentKey>` bucket 中的附件，在同一 agent 的当前会话下可读；本人在会话切换后读旧 bucket 的附件 ⇒ ok；他人在会话切换后读 ⇒ 404；loopback ⇒ ok。
- 处于 `evicting` 状态 ⇒ 404；在根目录下但不在索引中 ⇒ 404，且零 fs 调用。
- **generated / legacy** 的结构性复核（正例与反例）；用原始文件名拼出的路径 ⇒ 404。
- 扫描未完成 ⇒ `E_BUSY`；dirChain 被替换 ⇒ 409，且没有删除任何东西；大小不一致 ⇒ 409；mime 与内容不一致时以 sniff 结果为准。
- 预览读取后 `referencedAt` 不变、TTL 不变。
- **重启恢复（v3-3）**：构造旧格式的上传，经过 `recover()` 后走 legacy 分支，端到端返回 200 并通过 sha256 复核。

### PV3：hub 路由与装配（中；依赖 PV2a、PV2b；前置：SP13 对 `hub.ts` 的小修已合入）

**验收**：

- **矩阵（HP5）**：§4.7 逐格验证，外加三种 caps 组合；off 与现状字节一致；**默认配置**（on）下两处声明的 caps 都多出两项且一致。
- `api-preview.test.ts`：全流程和响应头；CSRF 的三种情况；会话不一致或不存在 ⇒ 409；未知 agent ⇒ 404；参数非法 ⇒ 400；429 + 审计键；并发 503；限流隔离（4097 个主体不影响 cmd 的桶）。
- **upload 篡改（HP8）**：冷缓存；缓存命中后 a) chmod ⇒ 图片和文本都返回完整 200，b) 内容和大小都变 ⇒ 图片 body 不完整、文本返回 409，c) 流式过程中被改写 ⇒ 图片 body 不完整；所有失败情况下客户端都拿不到完整的 200。
- **单飞**：3 个并发请求读同一个 100 MiB 文本，审计中 `verify` 为 1 个 `hashed` + 2 个 `joined`；中途断开一个不影响另外两个。
- `lan-preview.test.ts`：**默认 mode on**；同一会话中 A、B 都能读 A 的附件（U3，B 的审计 `shared:true`）；B 以另一会话请求 ⇒ 404；只读 agent 的 cwd 类请求 ⇒ 200；LAN 4 MiB 上限；home 作为 cwd 时普通文件 200、秘密文件 403（U2）；`mode:"loopback"` 时 LAN 一律 404（HP4）。
- **生命周期（HP7）**：三条路径（含单飞任务的中止）。**fd 泄漏（HP6）**。审计白名单（含 `shared` 字段），不出现路径原文和文件内容。`deadline-nesting`。

### PV4：UI 逻辑与传输（中；依赖 PV1）

**验收**：`logic-preview.test.ts`（识别规则正反例、性质测试、性能、`clientImageBudget`、`scopeKeyOf` 含 cwd）；`logic-state.test.ts`（同一 sessionId 和 sessionFile 下 cwd 不同 ⇒ 判定为换会话并清空；cwd 相同时与现状一致）；`transport-contract.test.ts`（两种 transport 同形；在读 body 之前就做的各项校验；body 不完整的情况）；`use-preview.test.ts`（各种状态迁移；scopeKey 因 sessionId 或 cwd 变化 ⇒ abort 并关闭；`E_SESSION_CHANGED` ⇒ 关闭；作用域真值表，包括**默认 on 下 password 模式能拿到作用域**）。在 `source-scan` 中禁用 `createObjectURL`。

### PV5：UI 组件（中；依赖 PV4）

**验收**：`path-text`、`preview-host`、`preview-image`、`preview-text`、`i18n-parity`、`source-scan`；`build:web` 与 `check:web`。

### PV6：接线（小；依赖 PV5；**前置：SP13 已合入或已 rebase**）

**验收**：markdown、transcript 相关的既有测试原样全绿；`preview-wiring.test.ts`：已落定的消息出现 `.path-ref`；流式中不出现，落定后出现；链接文本中不出现；切换会话后旧路径不可点；点击后的入参正确。**navigate 回归（v3-1）**：挂载接好预览的 `App.vue` 后，选中 agent ⇒ `hashRoute.navigate({name:"agent", key})` 被调用，`location.hash` 随之变化；SP13 自带的 navigate 用例原样全绿。

### PV7：代码集成（小；依赖 PV3、PV6）

`preview-e2e.test.ts`：真实的 `startHub` + 真实的 `createUploadStore`（一份 generated 格式、一份 legacy 恢复数据）+ 假 agent。cwd 类、两种上传布局、以及 LAN 上第二个用户在同一会话中读取附件（U3），四种情况端到端都返回 200 且 sha256 一致；close 时会 destroy 正在进行的流。

### PV8：文档收尾（小；依赖 PV7；前置：SP13 已合入）

- `acceptance.md`：桌面加手机 LAN 的真机验收，包括近上限图片、截断、二进制、会话切换、落定后才可点、`mode:"loopback"` 时手机端没有可点路径、hub 重启后旧上传仍可预览、**LAN 上第二个账号（如果有）能在同一会话里看到附件**。
- `AGENTS.md` 的 `src/web-hub/` 条目，说明默认 on、两类准入，以及上传可见范围已修订。
- `lan-plan.md`：写入 §5.1 的对照表和 U1、U2 的用户裁定原文。
- `web-hub-upload/plan.md`：**文末追加** §5.4 给出的修订备注，原文不改。

### 6.1 合入硬门槛

| #   | 场景                                                                                              | 包             |
| --- | ------------------------------------------------------------------------------------------------- | -------------- |
| HP1 | 软链逃逸、虚拟根                                                                                  | PV2a           |
| HP2 | 三种 TOCTOU 情况，以及 readlink 失败时 fail closed                                                | PV2a           |
| HP3 | 内存上界                                                                                          | PV2a           |
| HP4 | LAN：`mode:"loopback"` 时返回 404；**跨会话**读上传返回 404                                       | PV3            |
| HP5 | §4.7 逐格验证；off 与现状字节一致                                                                 | PV3            |
| HP6 | 无 fd 泄漏                                                                                        | PV3            |
| HP7 | 三条生命周期路径                                                                                  | PV3            |
| HP8 | 上传内容被篡改时客户端永远拿不到完整的 200；CSP 不变；不出现 `blob:`、`createObjectURL`、`v-html` | PV2b、PV3、PV5 |

**conformance 不加**：不经过 pi 的边界。

---

## 7. 关键决策与取舍

| #   | 决策                                                                         | 理由 / 被否的备选                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 用 fetch + `X-PWH` + data URL                                                | `<img src>` 带不上自定义头，同机其他端口的页面能借它当探针；用 blob 则需要放宽 CSP                                                                                               |
| D2  | 返回原始字节，元数据放响应头                                                 | 比 JSON+base64 少 33% 的体积                                                                                                                                                     |
| D3  | LAN 只由 mode 决定，**默认 on**                                              | 「cmd.v1 权限等价」不成立（§5.1）；权限做成一个可见、可控的开关；默认 on 来自用户拍板 U1（唯一使用者、密码认证、明示接受风险）                                                   |
| D4  | upload 内容对**会话可见者共享**（U3）                                        | 与 transcript 共享的语义保持一致：路径既然对会话查看者可见，内容也一并可见；写入面、去重、钉住仍按主体绑定，影响面封闭（§5.4）。这修订了 upload §5.1，修订通过追加备注的方式记录 |
| D5  | 在渲染层识别路径                                                             | 不碰解析器；自动覆盖所有容器；没有 ctx 时 DOM 等价                                                                                                                               |
| D6  | 只识别正文和反引号，且必须位于 cwd 或 uploads 下                             | 误报接近 0                                                                                                                                                                       |
| D7  | provide 放在 `App.vue`                                                       | 避开 fleet F6；与 SP13 的冲突用闸门加回归测试化解                                                                                                                                |
| D8  | 不支持 SVG、HEIC、AVIF、BMP                                                  | 白名单保持最小                                                                                                                                                                   |
| D9  | GET 不做二次 authorize                                                       | 只读，准入 ≤8s                                                                                                                                                                   |
| D10 | 不缓存响应                                                                   | 文件可能随时变化                                                                                                                                                                 |
| D11 | 拒绝列表只作纵深防御                                                         | 安全边界在别处；home 作为 cwd 时主要靠它（U2）                                                                                                                                   |
| D12 | mode 为 loopback 时 LAN 返回 404                                             | 与 off 时字节一致，不额外暴露信息                                                                                                                                                |
| D13 | 作用域按会话划分，键里带上 cwd 作双保险                                      | 依赖 cwd 不变量加上切会话时清空的行为，无需做快照；带上 cwd 只多一行代码，换来纵深防御                                                                                           |
| D14 | 独立的 `CmdLimit` 实例                                                       | 避免批量淘汰时挤掉其他线路的桶                                                                                                                                                   |
| D15 | 超出预算时不提供下载                                                         | 下载走浏览器导航，带不上 `X-PWH`                                                                                                                                                 |
| D16 | sha256 复核：图片在流式过程中计算，文本在发头前复核并单飞                    | 图片读取本来就要完整过一遍，失败直接 destroy，绝不在发头之后切换路径；文本可以安全地使用缓存；单飞避免并发时重复的 O(n) 计算                                                     |
| D17 | 旧布局走 legacy 分支，不做迁移                                               | 迁移会带来崩溃一致性问题；旧文件随 TTL 自然消失                                                                                                                                  |
| D18 | 判定会话可见者时，以「请求声明的会话当前可见」为前提，并要求 bucket 与之匹配 | hub 没有按会话的 ACL，所以「能看到会话」就等于「已认证且该会话在 registry 中是当前会话」；要求 bucket 匹配，可以防止借会话 X 的请求去读会话 Y 的附件；上传者本人不受会话切换影响 |

扩展点（本期不做）：fenced 代码块与 ToolCard 中的路径；相对路径；点击行号跳转定位；把 fleet 行和 worktree 纳入作用域；更多图片格式；附件 chip；在上传托盘中提示「附件对会话可见者共享」（归上传线）。

---

## 8. 风险清单

| #   | 风险                                                                   | 级别 | 缓解 / 状态                                                                                    |
| --- | ---------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------- |
| R1  | 默认 on 时，LAN 用户可无痕读取 cwd 内的秘密（含 home 作为 cwd 的情况） | 高   | **用户已明示接受**（U1/U2）；拒绝列表；虚拟根；设置说明提示「LAN 有其他使用者时改为 loopback」 |
| R2  | 明文 LAN 被嗅探                                                        | 中   | 沿用既有裁定，界面常驻警告                                                                     |
| R3  | 非 Linux 平台无法用 `/proc/self/fd` 复核                               | 低   | dev/ino + `O_NOFOLLOW`                                                                         |
| R4  | 解码炸弹                                                               | 低   | 40MP 上限，尺寸未知即拒绝；客户端上限 20MP                                                     |
| R5  | 生成名改造的终态与假设不符                                             | 中   | PV2b 开工闸门先核对                                                                            |
| R6  | 与 SP13 冲突                                                           | 中   | 闸门 + navigate 回归测试                                                                       |
| R7  | fleet 不同意本方案的合入顺序                                           | 低   | 有回退方案                                                                                     |
| R8  | hub 单例，设置改动需重启                                               | 低   | 在设置说明中写明                                                                               |
| R9  | 文本复核要读完整个文件                                                 | 低   | 单飞 + 缓存                                                                                    |
| R10 | hardlink / bind mount                                                  | 低   | 不在威胁模型内，用测试钉住                                                                     |
| R11 | 拒绝列表误伤                                                           | 低   | 有意为之                                                                                       |
| R12 | worktree 路径不可点                                                    | 低   | 留到 S2                                                                                        |
| R13 | `sameSession` 改动可能导致多余的重拉                                   | 低   | 正常情况下不会触发                                                                             |
| R14 | 上传者不知道附件内容对会话可见者共享（U3）                             | 低   | 用户是唯一的 LAN 使用者；托盘文案的提示由上传线跟进（扩展点）；PV8 在 `AGENTS.md` 中写明       |
| R15 | 共享的附件可能先于读者需要被淘汰                                       | 低   | TTL 语义不变（预览读取不延长）；被淘汰后返回 404，UI 显示错误                                  |

---

## 9. 已裁定（待确认清单已清空）

| 事项                                      | 裁定                                                                              | 来源                  |
| ----------------------------------------- | --------------------------------------------------------------------------------- | --------------------- |
| `webHub.preview` 默认值                   | **`"on"`**，LAN 可用；用户是 LAN 唯一使用者且启用了密码认证，明示接受 §5.1 的风险 | 用户 2026-10-05（U1） |
| home 作为 cwd 的 LAN 预览                 | **允许**，拒绝列表兜底（拒绝会废掉大半用途）                                      | 用户 2026-10-05（U2） |
| 上传附件在 LAN 上的可见范围               | **会话可见者共享**，修订 upload §5.1；影响面见 §5.4；upload plan 只追加备注       | 用户 2026-10-05（U3） |
| 两个 listener 在未认证时的 401/404 不对称 | 维持现状（loopback 401，LAN 未知 GET 404），preview 不改变                        | 主会话 2026-10-05     |
| App.vue 冲突                              | 归入 SP13 文件域；PV6 设闸门，并做 navigate 回归测试                              | 主会话 2026-10-05     |
| scopeKeyOf 与 cwd                         | cwd 同时纳入 `scopeKeyOf` 和 `sameSession`（双保险）                              | 主会话 2026-10-05     |
| 旧布局上传                                | 走 legacy 分支，不迁移                                                            | 主会话 2026-10-05     |
| 图片身份缓存                              | 图片一律在流式过程中算哈希，失败即 destroy；禁止发头之后切换路径                  | 主会话 2026-10-05     |
| 哈希单飞                                  | 文本复核按 `(uploadId, identity)` 单飞                                            | 主会话 2026-10-05     |
| `:行号` 跳转定位                          | S1 不做                                                                           | v3 收敛               |
| 与 fleet 的合入顺序                       | 默认 preview 在前；PV1 开工前与 fleet 对齐，对方不同意时回退（§2.3）              | v3 收敛               |
