# #54 设置文件改名 `pi-subagent.json` → `pi-toolkit.json`，设置与 traffic.db 跟随 agentDir：实施方案 r2

> 状态：r3，2026-10-26（r2 复审有条件通过，r3 按复审 5 条修订，见文末「r3 修订」）。r1 被 sonnet 评审打回（`/tmp/review54.md`，共 17 条），本稿逐条修订，对照见文末「r2 修订对照表」。只读调研产出，未改任何代码。
> 已拍板（2026-10-26，见文末原文）：① 迁移用「复制 + 兼容符号链接」；② launcher 在没有任何设置文件时默认旧名；③ 插件设置与 traffic.db **本次就**跟随 `PI_CODING_AGENT_DIR` / `getAgentDir()`。
> 本稿新增一个待拍板点 ④：已设变量的老用户如何过渡（§6.1）。
> 前置：#59 已以 `43d892fd` 合入 dev（`git log -3 --oneline -- src/config/settings.ts` 首条）。`src/config` 仍是 `settings.ts` 单文件（3753 行），包划分见 §6.2。工作区里另有一个任务在改 `src/core/*`、`src/service/*`、`src/tools/agent-tool.ts`，派发前要再核一次文件域。
> 不动的运行时旧名：`Symbol.for("pi-subagent:*")`、`subagent:*`、widget/status key、`[pi-subagent]` 日志前缀，以及锁文件名 `.pi-subagent.json.lock`（§5.5、§5.8）。

---

## 1. 背景与目标

1. 用户设置文件从 `pi-subagent.json` 改名为 `pi-toolkit.json`。老用户的配置零丢失（特别是 `secure.vaults`：丢了它，secure 域会判成 plain，守卫随之失效），并且可以降级回旧版。
2. 插件设置文件和 `traffic.db` 改为跟随 pi 的 agentDir（`$PI_CODING_AGENT_DIR`，未设时为 `~/.pi/agent`）。
3. **硬约束：变量未设或为空串时，所有路径、所有输出与现状逐字节一致。** A 级冻结物 `secure-off-golden.json`、`secure-contract-parity.json`，A′ 级 `secure-launcher-off-golden.json`，以及 `fabric-xs-off-golden.json` 等全部不变。
4. 并发安全：多个 pi 进程（主会话、hub 拉起的 headless 会话、`pi-secure run` 起的 pi、bash 里嵌套的 `pi`）可能同时首次启动，迁移要和 launcher 写设置互斥。
5. 不变式 I1/I3/I4/I5/I6/I8/I9/I10/I11 保持成立；I7 的措辞要改（§6.5）。

## 2. 现状摘要

### 2.1 设置文件的读写入口（与 r1 相同，已复核）

| 位置                                                 | 作用                                                                                                                                                                                     | 路径                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `src/config/settings.ts` `defaultSettingsPath()`     | 插件唯一的默认路径函数                                                                                                                                                                   | `join(homedir(),".pi","agent","pi-subagent.json")` |
| 同上 `loadSettingsFromFile(path=default)`            | 主会话 post-guard 调用（`src/index.ts:324`）；ms→s 与 cache-ttl 迁移的写回点，在锁内执行 tmp+rename（**不保留符号链接**）                                                                | 默认                                               |
| 同上 `readSettingsNoMigrate()`                       | pre-guard，**所有会话都调用，包括子会话**（`src/index.ts:207`）；只读                                                                                                                    | 默认                                               |
| 同上 `load{WebHubLan,WebHubProxy,FeishuBot}Warnings` | 只读诊断                                                                                                                                                                                 | 默认                                               |
| 同上 `persistSettingOverride`                        | `/agent settings`、TUI 编辑器（`index.ts:1311-1312`）、`cache-ttl.ts:543`                                                                                                                | 默认                                               |
| `src/secure/settings-lock.ts`                        | `settingsLockPath = dirname/.${basename}.lock`；`withSettingsFileLock`（没有 flock 二进制时不加锁照样执行，返回 `locked:false`）；`writeSettingsFileAtomic`（先 realpath，保留符号链接） | 由文件名推导                                       |
| `src/secure/domain.ts:551`                           | `initSecureDomain()` 是 activate 的第一条语句，读 `secure` 段                                                                                                                            | 固定 homedir                                       |
| `src/secure/bin/helper.mjs:441-477`                  | launcher 的 `settingsFilePath(home)`；`SETTINGS_LOCK_NAME` 硬编码为 `.pi-subagent.json.lock`；`__vault-*` 子进程在锁内重新计算路径；`assertWritableSettingsFile` 拒绝改写符号链接        | 固定 homedir                                       |
| `src/secure/bin/archive.mjs:155`                     | 经 helper                                                                                                                                                                                | 同上                                               |
| `src/web-hub/hub/**`                                 | **不读设置文件**。配置来自 `PI_WEBHUB_CONFIG`（`web-hub/agent/launcher.ts` 用拉起它的那个会话的 `AgentSettings` 组装）                                                                   | —                                                  |

### 2.2 现有的 agentDir 镜像（互不一致，评审 #3）

pi 本体的实现（`dist/config.js:491`）：`envDir ? normalizePath(envDir) : join(homedir(), CONFIG_DIR_NAME, "agent")`。其中 `normalizePath`（`dist/utils/paths.js:59`）默认不 trim；会展开 `~` 和 `~/`；`file://` 转成路径；win32 下转换 shell 路径；**相对路径原样返回**（于是相对于各进程自己的 cwd）。变量名 `ENV_AGENT_DIR = ${APP_NAME}_CODING_AGENT_DIR`，`CONFIG_DIR_NAME = piConfig.configDir || ".pi"`。

| 位置                                                                                           | 空串                                   | `~`              | 相对路径                                             | trim   |
| ---------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------- | ---------------------------------------------------- | ------ |
| pi `getAgentDir()`                                                                             | 视为未设                               | 展开             | 原样（相对 cwd）                                     | 否     |
| `src/cache-ttl/measure-store.ts:44`、`provider-evidence.ts:404`                                | 视为未设                               | **不展开**       | 原样                                                 | 否     |
| `src/traffic/dup-detect.ts:45`                                                                 | 视为未设                               | 不展开           | 原样                                                 | **是** |
| `src/secure/bin/helper.mjs:2478` `piAgentDir`                                                  | 视为未设                               | 展开             | `path.resolve`（launcher 已 `cd /`，所以相对于 `/`） | 否     |
| `src/secure/bin/convert.mjs:1610`                                                              | 视为未设                               | **变成相对 cwd** | `path.resolve`                                       | 否     |
| `src/web-hub/hub/hub.ts:1120,1170,1217,1277,1397,1482`                                         | **`??`：空串原样当作路径**             | 不展开           | 原样                                                 | 否     |
| `src/stack.ts`、`session-driver.ts`、`legacy-consult-forks.ts`、`cache-ttl/measure-command.ts` | 直接调用 pi 的 `getAgentDir()`（不改） |                  |                                                      |        |

### 2.3 traffic.db

`src/traffic/db.ts:55-67` 的 `defaultRecordPaths(home)` 固定为 `home/.pi/agent/{records,dumps}`（traffic-merge 拍板 1b）。`engine.ts:244` 在 `dbPath === defaults.dbPath` 时才做 legacy `dumps/` 检测。`tests/traffic/db-path.test.ts:77` 钉住"设了非默认变量仍然打开 homedir 下的库"。`server.ts:121` 的 `sanitizeDetail` 按 `state.dbPath` 精确脱敏，另有 `/home|/root|/Users` 正则兜底。外部 pi-traffic-record 用同样的固定算法，进程内由 `Symbol.for("pi-traffic-record:claim")` 认领协议互斥。`/record status` 会打印 `数据库: ${engine.dbPath}`（`index.ts:365`）。

### 2.4 hub

hub 每个 uid 一个，状态目录、socket、`hub.json`、UI 目录都固定在 `<home>/.pi/agent/web-hub*`（`protocol/paths.ts:157-199`，注释写明"never PI_CODING_AGENT_DIR"）。hub 的环境变量来自**最先拉起它的会话**（`launcher.ts:132` 的 `hubSafeEnv(process.env)`）。headless 子会话的环境变量来自 hub（`supervisor.ts:1876` 的 `hubSafeEnv(deps.env)`）。`hub.json` 由 agent 侧 `readHubJsonRecord`（`web-hub/agent/index.ts:1929`）按字段挑选读取，**未知键会被忽略**。

### 2.5 冻结物与路径的关系（已复核）

- `secure-contract-parity.json`：只有 `parseSecureConfig` 的输入和输出，与路径无关。
- `secure-off-golden.json`：`off-golden.test.ts` 把场景写进**旧名**文件后跑真实 activate，断言只依赖 API 调用序列在三个场景间一致、`envDelta`、domain 判定。迁移只做文件操作加 `console.warn`，不新增任何注册调用。
- `secure-launcher-off-golden.json`（A′）：23 个 case 带 `<ROOT>/home/.pi/agent/pi-subagent.json`。其中 7 个没有设置文件（`status-no-settings`、`status-unregistered-name`、`status-bad-name`、`unlock-not-found`、`lock-not-found`、`init-fix-not-found`、`run-not-found`）。`makeEnv` 构造的是**显式 env**（`launcher-off-golden.test.ts:191`，不继承 `process.env`），不含 `PI_CODING_AGENT_DIR`。
- `memory-legacy-golden.json` 等 B 级 fixture 的正文里出现旧路径文字。**文档批量替换必须排除 `tests/fixtures/`。**
- `compact-hint-golden.json`（A）钉住了 `[pi-subagent 上下文通报]`（§5.8）。

## 3. 总体设计

### 3.1 结构（文字图）

```
src/core/agent-dir.ts            ← 唯一 TS 权威实现：resolveAgentDir(env, home)（pi-free，仅 node:path/node:url）
  ├─ src/web-hub/protocol/agent-dir.ts   镜像（hub 白名单只收紧，不能 import core）
  └─ src/secure/bin/helper.mjs           镜像（launcher 零依赖，按契约镜像）
        三份由同一张表驱动（T-AD1），并用 conformance 测试经公开 API 对照真实 getAgentDir()（T-AD2）

src/secure/settings-lock.ts      ← 设置文件协议：文件名常量、resolveSettingsFile(dir)、
                                    resolveSettingsLocation(agentDirInfo)（含 home 继承）、
                                    migrateLegacySettingsFile(dir)（link + symlink、可自愈）、
                                    固定锁名、requireLock
  ├─ src/config/settings.ts      defaultSettingsPath()=location.path；prepareSettingsFile()（主会话唯一迁移点）
  ├─ src/secure/domain.ts        location.path；S6b secure 段比对；agentDir 落在保险库内 ⇒ locked
  └─ (镜像) helper.mjs           launcher 版解析 + 无文件时默认旧名 + status 后缀

src/traffic/db.ts                ← defaultRecordPaths({home, env, externalRecorder})：独立的根目录选择（不复用设置状态机）
src/web-hub/hub/hub.ts           ← 6 处合并为一个 hubAgentDir（protocol 镜像）；hub.json 追加可选 agentDir
src/index.ts (assembly)          ← initSecureDomain() → readSettingsNoMigrate() → [HOST_KEY]
                                    → const settingsFile = prepareSettingsFile() → loadSettingsFromFile(settingsFile.path)
                                    → stack 在既有 session_start 路径里一次性 notify（不新增注册）
```

