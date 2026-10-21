# web-hub `/` 命令参数提示与补全 — 实施方案（plan v1）

> 状态：设计稿（只读调研产出，待用户拍板 §10 后施工）。日期 2026-10-21。
> 范围：浏览器 UI Composer 在 `/name␠` 之后给出**参数用法提示（静态）**与**参数补全（动态）**。
> 前置阅读：AGENTS.md web-hub 段 P2 control-plane；`docs/dev/web-hub/control-plan.md` §4.6/§7.7；
> `src/web-hub/ui/src/components/control/{Composer,CommandPalette}.vue`。
> 建议车道：**L3**（跨 agent/hub/UI 三端 + 新协议帧 + 新 cap；评分：协议 +3、跨端 +2、安全面 +2）。

## 0. 结论摘要

1. **pi 不通过 `ExtensionAPI` 暴露其它命令的 `getArgumentCompletions`**。`pi.getCommands()` 只返回
   `{name, description, source, sourceInfo}`（pi `dist/core/extensions/types.d.ts:1293`、`dist/core/slash-commands.d.ts:3`）；
   完整 `RegisteredCommand`（含补全函数）只存在于内部 `ExtensionRunner.getRegisteredCommands()/getCommand()`
   （`runner.d.ts:159/161`），`ExtensionContext`（`types.d.ts:213`）不含 runner。
2. **但 TUI 模式下有一条公开通路拿到「全部命令的补全」**：`ctx.ui.addAutocompleteProvider(factory)`
   （`types.d.ts:141`，`AutocompleteProviderFactory` `:66`）。interactive-mode 的 `setupAutocompleteProvider()` 用
   `createBaseAutocompleteProvider()`（含 builtin、**所有扩展命令的 `getArgumentCompletions`（含第三方）**、skill、
   prompt 模板）作为 `current` 依次喂给每个 wrapper factory（`bundle/chunks/chunk-66G7ITPS.js`）。我们注册一个**透传**
   factory，只把 `current` 存进每栈闭包，之后用 `current.getSuggestions(["/name <prefix>"], 0, len, {signal})` 即可
   得到与本机 TUI 完全相同的参数补全（slash 参数分支：`chunk-6MWTY2OB.js`，命令无补全函数 ⇒ 直接 `null`，**不会**落到
   文件路径补全分支）。**RPC / print 模式的 `addAutocompleteProvider` 是空函数**（`rpc-mode.js`），factory 永不被调用 ⇒
   hub 托管 spawn 的 `pi --mode rpc` 会话拿不到第三方补全。
3. 因此补全来源分两层（agent 侧选源）：
   - **S-own（所有模式）**：本仓库命令。`wrapCommandApi` 的 `registerCommand` 代理（`src/web-hub/agent/command-capture.ts:446`）
     已在注册时拿到 `command` 对象，顺手把 `getArgumentCompletions` 记入与 `ownedNames` 同款「按引用共享」的 Map。
   - **S-tui（仅 `ctx.mode==="tui"`）**：透传 provider 捕获的 `current`，覆盖第三方（如 `/record`）、pi 内置、skill。
   - 都不可用 ⇒ 仅静态 usage/description（降级）。
4. **传输**：新增一对 agent↔hub 帧 `complete_req`/`complete_reply`（照 `run_tx_req/run_tx_reply` 先例，
   `registry.request()` 按 rid 关联）+ 新 HTTP 路由 `POST /api/command/complete`（独立限流/并发/审计，不进 `/api/cmd`
   的幂等账本）。**不**新增 `CmdOp`（避免污染 ledger/ctl/`CmdOp` 全部 switch）。PROTO 次版本 1.2→1.3，新 cap `cmd.args.v1`。
5. **静态提示**：`CommandInfoWire` 追加可选 `args?: { usage?: string; complete?: true }`（append-only，门控于 `cmd.args.v1`，
   因 `CommandInfoSchema` 是 `additionalProperties:false` 闭合 schema，旧 hub 会整帧丢弃）。usage 来源：toolkit 自有表 >
   pi 内置表 > 从 description 里启发式提取（`/name [a|b] <x>` 形态）。
6. **UI**：新组件 `CommandArgPalette.vue`（复用 `command-palette` CSS，不复用 `CommandPalette.vue` 的数据层）+ 纯逻辑
   `logic/cmdArgs.js`；Composer 增加「参数区（arg zone）」状态，与既有「名字区」面板互斥；latch 规则见 §6.4。
7. 全部由 `webHub.commandComplete`（`"all"|"toolkit"|"off"`，默认 `"all"`）门控；key 缺失 ⇒ hub/agent/UI 字节不变。

## 1. 现状与代码坐标（已核实）

