# #54 P1：设置协议层 + launcher

依据 `plan.md` r3（含用户拍板①②③④）实施 §6.2 的 P1。没有任何 git 写操作；`tests/fixtures/` 未动（`git diff --quiet HEAD -- tests/fixtures/` 通过）；只用沙箱 HOME，不打印设置文件内容；未碰并行 #61 包的文件，也未碰 P2 的 `src/config/settings.ts`、`src/index.ts`、`src/stack.ts`。

> **发布门禁（必须遵守）**：P1 与 P2 必须同版发布。本包合入后，P2 合入前**不得单独发版**。P1 单独存在时，插件仍然只读写旧名，没有人发起迁移，所以行为与现状一致，但 launcher 已经认识新名。如果 P2 先于 P1 上线，旧 launcher 会拒写兼容链接。

## 交付内容

**`src/secure/settings-lock.ts`**（pi-free；值导入集合仍是 `node:child_process / node:fs / node:path`，`AgentDirInfo` 只用 `import type`）

- 常量 `SETTINGS_FILE_NAME` / `LEGACY_SETTINGS_FILE_NAME` / `SETTINGS_LOCK_FILE_NAME`。`settingsLockPath` 固定返回 `<dir>/.pi-subagent.json.lock`（I7）。
- `resolveSettingsFile(dir)`（S0–S7，纯读、永不抛，含 S6a 同 inode、S6b 冲突与 `legacyNewer`、外部链接、绝对目标兼容链接、悬空兼容链接）。`resolveSettingsLocation(agent)`（default / agentDir / inherited 三档）。
- `migrateLegacySettingsFile(dir)`：`link(LEGACY, NEW)` 加 `.lnk` 符号链接换名。包含 `requireLock`、`secure-txn` 跳过、EEXIST 与锁外替换都判冲突、link 或 symlink 不受支持时静默回到 S1，以及 `afterLink` / `link` / `symlink` / `lstat` 测试缝。
- `healSettingsFileLocked(dir)`：只能在锁内调用，只补完 S6a，永不抛。
- `withSettingsFileLock` 新增 `requireLock`，失败结果追加可选的 `reason`（`no-flock` / `lock` / `open`），属于追加式改动，旧调用方不受影响。

**`src/secure/domain.ts`**

- 改为经 `resolveAgentDir` 与 `resolveSettingsLocation` 定位设置文件；显式 `deps.settingsPath` 仍然优先。
- S6b 时比较两份文件的 `secure` 段（键排序后序列化）。不一致就返回 `secure:invalid`，即 `config.valid=false`，错误文案为"两份设置文件的 secure 段不一致"；另一份不可读也算无效；另一份缺失则忽略。
- 环境变量选中的 agentDir 与已登记保险库的 dir/mnt 嵌套（双向，词法与 realpath 两族）时，判 `locked`。
- "不是已登记的保险库"这条原因，在 agentDir 来自环境变量时追加设置文件路径与"请确认 pi-secure 在同一环境下运行"。未设变量时这条原因与现状逐字节相同。

**`src/secure/command.ts`**（仅 status 段）

- 新增 `staleLauncherWarning()`：用可注入的 `which` 找 PATH 上的 `pi-secure`，只读其同目录 `helper.mjs` 的前 64 KiB，查找 `SETTINGS_FILE_NAME = "pi-toolkit.json"` 标记。仅在 location 为 `new`（S4/S5/S6x）时才可能警告，警告里带 `ln -sf` 的修复命令。
- `renderSecureStatus` 新增可选输入 `settings` 与 `launcherWarning`。
- **偏离方案一处**：方案写"`/secure status` 打印设置文件路径和 scope"。实现为**仅在 scope 不是 default 时**追加"设置文件："一行，默认目录下的输出与现状逐字节一致（有断言）。

**`src/secure/bin/helper.mjs`**（设置段）

