# web-hub 命令历史 P0 — 协议冻结包 · 实施报告

> 2026-10-24 · 方案 `docs/dev/web-hub-cmd-history/plan.md` v2（§4.1/§4.5/§4.6、§8.1 P0 行、§8.2 冻结面 F1/F3/F4、§8.3 协议测试）。
> 文件域（越界零项）：`src/web-hub/protocol/{cmd-record.ts(新),keys.ts,messages.ts,version.ts}`；`tests/web-hub/protocol/{keys.test.ts,cmd-record.test.ts(新),messages.test.ts,messages-cmd.test.ts}`。

## 改动清单

| 文件                                          | 新/改 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/web-hub/protocol/cmd-record.ts`          | 新    | `CMD_RECORD_ENTRY_TYPE`（`"subagent:cmd"`）、`CMD_RECORD_VERSION`、`CmdRecordSource/State/Notice` 枚举、`CmdRecordData` v1（§4.1 完整字段：cmdId/phase/name/args/source/startedAt + end 侧 endedAt/state/output/notice/error；output 复用 `CommandOutputWire` 原样，零改动）、`CmdRecordWire`（= Data 的投影别名）、`sanitizeCmdRecord()`（§4.5：确定性纯函数、按不可信输入再校验，结构+大小失败 ⇒ `undefined` ⇒ 纯墓碑）、边界常量（cmdId/name 正则、args/error ≤512、输出预算 8 KiB/条 · 32 KiB/64 条 · key 64 · title 200、`CMD_HISTORY_RUNNING_MAX=16`） |
| `src/web-hub/protocol/keys.ts`                | 改    | `projectSessionEntry` 的 `custom` 分支在 tool-timing 之后、fabric 之前新增 `subagent:cmd` 分支：保持 `display:false` 墓碑 + `dataKey = customKey(customType, r.data)`（对**完整 raw data**，对账语义不变）+ 可选 `cmd`（sanitize 失败则缺省）                                                                                                                                                                                                                                                                                                                |
| `src/web-hub/protocol/messages.ts`            | 改    | ① `WireEntry.cmd?: CmdRecordWire`（timing 先例，纯类型，开放 schema 不动）；② `StatusInfo.cmdRunning?: string[]`（≤16、最新优先、非空才出现）；③ `CmdData` 的 `command` 变体加 `history?: "recorded" \| "none"`——同一 `CmdResultBody.data` 形状天然覆盖同步回复与 `cmd_late` late 通道（m2）；④ `CMD_HISTORY_FEATURE_V1 = "cmd.history.v1"`（`StatusInfo.features` 令牌，注释钉顺序 `[resume.v1?, cmd.history.v1?]`）                                                                                                                                        |
| `src/web-hub/protocol/version.ts`             | 改    | `CMD_HISTORY_HUB_CAP` / `CMD_HISTORY_HUB_CAPS`（`"cmd.history.v1"`；P0 仅常量、**惰性**——无人 fold 进任何 caps 数组，H1 接线；无新帧 ⇒ 无 PROTO bump，只加不改）                                                                                                                                                                                                                                                                                                                                                                                             |
| `tests/web-hub/protocol/cmd-record.test.ts`   | 新    | 常量钉；合法 start/end 往返、未知字段丢弃、确定性；29 例结构违规矩阵（v:2、坏 cmdId/name/枚举、超长 args/error、非有限时间、坏 output 形状…）⇒ `undefined`；输出预算再套（65⇒64+truncated、9 KiB 单条 clip+`…`+`clipped`、多字节不劈 UTF-8、6×7 KiB ⇒ 留前 4 丢 2 计字节、未知 kind/坏 level/非字符串 text 丢弃计数、`truncated` 累加合并、key/title 切片、`clipped` 保留、`needsTerminal` 仅 `===true` 保留）；Q1 原文不改（`?token=`/`--take=` 原样、读侧**不**重洗 ANSI、args/error 原样）                                                                |
| `tests/web-hub/protocol/keys.test.ts`         | 改    | 新 describe「projectSessionEntry — subagent:cmd」：合法 start/end 精确投影（含 dataKey 断言、不带 timing）；非法（v:2/坏 cmdId）⇒ 纯墓碑且 dataKey 仍对完整 raw data；未知字段改 dataKey 不改 `cmd`（钉 dataKey=完整 data）；键序无关（canonical json，hub/agent 同输出）；65 条输出在投影内再预算；entryKey=dataKey + diffAppended 多重集（两条同 data 都 append、已投递一条只 append 另一条）；其余条目形状永不携带 `cmd`                                                                                                                                  |
| `tests/web-hub/protocol/messages.test.ts`     | 改    | 新 describe「cmd-history P0 open fields on unchanged schemas」：带 `features:[resume.v1, cmd.history.v1]` + `cmdRunning` 的 status 帧、带 `WireEntry.cmd` 的 branch_reply 帧经**未改动**的现行 schema 逐字解码通过；不带新字段的 status 帧原样解码（旧形状逐字节等价）；`CMD_HISTORY_FEATURE_V1 === CMD_HISTORY_HUB_CAP`（UI 双面门控钉）+ CAPS 数组内容                                                                                                                                                                                                     |
| `tests/web-hub/protocol/messages-cmd.test.ts` | 改    | `data.history` 在 `cmd_result`（sync）与 `cmd_late`（late 通道，m2）均逐字解码；无 `history` 的旧 agent 形状照常解码（缺失视同 none 的前提钉）                                                                                                                                                                                                                                                                                                                                                                                                               |

## 冻结面落点（§8.2）

- **F1** `subagent:cmd` 条目 v1 → `cmd-record.ts` 全量（`v:1` 字面量钉死；读方容忍未知字段；`v!==1` ⇒ 墓碑）。
- **F3** 投影形状 → `keys.ts` 分支：墓碑 + `cmd`，`dataKey` 对完整 data（对账/去重语义与既有 custom 完全一致）。
- **F4** → `version.ts` `CMD_HISTORY_HUB_CAP(S)`（hub 双面静态声明，H1 fold）+ `messages.ts` `StatusInfo.cmdRunning`、`CmdData.history`（经 `CmdResultBody` 同时覆盖同步与 late 通道）。
- **未动**：`CommandOutputWire`/`CommandOutputEntry`/`CommandArgsSchema`/任何 typebox schema（开放字段走 `additionalProperties:true` 的既有开放面，timing/features 先例）、PROTO（1.2 不变，version.test.ts 全绿）、三个 fabric off golden、`tests/fixtures/web-hub-ui/keepalive-legacy-golden.json`、`tests/fixtures/legacy-xs-v071/`、共享 fixture `tests/fixtures/web-hub/session-sample.jsonl`（投影测试全部内联构造，fixture 零改动）。
- 依赖方向：`cmd-record.ts → messages.ts` 仅 **type-only**（`CommandOutputWire`），`messages.ts → cmd-record.ts` 亦 type-only ⇒ 无运行时环；`keys.ts → cmd-record.ts` 单向运行时导入。protocol 不 import agent（输出预算常量镜像自 capture 引擎数值，双向测试钉死）。

## 自验（真实输出尾部）

`npx vitest run tests/web-hub/protocol --maxWorkers=3`：

```
 Test Files  46 passed (46)
      Tests  1695 passed | 3 skipped (1698)
   Start at  16:37:55
   Duration  5.08s (transform 1.13s, setup 613ms, collect 4.03s, tests 2.24s, environment 1ms)