| 事实                                                                                              | 坐标                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 命令名补全（UI）                                                                                  | `ui/src/components/control/Composer.vue`：`slash`(L161)、`paletteRows`(L389)、`paletteVisible`(L410)、`paletteKeydown`(L453)、`completeCommand`(L481)；`logic/control.js` `parseSlash`(L72)/`matchCommandRows`(L208)                                                                               |
| `parseSlash` 不区分 `/name` 与 `/name␠`（正则 `\s+` 吃掉空格，args 都是 `""`）                    | `logic/control.js:72`；**arg zone 需新 helper**                                                                                                                                                                                                                                                    |
| 现状：手敲 `/record␠` 后名字面板**仍显示**（query=record），仅 Tab/click 补全才 latch 隐藏        | `Composer.vue:421-429`                                                                                                                                                                                                                                                                             |
| `commands` 槽构造                                                                                 | `agent/slash.ts` `listSlashCommands`(L126)/`toCommandInfo`(L98)；`agent/index.ts` `publishCommands`(~L995)；schema `protocol/messages.ts` `CommandInfoWire`(L933)/`CommandInfoSchema`(L2027，闭合)                                                                                                 |
| 命令策略                                                                                          | `agent/command-policy.ts` `resolveCommandPolicy`(L222)；`PI_TOOLKIT_TABLE` 按**第一个 token** 子命令判定（`webhub` 的 `passwd                                                                                                                                                                      | 2fa | user` 为 deny、`mem` 写类为 confirm） |
| 本仓库补全函数现状                                                                                | `src/{memory/command.ts:102, goal/command.ts:122, cache-ttl/cache-ttl.ts:620, commands/webhub.ts:784, commands/status.ts:133, title/command.ts:155, topic-switch/command.ts:209, session-nav/index.ts:92}`；全是纯函数/静态表（`cache-ttl measure` 走 `measurement.completions`，需评审确认无 IO） |
| 补全语义：`value` **替换整个参数前缀**（pi-tui `applyCompletion`），多 token 补全须带已输入 token | 本仓库注释 `commands/webhub.ts:792-796`、`memory/command.ts:120`                                                                                                                                                                                                                                   |
| cmd 管线（幂等 LRU 2048/10min、ledger 512、16 在途、`pre` 30/s、`query` 桶 20/s）                 | `hub/commands.ts`、`hub/http.ts:2620 dispatchCmdOrDialog`、`:2441 limitCategoryFor`                                                                                                                                                                                                                |
| 先例：独立 GET 路由 + 自有 `CmdLimit` + 审计白名单                                                | `hub/file-search.ts`（`/api/files/search`，Composer 防抖 200ms + seq 守卫 + AbortController，`Composer.vue:224-300`）                                                                                                                                                                              |
| 先例：hub→agent 请求/应答帧                                                                       | `protocol/run-transcript.ts`（`run_tx_req/reply`）、`hub/registry.ts:490`、`agent/connection.ts:648 onRunTxReq`                                                                                                                                                                                    |
| 先例：agent 仅在 hello_ack 含 cap 时才发新字段                                                    | `TODO_ARCHIVE_HUB_CAP`（`protocol/version.ts`、`hub/hub.ts:696`、`hub/agent-server.ts:194`、`agent/index.ts:519`）                                                                                                                                                                                 |
| 无 key 缺失即关的先例                                                                             | `HubConfig.avatar/privacy/proxy`                                                                                                                                                                                                                                                                   |

## 2. 问题 1：能拿到谁的补全函数（核实结论）

pi 版本 1.3.0。核实点与结论：

- `ExtensionAPI.getCommands(): SlashCommandInfo[]` 无补全、无 `argumentHint`。RPC `get_commands`（`rpc-types.d.ts:138 RpcSlashCommand`）同样没有。
- 内部：interactive 的基础 provider 为每个扩展命令构造 `{name, description, getArgumentCompletions: cmd.getArgumentCompletions}`；builtin 带 `argumentHint`，且 `/model` 有内置补全（`createBaseAutocompleteProvider`）；skill = `skill:<name>`、prompt 模板有 `argumentHint` 但均**无**参数补全函数。
- `addAutocompleteProvider`：interactive 实现是 `wrappers.push(factory); setupAutocompleteProvider()`，而 `setupAutocompleteProvider` 每次都从 base 起**重放全部 wrapper**（所以 factory 会被**重复调用**，且在 /reload 时 wrappers 被清空 `autocompleteProviderWrappers=[]` 后由新激活重新注册）。
- 限制（写进文档，不做 workaround）：
  1. 经由「自己的 wrapper 层」而非 `getArgumentCompletions` 提供 slash 参数补全的第三方扩展，看不到（我们只拿到栈中位于我们之下的 provider）。
  2. RPC/print 模式无 S-tui；上游诉求：让 `ExtensionAPI` 暴露 `getCommands()` 返回 `getArgumentCompletions`（或在 rpc 模式也调用 factory）。**不做**反射/猴补 pi 内部（违背 I14 结构探测+fail-closed 原则）。
- 降级矩阵：

| 命令类别                                                                       | TUI 主会话                                      | RPC 托管 / print            |
| ------------------------------------------------------------------------------ | ----------------------------------------------- | --------------------------- |
| toolkit 自有                                                                   | 动态（S-own）+ usage 表                         | 动态（S-own）+ usage 表     |
| 第三方扩展                                                                     | 动态（S-tui，探测式）+ description 启发式 usage | 仅 description 启发式 usage |
| pi builtin（bridge 可执行的 `model/thinking/name/session/compact/new/reload`） | 静态 usage（内置表）                            | 同左                        |
| template / skill                                                               | 仅 description（可有 usage 启发式）             | 同左                        |
| deny 命令（含 `webCommandPolicy` 覆盖）                                        | 不提示、不补全                                  | 同左                        |

## 3. 问题 2：静态参数提示

