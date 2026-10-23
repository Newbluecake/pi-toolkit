# P2 报告：插件守护（data-encryption plan r4 + §R4 + §P0）

日期 2026-10-23 · 分支 dev · 未 commit。启动器（P1，`src/secure/bin/*`）由另一 agent 并行开发，本包未 import 它的文件；两边只靠配置和 env 契约对接，并用共享 fixture 做 parity 校验。

## 1. 判定时序

| #   | 时点                                                                                                                 | 代码                                                                                                | 做什么                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `activate()` 第一条语句，在 `wrapCommandApi`、`readSettingsNoMigrate()`（现 `src/index.ts:~190`）、HOST_KEY 判定之前 | `src/index.ts:163` `initSecureDomain()` → `src/secure/domain.ts`                                    | 读 `~/.pi/agent/pi-subagent.json`，只取原始 `secure` 段（`parseSecureConfig`，纯函数）。判定式为 `vault = env PI_SECURE_VAULT ?? cwd 命中`，再结合挂载判定得出 secure / locked / plain。结果冻结在 `Symbol.for("pi-subagent:secure-domain")`，按进程冻结：子会话和 `/reload` 复用同一值，不使用 module-scope 状态。判为 secure 时：`PI_SECURE_ORIG_ENV` 仅在缺失时写入；把 `TMPDIR` 设为 `<state>/tmp`（同时 mkdir 0700），`ARMORY_MEMORY_ROOT` 设为 `<state>/memory`，并设置 `PI_SECURE_SESSION=1`、`PI_SECURE_VAULT=<name>` |
| 2   | 所有 settings 读取                                                                                                   | `src/config/settings.ts` `loadSettings` 改为 `applySecureDomainOverrides(parseSettingsSource(src))` | `loadSettingsFromFile` 和 `readSettingsNoMigrate` 两个入口都经过这里。secure 时 `bashJobs.dir=<state>/bash-jobs`，同时影响 `stack.ts:783-793` 的写入根、`stack.ts:3326` 的恢复扫描、`bash/child.ts:262` 的子会话；`workflow.journalDir=<state>/workflows`（`stack.ts:3428`）。secure 和 locked 都把 `fabric.crossSession`、`externalAgents.droid`、`feishuNotify` 置为 off。改动的嵌套对象一律先克隆；plain 或无判定时返回**同一对象**                                                                                        |
| 3   | 守护钩子注册：在 isChildSession 确定之后、其他所有 `pi.on` 之前（pre-guard）                                         | `src/index.ts:204` `wireSecureGuards`                                                               | 注册 `tool_call`、`input`、`user_bash`、`session_before_switch`；只有主会话再注册 `session_start`。同一扩展内 pi 按注册顺序执行，首个 `handled`、`block` 或 `cancel` 生效，所以守护必须排在最前（off-golden 测试钉住了这个顺序）                                                                                                                                                                                                                                                                                              |
| 4   | 每次 `session_start`（仅主会话）                                                                                     | `guards.ts` `verifySessionFacts`                                                                    | secure：重新判定挂载，检查 cwd 在 `<R>/mnt` 内，持久化会话的 `getSessionDir()` 和 `getSessionFile()` 在 `<state>/sessions/` 下。`--no-session`（文件为 undefined 且 dir 为 `""`）免检文件和目录。plain：cwd、会话文件或会话目录落在任一 vault ⇒ LOCKED。冻结结果为 locked ⇒ LOCKED。核验不符时设置运行期锁，`notify(error)` 后设置 `setStatus("pi-subagent:secure", "secure:locked")`；下一次核验一致的 `session_start` 会解锁。不会自动 shutdown                                                                             |
| 5   | session_start 尾部                                                                                                   | `index.ts:1455`                                                                                     | `stack.scheduler.start()` 仅在 plain 下调用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 2. 守护点清单

