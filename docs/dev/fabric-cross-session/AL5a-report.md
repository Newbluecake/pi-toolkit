# AL5a 报告：发送端与工具（alias-plan r4）

## 寻址流程（`sender.message`）

1. 本地形式拒绝 / channel 门 / reply 分支与原来一致。
2. `port.resolve({query: to})`（`to` 原样，不剥 `@`、不规范化；规范化是 hub 的事）。
3. `aliasMode = port.aliasUsable?.() === true`：
   - resolve 必须带 `target.sessionId`，否则本地 `error{none, reason:no_session_id}`，不发 send；
   - `sendTo = 完整 sessionId`（与 reply 分支同一机制；线上无新字段，hub 按已协商 cap 做 exact-only，AL2 负责）。
4. send 阶段 `E_XS_NO_TARGET` 且 hub 无 reason ⇒ `no_target{none, reason:"changed"}`（目标变化）。
5. `E_XS_ALIAS_UNAVAILABLE`（degraded 守卫）⇒ 新 status `alias_unavailable`，effect none（加入 PROVABLE_NONE）。
6. 结果 `to` 增加可选 `alias`（hub 只对 aliasUsable 请求方写出；无 alias 时输出字节不变）；sessionId 从不进入模型可见结果。

- NQ2：别名存在但不可达 ⇒ hub 回 NO_TARGET，sender 原样透传，无任何名字回落。
- `aliasUsable` 缺省/false ⇒ 帧里 `to` 仍是原始串，输出与改动前逐字节一致（测试覆盖）。

## 工具实例与描述

- 参数 schema **没有新实例**：别名经现有 `query`/`to` 字符串走，故 alias 版与同模式（channels / reply）实例是**同一个 schema 对象**，只有 description 追加（list：「alias is a human-assigned…」；message：「pass that word verbatim as `to`… never guess」）。legacy 实例与三份 off golden 不变且通过。
- 选择方式（供 ALW）：`createListSessionsTool({sender, channels, alias})`、`createMessageSessionTool({sender, reply, alias})`，`alias` = `alias.enabled ∧ hub 已声明 xs.alias.v1`，activate 时冻结；省略/false ⇒ 旧工具。若 ALW 希望 hub cap 晚到也稳定，应按「本端 alias.enabled」冻结而非按 hub cap（description 一旦变就破坏 provider 缓存前缀）——这是 ALW 的取舍，工具本身只看布尔。
- list 行：`<ref> · alias="前端" · name=… · cwd=…`（有 alias 才出现，JSON 编码）；排序/query 前缀匹配在 hub（AL2）。
- `message_session` 在 `alias:true` 时对 `alias_unavailable` 追加「hub 别名服务暂不可用，请用 list_sessions 给出的 ref」。

## 端口需求（ALW / AL5b）

- `XsHubPort.aliasUsable?(): boolean`（新增，可选）：= 本端 `alias.enabled` ∧ live hub 声明 `xs.alias.v1`（与 agent hello cap 同源，对称）。ALW 在 `src/stack.ts` 的 port 适配器里实现；未实现 ⇒ 旧行为。
- ALW 的 port.resolve/send 适配须把 `target.alias`、`rows[].alias`、新错误码原样透传（outcome 的 `to.alias` 依赖此）。
- AL5b 的 mention 拦截后继续调用 `sender.message({to})`，无需新入口。

## 偏离

- 方案 §6 说「list_sessions 按 (channels×alias) 选实例」；因 schema 无差异，实现为同一 schema 对象 + 描述差异，没有新增 frozen schema 常量。
- 「目标变化」用 `reason:"changed"` 表达（status 仍 `no_target`）。

## 改动文件

- /home/bluecake/ai/pi-toolkit/src/fabric/xs/sender.ts
- /home/bluecake/ai/pi-toolkit/src/tools/list-sessions-tool.ts
- /home/bluecake/ai/pi-toolkit/src/tools/message-session-tool.ts
- /home/bluecake/ai/pi-toolkit/tests/fabric/xs-sender-alias.test.ts（新）
- /home/bluecake/ai/pi-toolkit/docs/dev/fabric-cross-session/AL5a-report.md

## 自验

- `npx vitest run tests/fabric tests/tools tests/integration/fabric-xs*.test.ts --maxWorkers=3`：83 files / 1371 passed。
- `npm run typecheck`：通过。
- `npx prettier --check <改动文件>`：见下。