### 3.2 agentDir 收敛：`resolveAgentDir`

**语义（三份实现逐行相同）：**

```
H = join(home, ".pi", "agent")
raw = env.PI_CODING_AGENT_DIR
raw === undefined || raw === ""                ⇒ { dir: H, home: H, source: "default" }
expanded = raw === "~" ? home
         : raw.startsWith("~/") ? join(home, raw.slice(2))
         : raw.startsWith("file://") ? fileURLToPath(raw)
         : raw                                  // 不 trim（与 pi 一致）
!isAbsolute(expanded)                          ⇒ { dir: H, home: H, source: "default", ignored: { raw, reason: "relative" } }
dir = resolve(expanded)                        // 只做词法规范化，不 realpath
dir === H                                      ⇒ { dir: H, home: H, source: "default" }   // 「与默认相同」视为未设
否则                                            ⇒ { dir, home: H, source: "env" }
```

- 与 pi 的差异只有一类：**相对路径**（包括 `" "` 这种只有空白的值）。pi 会相对各进程自己的 cwd 解析，而 launcher 先 `cd /`，两边必然错位。所以三份实现一律忽略相对值并回落 H。插件在每次 activate 时 `console.warn` 一次：`[pi-subagent] PI_CODING_AGENT_DIR is relative; toolkit settings/traffic stay under ~/.pi/agent`；`pi-secure status` 多打印一行同义提示。这种值下 pi 本体的会话目录本来就随 cwd 漂移，属于不支持的配置，在 README 写明。
- 变量名固定为 `PI_CODING_AGENT_DIR`，目录名固定为 `.pi`（与所有现有镜像一致）。conformance 测试只用 pi 包的公开导出（`exports` 只开放 `.` 和 `./rpc-entry`，`index.d.ts` 导出了 `CONFIG_DIR_NAME` 和 `getAgentDir`，**没有** `ENV_AGENT_DIR`）：断言 `CONFIG_DIR_NAME === ".pi"`，再用行为探针证明变量名，即设 `process.env.PI_CODING_AGENT_DIR = <tmp 绝对路径>` 后 `getAgentDir() === <该路径>`。pi 一旦改名，peer bump 时就会报红（r3 #2）。
- win32 的 shell 路径转换不镜像。secure 只支持 Linux；插件在 Windows 上走 `isAbsolute` 判定，行为写入"支持范围"（§5.9）。

**调用点清单（改为调用 `resolveAgentDir` 或其镜像）：**

| 调用点                                                                               | 现状                       | r2                                                                                                                                     | 未设变量时                                                      |
| ------------------------------------------------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `settings.ts` `defaultSettingsPath` 等                                               | 固定 H                     | `resolveSettingsLocation(resolveAgentDir(process.env, homedir()))`                                                                     | 逐字节一致（T-ID1）                                             |
| `secure/domain.ts:551`                                                               | 固定 H                     | 同上（`deps.env`/`deps.home` 已有注入缝）                                                                                              | 一致                                                            |
| `helper.mjs` `settingsFilePath` / `settingsLockPath`                                 | 固定 H                     | 镜像 + launcher 默认规则（§3.3）                                                                                                       | 一致（A′ golden）                                               |
| `helper.mjs` `piAgentDir`（init 嵌套检查、D5 traffic-record 告警）                   | 展开 `~` + resolve         | 镜像                                                                                                                                   | 一致                                                            |
| `helper.mjs:6483` → `convert.mjs` `defaultConvertContext`                            | convert 自算（`~` 有缺陷） | helper 显式传 `{ agentDir }`；`convert.mjs` **一行不改**（回落公式保留，仅供测试直调）                                                 | 一致                                                            |
| `convert.mjs:1619` `memoryRoot`                                                      | `agentDir/memory`          | **本 issue 不改**（r3 #5）。公式不变，只是 `agentDir` 改由 helper 传入；它与插件 `memory/paths.ts:27`（固定 home）的既有差异另开 issue | 一致                                                            |
| `cache-ttl/measure-store.ts:44`、`provider-evidence.ts:404`                          | 镜像（不展开 `~`）         | import core                                                                                                                            | 一致                                                            |
| `traffic/dup-detect.ts:45`                                                           | 镜像（trim）               | import core                                                                                                                            | 一致（trim 只影响首尾带空白的绝对路径值，这类值原本就是坏配置） |
| `traffic/db.ts` `defaultRecordPaths`                                                 | 固定 H                     | §3.5                                                                                                                                   | 一致                                                            |
| `web-hub/hub/hub.ts` 六处 `?? ${home}/.pi/agent`                                     | 空串原样当路径             | `startHub` 里算一次 `hubAgentDir = resolveAgentDir(process.env, config.home).dir`（protocol 镜像），六处共用                           | 未设时一致；空串从"错误的空路径"修正为 H                        |
| `stack.ts`、`session-driver.ts`、`measure-command.ts` 等用 pi `getAgentDir()` 的地方 | —                          | **不改**（它们是 pi 自己的语义；只有相对值会和我们不同，已列为不支持）                                                                 | —                                                               |

### 3.3 设置文件定位：目录两级 + 文件名一级

**文件名一级 `resolveSettingsFile(dir)`**（`NEW=dir/pi-toolkit.json`，`LEGACY=dir/pi-subagent.json`；存在与否按 `lstat` 判断）：

兼容链接 = `LEGACY` 是符号链接，并且 `readlink(LEGACY) === "pi-toolkit.json"` 或 `realpath(LEGACY) === realpath(NEW)`。

| #       | NEW               | LEGACY                            | `kind` / 标志                | 读写路径                                    | 迁移动作（只在主会话）                 |
| ------- | ----------------- | --------------------------------- | ---------------------------- | ------------------------------------------- | -------------------------------------- |
| S0      | 无                | 无                                | `none`                       | 插件/domain：NEW；launcher：LEGACY（拍板②） | —                                      |
| S1      | 无                | 普通文件                          | `legacy`                     | LEGACY                                      | 迁移                                   |
| S2      | 无                | 外部符号链接                      | `legacy`                     | LEGACY                                      | 不迁移（dotfile 用户，§5.4）           |
| S3      | 无                | 兼容链接（悬空）                  | `none`，`compatLinkDangling` | NEW（launcher 也用 NEW）                    | —                                      |
| S4      | 有                | 无                                | `new`                        | NEW                                         | —                                      |
| S5      | 有                | 兼容链接                          | `new`                        | NEW                                         | — （常态）                             |
| **S6a** | 普通文件          | 普通文件，**与 NEW 同 `dev:ino`** | `new`，`migrating`           | NEW                                         | **补完**步骤 e–g（崩溃窗口自愈，§3.4） |
| **S6b** | 有                | 普通文件（不同 inode）或外部链接  | `new`，`conflict`            | NEW                                         | 不动；可见告警 + secure 段比对（§3.6） |
| S7      | 不是普通文件/链接 | —                                 | `new`                        | NEW                                         | 由读写方报错（同现状）                 |

**目录两级 `resolveSettingsLocation(agent)`：**

```
P = agent.dir, H = agent.home
primary = resolveSettingsFile(P)
agent.source === "default"                          ⇒ { ...primary, scope: "default" }      // P === H，现状路径
primary.kind !== "none" || primary.compatLinkDangling ⇒ { ...primary, scope: "agentDir" }
home = resolveSettingsFile(H)
home.kind !== "none"                                ⇒ { ...home, scope: "inherited" }       // 读写都在 H，与升级前完全一致
否则                                                 ⇒ { ...primary, scope: "agentDir" }     // 都没有：新建在 P
```

- `scope:"inherited"` 就是**已设变量老用户的过渡方案**（拍板④，推荐）。这类用户升级前读写的本来就是 `~/.pi/agent/pi-subagent.json`，继承 H 是对现状的**原样保持**，不是新增泄露。想隔离时，在 `$PI_CODING_AGENT_DIR` 下放一个 `pi-toolkit.json`（哪怕是 `{}`），之后就切到 P。**不做自动复制**：复制会让 `secure.vaults` 和各种 token 出现两份，之后静默分叉。
- 迁移只作用于 `location` 所在的那个目录（inherited 时迁移的是 H 的旧名文件，与默认用户相同）。
- 锁 = `<location 所在目录>/.pi-subagent.json.lock`（固定名，§5.5）。

### 3.4 迁移：link 发布 + 兼容符号链接 + 崩溃自愈（修正评审阻塞 #1，采纳 #15 的简化）

```
migrateLegacySettingsFile(dir):
  快速路径（不加锁）：st = resolveSettingsFile(dir)
    不是 S1、也不是 S6a ⇒ 直接返回（S6b ⇒ { kind:"conflict" }）
  withSettingsFileLock(dir/.pi-subagent.json.lock, fn, { requireLock: true })
    // requireLock：没有 flock 二进制时**不执行 fn**，返回 skipped("no-flock")（评审 #12）
  锁内：
    0. 清理残留：删除 dir 下名字匹配 /^pi-subagent\.json\.[0-9a-f]{16}\.lnk$/ 的符号链接（只有锁持有者会创建它们）。
    1. 再解析一次：
       S1：
         a. lstat(LEGACY)：必须是普通文件且 uid == 本进程，否则 skipped("not-regular"|"foreign-owner")。
         b. 解析 JSON（失败不阻断）：任一 secure.vaults.* 带 pending 或 relocate ⇒ skipped("secure-txn")
            （事务进行中不迁移，避免旧版 launcher 的 --resume/--abort 被兼容链接卡住，评审 #12）。
         c. linkSync(LEGACY, NEW)：硬链接发布，不会覆盖已存在的 NEW。
              EEXIST ⇒ { kind:"conflict" }（有不守锁的写者抢先建了 NEW）
              EPERM / ENOTSUP / EMLINK / ENOSYS ⇒ skipped("link-unsupported")，静默，留在 S1
            成功后进入 S6a（NEW 与 LEGACY 同 inode），继续往下执行。
       S6a（当场的，或上次崩溃遗留的）：
         e. lnk = `${LEGACY}.${suffix16}.lnk`（suffix16 = (pid·时间戳) 的 16 位十六进制，见 §6.3）；symlinkSync("pi-toolkit.json", lnk)
              失败 ⇒ 如果 NEW 与 LEGACY 仍同 inode，就 unlink(NEW) 回到 S1；返回 skipped("symlink-unsupported")，静默
         f. 再 lstat(LEGACY)，确认仍与 NEW 同 dev:ino；不同（锁外有人原子替换了 LEGACY）⇒ unlink(lnk)，返回 conflict
         g. renameSync(lnk, LEGACY) ⇒ S5，返回 migrated
       其它状态 ⇒ noop
  锁超时 ⇒ skipped("lock")（不阻断加载，下次 activate 重试）
```

