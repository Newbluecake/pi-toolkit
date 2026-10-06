# 会话详情页「后台 bash 任务」只读面板：实施方案 v3

> 状态：**已实施**（A0 协议 `384ad91` · A agent 侧 `468c8c8` · B UI `16a6c39`；conformance
> `tests/conformance/rpc-bash-jobs.test.ts` 随 A 交付）。
> 基线 `2c37815`（v1 `965b8fd`），以符号名为准。照 todo-web/worktree-web：agent 投影 → 可选 `StatusInfo.bashJobs`（不 bump
> PROTO、不加 caps）→ 详情头只读面板；零 hub/`state.js`/settings 改动。评审处理见文末「v2/v3 修订记录」。

## 0. 可行性证据（已核实）

- web-hub 仅 tui/rpc attach（`agent/index.ts` `on("session_start")` 首行）。同步零 I/O 快照 `BashJobManager.list()`
  （`manager.ts`，createdAt 升序）。**manager 每次 session_start/stack 重建都换新实例**、不看 `ctx.mode`
  （`stack.ts` `previousBashJobs?.dispose()` 后 `buildBashJobManager`），旧实例 dispose 后 `list()` 仍返回旧 `entries`；
  web-hub 的 session_start 注册在 `wireDeferredReload` 之后、读 `holder.current` 时已是新 stack（`src/index.ts` 注释）。
  `WebHubDeps` 目前无 bash 端口（`fleet`/`query`/`todo` 均为 holder 晚绑定闭包，照此做）。
- **终态先于 footer**（`manager.ts` `finalizeLocal`）：`applyTransition(terminal, {logBytes: written})` → 等 drain →
  `appendLogFooter` → stream end → `applyPatch({logBytes: written})`。两步之间 record 已终态、但 logBytes/日志尾还会再变。
- **retention 只清盘、不清内存**：`maybeSweep()` → `store.pruneExpired()` 删 `.json/.log`，但 `entries` 只在
  `shouldDiscardJob`（前台）与 adopt 路径 `entries.delete`；`list()` 会无限期返回过期终态记录（评审 #3 成立）。
  过期判据 `now - (endedAt ?? createdAt) >= retentionMs`，`retentionMs <= 0` = 关闭（`job-store.ts` `pruneExpired`）。
- 有界 tail：`readBashJobTail(manager, record)`（`stack.ts`，1 KiB/10 行，返回 `{text, logBytes=实际文件大小}`，异常 →
  undefined；**绑定具体 manager**）；中段起读时首行可能半行。
- **同数据已在 web 线上**：transcript 的 bash ToolCard 摘要取 `args.command`（`ui/src/logic/tools.js` `SUMMARY_KEYS`），
  仅受 `LIMITS.textTruncateBytes` 截断、无脱敏；结算通知 `formatBashJobNotification(record, tail)`（`stack.ts`）以
  `display:true` 自定义消息进 transcript，含 10 行 tail **和完整 logPath**。
- `c.setSlot("status")` 最新值槽；`publishStatus` 与 snapshot 两处 `readStatus`；`StatusInfoSchema` 开放 ⇒ hub 透传。1Hz
  `onTick` 已有 todo 指纹门与 `wtSampler.tick`；reconnect 调 `publishStatus(); onTick(); wtSampler.kick()`。走时先例
  `FleetTree.vue` `tickBaselines`；真 rpc 夹具 `tests/conformance/rpc-spawn.test.ts`；pi 支持 `--session`。

## 1. 决策

**D1 选行**：数据源 = 被查看会话进程的 `list()`（含 retag/recover 捡回的 orphaned/exited_unknown）。不扫盘、不含子会话。
`selectJobs(records, now, retentionMs)`：①`backgroundedAt !== undefined`；②**终态行须 `retentionMs <= 0 ||
now - (endedAt ?? createdAt) < retentionMs`**（与 store 同式，#3）；③非终态按 createdAt 降序在前，终态按
`endedAt ?? createdAt` 降序；④总 20 行、终态 ≤12，余数计 `omitted`。无行 ⇒ 字段缺省（与 pre-feature 字节等价）。
`retentionMs` 经 deps 注入（`() => settings.bashJobs.retentionMs`），不读盘。

**D2 行内容**：字段见 §2。**v2 删 `logPath`**（连同 CopyButton；通知卡已带路径；顺带消掉 #5 的路径预算项）。