- 镜像 `resolveSettingsFile` / `resolveSettingsLocation` / `healSettingsFileLocked` / `agentDirVaultOverlap`。常量 `SETTINGS_FILE_NAME = "pi-toolkit.json"` 在文件前 64 KiB 内（有断言），供旧 launcher 探测使用。
- `settingsFilePath(home, env)` 与 `settingsLockPath(home, env)`：没有任何设置文件时默认旧名（拍板②）；env 参数放在最后并带默认值，旧调用方签名兼容。
- `loadSecureConfig(home, env)`：S6b 的 secure 段比对，不一致时返回 `valid:false`；agentDir 与保险库嵌套时返回 `agentProblem`。**默认情况下返回的键仍是 `["cfg","file"]`**（有断言）。
- `resolveVault`：有 `agentProblem` 时以 78 拒绝，`run` / `unlock` / `init` 因此被拒。`lock` 和 `status` 传 `allowAgentInVault:true`，不受影响。
- 锁内写者（`registerVaultUnlocked`、`patchVaultEntryUnlocked`、`removeVaultEntryUnlocked`、`unclaimInitEntryUnlocked`）第一步调用 heal 再解析目标。launcher 不发起迁移。
- `status`：agentDir 来自环境变量时，`settings:` 行追加 `[agentDir: env]` 或 `[inherited]`；相对路径被忽略时多一行提示；`agentProblem` 多一行 `!`。未设变量时输出逐字节不变（T-ID3 证明）。

**范围外但必须的一行**：`tests/web-hub/boundary.test.ts` 里 `src/secure/domain.ts` 的值导入 closure 表，加上 `../core/agent-dir.js` 与 `./settings-lock.js`。这是方案 §6.3 要求的"有意识的表更新"，该文件不在 P1 文件域清单内，需要调度方知悉。

## 测试

| ID                   | 文件                                                | 要点                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-SF1 / T-SF2        | `settings-file-resolve.test.ts`（新）               | 14 行 S0–S7 表同时驱动 TS 与 mjs，深度相等；位置三档，含悬空兼容链接留在 P、P 空且 H 有文件时继承                                                                                                                                                                                                                                                                                                          |
| T-MG1–MG5            | `settings-file-migrate.test.ts`（新）               | 正常路径（inode、mode、nlink、幂等）；`afterLink` 抛异常与真实 `SIGKILL`（tsx 子进程）后进入 S6a 再自愈；残留 `.lnk` 清理；no-flock 时文件系统不变；锁被占；foreign-owner；secure-txn；link 或 symlink 遇 EPERM；锁外替换 LEGACY ⇒ conflict 且未覆盖；EEXIST；6 个进程并发迁移恰好 1 个 migrated；4 个读进程循环读取，全程内容完整；launcher 等待持锁方后写入 NEW                                          |
| T-MG6（launcher 半） | `settings-file-heal.test.ts`（新）                  | 8 种初态 × `registerVault` / `patchVaultEntry` / `removeVaultEntry` 真实子进程写者：S6a ⇒ S5，S6b 保持，S2 拒写且链接目标不变，写后 domain 与 launcher 都不报 invalid；`unclaimInitEntry` 同样自愈；TS 与 mjs 两个 heal 实现对照；协议级证明"不 heal 的同一写入会制造 S6b"                                                                                                                                 |
| T-SC1–SC4            | `settings-file-secure.test.ts`（新）                | S6b 的 secure 段不一致（domain、launcher、`run`/`unlock` 78、status `!`）；一致或键序不同则有效；agentDir 嵌套三种形态 ⇒ locked 与 78（`run`/`unlock`/`init`），`lock` 不被拦；不相关目录、默认目录、`secure.enabled=false` 不触发；locked 原因的路径提示；旧 launcher 拒写兼容链接（回归）；status 的 `[agentDir: env]` 标记与相对路径提示；旧 launcher 探测的 6 种情形；本检出的 helper 前 64 KiB 含标记 |
| T-ID2                | `settings-file-identity.test.ts`（新）              | secure-off golden 的 3 个场景，在 `""`、默认目录、带尾斜杠、`~/.pi/agent` 四种写法下，新旧两种文件名各跑一遍，verdict、activation trace、envDelta 都与 fixture 一致（fixture 只读）                                                                                                                                                                                                                        |
| T-ID3                | `launcher-off-golden.test.ts`（只追加）             | 7 个无设置文件 case 加 `status-locked-all`，环境变量设为 `""`、默认目录、带尾斜杠三种写法，字节与 A′ fixture 相同（真机 fake-gocryptfs 块，本机 `/dev/fuse` 可用，已执行）                                                                                                                                                                                                                                 |
| 追加                 | `settings-lock.test.ts` / `launcher-helper.test.ts` | 固定锁名、`requireLock`、`reason`；launcher 的默认旧名、新名优先、悬空链接、env 三档、`loadSecureConfig` 默认形状                                                                                                                                                                                                                                                                                          |

