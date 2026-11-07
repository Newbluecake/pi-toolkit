# #66 web-hub 局域网登录凭据存储加固 — 实施方案 r3

> 状态：r3。依据「用户拍板（2026-10-26）」（§13，原文保留）、sonnet 评审（`/tmp/review66.md`，逐条回应见 §14）和 sonnet 复审（有条件通过，0 blocker；4 条修订见 §15）修订。r1 中与拍板冲突的口径已删除或移到 §12「已否决」。本版之后不再开评审，由主会话核对闭合。
> 车道：总体 **L3**。P2（升级写入 CAS）与 P6（TOTP 密钥）为 L3；P1、P4、P5 为 L2；P3（阶段翻转）为 L1。
> 代码坐标以 `3831a2bd`（v0.10.0）为准。本文只读代码写成，未改实现。
> 必读背景：`docs/dev/web-hub/README.md`「LAN security」、`docs/dev/web-hub/lan-plan.md` §1.1/§5/§6、`docs/dev/web-hub/lan-security-plan.md` §5.2/§5.3。

---

## 1. 背景与目标

#66 的目标是加固 LAN 登录相关凭据**落盘后**的强度。现状如下，均已逐项核实：

| 资产      | 现状                                                                                                                                                                                                                      | 代码                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 登录密码  | scrypt `N=2^15 r=8 p=1`，16B salt，32B hash，参数逐行存储                                                                                                                                                                 | `hub/kdf.ts:39-57`、`users` 表                                                  |
| 读取校验  | `N∈[2^14,2^16]`、`p∈[1,2]`、`128·N·r ≤ 32 MiB`，任一不满足即判 corrupt                                                                                                                                                    | `hub/kdf.ts:62-111`                                                             |
| 防枚举    | 用户不存在、记录损坏时都跑一次固定的 `DUMMY_PARAMS`（N=32768）                                                                                                                                                            | `hub/lan-auth.ts:44-47,64-85`                                                   |
| KDF 池    | 逻辑并发 2。**abort 时立即释放槽位，但 libuv 线程池里的 scrypt 不会停止**（`kdf.test.ts:206` 用例标题自己写了 “not literally cancelable”），所以物理并发的真实上限是线程池大小（默认 4，仓库未设置 `UV_THREADPOOL_SIZE`） | `hub/kdf.ts:177-228`                                                            |
| 会话      | 库中只存 `sha256(sid)`，sid 为 256 bit 随机值                                                                                                                                                                             | `hub/sid-hash.ts`                                                               |
| 恢复码    | 12 个 Crockford 字符（60 bit），存 `sha256(salt‖code)`，每用户一个 16B salt                                                                                                                                               | `hub/db-child.ts:182-194,309-321`                                               |
| TOTP 密钥 | 20B **明文** BLOB；`factorRowValid` 要求长度**恰好为 20**                                                                                                                                                                 | `hub/db-child.ts:126-131`                                                       |
| 初始密码  | 新库由维护子进程生成，约 99 bit，**明文**写入 `users.initial_password`，改密时清除；「仍在使用」的判据是 `initial_password IS NOT NULL`                                                                                   | `hub/db-child.ts:73-82,630-640,436,467,473`                                     |
| 文件权限  | db/-wal/-shm 为 0600，`<stateDir>`（`~/.pi/agent/web-hub`）为 0700                                                                                                                                                        | `hub/db.ts:20,296-326`                                                          |
| 密码策略  | 长度 10..256，没有强度检查；hub 侧只校验下限                                                                                                                                                                              | `protocol/lan.ts:207-208`、`hub/admin.ts:427-439`、`agent/passwd-prompt.ts:125` |

**本期范围**（与拍板一致）：

- ① scrypt 升到 `N=2^17`，两段发布；
- ② TOTP 密钥加密存储；
- ③ 设置密码时拒绝弱口令；
- ④ 保留自动生成的初始账号，首次登录成功后清除明文；
- ⑤ 恢复码**不变**，也不与 ② 的密钥绑定（理由见 §4.3）。

**约束**：

- 零运行时依赖，不调用外部二进制。
- 设置密码只有一个入口：TUI `/webhub passwd`。`passwd-prompt.ts` 做预检，`handlePasswd` 做权威校验。网页端发来的 `/webhub passwd|2fa|user` 已被 `agent/commands.ts:268` 拒绝。
- 旧版 hub 读到新格式数据时必须 fail-closed，并且有可执行的恢复路径。
- 不改 SQLite schema（F3），不改任何 strict wire schema（F8）。

## 2. 威胁模型

沿用 `lan-plan.md §1.1`：同 uid 完全可信；其它本机 uid 只受 0700/0600 约束；链路层攻击超出范围。本方案关心的攻击面如下：

| 编号    | 攻击者                                                                                | 能拿到                                                 | ① KDF                         | ② TOTP 加密（密钥放 `~/.local/state`）                                  | ③ 弱口令             | ④ 清明文 |
| ------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------- | -------------------- | -------- |
| **T1a** | 只拿到 `hub.db`（可能带 `-wal`）副本，例如误传、bug 附件                              | 密码 hash、TOTP、恢复码 hash、初始密码明文、登录 IP/UA | 成本约 ×16（内存×时间）       | **有效**：TOTP 解不开，绕过 2FA 退化为「破解密码 + 搜索 60 bit 恢复码」 | 有效（挡掉表内口令） | 有效     |
| **T1c** | 拿到 `~/.pi/agent` 的同步、备份或 dotfiles 副本（**最常见**）                         | 同 T1a，外加 `token`                                   | 同上                          | **有效**：密钥不在 `~/.pi/agent` 下                                     | 有效                 | 有效     |
| T1b     | 拿到整个 home 的备份或整盘镜像                                                        | 全部，含密钥文件                                       | 同上                          | **无效**（README 明说）                                                 | 有效                 | 有效     |
| **T2**  | 局域网在线猜密码，受限流约束（2/s、收紧后 0.5/s、退避、污点），从新 IP 登录还需过 2FA | 会话                                                   | 无效（速率已封顶）            | —                                                                       | **主要防线**         | 有效     |
| T2′     | 局域网 DoS                                                                            | CPU 与内存满载                                         | KDF 越贵，这一面越大（R2/R3） | —                                                                       | —                    | —        |
| T3      | 同 uid 进程或 root                                                                    | 全部                                                   | 超出范围                      |                                                                         |                      |          |

量级参考：scrypt `N=2^15 r=8` 在单块高端 GPU 上约 10^3–10^4 次/秒；升到 `N=2^17` 后内存×时间约为 16 倍。随机 10 位以上的口令在两种参数下都破不开；字典里的口令也只是被拖慢一个常数倍。所以：**③ 负责挡掉最显眼、最先被尝试的口令（在线、离线都受益）；对付离线字典攻击主要靠 ① 和口令长度**。

## 3. 关键事实（逐条约束设计）

- **F1** KDF 跑在 hub 主进程（libuv 线程池）里。db-child 中唯一一次 scrypt 是维护子进程生成初始密码时的 `scryptSync`（`db-child.ts:637`，参数写死 2^15，受 5 s 维护时限约束）。
- **F2** `setPassword` 会 `epoch+1`、清除 `initial_*`、删除全部会话（`db-child.ts:436,520-538`），所以透明升级**不能复用**它。
- **F3** `users.kdf` 带 `CHECK (kdf='scrypt')`；`twofa`/`recovery_codes` 由 `tableMatches` **按精确列数**校验，不符即报 `db-invalid:2fa-schema`。任何 schema 改动都会让旧 hub 关闭 LAN。`TWOFA_SQL` 没有长度 CHECK，因此 53B BLOB 在 schema 层是合法的；旧 hub 拒绝它的地方在 `factorRowValid`。
- **F4** 旧 hub 读到超范围的 KDF 参数时会判 corrupt，跑 dummy，返回 401，并出现 `db-invalid:kdf` 告警（`tests/web-hub/http/lan-kdf-warning.test.ts`）。本机执行 `/webhub passwd` 可以恢复。
- **F5** 恢复码按 `code_hash` 主键查找；若改用 scrypt，会阻塞串行的查询子进程。
- **F6** 测试辅助 `seedLanUser` 用 `n=16384` 播种（`tests/web-hub/http/lan-helpers.ts:439`）；fake store 没有新方法。
- **F7** `createKdf().run` 遇到 abort 会 reject，并在 `finally` 里释放池槽，但 scrypt 照样跑完。客户端断连、`step` 超时都走这条路径。
- **F8** `LanInfoPayloadSchema`（`messages.ts:2263`）和 tfa status（`lan-2fa.ts:129`）都是 `additionalProperties:false`，加字段会让「旧 agent × 新 hub」解码失败，违反 I10。`LanStatus.warnings` 是 `string[]`，旧 agent 遇到未知 token 会静默忽略（`agent/lan-status.ts:153`）。`lan_res`/`tfa_res` 的错误码是字符串（tfa 要求匹配 `^E_[A-Z0-9_]{1,48}$`）。
- **F9** 发版规则（AGENTS.md）：patch 只在 `dev` 发，`master` 只随 minor/major 前进，`pi install git:` 默认分支的用户只拿 minor。因此「隔一个发版」**不能**保证用户按顺序升级。另外 hub 是机器级单例，一个锁在旧版本的项目仍可能把旧 hub 拉起来。
- **F10** `open-check-migrate` 收尾时已经执行 `wal_checkpoint(TRUNCATE)`，但失败只体现在 reply 的 `warning` 字段里，`lan-store.ts runMaint` 把它丢掉了。告警 `initial-password-residue` 在 agent 侧已有文案（`lan-status.ts:148`），**hub 侧从来没有发出过**。
- **F11** `markInitialLogin` 在 `complete()` 中位于 `createSessionChecked` 之后（`lan-login.ts:355-359`）。它失败会抛错，导致已建好的会话被清理，登录返回 503。
- **F12** 查询子进程由 `db-client.ts:238` 拉起，env 为 `{...process.env, PI_WEBHUB_DB_PATH}`。崩溃后由同一个 `DbClientDeps` 重新拉起，所以 env 在 store 生命周期内保持一致。
- **F13** `hub.ts:988` 的 `kdfInFlight` 只包装了 `kdf.run`；`supersede.ts:201` 只在 `kdfInflight()===0` 时才执行安静替换。

