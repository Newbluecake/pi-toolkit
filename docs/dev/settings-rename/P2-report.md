# #54 P2：插件接线（设置文件 pi-toolkit.json + agentDir）

依据 `plan.md` r3（含拍板①②③④）实施 §6.2 的 P2。**零 git 写操作**；`tests/fixtures/` 未动；设置文件内容从不打印；测试只用沙箱 HOME；迁移同步执行、无定时器（I5）。

> **发布门禁（沿用 P1 报告）**：P1 与 P2 必须同版发布。P2 合入后 activate 即开始迁移，旧 launcher 会拒写兼容链接。

## 交付内容

**`src/config/settings.ts`**

- `settingsLocation()` = `resolveSettingsLocation(resolveAgentDir(process.env, homedir()))`；`defaultSettingsPath()` = `settingsLocation().path`（纯读，不迁移）。没有任何设置文件时指向**新名**（S0，插件侧；与 P1 domain 一致），变量未设时目录仍是 `~/.pi/agent`。
- `settingsPathNote(location)`：scope 为 inherited ⇒ `inherited from ~/.pi/agent`，agentDir ⇒ `PI_CODING_AGENT_DIR`，default ⇒ `undefined`（编辑器标题后缀）。
- `prepareSettingsFile(): SettingsFileReport`（`{ path, location, migration, notified, notices }`，`notices` 是追加字段）：主会话唯一迁移点。相对变量被忽略时 `console.warn` + 记入 notices；对 location 所在目录调用 `migrateLegacySettingsFile`；`migrated` / `conflict`（含"旧名更新"提示）/ `skipped:lock|io` 按 §4.3 表输出日志，其余静默；永不抛。
- `loadSettingsFromFile` 的 ms→s / cache-ttl 写回：锁内先 `healSettingsFileLocked(dirname(path))`，再复查内容，改用 `writeSettingsFileAtomic`（保留符号链接，T-PL3）。
- `persistSettingOverride(key, value, path?)`：`path` 可选。省略时 **锁 → heal → 在锁内重新解析目标 → 读改写 → 原子写**；显式 path 时锁该路径、先 heal 其所在目录。锁内解析出的目录与加锁目录不同（锁外文件冒出）⇒ 拒写并提示重试，不做无锁写。

**`src/index.ts`**（I2，只做装配）：`const settingsFile = prepareSettingsFile(); loadSettingsFromFile(settingsFile.path)`；`/agent settings` 的 `path: settingsFile.path` + `pathNote`；`buildSessionStack(..., settingsFile)` 多传最后一个参数。共三处小改动（方案写两处，第三处是把报告对象交给 stack 所必需，§3.8 "交给 stack"）。HOST_KEY 之后才调用，子会话到不了 `prepareSettingsFile`。

**`src/stack.ts`**：`buildSessionStack` 末尾新增可选参数 `settingsFile`；第一次构建时对 `notices` 一次性 `ctx.ui.notify(…, "warning")`（`ctx.hasUI` 才发；无 UI 模式 activate 时已 `console.warn`）。`notified` 标志在 activate 闭包持有的报告对象上（I4）。**没有新增任何 `pi.on` 注册。**

**`src/cache-ttl/cache-ttl.ts`**：去掉显式 `defaultSettingsPath()` 参数。

**编辑器标题**：`SettingsStore.pathNote?`（`src/config/setting-specs.ts`，仅接口追加）→ `SettingsEditorSnapshot.pathNote` → 标题追加 ` (<note>)`（`src/ui/settings-editor.ts`）。默认 scope 标题逐字节不变。`/agent settings list` 文本头未改。

## 测试