```

`npm run typecheck`（两个 tsconfig + vue-tsc）：

```
> pi-toolkit@0.8.0 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

（退出码 0，无任何输出错误）

`npx prettier --check`（全部 8 个改动文件）：

```
Checking formatting...
All matched files use Prettier code style!
```

off golden 相关测试（grep `fabric-*-off-golden` 命中的全部可本地运行测试；golden 文件零改动）：

```
 ✓ tests/tools/message-session-tool.test.ts (17 tests) 14ms
 ✓ tests/integration/fabric-xs-reply-off-golden.test.ts (2 tests) 33ms
 ✓ tests/integration/fabric-xs-off-golden.test.ts (2 tests) 60ms
 ✓ tests/integration/fabric-xs-channel-compat.test.ts (1 test) 104ms
 ✓ tests/tools/message-agent-wake.test.ts (8 tests) 12ms
 ✓ tests/integration/fabric-wake-off-golden.test.ts (2 tests) 22ms

 Test Files  6 passed (6)
      Tests  32 passed (32)
```

（`tests/conformance/fabric-wake.test.ts` 同被 grep 命中，但属真 pi peer-bump 门（需真实 pi 二进制），本次改动未触碰 message_agent/fabric 任何 schema，未运行；peer bump 前按惯例与 consult-preserve 一并跑。）

## 遗留 / 说明

- P0 常量 `CMD_HISTORY_HUB_CAPS` 目前**惰性**（无任何 fold 点）——A1/H1 接线时由 hub `extraHubCaps` 静态声明、agent 经 `StatusInfo.features` 声明。
- `StatusInfo.cmdRunning` 与 `WireEntry.cmd` 按本包只加**类型**不动 schema（`WireEntrySchema`/`StatusInfoSchema` 保持开放，旧 hub 逐字转发）；已用解码测试钉「新字段被现行（旧）schema 接受」。
- sanitize 读侧不重洗 ANSI/控制字符（写侧职责，§4.1）；内容零改写，Q1 拍板与 M2 残留登记由方案 §5.3 承担。
- 工作区其它会话改动（`src/secure/**`、`tests/secure/**`、`docs/dev/data-encryption/**`、AGENTS.md、README*）未触碰；零 git 写操作。
