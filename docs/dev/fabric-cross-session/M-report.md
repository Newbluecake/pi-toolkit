# 包 M 交付报告：@mention 寻址会话（核心，不含装配）

## 改动文件清单（绝对路径）

**新建**

- `/home/bluecake/ai/pi-toolkit/src/fabric/xs/directory.ts` — §9.2 目录缓存（pi-free，注入数据源）
- `/home/bluecake/ai/pi-toolkit/src/mention/session.ts` — §9.1 语法/§9.3 路由/§9.5 插入值规则/§9.6 文案
- `/home/bluecake/ai/pi-toolkit/tests/fabric/xs-directory.test.ts`（13 tests）
- `/home/bluecake/ai/pi-toolkit/tests/mention/session.test.ts`（25 tests）
- `/home/bluecake/ai/pi-toolkit/tests/mention/autocomplete-session.test.ts`（9 tests）
- `/home/bluecake/ai/pi-toolkit/tests/mention/session-off.test.ts`（5 tests）
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/commands-mention-session.test.ts`（6 tests）

**修改**（diff 均为加法，冻结面未动：`parseMention` 签名与行为、protocol/_、settings.ts、stack.ts、index.ts、fabric/xs/_ 既有文件、web-hub/hub/*、golden 全部原样）

- `/home/bluecake/ai/pi-toolkit/src/mention/mention.ts` — `MentionRouteDeps` 增可选 `sessions?`/`notifySession?`；`MentionRouteResult` 并入 session 分支；`installMentionInput` 内部接线两类通知消息
- `/home/bluecake/ai/pi-toolkit/src/mention/autocomplete.ts` — `MentionAutocompleteSource` 增可选 `sessions?()`/`sessionBareName?`（**工厂签名 2 参不变**，index.ts 无需改动即编译）
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/commands.ts` — 同步判定加 `safeParseSessionMention`，`MentionResultData` 映射 `action:"session"` 变体（RX0 冻结的 wire），catch 路径 label 兼容两分支

## 导出 API 与注入端口签名（MW 装配用）

```ts
// src/fabric/xs/directory.ts
type XsDirectoryRow = XsSessionRowWire;   // protocol/xs.js 的 list 行
interface XsDirectorySourcePort {         // MW 注入：membership 视图 + hub list
  view(): { key: string } | undefined;    // undefined⇔未join；key 变化（epoch/leave//new）⇒清空
  fetch(): Promise<readonly XsDirectoryRow[] | undefined>;  // 任何失败⇒undefined⇒保留旧数据
}
interface XsDirectoryCache {
  rows(): readonly XsDirectoryRow[];                        // 过期(>10min)/未join/已清空 ⇒ []
  lookupExact(name: string): XsDirectoryRow | undefined;    // name∪ref 唯一精确命中
  refresh(reason: string): Promise<void>;                   // single-flight·≥30s·3s 截止·不抛
  ingest(rows: readonly XsDirectoryRow[]): void;            // 外带数据直装（可接 list_sessions 工具）
  dispose(): void;
}
function createXsDirectoryCache(deps: {
  source: XsDirectorySourcePort; now(): number;
  refreshMinIntervalMs?: number; fetchDeadlineMs?: number; staleMs?: number;
}): XsDirectoryCache;   // 默认 30_000 / 3_000 / 600_000（常量已导出）

// src/mention/session.ts
function bareNameFileConflict(cwd: string, name: string): boolean;   // 仅 lstat undefined=false
function parseSessionMention(text, deps: { isLabel(name): boolean; cwd(): string;
  lookupExact(name): XsDirectoryRow | undefined }): ParsedSessionMention | undefined;
// ParsedSessionMention = { form:"explicit"|"bare"; target; message; label }
//   bare 的 target = 命中行的 ref（避免 parse→send 间改名竞态）；explicit 的 target = 操作数原样
interface MentionSessionPort {
  parse(text: string): ParsedSessionMention | undefined;   // 同步；未join/未连接⇒undefined
  send(target: string, message: string, options?: { expectReply?: boolean }):
    Promise<MentionSessionSendOutcome>;                    // 默认 expectReply:true
}
// MentionSessionSendOutcome = { status:"sent"|"no_target"|"ambiguous"|"reply_unsupported"|
//   "reply_quota"|"error"; effect:XsEffect; reason?; requestId?; replyDueAt?(epoch-ms);
//   pendingReplies?; to?:{ref;name?} }
function createMentionSessionPort(deps: {
  joined(): boolean;                                        // live 查（join/连接状态）
  isLabel(name): boolean; cwd(): string;                    // 复用 §9.1 三静态条件
  lookupExact(name): XsDirectoryRow | undefined;            // = directory.lookupExact
  send(target, message, options?): Promise<MentionSessionSendOutcome>;  // MW 适配 RX4 sender
}): MentionSessionPort;
function safeParseSessionMention(port | undefined, text): ParsedSessionMention | undefined;
function sessionCompletionBare(deps, name): boolean;        // §9.5 插入值规则（补全用）
function routeSessionMention(text, deps: { sessions; notifySession; now? }): Promise<SessionMentionRouteResult>;
const SESSION_MENTION_ERROR_SOURCE = "mention-session";     // subagent:mention-error 的 details.source
const SESSION_MENTION_SENT_CUSTOM_TYPE = "subagent:mention-session";  // 成功确认（display-only，§9.4）
```