| ID             | 文件                                                                                                                                                          | 要点                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-PL2 / 位置   | `tests/config/settings-file-rename.test.ts`（新，43 例）                                                                                                      | S0/S1/agentDir/inherited 位置与 `defaultSettingsPath`；`prepareSettingsFile`：S1→S5（inode 相同、readlink、二次 noop、无 `.lnk`）、S0/S4/S5 零触碰、S2 不迁移、S6b notices+保持、S6a 自愈无告警、**无 flock ⇒ 不迁移且文件系统不变**、相对变量忽略、inherited 只迁移 H、agentDir 迁移在 P（锁在 P）；`persistSettingOverride`：S5 链接保留、inherited 写 H、agentDir 写 P、S0 建 0600 新文件、坏 JSON 不覆盖；编辑器标题后缀 |
| T-MG6 插件半   | 同上                                                                                                                                                          | 初态 S0–S6b × 写者（省略 path / 显式 NEW / ms→s 写回）矩阵：写入内容出现在 `location.path`；S6a ⇒ S5；S6b 保持且 LEGACY 不被改；S2 外部链接保留且目标更新；写后 `loadSecureConfig` 与 `computeSecureDomain` 都无 `secure:invalid`（④）。显式 NEW 与 S1/S2 不组合（显式路径本就绕过名字解析，注释写明）。**变异验证**：去掉两处 heal ⇒ 4 个 S6a 用例变红                                                                      |
| T-MG6 EPERM 腿 | `tests/config/settings-file-symlink-eperm.test.ts`（新，`node:fs` mock 注入 `symlinkSync` EPERM）                                                             | S6a 写：回到 S1、内容写进 LEGACY、NEW 被撤；ms→s 写回回到 S1 并推迟，下次按解析出的 LEGACY 完成                                                                                                                                                                                                                                                                                                                              |
| T-PL3          | 矩阵 S2 行                                                                                                                                                    | ms→s 与 persist 在外部链接下保留链接、目标更新                                                                                                                                                                                                                                                                                                                                                                               |
| T-PL4          | 同上文件末                                                                                                                                                    | S5 下旧版语义 `writeSettingsFileAtomic(LEGACY)` / `writeFileSync(LEGACY)` 都经链接落到 NEW 且链接保留                                                                                                                                                                                                                                                                                                                        |
| T-PL1          | `tests/integration/settings-rename-activate.test.ts`（新，4 例）                                                                                              | 真实 activate：S1⇒S5、`/agent settings list                                                                                                                                                                                                                                                                                                                                                                                  | set`用新名并保留链接；无设置文件时不创建任何文件；**子会话（HOST_KEY 已占）ino、mtime 不变、无 NEW、无锁**；S6b 在首个 session_start notify 恰好一次（reload 再来不重复），且`pi.*` 注册序列与 S5 完全相同 |
| 重置写法       | `tests/integration/helpers/home-sandbox.ts`：新增 `resetSettingsFilesIn(dir)` / `resetSettingsFiles(home)`；`web-hub-disabled`、`fabric-xs-off-golden` 改用之 | 见下"范围外"另 8 个文件                                                                                                                                                                                                                                                                                                                                                                                                      |

## 范围外但必须的改动（调度方知悉）

1. **`tests/config/agent-dir-identity.test.ts:28`**（P0 的测试）：无设置文件时 `defaultSettingsPath()` 现在是 `pi-toolkit.json`，断言按 plan §3.3 S0 改为新名，加注释。
2. **`tests/web-hub/boundary.test.ts`**：`SYSLOAD_FILE_CLOSURE["src/config/settings.ts"]` 加 `../core/agent-dir.js`（plan §6.3 有意识的表更新，已加注释，hub 白名单未放宽；应 P4 请求）。已单独验证 20/20 通过。
3. **全量跑出的真实回归（plan §6.7「测试重置写法」风险，且 grep 字面量抓不到）**：`rmSync(settingsPath)` 只删兼容链接，留下过期 `pi-toolkit.json`，造成 6 个集成文件（context-switch / merged-plugins / schedule-surface / topic-switch / workflow-grace / …）的用例串味。把以下文件的 `rmSync(settingsPath, …)` 全部换成 `resetSettingsFilesIn(dirname(settingsPath))`：`topic-switch`、`compact-dynamic-wiring`、`child-context-switch`、`workflow-grace-wiring`、`merged-plugins-wiring`、`context-switch-wiring`、`workflow-background-wiring`、`schedule-surface-wiring`。
4. **`tests/integration/background-status-wiring.test.ts` 之前在真实 HOME 上 activate**（只读，没问题）；P2 后会去迁移真实 `~/.pi/agent/pi-subagent.json`。T-SB1 的 sandbox-home 守卫在 `open(.pi-subagent.json.lock)` 处拦住了它（**真实目录未被触碰**，已核对没有 `pi-toolkit.json`）。改为 `sandboxHome()` 包裹。**提醒**：任何后续新加的 activate 测试都必须走沙箱 HOME。

## 自验