| 拍板 / §4              | 守护点                                                                                                                                                                                                                                                                                                                      | 实现                                                                                                                            | 测试                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| LOCKED                 | 所有来源的 input ⇒ `handled` 并 notify；所有工具 ⇒ block；`user_bash` ⇒ `{result:{exitCode:1}}`；`session_before_switch` ⇒ cancel（冻结为 locked 时）                                                                                                                                                                       | `guards.ts` `wireSecureGuards`                                                                                                  | guards.test「LOCKED session」「later consistent session_start lifts」                                                               |
| D2                     | worktree 隔离被拒，抛出 failed(config)                                                                                                                                                                                                                                                                                      | `extensions/worktree.ts:267`（H2，在任何 git 调用之前）；workflow 的 `worktreeAvailable` 在 `stack.ts:3399` 非 plain 时为 false | guard-points「D2」（secure 不调 git，plain 照常进入 git）                                                                           |
| D3                     | secure 下 write/edit 的目标取「最近已存在祖先的 realpath + 余下路径」，不在写入区内就 block。写入区是 `<R>/mnt/work` 或 `<R>/mnt/state` 之下（**不含**这两个哨兵路径本身，也不含 `mnt/` 根层的其他条目）；secure 进程每次工具调用和输入都会重新判定挂载，见安全评审修复 #1。处理 `@` 前缀和 `~`；指向库外的符号链接同样拦截 | `guards.ts` `decideToolCall`                                                                                                    | guards.test「D3」                                                                                                                   |
| D4                     | plain 且配置了 vault 时：read/write/edit/grep/find/ls 的路径（缺省为 cwd）落在 `<dir>`（含 cipher）、入口链接或其 realpath 下 ⇒ block。bash 命令文本中出现 vault 的绝对路径、`~/…` 或 `$HOME/…` 前缀（带路径边界）⇒ block，属于尽力而为                                                                                     | 同上，`bashTouchesVault`                                                                                                        | guards.test「D4」                                                                                                                   |
| D8                     | xs、droid、feishu-notify 由 settings 覆盖关闭；cron：index 跳过 `start()`，`scheduler.ts` 中 `start()` 直接返回（不读 store），`register()` 抛错（双保险）                                                                                                                                                                  | settings.ts、index.ts:1455、`schedule/scheduler.ts` `cronRefusal`                                                               | settings-override、guard-points「D8」                                                                                               |
| §4 子会话              | secure ⇒ `SessionManager.create(cwd, <state>/sessions/default)`；plain 仍是原来的 `create(cwd)` 调用；locked ⇒ reject，不建会话                                                                                                                                                                                             | `session-driver.ts:858` 附近                                                                                                    | guard-points「session-driver」                                                                                                      |
| 跨域 resume / 切换     | driver `resume()` 打开文件前 `assertSessionFileInDomain`（secure 要求文件在 `<R>/mnt` 内，plain 要求不在任何 vault 内，locked 拒绝）；`session_before_switch` 遇到跨域目标 ⇒ `{cancel:true}` 并 notify                                                                                                                      | `session-driver.ts:~902`、`guards.ts` `decideSwitch`                                                                            | domain.test、guard-points、guards.test                                                                                              |
| §4 consult fork        | `consultSessionDir()` 在 secure 下返回 `<state>/cache/consult-sessions`。创建、main fork、`removeForkFile` 的默认根（`fork-store.ts:808`）、sweep（`stack.ts:2232/3068`）、`wireConsult` 的 consultDir/expert index 都走这一个函数，共用同一个根                                                                            | `fork-store.ts:84`                                                                                                              | guard-points「consult fork root」、stack-roots（真 stack：vault 根被 sweep，agent 根不动）                                          |
| §4 bash job / workflow | settings 覆盖                                                                                                                                                                                                                                                                                                               | settings.ts                                                                                                                     | stack-roots（真 `buildSessionStack`，`<state>/bash-jobs/<sid>/session-id` 实际落盘，agent 目录下没有 bash-jobs）、settings-override |
| §4 memory / 临时文件   | `ARMORY_MEMORY_ROOT`、`TMPDIR`                                                                                                                                                                                                                                                                                              | domain.ts `enterSecureEnv`                                                                                                      | domain.test                                                                                                                         |
| §4 session-nav 缓存    | sessionDir 为 `<state>/sessions/default` 时，缓存在 `<state>/cache/session-nav/…`                                                                                                                                                                                                                                           | 无需改代码                                                                                                                      | guard-points「§4 session-nav」                                                                                                      |
| §2.7 env 清洗          | `hubSafeEnv`（`src/secure/env.ts`，零 import）：删除 `PI_SECURE_*`，按 ORIG 恢复或删除 `TMPDIR`、`ARMORY_MEMORY_ROOT`，env 中没有 `PI_SECURE_*` 时原样返回同一对象                                                                                                                                                          | `web-hub/agent/launcher.ts:109` spawnHub；`web-hub/hub/spawn/supervisor.ts:1877` forkInto（另加前缀跳过作为防御）               | parity fixture 9 例、launcher.test、supervisor.test 2 例                                                                            |
| R9                     | secure 的 session_start 执行一次 `git rev-parse --git-common-dir`（`src/git/run.ts`，3s 截止，timer 已 unref），common-dir 在库外就 warning                                                                                                                                                                                 | guards.ts `warnGitCommonDir`                                                                                                    | guards.test「R9」                                                                                                                   |
| D5                     | `PI_SECURE_SESSION=1`（activate 时设置）；`/secure status` 检查 pi settings.json 的 packages 中 traffic-record 是否声明 `piSecure.honors`                                                                                                                                                                                   | command.ts `checkTrafficRecord`                                                                                                 | —                                                                                                                                   |
| `/secure status`       | 只读，post-guard（仅主会话）。只在非 plain、配置了 vault、或段已启用但非法时注册（off 时命令表不变）。输出包括判定、锁原因、库路径、各 vault 挂载状态、traffic-record 检查和启动器安装提示                                                                                                                                  | command.ts                                                                                                                      | off-golden（secure 下注册、子会话不注册）                                                                                           |