### 3.1 wire（append-only）

```ts
// protocol/messages.ts
export interface CommandInfoWire {
  /* …existing… */
  /** cmd.args.v1：仅当 hello_ack.caps ∋ cmd.args.v1 时 agent 才发。 */
  args?: { usage?: string /* ≤120 chars，单行，已 sanitize */; complete?: true };
}
```

- `CommandInfoSchema` 追加 `args: Optional(Object({usage: Optional(String({maxLength:120})), complete: Optional(Literal(true))}, {additionalProperties:false}))`。
- `args` 出现 ⇒ 双端都支持（agent 要求 hub cap，hub 路由只在 `config.cmdArgs` 存在时构造），**UI 不需要额外 features token**：`row.args !== undefined` 即正向能力信号；老 agent / 老 hub ⇒ 字段永不出现 ⇒ UI 字节不变。
- `complete:true` 含义：agent 会尝试动态补全（S-own 命中；或 S-tui 可用且为 extension 命令）。S-tui 对第三方只能「探测」（不知道有没有补全函数）⇒ 乐观置 true，空结果是正常态。S-tui 就绪（首次捕获 `current`）时需 `publishCommands()` 重发。

### 3.2 usage 来源（`agent/command-usage.ts`，纯函数）

优先级：`TOOLKIT_USAGE[name]`（手写表：agent/mem/cache-ttl/goal/title/webhub/tasklist/task/watch/topic-switch/clear/…，值取自各命令已有 `USAGE` 常量/description）> `BUILTIN_USAGE`（复制 pi `BUILTIN_SLASH_COMMANDS` 的 `argumentHint`：model `<provider/model>`、thinking `<level>`、bug、login…；加一个**可选** conformance 测试深 import pi 的表比对，漂移只 WARN）> `usageFromDescription(name, description)`（正则：描述里第一个 `/<name>\s+([<\[][^\n]{1,100})` 之后的片段，必须含 `<…>`/`[…]`/`|`，否则不产出）。第三方无信息 ⇒ 不产出 usage（UI 回落到 description）。不「发明」用法。

## 4. 问题 3：动态补全通道

### 4.1 协议

- `protocol/messages.ts`：
  - `HubFrame` += `{ t:"complete_req"; rid:string; name:string; prefix:string; deadlineMs:number; origin:{listener:"loopback"|"lan"} }`（origin 仅用于策略不依赖，**不带 ip/user**；审计在 hub 侧）。
  - `AgentFrame` += `{ t:"complete_reply"; rid:string } & ( {ok:true; items:CompleteItemWire[]; truncated?:true; source:"own"|"tui"} | {ok:false; code:"E_UNKNOWN_COMMAND"|"E_COMMAND_DENIED"|"E_UNSUPPORTED"|"E_RATE"|"E_DEADLINE"|"E_BAD_REQUEST"; retryable:boolean} )`。
  - `CompleteItemWire = { value:string /*≤512B，整段参数替换文本*/; label:string /*≤120 字符*/; description?:string /*≤200*/; policy?:"confirm" }`（`policy` 仅在 confirm 时出现；deny 项永不上线）。
  - 闭合 schema（TypeBox）+ `AGENT_FRAME_SCHEMAS/HUB_FRAME_SCHEMAS` 注册表追加。
- `protocol/version.ts`：`PROTO` 1.2→**1.3**（先例：fleet F0 新帧 bump；`protoCompatible` 只比 major）；`CMD_ARGS_CAP = "cmd.args.v1"`、`CMD_ARGS_HUB_CAPS`/`CMD_ARGS_AGENT_CAPS`。**需核对 golden：** 全仓 grep `PROTO`/`minor` 的断言测试一并改。
- cap 流向：hub 仅当 `config.cmdArgs` 存在时把 cap 折进 `extraHubCaps`（`hub/hub.ts:696` 与 `hub/agent-server.ts:194` 两面保持同源）；agent 仅当设置非 off 且 `conn.caps ∋ cmd.args.v1`（活链路）才发 `args` 与回应 `complete_req`，并在 `capsExtra()` 里把 `cmd.args.v1` 加入 agent caps（`agent/index.ts:1235` 一带）；hub 路由要求 `registry.getCaps(agentKey) ∋ ["cmd.v1","command.v1","cmd.args.v1"]`，否则本地 `E_UNSUPPORTED`（**不发帧**）。

### 4.2 HTTP 路由 `POST /api/command/complete`（`hub/command-complete.ts`，仿 `file-search.ts` 结构）