## 4. 设计

### 4.0 两段发布与事实门槛

新增纯模块 `hub/hardening.ts`（零 import）：

```ts
export const HARDENING_PHASE: 1 | 2 = 1; // 本期发布为 1；下一期由 P3 翻成 2
export const READER_MARKER_KEY = "hardening_reader";
export const READER_MARKER_VERSION = 1; // v1 = 能读 KDF ≤2^17 且能读 53B TOTP
export const WRITER_SOAK_MS = 14 * 86_400_000; // 读侧标记存在满 14 天后写侧才生效
export function writerActive(phase: 1 | 2, marker: { v: number; since: number } | undefined, now: number): boolean;
// = phase === 2 && marker !== undefined && marker.v >= 1 && marker.since <= now - WRITER_SOAK_MS（since 在未来视为不满足）
```

- **读侧标记**：从 P1 起，维护子进程在 `open-check-migrate` 中检查 `meta.hardening_reader`。缺失则写入 `{"v":1,"since":<now>}`；版本更低时只升 `v`，保留原 `since`。meta 是键值表，新增键不受 schema 校验影响，旧 hub 会忽略它。
- **写侧**包括两件事：KDF 以 2^17 写入（透明升级、改密），以及 TOTP 加密（建密钥、迁移、加密登记）。**两者都只在 `writerActive` 为真时生效**。
- **唯一判定点与传递**（r3 修订 #3）：`writerActive` 只由维护子进程在打开库时判定一次，写入 reply 的 `hardening.writerActive`。`lan-store` 把这一个值同时交给两处：
  - (a) 拉起常驻查询子进程时作为 env `PI_WEBHUB_TOTP_WRITE=1|0` 传入（同时传 `PI_WEBHUB_TOTP_KEY=<密钥路径>`），途径是 `DbClientDeps` 新增的可选字段 `childEnv`，由 `db-client.ts:238` 合并进 spawn env；
  - (b) 放进 `CreateLanStoreResult.hardening`，供 http/admin 选取 KDF 目标。

  查询子进程**从不自己判定**，崩溃重拉时沿用同一个 `childEnv`（F12），所以 store 生命周期内两边一定一致。运行中即使条件满足了，也要等下次 hub 重启才会生效。

- **效果**：用户从 v0.10 直接跳到第二期版本时，首次运行才写入标记，写侧还要再等 14 天，这期间回退到任何版本都不会锁死。只有「运行读侧版本满 14 天后又回退到 P1 之前」会受影响，后果见 §7。
- 第一期发布包含 P1、P2、P4、P5、P6，`HARDENING_PHASE=1`：写侧代码已经合入，但**不生效**。

### 4.1 ① scrypt 升到 2^17，配透明升级

**参数**：`KDF_LEGACY = {n:2^15,r:8,p:1,keyLen:32,saltBytes:16}`，`KDF_PHASE2` 只把 n 改为 2^17。`effectiveWriteTarget(writerActive)` 二选一。

**读侧放宽**（P1，本期生效）：`validateKdfParams` 改为 `N∈[2^14,2^17]`、`128·N·r ≤ 128 MiB`，`p≤2` 不变。

**池按物理完成释放**（P1）：

- `createKdf().run` 改由 scrypt 回调（即物理完成）释放池槽。调用方在 abort 时照样立即 reject，但池槽要等真实计算结束才归还。
- scrypt 一定会回调，不会挂起，满足 I1。物理并发因此 ≤ 2，与线程池大小无关，也给 fs/dns 至少留出 2 个线程。
- **内存上界**：修复前 2^15 下最坏 4×33 ≈ 132 MiB；到 2^17 若不修复会达 4×129 ≈ **516 MiB**；修复后 2^17 为 2×129 ≈ **258 MiB**。

**kdfInFlight 同时覆盖 `runPadded`**（r3 修订 #2）：`hub.ts:988` 的包装改为对 `KdfPort` 的**每个计算方法**（`run`、`runPadded`）都计数，抽成内部小函数 `countInFlight(fn)`，两个方法共用。这样 `supersede.ts:201` 在补偿运行或升级运行期间不会替换 hub。计数口径仍是逻辑在途：abort 后调用方 reject 即减计数；物理残余计算由池槽约束，进程替换时随进程结束，不影响正确性。

**校验目标与 dummy**：

- `verifyTarget = max(effectiveWriteTarget, maxStored)`。`maxStored` 由维护子进程打开库时查出（`SELECT n,r,p FROM users ORDER BY n*r*p DESC LIMIT 1`），放进 reply，形状取该记录自身的参数。
- 未知用户、损坏记录：只跑一次 `dummyParams(verifyTarget)`。
- 第一期所有记录都是 2^15，于是 `verifyTarget = 2^15`，dummy 与现在的 `DUMMY_PARAMS` 完全一致。
- 比写入目标更强的记录会把 `verifyTarget` 一起抬高，不会比未知用户更慢。

**补偿运行**（D6）：

- 有效记录若 `cost(rec) < cost(verifyTarget)`，用 `KdfPort.runPadded?(password, params, pad, opts)` 在**一次池占用内**先跑真实计算、再跑补偿计算。两次物理计算都完成后才返回真实结果，只释放一次池槽，排队次数因此与 dummy 路径相同。
- 补偿参数 `padParamsFor(rec, T) = {n: rec.n, r: T.r, p: ceil((cost(T) − cost(rec)) / (rec.n·T.r)), keyLen: 32, salt: DUMMY_SALT}`，p 上限 64。在当前参数范围内 p ≤ 8，一定能补平。
- fake kdf 没有 `runPadded` 时退回两次 `run`（只出现在测试中）。
- **残余**：补偿计算的内存规模比目标小，缓存行为不同，墙钟可能差 10–30%。A2 实测后写入 README。

**透明升级**（P2；本期合入，写侧生效后才启用）：

- **触发**：`passwordLogin` 在 `kdfMatches` 为真、`!run.revoked` 之后、2FA 门之前，调用 `kdfUpgrader?.maybeRehash(run.user, password)`，fire-and-forget，不 await。只有 `writerActive` 时 http.ts 才构造 upgrader，否则为 `undefined`。privacy verify 不触发升级。
- **执行**（`hub/kdf-upgrade.ts`）：
  - `needsRehash(rec, effectiveWriteTarget)`：只升不降。
  - 每用户单飞，全局同时最多 1 个在途。
  - 每用户失败冷却 5 分钟（`Map<userId, until>`，最多 256 条，过期即清理）。
  - 先用 `newKdfParams(target)` 生成参数，再 `kdf.run`（共用池，不经 admission），20 s deadline（`unref`）。用 `validateKdfParams` 自检后调用 `store.rehashPassword`。
  - 失败只记 warn（不含密码、salt、hash），不影响登录结果。
  - `dispose` 时 abort（I4）。
- **CAS**（新 query op，单条语句，autocommit）：

  ```sql
  UPDATE users SET n=?, r=?, p=?, salt=?, hash=?, updated_at=?
   WHERE id=? AND n=? AND r=? AND p=? AND salt=? AND hash=?
  ```

  - 不带 epoch 条件：`setPassword` 必定换掉随机 salt 和 hash，salt+hash 条件已能防止旧 hash 覆盖新密码；带上 epoch 反而会被 `revokeAllSessions` 白白作废。
  - 不 bump epoch、不删会话、不动 `initial_*`（F2）。

- **改密**：`handlePasswd` 改用 `newKdfParams(deps.kdfWriteTarget())`。第一期仍是 2^15。
- **维护子进程生成初始密码**：保持 2^15。写侧生效后，首次成功登录时由透明升级写成 2^17。

### 4.2 ② TOTP 密钥加密存储（P6）