**崩溃与并发分析（每一步之后被 SIGKILL）：**

| 中断点         | 留下的状态                                               | 读方看到的内容                   | 自愈                                                                                                                                                           |
| -------------- | -------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| c 之前         | S1                                                       | 旧名完整内容                     | 下次迁移                                                                                                                                                       |
| c 之后、g 之前 | **S6a**（两个名字同 inode，内容同一份），可能留下 `.lnk` | 新旧两个名字读到的是同一个 inode | 下次主会话迁移，**或任何新版写者在锁内写之前**（§3.4.1），识别出 S6a 并补做 e–g；步骤 0 清理 `.lnk`。S6a 本身不算 conflict；新版写者不会把它变成 S6b（§3.4.1） |
| g 之后         | S5                                                       | 正常                             | —                                                                                                                                                              |

- 并发首次启动的进程在无锁快速路径上读到瞬态 S6a，解析结果是 NEW，不告警（内容就是同一个 inode）。迁移的 c→g 全程在锁内完成，所以**守锁的新版写者永远看不到「迁移进行中」的 S6a**，只可能遇到崩溃遗留的 S6a。
- 和 r1 相比，去掉了 tmp 文件、字节复制、内容比对、回滚、EXDEV 分支、pid 命名带来的复用问题（评审 #13）。NEW 就是原 inode，mode、owner、xattr、mtime 原样保留。
- **为什么不违背拍板①**：拍板比较的是终态与兼容性，备选是"直接 rename，不留链接"和"保留旧文件"。本方案的终态与"复制 + 兼容链接"完全相同：NEW 是内容逐字节相同的普通文件，LEGACY 是指向它的兼容链接，旧版读写都经链接落到 NEW。差别只在机制：用硬链接做零拷贝的"复制"。评审 #1(b) 提的 `rename(LEGACY,NEW)` + symlink **不原样采纳**，原因有二：rename 会覆盖并发创建的 NEW；崩溃后落到 S4（没有兼容链接），降级的旧版就读不到配置了。link 方案同时解决了这两点。
- 硬链接或符号链接不受支持的文件系统（少见的 FUSE、vfat），以及没有 flock 的主机（常见于 macOS），会静默留在 S1：解析器回退旧名，功能完整。每次 activate 的代价是一次失败的 `link(2)`，不刷告警，所以不需要退避标记。

#### 3.4.1 S6a 下的写者：写前自愈（r3 #1）

问题：S6a（NEW 与 LEGACY 同 inode）若在自愈之前被某个写者用 tmp+rename 写了 NEW，NEW 就换成新 inode，LEGACY 留下的是旧内容的另一份，S6a 变成永不自愈的 S6b：误报冲突，涉及 secure 段时还会触发 `secure:invalid` / launcher 78。

| 方案                                                                           | 结论                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **(A) 写前自愈：所有新版写者在锁内先补完 S6a，再在锁内解析目标、再写**（推荐） | ✅ 复用迁移的 e–g，没有新机制；写完的状态只会是 S5（或在不支持 symlink 时回到 S1 后写 LEGACY），绝不产生 S6b |
| (B) 写时同时重建链接（写 NEW 后把 LEGACY 替换成兼容链接）                      | ❌ 每个写者都要带 symlink 逻辑，相当于把 (A) 放到写之后，而且写与重建之间崩溃会制造真正的 S6b                |
| (C) 不换 inode 的就地写（`O_TRUNC` 或 `pwrite`）                               | ❌ 放弃原子写，会撕裂写入并回退到 review B1 修掉的"读到半个 JSON ⇒ 全部默认值"                               |

**契约：** `settings-lock.ts` 新增 `healSettingsFileLocked(dir)`，只能在锁内调用（调用方必须已经持有 `withSettingsFileLock`）。它只处理 S6a，执行步骤 0（清理 `.lnk`）和 e–g，其它状态一律 noop；永不抛；返回 `"healed" | "reverted-to-legacy" | "noop" | "conflict"`。`migrateLegacySettingsFile` 的 S6a 分支改为直接调用它（一份实现）。launcher 镜像同名函数。

**写者清单（全部改为「锁内：heal → 解析目标 → 读改写」）：**

| 写者                                                                                   | 改动                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persistSettingOverride(key, value, path?)`                                            | `path` 变为可选。**省略时在锁内解析**：先 `healSettingsFileLocked(dir)`，再 `settingsLocation().path`。显式传路径（测试）时行为与现在相同，但锁内同样先 heal 该路径所在目录                                                                                   |
| `src/cache-ttl/cache-ttl.ts:543`                                                       | 去掉显式的 `defaultSettingsPath()` 参数，改为省略（走锁内解析）。`src/index.ts:1311` 本来就省略了                                                                                                                                                             |
| `loadSettingsFromFile` 的 ms→s / cache-ttl 写回                                        | 已在锁内；在 `now !== rawText` 复查之前先 heal（`prepareSettingsFile` 拿锁失败的情况下，这里会兜底）                                                                                                                                                          |
| `migrateLegacySettingsFile`                                                            | S6a 分支调用 `healSettingsFileLocked`                                                                                                                                                                                                                         |
| launcher `registerVaultUnlocked`、`patch`/`remove`/`unclaim` 的 `__vault-*` 锁内子进程 | 第一步调用镜像的 `healSettingsFileLocked(dir)`，然后才 `settingsFilePath()`、`loadMutableSettings`。**launcher 仍然不发起迁移**（不做 S1→S6a 的 link），只补完已经存在的 S6a。S6a 只可能来自新版插件中途崩溃，或用户手动 `ln`；两种情况下补完都与用户意图一致 |
| **旧版**写者（≤v0.10.0 插件、旧 launcher）                                             | 不会 heal。只有在"新版迁移中途崩溃"并且"降级到旧版"这两件事同时发生时，旧版写入才可能把 S6a 变成 S6b，此时有 S6b 可见告警兜底。列为残留（§6.7）                                                                                                               |

**不变式：** 守锁的新版写者执行完后，状态集合属于 {S0,S1,S2,S3,S4,S5,S7}，或者保持原有的 S6b。新版写者**从不制造** S6b。由 T-MG6 的矩阵测试证明。

### 3.5 traffic.db：独立的根目录选择（评审 #4，不复用设置状态机）

```
defaultRecordPaths({ home = homedir(), env = process.env, externalRecorder = false, exists = existsSync } = {}):
  a = resolveAgentDir(env, home); P = a.dir; H = a.home
  has(r) = exists(r/records/traffic.db) || exists(r/dumps)      // 把 dumps/ 也算进来：legacy 检测必须在同一个根上判
  a.source === "default"  ⇒ root = H, source "default"           // 与现状逐字节一致
  externalRecorder        ⇒ root = H, source "external-recorder" // 与外部 pi-traffic-record 写同一个库
  has(P)                  ⇒ root = P, source "agentDir"
  has(H)                  ⇒ root = H, source "inherited"         // 已设变量的老用户：继续用原来的库（如那个约 73 MB 的库）
  否则                     ⇒ root = P, source "agentDir"
  return { root, source, recordDir: root/records, dbPath: root/records/traffic.db,
           legacyDir: root/dumps, legacyDbPath: root/dumps/traffic.db }