**D2a 命令与 tail 保留（用户裁定，#1/#2）**。理由写进文档与 UI：同一命令全文已在 ToolCard、同一 tail 已在结算通知卡
（`display:true`）里上 web 线，面板不扩大暴露面；U1 裁定（唯一 LAN 用户、密码认证）。**脱敏是 best-effort 卫生，
明确不是安全边界**；面板展开区固定显示提示「命令与输出可能含敏感信息；脱敏仅尽力而为」。

- 命令管线（先匹配后截断）：`raw.slice(0, 8192)` → `redactSecrets()`（在原始多行文本上跑，引号/换行/heredoc 完整可见）
  → 空白折叠单行 → 截 200 字符（`…`）→ UTF-8 字节帽。显示窗口只有前 200 字符，任何起点 <200 的令牌在 8 KiB 窗口内
  完整可匹配；8 KiB 后的内容永不显示，跨 8 KiB 边界的残片也在截断后被丢弃。不复用 `previewCommand`（它先截断）。
- tail 管线：去 ANSI CSI/OSC 与除 `\n\t` 外的 C0 控制字符 → 若 `logBytes > BASH_JOB_TAIL_BYTES`（读起点在文件中段）
  丢弃首个可能残缺的行（半个令牌前缀规则匹配不到）→ 逐行 `redactSecrets()` → 字节帽（从头部按行丢，保留尾部）。
- `redactSecrets` 规则（纯函数，命令与 tail 共用）：
  1. 赋值 `KEY=VAL` / `export KEY=VAL`，KEY ~ `/(token|secret|passw(or)?d|pwd|api[_-]?key|auth|credential|cookie|
session|private[_-]?key)/i`；VAL 文法 `"[^"]*"|'[^']*'|\$\([^)]*\)|\S+`（覆盖 `VAR="$(cat token)"`）⇒ `KEY=***`。
  2. flag 值：`--(token|password|api-key|secret|auth)[= ]VAL`、`-p<VAL>`（仅 mysql/psql 类紧贴形式）⇒ `***`。
  3. 头：`(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-[\w-]*(Key|Token))\s*:\s*[^"'\n]*` ⇒ `Name: ***`；
     独立 `Bearer \S+`、`Basic [A-Za-z0-9+/=]+` ⇒ `Bearer ***`。
  4. URL：userinfo `://u:p@` ⇒ `://***@`；query 值 `[?&](token|access_token|api_key|key|sig|signature|password|secret)=[^&\s'"]*` ⇒ `=***`。
  5. JSON：`"(KEY 同 1)"\s*:\s*"[^"]*"` ⇒ `"k":"***"`。
  6. 已知前缀：`sk-`、`ghp_|gho_|ghs_|github_pat_`、`xox[abp]-`、`AKIA[0-9A-Z]{16}`、JWT `eyJ[\w-]+\.[\w-]+\.[\w-]+`。
  7. base64：≥64 字符 `[A-Za-z0-9+/]+={0,2}` 且同时含大写、小写、数字 ⇒ `***`（40 位 git sha / 64 位 sha256 hex
     无大写，不误伤）。

**D3 推送与两段语义**（#4/#6，v3 改 R3-1/2/3）：manager 无事件 ⇒ 挂现有 1Hz `onTick`，不建常驻 interval。

1. **轻指纹**（同步、每 tick、对 `selectJobs` **结果**算，retention 到期也改指纹）：
   `rows.map(r => [id, status, exitCode, endedAt, grace, running ? floor(elapsedMs/60000) : 0, terminal ? logBytes : -1])`
   \+ 行数 + omitted。**终态行 logBytes 入指纹**（R3-2，终态后只剩 footer 补丁会再改，有界）；running 行 logBytes/秒级
   elapsed 不入。变化 ⇒ `publishStatus()` **立即**发（状态权威、不等 tail），并 `sampler.kick(changedIds)`。
