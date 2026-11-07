# #66 P2 实施报告 — 透明升级（HARDENING_PHASE=1）

依据：`plan.md` r3 §4.1、§5、§7、§8 P2、§9 P2、§13–15，以及 `P1-report.md`。复用已确认的 L3 方案，未重新规划或评审。**零 git 写操作**；未改 P1/P4 的已提交边界、#63 工作区改动或 `tests/fixtures/`。

## 验收修订（2026-10-26）

用户反馈 deepseek-v4-pro 验收有条件通过（0 blocker，1 major 为口径冲突），并裁定按 r3 原文 **不带 epoch 条件**。本轮已移除 UPDATE 的 `epoch=?` 以及端口、upgrader、lan-store、私有 IPC、测试 fake 的 epoch 传参。当前 CAS 仅校验 `id + n/r/p + salt/hash`，与 §4.1、§9、§12、§14 #10/#16 一致。

`revokeAllSessions` 只改 epoch 时，撤销前的凭据快照仍可升级；`setPassword` 换 salt/hash 后，旧快照仍返回 stale。真实 SQLite + KDF + login core 的两个并发登录先返回会话，放行后台重算后只提交一次成功 CAS，升级不 bump epoch、不删会话、不动 `initial_*`。

本轮改动文件（绝对路径）：

- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/db-child.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/ports.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/kdf-upgrade.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/lan-store.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/kdf-upgrade.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/db-child.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/lan-store.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-login-integration.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/web-hub-auth-hardening/P2-report.md`

## 改动文件（绝对路径）

| 文件                                                                              | 内容                                                                                                       |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/kdf-upgrade.ts`（新）               | 无队列、全局单飞、最多 256 条失败冷却、20 s unref deadline、共享 KDF 池、结果自检、CAS、dispose 与日志脱敏 |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/db-child.ts`                        | query 段新增 prepared UPDATE / `rehashPassword`；沿用 test-only crash-after-commit 钩子；维护段未改        |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/db.ts`                              | 私有 query op 目录追加 `rehashPassword`；schema 不变                                                       |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/lan-store.ts`                       | 暴露冻结的打开时 writer verdict；编码/派发 CAS；writer off 时直接返回 stale，不派发 UPDATE                 |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/ports.ts`                           | 可选 `hardening`、可选 `rehashPassword`、KdfRow / CAS 类型、可选 login upgrader；旧 fake 无须新增实现      |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/lan-login.ts`                       | 密码匹配且未 revoked/disposed 后、2FA 门之前 fire-and-forget 触发；privacy 不走此挂钩                      |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/http.ts`                            | 仅 writerActive 为真构造 upgrader；scope teardown / LAN close 主动 dispose                                 |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/admin.ts`                           | 改密使用 `newKdfParams(effectiveWriteTarget(writerActive))`，保留 P4 弱口令校验                            |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/kdf-upgrade.test.ts`（新）        | 13 tests：单飞、冷却上限/过期、验证与错误路径、deadline/dispose、物理池 abort、unref 与真实 Node 退出      |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/lan-store.test.ts`                | 真实 SQLite CAS 字段矩阵、gate、会话/initial 保留、改密抢先提交、真实 KDF + login core 端到端升级          |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/db-child.test.ts`                 | UPDATE 已提交但未回复即退出；重拉后数据/会话保留，重试 stale                                               |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/lan-login.test.ts`                | 并发登录先返回两条会话、升级仍单飞；触发在 2FA 门前；错误/未知/撤销/dispose 不触发                         |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/admin.test.ts`                    | writerActive false/true 分别写 2^15 / 2^17                                                                 |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-login-integration.test.ts`   | HTTP gate、响应不等重算、再次登录不重算、旧 cookie 保留、close abort                                       |
| `/home/bluecake/ai/pi-toolkit/docs/dev/web-hub-auth-hardening/P2-report.md`（新） | 本报告                                                                                                     |

## 与方案逐条对照

| 方案项                                                    | 实现 / 验证                                                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4.0 / §13 D1+D2：本期 phase 1，不写新 KDF                | 未改 `HARDENING_PHASE=1`；真实 store 注入 phase 2 + 满 14 天 marker 才启用；phase 1 即使 marker 已满 14 天也拒绝直接 rehash                                                           |
| §4.1：登录匹配后，未撤销，2FA 门前，不 await              | `passwordLogin` 挂钩；core 断言调用先于 `isKnownIp`，两次并发登录在重算挂起时返回 200；HTTP 真实 socket 响应先于重算完成                                                              |
| 仅 writerActive 为真构造；privacy 不触发                  | HTTP 工厂 spy：writer off 未构造、只有校验 KDF（即使存有 2^17）；挂钩仅在 `passwordLogin`，`verifyPassword` / `kdfMatches` 未改                                                       |
| `needsRehash` 只升不降                                    | 复用 P1 helper；等成本、强记录、corrupt 或缺 optional store op 均不计算                                                                                                               |
| 新 salt、目标 2^17、共用 KDF 池、不经 admission           | `newKdfParams(target)` + `deps.kdf.run`；只走 P1 池，不取得第二个登录 admission；fresh salt / target / byte snapshot 断言                                                             |
| 每用户单飞，全局最多 1 在途                               | 一个实例 active slot 覆盖 KDF 和 DB；不排队，忙时直接跳过，不保留其它登录的口令；1000 次多用户触发只有一个计算；两个真实并发登录在重算挂起时返回 200，放行后只提交一次成功 SQLite CAS |
| 失败冷却 5 分钟，Map ≤256，过期清理                       | KDF 错误、invalid output、stale、DB reject/deadline 均进入冷却；299999/300000 ms 边界及 257 个用户驱逐/过期行为断言                                                                   |
| 20 s deadline、unref、dispose abort                       | 总 deadline 覆盖重算和 CAS；每 job 仅一个 unref timer，完成/关闭清理；abort-ignoring fake 保留唯一槽位直至底层 settle，晚结果不写，不会积累超时作业                                   |
| 后台失败不影响登录、不泄漏敏感数据                        | warn 只包含 userId/fromCost/toCost/code；不记录 raw Error/stack、username、密码、salt/hash；logger 抛错也被吞掉；HTTP/并发测试登录先成功                                              |
| R6：减少明文驻留                                          | 不排队；把口令交给 KDF 后立即丢弃 upgrader 自身的明文引用；deadline/dispose 也清掉尚未交付的引用。不能擦除调用方字符串或取消 native scrypt，继续受 P1 物理池约束                      |
| CAS 单条 UPDATE / autocommit，不复用 setPassword          | prepared UPDATE 仅修改 n/r/p/salt/hash/updated_at；条件为 id/n/r/p/salt/hash（不带 epoch）；真实 SQLite 精确比对其它字段和会话仍有效                                                  |
| salt/hash/参数不符、无该用户⇒stale                        | 每个字段分别制造不符，断言 stale 且行未变化；同一旧快照第二次写 stale                                                                                                                 |
| revokeAll 后升级                                          | ✓ 按方案：撤销前的旧凭据快照仍成功升级，保留 revokeAll 后的新 epoch；salt/hash 在 revokeAll 前后未变的断言证明没有刷新快照                                                            |
| setPassword 先提交⇒stale，新密码可用、旧密码不可用        | held background KDF → 真改密事务（salt/hash 均变化）→ 放行升级 → 真 CAS stale（无 epoch 条件）；真实 KDF 验证新/旧密码以及原 cookie 已失效                                            |
| createSessionChecked 不受透明升级影响                     | 升级前/后使用同一 epoch/factorGen 均能 checked insert；已有会话仍可 touch                                                                                                             |
| §9 端到端：2^15 → 后台 2^17 → 再次登录不再升级 → 会话有效 | phase 2 真实 store + KDF + login core：两个并发首登 200、后台单次 CAS 后行到 2^17、重登 200 无 rehash、原会话有效；HTTP fake store 另验证 listener 装配与旧 cookie                    |
| 进程退出 / 崩溃幂等                                       | 真 Node 子进程有永不 settle 的 fake KDF 仍在 5 s 外部上限内自行退出（仅 unref timer）；query 子进程 UPDATE 后退出未返回，下次查询记录/会话有效，CAS 重试 stale                        |
| kdfInFlight 回零                                          | 使用真实 P1 KDF 的受控 scrypt callback，逻辑计数在 dispose abort 后回零，物理 callback 完成不产生晚写；既有 hub-lan `run/runPadded` 安静替换用例随 hub/http 全部通过                  |
| handlePasswd 按 writer verdict 写 2^15/2^17               | admin 两个分支明确断言 run 和 setPassword 的 n/r/p；不使用 verifyTarget 作为写目标，避免 phase 1 回退后降写/误开 writer                                                               |
| §7 迁移 / 回退                                            | marker 未满 14 天或 phase 1 不升级；phase 2 满门槛可升级；phase 1 可以校验已有强记录但不启动 upgrader。≤v0.10.x 的恢复说明继续沿用方案，未改旧版本锚点                                |
| I1/I4/I5/I10/I11                                          | bounded job / pool、实例状态、timer unref、clampSpanMs 的 hub 内镜像且短 override 不得放大生产上限；不改 schema/strict wire/PROTO/设置/env/secure 接线；boundary 门禁通过             |

### 文件域内的装配选择

P2 不允许改 `lan-assembly.ts` / `hub.ts`。因此将维护子进程已有的唯一 writer 判定放到可选 `store.hardening.writerActive`（冻结对象），HTTP/admin 从同一 store 读取；同时保留现有 `CreateLanStoreResult.hardening`。不重新计算 phase 或 marker，不由 verifyTarget 推断 writer。P6 仍可使用同一打开时判定传递 childEnv。

## 自验命令与结果

- `npm run typecheck`：PASS（TS7 ×2 + vue-tsc，最终源码版本）。
- `npm run build`：PASS。
- `npx vitest run tests/web-hub/hub tests/web-hub/http --maxWorkers=4`：PASS，288 files / 5944 tests（删除旧 epoch 拒绝用例，改为 revokeAll 后旧快照成功）。
- `npx vitest run tests/integration/web-hub-lan.test.ts --maxWorkers=2`：PASS，1 file / 4 tests。
- `npx vitest run tests/web-hub/boundary.test.ts --maxWorkers=2`：PASS，1 file / 20 tests。
- `npx prettier --check`（上表全部 P2 ts/md 文件的精确路径）：PASS。
- `git diff --check`：PASS。
- `git diff --quiet HEAD -- tests/fixtures/`：PASS，未改 fixtures。

### 测试尾部（真实输出）

hub/http（最终源码版本）：

```text
 Test Files  288 passed (288)
      Tests  5944 passed (5944)
   Start at  19:00:37
   Duration  138.89s (transform 6.80s, setup 3.34s, collect 45.52s, tests 392.84s, environment 50ms, prepare 15.39s)