`tests/secure/helpers.ts`、`private-real-harness.ts`、`scripts/dev/*` 继续写旧名作为"旧名回退"覆盖，按方案不改。

## 自验

| 命令                                                                                                                       | 结果                     |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `npm run typecheck`                                                                                                        | PASS（TS7 ×2 + vue-tsc） |
| `npx vitest run tests/secure --maxWorkers=2`（含真 gocryptfs 自门控）                                                      | 见下方"最终全量结果"     |
| `npx vitest run tests/config tests/conformance/agent-dir.test.ts tests/web-hub/boundary.test.ts tests/docs --maxWorkers=1` | PASS：45 文件 / 609 测试 |
| `npx prettier --check src/secure tests/secure tests/web-hub/boundary.test.ts`                                              | PASS                     |
| `git diff --quiet HEAD -- tests/fixtures/`                                                                                 | PASS                     |

改动前基线：新代码接入后、新增测试加入前，`tests/secure` 原有 31 个文件全部通过（1419 通过 / 1 跳过，518 秒）。

## 遗留与注意

- **P2 接线未做**：`prepareSettingsFile`、`persistSettingOverride` 的锁内 heal 与可选 path、`loadSettingsFromFile` 写回、cache-ttl 去显式路径都在 P2。本包把"锁 → heal → 解析 → 原子写"的协议用 `settings-file-heal.test.ts` 的"plugin-side write protocol"在协议层固定住，P2 必须实现同一组合，并补 T-MG6 插件半（含 `persistSettingOverride` 与 ms→s 写回）、T-PL*。
- **T-MG3 的 `not-regular` 分支**未单独测试：在单一 lstat 视图下，`legacyType` 为 file 与 probe 为非 file 无法同时成立。该分支是防锁外替换的第二道检查，已由"锁外替换 LEGACY ⇒ conflict"间接覆盖。
- 迁移的 no-flock 路径会先创建 `.pi-subagent.json.lock`（`withSettingsFileLock` 先开锁文件再找 flock）。设置文件和 `.lnk` 完全不变，已断言；锁文件本身是 0600 空文件。
- `docs/dev/data-encryption/README.md` 的 launcher 解析、S6b、agentDir-in-vault 两条 fail-closed 规则未写，按方案归 P5。
- 本会话没有 `Agent` 派发能力，没有做 dev-flow 要求的异源独立 verifier，建议调度方派独立验收。

## 改动文件（绝对路径）

- `/home/bluecake/ai/pi-toolkit/src/secure/settings-lock.ts`
- `/home/bluecake/ai/pi-toolkit/src/secure/domain.ts`
- `/home/bluecake/ai/pi-toolkit/src/secure/command.ts`
- `/home/bluecake/ai/pi-toolkit/src/secure/bin/helper.mjs`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/boundary.test.ts`（仅 domain closure 一行表更新）
- `/home/bluecake/ai/pi-toolkit/tests/secure/settings-file-resolve.test.ts`（新）
- `/home/bluecake/ai/pi-toolkit/tests/secure/settings-file-migrate.test.ts`（新）
- `/home/bluecake/ai/pi-toolkit/tests/secure/settings-file-heal.test.ts`（新）
- `/home/bluecake/ai/pi-toolkit/tests/secure/settings-file-secure.test.ts`（新）
- `/home/bluecake/ai/pi-toolkit/tests/secure/settings-file-identity.test.ts`（新）
- `/home/bluecake/ai/pi-toolkit/tests/secure/settings-lock.test.ts`（追加）
- `/home/bluecake/ai/pi-toolkit/tests/secure/launcher-helper.test.ts`（追加）
- `/home/bluecake/ai/pi-toolkit/tests/secure/launcher-off-golden.test.ts`（只追加变体）
- `/home/bluecake/ai/pi-toolkit/docs/dev/settings-rename/P1-report.md`

建议 commit message（仅建议，未提交）：

```text
feat(secure): settings-file protocol layer and launcher for pi-toolkit.json (#54 P1)

Resolve the settings file by name (pi-toolkit.json, legacy pi-subagent.json) and
agentDir tier, add the link+compat-symlink migration with crash self-heal, and
teach domain and the pi-secure launcher the same rules. S6b secure-section
mismatches and an agentDir nested with a vault fail closed. Nothing migrates
until the plugin wiring (P2) lands — P1 and P2 must ship in the same release.
```