- 请求：`{agentKey, name, prefix}`；JSON，`X-PWH:1`，**strictCsrf**（同 `/api/cmd`：CT=json、Origin 必须同源、Sec-Fetch-Site）；用 POST 而非 GET，避免 prefix 进 URL/反代日志。`name` 复用 `COMMAND_NAME_RE`；`prefix` ≤1 KiB 且无 `\r\n`/控制字符，否则 400 `E_BAD_REQUEST`。
- 鉴权：与 `/api/cmd` 同一 `authorize()`（loopback token / LAN 会话 + `touchSession`），LAN 与 loopback **同宽**（`webHub.commandComplete≠off` 即两面开）；`webCommands:false` ⇒ agent 不广告 `command.v1` ⇒ 本地 `E_UNSUPPORTED`。
- 限流（**独立 `CmdLimit` 实例**，§7-D14 纪律，不挤 cmd/upload/preview 桶）：每主体 `cpre` 20/1s、`complete` 桶 capacity 8 / refill 200ms；`lan-ip` 20/2s；`agent-complete:${agentKey}` 15/1s；hub 全局在途 ≤8、每主体在途 ≤3，超出 ⇒ 429 `E_RATE`（带 `Retry-After`）/503 `E_BUSY`。不进幂等 LRU/ledger（补全无幂等语义，也不应在 hub 内存留 10 分钟）。
- 预算：`createReqDeadline(now, 4_000)`；帧 `deadlineMs = min(remaining-300, 2_000)`；`registry.request<CompleteReplyFrame>(agentKey, frame, deadline+500)`。agent 离线/无 cap ⇒ 404/`E_UNSUPPORTED`。
- 审计（自有 `auditCommandComplete` 白名单，**仅**：`listener`、`name`、`plen`（prefix 字节长）、`hits`、`ms`、`code`、`source`；**绝不记 prefix 与 item 文本**）。`redactLogUrl` 不涉及（POST）。
- 响应：`{items, truncated?, source}`；`Cache-Control: no-store`；items 经 hub 二次裁剪（≤50 条/≤16 KiB，防御性，真正上限在 agent）。
- 接线：`http.ts` 在 loopback 与 LAN 两面各加一个分支（紧随 `fileSearch` 分支 `:1925/:3562`，LAN 的 `authorize` 段复制 `/api/cmd` 的 `LAN_AUTH_CAP_MS` 写法）；`hub.ts` 构造路由、`HubConfig.cmdArgs`（key 缺失=关）。

### 4.3 agent 侧 `agent/command-complete.ts`（pi-free 核心 + 端口）

```
createCommandComplete({
  commands: CommandsPort,               // pi.getCommands()
  own: () => ReadonlyMap<string, ArgCompleter>,   // wrapCommandApi 写入
  tui: () => AutocompleteProviderLike | undefined,// 透传 factory 捕获的 current
  policy: { overrides?: Record<string,CommandPolicy> },
  mode: "all" | "toolkit",
  now, setTimer
}) → { answer(frame): Promise<CompleteReply>, hasTui(): boolean, dispose() }
```

`answer` 流程（任何异常 ⇒ 回 `ok:false` 或空 items，**绝不抛、绝不悬挂**）：

1. 校验 `name`/`prefix`（同 hub，二次防御）；`classifyCommand` 未知 ⇒ `E_UNKNOWN_COMMAND`。
2. 基础策略：`resolveCommandPolicy({name,args:"",kind,overrides})`；`deny`（含 `webCommandPolicy` 覆盖）⇒ `E_COMMAND_DENIED`（**deny 命令不泄露补全**）。
3. 选源：`own.get(name)` → 否则 `kind==="extension" && mode==="all"` 且 `tui()` 可用 → 否则 `ok:true, items:[]`。template/skill/builtin ⇒ 空。
4. 并发：agent 全局在途 ≤2（超 ⇒ `E_RATE` retryable）；单次**硬超时 1500ms**（`Promise.race` + 迟到结果丢弃；S-tui 另传 `AbortSignal`，超时 abort）。补全函数异常 ⇒ `ok:true, items:[]`（不泄露异常文本）。
5. S-tui 调用 `current.getSuggestions([`/${name} ${prefix}`], 0, len, {signal, force:false})`；**只接受 `res.prefix === prefix`**（防底层 wrapper 走了文件路径等其它分支把目录列表漏出来），否则丢弃。
6. 归一化：只收 `{value,label,description}` 字符串字段；`sanitizeText`（复用 `command-capture.ts` 的 ANSI/控制符剥离，需导出）；`value` 不许以空白开头、不含换行；字节/条数裁剪（50 条、value 512B、label 120、desc 200、总 16 KiB，超出 `truncated:true`）；去重。
7. **逐项策略过滤**：对每个 item 以 `resolveCommandPolicy({name,args:item.value,…})`——`deny` 项**丢弃**（如 `/webhub` 的 `passwd|2fa|user`、`unlock`），`confirm` 项带 `policy:"confirm"`（UI 画 chip，与命令面板一致），`allow` 不带。
8. 返回 `source`。

### 4.4 S-own 捕获

`wrapCommandApi` 第三参数旁加 `argCompleters?: Map<string, ArgCompleter>`（与 `ownedNames` 同款：`src/index.ts:124-130` 创建一次并按引用传给两端；每次 `activate()` 新建，**无模块级状态**）。`registerCommand` 代理里 `if (typeof command.getArgumentCompletions === "function") argCompleters.set(name, command.getArgumentCompletions)`。**注意**：存的是原始函数（非 wrapped handler），调用时 try/catch+超时。评审清单：8 个本仓库补全函数确认无 IO（`cache-ttl measure` 的 `measurement.completions` 单独核）。

### 4.5 S-tui 捕获（`agent/index.ts`，仅 `x.mode==="tui"` 且设置 `all`）

在 attach/`session_start` 时：`ctx.ui.addAutocompleteProvider((current) => { tuiRef.current = current; onTuiReady(); return current; })`。要点：factory 会被重复调用（每次任一扩展加 wrapper 都重放）⇒ 幂等、只存最新；`onTuiReady` 仅首次 `false→true` 时 `publishCommands()`；`session_shutdown` 清空；不得返回新对象改变 TUI 行为（原样透传）。

