# #66 P5 实施报告 — 首登清除初始密码明文

依据：`plan.md` r3 §4.5、§5、§7、§8 P5、§9 P5、§13 D4、§14 #9/#10。**零 git 写操作**；未动 `tests/fixtures/`，未打印 `~/.pi/agent` 下任何密钥/口令/哈希。

## 实现

- `hub/db-child.ts`：`markInitialLogin` 改为**一条语句**
  `UPDATE users SET initial_login_at=COALESCE(initial_login_at,?), initial_login_ip=COALESCE(initial_login_ip,?), initial_password=NULL WHERE username=? AND initial_password IS NOT NULL`，
  不带 epoch 条件，返回 `{cleared: changes===1}`。`getUserSummary.initialPasswordInUse` 与 `initialInfo` 改为新判据
  `initial_created_at IS NOT NULL OR initial_password IS NOT NULL`；`initialInfo` 只在「仍在使用」时返回 `initialLogin`，
  明文只在 `initial_password` 仍在时返回。维护子进程 `checkpoint-truncate` 现在读取 `wal_checkpoint` 的 `busy` 位，
  被读者挡住时回复 `warning:'checkpoint-truncate-busy'`（SQLite 在 busy 时不抛错，原先会被当作成功）。
- `hub/lan-store.ts`：`markInitialLogin` 返回 `{cleared}`；新增 `requestCheckpointTruncate()`（合并并发请求，in-flight 期间再来则补跑一次；
  失败或 busy ⇒ 记 warn + 置告警 `initial-password-residue`；成功 ⇒ 清除）、`warnings()`、`onWarningsChanged(cb)`。
- `hub/ports.ts`：`markInitialLogin` 返回值放宽为 `{cleared:boolean}|void`；`LanStorePort` 新增三个**可选**成员
  `requestCheckpointTruncate?` / `warnings?` / `onWarningsChanged?`（旧 fake 不必实现）；`LanUserSummary` 注释更新。
- `hub/lan-login.ts`：`complete()` 的清除改为 best-effort（独立 ≤2 s 预算，`try/catch`，失败只记 `initial-password-clear-failed` warn，
  日志里只有规范化的 `E_*` code，**登录照常成功**，F11 的旧语义被取代）；`cleared` 为真才调用 `store.requestCheckpointTruncate?.()`。
  登录响应 `initialPassword` 改用 `initialPasswordInUse(user)`（导出的小函数）。触发清除的条件仍是读到的记录里明文还在。
- `hub/http.ts`：`extraWarnings()` 并入 `store.warnings()`，订阅 `onWarningsChanged` 重建并发布 `LanStatus`，scope 关闭时退订。
  `/api/session` 的 `initialPasswordInUse` 来自 `getUserSummary`，随新判据自动更新（http.ts 无独立判据）。
- `agent/lan-status.ts`：`formatInitialPasswordLines` 新增分支：无明文但有 `initialLogin` ⇒ 一行
  「初始密码已被 <ip> 于 <时间> 使用登录，明文已清除；若不是你，立即 /webhub passwd。」（各 UI 模式一致、不含明文）。
  有明文时输出不变。`initial-password-residue` 的文案沿用已有的；`lan-status.ts:199` 文案核对后保留。
- wire 无变化（I10）；schema 不变；无新设置/env。`docs/dev/web-hub/README.md` LAN security 段补了本包说明。

三处旧判据（lan-login 响应、`getUserSummary`/`/api/session`、`initialInfo`/admin info）全部切到新口径。

## §7 旧库兼容（均有真实 SQLite 用例）

| 旧库状态                                         | 行为                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 明文在、`initial_created_at` 在                  | 首登清除，保留 created_at，in-use=true                                                 |
| 明文在、`initial_login_*` 已被旧版写入           | 清除明文，**保留最早的** ip/at（COALESCE）                                             |
| 明文在、`initial_created_at` 为 NULL（更老的库） | 视为使用中，可被清除；清除后（无 created_at）不再算使用中                              |
| 改密之后                                         | 两列都 NULL ⇒ 三处口径均为「不在使用」；`initialInfo` 不再返回残留的 `initial_login_*` |
| 旧 hub 读新库                                    | 明文为空 + created_at 在 ⇒ 旧判据视为「不在使用」，提醒消失（§7 已声明的轻微降级）     |

## 测试

