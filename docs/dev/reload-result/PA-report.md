# #30 P-A 交付报告 · agent 与协议

> 方案：`docs/dev/reload-result/plan.md`（r3）。本包只覆盖 plan §2「P-A」与 §3 中归属 P-A 的验收行。P-U（前端）、P-C（闭环/tiers/web-hub README）不在本包范围。

## 1. 改动文件（绝对路径）

源码：

- `/home/bluecake/ai/pi-toolkit/src/reload/phase.ts`（新建）— 事实类型、`life`/`execId` 生成、≤256 B UTF-8 安全的 message 截断
- `/home/bluecake/ai/pi-toolkit/src/reload/command-port.ts` — 第三参数 `onPhase?`；life/execId 归属；新增 `unavailable(ctx)`；arm/cancel/deferFire/reload 全部采集点
- `/home/bluecake/ai/pi-toolkit/src/commands/status.ts` — 不可用分支改调 `ctl.unavailable(ctx)`
- `/home/bluecake/ai/pi-toolkit/src/commands/capture.ts` — capture 代理新增只读、不可枚举的 `webCmdId`；导出 `webCmdIdOf`
- `/home/bluecake/ai/pi-toolkit/src/index.ts` — 端口 sink 晚绑定到 `webHubRef.current?.onReloadPhase?.(event)`（不新增 `pi.on`）
- `/home/bluecake/ai/pi-toolkit/src/web-hub/protocol/messages.ts` — `ReloadStatusWire` 等类型 + `StatusInfo.reload?`（仅追加）
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/reload-track.ts`（新建）— tracker、进程级 store、接管标记验证、TTL/时间规则
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/index.ts` — tracker 装配、`publishStatus` 追加 `s.reload`、`onTick` 撤销、session_start/shutdown 边界、`WebHubControl.onReloadPhase`、`reloadModuleInstance` 测试 seam

文档：`/home/bluecake/ai/pi-toolkit/docs/dev/deferred-reload/README.md`（I7/I9/I10 改写 + 新增「Phase observer」一节）。

测试：

- 新建 `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/reload-result-compat.test.ts`（G1）
- 新建 `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/reload-track.test.ts`（35 例：A1/A2/A5/A6/A7/A8/A10/A11/A12/A13、U11、G3）
- 新建 `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/wiring-reload-status.test.ts`（10 例：G3、A3、A4、A6、A8、A9、A10、A12、slot 投影）
- 追加 `/home/bluecake/ai/pi-toolkit/tests/reload/command-port.test.ts`（A1/A2/A13 与事件序列）
- 追加 `/home/bluecake/ai/pi-toolkit/tests/reload/status-reload.test.ts`（unavailable 路由）
- 追加 `/home/bluecake/ai/pi-toolkit/tests/commands/capture.test.ts`（`webCmdIdOf`）

Fixture（唯一允许新增）：`/home/bluecake/ai/pi-toolkit/tests/fixtures/web-hub/reload-result-compat-golden.json`。

## 2. G1 golden 的录制证据

- 在**任何 src 改动之前**，于未修改实现上用 `PI_TOOLKIT_RELOAD_RESULT_GOLDEN_CAPTURE=1` 录制；录制逻辑 `!existsSync(FIXTURE)` 才写，已存在则拒绝覆盖。
- 录制前 `git status -- src/reload src/web-hub src/commands/{status,capture}.ts` 为空。
- 文件 md5 `a873812e221cea0f72fec2f68edeea6a`，mtime 17:27:53（早于首个 src 改动）；之后多次复跑 md5 不变。
- 过程中第一次录制因占位符 `<pid>` 不是合法 JSON 而作废：当时文件是在未改动的 src 上写出的，随即把占位符换成 JSON 安全的哨兵并删除重录，仍在任何 src 改动之前完成。
- s1（TUI `/agent reload` 空闲含 handover）要求**完整帧序列逐字节相等**；s2/s3（Web）要求非 status 帧逐字节相等，status 只允许 D6 的两类差异（已有帧多 `reload` 字段 / 投影变化时插入且带 `reload` 的帧）。实测 s2、s3 的差异全部落在这两类里（存证见 §5）。

## 3. 验收矩阵对照（P-A 行）

| 行  | 覆盖                                                             | 位置                               |
| --- | ---------------------------------------------------------------- | ---------------------------------- |
| G1  | 兼容 golden                                                      | reload-result-compat               |
| G2  | 默认/webHub 关闭，五份 A 级 golden + activation                  | 门禁 §4                            |
| G3  | 无记录/投影未变零输出                                            | reload-track、wiring-reload-status |
| A1  | A、B 各自 execId，B 为当前，旧回调按 execId 丢弃，只 reload 一次 | command-port、reload-track         |
| A2  | 旧执行回调不覆盖新执行 started                                   | command-port、reload-track         |
| A3  | agent_settled 推迟仍按代理 webCmdId 归属                         | wiring-reload-status、capture      |
| A4  | deferred 期间 TUI now 后接管，归属 Web cmdId                     | reload-track（Q1）、wiring 接管    |
| A5  | IDLE_WAIT 后 now/retry/cancel                                    | reload-track                       |
| A6  | 其他来源完成 reload ⇒ superseded，非 completed                   | reload-track、wiring               |
| A7  | 接管标记身份不符的 6 种 + 损坏结构                               | reload-track                       |
| A8  | TUI 流式直接返回 ⇒ REFUSED                                       | wiring、status-reload              |
| A9  | shutdown 之后加载失败 ⇒ 无结局帧                                 | wiring                             |
| A10 | RPC 抛错 ⇒ THREW，message 截断                                   | wiring、reload-track               |
| A11 | version `"0.0.0"` ⇒ 不写 version                                 | reload-track                       |
| A12 | TTL 到期只发布一次撤销                                           | reload-track、wiring（假时钟）     |
| A13 | 旧执行失效、新请求开新 life                                      | command-port、reload-track         |
| U11 | 未知 v/损坏/未来时间戳/时钟回拨按空处理并清除                    | reload-track                       |