**密钥位置评估**：

| 选项                                                            | T1a | T1c   | T1b | 代价                                                                            |
| --------------------------------------------------------------- | --- | ----- | --- | ------------------------------------------------------------------------------- |
| **(a) `<home>/.local/state/pi-webhub/totp.key`（Recommended）** | ✓   | **✓** | ✗   | 多一个目录要管理；恢复到新机器后需重新登记 TOTP（这正是「绑定本机」想要的效果） |
| (b) `<stateDir>/totp.key`                                       | ✓   | ✗     | ✗   | 几乎没有价值                                                                    |
| (c) 从 `/etc/machine-id` 用 HKDF 派生                           | ✓   | ✓     | ✗   | machine-id 全局可读，不是秘密；容器里不稳定                                     |
| (d) 系统 keyring                                                | —   | —     | —   | 无头环境不可用，且需要外部二进制                                                |

采用 (a)。路径**只由 hub 的 `home` 推导**（与 `webHubStateDir(home)` 同源，新增 `HubPaths.totpKeyFile`），**不读 `XDG_STATE_HOME`**，避免换个 env 启动就进入 key-missing。README 写明保护范围：只防 db 或 `~/.pi/agent` 单独泄漏，**不防整个 home 被拷走**。secure 会话下，hub 本来就跑在加密卷外（`hubSafeEnv`，即已接受的 R12），密钥文件同样在卷外。

**密钥文件合规性**：32B 原始随机字节，目录 0700，文件 0600。

- 合规 = `lstat` 为普通文件、属主为本 uid、大小恰好 32B。
- 只是权限过宽（属主与大小都对）时，chmod 回 0600 并告警，然后照常采用，与 `checkDbFiles` 一致。
- 其它不合规情形（不是普通文件或是符号链接、属主不对、大小不等于 32）：
  - `rows53>0` ⇒ 判为 `key-missing`，记 detail，**绝不覆盖**；
  - `rows53=0` ⇒ **视为不存在，按下面的建钥流程覆盖，并记一条 warn**（r3 修订 #4）。rename 替换的是目录项本身，符号链接只替换链接，不会写到目标上。如果目标是非空目录，rename 会失败，走「建钥失败」分支：状态 `none`，记 warn。如果密钥目录本身属主不对，目录校验失败，不建钥。
- 查询子进程与维护子进程**各自读取**该文件（路径经 env `PI_WEBHUB_TOTP_KEY` 传入），密钥不经过 IPC。

**指纹与 key-id**：`fp = HMAC-SHA256(key, "pi-webhub-totp-key-check\0v1")`，存入 `meta.totp_key_fp`（base64url）；`kid = fp[0..4]`。

**行格式**（53B，不改 schema）：

```text
0x01 ‖ kid(4) ‖ nonce(12) ‖ AES-256-GCM(secret20) ‖ tag(16)
AAD = "pi-webhub-totp\0v1\0" ‖ uint64BE(user_id)
```

`factorRowValid` 放宽为：长度 20，或者长度 53 且首字节为 `0x01`。

**密钥状态以 `rows53` 为准**（r3 修订 #1；`rows53` 为 53B 行数，`fp` 仅在 `rows53>0` 时有意义）：

| 状态           | 判定                                                                                       | 后果                                         |
| -------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `none`         | `rows53=0`，不看 fp 是否存在或是否匹配。陈旧的 fp 会在下次打开或下次登记时被覆盖           | 没有加密数据，可以（重新）建钥或采用现有密钥 |
| `ok`           | `rows53>0`，密钥合规，且 HMAC 等于 fp                                                      | 正常                                         |
| `key-missing`  | `rows53>0`，密钥文件不存在、不可读或不合规                                                 | 见下                                         |
| `key-mismatch` | `rows53>0`，密钥合规但 HMAC 不等于 fp，或 fp 缺失。单行 kid 与 `fp[0..4]` 不符时只影响该行 | 见下                                         |

**key-missing 和 key-mismatch 是独立状态，绝不归入 `inconsistent`**：

- `factorsConsistent` 照常通过，`open-check-migrate` 不报 db-invalid，**LAN 保持开启**。
- 端口类型 `Lan2faState` 新增可选字段 `totpUsable?: boolean`（缺省视为可用），`state` 仍为 `enrolled`；wire 上的 tfa status 不变。
- **登录**：`newChallenge` 中 `totp: factor.totp && factor.totpUsable !== false`，恢复码与飞书照常。三者都不可用时沿用现有 `!methods.length` 分支，返回 503 `E_DB`，并在 status 告警中说明原因。
- **验证**：`verifyTotp` 解不开（无密钥、kid 不符、GCM tag 失败）时返回内部 reason `unavailable`。`submitFactor` 收到后**退还预算、不调 `limiter.fail`**，状态回到 pending，返回 503 `E_DB`，审计 reason 记 `unavailable`；**不算 bad**。
- **reset2fa**：只把 `totp_secret` 置 NULL，不需要解密，**也无须动 fp**。状态以 `rows53` 为准，最后一条 53B 行被 reset 后自然变成 `none`。
- **repair-2fa**：删表重建；同一事务里顺带删除 `meta.totp_key_fp`（不删也没关系，删掉更整洁）。密钥文件保留。
- **新登记**（`beginTotp`/`commitTotp`，在查询子进程中，由 `PI_WEBHUB_TOTP_WRITE` 决定格式）：
  - `TOTP_WRITE=0`：照旧写 20B 明文。
  - `TOTP_WRITE=1`：`commitTotp` 在事务内**重新读取密钥文件**（登记很少，同步读开销可以忽略；不用启动时缓存的密钥，以免文件在运行中被删或换掉后用了旧密钥），并统计 `others53` = 除本用户外的 53B 行数：
    - `others53=0`，密钥合规：**在同一事务里覆盖 `meta.totp_key_fp = HMAC(key)`**，写入 53B（kid 取新 fp）。
    - `others53=0`，密钥不存在或不合规：降级写 20B 明文，记 warn；下次打开时由维护子进程建钥并迁移。查询子进程不建钥。
    - `others53>0`，密钥合规且 HMAC 等于 fp：写入 53B。
    - `others53>0`，其它情况：拒绝，返回 tfa 错误码 `E_TOTP_KEY`（字面量 append-only，文案固定并附处置提示）。
  - `verifyTotp` 使用启动时缓存的密钥。运行中删掉文件不会影响验证，直到下次重启。
- **状态行**：维护子进程 reply 中的密钥状态会映射为 `LanStatus.warnings` 中的 `totp-key-missing` / `totp-key-mismatch`。agent 新增对应文案：「TOTP 密钥缺失：受影响账号只能用恢复码或飞书登录；本机执行 `/webhub 2fa reset --confirm`（主账号）或 `/webhub 2fa repair --confirm`（全部账号），再 `/webhub restart` 后重新 enroll」。旧 agent 会忽略这两个 token。告警只在启动时计算。

**维护子进程的建钥与 fp 规则**（只在维护子进程中写密钥文件）：

1. `rows53>0`：**永不建钥、永不换钥**，也不改 fp，状态按上表判定。
2. `rows53=0` 且密钥合规（含「仅权限过宽、已修复」）：采用该密钥，**无条件覆盖** `meta.totp_key_fp = HMAC(key)`。即使原 fp 缺失、陈旧或不匹配也覆盖，因为没有任何加密行在用它。
3. `rows53=0` 且密钥不存在或不合规，并且 `writerActive`：执行建钥（不合规文件会被覆盖，记 warn），然后同样**覆盖 fp**。落盘顺序（维护脚本是纯 JS 文本，按 `protocol/token-file.ts` 的模式内联实现）：
   - `mkdirSync(dir, {recursive:true, mode:0o700})`，再校验目录属主与权限，必要时 chmod；
   - `tmp = <file>.<pid>.<rand>.tmp`，`openSync(tmp, "wx", 0o600)`，写入 32B，`fsyncSync`，`close`；
   - `renameSync(tmp, file)`；
   - 对目录 fsync，`EINVAL`/`EISDIR` 视为不支持并忽略，与 token-file 一致；
   - 读回并比对；
   - 任一步出错：清理 tmp，本次不迁移，状态 `none`，记 warn。

   维护子进程是串行的（hub 单例加 `start.lock`），没有并发写者。

4. `rows53=0`、密钥不存在、`writerActive` 为假：什么都不做，状态 `none`。

**按推荐恢复路径走一遍**：已有 53B 行（密钥 A），状态为 `key-missing` → reset（`rows53` 变 0）→ 删除 `totp.key` → `/webhub restart` → 规则 3 建出密钥 B 并覆盖 fp → 状态 `none` → enroll 时 `others53=0`，fp 已等于 HMAC(B)，写入 53B（kid(B)）→ 下次打开状态为 `ok`。不删密钥只重启也一样：规则 2 采用现有密钥并覆盖 fp。

**迁移**（维护子进程 `open-check-migrate`，`writerActive` 且规则 2/3 之后密钥可用时执行）：