- `tests/web-hub/hub/lan-store.test.ts`（真实 SQLite，+11）：一条语句写入并清除、created_at/epoch 不变；三处口径一致；二次调用 `cleared:false` 且不覆盖；
  未知用户；改密后翻转；与改密并发（改密先）⇒ `cleared:false`；两种旧库；`requestCheckpointTruncate` 后 hub.db/-wal 里 grep 不到明文；
  读者占住快照时 TRUNCATE 被挡 ⇒ `initial-password-residue`（含通知事件），随后成功 ⇒ 清除；20 次并发请求合并。
- `tests/web-hub/hub/lan-login.test.ts`：原「markInitialLogin 在完成 deadline 内、失败回滚」用例按新语义改写为：挂起 ⇒ 2 s 后 200 且会话保留；
  reject ⇒ 200、仅一条 warn、日志不含口令；`cleared` 真/假决定是否 truncate；明文已清但 `initialCreatedAt` 在 ⇒ 响应仍 `initialPassword:true` 且不再调用 mark。
- `tests/web-hub/http/lan-initial-clear.test.ts`（新）：HTTP 登录清除一次、`/api/session` 仍 in-use、二次登录不再清除；mark reject 仍登录；
  `store.warnings()` 进入 `LanStatus.warnings` 并随通知刷新、关闭后退订。
- `tests/web-hub/agent/lan-status.test.ts`：新提示行（四种 UI 模式）；有明文时旧输出不变。
- `tests/web-hub/hub/hub-lan.test.ts`：首登后 `info` 无明文、有 `initialLogin`，hub.log 不含原明文（改为在清除前取值，避免空断言）。
- `tests/integration/web-hub-lan.test.ts`：真 hub 端到端——首登后 info 无明文/有 initialLogin、`/api/session` in-use、磁盘无明文、二次登录仍成功且首次记录不变、passwd 后 info 无 initialLogin。
- `tests/web-hub/contract/fakes.ts`（测试支撑，方案 §8 未列出但必须同步）：fake store 的 `markInitialLogin`/`getUserSummary`/`initialInfo` 对齐真实语义。

## 自验

- `npm run typecheck`：PASS。
- `npx vitest run tests/web-hub/hub tests/web-hub/http tests/web-hub/agent --maxWorkers=4`：PASS，377 files / 7573 tests。
- `npx vitest run tests/integration/web-hub-lan.test.ts tests/integration/web-hub-control.test.ts --maxWorkers=2`：PASS，2 files / 29 tests。
- `tests/web-hub/boundary.test.ts`、`tests/commands/webhub-lan.test.ts`：PASS。
- `tests/integration/web-hub-headless.test.ts`：见末尾状态行。
- `npx prettier --check src/web-hub tests/web-hub tests/integration/web-hub-lan.test.ts docs/dev/web-hub/README.md`：PASS。
- `git diff --quiet HEAD -- tests/fixtures/`：干净。

## 遗留 / 注意

- 打开库时（open-check-migrate）末尾 TRUNCATE 失败只进 `truncateFailed`/日志，**不**发 `initial-password-residue`（无法区分残留的是不是初始密码）；告警为内存态，重启后消失，由下次打开时的 TRUNCATE 收尾。
- 清除前的备份、已释放文件系统块不在范围内（已写入 README）。实测 UPDATE 在同一页内覆盖，主库与 -wal 在 TRUNCATE 后均 grep 不到明文，未启用 `secure_delete`。
- 新增的 store 告警走 `LanStorePort` 可选成员而非 `lan-assembly.ts`（不在 P5 文件域）；P6 的 `totp-*` 告警可复用同一通道。
- 单次 checkpoint-truncate 最长 3 s（busy_timeout 2.5 s），在 hub 主线程外的子进程中执行，不占登录路径。

## 建议 commit message

```
feat(web-hub): wipe the generated LAN password plaintext at the first sign-in

The auto-generated initial account stays, but its plaintext initial password is now cleared by the
first successful login: one statement records the login ip/time and NULLs initial_password, then a
coalesced WAL TRUNCATE removes the residue (failure raises the initial-password-residue status
warning). The wipe is best-effort and never fails a login. "Initial password in use" is now
initial_created_at IS NOT NULL OR initial_password IS NOT NULL everywhere (login response,
/api/session, info), and the TUI reports which address used it and when. No wire or schema change.
```