### 4.6 与现有权限/安全的关系

- 补全函数可能读文件/有副作用 ⇒ 边界：
  1. S-own 全部为本仓库已评审纯函数；新增补全函数须过评审（AGENTS.md 增一条约束）。
  2. S-tui 执行第三方代码，等价于「本机用户在 TUI 里敲 `/cmd␠`」，由已认证的 web 主体远程触发。沿用 preview U1/U4 的已接受风险姿态（同一主体本就能 `prompt` 让模型跑 bash），但加：deny 命令不调用、独立限流、在途上限 2、1.5s 超时、结果大小上限、**设置可降级到 `toolkit` 或 `off`**。
  3. 不记录 prefix/结果（审计白名单）；`prefix` 可能含敏感参数（如 token），只在内存短暂存在；hub 不缓存。
- 与 `webCommandPolicy`：覆盖 deny ⇒ 整命令不补全；覆盖 allow/confirm 不改变「逐项 deny 仍丢弃」（只有 `resolveCommandPolicy` 的 override 会让整命令一刀切，这与执行路径完全一致）。
- 忙/闲：补全不看 busy（只读）；`policyBusy` 仍只影响执行。

## 5. 设置

`webHub.commandComplete`: `"all" | "toolkit" | "off"`，**默认 `"all"`**（见 §10 D1）；非 live（`/reload` 后 `/webhub restart`，因为影响 hub 配置与 cap）。落点：`src/config/settings.ts`（`WebHubSettings` + 解析 + 默认）、`src/config/setting-specs.ts`（TUI 设置编辑器）、`/webhub status` 一行 `cmd-complete: all|toolkit|off`（`agent/ui-status.ts` 风格，可选）。语义：`off` ⇒ 不广告 cap、不发 `args`、不注册 TUI wrapper、hub 不建路由；`toolkit` ⇒ 不注册 TUI wrapper，仅 S-own + usage；`all` ⇒ 全开。`HubConfig.cmdArgs` 仅当 `enabled ∧ control≠false ∧ webCommands≠false ∧ mode≠off` 才存在（`hub/main.ts` 重新校验，同 proxy/avatar 做法）。

## 6. 问题 4：UI

### 6.1 状态机（Composer）

新增纯函数 `logic/cmdArgs.js`：

- `argZone(text, caret)` → `{name, argStart, prefix} | undefined`：要求 `text` 以 `/` 开头且非 `//`，名字后跟**一个空格字符**（U+0020；tab 不算），`caret === text.length`（v1 只在光标位于末尾时补全，与 pi 的整段替换语义一致），单行（无 `\n`），`prefix` 字节 ≤1 KiB。
- `applyArgItem(name, item)` → `/${name} ${item.value}`；`item.value` 已保证无前导空白。
- `argKeyAction(ev, state)`、`parseCompleteResponse(body)`（客户端二次裁剪/类型校验，≤50 行）。
- 结果缓存：`Map<agentKey|name|prefix, {items,at}>`，30s TTL、≤64 项 LRU，仅用于回退（退格）瞬时显示，不作本地过滤（补全函数语义因命令而异，本地 `startsWith` 过滤会出错）。

`argActive = capPresent && argZone≠undefined && row(name) 存在 && row.policy≠deny && commandMode`；其中 `capPresent` = `commands` 槽中任一行带 `args`（正向信号）。`argActive` 时 **名字区面板隐藏**（`paletteOpen &&= !argActive`）——这同时修掉「手敲 `/record␠` 后名字面板赖着不走」；`capPresent=false` 时 `argActive` 恒 false，行为字节不变。

### 6.2 面板与内容

新组件 `CommandArgPalette.vue`（listbox，`role=listbox`、`aria-activedescendant` 由 Composer 持有，与 `CommandPalette` 同模型；复用 `.command-palette/.command-item` 样式类；**不用 `v-html`**）：

- 头部一行：`/name` + usage（`row.args.usage`，无则 `row.description`），始终显示（静态提示，零请求）。
- 列表：每行 `label`（粗）+ `description`（弱）+ confirm chip（仅 `policy:"confirm"`）；`value` 做 `title` 提示。
- 状态：**loading**（上一批 rows 保留并 `aria-busy`；无旧 rows 时延迟 250ms 显示「…」避免闪烁）；**empty**（仅头部 usage + 「无可用补全」弱提示；usage 也没有则面板不渲染）；**error/429/超时**（静默降级为头部 usage；`E_RATE` 按 `Retry-After` 暂停查询；`E_UNSUPPORTED`/`E_COMMAND_DENIED`/404 在该 agentKey+name 上本会话内不再查询）。
- 页脚提示：`Tab 补全 · ↑↓ 选择 · Esc 关闭`。

### 6.3 请求节奏

进入参数区或 Tab 应用后 **立即**（0ms，首问 prefix=""，兼作「发现」）；之后输入 **150ms 防抖**；每次新请求 `AbortController.abort()` 上一个并 `seq++`，过期响应丢弃（`file-mention` 同款 `seq` 守卫）；IME 组字期间不发（`composing` ref，`compositionend` 后补一次）；请求自身 3s 客户端超时；`fetch` 带 `X-PWH:1`、`credentials:same-origin`、POST JSON。离线 agent / 无 `agentKey` / `sendAsText` / `commandsEnabled=false` 不查。