1. 在 `BEGIN IMMEDIATE` 事务中，按规则 2/3 写入 fp；对每一条 20B 行执行 `UPDATE twofa SET totp_secret=<53B> WHERE user_id=? AND totp_secret=<旧20B>`。**不 bump `factor_gen`**。然后 `COMMIT`。最多 256 行，AES-GCM 在毫秒级完成，5 s 时限足够。
2. 紧接着执行 `PRAGMA wal_checkpoint(TRUNCATE)`（现有收尾步骤）。reply 新增 `hardening.truncateFailed`，lan-store **不再丢弃它**。`totpMigrated>0 && truncateFailed` 时设置告警 `totp-plaintext-residue`；下次打开会再次 TRUNCATE。
3. **崩溃幂等**：建钥之后、事务之前崩溃，下次打开时 `rows53=0`，走规则 2 采用该密钥，覆盖 fp 再迁移；事务提交之后、TRUNCATE 之前崩溃，下次打开时收尾补做 TRUNCATE。
4. **残留**（README 写明）：TRUNCATE 之前，`-wal` 中仍有旧明文；文件系统层面已释放的块不在本方案范围内；**迁移前做的备份仍含明文**。

**备份与恢复**：

| 情况                                            | 结果                                      | 处置                                                        |
| ----------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| db 与密钥来自同一时点                           | `ok`                                      | —                                                           |
| 只恢复了 db（新机器，或只同步了 `~/.pi/agent`） | `key-missing`                             | 用恢复码或飞书登录；reset 或 repair 后 restart，重新 enroll |
| 密钥与 db 不配对                                | `key-mismatch`                            | 同上                                                        |
| 恢复了迁移前的备份                              | 20B 行；`writerActive` 时下次打开会再迁移 | —                                                           |

**轮换本期不做**。怀疑密钥泄漏时的手工步骤：所有 TOTP 账号执行 reset（或 repair）→ 删除 `totp.key` → `/webhub restart`（规则 3 生成新密钥并覆盖 fp）→ 重新 enroll。kid 与版本字节为将来的在线轮换预留。

**两段发布与旧 hub 回退**：

- 第一期发布读侧：接受 53B、能解密、状态机与告警齐备；`TOTP_WRITE` 恒为 0，所以不建钥、不迁移，登记写明文。
- 第二期翻转写侧，与 KDF 共用 §4.0 的 14 天门槛。
- 写侧生效后回退到第一期版本：能读 53B；登记写 20B，下次第二期打开时再迁移。
- 回退到 ≤ v0.10.x：53B 行会被判 `db-invalid:2fa-missing-row`，**LAN 关闭**；唯一出路是 `/webhub 2fa repair --confirm`，会清空 2FA。README 和 CHANGELOG 写明：回退前先在新版本上执行 `/webhub 2fa reset --confirm`。
- 现有 repair 文案（`twofa-cmd.ts:64,283`、`lan-status.ts:197`）补一句「同时解除 TOTP 密钥绑定，密钥文件保留」。

### 4.3 ⑤ 恢复码：保持现状，不与 TOTP 密钥绑定

恢复码是**密钥丢失时的逃生口**。如果它也用同一把密钥做 HMAC，密钥一丢 TOTP 和恢复码会同时失效。因此恢复码保持 `sha256(salt‖code)`，也不引入第二把密钥。

代价：在 T1a/T1c 场景下，攻击者破解密码后仍可以离线搜索 60 bit 恢复码，约 1.2e17 次 sha256，GPU 集群需数天到数周。TOTP 加密的效果是把绕过 2FA 从「免费」抬高到「破解密码 + 大规模搜索」，并不是做到不可行。

### 4.4 ③ 设置密码时拒绝弱口令（P4）

**规则**（NIST SP 800-63B 口径：不要求字符组合，不设熵阈值）：

1. 长度 10..256，按 UTF-16 码元计数（与现有 `password.length` 一致）；hub 侧**补上上限校验**。
2. 匹配前先 NFKC 归一化再转小写；**存储仍用原串**。
3. `common`：
   - 内置表取公开高频口令前 10 万中长度 ≥10 的子集，约 1–2 万条，以换行拼接的字符串常量存于 `protocol/common-passwords.ts`（约 150 KB），首次调用时惰性构建 `Set`；
   - 另有约 150 个基词：去掉首尾的数字和符号，做 leet 反映射（`@4→a 0→o 1→i/l 3→e 5$→s 7→t`），剩余部分整串等于某个基词即命中；
   - 文件头写明来源、版本与许可证（如 SecLists，MIT，保留出处），不进 UI bundle。
4. `pattern`：单字符重复，或长度 ≤3 的单元重复；等差序列；键盘行连续片段及其反向。
5. `variety`：不同字符数少于 5。
6. `username`：用户名长度 ≥3 且（不区分大小写）出现在口令中；或口令中含 `webhub` / `pi-webhub`。

**落点**：`protocol/password-policy.ts`（零 import），`handlePasswd` 与 `passwd-prompt.ts` 共用。

**hub 拒绝**：返回 `lan_res{ok:false, code:"E_WEAK_PASSWORD", message:"password rejected: <reason>"}`，文案固定、不回显输入；审计记 `audit("passwd", {ok:false, code:"E_WEAK_PASSWORD", reason})`；不调用 `kdf.run`，也不调用 `setPassword`。长度越界仍返回 `E_BAD_REQUEST`。

**不做**：不强制存量密码重设，也不在登录时检测。登录体已限制在 4 KiB（`http.ts:207`），不存在超长口令打 KDF 的 DoS。

### 4.5 ④ 自动生成的初始账号，首次登录后清除明文（P5）

**判据**：

- 初始密码「仍在使用」（记为 `inUse`）⇔ `initial_created_at IS NOT NULL OR initial_password IS NOT NULL`。`stmtUpdateUser` 改密时会把这两列都置 NULL（`db-child.ts:436`）。
- 「明文仍在」⇔ `initial_password IS NOT NULL`。

**清除语句**：在一条语句里完成首登记录与清除。

```sql
UPDATE users SET initial_login_at = COALESCE(initial_login_at, ?), initial_login_ip = COALESCE(initial_login_ip, ?),
                 initial_password = NULL
 WHERE username = ? AND initial_password IS NOT NULL
```

- 返回 `{cleared: changes === 1}`。
- **不带 epoch 条件**（评审 #10 部分采纳，理由已被复审认可）：条件 `initial_password IS NOT NULL` 本身就幂等，也能正确处理与改密并发；带 epoch 的话，遇到 revokeAll 会漏清。
- 端口签名不变，返回值放宽为 `{cleared:boolean} | void`。

**调用点与口径**：

| #   | 位置                                                                            | 改为                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `lan-login.ts complete()`（`:355-359`）                                         | 调用条件仍是 `user.initialPassword !== undefined`；改为 **best-effort**：`try/catch`，失败只记 warn（`initial-password-clear-failed`），**登录照常成功**（改变 F11 的语义，用测试固定），下次登录再试。`cleared` 为真时调用 `store.requestCheckpointTruncate()` |
| 2   | 登录成功响应 `body.initialPassword`（`lan-login.ts:405`）                       | 改为 `inUse(user)`                                                                                                                                                                                                                                              |
| 3   | `getUserSummary.initialPasswordInUse`（`db-child.ts:467`，`http.ts:2258` 使用） | 改为 `inUse` 判据                                                                                                                                                                                                                                               |
| 4   | `initialInfo`（`db-child.ts:438,469-478`，`admin.ts handleInfo` 使用）          | 只在 `inUse` 时返回 `initialLogin`；`initialPassword` 只在明文仍在时返回                                                                                                                                                                                        |

**checkpoint**：`lan-store.requestCheckpointTruncate()` 合并并发请求，调用现有维护操作 `checkpoint-truncate`（3 s，fire-and-forget）。失败时设置告警 `initial-password-residue`，下次启动收尾时会再次 TRUNCATE。

**TUI 展示**（`formatInitialPasswordLines`，wire 不变）：

- 有明文：维持现状。
- 无明文、有 `initialLogin`：显示「初始密码已于 `<时间>` 被 `<ip>` 用于登录，明文已从 hub.db 清除；该账号仍在使用初始密码，若不是你本人登录，立即在本机执行 /webhub passwd。」，并加上原有的修改提醒。
- 两者都没有：不显示。
- 旧 agent × 新 hub：明文清除后旧版不再显示提醒，属于轻微降级（§7）。

## 5. 模块与接口契约