## 3. env / 配置契约 parity

- 契约按主会话转达的 P1 提议实现：`secure.enabled` 默认 true；`vaults` 是 `{<name>:{dir?,link?}}`；name 匹配 `^[a-z0-9][a-z0-9_-]{0,31}$`；派生 cipher/mnt/work/state/sessionDir/lock。我补充的三点（mountinfo 同一挂载点取最后一行并做八进制解码、路径展开规则、插件侧 fail-closed）已由主会话采纳并转达 P1。
- 共享 fixture 是 `tests/fixtures/secure-contract-parity.json`，由 P2 主写：
  - settings 15 例，期望值是 `parseSecureConfig` 的全量 JSON；
  - mountinfo 11 例，字段为 `mountinfo/realMnt/realCipher`；
  - hubSafeEnv 9 例。
- 我的 `tests/secure/config-parity.test.ts` 和 P1 的 `tests/secure/launcher-helper.test.ts` 读同一份文件，当前都通过。P1 的 `helper.mjs` 是对 `config.ts` 的逐行等价实现。
- 补充约定（都已写进 fixture）：
  - `vaults` 缺省视为有效且为空；
  - `enabled` 不是布尔值时按 true；
  - `enabled:false` 时仍解析 vaults，由消费方忽略；
  - `secure:null` 视为非法；
  - vault 条目的 `dir:null` 判为 invalid。

## 4. 偏离与决定（需知悉）

1. **consult 根是 `<state>/cache/consult-sessions`**，而不是 plan 写的 `<state>/consult`。原因是 `consult/index.ts:146` 用 `dirname(dirname(consultDir))` 推导 agentDir，改这里不在本包的文件域内。保持 `<agentDir>/cache/consult-sessions` 的形状后，推导出的「agentDir」就是 `<state>`，仍在 vault 内。
2. **cwd 判定用整个 vault 目录（`realpath(dir)`）**，不只看 `mnt/`。cwd 落在 cipher 目录时也判为该 vault：已挂载就是 secure，随后 session_start 因 cwd 不在 `mnt` 内而 LOCKED；未挂载就是 locked。这比只看 mnt 更保守。
3. **cwd 判定得出的 secure 也导出 `PI_SECURE_VAULT`**（plan 只写了 TMPDIR、ARMORY、SESSION）。这样会话 bash 里嵌套启动的 `pi` 会进入同一个域（secure 或 LOCKED），不会以普通会话的身份把内容写到库外。hub 方向由 hubSafeEnv 清除这个变量。
4. **判定按进程冻结**，`/reload` 不会重判：先 LOCKED 后挂载的话，需要重开会话。但每次 session_start 会重新核验挂载，所以 secure 进程在运行中被卸载时会变成 LOCKED。
5. **插件额外防御**：mountinfo 显示已挂载后，再 `lstat(<state>)`，要求它是目录（排除哨兵文件或 ENOTCONN）。这是插件侧比契约更严的一步，P1 不需要跟进。
6. **locked 进程同样关闭 D8**（xs/droid/feishu/cron），但 bash/workflow 根不重定向（vault 未挂载，而且什么都不会运行）。
7. **`/secure` web 允许已实现**（主会话在 `src/web-hub/agent/command-policy.ts` 落地：`secure` 子命令为空或 `status` ⇒ allow，其余 deny；对应测试 `tests/web-hub/agent/command-policy.test.ts`）。
8. **文件域外的测试改动**（都是同文件内追加的对应测试，没有改任何已有断言）：`tests/web-hub/agent/launcher.test.ts` +1 例，`tests/web-hub/hub/spawn/supervisor.test.ts` +2 例。`tests/web-hub/boundary.test.ts` 按任务要求在 SYSLOAD_FILE_CLOSURE 中加入 `../secure/domain.js`，钉住 `src/secure/{domain,config,env}.ts` 的 import 闭包，并把 `src/secure/env.ts` 加入 hub 可导入的白名单（supervisor 需要它）。
9. **runtime 层面不可防的点（残留）**：
   - 运行期 LOCKED 只拦当前主会话的输入和工具；plain 进程打开 vault 会话后，其他扩展经 RPC 或事件触发的 spawn 不在拦截范围内。
   - `user_bash`（`!cmd`）在 plain 下不做 D4 检查，因为那是用户自己的操作。
   - 第三方工具的路径参数不检查。
   - 已登记但 dir/link 非法的条目无法参与 cwd 匹配，按 plain 处理（只有 env 指名时才 locked）。
   - 这些都属于 §5 R7/R8/R11 一类。
