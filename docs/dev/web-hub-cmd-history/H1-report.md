# web-hub 命令历史 H1 — hub 侧包 · 实施报告

> 2026-10-24 · 方案 `docs/dev/web-hub-cmd-history/plan.md` v2（§4.6 cap、§4.10 runTail 回落（M4 规格）、§8.1 H1 行、§8.2 冻结面 F4、§8.3 H1 测试）。P0（e33b984f）已就位；本包为并行 A1/H1/U1 中的 H1。
> 文件域：`src/web-hub/hub/{hub.ts,history.ts}`；`tests/web-hub/hub/{history*.test.ts,caps-coexist.test.ts}` + `history-`/`cmd-history-` 前缀新测试。**A1 / U1 文件零触碰**（`src/web-hub/agent/**`、`src/web-hub/ui/**`、`src/index.ts`、`src/secure/**`、`src/config/**` 均为并行包在途改动，未读不写）。**零 git 写操作**。

## 改动清单

| 文件                                            | 新/改                    | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/hub/hub.ts`                        | 改                       | `extraHubCaps` 尾部无条件加入 `CMD_HISTORY_HUB_CAPS`（§4.6：新 hub 静态声明，无设置门——P0 投影与 §4.10 回落随每个 hub 构建生效，agent 侧同名 `StatusInfo.features` 令牌才是功能门）；两面（`HubInfo.caps` / `hello_ack.caps`）同源数组展开，落点紧跟 CMD_ARGS 之后、`version.v1` 之前                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/web-hub/hub/history.ts`                    | 改                       | ① 新常量 `RUNTAIL_BRANCH_FALLBACK_BYTES = 256 KiB`（§4.10 预算，比 `loadBranch` 的 2 MiB 紧——只 diff 尾 64 条且回落窗口内分支很小）；② 新内部函数 `readTailFromAgent`：`registry.request(branch_req{maxBytes: 256 KiB}, TIMING.snapshotMs)`（registry 内计时器 unref），按 pending leaf `findIndex` 截断（同 `loadBranch`；**leaf 不在回复 ⇒ 视同读失败返回 undefined，等下一次 leaf 变化**，绝不对未对齐分支 diff），出错/超时 `log.info`（仅 agentKey + error 字符串，**无条目/输出内容**）后吞掉、永不抛进 `runTail`；③ `runTail`：`readBranch` 失败且 reason===`ENOENT` 时走回落，TOO_LARGE/PARSE/LEAF_NOT_FOUND 维持原「下次 leaf 变化重试」早退；`--no-session`（`file===undefined`）保持既有早退**不纳入**；回落 await 后仍过 `st.delivered`/会话一致性守卫；沿用 `st.reading` 单飞、500 ms debounce 与 `APPEND_TAIL_ENTRIES` 尾窗 |
| `tests/web-hub/hub/cmd-history-runtail.test.ts` | 新                       | 9 例回落矩阵：持久化路径+无文件 ⇒ `branch_req`（**maxBytes 256 KiB 钉**）+ 按 leaf 截断（回复中 leaf 之后的条目不推）+ 仅新条目 append；`subagent:cmd` 投影条目原样透传；leaf 缺失 ⇒ 不推送不脏 baseline、下次 leaf 变化恢复；`--no-session` ⇒ 零 `branch_req` 零 append（M4 排除钉）；文件中途消失（ENOENT）⇒ 回落照常；TOO_LARGE（稀疏 truncate 256 MiB+1）/PARSE/LEAF_NOT_FOUND ⇒ 零 `branch_req`（ENOENT-only 钉）；agent 永不回 ⇒ `TIMING.snapshotMs` 内 `E_DEADLINE`、`log.info` 一条、无 append 不抛、**状态机不楔死**（下一 leaf 变化照常 append）；日志卫生（成功与失败路径的 hub.log 均无输出正文，以 secret 探针串断言）；超尾窗（>64 条）只 diff 新条目                                                                                                                                                                       |
| `tests/web-hub/hub/cmd-history-hub.test.ts`     | 新                       | **m8② 56c71cae 回归钉**（§8.3）：同一 registry 总线上，被推迟的扩展命令答 `completion:"unknown"` 且永无 `cmd_late` ⇒ 在记录写入驱动的 ENOENT 回落 append + status churn 之中，hub 账本条目保持 56c71cae 后语义——`done`、缓存体与 agent 回答逐字相等、后续 queryOnly 命中缓存**零新 cmd 帧**；另一例钉 `completion:"async"` 在同样 churn 下仍经 `cmd_late` 升级出完整 output                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tests/web-hub/hub/caps-coexist.test.ts`        | 改                       | 默认配置用例的无条件 cap 循环加入 `CMD_HISTORY_HUB_CAPS`（两面 set-equal 断言既有关，新 cap 被既有 `browserCaps ≡ agentCaps` 覆盖）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `tests/web-hub/hub/hub-lan.test.ts`             | 改（**域外连带**，见下） | 2 处 `hello_ack.caps` 精确数组基线机械更新（`CMD_HISTORY_HUB_CAP` 插在 `VERSION_HUB_CAP` 前，与 hub.ts 实收顺序一致）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tests/web-hub/hub/hub-preview.test.ts`         | 改（**域外连带**，见下） | `baselineCaps()` + import 同样一行机械更新（3 个精确数组用例由此恢复）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 域外连带说明（需调度方知悉）