2. **tail 采样器** `createBashJobsSampler`（仅 hub live；单飞、timer 全 unref、generation 丢弃迟到结果；照 `worktree-sampler`）：
   - **需采样判据**（每 tick 对当前选集同步重算，纯内存，不靠 kick 记忆）：无缓存；或 `c.tailBytes !== r.logBytes`；或
     终态且 `c.tailAt < endedAt`；或 running 且 `now - c.tailAt ≥ 10s`。第二条使「终态→footer→logBytes 补丁」之间采到的
     无 footer tail 在补丁落地后**必然**重新入队（R3-2）；读到的文件大小 > record.logBytes（footer 已写、补丁未到）同样
     不算 current，下 tick 再读。**稳定失配**（adopt 等）：连续 3 次 text 与大小不变 ⇒ `settled`、视同 current、停读，直到
     record.logBytes 变。
   - **并发与 deadline**（R3-1；v4 修复审 #3）：`perRound = 20`（= D1 行数上限，一轮覆盖整个选集）；
     **per-job 2s deadline 包住整个 job 的 tail 读取**（`readBashJobTail` 内部的 ≤2 次 `readOutput` 共享同一 deadline，
     不是每次读各 2s）⇒ per-batch 上限 = per-job 上限 = 2s，与行数无关。顺序：kick 行 → 终态未 current 行 → running 到期行。
   - **连续追赶**：轮在途时到达的 kick/新需采样行记 pendingRerun，轮结算后**立即**（unref 0ms）起追赶轮；本轮刚读过仍未
     current 的行留给下个 tick（每行 ≤1 次/秒、无忙等）。
   - **zombie 按 job 计**（v4 修 R3 复审 #1）：超时未落地的读把该 job 标 zombie、该 job 不入新轮直到落地（落地结果按
     generation 丢弃，但触发 pendingRerun）；其余行照常。槽位有**硬释放**：读起后 10s 未落地 ⇒ 槽位释放、结果到达即丢
     （fs 读无法取消，但槽位不被旧代/楔死读永久占住 — 新代永远能进展；同一时刻计入 I/O 上界的只有 <10s 的读）。
     全局活跃（<10s）读 ≥4 才停起新轮。读返回 undefined ⇒ 重试 ≤3 次后 `tailUnavailable`（内部记
     `unavailableAtLogBytes = record.logBytes` — v4 修复审 #2：此后每 tick 不再重试，直到 `record.logBytes !==