```

- **不复制、不移动**。SQLite 有 `-wal`/`-shm`，外部 recorder 也可能正在写。想迁到 P：先 `/record off`，退出所有 pi，再 `mv ~/.pi/agent/records "$PI_CODING_AGENT_DIR"/`。README 写明。
- `externalRecorder` 来自 `traffic/index.ts:969` 已有的 `scanExternalTrafficReferences({ agentDir: P, … })`：只要发现外部 recorder 还装着，就钉在 H，保证两边写同一个库，进程内的认领协议照旧。`createTrafficEngine` 不再自己调用 `defaultRecordPaths()`，改由 `wireTraffic` 算好后通过 opts 传入。engine 里 `dbPath === defaults.dbPath` 才做 legacy 检测的判断改为"与传入的 defaults 比较"，于是 legacy 判定始终在选中的根上成对进行（评审 #4 iii）。
- `/record status`：`数据库:` 行在 `source !== "default"` 时追加 `（agentDir）` / `（继承 ~/.pi/agent）` / `（外部 recorder 共用 ~/.pi/agent）`。未设变量时输出不变。
- `server.ts` 的脱敏用的是运行时的 `state.dbPath`，P 在 `/home` 之外（如 `/data/agent`）也能被精确替换，不用改。
- `tests/traffic/db-path.test.ts:77`（"设了非默认变量，P 无库、H 有库，仍打开 H 下的库"）在本设计下**语义不变、继续通过**（走 inherited 分支），只把用例标题和注释改成"inherited"。另外新增 P 有库、两边都没有、外部 recorder 存在、P 下有 `dumps/` 四个用例。traffic-merge 的 1b 拍板在 `docs/dev/traffic-merge/README.md` 标注"由 #54 修订：跟随 agentDir，带继承回退"，commit 正文写明原因。

### 3.6 secure：domain、launcher、守卫、越界

1. **路径一致性**：domain 与 launcher 用同一套 `resolveAgentDir` + `resolveSettingsLocation`（launcher 是镜像）。`pi-secure run` 起的 pi 继承 launcher 的环境变量，所以不会错位。可能错位的场景是"变量只设在 pi 的 wrapper 里、没设在 shell 里"。对策（评审 #6）：
   - `pi-secure status` 的 `settings:` 行在 `source === "env"` 或 `scope === "inherited"` 时追加 `  [agentDir: env]` / `  [inherited]`。未设变量时不追加，A′ 不变。
   - `/secure status` 打印设置文件路径和 scope。
   - domain 判定 locked、原因是"`PI_SECURE_VAULT=… 不是已登记的保险库`"时，若 `source === "env"`，追加 `（设置文件 <path>；agentDir 来自 PI_CODING_AGENT_DIR，请确认 pi-secure 在同一环境下运行）`。
   - README 写明 launcher 与 pi 必须在同一套环境变量下使用。
2. **agentDir 落在保险库内属于不支持的配置**（评审 #7）：`source === "env"` 且 P 与任一已登记保险库的 `dir`/`mnt` 相互嵌套（词法 + realpath-nearest 两族，与 `helper.mjs:880` 的 init 检查同一规则）时：
   - domain 判 `locked`，原因：`PI_CODING_AGENT_DIR（<P>）位于保险库 <name> 内：不支持（设置登记会藏进它自己描述的保险库）`；
   - launcher 的 `status` 打印 `! …` 行；`run`/`unlock`/`init` 以退出码 78 拒绝。
   - 检测的前提是登记表可读（P 在未挂载的保险库内时 P 为空，location 会继承 H，登记表来自 H，照样能判定）。这条只对 `source === "env"` 生效，未设变量时零影响。
3. **S6b 下的 secure 段**（评审 #11）：domain 和 launcher 都读两份文件，比较 `stableStringify(root.secure)`（键排序后序列化；两边都没有 secure 键也算相等）。不一致时把 config 置为 `{ present:true, enabled:true, valid:false, error:"两份设置文件的 secure 段不一致：<NEW> 与 <LEGACY>" }`，走现有的 `secure:invalid` 路径：可见状态、`/secure` 命令、守卫、一次告警。launcher 的 `run`/`unlock` 以 78 退出，并提示手动合并。宁可 fail-closed 地报错，也不静默只用 NEW。
4. **越界写盘**：迁移只在 location 所在目录写入。只要 P 不在保险库内（第 2 条已保证），那就是保险库外本来就存在的明文设置位置，和现有的 ms→s 写回同类，不新增保险库内状态。D3 守卫只管 tool_call，插件内部写设置不归它管，这与现状一致。secure 或 locked 域里 traffic 被 D8 强制关闭，不会写 traffic.db。
5. **过旧的 pi-secure launcher（r3 #3）**：用户已有的 `~/.local/bin/pi-secure` 可能指向另一个旧检出。它不认识新名，S5 下改写设置时会因为是符号链接被拒绝（`helper.mjs:489-500`，属于 fail-closed，可恢复）。处理分两部分：
   - **运行时探测**，只在 `/secure status` 里做，因为它是只读、主会话、按需执行的命令，不进 activate 热路径。在 `PATH` 上找 `pi-secure`（注入 `which` 缝），`realpath` 后：
     - 指向本检出的 `src/secure/bin/pi-secure`：不提示；
     - 指向别处：读取其同目录的 `helper.mjs`，只读前 64 KiB 做文本匹配，查找标记 `SETTINGS_FILE_NAME = "pi-toolkit.json"`。找不到标记，并且当前 location 是 S4、S5 或 S6x 时，在 `启动器：ln -s …` 那一行之前追加：
       `警告：PATH 上的 pi-secure（<realpath>）是旧版，不认识 pi-toolkit.json；设置迁移后它改写设置（init/convert/import 登记、--resume/--abort）会被拒绝。请改指本检出：ln -sf <packageRoot>/src/secure/bin/pi-secure ~/.local/bin/pi-secure`
     - 找不到 `pi-secure` 或读取失败：不提示。
     - 这一段只在有 secure 配置、`/secure` 命令已注册时才可能出现，secure-off golden 不受影响。
   - **残留风险**：没跑过 `/secure status` 的用户只会在旧 launcher 拒写时看到它自己的报错（`拒绝改写设置文件：… 是符号链接`）。补救：用上面的 `ln -sf`，或者临时执行 `mv ~/.pi/agent/pi-toolkit.json ~/.pi/agent/pi-subagent.json`。写入 README 的"降级与回滚"一节和 §6.7。

### 3.7 hub 与 spawn（评审 #5）

规则（写进 web-hub README）：

1. **hub 状态不跟随**：`webHubStateDir`、socket、`hub.json`、`web-hub-ui`、uploads 仍固定在 `<home>/.pi/agent`（每个 uid 一个 hub）。`paths.ts:157-199` 的注释由"never PI_CODING_AGENT_DIR"改为"hub _state_ never follows PI_CODING_AGENT_DIR; the hub's agentDir only drives session discovery and the env of spawned children"。
2. **hub 的 agentDir = hub 进程自己的环境变量（继承自拉起它的会话）**，由 §3.2 的 `hubAgentDir` 统一计算。headless 子会话继承 hub 的环境变量，所以它们的设置、traffic 位置都按**hub 的 agentDir** 解析，同样带 inherited 规则。这是"一机一 hub、hub 级单一 agentDir"的明确限制。spawn 请求不携带 agentDir，不改 wire。
3. **诊断**：`HubRecord` 追加可选字段 `agentDir?: string`，**只在 hub 的 `source === "env"` 时写入**，所以未设变量时 `hub.json` 逐字节一致。agent 侧 `readHubJsonRecord` 增加对该字段的结构化读取。`/webhub status`：
   - 本会话的 `resolveAgentDir().dir` 与 `hub.json.agentDir ?? H` 不同 ⇒ 提示 `hub agentDir <a> ≠ this session <b>: web-spawned sessions use the hub's; /webhub restart from the desired env to switch`；
   - 字段缺失而本会话 `source === "env"` ⇒ 提示"hub 的 agentDir 未知（旧版 hub 或默认）"。
   - 旧 hub × 新 agent：字段缺失，按上面处理；新 hub × 旧 agent：未知键被忽略（`readHubJsonRecord` 已确认按字段挑选）。I10 成立。
4. `PI_WEBHUB_CONFIG` 一直来自拉起 hub 的那个会话的设置，这一点不变，写进 README。

### 3.8 消费方改动面汇总

| 消费方                                | 改动                                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                        | `const settings = loadSettingsFromFile()` 改为 `const settingsFile = prepareSettingsFile(); const settings = loadSettingsFromFile(settingsFile.path);`，并把 `settingsFile`（报告对象）交给 stack。仍是纯装配（I2）                               |
| `loadSettingsFromFile`                | 签名不变，**不负责文件名迁移**。默认参数仍为 `defaultSettingsPath()`（解析，不迁移）。ms→s 写回改用 `writeSettingsFileAtomic`（保留符号链接）                                                                                                     |
| `persistSettingOverride`、cache-ttl   | `path` 可选、在锁内 heal 后解析；cache-ttl 去掉显式路径参数（§3.4.1）                                                                                                                                                                             |
| `/agent settings` 编辑器              | `path` 在 `prepareSettingsFile()` 之后求值；scope 不是 default 时标题追加 ` (inherited from ~/.pi/agent)` / ` (PI_CODING_AGENT_DIR)`                                                                                                              |
| 子会话                                | 不改：`readSettingsNoMigrate()` 只解析，HOST_KEY 守卫保证子会话到不了 `prepareSettingsFile`                                                                                                                                                       |
| stack（既有 session_start 路径）      | 收到报告后、在第一次 `buildSessionStack` 时一次性 `ctx.ui.notify(…, "warning")`：S6b 冲突（附"旧名比新名新"的 mtime 提示）、相对变量被忽略。**不新增任何 `pi.on` 注册**，activate 的调用序列不变。once 标志放在 activate 闭包里的报告对象上（I4） |
| `settings-lock.ts` `settingsLockPath` | 固定为 `join(dirname(p), ".pi-subagent.json.lock")`                                                                                                                                                                                               |

## 4. 接口契约

### 4.1 `src/core/agent-dir.ts`（新增；pi-free；只 import `node:path`、`node:url`）

```ts
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export interface AgentDirInfo {
  readonly dir: string; // 生效的 agentDir（绝对、词法规范化）
  readonly home: string; // join(home, ".pi", "agent")
  readonly source: "default" | "env";
  readonly ignored?: { readonly raw: string; readonly reason: "relative" };
}
export function resolveAgentDir(env: Readonly<Record<string, string | undefined>>, home: string): AgentDirInfo;
```

镜像：`src/web-hub/protocol/agent-dir.ts`（同签名，文件头注明"mirror of src/core/agent-dir.ts — parity: tests/config/agent-dir-parity.test.ts"）；`helper.mjs` 导出 `resolveAgentDir(env, home)`，返回同形对象。

### 4.2 `src/secure/settings-lock.ts`（新增导出；不新增 import）

```ts
export const SETTINGS_FILE_NAME = "pi-toolkit.json";
export const LEGACY_SETTINGS_FILE_NAME = "pi-subagent.json";
export const SETTINGS_LOCK_FILE_NAME = ".pi-subagent.json.lock"; // I7 运行时旧名，永不随文件名变

export type SettingsFileState =
  | { kind: "new"; path: string; newPath: string; legacyPath: string;
      legacy: "absent" | "compat-link" | "same-inode" /* S6a */ | "conflict" /* S6b */; legacyNewer?: boolean }
  | { kind: "legacy"; path: string; newPath: string; legacyPath: string; legacyType: "file" | "symlink" | "other" }
  | { kind: "none"; path: string /* newPath */; newPath: string; legacyPath: string; compatLinkDangling: boolean };

export type SettingsLocation = SettingsFileState & { scope: "default" | "agentDir" | "inherited"; agent: AgentDirInfo };

export interface SettingsFsDeps { lstat?: …; readlink?: …; realpath?: … } // ENOENT/ENOTDIR ⇒ 视为不存在

export function resolveSettingsFile(dir: string, deps?: SettingsFsDeps): SettingsFileState;      // 纯读
export function resolveSettingsLocation(agent: AgentDirInfo, deps?: SettingsFsDeps): SettingsLocation; // 纯读

export type SettingsMigrationOutcome =
  | { kind: "noop" }
  | { kind: "migrated"; from: string; to: string; healed: boolean /* 来自 S6a */ }
  | { kind: "conflict"; newPath: string; legacyPath: string; legacyNewer: boolean }
  | { kind: "skipped"; reason: "no-flock" | "lock" | "not-regular" | "foreign-owner" | "secure-txn"
                              | "link-unsupported" | "symlink-unsupported" | "io"; detail: string };
export interface SettingsMigrationDeps extends SettingsFsDeps, SettingsLockDeps {
  link?: (a: string, b: string) => void; symlink?: (t: string, p: string) => void; // 测试缝（注入 EPERM 等）
  afterLink?: () => void; // 测试缝：在 c 与 e 之间插入（模拟崩溃或锁外替换）
}
export function migrateLegacySettingsFile(dir: string, deps?: SettingsMigrationDeps): SettingsMigrationOutcome; // 永不抛
/** 仅限锁内调用：补完 S6a（步骤 0 + e–g），其它状态 noop；永不抛。所有写者在读改写前调用（§3.4.1）。 */
export function healSettingsFileLocked(dir: string, deps?: SettingsMigrationDeps): "healed" | "reverted-to-legacy" | "noop" | "conflict";

export interface SettingsLockDeps { flockBin?: string; waitS?: number; requireLock?: boolean } // requireLock 为新增
export function settingsLockPath(settingsPath: string): string; // = join(dirname, SETTINGS_LOCK_FILE_NAME)
```

`settings-lock.ts` 需要 `AgentDirInfo` 类型，只用 `import type`，不影响 boundary closure 的值导入集合。

### 4.3 `src/config/settings.ts`