A4 的「接管发生在真实第二个 activation」由 `reloadModuleInstance` seam 模拟模块重新求值；见 §6 残留 2。

## 4. 自验命令与真实输出

门禁 1（plan §4 P-A）：

```
npx vitest run tests/reload tests/commands tests/web-hub/agent tests/web-hub/protocol tests/web-hub/boundary.test.ts tests/boundary/pi-free.test.ts tests/governance
 Test Files  188 passed (188)
      Tests  4503 passed | 3 skipped (4506)
exit=0
```

门禁 2（A 级 off golden + 激活 + epoch-up + 本包 compat）：

```
npx vitest run tests/integration/{thread-off,thread-rebind-off,fabric-xs-off,fabric-xs-reply-off,schedule-off}-golden.test.ts tests/reload/activation.test.ts tests/web-hub/hub/epoch-up-compat.test.ts tests/web-hub/agent/reload-result-compat.test.ts
 Test Files  8 passed (8)
      Tests  25 passed (25)
exit=0
```

`npm run typecheck`（TS7 ×2 + vue-tsc）：`exit=0`，无输出错误。过程中一次因 `nextRecord` 返回 undefined 与 `exactOptionalPropertyTypes` 冲突失败（我的代码），已修为「无变化保留原记录」后通过。

`npx prettier --check`（全部改动文件，含文档）：`All matched files use Prettier code style!` exit=0。

`git diff --stat origin/dev -- tests/fixtures/`：空输出（已跟踪 fixture 零变化）；`git diff --quiet origin/dev -- tests/fixtures/` 通过。唯一新增的未跟踪 fixture 是 `tests/fixtures/web-hub/reload-result-compat-golden.json`。另一份未跟踪的 `tests/fixtures/reflex-drafts-off-parity.json` 属于 #25 B0，不是本包。

日志：`/tmp/rr-gate1-final.log`、`/tmp/rr-gate2-final.log`、`/tmp/rr-typecheck3.log`、`/tmp/rr-prettier.log`。未跑全量与 secure 测试。

## 5. 实现中发现并修复的真实缺陷（均在测试暴露后修）

1. 端口层 `deferred` 去重记忆与归属无关：TUI 事实（被 tracker 按 Q1 丢弃）会抑制其后同形状的 Web 事实，导致 Web 请求永远不被建立。记忆 key 现带 `webCmdId`。
2. `ctx.reload()` 抛错时 `lifeOpen=false` 被 rethrow 跳过，life 泄漏到下一请求。改为 `finally`。
3. `onPhase` 在 life 不匹配时保留了旧记录而不是替换；建立分支重写。
4. `applyPatch` 用 `Object.assign` 无法删除不应出现的键（started 后仍带 `waitingFor`）。改为不可变的 `nextRecord`。
5. `clipReloadMessage` 实际可达 258 B（省略号未计入、孤立 lead 字节解码为 U+FFFD）。改为预留省略号并丢弃截断的多字节序列。
6. 未来时间戳的清除在只读路径中写回，被调用方后续 write-back 复活。新增 `sanitizeStore`，在每个变更入口先清并持久化。
7. 接管验证放在 attach 之前执行，使完成态已就位；见残留 2 关于线上可见时机。

## 6. 遗留问题 / 残留风险

1. **范围外发现（未改）**：`tests/tiers.ts` 与多处 `src/reflex`、`src/config`、`src/secure`、`src/sysload` 的改动来自并行包，非本包。
2. **completed 帧在真实第二个 activation 内的线上时机**：session_start 里 `onSessionStart` 发生时 `conn` 尚未由新 activation 建立，该次 `publishStatus` 被 `conn===undefined` 丢弃；completed 随后由 `connectWith` 的 `publishStatus()`（hello_ack 之后重放槽）送达（plan D9：电平式、槽重放）。单 activation 测试里用「槽内写入 completed 后下一次发布携带」验证投影；**跨两个真实 activation 的端到端（socket→hub→UI）属于 P-C 的 `web-hub-reload-result-loop` 集成测试**，本包 fakeNet 不覆盖。我在进程内用 `reloadModuleInstance` seam 验证了 marker 校验与 store 内的 completed，没有验证 hub 侧收到。
3. plan §5 要求「P-A 需实测 shutdown 前 started 这一帧能否落到 wire」：fakeNet 下 `started` 的 status 帧先于 `session_detached` 写出（见 wiring 测试 A4 的帧序列：`status(started)` → `session_detached`），但真实 socket 的背压行为未测，同样留给 P-C。
4. TUI 在 shutdown 之后加载失败无法采集（A9 如实验证为「无结局帧」，记录保持 started），UI 需据 started + 下线判 `E_RELOAD_LOST`（P-U）。
5. 计划文件清单里提到的 `tests/reload/fire-idle.test.ts`、`tests/web-hub/agent/capture-commands.test.ts` 本包没有追加用例：fire-idle 的现有用例全部原样通过（端口新增事实不改变其断言行为），capture 归属已在 `tests/commands/capture.test.ts` 与 wiring 测试中覆盖。如评审要求逐文件追加，可作为小补丁。