unavailableAtLogBytes`；`tailUnavailable` 行**永不**置 `tailCurrent`）。tail 文本/tailBytes/current 位变 ⇒
     `onChange()` → `publishStatus()`。
   - 缓存只留当前选中 jobId（retention 到期行的 tail 同帧消失）；源代际变（D3-4）或 session_start ⇒ 清缓存。
3. **新鲜度**由 **agent 判定**、以 `tailCurrent?: true` 上线（UI 不再自行比较）：终态行
   `tailAt >= endedAt && tailBytes === 当前 record.logBytes`（或 `settled`）；running 行 `tailAt` 存在。非 current ⇒ UI 显示 `sampling…`（有旧
   tail 时仍显示 + 标记）；无 tail 且非 sampling ⇒ `no output yet`。**陈旧上界**（hub live、zombie <4、单读 <2s）：
   采样器空闲时，状态变化 ≤1 tick 被发现 + 一轮 ≤2s ⇒ **≤3s 内全部（≤20）终态行 current**；轮在途时 + 追赶轮 ≤2s ⇒
   ≤5s；footer 补丁落地后 ≤1 tick + 2s 再 current；running 行 ≤10s + 2s + 1s = 13s。被 zombie 卡住的行无上界 ⇒ UI 用
   `sampledAt - tailAt`（同一 agent 时钟）显示 `tail 45s old`，>30s 才显示。
4. **源与代际**（R3-3）：端口不是捕获的 manager，而是 holder 晚绑定 `current(): BashJobsSource | undefined`，
   `BashJobsSource = { gen: object; list(); tail(r) }`，`gen` = manager 实例本身（身份比较），`list`/`tail` 都绑定**同一**
   manager（`tail = r => readBashJobTail(m, r)`）。规则：①每轮开始取一次 source，本轮 list 与所有 tail 只用它（不混代）；
   ②结算时 `current()?.gen !== 本轮 gen` ⇒ 整轮结果丢弃、不 publish；③每 tick 与每次 `readStatus` 先取 source，`gen` 与
   缓存 gen 不同 ⇒ 清缓存 + bump generation + 全量 kick（旧 gen 的 zombie 仍计入 I/O 上界，结果丢弃）；④`readStatus`
   只把 `cache.gen === source.gen` 的 tail 拼进投影，行集合与 tail 同代；⑤`current()` 为 undefined（compat gate 失败、
   holder 空）⇒ 字段缺省。会话边界：/new、/resume、/fork 走 stack 重建 → gen 变（web-hub session_start 另外显式 reset）；
   /reload 是新 activate（新 holder、新 sampler），旧 activation 在 session_shutdown `stop()`，迟到结果按 generation 丢弃。
   采样 I/O 只经 source（不 import `stack.ts`）；`readStatus` 只读缓存（热路径零 I/O）；`bashJobsEnabled=false` ⇒ 无端口。

**D4 UI**：`BashJobsPanel.vue` 照 `TodoPanel.vue`：默认折叠；摘要 `bash 2 running · 5 done · 1 failed`（英文 token）；
展开每行：状态图标、短 id、cmd（等宽单行省略，title=脱敏后全文）、`exit N`/`grace`、时长、`logBytes`（`+`=截断）。
行点击 ⇒ `<pre>` 纯文本 tail（禁 v-html）+ D3-3 新鲜度标记（读 `tailCurrent`） + 敏感提示（中文散文）。`omitted` ⇒ `(+N more)`。零行/无
wire ⇒ 不渲染。折叠态本地 ref 不持久化；样式进 `styles/bash-jobs.css`（禁 `<style>`）；i18n en/zh 键集一致。
**走时基线**（#6）：照 `FleetTree.vue` — `Map<id,{elapsedMs, at}>`，行 `elapsedMs` 变（新帧）即重置 `at = 共享 now`，
显示 `elapsedMs + max(0, now - at)`；终态行直接显示 `elapsedMs`；行集合收缩时 prune；计时器仅在存在 running 行时启用、
卸载清理。已知局限：浏览器晚连时 hub 回放的旧 status 帧会少计回放时长，被 D3-1 分钟桶封顶在 ≤60s。

**D5 兼容**：可选字段、不 bump PROTO、不加 caps；旧 hub 透传、旧 UI 忽略；webHub 关 ⇒ 不 wire。`BashJobsWireSchema`
`additionalProperties:true` + 宽于投影的上限（worktree Q4 先例）。

**D6 字节预算**（#5，v3 R3-4）：预算对象**只是 `BashJobsWire`**（即 status 帧的 `bashJobs` 槽值），常量
`BASH_JOBS_WIRE_BUDGET_BYTES = 24 << 10`，度量函数 `bashJobsWireBytes(w) = Buffer.byteLength(JSON.stringify(w))`（含转义
膨胀）——投影削减、单测、conformance 断言**同用此函数与此对象**。照 todo（`TODO_WIRE_BUDGET_BYTES` 32 KiB）/worktrees
（`WT_WIRE_BUDGET_BYTES` 16 KiB）先例各槽自管预算，不对整帧设 24 KiB；整帧 = 基础字段 + todo≤32 + wt≤16 + bash≤24 KiB，
远低于 `MAX_FRAME_BYTES`（4 MiB，`ndjson.ts`），无需为兄弟槽预留。

- 每字段帽（UTF-8 边界安全截断）：`id` ≤32B、`status` ≤32B、`cmd` ≤200 字符且 ≤600B、`tail` ≤1024B 且 ≤10 行。
  D2a 已去控制字符 ⇒ 转义膨胀仅 `"`/`\`（≤2×）。最坏单行 ≈ 600·2 + 1024·2 + 250 ≈ 3.5 KiB，20 行 ≈ 70 KiB > 24 KiB ⇒ 削减必要。
- 削减顺序（保 tail 可用）：①最旧终态行起把 tail 缩到末 3 行/≤256B；②仍超 ⇒ 最旧终态行起删 tail；③再从最旧 running 行
  缩 tail 到 256B；④再删 running tail；⑤从尾部删终态行、再删 running 行，计入 `omitted`。cmd 不削（≤600B 已有界）。

## 2. 线协议（`src/web-hub/protocol/messages.ts`）

```text
export interface BashJobRowWire {
  id: string; cmd: string /* redacted, ≤200 chars / ≤600 B */; cmdTruncated?: true; status: string;
  exitCode: number | null; createdAt: number; endedAt?: number; elapsedMs: number /* agent clock at projection */;
  logBytes: number; logTruncated?: true; grace?: true;
  tail?: string /* redacted, ≤1024 B */; tailAt?: number /* agent clock when sampled */;
  tailBytes?: number /* file size seen by that sample */; tailUnavailable?: true;
  tailCurrent?: true /* agent-judged freshness, D3-3 (v3) */;
}
export interface BashJobsWire { rows: BashJobRowWire[]; total: number; running: number; failed: number; omitted?: number; sampledAt: number }
// StatusInfo: bashJobs?: BashJobsWire;   StatusInfoSchema: bashJobs: Type.Optional(BashJobsWireSchema)
```