```ts
export function settingsLocation(): SettingsLocation; // resolveSettingsLocation(resolveAgentDir(process.env, homedir()))
export function defaultSettingsPath(): string; // settingsLocation().path
export interface SettingsFileReport {
  path: string;
  location: SettingsLocation;
  migration: SettingsMigrationOutcome;
  notified: boolean;
}
/** 主会话唯一的文件名迁移点（只由 src/index.ts 在 HOST_KEY 之后调用）。永不抛。 */
export function prepareSettingsFile(): SettingsFileReport;
/** path 省略 ⇒ 锁内 heal 后再解析默认位置；显式 path ⇒ 锁内 heal 其所在目录后写该路径。 */
export function persistSettingOverride(dottedKey: string, value: unknown, path?: string): string | undefined;
```

日志：全部用 `console.warn`，前缀 `[pi-subagent]`，每次 activate 最多各一条。

| 情况                  | 输出                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `migrated`            | `settings moved: <from> → <to> (kept <from> as a compatibility symlink for older versions)` |
| `conflict`            | 告警加 notify（§3.8）                                                                       |
| `skipped:lock` / `io` | `settings rename postponed (<detail>); still reading <legacy>`                              |
| 其余 skipped、noop    | 静默                                                                                        |
| `agent.ignored`       | 一条告警                                                                                    |

### 4.4 `helper.mjs`（launcher 镜像）

```js
export function resolveAgentDir(env, home) { … }                  // 与 core 同表
export function resolveSettingsLocation(agent) { … }              // 与 settings-lock 同表（含 S6a/S6b、inherited）
export function settingsFilePath(home = homeDir(), env = process.env) {
  const loc = resolveSettingsLocation(resolveAgentDir(env, home));
  if (loc.kind !== "none" || loc.compatLinkDangling) return loc.path;
  return path.join(path.dirname(loc.newPath), LEGACY_SETTINGS_FILE_NAME);   // 拍板②：无文件时默认旧名
}
export function settingsLockPath(home = homeDir(), env = process.env) { /* dirname(settingsFilePath(home, env)) + SETTINGS_LOCK_NAME */ }
```

- launcher **从不发起迁移**（不做 link），但每个锁内写者在第一步调用镜像的 `healSettingsFileLocked(dir)`，补完 S6a（§3.4.1）。S6b 的 secure 段比对、agentDir 落在保险库内的检测，在 `loadSecureConfig` 里完成，结果放进现有的 `readError` / problems 通道。
- 所有现有调用方签名兼容（`env` 参数在最后，带默认值）。

### 4.5 `src/traffic/db.ts`、`hub-json.ts`

```ts
export function defaultRecordPaths(opts?: {
  home?: string;
  env?: NodeJS.ProcessEnv;
  externalRecorder?: boolean;
  exists?: (p: string) => boolean;
}): {
  root: string;
  source: "default" | "agentDir" | "inherited" | "external-recorder";
  recordDir: string;
  dbPath: string;
  legacyDir: string;
  legacyDbPath: string;
};
// HubRecord 追加：agentDir?: string（仅 source==="env" 时写）
```

### 4.6 错误约定

- 解析器、迁移、`prepareSettingsFile`、`defaultRecordPaths` 都**永不抛异常**。迁移失败等于"继续用当前文件"，不影响加载。
- 写入方的拒绝规则不变：插件拒绝非普通文件、拒绝锁失败；launcher 拒绝符号链接、非本人文件、锁超时（73/78）。
- 新增的 fail-closed 只有两处：S6b secure 段不一致（`secure:invalid` / launcher 78）、agentDir 位于保险库内（locked / launcher 78）。两者都**只在非默认状态下**出现。

## 5. 关键决策

### 5.1 迁移机制：link + symlink（实现拍板①，并采纳评审 #15 的一部分）

| 方案                                     | 崩溃安全                                                 | 降级               | 复杂度                     | 结论                               |
| ---------------------------------------- | -------------------------------------------------------- | ------------------ | -------------------------- | ---------------------------------- |
| **link 发布 + 兼容链接，S6a 自愈**（r2） | 任何时刻都处于合法状态，中间态可自愈                     | 旧版经链接读写 NEW | 低：无复制、无比对、无回滚 | ✅ 终态等同拍板①                   |
| r1：字节复制 + 比对 + symlink            | 步骤 5–7 之间崩溃会卡在 S6，永远误报（评审阻塞 #1）      | 同上               | 高                         | ❌                                 |
| rename + symlink（评审 #1b）             | 崩溃落到 S4，不会自愈出链接；rename 会覆盖并发创建的 NEW | 崩溃后旧版读不到   | 低                         | ❌                                 |
| R0：只做新名优先读，不迁移（评审 #15）   | 无窗口                                                   | 完全兼容           | 最低                       | ❌ 违背拍板①（老用户永远停在旧名） |

评审 #15 关于"8 状态 × 两份实现 × agentDir 维度会让复杂度相乘"的担忧，r2 的处理是：

1. agentDir 维度只在 `resolveSettingsLocation` 的四行里出现，是一层薄包装，没有和文件名状态做笛卡尔积。
2. 迁移状态机缩成 S1 → S6a → S5 一条直线。
3. traffic 独立成五行规则，不复用设置状态机。
4. TS 与 mjs 的一致性由**同一张表**驱动（T-SF1），维护成本是一张表，而不是两套测试。

### 5.2 launcher 无文件时默认旧名（拍板②）

带上 agentDir 之后规则不变：`scope` 为 default/agentDir、`kind:"none"` 且没有悬空兼容链接时，默认用所在目录下的 `pi-subagent.json`。未设变量 ⇒ 目录是 H ⇒ A′ golden 里 7 个无文件 case 逐字节不变。

### 5.3 冲突（S6b）：新名优先，可见告警，secure 段不一致时 fail-closed

不做自动合并（`secure.vaults` 合并后语义不明）。非 secure 部分：notify + 告警，告警附 mtime 提示。secure 部分：§3.6 第 3 条。`sed -i`、`jq … > tmp && mv`、编辑器原子保存都会把兼容链接替换成普通文件进入 S6b，所以告警必须**可见**（评审 #11）。README 提示"请编辑 `pi-toolkit.json`"。

### 5.4 旧名是外部符号链接（S2）：不自动迁移

理由同 r1：stow、home-manager 等工具会重建或校验链接。

### 5.5 锁名固定为 `.pi-subagent.json.lock`

新旧插件、新旧 launcher 必须争同一把锁。锁名如果跟着文件名变，迁移后两把锁互不排斥，P1 安全评审 #5 修掉的并发覆盖会重新出现。锁在 location 所在目录：inherited 时在 H，与旧版共用；agentDir 时在 P，旧版从来不写 P。

### 5.6 已设变量老用户：继承 H（拍板④，推荐）

| 方案                                             | 升级时                  | 隔离                                 | secure 风险                                                         | 结论                          |
| ------------------------------------------------ | ----------------------- | ------------------------------------ | ------------------------------------------------------------------- | ----------------------------- |
| **(a) P 下没有文件就继承 H，读写都在 H**（推荐） | 与升级前一致，零回归    | 在 P 下建 `pi-toolkit.json` 即可隔离 | 无（登记表还是原来那一份）                                          | ✅                            |
| (b) 不继承，只告警并给出手动 `cp` 命令           | P 为空 ⇒ 全部回落默认值 | 立即隔离                             | **`secure.vaults` 消失 ⇒ secure 域判 plain，守卫失效（fail-open）** | ❌                            |
| (c) 自动复制 H → P                               | 无感                    | 复制完即隔离                         | 登记表和 token 出现两份，之后静默分叉                               | ❌                            |
| (d) 提供显式导入命令 `/agent settings adopt`     | 同 (a)，外加一条命令    | 同 (a)                               | 同 (a)                                                              | 可作为后续增强，本 issue 不做 |

traffic.db 采用同一思路（§3.5 inherited），保证评审 #4(i) 提到的历史库不会"消失"。

### 5.7 跟随与仍固定 home 的清单（重写 r1 §5.7，评审 #10）

| 状态                                                    | 跟随 agentDir？                                 | 理由                                                                                                                                                                     |
| ------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 插件设置文件                                            | **是**（带 H 继承）                             | 拍板③                                                                                                                                                                    |
| `traffic.db`                                            | **是**（带 H 继承，外部 recorder 存在时固定 H） | 拍板③                                                                                                                                                                    |
| bash-jobs、quota-state、telemetry、cache-ttl 测量与证据 | 是（现状如此）                                  | —                                                                                                                                                                        |
| memory（`memory/paths.ts:27`）                          | 否（`ARMORY_MEMORY_ROOT` 可覆盖）               | 不在拍板范围；memory B 级 golden、与 Claude Code slug 互通。`convert.mjs` 的 memoryRoot（`agentDir/memory`）与插件不一致是既有问题，**不在 #54 修**（r3 #5），另开 issue |
| workflows journal（`stack.ts:3349`）                    | 否（`workflow.journalDir` 可覆盖）              | 不在拍板范围                                                                                                                                                             |
| web-hub 状态、UI、uploads、socket                       | 否                                              | 每个 uid 一个 hub（§3.7）                                                                                                                                                |
| `feishu-notify.json`                                    | 否（`FEISHU_NOTIFY_CONFIG_PATH` 可覆盖）        | 独立的老插件配置，不在拍板范围                                                                                                                                           |
| `~/.local/share/pi-toolkit-secure`                      | 否                                              | 保险库数据，与 agentDir 无关                                                                                                                                             |

README 新增一节"PI_CODING_AGENT_DIR 与本插件"，列出上表，说明这种混合状态：设了变量的会话仍与 home 共用 memory 和 hub。memory/workflows 是否跟随，另开 issue。

### 5.8 运行时旧名：维持 r1 结论，不动

`Symbol.for` 关系到跨激活和新旧版本混跑；customType 关系到已落盘的会话和 wire（I10）；`[pi-subagent]` 文案被 A 级 `compact-hint-golden.json` 钉住；锁名见 §5.5。

### 5.9 支持范围

- **Linux**：全部功能。
- **macOS**：通常没有 `flock` ⇒ 不迁移（requireLock），新名优先读照常生效；手动 `mv` 后用新名。
- **Windows**：创建 symlink 需要特权 ⇒ 静默留在旧名；agentDir 的 win32 shell 路径转换不镜像。secure 只支持 Linux。

## 6. 实施要点

### 6.1 待拍板

④ 已设 `PI_CODING_AGENT_DIR` 的老用户：**P 下没有文件就继承 `~/.pi/agent`（与升级前一致，在 P 下建文件即隔离）（Recommended）** / 不继承，只告警（secure 会 fail-open）/ 自动复制到 P。traffic.db 同规则。

其余（①②③）已拍板。

### 6.2 拆包与文件域