10. 冻结面核验：
    - 新增的 `tests/fixtures/secure-off-golden.json` 加 `tests/secure/off-golden.test.ts` 覆盖三种 off 场景：无配置、`enabled:false` 带 vault、空段。断言 activate 的完整 ExtensionAPI 调用序列在三个场景间完全相同、没有 `/secure`、没有守护钩子、`process.env` 无增量、`loadSettings` 原样返回、`DEFAULT_SETTINGS` 未被修改、`hubSafeEnv` 原样返回。
    - 另做了一次性对照：用 `git worktree` 检出改动前的 HEAD，以同一 recorder 录制。三个场景在 HEAD 与 P2 上都是**完全相同的 176 次调用**，env 增量为空。worktree 已删除；这一对照没有写成常驻测试，因为全量调用序列会随其他功能变化，不适合作为「永不重生成」的 golden。
    - 三份 off golden（xs/wake/reply）未改动，且都通过。

## 4b. 安全评审修复（2026-10-23，GLM 评审 pass-with-changes，全文 /tmp/secure-P2-secreview.md）

| #   | 级别         | 问题                                                                                                                           | 修复落点                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 测试                                                                                                                                                                                                                         |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 严重         | 运行中被卸载后，D3 允许区退化为明文写入区：未挂载时 `mnt/<新文件>` 是真实目录下的新文件，`mnt/work` 是哨兵文件，两者都会被放行 | ① `guards.ts` `recheckMount`：secure 进程在**每次** `tool_call` 和 `input` 时调用一次 `judgeVaultMount`（读 `/proc/self/mountinfo`，必要时 lstat `<state>`）。不 ok ⇒ 立即置 `runtimeLock`，状态栏切到 `secure:locked` 并 notify，本次调用和之后的所有输入、工具都被拦。子会话同样复查（子会话没有 session_start）。② 收窄写入区：`domain.ts` 新增 `inVaultWriteZone`，只允许严格位于 `mnt/work` 或 `mnt/state` 之下的路径，哨兵路径本身和 `mnt/` 根层条目一律拒绝 | guards.test：「unmounted mid-session ⇒ mnt-root and sentinel writes blocked, session turns LOCKED, input refused」「unmount noticed first by input」「child sessions re-verify」「write zone is strictly below…」            |
| 2   | 一般         | settings 文件存在但不可读或 JSON 损坏时，静默 fail-open 成 plain                                                               | `readSecureSettingsRaw` 返回三态（missing / ok / error）。ENOENT、ENOTDIR 视为 missing（plain）；读取失败或 JSON 无法解析 ⇒ `secureConfigFromRead` 视为「已启用但非法」的 secure 段。此时 `secureGuardsNeeded` 和 `secureCommandWanted` 都为真，注册 `/secure`，状态栏显示 `secure:invalid`，`initSecureDomain` 打一次 `console.warn`（判定冻结，子会话和 `/reload` 不会重复）。带 `PI_SECURE_VAULT` 时仍是 locked                                                 | domain.test「corrupt JSON」「unreadable (EISDIR)」「warns once」；guards.test「broken secure section: status secure:invalid」；off-golden「corrupt settings file registers /secure + guards and warns once (real activate)」 |
| 3   | 一般         | 判定按进程冻结，`/reload` 不重判，但用户看不到这一点                                                                           | `/secure status` 增加一行：「secure 配置变更（如 pi-secure init 登记新保险库）需重启 pi 进程才生效；/reload 不会重新判定。」                                                                                                                                                                                                                                                                                                                                       | domain.test「/secure status text」                                                                                                                                                                                           |
| 4   | 一般         | 冻结为 locked 的进程放行 `session_before_switch`                                                                               | `decideSwitch`：locked ⇒ 返回原因 ⇒ `{cancel:true}`，有无目标文件都取消                                                                                                                                                                                                                                                                                                                                                                                            | guards.test「locked cancels every switch」「locked process: session_before_switch is always cancelled」                                                                                                                      |
| 5   | 建议（已做） | 远端安装的 traffic-record 永远显示 unknown，告警疲劳                                                                           | `checkTrafficRecord` 新增 `remote` 判定，文案为「远端安装，无法在本地核验…请确认其版本已适配」，不再用「警告」措辞                                                                                                                                                                                                                                                                                                                                                 | domain.test「/secure status text」                                                                                                                                                                                           |
| 6   | 建议         | 报告 §4.7 与代码不一致                                                                                                         | §4.7 已更新为「已实现」                                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                                                                                                                                                                                                            |
| 7   | Nit          | R15 未点名几个文件                                                                                                             | plan §5 R15 行内追加 `cache-provider-evidence.json`、`cache-ttl-measurements.json`、`.pi-subagent.json.lock`（只改这一行）                                                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                            |
| 8   | Nit          | 「只有 `PI_SECURE_ORIG_ENV`、没有其他 `PI_SECURE_*`」时的 hubSafeEnv 行为没有钉住                                              | parity fixture 的 `hubSafeEnv` 段追加 2 例：ORIG 合法时按 ORIG 处理（null 删除、字符串恢复）；ORIG 损坏且不是 secure 会话时，只删 ORIG，保留 TMPDIR 和 ARMORY。P1 的 helper 测试不读 hubSafeEnv 段，只由 P2 测试消费；`launcher-helper.test.ts` 仍然通过                                                                                                                                                                                                           | config-parity                                                                                                                                                                                                                |