Schema 上限：rows maxItems 64、cmd maxLength 1024、tail maxLength 8192、status 32。

## 3. 文件级步骤

### 包 A0（协议冻结，先合）

1. `protocol/messages.ts`：§2 interface + `BashJobRowSchema`/`BashJobsWireSchema`（导出）+ `StatusInfo(Schema).bashJobs`。
2. `tests/web-hub/protocol/bash-jobs-schema.test.ts`：合法/未知字段/旧帧（无 bashJobs）过、超 maxItems 拒、schema 无 `logPath`。

### 包 A（agent 侧）

3. 新 `src/web-hub/agent/redact.ts`：`redactSecrets(s)`、`sanitizeTail(text, logBytes)`、`redactCommand(raw)`（D2a）。
4. 新 `src/web-hub/agent/bash-jobs.ts`（纯函数、零 pi import，只 `import type` JobRecord + `isTerminalJobStatus`）：
   `selectJobs(records, now, retentionMs)`、`projectBashJobs(records, tails, now, retentionMs)`（D2/D6/`tailCurrent`）、
   `bashJobsLightFingerprint(selected, now)`（D3-1）、`BASH_JOBS_WIRE_BUDGET_BYTES`、`bashJobsWireBytes`、常量。
5. 新 `src/web-hub/agent/bash-jobs-sampler.ts`：`createBashJobsSampler({ source, now, isLive, onChange, deadlineMs=2000,
runningEveryMs=10000, perRound=20, maxZombies=4, maxRetries=3, settleRounds=3 })` → `{ tails(gen), kick(ids?), tick(now),
start(), stop() }`；单飞 + per-job `Promise.race`（unref）+ per-job zombie + 追赶轮 + 每 tick needsSample + 源 gen 校验。
6. `agent/status.ts`：`readStatus` 加第 7 参 `bashJobs?: () => BashJobsWire | undefined`。
7. `agent/index.ts`：`WebHubDeps.bashJobs?: { current(): BashJobsSource | undefined; retentionMs(): number }`（D3-4）；闭包
   `lastBashFp` + sampler（isLive 同 wtSampler）；`publishStatus` 与 snapshot 两处 `readStatus` 传投影闭包；`onTick` 指纹门 →
   publish + kick；`sampler.tick(now())` 返回 true ⇒ publish；session_start 清 `lastBashFp`/缓存并 `start()`；shutdown
   `stop()`；reconnect 处 `sampler.kick()`。