| 包                                  | 内容                                                                                                                                                                                                                                                        | 文件域（独占）                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 依赖与并行                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **P0 agentDir 收敛 + 测试环境卫生** | `core/agent-dir.ts`、protocol 镜像、helper 镜像；替换 measure-store、provider-evidence、dup-detect、hub.ts 六处、helper `piAgentDir`、helper 向 convert ctx 传 `agentDir`；setup 与 sandbox 清理变量；parity、conformance、恒等测试                         | `src/core/agent-dir.ts`（新）、`src/web-hub/protocol/agent-dir.ts`（新）、`src/cache-ttl/measure-store.ts`、`src/cache-ttl/provider-evidence.ts`、`src/traffic/dup-detect.ts`、`src/web-hub/hub/hub.ts`、`src/secure/bin/helper.mjs`（只动 `piAgentDir` 和 6483 行）、`tests/setup/sandbox-home.ts`、`tests/integration/helpers/home-sandbox.ts`、`tests/config/agent-dir-*.test.ts`（新）、`tests/conformance/agent-dir.test.ts`（新）、`tests/web-hub/boundary.test.ts`（closure 表） | 最先做；`src/core` 只新增文件，不碰正在被改的 `core/*` |
| **P1 设置协议层 + launcher**        | `settings-lock.ts` 全部新增内容；`domain.ts` 改用 location，加 S6b secure 比对和 agentDir-in-vault 检测；helper 设置解析镜像、默认②、status 后缀、78 拒绝；`healSettingsFileLocked`（TS 与镜像）及 launcher 锁内写者接入；`/secure status` 旧 launcher 探测 | `src/secure/settings-lock.ts`、`src/secure/domain.ts`、`src/secure/command.ts`（只动 status 的启动器提示段）、`src/secure/bin/helper.mjs`（441-800 段：设置解析、`loadSecureConfig`、`__vault-*` 写者入口、status 输出）、`tests/secure/settings-file-*.test.ts`（新）、`tests/secure/settings-lock.test.ts`（追加）、`tests/secure/launcher-helper.test.ts`（追加）、`tests/secure/launcher-off-golden.test.ts`（**只追加**设变量的变体运行，fixture 不动）                            | P0 之后                                                |
| **P2 插件接线**                     | `settingsLocation`、`defaultSettingsPath`、`prepareSettingsFile`；ms→s 写回改用 `writeSettingsFileAtomic`；`index.ts` 两行；stack 一次性 notify；编辑器标题                                                                                                 | `src/config/settings.ts`（底部 3440 行至文件尾）、`src/index.ts`（324 行附近与 1312 行）、`src/stack.ts`（只加 notify）、`src/cache-ttl/cache-ttl.ts`（543 行去掉显式路径）、`tests/config/settings-file-rename.test.ts`（新）、`tests/integration/settings-rename-activate.test.ts`（新）、`tests/integration/web-hub-disabled.test.ts:146`、`tests/integration/fabric-xs-off-golden.test.ts:168`（改为调用 `resetSettingsFiles`）                                                     | P1 之后；派发前核对 `src/stack.ts` 是否被其它任务占用  |
| **P3 traffic**                      | §3.5 全部                                                                                                                                                                                                                                                   | `src/traffic/db.ts`、`src/traffic/engine.ts`、`src/traffic/index.ts`（status 行、传 opts）、`tests/traffic/db-path.test.ts`、`tests/traffic/legacy-dir.test.ts`、`tests/traffic/root-select.test.ts`（新）、`docs/dev/traffic-merge/README.md`                                                                                                                                                                                                                                          | P0 之后；可与 P1、P2 并行                              |
| **P4 hub 诊断**                     | `HubRecord.agentDir`、hub 写入、agent 侧读取与 `/webhub status` 提示；`paths.ts` 注释                                                                                                                                                                       | `src/web-hub/hub/hub-json.ts`、`src/web-hub/hub/hub.ts`（只动写 hub.json 那处）、`src/web-hub/agent/index.ts`（`readHubJsonRecord` 与 status 文案）、`src/web-hub/protocol/paths.ts`（只改注释）、对应 tests、`docs/dev/web-hub/README.md`                                                                                                                                                                                                                                              | P0 之后；可与 P1–P3 并行                               |
| **P5 文案与文档**                   | §6.5                                                                                                                                                                                                                                                        | `src/commands/webhub.ts`、`src/web-hub/ui/src/i18n/{zh,en}/spawn.ts`、`src/config/setting-specs.ts`（注释）、`src/secure/config.ts` 文件头、README（中/英）、`docs/guide/tools.md`、`AGENTS.md`、`docs/dev/{data-encryption,feishu-bot,external-agent}/README.md`                                                                                                                                                                                                                       | P2–P4 之后；**批量替换排除 `tests/fixtures/`**         |

发布门禁：P1（launcher 认识新名）与 P2（开始迁移）必须进同一个版本，P2 不能先于 P1 单独发布。pi-secure 的安装方式是 `ln -s` 到本包里的 `src/secure/bin/pi-secure`，与插件同一检出；README 提醒不要让它指向另一个更旧的检出。

### 6.3 开发提示

- 三份 agentDir 实现、两份设置解析实现，各自由一张内联表驱动，不往 `secure-contract-parity.json` 追加内容。
- `settings-lock.ts` 的值导入集合保持 `["node:child_process","node:fs","node:path"]`，因此不用 `node:crypto`：`.lnk` 后缀取 `process.pid` 与 `Date.now()` 拼接后的十六进制，左补零或截断到 16 位。只有锁持有者会创建 `.lnk`，并且步骤 0 会先清理残留，所以不需要密码学随机，也不存在 pid 复用导致的永久失败。
- `domain.ts` 的 closure 增加 `"../core/agent-dir.js"`、`"./settings-lock.js"`；`settings.ts` 的 closure 增加 `"../core/agent-dir.js"`。`tests/web-hub/boundary.test.ts` 的表要显式更新，这是"有意识的表更新"，不涉及 hub 白名单（hub 侧用的是 protocol 镜像）。
- 整个迁移流程同步执行，不引入定时器（I5）。
- 任何测试和验收都只做 `lstat`/`readlink`/`stat` 级别的检查，**不打印设置文件内容**。

### 6.4 测试清单