### 6.4 键盘、IME、移动端与 latch

- 键位（焦点永远在 textarea，同名字面板）：`↑/↓/Shift+Tab` 移动高亮（wrap，复用 `moveMentionActive`）；`Tab` 应用高亮项（面板可见时即使无项也消费 Tab，防焦点逃逸，面板关闭则 Tab 原生）；`Esc` 关闭（**latch `argDismissed`**，任何后续输入变化即复位，同 `mentionDismissed`）；`Enter`：**仅当用户已显式用 ↑↓ 移动过高亮（`argNavigated` 置位）时应用高亮项**，否则不消费，沿用现有「Enter 执行当前命令」语义（见 §10 D2）；应用后保持参数区、`argNavigated` 复位、立即触发下一级查询（多层补全如 `keepalive ` → `keepalive on`）。
- IME：`ev.isComposing || keyCode===229 || composing.value` 一律不接管（与 `paletteKeydown` 一致）。
- 移动端（`pointer:coarse`）：无 Tab；点击行 = 应用（`@click` + `@mousedown.prevent` 防 textarea 失焦）；Enter 本就是换行；面板与名字面板同位置同滚动（max-height 240）。
- 与现有 latch 协调：名字区 `paletteSuppressed/completingName` 逻辑**不改**；`completeCommand(name)` 末尾因文本变为 `/name␠` 自然进入参数区并立即发首问（若 cap 在）；名字区 latch 仍保证 Tab 补全名字后名字面板不弹。`argActive` 与 `mentionOpen` 互斥（`@` 触发在行首，`/` 开头不会冲突，加断言测试）。
- 补全后文本、草稿持久化、`grow()`、光标置尾沿用 `completeCommand` 的同一 nextTick 流程（抽 `focusEnd()` 共享）。

### 6.5 i18n

`i18n/{zh,en}/control.ts` 追加：`argAria`、`argUsage`、`argLoading`、`argEmpty`、`argHint`（页脚）、`argConfirmChip`（复用 `control.policyConfirm` 即可，不新增）。遵循 AGENTS.md「紧凑标记仅英文 token」：`argHint` 属散文提示，zh 用中文。

## 7. 问题 5：新旧兼容矩阵

| hub \ agent                        | 新 agent                                                                                  | 旧 agent                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 新 hub（`cmdArgs` on）             | 全功能                                                                                    | 不发 `args`、不应答 `complete_req`；hub 路由 `getCaps` 缺 `cmd.args.v1` ⇒ 本地 `E_UNSUPPORTED`；UI 看不到 `args` ⇒ 字节不变 |
| 新 hub（`cmdArgs` off / key 缺失） | agent 见不到 hub cap ⇒ 不发 `args`                                                        | 同上                                                                                                                        |
| 旧 hub                             | agent 见不到 hub cap ⇒ **绝不发** `args`/新帧（旧 hub 闭合 schema 会整帧丢弃 `commands`） | 现状                                                                                                                        |

浏览器旧 UI + 新 hub/agent：忽略未知字段，名字面板行为不变。新 UI + 旧 agent：`row.args` 缺失 ⇒ `argActive=false`。PROTO 1.3 vs 1.2 互通（只比 major）。

## 8. 问题 6：测试计划

**protocol**（`tests/web-hub/protocol/`）：`CommandInfoSchema` 接受/拒绝 `args`（长度、额外键）；`complete_req/reply` 编解码、闭合 schema、`AGENT/HUB_FRAME_SCHEMAS` 完备；PROTO golden 更新；cap 常量。
**agent**（`tests/web-hub/agent/`）：