方案 §4.6 拍板 cap **无条件**静态声明（无设置门，同 `version.v1` 先例），而 `hub-lan.test.ts`（2 用例）与 `hub-preview.test.ts`（3 用例）对默认配置的完整 caps 数组做**精确 toEqual**——任何新增无条件 cap 必然打破，属于方案决定的机械必然，非实现选择。两文件不在 H1 文件域且本会话无 ask_user 通道（`message_agent`→root 未授权，尝试过）——按「验证不通过必须修复后再交付 + 诚实报告」原则做了**各 1–2 行基线插入**（历次无条件 cap 落基线同款改法），在此单列上报；如调度方不认可，revert 这两处即回红 5 例，功能面不受影响。

## 冻结面 / 约束对照（§8.2）

- **F4**：`cmd.history.v1` 两面静态声明完成（P0 常量 `CMD_HISTORY_HUB_CAPS` 由惰性转 fold，H1 接线点即此）；无 PROTO bump、无新帧（回落复用既有 `branch_req`/`branch_reply`）、`CommandArgsSchema` 未动。
- **M4/§4.10 口径**：不纳入 `--no-session`（早退不变，测试钉）；leaf 截断防重复 diff（测试钉）；超时以 `TIMING.snapshotMs` 为准（测试钉）；「回落不受 `cmdHistory` 开关控制」的边界已如实写进 `readTailFromAgent` 的 doc 注释与测试文件头（R9：旧 agent / cmdHistory:false 会话首条消息前的 idle custom 条目也会开始实时 append——改善方向，明示不在「关闭即不变」承诺内）。
- **日志卫生（§5.3）**：回落唯一日志点只带 `{agentKey, error}`，error 为 `HubError` 的 code 字符串；测试以 secret 探针钉「hub.log 无命令输出正文」。
- **关闭时与现状一致**：hub 侧无 `cmdHistory` 设置键；cap 面对旧端只是多一个可忽略字符串；回落是方案明示的通用修复（§1.3）。三份 fabric off golden、`tests/fixtures/legacy-xs-v071/`、`keepalive-legacy-golden.json` **零改动**（git status 佐证）。

## 自验（真实输出尾部）

`npx vitest run tests/web-hub/hub --maxWorkers=3`：

```
 Test Files  199 passed (199)
      Tests  4737 passed (4737)
   Start at  17:08:41
   Duration  131.76s (transform 5.95s, setup 2.45s, collect 26.78s, tests 287.32s, environment 34ms, prepare 10.82s)
```

其中新增 `cmd-history-runtail.test.ts` 9 例 + `cmd-history-hub.test.ts` 2 例全绿（先红后绿：实现前 9 败 2 过，败因均为回落缺失）。

`npx vitest run tests/web-hub/protocol --maxWorkers=3`（P0 面回归）：`1695 passed | 3 skipped (1698)`。

`npm run typecheck`：**本包文件两个 tsconfig 项目均 0 错误**（`tsc -p tsconfig.json` / `tsc -p tsconfig.typecheck.json` 过滤 `web-hub/hub/{hub,history}.ts` 与本包测试文件均为 0 命中）；整仓当前报 5 处 `exactOptionalPropertyTypes` 错误，**全部位于 `src/web-hub/agent/command-record.ts`——并行 A1 包的在途新文件**（工作区可见 `git status`：builtin-bridge/command-capture/ui 等同为 A1/U1 未完成改动），不在 H1 文件域、按指示未触碰，待 A1 自行收敛。

`npx prettier --check`（全部 7 个改动文件）：

```
Checking formatting...
All matched files use Prettier code style!
```

## 遗留 / 说明

- 生效方式（§8.4）：hub 侧改动经 `/webhub restart` 生效。
- I1（集成 / conformance / 真机验收：真 hub 子进程 × fake agent 的「文件含记录 ⇒ history 带 cmd」「leaf 变化 ⇒ append 带 cmd」「首条对话前 ⇒ 回落 append」）不属 H1，未做。
- hub.log 卫生目前只覆盖回落路径的机械断言；§8.5 #7 的真机 grep 验收归 I1。
- 域外连带两文件（hub-lan / hub-preview 基线）待调度方追认（见上节）。

## 边界变更（2026-10-28 · refresh-slow plan §4.3 追认）

`runTail` 的回落条件从 **ENOENT-only 扩为 ENOENT / TOO_LARGE**：会话文件超过整读上限
（`DEFAULT_MAX_FILE_BYTES`，256 MiB）且 `readBranchTail` 答不了（尾部预算耗尽 / leaf 未落盘 /
尾块内坏行）时，同样走 256 KiB `branch_req` 回落（按 pending leaf 截断），实时 append 不再在
256 MiB 悬崖后无声停摆。每个 agent 每段连续 TOO_LARGE 状态只记一条 `log.warn`（仅元数据：
agentKey / reason / maxFileBytes），某次文件读成功（`res.ok`）后复位；PARSE / LEAF_NOT_FOUND
两个分支维持原「下次 leaf 变化重试」行为，`--no-session` 排除不变（M4）。本文上文所述
「ENOENT-only」为当时事实，以本节为准。钉子更新：`tests/web-hub/hub/cmd-history-runtail.test.ts`
的 TOO_LARGE 子用例改为「回落 + append + warn-once + ok 读复位再警告」断言。残留：文件持续
超限且 leaf 不在 agent 256 KiB 回复窗口内时，每次 leaf 变化仍发出一次失败的 branch_req
（warn 只记一次）；待 agent 侧反向投影（refresh-slow P1②）落地后该往返成本可忽略。