| ID       | 测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 包       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| T-AD1    | 一致性表：`resolveAgentDir` 在 core、protocol、helper.mjs 三份实现上，对 未设 / `""` / `" "` / `"~"` / `"~/x"` / 绝对路径 / 带尾斜杠的绝对路径 / 等于 H / `file:///x` / 相对路径 `"rel"` 逐行结果相同                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | P0       |
| T-AD2    | conformance（`tests/conformance/agent-dir.test.ts`），**只 import `@earendil-works/pi-coding-agent` 的公开导出**：除相对路径外的每个值，用 `vi.stubEnv` 设好后断言 `join(resolveAgentDir(process.env,homedir()).dir,"x") === join(getAgentDir(),"x")`；`CONFIG_DIR_NAME===".pi"`；变量名用行为探针证明（设 `PI_CODING_AGENT_DIR=<tmp>` ⇒ `getAgentDir()===<tmp>`；删除 ⇒ `join(homedir(),CONFIG_DIR_NAME,"agent")`）。不 import `dist/config.js`（会 `ERR_PACKAGE_PATH_NOT_EXPORTED`）。写进 AGENTS.md 的 peer bump 清单                                                                                                                                                                                                                                                                                                                                                                                                                        | P0       |
| T-ID1    | **恒等证明**：env ∈ {未设, `""`, `"~/.pi/agent"`, `join(home,".pi","agent")`, 带尾斜杠形式} 时，`defaultSettingsPath()`、`settingsLocation().scope==="default"`、`defaultRecordPaths()`、`defaultMeasureStorePath()`、provider-evidence 路径、hub 的 `hubAgentDir`、helper 的 `settingsFilePath`/`settingsLockPath`/`piAgentDir`，都等于改动前的字面公式                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | P0/P1/P3 |
| T-ID2    | 变量设为 `""` 和"等于默认"时，`off-golden.test.ts` 的三个场景仍与 fixture 一致（在 test 文件里增加参数化循环，fixture 不动）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | P1       |
| T-ID3    | `launcher-off-golden.test.ts`：对 7 个无文件 case 加 `status-locked-all`，在 `makeEnv` 的 env 里额外放 `PI_CODING_AGENT_DIR` = `""` 或 `<home>/.pi/agent` 再跑一遍，与 fixture 原 case 字节相同（自门控，需要 `/dev/fuse`，真机执行）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | P1       |
| T-SB1    | setup 卫生：`tests/setup/sandbox-home.ts` 记下 `REAL_AGENT_DIR` 后 `delete process.env.PI_CODING_AGENT_DIR`；`sandboxHome()` 保存、清空、还原该变量。**不做快照比对**（开发机上有真实 pi 在写，会偶发失败，r3 #4）。改为沿用该文件对 `net`/`child_process` 的拦截手法，用 `syncBuiltinESMExports` 包装 `node:fs` 的写类同步 API（`writeFileSync`、`renameSync`、`linkSync`、`symlinkSync`、`unlinkSync`、`rmSync`，以及带写/创建标志的 `openSync`），**断言测试进程自己没写过**受保护目标。受保护目标为 `R ∈ {REAL_AGENT_DIR, REAL_HOME/.pi/agent}` 下的 `pi-toolkit.json*`、`pi-subagent.json*`、`.pi-subagent.json.lock`、`records/`，任一参数路径落进去即记违规，`afterEach` 报错，`withRealHomeAllowed` 可豁免。`guardSpawn` 追加一条：子进程 env（显式或继承）里的 `PI_CODING_AGENT_DIR` 解析后等于 `REAL_AGENT_DIR` 即违规。原生代码（`node:sqlite`）打开的库不在拦截范围，traffic 由「测试一律注入 dbPath 或使用沙箱 HOME」加 T-TR1 保证 | P0       |
| T-SF1    | 文件名解析表 S0–S7（含 S6a 同 inode、S6b 不同 inode、外部链接、绝对目标的兼容链接、悬空兼容链接），TS 与 helper 同表                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | P1       |
| T-SF2    | 位置解析：scope default / agentDir（P 有文件）/ inherited（P 空、H 有）/ agentDir（都空）；P 只有悬空兼容链接时的行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | P1       |
| T-MG1    | 迁移正常路径：NEW 与原 inode 相同；LEGACY 变成 `readlink==="pi-toolkit.json"`；两名读到相同内容；第二次调用为 noop；无 `.lnk` 残留                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | P1       |
| T-MG2    | **崩溃注入**：用 `afterLink` 抛异常模拟 c 之后的中断 ⇒ 状态为 S6a；`resolveSettingsFile` 返回 `legacy:"same-inode"` 且不算冲突；再调一次 ⇒ `migrated, healed:true`、处于 S5。另外用子进程在 c 之后 `process.kill(self,'SIGKILL')` 做一次真实的进程级验证                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | P1       |
| T-MG3    | 跳过与冲突：外部链接；非本人；锁被占（spawn 一个 `flock` 持有者）⇒ `lock`；`flockBin` 不存在 ⇒ `no-flock` 且**文件系统完全不变**；`secure.vaults.x.pending` ⇒ `secure-txn`；注入 `link` 抛 EPERM ⇒ 静默留在 S1；注入 `symlink` 抛 EPERM ⇒ 回到 S1、NEW 被删；`afterLink` 里原子替换 LEGACY ⇒ `conflict`，`.lnk` 已清理；NEW 被抢先创建 ⇒ `conflict`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | P1       |
| T-MG4    | 多进程并发：6 个子进程同时迁移 ⇒ 恰好 1 个 `migrated`，其余 `noop`，最终 S5；另有 4 个读方进程循环 `readFileSync(LEGACY)` 与 `readFileSync(location.path)`，全程每次都解析成功且内容一致（评审 #14 的读方并发）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | P1       |
| T-MG5    | 锁互通：迁移持锁期间 helper `registerVault` 等待；之后 launcher 写入 NEW（普通文件），兼容链接仍在；`settingsLockPath(NEW)` 以 `.pi-subagent.json.lock` 结尾                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | P1       |
| T-MG6    | **S6a 写者矩阵**（r3 #1）：初始状态 ∈ {S0,S1,S2,S3,S4,S5,S6a,S6b} × 写者 ∈ {`persistSettingOverride`（省略 path）、`persistSettingOverride`（显式 NEW）、ms→s 写回、helper `registerVault`、`patchVaultEntry`}。断言：① 写入内容出现在写后 `location.path` 上；② 初始不是 S6b 时，写后状态 ∉ {S6a, S6b}，初始为 S6a 时写后为 S5，注入 symlink EPERM 时写后为 S1 且写进了 LEGACY；③ 初始为 S6b 时保持 S6b（新版写者不修冲突，也不制造冲突）；④ 写入涉及 `secure.vaults` 时 domain 与 launcher 都不报 `secure:invalid`                                                                                                                                                                                                                                                                                                                                                                                                                            | P1/P2    |
| T-SC4    | `/secure status` 旧 launcher 探测（r3 #3）：注入 `which`：不存在 ⇒ 无提示；指向本检出 ⇒ 无提示；指向临时目录里不含标记的 `helper.mjs` ⇒ S5 时出现警告行、S1 时不出现；含标记 ⇒ 无提示                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | P1       |
| T-SC1    | S6b 时 secure 段不一致 ⇒ domain `config.valid===false`、error 文案正确；launcher `status` 显示 `!` 行、`run` 返回 78；secure 段一致（或两边都没有）⇒ 正常                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | P1       |
| T-SC2    | agentDir 位于保险库 `mnt` 或 `dir` 内 ⇒ domain locked 且原因正确，launcher `run`/`unlock` 返回 78；`source==="default"` 时不触发                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | P1       |
| T-SC3    | 旧 launcher 语义：`assertWritableSettingsFile(LEGACY)` 在 S5 下拒绝（既有行为，加回归断言）；locked 原因在 `source==="env"` 时带设置路径后缀，否则与现状相同                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | P1       |
| T-PL1    | `prepareSettingsFile` 加 activate 集成：沙箱里写旧名 ⇒ S5、设置生效、编辑器 path 为 NEW；子会话 activate（HOST_KEY 已占）时文件系统零触碰（对比 ino 与 mtime）；S6b 时在首次 session_start notify 一次，activate 的调用序列与 S5 时相同                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | P2       |
| T-PL2    | `persistSettingOverride`：S5 写 NEW 且链接保留；inherited 时写 H；agentDir 时写 P；锁文件在对应目录                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | P2       |
| T-PL3    | ms→s 写回在 S2（外部链接）下保留链接                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | P2       |
| T-PL4    | 降级模拟：S5 下按旧版语义 `writeSettingsFileAtomic(LEGACY)` 写入后 NEW 内容更新、链接保留；`writeFileSync(LEGACY)` 跟随链接                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | P2       |
| T-TR1    | traffic 根目录五分支 + 恒等（T-ID1）+ `db-path.test.ts:77` 改标题后仍然通过 + P 下 `dumps/` 时 legacy 检测在 P 上判定 + `/record status` 后缀（默认时没有后缀）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | P3       |
| T-HB1    | hub.json：默认时不写 `agentDir`（与现状逐字节相同）；env 时写入；agent 侧的提示文案；旧 hub.json 缺字段时的提示                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | P4       |
| T-DOC    | `tests/docs/agents-md.test.ts`（K7 仍包含 `pi-subagent.json` 子串）、`tests/web-hub/boundary.test.ts`、`npm run check:web`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | P0/P5    |
| 冻结门禁 | `git diff --quiet origin/dev -- tests/fixtures/`；`off-golden`、`config-parity`、`launcher-off-golden`、`fabric-xs-off-golden`、`compact-hint` 全绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 每包     |
| 全量     | `format:check` → `typecheck` → `test` → `build`（P5 加 `build:web` 与 `check:web`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 每包     |

另外要更新的入口和 harness（评审 #14）：`tests/secure/helpers.ts:63`、`tests/secure/private-real-harness.ts`、`scripts/dev/readme-shots/tui/setup.sh:9`、`scripts/dev/secure-ns-probe.sh:287` 继续写旧名，作为"旧名回退"的覆盖，**不改**，在 P1 报告里注明。`tests/integration/fabric-xs-off-golden.test.ts:168` 在首次 activate 之前就 rm，因此也换成 `resetSettingsFiles(home)`（同时删两个名字），以免日后被同进程的前序用例污染。

### 6.5 文档要点（P5）