```

LAN integration：

```text
 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  19:00:01
   Duration  4.84s (transform 2.34s, setup 59ms, collect 3.00s, tests 1.52s, environment 0ms, prepare 57ms)
```

定向最终源码验证：

```text
 Test Files  5 passed (5)
      Tests  160 passed (160)
   Start at  18:58:51
   Duration  10.78s (transform 1.16s, setup 146ms, collect 1.77s, tests 20.45s, environment 1ms, prepare 256ms)
```

## 遗留 / 未做

1. 验收指出的 epoch CAS major 已按方案原文修正；本轮自验结果见上方。未改方案原文。
2. 上一版首次 hub/http 全集运行有一个范围外的定时抖动：`hub/feishu/service.test.ts` 的 adoption-timeout 日志尚未出现（287 files / 5944 tests passed，1 test failed）。该文件独立复跑 33/33 通过；原命令随后两次完整复跑均 288/5945 通过。**未改飞书实现或测试**。本轮按裁定修正后，全集首跑即 288/5944 通过。
3. 未跑全仓 `npm test` / 全仓 `format:check` / build:web；按任务指定范围测试与精确文件 prettier 执行，避免触碰 #63 工作区文件。另补 type/build 与 boundary。
4. A1/A2/A3 的 RSS/墙钟/旧版本真机回退仍属于方案后续验收，不把 unit/fake 测试冒充真机结论。
5. 用户反馈上一版已由 deepseek-v4-pro 有条件验收通过；本轮修正其 major。当前会话没有 Agent 调度工具，未另行发起异源复验，本轮仅声明开发自验结果。
6. 查询 UPDATE 已派发时，如果进程在提交后、回复前退出，调用方可能得到失败但升级已提交。单语句 CAS / 不改 epoch / 不删会话让此结果安全，重试只会 stale；已测该窗口。

## 建议 commit message（未执行 commit）

```text
feat(web-hub): add phase-gated background password rehash with bounded CAS upgrades

- only construct the login upgrader when the maintenance writer verdict is active
- use fresh scrypt 2^17 parameters and a params/salt/hash CAS (no epoch condition) without revoking sessions
- bound upgrades to one job, a 20s unref deadline and 256 five-minute cooldown entries
- choose password-write parameters from the same immutable open-time writer verdict
- keep phase 1 writes at 2^15; cover races, teardown, process exit and live-session preservation
```