| 模块                                                                                                                                                                                                                                                          | 职责                                                                                                                                                                                                     | 包  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `hub/hardening.ts`（新）                                                                                                                                                                                                                                      | 阶段常量、读侧标记、`writerActive`                                                                                                                                                                       | P1  |
| `hub/kdf.ts`                                                                                                                                                                                                                                                  | `KdfShape`、`KDF_LEGACY`/`KDF_PHASE2`、`effectiveWriteTarget`、`kdfCost`、`newKdfParams`、`dummyParams`、`padParamsFor`、`needsRehash`；`validateKdfParams` 放宽；池改为按物理完成释放；新增 `runPadded` | P1  |
| `hub/lan-auth.ts`                                                                                                                                                                                                                                             | `kdfMatches` 用 `verifyTarget` 作 dummy、用 `runPadded` 做补偿；`LanLoginDeps.kdfPolicy?`（缺省为 `KDF_LEGACY`）                                                                                         | P1  |
| `hub/hub.ts`                                                                                                                                                                                                                                                  | 用 `countInFlight` 包装 `run` 和 `runPadded`（r3 #2）；把 policy 传给 privacy 用的 `LanLoginDeps`（`:1650`）                                                                                             | P1  |
| `hub/db-child.ts`（维护脚本）                                                                                                                                                                                                                                 | 读侧标记；reply 增加 `hardening{readerSince,writerActive,maxKdf}`                                                                                                                                        | P1  |
| `hub/lan-store.ts`、`hub/lan-assembly.ts`                                                                                                                                                                                                                     | 透传 `hardening`；不再丢弃 reply 中的 warning                                                                                                                                                            | P1  |
| `hub/kdf-upgrade.ts`（新），以及 `rehashPassword` op、`ports.ts` 的可选成员、`lan-login.ts` 挂钩、`http.ts` 构造                                                                                                                                              | 透明升级                                                                                                                                                                                                 | P2  |
| `protocol/password-policy.ts`、`protocol/common-passwords.ts`（新），以及 `admin.ts`、`passwd-prompt.ts`                                                                                                                                                      | 弱口令                                                                                                                                                                                                   | P4  |
| `db-child.ts`（`markInitialLogin`/`getUserSummary`/`initialInfo`），以及 `lan-store.ts`（`requestCheckpointTruncate`）、`lan-login.ts`、`agent/lan-status.ts`                                                                                                 | 首登清除明文                                                                                                                                                                                             | P5  |
| `db-child.ts`（PRELUDE、query、维护），以及 `db-client.ts`（`childEnv`，r3 #3）、`lan-store.ts`（生成 `childEnv`）、`ports.ts`、`lan-login.ts`、`admin.ts`（`E_TOTP_KEY`）、`protocol/paths.ts`（`totpKeyFile`）、`agent/lan-status.ts`、`agent/twofa-cmd.ts` | TOTP 加密                                                                                                                                                                                                | P6  |

```ts
// hub/kdf.ts
export interface KdfShape { readonly n: number; readonly r: number; readonly p: number; readonly keyLen: number; readonly saltBytes: number }
export const KDF_LEGACY: KdfShape;   // 2^15/8/1/32/16
export const KDF_PHASE2: KdfShape;   // 2^17/8/1/32/16
export function effectiveWriteTarget(writerActive: boolean): KdfShape;
export function kdfCost(s: { n: number; r: number; p: number }): number;
export function newKdfParams(target: KdfShape): KdfParams;      // defaultKdfParams() 保留为 newKdfParams(KDF_LEGACY) 的别名
export function dummyParams(target: KdfShape): KdfParams;
export function padParamsFor(rec: { n: number; r: number; p: number }, target: KdfShape): KdfParams | undefined;
export function needsRehash(rec: Pick<LanUserRecord, "kdf" | "n" | "r" | "p" | "salt" | "hash">, target: KdfShape): boolean;
// KdfPort（ports.ts）新增可选成员：
runPadded?(password: string, params: KdfParams, pad: KdfParams, opts?: PortOptions): Promise<Uint8Array>;
```

```ts
// hub/ports.ts（全部可选，兼容旧 fake）
interface LanStorePort {
  rehashPassword?(input: { userId: number; old: KdfRow; next: KdfRow }, opts?: PortOptions): Promise<{ ok: true } | { ok: false; reason: "stale" }>;
  markInitialLogin(username: string, ip: string, at: number, opts?: PortOptions): Promise<{ cleared: boolean } | void>;
}
type KdfRow = { n: number; r: number; p: number; salt: Uint8Array; hash: Uint8Array };
interface Lan2faState { /* 现有字段 */ totpUsable?: boolean }
type LanFactorVerdict = { ok: true; recoveryLeft?: number } | { ok: false; reason: "bad" | "replay" | "stale" | "none" | "unavailable" };
interface LanLoginCoreDeps { kdfUpgrader?: KdfUpgrader; kdfPolicy?: { verifyTarget: KdfShape } }
// LanStore（具体类型，不进冻结端口）
requestCheckpointTruncate(): void;
// CreateLanStoreResult.ok 新增：
hardening: { readerSince: number; writerActive: boolean; verifyTarget: KdfShape;
             totpKey: "none" | "ok" | "missing" | "mismatch"; totpMigrated: number; truncateFailed: boolean };

// hub/db-client.ts（r3 #3）
interface DbClientDeps { /* 现有字段 */ childEnv?: Readonly<Record<string, string>> }   // 合并进 spawn env，重拉时沿用
// lan-store 生成：{ PI_WEBHUB_TOTP_WRITE: hardening.writerActive ? "1" : "0", PI_WEBHUB_TOTP_KEY: paths.totpKeyFile }

// hub/kdf-upgrade.ts
export interface KdfUpgrader { maybeRehash(user: LanUserRecord, password: string): void; dispose(): void }
export function createKdfUpgrader(deps: { kdf: KdfPort; store: Pick<LanStorePort, "rehashPassword">; log: HubLog; now(): number;
  target: KdfShape; deadlineMs?: number /*20_000*/; cooldownMs?: number /*300_000*/ }): KdfUpgrader;

// protocol/password-policy.ts
export type LanPasswordReject = "length" | "common" | "pattern" | "variety" | "username";
export function checkLanPassword(password: string, ctx: { username: string }): { ok: true } | { ok: false; reason: LanPasswordReject };
export const LAN_PASSWORD_POLICY_VERSION: number;
```

- 私有 IPC（hub ⇄ db-child NDJSON）：新增 `rehashPassword`；`markInitialLogin` 返回值放宽；维护 reply 新增 `hardening`。
- 子进程 env：沿用既有模式（`PI_WEBHUB_DB_PATH` 等，由 lan-store 显式传入）。hub 主线程**不读取任何新 env**。
- 日志脱敏：不得出现密码、salt、hash、TOTP 秘密、密钥、fp 原文。允许的字段只有 `userId`、`fromCost`、`toCost`、`code`、`state`、`count`。

## 6. wire / 协议与全局不变式

| 面                          | 变化                                                                                                            | 兼容性              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| LAN HTTP                    | 不新增字段；TOTP 不可用时返回已有的 503 `E_DB`                                                                  | 字节一致            |
| `lan_res`                   | 新增错误码 `E_WEAK_PASSWORD`                                                                                    | 旧 TUI 显示 message |
| `tfa_res`                   | 新增错误码 `E_TOTP_KEY`                                                                                         | 旧 TUI 显示 message |
| `lan_res.info` / tfa status | **不改**（strict）；`initialLogin` 只调整何时返回                                                               | 旧 agent 解码正常   |
| `LanStatus.warnings`        | 新增 `totp-key-missing`、`totp-key-mismatch`、`totp-plaintext-residue`；`initial-password-residue` 开始真正发出 | 旧 agent 静默忽略   |
| SQLite                      | schema 不变；新增 meta 键 `hardening_reader`、`totp_key_fp`；`totp_secret` 允许 53B                             | §7                  |

- **I1**：池槽按物理完成释放，scrypt 一定回调；upgrader 与 checkpoint 都有 deadline 且 `unref`；维护子进程的新步骤都在 5 s 内完成。
- **I4**：冷却表与密钥状态都随实例或进程存在；`HARDENING_PHASE` 是常量。
- **I5**：所有新增定时器都 `unref`。
- **I8**：`protocol/password-policy.ts`、`protocol/common-passwords.ts`、`hub/hardening.ts` 零 import，boundary 白名单不需要改。
- **I9**：不新增设置键。LAN 关闭时不打开 store、不构造 login core、不读写密钥文件。
- **I10**：不修改任何 strict schema，不 bump PROTO。
- **I11/D8**：不新增设置路径。hub 与密钥文件都在加密卷外，与已接受的 R12 一致，README 会写明。

## 7. 数据迁移与回滚

| 场景                       | 行为                                                                                                            | 恢复                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 第一期首次启动             | 写入读侧标记；`writerActive` 为假；对 2^15 记录，KDF、TOTP、dummy 行为与 v0.10 一致；首次登录后清除初始密码明文 | —                                                                        |
| 第二期安装，标记未满 14 天 | 行为同第一期                                                                                                    | —                                                                        |
| 第二期安装，满 14 天后     | 透明升级到 2^17；建钥并迁移 TOTP 后执行 TRUNCATE；新登记写 53B                                                  | —                                                                        |
| 写侧生效后回退到第一期版本 | 能读 2^17 和 53B；`verifyTarget` 跟随 `maxStored`；不回写                                                       | —                                                                        |
| 写侧生效后回退到 ≤ v0.10.x | KDF 记录判 corrupt，返回 401，告警 `db-invalid:kdf`；TOTP 53B 行导致 LAN 关闭                                   | KDF：`/webhub passwd`。TOTP：回退前先 reset，否则只能 repair（清空 2FA） |
| 第一期之后回退到 ≤ v0.10.x | 读侧标记被忽略；已清除明文的初始账号被旧版视为「不在使用」，提醒消失                                            | 无须恢复                                                                 |
| 密钥丢失或不匹配           | LAN 保持开启；TOTP 不可用；恢复码、飞书可用                                                                     | reset/repair → restart（规则 2/3 覆盖 fp）→ 重新 enroll                  |
| 备份                       | 迁移前的备份含 TOTP 明文；清除前的备份含初始密码明文                                                            | README 写明                                                              |

