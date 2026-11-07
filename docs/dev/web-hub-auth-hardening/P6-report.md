# #66 P6 实施报告 — TOTP 密钥加密存放（L3）

依据：`plan.md` r3 全文（重点 §4.0/§4.2/§5/§7/§8 P6/§9 P6、§13 D3、§14 #1–#8、§15 #1/#3/#4）、P1/P2/P5 报告与 AGENTS.md。基线 `dev / de0f1f52`。复用已确认方案，**零 git 写操作**，未改 `tests/fixtures/`，未读取或打印真实 `~/.pi/agent` 下的密钥、哈希或 TOTP；密钥测试全部使用临时 home。

**本期仍为 `HARDENING_PHASE=1`**：读侧支持 20B/53B，写路径机制已完成，但正常运行不创建密钥、不迁移、登记仍写 20B。phase 2 + 满 14 天门槛通过测试注入验证；没有提前翻转 P3。

## 改动文件（绝对路径）

| 文件                                                                             | 内容                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/db-child.ts`                       | 两个纯 CommonJS 子进程共用的密钥/加解密 helper；合规检查、原子建钥、独立状态、迁移、登记与 unavailable；reset/recovery 绕过解密，repair 同事务删 fp；TRUNCATE busy/失败可见 |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/db-client.ts`                      | 可选 childEnv 的不可变快照与每次 respawn 复用；私有 E_TOTP_KEY 透传；查询密钥告警只接受固定 code                                                                            |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/lan-store.ts`                      | home 同源路径派生；唯一维护 verdict 下发 env；hardening 的真实 TOTP 状态与 store warnings                                                                                   |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/ports.ts`                          | 内部可选 totpUsable 与 unavailable verdict，不进 strict wire                                                                                                                |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/lan-login.ts`                      | challenge 去掉不可用 TOTP；unavailable 退还两项预算、503、不计 limiter.fail、回 pending                                                                                     |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/admin.ts`                          | E_TOTP_KEY 的固定处置文案，不转发原始异常                                                                                                                                   |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/http.ts`                           | 明确 P5/P6 共用已有 store warning 通道（装配机制复用 P5，不重复添加）                                                                                                       |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/protocol/paths.ts`                     | webHubTotpKeyFile(home)、HubPaths.totpKeyFile（可选以兼容既有 assembly fake；真实 resolve 始终提供）                                                                        |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/lan-status.ts`                   | missing/mismatch/residue 告警与恢复提示；repair 说明解除绑定但保留文件                                                                                                      |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/twofa-cmd.ts`                    | E_TOTP_KEY 文案与 repair 提示                                                                                                                                               |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/totp-key.test.ts`（新）          | 57 条：真实 AES/SQLite/child/HTTP、原子落盘与故障注入、状态/恢复/迁移/门槛/脱敏/告警矩阵                                                                                    |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/db-lan-security.test.ts`         | 20B/53B 行合法性、其他长度/版本 fail-closed                                                                                                                                 |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/db-client.test.ts`               | 0/1 childEnv 在真实子进程崩溃后保持不变，重登记格式不变，调用方修改原 env 对象无效                                                                                          |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/admin-tfa.test.ts`               | E_TOTP_KEY 固定响应/脱敏与 totpUsable 不进入 strict status                                                                                                                  |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/lan-login.test.ts`               | missing challenge、全部方法不可用、unavailable 超过预算次数仍退预算并保持 pending                                                                                           |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/totp.test.ts`                    | 冻结的 v0.10 长度校验锚点拒绝 53B（未重生 fixture）                                                                                                                         |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/contract/lan-security-store.test.ts` | 原共享契约同时跑 fake / 明文 SQLite / phase-2 加密 SQLite，36 条                                                                                                            |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/db-child.test.ts`                | **用户追加批准**：仅更新原 :539 hardening IPC 对象的这一处断言，补新增 TOTP 字段预期                                                                                        |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/protocol/paths.test.ts`              | **用户追加批准**：仅更新原 :58 HubPaths 对象的这一处断言，补 totpKeyFile 预期                                                                                               |
| `/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/README.md`                        | 仅 LAN security 段追加机制、不变式、备份/恢复/回退、残留与轮换不做说明                                                                                                      |
| `/home/bluecake/ai/pi-toolkit/docs/dev/web-hub-auth-hardening/P6-report.md`      | 本报告                                                                                                                                                                      |

### 文件域说明

首次完整指定门禁仅 `db-child.test.ts:539` 的旧精确对象断言失败（未包含新增私有 IPC 字段）；额外路径测试仅 `paths.test.ts:58` 的旧精确对象断言失败（未包含 totpKeyFile）。没有通过隐藏枚举字段、削弱断言或修改冻结面规避。上报后用户明确批准两处最小更新，**这两个文件的其他断言均未改动**（git diff 已核对）。随后完整门禁通过。

既有 assembly 只交给 store `dbFile`，而 `lan-assembly.ts` 不在本包域内；因此 store 从规范 `/.pi/agent/web-hub/hub.db` 后缀取出与 HubPaths 相同的 home，再调用 `webHubTotpKeyFile(home)`。不读取 HOME/XDG_STATE_HOME/任何新主线程 env；自定义测试 DB 路径用显式 totpKeyPath。未动 hub.ts、lan-assembly.ts、hardening.ts、db.ts 或 strict schemas。

## 与设计逐条对照

| 方案项                              | 实现与真实验证                                                                                                                                                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4.2 密钥落点 / §14 #3              | `<home>/.local/state/pi-webhub/totp.key`，不在 `.pi/agent`；XDG_STATE_HOME 改变不影响路径；README 明说 DB/.pi 单独泄漏保护，不保护整 home 或同 uid/root；secure 卷外 R12 不变                                                                              |
| 32B key、0700 dir、0600 file        | lstat 普通文件/本 uid/32B；宽模式 chmod + 固定 code 告警；NOFOLLOW/NONBLOCK open + fstat 身份复核；真实权限与文件内容断言                                                                                                                                  |
| §15 #4 不合规文件                   | rows53=0 时 31B、符号链接、foreign owner 均可覆盖并 warn；链接目标不变；非空目录目标建钥失败仍 none；foreign-owned key 目录不建；rows53>0 时相同情形 missing、不重建，fs spy 断言没有 wx/rename、fp/行不变                                                 |
| §14 #4 建钥原子落盘                 | 只有维护子进程、只有 rows53=0 + writerActive 可建钥；真实 fs spy 顺序 wx → file fsync → rename → dir fsync → readback；mkdir/open/write/fsync/close/rename/dir-fsync/readback 故障都清 tmp，返回 none、不迁移；EINVAL/EISDIR 的目录 fsync 不支持情况可继续 |
| fp/kid/53B/AAD                      | HMAC-SHA256 指纹常量与独立实现比对；版本1+4B kid+12B nonce+20B AES-GCM+16B tag；AAD 绑定 uint64BE user_id；往返、fresh nonce、逐一改 53 个字节及改 user_id 都验证失败                                                                                      |
| factorRowValid 读侧                 | 真 SQLite 接受20/53B（53B首字节1），拒绝0/19/21/52/54B与版本2；加密行缺钥不是 schema-invalid，不关闭 LAN；冻结 v0.10 长度锚点拒绝53B                                                                                                                       |
| §15 #1 rows53 为准                  | rows53=0 时缺失/陈旧/错 fp 均 none；采用已有 key 或新建 key 时在事务内覆盖 fp；rows53>0 有匹配 key 为 ok、无/不合规 key 为 missing、缺/错 fp 为 mismatch，永不替换 key/fp                                                                                  |
| 单行 kid/tag 错                     | 只给该行 totpUsable:false / unavailable；另一用户的有效行继续成功，启动全局 key 状态仍 ok                                                                                                                                                                  |
| §14 #2 登录降级                     | challenge 去掉 totpUsable:false 的 TOTP，恢复码与 live Feishu 保留；全部方法不可用沿用503 E_DB；真实 HTTP + SQLite 缺钥时 LAN on、challenge 只有 recovery，恢复码成功建立会话                                                                              |
| unavailable 不计 bad                | verifyTotp 无钥/kid/tag 失败返回 unavailable；submitFactor 两项预算退款、pending、503、审计 unavailable、不 limiter.fail；连续调用超过两项预算上限仍无锁定，后续 bad 只扣一次、success 仍能完成                                                            |
| reset / repair / recovery           | reset/recovery 不调用解密（真实 SQLite + createDecipheriv spy 正反对照）；missing/mismatch 下 reset 可成功；repair 删除表并在同一事务删 fp，文件保留；恢复码 hash/salt 未变化，不与 key 绑定（§14 #8）                                                     |
| 运行中登记                          | commit 在事务内重读文件、按 others53 判定；无其他加密行覆盖 fp 写53B；缺文件降级20B并 warn，后续打开迁移；有其他53B但 key 缺/错 ⇒ E_TOTP_KEY，事务回滚，原行/fp不变；admin 的错误码与文案通过 strict TfaResSchema                                          |
| 缓存语义                            | 验证使用启动时 key；运行中删文件仍可验证，重启才 unavailable；commit 始终重读，不使用旧缓存                                                                                                                                                                |
| 推荐恢复路径                        | key A 的53B → 删除 key / missing → reset → restart 建 key B、覆盖 fp → none → enroll53B/kid(B) → restart ok / 验证成功；另测保留 key A 直接 restart、采用并覆盖 fp；也测运行中 reset+换文件后 commit 覆盖 fp                                               |
| §4.0 / §15 #3 writerActive 唯一判定 | 维护子进程唯一计算；CreateLanStoreResult 与 store.hardening 同值；下发 childEnv 0/1 与 key path；query 源码不含 WRITER_SOAK/reader marker/判定函数；真实 kill/respawn 沿用快照，登记长度不变（包含调用方改原 env 对象的防御）                              |
| §14 #7 两段发布                     | phase1 恒不建/不迁移/登记20B，仍能验证已有53B；phase2未满14天同phase1，满门槛才迁移/写53B；原 HARDENING_PHASE=1 未改                                                                                                                                       |
| §14 #5 迁移/残留                    | BEGIN IMMEDIATE 事务写 fp/CAS迁移20B（有匹配的已有53B时也可迁移余下明文），不 bump factor_gen、不动 recovery/session；紧接 TRUNCATE；真实 reader 阻塞产生 busy+truncateFailed+totp-plaintext-residue，下次打开重试成功，DB/WAL 不含旧20B明文               |
| 崩溃幂等                            | 真实 SIGKILL 于建钥后/事务前、COMMIT后/TRUNCATE前；重启采用同 key、fp 正确、全部53B，TRUNCATE补做、验证成功                                                                                                                                                |
| §14 #6 轮换                         | kid/version预留；本期无在线轮换；README 有全 reset/repair → 删除 key → restart（phase2+soak）→ re-enroll 手工步骤                                                                                                                                          |
| §5 / I8 / I10                       | 仅可选内部端口/私有IPC变化；status strict schema/PROTO 未动；public warning token append-only，旧未知token仍忽略；boundary20条通过                                                                                                                         |
| I1 / I5 / I11                       | 新 fs/crypto 在有SIGKILL预算的维护/查询子进程；没有新增timer，沿用unref的query/维护/登录预算；无运行时依赖/设置/secure接线变化，LAN-off不启动store/key机制                                                                                                 |

## 自验命令与结果

全部基于最终源码与获批的两处断言更新：

- `npm run typecheck`：PASS（TS7 ×2 + vue-tsc）。
- `npm run build`：PASS。
- `npx vitest run tests/web-hub/hub tests/web-hub/http tests/web-hub/agent tests/web-hub/contract tests/web-hub/boundary.test.ts --maxWorkers=4`：PASS，384 files / 7792 tests。
- `npx vitest run tests/integration/web-hub-lan.test.ts --maxWorkers=2`：PASS，1 file / 5 tests；获批断言更新后亦与路径测试合跑再次 PASS。
- `npx vitest run tests/integration/web-hub-lan.test.ts tests/web-hub/protocol/paths.test.ts tests/web-hub/protocol/paths-private-dir.test.ts --maxWorkers=2`：PASS，3 files / 44 passed + 2 existing skipped（路径平台条件用例）。
- `npm run format:check`：PASS（全仓 Prettier 检查，不写文件）。
- 对本包全部改动文件 `npx prettier --write` / 报告 `--check`：PASS（只格式化精确路径）。
- `git diff --check`：PASS。
- `git diff --quiet HEAD -- tests/fixtures/`：PASS，冻结产物未改。

### 测试尾部（真实输出）

完整指定门禁：

```text
 Test Files  384 passed (384)
      Tests  7792 passed (7792)
   Start at  20:24:46
   Duration  162.74s (transform 11.93s, setup 4.68s, collect 74.00s, tests 439.19s, environment 67ms, prepare 20.82s)