8. `src/index.ts` `wireWebHub(...)` deps：`bashJobsEnabled(settings)` 时注入 `current: () => { const m = holder.current?.bashJobs;
return m && { gen: m, list: () => m.list(), tail: (r) => readBashJobTail(m, r) } }` 与 `retentionMs: () =>
settings.bashJobs.retentionMs`（每次调用现取 holder，绝不在 activate/session_start 捕获 manager）。
9. 测试（`tests/web-hub/agent/`）：
   - `redact.test.ts`（#8，**卫生用例、非边界证明**；命令与 tail 两路各跑一遍）：shell 单/双引号、反斜杠续行与 heredoc
     换行、`export`、`VAR="$(cat token)"`、`TOKEN='a b'`；`curl -H "Authorization: Bearer x"`、`-H 'X-Api-Key: k'`、
     `--header=Cookie: s=1`；URL userinfo 与 `?access_token=…&x=1`；`-d '{"password":"p","api_key":"k"}'`、多行
     JSON tail；`Basic <b64>` 与 ≥64 字符混合 base64；前缀令牌全表；跨 200 字符截断边界的令牌（先匹配后截断）；tail
     中段读起点的半行丢弃；ANSI/控制字符剥离。误伤反例：`npm test`、`git log --author=x`、40 位 sha、sha256 hex、
     `session_start` 之类标识符不在赋值位置。
   - `bash-jobs-projection.test.ts`：过滤前台、排序、20/12+omitted、空 ⇒ undefined；**retention 假时钟**（#3）：
     `endedAt=T`，`now=T+R-1` 行与 tail 在、`now=T+R` 行与 tail 同时消失且指纹变化；`R<=0` 不过滤；以 `createdAt` 兜底
     的无 endedAt 终态行；**每字段帽**（4 字节 emoji cmd、超长 status/id）与**最坏组合**（#5：20 行全帽、tail 全 `"`/`\`）
     ⇒ `bashJobsWireBytes(wire) ≤ BASH_JOBS_WIRE_BUDGET_BYTES`、削减顺序逐级断言（running tail 最后删、终态 tail 先缩后删）；
     指纹不受 running logBytes/秒级 elapsed 影响，受 status/exit/grace/分钟桶/**终态 logBytes**（R3-2）影响；`tailCurrent` 表。
   - `bash-jobs-sampler.test.ts`（fake timers）：kick 行优先；终态 current 后只读一次；running 10s 节流；**20 终态行**
     （R3-1）同 tick 变终态 ⇒ 一轮发起全部读、≤3s 全部 `tailCurrent`；轮在途再 kick ⇒ 立即追赶轮、≤5s；1 楔死 + 19 行 ⇒
     19 行 2s 内 current；4 zombie ⇒ 停轮、落地后恢复并补跑 pendingRerun（#4）；**footer 竞态**（R3-2）：record 终态
     logBytes=N 时采样（无 footer、current）→ 文件追加 footer（读到 N+k、record 仍 N ⇒ 非 current、每 tick 至多一读）→
     补丁 N+k ⇒ 重新入队、tail 含 footer 且 current；稳定失配 3 次 settled、logBytes 再变复读；**源换代**（R3-3）：A→B 后
     首 tick 清缓存只读 B，A 的在途轮落地 ⇒ 丢弃不 onChange，同轮 list/tail 恒同源；重试 3 次 `tailUnavailable`；stop 后
     迟到结果丢弃；非 live 不读；retention 到期缓存剔除。
   - `wiring.test.ts` 扩（#4/#6）：传端口 ⇒ 帧含 bashJobs；状态变 ⇒ 立即一帧（非 current）再一帧（current）；首个 running
     行同 tick 发帧；reconnect 后新连接收到 bashJobs 槽且 kick、在途时仅一次补采；snapshot_req 返回 bashJobs；不传端口 ⇒
     字节等价；**manager 重建**（R3-3，holder 换 stack 模拟 /new·/resume）：下一帧只含新 manager 行、旧 tail 不出现；
     `current()` undefined ⇒ 字段缺省；/reload 模拟（旧 wiring shutdown + 新 wiring）后旧 sampler 不再调任何 tail。
10. 真托管 RPC 集成（#7）：新 `tests/conformance/rpc-bash-jobs.test.ts`，克隆 `rpc-spawn.test.ts` 夹具（真 `pi --mode rpc`、
    假 hub socket 回 `hello_ack`、temp HOME 正规安装、`webHub.enabled`），预写已知 id 的会话文件经 `--session <path>` 启动（备选：
    读首个 `session` 帧拿 sessionId → 播种 → rpc `switch_session` 触发 session_start/recover）。在
    `<HOME>/.pi/agent/bash-jobs/<sanitizeSessionDirName(id)>/` 播种：终态后台 job（log 含 `ghp_…`、`Authorization: Bearer …`）、
    hostPid 已死的 running job（recover 成 orphaned/exited_unknown）、前台 job、超 retention 终态 job。断言：≤30s 收到含 bashJobs
    的 status 帧；前台/过期行缺席；tail 已脱敏且最终 `tailCurrent`；无 `logPath`；`bashJobsWireBytes(frame.bashJobs) ≤ 24 KiB`
    （只量该槽，D6）；stdin EOF ⇒ 8s 内退出。随 `npm run test:conformance`、`skipIf(!existsSync(PI_CLI))`；不起 hub ⇒ 无 reaper flake。

### 包 B（UI）

11. 新 `ui/src/components/detail/bashJobsView.ts`：`bashJobsOf(agent)`、`statusToken(row)`（未知 ⇒ generic）、
    `tailFreshness(row, sampledAt)`（按 `tailCurrent`：current/sampling/unavailable/age）、`formatBytes`、`summaryCounts`。
12. 新 `BashJobsPanel.vue`（D4，含 FleetTree 式 baseline Map）+ `styles/bash-jobs.css`。
13. `DetailHeader.vue`：`WorktreePanel` 后 `<BashJobsPanel v-if="bashJobs" :jobs="bashJobs" />`。
14. `i18n/{en,zh}/detail.ts`：`bashJobs{Title,Summary,Running,Done,Failed,Exit,Grace,NoOutput,Sampling,TailAge,
Unavailable,More,SensitiveHint}`。
15. 测试 `tests/web-hub/ui/bash-jobs-panel.test.ts`：空态、计数、行展开、`<script>` tail 作文本、未知 status、omitted、
    sampling/age/unavailable 标记、**敏感提示始终可见**、无任何 logPath/CopyButton 渲染、走时基线（新帧 elapsedMs 变 ⇒
    重置；终态不走；无 running 行不起计时器；卸载清理）；`detail-header.test.ts` 加挂载断言；`build:web` 看 190 KiB gzip 预算。

### 包 C（文档，A/B 合入后）

16. `AGENTS.md` web-hub 段一句指针（含「脱敏非安全边界」）；本文件状态改「已实施」+ 提交号。

## 4. 并行、冲突面与测试注意

- A0 先合；A/B 文件不相交可并行（B 用手写 fixture，仅 `import type`）。热点 `src/index.ts`、`DetailHeader.vue`、`i18n/*/detail.ts`
  只做局部插入。验收模型 ≠ 开发模型；A 重点：热路径零 I/O、timer 全 unref、楔死 tail 不挂、retention 行+tail 同帧消失、
  缺省字节等价、不捕获 manager、20 行 3s。
- 全量跑时 `web-hub-headless.test.ts` 的 `findReaperPid()` 若因本机真实 hub 误命中/超时，属已知环境 flake——停本机 hub
  或单独重跑，不改代码迁就；新 conformance 用例不起 hub。CI 四步 + `build:web` 体积 + 手跑 `npm run test:conformance`。
- 非 v1：子会话 job（`child-registry.ts`）、按需全量日志（新路由+白名单）、kill/extend（P2 `cmd`）、脱敏可配置、logPath 展示。

## v2 修订记录（评审 gpt-5.6-sol，PASS-with-changes）

- #1 命令保留（用户裁定）+ 敏感提示 + 先匹配后截断；#2 tail 保留、删 logPath/CopyButton；#3 retention 投影过滤；#4 新鲜度
  与 `sampling…`；#5 字段帽 + 五级削减；#6 分钟桶 + FleetTree 基线；#7 真 rpc conformance；#8 脱敏卫生全表；#9 拒绝。

## v3 修订记录（评审 gpt-5.6-sol 第 2 次 REJECT，4 条；只修不重设计）

- **R3-1 并发 vs 3s 上界** → D3-2 `perRound` 4→20（= 行数上限，一轮覆盖选集）；per-job 2s deadline、轮于全部落地或 2s
  结算 ⇒ per-batch = per-job = 2s；轮中变更走立即追赶轮；zombie 按 job 计、≥4 才停轮；D3-3 上界改为空闲 ≤3s / 在途 ≤5s；
  §3.9 加 20 终态行、追赶轮、1 楔死不阻塞 19 行用例。
- **R3-2 footer 竞态** → 核实 `finalizeLocal` 先终态、后 footer、再补 logBytes。D3-1 终态行 logBytes 入指纹；D3-2 每 tick
  按 `tailBytes !== record.logBytes` 重算需采样（不靠 kick），文件大于 record 亦非 current，稳定失配 3 次 settled 防空转；
  新鲜度改 agent 判定 `tailCurrent`（§2 加可选字段）；§3.9 footer 竞态用例。
- **R3-3 manager 换代** → 新 D3-4：holder 晚绑定 `current()` → `{gen, list, tail}`（gen = manager 实例），单轮不混代、结算
  校验 gen、换代清缓存、投影只拼同代 tail，写明 /new·/resume·/fork 与 /reload；§3.7/3.8 端口改形；§3.9 加重建/在途切换用例。
- **R3-4 预算对象** → D6 预算只作用于 `BashJobsWire` 槽值、单一度量 `bashJobsWireBytes`，实现/单测/conformance 同用；兄弟
  槽各自预算、整帧远低于 4 MiB `MAX_FRAME_BYTES`；§3.10 只量 `frame.bashJobs`。