- README（中/英）113 行：主名改为 `<agentDir>/pi-toolkit.json`（默认 `~/.pi/agent`）；说明旧名会自动迁移并保留为兼容链接、两份都在时以新名为准并给出可见告警、"请编辑 pi-toolkit.json"；新增"PI_CODING_AGENT_DIR 与本插件"一节（§5.7 表、inherited 规则、traffic 手动迁移、hub 级单一 agentDir、launcher 与 pi 须同一环境）；新增"降级/回滚"一节（§7）。
- `AGENTS.md`：
  - I7 改为 `` `.pi-subagent.json.lock` (the settings file became `pi-toolkit.json` in #54; legacy `pi-subagent.json` stays a read fallback / compat symlink) ``（保留子串，K7 不用改）；
  - "What this is"那句同步改；
  - peer bump 清单第 2 条加入 `tests/conformance/agent-dir.test.ts`。
- `docs/dev/data-encryption/README.md`：锁名固定；launcher 按 agentDir 加新名优先解析；S6b 与 agentDir-in-vault 两条 fail-closed 规则。
- `docs/dev/web-hub/README.md`（P4）：§3.7 规则。`docs/dev/traffic-merge/README.md`（P3）：1b 修订。
- `docs/dev/**` 其余历史文档、`tests/fixtures/**` **不改**。

### 6.6 端到端验收（评审 #17；全部在 `mktemp -d` 出来的沙箱 HOME 里做，只看 lstat、readlink、stat，不打印内容）

1. **未设变量的老用户升级**：沙箱 HOME 放 `pi-subagent.json`（普通文件）⇒ 启动真实 `pi`（tmux）⇒ `pi-toolkit.json` 为普通文件且 ino 等于原文件；`readlink pi-subagent.json` 为 `pi-toolkit.json`；`/agent settings` 标题为新路径；`pi-secure status` 的 `settings:` 行为新路径。
2. **已设变量的老用户升级**：HOME 下有旧名，`PI_CODING_AGENT_DIR=$SB/agent2` 且该目录为空 ⇒ 启动后 `$SB/agent2` 下不出现设置文件；H 下完成迁移；编辑器标题带 `(inherited from ~/.pi/agent)`；`/record status` 数据库行带"继承"。在 `$SB/agent2` 下 `echo '{}' > pi-toolkit.json` 后重启 ⇒ 改用 P。
3. **降级再升级**：在 S5 状态下用 v0.10.0 检出启动（经链接读到设置）⇒ `/agent settings set` 一个键 ⇒ NEW 的 mtime 变化、链接仍在 ⇒ 切回新版，状态仍是 S5。再执行 `mv pi-toolkit.json pi-subagent.json` ⇒ 新版重新迁移成功。
4. **崩溃窗口**：用测试缝构造 S6a ⇒ 启动 ⇒ 自愈到 S5，没有冲突告警。
5. **hub**：从设了变量的会话 `/webhub restart` ⇒ `hub.json` 出现 `agentDir` 键（只检查键是否存在）⇒ 从未设变量的会话查看 `/webhub status`，出现 mismatch 提示 ⇒ 网页新建一个会话，它的设置位置（编辑器标题）跟随 hub 的 agentDir。
6. **secure**：变量只设在 pi 一侧 ⇒ `pi-secure status` 与 `/secure status` 打印的设置路径不同，locked 原因带上提示。

### 6.7 风险

- **测试"重置"写法**：§6.4 已列出的两处，P2 实施时再执行 `grep -rn "pi-subagent.json" tests | grep -E "rmSync|unlink"` 复查。
- **不守锁的写者**（编辑器、≤v0.8.0）：link 不会覆盖已有文件（EEXIST）；步骤 f 复查 inode。剩余窗口只有 f 到 g 之间几微秒内的手工原子保存，可接受，写进 README。
- **旧版写者遇到崩溃遗留的 S6a**（r3 #1 的残留）：新版迁移中途崩溃，用户又在新版下次启动之前降级。旧版写入可能把 S6a 变成 S6b，由 S6b 可见告警兜底，人工合并（§7）。
- **过旧的 pi-secure launcher**（r3 #3 的残留）：只有 `/secure status` 能探测到；没跑过它的用户会先看到旧 launcher 自己的"是符号链接"拒写报错。补救命令见 §3.6 第 5 条，并写进 README。
- **变量只设在 wrapper 里**：靠路径后缀和原因提示让人看得见，无法根治，文档说明。
- **hub 级单一 agentDir**：一个明确的限制。若以后要让 spawn 请求携带 agentDir，必须是追加式可选字段（I10），另开 issue。

## 7. 回滚

- **代码**：按 P5 → P2 → P3/P4 → P1 → P0 的顺序 revert。P0、P1 单独保留时，未设变量的行为与现状相同。revert 之后的旧代码经兼容链接读写，配置完整。设了变量的用户回到"固定 H"，而在 inherited 模式下 H 本来就是权威位置，不会丢；只有已切到 P 的用户需要手动把 P 下的文件拷回 H。
- **用户侧回到旧布局**：`mv ~/.pi/agent/pi-toolkit.json ~/.pi/agent/pi-subagent.json`（评审已在 `/tmp` 实测：GNU mv 能用真实文件替换指向源文件的链接）。之后再升级会重新迁移。
- **S6b 人工处理**：合并进 `pi-toolkit.json`，然后删除或改名 `pi-subagent.json` ⇒ 进入 S4，不会再生成链接。
- **traffic**：本方案从不移动库文件，回滚不需要任何数据操作。

---

## 用户拍板（2026-10-26，覆盖正文冲突处）

- 迁移：锁内复制 + 旧名替换为兼容符号链接（推荐方案）。
- launcher 无任何设置文件时默认旧名（A′ golden 不变）。
- **插件设置与 traffic.db 本次就跟随 PI_CODING_AGENT_DIR / getAgentDir()**（正文推荐暂不跟随，以此为准；方案需补：目录来源收敛函数、未设变量时与现状字节一致、已设变量用户的迁移/回退、secure launcher 与 hub 侧的一致性、测试）。

> r2 注：第一条由 §3.4 的"link 发布（零拷贝复制）+ 兼容链接"实现，终态与兼容性完全一致，论证见 §3.4 末尾与 §5.1。第三条由 §3.2–§3.7 落实；新增的子决策 ④ 见 §6.1。

---

## r2 修订对照表

| #      | 评审意见（摘要）                                                                         | r2 处理                                                                                                                                                                                                      | 位置                            |
| ------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| 1      | 步骤 5–7 之间崩溃留下两份普通文件，被判成 S6 后永不自愈；并发快速路径会误报              | **采纳 (a) 与 (b) 的结合**：改为 `link(LEGACY,NEW)` 发布，中间态是同 inode 的 S6a，不算冲突，下次锁内补完 e–g；去掉复制、比对、回滚                                                                          | §3.3 S6a、§3.4、T-MG2           |
| 2      | 已设变量用户升级后读到空目录，静默回落默认值，`secure.vaults` 丢失                       | 两级定位：P 下没有文件就**继承 H，读写都在 H**（与升级前一致）；不自动复制；在 P 下建文件即隔离；列为拍板④                                                                                                   | §3.3、§5.6、§6.1                |
| 3      | 四份互不一致的 agentDir 镜像；相对路径与 launcher 的 `cd /` 冲突                         | `core/agent-dir.ts` 作为唯一权威，protocol 与 mjs 两个镜像；同一张表做一致性测试，conformance 测试对照真实 `getAgentDir()` 并写进 peer bump 清单；相对值三份一律忽略并告警；收敛全部旧镜像，包括 hub.ts 六处 | §2.2、§3.2、T-AD1/2             |
| 4      | traffic.db 跟随后历史丢失、WAL 不能复制、外部 recorder、dumps 判定、测试与 1b            | 独立的五行根目录选择：inherited 回退、外部 recorder 存在时固定 H、不复制、legacy 在选中的根上成对判定；`db-path.test.ts:77` 语义保留；traffic-merge README 标注修订                                          | §3.5、T-TR1                     |
| 5      | hub 一机一个，headless 继承首个会话的 agentDir；`paths.ts` 注释                          | 明确"hub 状态不跟随、hub 级单一 agentDir"；`hub.json` 追加可选 `agentDir`（只在 env 时写）；`/webhub status` 给出 mismatch 提示；不改 wire；更新注释                                                         | §3.7、T-HB1                     |
| 6      | launcher 与 pi 环境不同时会误判 locked，难排查                                           | `pi-secure status` 与 `/secure status` 打印路径和 scope 后缀（只在非默认时）；locked 原因带上提示；文档说明                                                                                                  | §3.6 第 1 条、T-SC3             |
| 7      | agentDir 指向保险库内，登记表藏进自己描述的保险库                                        | 列为不支持：domain 判 locked，launcher 返回 78，规则与 init 嵌套检查相同；只在 env 时生效                                                                                                                    | §3.6 第 2 条、T-SC2             |
| 8      | `sandboxHome` 只改 HOME，开发机设了变量会污染真实目录                                    | setup 删除变量，`sandboxHome` 保存、清空、还原；（r3 把快照比对改为 fs 写拦截，见 r3 #4）；launcher golden 本来就是显式 env，再加设变量的变体                                                                | §6.4 T-SB1、T-ID3               |
| 9      | 缺少"未设变量时逐字节一致"的证明                                                         | "空串视为未设"和"等于默认视为未设"写成显式规则；T-ID1/2/3 用参数化方式覆盖全部路径函数和两套 golden                                                                                                          | §3.2、§6.4                      |
| 10     | r1 §5.7 与拍板冲突；memory、hub 等割裂                                                   | 重写为最终的"跟随与固定"清单和理由；README 说明混合状态；（r3 撤回 convert memoryRoot 修正，见 r3 #5）                                                                                                       | §5.7                            |
| 11     | S6 下 domain 只读 NEW 可能 fail-open；`sed -i` 等会把链接换成普通文件；只有 console.warn | S6b 时比较两份的 secure 段，不一致 ⇒ `secure:invalid` / launcher 78；冲突在既有 session_start 路径 notify（不新增注册）；README 提示编辑新名                                                                 | §3.6 第 3 条、§3.8、§5.3、T-SC1 |
| 12     | 没有 flock 时迁移无互斥；新插件配旧 launcher 会锁死 pending 的保险库                     | `requireLock`：不加锁就不迁移；存在 `pending` 或 `relocate` 时跳过；P1 与 P2 同版本发布作为门禁；文档说明同一检出                                                                                            | §3.4 步骤 b、§4.2、§6.2         |
| 13     | tmp 文件用 pid 命名并 O_EXCL，加上 EXDEV 分支和支持范围不清，失败会反复重试              | 不再有 NEW 的 tmp 文件；`.lnk` 带随机后缀，锁内清理；删掉 EXDEV 分支；明确支持范围；不支持时静默留在旧名，每次只多一次 `link(2)`，不刷告警、不需要标记                                                       | §3.4、§5.9                      |
| 14     | 测试缺口；入口清单遗漏；fixtures 必须排除在批量替换外                                    | 补上崩溃注入、S6a 收敛、读方并发、no-flock、旧 launcher 拒写；列出遗漏的入口并给出处理；`fabric-xs-off-golden` 的 rm 改为两名都删；批量替换排除 `tests/fixtures/`                                            | §6.4、§6.5                      |
| 15     | 建议与 R0 或 rename+symlink 比较以降低复杂度                                             | 部分采纳：迁移改为 link + symlink 的直线状态机（比 rename+symlink 多了不覆盖和可自愈）；R0 违背拍板①，不采纳；agentDir 维度做成薄包装，traffic 独立；TS 与 mjs 共用一张表                                    | §5.1                            |
| 16     | 无法确认 #59 已合入；需要新的拆包                                                        | 已确认 `43d892fd`（提交信息不含编号）；重写为 P0–P5 六个包，含 agentDir 收敛、traffic、hub 独立包，并给出文件域与并行关系                                                                                    | 文首、§6.2                      |
| 17     | 没有端到端验收                                                                           | 新增六个场景，全部只做 lstat、readlink 级别检查                                                                                                                                                              | §6.6                            |
| 未核实 | hub 的 `db-client.ts`/`http.ts` 是否读 traffic.db；`normalizePath` 的实现                | `normalizePath` 已逐行核对（`dist/utils/paths.js:59`，见 §2.2）；`grep -rln "traffic.db\|defaultRecordPaths" src/web-hub` 无命中：hub 不读 traffic.db，P3 不涉及 hub                                         | §2.2、§6.2                      |

---

## r3 修订（复审有条件通过后的 5 条）

| #         | 复审意见                                                                                         | r3 处理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 位置                                                          |
| --------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1 [major] | S6a 在自愈前被写者 tmp+rename 后变成永不自愈的 S6b；r2 只覆盖了读方                              | **采纳"写前自愈"**：新增 `healSettingsFileLocked(dir)`（TS + launcher 镜像，与迁移的 S6a 分支共用一份实现）。所有新版写者（`persistSettingOverride`、ms→s 写回、launcher 的 `__vault-*` 写者）改为「锁内 heal → 锁内解析目标 → 读改写」。`persistSettingOverride` 的 path 改为可选并在锁内解析，cache-ttl 去掉显式路径。否决"写时重建链接"（写与重建之间崩溃会制造 S6b）和"就地写"（放弃原子写）。新增不变式"新版写者从不制造 S6b"，由 T-MG6 矩阵证明。旧版写者叠加崩溃窗口的情况列为残留 | §3.4.1、§3.8、§4.2–§4.4、§6.2、§6.4 T-MG6、§6.7               |
| 2 [minor] | `ENV_AGENT_DIR` 不在 pi 的公开导出里，import `dist/config.js` 会 `ERR_PACKAGE_PATH_NOT_EXPORTED` | 已核对 `package.json` 的 `exports`（只有 `.` 和 `./rpc-entry`）与 `index.d.ts`（导出 `CONFIG_DIR_NAME`、`getAgentDir`）。conformance 只用公开导出：直接断言 `CONFIG_DIR_NAME`，变量名改用行为探针（设变量 ⇒ `getAgentDir()` 返回该值）                                                                                                                                                                                                                                                    | §3.2、§6.4 T-AD2                                              |
| 3 [minor] | 过旧的 launcher 在迁移后拒写，r2 只靠文档                                                        | 两手都做：`/secure status` 运行时探测 PATH 上的 `pi-secure`（realpath 后在其 `helper.mjs` 里找新名标记，只读前 64 KiB），旧版且已迁移时给出带 `ln -sf` 修复命令的警告行，全文见 §3.6 第 5 条；没跑过 `/secure status` 的情况明确列为残留风险，并给出补救命令                                                                                                                                                                                                                              | §3.6 第 5 条、§6.2 P1（`src/secure/command.ts`）、T-SC4、§6.7 |
| 4 [minor] | lstat 快照比对在开发机有真实 pi 运行时会偶发失败                                                 | 去掉快照。改为在测试进程内拦截 `node:fs` 写类 API（与现有的 `net`/`child_process` 拦截同一手法），断言"测试进程自己没写过"真实 agentDir 和 home 下的设置、锁、records 路径；`guardSpawn` 增加对子进程 `PI_CODING_AGENT_DIR` 指向真实目录的检查；明确原生 sqlite 不在拦截范围，以及对应的保障方式                                                                                                                                                                                          | §6.4 T-SB1                                                    |
| 5 [minor] | convert memoryRoot 修正会改变已设变量用户的行为，不属于 #54                                      | **移出 #54**。`convert.mjs` 一行不改，helper 只是把收敛后的 `agentDir` 传进 ctx（`memoryRoot = agentDir/memory` 的公式不变；对绝对路径值，传入结果与原来的 `path.resolve` 相同）。它与插件 memory 根目录的既有差异另开 issue                                                                                                                                                                                                                                                              | §3.2 表、§5.7、§6.2 P0                                        |

- ④（2026-10-26 补拍）：已设变量的老用户，P 下没有设置文件时继承 `~/.pi/agent`（与升级前一致），在 P 下建文件即隔离；traffic.db 同规则。