发版说明须写明：跳版本或回退的后果、上述恢复步骤，以及 14 天门槛的含义。

## 8. 拆包与文件域

**第一期发布**（`HARDENING_PHASE=1`）：`P1 ∥ P4` → `P2` → `P5` → `P6`（后三者共用 `db-child.ts`/`lan-store.ts`/`lan-login.ts`，必须串行）。
**第二期发布**：`P3`，前提是第一期已经以 minor 版本发出。

| 包                        | 内容                                                                                                                                                                             | 文件域（src）                                                                                                                                                                                                                        | 测试文件                                                                                                                                                                                                                         | 车道   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **P1** 读侧、池、补偿     | §4.0/§4.1：`hardening.ts`、kdf 读侧放宽、按物理完成释放、`runPadded`、`verifyTarget` 与补偿、读侧标记、维护 reply 的 `hardening`、hub.ts 的 `countInFlight` 与 privacy 用 policy | `hub/hardening.ts`（新）、`hub/kdf.ts`、`hub/lan-auth.ts`、`hub/hub.ts`、`hub/db-child.ts`（维护段）、`hub/lan-store.ts`、`hub/lan-assembly.ts`、`hub/http.ts`                                                                       | `kdf.test.ts`、`lan-auth.test.ts`、`db-child.test.ts`、`lan-store.test.ts`、`hub/supersede.test.ts`（或 hub 集成测试中现有的 kdfInflight 用例所在文件）、`http/lan-helpers.ts`（注入 `kdfPolicy`）、`contract/fakes.ts`          | L2     |
| **P2** 透明升级           | §4.1                                                                                                                                                                             | `hub/kdf-upgrade.ts`（新）、`hub/db-child.ts`（query 段）、`hub/db.ts`、`hub/lan-store.ts`、`hub/ports.ts`、`hub/lan-login.ts`、`hub/http.ts`、`hub/admin.ts`                                                                        | `kdf-upgrade.test.ts`（新）、`lan-store.test.ts`、`db-child.test.ts`、`lan-login.test.ts`、`admin.test.ts`、`http/lan-login-integration.test.ts`                                                                                 | **L3** |
| **P4** 弱口令             | §4.4                                                                                                                                                                             | `protocol/password-policy.ts`（新）、`protocol/common-passwords.ts`（新）、`hub/admin.ts`、`agent/passwd-prompt.ts`                                                                                                                  | `protocol/password-policy.test.ts`（新）、`admin.test.ts`、`agent/passwd-prompt.test.ts`                                                                                                                                         | L2     |
| **P5** 首登清除明文       | §4.5                                                                                                                                                                             | `hub/db-child.ts`、`hub/lan-store.ts`、`hub/ports.ts`、`hub/lan-login.ts`、`hub/http.ts`、`agent/lan-status.ts`                                                                                                                      | `lan-store.test.ts:44-234`、`hub/hub-lan.test.ts:369-431`、`lan-login.test.ts`、`agent/lan-status.test.ts`、`tests/integration/web-hub-lan.test.ts:174-283`、`web-hub-control.test.ts:959-1180`、`web-hub-headless.test.ts:1210` | L2     |
| **P6** TOTP 加密          | §4.2                                                                                                                                                                             | `hub/db-child.ts`（PRELUDE、query、维护）、`hub/db-client.ts`（`childEnv`）、`hub/lan-store.ts`、`hub/ports.ts`、`hub/lan-login.ts`、`hub/admin.ts`、`hub/http.ts`、`protocol/paths.ts`、`agent/lan-status.ts`、`agent/twofa-cmd.ts` | `db-lan-security.test.ts`、`lan-store-security.test.ts`、`db-client.test.ts`、`admin-tfa.test.ts`、`lan-login.test.ts`、`totp.test.ts`、`contract/lan-security-store.test.ts`、`totp-key.test.ts`（新）                          | **L3** |
| **P3** 翻转阶段（第二期） | `HARDENING_PHASE=2`；更新冻结断言；补 README、lan-plan §5.1/§5.2、lan-security-plan §5.2 的指针                                                                                  | `hub/hardening.ts`、`docs/dev/web-hub/README.md` 及两份 plan                                                                                                                                                                         | `kdf.test.ts`、`hardening.test.ts`                                                                                                                                                                                               | L1     |

文档同步：P1、P5、P6 各自更新 README 的 LAN security 段。`lan-status.ts:199` 的文案在 D4 下仍然成立，P5 核对后保留。

## 9. 测试清单

**P1**

- `validateKdfParams`：接受 2^17；拒绝 2^18、`N=2^17 r=16`、`p=3`。
- `writerActive` 真值表：phase=1 恒为假；phase=2 时无标记、未满 14 天或 since 在未来均为假；满 14 天为真。
- 读侧标记：首次写入；再次打开不改 since；只升级 v。
- 池按物理完成释放：用假 scrypt，abort 后调用方立即 reject，但第 3 个调用要等物理回调后才开始；物理在途 ≤ 2。另跑一个真实 scrypt 的 abort 洪泛用例，借计数 hook 断言物理并发 ≤ 2。
- `runPadded`：只 acquire 一次；两次物理计算都完成才 resolve；abort 时只释放一次。
- **kdfInFlight 覆盖 runPadded**（r3 #2）：用受控的假 `runPadded`（补偿阶段挂起），断言 `kdfInflight()` 为 1，安静替换（`supersede.ts:201` 的判定）不执行；补偿完成后计数回到 0，替换得以继续。`run`（含 upgrader 的调用）有同样的断言。抛错时也会减计数。
- **计时防枚举**（用 spy，不量墙钟）：`verifyTarget=2^17` 时，以下各情况的 Σcost 与 acquire 次数（均为 1）全部相同：未知用户、target 记录对/错、2^15 记录对/错、`N=2^16 p=2` 的强记录、`r=1` 的记录。损坏记录只跑 dummy。
- **生产记录不变**：不注入 policy 时，2^15 记录与未知用户的 `kdf.run` 调用次数和参数都与 v0.10 一致；2^14 种子多一次补偿（声明过的行为变化）。测试辅助注入 policy 后，现有断言保持不变。
- privacy verify 的 cost 断言与登录一致。

**P2**

- CAS：命中时只改参数与 hash；salt/hash 不符或用户已删时返回 `stale`；`revokeAllSessions` 之后升级仍然成功。
- 并发：单飞；`setPassword` 先提交则 `stale`，之后新密码可登录、旧密码不行；`createSessionChecked` 不受影响。
- 失败冷却：5 分钟内不再触发；过期后重新触发；冷却表上限 256。
- `writerActive` 为假时不构造 upgrader，没有额外 KDF。
- 端到端：2^15 用户登录 → 后台升到 2^17 → 再次登录不再触发 → 原会话仍有效。
- 零挂起与脱敏：dispose 时 abort、定时器 `unref`、`kdfInFlight` 回零；日志中不出现密码、salt、hash。
- `handlePasswd` 按 `writerActive` 写入 2^17 或 2^15。

**P4**

- 正例：4 词随机短语、`Tr0ub4dor&3x9`、10 字以上的中文短语。
- 每类反例至少 3 个：`password123`、`Password2024!`、`p@ssw0rd!!`、`qwertyuiop`、`9876543210`、`abcabcabca`、`aaaaaaaaaa`、`alice-secret-1`（用户名 alice）、`my-webhub-pass`。
- 长度边界：9/10/256/257 个码元；含代理对；全角字符经 NFKC 后长度不同时，以原串长度为准；与 `MAX_LAN_PASSWORD_LENGTH` 一致。
- 表版本 `LAN_PASSWORD_POLICY_VERSION` 与条目数锁定；首次调用前不构建 `Set`。
- hub：返回 `E_WEAK_PASSWORD`，message 不含输入，审计只记 code 与 reason，不调用 `kdf.run`/`setPassword`；超长口令返回 `E_BAD_REQUEST`。
- agent：预检失败时不发 `lan_req`；未知错误码透传。

**P5**