冻结面说明：修复 #2 让「secure 段已启用但损坏」的文件可见（多出 `/secure` 命令、`secure:invalid` 状态和一行 warn）。这一点是评审明确要求的。没有 settings 文件、没有 secure 段、`secure.enabled=false` 三种情况仍然逐字节不变，由 secure-off golden 钉住；文件存在但损坏的情况，原本就会触发 settings 加载自己的 parse warn。

## 5. 自验输出

```
$ npx vitest run tests/secure tests/config tests/runtime tests/consult tests/extensions tests/web-hub/agent tests/web-hub/hub/spawn tests/integration/fabric-xs-off-golden.test.ts tests/web-hub/boundary.test.ts --maxWorkers=3
 Test Files  221 passed (221)       # 含设置文件锁改动与 P1 当前 launcher 测试
      Tests  3810 passed (3810)

$ npx vitest run tests/integration/fabric-wake-off-golden.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts tests/schedule tests/session-nav tests/bash tests/workflow/host.test.ts tests/integration/child-bash-jobs.test.ts tests/integration/bash-jobs-wiring.test.ts --maxWorkers=3
 Test Files  31 passed (31)
      Tests  606 passed (606)

$ npm run typecheck        # tsc ×2 + vue-tsc
(exit 0)

$ npx prettier --check <改动文件>
All matched files use Prettier code style!
```

全量 `npx vitest run` 的结果见第 7 节。

安全评审修复后的复验：

```
$ npx vitest run tests/secure tests/web-hub/agent tests/web-hub/hub/spawn tests/web-hub/boundary.test.ts --maxWorkers=3
 Test Files  131 passed (131)
      Tests  2574 passed (2574)
$ npm run typecheck
```

- `npm run typecheck` 当前失败，报错只出现在 `src/traffic/server.ts` 和 `src/traffic/tap.ts`。这两个文件属于另一个 agent 正在进行的 traffic-merge，工作区中有它未提交的改动，不在本包范围内。
- 把这两个文件的报错过滤掉之后，`tsc -p tsconfig.json` 和 `tsc -p tsconfig.typecheck.json` 都没有其他错误。
- 改动文件 `prettier --check` 全部通过。

## 6. 设置文件锁（P1 安全评审 #5 跨写者协议，主会话 2026-10-23 批准）