**MW 接线点**：①`stack.ts` 构建/处置 directory（source.view 的 key 建议 `${sessionId}#${epoch}`，fetch 由 sender.list 适配）；②`createMentionSessionPort` 注入 `index.ts:1034` 的 mentionRouteDeps（TUI 的 `installMentionInput` 已**内部**接线通知，勿再传 notifySession）与 `index.ts:1324` 的 web deps（web 的 notifySession 由 MW 传 `pi.sendMessage`）；③补全 source（`index.ts:929/1146`）加 `sessions: () => { void directory.refresh("complete"); return 投影(directory.rows()); }` + `sessionBareName: (n) => sessionCompletionBare(deps, n)`，投影为 `{ref, name?, cwdLabel, receive, busy}`。

## §9.1 优先级与代码对应

1. **subagent label 优先**：`mention.ts` `routeMention` 第一行仍先 `parseMention(text, deps.registry)`（一行未改），命中即走原 steer/resume 分支，session 分支不可达（测试「a registered subagent label wins over a same-named session」双端钉死）。
2. **显式形式**：`session.ts` `EXPLICIT_SESSION_MENTION_RE = /^@session:(\S+)[ \t]+(\S[\s\S]*)$/` 命中即拦截（不查 label/文件/缓存，测试含 `@session:foo/bar` 怪操作数）。
3. **裸形式四条件**：`parseSessionMention` 内依序 ①`BARE_SESSION_NAME_RE`（`^[A-Za-z0-9_-]{1,64}$`）→ ②`isLabel` → ③`bareNameFileConflict`（`lstatSync(resolve(cwd,x),{throwIfNoEntry:false})` 仅 `undefined` 算不存在，stat/抛错一律冲突放行；路由与补全共用）→ ④`lookupExact` 唯一精确命中（name∪ref，2 命中含交叉也算不唯一）。任一不满足 ⇒ `{handled:false}` 放行给 pi。
4. `reply_unsupported`（pre-send、effect none）⇒ 去 expectReply 重发一次并告知用户（`routeSessionMention`），成功文案注明「对方不支持回复关联」。

## off 三状态字节比对测试名（tests/mention/session-off.test.ts）

- `§9.7 off states — TUI parse/route byte-comparison vs the xs-off baseline > state ① xs off (port absent): identical bytes for every @ shape`
- `> state ② xs on but not joined: parse returns undefined ⇒ identical bytes to state ①`
- `> state ③ after leave: the SAME port flips joined→false and outputs return to baseline`（先验证 join 时确实拦截，再 leave 后 6 种 @ 形状 JSON.stringify 逐字节等于基线）
- `§9.7 off states — completion output byte-comparison > states ①②③ produce byte-identical completion output to the sessions-absent baseline`（含 live 对照组防「空比较」）
- `§9.7 off states — web prompt sync determination (native path) > states ①②③ all hand every @ shape to sendUserMessage verbatim`

## 自验输出（真实尾部）

```
$ npx vitest run tests/mention tests/fabric/xs-directory.test.ts tests/web-hub/agent/commands-mention-session.test.ts
 Test Files  8 passed (8)
      Tests  93 passed (93)

$ npx vitest run tests/web-hub/agent/commands*.test.ts --maxWorkers=2
 Test Files  5 passed (5)
      Tests  105 passed (105)
  （另加 command-{capture,complete,usage,policy,policy-fabric} 全家族：9 files / 212 tests 全过）

$ npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
（无输出=通过；并行包 RX1/RX3 的未跟踪文件当前也一致通过）

$ npx prettier --check <10 个改动/新建文件>
All matched files use Prettier code style!

$ npx vitest run tests/integration/fabric-xs-off-golden.test.ts   （§8.4 附加核验）
 Test Files  1 passed (2)
      Tests  2 passed (2)
```

## 未决事项 / 决策备注

1. **MW 装配**（见上）：本包未接线任何真实 sender/directory；`refresh(reason)` 的 reason 目前仅保留接口位（§9.2 冻结签名），未做观测用途。
2. **裸形式 target 取命中行的 ref**（方案未明说）：缓存已证明名字指代哪场会话，发 ref 消除 parse→send 间改绑竞态；方案语义（hub resolve）不变。
3. `MentionSessionAutocompleteEntry.receive` 为展示字符串；wire 上只有 `"deliver"|"wake"`（RX2 的 hub list 会滤掉 replies 模式会话，§5.3）。
4. 集成测试 `fabric-xs-mention.test.ts`（§12.2-10：真实往返/level 0/display 回复不触发轮次）属 RXW/MW 阶段，本包不做。
5. web 路径与既有 subagent 分支共享同一理论竞态形状：同步判定命中后 `routeMention` 若异步返回 `{handled:false}`（同一 tick 内不可发生——两侧 parse 均无 await），frame 走既有 unobserved 兜底，非本包引入。
6. `npm test` 全量未跑（任务纪律限定定向测试）；已额外核验 mention 模块的唯一其他消费方 `tests/integration/load-producer-matrix.test.ts` 通过。