- 首次登录（任一方式）后：`initial_password` 为 NULL，`initial_login_*` 已写入，`initial_created_at` 保留；响应 `initialPassword:true`；`initialPasswordInUse:true`；`info` 带 `initialLogin`、不带明文；TUI 显示新提示行。
- 第二次登录不再执行清除；改密后三处口径一致变为「不在使用」。
- 清除失败时登录仍返回 200，只记一条 warn，下次登录重试。
- 清除与 `setPassword` 并发：`cleared:false`，不报错。
- checkpoint：清除后在 db/-wal 中 grep 不到明文；TRUNCATE 失败时出现 `initial-password-residue`；重启后消失。
- 旧 agent 渲染基线：清除后不显示（声明过的降级）。
- 评审 #19 列出的集成测试补充「首次登录后明文消失」的断言。

**P6**

- 格式：往返加解密正确；改动任一字节，或 AAD 换成别的 user_id，都解不开；`factorRowValid` 接受 20B 和首字节 `0x01` 的 53B，拒绝其它长度以及首字节不对的 53B。
- 状态矩阵（以 rows53 为准）：
  - `rows53=0` 且 fp 缺失、陈旧或与现有密钥不匹配 ⇒ **都是 `none`**，打开后 fp 被覆盖为 HMAC(现密钥)（r3 #1）；
  - `rows53>0` ⇒ `ok`、`missing`（文件不存在、属主不对、31B、符号链接）、`mismatch`（换了密钥、fp 缺失、单行 kid 不符）；
  - 以上各情形 LAN 均保持开启。
- **推荐恢复路径端到端**（r3 #1）：密钥 A 下已有 53B → 删除密钥后重启得到 `key-missing` → reset → 再删密钥后重启，生成新密钥 B，fp 等于 HMAC(B) → 状态 `none` → enroll 成功并写 53B（kid(B)）→ 重启后状态 `ok` 且可验证。另测一条「reset 后不删密钥直接重启」：采用现有密钥、覆盖 fp、enroll 成功。
- **运行中、不重启的登记**（r3 #1）：reset 使 `others53=0` 后，commit 会重新读取密钥文件，并在同一事务中覆盖 fp 再写 53B。若文件已被删除，则降级写 20B、记 warn，下次打开时迁移。`others53>0` 且密钥不匹配时返回 `E_TOTP_KEY`。
- **不合规密钥文件**（r3 #4）：`rows53=0` 时，大小不为 32、属主不对、是符号链接，都会被覆盖为新密钥（符号链接的目标文件不受影响），记一条 warn，fp 被覆盖；目标是非空目录时建钥失败，状态 `none`，记 warn；密钥目录属主不对时不建钥。`rows53>0` 时不合规文件一律判 `key-missing`，用 fs spy 断言没有写入。只是权限过宽（0644，属主与大小都对）时 chmod 修复后采用。
- **writerActive 传递**（r3 #3）：维护 reply `writerActive=true` ⇒ `childEnv.PI_WEBHUB_TOTP_WRITE="1"` ⇒ commit 写 53B；为 false ⇒ "0" ⇒ 写 20B。查询子进程被 kill 后重拉，env 不变，格式不变（`db-client.test.ts`）。查询子进程自身不计算门槛（源码断言脚本中不出现 `WRITER_SOAK`）。
- 登录：`missing` 时 challenge 不含 totp；`unavailable` 时退还预算、不调 `limiter.fail`、返回 503、审计 reason 为 `unavailable`；三种方式全部不可用时返回 503。
- reset2fa 与 repair 在 `missing`/`mismatch` 下都能成功。
- 建钥落盘顺序：fs spy 断言 `wx → fsync → rename → syncDirectory`；任一步注入失败，tmp 被清理，状态 `none`。
- 迁移：20B 全部变为 53B，`factor_gen` 不变；在「建钥之后、事务之前」注入崩溃，重启后采用该密钥、覆盖 fp 并完成迁移；在「提交之后、TRUNCATE 之前」注入崩溃，重启后补做 TRUNCATE；迁移后 grep 不到旧明文；TRUNCATE 失败时出现 `totp-plaintext-residue`。
- 两段发布：phase=1 时不建钥、不迁移、登记写 20B，但能验证已存在的 53B；phase=2 未满 14 天时与 phase=1 相同。
- 旧 hub 锚点：冻结的 v0.10 `factorRowValid` 判 53B 无效。
- 路径只由 `home` 推导，不受 `XDG_STATE_HOME` 影响。日志中不出现秘密、密钥、fp 原文。

**P3**：`HARDENING_PHASE=2` 的冻结断言；跑一次真实 2^17 scrypt（慢测试）。

**全局门禁**：`git diff --quiet origin/dev -- tests/fixtures/`；依次通过 `npm run format:check`、`typecheck`、`test`、`build`。

**真机验收**

- A1：2^17 登录的 p50/p95，hub RSS 峰值（含 abort 洪泛场景，期望物理并发 ≤ 2、内存增量 ≤ 300 MiB）。
- A2：三类「密码错误」各 50 次，记录墙钟中位数差。
- A3：在临时副本上回退到第一期版本能登录；回退到 v0.10.0 时按 §7 恢复。
- A4：TOTP 迁移后只恢复 `~/.pi/agent` 到新 home，出现 `key-missing`，用恢复码能登录；按推荐恢复路径操作后重新 enroll 成功。

## 10. 风险

| #   | 风险                                                   | 缓解                                                                                        |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| R1  | 回退到 ≤ v0.10.x 时 KDF 锁死、LAN 关闭                 | 14 天门槛；发版说明；fail-closed；本机恢复路径                                              |
| R2  | 2^17 下 KDF 峰值约 258 MiB（不修池释放会到约 516 MiB） | P1 修复释放时机；A1 实测 abort 洪泛                                                         |
| R3  | T2′ DoS：每次失败的 CPU 变为 4 倍                      | admission 速率不变，最坏约 0.8 核，收紧后约 0.2 核；物理并发 ≤ 2                            |
| R4  | 补偿运行只能近似等时                                   | A2 实测；用户名在本项目中本来就不算秘密                                                     |
| R5  | 测试漂移（2^14 种子）                                  | 从 P1 起测试辅助都注入 `kdfPolicy`                                                          |
| R6  | upgrader 中密码明文最多多驻留 20 s                     | 有 deadline，不写日志                                                                       |
| R7  | 密钥丢失导致 TOTP 不可用                               | 恢复码不绑定密钥；独立状态与文案；「rows53=0 覆盖 fp」保证恢复路径能走通                    |
| R8  | 整个 home 泄漏时 TOTP 加密无效                         | README 写明保护范围                                                                         |
| R9  | 迁移前、清除前的备份以及 WAL 中的明文残留              | 迁移或清除后立即 TRUNCATE，失败即告警；README 写明                                          |
| R10 | 维护子进程中的 `scryptSync`                            | 保持 2^15，首次登录时再升级                                                                 |
| R11 | 口令表的体积与许可证                                   | 约 150 KB 纯数据，不进 UI bundle，注明出处                                                  |
| R12 | 14 天门槛偏保守                                        | 常量可调，README 写明                                                                       |
| R13 | 运行中 reset 后告警状态不刷新                          | 文案提示 restart；登记路径会重新读取密钥、按 `others53` 判断，所以运行中重新登记仍然正确    |
| R14 | 「rows53=0 时覆盖」会清掉一个不合规但其实有用的文件    | 判定前提是没有任何加密行，被覆盖的文件不可能解开任何数据；记 warn；不会跟随符号链接写到目标 |

## 11. 实施要点

- P2、P5、P6 串行合入，每一包都先 rebase。
- 维护与查询脚本都是 CommonJS 文本：AES-GCM、HMAC、fs 落盘全部内联，常量以 `JSON.stringify` 嵌入。测试经 `buildMaintScript({hardeningPhase, now, totpKeyPath})` 与 `childEnv` 覆盖参数；hub 主线程不读任何新 env。
- 每包完成后派 verifier，验收模型不得与开发模型相同（dev-flow）。P2/P6 重点审 CAS 条件、建钥与 fp 覆盖条件（只在 `rows53=0` / `others53=0` 时）、`childEnv` 传递、日志脱敏。

## 12. 已否决

- r1 推荐的「② 本期不做」：被 D3 否决。
- r1 推荐的「④a 新库不再自动生成账号」：被 D4 否决，Q14/L6 保持不变。
- 用「隔一个发版」保证两段发布：前提不成立（F9），改为 §4.0 的事实门槛。
- 用 TOTP 密钥给恢复码加 pepper：密钥丢失时就没有逃生口了。
- 密钥放 `<stateDir>`：挡不住最常见的 `~/.pi/agent` 泄漏。
- 由 machine-id 派生密钥、使用系统 keyring：见 §4.2 的位置评估。
- 用同长度 XOR 掩码兼容旧 hub：属于非标准构造，旧 hub 会静默拒绝 TOTP。
- onion 包裹：需要改 schema（F3）。
- 复用 `setPassword` 做升级：F2。
- 在请求路径上同步升级：增加登录延迟，占用 admission。
- 升级与清明文的 CAS 带 epoch 条件：会被 revokeAll 误伤。
- 给 `LanInfoPayload` 或 tfa status 加字段：违反 I10（F8）。
- 恢复码改用 scrypt：F5。
- 字符组合规则与熵阈值：被 D5 否决。
- 登录时检测存量弱口令：需要新 wire 字段，且延长明文停留时间。
- 「fp 缺失才写」「仅建钥时写 fp」：会让推荐恢复路径落入 key-mismatch（复审 #1），改为 rows53=0 时一律覆盖。
- 查询子进程自行计算 writerActive：两边时钟或读取时机不同会导致结论不一致，改为由维护子进程唯一判定后通过 env 下发（复审 #3）。