- **新文件** `src/secure/settings-lock.ts`，纯 Node 实现，不依赖 pi，提供 `withSettingsFileLock(settingsPath, fn)` 和 `writeSettingsFileAtomic`。
- **锁文件位置**：`<settings 所在目录>/.<basename>.lock`，默认是 `~/.pi/agent/.pi-subagent.json.lock`，与启动器 `registerVault` 用的是同一个 inode。
- **打开方式**：`O_RDONLY|O_CREAT|O_NOFOLLOW|O_NONBLOCK`，权限 0600；打开后 fstat，必须是本 uid 的普通文件。
  - 锁文件是符号链接或不属于本用户 ⇒ fail closed。
- **取锁实现**：同步执行子进程 `flock -x -E 75 -w 10 3`，并把我们的 fd 放进它的 stdio 槽 3。
  - 依据：flock(2) 锁属于 open file description。子进程继承的是同一个 description，它退出时只关闭自己那份 fd，父进程仍持有，锁也就一直在，直到父进程 `closeSync(fd)`。源码注释已写明。
  - 测试 `settings-lock.test.ts`「flock(2) lives on the open file description」覆盖了这一点：持锁期间另一进程 `flock -n` 失败（exit 1），关闭 fd 后另一进程能拿到锁。
- **持锁范围**：「重读 → 合并 → 写 tmp → rename」全程持锁。
- **失败处理**：
  - 等待 10s 超时、flock 异常退出、锁文件打不开 ⇒ 放弃写入并返回错误，不会无锁写。
  - **唯一例外**：系统里没有 flock 二进制（`ENOENT`，例如 macOS）⇒ 无锁但原子写，返回值里 `locked:false`。理由是启动器本身依赖 flock，没有 flock 就不可能出现并发的启动器写者。主会话已同意这一例外。
- **接入点**：
  - `persistSettingOverride`（`/agent settings set|reset` 和 TUI 编辑器）：整段读改写放进锁内。写入从直接 `writeFileSync` 改为 tmp+rename，并且对 realpath 目标操作，所以符号链接形式的 settings 文件仍保持为链接。已有文件保留原权限位并去掉 g/o 写权限；新建文件 0600。拿不到锁时返回带原因的错误字符串，沿用原有的错误通道。
  - `loadSettingsFromFile` 的迁移回写：在锁内重读，文件内容与迁移前读到的不一致就跳过（下次再迁移）。拿锁失败**只跳过回写**，打一行 warn，照常返回内存中已迁移的设置，启动路径不会因此失败。最坏情况是另一写者长期持锁，此时启动会多阻塞最多 10s。
- **代价**：每次持久化多一次 spawnSync flock，约 2–5ms；`~/.pi/agent` 下多一个 `.pi-subagent.json.lock`。
- **测试**（`tests/secure/settings-lock.test.ts`，13 例）：
  - 父进程持锁的证明；
  - 超时放弃，fn 不执行；
  - 符号链接锁文件 fail closed；
  - 没有 flock 时走例外路径；
  - fn 抛错后锁仍被释放；
  - 被他人持锁时 persist 拒写并给出原因；
  - 符号链接 settings 保持为链接，权限保留；
  - 新文件 0600；
  - **并发**：8 个子进程同时调用启动器 `registerVault`，与插件的 20 次 `persistSettingOverride` 交错执行，结束后 8 个 vault 和 20 个键全部保留，没有丢更新；
  - 迁移回写拿锁失败时只 warn、照常返回；锁空闲时正常回写。
- **boundary**：`settings.ts` 的值导入闭包新增 `../secure/settings-lock.js`；`src/secure/settings-lock.ts` 的闭包钉为 `node:child_process`、`node:fs`、`node:path`。

## 7. 全量测试

```
$ npx vitest run --maxWorkers=4 --exclude 'tests/secure/launcher*'   # 加锁改动之前
 Test Files  1384 passed (1384)
      Tests  26214 passed | 22 skipped (26236)
```

- 不加 `--exclude` 跑全量时，P1 的 `tests/secure/launcher-cli.test.ts` 中有 3 例失败（status incomplete、D9 重试、哨兵校验）。这些是 P1 在本次运行时尚未完成的部分，不在本包范围内。排除它们后全部通过。后续 r2 的 launcher 测试由 P1 自行负责。
- 加锁改动之后重跑了受影响的子集：
  - `tests/config tests/commands tests/ui tests/secure tests/web-hub/boundary.test.ts`：69 个文件、1282 例通过；
  - `merged-plugins-wiring`、`tests/cache-ttl`、三份 off golden：44 个文件、1247 例通过。
- `npm run typecheck` 通过；所有改动文件 `prettier --check` 通过。