- `command-complete.test.ts`：选源优先级；未知/deny/覆盖 deny；逐项 deny 丢弃（`webhub` 的 `passwd`）、confirm 标注；超时（假定时器）；在途上限；异常隔离；迟到结果丢弃；`res.prefix` 不等丢弃（模拟底层 wrapper 返回路径补全）；sanitize/裁剪/去重/截断；dispose。
- `command-usage.test.ts`：表覆盖 + 启发式正例/反例 + builtin 表与 pi 表比对（深 import，漂移 WARN）。
- `command-capture.test.ts` 增：`registerCommand` 代理记录 `getArgumentCompletions`、无该字段不记录、`ownedNames` 行为不变。
- `slash.test.ts`/`capture-commands.test.ts` 增：cap 缺失 ⇒ `listSlashCommands` 输出**与现状逐字节一致**（golden）；cap 在 ⇒ `args` 正确。
- `connection.test.ts`：`complete_req` 仅 live 链路转发；无 `onCompleteReq` 静默忽略。
- `tui-provider-capture.test.ts`：factory 重复调用幂等、透传同一对象、`session_shutdown` 清理、`mode≠tui`/设置≠all 不注册。
  **hub**（`tests/web-hub/http|hub/`）：`command-complete-route.test.ts`——CSRF 拒绝、未鉴权无 fs/agent 触达、cap 缺失本地 `E_UNSUPPORTED` 且 **registry.request 未被调用**、限流（独立桶不影响 `/api/cmd` 桶）、在途上限、预算嵌套（deadline-nesting 套件追加）、审计行无 prefix/item、响应二次裁剪、LAN 与 loopback 同宽、`HubConfig.cmdArgs` 缺失 ⇒ 路由 404 且 caps 不含该项（`caps-coexist` 套件追加）；registry 对 `complete_reply` 的 rid/agentKey 校验。
  **UI**（`tests/web-hub/ui/`）：`cmd-args-logic.test.ts`（`argZone` 边界：`/a`、`/a␠`、`/a␠␠x`、`//`、tab、换行、caret 非末尾、>1KiB；`applyArgItem`；`parseCompleteResponse` 裁剪）；`command-arg-palette.test.ts`（渲染态：loading/empty/error/confirm chip、aria、无 `v-html`）；`composer-args.test.ts`（Tab/↑↓/Shift+Tab/Esc/Enter 显式导航规则、IME 不接管、`argDismissed` 复位、seq 过期丢弃、防抖与 abort、cap 缺失字节不变快照、与 `completeCommand` latch 协调、`mentionOpen` 互斥、deny/`sendAsText`/`commandsEnabled=false` 不查询、E_RATE 暂停）；`detail-dock` 路由不受影响。
  **集成**（`tests/integration/web-hub-command-complete.test.ts`）：真 hub 子进程 × fake-pi agent：端到端补全、deny 项被过滤、老 agent 无 cap、hub 重启后重连能力恢复。
  **conformance**（`tests/conformance/`，pi peer bump 前必跑）：真 pi TUI 模式下 `addAutocompleteProvider` factory 被调用、`current.getSuggestions(["/mcp "],…)` 返回 `/mcp` 的补全且 `prefix` 相等（用 pi 内置 `/mcp` 作探针）；rpc 模式 factory **未**被调用（断言降级假设）；pi 升级若改变任一假设，测试失败并提示 §2 限制需复核。**手动真机**（tmux，见 memory live-acceptance）：浏览器输入 `/cache-ttl␠`、`/webhub␠`（不见 `passwd`）、`/record␠`（TUI 主会话）、移动端点选、中文输入法。

## 9. 拆包、规模、风险

| 包               | 内容                                                                                                                                                                                                                                                       | 文件域（互不重叠）                                              | 规模(LOC 含测试) | 依赖                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------- | ------------------------------------------------------------ |
| **P0 协议冻结**  | messages.ts 类型+schema、version.ts cap/PROTO、settings+specs、`http-contract.ts` 错误码、`ui/logic/contract.js` API 常量                                                                                                                                  | `protocol/*`、`config/settings*.ts`、`ui/src/logic/contract.js` | ~250             | 无（先行，冻结接口）                                         |
| **P1 agent**     | `command-complete.ts`、`command-usage.ts`、`command-capture.ts`（argCompleters 捕获+导出 sanitize）、`slash.ts`（args 发射）、`connection.ts`（`onCompleteReq`）、`agent/index.ts`（接线、capsExtra、TUI provider、republish）、`src/index.ts`（Map 创建） | `src/web-hub/agent/*`、`src/index.ts`                           | ~1100            | P0                                                           |
| **P2 hub**       | `hub/command-complete.ts`、`registry.ts`（reply 分支）、`http.ts` 两面接线、`hub.ts`/`agent-server.ts`/`main.ts`（config+cap）、`audit.ts`                                                                                                                 | `src/web-hub/hub/*`                                             | ~1000            | P0                                                           |
| **P3 UI**        | `logic/cmdArgs.js`、`CommandArgPalette.vue`、`Composer.vue` 接线、i18n                                                                                                                                                                                     | `src/web-hub/ui/**`（不含 contract.js）                         | ~1300            | P0（类型/常量），与 P1/P2 **可并行**（UI 测试用 fake fetch） |
| **P4 集成/文档** | 集成+conformance 测试、AGENTS.md web-hub 段、`docs/dev/web-hub-slash-args/acceptance.md`、/webhub status 行                                                                                                                                                | tests/、docs/、AGENTS.md                                        | ~600             | P1–P3                                                        |

总计 ≈ 4.3k LOC（含测试约 60%）。P0 → (P1 ∥ P2 ∥ P3) → P4；每包返回即派 verifier（验收模型 ≠ 开发模型）。UI 包涉及 Vue 前端，按 dev-flow 走「前端开发」模型位。

**风险**

1. S-tui 依赖 pi 公开但冷门的 `addAutocompleteProvider` 重放语义 → conformance 守护；失败则 `complete` 位自动不亮（`hasTui()` false），仅降级为静态提示。
2. 第三方补全函数慢/有副作用/卡死 → 1.5s 硬超时 + 在途 2 + 迟到丢弃；但**无法取消**其内部工作（`getArgumentCompletions` 无 signal），残余风险接受并在设置里可降到 `toolkit/off`。
3. `commands` 槽新增字段触发旧 hub 闭合 schema 丢帧 → 只在 hub cap 到位时发（§7 矩阵，专测）。
4. 名字面板在参数区隐藏是行为变更（修 bug 性质）；仅 `capPresent` 时生效，快照测试守住 off 状态字节不变。
5. 补全 `value` 整段替换语义被个别第三方误用（只返回尾部 token）→ UI 照 pi 语义整段替换，行为与 TUI 一致；不做猜测性修复。
6. prefix 含敏感参数 → 仅内存、审计白名单、POST。
7. PROTO 1.3 bump 触发 golden/测试连锁更新 → P0 内一次性处理。