## 13. 用户拍板（2026-10-26，覆盖正文冲突处）

- D1+D2：N=2^17 r=8 p=1，**两段发**（本版只让新 hub 能读 2^17，透明升级写入下一版才开）。
- D3：**TOTP 密钥加密存放，本期做**（正文推荐不做，以此为准；方案需补密钥存放位置、迁移、备份/恢复、密钥丢失恢复路径）。
- D4：**保留自动生成初始账号**（不推翻 Q14/L6），但**首次登录成功后清除明文初始密码字段**。
- D5：黑名单 + 键盘/重复规律 + 包含用户名；不加字符组合要求与熵阈值。
- D6：迁移期防枚举计时补偿，做。

> 落实说明：D2 的「下一版」按 F9 改为「第二期发布 + 14 天读侧门槛」（§4.0）。D3、D6 的细节分别见 §4.2、§4.1。

## 14. r2 修订对照表（回应 `/tmp/review66.md`）

| #   | 评审问题                                              | 处理     | 怎么改 / 不采纳的理由                                                                                                                                                                       |
| --- | ----------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D3 没有可施工的设计                                   | 采纳     | ② 升格为正式包 P6（§4.2），带完整测试（§9 P6）；⑤ 明确不做（§4.3）                                                                                                                          |
| 2   | 密钥丢失被误分类，`reset2fa` 被堵，解密失败被记为 bad | 采纳     | 新增独立的 `key-missing`/`key-mismatch` 状态；登录时只去掉 totp；reset、repair 都不需要解密；新增 `unavailable` reason，退还预算、不计失败                                                  |
| 3   | 没有评估密钥放哪才有价值                              | 采纳     | 对比四个选项，推荐 `<home>/.local/state/pi-webhub/totp.key`；README 写明保护范围；路径不受 XDG 变量影响                                                                                     |
| 4   | 迁移次序与原子性；可能静默换钥                        | 采纳     | 只在 `rows53=0` 时建钥或换钥；落盘顺序 `wx → fsync → rename → syncDirectory` 后读回校验；崩溃幂等；只有维护子进程写密钥                                                                     |
| 5   | 迁移后明文残留                                        | 采纳     | 迁移后立即 TRUNCATE，lan-store 不再丢弃结果，失败发告警并在下次重试；README 写明                                                                                                            |
| 6   | 缺 key-id 与轮换方案                                  | 采纳     | meta 存 fp，行格式加 4B kid；明确本期不做轮换，写明手工步骤                                                                                                                                 |
| 7   | TOTP 回退更严重，两段发布未覆盖                       | 采纳     | TOTP 与 KDF 共用阶段常量和门槛；§7 写明回退后果，建议回退前先 reset                                                                                                                         |
| 8   | 恢复码不应与密钥绑定                                  | 采纳     | 恢复码保持 sha256，代价写进 §4.3                                                                                                                                                            |
| 9   | 首登清明文缺新判据                                    | 采纳     | 引入 `inUse` 判据，四处调用点全部改；TUI 新增提示行；不改 wire                                                                                                                              |
| 10  | 清除写法、epoch、失败语义与残留                       | 部分采纳 | 采纳：同一条语句完成记录与清除；清除失败不影响登录；清除后 TRUNCATE，失败告警。**不采纳 epoch 条件**：`initial_password IS NOT NULL` 本身已幂等；带 epoch 会被 revokeAll 误伤（复审已认可） |
| 11  | P5 是过期设计                                         | 采纳     | 重写为首登清除明文；删除 ④a；R10 改为维持 2^15、首次登录再升级                                                                                                                              |
| 12  | KDF 内存上界写错；abort 不回收资源                    | 采纳     | 核实属实（F7）；池改为按物理完成释放；上界改为 258 MiB（不修复为 516 MiB）；A1 增加 abort 洪泛                                                                                              |
| 13  | 两段发布的前提不成立                                  | 采纳     | 核实属实（F9）；改为读侧标记 + 14 天门槛；第二期须在第一期以 minor 发出之后                                                                                                                 |
| 14  | 补偿运行两次排队；强记录与不同 r 补不平               | 采纳     | `runPadded` 一次占用池槽；`verifyTarget` 跟随 `maxStored`；补偿固定 `r=T.r`，p 上限 64                                                                                                      |
| 15  | P1「字节级不变」不成立                                | 采纳     | 改为承诺「2^15 生产记录与未知用户不变」；测试辅助注入 policy；第一期不构造 upgrader                                                                                                         |
| 16  | upgrader 没有退避；epoch 条件误伤                     | 采纳     | 增加 5 分钟冷却；CAS 去掉 epoch 条件                                                                                                                                                        |
| 17  | 口令表太小，却称「收益最高」                          | 采纳     | 表扩大到 1–2 万条；§2 改口径                                                                                                                                                                |
| 18  | 错误码、长度口径、非 ASCII                            | 采纳     | 统一错误码与审计；长度按 UTF-16 码元、匹配用 NFKC、存储原串；补边界测试                                                                                                                     |
| 19  | 遗漏的文档、文案与测试                                | 采纳     | 补进 P5/P6 的文件域与测试                                                                                                                                                                   |
| 20  | 拆包需要重排                                          | 采纳     | 第一期 `P1∥P4 → P2 → P5 → P6`，第二期 P3                                                                                                                                                    |
| 21  | 缺 I9/I11 论证与 secure 会话下的密钥落点              | 采纳     | §6 逐条论证；密钥在加密卷外，与 R12 一致                                                                                                                                                    |

## 15. r3 修订（回应 sonnet 复审：有条件通过，0 blocker）

| #         | 复审意见                                                                                                                         | 处理 | 改动位置与做法                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 [major] | fp 在重建密钥的路径上不刷新：reset2fa 不删 fp，迁移只在缺失时写，建钥分支也不写。按推荐恢复路径操作会落入 key-mismatch，登记被拒 | 采纳 | §4.2：①「密钥状态」改为**以 rows53 为准**，`rows53=0` 时一律为 `none`，fp 不参与判定；② 维护子进程规则 2/3：`rows53=0` 时**无条件覆盖** `meta.totp_key_fp = HMAC(当前密钥)`（采用现有密钥或新建密钥两种情况都覆盖）；③ reset2fa 无须动 fp；④ 查询子进程登记时重新读取密钥文件，若 `others53=0` 就在同一事务中覆盖 fp，保证运行中、不重启也能正确重新登记；⑤ 新增「推荐恢复路径走一遍」。测试：§9 P6 的状态矩阵（陈旧 fp 视为 `none`）、推荐恢复路径端到端、运行中登记；A4 增加恢复路径。§12 记入已否决口径 |
| 2 [minor] | kdfInFlight 只包装了 `kdf.run`，`runPadded` 不计入，安静替换可能在补偿运行中发生                                                 | 采纳 | §3 F13、§4.1：`hub.ts` 用 `countInFlight` 同时包装 `run` 与 `runPadded`（P1）；§5 模块表更新。测试：§9 P1 新增「补偿挂起期间 `kdfInflight()=1`、安静替换不执行；完成或抛错后归零」                                                                                                                                                                                                                                                                                                                         |
| 3 [minor] | writerActive 怎么传给常驻查询子进程没写清楚                                                                                      | 采纳 | §3 F12、§4.0：维护子进程是**唯一判定点**；lan-store 把 reply 中的 `writerActive` 经 `DbClientDeps.childEnv`（新增可选字段，合并进 `db-client.ts:238` 的 spawn env）以 `PI_WEBHUB_TOTP_WRITE=1                                                                                                                                                                                                                                                                                                              | 0`（连同 `PI_WEBHUB_TOTP_KEY`）下发，崩溃重拉时沿用；同一个值也放进 `CreateLanStoreResult.hardening`供 KDF 使用。§5 契约与 P6 文件域加入`db-client.ts`。测试：§9 P6「writerActive 传递」（含重拉后不变、子进程不自行计算门槛） |
| 4 [minor] | `rows53=0`、密钥文件存在但不合规时如何处理没写                                                                                   | 采纳 | §4.2「密钥文件合规性」：`rows53=0` 时视为不存在，按建钥流程覆盖并记 warn（符号链接只替换链接本身；目标是非空目录时建钥失败，状态 `none`；目录属主不对时不建钥）；只是权限过宽时 chmod 后采用；`rows53>0` 时一律判 `key-missing`，绝不覆盖。规则 3 同步。测试：§9 P6「不合规密钥文件」；风险 R14                                                                                                                                                                                                            |