| 命令                                                                                                                                                                                                                    | 结果                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`                                                                                                                                                                                                     | PASS                                                                                                                                                                                                   |
| `npx vitest run tests/config tests/secure tests/governance tests/integration/settings-rename-activate.test.ts tests/integration/web-hub-disabled.test.ts tests/integration/fabric-xs-off-golden.test.ts --maxWorkers=3` | PASS：84 文件 / 2151 通过 / 1 跳过（含真 gocryptfs）                                                                                                                                                   |
| `npm run test:conformance`                                                                                                                                                                                              | PASS：34 文件 / 352 通过 / 16 跳过                                                                                                                                                                     |
| `npx vitest run tests/web-hub/boundary.test.ts`                                                                                                                                                                         | PASS：20/20（修表后）                                                                                                                                                                                  |
| 全仓（排除 web-hub、secure）一轮                                                                                                                                                                                        | 802/809 文件通过；6 个失败文件是上面第 3、4 点（已修，9 个相关集成文件重跑 69/69 通过），另 1 个是 `conformance/secure-private-ns` NC2c（真 gocryptfs 偶发，单独重跑与 `test:conformance` 全量均通过） |
| `tests/web-hub` 全量                                                                                                                                                                                                    | 第一轮中被中止前 161 个文件全部通过                                                                                                                                                                    |
| `npx prettier --check`（改动的 src/tests/docs）                                                                                                                                                                         | PASS                                                                                                                                                                                                   |
| `git diff --quiet HEAD -- tests/fixtures/`                                                                                                                                                                              | PASS                                                                                                                                                                                                   |

activate-trace（B 档 `governance/activate-trace.json`）**未变**（governance 目录在上面第二行里通过）：stack 的 notify 走既有 `session_start` 路径，无新注册。off-golden 系列字节不变。

## 遗留与注意

- 没有 flock 的主机（macOS）不迁移，读写继续用旧名；功能完整，无告警。
- 显式 `path` 的 `persistSettingOverride`（仅测试/逃生口）不做名字解析，对 S1/S2 写 NEW 会造成 S6b；生产路径只用省略形式。
- `/agent settings list` 文本头未带 scope 后缀（只改了 TUI 编辑器标题）。需要的话在 P5 补。
- 本会话没有 `Agent` 派发能力，没做异源独立 verifier，建议调度方派独立验收。
- README/AGENTS.md/data-encryption 文档按方案归 P5。

## 改动文件（绝对路径）

- `/home/bluecake/ai/pi-toolkit/src/config/settings.ts`
- `/home/bluecake/ai/pi-toolkit/src/config/setting-specs.ts`（仅 `SettingsStore.pathNote?`）
- `/home/bluecake/ai/pi-toolkit/src/ui/settings-editor.ts`
- `/home/bluecake/ai/pi-toolkit/src/index.ts`
- `/home/bluecake/ai/pi-toolkit/src/stack.ts`
- `/home/bluecake/ai/pi-toolkit/src/cache-ttl/cache-ttl.ts`
- `/home/bluecake/ai/pi-toolkit/tests/config/settings-file-rename.test.ts`（新）
- `/home/bluecake/ai/pi-toolkit/tests/config/settings-file-symlink-eperm.test.ts`（新）
- `/home/bluecake/ai/pi-toolkit/tests/config/agent-dir-identity.test.ts`（一行）
- `/home/bluecake/ai/pi-toolkit/tests/integration/settings-rename-activate.test.ts`（新）
- `/home/bluecake/ai/pi-toolkit/tests/integration/helpers/home-sandbox.ts`
- `/home/bluecake/ai/pi-toolkit/tests/integration/{web-hub-disabled,fabric-xs-off-golden,background-status-wiring,topic-switch,compact-dynamic-wiring,child-context-switch,workflow-grace-wiring,merged-plugins-wiring,context-switch-wiring,workflow-background-wiring,schedule-surface-wiring}.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/boundary.test.ts`（closure 表一行）
- `/home/bluecake/ai/pi-toolkit/docs/dev/settings-rename/P2-report.md`

建议 commit message（仅建议，未提交）：

```text
feat(config): wire the plugin to pi-toolkit.json and the agentDir (#54 P2)

The plugin now resolves its settings file through the agentDir + file-name protocol: activate
migrates pi-subagent.json to pi-toolkit.json (hard link + compat symlink, crash-healing) in the
main session only, persistSettingOverride and the ms→s write-back heal a crash-window S6a under
the lock before writing, and the editor title names an inherited / agentDir source. Conflicts and
an ignored relative PI_CODING_AGENT_DIR surface once through the existing session_start path.
Must ship in the same release as the P1 launcher support.
```