## 10. 明确不做（v1）

- 光标不在末尾 / 多行参数 / `//` 转义文本的补全。
- RPC 托管/print 会话的第三方补全（等上游暴露；不做反射）。
- builtin `/model`（已有 ModelSwitcher）、`/thinking <level>` 动态候选（v1.1，可由 agent 内置表给出，当前仅静态 usage）。
- skill / prompt 模板的参数提示（pi 未暴露 `argumentHint`，仅 description）。
- 经第三方自有 autocomplete wrapper 层提供的补全。
- 文件路径参数补全（`@` 文件区已有；参数里的路径不接）。
- 本地（前端）对结果再过滤/排序；hub 侧缓存；Feishu bot 卡片内的补全。
- 为补全新增 `CmdOp`、复用 `/api/cmd` 幂等账本。

## 11. 需用户拍板（推荐在前）

- **D1 默认设置**：`webHub.commandComplete` 默认 `"all"`（含对第三方命令触发 S-tui，覆盖你截图里的 `/record`）(Recommended) / `"toolkit"`（只本仓库命令，第三方仅 description）/ 默认 `off`。
- **D2 Enter 语义**：仅当用户已用 ↑↓ 显式选择过才「Enter 应用候选」，否则 Enter 仍是发送/执行（Recommended）/ 面板可见时 Enter 总是应用候选（与 pi TUI 一致，但会改变现有名字面板「Enter 执行」习惯）。
- **D3 RPC 托管会话的第三方补全**：接受降级 + 另起上游需求（pi 暴露 `getCommands()` 的补全或 rpc 模式也调 factory）(Recommended) / 对 pi 内部做反射获取（不建议，违背 fail-closed 兼容策略）。
- **D4 传输形态**：新帧对 + 独立路由，PROTO 1.2→1.3 (Recommended) / 复用 `cmd` 通道新增 `CmdOp:"complete"`（免 bump，但污染 ledger/ctl/CmdOp 各处 switch 并占用 16 在途账本）。
- **D5 usage 启发式**：从第三方 description 里提取 `[..]/<..>` 形态作为 usage 提示 (Recommended，低危害、可误判时无提示) / 仅用手写表+builtin 表。
- **D6 TUI 与 web 同时输入时**：不做互斥（补全只读）(Recommended) / 若 TUI 正在 `ui.custom` 弹窗则暂停 S-tui（需额外探测，复杂度高，不建议）。

## §11 拍板结果（用户，2026-10-21）

- D1：`webHub.commandComplete` 默认 **`"all"`**（含第三方命令，经 S-tui）。
- D2：仅当用户已用 ↑↓ 显式选过候选时 Enter 应用候选，否则 Enter 仍是发送/执行。
- D3–D6：**全部按推荐**（RPC 托管会话第三方补全接受降级并另提上游需求；新帧对 + 独立路由、PROTO 1.2→1.3；从 description 提取 `[..]/<..>` 作 usage；TUI 与 web 不互斥）。

## r1 评审处置（glm，有条件通过，2026-10-21；全文 `review-r1.md`）——优先于正文

- **#1 Major（commands slot 首发时序）采纳三件套**：① commands 帧构建不依赖 caps；② slot flush 前按**当前** hub caps 剥离 `args`（slot 存帧 + 可选 transform）；③ hello_ack / caps 变化（含重连、hub 降级）时 republish。补测试：hello_ack 晚于首发 ⇒ 最终帧带 args；无 cap 的 hub flush 帧不含 args。
- **#2 Major（PROTO bump）采纳：不 bump**。新帧对 + cap `cmd.args.v1` 门控即可（遵循 version.ts 现行「只加帧不改」惯例，fsb/lan/tfa 先例）。**这修订了 §11 D4 的推荐项**（用户按推荐选了「新帧对 + 独立路由」——帧对与独立路由保留，仅撤回 1.2→1.3 bump）。PROTO 断言测试不动。
- #3 usage 上限放宽到 200 字符，末尾空白处回退截断加 `…`，手写表单测断言不超限，UI ellipsis + title 全文。
- #4 风险段单列「第三方补全函数**同步**死循环会挂死整个会话进程，超时/在途/限流均无效」，并在设置描述如实标注（默认仍 `all`，用户已拍板）。
- #5 任何非导航键输入即复位 `argNavigated`（同 `argDismissed`），补 composer 测试。
- #6 res-close：释放在途计数，审计 `code:"aborted"`，可提前 settle pending。
- #7 #8 #9 文字修正照建议。

### 与 fabric 二期的文件冲突与顺序（主会话裁定）

本方案 P0（`protocol/*`）与 fabric XS0 同改 `protocol/messages.ts`；P1（`agent/connection.ts`、`agent/index.ts`、`src/index.ts`）与 fabric X2/XW、P2（`hub/{registry,agent-server,hub,main,audit}.ts`）与 fabric X1 重叠。顺序：**fabric XS0 合入 → 本方案 P0 → (P1 ∥ P2 ∥ P3) 合入 → fabric X1/X2**；fabric R1/T1/X3 文件不重叠，可与本方案 P1–P3 并行。