```

单独 LAN 集成命令：

```text
 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  20:19:26
   Duration  5.98s (transform 2.57s, setup 60ms, collect 3.43s, tests 2.22s, environment 0ms, prepare 51ms)
```

最终 LAN + 路径额外复验：

```text
 Test Files  3 passed (3)
      Tests  44 passed | 2 skipped (46)
   Start at  20:25:08
   Duration  5.64s (transform 2.27s, setup 85ms, collect 2.96s, tests 2.20s, environment 1ms, prepare 191ms)
```

定向 TOTP/共享契约：

```text
 Test Files  2 passed (2)
      Tests  93 passed (93)
   Start at  20:17:02
   Duration  16.62s (transform 1.06s, setup 107ms, collect 1.46s, tests 21.11s, environment 0ms, prepare 106ms)
```

## 遗留 / 未做

1. 本次工具集没有 Agent 调度能力，**未自行发起异源 verifier**；以上均为开发自验、真实子进程/SQLite/HTTP及确定性故障测试，不冒充独立验收结论。
2. 未跑全仓 `npm test` 或 build:web（未动UI）。已跑用户指定完整 hub/http/agent/contract/boundary 门禁、LAN integration，以及全仓 typecheck/build/format:check。
3. 方案 A1/A2/A3/A4 的人工真机/RSS/旧版本二进制回退或新机器备份恢复验收未执行。自动化已验证 phase1 读53B、v0.10校验锚点、真实HTTP缺钥恢复码登录与完整重建路径，但不声称真实旧hub/新机器操作完成。
4. 在线轮换明确本期不做；正常 phase1 不新写加密数据。这些是已确认的范围，不是待修缺陷。
5. 启动告警快照需 restart 刷新；验证 key 缓存直到查询子进程重启。迁移前备份、TRUNCATE前WAL、已释放文件系统块与整home泄漏风险已写入README。

## 建议 commit message（未执行）

```text
feat(web-hub): add phase-gated TOTP key encryption and recoverable key states

- accept legacy 20B and user-bound AES-256-GCM 53B TOTP records without schema changes
- keep the machine key outside .pi/agent; create it atomically only when no encrypted rows exist
- forward the sole maintenance writer verdict through immutable childEnv across query restarts
- preserve recovery/Feishu login and reset/repair on missing or mismatched keys; refund unavailable attempts
- migrate with fp/row CAS and WAL TRUNCATE, surfacing key and plaintext-residue warnings
- keep HARDENING_PHASE=1 writes unchanged; cover filesystem faults, crashes, recovery and encrypted contracts
```
